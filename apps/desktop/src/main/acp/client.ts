/**
 * ACP v1 客户端 —— 主进程侧的"咽喉点"（架构文档 §4.1 的 L2）。
 *
 * 为什么手写 JSON-RPC 而不套 SDK 封装：
 *  - client 侧要实现的正是 fs/*、terminal/*、session/request_permission 三类反向调用，
 *    那正是 L2 咽喉本身，必须完全可控；
 *  - 需要把每一条出站/入站消息原样留痕，供 M1 验收与 M3 策略判定使用。
 *
 * 线格式：JSON-RPC 2.0 over NDJSON，每条消息一行 UTF-8（§ACP transports）。
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  Policy,
  PolicyRequest,
  PolicyScopeContext,
  ScopeMatch,
  ScopeTargetRef,
} from "../policy/policy.ts";
import type { ScopeConfig } from "../config/loader.ts";
import type { TargetView } from "../../../../../packages/shared-protocol/events.ts";
import { extractTargets } from "../scope/extract.ts";
import { matchTargets } from "../scope/match.ts";

/**
 * Windows 上 `child.kill()` 只杀直接子进程，agent 再拉起的 MCP 子进程 / shell 会变孤儿。
 * 用 `taskkill /T` 收掉整棵进程树（架构 §4.2 规则 4 的 Job Object 语义的可用替代）。
 * 非 Windows 退化为普通 kill。
 */
function killTree(pid: number | undefined, guard?: (pid: number) => boolean): void {
  if (!pid) return;
  // P7-B：清理前用 PID + OS 启动时间校验；不匹配说明 PID 已被复用，跳过树 kill。
  if (guard && !guard(pid)) {
    process.stderr.write(`[acp] PID ${pid} 启动时间不匹配（复用），跳过 killTree\n`);
    return;
  }
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

/** 把路径解析到真实位置；目标尚不存在时，解析最近的已存在祖先再拼回尾部。 */
function realpathDeep(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    return resolve(realpathSync.native(cur), ...tail);
  } catch {
    return abs;
  }
}

/**
 * `child` 是否在 `root` 之内（root 本身也算）。
 *
 * R17：用 realpath 解析，避免 junction / symlink 指到工作目录外时被 `resolve()` 骗过
 * （例如 `work/link -> C:\Windows`，`work/link/x` 字面上仍在 work 下）。
 */
export function isInsideDir(root: string, target: string): boolean {
  const r = realpathDeep(root);
  const t = realpathDeep(target);
  const rel = relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 应用运行态目录永远不属于题目证据。即使 Agent 使用 autonomous 模式，
 * 也不能读取 board.db、平台 token、Cookie、其他会话日志或凭据文件。
 */
export function isSensitiveRuntimePath(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\//g, "\\");
  if (
    normalized.includes("\\appdata\\roaming\\bumimang\\workspace") ||
    normalized.includes("\\appdata\\roaming\\不迷茫\\workspace") ||
    normalized.includes("bumimang\\workspace") ||
    normalized.includes("%appdata%") ||
    normalized.includes("$env:appdata") ||
    normalized.includes("\\.ui-run\\")
  ) {
    return true;
  }
  return (
    /(^|\\)platform-state\.json($|\s)/.test(normalized) ||
    /(^|\\)platform-credentials\.bin($|\s)/.test(normalized) ||
    /(^|\\)permissions\.json($|\s)/.test(normalized) ||
    /(^|\\)board\.db($|\s)/.test(normalized)
  );
}

export const ACP_PROTOCOL_VERSION = 1;

export interface AgentSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  label: string;
}

export interface McpStdioServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface WireLogEntry {
  ts: number;
  dir: "out" | "in" | "sys";
  message: unknown;
}

/** P4-C：某任务当前的目标数据；由 SessionManager 从 board 读取后闭包传入。 */
export interface ScopeTargetSource {
  targets: TargetView[];
  denyTargets: string[];
  /** V2-P0-5：任务级允许动作；空数组 = 不限制。 */
  allowedActions?: string[];
}

/**
 * P4-C：从命令/权限请求文本提取目标并计算 inScope。
 *
 * 这是纯函数，便于确定性测试；AcpClient 只在 `enabled=true` 时调用它。
 * `enabled=false` 直接返回 undefined，连提取都不做，保证旧行为逐字不变。
 *
 * 多目标取最严格：out > unknown > in。没有候选但存在解析失败的 token 时，
 * 返回 inScope=unknown（交给 outOfScopeAction 兜底），不静默当作 in。
 */
