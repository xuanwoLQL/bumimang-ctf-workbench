/**
 * V2-P0-3：战略建议生成（纯函数）。
 *
 * 输出只是建议；`applicable` 表示 apply 是否允许执行（只有 start/stop/verify/switch
 * 可执行；continue/abandon/reallocate 只供人读）。
 *
 * 关键约束：
 *  - E0 不触发“停止队友”；E1 只建议验证；E2 且无冲突才建议停止非 verify；
 *  - 冲突候选（不同归一化值）时只建议人工对比，不停止；
 *  - 已确认/已解出时保留 verify，停止其他重复劳动；
 *  - 所有“现在不做什么”写在 doNot / noAction 里；
 *  - scope 只降权并提示风险，不提出具体目标或攻击链。
 */

import type {
  Role,
  StrategyCandidateInput,
  StrategyInput,
  StrategyNoAction,
  StrategyPlan,
  StrategyRecommendation,
  StrategySessionInput,
  StrategyTaskInput,
  StrategyTemplate,
} from "./model.ts";
import { STRATEGY_TEMPLATES, TEMPLATE_LABEL } from "./model.ts";
import {
  assessNoProgress,
  computeScore,
  mergeWeights,
  scopeMultiplier,
  type NoProgressAssessment,
} from "./score.ts";

const TERMINAL = new Set(["blocked", "stopped", "failed", "done"]);

function isActive(s: StrategySessionInput): boolean {
  return !TERMINAL.has(s.status);
}

function taskSessions(input: StrategyInput, taskId: string): StrategySessionInput[] {
  return input.sessions.filter((s) => s.taskId === taskId);
}

function taskCandidates(input: StrategyInput, taskId: string): StrategyCandidateInput[] {
  return input.candidates.filter((c) => c.taskId === taskId);
}

function latestProgressAt(input: StrategyInput, taskId: string): number {
  const times = [
    ...input.facts.filter((f) => f.taskId === taskId).map((f) => f.createdAt),
    ...input.deadEnds.filter((d) => d.taskId === taskId).map((d) => d.createdAt),
    ...input.candidates.filter((c) => c.taskId === taskId).map((c) => c.firstSeen),
  ];
  return times.length ? Math.max(...times) : 0;
}

function normalizeValue(c: StrategyCandidateInput): string {
  return (c.normalizedValue ?? c.value ?? c.id).trim();
}

/** 显著候选：状态 new 且 E1/E2；E0 不参与“停止”判断。 */
function significantCandidates(candidates: StrategyCandidateInput[]): StrategyCandidateInput[] {
  return candidates.filter((c) => c.status === "new" && (c.evidence === "E1" || c.evidence === "E2"));
}

function hasConflict(significant: StrategyCandidateInput[]): boolean {
  return new Set(significant.map(normalizeValue)).size > 1;
}

function chooseTemplate(input: StrategyInput, task: StrategyTaskInput, estimateMinutes: number): StrategyTemplate {
  const remaining = input.budget.remainingMs;
  const complex = ["pentest", "ir", "awd", "reverse", "pwn", "crypto", "unknown"].includes(task.category);
  const highValue = task.points >= 300 || task.priority >= 70;
  if (remaining !== undefined && remaining < estimateMinutes * 60_000 * 0.5) return "single";
  if (highValue) return complex ? "recon_lead_verify" : "lead_verify";
  if (complex && (remaining === undefined || remaining > estimateMinutes * 60_000 * 1.5)) {
    return "recon_lead_verify";
  }
  return "single";
}

