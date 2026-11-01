/**
 * P6-C 批次 1.6a / D1：低干扰 benchmark monitor。
 *
 * 设计（针对批次 1 的 H1）：
 *  - DB + stream.jsonl 是主数据源：每 5s 读一次 board.db 的 session/approval/flag 行，
 *    增量读 stream.jsonl 的字节偏移；
 *  - CDP 只做可选的 one-shot snapshot（默认每 30s 一次），每次连接用完即关；
 *    30s 超时就 close + 清 pending，绝不把 pending Runtime.evaluate 留到下一轮；
 *  - CDP 失败只记日志，不阻塞 DB/stream 主流程；
 *  - 不自动批准、不自动 confirm flag。
 *
 * 用法（batch 2）：
 *   node apps/desktop/src/cli/bench-monitor.ts \
 *     --state=<tmp>/p6c-b2-state.json --db=.ui-run/board.db \
 *     --stream=.ui-run/sessions/<sid>/stream.jsonl --wire=.ui-run/sessions/<sid>/wire.jsonl \
 *     --cdp-port=9333 --cdp-interval=30000 --out=evidence/p6c-b2-monitor.json
 *
 * 自检（无 Electron/agent）：
 *   node apps/desktop/src/cli/bench-monitor.ts --self-test
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- types

export interface MonitorState {
  challengeId?: string;
  target?: string;
  targetUrl?: string;
  taskId: string;
  sessionId: string;
  startedAt?: number;
  [key: string]: unknown;
}

export interface BoardApproval {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  action: string | null;
  command: string | null;
  risk: string | null;
  status: string;
  decidedBy: string | null;
  createdAt: number | null;
  decidedAt: number | null;
}

export interface BoardFlag {
  id: string;
  taskId: string;
  value: string;
  sourceSession: string | null;
  evidence: string;
  firstSeen: number;
  status: string;
  sources: Array<{ sessionId: string | null; witness: string | null; evidence: string }>;
}

export interface BoardState {
  session: {
    id: string;
    taskId: string;
    agent: string;
    role: string;
    tier: string;
    status: string;
    pid: number | null;
    startedAt: number | null;
    endedAt: number | null;
    toolCalls: number;
  } | null;
  approvals: BoardApproval[];
  flags: BoardFlag[];
  dbError?: string;
}

export interface StreamIncrement {
  nextOffset: number;
  partial: string;
  lines: number;
  kinds: Record<string, number>;
  maxLineBytes: number;
  lastTs: number | null;
  lastKind: string | null;
  firstTs: number | null;
}

export interface MonitorResult {
  challengeId: string | null;
  target: string | null;
  taskId: string;
  sessionId: string;
  monitorMode: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  firstFlagMs: number | null;
  toolCalls: number | null;
  toolCallsDb: number | null;
  toolCallsHealth: number | null;
  boardReads: number | null;
  approvals: Record<string, number>;
  approvalDetails: BoardApproval[];
  flags: BoardFlag[];
  flagFound: boolean;
  flagValue: string | null;
  e2EvidenceChain: boolean;
  confirmPathAvailable: boolean;
  exportAvailable: null;
  tokens: unknown;
  tokenSource: string | null;
  tokenUsageRecords: number;
  sessionStatus: string | null;
  sessionEndedAt: string | null;
  endedReason: string;
  cdp: {
    enabled: boolean;
    snapshots: number;
    timeouts: number;
    errors: number;
    reconnects: number;
    lastError: string | null;
    lastHealth: unknown;
  };
  stream: {
    path: string;
    bytes: number;
    lines: number;
    kinds: Record<string, number>;
    maxLineBytes: number;
    lastTs: number | null;
  };
  errors: string[];
  notes: string[];
}

// ---------------------------------------------------------------- DB

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickCommand(context: unknown): string | null {
  if (typeof context === "string") {
    const obj = parseJson(context);
    if (!obj) return context.trim() ? context.slice(0, 2000) : null;
    const direct = obj.command ?? obj.rawInput ?? obj.input ?? obj.detail;
    if (typeof direct === "string") return direct.slice(0, 2000);
    if (direct && typeof direct === "object") {
      const d = direct as Record<string, unknown>;
      const c = d.command ?? d.cmd ?? d.rawInput;
      if (typeof c === "string") return c.slice(0, 2000);
    }
    return null;
  }
  if (context && typeof context === "object") {
    const obj = context as Record<string, unknown>;
    const direct = obj.command ?? obj.rawInput ?? obj.input ?? obj.detail;
    if (typeof direct === "string") return direct.slice(0, 2000);
    if (direct && typeof direct === "object") {
      const d = direct as Record<string, unknown>;
      const c = d.command ?? d.cmd ?? d.rawInput;
      if (typeof c === "string") return c.slice(0, 2000);
    }
  }
  return null;
}

/** 只读打开 board.db；表/列按 board v3。读失败返回带 dbError 的空结构。 */
export function readBoardState(
  dbPath: string,
  taskId: string,
  sessionId: string,
): BoardState {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      /* read-only 连接上可能不允许；忽略 */
    }
    const s = db
      .prepare(
        "SELECT id,task_id,agent,role,tier,status,pid,started_at,ended_at,tool_calls " +
          "FROM sessions WHERE id = ?",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    const approvals = (
      db
        .prepare(
          "SELECT id,task_id,session_id,action,context,risk,status,decided_by,created_at,decided_at " +
            "FROM approvals WHERE task_id = ? OR session_id = ? ORDER BY created_at ASC",
        )
        .all(taskId, sessionId) as Array<Record<string, unknown>>
    ).map((r): BoardApproval => ({
      id: String(r.id),
      taskId: r.task_id == null ? null : String(r.task_id),
      sessionId: r.session_id == null ? null : String(r.session_id),
      action: r.action == null ? null : String(r.action),
      command: pickCommand(r.context),
      risk: r.risk == null ? null : String(r.risk),
      status: String(r.status),
      decidedBy: r.decided_by == null ? null : String(r.decided_by),
      createdAt: typeof r.created_at === "number" ? r.created_at : null,
      decidedAt: typeof r.decided_at === "number" ? r.decided_at : null,
    }));
    const rawFlags = db
      .prepare(
        "SELECT id,task_id,value,source_session,witness,evidence,first_seen,status " +
          "FROM flag_candidates WHERE task_id = ? ORDER BY first_seen ASC",
      )
      .all(taskId) as Array<Record<string, unknown>>;
    const flags: BoardFlag[] = rawFlags.map((r) => {
      const sources = (
        db!
          .prepare(
            "SELECT session_id,witness,evidence FROM flag_sources WHERE candidate_id = ? ORDER BY seen_at ASC",
          )
          .all(String(r.id)) as Array<Record<string, unknown>>
      ).map((s) => ({
        sessionId: s.session_id == null ? null : String(s.session_id),
        witness: s.witness == null ? null : String(s.witness),
        evidence: String(s.evidence),
      }));
      return {
        id: String(r.id),
        taskId: String(r.task_id),
        value: String(r.value),
        sourceSession: r.source_session == null ? null : String(r.source_session),
        evidence: String(r.evidence),
        firstSeen: Number(r.first_seen) || 0,
        status: String(r.status),
        sources,
      };
    });
    return {
      session: s
        ? {
            id: String(s.id),
            taskId: String(s.task_id),
            agent: String(s.agent),
            role: String(s.role),
            tier: String(s.tier),
            status: String(s.status),
            pid: typeof s.pid === "number" ? s.pid : null,
            startedAt: typeof s.started_at === "number" ? s.started_at : null,
            endedAt: typeof s.ended_at === "number" ? s.ended_at : null,
            toolCalls: Number(s.tool_calls) || 0,
          }
        : null,
      approvals,
      flags,
    };
  } catch (err) {
    return {
      session: null,
      approvals: [],
      flags: [],
      dbError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- stream

export function readStreamIncrement(
  streamPath: string,
  offset: number,
  partial = "",
  kindsAcc: Record<string, number> = {},
): StreamIncrement {
  const empty: StreamIncrement = {
    nextOffset: offset,
    partial,
    lines: 0,
    kinds: { ...kindsAcc },
    maxLineBytes: 0,
    lastTs: null,
    lastKind: null,
    firstTs: null,
  };
  if (!fs.existsSync(streamPath)) return empty;
  const size = fs.statSync(streamPath).size;
  if (size < offset) {
    // 文件被截断/轮转：从头读。
    offset = 0;
    partial = "";
  }
  if (size === offset) return empty;
  const fd = fs.openSync(streamPath, "r");
  let buf = Buffer.alloc(size - offset);
  try {
    const read = fs.readSync(fd, buf, 0, buf.length, offset);
    buf = buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  const text = partial + buf.toString("utf8");
  const parts = text.split("\n");
  const nextPartial = parts.pop() ?? "";
  let lines = 0;
  let maxLineBytes = 0;
  let lastTs: number | null = null;
  let lastKind: string | null = null;
  let firstTs: number | null = null;
  const kinds: Record<string, number> = { ...kindsAcc };
  for (const line of parts) {
    if (!line) continue;
    lines += 1;
    const bytes = Buffer.byteLength(line);
    if (bytes > maxLineBytes) maxLineBytes = bytes;
    try {
      const u = JSON.parse(line) as { ts?: unknown; kind?: unknown };
      if (typeof u.ts === "number") {
        lastTs = u.ts;
        if (firstTs == null) firstTs = u.ts;
      }
      const kind = typeof u.kind === "string" ? u.kind : "unknown";
      lastKind = kind;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    } catch {
      /* 半行/坏行：不计 kind */
    }
  }
  return {
    nextOffset: offset + buf.length,
    partial: nextPartial,
    lines,
    kinds,
    maxLineBytes,
    lastTs,
    lastKind,
    firstTs,
  };
}

// ---------------------------------------------------------------- tokens

export function readWireTokens(wirePath: string | null): {
  tokens: unknown;
  source: string | null;
  records: number;
} {
  if (!wirePath || !fs.existsSync(wirePath)) return { tokens: null, source: wirePath, records: 0 };
  const text = fs.readFileSync(wirePath, "utf8");
  const re =
    /"usage":\{"inputTokens":(\d+),"outputTokens":(\d+),"cachedReadTokens":(\d+),"cachedWriteTokens":(\d+),"totalTokens":(\d+)\}/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return { tokens: null, source: wirePath, records: 0 };
  const m = matches[matches.length - 1];
  return {
    tokens: {
      inputTokens: Number(m[1]),
      outputTokens: Number(m[2]),
      cachedReadTokens: Number(m[3]),
      cachedWriteTokens: Number(m[4]),
      totalTokens: Number(m[5]),
      records: matches.length,
    },
    source: wirePath,
    records: matches.length,
  };
}

// ---------------------------------------------------------------- CDP one-shot

export interface WebSocketLike {
  readyState: number;
  addEventListener(type: string, cb: (ev: { data?: string }) => void, opts?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface CdpEvalResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * 每次 evaluate 一个连接，finally close；超时也先 close 再返回。
 * 这样 Runtime.evaluate 的 pending 不会跨轮累积（批次 1 的 H1）。
 */
export class CdpOneShot {
  private factory: WebSocketFactory;
  private timeoutMs: number;
  private pendingCount = 0;
  private closedCount = 0;
  private lastError: string | null = null;

  constructor(factory?: WebSocketFactory, timeoutMs = 30_000) {
    this.factory =
      factory ??
      ((url) => {
        const ws = new WebSocket(url) as unknown as WebSocketLike;
        return ws;
      });
    this.timeoutMs = timeoutMs;
  }

  getPendingCount(): number {
    return this.pendingCount;
  }
  getClosedCount(): number {
    return this.closedCount;
  }
  getLastError(): string | null {
    return this.lastError;
  }

  async evaluate(url: string, expression: string, timeoutMs?: number): Promise<CdpEvalResult> {
    const timeout = timeoutMs ?? this.timeoutMs;
    let ws: WebSocketLike;
    try {
      ws = this.factory(url);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, error: this.lastError };
    }
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.pendingCount = 0;
      this.closedCount += 1;
    };
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`cdp open timeout after ${timeout}ms`)), timeout),
        ),
      ]);
      const result = await Promise.race([
        new Promise<CdpEvalResult>((resolve, reject) => {
          ws.addEventListener(
            "message",
            (ev) => {
              try {
                const msg = JSON.parse(String(ev.data ?? "{}")) as {
                  id?: number;
                  result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
                  error?: unknown;
                };
                if (msg.error) {
                  reject(new Error(JSON.stringify(msg.error)));
                  return;
                }
                const details = msg.result?.exceptionDetails;
                if (details) {
                  reject(new Error(`evaluate exception: ${JSON.stringify(details).slice(0, 400)}`));
                  return;
                }
                resolve({ ok: true, value: msg.result?.result?.value });
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            },
            { once: true },
          );
          this.pendingCount = 1;
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression,
                awaitPromise: true,
                returnByValue: true,
                userGesture: true,
              },
            }),
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`cdp evaluate timeout after ${timeout}ms`)), timeout),
        ),
      ]);
      return result;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, error: this.lastError };
    } finally {
      close();
    }
  }

  async snapshot(url: string): Promise<CdpEvalResult> {
    return this.evaluate(url, "window.bumimang.snapshot()", this.timeoutMs);
  }

  async stopSession(url: string, sessionId: string): Promise<CdpEvalResult> {
    return this.evaluate(
      url,
      `window.bumimang.dispatch(${JSON.stringify({ type: "session.stop", sessionId })})`,
      30_000,
    );
  }
}