export function deriveScopeContext(input: {
  action: string;
  detail: Record<string, unknown>;
  enabled: boolean;
  targets: TargetView[];
  denyTargets: string[];
}): PolicyScopeContext | undefined {
  if (!input.enabled) return undefined;
  const extracted = extractTargets(scopeTextForAction(input.action, input.detail));
  const rank: Record<ScopeMatch, number> = { in: 0, unknown: 1, out: 2 };
  let chosen: { target: ScopeTargetRef; inScope: ScopeMatch } | undefined;
  for (const candidate of extracted.candidates) {
    const res = matchTargets(input.targets, candidate, input.denyTargets);
    const next = {
      target: { kind: candidate.kind, value: candidate.value } as ScopeTargetRef,
      inScope: res.verdict,
    };
    if (!chosen || rank[next.inScope] > rank[chosen.inScope]) chosen = next;
  }
  if (!chosen) {
    if (extracted.unknowns.length > 0) {
      return {
        inScope: "unknown",
        target: { kind: "unknown", value: extracted.unknowns[0] },
      };
    }
    return undefined;
  }
  return { inScope: chosen.inScope, target: chosen.target };
}

/**
 * 把一次 ACP 调用压成可提取目标的文本。
 *
 * 刻意不拼 `options`（allow/deny 选项文案与目标无关，拼进去只会制造噪声）。
 * `rawInput` 用 JSON 字符串展开，因为不同 agent 把 command/path 放在不同字段。
 */
function scopeTextForAction(action: string, detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) parts.push(v);
  };
  push(detail.title);
  push(detail.name);
  push(detail.kind);
  push(detail.command);
  push(detail.path);
  push(detail.target);
  push(detail.cwd);
  if (Array.isArray(detail.args)) {
    for (const a of detail.args) push(a);
  }
  const raw = detail.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    try {
      parts.push(JSON.stringify(raw));
    } catch {
      /* 循环引用等异常不影响策略判定 */
    }
  }
  return parts.join("\n");
}

export interface AcpClientOptions {
  policy: Policy;
  sessionId: string;
  onUpdate: (update: Record<string, unknown>) => void;
  /** 留痕：每条线消息与每个策略判定 */
  log: (entry: WireLogEntry) => void;
  onExit: (code: number | null, signal: string | null) => void;
  /** 观测钩子：agent 每发起一次客户端反向调用就会触发（探针与健康度用） */
  onClientCall?: (action: string) => void;
  /**
   * 策略判定为 `approve` 时调用，返回 true 表示放行。
   * 这是唯一的事前闸门（实测三家 agent 都只走 request_permission，不发 terminal/*）。
   */
  onApprovalRequired?: (
    detail: Record<string, unknown>,
    decision: { rule: string; reason: string },
    /** 触发审批的 L2 action（fs/read、terminal/exec、session/request_permission） */
    action: string,
  ) => Promise<boolean>;
  /** 会话档位。受控档下"无规则命中"也会转人工（§9.2 第 4 步） */
  tier?: "autonomous" | "guarded";
  /** P4-C：范围策略配置。缺席/关闭时不提取目标，旧行为不变。 */
  scope?: ScopeConfig;
  /**
   * P4-C：当前任务的目标数据。只在 scope.enabled=true 时调用；
   * 关闭时不触碰 board，保证旧路径没有额外 DB 读取。
   */
  getScopeTargets?: () => ScopeTargetSource;
  /** P4-C：任务 id，供策略审计事件按任务归档。 */
  taskId?: string;
  /** agent 唯一可写根目录（R16）。`fs/write` 与 `terminal/create` 会做包含性检查。 */
  workRoot?: string;
  /**
   * 权限请求进入策略引擎前的补全钩子（R16）。
   *
   * 为什么必须在 evaluate **之前**：codex 的 `session/request_permission` 只带
   * toolCallId / kind，工具名在前一条 `tool_call` update 里。早先只在审批卡片上补名字，
   * 策略引擎看到的是「未命名工具调用」，于是每一次 `blackboard_*` 都走档位兜底变成
   * 人工审批。补全必须发生在判定之前，规则才可能匹配到黑板上具名工具。
   */
  enrichDetail?: (detail: Record<string, unknown>) => Record<string, unknown>;
  /**
   * R18 故障注入：替换真实的进程树清理。
   * 只给确定性回调用（模拟 kill 无效），生产不传。
   */
  killImpl?: () => void;
  /**
   * P7-B：killTree 前的 PID + OS 启动时间校验；返回 false 时不按树 kill，
   * 避免 PID 复用误杀。生产由 SessionManager 从 ProcessRegistry 注入。
   */
  killGuard?: (pid: number) => boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** R18：带超时的请求（目前只有 session/close）必须能被清掉，不能留下悬空定时器 */
  timer?: ReturnType<typeof setTimeout>;
}

