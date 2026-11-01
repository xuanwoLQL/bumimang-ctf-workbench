/**
 * V2-P0-3：战略决策器的输入/输出模型（纯类型 + 常量）。
 *
 * 设计边界：
 *  - 只做建议，不执行动作；`strategy.apply` 由 Hub 在人工显式点击后执行。
 *  - 不硬编码 Web 规则：题型只提供基准先验，priority/points/时间/证据/成本参与评分。
 *  - 不提出具体目标或攻击链；scope 风险只作为降权/风险提示。
 */

import type {
  AnswerType,
  EvidenceLevel,
  Role,
  TaskCategory,
  TaskStatus,
  Tier,
} from "../../../../../packages/shared-protocol/events.ts";

export type StrategyMode = "suggest" | "competition-auto";

export type StrategyAction =
  | "continue"
  | "start_session"
  | "stop_session"
  | "switch_role"
  | "verify"
  | "abandon"
  | "reallocate";

export type StrategyTemplate = "single" | "lead_verify" | "recon_lead_verify" | "converge_verify";

export interface StrategyTaskInput {
  id: string;
  title: string;
  category: TaskCategory;
  status: TaskStatus;
  priority: number;
  points: number;
  difficulty?: "easy" | "medium" | "hard" | number;
  /** 比赛剩余时间（毫秒）；未提供时按“未知”处理，不做硬性拒绝。 */
  remainingMs?: number;
  /** 单题预算（毫秒）；未提供时用题型基准。 */
  budgetMs?: number;
}

export interface StrategySessionInput {
  id: string;
  taskId: string;
  role: Role;
  agent: string;
  tier: Tier;
  status: string;
  toolCalls: number;
  boardReads: number;
  /** 会话开始时间；无 lastProgressAt 时作为无进展起点。 */
  startedAt?: number;
  /** 最后一次产生新事实/死路/候选/证据的时间；用于无进展检测。 */
  lastProgressAt?: number;
  /** 距上次进展的工具调用数；Hub 尽力计算，缺省按 0。 */
  toolCallsSinceProgress?: number;
  approvalsPending?: number;
}

export interface StrategyFactInput {
  id: string;
  taskId: string;
  evidence: EvidenceLevel;
  createdAt: number;
  status: string;
}

export interface StrategyDeadEndInput {
  id: string;
  taskId: string;
  createdAt: number;
}

export interface StrategyCandidateInput {
  id: string;
  taskId: string;
  value?: string;
  answerType?: AnswerType;
  evidence: EvidenceLevel;
  status: "new" | "confirmed" | "false_positive";
  firstSeen: number;
  /** 归一化值用于判断“不同结论”；缺省用 value。 */
  normalizedValue?: string;
}

export interface StrategyBudget {
  now: number;
  /** 比赛剩余时间；未知时不填。 */
  remainingMs?: number;
  /** 单题预算上限；未填时用题型基准。 */
  perTaskMs?: number;
  /** 至少留给验证/人工确认的时间。 */
  verifyMs?: number;
  /** 当前允许的活跃会话总数（全局）。 */
  maxSessions: number;
  /** 每任务活跃会话上限（默认 3）。 */
  maxSessionsPerTask?: number;
  /** 本次最多新开几个会话（apply 用）。 */
  maxNewSessions?: number;
  /** 人工审批预算；未知时不填。 */
  humanApprovalsRemaining?: number;
  /** 单会话的等效成本（用于评分分母）。 */
  sessionCost?: number;
  /** 每次待审批的等效成本。 */
  approvalCost?: number;
}

export interface StrategyScopeRisk {
  hasDenyTargets: boolean;
  hasUnknownTargets: boolean;
  note?: string;
}

export interface StrategyWeights {
  /** 证据边际权重：无候选/候选 E0/E1/E2/已确认。 */
  evidenceNone: number;
  evidenceE0: number;
  evidenceE1: number;
  evidenceE2: number;
  evidenceConfirmed: number;
  /** 无进展惩罚（每次超过阈值的工具调用/分钟）。 */
  noProgressPenalty: number;
  /** scope 风险乘数（0–1）。 */
  scopeRiskMultiplier: number;
  /** 单题基础成功概率按题型；可覆盖。 */
  categorySuccess: Partial<Record<TaskCategory, number>>;
  /** 单题基准时间（分钟）按题型；可覆盖。 */
  categoryMinutes: Partial<Record<TaskCategory, number>>;
}

