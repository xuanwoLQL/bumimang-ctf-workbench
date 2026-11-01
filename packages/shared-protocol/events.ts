/**
 * 不迷茫 · 主进程 ↔ 渲染进程契约
 *
 * 状态：**已冻结**（T1，2026-10-12 23:40，由 Lane A 拥有）
 * 冻结后 Lane B 只读。任何单方面修改都是违规操作 —— 要改走 docs/requests/。
 *
 * 只放两样东西：状态快照 + 增量事件。业务逻辑、渲染细节、IPC 实现方式都不在这里。
 */

// ---------------------------------------------------------------- 基础枚举

export type Tier = "autonomous" | "guarded";
export type Role = "lead" | "verify" | "recon" | "scribe";

export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_lease"
  | "blocked"
  | "done"
  | "failed"
  | "stopped";

export type TaskStatus = "open" | "solving" | "solved" | "abandoned";

export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout" | "auto";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

/**
 * 「一键放行」授权的视图（R-权限增强）。
 *
 * scope=session：只在本会话内有效，进程退出即失效；
 * scope=agent：按 agent 维度持久化到 `<workspace>/permissions.json`，重启后仍生效。
 *
 * 全局全部放行复用 scope=agent + `agentId: "*"`、`id: "global:all"` 表示，
 * 避免为一个合成项扩展枚举；UI 应把它单独标成「全局（所有 agent）」。
 */
export interface PermissionGrantView {
  id: string;
  agentId: string;
  scope: "session" | "agent";
  /** scope=session 时指向具体会话；agent 级为 null。 */
  sessionId: string | null;
  /** 操作类别：read / write / delete / execute / network / credential / other */
  category: string;
  /** 人读的类别名，如「写入/编辑文件」。 */
  label: string;
  risk: RiskLevel;
  createdAt: number;
}

export type EvidenceLevel = "E0" | "E1" | "E2";

/**
 * V2-P0-2：统一答案模型。
 *
 * 旧任务没有 AnswerSpec 时按 `flag_regex` + `flag{...}` 处理，行为与旧版一致。
 * `typed` / `freeform` 只产生**候选**，不会自动确认或提交。
 */
export type AnswerMode = "flag_regex" | "typed" | "freeform";

export type AnswerType =
  | "flag"
  | "ip"
  | "timestamp"
  | "hash"
  | "path"
  | "process"
  | "command"
  | "account"
  | "text";

export type AnswerNormalizer =
  | "trim"
  | "lower"
  | "upper"
  | "strip_quotes"
  | "collapse_ws"
  | "normalize_path"
  | "base64_decode"
  | "hex_decode";

export interface AnswerSpec {
  mode: AnswerMode;
  /**
   * 可选正则。有捕获组时取第 1 组作为答案，否则取完整匹配。
   * 只在 flag_regex / typed / freeform 下使用；缺省按 mode 用内置规则。
   */
  pattern?: string;
  answerType?: AnswerType;
  normalizers?: AnswerNormalizer[];
  /** 默认 false（大小写不敏感）。 */
  caseSensitive?: boolean;
  /** 默认 E1；只影响“是否够确认”，不自动确认。 */
  requiredEvidence?: EvidenceLevel;
  /** 支持 ${value} ${answerType} ${taskTitle} ${candidateId}。 */
  exportTemplate?: string;
  /** 同一答案的等价写法（候选归一化后按 aliases 合并）。 */
  aliases?: string[];
  /** typed 模式的问题/字段名，用于 IR 答题卡。 */
  field?: string;
}

/** P5-A：flag 候选来源（只读视图）；P5-C 的 flag.updated 事件复用该结构。 */
export interface FlagSourceView {
  sessionId: string | null;
  witness: string | null;
  evidence: EvidenceLevel;
  seenAt: number;
  /** V2-P0-2：来源位置（附件/日志扫描）。旧快照/旧来源没有这些字段。 */
  line?: number | null;
  offset?: number | null;
  sourceKind?: string | null;
  sourcePath?: string | null;
}

/** P5-A：flag 候选（持久化视图）。确认/误报/导出见 P5-C；提交见 P5-D。 */
export interface FlagCandidateView {
  id: string;
  taskId: string;
  value: string;
  status: "new" | "confirmed" | "false_positive";
  evidence: EvidenceLevel;
  firstSeen: number;
  sources: FlagSourceView[];
  submittedAt?: number | null;
  /** P5-D：manual 只记录人工提交时间；dry_run 是预览，不落库。 */
  submitStatus?: "manual" | "dry_run" | "ok" | "failed" | "timeout" | null;
  /** V2-P0-2：候选类型/归一化值/spec 标识；旧候选没有这些字段。 */
  answerType?: AnswerType;
  normalizedValue?: string;
  specId?: string;
}

/**
 * P5-D：记分板（只读聚合）。
 *
 * 包含**全部任务**（含归档，历史积分仍算）；`flagCount` 是候选总数（三态都算）。
 * 旧快照没有该字段时渲染层不显示/回退。
 */
export interface ScoreboardView {
  tasks: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    points: number;
    flagCount: number;
  }>;
  solved: number;
  total: number;
  points: number;
}

/**
 * P6-B 批次 2a：代理真实运行状态。
 *
 * 与 `enabled` 分开口径：
 *  - `enabled` 来自 config，表示用户意图（想不想开代理）；
 *  - `state` 来自代理实例，表示真实状态（有没有起来、有没有崩）。
 * 旧快照/旧 mock 没有 `state` 时按未知处理，不臆造。
 */
export type ProxyState = "starting" | "running" | "failed" | "stopped";

/**
 * 代理状态视图（P6-B 批次 2a）。
 *
 * `port` 只有 `state=running` 时才是真实端口；`failed/stopped/starting` 一律为 null。
 * `error` 只在 `state=failed` 时有值。字段全部可选（state/error），旧渲染层不读不炸。
 */
