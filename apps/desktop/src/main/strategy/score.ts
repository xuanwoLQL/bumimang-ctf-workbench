/**
 * V2-P0-3：可解释评分。
 *
 * EV = expectedPoints × successProbability × marginalEvidence / (timeCost + costWeight)
 *
 * - expectedPoints：points 优先，否则 priority（都缺省时 1，避免除零/全零）。
 * - successProbability：题型基准 × 难度系数 × 时间是否够；scope 风险另乘。
 * - marginalEvidence：无候选 / E0 / E1 / E2 / 已确认 五档。
 * - timeCost：题型基准分钟 × 难度系数。
 * - costWeight：活跃会话数 × sessionCost + 待审批 × approvalCost。
 *
 * 权重集中可配置；不针对 Web 写死规则。
 */

import type {
  StrategyCandidateInput,
  StrategyInput,
  StrategyScopeRisk,
  StrategyScoreBreakdown,
  StrategySessionInput,
  StrategyTaskInput,
  StrategyWeights,
} from "./model.ts";
import { DEFAULT_WEIGHTS } from "./model.ts";

export function mergeWeights(overrides?: Partial<StrategyWeights>): StrategyWeights {
  return {
    ...DEFAULT_WEIGHTS,
    ...(overrides ?? {}),
    categorySuccess: { ...DEFAULT_WEIGHTS.categorySuccess, ...(overrides?.categorySuccess ?? {}) },
    categoryMinutes: { ...DEFAULT_WEIGHTS.categoryMinutes, ...(overrides?.categoryMinutes ?? {}) },
  };
}

export function difficultyFactor(difficulty: StrategyTaskInput["difficulty"]): number {
  if (typeof difficulty === "number" && Number.isFinite(difficulty)) {
    return Math.max(0.4, Math.min(1.3, difficulty));
  }
  switch (difficulty) {
    case "easy":
      return 1.2;
    case "hard":
      return 0.75;
    case "medium":
    default:
      return 1;
  }
}

export function expectedPoints(task: StrategyTaskInput): number {
  if (Number.isFinite(task.points) && task.points > 0) return task.points;
  if (Number.isFinite(task.priority) && task.priority > 0) return task.priority;
  return 1;
}

export function marginalEvidence(candidates: StrategyCandidateInput[], weights: StrategyWeights): number {
  if (candidates.some((c) => c.status === "confirmed")) return weights.evidenceConfirmed;
  const fresh = candidates.filter((c) => c.status === "new");
  if (fresh.some((c) => c.evidence === "E2")) return weights.evidenceE2;
  if (fresh.some((c) => c.evidence === "E1")) return weights.evidenceE1;
  if (fresh.some((c) => c.evidence === "E0")) return weights.evidenceE0;
  return weights.evidenceNone;
}

export interface NoProgressAssessment {
  stalled: boolean;
  minutesSinceProgress: number;
  callsSinceProgress: number;
  factor: number;
  reason: string | null;
}

export function assessNoProgress(
  session: StrategySessionInput,
  now: number,
  weights: StrategyWeights,
  opts: { toolCalls: number; minutes: number; taskLastProgressAt?: number } = {
    toolCalls: 12,
    minutes: 10,
  },
): NoProgressAssessment {
  const started = session.lastProgressAt ?? session.startedAt ?? now;
  const taskLast = opts.taskLastProgressAt ?? 0;
  const last = Math.max(started, taskLast);
  const minutesSinceProgress = Math.max(0, (now - last) / 60_000);
  const callsSinceProgress = Math.max(0, session.toolCallsSinceProgress ?? 0);
  const byCalls = callsSinceProgress >= opts.toolCalls;
  const byMinutes = minutesSinceProgress >= opts.minutes;
  const stalled = byCalls || byMinutes;
  const factor = stalled ? Math.pow(weights.noProgressPenalty, Math.max(1, callsSinceProgress / Math.max(1, opts.toolCalls))) : 1;
  return {
    stalled,
    minutesSinceProgress,
    callsSinceProgress,
    factor,
    reason: stalled
      ? byCalls
        ? `连续 ${callsSinceProgress} 次工具调用没有新事实/死路/候选/证据`
        : `${Math.round(minutesSinceProgress)} 分钟没有新事实/死路/候选/证据`
      : null,
  };
}

export function scopeMultiplier(risk: StrategyScopeRisk | undefined, weights: StrategyWeights): number {
  if (!risk) return 1;
  if (risk.hasDenyTargets) return Math.min(weights.scopeRiskMultiplier, 0.5);
  if (risk.hasUnknownTargets) return weights.scopeRiskMultiplier;
  return 1;
}

export function computeScore(input: {
  task: StrategyTaskInput;
  sessions: StrategySessionInput[];
  candidates: StrategyCandidateInput[];
  risk?: StrategyScopeRisk;
  budget: StrategyInput["budget"];
  weights: StrategyWeights;
  noProgress: NoProgressAssessment;
}): StrategyScoreBreakdown & { expectedValue: number; confidence: number; timeRisk: boolean } {
  const { task, sessions, candidates, risk, budget, weights, noProgress } = input;
  const active = sessions.filter((s) => !["blocked", "stopped", "failed", "done"].includes(s.status));
  const pendingApprovals = active.reduce((n, s) => n + (s.approvalsPending ?? 0), 0);
  const baseSuccess = weights.categorySuccess[task.category] ?? 0.5;
  const difficulty = difficultyFactor(task.difficulty);
  const baseMinutes = (weights.categoryMinutes[task.category] ?? 40) / difficulty;
  const evidence = marginalEvidence(candidates, weights);
  const scope = scopeMultiplier(risk, weights);
  const timeCostMinutes = Math.max(1, baseMinutes);

  // 时间够不够：剩余时间 < 预估时间时，成功概率显著下降（不直接拒绝，交给人判断）。
  let timeRisk = false;
  let success = baseSuccess * difficulty;
  if (budget.remainingMs !== undefined && budget.remainingMs > 0) {
    const ratio = budget.remainingMs / (timeCostMinutes * 60_000);
    if (ratio < 1) {
      timeRisk = true;
      success *= Math.max(0.25, ratio * 0.6);
    } else if (ratio < 1.5) {
      success *= 0.85;
    }
  }
  if (budget.humanApprovalsRemaining !== undefined && pendingApprovals > budget.humanApprovalsRemaining) {
    success *= 0.8;
  }
  success = Math.max(0.05, Math.min(0.95, success)) * scope * noProgress.factor;

  const costWeight =
    active.length * (budget.sessionCost ?? 4) + pendingApprovals * (budget.approvalCost ?? 1);
  const expectedValue = (expectedPoints(task) * success * evidence) / (timeCostMinutes + costWeight);
  const confidence = Math.max(
    0.2,
    Math.min(
      0.9,
      0.35 +
        Math.min(0.3, evidence / 6) +
        (active.length > 0 ? 0.1 : 0) +
        (budget.remainingMs === undefined ? 0 : 0.1) -
        (scope < 1 ? 0.1 : 0) -
        (noProgress.stalled ? 0.1 : 0),
    ),
  );

  return {
    expectedPoints: expectedPoints(task),
    successProbability: Number(success.toFixed(4)),
    marginalEvidence: evidence,
    timeCostMinutes: Number(timeCostMinutes.toFixed(1)),
    costWeight: Number(costWeight.toFixed(2)),
    scopeRisk: Number((1 - scope).toFixed(2)),
    noProgress: Number((1 - noProgress.factor).toFixed(2)),
    expectedValue: Number(expectedValue.toFixed(4)),
    confidence: Number(confidence.toFixed(2)),
    timeRisk,
  };
}
