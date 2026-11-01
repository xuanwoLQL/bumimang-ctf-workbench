/** V2-P0-3：战略决策器入口（纯函数；不读 DB/文件/网络）。 */
export {
  DEFAULT_WEIGHTS,
  STRATEGY_ACTIONS,
  STRATEGY_TEMPLATES,
  TEMPLATE_LABEL,
  type StrategyAction,
  type StrategyBudget,
  type StrategyCandidateInput,
  type StrategyDeadEndInput,
  type StrategyFactInput,
  type StrategyInput,
  type StrategyMode,
  type StrategyNoAction,
  type StrategyPlan,
  type StrategyRecommendation,
  type StrategyScopeRisk,
  type StrategyScoreBreakdown,
  type StrategySessionInput,
  type StrategyTaskInput,
  type StrategyTemplate,
  type StrategyTemplateStep,
  type StrategyWeights,
} from "./model.ts";
export { mergeWeights, computeScore, assessNoProgress, difficultyFactor, expectedPoints, marginalEvidence } from "./score.ts";
export { buildStrategyPlan } from "./plan.ts";