export interface ScopeProxyView {
  /** 用户意图：来自 config.scope.proxy.enabled；启动失败也保持 true。 */
  enabled: boolean;
  /** 真实监听端口；非 running 状态为 null。 */
  port: number | null;
  /** 真实运行状态；缺席 = 旧快照，UI 显示未知。 */
  state?: ProxyState;
  /** state=failed 时的可读原因。 */
  error?: string;
}

/**
 * 题型分类（WP1 数据字段，WP2 用于 playbook/技能路由）。
 * 旧快照/旧 mock 没有该字段时按 unknown 处理。
 */
export type TaskCategory =
  | "web"
  | "misc"
  | "crypto"
  | "reverse"
  | "pwn"
  | "pentest"
  | "ir"
  | "awd"
  | "unknown";

// ---------------------------------------------------------------- 比赛平台

export type PlatformConnectionStatus =
  | "unconfigured"
  | "needs_login"
  | "connecting"
  | "connected"
  | "syncing"
  | "offline"
  | "error";

export interface PlatformTargetView {
  protocol: string;
  host: string;
  port: number;
  url: string;
  innerPort?: number | null;
  label?: string | null;
}

/** A bounded, read-only liveness probe for one platform target. */
export interface PlatformSceneProbeView {
  challengeId: string;
  url: string;
  protocol: string;
  host: string;
  port: number;
  reachable: boolean;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  checkedAt: number;
}

/** Structured platform submission verdict used by auto-submit correction. */
export interface PlatformSubmissionResultView {
  accepted: boolean;
  rejected: boolean;
  retryable: boolean;
  detail: string;
  statusCode: number | null;
}

export interface PlatformChallengeView {
  id: string;
  taskId: string | null;
  title: string;
  direction: string;
  category: TaskCategory;
  points: number;
  solvedCount: number;
  isSolved: boolean;
  description: string;
  attachmentName: string | null;
  attachmentUrl: string | null;
  withScene: boolean;
  sceneReady: boolean;
  targets: PlatformTargetView[];
  noticeCount: number;
  difficulty?: string | null;
  wpMatchCount?: number;
}

export interface PlatformRaceView {
  id: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  timeStatus: number | null;
  checkpointNum: number | null;
}

export interface WpMatchView {
  title: string;
  path: string;
  category?: string | null;
  score: number;
  reason: string;
}

export interface PlatformStateView {
  provider: string;
  status: PlatformConnectionStatus;
  baseUrl: string;
  username: string | null;
  displayName: string | null;
  team: string | null;
  organization: string[];
  race: PlatformRaceView | null;
  challenges: PlatformChallengeView[];
  lastSyncAt: number | null;
  cached: boolean;
  error: string | null;
  autoConnect: boolean;
  autoSync: boolean;
  autoSubmit: boolean;
  syncIntervalSeconds: number;
  wpRoot: string | null;
  wpIndexed: boolean;
  wpCount: number;
}

/**
 * 任务附件视图（WP3 / P3-A）。
 *
 * 附件本体落在 `<workRoot>/<taskId>/attachments/`，`attachments.json` 是清单；
 * `relativePath` 一律 POSIX 分隔符，禁止 `..` / 盘符 / 绝对路径 / NUL。
 * 全部字段都是只读快照，P3-A 不执行、不渲染任何附件。
 */
export interface AttachmentView {
  name: string;
  relativePath: string;
  size: number;
  sha256: string;
  type: string;
  source: string;
  importedAt: number;
}

/** 授权目标的类型（P4-A 只存值，不做解析/匹配；解析在 P4-B）。 */
export type TargetKind = "host" | "cidr" | "url";

/** 目标状态（人工维护；P4-A 不做存活探测）。 */
export type TargetStatus = "unknown" | "alive" | "owned";

/**
 * 任务授权目标（WP4 / P4-A）。
 *
 * 只是显式的范围数据：P4-A 增删改查，**不做策略判定**（P4-C）、
 * **不做 IP/CIDR 解析**（P4-B）、**不做代理**（P4-D）。
 * `value` 原样保存（只 trim），不加 CIDR/IP 校验。
 */
export interface TargetView {
  id: string;
  taskId: string;
  value: string;
  kind: TargetKind;
  status: TargetStatus;
  notes: string | null;
  createdAt: number;
}

/**
 * 工件视图（WP3 / P3-C）。
 *
 * 与附件不同：附件是导入进 `attachments/` 的原始题面文件；工件是任务目录里
 * agent/人产生的普通文件（`evidence/`、`artifacts/`、任务根目录等）。
 * `path` 是任务目录相对路径（POSIX），后端 realpath 校验；渲染层只读快照，
 * 不自己拼路径、不执行、不系统打开。
 */
export interface ArtifactView {
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: "text" | "image" | "binary" | "dir";
  previewable: boolean;
}

/**
 * 只读预览结果（P3-C）。文本/hex 只作为文本节点渲染；图片只接受
 * `data:image/(png|jpeg|gif|webp|bmp);base64`，HTML/SVG 一律按文本。
 */
export interface ArtifactPreview {
  kind: "text" | "image" | "hex" | "unsupported";
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
  totalBytes?: number;
  mime?: string;
  /** 可读错误（路径越界/不存在/后端不支持）；有值时 UI 只显示错误，不渲染内容。 */
  error?: string;
}

/** P3-C 附件选择：一次只允许一种来源类型。 */
export type AttachmentPickKind = "files" | "folder" | "zip";

export interface AttachmentPickResult {
  canceled: boolean;
  /** 绝对路径（dialog.showOpenDialog 返回）；取消时为空数组。 */
  paths: string[];
  error?: string;
}

// ---------------------------------------------------------------- 视图类型

