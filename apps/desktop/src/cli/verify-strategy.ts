/**
 * V2-P0-3 战略决策器验收。
 *
 * A. 评分：分值/优先级/时间/证据/scope/无进展
 * B. 计划：模板、配额、无进展、E0/E1/E2、冲突、已拿分、重复角色、再分配
 * C. Hub 集成：strategy.plan / strategy.apply（fake SessionManager，不 spawn 真实 agent）
 *
 * 用法：npm run verify:strategy
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import type { SessionManager, SessionRecord } from "../main/session/manager.ts";
import type { AgentSpec } from "../main/acp/client.ts";
import {
  STRATEGY_TEMPLATES,
  buildStrategyPlan,
  computeScore,
  mergeWeights,
  type StrategyBudget,
  type StrategyCandidateInput,
  type StrategyInput,
  type StrategySessionInput,
  type StrategyTaskInput,
} from "../main/strategy/index.ts";

const ROOT = process.cwd();
const RUN = path.join(ROOT, ".ui-run", "strategy");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
function section(title: string): void {
  console.log(`\n================ ${title} ================\n`);
}

const NOW = 1_760_000_000_000;
const budget: StrategyBudget = {
  now: NOW,
  maxSessions: 8,
  maxSessionsPerTask: 3,
  maxNewSessions: 3,
};
const baseTask = (over: Partial<StrategyTaskInput> = {}): StrategyTaskInput => ({
  id: "t1",
  title: "任务一",
  category: "web",
  status: "open",
  priority: 0,
  points: 0,
  ...over,
});
const baseSession = (over: Partial<StrategySessionInput> = {}): StrategySessionInput => ({
  id: "s1",
  taskId: "t1",
  role: "lead",
  agent: "fake",
  tier: "guarded",
  status: "running",
  toolCalls: 10,
  boardReads: 2,
  startedAt: NOW - 5 * 60_000,
  ...over,
});
const baseInput = (over: Partial<StrategyInput> = {}): StrategyInput => ({
  tasks: [baseTask()],
  sessions: [],
  facts: [],
  deadEnds: [],
  candidates: [],
  budget,
  availableAgents: ["fake"],
  ...over,
});

function findStart(plan: ReturnType<typeof buildStrategyPlan>) {
  return plan.recommendations.filter((r) => r.action === "start_session");
}
function findStop(plan: ReturnType<typeof buildStrategyPlan>) {
  return plan.recommendations.filter((r) => r.action === "stop_session");
}

// ---------------------------------------------------------------- A. 评分

section("A. 评分：分值/优先级/时间/证据/scope/无进展");
{
  const weights = mergeWeights();
  const noProgress = {
    stalled: false,
    minutesSinceProgress: 1,
    callsSinceProgress: 0,
    factor: 1,
    reason: null,
  };
  const low = computeScore({
    task: baseTask({ points: 10 }),
    sessions: [],
    candidates: [],
    budget,
    weights,
    noProgress,
  });
  const high = computeScore({
    task: baseTask({ points: 500 }),
    sessions: [],
    candidates: [],
    budget,
    weights,
    noProgress,
  });
  check("A1 points 越高 EV 越高", high.expectedValue > low.expectedValue, `${low.expectedValue} → ${high.expectedValue}`);
  eq("A1 expectedPoints=points", high.expectedPoints, 500);

  const prioLow = computeScore({
    task: baseTask({ points: 0, priority: 10 }),
    sessions: [],
    candidates: [],
    budget,
    weights,
    noProgress,
  });
  const prioHigh = computeScore({
    task: baseTask({ points: 0, priority: 90 }),
    sessions: [],
    candidates: [],
    budget,
    weights,
    noProgress,
  });
  check("A2 无 points 时 priority 参与评分", prioHigh.expectedValue > prioLow.expectedValue, `${prioLow.expectedValue} → ${prioHigh.expectedValue}`);

  const noTime = computeScore({
    task: baseTask({ points: 500, remainingMs: 5 * 60_000 }),
    sessions: [],
    candidates: [],
    budget: { ...budget, remainingMs: 5 * 60_000 },
    weights,
    noProgress,
  });
  check("A3 时间不足降低成功率", noTime.successProbability < high.successProbability, `${noTime.successProbability} < ${high.successProbability}`);
  check("A3 时间风险标记", noTime.timeRisk === true);

  const e0 = computeScore({
    task: baseTask({ points: 100 }),
    sessions: [],
    candidates: [{ id: "c0", taskId: "t1", evidence: "E0", status: "new", firstSeen: NOW }],
    budget,
    weights,
    noProgress,
  });
  const e1 = computeScore({
    task: baseTask({ points: 100 }),
    sessions: [],
    candidates: [{ id: "c1", taskId: "t1", evidence: "E1", status: "new", firstSeen: NOW }],
    budget,
    weights,
    noProgress,
  });
  const e2 = computeScore({
    task: baseTask({ points: 100 }),
    sessions: [],
    candidates: [{ id: "c2", taskId: "t1", evidence: "E2", status: "new", firstSeen: NOW }],
    budget,
    weights,
    noProgress,
  });
  check("A4 证据边际：E2 > E1 > E0", e2.marginalEvidence > e1.marginalEvidence && e1.marginalEvidence > e0.marginalEvidence, `${e0.marginalEvidence}/${e1.marginalEvidence}/${e2.marginalEvidence}`);

  const scope = computeScore({
    task: baseTask({ points: 500 }),
    sessions: [],
    candidates: [],
    budget,
    weights,
    noProgress,
    risk: { hasDenyTargets: true, hasUnknownTargets: false },
  });
  check("A5 scope 风险降低 EV", scope.expectedValue < high.expectedValue, `${scope.expectedValue} < ${high.expectedValue}`);

  const stalled = computeScore({
    task: baseTask({ points: 500 }),
    sessions: [baseSession({ toolCallsSinceProgress: 20 })],
    candidates: [],
    budget,
    weights,
    noProgress: {
      stalled: true,
      minutesSinceProgress: 15,
      callsSinceProgress: 20,
      factor: 0.8,
      reason: "无进展",
    },
  });
  check("A6 无进展惩罚", stalled.noProgress > 0 && stalled.successProbability < high.successProbability, `${stalled.successProbability}`);
}

// ---------------------------------------------------------------- B. 计划

section("B. 计划：模板/配额/无进展/证据/冲突/收敛");
{
  const single = buildStrategyPlan(
    baseInput({ tasks: [baseTask({ points: 100 })], budget: { ...budget, maxNewSessions: 1 } }),
  );
  const singleStarts = findStart(single);
  eq("B1 低分题单路：1 条启动", singleStarts.length, 1);
  eq("B1 模板 single", singleStarts[0]?.template, "single");
  eq("B1 角色 lead", singleStarts[0]?.role, "lead");
  check("B1 建议带 EV 理由", (singleStarts[0]?.reason ?? "").includes("EV="), singleStarts[0]?.reason ?? "");

  const highWeb = buildStrategyPlan(
    baseInput({ tasks: [baseTask({ points: 500 })], budget: { ...budget, maxNewSessions: 3 } }),
  );
  const highStarts = findStart(highWeb);
  eq("B2 高分 Web 模板 lead_verify", highStarts[0]?.template, "lead_verify");
  check("B2 至少 lead+verify 两路", highStarts.length >= 2 && highStarts.some((r) => r.role === "lead") && highStarts.some((r) => r.role === "verify"), highStarts.map((r) => r.role).join(","));

  const highPentest = buildStrategyPlan(
    baseInput({ tasks: [baseTask({ category: "pentest", points: 500 })], budget: { ...budget, maxNewSessions: 3 } }),
  );
  eq("B3 高分渗透模板 recon_lead_verify", findStart(highPentest)[0]?.template, "recon_lead_verify");

  const shortTime = buildStrategyPlan(
    baseInput({ tasks: [baseTask({ points: 500, remainingMs: 7 * 60_000 })], budget: { ...budget, remainingMs: 7 * 60_000 } }),
  );
  eq("B4 时间不足不启动", findStart(shortTime).length, 0);
  check("B4 给出现在不做的原因", shortTime.noAction.some((n) => n.reason.includes("剩余时间")), JSON.stringify(shortTime.noAction));
  check("B4 建议止损", shortTime.recommendations.some((r) => r.action === "abandon"), JSON.stringify(shortTime.recommendations.map((r) => r.action)));
  check("B4 limitedBy 含 remainingMs", shortTime.limitedBy.includes("remainingMs"), JSON.stringify(shortTime.limitedBy));

  const maxNew = buildStrategyPlan(
    baseInput({ tasks: [baseTask({ points: 500 })], budget: { ...budget, maxNewSessions: 1 } }),
  );
  eq("B5 maxNewSessions 截断启动", findStart(maxNew).length, 1);
  check("B5 limitedBy 含 maxNewSessions", maxNew.limitedBy.includes("maxNewSessions"), JSON.stringify(maxNew.limitedBy));

  const quota = buildStrategyPlan(
    baseInput({
      tasks: [baseTask({ id: "low", title: "低收益", points: 10 }), baseTask({ id: "high", title: "高收益", points: 900 })],
      sessions: [baseSession({ id: "slow", taskId: "low" })],
      budget: { ...budget, maxSessions: 1, maxNewSessions: 3 },
    }),
  );
  eq("B6 配额满不启动高收益", findStart(quota).length, 0);
  check("B6 给出再分配建议", quota.recommendations.some((r) => r.action === "reallocate"), JSON.stringify(quota.recommendations.map((r) => r.action)));
  check("B6 limitedBy 含 maxSessions", quota.limitedBy.includes("maxSessions"), JSON.stringify(quota.limitedBy));

  const stalled = buildStrategyPlan(
    baseInput({ sessions: [baseSession({ toolCallsSinceProgress: 20 })] }),
  );
  const switchRec = stalled.recommendations.find((r) => r.action === "switch_role");
  check("B7 无进展建议换线", Boolean(switchRec), JSON.stringify(stalled.recommendations.map((r) => r.action)));
  check("B7 理由含工具调用数", (switchRec?.reason ?? "").includes("20"), switchRec?.reason ?? "");
  eq("B7 换线可应用", switchRec?.applicable, true);

  const e0 = buildStrategyPlan(
    baseInput({
      sessions: [baseSession({ toolCallsSinceProgress: 20 })],
      candidates: [{ id: "c0", taskId: "t1", value: "10.0.0.1", evidence: "E0", status: "new", firstSeen: NOW }],
    }),
  );
  check("B8 E0 不触发停止", findStop(e0).length === 0, JSON.stringify(findStop(e0).map((r) => r.reason)));

  const e1 = buildStrategyPlan(
    baseInput({
      sessions: [baseSession()],
      candidates: [{ id: "c1", taskId: "t1", value: "10.0.0.2", evidence: "E1", status: "new", firstSeen: NOW }],
    }),
  );
  check("B9 E1 只建议验证", e1.recommendations.some((r) => r.action === "verify"), JSON.stringify(e1.recommendations.map((r) => r.action)));
  check("B9 E1 不停止 lead", findStop(e1).length === 0, JSON.stringify(findStop(e1).map((r) => r.reason)));

  const e2 = buildStrategyPlan(
    baseInput({
      sessions: [baseSession()],
      candidates: [{ id: "c2", taskId: "t1", value: "10.0.0.3", evidence: "E2", status: "new", firstSeen: NOW }],
    }),
  );
  const e2Starts = findStart(e2);
  const e2Stops = findStop(e2);
  check("B10 E2 补 verify", e2Starts.some((r) => r.role === "verify" && r.template === "converge_verify"), JSON.stringify(e2Starts.map((r) => [r.role, r.template])));
  check("B10 E2 停止 lead", e2Stops.some((r) => r.sessionId === "s1"), JSON.stringify(e2Stops.map((r) => r.sessionId)));
  check("B10 E2 不自动 solved", e2.recommendations.every((r) => r.action !== "verify" || r.applicable === false), "verify 只建议");

  const conflict = buildStrategyPlan(
    baseInput({
      sessions: [baseSession()],
      candidates: [
        { id: "c2a", taskId: "t1", value: "10.0.0.3", evidence: "E2", status: "new", firstSeen: NOW },
        { id: "c2b", taskId: "t1", value: "10.0.0.4", evidence: "E2", status: "new", firstSeen: NOW },
      ],
    }),
  );
  check("B11 冲突不停止", findStop(conflict).length === 0, JSON.stringify(findStop(conflict).map((r) => r.reason)));
  check("B11 冲突建议人工对比", conflict.recommendations.some((r) => r.action === "verify" && r.reason.includes("冲突")), JSON.stringify(conflict.recommendations.map((r) => r.reason)));

  const confirmed = buildStrategyPlan(
    baseInput({
      tasks: [baseTask({ status: "solved" })],
      sessions: [baseSession({ id: "lead", role: "lead" }), baseSession({ id: "verify", role: "verify" })],
      candidates: [{ id: "cc", taskId: "t1", value: "flag{ok}", evidence: "E2", status: "confirmed", firstSeen: NOW }],
    }),
  );
  check("B12 已确认停止 lead", findStop(confirmed).some((r) => r.sessionId === "lead"), JSON.stringify(findStop(confirmed).map((r) => r.sessionId)));
  check("B12 已确认保留 verify 复核", confirmed.recommendations.some((r) => r.action === "continue" && r.sessionId === "verify"), JSON.stringify(confirmed.recommendations.map((r) => [r.action, r.sessionId])));
  check("B12 已确认不再启动", findStart(confirmed).length === 0);

  const dup = buildStrategyPlan(
    baseInput({
      sessions: [
        baseSession({ id: "lead1", role: "lead", toolCalls: 20 }),
        baseSession({ id: "lead2", role: "lead", toolCalls: 5 }),
      ],
    }),
  );
  check("B13 重复角色停一个", findStop(dup).some((r) => r.sessionId === "lead2"), JSON.stringify(findStop(dup).map((r) => r.sessionId)));

  const maxPerTask = buildStrategyPlan(
    baseInput({ tasks: [baseTask({ points: 500 })], budget: { ...budget, maxSessionsPerTask: 1, maxNewSessions: 3 } }),
  );
  eq("B14 每任务上限截断", findStart(maxPerTask).length, 1);

  check("B15 模板齐全", ["single", "lead_verify", "recon_lead_verify", "converge_verify"].every((k) => k in STRATEGY_TEMPLATES), Object.keys(STRATEGY_TEMPLATES).join(","));
  check("B15 每模板都有角色/档位", Object.values(STRATEGY_TEMPLATES).every((steps) => steps.length > 0 && steps.every((s) => s.role && s.tier)));

  const all = buildStrategyPlan(baseInput({ tasks: [baseTask({ points: 500 })] }));
  const advisory = all.recommendations.filter((r) => ["continue", "verify", "abandon", "reallocate"].includes(r.action));
  check("B16 建议类不可应用", advisory.every((r) => r.applicable === false), JSON.stringify(advisory.map((r) => [r.action, r.applicable])));
  const executable = all.recommendations.filter((r) => ["start_session", "stop_session", "switch_role"].includes(r.action));
  check("B16 执行类可应用", executable.every((r) => r.applicable === true), JSON.stringify(executable.map((r) => [r.action, r.applicable])));
  check("B17 建议都有 doNot/risk/reason", all.recommendations.every((r) => r.reason && r.risk && r.doNot.length > 0), "检查 reason/risk/doNot");

  const inputSessions = [baseSession()];
  const before = inputSessions.length;
  buildStrategyPlan(baseInput({ sessions: inputSessions, tasks: [baseTask({ points: 500 })] }));
  eq("B18 计划是纯函数（不改输入）", inputSessions.length, before);
}

// ---------------------------------------------------------------- C. Hub 集成

section("C. Hub 集成：strategy.plan / strategy.apply（fake SessionManager）");
{
  const dir = path.join(RUN, "hub");
  mkdirSync(dir, { recursive: true });
  const board = Blackboard.open(path.join(dir, "board.db"));
  const fakeSessions: SessionRecord[] = [];
  let startCalls = 0;
  const fakeMgr = {
    listSessions: (taskId: string) => fakeSessions.filter((s) => s.taskId === taskId),
    getSession: (id: string) => fakeSessions.find((s) => s.id === id),
    historyOf: () => [],
    startSession: async (input: {
      taskId: string;
      agent: string;
      role: string;
      tier: string;
    }): Promise<SessionRecord> => {
      startCalls++;
      const rec: SessionRecord = {
        id: `fake-s${fakeSessions.length + 1}`,
        taskId: input.taskId,
        agent: input.agent,
        role: input.role,
        tier: input.tier,
        acpSession: null,
        pid: null,
        status: "idle",
        toolCalls: 0,
        lastBoardReadAt: 0,
        boardReads: 0,
        expectedExit: false,
        model: null,
        startedAt: NOW,
        endedAt: null,
      };
      fakeSessions.push(rec);
      return rec;
    },
    sendBriefing: async () => ({ task: { id: "t", title: "t", brief: "" }, my_role: "lead", work_dir: "", facts_verified: [], dead_ends: [], in_flight: [], leases_held: [], do_not: [], open_questions: [], sync_protocol: { call: "x", every_n_tool_calls: 3, also_when: "x", after_id: 0 }, incidents: [] }),
  } as unknown as SessionManager;
  const fakeSpec: AgentSpec = { command: "node", args: [], cwd: dir, label: "fake" };
  const bus = new EventBus();
  const hub = new HubService({
    board,
    sessions: fakeMgr,
    bus,
    workspaceRoot: dir,
    workDir: dir,
    specFor: () => fakeSpec,
    strategyAgents: ["fake"],
    maxSessionsTotal: 8,
    maxSessionsPerTask: 3,
    convergeGraceMs: 0,
  });
  const created = await hub.dispatch({
    type: "task.create",
    title: "战略集成",
    brief: "高分 Web",
    category: "web",
    points: 500,
  });
  check("C1 创建带 points 任务", created.ok, JSON.stringify(created));
  const taskId = hub.currentTaskId!;
  eq("C1 points 落库", board.getTask(taskId)?.points, 500);

  const planRes = await hub.dispatch({ type: "strategy.plan", taskId });
  check("C2 strategy.plan 返回 ok", planRes.ok, JSON.stringify(planRes));
  const plan = planRes.strategyPlan!;
  check("C2 计划带启动建议", plan.recommendations.some((r) => r.action === "start_session" && r.applicable), JSON.stringify(plan.recommendations.map((r) => [r.action, r.applicable])));
  check("C2 计划有 summary/noAction", typeof plan.summary === "string" && Array.isArray(plan.noAction), plan.summary);

  const startRec = plan.recommendations.find((r) => r.action === "start_session");
  check("C3 找到启动建议", Boolean(startRec), JSON.stringify(plan.recommendations.map((r) => r.id)));
  const applyRes = await hub.dispatch({
    type: "strategy.apply",
    taskId,
    recommendationIds: startRec ? [startRec.id] : ["missing"],
  });
  check("C3 strategy.apply 启动成功", applyRes.ok, JSON.stringify(applyRes));
  eq("C3 fake manager 收到 startSession", startCalls, 1);
  eq("C3 会话已创建", fakeSessions.length, 1);

  const stale = await hub.dispatch({
    type: "strategy.apply",
    taskId,
    recommendationIds: ["st:not-exist"],
  });
  check("C4 过期建议被拒", stale.ok === false && (stale.error ?? "").includes("过期"), JSON.stringify(stale));

  const plan2 = (await hub.dispatch({ type: "strategy.plan", taskId })).strategyPlan!;
  const advisory = plan2.recommendations.find((r) => !r.applicable);
  if (advisory) {
    const advisoryRes = await hub.dispatch({
      type: "strategy.apply",
      taskId,
      recommendationIds: [advisory.id],
    });
    check("C5 建议类不可应用", advisoryRes.ok === false, JSON.stringify(advisoryRes));
  } else {
    check("C5 建议类不可应用（本轮无建议类）", true, "skip");
  }

  const audits = board.raw("SELECT detail FROM audit WHERE action = 'strategy.apply'") as Array<{ detail: string }>;
  check("C6 strategy.apply 写审计", audits.length >= 1, JSON.stringify(audits));
  check("C6 审计不含答案明文", audits.every((a) => !a.detail.includes("flag{")), JSON.stringify(audits));

  const task = board.getTask(taskId);
  eq("C7 任务没有被 apply 自动标 solved", task?.status, "solving");
  eq("C7 任务 answer 仍 null", task?.answer, null);

  board.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
if (failed > 0) process.exitCode = 1;
