/**
 * P3-B 批次 2：`cmd:` 证据回放（默认关）。
 *
 * 安全边界（与 `docs/decisions/D-evidence-replay.md` 对应）：
 *  - **默认关**：只有 `BUMIMANG_EVIDENCE_REPLAY=1` 才开；构造器只认显式 `enabled === true`。
 *  - **无 shell**：命令行解析成 argv 数组，`spawn(file, args, { shell: false })`；
 *    Windows 不拼 `cmd /c`，因此 `type`/`echo` 这类内建命令不会执行（失败降级 E1）。
 *  - **cwd = 任务 workdir**：由调用方传入，replay 不自己推导。
 *  - **30s 超时 / stdout、stderr 各 1MB**：超时杀进程树；输出只保留前 1MB 用于匹配。
 *  - **执行前过策略 `evidence/replay`**：block 拒绝；approve 进审批队列，人工批准后才执行。
 *  - **失败只降级**：超时/非零退出/spawn 失败都返回 `matched=false`，由调用方判 E1。
 *  - **审计不落 flag 明文**：`redactFlagText()` 把 `flag{...}` 脱敏成 `flag{***}`；
 *    stdout/stderr 内容不写审计，只记字节数/截断/是否命中。
 */

import { execFileSync, spawn } from "node:child_process";
import type { ApprovalOutcome, ApprovalService } from "../approval/queue.ts";
import type { Policy, PolicyDecision, Verdict } from "../policy/policy.ts";

export const REPLAY_TIMEOUT_MS = 30_000;
export const REPLAY_MAX_OUTPUT_BYTES = 1024 * 1024;

export type ReplayStatus =
  | "disabled"
  | "invalid"
  | "blocked"
  | "needs_approval"
  | "denied"
  | "ok"
  | "failed"
  | "timeout"
  | "spawn_error";

export interface ReplayResult {
  status: ReplayStatus;
  /** 是否真的 spawn 了子进程 */
  ran: boolean;
  /** 仅在 status=ok 且调用方 match 回调命中时为 true */
  matched: boolean;
  policyVerdict: Verdict | null;
  rule: string | null;
  reason: string | null;
  approvalDecision: "approved" | "denied" | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** 实际保留（截断后）的字节数 */
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error: string | null;
}

export interface ReplayInput {
  commandLine: string;
  cwd: string;
  sessionId: string;
  taskId: string;
  /** 策略档位兜底：受控档无规则命中 → approve（进审批）；默认受控档。 */
  tier?: "autonomous" | "guarded";
  /**
   * stdout 命中判定由调用方提供（flag / 事实文本的语义留在 inferEvidence），
   * replay 只负责执行与返回 stdout；不把 flag 语义复制到这里。
   */
  match: (stdout: string) => boolean;
}

export interface EvidenceReplayerOptions {
  /** 只有显式 true 才开启；缺省/undefined/其它值一律关闭。 */
  enabled: boolean;
  /** 延迟取策略：main.ts 里桥先于策略/审批创建，用 provider 避免时序问题。 */
  policy?: () => Policy | undefined;
  /** 延迟取审批队列；approve 时用它请求人工批准。 */
  approval?: () => ApprovalService | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** 把 `flag{...}` 脱敏；审计/审批里只保留“有 flag”这一事实，不落明文。 */
export function redactFlagText(text: string): string {
  return text.replace(/flag\{[^}\r\n]{1,256}\}/gi, "flag{***}");
}

/**
 * 把命令行解析成 argv（不经过 shell）。
 *
 * 规则：
 *  - 空白分隔；双引号/单引号内保留空白；
 *  - 双引号内 `\"` 表示字面量 `"`，其它反斜杠原样保留（Windows 路径）；
 *  - 引号外反斜杠原样保留（`C:\Windows\...` 不会被吃掉）；
 *  - 未闭合引号、NUL、空 argv 都拒绝。
 */
