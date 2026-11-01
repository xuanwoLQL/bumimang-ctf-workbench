/**
 * 多窗格的事件流模型（纯逻辑，无 DOM）。
 *
 * 每个会话一个 `SessionStreamSink`：把高频的 `session.stream` 事件先节流、
 * 再聚合成「对话块」（conversation blocks）交给 DOM 层。
 * 这是 T7 的核心，也是 ARCHITECTURE §6 已知坑「UI 必须节流聚合」的落点。
 *
 * R13 改造（2026-10-13）：把中栏从「平铺行日志」升级成「对话流」——
 *   - agent_message / agent_thought 的文本增量**累加进同一个块**（会话本来就是积累，
 *     不是每来一个 chunk 就 append 一行）；
 *   - tool_call + tool_call_update 合成**一步**：tool_call 建块，tool_call_update
 *     原地更新该步的状态（不是两个条目）；
 *   - tool_call_update 若没有对应的 tool_call 步（突发 / 乱序），只折叠计数、不新增块。
 *
 * 不变量：只有最后一个块会被改写（activeToolId 要么为空、要么指向最后一个块），
 * 这让 DOM 层可以「只 append 新块 + 原地更新末块」，避免每次 flush 全量重画。
 */
import type { SessionStatus, SessionView, StreamUpdate } from "../contract.ts";
import { StreamThrottler } from "../throttle.ts";

/** 对话块种类：把契约的 StreamUpdate.kind 映射成用户能读懂的会话单元。 */
export type ConvBlockKind = "message" | "thought" | "user" | "tool" | "plan" | "other";

export interface ConvBlock {
  /** 稳定 id（不是数组下标），供 DOM 层按块原地更新，避免截断后错位。 */
  id: number;
  kind: ConvBlockKind;
  /** 首条事件的 ts */
  ts: number;
  /** 最近一条事件的 ts */
  lastTs: number;
  /** message / thought / plan / other：累加后的文本。 */
  text?: string;
  /** tool：标题（如 "read target/index.html"）。 */
  title?: string;
  /** tool：工具名（如 fs/read_text_file）。 */
  toolKind?: string;
  /** tool：最近一次状态（in_progress / completed / failed …），由 tool_call_update 原地刷新。 */
  status?: string;
}

export interface ConvLog {
  sessionId: string;
  blocks: ConvBlock[];
  /** 累计折叠掉的 tool_call_update 条数（原地更新进状态，不产生新块）。 */
  collapsed: number;
  /** 累计真实 tool_call 步数（只数 tool_call，不数 tool_call_update）。 */
  toolCalls: number;
  /** 最近一条 tool_call_update.status。 */
  status?: string;
}

export interface SinkOptions {
  windowMs?: number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  maxBlocks?: number;
  /** 每次聚合刷出后回调，DOM 层用它把新块追加进窗格。 */
  onFlush?: (log: ConvLog) => void;
}

const MAX_BLOCKS = 500;

/**
 * P6-C 2.1 / D3：单个 thought 块最多保留的字符数。
 *
 * 批次 2 run 2 的 thought 块达到 69,623 字符，pane 每次 flush 对末块
 * `replaceChildren` + `scrollHeight` 时单次布局 181ms，页面卡死。这里只截断
 * thought（推理过程），message/tool/plan 不截断；保留最后 N 字符，前面加明确标记。
 */
export const MAX_THOUGHT_TEXT = 32_768;

/**
 * P6-C 2.1 / D3：follow 模式下可见窗口（最多 CONV_WINDOW 块）的总文本预算。
 *
 * 块数上限（120）不等于文本量上限；run 2 的 120 块可见窗口达到 221,366 字符。
 * 超出预算时从窗口头部丢老块（仍可通过「加载更早」回看），避免每次 flush 布局过大。
 */
export const MAX_WINDOW_TEXT = 131_072;

const THOUGHT_TRUNCATED_MARK = "…（前文过长已省略）\n";

