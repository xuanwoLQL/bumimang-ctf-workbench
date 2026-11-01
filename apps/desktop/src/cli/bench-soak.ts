/**
 * P6-B 批次 1：fake agent soak（进程内模拟，0 token）。
 *
 * 做法（不启动任何子进程、不 import 真实 agent 客户端）：
 *  - 3 个任务 × 3 个 fake 会话写入真实 Blackboard（SQLite）；
 *  - 每 5s 写 session 流文件（模拟 agent 输出）；
 *  - 每 60s 轮转会话状态（running/idle/waiting_approval），写 lifecycle 事件；
 *  - 每 2 分钟写 fact/note/deadend + 发审批请求（ApprovalQueue，随后人工放行）；
 *  - 每 interval 采样 RSS/句柄/DB/stream/events/审批 pending/错误；
 *  - 结束写 evidence/bench-soak-<ts>.json + evidence/bench-soak-summary.txt。
 *
 * 判定：RSS 增长 <50% 且斜率 <2MB/min；句柄峰值-首值 <=10 且斜率 <0.5/min；
 * DB 增长 <200KB/min（不再用“初始倍数”）；events/分钟 <=5000 且总量 <=200000；审批 pending 峰值 <=9、终值 <=3；
 * 错误=0；每个会话至少 1 次状态变化；采样数 >= 预期 90%；结束时全部 stopped。
 */
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Blackboard } from "../main/blackboard/board.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";

const ACTIVE_STATUSES = new Set(["starting", "running", "idle", "waiting_approval", "waiting_lease"]);
const STATUS_CYCLE = ["running", "idle", "waiting_approval"];

export interface SoakOptions {
  dry: boolean;
  tasks: number;
  sessions: number;
  minutes: number;
  /** 采样间隔（ms）；默认 60000。 */
  intervalMs: number;
  /** 测试用计数钩子；runner 记录启动次数，dry-run 永远不应调用。 */
  hooks?: { onAgentStart?: () => void };
  help?: boolean;
}

export interface SoakPlan {
  tasks: number;
  sessions: number;
  minutes: number;
  intervalMs: number;
  sessionCount: number;
  sessionMinutes: number;
}

export interface SoakSample {
  ts: number;
  elapsedMs: number;
  rssBytes: number;
  handles: number;
  dbBytes: number;
  walBytes: number;
  streamBytes: number;
  events: number;
  approvalsPending: number;
  approvalsTotal: number;
  errors: number;
  sessionsActive: number;
  statusChangesMin: number;
}

export interface SoakCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SoakSummary {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  sampleCount: number;
  expectedSamples: number;
  rssFirst: number;
  rssPeak: number;
  rssLast: number;
  rssGrowthRatio: number;
  rssSlopeBytesPerMin: number;
  handlesFirst: number;
  handlesPeak: number;
  handlesLast: number;
  handleSlopePerMin: number;
  dbFirst: number;
  dbLast: number;
  dbGrowthRatio: number;
  /** 首尾平均增长（KB/min）；新阈值用它，不再用“初始倍数”。 */
  dbGrowthKbPerMin: number;
  /** 观测：ΔDB（KB）/ Δevents；用于判断增长是否随事件写入。 */
  dbKbPerEvent: number;
  streamFirst: number;
  streamLast: number;
  eventsFirst: number;
  eventsLast: number;
  eventsPerMinuteMax: number;
  approvalsPendingPeak: number;
  approvalsPendingLast: number;
  approvalsCreated: number;
  errors: number;
  lastError: string | null;
  statusChangesMin: number;
  statusChangesMax: number;
  sessionsStopped: number;
  sessionsTotal: number;
}

export interface SoakVerdict {
  pass: boolean;
  checks: SoakCheck[];
  thresholds: Record<string, number | string>;
}

export interface SoakResult {
  ok: boolean;
  error?: string;
  plan?: SoakPlan;
  reportPath?: string;
  summaryPath?: string;
  summary?: SoakSummary;
  verdict?: SoakVerdict;
}

interface FakeSession {
  id: string;
  taskId: string;
  status: string;
  statusIdx: number;
  role: string;
  tier: string;
  streamPath: string;
}