export const DEFAULT_WEIGHTS: StrategyWeights = {
  evidenceNone: 1.0,
  evidenceE0: 0.4,
  evidenceE1: 1.2,
  evidenceE2: 2.0,
  evidenceConfirmed: 0.1,
  noProgressPenalty: 0.85,
  scopeRiskMultiplier: 0.6,
  categorySuccess: {
    web: 0.7,
    misc: 0.7,
    crypto: 0.55,
    reverse: 0.55,
    pwn: 0.45,
    pentest: 0.5,
    ir: 0.6,
    awd: 0.5,
    unknown: 0.5,
  },
  categoryMinutes: {
    web: 25,
    misc: 25,
    crypto: 45,
    reverse: 45,
    pwn: 60,
    pentest: 60,
    ir: 45,
    awd: 60,
    unknown: 40,
  },
};

export interface StrategyInput {
  tasks: StrategyTaskInput[];
  sessions: StrategySessionInput[];
  facts: StrategyFactInput[];
  deadEnds: StrategyDeadEndInput[];
  candidates: StrategyCandidateInput[];
  budget: StrategyBudget;
  weights?: Partial<StrategyWeights>;
  scopeRisk?: Record<string, StrategyScopeRisk>;
  /** 技能/引擎池；模板按顺序分配，空时由 apply 再决定。 */
  availableAgents?: string[];
  mode?: StrategyMode;
  /** 无进展阈值：同一会话连续多少次工具调用没有新产出。 */
  noProgressToolCalls?: number;
  /** 无进展阈值：多少分钟没有新产出。 */
  noProgressMinutes?: number;
}

export interface StrategyScoreBreakdown {
  expectedPoints: number;
  successProbability: number;
  marginalEvidence: number;
  timeCostMinutes: number;
  costWeight: number;
  scopeRisk: number;
  noProgress: number;
}

export interface StrategyRecommendation {
  id: string;
  action: StrategyAction;
  taskId: string;
  taskTitle: string;
  sessionId?: string;
  agent?: string;
  role?: Role;
  tier?: Tier;
  template?: StrategyTemplate;
  expectedValue: number;
  confidence: number;
  reason: string;
  risk: string;
  deadline?: number;
  /** 明确“现在不要做什么”。 */
  doNot: string[];
  score: StrategyScoreBreakdown;
  /** apply 是否允许执行（continue/abandon/reallocate 只建议）。 */
  applicable: boolean;
}

export interface StrategyNoAction {
  taskId: string;
  taskTitle: string;
  reason: string;
}

export interface StrategyPlan {
  generatedAt: number;
  mode: StrategyMode;
  budget: StrategyBudget;
  recommendations: StrategyRecommendation[];
  noAction: StrategyNoAction[];
  summary: string;
  /** 本次受哪些上限约束（配额/时间/审批/scope）。 */
  limitedBy: string[];
}

export interface StrategyTemplateStep {
  role: Role;
  tier: Tier;
}

export const STRATEGY_TEMPLATES: Record<StrategyTemplate, StrategyTemplateStep[]> = {
  single: [{ role: "lead", tier: "guarded" }],
  lead_verify: [
    { role: "lead", tier: "guarded" },
    { role: "verify", tier: "autonomous" },
  ],
  recon_lead_verify: [
    { role: "recon", tier: "autonomous" },
    { role: "lead", tier: "guarded" },
    { role: "verify", tier: "autonomous" },
  ],
  converge_verify: [{ role: "verify", tier: "guarded" }],
};

export const TEMPLATE_LABEL: Record<StrategyTemplate, string> = {
  single: "单路攻坚",
  lead_verify: "lead + verify",
  recon_lead_verify: "recon + lead + verify",
  converge_verify: "已拿分后的验证/收敛",
};

export const STRATEGY_ACTIONS: readonly StrategyAction[] = [
  "continue",
  "start_session",
  "stop_session",
  "switch_role",
  "verify",
  "abandon",
  "reallocate",
];