/**
 * P6-C 2.1 / D3：计算 follow 窗口起点（最多 windowSize 块，且文本总量 <= maxText）。
 * 纯函数，panes.ts 与压测 harness 共用，避免两份口径。
 */
export function fitWindowStart(
  blocks: ConvBlock[],
  windowSize: number,
  maxText: number,
): number {
  let start = Math.max(0, blocks.length - windowSize);
  let sum = 0;
  for (let i = start; i < blocks.length; i += 1) sum += blocks[i]?.text?.length ?? 0;
  while (start < blocks.length - 1 && sum > maxText) {
    sum -= blocks[start]?.text?.length ?? 0;
    start += 1;
  }
  return start;
}

export class SessionStreamSink {
  readonly sessionId: string;
  private readonly throttler: StreamThrottler;
  private readonly onFlushCb?: (log: ConvLog) => void;
  private blocks: ConvBlock[] = [];
  private nextId = 1;
  /** 最近一个 tool_call 建的块 id；tool_call_update 原地更新它。非 tool 块出现时清空。 */
  private activeToolId: number | null = null;
  private collapsed = 0;
  private toolCalls = 0;
  private status: string | undefined;
  private readonly maxBlocks: number;
  /** 已处理的最大 seq（R16）：历史回放与实时推送可能重叠，靠它去重。 */
  private lastSeq = 0;

  constructor(sessionId: string, opts: SinkOptions = {}) {
    this.sessionId = sessionId;
    this.maxBlocks = opts.maxBlocks ?? MAX_BLOCKS;
    this.onFlushCb = opts.onFlush;
    this.throttler = new StreamThrottler({
      windowMs: opts.windowMs ?? 80,
      schedule: opts.schedule,
      onFlush: (batch) => this.apply(batch),
    });
  }

  push(u: StreamUpdate): void {
    if (typeof u.seq === "number") {
      if (u.seq <= this.lastSeq) return;
      this.lastSeq = u.seq;
    }
    this.throttler.push(u);
  }

  flush(): void {
    this.throttler.flush();
  }

  private newBlock(kind: ConvBlockKind, u: StreamUpdate): ConvBlock {
    const b: ConvBlock = { id: this.nextId++, kind, ts: u.ts, lastTs: u.ts };
    this.blocks.push(b);
    return b;
  }

  private lastBlock(): ConvBlock | undefined {
    return this.blocks[this.blocks.length - 1];
  }

  private apply(batch: StreamUpdate[]): void {
    for (const u of batch) {
      switch (u.kind) {
        case "tool_call_update": {
          // tool_call_update 是「同一次调用的进度推送」，不是新条目：
          // 原地更新最近那个 tool 块的状态；没有可更新的 tool 块（突发/乱序）只计数。
          this.collapsed += 1;
          if (u.status) this.status = u.status;
          const target =
            this.activeToolId != null ? this.blocks.find((b) => b.id === this.activeToolId) : undefined;
          if (target) {
            if (u.status) target.status = u.status;
            if (u.title && !target.title) target.title = u.title;
            target.lastTs = u.ts;
          }
          break;
        }
        case "tool_call": {
          this.toolCalls += 1;
          const b = this.newBlock("tool", u);
          b.title = u.title;
          b.toolKind = u.toolKind;
          b.status = u.status;
          this.activeToolId = b.id;
          break;
        }
        case "agent_message":
          this.accumulate("message", u);
          this.activeToolId = null;
          break;
        case "agent_thought":
          this.accumulate("thought", u);
          this.activeToolId = null;
          break;
        case "user_prompt":
          this.accumulate("user", u);
          this.activeToolId = null;
          break;
        case "plan":
          this.accumulate("plan", u);
          this.activeToolId = null;
          break;
        default: {
          this.accumulate("other", u);
          this.activeToolId = null;
          break;
        }
      }
    }
    if (this.blocks.length > this.maxBlocks) {
      this.blocks = this.blocks.slice(-this.maxBlocks);
    }
    this.onFlushCb?.(this.snapshot());
  }

