/**
 * P6-A：benchmark manifest / dry-run 计划 / 聚合纯函数单元测试。
 *
 * 只测：
 *  - A manifest schema 校验（合法/缺字段/非法 category/重复 id/expectedFlagFile 不存在）
 *  - B dry-run 计划（题数 × 重复 × 会话数；不启动 agent）
 *  - C 聚合纯函数（中位数/p95/失败率/重复不足）
 *  - D 非 dry-run 明确拒绝；bench/soak 源码无进程/agent 客户端
 *
 * 不测真实跑、不测 fake agent、不测 soak、不烧 token。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, canConclude, type BenchRun } from "./bench-aggregate.ts";
import {
  parseBenchArgs,
  loadManifest,
  validateManifest,
  buildBenchPlan,
  formatBenchPlan,
  runBench,
} from "./bench.ts";
import { parseSoakArgs, buildSoakPlan, formatSoakPlan, runSoak } from "./bench-soak.ts";
import { aggregateBenchMetrics, formatBenchAggregate, median, percentile, type BenchRunMetrics } from "./bench-metrics.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const EXAMPLE = join(REPO, "benchmarks", "challenges.example.json");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
function throws(name: string, fn: () => unknown, includes: string): void {
  try {
    fn();
    check(name, false, "没有抛错");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    check(name, msg.includes(includes), msg);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "bumimang-p6a-"));
mkdirSync(join(TMP, "expected"), { recursive: true });
writeFileSync(join(TMP, "expected", "ok.txt"), "flag{placeholder}\n", "utf8");

function baseManifest() {
  return {
    version: 1,
    challenges: [
      {
        id: "fixture-1",
        category: "web",
        difficulty: "easy",
        brief: "fixture brief",
        attachments: [],
        targets: [],
        expectedFlagFile: "expected/ok.txt",
        timeoutMs: 900000,
        maxSessions: 3,
      },
    ],
  };
}
function tryValidate(raw: unknown) {
  try {
    return { ok: true as const, manifest: validateManifest(raw, { repoRoot: TMP }) };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message ?? String(err) };
  }
}

async function main(): Promise<void> {
  console.log("================ P6-A A 组：manifest 校验 ================\n");
  const exampleRaw = loadManifest(EXAMPLE);
  const example = validateManifest(exampleRaw, { repoRoot: REPO });
  eq("A 合法 example manifest 通过", example.challenges.length, 3);
  check(
    "A example 只含占位 id",
    example.challenges.every((c) => c.id.startsWith("example-")),
    JSON.stringify(example.challenges.map((c) => c.id)),
  );

  const ok = tryValidate(baseManifest());
  check("A 合法 fixture 通过", ok.ok === true, ok.ok ? "" : ok.error);

  const missingId = baseManifest();
  delete (missingId.challenges[0] as { id?: string }).id;
  throws("A 缺 id 被拒", () => validateManifest(missingId, { repoRoot: TMP }), "id");

  const badCategory = baseManifest();
  badCategory.challenges[0].category = "web2";
  throws("A 非法 category 被拒", () => validateManifest(badCategory, { repoRoot: TMP }), "category");

  const badDifficulty = baseManifest();
  badDifficulty.challenges[0].difficulty = "insane";
  throws("A 非法 difficulty 被拒", () => validateManifest(badDifficulty, { repoRoot: TMP }), "difficulty");

  const dup = baseManifest();
  dup.challenges.push({ ...dup.challenges[0] });
  throws("A 重复 id 被拒", () => validateManifest(dup, { repoRoot: TMP }), "重复");

  const missingFile = baseManifest();
  missingFile.challenges[0].expectedFlagFile = "expected/missing.txt";
  throws(
    "A expectedFlagFile 不存在被拒",
    () => validateManifest(missingFile, { repoRoot: TMP }),
    "expectedFlagFile",
  );

  const badTimeout = baseManifest();
  badTimeout.challenges[0].timeoutMs = 0;
  throws("A timeoutMs=0 被拒", () => validateManifest(badTimeout, { repoRoot: TMP }), "timeoutMs");

  const badMax = baseManifest();
  badMax.challenges[0].maxSessions = 4;
  throws("A maxSessions=4 被拒", () => validateManifest(badMax, { repoRoot: TMP }), "maxSessions");

  const badVersion = baseManifest();
  badVersion.version = 2;
  throws("A version=2 被拒", () => validateManifest(badVersion, { repoRoot: TMP }), "version");

  const missingBrief = baseManifest();
  delete (missingBrief.challenges[0] as { brief?: string }).brief;
  throws("A 缺 brief 被拒", () => validateManifest(missingBrief, { repoRoot: TMP }), "brief");

  const badAttachments = baseManifest();
  (badAttachments.challenges[0] as unknown as { attachments: unknown }).attachments = "x";
  throws("A attachments 非数组被拒", () => validateManifest(badAttachments, { repoRoot: TMP }), "attachments");

  throws(
    "A challenge 过滤不存在被拒",
    () => validateManifest(baseManifest(), { repoRoot: TMP, challengeId: "nope" }),
    "challenge",
  );

  console.log("\n================ P6-A B 组：dry-run 计划 ================\n");
  const plan = buildBenchPlan(example, {
    repeats: 3,
    sessions: 2,
    manifestPath: EXAMPLE,
  });
  eq("B 计划题数", plan.challenges.length, 3);
  eq("B 计划 repeats", plan.repeats, 3);
  eq("B 计划 sessions", plan.sessions, 2);
  eq("B runCount=题数×重复", plan.runCount, 9);
  eq("B sessionCount=run×会话", plan.sessionCount, 18);
  eq("B 预计最坏墙钟=sessionCount×maxTimeout", plan.estimatedWallMs, 18 * 1800000);
  const planText = formatBenchPlan(plan);
  check("B 计划文本含题数/repeats/sessions", planText.includes("题数=3") && planText.includes("repeats=3") && planText.includes("sessions=2"), planText.slice(0, 300));
  check("B 计划文本明确不启动 agent/0 token", planText.includes("不启动 agent") && planText.includes("0 token"), planText.slice(0, 300));

  const selected = buildBenchPlan(example, { repeats: 3, sessions: 1, challengeId: "example-web-1" });
  eq("B --challenge 过滤题数", selected.challenges.length, 1);
  eq("B --challenge 过滤 runCount", selected.runCount, 3);

  let agentStarts = 0;
  const dryRes = await runBench({
    dry: true,
    manifestPath: EXAMPLE,
    repeats: 3,
    sessions: 2,
    repoRoot: REPO,
    hooks: { onAgentStart: () => { agentStarts += 1; } },
  });
  check("B dry-run 返回 ok", dryRes.ok === true, JSON.stringify(dryRes).slice(0, 200));
  eq("B dry-run 启动 agent 次数=0", agentStarts, 0);

  const parsed = parseBenchArgs(["--manifest", EXAMPLE, "--repeats=3", "--sessions=2"]);
  check("B 参数默认 dry=true", parsed.dry === true, String(parsed.dry));
  eq("B 参数 repeats", parsed.repeats, 3);
  eq("B 参数 sessions", parsed.sessions, 2);
  check("B --no-dry 可解析", parseBenchArgs(["--no-dry"]).dry === false);
  throws("B repeats=0 被拒", () => parseBenchArgs(["--repeats=0"]), "repeats");
  throws("B sessions=4 被拒", () => parseBenchArgs(["--sessions=4"]), "sessions");

  console.log("\n================ P6-A C 组：聚合纯函数 ================\n");
  const runs = (walls: number[], errors: number[] = [], firstFlags?: Array<number | null>): BenchRun[] =>
    walls.map((wallMs, i) => ({
      challengeId: "c1",
      sessions: 1,
      tier: "guarded",
      repeat: i + 1,
      wallMs,
      firstFlagMs: firstFlags ? firstFlags[i] : wallMs,
      errors: errors[i] ?? 0,
    }));

  const empty = aggregate([]);
  eq("C 空 runs medianWallMs=0", empty.medianWallMs, 0);
  eq("C 空 runs medianFirstFlagMs=null", empty.medianFirstFlagMs, null);
  eq("C 空 runs sampleCount=0", empty.sampleCount, 0);
  check("C 空 runs canConclude=false", canConclude(empty) === false);

  const three = aggregate(runs([100, 200, 300]));
  eq("C 中位数 three=200", three.medianWallMs, 200);
  eq("C p95 three=300", three.p95WallMs, 300);
  eq("C sampleCount=3", three.sampleCount, 3);
  eq("C repeatsPerChallenge=3", three.repeatsPerChallenge, 3);
  check("C 3 次同题 canConclude=true", canConclude(three) === true);

  const four = aggregate(runs([100, 200, 300, 400]));
  eq("C 中位数 four=250", four.medianWallMs, 250);
  eq("C p95 four=400", four.p95WallMs, 400);

  const failed = aggregate(runs([100, 200, 300], [0, 1, 0]));
  eq("C failureRate=1/3", failed.failureRate, 0.3333);

  const firstNull = aggregate(runs([100, 200, 300], [], [100, null, 300]));
  eq("C medianFirstFlagMs 忽略 null=200", firstNull.medianFirstFlagMs, 200);
  const allNull = aggregate(runs([100, 200, 300], [], [null, null, null]));
  eq("C medianFirstFlagMs 全 null=null", allNull.medianFirstFlagMs, null);

  const twenty = aggregate(runs(Array.from({ length: 20 }, (_, i) => i + 1)));
  eq("C p95 twenty=19", twenty.p95WallMs, 19);

  const mixed: BenchRun[] = [
    ...runs([1, 2, 3]).map((r) => ({ ...r, challengeId: "a" })),
    ...runs([4, 5]).map((r) => ({ ...r, challengeId: "b" })),
  ];
  const mixedAgg = aggregate(mixed);
  eq("C 两题 sampleCount=5", mixedAgg.sampleCount, 5);
  eq("C repeatsPerChallenge 取最小=2", mixedAgg.repeatsPerChallenge, 2);
  check("C 重复不足 3 canConclude=false", canConclude(mixedAgg) === false);

  console.log("\n================ P6-A D 组：非 dry-run 拒绝 / 无进程 API ================\n");
  let benchHook = 0;
  const noDryBench = await runBench({
    dry: false,
    manifestPath: EXAMPLE,
    repeats: 3,
    sessions: 1,
    repoRoot: REPO,
    hooks: { onAgentStart: () => { benchHook += 1; } },
  });
  check("D bench 非 dry-run 被拒", noDryBench.ok === false, JSON.stringify(noDryBench));
  check("D bench 错误可读（P6-C）", String(noDryBench.error ?? "").includes("P6-C"), String(noDryBench.error));
  eq("D bench 非 dry-run 启动 agent=0", benchHook, 0);

  const soakOpts = parseSoakArgs([]);
  eq("D soak 默认 tasks=3", soakOpts.tasks, 3);
  eq("D soak 默认 sessions=3", soakOpts.sessions, 3);
  eq("D soak 默认 minutes=60", soakOpts.minutes, 60);
  const soakPlan = buildSoakPlan(soakOpts);
  eq("D soak sessionCount=9", soakPlan.sessionCount, 9);
  eq("D soak sessionMinutes=540", soakPlan.sessionMinutes, 540);
  const soakText = formatSoakPlan(soakPlan);
  check("D soak 计划文本含 tasks/sessions/minutes", soakText.includes("tasks=3") && soakText.includes("sessions=3") && soakText.includes("minutes=60"), soakText.slice(0, 200));
  check("D soak 计划明确不启动/0 token", soakText.includes("不启动") && soakText.includes("0 token"), soakText.slice(0, 200));
  check("D soak --no-dry 可解析", parseSoakArgs(["--no-dry"]).dry === false);
  check(
    "D soak dry/minutes 触发规则",
    parseSoakArgs(["--dry", "--minutes=60"]).dry === true &&
      parseSoakArgs(["--minutes=60"]).dry === false,
    JSON.stringify({
      dryWithMinutes: parseSoakArgs(["--dry", "--minutes=60"]).dry,
      minutesOnly: parseSoakArgs(["--minutes=60"]).dry,
    }),
  );
  throws("D soak tasks=4 被拒", () => parseSoakArgs(["--tasks=4"]), "tasks");
  throws("D soak minutes=0 被拒", () => parseSoakArgs(["--minutes=0"]), "minutes");
  throws("D soak sessions=4 被拒", () => parseSoakArgs(["--sessions=4"]), "sessions");

  let soakHook = 0;
  const invalidSoak = await runSoak({
    dry: false,
    tasks: 0,
    sessions: 3,
    minutes: 60,
    intervalMs: 60000,
    hooks: { onAgentStart: () => { soakHook += 1; } },
  });
  check(
    "D soak 非 dry-run 参数错误可读（不跑）",
    invalidSoak.ok === false && String(invalidSoak.error ?? "").includes("tasks"),
    JSON.stringify(invalidSoak),
  );
  eq("D soak 非 dry-run 启动 agent=0", soakHook, 0);

  const benchSrc = readFileSync(join(REPO, "apps", "desktop", "src", "cli", "bench.ts"), "utf8");
  const soakSrc = readFileSync(join(REPO, "apps", "desktop", "src", "cli", "bench-soak.ts"), "utf8");
  const aggSrc = readFileSync(join(REPO, "apps", "desktop", "src", "cli", "bench-aggregate.ts"), "utf8");
  const processRe = /\bchild_process\b|\bspawn\b|\bexec(?:File|Sync)?\b/;
  const agentImportRe = /from\s+["'][^"']*(?:session\/manager|acp\/|discovery\/detect|verify-ab)[^"']*["']/;
  check("D bench.ts 无进程 API", !processRe.test(benchSrc), "child_process/spawn/exec");
  check("D bench.ts 不 import agent/session/verify-ab", !agentImportRe.test(benchSrc), "agent import");
  check("D bench-soak.ts 无进程 API", !processRe.test(soakSrc), "child_process/spawn/exec");
  check("D bench-soak.ts 不 import agent/session/verify-ab", !agentImportRe.test(soakSrc), "agent import");
  check("D bench-aggregate.ts 无进程 API", !processRe.test(aggSrc), "child_process/spawn/exec");
  check("D bench-aggregate.ts 不 import fs", !/from\s+["']node:fs["']/.test(aggSrc), "node:fs");

  // ---------------------------------------------------------------- E V2-P0-6 指标/manifest
  console.log("\n================ V2-P0-6 E 组：manifest 新字段 / 指标聚合 ================\n");
  {
    const m = baseManifest();
    m.challenges[0].expectedFlagFile = "";
    (m.challenges[0] as Record<string, unknown>).expectedAnswerFile = "expected/ok.txt";
    (m.challenges[0] as Record<string, unknown>).answerSpec = {
      mode: "flag_regex",
      pattern: "DASCTF\\{[^}\\s]+\\}",
      answerType: "flag",
    };
    (m.challenges[0] as Record<string, unknown>).resetMode = "manual";
    (m.challenges[0] as Record<string, unknown>).allowedTargets = ["10.0.0.0/8"];
    (m.challenges[0] as Record<string, unknown>).forbiddenActions = ["submit"];
    (m.challenges[0] as Record<string, unknown>).agent = "claude";
    (m.challenges[0] as Record<string, unknown>).role = "lead";
    (m.challenges[0] as Record<string, unknown>).tier = "guarded";
    (m.challenges[0] as Record<string, unknown>).budget = { tokens: 1000, wallMs: 900000 };
    const validated = tryValidate(m);
    check("E1 新字段 manifest 通过", validated.ok, validated.ok ? "" : validated.error);
    if (validated.ok) {
      const c = validated.manifest.challenges[0]!;
      eq("E1 expectedAnswerFile", c.expectedAnswerFile, "expected/ok.txt");
      eq("E1 answerSpec.mode", c.answerSpec?.mode, "flag_regex");
      eq("E1 resetMode", c.resetMode, "manual");
      eq("E1 allowedTargets", (c.allowedTargets ?? []).join(","), "10.0.0.0/8");
      eq("E1 agent/role/tier", `${c.agent}/${c.role}/${c.tier}`, "claude/lead/guarded");
      eq("E1 budget", JSON.stringify(c.budget), JSON.stringify({ tokens: 1000, wallMs: 900000 }));
    }
    const badAnswerSpec = baseManifest();
    (badAnswerSpec.challenges[0] as Record<string, unknown>).answerSpec = { mode: "nope" };
    throws("E2 非法 answerSpec 被拒", () => validateManifest(badAnswerSpec, { repoRoot: TMP }), "answerSpec");
    const badReset = baseManifest();
    (badReset.challenges[0] as Record<string, unknown>).resetMode = "platform-api";
    throws("E2 平台 resetMode 被拒", () => validateManifest(badReset, { repoRoot: TMP }), "resetMode");
    const noExpected = baseManifest();
    noExpected.challenges[0].expectedFlagFile = "";
    throws("E2 没有标准答案文件被拒", () => validateManifest(noExpected, { repoRoot: TMP }), "expectedFlagFile");
    const badBudget = baseManifest();
    (badBudget.challenges[0] as Record<string, unknown>).budget = { tokens: -1 };
    throws("E2 非法 budget 被拒", () => validateManifest(badBudget, { repoRoot: TMP }), "budget");

    eq("E3 median 奇数", median([3, 1, 2]), 2);
    eq("E3 median 偶数", median([1, 2, 3, 4]), 2.5);
    eq("E3 median 空", median([]), null);
    eq("E3 p90 最近秩", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);

    const mk = (i: number, over: Partial<BenchRunMetrics> = {}): BenchRunMetrics => ({
      challengeId: "c1",
      configId: "S1",
      sampleIndex: i,
      solved: true,
      firstAnswerMs: 1000 + i * 100,
      makespanMs: 2000 + i * 100,
      toolCalls: 10 + i,
      boardReads: 2 + i,
      duplicateFacts: 1,
      wrongCandidates: i,
      approvalCount: 1,
      approvalWaitMs: 500,
      scopeViolations: 0,
      tokens: 1000,
      cost: null,
      crashes: 0,
      recoveries: 0,
      manualInterventions: 0,
      ...over,
    });
    const agg = aggregateBenchMetrics([mk(0), mk(1), mk(2)]);
    eq("E3 样本数", agg.sampleSize, 3);
    eq("E3 解出数", agg.solved, 3);
    eq("E3 solveRate", agg.solveRate, 1);
    eq("E3 firstAnswer median", agg.firstAnswerMs.median, 1100);
    eq("E3 firstAnswer p90", agg.firstAnswerMs.p90, 1200);
    eq("E3 canConclude", agg.canConclude, true);
    eq("E3 token 合计", agg.tokensTotal, 3000);
    eq("E3 approval 合计", agg.approvalCountTotal, 3);
    check("E3 token 完整无告警", !agg.notes.some((n) => n.includes("token")), JSON.stringify(agg.notes));

    const one = aggregateBenchMetrics([mk(0)]);
    eq("E4 单样本 canConclude=false", one.canConclude, false);
    check("E4 单样本给出结论不足", one.notes.some((n) => n.includes("结论不足")), JSON.stringify(one.notes));

    const missingFirst = aggregateBenchMetrics([mk(0, { firstAnswerMs: null }), mk(1, { firstAnswerMs: null }), mk(2)]);
    eq("E5 null firstAnswer 被忽略", missingFirst.firstAnswerMs.valid, 1);
    eq("E5 median 只用有效值", missingFirst.firstAnswerMs.median, 1200);

    const incompleteTokens = aggregateBenchMetrics([mk(0), mk(1, { tokens: null }), mk(2)]);
    check("E6 token 不完整告警", incompleteTokens.notes.some((n) => n.includes("token 记录不完整")), JSON.stringify(incompleteTokens.notes));
    const text = formatBenchAggregate(agg);
    check("E6 指标文本含 solveRate/p90/样本", text.includes("solveRate") && text.includes("p90") && text.includes("样本=3"), text.slice(0, 200));
  }

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n================ ${results.length - failedCount}/${results.length} 通过 ================`);
  if (failedCount > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 2;
  })
  .finally(() => {
    rmSync(TMP, { recursive: true, force: true });
  });
