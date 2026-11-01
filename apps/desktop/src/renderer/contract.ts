/**
 * 渲染进程本地类型入口。
 *
 * 只做「类型再导出」：`export type` 在运行时会被擦除，浏览器因此永远不需要
 * 真正去加载 `packages/shared-protocol/events.ts` —— 那是一个跨 package 的只读契约文件，
 * 渲染进程只借用它的类型，不借用它的运行时代码（`HUB_CHANNELS` 等值不在这里）。
 *
 * 这样 renderer 在运行时完全自包含于 `src/renderer/**` 之下，
 * 也符合「无 bundler、纯 HTML + TS」的加载方式（见 electron/renderer-protocol.ts）。
 */
export type {
  Tier,
  Role,
  SessionStatus,
  TaskStatus,
  ApprovalStatus,
  RiskLevel,
  EvidenceLevel,
  AnswerMode,
  AnswerType,
  AnswerSpec,
  TaskCategory,
  PlatformConnectionStatus,
  PlatformTargetView,
  PlatformSceneProbeView,
  PlatformSubmissionResultView,
  PlatformChallengeView,
  PlatformRaceView,
  WpMatchView,
  PlatformStateView,
  AttachmentView,
  ArtifactView,
  ArtifactPreview,
  AttachmentPickKind,
  AttachmentPickResult,
  TaskView,
  SessionView,
  SessionHealth,
  StreamUpdate,
  ApprovalView,
  PermissionGrantView,
  FactView,
  DeadEndView,
  LeaseView,
  IntentView,
  BoardEventView,
  FlagSourceView,
  FlagCandidateView,
  ScoreboardView,
  AwdView,
  IrView,
  StrategyMode,
  StrategyAction,
  StrategyTemplate,
  StrategyScoreView,
  StrategyRecommendationView,
  StrategyNoActionView,
  StrategyPlanView,
  HubSnapshot,
  HubEvent,
  HubAction,
  ActionResult,
  HubApi,
} from "../../../../packages/shared-protocol/events.ts";

/**
 * 镜像契约里 `HubSnapshot.agents` 的内联元素类型（§6.1 检测结果）。
 * 契约把该数组写成了内联类型，没有单独命名，这里给渲染进程补一个可复用的名字。
 */
export interface AgentDescriptor {
  id: string;
  title: string;
  installed: boolean;
  installHint: string;
  maturity: string;
  /**
   * 这家 agent 默认会不会主动请求授权（应 Lane B 的请求 R-2）。
   * 契约里是可选字段：缺席时 UI 只少一条「选哪个 agent」的闸门行为提示，不报错。
   */
  permissionBehavior?: "requests_by_default" | "needs_config" | "unknown";
}

/**
 * 渲染进程本地补充：当前生效的策略规则包信息。
 *
 * ⚠ 这不是冻结契约的一部分 —— `HubSnapshot` 里还没有这个字段（Lane A 的策略引擎
 * 只在启动时打印包名，不对外暴露）。这里按「主进程未来会在快照里带一个 `policy`
 * 字段」的形状预置好类型与 UI 槽位；字段缺席时 UI 显示「—」。要正式落地需改契约，
 * 走 docs/requests/，请求已记在 docs/BLOCKED.md。
 */
export interface PolicyPackInfo {
  /** 规则包 id，如 competition / dev */
  packId: string;
  /** 展示名，如「京津冀决赛合规包」 */
  name: string;
  /** 规则包缺失时是否已回落到内置最小安全集 */
  fellBackToMinimal: boolean;
}