function templateStartRecs(input: {
  task: StrategyTaskInput;
  template: StrategyTemplate;
  score: ReturnType<typeof computeScore>;
  riskText: string;
  reasonPrefix: string;
  budgetLeft: { global: number; perTask: number; newStarts: number; maxNew: number };
  idSeq: { n: number };
  availableAgents?: string[];
  limitedBy?: Set<string>;
}): StrategyRecommendation[] {
  const steps = STRATEGY_TEMPLATES[input.template] ?? [];
  const out: StrategyRecommendation[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (input.budgetLeft.global <= 0 || input.budgetLeft.perTask <= 0) {
      input.limitedBy?.add("maxSessions");
      break;
    }
    if (input.budgetLeft.newStarts >= input.budgetLeft.maxNew) {
      input.limitedBy?.add("maxNewSessions");
      break;
    }
    const step = steps[i]!;
    input.budgetLeft.global--;
    input.budgetLeft.perTask--;
    input.budgetLeft.newStarts++;
    input.idSeq.n++;
    const pool = (input.availableAgents ?? []).filter((a) => a.trim().length > 0);
    out.push({
      id: `st:${input.task.id}:start:${input.template}:${step.role}:${input.idSeq.n}`,
      action: "start_session",
      taskId: input.task.id,
      taskTitle: input.task.title,
      role: step.role,
      tier: step.tier,
      agent: pool.length ? pool[i % pool.length] : undefined,
      template: input.template,
      expectedValue: input.score.expectedValue,
      confidence: input.score.confidence,
      reason:
        `${input.reasonPrefix}模板「${TEMPLATE_LABEL[input.template]}」第 ${i + 1}/${steps.length} 路：` +
        `${step.role}/${step.tier}。EV=${input.score.expectedValue.toFixed(2)}（分数 ${input.score.expectedPoints} × ` +
        `成功率 ${input.score.successProbability.toFixed(2)} × 证据 ${input.score.marginalEvidence.toFixed(2)} ÷ ` +
        `(时间 ${input.score.timeCostMinutes}分 + 成本 ${input.score.costWeight})）`,
      risk: input.riskText,
      doNot: ["不要重复黑板已记录的死路", "不要越过 scope/denyTargets", "不要把候选当已确认"],
      score: input.score,
      applicable: true,
    });
  }
  return out;
}