export interface TaskView {
  id: string;
  title: string;
  brief: string;
  status: TaskStatus;
  answer: string | null;
  solvedBy: string | null;
  createdAt: number;
  /** 题型分类；可选，旧数据/旧 mock 缺席时视为 unknown。 */
  category?: TaskCategory;
  /** 任务优先级；0 为默认，数值越大越靠前（P1-B 才消费）。 */
  priority?: number;
  /** 该任务当前非终态会话数（P1-B 才填充）。 */
  runningSessions?: number;
  /** 该任务未隐藏会话总数（P1-B 才填充）。 */
  totalSessions?: number;
  /** 任务最后更新时间（毫秒）；P1-A 迁移时回填 created_at。 */
  updatedAt?: number;
  /** 是否已归档；归档只影响活跃看板，不删历史（P1-B 才实现归档动作）。 */
  archived?: boolean;
  /** 附件数量（WP3 用；P1-A 可留空）。 */
  attachmentCount?: number;
  /**
   * 附件清单（WP3 / P3-A 加的可选字段）。
   * 旧快照/旧 mock 不带它时不炸；当前 Hub 只给焦点任务填完整清单，
   * 其他任务只填 `attachmentCount`（避免每次快照搬运 N 份清单）。
   */
  attachments?: AttachmentView[];
  /**
   * 从 agent 消息 / 黑板事实里自动识别到的 flag 候选（`flag{...}`）。
   * 只是候选，**不会**自动把任务改成 solved —— 人工确认后才落 answer。
   */
  flagCandidate?: string | null;
  /** P5-A：该任务持久化候选数量（所有任务可填；旧快照缺席时按 0 处理）。 */
  flagCount?: number;
  /** P5-D：任务积分（默认 0；只读展示/记分板聚合）。 */
  points?: number;
  /** P5-D：提交模式；当前只实现 manual。 */
  submitMode?: "manual";
  /**
   * 该任务专属工作目录（R27 A1）：`<快照 workDir 根>/<taskId>`。
   * 同任务多会话共享、跨任务隔离。缺席时渲染层退回快照根目录。
   */
  workDir?: string | null;
  /**
   * 授权目标（WP4 / P4-A 可选字段）。
   * 快照只为**焦点任务**填完整列表；旧快照/旧 mock 不带时按空数组处理。
   */
  targets?: TargetView[];
  /** 显式拒绝目标（JSON 数组；P4-A 只读，P4-C 才参与策略判定）。 */
  denyTargets?: string[];
  /** 范围备注（如“只打 10.0.0.0/8”）；P4-A 只读。 */
  scopeNotes?: string | null;
  /**
   * V2-P0-5：允许的动作类型（如 terminal/exec、fs/write、session/request_permission）。
   * 非空时，scope.enabled=true 下未列出的动作默认转人工（approve），不静默放行。
   */
  allowedActions?: string[];
  /**
   * V2-P0-2：该任务的答案格式。缺席/旧任务按默认 `flag{...}` 处理。
   * 只影响候选识别与导出模板，不会自动确认或提交。
   */
  answerSpec?: AnswerSpec | null;
}

export interface SessionView {
  id: string;
  taskId: string;
  /** agent 标识：opencode / codex / claude / dsh */
  agent: string;
  role: Role;
  tier: Tier;
  status: SessionStatus;
  /** ACP 会话 id（与本地 id 不同，见 ARCHITECTURE §0.4） */
  acpSession: string | null;
  pid: number | null;
  /** 会话级模型覆盖；null 表示用 agent 的默认 */
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  /** P7-B：MCP 子进程异常断开；不改 status。旧快照没有该字段按 false。 */
  mcpUnavailable?: boolean;
}

/** 同步健康度 —— 窗格右上角那个小指标（§7.4） */
export interface SessionHealth {
  toolCalls: number;
  boardReads: number;
  /** 距上次读黑板的 tool call 数；>8 标黄，>12 标红 */
  syncLag: number;
}

/** 从 session/update 抽出来的流式事件（已归一化，UI 不用再理解 ACP） */
export interface StreamUpdate {
  /**
   * 会话内单调递增序号（主进程分配）。
   *
   * 为什么需要它：重启后渲染进程会先拉一次历史、再接受实时事件，两者在时间上可能
   * 重叠。渲染层用 `seq <= lastSeq` 丢弃重复项，避免同一句话被画两遍。
   */
  seq?: number;
  ts: number;
  kind:
    | "agent_message"
    | "agent_thought"
    | "user_prompt"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "other";
  /** tool_call 系的标题，例如 "read target/index.html" */
  title?: string;
  /** 文本增量（agent_message / agent_thought / plan） */
  text?: string;
  toolKind?: string;
  status?: string;
}

export interface ApprovalView {
  id: string;
  taskId: string;
  /** 任务标题（全局审批队列用；由 Hub 补，旧快照可缺席）。 */
  taskTitle?: string | null;
  sessionId: string;
  /** §9.1 的 action 命名，如 terminal/exec、fs/write */
  action: string;
  /** 左栏：命令全文 + 目标 */
  command: string | null;
  target: string | null;
  /** 中栏：agent 自述意图（从最近 reasoning/plan 事件抽取） */
  intentSummary: string | null;
  /** 右栏：命中规则 + 风险 */
  rule: string | null;
  /**
   * P4-C 批次 2：命中规则 id（与 rule 同值；旧快照可缺席）。
   * 单独保留 rule 以兼容旧渲染层；新 UI 可读 ruleId。
   */
  ruleId?: string | null;
  /**
   * P4-C 批次 2：策略判定时的结构化范围目标；仅 no-out-of-scope 命中时非空。
   * 旧快照/旧 mock 没有该字段时按 null 处理，不炸。
   */
  scopeTarget?: { kind: string; value: string } | null;
  risk: RiskLevel;
  /**
   * 操作画像（权限增强）：类别、是否高风险、能否被「本会话/该 agent 始终允许」记住。
   * 全部可选，旧快照 / 旧测试没有这些字段时 UI 退化为「只放行/拒绝」。
   */
  category?: string;
  categoryLabel?: string;
  highRisk?: boolean;
  rememberable?: boolean;
  status: ApprovalStatus;
  decidedBy: "human" | "policy" | null;
  /** 同会话同类动作已出现次数，用于 §9.6 的退避计数 */
  sameKindCount: number;
  createdAt: number;
  decidedAt: number | null;
}

