/**
 * V2-P0-6：benchmark 指标聚合（纯函数，不启动 agent、不调用平台）。
 *
 * 纪律：样本 <3 时 canConclude=false；不把单次结果当规律。
 * token 缺失时保持 null，不估造成本。
 */

export interface BenchRunMetrics {
  challengeId: string;
  /** 配置标识：S1/S2/S3 或 guarded/autonomous 等。 */
  configId: string;
  sampleIndex: number;
  solved: boolean;
  firstAnswerMs: number | null;
  makespanMs: number | null;
  toolCalls: number;
  boardReads: number;
  duplicateFacts: number;
  wrongCandidates: number;
  approvalCount: number;
  approvalWaitMs: number;
  scopeViolations: number;
  tokens: number | null;
  cost: number | null;
  crashes: number;
  recoveries: number;
  manualInterventions: number;
}

export interface MetricSummary {
  median: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  valid: number;
}

export interface BenchAggregate {
  challengeId: string;
  configId: string;
  sampleSize: number;
  solved: number;
  solveRate: number;
  canConclude: boolean;
  notes: string[];
  firstAnswerMs: MetricSummary;
  makespanMs: MetricSummary;
  toolCalls: MetricSummary;
  boardReads: MetricSummary;
  duplicateFactsTotal: number;
  wrongCandidatesTotal: number;
  approvalCountTotal: number;
  approvalWaitMs: MetricSummary;
  scopeViolationsTotal: number;
  tokensTotal: number | null;
  costTotal: number | null;
  crashesTotal: number;
  recoveriesTotal: number;
  manualInterventionsTotal: number;
}

export function median(values: number[]): number | null {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid]! : (list[mid - 1]! + list[mid]!) / 2;
}

/** 最近秩 p90：sorted[ceil(p*n)-1]；空数组返回 null。 */
export function percentile(values: number[], p: number): number | null {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = Math.min(list.length, Math.max(1, Math.ceil(p * list.length)));
  return list[rank - 1]!;
}

function summarize(values: Array<number | null>): MetricSummary {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    median: median(nums),
    p90: percentile(nums, 0.9),
    min: nums.length ? Math.min(...nums) : null,
    max: nums.length ? Math.max(...nums) : null,
    valid: nums.length,
  };
}

export function aggregateBenchMetrics(
  runs: BenchRunMetrics[],
  opts: { challengeId?: string; configId?: string; minSamples?: number } = {},
): BenchAggregate {
  const challengeId = opts.challengeId ?? runs[0]?.challengeId ?? "unknown";
  const configId = opts.configId ?? runs[0]?.configId ?? "unknown";
  const group = runs.filter(
    (r) => r.challengeId === challengeId && r.configId === configId,
  );
  const minSamples = Math.max(1, opts.minSamples ?? 3);
  const solved = group.filter((r) => r.solved).length;
  const tokens = group.map((r) => r.tokens).filter((v): v is number => typeof v === "number");
  const costs = group.map((r) => r.cost).filter((v): v is number => typeof v === "number");
  const notes: string[] = [];
  if (group.length < minSamples) {
    notes.push(`样本量 ${group.length} < ${minSamples}：结论不足，不写成规律`);
  }
  if (tokens.length < group.length) {
    notes.push(`token 记录不完整（${tokens.length}/${group.length}）：成本不可比`);
  }
  if (group.length > 0 && group.every((r) => !r.solved)) {
    notes.push("全部未解出：需检查靶场存活/题面/标准答案，不应直接归因于模型");
  }
  return {
    challengeId,
    configId,
    sampleSize: group.length,
    solved,
    solveRate: group.length ? solved / group.length : 0,
    canConclude: group.length >= minSamples,
    notes,
    firstAnswerMs: summarize(group.map((r) => r.firstAnswerMs)),
    makespanMs: summarize(group.map((r) => r.makespanMs)),
    toolCalls: summarize(group.map((r) => r.toolCalls)),
    boardReads: summarize(group.map((r) => r.boardReads)),
    duplicateFactsTotal: group.reduce((n, r) => n + r.duplicateFacts, 0),
    wrongCandidatesTotal: group.reduce((n, r) => n + r.wrongCandidates, 0),
    approvalCountTotal: group.reduce((n, r) => n + r.approvalCount, 0),
    approvalWaitMs: summarize(group.map((r) => r.approvalWaitMs)),
    scopeViolationsTotal: group.reduce((n, r) => n + r.scopeViolations, 0),
    tokensTotal: tokens.length ? tokens.reduce((n, v) => n + v, 0) : null,
    costTotal: costs.length ? costs.reduce((n, v) => n + v, 0) : null,
    crashesTotal: group.reduce((n, r) => n + r.crashes, 0),
    recoveriesTotal: group.reduce((n, r) => n + r.recoveries, 0),
    manualInterventionsTotal: group.reduce((n, r) => n + r.manualInterventions, 0),
  };
}

export function formatBenchAggregate(a: BenchAggregate): string {
  const fmt = (m: MetricSummary): string =>
    m.median === null ? "n/a" : `${m.median.toFixed(0)}ms(median)/${m.p90?.toFixed(0) ?? "n/a"}ms(p90)`;
  return [
    `# ${a.challengeId} · ${a.configId}`,
    `样本=${a.sampleSize} 解出=${a.solved} solveRate=${(a.solveRate * 100).toFixed(1)}% 可下结论=${a.canConclude}`,
    `firstAnswer=${fmt(a.firstAnswerMs)} makespan=${fmt(a.makespanMs)}`,
    `toolCalls=${a.toolCalls.median ?? "n/a"} boardReads=${a.boardReads.median ?? "n/a"}`,
    `duplicateFacts=${a.duplicateFactsTotal} wrongCandidates=${a.wrongCandidatesTotal} approval=${a.approvalCountTotal} scopeViolations=${a.scopeViolationsTotal}`,
    `tokens=${a.tokensTotal ?? "n/a"} cost=${a.costTotal ?? "n/a"} crashes=${a.crashesTotal} recoveries=${a.recoveriesTotal} manual=${a.manualInterventionsTotal}`,
    ...(a.notes.length ? a.notes.map((n) => `- ${n}`) : []),
  ].join("\n");
}