/** session/close 的等待上限（R18）。坏 agent 可能永远不回，不能把退出流程一起拖死。 */
const CLOSE_TIMEOUT_MS = 3000;

interface TerminalRecord {
  child: ReturnType<typeof spawn>;
  output: string;
  truncated: boolean;
  exit: { exitCode: number | null; signal: string | null } | null;
  limit: number;
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private terminals = new Map<string, TerminalRecord>();
  private opts: AcpClientOptions;
  private closed = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private exitWaiters = new Set<() => void>();
  readonly spec: AgentSpec;

  private constructor(spec: AgentSpec, opts: AcpClientOptions) {
    this.spec = spec;
    this.opts = opts;
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...(opts.workRoot ? { BUMIMANG_WORKDIR: opts.workRoot } : {}),
        ...(spec.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    // R18：agent 在退出途中被写 stdin（cancel/close 与 exit 竞态）会发 EPIPE。
    // 不监听 'error' 会直接把整个主进程掀掉 —— 正常退出时必须容忍这个竞态。
    // 管道已断时所有出站请求都不可能再收到应答，必须立即 reject，不能永久 pending。
    this.child.stdin.on("error", (err: Error) => {
      this.opts.log({ ts: Date.now(), dir: "sys", message: { stdinError: err.message } });
      this.rejectAllPending(new Error(`agent stdin 写入失败：${err.message}`));
    });
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.opts.log({ ts: Date.now(), dir: "sys", message: { stderr: chunk } });
    });
    // R18：spawn 失败（ENOENT / EACCES）只发 'error'，不保证发 'exit'。
    // 不监听会把整个主进程掀掉；这里统一走 finalizeExit，error/exit 只回调一次。
    this.child.on("error", (err: Error & { code?: string }) => {
      const message = `agent 启动失败：${err.code ? `${err.code}: ` : ""}${err.message}`;
      this.opts.log({ ts: Date.now(), dir: "sys", message: { spawnError: message } });
      this.finalizeExit(null, null, message);
    });
    this.child.on("exit", (code, signal) => {
      this.finalizeExit(code, signal, "agent 进程已退出");
    });
  }

  /** 统一的进程终结路径：pending、waiters、onExit 只处理一次。 */
  private finalizeExit(code: number | null, signal: string | null, reason: string): void {
    if (this.exitInfo) return;
    this.closed = true;
    this.exitInfo = { code, signal };
    this.rejectAllPending(new Error(reason));
    for (const wake of [...this.exitWaiters]) wake();
    this.exitWaiters.clear();
    this.reapTerminals();
    this.opts.onExit(code, signal);
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  static spawn(spec: AgentSpec, opts: AcpClientOptions): AcpClient {
    return new AcpClient(spec, opts);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** 测试/诊断：仍未收到应答的请求数。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 进程是否已经终结（含 spawn 失败）。 */
  get hasExited(): boolean {
    return this.exitInfo !== null;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        this.opts.log({ ts: Date.now(), dir: "sys", message: { unparsable: line.slice(0, 400) } });
        continue;
      }
      this.opts.log({ ts: Date.now(), dir: "in", message: msg });
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;

    // 响应
    if (method === undefined && id !== undefined) {
      const p = this.pending.get(Number(id));
      if (!p) return;
      this.pending.delete(Number(id));
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`ACP error: ${JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (method === undefined) return;

    // 通知
    if (id === undefined) {
      if (method === "session/update") {
        const params = msg.params as Record<string, unknown>;
        this.opts.onUpdate(params ?? {});
      }
      return;
    }

    // 反向请求（agent -> client）—— 全部落在 L2
    try {
      const result = await this.handleClientRequest(method, (msg.params ?? {}) as Record<string, unknown>);
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message },
      });
    }
  }

  /** 发送一条消息；失败返回 Error（通知忽略，请求必须据此 reject）。 */
  private send(obj: Record<string, unknown>): Error | null {
    if (this.closed || this.exitInfo || !this.child.stdin?.writable) {
      return new Error("agent 进程已退出或 stdin 不可写");
    }
    this.opts.log({ ts: Date.now(), dir: "out", message: obj });
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
      return null;
    } catch (err) {
      const message = (err as Error).message;
      this.opts.log({ ts: Date.now(), dir: "sys", message: { writeError: message } });
      return new Error(`agent stdin 写入失败：${message}`);
    }
  }

  private rejectRequest(id: number, err: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.reject(err);
  }

  private request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    // 关闭后不再注册 pending —— 否则 send 静默返回，Promise 会永远挂着。
    if (this.closed || this.exitInfo) {
      return Promise.reject(new Error(`agent 进程已退出，无法发送 ${method}`));
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return Promise.reject(new Error(`ACP 请求超时（${method}，${timeoutMs}ms）`));
    }
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            // 只有仍然挂着的那条才需要报超时；已经回过的请求在 dispatch 里删掉了。
            if (!this.pending.delete(id)) return;
            reject(new Error(`ACP 请求超时（${method}，${timeoutMs}ms）`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    const err = this.send({ jsonrpc: "2.0", id, method, params });
    if (err) this.rejectRequest(id, err);
    return p;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  // ---------------- L2 咽喉：agent 反向调用 ----------------

  private async handleClientRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // 进程已经退出后，stdout 里仍可能有缓冲中的反向请求。此时不能再执行任何
    // 文件写入 / 命令 / 审批 —— 否则「会话已停」之后还会产生副作用（审查 P3）。
    if (this.closed || this.exitInfo) {
      throw new Error("agent 进程已退出，拒绝处理客户端反向调用");
    }
    switch (method) {
      case "fs/read_text_file":
        return this.fsRead(params);
      case "fs/write_text_file":
        return this.fsWrite(params);
      case "terminal/create":
        return this.terminalCreate(params);
      case "terminal/output":
        return this.terminalOutput(params);
      case "terminal/wait_for_exit":
        return this.terminalWait(params);
      case "terminal/kill":
        return this.terminalKill(params);
      case "terminal/release":
        return this.terminalRelease(params);
      case "session/request_permission":
        return this.requestPermission(params);
      default:
        throw new Error(`未实现的客户端方法：${method}`);
    }
  }

  /**
   * 只判定、不抛错。用于 `session/request_permission` —— 那条路径上"拒绝"必须
   * 以 ACP 规定的 `cancelled` outcome 回给 agent，而不是 JSON-RPC error。
   * （实测教训：早先这里让 block 抛错，agent 收到的是协议错误，会以为会话坏了。）
   */
  private evaluate(action: string, detail: Record<string, unknown>): ReturnType<Policy["evaluate"]> {
    this.opts.onClientCall?.(action);
    // P4-C：scope 关闭时连提取都不做；开启时把提取结果 + 当前任务 targets 压成
    // in/out/unknown，交给策略引擎。这里只提供数据，block/approve 由规则与配置决定。
    let scope: PolicyScopeContext | undefined;
    if (this.opts.scope?.enabled === true) {
      let source: ScopeTargetSource = { targets: [], denyTargets: [] };
      try {
        source = this.opts.getScopeTargets?.() ?? source;
      } catch (err) {
        this.opts.log({
          ts: Date.now(),
          dir: "sys",
          message: { scopeTargetsError: (err as Error).message },
        });
        // 读不到目标数据时按 unknown 兜底（默认 approve），不静默当成 in 放行。
        scope = { inScope: "unknown" };
      }
      if (!scope) {
        scope = deriveScopeContext({
          action,
          detail,
          enabled: true,
          targets: source.targets,
          denyTargets: source.denyTargets,
        });
      }
      // V2-P0-5：任务级允许动作随 scope 上下文进入策略引擎；空数组不限制。
      if (scope && (source.allowedActions?.length ?? 0) > 0) {
        scope = { ...scope, allowedActions: source.allowedActions };
      }
    }
    const req: PolicyRequest = {
      action,
      sessionId: this.opts.sessionId,
      taskId: this.opts.taskId,
      tier: this.opts.tier,
      detail,
      ...(scope ? { scope } : {}),
    };
    const decision = this.opts.policy.evaluate(req);
    this.opts.log({
      ts: Date.now(),
      dir: "sys",
      message: {
        policy: {
          action,
          verdict: decision.verdict,
          rule: decision.rule,
          ...(scope ? { inScope: scope.inScope, target: scope.target } : {}),
          detail,
        },
      },
    });
    return decision;
  }

  /**
   * 判定并在 block / 人工拒绝时抛错。用于 `terminal/*`、`fs/*` 这类"我们自己在执行"的动作。
   *
   * 关键语义：策略引擎的 `approve` 是「转人工」，不是「放行」。早先这里只处理 block，
   * 于是 guarded 档下 fs/read、fs/write、terminal/create 的无规则命中会被直接执行
   * （审查 P1：approvalCalls=0 却能读工作目录外文件、执行任意命令）。
   */
  private async decide(
    action: string,
    detail: Record<string, unknown>,
  ): Promise<ReturnType<Policy["evaluate"]>> {
    const decision = this.evaluate(action, detail);
    if (decision.verdict === "block") {
      throw new Error(`[policy:${decision.rule}] ${decision.reason}`);
    }
    if (decision.verdict === "approve") {
      const allowed = (await this.opts.onApprovalRequired?.(detail, decision, action)) ?? false;
      if (!allowed) {
        this.opts.log({
          ts: Date.now(),
          dir: "sys",
          message: { deny: { action, rule: decision.rule, reason: decision.reason, detail } },
        });
        throw new Error(`[policy:${decision.rule}] 人工拒绝：${decision.reason}`);
      }
    }
    return decision;
  }

  /**
   * 把 agent 给的路径解析到会话工作根。
   *
   * ACP 的 fs/* 与 terminal/create 可能收到相对路径；相对路径必须按 **agent 的 cwd**
   * （本应用里就是 workRoot）解析，而不是按主进程 cwd 解析。否则权限画像与真正的
   * 包含性检查会用两套基准，甚至读到应用自己的源码目录。
   */
  private resolveAgentPath(p: string, label: string): string {
    const raw = p.trim();
    if (!raw) throw new Error(`${label}路径为空`);
    const base = this.opts.workRoot ?? this.spec.cwd;
    return isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  }

  private async fsRead(params: Record<string, unknown>): Promise<{ content: string }> {
    const path = this.resolveAgentPath(String(params.path ?? ""), "读取");
    if (isSensitiveRuntimePath(path)) {
      throw new Error(`读取被拒绝：${path} 属于应用运行态/凭据目录，不是题目证据`);
    }
    // 读取不一定要求在工作目录内（codex 的 additionalDirectories 可能是 skills），
    // 但工作目录外必须进入策略判定：guarded 档会转人工，autonomous 档才直接放行。
    const inside = !this.opts.workRoot || isInsideDir(this.opts.workRoot, path);
    await this.decide("fs/read", { path, outsideWorkRoot: String(!inside) });
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(`读取失败 ${path}: ${(err as Error).message}`);
    }
    const line = params.line as number | null | undefined;
    const limit = params.limit as number | null | undefined;
    if (line || limit) {
      const all = content.split("\n");
      const start = line ? Math.max(0, line - 1) : 0;
      content = all.slice(start, limit ? start + limit : undefined).join("\n");
    }
    return { content };
  }

  private async fsWrite(params: Record<string, unknown>): Promise<Record<string, never>> {
    const path = this.resolveAgentPath(String(params.path ?? ""), "写入");
    if (this.opts.workRoot && !isInsideDir(this.opts.workRoot, path)) {
      throw new Error(
        `写入被拒绝：${path} 不在工作目录 ${this.opts.workRoot} 内。` +
          `所有生成文件必须写到工作目录。`,
      );
    }
    await this.decide("fs/write", { path, bytes: String(params.content ?? "").length });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(params.content ?? ""), "utf8");
    return {};
  }

  private async terminalCreate(params: Record<string, unknown>): Promise<{ terminalId: string }> {
    const command = String(params.command ?? "");
    if (!command.trim()) throw new Error("命令为空");
    if (isSensitiveRuntimePath(command)) {
      throw new Error("命令被拒绝：不得访问应用运行态、平台凭据、Cookie 或其他会话数据");
    }
    const args = (params.args as string[] | undefined) ?? [];
    const requestedCwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    const cwd = requestedCwd
      ? this.resolveAgentPath(requestedCwd, "命令 cwd")
      : (this.opts.workRoot ?? this.spec.cwd);
    if (this.opts.workRoot && !isInsideDir(this.opts.workRoot, cwd)) {
      throw new Error(
        `命令被拒绝：cwd=${cwd} 不在工作目录 ${this.opts.workRoot} 内。` +
          `所有命令必须在工作目录下执行。`,
      );
    }
    const limit = Number(params.outputByteLimit ?? 1024 * 1024);
    // command 本身不做路径限制：在 guarded 档下它会转人工，人工看到的就是完整命令。
    await this.decide("terminal/exec", { command, args, cwd });

    const terminalId = `t-${randomUUID().slice(0, 8)}`;
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(this.opts.workRoot ? { BUMIMANG_WORKDIR: this.opts.workRoot } : {}),
        ...Object.fromEntries(
          ((params.env as Array<{ name: string; value: string }> | undefined) ?? []).map((e) => [
            e.name,
            e.value,
          ]),
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const rec: TerminalRecord = { child, output: "", truncated: false, exit: null, limit };
    const push = (s: string): void => {
      rec.output += s;
      if (rec.output.length > rec.limit) {
        rec.output = rec.output.slice(rec.output.length - rec.limit);
        rec.truncated = true;
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("exit", (code, signal) => {
      rec.exit = { exitCode: code, signal };
    });
    child.on("error", (err) => {
      push(`\n[spawn error] ${err.message}\n`);
      rec.exit = { exitCode: -1, signal: null };
    });
    this.terminals.set(terminalId, rec);
    return { terminalId };
  }

  private terminalOutput(params: Record<string, unknown>): Record<string, unknown> {
    const rec = this.terminals.get(String(params.terminalId));
    if (!rec) throw new Error(`未知 terminalId: ${String(params.terminalId)}`);
    return {
      output: rec.output,
      truncated: rec.truncated,
      exitStatus: rec.exit,
    };
  }

  private terminalWait(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rec = this.terminals.get(String(params.terminalId));
    if (!rec) throw new Error(`未知 terminalId: ${String(params.terminalId)}`);
    if (rec.exit) return Promise.resolve(rec.exit as unknown as Record<string, unknown>);
    return new Promise((resolve) => {
      rec.child.on("exit", (code, signal) => resolve({ exitCode: code, signal }));
    });
  }

  private terminalKill(params: Record<string, unknown>): Record<string, never> {
    const rec = this.terminals.get(String(params.terminalId));
    if (rec && !rec.exit) killTree(rec.child.pid);
    return {};
  }

  private terminalRelease(params: Record<string, unknown>): Record<string, never> {
    const id = String(params.terminalId);
    const rec = this.terminals.get(id);
    if (rec && !rec.exit) killTree(rec.child.pid);
    this.terminals.delete(id);
    return {};
  }

  private async requestPermission(
    params: Record<string, unknown>,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const title = String(toolCall.title ?? toolCall.name ?? "未命名工具调用");
    const options = (params.options as Array<Record<string, unknown>> | undefined) ?? [];
    const meta = toolCall._meta as Record<string, unknown> | undefined;
    const claudeMeta = meta?.claudeCode as Record<string, unknown> | undefined;
    const toolName = String(toolCall.name ?? claudeMeta?.toolName ?? "").trim();
    const rawDetail: Record<string, unknown> = {
      toolCallId: toolCall.toolCallId,
      title,
      kind: toolCall.kind,
      rawInput: toolCall.rawInput,
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };
    // 工具名的结构化副本：策略里的 tool_regex 只认这个字段，不再对 rawInput
    // 自由文本做 allow 匹配（否则命令里塞一个 blackboard_read_since 就能绕过闸门）。
    if (toolName) rawDetail.toolName = toolName;
    // 判定前补全工具名（R16）：codex/dsh 的权限请求不带 title，名字在前一条
    // tool_call update 里。补全后再交给策略引擎，blackboard_* 才能命中置顶放行规则。
    const detail = this.opts.enrichDetail ? this.opts.enrichDetail(rawDetail) : rawDetail;
    // 注意用 evaluate 而不是 decide：block 也要以 cancelled outcome 回传，
    // 不能变成 JSON-RPC error（协议要求，实测踩过）
    const decision = this.evaluate("session/request_permission", detail);
    if (decision.verdict === "block") {
      this.opts.log({
        ts: Date.now(),
        dir: "sys",
        message: { blocked: { rule: decision.rule, reason: decision.reason } },
      });
      return { outcome: { outcome: "cancelled" } };
    }
    if (decision.verdict === "approve") {
      const allowed =
        (await this.opts.onApprovalRequired?.(detail, decision, "session/request_permission")) ?? false;
      if (!allowed) {
        // 拒绝要回结构化原因，否则 agent 会反复重试同一条（§9.6）
        this.opts.log({
          ts: Date.now(),
          dir: "sys",
          message: {
            deny: { rule: decision.rule, reason: decision.reason, detail },
          },
        });
        return { outcome: { outcome: "cancelled" } };
      }
    }
    // 优先 allow_once：一次人工放行只应授权这一次。若 agent 把 allow_always 排在
    // 前面，直接用 startsWith("allow") 会把「放行一次」变成 agent 侧的永久放行。
    const allow =
      options.find((o) => String(o.kind ?? "") === "allow_once") ??
      options.find((o) => String(o.kind ?? "").startsWith("allow"));
    if (!allow) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: String(allow.optionId) } };
  }

  private reapTerminals(): void {
    for (const [, rec] of this.terminals) {
      if (!rec.exit) killTree(rec.child.pid);
    }
    this.terminals.clear();
  }

  // ---------------- 出站：agent 侧方法 ----------------

  initialize(): Promise<Record<string, unknown>> {
    return this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "bumimang", title: "不迷茫", version: "0.1.0-m1" },
    });
  }

  newSession(input: {
    cwd: string;
    mcpServers?: McpStdioServer[];
    /** 额外只读/工作目录（codex-acp 支持；其它 agent 不传） */
    additionalDirectories?: string[];
  }): Promise<{ sessionId: string }> {
    const params: Record<string, unknown> = {
      cwd: input.cwd,
      mcpServers: input.mcpServers ?? [],
    };
    if (input.additionalDirectories?.length) {
      params.additionalDirectories = input.additionalDirectories;
    }
    return this.request("session/new", params);
  }

  /**
   * 会话级配置项（§session/set_config_option）。
   * 模型就是通过这个设的 —— agent 在 session/new 的 configOptions 里声明它支持哪些。
   */
  setConfigOption(input: {
    sessionId: string;
    configId: string;
    value: string | boolean;
    kind?: "select" | "boolean";
  }): Promise<Record<string, unknown>> {
    const kind = input.kind ?? (typeof input.value === "boolean" ? "boolean" : "select");
    return this.request("session/set_config_option", {
      sessionId: input.sessionId,
      configId: input.configId,
      type: kind,
      value: input.value,
    });
  }

  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  closeSession(sessionId: string, timeoutMs = CLOSE_TIMEOUT_MS): Promise<Record<string, unknown>> {
    // 进程已经退出了就不必再等一个永远不来的应答（正常退出/已被 kill 的会话）。
    if (this.closed || this.exitInfo) return Promise.resolve({});
    // R18：有界等待。坏 agent 无视 session/close 时必须能落到 kill。
    return this.request("session/close", { sessionId }, timeoutMs);
  }

  /** 等进程真正退出（R18 正常退出流程用）；返回 false 表示超时。 */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = (): void => {
        if (timer) clearTimeout(timer);
        this.exitWaiters.delete(wake);
        resolve(true);
      };
      this.exitWaiters.add(wake);
      timer = setTimeout(() => {
        this.exitWaiters.delete(wake);
        resolve(false);
      }, timeoutMs);
    });
  }

  kill(): void {
    this.reapTerminals();
    if (!this.closed) {
      if (this.opts.killImpl) {
        // 故障注入：调用方明确要求这一轮不真正杀进程。
        this.opts.killImpl();
        return;
      }
      // 先收整棵进程树（agent 会拉起 MCP 子进程 / shell），再补一次 child.kill 兜底。
      killTree(this.child.pid, this.opts.killGuard);
      try {
        this.child.kill();
      } catch {
        /* 忽略 */
      }
    }
  }
}