export interface FactView {
  id: string;
  content: string;
  status: "candidate" | "verified" | "challenged" | "retired";
  evidence: EvidenceLevel;
  witness: string | null;
  by: string | null;
}

export interface DeadEndView {
  id: string;
  description: string;
  scope: string | null;
  reopenWhen: string | null;
  by: string | null;
  createdAt: number;
}

export interface LeaseView {
  resource: string;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface IntentView {
  id: string;
  description: string;
  status: "open" | "claimed" | "done" | "abandoned" | "blocked_by_conflict";
  claimedBy: string | null;
}

export interface BoardEventView {
  id: number;
  ts: number;
  by: string | null;
  kind: "fact" | "deadend" | "intent" | "claim" | "release" | "answer" | "approval" | "note" | "lifecycle";
  body: unknown;
}

// ---------------------------------------------------------------- WP9-A：AWD / IR 只读视图

/** AWD 轮次（由 awd.round fact 派生；人工开始/结束，不接平台）。 */
export interface AwdRoundView {
  number: number;
  startedAt: number;
  endsAt: number;
  state: "idle" | "running" | "ended";
}

/** AWD 服务（targets + awd.service fact；status 复用 TargetStatus）。 */
export interface AwdServiceView {
  id: string;
  name: string;
  target: string;
  status: TargetStatus;
  ownerSessionId?: string | null;
  patchStatus?: string | null;
}

/** AWD 每轮 flag 候选（awd.flag fact 映射；未映射的归 round=0）。 */
export interface AwdFlagRoundView {
  round: number;
  candidates: FlagCandidateView[];
  confirmed: number;
  submitted: number;
}

export interface AwdPatchView {
  id: string;
  service: string;
  vuln: string;
  status: "proposed" | "applied" | "verified" | "failed";
  evidence: EvidenceLevel;
  witness?: string | null;
}

export interface AwdCheckView {
  round: number;
  item: string;
  status: "todo" | "ok" | "fail";
  evidence?: string | null;
}

export interface AwdAttackView {
  id: string;
  attacker: string;
  target: string;
  action: string;
  result: string;
  evidence?: string | null;
  at: number;
}

/** AWD 只读视图（category=awd；旧快照没有该字段）。 */
export interface AwdView {
  taskId: string;
  round: AwdRoundView | null;
  services: AwdServiceView[];
  flags: AwdFlagRoundView[];
  patches: AwdPatchView[];
  checks: AwdCheckView[];
  attacks: AwdAttackView[];
  scoreboard?: ScoreboardView;
  /** 结构化 fact 解析失败/缺字段的告警；不猜、不抛错。 */
  warnings?: string[];
}

export interface IrEvidenceView {
  id: string;
  kind: string;
  path: string;
  sha256?: string;
  evidence: EvidenceLevel;
  witness?: string | null;
  source: string;
  addedAt: number;
}

export interface IrTimelineView {
  id: string;
  at: number;
  source: string;
  event: string;
  impact?: string;
  evidence?: string | null;
}

export interface IrAnswerCandidateView {
  /** 对应 flag_candidates.id；人工确认走现有 flag.confirm。 */
  candidateId?: string;
  value?: string;
  answerType?: AnswerType;
  confidence: number;
  evidence: EvidenceLevel;
  witness?: string | null;
  sources?: string[];
  gaps?: string[];
}

export interface IrQuestionView {
  id: string;
  question: string;
  status: "open" | "answered" | "verified";
  answer?: string | null;
  evidence?: string | null;
  /** V2-P0-4：分析产生的候选答案（未确认）与缺口。 */
  candidates?: IrAnswerCandidateView[];
  gaps?: string[];
}

export interface IrAnalysisView {
  analyzerId: string;
  input: string;
  sha256?: string;
  facts: number;
  timeline: number;
  iocs: number;
  warnings: string[];
  tools: Array<{ tool: string; ok: boolean; exitCode: number | null; timedOut: boolean; durationMs: number }>;
  generatedAt: number;
}

/** IR 只读视图（category=ir；旧快照没有该字段）。 */
export interface IrView {
  taskId: string;
  evidence: IrEvidenceView[];
  timeline: IrTimelineView[];
  questions: IrQuestionView[];
  attachments: AttachmentView[];
  artifacts: ArtifactView[];
  /** V2-P0-4：分析运行摘要（每个分析器×输入一条）。 */
  analysis?: IrAnalysisView[];
  warnings?: string[];
}

/** V2-P0-4：ir.analyze 的返回摘要（不包含答案明文）。 */
export interface IrAnalysisSummaryView {
  taskId: string;
  inputs: number;
  results: number;
  facts: number;
  timeline: number;
  iocs: number;
  candidates: number;
  warnings: string[];
  durationMs: number;
  generatedAt: number;
}

// ---------------------------------------------------------------- 快照与事件

/** UI 首屏拉一次 */
export interface HubSnapshot {
  task: TaskView | null;
  /**
   * 本机全部任务（R19，切换任务用），按创建时间倒序（最新在前）。
   *
   * 当前任务仍单独放在 `task`（向后兼容，渲染层据此画任务卡）；这个列表只用于
   * 「切换回旧任务」。R17 之前旧任务数据一直留在库里却没有任何入口能切回去。
   */
  tasks: TaskView[];
  sessions: SessionView[];
  approvals: ApprovalView[];
  /**
   * P5-A：焦点任务的 flag 候选（含来源）；旧快照没有该字段时渲染层按空处理。
   * P5-C 的确认/误报通过 flag.updated 增量更新；提交留 P5-D。
   */
  flags?: FlagCandidateView[];
  /**
   * P5-D：记分板（只读聚合，含归档任务）。
   * 旧快照/旧 mock 缺席时渲染层隐藏记分板，不臆造。
   */
  scoreboard?: ScoreboardView;
  /**
   * 全部任务（跨任务）的待批/已决项；`approvals` 仍是焦点任务，保持旧渲染层兼容。
   * P1-A 只加字段，P1-B 才由 Hub 填充和消费。
   */
  approvalsAll?: ApprovalView[];
  /**
   * 会话配额展示（P1-A 只加字段；P1-B 才填充/执行配额）。
   * 旧快照没有该字段时 UI 不显示配额。
   */
  quota?: {
    maxSessionsPerTask: number;
    maxSessionsTotal: number;
    runningSessions: number;
  };
  /**
   * P4-D：范围/代理状态（只读展示，不参与判定）。
   * 可选：旧快照/旧 mock 缺席时 UI 显示“范围状态未知”，不臆造。
   *
   * P6-B 批次 2a：`proxy.state/error` 是可选字段——`enabled` 仍是 config 意图，
   * `state` 是代理实例真实状态，`port` 只有 running 时才是真实端口。
   * 旧快照没有 state 时保持“未知”，不能当成 running/stopped。
   */
  scope?: {
    enabled: boolean;
    outOfScopeAction: "block" | "approve";
    proxy?: ScopeProxyView;
  };
  /**
   * 技能库状态（P2-A 只读字段）。
   * 可选：旧快照/旧 mock 没有该字段时渲染层不读即可，不影响任何旧行为。
   * P2-A 只做「根解析 + 懒索引占位」；builtAt 为 null 表示索引尚未构建。
   */
  skill?: {
    configured: boolean;
    root: string | null;
    packages: string[];
    builtAt: number | null;
    /**
     * V2-P0-1：技能库根来源。`packaged` = 安装包内置最小库；
     * `env` / `config` = 外置完整库；`dev` = 开发态仓库同级 skill。
     * 旧快照没有该字段时 UI 显示“来源未知”，不臆造。
     */
    source?: "env" | "config" | "dev" | "packaged";
    error?: string;
  };
  /**
   * 焦点任务的附件清单（P3-A 可选字段）。
   * 无任务/未导入时是空数组；旧快照没有该字段时渲染层按空处理。
   */
  attachments?: AttachmentView[];
  /**
   * 焦点任务的工件清单（P3-C 可选字段）。
   * 无任务/无产物时是空数组；旧快照没有该字段时渲染层按空处理。
   */
  artifacts?: ArtifactView[];
  /**
   * 当前生效的「一键放行」授权（权限增强）。
   * 可选：旧验证脚本构造的快照没有该字段时，渲染层按空列表处理。
   */
  permissionGrants?: PermissionGrantView[];
  board: {
    facts: FactView[];
    deadEnds: DeadEndView[];
    leases: LeaseView[];
    intents: IntentView[];
  };
  health: Record<string, SessionHealth>;
  /** 已检测到的 agent（C3：只检测不安装） */
  agents: Array<{
    id: string;
    title: string;
    installed: boolean;
    installHint: string;
    maturity: string;
    /**
     * 这家 agent 默认会不会主动请求授权（应 Lane B 的请求 R-2）。
     *
     * 为什么它值得进契约：实测三家行为完全不同——claude 开箱就会发
     * `session/request_permission`，opencode / codex 默认不问（它们自己判断着做）。
     * 而"人工审批"这个核心卖点只在会问的那家开箱成立。所以扇出时选哪家 agent，
     * 直接决定 guarded 档有没有输入。这个知识属于主进程的检测层，不该硬编码在渲染层。
     */
    permissionBehavior?: "requests_by_default" | "needs_config" | "unknown";
  }>;
  /**
   * 当前生效的策略规则包（应 Lane B 的请求 R-1，2026-10-13）。
   * 渲染进程在 contextIsolation 下拿不到 stdout/环境变量，只能靠快照带过来。
   * 字段可选：缺席时 UI 显示「—」，不报错。
   */
  policy?: {
    packId: string;
    name: string;
    /** 规则包缺失、回落到内置最小安全集时为 true —— UI 应显式提示 */
    fellBackToMinimal: boolean;
  };
  /**
   * 本机允许 agent 生成文件的唯一根目录（R16）。
   *
   * 来源优先级：`BUMIMANG_WORKDIR` 环境变量 > `config/app.json` 的 `workDir`
   * （本仓库默认 `D:/agent/xuanwo/work`）> 运行形态兜底（开发态 `<repo>/work`，
   * 打包态 exe 同级/上一级的 `work/`）。渲染层把它显示在任务卡上，让「产物去了哪」一目了然。
   */
  workDir?: string;
  /**
   * P7-A：events 哈希链健康（只读告警，不自动截断）。
   * 旧快照/旧 mock 没有该字段；断裂时 brokenAt 是首个 prev_hash 不连续的事件 id。
   */
  healthChain?: {
    ok: boolean;
    brokenAt?: number;
  };
  /** WP9-A：AWD 只读视图；仅 category=awd 的焦点任务填。旧快照没有该字段。 */
  awd?: AwdView;
  /** WP9-A：IR 只读视图；仅 category=ir 的焦点任务填。旧快照没有该字段。 */
  ir?: IrView;
  /** 比赛平台连接、题目列表与同步状态；离线/旧快照可以缺席。 */
  platform?: PlatformStateView;
}

// ---------------------------------------------------------------- V2-P0-3：战略建议（只读视图）

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

export interface StrategyScoreView {
  expectedPoints: number;
  successProbability: number;
  marginalEvidence: number;
  timeCostMinutes: number;
  costWeight: number;
  scopeRisk: number;
  noProgress: number;
}

export interface StrategyRecommendationView {
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
  doNot: string[];
  score: StrategyScoreView;
  applicable: boolean;
}

export interface StrategyNoActionView {
  taskId: string;
  taskTitle: string;
  reason: string;
}

export interface StrategyPlanView {
  generatedAt: number;
  mode: StrategyMode;
  budget: {
    now: number;
    remainingMs?: number;
    perTaskMs?: number;
    verifyMs?: number;
    maxSessions: number;
    maxSessionsPerTask?: number;
    maxNewSessions?: number;
    humanApprovalsRemaining?: number;
    sessionCost?: number;
    approvalCost?: number;
  };
  recommendations: StrategyRecommendationView[];
  noAction: StrategyNoActionView[];
  summary: string;
  limitedBy: string[];
}

/** 主进程推给渲染进程的增量 */
export type HubEvent =
  | { type: "task.upsert"; task: TaskView }
  | { type: "session.upsert"; session: SessionView }
  /** 会话被关标签移除（R20 session.remove）：从列表消失，历史保留在库里，只是不再显示 */
  | { type: "session.removed"; sessionId: string; taskId?: string }
  | { type: "session.stream"; sessionId: string; taskId?: string; update: StreamUpdate }
  | { type: "approval.upsert"; approval: ApprovalView }
  /** 一键放行授权变化（新增 / 撤销 / 过期清理） */
  | { type: "permission.updated"; grants: PermissionGrantView[] }
  | { type: "board.appended"; taskId?: string; events: BoardEventView[] }
  | { type: "health"; sessionId: string; taskId?: string; health: SessionHealth }
  /** P7-B：MCP 子进程异常断开；会话保留但黑板工具不可用，需新建会话。 */
  | { type: "mcp.unavailable"; sessionId: string; taskId?: string }
  /**
   * 工件列表刷新（WP3 / P3-C）。`artifact.refresh` 后广播；渲染层只更新焦点任务。
   */
  | {
      type: "artifact.updated";
      taskId: string;
      artifacts: ArtifactView[];
    }
  /**
   * P5-C：flag 候选状态变化（确认/误报后广播）。
   *
   * 只带该任务的完整候选列表；渲染层按 P1-E 规则只接受焦点任务的事件。
   * 导出不广播（没有状态变化），导出内容由 `flag.export` 的 ActionResult 返回。
   */
  | { type: "flag.updated"; taskId: string; flags: FlagCandidateView[] }
  /**
   * P6-B 批次 2a：代理真实状态变化（启动成功 / 启动失败 / 运行中崩溃 / 主动关闭）。
   *
   * 可选事件：旧渲染层不识别该 type 时直接忽略，不炸。快照里的
   * `scope.proxy.state/error` 是同一状态的兜底；事件只用于实时更新。
   */
  | { type: "proxy.state.changed"; proxy: ScopeProxyView }
  /** 平台连接、题目列表或同步状态变化。 */
  | { type: "platform.updated"; platform: PlatformStateView };

// ---------------------------------------------------------------- 动作（渲染进程 → 主进程）

export type HubAction =
  /** Renderer view switch; main uses it to avoid shipping hidden-pane streams. */
  | { type: "ui.setView"; view: "competition" | "workspace" }
  | {
      type: "task.create";
      title: string;
      brief: string;
      /** 题型分类（可选；缺省 unknown，P1-B 起 UI 可传）。 */
      category?: TaskCategory;
      /** 优先级（可选；缺省 0）。 */
      priority?: number;
      /** V2-P0-2：答案格式（可选；缺省按默认 flag{...}）。 */
      answerSpec?: AnswerSpec;
      /** V2-P0-3：题目分值（可选；缺省 0）。策略层用 points 优先于 priority。 */
      points?: number;
    }
  /**
   * V2-P0-3：人工更新任务的分值/优先级（只改调度输入，不执行任何利用/提交）。
   * 只允许 priority/points；其他字段走各自动作。
   */
  | { type: "task.update"; taskId: string; priority?: number; points?: number }
  /** 切换当前焦点（R19）：P1-B 起只切 UI 焦点，不停任何会话。 */
  | { type: "task.switch"; taskId: string }
  /** 只切焦点（P1-B 新增；与 task.switch 等价）。 */
  | { type: "task.focus"; taskId: string }
  /**
   * 归档任务（P1-B 只做占位校验：有活会话且 force!==true 时拒绝；
   * 真正归档/看板过滤留 P1-D）。
   */
  | { type: "task.archive"; taskId: string; force?: boolean }
  /** 显式停止某任务的全部非终态会话（P1-B；不影响其他任务，不归档）。 */
  | { type: "task.stopAll"; taskId: string }
  | {
      type: "session.start";
      taskId: string;
      agent: string;
      role: Role;
      tier: Tier;
      model?: string;
      /**
       * 一键全部放行（用户显式选择）：本会话所有需要人工审批的动作自动放行，
       * 包括执行命令 / 删除 / 凭据 / 网络等高风险类别。
       *
       * 边界：规则引擎的 block（硬阻断）与工作目录包含性检查仍然生效。
       */
      allowAll?: boolean;
    }
  | { type: "session.stop"; sessionId: string }
  /**
   * 关标签真移除（R20）：先停（若在跑），再把会话从列表隐藏。
   *
   * 语义（用户拍板）：**只隐藏、不删除**——库里记录与 stream.jsonl 历史都保留，
   * 恢复 = 把库里 sessions.hidden 翻回 0（UI 恢复入口留给下一轮）。
   */
  | { type: "session.remove"; sessionId: string }
  | { type: "session.prompt"; sessionId: string; text: string }
  | {
      type: "approval.decide";
      approvalId: string;
      decision: "approve" | "deny";
      /** §9.5 规则学习：这次放行，以后同类自动放行 */
      remember?: boolean;
      /**
       * 记住的范围：
       *  - session：本会话内同类操作始终允许（默认，兼容旧 remember=true）；
       *  - agent：对该 agent 永久允许，写入本地配置文件，重启后仍生效。
       */
      rememberScope?: "session" | "agent";
    }
  | {
      type: "permission.revoke";
      agentId: string;
      /** 不传 = 撤销该 agent 的全部授权（含会话级）；传入则只撤销这一条。 */
      grantId?: string;
    }
  /**
   * 一键全部放行（用户显式操作）。
   *
   * - scope=session：该会话所有需人工审批的动作自动放行（含高风险），仅本会话有效；
   * - scope=agent：对该 agent 的所有会话永久生效，写入本地 permissions.json；
   * - scope=all：当前任务的所有活跃会话各发一条 session 级通配授权；
   * - scope=global：全局全部放行（所有 agent / 所有会话），写入本地 permissions.json。
   *
   * 无论哪种 scope，命令/文件操作仍先过策略引擎：block 硬阻断不可放行，
   * 工作目录边界也不因通配授权而取消。
   */
  | {
      type: "permission.grantAll";
      scope: "session" | "agent" | "all" | "global";
      sessionId?: string;
      agentId?: string;
      /** P1-B 只透传；跨任务批量逻辑留 P1-E/后续。 */
      taskId?: string;
    }
  | { type: "approval.bulk"; ids: string[]; decision: "approve" | "deny" }
  | { type: "session.setTier"; sessionId: string; tier: Tier }
  /** 打断当前这一轮推理（session/cancel），已排队的人工提示会在其后送达 */
  | { type: "session.interrupt"; sessionId: string }
  /** 人工更新任务状态：待解 / 解题中 / 已解出 / 已放弃（附 flag / 答案） */
  | { type: "task.setStatus"; taskId?: string; status: TaskStatus; answer?: string }
  /**
   * 导入附件（WP3 / P3-A）：文件、文件夹或 zip，三者不能混在一次动作里。
   * `taskId` 缺省 = 当前焦点任务；`note` 只进审计，不写进 attachments.json。
   */
  | { type: "attachment.import"; taskId?: string; paths: string[]; note?: string }
  /**
   * 刷新工件列表（WP3 契约占位）。P3-A 只加类型，调用返回「P3-C 才实现」；
   * 真正的工件扫描/预览在 P3-C 接渲染层时做。
   */
  | { type: "artifact.refresh"; taskId?: string }
  /**
   * 新增授权目标（WP4 / P4-A）。
   *
   * 只做数据 CRUD：不解析 IP/CIDR/URL（P4-B）、不参与策略判定（P4-C）。
   * `value` 非空、≤256；`kind` 只允许 host/cidr/url，缺省 host；
   * 同一任务内 value 唯一，不同任务可以重复。
   */
  | {
      type: "target.add";
      taskId: string;
      value: string;
      kind?: TargetKind;
      notes?: string;
    }
  /** 更新目标状态/备注（P4-A；targetId 必须属于该 taskId）。 */
  | {
      type: "target.update";
      taskId: string;
      targetId: string;
      status?: TargetStatus;
      notes?: string;
    }
  /** 移除目标（P4-A；targetId 必须属于该 taskId）。 */
  | { type: "target.remove"; taskId: string; targetId: string }
  /**
   * V2-P0-5：更新任务范围数据（denyTargets / scopeNotes / allowedActions）。
   * 只写数据并审计；不自动改 targets、不自动启用 scope。
   */
  | {
      type: "task.scope.update";
      taskId: string;
      denyTargets?: string[];
      scopeNotes?: string | null;
      allowedActions?: string[];
    }
  /**
   * 确认 flag 候选（P5-C，只能人工触发）。
   *
   * 候选必须属于该 taskId；确认后候选 status=confirmed，任务
   * answer=候选值、status=solved、solvedBy=human。**不删除候选、不自动提交**。
   */
  | { type: "flag.confirm"; taskId: string; candidateId: string }
  /**
   * 标记 flag 候选为误报（P5-C）。
   *
   * 候选保留（只改 status=false_positive，供审计）；不写 task.answer、
   * 不改任务状态、不删除候选。
   */
  | { type: "flag.reject"; taskId: string; candidateId: string }
  /**
   * 导出 flag 候选（P5-C）。
   *
   * `taskId` 缺省 = 导出全部**有候选**的任务；指定 taskId 时只导出该任务。
   * 只返回 `ActionResult.content`，**不写文件**；渲染层决定保存或复制。
   * 事件/审计只记 format 与候选数，不记 flag 明文。
   */
  | { type: "flag.export"; taskId?: string; format: "md" | "csv" | "json" }
  /**
   * P9-C1：AWD/IR 只读导出。
   *
   * 返回 ActionResult.content（md/csv/json）；不写文件、不接平台、
   * 不自动提交/利用/开环境。taskId 缺省 = 当前焦点任务。
   */
  | { type: "awd.export"; taskId?: string; format: "md" | "csv" | "json" }
  | { type: "ir.export"; taskId?: string; format: "md" | "csv" | "json" }
  /**
   * 人工提交 flag（P5-D）。
   *
   * - mode 缺省/manual：只记录候选 submitted_at/submit_status="manual"，返回
   *   value + instructions；**不执行任何命令、不调用平台 API**。
   * - mode=dry_run：只返回 argv 预览；不执行、不写文件、不改候选状态。
   * - command 模式**未实现**（用户决策：WP6 评估前不做）；运行时收到 command
   *   返回可读错误，不静默降级。
   */
  | {
      type: "flag.submit";
      taskId: string;
      candidateId: string;
      mode?: "manual" | "dry_run";
    }
  /**
   * V2-P0-3：生成作战建议（只读）。
   *
   * 默认只看焦点任务；taskId 可指定。返回 `ActionResult.strategyPlan`。
   * 只给建议，不执行任何会话动作。
   */
  | { type: "strategy.plan"; taskId?: string; mode?: StrategyMode }
  /**
   * V2-P0-3：应用选中的建议（人工显式点击）。
   *
   * 只允许 start_session / stop_session / switch_role；apply 会按当前状态重算计划，
   * 不信任渲染层传来的 EV/agent/role。受 maxSessions、scope、审批与预算约束。
   * competition-auto 只是允许更多自动动作的显式模式，不会绕过这些上限。
   */
  | {
      type: "strategy.apply";
      taskId: string;
      recommendationIds: string[];
      mode?: StrategyMode;
    }
  /** 登录比赛平台；成功后会立即拉取比赛与题目列表。 */
  | {
      type: "platform.login";
      username: string;
      password: string;
      baseUrl?: string;
      /** auto / nest-cyberpeace / ctfd / ctfy；缺省 auto。 */
      provider?: string;
      raceId?: string;
      remember?: boolean;
    }
  | { type: "platform.logout" }
  | { type: "platform.sync"; raceId?: string }
  /**
   * 把平台题目物化为本地任务：建任务、下载附件、复制同类 WP、登记靶机目标。
   * 不启动 agent；随后由 UI 显式调用 session.start。
   */
  | {
      type: "platform.materialize";
      challengeId: string;
      downloadAttachment?: boolean;
      includeWp?: boolean;
    }
  | { type: "platform.openScene"; challengeId: string }
  | { type: "platform.closeScene"; challengeId: string }
  /**
   * 只读探测题目靶机的 HTTP/TCP 存活状态。目标只能来自平台快照，渲染层
   * 不能传入任意 URL；用于自动调度识别 502/断连并切换到下一题。
   */
  | { type: "platform.probeScenes"; challengeIds?: string[] }
  /** 显式提交 flag 到平台；成功后任务标记已解出。 */
  | {
      type: "platform.submitFlag";
      challengeId: string;
      flag: string;
      taskId?: string;
      candidateId?: string;
    }
  /** 检索本地 WP（只读，不复制）。 */
  | { type: "platform.searchWp"; challengeId: string; limit?: number }
  /**
   * V2-P0-4：导入 IR 问题清单（每行一个问题，或 JSON 数组）。
   * 只写 ir.question 事实；不写答案、不自动回答。
   */
  | { type: "ir.questions.import"; taskId?: string; text: string }
  /**
   * V2-P0-4：分析 IR 附件/工件（日志、ZIP、Webshell、PCAP、EVTX、内存等）。
   *
   * paths 缺省 = 扫描 attachments/evidence/artifacts；相对路径按任务目录解析。
   * 只产生证据/事实/候选；不确认、不提交、不执行 payload。
   */
  | { type: "ir.analyze"; taskId?: string; paths?: string[] };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** 可选的提示文案（如「已排队，当前轮结束后送达」），UI 直接 notify */
  message?: string;
  /**
   * flag.export 的导出内容（P5-C）。
   *
   * 内容本身包含 flag 明文，只在 IPC 返回值里传给渲染层；主进程**不落文件**、
   * 不写 events/审计。其他动作不填该字段。
   */
  content?: string;
  /**
   * P5-D：flag.submit 的返回（manual / dry_run）。
   * manual 不执行命令、不调平台 API；dry_run 只给 argv 预览，不执行。
   */
  mode?: "manual" | "dry_run";
  /** manual：候选值，供用户复制到比赛平台。 */
  value?: string;
  /** manual：人读说明（不自动提交；复制后手动提交）。 */
  instructions?: string;
  /** dry_run：argv 预览（只展示，不 spawn）。 */
  argv?: string[];
  /** V2-P0-3：strategy.plan 返回的建议（只读；不含答案明文）。 */
  strategyPlan?: StrategyPlanView;
  /** V2-P0-4：ir.analyze 的运行摘要（只读；不含答案明文）。 */
  irAnalysis?: IrAnalysisSummaryView;
  /** 平台动作后返回最新状态，避免 UI 再等一轮 snapshot。 */
  platform?: PlatformStateView;
  /** platform.materialize 创建/复用的任务 id。 */
  taskId?: string;
  /** 平台题目 id。 */
  challengeId?: string;
  /** platform.searchWp 的命中列表。 */
  wpMatches?: WpMatchView[];
  /** platform.probeScenes 的探测结果。 */
  sceneProbes?: PlatformSceneProbeView[];
  /** platform.submitFlag 的结构化判定（接受 / 明确拒绝 / 可重试）。 */
  submission?: PlatformSubmissionResultView;
}