export function parseCommandLine(input: string): string[] {
  if (input.includes("\0")) throw new Error("命令包含 NUL 字符");
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && input[i + 1] === '"') {
        cur += '"';
        i += 1;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur.length > 0) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }

  if (quote) throw new Error("命令引号未闭合");
  if (started || cur.length > 0) out.push(cur);
  if (out.length === 0 || !out[0]) throw new Error("命令为空");
  return out;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    } catch {
      /* 进程已退出 / 没有权限：继续走普通 kill */
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

interface CaptureState {
  chunks: Buffer[];
  captured: number;
  total: number;
}

function capture(state: CaptureState, chunk: Buffer, max: number): void {
  state.total += chunk.length;
  const remaining = max - state.captured;
  if (remaining <= 0) return;
  const take = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  state.chunks.push(take);
  state.captured += take.length;
}

export class EvidenceReplayer {
  private readonly enabled: boolean;
  private readonly policy?: () => Policy | undefined;
  private readonly approval?: () => ApprovalService | undefined;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(opts: EvidenceReplayerOptions) {
    // 只认显式 true：缺省、undefined、字符串 "true" 都不会开启。
    this.enabled = opts.enabled === true;
    this.policy = opts.policy;
    this.approval = opts.approval;
    this.timeoutMs = opts.timeoutMs ?? REPLAY_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? REPLAY_MAX_OUTPUT_BYTES;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async run(input: ReplayInput): Promise<ReplayResult> {
    const base: ReplayResult = {
      status: "disabled",
      ran: false,
      matched: false,
      policyVerdict: null,
      rule: null,
      reason: null,
      approvalDecision: null,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
    };

    if (!this.enabled) return base;
    if (!input.commandLine.trim()) {
      return { ...base, status: "invalid", error: "命令为空" };
    }

    let argv: string[];
    try {
      argv = parseCommandLine(input.commandLine);
    } catch (err) {
      return { ...base, status: "invalid", error: (err as Error).message };
    }

    // 执行前过策略：block 拒绝；approve 进审批；allow 直接执行。
    let decision: PolicyDecision;
    try {
      const policy = this.policy?.();
      if (!policy) {
        return { ...base, status: "blocked", rule: "no-policy", reason: "策略引擎不可用，拒绝回放" };
      }
      decision = policy.evaluate({
        action: "evidence/replay",
        sessionId: input.sessionId,
        tier: input.tier ?? "guarded",
        detail: { command: input.commandLine, cwd: input.cwd, taskId: input.taskId },
      });
    } catch (err) {
      return { ...base, status: "blocked", rule: "policy-error", error: (err as Error).message };
    }

    base.policyVerdict = decision.verdict;
    base.rule = decision.rule;
    base.reason = decision.reason;

    if (decision.verdict === "block") {
      return { ...base, status: "blocked" };
    }

    if (decision.verdict === "approve") {
      const approval = this.approval?.();
      if (!approval) {
        return { ...base, status: "needs_approval", error: "没有审批队列，approve 无法执行" };
      }
      let outcome: ApprovalOutcome;
      try {
        outcome = await approval.request({
          taskId: input.taskId,
          sessionId: input.sessionId,
          action: "evidence/replay",
          // 审批卡/落库同样不落 flag 明文；人看到的是脱敏后的命令。
          detail: { command: redactFlagText(input.commandLine), cwd: input.cwd, taskId: input.taskId },
          rule: decision.rule,
          reason: decision.reason,
        });
      } catch (err) {
        return { ...base, status: "denied", error: (err as Error).message };
      }
      base.approvalDecision = outcome.decision;
      if (outcome.decision !== "approved") {
        return { ...base, status: "denied" };
      }
    }

    return this.execute(argv, input, base).catch((err: unknown) => ({
      ...base,
      status: "spawn_error" as const,
      error: (err as Error).message ?? String(err),
    }));
  }

  private execute(argv: string[], input: ReplayInput, base: ReplayResult): Promise<ReplayResult> {
    const startedAt = Date.now();
    const stdout: CaptureState = { chunks: [], captured: 0, total: 0 };
    const stderr: CaptureState = { chunks: [], captured: 0, total: 0 };

    return new Promise<ReplayResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: input.cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          ...base,
          status: "spawn_error",
          ran: false,
          matched: false,
          durationMs: Date.now() - startedAt,
          error: (err as Error).message,
        });
        return;
      }

      const finish = (status: ReplayStatus, exitCode: number | null, signal: string | null, error: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const stdoutText = Buffer.concat(stdout.chunks).toString("utf8");
        let matched = false;
        if (status === "ok") {
          try {
            matched = input.match(stdoutText) === true;
          } catch {
            matched = false;
          }
        }
        resolve({
          ...base,
          status,
          ran: true,
          matched,
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          stdoutBytes: stdout.captured,
          stderrBytes: stderr.captured,
          stdoutTruncated: stdout.total > stdout.captured,
          stderrTruncated: stderr.total > stderr.captured,
          error,
        });
      };

      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
        finish("timeout", null, "timeout", `超过 ${this.timeoutMs}ms 未结束`);
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk, this.maxOutputBytes));
      child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk, this.maxOutputBytes));
      child.on("error", (err) => {
        finish("spawn_error", null, null, err.message);
      });
      child.on("close", (code, signal) => {
        if (timedOut) return; // 超时路径已经结算
        if (code === 0) finish("ok", code, signal, null);
        else finish("failed", code, signal, `退出码 ${code ?? "null"}`);
      });
    });
  }
}