function intArg(raw: string, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${field} 必须是整数：${JSON.stringify(raw)}`);
  return n;
}

export function parseSoakArgs(argv: string[]): SoakOptions {
  let dry = true;
  let dryFlag = false;
  let minutesExplicit = false;
  let tasks = 3;
  let sessions = 3;
  let minutes = 60;
  let intervalMs = 60000;
  let help = false;

  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少值`);
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry") {
      dry = true;
      dryFlag = true;
      continue;
    }
    if (a === "--no-dry") {
      dry = false;
      dryFlag = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a.startsWith("--tasks=")) {
      tasks = intArg(a.slice("--tasks=".length), "tasks");
      continue;
    }
    if (a === "--tasks") {
      tasks = intArg(take(i, "--tasks"), "tasks");
      i += 1;
      continue;
    }
    if (a.startsWith("--sessions=")) {
      sessions = intArg(a.slice("--sessions=".length), "sessions");
      continue;
    }
    if (a === "--sessions") {
      sessions = intArg(take(i, "--sessions"), "sessions");
      i += 1;
      continue;
    }
    if (a.startsWith("--minutes=")) {
      minutes = intArg(a.slice("--minutes=".length), "minutes");
      minutesExplicit = true;
      continue;
    }
    if (a === "--minutes") {
      minutes = intArg(take(i, "--minutes"), "minutes");
      minutesExplicit = true;
      i += 1;
      continue;
    }
    if (a.startsWith("--interval=")) {
      intervalMs = intArg(a.slice("--interval=".length), "interval");
      continue;
    }
    if (a === "--interval") {
      intervalMs = intArg(take(i, "--interval"), "interval");
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${a}`);
  }

  if (tasks < 1 || tasks > 3) throw new Error("tasks 必须是 1–3");
  if (sessions < 1 || sessions > 3) throw new Error("sessions 必须是 1–3");
  if (minutes < 1 || minutes > 120) throw new Error("minutes 必须是 1–120");
  if (intervalMs < 1000 || intervalMs > 600000) throw new Error("interval 必须是 1000–600000");
  // P6-A 的默认仍是 dry（无参数只看计划）；显式 --minutes=N 且没有 --dry/--no-dry
  // 时视为真实 soak，支持 `npm run bench:soak -- --minutes=60`。
  if (minutesExplicit && !dryFlag) dry = false;
  return { dry, tasks, sessions, minutes, intervalMs, help };
}

export function buildSoakPlan(
  opts: Pick<SoakOptions, "tasks" | "sessions" | "minutes" | "intervalMs">,
): SoakPlan {
  const sessionCount = opts.tasks * opts.sessions;
  return {
    tasks: opts.tasks,
    sessions: opts.sessions,
    minutes: opts.minutes,
    intervalMs: opts.intervalMs,
    sessionCount,
    sessionMinutes: sessionCount * opts.minutes,
  };
}

export function formatSoakPlan(plan: SoakPlan): string {
  return [
    "不迷茫 · soak dry-run",
    `tasks=${plan.tasks} sessions=${plan.sessions} minutes=${plan.minutes} interval=${plan.intervalMs}ms`,
    `sessionCount=${plan.sessionCount} sessionMinutes=${plan.sessionMinutes}`,
    "计划观测：RSS / 句柄 / DB 大小 / stream 文件大小 / events / 审批 pending / 错误。",
    "dry-run：不启动 fake/真实 agent、0 token、不写采样文件。",
    "提示：显式 --minutes=N 且不加 --dry 时会运行真实 fake soak；--dry 只看计划。",
  ].join("\n");
}

function validateSoakOptions(opts: SoakOptions): void {
  if (opts.tasks < 1 || opts.tasks > 3) throw new Error("tasks 必须是 1–3");
  if (opts.sessions < 1 || opts.sessions > 3) throw new Error("sessions 必须是 1–3");
  if (opts.minutes < 1 || opts.minutes > 120) throw new Error("minutes 必须是 1–120");
  if (opts.intervalMs < 1000 || opts.intervalMs > 600000) {
    throw new Error("interval 必须是 1000–600000");
  }
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function linearSlope(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function activeHandleCount(): number {
  const proc = process as unknown as {
    _getActiveHandles?: () => unknown[];
    getActiveResourcesInfo?: () => string[];
  };
  try {
    // Node 25 的 _getActiveHandles() 实测恒为 0；getActiveResourcesInfo() 仍能列出
    // timer/pipe 等活跃资源，因此优先用它，旧 API 只作兜底（仅观测，不 assert）。
    if (typeof proc.getActiveResourcesInfo === "function") {
      return proc.getActiveResourcesInfo().length;
    }
    return proc._getActiveHandles?.().length ?? 0;
  } catch {
    return 0;
  }
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runSoak(opts: SoakOptions): Promise<SoakResult> {
  const plan = buildSoakPlan(opts);
  if (opts.dry) {
    console.log(formatSoakPlan(plan));
    return { ok: true, plan };
  }
  try {
    validateSoakOptions(opts);
    return await runSoakReal(opts, plan);
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err), plan };
  }
}

async function runSoakReal(opts: SoakOptions, plan: SoakPlan): Promise<SoakResult> {
  const ts = nowStamp();
  const runId = `soak-${ts}`;
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const root = join(repo, ".ui-run", `bench-soak-${ts}`);
  const evidenceDir = join(repo, "evidence");
  const sessionsDir = join(root, "sessions");
  const workDir = join(root, "work");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const boardPath = join(root, "board.db");
  const board = Blackboard.open(boardPath);
  const startedAt = Date.now();
  const fakeSessions: FakeSession[] = [];
  const statusChanges = new Map<string, number>();
  const tasks: Array<{ id: string; title: string }> = [];
  let errors = 0;
  let lastError: string | null = null;
  let approvalsCreated = 0;
  let pendingPeak = 0;
  let tickNo = 0;

  const notePendingPeak = (): void => {
    try {
      pendingPeak = Math.max(pendingPeak, queue.pendingCount());
    } catch {
      /* 观测辅助 */
    }
  };

  const noteError = (err: unknown): void => {
    errors += 1;
    lastError = (err as Error).message ?? String(err);
  };

  const queue = new ApprovalQueue({
    onUpsert: () => undefined,
    intentSummary: () => "soak fake intent",
    timeoutMs: 60_000,
    onTimeout: "denied",
    onError: (err) => noteError(err),
    onPersist: (view) => {
      board.upsertApproval({
        id: view.id,
        taskId: view.taskId,
        sessionId: view.sessionId,
        action: view.action,
        command: view.command,
        intentSummary: view.intentSummary,
        risk: view.risk,
        rule: view.rule,
        status: view.status,
        decidedBy: view.decidedBy,
        decidedAt: view.decidedAt,
        createdAt: view.createdAt,
      });
    },
  });

  try {
    for (let t = 0; t < plan.tasks; t += 1) {
      const task = board.createTask({
        title: `soak task ${t + 1}`,
        brief: "P6-B fake soak：进程内模拟，不启动真实 agent。",
      });
      tasks.push(task);
      for (let s = 0; s < plan.sessions; s += 1) {
        const id = `soak-${t + 1}-${s + 1}`;
        const status = STATUS_CYCLE[(t + s) % STATUS_CYCLE.length];
        board.insertSession({
          id,
          taskId: task.id,
          agent: "fake-soak",
          role: ["lead", "verify", "recon"][s % 3],
          tier: s % 2 === 0 ? "guarded" : "autonomous",
          status,
        });
        const streamPath = join(sessionsDir, id, "stream.jsonl");
        mkdirSync(join(sessionsDir, id), { recursive: true });
        writeFileSync(streamPath, "", "utf8");
        fakeSessions.push({
          id,
          taskId: task.id,
          status,
          statusIdx: (t + s) % STATUS_CYCLE.length,
          role: ["lead", "verify", "recon"][s % 3],
          tier: s % 2 === 0 ? "guarded" : "autonomous",
          streamPath,
        });
        statusChanges.set(id, 0);
      }
    }

    const sample = (): SoakSample => {
      const dbBytes = statSize(boardPath);
      const walBytes = statSize(`${boardPath}-wal`);
      const streamBytes = fakeSessions.reduce((sum, s) => sum + statSize(s.streamPath), 0);
      const changes = [...statusChanges.values()];
      return {
        ts: Date.now(),
        elapsedMs: Date.now() - startedAt,
        rssBytes: process.memoryUsage().rss,
        handles: activeHandleCount(),
        dbBytes,
        walBytes,
        streamBytes,
        events: board.counts().events,
        approvalsPending: queue.pendingCount(),
        approvalsTotal: approvalsCreated,
        errors,
        sessionsActive: fakeSessions.filter((s) => ACTIVE_STATUSES.has(s.status)).length,
        statusChangesMin: changes.length === 0 ? 0 : Math.min(...changes),
      };
    };

    const logSample = (s: SoakSample): void => {
      console.log(
        `[soak] +${Math.round(s.elapsedMs / 1000)}s rss=${Math.round(s.rssBytes / 1024 / 1024)}MB ` +
          `handles=${s.handles} db=${Math.round((s.dbBytes + s.walBytes) / 1024)}KB ` +
          `stream=${Math.round(s.streamBytes / 1024)}KB events=${s.events} ` +
          `pending=${s.approvalsPending} errors=${s.errors}`,
      );
    };

    const decidePending = (): void => {
      try {
        notePendingPeak();
        const pending = queue.list(100).filter((v) => v.status === "pending");
        if (pending.length > 0) queue.bulk(pending.map((v) => v.id), "approved");
      } catch (err) {
        noteError(err);
      }
    };

    const requestApproval = (taskId: string, sessionId: string): void => {
      approvalsCreated += 1;
      void queue
        .request({
          taskId,
          sessionId,
          action: "session/request_permission",
          detail: {
            title: `soak approval ${approvalsCreated}`,
            kind: "execute",
            command: "echo soak",
          },
          rule: "soak",
          reason: "fake soak approval",
        })
        .catch(noteError);
      // queue.request 同步把 pending 放进队列；在这里记录瞬时峰值，
      // 避免只靠 60s 采样点错过短命的 pending。
      notePendingPeak();
    };

    const tick = (): void => {
      tickNo += 1;
      try {
        for (const s of fakeSessions) {
          const line = JSON.stringify({
            ts: Date.now(),
            kind: "agent_message",
            text: `soak tick ${tickNo} session ${s.id} (fake, no flag)`,
          });
          appendFileSync(s.streamPath, `${line}\n`, "utf8");
          if (tickNo % 12 === 0) {
            // 每 60s 轮转一次状态，模拟真实 agent 的 running/idle/等待审批。
            s.statusIdx = (s.statusIdx + 1) % STATUS_CYCLE.length;
            s.status = STATUS_CYCLE[s.statusIdx];
            board.setSessionStatus(s.id, s.status);
            statusChanges.set(s.id, (statusChanges.get(s.id) ?? 0) + 1);
          }
        }
        if (tickNo % 24 === 0) {
          // 每 2 分钟写黑板 + 发审批请求（5 分钟验证也能采到 pending）。
          for (const t of tasks) {
            const mine = fakeSessions.filter((s) => s.taskId === t.id);
            if (mine.length === 0) continue;
            try {
              board.submitFact({
                taskId: t.id,
                sessionId: mine[0].id,
                content: `soak fact tick ${tickNo} task ${t.id}`,
                witness: null,
                evidence: "E0",
              });
              board.note({
                taskId: t.id,
                sessionId: mine[Math.min(1, mine.length - 1)].id,
                text: `soak note tick ${tickNo}`,
              });
              board.declareDeadEnd({
                taskId: t.id,
                sessionId: mine[mine.length - 1].id,
                description: `soak dead end tick ${tickNo}`,
              });
            } catch (err) {
              noteError(err);
            }
            requestApproval(t.id, mine[0].id);
          }
        }
      } catch (err) {
        noteError(err);
      }
    };

    const samples: SoakSample[] = [];
    const workTimer = setInterval(tick, 5000);
    const decideTimer = setInterval(decidePending, 5000);
    const sampleTimer = setInterval(() => {
      try {
        const s = sample();
        samples.push(s);
        logSample(s);
      } catch (err) {
        noteError(err);
      }
    }, opts.intervalMs);

    // 先创建 timer 再采首个样本，handles 才能反映稳定运行的基线（而不是 0）。
    const initial = sample();
    samples.push(initial);
    logSample(initial);

    await new Promise<void>((resolve) => setTimeout(resolve, opts.minutes * 60_000));
    decidePending();
    // 终样本在 clear 之前采，handles 才能反映结束时的活跃资源。
    const finalSample = sample();
    samples.push(finalSample);
    logSample(finalSample);

    clearInterval(workTimer);
    clearInterval(decideTimer);
    clearInterval(sampleTimer);

    for (const s of fakeSessions) {
      board.setSessionStatus(s.id, "stopped");
      s.status = "stopped";
      statusChanges.set(s.id, (statusChanges.get(s.id) ?? 0) + 1);
    }
    const sessionsStopped = fakeSessions.filter((s) => s.status === "stopped").length;
    const endedAt = Date.now();
    const changes = [...statusChanges.values()];
    const dbFirstBytes = samples[0].dbBytes + samples[0].walBytes;
    const dbLastBytes = samples[samples.length - 1].dbBytes + samples[samples.length - 1].walBytes;
    const durationMin = Math.max(1e-9, (endedAt - startedAt) / 60_000);
    const dbDeltaKb = (dbLastBytes - dbFirstBytes) / 1024;
    const eventsDelta = samples[samples.length - 1].events - samples[0].events;
    const dbGrowthKbPerMin = dbDeltaKb / durationMin;
    const dbKbPerEvent = eventsDelta <= 0 ? 0 : dbDeltaKb / eventsDelta;
    const summary: SoakSummary = {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      sampleCount: samples.length,
      expectedSamples: Math.max(1, Math.floor((opts.minutes * 60_000) / opts.intervalMs)),
      rssFirst: samples[0].rssBytes,
      rssPeak: Math.max(...samples.map((s) => s.rssBytes)),
      rssLast: samples[samples.length - 1].rssBytes,
      rssGrowthRatio:
        samples[0].rssBytes === 0 ? 0 : (samples[samples.length - 1].rssBytes - samples[0].rssBytes) / samples[0].rssBytes,
      rssSlopeBytesPerMin: linearSlope(
        samples.map((s) => ({ x: s.elapsedMs / 60_000, y: s.rssBytes })),
      ),
      handlesFirst: samples[0].handles,
      handlesPeak: Math.max(...samples.map((s) => s.handles)),
      handlesLast: samples[samples.length - 1].handles,
      handleSlopePerMin: linearSlope(
        samples.map((s) => ({ x: s.elapsedMs / 60_000, y: s.handles })),
      ),
      dbFirst: dbFirstBytes,
      dbLast: dbLastBytes,
      dbGrowthRatio: dbFirstBytes === 0 ? 0 : dbLastBytes / dbFirstBytes,
      dbGrowthKbPerMin,
      dbKbPerEvent,
      streamFirst: samples[0].streamBytes,
      streamLast: samples[samples.length - 1].streamBytes,
      eventsFirst: samples[0].events,
      eventsLast: samples[samples.length - 1].events,
      eventsPerMinuteMax: Math.max(
        0,
        ...samples.slice(1).map((s, i) => {
          const prev = samples[i];
          const dt = (s.elapsedMs - prev.elapsedMs) / 60_000;
          return dt <= 0 ? 0 : (s.events - prev.events) / dt;
        }),
      ),
      approvalsPendingPeak: Math.max(pendingPeak, ...samples.map((s) => s.approvalsPending)),
      approvalsPendingLast: samples[samples.length - 1].approvalsPending,
      approvalsCreated,
      errors,
      lastError,
      statusChangesMin: changes.length === 0 ? 0 : Math.min(...changes),
      statusChangesMax: changes.length === 0 ? 0 : Math.max(...changes),
      sessionsStopped,
      sessionsTotal: fakeSessions.length,
    };

    const thresholds = {
      rssGrowthMax: 0.5,
      rssSlopeMaxBytesPerMin: 2 * 1024 * 1024,
      handlePeakDeltaMax: 10,
      handleSlopeMaxPerMin: 0.5,
      dbGrowthKbPerMinMax: 200,
      eventsPerMinuteMax: 5000,
      eventsTotalMax: 200000,
      approvalsPendingPeakMax: 9,
      approvalsPendingLastMax: 3,
      errorsMax: 0,
      statusChangesMin: 1,
      sampleCoverageMin: 0.9,
    };
    const checks: SoakCheck[] = [
      {
        name: "采样覆盖 >=90%",
        pass: summary.sampleCount >= Math.floor(summary.expectedSamples * thresholds.sampleCoverageMin),
        detail: `${summary.sampleCount}/${summary.expectedSamples}`,
      },
      {
        name: "RSS 增长 <50%",
        pass: summary.rssGrowthRatio < thresholds.rssGrowthMax,
        detail: `${(summary.rssGrowthRatio * 100).toFixed(1)}%`,
      },
      {
        name: "RSS 斜率 <2MB/min",
        pass: summary.rssSlopeBytesPerMin < thresholds.rssSlopeMaxBytesPerMin,
        detail: `${(summary.rssSlopeBytesPerMin / 1024 / 1024).toFixed(2)}MB/min`,
      },
      {
        name: "句柄峰值-首值 <=10",
        pass: summary.handlesPeak - summary.handlesFirst <= thresholds.handlePeakDeltaMax,
        detail: `${summary.handlesFirst}→${summary.handlesPeak}`,
      },
      {
        name: "句柄斜率 <0.5/min",
        pass: summary.handleSlopePerMin < thresholds.handleSlopeMaxPerMin,
        detail: `${summary.handleSlopePerMin.toFixed(3)}/min`,
      },
      {
        name: "DB 增长 <200KB/min",
        pass: summary.dbGrowthKbPerMin < thresholds.dbGrowthKbPerMinMax,
        detail: `${summary.dbGrowthKbPerMin.toFixed(2)}KB/min（总 ${summary.dbGrowthRatio.toFixed(2)}x，${summary.dbKbPerEvent.toFixed(2)}KB/event）`,
      },
      {
        name: "events/分钟 <=5000",
        pass: summary.eventsPerMinuteMax <= thresholds.eventsPerMinuteMax,
        detail: summary.eventsPerMinuteMax.toFixed(0),
      },
      {
        name: "events 总量 <=200000",
        pass: summary.eventsLast <= thresholds.eventsTotalMax,
        detail: String(summary.eventsLast),
      },
      {
        name: "审批 pending 峰值 <=9",
        pass: summary.approvalsPendingPeak <= thresholds.approvalsPendingPeakMax,
        detail: String(summary.approvalsPendingPeak),
      },
      {
        name: "审批 pending 终值 <=3",
        pass: summary.approvalsPendingLast <= thresholds.approvalsPendingLastMax,
        detail: String(summary.approvalsPendingLast),
      },
      {
        name: "错误数=0",
        pass: summary.errors === thresholds.errorsMax,
        detail: summary.lastError ?? "0",
      },
      {
        name: "每会话至少 1 次状态变化",
        pass: summary.statusChangesMin >= thresholds.statusChangesMin,
        detail: `${summary.statusChangesMin}–${summary.statusChangesMax}`,
      },
      {
        name: "结束时全部会话 stopped",
        pass: summary.sessionsStopped === summary.sessionsTotal,
        detail: `${summary.sessionsStopped}/${summary.sessionsTotal}`,
      },
    ];
    const verdict: SoakVerdict = {
      pass: checks.every((c) => c.pass),
      checks,
      thresholds,
    };

    const report = {
      runId,
      startedAt,
      endedAt,
      config: {
        tasks: plan.tasks,
        sessions: plan.sessions,
        minutes: plan.minutes,
        intervalMs: plan.intervalMs,
        mode: "fake-in-process",
        tokenCost: 0,
      },
      environment: {
        os: process.platform,
        node: process.version,
        arch: process.arch,
      },
      samples,
      summary,
      verdict,
    };
    const reportPath = join(evidenceDir, `bench-soak-${ts}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

    const summaryLines = [
      "不迷茫 · P6-B fake soak summary",
      `runId=${runId}`,
      `started=${new Date(startedAt).toISOString()}`,
      `ended=${new Date(endedAt).toISOString()}`,
      `duration=${(summary.durationMs / 60000).toFixed(1)}min samples=${summary.sampleCount}/${summary.expectedSamples}`,
      `config=tasks:${plan.tasks} sessions:${plan.sessions} minutes:${plan.minutes} interval:${plan.intervalMs}ms`,
      `rss first=${Math.round(summary.rssFirst / 1024 / 1024)}MB peak=${Math.round(summary.rssPeak / 1024 / 1024)}MB last=${Math.round(summary.rssLast / 1024 / 1024)}MB growth=${(summary.rssGrowthRatio * 100).toFixed(1)}% slope=${(summary.rssSlopeBytesPerMin / 1024 / 1024).toFixed(2)}MB/min`,
      `handles first=${summary.handlesFirst} peak=${summary.handlesPeak} last=${summary.handlesLast} slope=${summary.handleSlopePerMin.toFixed(3)}/min`,
      `db first=${Math.round(summary.dbFirst / 1024)}KB last=${Math.round(summary.dbLast / 1024)}KB growth=${summary.dbGrowthRatio.toFixed(2)}x rate=${summary.dbGrowthKbPerMin.toFixed(2)}KB/min kbPerEvent=${summary.dbKbPerEvent.toFixed(2)}`,
      `stream first=${Math.round(summary.streamFirst / 1024)}KB last=${Math.round(summary.streamLast / 1024)}KB`,
      `events first=${summary.eventsFirst} last=${summary.eventsLast} max/min=${summary.eventsPerMinuteMax.toFixed(0)}`,
      `approvals created=${summary.approvalsCreated} pendingPeak=${summary.approvalsPendingPeak} pendingLast=${summary.approvalsPendingLast}`,
      `errors=${summary.errors}${summary.lastError ? ` last=${summary.lastError}` : ""}`,
      `statusChanges=${summary.statusChangesMin}–${summary.statusChangesMax} sessions=${summary.sessionsStopped}/${summary.sessionsTotal} stopped`,
      "",
      ...checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  — ${c.detail}`),
      "",
      `VERDICT: ${verdict.pass ? "PASS" : "FAIL"}`,
      `report=${reportPath}`,
      "注：fake in-process 负载不代表真实 agent 的 token/延迟特征；真实数据见 P6-C。",
    ];
    const summaryPath = join(evidenceDir, "bench-soak-summary.txt");
    writeFileSync(summaryPath, summaryLines.join("\n"), "utf8");
    console.log(`\n${summaryLines.join("\n")}`);

    return {
      ok: verdict.pass,
      error: verdict.pass ? undefined : "soak 阈值未通过；详见 evidence/bench-soak-summary.txt",
      plan,
      reportPath,
      summaryPath,
      summary,
      verdict,
    };
  } finally {
    try {
      const pending = queue.list(100).filter((v) => v.status === "pending");
      if (pending.length > 0) queue.bulk(pending.map((v) => v.id), "denied");
    } catch {
      /* 清理失败不影响报告 */
    }
    try {
      board.close();
    } catch {
      /* 关闭失败不影响进程退出 */
    }
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    const opts = parseSoakArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(
        "用法：npm run bench:soak -- --dry [--tasks=3] [--sessions=3] [--minutes=60] [--interval=60000]\n" +
          "显式 --minutes=N 且不加 --dry 时运行真实 fake soak（进程内模拟，0 token）。",
      );
      process.exit(0);
    }
    const res = await runSoak(opts);
    if (!res.ok) {
      console.error(res.error ?? "soak 失败");
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    process.exit(2);
  }
}

if (isMain()) void main();