/** 渲染进程看到的接口面。主进程通过 Electron IPC 实现它。 */
export interface HubApi {
  snapshot(): Promise<HubSnapshot>;
  dispatch(action: HubAction): Promise<ActionResult>;
  /**
   * 某个会话的完整对话历史（R16，持久化恢复用）。
   *
   * 只在这一条通道上拉历史：快照每次动作都会重拉，如果把历史塞进快照，
   * 一次审批就会搬运整段对话。历史按会话单独取，渲染层只在建标签页时拉一次。
   */
  history(sessionId: string): Promise<StreamUpdate[]>;
  /**
   * P3-C：只读预览一个任务内文件（附件或产物）。
   *
   * `path` 是任务目录相对路径：附件要带 `attachments/` 前缀，产物用
   * `ArtifactView.path`。后端负责 realpath/越界/symlink 校验；渲染层不拼任意路径。
   * 旧 preload/mock 可以不实现（可选），UI 显示“当前后端不支持预览”。
   */
  previewArtifact?(taskId: string | undefined, path: string): Promise<ArtifactPreview>;
  /**
   * P3-C：打开系统文件/文件夹选择器，返回绝对路径。
   * 只由 Electron 主进程实现；浏览器/mock 环境可返回取消或演示路径。
   */
  pickAttachments?(kind: AttachmentPickKind): Promise<AttachmentPickResult>;
  onEvent(cb: (e: HubEvent) => void): () => void;
}

/** IPC 通道名（冻结） */
export const HUB_CHANNELS = {
  snapshot: "hub:snapshot",
  dispatch: "hub:action",
  event: "hub:event",
  history: "hub:history",
  /** P3-C：只读预览 */
  artifactPreview: "hub:artifact.preview",
  /** P3-C：文件/文件夹/zip 选择器 */
  attachmentPick: "hub:attachment.pick",
} as const;