export function buildStrategyPlan(input: StrategyInput): StrategyPlan {
  const weights = mergeWeights(input.weights);
  const now = input.budget.now;
  const mode = input.mode ?? "suggest";
  const maxSessionsPerTask = input.budget.maxSessionsPerTask ?? 3;
  const maxNew = Math.max(0, input.budget.maxNewSessions ?? 3);
  const activeTotal = input.sessions.filter(isActive).length;
  let plannedStarts = 0;
  const recommendations: StrategyRecommendation[] = [];
  const noAction: StrategyNoAction[] = [];
  const limitedBy = new Set<string>();
  const idSeq = { n: 0 };

  const scored = input.tasks.map((task) => {
    const sessions = taskSessions(input, task.id);
    const active = sessions.filter(isActive);
    const candidates = taskCandidates(input, task.id);
    const lastProgress = latestProgressAt(input, task.id);
    const assessments = new Map<string, NoProgressAssessment>();
    for (const s of active) {
      assessments.set(
        s.id,
        assessNoProgress(s, now, weights, {
          toolCalls: input.noProgressToolCalls ?? 12,
          minutes: input.noProgressMinutes ?? 10,
          taskLastProgressAt: 0, // 只按该会话自己的产出；别人的进展不算它的进展
        }),
      );
    }
    const worst = [...assessments.values()].sort(
      (a, b) => b.minutesSinceProgress - a.minutesSinceProgress,
    )[0] ?? {
      stalled: false,
      minutesSinceProgress: 0,
      callsSinceProgress: 0,
      factor: 1,
      reason: null,
    };
    const score = computeScore({
      task,
      sessions,
      candidates,
      risk: input.scopeRisk?.[task.id],
      budget: input.budget,
      weights,
      noProgress: worst,
    });
    return { task, sessions, active, candidates, lastProgress, assessments, score };
  });
  scored.sort((a, b) => b.score.expectedValue - a.score.expectedValue);

  const activeHighValue = scored.find(
    (s) => s.task.status !== "solved" && s.task.status !== "abandoned" && s.score.expectedValue > 0,
  );

  for (const item of scored) {
    const { task, active, candidates, assessments, score } = item;
    const taskRemaining = task.remainingMs ?? input.budget.remainingMs;
    const deadline = taskRemaining !== undefined ? now + Math.max(0, taskRemaining) : undefined;
    const risk = input.scopeRisk?.[task.id];
    const scopeRiskText = risk?.hasDenyTargets
      ? "scope 风险：存在 denyTargets，启动/执行前必须人工核对目标"
      : risk?.hasUnknownTargets
        ? "scope 风险：存在无法判定的目标，按 approve/block 兜底处理"
        : "低风险";
    const riskText = score.timeRisk
      ? `时间风险：剩余时间不足以覆盖预估 ${score.timeCostMinutes} 分钟`
      : worstReasonText(assessments) ?? scopeRiskText;

    if (task.status === "abandoned") {
      noAction.push({ taskId: task.id, taskTitle: task.title, reason: "任务已放弃；不分配新会话" });
      continue;
    }

    const confirmed = candidates.find((c) => c.status === "confirmed");
    if (task.status === "solved" || confirmed) {
      let stopped = 0;
      for (const s of active) {
        if (s.role === "verify") {
          recommendations.push({
            id: `st:${task.id}:continue:verify:${s.id}`,
            action: "continue",
            taskId: task.id,
            taskTitle: task.title,
            sessionId: s.id,
            role: s.role,
            tier: s.tier,
            expectedValue: score.expectedValue,
            confidence: score.confidence,
            reason: "任务已确认/已解出；保留 verify 复核不同证据，不再开新方向",
            risk: "若该 verify 持有不同答案，先把它写回黑板再人工裁决",
            deadline,
            doNot: ["不要重复提交", "不要开新的攻击/分析方向", "不要删除其他证据"],
            score,
            applicable: false,
          });
        } else {
          stopped++;
          recommendations.push({
            id: `st:${task.id}:stop:solved:${s.id}`,
            action: "stop_session",
            taskId: task.id,
            taskTitle: task.title,
            sessionId: s.id,
            role: s.role,
            tier: s.tier,
            expectedValue: score.expectedValue,
            confidence: score.confidence,
            reason: "任务已确认/已解出，停止重复劳动；证据与历史保留",
            risk: "停止前先看黑板：若该会话持有不同答案，先保留其证据",
            deadline,
            doNot: ["不要在停止前删证据", "不要重新提交已确认答案"],
            score,
            applicable: true,
          });
        }
      }
      if (stopped === 0 && active.length === 0) {
        noAction.push({
          taskId: task.id,
          taskTitle: task.title,
          reason: "任务已确认/已解出，不再分配新会话",
        });
      }
      continue;
    }

    const significant = significantCandidates(candidates);
    const conflict = hasConflict(significant);
    const e2 = significant.find((c) => c.evidence === "E2");
    const e1 = significant.find((c) => c.evidence === "E1");
    const verifySession = active.find((s) => s.role === "verify");
    const budgetLeft = {
      global: input.budget.maxSessions - activeTotal - plannedStarts,
      perTask: maxSessionsPerTask - active.length,
      newStarts: plannedStarts,
      maxNew,
    };

    if (e2 && !conflict) {
      // E2：保留/补一个 verify，停止其他重复劳动；不把任务标 solved。
      if (!verifySession) {
        const recs = templateStartRecs({
          task,
          template: "converge_verify",
          score,
          riskText,
          reasonPrefix: "E2 候选已出现且无冲突，先复现再人工确认；",
          budgetLeft,
          idSeq,
          availableAgents: input.availableAgents,
          limitedBy,
        });
        plannedStarts += recs.length;
        recommendations.push(...recs);
        recommendations.push({
          id: `st:${task.id}:verify:e2:start`,
          action: "verify",
          taskId: task.id,
          taskTitle: task.title,
          role: "verify",
          tier: "guarded",
          template: "converge_verify",
          expectedValue: score.expectedValue,
          confidence: score.confidence,
          reason: "E2 候选已出现且无冲突；先复现/人工确认，不要自动提交",
          risk: "不要把 E2 当已确认；停止 lead 前先看其证据",
          deadline,
          doNot: ["不要自动提交", "不要自动把任务标 solved"],
          score,
          applicable: false,
        });
        if (recs.length === 0) {
          noAction.push({
            taskId: task.id,
            taskTitle: task.title,
            reason: "E2 候选需要 verify，但会话配额/新开上限已满；先人工确认或停一个会话",
          });
          limitedBy.add("maxSessions");
        }
      } else {
        recommendations.push({
          id: `st:${task.id}:verify:existing:${verifySession.id}`,
          action: "verify",
          taskId: task.id,
          taskTitle: task.title,
          sessionId: verifySession.id,
          role: "verify",
          tier: verifySession.tier,
          expectedValue: score.expectedValue,
          confidence: score.confidence,
          reason: "E2 候选已出现且无冲突；verify 继续复现，人工确认后才算 solved",
          risk: "不要因为 E2 自动提交；人工确认仍是唯一入口",
          deadline,
          doNot: ["不要自动提交", "不要停止持有不同证据的 verify"],
          score,
          applicable: false,
        });
      }
      for (const s of active) {
        if (s.role === "verify") continue;
        recommendations.push({
          id: `st:${task.id}:stop:e2:${s.id}`,
          action: "stop_session",
          taskId: task.id,
          taskTitle: task.title,
          sessionId: s.id,
          role: s.role,
          tier: s.tier,
          expectedValue: score.expectedValue,
          confidence: score.confidence,
          reason: "E2 候选已出现且无冲突；停止 lead/recon 的重复侦察，保留 verify",
          risk: "停止前确认该会话没有未写回的不同证据",
          deadline,
          doNot: ["停止前先 flush 证据到黑板", "不要删除候选"],
          score,
          applicable: true,
        });
      }
      continue;
    }

    if (e2 && conflict) {
      recommendations.push({
        id: `st:${task.id}:verify:conflict`,
        action: "verify",
        taskId: task.id,
        taskTitle: task.title,
        sessionId: verifySession?.id,
        role: "verify",
        tier: verifySession?.tier ?? "guarded",
        expectedValue: score.expectedValue,
        confidence: Math.min(score.confidence, 0.7),
        reason: "存在多个不同答案的 E2/E1 候选（冲突），需人工对比；不停止任何持有证据的会话",
        risk: "冲突未裁决前停止会丢失证据",
        deadline,
        doNot: ["不要按分数/话术自动选一个", "不要停止持有不同证据的会话"],
        score,
        applicable: false,
      });
      continue;
    }

    if (e1) {
      if (!verifySession) {
        const recs = templateStartRecs({
          task,
          template: "converge_verify",
          score,
          riskText,
          reasonPrefix: "E1 候选已有见证但未复现；",
          budgetLeft,
          idSeq,
          availableAgents: input.availableAgents,
          limitedBy,
        });
        plannedStarts += recs.length;
        recommendations.push(...recs);
        recommendations.push({
          id: `st:${task.id}:verify:e1:start`,
          action: "verify",
          taskId: task.id,
          taskTitle: task.title,
          role: "verify",
          tier: "guarded",
          template: "converge_verify",
          expectedValue: score.expectedValue,
          confidence: score.confidence,
          reason: "E1 候选已有见证但未复现；建议 verify 回放/复核，不触发停止",
          risk: "不要把 E1 当 E2；证据仍需回放/人工核对",
          deadline,
          doNot: ["不要自动确认", "不要自动提交", "不要停掉 lead"],
          score,
          applicable: false,
        });
        if (recs.length === 0) {
          noAction.push({
            taskId: task.id,
            taskTitle: task.title,
            reason: "E1 候选需要 verify，但配额/新开上限已满；保留现有会话继续",
          });
          limitedBy.add("maxSessions");
        }
      } else {
        recommendations.push({
          id: `st:${task.id}:verify:e1:${verifySession.id}`,
          action: "verify",
          taskId: task.id,
          taskTitle: task.title,
          sessionId: verifySession.id,
          role: "verify",
          tier: verifySession.tier,
          expectedValue: score.expectedValue,
          confidence: score.confidence,
          reason: "E1 候选只建议复现，不触发停止；E0 文本不会停掉任何队友",
          risk: "不要把 E1 当 E2；证据仍需回放/人工核对",
          deadline,
          doNot: ["不要自动确认", "不要自动提交", "不要停掉 lead"],
          score,
          applicable: false,
        });
      }
      // 继续给已有 lead/recon 一条 continue，但不建议停止。
      for (const s of active.filter((x) => x.role !== "verify")) {
        recommendations.push(
          continueRec(task, s, assessments.get(s.id)!, score, deadline),
        );
      }
      continue;
    }

    if (active.length === 0) {
      if (budgetLeft.global <= 0 || budgetLeft.perTask <= 0) {
        noAction.push({
          taskId: task.id,
          taskTitle: task.title,
          reason: "有得分价值，但会话配额已满；先停一个低收益会话或调大配额",
        });
        limitedBy.add("maxSessions");
        continue;
      }
      if (taskRemaining !== undefined && taskRemaining < 10 * 60_000) {
        noAction.push({
          taskId: task.id,
          taskTitle: task.title,
          reason: "剩余时间不足 10 分钟；不再开新方向，优先验证已有候选",
        });
        limitedBy.add("remainingMs");
        recommendations.push(abandonRec(task, score, deadline, "剩余时间不足，建议止损"));
        continue;
      }
      const template = chooseTemplate(input, task, score.timeCostMinutes);
      const recs = templateStartRecs({
        task,
        template,
        score,
        riskText,
        reasonPrefix: "当前无活跃会话；",
        budgetLeft,
        idSeq,
        availableAgents: input.availableAgents,
        limitedBy,
      });
      plannedStarts += recs.length;
      // 模板可能被 maxNew 截断；把第一个 rec 关联模板，apply 会按模板补足。
      if (recs.length === 0) {
        noAction.push({
          taskId: task.id,
          taskTitle: task.title,
          reason: "有得分价值，但新开会话上限已满",
        });
        limitedBy.add("maxNewSessions");
      } else {
        recommendations.push(...recs);
      }
      continue;
    }

    // 有活跃会话、没有显著候选：先处理重复角色与无进展。
    const dupRoles = new Map<Role, StrategySessionInput[]>();
    for (const s of active) {
      const list = dupRoles.get(s.role) ?? [];
      list.push(s);
      dupRoles.set(s.role, list);
    }
    const stopSet = new Set<string>();
    for (const [role, list] of dupRoles) {
      if (list.length <= 1) continue;
      const keep = [...list].sort((a, b) => b.toolCalls - a.toolCalls)[0]!;
      for (const s of list) {
        if (s.id === keep.id) continue;
        stopSet.add(s.id);
        recommendations.push({
          id: `st:${task.id}:stop:dup:${role}:${s.id}`,
          action: "stop_session",
          taskId: task.id,
          taskTitle: task.title,
          sessionId: s.id,
          role: s.role,
          tier: s.tier,
          expectedValue: score.expectedValue,
          confidence: score.confidence,
          reason: `同角色 ${role} 重复（${list.length} 个会话）；保留工具调用更多的 ${keep.id}，停掉重复劳动`,
          risk: "停止前确认它没有独占的租约/证据",
          deadline,
          doNot: ["不要停掉持有不同证据的会话"],
          score,
          applicable: true,
        });
      }
    }

    let stalledCount = 0;
    for (const s of active) {
      if (stopSet.has(s.id)) continue;
      const assessment = assessments.get(s.id)!;
      if (assessment.stalled) {
        stalledCount++;
        recommendations.push({
          id: `st:${task.id}:switch:stalled:${s.id}`,
          action: "switch_role",
          taskId: task.id,
          taskTitle: task.title,
          sessionId: s.id,
          role: s.role === "lead" ? "verify" : "lead",
          tier: s.tier,
          expectedValue: score.expectedValue,
          confidence: Math.min(score.confidence, 0.65),
          reason: `${assessment.reason}；建议换线（停当前会话，换角色重开）而不是继续烧时间`,
          risk: "误杀风险：若它刚发现新证据，先看黑板再停",
          deadline,
          doNot: ["不要因为绝对耗时停掉有进展的队友", "停止前 flush 证据"],
          score,
          applicable: true,
        });
      } else {
        recommendations.push(continueRec(task, s, assessment, score, deadline));
      }
    }

    if (stalledCount > 0 && stalledCount === active.length && active.length === 1) {
      if (taskRemaining !== undefined && taskRemaining < 20 * 60_000) {
        recommendations.push(abandonRec(task, score, deadline, "单路长时间无进展且剩余时间不足"));
      }
    }

    // 全局配额紧张时，给“低收益任务占着会话、高收益任务没会话”一条再分配建议。
    if (
      activeHighValue &&
      activeHighValue.task.id !== task.id &&
      activeHighValue.active.length === 0 &&
      activeTotal >= input.budget.maxSessions &&
      activeHighValue.score.expectedValue > score.expectedValue * 1.5
    ) {
      const victim = active[0];
      if (victim) {
        recommendations.push({
          id: `st:${task.id}:reallocate:${victim.id}:${activeHighValue.task.id}`,
          action: "reallocate",
          taskId: task.id,
          taskTitle: task.title,
          sessionId: victim.id,
          role: victim.role,
          tier: victim.tier,
          expectedValue: activeHighValue.score.expectedValue,
          confidence: 0.55,
          reason:
            `全局会话已满；任务「${activeHighValue.task.title}」EV=${activeHighValue.score.expectedValue.toFixed(2)}，` +
            `本任务 EV=${score.expectedValue.toFixed(2)}。建议停本任务一个会话，把名额让给高收益任务。`,
          risk: "再分配会中断当前会话；先确认它没有独占证据/租约",
          deadline,
          doNot: ["不要自动执行再分配", "停止前 flush 证据"],
          score: activeHighValue.score,
          applicable: false,
        });
      }
    }
  }

  if (plannedStarts === 0 && recommendations.every((r) => r.action === "continue")) {
    // 没有任何可执行动作时，把原因说清楚，而不是给一个空列表。
    limitedBy.add("no-actionable");
  }

  recommendations.sort(
    (a, b) =>
      Number(b.applicable) - Number(a.applicable) ||
      b.expectedValue - a.expectedValue ||
      a.id.localeCompare(b.id),
  );

  const actionable = recommendations.filter((r) => r.applicable).length;
  const summary =
    `${input.tasks.length} 个任务；${recommendations.length} 条建议（${actionable} 条可应用）；` +
    `${noAction.length} 条“现在不做”` +
    (limitedBy.size ? `；受限：${[...limitedBy].join(", ")}` : "");

  return {
    generatedAt: now,
    mode,
    budget: input.budget,
    recommendations,
    noAction,
    summary,
    limitedBy: [...limitedBy],
  };
}

