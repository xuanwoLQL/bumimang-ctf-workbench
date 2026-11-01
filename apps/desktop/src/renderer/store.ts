/**
 * 渲染进程侧的状态仓库（纯逻辑，无 DOM）。
 *
 * 职责：把主进程推来的 `HubSnapshot` / `HubEvent` 折叠成一份 UI 可读的状态。
 * 高频的 `session.stream` 不在这里积累 —— 它由 `panes/model.ts` 的节流器单独处理
 * （见 ARCHITECTURE §6 已知坑：单轮约 150 条 tool_call_update，不能逐条进状态、逐条渲染）。
 *
 * P1-E：从「单任务视图」升级为「多任务看板 + 焦点视图」。
 *   - `tasks` 保留全部任务（含 archived）；`task/sessions/approvals/board/health`
 *     仍是焦点任务，旧调用方不用改；
 *   - `approvalsAll` 保存跨任务审批，供全局队列过滤；
 *   - 后台 `session.upsert/removed` 只更新对应任务的 running/total 计数，
 *     不把后台会话塞进焦点列表；
 *   - 焦点切换/归档时立刻清空旧焦点缓存，等新快照替换，避免 A 的会话串到 B。
 */
import type {
  TaskView,
  SessionView,
  SessionHealth,
  SessionStatus,
  ApprovalView,
  PermissionGrantView,
  FactView,
  DeadEndView,
  LeaseView,
  IntentView,
  AttachmentView,
  ArtifactView,
  FlagCandidateView,
  ScoreboardView,
  AwdView,
  IrView,
  PlatformStateView,
  HubSnapshot,
  HubEvent,
} from "./contract.ts";
import type { AgentDescriptor, PolicyPackInfo } from "./contract.ts";

export interface SessionMeta {
  taskId: string;
  status: SessionStatus;
}

type ProxyStateChangedEvent = Extract<HubEvent, { type: "proxy.state.changed" }>;
/** P6-B 批次 2b：契约里的代理真实状态（从 HubEvent 派生，避免重复定义）。 */
export type ScopeProxyState = NonNullable<ProxyStateChangedEvent["proxy"]["state"]>;

/**
 * P4-D：范围/代理状态（来自 `HubSnapshot.scope?`）。
 *
 * `null` 表示旧快照没有该字段 —— UI 必须显示「范围状态未知」，不能当成
 * 「未启用」或「已启用」。代理状态只读展示；批次 1 的 `port` 恒为 null。
 *
 * P6-B 批次 2b：`state/error` 是可选字段——`enabled` 是 config 用户意图，
 * `state` 是真实状态；旧快照没有 state 时 UI 显示「未知」，不臆造。
 */
export interface ScopeProxyStatusState {
  enabled: boolean;
  port: number | null;
  state?: ScopeProxyState;
  error?: string;
}

export interface ScopeStatusState {
  enabled: boolean;
  outOfScopeAction: "block" | "approve";
  proxy: ScopeProxyStatusState | null;
}

export type ScopeStatusKind = "disabled" | "enabled" | "unknown";

/** P6-B 批次 2b：代理显示的六种落地状态（含旧快照的未知与 config 关闭）。 */
export type ScopeProxyDisplayState =
  | "running"
  | "failed"
  | "stopped"
  | "starting"
  | "unknown"
  | "disabled";

export type ScopeProxyTone = "ok" | "error" | "warn" | "muted";

export interface ScopeStatusView {
  kind: ScopeStatusKind;
  badge: string;
  headline: string;
  title: string;
  outOfScopeAction: "block" | "approve";
  proxyEnabled: boolean;
  proxyPort: number | null;
  /** P6-B 批次 2b：代理真实状态的显示口径。 */
  proxyState: ScopeProxyDisplayState;
  proxyText: string;
  proxyTitle: string;
  proxyTone: ScopeProxyTone;
  proxyError: string | null;
}

function normalizeProxyState(value: unknown): ScopeProxyState | undefined {
  return value === "starting" || value === "running" || value === "failed" || value === "stopped"
    ? value
    : undefined;
}

/**
 * P6-B 批次 2b：归一化代理视图。
 *
 * - `state` 只认四个真实状态；其他值按旧快照处理（缺席）；
 * - `port` 仅 `state=running` 时保留；failed/stopped/starting 强制 null；
 * - 旧快照没有 state 时保留 port（P4-D 旧语义），不臆造 state；
 * - `error` 只在非空字符串时保留。
 */