// ---------------------------------------------------------------- self-test fakes

class FakeNeverSocket implements WebSocketLike {
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(ev: { data?: string }) => void>>();
  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }
  addEventListener(type: string, cb: (ev: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  send(): void {
    /* never respond */
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  private emit(type: string, ev: { data?: string }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

class FakeRespondSocket extends FakeNeverSocket {
  override send(data: string): void {
    const req = JSON.parse(data) as { id: number };
    setTimeout(() => this.emitMessage({ id: req.id, result: { result: { value: 2 } } }), 0);
  }
  private emitMessage(payload: unknown): void {
    // @ts-expect-error access private emit for the fake
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

// ---------------------------------------------------------------- self-test

function pass(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

export async function runSelfTest(repoRoot = "D:/agent/xuanwo"): Promise<void> {
  console.log("== D1 monitor self-test (no Electron/agent) ==");

  // 1. CDP timeout: must close + clear pending, not leave a pending eval.
  const never = new FakeNeverSocket();
  const cdpTimeout = new CdpOneShot(() => never, 80);
  const t0 = Date.now();
  const r1 = await cdpTimeout.evaluate("ws://fake", "1+1", 80);
  const elapsed = Date.now() - t0;
  pass("CDP timeout returns ok=false", r1.ok === false, String(r1.error));
  pass("CDP timeout closes socket", never.closed === true);
  pass("CDP timeout clears pending", cdpTimeout.getPendingCount() === 0, String(cdpTimeout.getPendingCount()));
  pass("CDP timeout is bounded (~80ms)", elapsed < 1500, `${elapsed}ms`);
  pass("CDP timeout counts a close", cdpTimeout.getClosedCount() === 1, String(cdpTimeout.getClosedCount()));

  // 2. A second call uses a fresh connection (one-shot) and succeeds.
  const cdpOk = new CdpOneShot(() => new FakeRespondSocket(), 500);
  const r2 = await cdpOk.evaluate("ws://fake", "1+1", 500);
  pass("CDP second call succeeds", r2.ok === true && r2.value === 2, JSON.stringify(r2));
  pass("CDP second call closes", cdpOk.getClosedCount() === 1);
  pass("CDP second call clears pending", cdpOk.getPendingCount() === 0);

  // 3. DB reader on the real batch-1 DB.
  const dbPath = path.join(repoRoot, ".ui-run", "board.db");
  const board = readBoardState(dbPath, "task-9999666e", "s7");
  pass("DB reader opens board.db", !board.dbError, board.dbError ?? "");
  pass("DB reader finds s7", board.session?.id === "s7", JSON.stringify(board.session));
  pass("DB reader final status failed", board.session?.status === "failed", String(board.session?.status));
  pass("DB reader sees 1 approval", board.approvals.length === 1, String(board.approvals.length));
  pass(
    "DB reader approval approved by human",
    board.approvals[0]?.status === "approved" && board.approvals[0]?.decidedBy === "human",
    JSON.stringify(board.approvals[0] ?? null),
  );
  pass("DB reader flags empty", board.flags.length === 0, String(board.flags.length));

  // 4. Stream increment reader on the real batch-1 stream.
  const streamPath = path.join(repoRoot, ".ui-run", "sessions", "s7", "stream.jsonl");
  const inc = readStreamIncrement(streamPath, 0);
  const total = Object.values(inc.kinds).reduce((a, b) => a + b, 0);
  pass("stream reader counts > 90k events", total > 90_000, String(total));
  pass("stream reader sees agent_thought majority", (inc.kinds.agent_thought ?? 0) > 90_000, JSON.stringify(inc.kinds));
  pass("stream reader tracks max line bytes", inc.maxLineBytes > 0 && inc.maxLineBytes <= 655, String(inc.maxLineBytes));
  pass("stream reader returns a next offset", inc.nextOffset > 0, String(inc.nextOffset));

  // 5. Incremental read from the end must not re-count old lines.
  const inc2 = readStreamIncrement(streamPath, inc.nextOffset, inc.partial, inc.kinds);
  pass("incremental read adds 0 lines at EOF", inc2.lines === 0, String(inc2.lines));
  pass("incremental read keeps offset", inc2.nextOffset === inc.nextOffset, `${inc2.nextOffset} vs ${inc.nextOffset}`);

  console.log("== self-test done ==");
}

// ---------------------------------------------------------------- main loop

export interface MonitorOptions {
  state: MonitorState;
  dbPath: string;
  streamPath: string;
  wirePath: string | null;
  outPath: string;
  cdpPort: number | null;
  cdpIntervalMs: number;
  pollMs: number;
  timeoutMs: number;
  approvalStallMs: number;
  stopOnTimeout: boolean;
  stopOnStall: boolean;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function witnessExists(witness: string | null, repoRoot: string, taskId: string): boolean {
  if (!witness) return false;
  const list = path.isAbsolute(witness)
    ? [witness]
    : [
        path.join(repoRoot, "work", taskId, witness),
        path.join(repoRoot, "work", taskId, "evidence", witness),
        path.join(repoRoot, "work", taskId, "evidence", path.basename(witness)),
      ];
  return list.some((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export async function runMonitor(opts: MonitorOptions): Promise<MonitorResult> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const startedAt = opts.state.startedAt ?? Date.now();
  const cdpUrl = opts.cdpPort
    ? (() => {
        // One-shot websocket: resolve the page target once via /json/list.
        return `http://127.0.0.1:${opts.cdpPort}/json/list`;
      })()
    : null;
  const cdp = opts.cdpPort ? new CdpOneShot(undefined, 30_000) : null;
  let cdpWsUrl: string | null = null;
  let cdpSnapshots = 0;
  let cdpTimeouts = 0;
  let cdpErrors = 0;
  let cdpReconnects = 0;
  let cdpLastError: string | null = null;
  let lastCdpAt = 0;
  let lastHealth: unknown = null;

  async function resolveCdpWs(): Promise<string | null> {
    if (!cdpUrl) return null;
    if (cdpWsUrl) return cdpWsUrl;
    try {
      const res = await fetch(cdpUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
      const list = (await res.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      const page =
        list.find((x) => x.type === "page" && String(x.url).includes("renderer.html")) ??
        list.find((x) => x.type === "page");
      if (!page?.webSocketDebuggerUrl) throw new Error("CDP page target not found");
      cdpWsUrl = page.webSocketDebuggerUrl;
      return cdpWsUrl;
    } catch (err) {
      cdpErrors += 1;
      cdpLastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async function cdpSnapshotOnce(): Promise<void> {
    if (!cdp) return;
    const ws = await resolveCdpWs();
    if (!ws) return;
    cdpSnapshots += 1;
    const r = await cdp.snapshot(ws);
    if (!r.ok) {
      if (String(r.error).includes("timeout")) cdpTimeouts += 1;
      else cdpErrors += 1;
      cdpLastError = r.error ?? "cdp error";
      // one-shot client already closed; next call re-resolves/reconnects.
      cdpWsUrl = null;
      cdpReconnects += 1;
      log(`[monitor] CDP snapshot failed (will reconnect next interval): ${r.error}`);
      return;
    }
    const snap = r.value as {
      health?: Record<string, unknown>;
      scope?: unknown;
      flags?: unknown;
    } | null;
    lastHealth = snap?.health ?? null;
  }

  let streamOffset = 0;
  let partial = "";
  let streamLines = 0;
  let streamKinds: Record<string, number> = {};
  let streamMaxLine = 0;
  let streamLastTs: number | null = null;
  let firstObservedFlagMs: number | null = null;
  const approvalsSeen = new Map<string, BoardApproval>();
  let lastPendingKey = "";
  let pendingSince: number | null = null;
  let firstFlag: BoardFlag | null = null;
  let lastBoard: BoardState | null = null;
  let lastSession: BoardState["session"] = null;
  let terminal = "running";
  const errors: string[] = [];
  let lastProgress = 0;

  while (true) {
    const now = Date.now();
    if (now - startedAt >= opts.timeoutMs) {
      terminal = "timeout";
      break;
    }
    const board = readBoardState(opts.dbPath, opts.state.taskId, opts.state.sessionId);
    if (board.dbError) {
      errors.push(`db: ${board.dbError}`);
      log(`[monitor] DB read failed: ${board.dbError}`);
    } else {
      lastBoard = board;
      lastSession = board.session;
      for (const a of board.approvals) approvalsSeen.set(a.id, a);
      const pending = board.approvals.filter((a) => a.status === "pending");
      if (pending.length > 0) {
        const key = pending.map((a) => a.id).sort().join(",");
        if (key !== lastPendingKey) {
          lastPendingKey = key;
          pendingSince = now;
          log(
            `[monitor] PENDING APPROVALS (${pending.length}): ` +
              pending
                .map((a) => `${a.id} action=${a.action} risk=${a.risk} command=${(a.command ?? "").slice(0, 240)}`)
                .join(" | "),
          );
          log("[monitor] 👉 人工点批准/拒绝；monitor 不会自动批准。");
        } else if (pendingSince != null && now - pendingSince > opts.approvalStallMs) {
          terminal = "approval_stall";
          break;
        }
      } else {
        lastPendingKey = "";
        pendingSince = null;
      }
      const flag = board.flags.find((f) => f.status === "new" || f.status === "confirmed") ?? null;
      if (flag) {
        firstFlag = flag;
        if (firstObservedFlagMs == null) {
          firstObservedFlagMs = flag.firstSeen > 0 ? Math.max(0, flag.firstSeen - startedAt) : now - startedAt;
          log(
            `[monitor] FLAG CANDIDATE at +${firstObservedFlagMs}ms: ` +
              JSON.stringify({ id: flag.id, value: flag.value, evidence: flag.evidence, status: flag.status }),
          );
        }
      }
      if (board.session && ["done", "stopped", "failed", "blocked"].includes(board.session.status)) {
        terminal = `session_${board.session.status}`;
        break;
      }
    }

    const inc = readStreamIncrement(opts.streamPath, streamOffset, partial, streamKinds);
    streamOffset = inc.nextOffset;
    partial = inc.partial;
    streamLines += inc.lines;
    streamKinds = inc.kinds;
    if (inc.maxLineBytes > streamMaxLine) streamMaxLine = inc.maxLineBytes;
    if (inc.lastTs != null) streamLastTs = inc.lastTs;

    if (cdp && opts.cdpIntervalMs > 0 && now - lastCdpAt >= opts.cdpIntervalMs) {
      lastCdpAt = now;
      await cdpSnapshotOnce();
    }

    if (now - lastProgress > 15_000) {
      lastProgress = now;
      log(
        `[monitor] t=${Math.round((now - startedAt) / 1000)}s ` +
          `status=${lastSession?.status ?? "?"} toolCalls=${lastSession?.toolCalls ?? "?"} ` +
          `pending=${board.approvals.filter((a) => a.status === "pending").length} ` +
          `flags=${board.flags.length} streamLines=${streamLines} ` +
          `cdpSnapshots=${cdpSnapshots} cdpTimeouts=${cdpTimeouts}`,
      );
    }
    await sleep(opts.pollMs);
  }

  log(`[monitor] terminal=${terminal}`);
  const finalBoard = readBoardState(opts.dbPath, opts.state.taskId, opts.state.sessionId);
  if (!finalBoard.dbError) {
    lastBoard = finalBoard;
    lastSession = finalBoard.session;
    for (const a of finalBoard.approvals) approvalsSeen.set(a.id, a);
  }
  const inc = readStreamIncrement(opts.streamPath, streamOffset, partial, streamKinds);
  streamLines += inc.lines;
  streamKinds = inc.kinds;
  if (inc.maxLineBytes > streamMaxLine) streamMaxLine = inc.maxLineBytes;
  if (inc.lastTs != null) streamLastTs = inc.lastTs;

  let stoppedByMonitor = false;
  if (
    cdp &&
    ((terminal === "timeout" && opts.stopOnTimeout) ||
      (terminal === "approval_stall" && opts.stopOnStall))
  ) {
    const ws = await resolveCdpWs();
    if (ws) {
      const stop = await cdp.stopSession(ws, opts.state.sessionId);
      stoppedByMonitor = stop.ok;
      log(`[monitor] session.stop: ${stop.ok ? JSON.stringify(stop.value) : stop.error}`);
    } else {
      log("[monitor] session.stop skipped: CDP unavailable; 需要人工停止。");
    }
  }

  const approvals = [...approvalsSeen.values()];
  const count = (status: string) => approvals.filter((a) => a.status === status).length;
  const approvalCounts = {
    created: approvals.length,
    approved: count("approved"),
    denied: count("denied"),
    timeout: count("timeout"),
    pending: count("pending"),
    auto: count("auto"),
  };
  const flags = lastBoard?.flags ?? [];
  const candidate = firstFlag ?? flags.find((f) => f.status === "new" || f.status === "confirmed") ?? null;
  let e2EvidenceChain = false;
  let confirmPathAvailable = false;
  if (candidate) {
    confirmPathAvailable = candidate.status === "new";
    const hasE2 = candidate.evidence === "E2" || candidate.sources.some((s) => s.evidence === "E2");
    e2EvidenceChain =
      hasE2 &&
      candidate.sources.length > 0 &&
      candidate.sources.some((s) => witnessExists(s.witness, "D:/agent/xuanwo", opts.state.taskId));
  }
  const tokenInfo = readWireTokens(opts.wirePath);
  const wallMs = Date.now() - startedAt;
  const healthForSession =
    lastHealth && typeof lastHealth === "object"
      ? ((lastHealth as Record<string, { toolCalls?: number; boardReads?: number }>)[opts.state.sessionId] ??
        null)
      : null;
  const result: MonitorResult = {
    challengeId: (opts.state.challengeId as string | undefined) ?? null,
    target: (opts.state.target as string | undefined) ?? null,
    taskId: opts.state.taskId,
    sessionId: opts.state.sessionId,
    monitorMode: "db+stream" + (cdp ? "+optional-cdp-oneshot" : ""),
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    wallMs,
    firstFlagMs: firstObservedFlagMs,
    toolCalls: healthForSession?.toolCalls ?? lastSession?.toolCalls ?? null,
    toolCallsDb: lastSession?.toolCalls ?? null,
    toolCallsHealth: healthForSession?.toolCalls ?? null,
    boardReads: healthForSession?.boardReads ?? null,
    approvals: approvalCounts,
    approvalDetails: approvals,
    flags,
    flagFound: Boolean(candidate),
    flagValue: candidate?.value ?? null,
    e2EvidenceChain,
    confirmPathAvailable,
    exportAvailable: null,
    tokens: tokenInfo.tokens,
    tokenSource: tokenInfo.source,
    tokenUsageRecords: tokenInfo.records,
    sessionStatus: lastSession?.status ?? null,
    sessionEndedAt: lastSession?.endedAt ? new Date(lastSession.endedAt).toISOString() : null,
    endedReason: terminal,
    cdp: {
      enabled: Boolean(cdp),
      snapshots: cdpSnapshots,
      timeouts: cdpTimeouts,
      errors: cdpErrors,
      reconnects: cdpReconnects,
      lastError: cdpLastError,
      lastHealth,
    },
    stream: {
      path: opts.streamPath,
      bytes: fs.existsSync(opts.streamPath) ? fs.statSync(opts.streamPath).size : 0,
      lines: streamLines,
      kinds: streamKinds,
      maxLineBytes: streamMaxLine,
      lastTs: streamLastTs,
    },
    errors,
    notes: [
      "DB + stream are the primary source; CDP snapshot is optional one-shot every 30s",
      "CDP timeout closes the socket and clears pending; no pending eval accumulation",
      "monitor never approves; never confirms a flag",
      `stoppedByMonitor=${stoppedByMonitor}`,
    ],
  };
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, JSON.stringify(result, null, 2) + "\n");
  log(`[monitor] evidence written: ${opts.outPath}`);
  return result;
}

// ---------------------------------------------------------------- CLI

function arg(name: string, fallback: string | null = null): string | null {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const kv = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (kv) return kv.slice(flag.length + 1);
  return fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (has("self-test")) {
    await runSelfTest("D:/agent/xuanwo");
    return;
  }
  const statePath = arg("state");
  let state: MonitorState;
  if (statePath) {
    state = JSON.parse(fs.readFileSync(statePath, "utf8")) as MonitorState;
  } else {
    const taskId = arg("task-id");
    const sessionId = arg("session-id");
    if (!taskId || !sessionId) {
      console.error("--state=<json> or --task-id/--session-id is required");
      process.exitCode = 2;
      return;
    }
    state = { taskId, sessionId, startedAt: Date.now() };
  }
  const repoRoot = "D:/agent/xuanwo";
  const dbPath = arg("db", path.join(repoRoot, ".ui-run", "board.db"))!;
  const sessionDir = path.join(repoRoot, ".ui-run", "sessions", state.sessionId);
  const streamPath = arg("stream", path.join(sessionDir, "stream.jsonl"))!;
  const wirePath = arg("wire", path.join(sessionDir, "wire.jsonl"));
  const outPath = arg("out", path.join(repoRoot, "evidence", "p6c-b2-monitor.json"))!;
  const cdpPort = arg("cdp-port");
  const result = await runMonitor({
    state,
    dbPath,
    streamPath,
    wirePath,
    outPath,
    cdpPort: cdpPort ? Number(cdpPort) : null,
    cdpIntervalMs: Number(arg("cdp-interval", "30000")),
    pollMs: Number(arg("poll", "5000")),
    timeoutMs: Number(arg("timeout", "900000")),
    approvalStallMs: Number(arg("approval-stall", "300000")),
    stopOnTimeout: !has("no-stop"),
    stopOnStall: !has("no-stop"),
  });
  process.stdout.write(JSON.stringify({ endedReason: result.endedReason, sessionStatus: result.sessionStatus }, null, 2) + "\n");
}

const isDirect = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isDirect) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
