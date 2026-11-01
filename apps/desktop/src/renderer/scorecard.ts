/**
 * 每会话计分卡（纯逻辑，无 DOM）。
 *
 * 数据全部来自**冻结契约里已有的字段**，不新增契约字段：
 *   - 墙钟时长：SessionView.startedAt / endedAt（endedAt 为空 = 还在跑，用 now 算）
 *   - 活动量：SessionHealth.toolCalls / boardReads / syncLag
 *   - 审批：snapshot.approvals 里 sessionId 匹配的条数
 *   - 黑板写入：snapshot.board 里 `by === sessionId` 的事实 + 死路
 *
 * 「黑板写入」的可归属范围要诚实：FactView / DeadEndView 有 `by` 字段，可归属；
 * IntentView 只有 claimedBy（认领人）、没有作者，LeaseView 只有 holder（持锁人）——
 * 两者都不是「写入」，所以不计入 write 数，不编造。这条口径写进了 scorecardTitle。
 */
import type { SessionView, SessionHealth, ApprovalView, FactView, DeadEndView } from "./contract.ts";
import { isTerminalStatus } from "./session-status.ts";

export interface SessionScorecardInput {
  session: SessionView;
  health: SessionHealth | undefined;
  approvals: ApprovalView[];
  facts: FactView[];
  deadEnds: DeadEndView[];
  now: number;
}

export interface SessionScorecard {
  sessionId: string;
  /** 是否仍在跑（非终态）；决定文案用「已运行」还是「历时」。 */
  running: boolean;
  elapsedMs: number;
  toolCalls: number;
  boardReads: number;
  /** null = 主进程尚未给过该会话的健康度（诚实显示「—」，而不是假装是 0）。 */
  syncLag: number | null;
  approvals: number;
  /** 事实 + 死路里 by === sessionId 的条数（意图/租约无作者，不计入）。 */
  boardWrites: number;
}

export function buildScorecard(input: SessionScorecardInput): SessionScorecard {
  const { session, health, approvals, facts, deadEnds, now } = input;
  const endedAt = session.endedAt ?? now;
  const elapsedMs = Math.max(0, endedAt - session.startedAt);
  const boardWrites =
    facts.filter((f) => f.by === session.id).length +
    deadEnds.filter((d) => d.by === session.id).length;
  return {
    sessionId: session.id,
    running: !isTerminalStatus(session.status),
    elapsedMs,
    toolCalls: health?.toolCalls ?? 0,
    boardReads: health?.boardReads ?? 0,
    syncLag: health ? health.syncLag : null,
    approvals: approvals.filter((a) => a.sessionId === session.id).length,
    boardWrites,
  };
}

/** 紧凑时长：42s / 3m20s / 1h02m / 2d1h（计分卡是密集条，不用「42 秒」这种全称）。 */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm === 0 ? `${h}h` : `${h}h${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d` : `${d}d${rh}h`;
}

/** 完整计分卡一行（窗格头部条）：六个字段全量。 */
export function scorecardText(sc: SessionScorecard): string {
  const elapsed = sc.running ? `已运行 ${fmtElapsed(sc.elapsedMs)}` : `历时 ${fmtElapsed(sc.elapsedMs)}`;
  const lag = sc.syncLag === null ? "—" : String(sc.syncLag);
  return `${elapsed} · 工具 ${sc.toolCalls} · 读板 ${sc.boardReads} · 滞后 ${lag} · 审批 ${sc.approvals} · 写板 ${sc.boardWrites}`;
}

/** 紧凑计分卡（左栏会话卡）：只留「多久 + 干了多少活」三个最直观的数。 */
export function scorecardTextCompact(sc: SessionScorecard): string {
  const elapsed = sc.running ? `已运行 ${fmtElapsed(sc.elapsedMs)}` : `历时 ${fmtElapsed(sc.elapsedMs)}`;
  return `${elapsed} · 工具 ${sc.toolCalls} · 写板 ${sc.boardWrites}`;
}

/** 派生口径说明（悬停提示）：让用户知道「写板」到底数了什么、为什么有的没数。 */
export function scorecardTitle(sc: SessionScorecard): string {
  const lag = sc.syncLag === null ? "N/A" : String(sc.syncLag);
  return (
    `写板 ${sc.boardWrites} = 事实 + 死路（两者带 by 署名）；` +
    `意图/租约无作者字段，不计入写板；` +
    `滞后 ${lag} = 距上次读黑板的 tool call 数`
  );
}