function normalizeScopeProxyState(
  raw:
    | { enabled?: unknown; port?: unknown; state?: unknown; error?: unknown }
    | null
    | undefined,
): ScopeProxyStatusState | null {
  if (!raw) return null;
  const state = normalizeProxyState(raw.state);
  const rawPort =
    typeof raw.port === "number" && Number.isFinite(raw.port) ? raw.port : null;
  const port = state && state !== "running" ? null : rawPort;
  const error =
    typeof raw.error === "string" && raw.error.trim() ? raw.error.trim() : undefined;
  return {
    enabled: raw.enabled === true,
    port,
    ...(state ? { state } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * P6-B 批次 2b：把代理状态折叠成 UI 文案。
 *
 * 关键口径（限制 A/B）：
 *  - failed 只说启动失败 + error，绝不说“已启用”；
 *  - stopped 不带 port；
 *  - 旧快照没有 state 时说“状态未知”，不说“已启用”；
 *  - config 明确关闭（enabled=false）时优先说“未启用”，不把默认关误报成“已停止”。
 */
function proxyStatusView(proxy: ScopeProxyStatusState | null): {
  state: ScopeProxyDisplayState;
  text: string;
  title: string;
  tone: ScopeProxyTone;
  error: string | null;
} {
  if (!proxy) {
    return {
      state: "unknown",
      text: "本地代理状态未知（旧快照）",
      title: "旧快照没有代理状态；快照更新后会自动显示",
      tone: "warn",
      error: null,
    };
  }
  const error = proxy.error ?? null;
  switch (proxy.state) {
    case "running": {
      const portText = proxy.port != null ? ` :${proxy.port}` : "";
      return {
        state: "running",
        text: `本地代理运行中${portText}`,
        title:
          `本地代理运行中${portText}；仅对遵守 HTTP_PROXY 的工具生效，` +
          "nmap/raw socket/DNS 可绕过",
        tone: "ok",
        error: null,
      };
    }
    case "failed": {
      const message = error ?? "未知错误";
      return {
        state: "failed",
        text: `本地代理启动失败：${message}`,
        title: `本地代理启动失败：${message}；会话照常启动，代理网络出口不可用`,
        tone: "error",
        error,
      };
    }
    case "starting":
      return {
        state: "starting",
        text: "本地代理启动中…",
        title: "本地代理启动中；启动失败不会阻塞会话",
        tone: "warn",
        error: null,
      };
    case "stopped":
      if (!proxy.enabled) {
        return {
          state: "disabled",
          text: "本地代理未启用",
          title: "scope.proxy.enabled=false",
          tone: "muted",
          error: null,
        };
      }
      return {
        state: "stopped",
        text: "本地代理已停止",
        title: "本地代理已停止；会话继续，网络出口不可用",
        tone: "muted",
        error: null,
      };
    default:
      if (!proxy.enabled) {
        return {
          state: "disabled",
          text: "本地代理未启用",
          title: "scope.proxy.enabled=false（旧快照未带 state）",
          tone: "muted",
          error: null,
        };
      }
      return {
        state: "unknown",
        text: "本地代理状态未知（旧快照）",
        title: "旧快照没有 proxy.state；不能判断代理是否运行",
        tone: "warn",
        error: null,
      };
  }
}

/**
 * P2-C：技能库状态（来自 `HubSnapshot.skill?`，P2-A 加的可选契约字段）。
 *
 * `null` 表示「快照没带这个字段」——旧快照/旧主进程，UI 必须显示「未知/未检测」，
 * 不能当成「未配置」，也不能阻止创建任务或启动会话。
 */
export interface SkillStatusState {
  configured: boolean;
  root: string | null;
  packages: string[];
  builtAt: number | null;
  /** V2-P0-1：来源；旧快照/旧 mock 缺席时为 null。 */
  source?: SkillStatusSource | null;
  error: string | null;
}

export type SkillStatusSource = "env" | "config" | "dev" | "packaged";

export type SkillStatusKind = "configured" | "unconfigured" | "error" | "unknown";

export interface SkillStatusView {
  kind: SkillStatusKind;
  label: string;
  /** 顶部指示条下方的一行摘要（已配置时含来源 + root + 包数 + 索引时间）。 */
  headline: string;
  /** 点击展开后的明细（来源 / root / packages / 索引时间 / error）。 */
  detail: string;
  title: string;
  root: string | null;
  packages: string[];
  packageCount: number;
  builtAt: number | null;
  builtAtText: string;
  source: SkillStatusSource | null;
  sourceLabel: string;
  error: string | null;
  /** 未配置 / 错误时，创建任务弹窗与任务卡要显示提示；unknown/configured 不显示。 */
  showWarning: boolean;
  warningText: string | null;
}

/** 技能库来源的人话标签；未知来源不臆造成“内置”。 */
export function skillSourceLabel(source: SkillStatusSource | null | undefined): string {
  switch (source) {
    case "env":
      return "外置（BUMIMANG_SKILL_DIR）";
    case "config":
      return "外置（config.skillDir）";
    case "dev":
      return "开发态（仓库同级 skill）";
    case "packaged":
      return "内置（安装包）";
    default:
      return "来源未知";
  }
}

export const SKILL_UNCONFIGURED_WARNING =
  "技能库未配置：agent 将拿不到技能检索，仅能用 playbook 与已有工具";

/**
 * 范围提示文案。`enabled=false` 明确写「仅展示与审计」；`true` 写 action；
 * 旧快照缺席时写「未知」，不撒谎。
 *
 * P6-B 批次 2b：代理行按真实 state 显示五态 + 未知；`proxyText` 是可见文案，
 * `proxyTitle` 是 hover 说明，`proxyTone` 给 UI 选颜色（ok/error/warn/muted）。
 */
export function buildScopeStatusView(
  state: Pick<AppState, "scopeStatus">,
): ScopeStatusView {
  const s = state.scopeStatus;
  if (!s) {
    const proxy = proxyStatusView(null);
    return {
      kind: "unknown",
      badge: "未知",
      headline: "范围状态未知（旧快照未带 scope 字段）",
      title: "旧快照没有 scope 状态；这不影响目标展示与审批，快照更新后会自动显示",
      outOfScopeAction: "approve",
      proxyEnabled: false,
      proxyPort: null,
      proxyState: proxy.state,
      proxyText: proxy.text,
      proxyTitle: proxy.title,
      proxyTone: proxy.tone,
      proxyError: proxy.error,
    };
  }
  const actionText = s.outOfScopeAction === "block" ? "block（拦截）" : "approve（人工审批）";
  const proxy = proxyStatusView(s.proxy);
  const proxyText = proxy.text;
  const proxyPort =
    s.proxy?.state && s.proxy.state !== "running" ? null : (s.proxy?.port ?? null);
  const proxyFields = {
    proxyState: proxy.state,
    proxyText: proxy.text,
    proxyTitle: proxy.title,
    proxyTone: proxy.tone,
    proxyError: proxy.error,
  };
  if (!s.enabled) {
    return {
      kind: "disabled",
      badge: "未启用",
      headline: "范围策略未启用，仅展示与审计",
      title: `scope.enabled=false；判定结果与旧规则一致，目标/范围只展示与审计。${proxyText}；不是 OS 级隔离，agent 自执行命令仅可事后审计。`,
      outOfScopeAction: s.outOfScopeAction,
      proxyEnabled: s.proxy?.enabled === true,
      proxyPort,
      ...proxyFields,
    };
  }
  return {
    kind: "enabled",
    badge: "已启用",
    headline: `范围策略已启用（${actionText}；仅平台可中介的 ACP 动作）`,
    title:
      `scope.enabled=true；范围外/无法判定的目标按 ${actionText} 处理。` +
      `${proxyText}；仅对遵守代理的工具生效，nmap/raw socket/DNS/直连可绕过；` +
      `agent 自己执行、不经过平台的命令仅可事后审计，不能声称已强制隔离。`,
    outOfScopeAction: s.outOfScopeAction,
    proxyEnabled: s.proxy?.enabled === true,
    proxyPort,
    ...proxyFields,
  };
}

/** 索引时间：懒构建前显示「未构建」，不是错误。 */
export function formatSkillBuiltAt(builtAt: number | null): string {
  if (builtAt == null) return "未构建（懒构建）";
  return new Date(builtAt).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 把 store 里的 skillStatus 折叠成可直接渲染的视图。
 *
 * 判定顺序（不能反）：`configured=false` 一律算「未配置」——即使带 error，
 * 那也只是「为什么没配置」；只有 `configured=true` 且 error 有值才是「已配置但索引失败」。
 */
export function buildSkillStatusView(state: Pick<AppState, "skillStatus">): SkillStatusView {
  const s = state.skillStatus;
  if (!s) {
    return {
      kind: "unknown",
      label: "技能库未检测",
      headline: "技能库状态未知（旧快照未带 skill 字段，未检测）",
      detail: "旧快照没有技能库状态；这不影响创建任务与启动会话，快照更新后会自动显示。",
      title: "旧快照没有 skill 字段；按「未知/未检测」处理，不误报为未配置",
      root: null,
      packages: [],
      packageCount: 0,
      builtAt: null,
      builtAtText: "未检测",
      source: null,
      sourceLabel: "来源未知",
      error: null,
      showWarning: false,
      warningText: null,
    };
  }

  const builtAtText = formatSkillBuiltAt(s.builtAt);
  const packagesText = s.packages.length > 0 ? s.packages.join(", ") : "未识别技能包";
  const rootText = s.root ?? "未找到";
  const sourceLabel = skillSourceLabel(s.source);

  if (!s.configured) {
    return {
      kind: "unconfigured",
      label: "技能库未配置",
      headline: "技能库未配置：agent 仅能靠 playbook 与已有工具",
      detail:
        `来源：${sourceLabel}；根目录：${rootText}；包：${packagesText}；索引：${builtAtText}` +
        (s.error ? `；原因：${s.error}` : ""),
      title: "技能库未配置；配置走 config/app.json 或 BUMIMANG_SKILL_DIR。仍可创建任务/启动会话",
      root: s.root,
      packages: s.packages,
      packageCount: s.packages.length,
      builtAt: s.builtAt,
      builtAtText,
      source: s.source ?? null,
      sourceLabel,
      error: s.error,
      showWarning: true,
      warningText: SKILL_UNCONFIGURED_WARNING,
    };
  }

  if (s.error) {
    return {
      kind: "error",
      label: "技能库错误",
      headline: `技能库错误：${s.error}`,
      detail: `来源：${sourceLabel}；根目录：${rootText}；包：${packagesText}；索引：${builtAtText}`,
      title: `技能库已解析但索引/读取报错：${s.error}`,
      root: s.root,
      packages: s.packages,
      packageCount: s.packages.length,
      builtAt: s.builtAt,
      builtAtText,
      source: s.source ?? null,
      sourceLabel,
      error: s.error,
      showWarning: true,
      warningText: `技能库错误：${s.error}；agent 可能拿不到技能检索，仍可用 playbook 与已有工具`,
    };
  }

  return {
    kind: "configured",
    label: "技能库已配置",
    headline: `技能库已配置 · ${sourceLabel} · ${rootText} · ${s.packages.length} 个包 · 索引时间 ${builtAtText}`,
    detail: `来源：${sourceLabel}；根目录：${rootText}；包：${packagesText}；索引：${builtAtText}`,
    title: `技能库：${sourceLabel} · ${rootText}（${packagesText}；索引 ${builtAtText}）`,
    root: s.root,
    packages: s.packages,
    packageCount: s.packages.length,
    builtAt: s.builtAt,
    builtAtText,
    source: s.source ?? null,
    sourceLabel,
    error: null,
    showWarning: false,
    warningText: null,
  };
}

/**
 * P2-C 简报预览（渲染层预置的可选快照字段）。
 *
 * 主进程当前没有在快照里暴露简报（P2-B 的简报只发给 agent），所以这个字段是
 * 渲染层的**可选前向兼容槽位**（与 `policy` 同一做法）：字段缺席时整块不显示，
 * 不编造数据。字段存在时只保留标题 / 路径条数 / tools 可用性 / 证据约定摘要，
 * 不保留 steps 全文。
 */
export interface BriefingPreviewState {
  playbookTitle: string;
  skillRoutingCount: number;
  knowledgeToolsAvailable: boolean;
  evidenceSummary: string | null;
}

export interface BriefingPreviewView {
  title: string;
  playbookTitle: string;
  routingText: string;
  knowledgeToolsText: string;
  evidenceSummary: string | null;
}

interface RawBriefingPreview {
  playbookTitle?: string;
  skillRoutingPaths?: string[];
  skillRoutingCount?: number;
  knowledgeToolsAvailable?: boolean;
  evidenceRule?: string;
}

const EVIDENCE_SUMMARY_MAX = 80;

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 无 task 或快照不带简报字段时返回 null（UI 不显示空壳）。 */
export function buildBriefingPreview(
  state: Pick<AppState, "task" | "briefingPreview">,
): BriefingPreviewView | null {
  if (!state.task || !state.briefingPreview) return null;
  const p = state.briefingPreview;
  return {
    title: "简报预览",
    playbookTitle: p.playbookTitle,
    routingText: `${p.skillRoutingCount} 条路径`,
    knowledgeToolsText: p.knowledgeToolsAvailable ? "可用" : "不可用",
    evidenceSummary: p.evidenceSummary,
  };
}

export interface AppState {
  task: TaskView | null;
  /** 全部任务（含归档）；快照里的 `tasks` 列表，最新在前。 */
  tasks: TaskView[];
  sessions: SessionView[];
  approvals: ApprovalView[];
  /** 跨任务审批（P1-E 全局队列的数据源）；旧快照缺席时回退到 `approvals`。 */
  approvalsAll: ApprovalView[];
  /** 焦点任务附件清单（P3-C）；旧快照/旧 mock 缺席时为 []。 */
  attachments: AttachmentView[];
  /** 焦点任务产物清单（P3-C）；旧快照/旧 mock 缺席时为 []。 */
  artifacts: ArtifactView[];
  /** WP9-A：焦点 AWD 只读视图（category=awd）；旧快照/其他 category 为 null。 */
  awd: AwdView | null;
  /** WP9-A：焦点 IR 只读视图（category=ir）；旧快照/其他 category 为 null。 */
  ir: IrView | null;
  /** 比赛平台连接、题目与 WP 索引状态；旧快照可以缺席。 */
  platform: PlatformStateView | null;
  /**
   * P5-C：焦点任务的 flag 候选（含来源）。
   *
   * 旧快照/旧 mock 不带 `flags` 时保持 []，但 `flagsStatus` 会是 "unknown"，
   * UI 必须显示「未知」而不是「无候选」——两者语义不同。
   */
  flags: FlagCandidateView[];
  /** "known" = 主进程明确给了 flags（[] 就是真的没有候选）；"unknown" = 旧快照。 */
  flagsStatus: "known" | "unknown";
  /**
   * P5-D：记分板（主进程只读聚合，含归档任务）。
   * 旧快照/旧 mock 不带 scoreboard 时为 null，UI 显示「未知」或隐藏。
   */
  scoreboard: ScoreboardView | null;
  /** 全局配额；旧快照缺席时为 null，UI 只隐藏配额条，不报错。 */
  quota: HubSnapshot["quota"] | null;
  /** 技能库状态（P2-C）；旧快照不带 `skill` 时为 null，UI 显示「未知/未检测」。 */
  skillStatus: SkillStatusState | null;
  /** 范围/代理状态（P4-D）；旧快照不带 `scope` 时为 null，UI 显示「范围状态未知」。 */
  scopeStatus: ScopeStatusState | null;
  /** 简报预览（P2-C，可选前向兼容字段）；缺席时为 null，UI 不显示。 */
  briefingPreview: BriefingPreviewState | null;
  /** 一键放行授权（本会话 + 按 agent 永久）。 */
  permissionGrants: PermissionGrantView[];
  facts: FactView[];
  deadEnds: DeadEndView[];
  leases: LeaseView[];
  intents: IntentView[];
  health: Record<string, SessionHealth>;
  agents: AgentDescriptor[];
  /** 当前策略规则包（契约尚未暴露，字段缺席时为 null）。 */
  policy: PolicyPackInfo | null;
  /** agent 唯一可写根目录（R16）；字段缺席时为 null。 */
  workDir: string | null;
  /**
   * 内部元数据（不参与渲染）：所有见过的会话归属与状态。
   *
   * 后台没有 `sessions` 列表，但收到后台 `session.upsert` 时要判断
   * running 是否变化、`session.removed` 要判断 total/running 各减多少，
   * 所以保留这一份轻量索引；它不创建任何 DOM / 对话块。
   */
  sessionMeta: Record<string, SessionMeta>;
}

export function emptyState(): AppState {
  return {
    task: null,
    tasks: [],
    sessions: [],
    approvals: [],
    approvalsAll: [],
    attachments: [],
    artifacts: [],
    awd: null,
    ir: null,
    platform: null,
    flags: [],
    flagsStatus: "unknown",
    scoreboard: null,
    quota: null,
    skillStatus: null,
    scopeStatus: null,
    briefingPreview: null,
    permissionGrants: [],
    facts: [],
    deadEnds: [],
    leases: [],
    intents: [],
    health: {},
    agents: [],
    policy: null,
    workDir: null,
    sessionMeta: {},
  };
}

const TERMINAL_STATUS: ReadonlySet<string> = new Set(["blocked", "stopped", "failed", "done"]);

export function isActiveSessionStatus(status: SessionStatus): boolean {
  return !TERMINAL_STATUS.has(status);
}

function buildSessionMeta(
  tasks: TaskView[],
  sessions: SessionView[],
  prev?: AppState,
): Record<string, SessionMeta> {
  const taskIds = new Set(tasks.map((t) => t.id));
  const meta: Record<string, SessionMeta> = {};
  if (prev) {
    for (const [id, m] of Object.entries(prev.sessionMeta)) {
      if (taskIds.has(m.taskId)) meta[id] = { ...m };
    }
  }
  for (const s of sessions) meta[s.id] = { taskId: s.taskId, status: s.status };
  return meta;
}

export function applySnapshot(snap: HubSnapshot, prev?: AppState): AppState {
  const policy = (snap as HubSnapshot & { policy?: PolicyPackInfo | null }).policy ?? null;
  const tasks = (snap.tasks ?? []).map((t) => ({ ...t }));
  const sessions = snap.sessions.slice();
  const approvalsAll = (snap.approvalsAll ?? snap.approvals).map((a) => ({ ...a }));
  // P3-C：附件/产物都是可选字段；旧快照没有时保持空数组，不臆造。
  const attachments = (snap.attachments ?? snap.task?.attachments ?? []).map((a) => ({ ...a }));
  const artifacts = (snap.artifacts ?? []).map((a) => ({ ...a }));
  // P5-C：flags 是可选字段；缺席 = 旧快照/旧主进程（unknown），不能当成“无候选”。
  const hasFlags = Array.isArray(snap.flags);
  const flags: FlagCandidateView[] = hasFlags
    ? (snap.flags ?? []).map((f) => ({
        ...f,
        sources: Array.isArray(f.sources) ? f.sources.map((s) => ({ ...s })) : [],
      }))
    : [];
  const flagsStatus: "known" | "unknown" = hasFlags ? "known" : "unknown";
  // P5-D：scoreboard 是可选字段；缺席 = 旧快照（null），UI 显示未知/隐藏。
  const scoreboard: ScoreboardView | null = snap.scoreboard
    ? {
        ...snap.scoreboard,
        tasks: snap.scoreboard.tasks.map((t) => ({ ...t })),
      }
    : null;
  // P2-A 的可选字段：旧快照不带 skill 时保持 null（未知/未检测），不臆造。
  const rawSkill = snap.skill;
  const skillStatus: SkillStatusState | null = rawSkill
    ? {
        configured: rawSkill.configured === true,
        root: rawSkill.root ?? null,
        packages: Array.isArray(rawSkill.packages) ? rawSkill.packages.slice() : [],
        builtAt: typeof rawSkill.builtAt === "number" ? rawSkill.builtAt : null,
        source:
          rawSkill.source === "env" ||
          rawSkill.source === "config" ||
          rawSkill.source === "dev" ||
          rawSkill.source === "packaged"
            ? rawSkill.source
            : null,
        error: typeof rawSkill.error === "string" ? rawSkill.error : null,
      }
    : null;
  // P4-D：可选 scope 状态；旧快照缺席时保持 null（未知），不臆造。
  // P6-B 批次 2b：代理 state/error 是可选字段；旧快照没有 state 时退回旧语义。
  const rawScope = snap.scope;
  const scopeStatus: ScopeStatusState | null = rawScope
    ? {
        enabled: rawScope.enabled === true,
        outOfScopeAction: rawScope.outOfScopeAction === "block" ? "block" : "approve",
        proxy: normalizeScopeProxyState(rawScope.proxy),
      }
    : null;
  // P2-C 的渲染层前向兼容槽位：主进程尚未提供，缺席时 UI 不显示。
  const rawPreview = (snap as HubSnapshot & { briefingPreview?: RawBriefingPreview }).briefingPreview;
  const briefingPreview: BriefingPreviewState | null = rawPreview
    ? {
        playbookTitle:
          typeof rawPreview.playbookTitle === "string" && rawPreview.playbookTitle.trim()
            ? rawPreview.playbookTitle
            : "未命名检查表",
        skillRoutingCount:
          Array.isArray(rawPreview.skillRoutingPaths)
            ? rawPreview.skillRoutingPaths.length
            : typeof rawPreview.skillRoutingCount === "number"
              ? rawPreview.skillRoutingCount
              : 0,
        knowledgeToolsAvailable: rawPreview.knowledgeToolsAvailable === true,
        evidenceSummary:
          typeof rawPreview.evidenceRule === "string" && rawPreview.evidenceRule.trim()
            ? truncateText(rawPreview.evidenceRule, EVIDENCE_SUMMARY_MAX)
            : null,
      }
    : null;
  return {
    task: snap.task ?? null,
    tasks,
    sessions,
    approvals: snap.approvals.slice(),
    approvalsAll,
    attachments,
    artifacts,
    awd: snap.awd ?? null,
    ir: snap.ir ?? null,
    platform: snap.platform ?? null,
    flags,
    flagsStatus,
    scoreboard,
    quota: snap.quota ?? null,
    skillStatus,
    scopeStatus,
    briefingPreview,
    permissionGrants: (snap.permissionGrants ?? []).map((g) => ({ ...g })),
    facts: snap.board.facts.slice(),
    deadEnds: snap.board.deadEnds.slice(),
    leases: snap.board.leases.slice(),
    intents: snap.board.intents.slice(),
    health: { ...snap.health },
    agents: snap.agents.map((a) => ({ ...a })),
    policy,
    workDir: snap.workDir ?? null,
    sessionMeta: buildSessionMeta(tasks, sessions, prev),
  };
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

/** 只改 `tasks` 里对应任务的计数；任务不存在或 delta 为 0 时原样返回。 */
function adjustTaskCounts(
  tasks: TaskView[],
  taskId: string | null,
  runningDelta: number,
  totalDelta: number,
): TaskView[] {
  if (!taskId || (runningDelta === 0 && totalDelta === 0)) return tasks;
  let found = false;
  const next = tasks.map((t) => {
    if (t.id !== taskId) return t;
    found = true;
    return {
      ...t,
      runningSessions: Math.max(0, (t.runningSessions ?? 0) + runningDelta),
      totalSessions: Math.max(0, (t.totalSessions ?? 0) + totalDelta),
    };
  });
  return found ? next : tasks;
}

/** 焦点为空时的干净状态：会话/审批/黑板/健康/授权全部清掉，任务列表保留。 */
function clearFocus(state: AppState): AppState {
  return {
    ...state,
    task: null,
    sessions: [],
    approvals: [],
    attachments: [],
    artifacts: [],
    awd: null,
    ir: null,
    flags: [],
    flagsStatus: "unknown",
    permissionGrants: [],
    facts: [],
    deadEnds: [],
    leases: [],
    intents: [],
    health: {},
  };
}

/**
 * P5-D：把单个 task.upsert 折进 scoreboard（solved/points 重算）。
 * 没有 scoreboard（旧快照）时保持 null；新任务会追加到列表。
 */
function scoreboardWithTask(sb: ScoreboardView | null, task: TaskView): ScoreboardView | null {
  if (!sb) return null;
  const existing = sb.tasks.find((t) => t.taskId === task.id);
  const row = {
    taskId: task.id,
    title: task.title,
    status: task.status,
    points: typeof task.points === "number" ? task.points : existing?.points ?? 0,
    flagCount:
      typeof task.flagCount === "number" ? task.flagCount : existing?.flagCount ?? 0,
  };
  const tasks = existing
    ? sb.tasks.map((t) => (t.taskId === task.id ? row : t))
    : [...sb.tasks, row];
  return {
    ...sb,
    tasks,
    solved: tasks.filter((t) => t.status === "solved").length,
    total: tasks.length,
    points: tasks.reduce((sum, t) => sum + t.points, 0),
  };
}

/** P5-D：flag.updated 只改该任务的候选数量（不影响 solved/points）。 */
function scoreboardWithFlagCount(
  sb: ScoreboardView | null,
  taskId: string,
  flagCount: number,
): ScoreboardView | null {
  if (!sb) return null;
  return {
    ...sb,
    tasks: sb.tasks.map((t) => (t.taskId === taskId ? { ...t, flagCount } : t)),
  };
}

export interface ScoreboardTaskRow {
  taskId: string;
  title: string;
  status: ScoreboardView["tasks"][number]["status"];
  points: number;
  flagCount: number;
  archived: boolean;
  isFocus: boolean;
}

export interface ScoreboardViewState {
  kind: "unknown" | "ready";
  solved: number;
  total: number;
  points: number;
  tasks: ScoreboardTaskRow[];
  summaryText: string;
  unknownText: string | null;
}

/**
 * P5-D：记分板纯视图模型。
 *
 * - `scoreboard` 为 null（旧快照）→ unknown，不臆造 0；
 * - 归档任务保留（与批次 1 语义一致），UI 用 archived 灰显；
 * - 焦点任务用 isFocus 标记。
 */
export function buildScoreboardView(
  state: Pick<AppState, "task" | "tasks" | "scoreboard">,
): ScoreboardViewState {
  const sb = state.scoreboard;
  if (!sb) {
    return {
      kind: "unknown",
      solved: 0,
      total: 0,
      points: 0,
      tasks: [],
      summaryText: "记分板未知",
      unknownText: "记分板未知（旧快照未带 scoreboard 字段）",
    };
  }
  const focusId = state.task?.id ?? null;
  const taskById = new Map((state.tasks ?? []).map((t) => [t.id, t]));
  const tasks: ScoreboardTaskRow[] = sb.tasks.map((t) => ({
    ...t,
    archived: taskById.get(t.taskId)?.archived === true,
    isFocus: t.taskId === focusId,
  }));
  return {
    kind: "ready",
    solved: sb.solved,
    total: sb.total,
    points: sb.points,
    tasks,
    summaryText: `已解 ${sb.solved}/${sb.total} · ${sb.points} 分`,
    unknownText: null,
  };
}

export function applyEvent(state: AppState, e: HubEvent): AppState {
  switch (e.type) {
    case "task.upsert": {
      const tasks = upsertById(state.tasks, e.task);
      const scoreboard = scoreboardWithTask(state.scoreboard, e.task);
      if (e.task.archived) {
        // 归档非焦点任务：只更新看板，不抢焦点。
        if (state.task?.id !== e.task.id) return { ...state, tasks, scoreboard };
        // 归档焦点任务：立即清空焦点视图；后续 focus 事件/快照再填新焦点。
        return { ...clearFocus(state), tasks, scoreboard };
      }
      if (state.task?.id === e.task.id) {
        return {
          ...state,
          task: e.task,
          tasks,
          scoreboard,
          // 焦点任务的 task.upsert 会带完整附件清单；旧后端不带时保留快照里的清单。
          attachments: e.task.attachments ?? state.attachments,
        };
      }
      // 切焦点：先用空焦点替换，避免旧任务 sessions 在新 task 下短暂串台。
      return {
        ...clearFocus(state),
        task: e.task,
        tasks,
        scoreboard,
        attachments: e.task.attachments ?? [],
      };
    }
    case "session.upsert": {
      const s = e.session;
      const old = state.sessions.find((x) => x.id === s.id);
      const meta = state.sessionMeta[s.id];
      const prevStatus = meta?.status ?? old?.status;
      const isNew = prevStatus === undefined;
      const nowActive = isActiveSessionStatus(s.status);

      let tasks = state.tasks;
      let runningDelta = 0;
      let totalDelta = 0;
      if (meta && meta.taskId !== s.taskId) {
        // 归属变化（理论上不应发生）：从旧任务扣、给新任务加。
        tasks = adjustTaskCounts(tasks, meta.taskId, isActiveSessionStatus(meta.status) ? -1 : 0, -1);
        tasks = adjustTaskCounts(tasks, s.taskId, nowActive ? 1 : 0, 1);
      } else if (isNew) {
        // 新会话先发 starting；终态首事件通常意味着快照已计过，不再重复加 total。
        if (nowActive || s.status === "starting") {
          totalDelta = 1;
          runningDelta = nowActive ? 1 : 0;
        }
      } else {
        const wasActive = isActiveSessionStatus(prevStatus);
        if (wasActive !== nowActive) runningDelta = nowActive ? 1 : -1;
      }
      tasks = adjustTaskCounts(tasks, s.taskId, runningDelta, totalDelta);

      const sessions =
        state.task?.id === s.taskId ? upsertById(state.sessions, s) : state.sessions;
      return {
        ...state,
        tasks,
        sessions,
        sessionMeta: { ...state.sessionMeta, [s.id]: { taskId: s.taskId, status: s.status } },
      };
    }
    case "session.removed": {
      const old = state.sessions.find((x) => x.id === e.sessionId);
      const meta = state.sessionMeta[e.sessionId];
      const taskId = e.taskId ?? meta?.taskId ?? old?.taskId ?? null;
      if (!taskId) return state;
      const existed = Boolean(meta ?? old);
      const wasActive = meta ? isActiveSessionStatus(meta.status) : old ? isActiveSessionStatus(old.status) : false;
      const tasks = adjustTaskCounts(
        state.tasks,
        taskId,
        existed && wasActive ? -1 : 0,
        existed ? -1 : 0,
      );
      const sameFocus = state.task?.id === taskId;
      const sessions = sameFocus
        ? state.sessions.filter((s) => s.id !== e.sessionId)
        : state.sessions;
      const health = { ...state.health };
      if (sameFocus) delete health[e.sessionId];
      const sessionMeta = { ...state.sessionMeta };
      delete sessionMeta[e.sessionId];
      return { ...state, tasks, sessions, health, sessionMeta };
    }
    case "approval.upsert": {
      const approvalsAll = upsertById(state.approvalsAll, e.approval);
      const focusId = state.task?.id ?? null;
      const approvals =
        focusId && e.approval.taskId === focusId
          ? upsertById(state.approvals, e.approval)
          : state.approvals;
      return { ...state, approvalsAll, approvals };
    }
    case "permission.updated":
      return { ...state, permissionGrants: e.grants.map((g) => ({ ...g })) };
    case "health": {
      // 焦点唯一：后台健康度只可能在快照里被丢弃，不进焦点 store。
      const focusId = state.task?.id ?? null;
      if (!focusId) return state;
      if (e.taskId ? e.taskId !== focusId : !state.sessions.some((s) => s.id === e.sessionId)) {
        return state;
      }
      return { ...state, health: { ...state.health, [e.sessionId]: e.health } };
    }
    case "mcp.unavailable": {
      // P7-B：只标记会话，不改 status；后台任务事件不进焦点 store。
      const focusId = state.task?.id ?? null;
      if (!focusId) return state;
      if (e.taskId ? e.taskId !== focusId : !state.sessions.some((s) => s.id === e.sessionId)) {
        return state;
      }
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === e.sessionId ? { ...s, mcpUnavailable: true } : s,
        ),
      };
    }
    case "session.stream": {
      // 流式事件不落 store：由 panes/model.ts 的 SessionStreamSink 节流聚合后直接进 DOM。
      const focusId = state.task?.id ?? null;
      if (!focusId) return state;
      if (e.taskId ? e.taskId !== focusId : !state.sessions.some((s) => s.id === e.sessionId)) {
        return state;
      }
      return state;
    }
    case "board.appended": {
      // 台账的增量刷新走「重新拉快照」；后台任务的事件不触发焦点 UI。
      const focusId = state.task?.id ?? null;
      if (!focusId) return state;
      if (e.taskId && e.taskId !== focusId) return state;
      return state;
    }
    case "artifact.updated": {
      // P3-C：工件刷新只更新焦点任务；后台任务的事件直接丢弃（P1-E 规则）。
      const focusId = state.task?.id ?? null;
      if (!focusId || e.taskId !== focusId) return state;
      return { ...state, artifacts: e.artifacts.map((a) => ({ ...a })) };
    }
    case "flag.updated": {
      // P5-C：确认/误报后的候选列表。只接受焦点任务；后台事件丢弃（P1-E 规则）。
      const focusId = state.task?.id ?? null;
      if (!focusId || e.taskId !== focusId) return state;
      const flags = Array.isArray(e.flags)
        ? e.flags.map((f) => ({
            ...f,
            sources: Array.isArray(f.sources) ? f.sources.map((s) => ({ ...s })) : [],
          }))
        : [];
      const count = flags.length;
      return {
        ...state,
        flags,
        flagsStatus: "known",
        scoreboard: scoreboardWithFlagCount(state.scoreboard, e.taskId, count),
        task: state.task && state.task.id === e.taskId ? { ...state.task, flagCount: count } : state.task,
        tasks: state.tasks.map((t) => (t.id === e.taskId ? { ...t, flagCount: count } : t)),
      };
    }
    case "proxy.state.changed": {
      // P6-B 批次 2b：只更新范围/代理展示，不影响会话/审批/黑板。
      // 旧快照没有 scope 时丢弃事件，不凭空造一个“范围状态”。
      if (!state.scopeStatus) return state;
      const proxy = normalizeScopeProxyState(e.proxy);
      if (!proxy) return state;
      return {
        ...state,
        scopeStatus: { ...state.scopeStatus, proxy },
      };
    }
    case "platform.updated":
      return { ...state, platform: e.platform };
    default: {
      const _exhaustive: never = e;
      return state;
    }
  }
}

export type Listener = () => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private workspaceListeners = new Set<Listener>();
  private competitionListeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  get(): AppState {
    return this.state;
  }

  set(next: AppState): void {
    this.state = next;
    this.emit();
  }

  update(fn: (s: AppState) => AppState): void {
    this.state = fn(this.state);
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 只在该视图可见时通知。比赛面板和 Agent 控制台各有大量 DOM；
   * 隐藏视图继续重建 DOM 是低延迟界面的主要浪费。
   */
  subscribeWorkspace(fn: Listener): () => void {
    this.workspaceListeners.add(fn);
    return () => {
      this.workspaceListeners.delete(fn);
    };
  }

  subscribeCompetition(fn: Listener): () => void {
    this.competitionListeners.add(fn);
    return () => {
      this.competitionListeners.delete(fn);
    };
  }

  /** 视图切换后强制跑一次当前视图的订阅者。 */
  notify(): void {
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
    if (typeof document === "undefined") {
      for (const l of this.competitionListeners) l();
      for (const l of this.workspaceListeners) l();
      return;
    }
    const view = document.getElementById("app")?.dataset.view;
    const selected = view === "workspace"
      ? this.workspaceListeners
      : view === "competition"
        ? this.competitionListeners
        : null;
    if (selected) {
      for (const l of selected) l();
    } else {
      for (const l of this.competitionListeners) l();
      for (const l of this.workspaceListeners) l();
    }
  }
}