function continueRec(
  task: StrategyTaskInput,
  s: StrategySessionInput,
  assessment: NoProgressAssessment,
  score: ReturnType<typeof computeScore>,
  deadline?: number,
): StrategyRecommendation {
  return {
    id: `st:${task.id}:continue:${s.id}`,
    action: "continue",
    taskId: task.id,
    taskTitle: task.title,
    sessionId: s.id,
    role: s.role,
    tier: s.tier,
    expectedValue: score.expectedValue,
    confidence: score.confidence,
    reason: assessment.stalled
      ? `${assessment.reason}；但整体仍有得分价值，保留观察`
      : `有进展（${s.toolCalls} 次工具调用，${s.boardReads} 次读板）；继续当前方向`,
    risk: assessment.stalled ? "无进展风险；下一轮仍无产出就换线" : "低风险",
    deadline,
    doNot: ["不要重复已记录的死路", "每 3 次工具调用读一次黑板"],
    score,
    applicable: false,
  };
}

function abandonRec(
  task: StrategyTaskInput,
  score: ReturnType<typeof computeScore>,
  deadline: number | undefined,
  reason: string,
): StrategyRecommendation {
  return {
    id: `st:${task.id}:abandon`,
    action: "abandon",
    taskId: task.id,
    taskTitle: task.title,
    expectedValue: score.expectedValue,
    confidence: Math.max(0.3, Math.min(0.7, score.confidence)),
    reason: `${reason}；建议把剩余时间让给更高收益方向`,
    risk: "放弃前保留证据/死路，供复盘；不要删除候选",
    deadline,
    doNot: ["不要删除证据/候选", "不要自动把任务标 abandoned"],
    score,
    applicable: false,
  };
}

function worstReasonText(assessments: Map<string, NoProgressAssessment>): string | null {
  const stalled = [...assessments.values()].find((a) => a.stalled);
  return stalled?.reason ?? null;
}
