/**
 * P6-A：benchmark 聚合纯函数。
 *
 * 只吃合成/落盘的 runs，不读文件、不写文件、不启动进程、不接触 agent。
 * P6-C 真实跑完后把 runs 交给这里做中位数/p95/失败率与“能否下结论”。
 */

export interface BenchRun {
  challengeId: string;
  sessions: number;
  tier: string;
  repeat: number;
  wallMs: number;
  firstFlagMs: number | null;
  toolCalls?: number;
  boardReads?: number;
  duplicateFacts?: number;
  approvals?: number;
  approvalWaitMs?: number;
  errors?: number;
  tokens?: number | null;
  cost?: number | null;
}

export interface BenchAggregate {
  /** 墙钟中位数（ms）；空 runs = 0。 */
  medianWallMs: number;
  /** 首个 flag 中位数（ms）；忽略 null/缺失；全部没有 = null。 */
  medianFirstFlagMs: number | null;
  /** 墙钟 p95（最近秩：ceil(0.95n)-1）；空 runs = 0。 */
  p95WallMs: number;
  /** errors>0 的 run 占比（4 位小数）；空 runs = 0。 */
  failureRate: number;
  /** 总 run 数。 */
  sampleCount: number;
  /** 每个 challenge 的最少 run 数（保守口径）；空 = 0。 */
  repeatsPerChallenge: number;
}

/** P6-A：结果文件 schema（P6-C 落盘；本步不写文件）。 */
export interface BenchEnvironment {
  os: string;
  node: string;
  electron: string;
  agent: string;
  model: string;
}

export interface BenchResultFile {
  runId: string;
  startedAt: number;
  environment: BenchEnvironment;
  runs: BenchRun[];
  aggregate: BenchAggregate;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function nearestRankP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx];
}

export function aggregate(runs: BenchRun[]): BenchAggregate {
  const sampleCount = runs.length;
  const walls = runs.map((r) => r.wallMs);
  const firstFlags = runs
    .map((r) => r.firstFlagMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const failures = runs.filter((r) => (r.errors ?? 0) > 0).length;
  const byChallenge = new Map<string, number>();
  for (const r of runs) {
    byChallenge.set(r.challengeId, (byChallenge.get(r.challengeId) ?? 0) + 1);
  }
  const repeatsPerChallenge =
    byChallenge.size === 0 ? 0 : Math.min(...byChallenge.values());
  return {
    medianWallMs: median(walls),
    medianFirstFlagMs: firstFlags.length === 0 ? null : median(firstFlags),
    p95WallMs: nearestRankP95(walls),
    failureRate: sampleCount === 0 ? 0 : Number((failures / sampleCount).toFixed(4)),
    sampleCount,
    repeatsPerChallenge,
  };
}

/**
 * 能否下结论：总 run >=3 且每个 challenge 至少 3 次。
 * 这只是“样本量够不够”的下限，不替代“真实 agent、固定环境、记录模型”的要求。
 */
export function canConclude(a: BenchAggregate): boolean {
  return a.sampleCount >= 3 && a.repeatsPerChallenge >= 3;
}