  /** 同 kind 的文本增量累加进当前块；不同 kind（或首块）才开新块。 */
  private accumulate(kind: ConvBlockKind, u: StreamUpdate): void {
    const last = this.lastBlock();
    if (last && last.kind === kind) {
      if (u.text) last.text = (last.text ?? "") + u.text;
      last.lastTs = u.ts;
      if (kind === "thought" && (last.text?.length ?? 0) > MAX_THOUGHT_TEXT) {
        last.text = THOUGHT_TRUNCATED_MARK + (last.text ?? "").slice(-MAX_THOUGHT_TEXT);
      }
      return;
    }
    const b = this.newBlock(kind, u);
    b.text = u.text;
    if (kind === "thought" && (b.text?.length ?? 0) > MAX_THOUGHT_TEXT) {
      b.text = THOUGHT_TRUNCATED_MARK + (b.text ?? "").slice(-MAX_THOUGHT_TEXT);
    }
  }

  snapshot(): ConvLog {
    return {
      sessionId: this.sessionId,
      blocks: this.blocks.slice(),
      collapsed: this.collapsed,
      toolCalls: this.toolCalls,
      status: this.status,
    };
  }
}

/**
 * GATE-INPUT-STARVED（2026-10-13）：
 * 真实 agent（至少 opencode）在默认配置下从不请求授权，闸门「已武装但上游没水」。
 * 所以一个跑了很久的会话如果 0 审批 + 0 读黑板，可能不是「没事」，而是「它不会问」。
 * 这里给出一个**安静**的提示（不是告警），帮用户区分「没有需要审批的」和「没有审批的能力」。
 */

/** 会话跑了多久仍 0 审批 + 0 读黑板时，才开始给安静提示。 */
export const QUIET_HINT_AFTER_MS = 30_000;

export interface SessionQuietHintInput {
  status: SessionStatus;
  startedAt: number;
  /** 该会话名下已产生的审批条数（含已决 —— 问过就算，不问才会提示） */
  approvalsForSession: number;
  /** 黑板累计读取次数（SessionHealth.boardReads；健康度缺失按 0 计） */
  boardReads: number;
  /** 当前时钟（毫秒时间戳），测试可注入 */
  now: number;
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
}

/** 返回 null 表示无需提示；否则返回一句平静、事实性的提示语。 */
export function sessionQuietHint(input: SessionQuietHintInput): string | null {
  if (input.status !== "running") return null;
  if (input.approvalsForSession > 0) return null;
  if (input.boardReads > 0) return null;
  const elapsed = input.now - input.startedAt;
  if (elapsed < QUIET_HINT_AFTER_MS) return null;
  return `已运行 ${fmtDuration(elapsed)}，尚无审批请求、未读黑板 —— 可能还没到关键动作，也可能是该 agent 默认不请求授权。`;
}

/**
 * P1-E：焦点任务的 pane 选择（纯逻辑，smoke 可直接验证）。
 *
 * 焦点最多保留 3 个 pane；优先活跃会话（避免在跑的会话被历史挤掉），
 * 余量再用最近结束的终态会话补足，方便回看历史。后台会话不在 `sessions`
 * 里（store 只存焦点），所以这里天然不会为后台建 DOM。
 */
export function selectPaneSessions(sessions: SessionView[], max = 3): SessionView[] {
  const terminal = (s: SessionView): boolean =>
    s.status === "blocked" || s.status === "done" || s.status === "failed" || s.status === "stopped";
  const active = sessions
    .filter((s) => !terminal(s))
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, Math.max(0, max));
  const picked = new Set(active.map((s) => s.id));
  const history = sessions
    .filter((s) => terminal(s) && !picked.has(s.id))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, Math.max(0, max - active.length));
  return [...active, ...history].sort((a, b) => a.startedAt - b.startedAt);
}
