/**
 * 事件总线 + Hub 服务 —— 架构文档 T2。
 *
 * 职责边界：
 *  - 把核心（黑板 / 会话 / 审批）的状态变化**翻译成契约里的事件**推给渲染进程
 *  - 把渲染进程发来的 HubAction **翻译成核心调用**
 *
 * 它自己不含业务逻辑：不判定策略、不写库、不管进程。那些分别属于 policy / blackboard / session。
 */

import type {
  ActionResult,
  AnswerSpec,
  AnswerType,
  ApprovalView,
  ArtifactPreview,
  ArtifactView,
  AttachmentView,
  BoardEventView,
  DeadEndView,
  FactView,
  FlagCandidateView,
  FlagSourceView,
  HubAction,
  HubEvent,
  HubSnapshot,
  IntentView,
  LeaseView,
  PlatformSceneProbeView,
  PlatformSubmissionResultView,
  PlatformTargetView,
  Role,
  ProxyState,
  ScopeProxyView,
  SessionHealth,
  SessionStatus,
  SessionView,
  StreamUpdate,
  TaskCategory,
  TargetView,
  AwdView,
  IrView,
  TaskView,
  Tier,
} from "../../../../../packages/shared-protocol/events.ts";
import type { Blackboard, FlagCandidate, FlagSource } from "../blackboard/board.ts";
import { parseAwdFacts, parseIrFacts } from "../awdir/model.ts";
import { exportAwd, exportIr } from "../awdir/export.ts";
import type { SessionManager, SessionRecord } from "../session/manager.ts";
import { detectAgents, installedAgents } from "../discovery/detect.ts";
import type { AgentSpec } from "../acp/client.ts";
import { isInsideDir } from "../acp/client.ts";
import type { ApprovalQueue } from "../approval/queue.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { PermissionStore } from "../permission/store.ts";
import type { OperationCategory, OperationProfile } from "../permission/profile.ts";
import { importAttachments, readAttachments } from "../artifacts/import.ts";
import { listArtifacts } from "../artifacts/list.ts";
import { previewAttachment } from "../artifacts/preview.ts";
import {
  DEFAULT_ANSWER_SPEC,
  answerSpecId,
  canonicalAnswer,
  detectAnswers,
  parseAnswerSpec,
  scanAttachmentAnswers,
  validateAnswerSpec,
} from "../answer/index.ts";
import {
  buildStrategyPlan,
  type StrategyBudget,
  type StrategyInput,
  type StrategyMode,
  type StrategyPlan,
  type StrategyRecommendation,
  type StrategySessionInput,
} from "../strategy/index.ts";
import {
  DEFAULT_IR_LIMITS,
  collectIrInputs,
  createDefaultIrRegistry,
  mapQuestionCandidates,
  parseIrQuestions,
  resolveTool,
  runCommandSafe,
  runIrAnalysis,
  type IrContext,
  type IrQuestion,
} from "../ir/index.ts";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { normalizeUpdate } from "../stream/normalize.ts";
import type { PlatformService } from "../platform/service.ts";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";

export { normalizeUpdate };

// ---------------------------------------------------------------- 事件总线

type Subscriber = (e: HubEvent) => void;

export class EventBus {
  private subs = new Set<Subscriber>();

  on(cb: Subscriber): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  emit(e: HubEvent): void {
    for (const s of [...this.subs]) {
      try {
        s(e);
      } catch {
        /* 单个订阅者出错不能影响其他订阅者 */
      }
    }
  }
}

/** P6-B 批次 2a：只接受契约里的四个真实状态；其他值按“未知”处理。 */
function normalizeProxyState(value: unknown): ProxyState | undefined {
  return value === "starting" || value === "running" || value === "failed" || value === "stopped"
    ? value
    : undefined;
}

/**
 * P6-B 批次 2a：归一化代理视图。
 *
 * - `enabled` 原样保留（config 用户意图）；
 * - `port` 只在 `state=running` 时保留；failed/stopped/starting 强制 null；
 * - 旧快照没有 state 时沿用旧语义（port 原样保留），不臆造 state；
 * - `error` 只在非空字符串时保留。
 */
function normalizeScopeProxyView(
  proxy:
    | { enabled?: boolean; port?: number | null; state?: unknown; error?: unknown }
    | undefined,
): ScopeProxyView {
  const state = normalizeProxyState(proxy?.state);
  const rawPort = typeof proxy?.port === "number" ? proxy.port : null;
  const port = state && state !== "running" ? null : rawPort;
  const error = typeof proxy?.error === "string" && proxy.error ? proxy.error : undefined;
  return {
    enabled: proxy?.enabled === true,
    port,
    ...(state ? { state } : {}),
    ...(error ? { error } : {}),
  };
}

const SCENE_PROBE_TIMEOUT_MS = 4_500;

function probeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, " ").trim().slice(0, 180) || "probe failed";
}

async function probePlatformTarget(
  challengeId: string,
  target: PlatformTargetView,
): Promise<PlatformSceneProbeView> {
  const started = Date.now();
  const base = {
    challengeId,
    url: target.url,
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    checkedAt: started,
  };
  if (target.protocol === "http" || target.protocol === "https") {
    let parsed: URL;
    try {
      parsed = new URL(
        /^https?:\/\//i.test(target.url)
          ? target.url
          : `${target.protocol}://${target.host}:${target.port}`,
      );
    } catch (err) {
      return {
        ...base,
        reachable: false,
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - started,
        error: probeErrorText(err),
      };
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (
        reachable: boolean,
        statusCode: number | null,
        error: string | null,
      ): void => {
        if (settled) return;
        settled = true;
        resolve({
          ...base,
          reachable,
          // A root page may legitimately be 401/403/404. Only 5xx means the
          // challenge service itself is unhealthy; transport errors are down.
          ok: reachable && statusCode != null && statusCode < 500,
          statusCode,
          latencyMs: Date.now() - started,
          error,
        });
      };
      const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        parsed,
        {
          method: "GET",
          rejectUnauthorized: false,
          headers: {
            "User-Agent": "Bumimang-Scene-Probe/1.0",
            Accept: "*/*",
          },
        },
        (res) => {
          res.resume();
          finish(true, res.statusCode ?? null, null);
        },
      );
      req.setTimeout(SCENE_PROBE_TIMEOUT_MS, () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", (err) => finish(false, null, probeErrorText(err)));
      req.end();
    });
  }

  return new Promise((resolve) => {
    const socket = netConnect({ host: target.host, port: target.port });
    let settled = false;
    const finish = (reachable: boolean, error: string | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ...base,
        reachable,
        ok: reachable,
        statusCode: null,
        latencyMs: Date.now() - started,
        error,
      });
    };
    socket.setTimeout(SCENE_PROBE_TIMEOUT_MS, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, null));
    socket.once("error", (err) => finish(false, probeErrorText(err)));
  });
}

// ---------------------------------------------------------------- 视图映射

function toTaskView(
  row:
    | {
        id: string;
        title: string;
        brief: string;
        status: string;
        answer?: string | null;
        solved_by?: string | null;
        created_at?: number;
        category?: string;
        priority?: number;
        archived?: number;
        updated_at?: number;
        points?: number;
        submit_mode?: string;
        answer_spec?: string | null;
        allowed_actions?: string | null;
      }
    | undefined,
  flagCandidate: string | null = null,
): TaskView | null {
  if (!row) return null;
  const parsedSpec = row.answer_spec ? parseAnswerSpec(row.answer_spec) : null;
  let allowedActions: string[] | undefined;
  if (row.allowed_actions) {
    try {
      const parsed = JSON.parse(row.allowed_actions) as unknown;
      if (Array.isArray(parsed)) {
        allowedActions = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      allowedActions = undefined;
    }
  }
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    status: row.status as TaskView["status"],
    answer: row.answer ?? null,
    solvedBy: row.solved_by ?? null,
    createdAt: row.created_at ?? 0,
    category: (row.category as TaskCategory) ?? "unknown",
    priority: row.priority ?? 0,
    updatedAt: row.updated_at ?? row.created_at ?? 0,
    archived: Boolean(row.archived),
    points: row.points ?? 0,
    ...(row.submit_mode === "manual" ? { submitMode: "manual" as const } : {}),
    ...(parsedSpec ? { answerSpec: parsedSpec.spec } : {}),
    ...(allowedActions && allowedActions.length > 0 ? { allowedActions } : {}),
    flagCandidate,
  };
}

/** P4-A：黑板目标行 → 契约 TargetView（只做字段映射，不做解析/判定）。 */
function toTargetView(row: {
  id: string;
  task_id: string;
  value: string;
  kind: string;
  status: string;
  notes: string | null;
  created_at: number;
}): TargetView {
  return {
    id: row.id,
    taskId: row.task_id,
    value: row.value,
    kind: row.kind as TargetView["kind"],
    status: row.status as TargetView["status"],
    notes: row.notes ?? null,
    createdAt: row.created_at,
  };
}

/** P5-A：flag 来源行 → 契约视图（只映射，不做确认/提交）。 */
function toFlagSourceView(row: FlagSource): FlagSourceView {
  return {
    sessionId: row.session_id ?? null,
    witness: row.witness ?? null,
    evidence: row.evidence as FlagSourceView["evidence"],
    seenAt: row.seen_at,
    ...(row.line !== null && row.line !== undefined ? { line: row.line } : {}),
    ...(row.byte_offset !== null && row.byte_offset !== undefined ? { offset: row.byte_offset } : {}),
    ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
  };
}

/** P5-A：flag 候选行 + 来源 → 契约视图。 */
function toFlagCandidateView(row: FlagCandidate, sources: FlagSource[]): FlagCandidateView {
  return {
    id: row.id,
    taskId: row.task_id,
    value: row.value,
    status: row.status as FlagCandidateView["status"],
    evidence: row.evidence as FlagCandidateView["evidence"],
    firstSeen: row.first_seen,
    sources: sources.map(toFlagSourceView),
    submittedAt: row.submitted_at ?? null,
    submitStatus: (row.submit_status as FlagCandidateView["submitStatus"]) ?? null,
    ...(row.answer_type ? { answerType: row.answer_type as FlagCandidateView["answerType"] } : {}),
    ...(row.normalized_value ? { normalizedValue: row.normalized_value } : {}),
    ...(row.spec_id ? { specId: row.spec_id } : {}),
  };
}

// ---------------------------------------------------------------- flag 导出（P5-C）

export type FlagExportFormat = "md" | "csv" | "json";

interface FlagExportTask {
  taskId: string;
  title: string;
  status: string;
  candidates: FlagCandidateView[];
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** Markdown 表格单元：转义 `|`，把换行压成空格（不渲染 HTML）。 */
function mdText(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** CSV 单元：含逗号/引号/换行时加引号，内部引号翻倍。 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sourceText(c: FlagCandidateView): string {
  return c.sources
    .map((s) => `${s.sessionId ?? "system"}@${s.witness ?? "-"}(${s.evidence})`)
    .join("; ");
}

function exportFlagsMarkdown(tasks: FlagExportTask[], now: number, count: number): string {
  const lines: string[] = [
    "# Flag 导出",
    "",
    `导出时间：${isoTime(now)}`,
    `任务数：${tasks.length}`,
    `候选数：${count}`,
    "",
  ];
  for (const t of tasks) {
    lines.push(`## 任务：${mdText(t.title)}（${t.taskId}）`);
    lines.push(`任务状态：${t.status}；候选数：${t.candidates.length}`, "");
    if (t.candidates.length === 0) {
      lines.push("（无候选）", "");
      continue;
    }
    lines.push("| flag | 状态 | 证据 | 来源数 | 首次发现 | 已提交 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const c of t.candidates) {
      lines.push(
        `| ${mdText(c.value)} | ${c.status} | ${c.evidence} | ${c.sources.length} | ` +
          `${isoTime(c.firstSeen)} | ${
            c.submittedAt
              ? `${isoTime(c.submittedAt)}${c.submitStatus ? ` / ${c.submitStatus}` : ""}`
              : "否"
          } |`,
      );
    }
    lines.push("", "来源：");
    for (const c of t.candidates) {
      if (c.sources.length === 0) {
        lines.push(`- ${mdText(c.value)}：无来源`);
        continue;
      }
      for (const s of c.sources) {
        lines.push(
          `- ${mdText(c.value)}：${s.sessionId ?? "system"} / ${s.witness ?? "无 witness"} / ` +
            `${s.evidence} / ${isoTime(s.seenAt)}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function exportFlagsCsv(tasks: FlagExportTask[]): string {
  const rows: string[] = [
    "taskId,taskTitle,taskStatus,flag,status,evidence,sources,firstSeen,submittedAt",
  ];
  for (const t of tasks) {
    for (const c of t.candidates) {
      rows.push(
        [
          t.taskId,
          t.title,
          t.status,
          c.value,
          c.status,
          c.evidence,
          sourceText(c),
          isoTime(c.firstSeen),
          c.submittedAt
            ? `${isoTime(c.submittedAt)}${c.submitStatus ? ` ${c.submitStatus}` : ""}`
            : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return rows.join("\n");
}

function exportFlagsJson(tasks: FlagExportTask[], now: number, count: number): string {
  return JSON.stringify(
    {
      format: "json",
      exportedAt: now,
      taskCount: tasks.length,
      candidateCount: count,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        candidates: t.candidates.map((c) => ({
          id: c.id,
          value: c.value,
          status: c.status,
          evidence: c.evidence,
          answerType: c.answerType ?? null,
          normalizedValue: c.normalizedValue ?? null,
          specId: c.specId ?? null,
          firstSeen: c.firstSeen,
          submittedAt: c.submittedAt ?? null,
          submitStatus: c.submitStatus ?? null,
          sources: c.sources.map((s) => ({
            sessionId: s.sessionId,
            witness: s.witness,
            evidence: s.evidence,
            seenAt: s.seenAt,
            line: s.line ?? null,
            offset: s.offset ?? null,
            sourceKind: s.sourceKind ?? null,
            sourcePath: s.sourcePath ?? null,
          })),
        })),
      })),
    },
    null,
    2,
  );
}

/**
 * P5-D：dry-run 的 argv 预览（只构造字符串数组，不启动进程）。
 *
 * `tasks.submit_command` 是 P5-A 加的列：支持 JSON argv 数组或简单空白分隔；
 * `{flag}` / `{value}` / `{taskId}` 会被替换。未配置时返回 `[flag 值]`。
 */
function buildSubmitArgv(row: { id: string; submit_command?: string | null }, value: string): string[] {
  const template = (row.submit_command ?? "").trim();
  const replace = (s: string): string =>
    s.replaceAll("{flag}", value).replaceAll("{value}", value).replaceAll("{taskId}", row.id);
  if (!template) return [value];
  if (template.startsWith("[")) {
    try {
      const parsed = JSON.parse(template) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => replace(String(x)));
    } catch {
      /* 回落到空白分隔 */
    }
  }
  return template.split(/\s+/).filter(Boolean).map(replace);
}

function toSessionView(r: SessionRecord): SessionView {  return {
    id: r.id,
    taskId: r.taskId,
    agent: r.agent,
    role: r.role as Role,
    tier: r.tier as Tier,
    status: r.status as SessionStatus,
    acpSession: r.acpSession,
    pid: r.pid ?? null,
    model: r.model,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    mcpUnavailable: r.mcpUnavailable === true ? true : undefined,
  };
}

function toBoardEvent(row: { id: number; ts: number; session_id: string | null; kind: string; body: string }): BoardEventView {
  let body: unknown = row.body;
  try {
    body = JSON.parse(row.body);
  } catch {
    /* 保持原样 */
  }
  return { id: row.id, ts: row.ts, by: row.session_id, kind: row.kind as BoardEventView["kind"], body };
}

// ---------------------------------------------------------------- Hub 服务

export interface HubDeps {
  board: Blackboard;
  sessions: SessionManager;
  bus: EventBus;
  workspaceRoot: string;
  /** 默认模型覆盖：agentId -> model */
  models?: Record<string, string>;
  /** 审批队列（T4）。没有它就退化成"永不放行"，所以生产路径必须传 */
  approvals?: ApprovalQueue;
  /** 策略引擎，用于规则学习（§9.5「这次放行，以后同类自动放行」） */
  policy?: PolicyEngine;
  /** 一键放行授权（本会话 + 按 agent 永久） */
  permissions?: PermissionStore;
  /** agent 唯一可写根目录（R16）；只在快照里展示给 UI，不参与判定 */
  workDir?: string;
  /**
   * R24 收敛宽限期（ms）：首个带证据的 flag 候选出现后，其余仍在跑的会话先收到
   * 提示、宽限期满后被停止。<=0 = 关闭（默认关闭；生产由 main.ts 按环境变量开）。
   */
  convergeGraceMs?: number;
  /** 测试/嵌入用：覆盖 agent 启动 spec 解析（默认读本机检测结果） */
  specFor?: (agentId: string) => AgentSpec | null;
  /** 每任务/全局活跃会话上限（P1-C 起在 session.start 前执行；默认 3/8）。 */
  maxSessionsPerTask?: number;
  maxSessionsTotal?: number;
  /**
   * V2-P0-3：战略预算覆盖（比赛剩余时间、单题预算、人工审批预算等）。
   * 生产由 main.ts 从 config/env 计算；测试可直接传入。
   */
  strategyBudget?: Partial<StrategyBudget>;
  /** 技能/引擎池；缺省用本机已安装 agent。 */
  strategyAgents?: string[];
  /** V2.1：IR 工具解析（config > env > PATH）；缺省只用 env/PATH。 */
  irToolResolver?: (envVar: string, defaultName: string) => string | null;
  /**
   * P4-D：范围/代理状态，只用于快照展示。
   *
   * P6-B 批次 2a：`proxy.state/error` 来自代理实例真实状态；`proxy.enabled`
   * 仍是 config 用户意图。旧调用方只传 `{enabled, port}` 时行为不变。
   */
  scope?: {
    enabled: boolean;
    outOfScopeAction: "block" | "approve";
    proxy?: {
      enabled: boolean;
      port?: number | null;
      state?: ProxyState;
      error?: string;
    };
  };
  /** 已配置的比赛平台运行态；不传时平台动作返回可读错误。 */
  platform?: PlatformService;
}

export class HubService {
  private board: Blackboard;
  private sessions: SessionManager;
  private bus: EventBus;
  private workspaceRoot: string;
  private models: Record<string, string>;
  private approvals?: ApprovalQueue;
  private policy?: PolicyEngine;
  private permissions?: PermissionStore;
  private workDir?: string;
  /** P4-D：范围/代理状态（只读展示）。 */
  private scopeConfig?: HubDeps["scope"];
  /** 当前 UI 焦点任务；后台任务仍可继续跑（P1-B）。 */
  private focusedTaskId: string | null = null;
  /** 当前 renderer 视图；用于丢弃隐藏 Agent 控制台的高频流事件。 */
  private uiView: "competition" | "workspace" = "competition";
  private maxSessionsPerTask: number;
  private maxSessionsTotal: number;
  private strategyBudgetOverride?: Partial<StrategyBudget>;
  private strategyAgents?: string[];
  private irToolResolver?: (envVar: string, defaultName: string) => string | null;
  private platform?: PlatformService;
  /** V2-P0-3：每会话最后一次进展（事实/死路/候选）的工具调用计数与时间。 */
  private progressBySession = new Map<string, { at: number; toolCalls: number }>();
  private specProvider: (agentId: string) => AgentSpec | null;
  /** R24 收敛：宽限期与已收敛任务集（每任务只触发一次） */
  private convergeGraceMs: number;
  private converging = new Set<string>();
  /** 每个会话最近几段自述文本，用作审批卡片的中栏（§9.5） */
  private recentText = new Map<string, string[]>();
  /**
   * 每会话最近一段 agent_message 文本（R17）。
   *
   * 流式 chunk 会把 `flag{abc}` 拆成 `flag{ab` + `c}`，逐条扫永远识别不到；
   * 所以先累加再扫。限制长度，避免长会话把内存吃穿。
   */
  private flagScanText = new Map<string, string>();
  /** 自动提交去重：同一任务同一 E2 flag 只尝试一次。 */
  private autoSubmittedFlags = new Set<string>();
  /** 开靶 accepted 但地址尚未下发时，后台继续盯场景，不阻塞 Agent 启动。 */
  private sceneWatchers = new Map<string, Promise<void>>();

  constructor(deps: HubDeps) {
    this.board = deps.board;
    this.sessions = deps.sessions;
    this.bus = deps.bus;
    this.workspaceRoot = deps.workspaceRoot;
    this.models = deps.models ?? {};
    this.approvals = deps.approvals;
    this.policy = deps.policy;
    this.permissions = deps.permissions;
    this.workDir = deps.workDir;
    this.scopeConfig = deps.scope;
    this.maxSessionsPerTask = deps.maxSessionsPerTask ?? 3;
    this.maxSessionsTotal = deps.maxSessionsTotal ?? 8;
    this.strategyBudgetOverride = deps.strategyBudget;
    this.strategyAgents = deps.strategyAgents;
    this.irToolResolver = deps.irToolResolver;
    this.platform = deps.platform;
    this.convergeGraceMs = deps.convergeGraceMs ?? 0;
    this.specProvider = deps.specFor ?? ((agentId) => this.specFor(agentId));
  }

  /**
   * P6-B 批次 2a：更新快照里的代理运行时状态，并广播 `proxy.state.changed`。
   *
   * 只改展示字段；不改会话/策略/审批逻辑，也不启停代理。没有 scope 依赖时忽略。
   */
  setScopeProxyRuntime(proxy: ScopeProxyView): void {
    if (!this.scopeConfig) return;
    const normalized = normalizeScopeProxyView(proxy);
    this.scopeConfig = { ...this.scopeConfig, proxy: normalized };
    this.bus.emit({ type: "proxy.state.changed", proxy: { ...normalized } });
  }

  /** 审批卡片中栏数据源：该会话最近说过什么（agent_message / thought / plan） */
  intentSummary(sessionId: string): string | null {
    const list = this.recentText.get(sessionId);
    if (!list?.length) return null;
    return list.slice(-3).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  setTask(taskId: string | null): void {
    this.focusedTaskId = taskId;
    this.emitTask();
  }

  isWorkspaceView(): boolean {
    return this.uiView === "workspace";
  }

  /**
   * 平台已判定题解完成时，把本地任务同步为 solved，并停掉该任务遗留的 verify/idle 会话。
   * 这些会话不停止会持续占全局配额，最终把自动调度卡在 11/12、12/12。
   */
  async reconcilePlatformSolvedTasks(): Promise<number> {
    if (!this.platform) return 0;
    let stopped = 0;
    for (const task of this.board.listActiveTasks()) {
      const challenge = this.platform.challengeForTask(task.id);
      if (!challenge?.isSolved) continue;
      if (task.status !== "solved") {
        this.board.setTaskStatus(task.id, "solved");
        this.emitTaskById(task.id);
      }
      stopped += await this.stopTaskSessions(task.id);
    }
    return stopped;
  }

  /** 活跃 = 非终态；与 SessionManager/接口文案保持一致。 */
  private isActiveStatus(status: string): boolean {
    return !["blocked", "stopped", "failed", "done"].includes(status);
  }

  private isActiveSession(rec: SessionRecord): boolean {
    return this.isActiveStatus(rec.status);
  }

  private taskCounts(taskId: string): { running: number; total: number } {
    const rows = this.sessions.listSessions(taskId);
    return { running: rows.filter((s) => this.isActiveSession(s)).length, total: rows.length };
  }

  /**
   * 全局配额只统计**非归档任务**的非终态会话（计划 §4.3）。
   * 归档任务的历史会话仍可查，但不占新启动名额。
   */
  private globalActiveCount(): number {
    let count = 0;
    for (const t of this.board.listTasks()) {
      if (t.archived) continue;
      count += this.taskCounts(t.id).running;
    }
    return count;
  }

  /** 配额检查（P1-C）；返回可读错误，null 表示还有名额。 */
  private quotaError(taskId: string): string | null {
    const perTask = this.taskCounts(taskId).running;
    if (perTask >= this.maxSessionsPerTask) {
      return (
        `任务会话配额已满（${perTask}/${this.maxSessionsPerTask}）：` +
        `请先停一个会话，或调大 config/app.json 的 maxSessionsPerTask`
      );
    }
    const global = this.globalActiveCount();
    if (global >= this.maxSessionsTotal) {
      return (
        `全局会话配额已满（${global}/${this.maxSessionsTotal}）：` +
        `请先停一个会话，或调大 config/app.json 的 maxSessionsTotal`
      );
    }
    return null;
  }

  /**
   * 某任务当前要展示的 flag 候选。
   *
   * P5-A：从持久化 store 读；P1-C 的语义不变——快照只暴露焦点任务的候选，
   * 多个候选时取最近 first_seen 的一条（listFlagCandidates 已按最新在前排序）。
   */
  private flagCandidateOf(taskId: string | null): string | null {
    if (!taskId) return null;
    return this.board.listFlagCandidates(taskId)[0]?.value ?? null;
  }

  /** 给任务视图补运行计数与任务专属工作目录（所有快照/增量入口共用）。 */
  private fillTaskView(
    taskId: string,
    view: TaskView | null,
    withAttachmentList = false,
    withTargetScope = false,
  ): TaskView | null {
    if (!view) return null;
    const counts = this.taskCounts(taskId);
    view.runningSessions = counts.running;
    view.totalSessions = counts.total;
    view.workDir = this.workDir ? join(this.workDir, taskId) : null;
    // P5-A：所有任务都填候选数量；完整候选/来源只给焦点快照 flags。
    view.flagCount = this.board.listFlagCandidates(taskId).length;
    // P3-A：附件清单在磁盘上（attachments.json），不进库。
    // 所有任务只填数量；只有明确要求时才带完整清单（焦点任务），
    // 避免一次快照在 task/tasks 里重复搬运 N 份列表。
    const attachments = this.taskAttachments(taskId);
    view.attachmentCount = attachments.length;
    if (withAttachmentList) view.attachments = attachments;
    // P4-A：目标/denyTargets/scopeNotes 同样只给焦点任务填完整内容；
    // tasks 列表不重复搬运。旧快照/旧渲染层不读这些可选字段也不炸。
    if (withTargetScope) {
      view.targets = this.board.listTargets(taskId).map(toTargetView);
      const scope = this.board.getTaskScope(taskId);
      view.denyTargets = scope?.denyTargets ?? [];
      view.scopeNotes = scope?.scopeNotes ?? null;
    }
    return view;
  }

  /** 读某任务的附件清单（安全读：清单缺失/损坏时返回空数组，不影响快照）。 */
  private taskAttachments(taskId: string): AttachmentView[] {
    const root = this.workDir ?? this.workspaceRoot;
    return readAttachments(join(root, taskId));
  }

  /** P3-C：列某任务目录的产物（不含 attachments/；任务目录缺失时为空）。 */
  private taskArtifacts(taskId: string): ArtifactView[] {
    const root = this.workDir ?? this.workspaceRoot;
    const taskDir = join(root, taskId);
    try {
      // 与 previewArtifact 同一道边界：任务目录本身若是 junction/符号链接逃逸，不列。
      if (!isInsideDir(root, taskDir)) return [];
    } catch {
      return [];
    }
    return listArtifacts(taskDir);
  }

  /**
   * P3-C：只读预览任务内文件。
   *
   * 路径由快照里的 `AttachmentView.relativePath` / `ArtifactView.path` 派生；
   * 后端再用 preview.ts 做 realpath/越界/symlink 校验。渲染层不传任意绝对路径。
   * 出错时返回 `kind=unsupported + error`，不抛给 IPC。
   */
  async previewArtifact(taskId: string | undefined, relativePath: string): Promise<ArtifactPreview> {
    const id = taskId || this.focusedTaskId;
    if (!id) {
      return { kind: "unsupported", content: "没有活动任务", error: "没有活动任务" };
    }
    if (!this.board.getTask(id)) {
      return { kind: "unsupported", content: `任务不存在：${id}`, error: `任务不存在：${id}` };
    }
    const root = this.workDir ?? this.workspaceRoot;
    const taskDir = join(root, id);
    try {
      // 防御 taskId 被构造出目录逃逸；正常任务 id 是生成的，不应触发。
      if (!isInsideDir(root, taskDir)) {
        return { kind: "unsupported", content: "任务目录越界", error: "任务目录越界" };
      }
    } catch {
      // 任务目录不存在时交给 previewAttachment 返回 missing；这里不提前失败。
    }
    try {
      return previewAttachment({ taskDir, relativePath });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return { kind: "unsupported", content: message, error: message };
    }
  }

  /** 全部任务的视图列表（R19）；P1-B 起带 counts/archived/category。 */
  private listTaskViews(): TaskView[] {
    const out: TaskView[] = [];
    for (const t of this.board.listTasks()) {
      const candidate = t.id === this.focusedTaskId ? this.flagCandidateOf(t.id) : null;
      const view = this.fillTaskView(t.id, toTaskView(t, candidate));
      if (!view) continue;
      out.push(view);
    }
    return out;
  }

  /**
   * 停止某任务的全部非终态会话（P1-B 的 task.stopAll；P1-D 归档也会复用）。
   * 不触碰其他任务，不归档、不改任务状态。
   */
  private async stopTaskSessions(taskId: string, exceptSessionId?: string): Promise<number> {
    let stopped = 0;
    for (const rec of this.sessions.listSessions(taskId)) {
      if (exceptSessionId && rec.id === exceptSessionId) continue;
      if (!this.isActiveSession(rec)) continue;
      await this.stopAndCleanup(rec);
      stopped++;
    }
    return stopped;
  }

  /**
   * 等某任务的非终态会话真正归零（P1-D 归档 force 用）。
   *
   * `stopSession()` 只负责 kill；状态由异步退出回调落库。归档前必须等落库完成，
   * 否则 `archiveTask` 会看到“仍有会话”而拒绝，留下半途状态。超时返回剩余数。
   */
  private async waitForTaskIdle(taskId: string, timeoutMs = 2000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const active = this.board
        .listSessions(taskId)
        .filter((s) => this.isActiveStatus(s.status)).length;
      if (active === 0 || Date.now() >= deadline) return active;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * 停止一个会话并做统一清理。
   *
   * 之前只有显式 session.stop/remove 清 session 授权；task.create/switch、收敛停止、
   * 崩溃/策略终止都会漏掉授权、MCP token 和内存状态（审查 P1/P2/P3）。现在所有
   * Hub 侧的停止路径都走这里；SessionManager 的崩溃/策略终态通过 onSessionTerminal
   * 回调完成同一套清理。
   */
  private async stopAndCleanup(rec: SessionRecord): Promise<void> {
    // 先清审批再 close：否则 agent 卡在审批里，close 可能永远等不到响应。
    this.approvals?.denyAllOf(rec.id);
    await this.sessions.stopSession(rec.id);
    this.onSessionTerminal(rec.id);
  }

  /**
   * 会话进入终态后的统一清理（stop / remove / 崩溃 / 策略终止 / 启动回滚都会调）。
   *
   * 幂等：重复调用只是再次确认空集合。
   */
  onSessionTerminal(sessionId: string): void {
    this.approvals?.denyAllOf(sessionId);
    this.approvals?.forgetSession(sessionId);
    const cleared = this.permissions?.clearSession(sessionId) ?? 0;
    this.recentText.delete(sessionId);
    this.flagScanText.delete(sessionId);
    if (cleared > 0) this.publishPermissions();
  }

  /** 把当前焦点任务的视图推给渲染层（任务卡状态 / flag 候选变化时都走这里） */
  private emitTask(): void {
    if (!this.focusedTaskId) return;
    this.emitTaskById(this.focusedTaskId);
  }

  /**
   * 推任务视图的 `task.upsert`（不检查焦点）。
   *
   * 只给归档路径用：归档任务可能不是焦点，但任务列表需要看到 archived=true。
   * 因为 P1-B 的渲染层 store 对 `task.upsert` 没有 taskId 过滤（会把 `task`
   * 覆盖成事件里的任务），调用方必须在这之后重新推一次当前焦点（或切到新焦点）。
   */
  private emitTaskView(taskId: string): void {
    const row = this.board.getTask(taskId);
    const candidate = taskId === this.focusedTaskId ? this.flagCandidateOf(taskId) : null;
    const view = this.fillTaskView(
      taskId,
      toTaskView(row, candidate),
      taskId === this.focusedTaskId,
      taskId === this.focusedTaskId,
    );
    if (view) this.bus.emit({ type: "task.upsert", task: view });
  }

  /**
   * 推焦点任务的 `task.upsert`；非焦点任务只落库。
   *
   * P1-C 的决定：后台启动/回滚不推 `task.upsert`，避免 P1-B 的渲染层 store
   * 把焦点 `task` 覆盖成后台任务（store 对该事件没有 taskId 过滤）。
   */
  private emitTaskById(taskId: string): void {
    if (taskId !== this.focusedTaskId) return;
    this.emitTaskView(taskId);
  }

  /** P5-C：广播某任务的完整候选列表（确认/误报后）。后台任务也带 taskId。 */
  private emitFlags(taskId: string): void {
    const flags = this.board
      .listFlagCandidates(taskId)
      .map((c) => toFlagCandidateView(c, this.board.listFlagSources(c.id)));
    this.bus.emit({ type: "flag.updated", taskId, flags });
  }

  /**
   * P5-C：组装导出用的任务/候选视图。
   *
   * - 指定 taskId：只导出该任务（即使 0 候选也保留任务头）；
   * - 不指定：导出全部**有候选**的任务（含归档；导出是只读报告，不改状态）。
   */
  private flagExportTasks(taskId?: string): FlagExportTask[] {
    const rows = taskId ? [this.board.getTask(taskId)] : this.board.listTasks();
    const tasks: FlagExportTask[] = [];
    for (const row of rows) {
      if (!row) continue;
      const candidates = this.board
        .listFlagCandidates(row.id)
        .map((c) => toFlagCandidateView(c, this.board.listFlagSources(c.id)));
      if (taskId === undefined && candidates.length === 0) continue;
      tasks.push({ taskId: row.id, title: row.title, status: row.status, candidates });
    }
    return tasks;
  }

  /** 当前焦点任务视图（轻量：不探测 agent，供每次动作后的增量推送使用）。 */
  currentTaskView(): TaskView | null {
    if (!this.focusedTaskId) return null;
    const row = this.board.getTask(this.focusedTaskId);
    return this.fillTaskView(
      this.focusedTaskId,
      toTaskView(row, this.flagCandidateOf(this.focusedTaskId)),
      true,
      true,
    );
  }

  /**
   * 记录一个 flag 候选；P5-A 起写 SQLite store，不再用内存 Map。
   * - 同任务同 value 一条候选；同来源（session/witness/evidence）只保留一条来源；
   * - 来源证据取最高（E2 > E1 > E0）；
   * - 只对焦点任务推增量，后台任务的候选留到下次快照。
   */
  /** V2-P0-2：读取任务 AnswerSpec；非法/缺失回落默认 flag 规则。 */
  private answerSpecForTask(taskId: string | null): { spec: AnswerSpec; specId: string } {
    if (!taskId) return { spec: { ...DEFAULT_ANSWER_SPEC }, specId: answerSpecId(DEFAULT_ANSWER_SPEC) };
    const row = this.board.getTask(taskId);
    const parsed = parseAnswerSpec(row?.answer_spec ?? null);
    if (parsed.error) {
      process.stderr.write(`[answer] task=${taskId} ${parsed.error}\n`);
    }
    return { spec: parsed.spec, specId: answerSpecId(parsed.spec) };
  }

  private isPlaceholderFlag(value: string): boolean {
    const upper = value.toUpperCase();
    if (upper.includes("...") || upper.includes("…")) return true;
    if (
      /(SANDBOX_FAKE_FLAG|MOCK_HANDOFF|MOCK_FLAG|EXAMPLE_FLAG|PLACEHOLDER|FAKE_FLAG|LOCAL_TEST)/.test(
        upper,
      )
    ) {
      return true;
    }
    return false;
  }

  private noteFlagCandidate(
    taskId: string | null,
    flag: string,
    sessionId: string | null,
    source?: {
      witness?: string | null;
      evidence?: "E0" | "E1" | "E2";
      answerType?: AnswerType;
      normalizedValue?: string;
      specId?: string;
      sourceKind?: string | null;
      sourcePath?: string | null;
      line?: number | null;
      offset?: number | null;
    },
  ): void {
    if (!taskId) return;
    const normalized = flag.trim();
    if (!normalized) return;
    this.markProgress(sessionId);
    const evidence = source?.evidence ?? "E0";
    const witness = source?.witness ?? null;
    let created = false;
    let candidateId: string | null = null;
    try {
      const res = this.board.addFlagCandidate({
        taskId,
        value: normalized,
        sessionId,
        witness,
        evidence,
        answerType: source?.answerType,
        normalizedValue: source?.normalizedValue,
        specId: source?.specId,
      });
      created = res.created;
      candidateId = res.candidate.id;
      this.board.addFlagSource(candidateId, {
        sessionId,
        witness,
        evidence,
        sourceKind: source?.sourceKind ?? null,
        sourcePath: source?.sourcePath ?? null,
        line: source?.line ?? null,
        offset: source?.offset ?? null,
      });
    } catch (err) {
      // 候选持久化失败不能反过来影响会话/收敛；只留可读日志。
      process.stderr.write(`[flags] 候选持久化失败（task=${taskId}）：${(err as Error).message}\n`);
      return;
    }
    if (created) {
      // 审计不写答案明文：只记 candidateId/类型/来源/哈希前缀。
      this.board.audit({
        sessionId,
        actor: sessionId ?? "system",
        action: "task.flag_candidate",
        detail: {
          taskId,
          candidateId,
          answerType: source?.answerType ?? "flag",
          sourceKind: source?.sourceKind ?? null,
          sourcePath: source?.sourcePath ?? null,
          line: source?.line ?? null,
        },
      });
    }
    if (created && taskId === this.focusedTaskId) this.emitTask();
    if (
      this.platform?.snapshot().autoSubmit &&
      !this.isPlaceholderFlag(normalized) &&
      /^[A-Za-z0-9_-]+\{[^{}\s]{8,512}\}$/.test(normalized)
    ) {
      void this.attemptAutoSubmitFlag(taskId, normalized, candidateId);
    }
    // P1-C：收敛按任务独立——后台任务首答也只停该任务的队友。
    if (sessionId) this.maybeStartConvergence(taskId, normalized, sessionId);
  }

  private async attemptAutoSubmitFlag(
    taskId: string,
    value: string,
    candidateId: string | null,
    attempt = 0,
  ): Promise<void> {
    const challenge = this.platform?.challengeForTask(taskId);
    if (!challenge || challenge.isSolved) return;
    if (candidateId) {
      const candidate = this.board.getFlagCandidateById(candidateId);
      if (candidate?.status === "false_positive") return;
    }
    const key = `${taskId}\0${value}`;
    if (attempt === 0) {
      if (this.autoSubmittedFlags.has(key)) return;
      this.autoSubmittedFlags.add(key);
    }

    const result = await this.submitPlatformFlag({
      type: "platform.submitFlag",
      challengeId: challenge.id,
      taskId,
      candidateId: candidateId ?? undefined,
      flag: value,
    });

    if (result.ok) {
      try {
        if (candidateId) {
          this.board.updateFlagCandidateStatus(candidateId, "confirmed", "platform");
          this.board.updateFlagSubmitStatus(candidateId, "ok", Date.now(), "平台已接受");
          this.emitFlags(taskId);
        }
      } catch {
        // 平台已接受是权威结果；本地状态回写失败不回滚已解任务。
      }
      return;
    }

    const verdict = result.submission;
    const detail = verdict?.detail || result.error || "未知错误";
    if (!verdict?.rejected) {
      try {
        if (candidateId) {
          this.board.updateFlagSubmitStatus(candidateId, "timeout", Date.now(), detail);
          this.emitFlags(taskId);
        }
      } catch {
        // 重试状态写失败不影响后续重试。
      }
      process.stderr.write(
        `[platform] flag 自动提交暂时失败（${challenge.title}，attempt=${attempt + 1}）：${detail}\n`,
      );
      if (attempt < 2) {
        const delayMs = 10_000 * (attempt + 1);
        setTimeout(() => {
          void this.attemptAutoSubmitFlag(taskId, value, candidateId, attempt + 1);
        }, delayMs).unref();
      } else {
        // 网络恢复后仍允许未来的新证据触发一次重试。
        setTimeout(() => this.autoSubmittedFlags.delete(key), 60_000).unref();
      }
      return;
    }

    try {
      if (candidateId) {
        this.board.updateFlagCandidateStatus(candidateId, "false_positive");
        this.board.updateFlagSubmitStatus(candidateId, "failed", Date.now(), detail);
        this.emitFlags(taskId);
      }
      const correction =
        `【平台纠错】候选 ${value} 被平台拒绝：${detail}。` +
        "不要再次提交同一值；请回到题面/靶机证据，重新构造并验证一个不同的 flag 候选。";
      this.board.note({ taskId, sessionId: null, text: correction });
      for (const rec of this.sessions.listSessions(taskId)) {
        if (!this.isActiveStatus(rec.status)) continue;
        void this.sessions.prompt(rec.id, correction).catch(() => undefined);
      }
    } catch {
      // 纠错提示失败不影响 Agent 继续运行。
    }
  }

  /**
   * R24 收敛（Codex 评审 P2）：首个**带证据**的 flag 候选出现后，让还在跑的队友收尾，
   * 而不是继续各自的重复侦察。A/B 里 s2 的 flag 落库后 s3 又写一遍、s1 再复核，
   * makespan 因此翻倍——收敛就是冲这个去的。
   *
   * 触发条件：① 宽限期已配置（>0）；② 每任务只收敛一次；③ 该任务黑板上有含该 flag
   * 且 evidence != E0 的 fact（E0 = 无证据裸文本，幻觉风险太高，不触发）。
   * 行为：给**该任务**仍在跑的其它会话发提示（流 + prompt + 黑板 note），宽限期满后
   * 停止这些会话；提交候选的会话不动，任务状态也不动（solved 仍由人工确认）。
   *
   * P1-C 的关键边界：`listSessions(taskId)` / `board.note(..., taskId)` 全部按任务收敛，
   * 绝不触碰其它任务的会话、黑板或租约。
   */
  private maybeStartConvergence(taskId: string, flag: string, bySessionId: string): void {
    if (this.convergeGraceMs <= 0 || this.converging.has(taskId)) return;
    const fact = this.board.listFacts(taskId).find((f) => f.content.includes(flag) && f.evidence !== "E0");
    if (!fact) return;
    // P5-A：门槛仍是 R24 的 fact E1+；额外从 store 读候选并把 fact 证据补进来源。
    // 这样收敛读的是持久化 store，但触发条件/停谁/写哪条 note 都不变。
    try {
      const existing = this.board.getFlagCandidate(taskId, flag);
      const factEvidence = (fact.evidence === "E2" ? "E2" : "E1") as "E1" | "E2";
      const { spec, specId } = this.answerSpecForTask(taskId);
      const answerType = spec.answerType ?? "flag";
      const normalizedValue = canonicalAnswer(flag, answerType);
      if (!existing) {
        const res = this.board.addFlagCandidate({
          taskId,
          value: flag,
          sessionId: bySessionId,
          witness: fact.witness ?? null,
          evidence: factEvidence,
          answerType,
          normalizedValue,
          specId,
        });
        this.board.addFlagSource(res.candidate.id, {
          sessionId: bySessionId,
          witness: fact.witness ?? null,
          evidence: factEvidence,
          sourceKind: "fact",
          sourcePath: fact.witness ?? null,
        });
      } else if (
        (factEvidence === "E2" && existing.evidence !== "E2") ||
        (factEvidence === "E1" && existing.evidence === "E0")
      ) {
        this.board.addFlagSource(existing.id, {
          sessionId: bySessionId,
          witness: fact.witness ?? null,
          evidence: factEvidence,
          sourceKind: "fact",
          sourcePath: fact.witness ?? null,
        });
      }
    } catch (err) {
      process.stderr.write(`[flags] 收敛前补写候选失败（task=${taskId}）：${(err as Error).message}\n`);
    }
    this.converging.add(taskId);
    const others = this.sessions
      .listSessions(taskId)
      .filter((s) => s.id !== bySessionId && !["blocked", "stopped", "failed", "done"].includes(s.status));
    if (!others.length) return;
    const notice =
      `[收敛] 队友 ${bySessionId} 已提交带证据的答案候选：${flag}` +
      `${fact.witness ? `（证据：${fact.witness}）` : ""}。若你的结论一致请收尾；若发现不同结论，请在宽限期内继续并说明。` +
      `宽限期后仍在跑的会话会被自动停止。`;
    // 收敛结论写进**该任务**的黑板，切过去时队友能看到为什么被停。
    try {
      this.board.note({ taskId, sessionId: bySessionId, text: notice });
    } catch {
      /* note 落库失败不能阻止收敛本身 */
    }
    for (const s of others) {
      this.publishStreamUpdate(s.id, { ts: Date.now(), kind: "other", text: notice });
      if (["starting", "running", "waiting_approval"].includes(s.status)) {
        void this.sessions.prompt(s.id, notice).catch(() => undefined);
      }
    }
    setTimeout(() => {
      for (const s of others) {
        const latest = this.sessions.getSession(s.id);
        if (!latest || !["starting", "running", "waiting_approval"].includes(latest.status)) continue;
        void this.stopAndCleanup(latest)
          .then(() => {
            const after = this.sessions.getSession(s.id);
            if (after) this.publishSessionRec(after);
          })
          .catch(() => undefined);
      }
    }, this.convergeGraceMs);
  }

  /** 读某个会话的完整历史（R16）；渲染层建标签页时拉一次。 */
  history(sessionId: string): StreamUpdate[] {
    return this.sessions.historyOf(sessionId);
  }

  /**
   * 重启后从历史 / 黑板事实里重新识别 flag 候选（R17）。
   *
   * 候选只存在内存里，重启会丢；恢复会话后重扫一遍，任务栏不会「重启前有、重启后没了」。
   * 按会话拼接消息，跨 chunk 的 flag{...} 也能拼回来。
   */
  recoverTaskSignals(taskId: string | null = this.focusedTaskId): void {
    if (!taskId) return;
    const { spec, specId } = this.answerSpecForTask(taskId);
    const chunks: string[] = [];
    for (const s of this.sessions.listSessions(taskId)) {
      for (const u of this.sessions.historyOf(s.id)) {
        if (u.kind === "agent_message" && u.text) chunks.push(u.text);
      }
    }
    for (const hit of detectAnswers(chunks.join(""), spec, { evidence: "E0", maxHits: 200 })) {
      this.noteFlagCandidate(taskId, hit.value, null, {
        evidence: "E0",
        answerType: hit.answerType,
        normalizedValue: hit.normalizedValue,
        specId,
        sourceKind: "agent_message",
      });
    }
    for (const f of this.board.listFacts(taskId)) {
      const evidence = (f.evidence === "E2" ? "E2" : f.evidence === "E1" ? "E1" : f.witness ? "E1" : "E0") as
        | "E0"
        | "E1"
        | "E2";
      for (const hit of detectAnswers(f.content, spec, { evidence, maxHits: 50 })) {
        this.noteFlagCandidate(taskId, hit.value, null, {
          witness: f.witness ?? null,
          evidence,
          answerType: hit.answerType,
          normalizedValue: hit.normalizedValue,
          specId,
          sourceKind: "fact",
          sourcePath: f.witness ?? null,
        });
      }
    }
  }

  get currentTaskId(): string | null {
    return this.focusedTaskId;
  }

  healthOf(sessionId: string): SessionHealth {
    const rec = this.sessions.getSession(sessionId);
    if (!rec) return { toolCalls: 0, boardReads: 0, syncLag: 0 };
    return {
      toolCalls: rec.toolCalls,
      boardReads: rec.boardReads,
      syncLag: this.sessions.syncLag(sessionId),
    };
  }

  /** P9-C1：按任务构造 AWD 只读视图（导出用；不依赖当前焦点）。 */
  private awdViewForTask(taskId: string): AwdView | null {
    const row = this.board.getTask(taskId);
    if (!row || row.category !== "awd") return null;
    const facts = this.board.listFacts(taskId).map((f): FactView => ({
      id: f.id,
      content: f.content,
      status: f.status as FactView["status"],
      evidence: f.evidence as FactView["evidence"],
      witness: f.witness ?? null,
      by: f.created_by ?? null,
    }));
    const flags = this.board
      .listFlagCandidates(taskId)
      .map((c) => toFlagCandidateView(c, this.board.listFlagSources(c.id)));
    const targets = this.board.listTargets(taskId).map(toTargetView);
    return parseAwdFacts({
      taskId,
      facts,
      targets,
      flags,
      sessions: this.sessions.listSessions(taskId).map(toSessionView),
      scoreboard: this.board.getScoreboard(),
    }).view;
  }

  /** P9-C1：按任务构造 IR 只读视图（导出用）。 */
  private irViewForTask(taskId: string): IrView | null {
    const row = this.board.getTask(taskId);
    if (!row || row.category !== "ir") return null;
    const facts = this.board.listFacts(taskId).map((f): FactView => ({
      id: f.id,
      content: f.content,
      status: f.status as FactView["status"],
      evidence: f.evidence as FactView["evidence"],
      witness: f.witness ?? null,
      by: f.created_by ?? null,
    }));
    return parseIrFacts({
      taskId,
      facts,
      attachments: this.taskAttachments(taskId),
      artifacts: this.taskArtifacts(taskId),
      flags: this.board
        .listFlagCandidates(taskId)
        .map((c) => toFlagCandidateView(c, this.board.listFlagSources(c.id))),
    }).view;
  }

  snapshot(): HubSnapshot {
    const taskId = this.focusedTaskId ?? "";
    const deadEnds: DeadEndView[] = taskId
      ? this.board.listDeadEnds(taskId).map((d) => ({
          id: d.id,
          description: d.description,
          scope: d.scope,
          reopenWhen: d.reopen_when,
          by: d.created_by,
          createdAt: d.created_at,
        }))
      : [];
    const facts: FactView[] = taskId
      ? this.board.listFacts(taskId).map((f) => ({
          id: f.id,
          content: f.content,
          status: f.status as FactView["status"],
          evidence: f.evidence as FactView["evidence"],
          witness: f.witness ?? null,
          by: f.created_by ?? null,
        }))
      : [];
    // R18：租约视图也只属于当前焦点任务；无任务时为空。
    const leases: LeaseView[] = taskId
      ? this.board.listLeases(taskId).map((l) => ({
          resource: l.resource,
          holder: l.holder,
          acquiredAt: l.acquired_at,
          expiresAt: l.expires_at,
        }))
      : [];
    const intents: IntentView[] = taskId
      ? this.board.listIntents(taskId).map((i) => ({
          id: i.id,
          description: i.description,
          status: i.status as IntentView["status"],
          claimedBy: i.claimed_by,
        }))
      : [];

    // R17/P1-B：sessions/health/board 仍只属于焦点任务；P1-B 允许后台会话继续跑，
    // 但 UI 的焦点快照不混入后台数据。全局审批另放 approvalsAll。
    const sessionRecs = taskId ? this.sessions.listSessions(taskId) : [];
    const health: Record<string, SessionHealth> = {};
    for (const s of sessionRecs) health[s.id] = this.healthOf(s.id);
    const validSessionIds = new Set(sessionRecs.map((s) => s.id));

    const taskView = this.fillTaskView(
      taskId,
      toTaskView(
        taskId ? this.board.getTask(taskId) : undefined,
        taskId ? this.flagCandidateOf(taskId) : null,
      ),
      Boolean(taskId),
      Boolean(taskId),
    );

    const titles = new Map(this.board.listTasks().map((t) => [t.id, t.title]));
    const allApprovals = (this.approvals?.list() ?? []).map((a) => ({
      ...a,
      taskTitle: titles.get(a.taskId) ?? null,
    }));
    const flags = taskId
      ? this.board
          .listFlagCandidates(taskId)
          .map((c) => toFlagCandidateView(c, this.board.listFlagSources(c.id)))
      : [];
    const runningSessions = this.globalActiveCount();
    // WP9-A：AWD/IR 只读视图（仅 category=awd/ir；解析失败只告警，不影响快照）。
    const scoreboard = this.board.getScoreboard();
    const attachments = taskId ? this.taskAttachments(taskId) : [];
    const artifacts = taskId ? this.taskArtifacts(taskId) : [];
    const sessionViews = sessionRecs.map(toSessionView);
    const category = taskView?.category;
    let awd: ReturnType<typeof parseAwdFacts>["view"] | undefined;
    let ir: ReturnType<typeof parseIrFacts>["view"] | undefined;
    if (taskId && category === "awd") {
      const res = parseAwdFacts({
        taskId,
        facts,
        targets: taskView?.targets ?? [],
        flags,
        sessions: sessionViews,
        scoreboard,
      });
      awd = res.view;
      if (res.warnings.length > 0) {
        process.stderr.write(`[awdir] awd warnings: ${res.warnings.slice(0, 3).join(" | ")}\n`);
      }
    } else if (taskId && category === "ir") {
      const res = parseIrFacts({
        taskId,
        facts,
        attachments,
        artifacts,
        flags: this.board
          .listFlagCandidates(taskId)
          .map((c) => toFlagCandidateView(c, this.board.listFlagSources(c.id))),
      });
      ir = res.view;
      if (res.warnings.length > 0) {
        process.stderr.write(`[awdir] ir warnings: ${res.warnings.slice(0, 3).join(" | ")}\n`);
      }
    }

    return {
      task: taskView,
      tasks: this.listTaskViews(),
      sessions: sessionViews,
      approvals: taskId ? allApprovals.filter((a) => a.taskId === taskId) : [],
      approvalsAll: allApprovals,
      flags,
      scoreboard,
      quota: {
        maxSessionsPerTask: this.maxSessionsPerTask,
        maxSessionsTotal: this.maxSessionsTotal,
        runningSessions,
      },
      // P4-D：只透传范围/代理状态；P6-B 批次 2a 透传代理真实 state/error。
      scope: this.scopeConfig
        ? {
            enabled: this.scopeConfig.enabled === true,
            outOfScopeAction: this.scopeConfig.outOfScopeAction === "block" ? "block" : "approve",
            proxy: normalizeScopeProxyView(this.scopeConfig.proxy),
          }
        : undefined,
      permissionGrants: this.permissions?.list(validSessionIds) ?? [],
      // P3-A：焦点任务的附件清单（无任务时为空数组；旧快照没有该字段也不炸）。
      attachments,
      // P3-C：焦点任务的产物清单（只读扫描；attachments/ 不重复列）。
      artifacts,
      ...(awd ? { awd } : {}),
      ...(ir ? { ir } : {}),
      ...(this.platform ? { platform: this.platform.snapshot() } : {}),
      board: { facts, deadEnds, leases, intents },
      health,
      agents: detectAgents().map((a) => ({
        id: a.id,
        title: a.title,
        installed: a.installed,
        installHint: a.installHint,
        maturity: a.maturity,
        permissionBehavior: a.permissionBehavior,
      })),
      policy: this.policy
        ? {
            packId: this.policy.packId,
            name: this.policy.name,
            fellBackToMinimal: this.policy.fellBackToMinimal,
          }
        : undefined,
      workDir: this.workDir,
    };
  }

  /** V2-P0-3：记录某会话产生了新事实/死路/候选/证据（用于无进展检测）。 */
  private markProgress(sessionId: string | null): void {
    if (!sessionId) return;
    const rec = this.sessions.getSession(sessionId);
    if (!rec) return;
    this.progressBySession.set(sessionId, { at: Date.now(), toolCalls: rec.toolCalls });
  }

  private remainingMsFromEnv(now: number): number | undefined {
    const rawRemaining = process.env.BUMIMANG_REMAINING_MS?.trim();
    if (rawRemaining && /^\d+$/.test(rawRemaining)) return Number(rawRemaining);
    const rawDeadline = process.env.BUMIMANG_CONTEST_DEADLINE?.trim();
    if (!rawDeadline) return undefined;
    const asNumber = /^\d+$/.test(rawDeadline) ? Number(rawDeadline) : Date.parse(rawDeadline);
    if (!Number.isFinite(asNumber)) return undefined;
    return Math.max(0, asNumber - now);
  }

  /** 组装战略输入：只读快照；不执行任何动作。 */
  private strategyInputFor(mode: StrategyMode = "suggest"): StrategyInput {
    const now = Date.now();
    const taskRows = this.board.listActiveTasks();
    const tasks = taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      category: (t.category as TaskCategory) ?? "unknown",
      status: t.status as TaskView["status"],
      priority: t.priority ?? 0,
      points: t.points ?? 0,
      ...(t.updated_at > 0 ? { updatedAt: t.updated_at } : {}),
    }));
    const sessions: StrategySessionInput[] = [];
    const facts: StrategyInput["facts"] = [];
    const deadEnds: StrategyInput["deadEnds"] = [];
    const candidates: StrategyInput["candidates"] = [];
    const scopeRisk: StrategyInput["scopeRisk"] = {};
    const pendingBySession = new Map<string, number>();
    for (const a of this.approvals?.list(200) ?? []) {
      if (a.status === "pending") {
        pendingBySession.set(a.sessionId, (pendingBySession.get(a.sessionId) ?? 0) + 1);
      }
    }
    for (const t of taskRows) {
      for (const s of this.sessions.listSessions(t.id)) {
        const progress = this.progressBySession.get(s.id);
        const toolCallsSinceProgress = progress ? Math.max(0, s.toolCalls - progress.toolCalls) : s.toolCalls;
        sessions.push({
          id: s.id,
          taskId: s.taskId,
          role: s.role as Role,
          agent: s.agent,
          tier: s.tier as Tier,
          status: s.status,
          toolCalls: s.toolCalls,
          boardReads: s.boardReads,
          startedAt: s.startedAt,
          ...(progress ? { lastProgressAt: progress.at } : {}),
          toolCallsSinceProgress,
          approvalsPending: pendingBySession.get(s.id) ?? 0,
        });
      }
      for (const f of this.board.listFacts(t.id)) {
        facts.push({
          id: f.id,
          taskId: t.id,
          evidence: (f.evidence === "E2" ? "E2" : f.evidence === "E1" ? "E1" : "E0") as
            | "E0"
            | "E1"
            | "E2",
          createdAt: f.created_at,
          status: f.status,
        });
      }
      for (const d of this.board.listDeadEnds(t.id)) {
        deadEnds.push({ id: d.id, taskId: t.id, createdAt: d.created_at });
      }
      for (const c of this.board.listFlagCandidates(t.id)) {
        candidates.push({
          id: c.id,
          taskId: t.id,
          value: c.value,
          ...(c.answer_type ? { answerType: c.answer_type as AnswerType } : {}),
          evidence: (c.evidence === "E2" ? "E2" : c.evidence === "E1" ? "E1" : "E0") as
            | "E0"
            | "E1"
            | "E2",
          status: c.status as "new" | "confirmed" | "false_positive",
          firstSeen: c.first_seen,
          ...(c.normalized_value ? { normalizedValue: c.normalized_value } : {}),
        });
      }
      const scope = this.board.getTaskScope(t.id);
      const targets = this.board.listTargets(t.id);
      scopeRisk[t.id] = {
        hasDenyTargets: (scope?.denyTargets ?? []).length > 0,
        hasUnknownTargets:
          targets.length === 0 &&
          (((t.category as TaskCategory) ?? "unknown") === "pentest" ||
            ((t.category as TaskCategory) ?? "unknown") === "awd"),
        note: scope?.scopeNotes ?? undefined,
      };
    }
    const agents =
      this.strategyAgents ??
      installedAgents().map((a) => a.id);
    const envRemaining = this.remainingMsFromEnv(now);
    const budget: StrategyBudget = {
      now,
      maxSessions: this.maxSessionsTotal,
      maxSessionsPerTask: this.maxSessionsPerTask,
      maxNewSessions: 3,
      ...(envRemaining !== undefined ? { remainingMs: envRemaining } : {}),
      ...this.strategyBudgetOverride,
    };
    return {
      tasks,
      sessions,
      facts,
      deadEnds,
      candidates,
      budget,
      scopeRisk,
      availableAgents: agents,
      mode,
      noProgressToolCalls: 12,
      noProgressMinutes: 10,
    };
  }

  /** V2-P0-3：生成计划；只读，不执行。 */
  strategyPlan(mode: StrategyMode = "suggest"): StrategyPlan {
    return buildStrategyPlan(this.strategyInputFor(mode));
  }

  /** V2-P0-3：应用选中的建议。只执行 start/stop/switch；apply 时重算计划。 */
  private async applyStrategyPlan(action: {
    taskId: string;
    recommendationIds: string[];
    mode?: StrategyMode;
  }): Promise<ActionResult> {
    const row = this.board.getTask(action.taskId);
    if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
    if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
    const plan = this.strategyPlan(action.mode ?? "suggest");
    const byId = new Map(plan.recommendations.map((r) => [r.id, r]));
    const selected: StrategyRecommendation[] = [];
    const stale: string[] = [];
    for (const id of action.recommendationIds) {
      const rec = byId.get(id);
      if (rec) selected.push(rec);
      else stale.push(id);
    }
    if (selected.length === 0) {
      return {
        ok: false,
        error: "选中的建议已过期（计划已重算，没有匹配项）；请重新生成",
        strategyPlan: plan,
      };
    }
    const executable = selected.filter(
      (r) =>
        r.taskId === action.taskId &&
        r.applicable &&
        (r.action === "start_session" || r.action === "stop_session" || r.action === "switch_role"),
    );
    const crossTask = selected.filter((r) => r.taskId !== action.taskId);
    if (crossTask.length > 0) {
      // 现有安全语义：session.stop 只允许焦点任务（后台停止走 task.stopAll）。
      // 跨任务建议只展示，应用前先切到该任务，避免一次点击停掉别的任务。
      process.stderr.write(
        `[strategy] ${crossTask.length} 条跨任务建议未应用（先切到对应任务）：${crossTask
          .map((r) => r.taskId)
          .join(", ")}\n`,
      );
    }
    if (executable.length === 0) {
      return {
        ok: false,
        error: "选中的建议只是建议（continue/verify/abandon/reallocate），不会自动执行；请用会话按钮或人工处理",
        strategyPlan: plan,
      };
    }

    const maxNew = plan.budget.maxNewSessions ?? 3;
    let starts = 0;
    let applied = 0;
    const errors: string[] = [];
    const actions: Array<Record<string, unknown>> = [];
    for (const rec of executable) {
      if (applied >= 8) {
        errors.push("本次最多应用 8 条动作");
        break;
      }
      try {
        if (rec.action === "start_session") {
          if (starts >= maxNew) {
            errors.push(`新开上限 ${maxNew} 已到，跳过 ${rec.id}`);
            continue;
          }
          if (!rec.role || !rec.tier) {
            errors.push(`建议 ${rec.id} 缺 role/tier`);
            continue;
          }
          const agent =
            rec.agent ??
            this.strategyAgents?.[0] ??
            installedAgents().find((a) => a.installed)?.id;
          if (!agent) {
            errors.push("没有可用 agent，无法启动会话");
            continue;
          }
          const res = await this.dispatch({
            type: "session.start",
            taskId: rec.taskId,
            agent,
            role: rec.role,
            tier: rec.tier,
          });
          if (!res.ok) {
            errors.push(`${rec.id}: ${res.error ?? "启动失败"}`);
            continue;
          }
          starts++;
          applied++;
          actions.push({ id: rec.id, action: rec.action, role: rec.role, tier: rec.tier, agent });
        } else if (rec.action === "stop_session") {
          if (!rec.sessionId) {
            errors.push(`建议 ${rec.id} 缺 sessionId`);
            continue;
          }
          const res = await this.dispatch({ type: "session.stop", sessionId: rec.sessionId });
          if (!res.ok) {
            errors.push(`${rec.id}: ${res.error ?? "停止失败"}`);
            continue;
          }
          applied++;
          actions.push({ id: rec.id, action: rec.action, sessionId: rec.sessionId });
        } else if (rec.action === "switch_role") {
          if (!rec.sessionId || !rec.role || !rec.tier) {
            errors.push(`建议 ${rec.id} 缺 sessionId/role/tier`);
            continue;
          }
          if (starts >= maxNew) {
            errors.push(`新开上限 ${maxNew} 已到，跳过 ${rec.id}`);
            continue;
          }
          const stop = await this.dispatch({ type: "session.stop", sessionId: rec.sessionId });
          if (!stop.ok) {
            errors.push(`${rec.id}: 停止旧会话失败：${stop.error ?? "未知"}`);
            continue;
          }
          const agent =
            rec.agent ??
            this.strategyAgents?.[0] ??
            installedAgents().find((a) => a.installed)?.id;
          if (!agent) {
            errors.push("没有可用 agent，无法换线");
            continue;
          }
          const start = await this.dispatch({
            type: "session.start",
            taskId: rec.taskId,
            agent,
            role: rec.role,
            tier: rec.tier,
          });
          if (!start.ok) {
            errors.push(`${rec.id}: 换线启动失败：${start.error ?? "未知"}`);
            continue;
          }
          starts++;
          applied++;
          actions.push({
            id: rec.id,
            action: rec.action,
            sessionId: rec.sessionId,
            role: rec.role,
            tier: rec.tier,
            agent,
          });
        }
      } catch (err) {
        errors.push(`${rec.id}: ${(err as Error).message}`);
      }
    }

    try {
      this.board.audit({
        sessionId: null,
        actor: "human",
        action: "strategy.apply",
        detail: {
          taskId: action.taskId,
          mode: action.mode ?? "suggest",
          requested: action.recommendationIds.length,
          applied,
          actions,
          stale,
          errors,
        },
      });
    } catch {
      /* 审计失败不能回滚已执行动作 */
    }

    const after = this.strategyPlan(action.mode ?? "suggest");
    const message =
      `已应用 ${applied}/${action.recommendationIds.length} 条建议` +
      (stale.length ? `；${stale.length} 条已过期` : "") +
      (errors.length ? `；${errors.length} 条失败：${errors.slice(0, 3).join("；")}` : "");
    return {
      ok: applied > 0,
      message,
      ...(applied > 0 ? { strategyPlan: after } : { strategyPlan: plan }),
      ...(applied === 0 && errors.length ? { error: errors.slice(0, 3).join("；") } : {}),
    };
  }

  /** V2-P0-4：任务工作目录（IR 分析输入/工具 cwd 都限定在这里）。 */
  private irTaskDir(taskId: string): string {
    return join(this.workDir ?? this.workspaceRoot, taskId);
  }

  /** 读取任务下 ir.question 事实（只读，不包含答案明文）。 */
  private irQuestions(taskId: string): IrQuestion[] {
    const out: IrQuestion[] = [];
    const seen = new Set<string>();
    for (const f of this.board.listFacts(taskId)) {
      try {
        const data = JSON.parse(f.content) as Record<string, unknown>;
        if (data.schema !== "ir.question" || typeof data.question !== "string") continue;
        const id = typeof data.id === "string" && data.id.trim() ? data.id.trim() : f.id;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          question: data.question.trim(),
          ...(typeof data.field === "string" ? { field: data.field as AnswerType } : {}),
        });
      } catch {
        /* 非 JSON 事实忽略 */
      }
    }
    return out;
  }

  private async importIrQuestions(action: { taskId?: string; text: string }): Promise<ActionResult> {
    const taskId = action.taskId || this.focusedTaskId;
    if (!taskId) return { ok: false, error: "没有活动任务" };
    const row = this.board.getTask(taskId);
    if (!row) return { ok: false, error: `任务不存在：${taskId}` };
    if (row.category !== "ir") return { ok: false, error: `任务不是 IR：${taskId}` };
    const questions = parseIrQuestions(action.text);
    if (questions.length === 0) return { ok: false, error: "问题清单为空（每行一个问题，或 JSON 数组）" };
    const existing = new Set(this.irQuestions(taskId).map((q) => q.question));
    let added = 0;
    for (const q of questions) {
      if (existing.has(q.question)) continue;
      existing.add(q.question);
      this.board.submitFact({
        taskId,
        sessionId: null,
        content: JSON.stringify({
          schema: "ir.question",
          id: q.id,
          question: q.question,
          status: "open",
          ...(q.field ? { field: q.field } : {}),
        }),
        evidence: "E0",
      });
      added++;
    }
    try {
      this.board.audit({
        sessionId: null,
        actor: "human",
        action: "ir.questions.import",
        detail: { taskId, parsed: questions.length, added },
      });
    } catch {
      /* 审计失败不回滚问题导入 */
    }
    this.emitTaskById(taskId);
    return {
      ok: true,
      message: `已导入 ${added} 个问题（解析 ${questions.length}，重复 ${questions.length - added}）`,
    };
  }

  private async analyzeIrTask(action: { taskId?: string; paths?: string[] }): Promise<ActionResult> {
    const taskId = action.taskId || this.focusedTaskId;
    if (!taskId) return { ok: false, error: "没有活动任务" };
    const row = this.board.getTask(taskId);
    if (!row) return { ok: false, error: `任务不存在：${taskId}` };
    if (row.category !== "ir") return { ok: false, error: `任务不是 IR：${taskId}` };
    const taskDir = this.irTaskDir(taskId);
    const collected = collectIrInputs({
      taskId,
      taskDir,
      ...(action.paths ? { paths: action.paths } : {}),
    });
    if (collected.inputs.length === 0) {
      return {
        ok: false,
        error:
          "没有可分析的输入：请先把日志/PCAP/内存/目录导入任务附件，或在 paths 中指定任务内路径" +
          (collected.warnings.length ? `（${collected.warnings.slice(0, 3).join("；")}）` : ""),
      };
    }
    const started = Date.now();
    const ctx: IrContext = {
      taskId,
      workDir: taskDir,
      now: Date.now(),
      limits: DEFAULT_IR_LIMITS,
      runCommand: (command, args, opts) =>
        runCommandSafe(command, args, {
          cwd: taskDir,
          timeoutMs: opts?.timeoutMs ?? DEFAULT_IR_LIMITS.toolTimeoutMs,
          maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_IR_LIMITS.maxToolOutputBytes,
        }),
      resolveTool: (envVar, defaultName) =>
        this.irToolResolver
          ? this.irToolResolver(envVar, defaultName)
          : resolveTool(envVar, defaultName),
      audit: (actionName, detail) => {
        try {
          this.board.audit({ sessionId: null, actor: "system", action: actionName, detail });
        } catch {
          /* 审计失败不影响分析 */
        }
      },
      log: (line) => process.stderr.write(`${line}\n`),
    };
    const bundle = await runIrAnalysis({
      inputs: collected.inputs,
      registry: createDefaultIrRegistry(),
      ctx,
      concurrency: 2,
    });

    // 事实去重：同一内容重复分析不重复落库（analysis 摘要除外，保留每次运行）。
    const existing = new Set(this.board.listFacts(taskId).map((f) => f.content));
    const addFact = (schema: string, data: Record<string, unknown>, witness: string | null, evidence: "E0" | "E1" | "E2"): boolean => {
      const content = JSON.stringify({ schema, ...data });
      if (existing.has(content)) return false;
      existing.add(content);
      this.board.submitFact({ taskId, sessionId: null, content, witness, evidence });
      return true;
    };

    let addedFacts = 0;
    let timelineCount = 0;
    let iocCount = 0;
    for (const result of bundle.results) {
      addFact(
        "ir.analysis",
        {
          analyzerId: result.analyzerId,
          analyzerTitle: result.analyzerTitle,
          input: result.input.relativePath,
          sha256: result.input.sha256 ?? null,
          facts: result.facts.length,
          timeline: result.timeline.length,
          iocs: result.iocs.length,
          warnings: result.warnings,
          tools: result.toolLogs.map((t) => ({
            tool: t.tool,
            ok: t.ok,
            exitCode: t.exitCode,
            timedOut: t.timedOut,
            truncated: t.truncated,
            durationMs: t.durationMs,
          })),
          generatedAt: Date.now(),
        },
        result.input.relativePath,
        "E1",
      );
      addedFacts++;
      for (const ev of result.timeline) {
        if (timelineCount >= 500) break;
        if (
          addFact(
            "ir.timeline",
            {
              at: ev.at,
              source: ev.source,
              event: ev.event,
              impact: ev.impact ?? null,
              evidence: ev.evidence,
            },
            ev.witness ?? result.input.relativePath,
            ev.evidence,
          )
        ) {
          timelineCount++;
        }
      }
      for (const ioc of result.iocs) {
        if (iocCount >= 500) break;
        if (
          addFact(
            "ir.ioc",
            {
              type: ioc.type,
              value: ioc.value,
              count: ioc.count,
              firstSeen: ioc.firstSeen ?? null,
              evidence: ioc.evidence,
            },
            ioc.witness ?? result.input.relativePath,
            ioc.evidence,
          )
        ) {
          iocCount++;
        }
      }
      for (const fact of result.facts) {
        if (addFact(fact.schema, fact.data, fact.witness ?? result.input.relativePath, fact.evidence)) {
          addedFacts++;
        }
      }
    }

    // 问题驱动：把证据映射成候选；候选值进 flag_candidates，事实只存候选 id（无明文）。
    const questions = this.irQuestions(taskId);
    let candidateCount = 0;
    for (const q of questions) {
      const candidates = mapQuestionCandidates(q, bundle.results);
      for (const cand of candidates) {
        if (!cand.value) {
          addFact(
            "ir.answer_gap",
            {
              questionId: q.id,
              field: cand.answerType,
              gaps: cand.gaps ?? [],
            },
            null,
            "E0",
          );
          continue;
        }
        this.noteFlagCandidate(taskId, cand.value, null, {
          witness: cand.witness ?? null,
          evidence: cand.evidence,
          answerType: cand.answerType,
          normalizedValue: canonicalAnswer(cand.value, cand.answerType),
          specId: `ir-question:${q.id}`,
          sourceKind: "ir",
          sourcePath: cand.witness ?? null,
        });
        const candidate = this.board.getFlagCandidate(taskId, cand.value);
        if (!candidate) continue;
        if (
          addFact(
            "ir.answer_candidate",
            {
              questionId: q.id,
              candidateId: candidate.id,
              field: cand.answerType,
              confidence: cand.confidence,
              evidence: cand.evidence,
              sources: cand.sources ?? [],
              gaps: cand.gaps ?? [],
            },
            cand.witness ?? null,
            cand.evidence,
          )
        ) {
          candidateCount++;
        }
      }
    }

    const warnings = [...collected.warnings, ...bundle.warnings].slice(0, 50);
    const summary = {
      taskId,
      inputs: collected.inputs.length,
      results: bundle.results.length,
      facts: addedFacts,
      timeline: timelineCount,
      iocs: iocCount,
      candidates: candidateCount,
      warnings,
      durationMs: Date.now() - started,
      generatedAt: Date.now(),
    };
    try {
      this.board.audit({
        sessionId: null,
        actor: "system",
        action: "ir.analyze",
        detail: {
          taskId,
          inputs: summary.inputs,
          results: summary.results,
          facts: summary.facts,
          timeline: summary.timeline,
          iocs: summary.iocs,
          candidates: summary.candidates,
          warnings: warnings.length,
          durationMs: summary.durationMs,
        },
      });
    } catch {
      /* 审计失败不回滚分析结果 */
    }
    this.emitTaskById(taskId);
    return {
      ok: true,
      message:
        `IR 分析完成：输入 ${summary.inputs}、分析器结果 ${summary.results}、事实 ${summary.facts}、` +
        `时间线 ${summary.timeline}、IOC ${summary.iocs}、候选 ${summary.candidates}` +
        (warnings.length ? `；${warnings.length} 条告警（见 IR 面板）` : ""),
      irAnalysis: summary,
    };
  }

  private platformBrief(
    challenge: NonNullable<ReturnType<PlatformService["challenge"]>>,
    wpMatches: Array<{ title: string; path: string; reason: string }>,
  ): string {
    const lines = [
      `平台题目：${challenge.title}`,
      `方向：${challenge.direction}（${challenge.category}） · 当前分值：${Math.round(challenge.points)} · 已解：${challenge.solvedCount} 队`,
      "",
      "【题面】",
      challenge.description || "（平台未返回题面）",
      "",
      "【靶机地址】",
      ...(challenge.targets.length > 0
        ? challenge.targets.map((target) => `- ${target.url}（协议 ${target.protocol}）`)
        : ["- 当前无公开实例；竞速启动会先自动开靶并把地址写入任务黑板。"]),
      "",
      "【附件】",
      challenge.attachmentName
        ? `- ${challenge.attachmentName}（开题时自动下载到 attachments/）`
        : "- 无附件",
      "",
      "【本地 WP 参考】",
      ...(wpMatches.length > 0
        ? wpMatches.map((match) => `- reference/wp/ 内的 ${match.title}（来源 ${match.path}；${match.reason}）`)
        : ["- 未检索到同名 WP；按题型 playbook 和技能库推进。"]),
      "",
      "【速度纪律】",
      "- 先读 challenge.json / README.md / attachments/ / reference/wp/，30 秒内形成 2–3 个可验证假设。",
      "- 每个命中 flag 立即写入 evidence/，并调用黑板 submit_fact 记录 witness；把完整候选单独输出为 PLATFORM_FLAG=<值>。",
      "- 不重复队友已声明的死路；每 3 个工具调用读一次黑板增量。",
      "- 单条路径 10 分钟无新证据就写 dead_end 并换路线；拿到 flag 候选立即告知用户。",
    ];
    return lines.join("\n");
  }

  private ensurePlatformTaskDir(taskId: string): string {
    const root = this.workDir ?? this.workspaceRoot;
    const taskDir = join(root, taskId);
    mkdirSync(join(taskDir, "attachments"), { recursive: true });
    mkdirSync(join(taskDir, "reference", "wp"), { recursive: true });
    mkdirSync(join(taskDir, "evidence"), { recursive: true });
    return taskDir;
  }

  private refreshPlatformTaskFiles(
    taskId: string,
    challenge: NonNullable<ReturnType<PlatformService["challenge"]>>,
  ): void {
    const taskDir = this.ensurePlatformTaskDir(taskId);
    const manifestPath = join(taskDir, "challenge.json");
    let previous: Record<string, unknown> = {};
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          previous = parsed as Record<string, unknown>;
        }
      } catch {
        previous = {};
      }
    }
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...previous,
        version: 1,
        syncedAt: Date.now(),
        taskId,
        challenge,
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(taskDir, "targets.txt"),
      [
        `# ${challenge.title} targets`,
        "",
        ...(challenge.targets.length > 0
          ? challenge.targets.map((target) =>
              `${target.url}\t${target.protocol}\tinner=${target.innerPort ?? "-"}\t${target.label ?? ""}`,
            )
          : ["(none)"]),
        "",
      ].join("\n"),
      "utf8",
    );
  }

  private addPlatformTargets(
    taskId: string,
    challenge: NonNullable<ReturnType<PlatformService["challenge"]>>,
  ): void {
    const existing = new Set(this.board.listTargets(taskId).map((target) => target.value));
    const facts = new Set(this.board.listFacts(taskId).map((fact) => fact.content));
    for (const target of challenge.targets) {
      if (!target.url) continue;
      const content = `平台靶机地址：${target.url}（协议 ${target.protocol}${target.innerPort ? `，容器端口 ${target.innerPort}` : ""}）`;
      if (!facts.has(content)) {
        this.board.submitFact({
          taskId,
          sessionId: null,
          content,
          witness: `platform:${challenge.id}:${target.url}`,
          evidence: "E1",
        });
        facts.add(content);
      }
      if (existing.has(target.url)) continue;
      const kind = target.protocol === "http" || target.protocol === "https" ? "url" : "host";
      const result = this.board.addTarget({
        taskId,
        value: target.url,
        kind,
        notes: `${challenge.title} 平台实例（${target.protocol}${target.innerPort ? `，容器端口 ${target.innerPort}` : ""}）`,
      });
      if (result.ok) existing.add(target.url);
    }
    this.refreshPlatformTaskFiles(taskId, challenge);
  }

  private watchSceneUntilReady(challengeId: string, taskId: string): void {
    if (this.sceneWatchers.has(taskId)) return;
    const watcher = (async () => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        const challenge = await this.platform?.refreshChallenge(challengeId).catch(() => null);
        if (!challenge || !challenge.sceneReady || challenge.targets.length === 0) continue;
        this.addPlatformTargets(taskId, challenge);
        this.emitTaskById(taskId);
        const message =
          `【平台】靶机已就绪：${challenge.targets.map((target) => target.url).join("、")}。` +
          "已写入黑板、challenge.json 和 targets.txt；立即基于该地址继续，不要再说靶机未下发。";
        try {
          this.board.note({ taskId, sessionId: null, text: message });
        } catch {
          // 黑板写失败不影响完成后的地址注入。
        }
        for (const rec of this.sessions.listSessions(taskId)) {
          if (!this.isActiveStatus(rec.status)) continue;
          void this.sessions.prompt(rec.id, message).catch(() => undefined);
        }
        return;
      }
      try {
        this.board.note({
          taskId,
          sessionId: null,
          text: "【平台】靶机等待 10 分钟仍未下发地址；任务可继续离线推进，调度器会把它视为环境受阻并切换目标。",
        });
      } catch {
        // 告警失败不影响调度。
      }
    })().finally(() => {
      this.sceneWatchers.delete(taskId);
    });
    this.sceneWatchers.set(taskId, watcher);
  }

  private async materializePlatformChallenge(
    action: Extract<HubAction, { type: "platform.materialize" }>,
  ): Promise<ActionResult> {
    if (!this.platform) return { ok: false, error: "未配置比赛平台" };
    const challenge = this.platform.challenge(action.challengeId);
    if (!challenge) return { ok: false, error: `平台题目不存在：${action.challengeId}` };

    let taskId = this.platform.taskForChallenge(challenge.id);
    let task = taskId ? this.board.getTask(taskId) : undefined;
    if (task?.archived) task = undefined;
    const warnings: string[] = [];
    const includeWp = action.includeWp !== false;
    const wpMatches = includeWp
      ? await this.platform.searchWp(challenge.id, 10).catch((err: Error) => {
          warnings.push(`WP 检索失败：${err.message}`);
          return [];
        })
      : [];

    if (!task) {
      const created = this.board.createTask({
        title: challenge.title,
        brief: this.platformBrief(challenge, wpMatches),
        category: challenge.category,
        priority: challenge.isSolved ? 0 : Math.max(0, Math.min(100, Math.round(challenge.points / 10))),
        points: Math.max(0, Math.round(challenge.points)),
      });
      taskId = created.id;
      task = this.board.getTask(taskId);
      this.platform.attachTask(challenge.id, taskId);
    } else if (taskId) {
      this.board.updateTaskScheduling({
        taskId,
        points: Math.max(0, Math.round(challenge.points)),
        priority: challenge.isSolved ? 0 : Math.max(0, Math.min(100, Math.round(challenge.points / 10))),
      });
      this.platform.attachTask(challenge.id, taskId);
    }
    if (!taskId || !task) return { ok: false, error: "创建平台任务失败" };

    const taskDir = this.ensurePlatformTaskDir(taskId);
    let attachmentImported = false;
    if (action.downloadAttachment !== false && challenge.attachmentUrl) {
      const downloadDir = join(taskDir, ".platform-download");
      let temp: string | null = null;
      try {
        rmSync(downloadDir, { recursive: true, force: true });
        temp = await this.platform.downloadAttachment(challenge.id, downloadDir);
        if (temp) {
          const imported = await importAttachments({
            workRoot: this.workDir ?? this.workspaceRoot,
            taskId,
            paths: [temp],
            // Forensic images are frequently several hundred MB. Keep the
            // interactive upload default conservative, but allow platform
            // handouts enough room to materialize without manual workarounds.
            limits: {
              maxTotalBytes: 2 * 1024 * 1024 * 1024,
              maxFiles: 5_000,
            },
          });
          if (imported.ok) attachmentImported = true;
          else if (imported.error && !/已存在|目标已存在/.test(imported.error)) {
            warnings.push(`附件导入失败：${imported.error}`);
          }
        }
      } catch (err) {
        warnings.push(`附件下载失败：${(err as Error).message}`);
      } finally {
        try {
          rmSync(downloadDir, { recursive: true, force: true });
        } catch {
          // 临时附件清理失败不影响任务。
        }
      }
    }

    let copiedWp: Array<{ title: string; relativePath: string; source: string }> = [];
    if (includeWp) {
      try {
        copiedWp = await this.platform.copyWp(challenge.id, taskDir, 6);
      } catch (err) {
        warnings.push(`WP 复制失败：${(err as Error).message}`);
      }
    }
    this.addPlatformTargets(taskId, challenge);
    if (challenge.withScene && (!challenge.sceneReady || challenge.targets.length === 0)) {
      this.watchSceneUntilReady(challenge.id, taskId);
    }

    const platformManifest = {
      version: 1,
      syncedAt: Date.now(),
      challenge,
      taskId,
      wpMatches,
      copiedWp,
      attachmentImported,
    };
    writeFileSync(
      join(taskDir, "challenge.json"),
      `${JSON.stringify(platformManifest, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(taskDir, "README.md"),
      [
        `# ${challenge.title}`,
        "",
        `- 平台题目 ID：\`${challenge.id}\``,
        `- 方向：${challenge.direction}`,
        `- 分值：${challenge.points}`,
        `- 当前解出：${challenge.solvedCount} 队`,
        `- 平台状态：${challenge.isSolved ? "已解出" : "未解出"}`,
        "",
        "## 题面",
        "",
        challenge.description || "（平台未返回题面）",
        "",
        "## 目标",
        "",
        ...(challenge.targets.length > 0
          ? challenge.targets.map((target) => `- ${target.url}`)
          : ["- 暂无公开实例"]),
        "",
        "## 本地资料",
        "",
        `- 附件目录：attachments/`,
        `- WP 参考：reference/wp/（${copiedWp.length} 篇）`,
        `- 证据目录：evidence/`,
        "",
      ].join("\n"),
      "utf8",
    );

    this.setTask(taskId);
    this.emitTaskById(taskId);
    this.sessions.loadTaskSessions(taskId);
    this.recoverTaskSignals(taskId);
    return {
      ok: true,
      taskId,
      challengeId: challenge.id,
      wpMatches,
      platform: this.platform.snapshot(),
      message:
        `已开题「${challenge.title}」：WP ${copiedWp.length} 篇` +
        `${attachmentImported ? "，附件已导入" : ""}` +
        `${warnings.length > 0 ? `；${warnings.length} 条告警：${warnings.join("；")}` : ""}`,
    };
  }

  private async submitPlatformFlag(
    action: Extract<HubAction, { type: "platform.submitFlag" }>,
  ): Promise<ActionResult> {
    if (!this.platform) return { ok: false, error: "未配置比赛平台" };
    const challenge = this.platform.challenge(action.challengeId);
    if (!challenge) return { ok: false, error: `平台题目不存在：${action.challengeId}` };
    const flag = action.flag.trim();
    if (!flag) return { ok: false, error: "flag 不能为空" };
    try {
      const result = await this.platform.submitFlag(challenge.id, flag);
      const resultRecord = result as Record<string, unknown>;
      const accepted =
        resultRecord.is_pass === true ||
        resultRecord.is_pass === 1 ||
        resultRecord.is_pass === "true" ||
        resultRecord.success === true ||
        resultRecord.success === 1 ||
        resultRecord.success === "true" ||
        resultRecord.status === "correct" ||
        resultRecord.status === "solved";
      if (!accepted) {
        const message =
          typeof resultRecord.message === "string" && resultRecord.message.trim()
            ? resultRecord.message
            : "平台未接受该 flag";
        return {
          ok: false,
          error: `平台未接受 flag：${message}`,
          submission: {
            accepted: false,
            rejected: true,
            retryable: false,
            detail: message,
            statusCode: null,
          },
        };
      }
      const taskId = action.taskId ?? this.platform.taskForChallenge(challenge.id);
      if (taskId && this.board.getTask(taskId)) {
        this.board.setTaskStatus(taskId, "solved", flag, "platform");
        const candidate = this.board.addFlagCandidate({
          taskId,
          value: flag,
          sessionId: "platform",
          witness: `platform:${challenge.id}`,
          evidence: "E2",
          status: "confirmed",
        });
        this.board.addFlagSource(candidate.candidate.id, {
          sessionId: "platform",
          witness: `platform:${challenge.id}`,
          evidence: "E2",
          sourceKind: "platform",
          sourcePath: challenge.id,
        });
        if (candidate.candidate.status !== "confirmed") {
          this.board.updateFlagCandidateStatus(candidate.candidate.id, "confirmed", "platform");
        }
        this.emitTaskById(taskId);
        this.emitFlags(taskId);
      }
      if (action.candidateId) {
        try {
          this.board.updateFlagCandidateStatus(action.candidateId, "confirmed", "platform");
          this.board.updateFlagSubmitStatus(
            action.candidateId,
            "ok",
            Date.now(),
            "平台已接受",
          );
        } catch {
          // 平台接受后本地候选缺失不阻塞任务 solved。
        }
      }
      await this.platform.refreshChallenge(challenge.id).catch(() => undefined);
      await this.reconcilePlatformSolvedTasks().catch(() => undefined);
      const submission: PlatformSubmissionResultView = {
        accepted: true,
        rejected: false,
        retryable: false,
        detail: "平台已接受",
        statusCode: null,
      };
      return {
        ok: true,
        taskId: taskId ?? undefined,
        challengeId: challenge.id,
        platform: this.platform.snapshot(),
        message: `平台已接收 flag：${challenge.title}`,
        content: JSON.stringify(result),
        submission,
      };
    } catch (err) {
      const detail =
        err instanceof Error ? err.message.replace(/\s+/g, " ").trim().slice(0, 400) : String(err);
      const statusCode =
        typeof (err as { status?: unknown }).status === "number"
          ? ((err as { status: number }).status)
          : null;
      const rejected =
        /flag.*(?:错误|不正确|无效|错误|wrong|invalid|incorrect|reject|not\s+correct)/i.test(
          detail,
        ) || statusCode === 422;
      return {
        ok: false,
        error: `平台提交失败：${detail}`,
        submission: {
          accepted: false,
          rejected,
          retryable: !rejected,
          detail,
          statusCode,
        },
      };
    }
  }

  async dispatch(action: HubAction): Promise<ActionResult> {
    try {
      switch (action.type) {
        case "ui.setView": {
          this.uiView = action.view;
          return { ok: true };
        }
        case "platform.login": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          try {
            const platform = await this.platform.connect({
              username: action.username,
              password: action.password,
              baseUrl: action.baseUrl,
              provider: action.provider,
              raceId: action.raceId,
              remember: action.remember,
            });
            return {
              ok: true,
              platform,
              message:
                `平台登录成功：${platform.challenges.length} 道题` +
                `${platform.race ? ` · ${platform.race.name}` : ""}`,
            };
          } catch (err) {
            return { ok: false, error: `平台登录失败：${(err as Error).message}` };
          }
        }
        case "platform.logout": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          return { ok: true, platform: this.platform.logout(), message: "已退出比赛平台" };
        }
        case "platform.sync": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          try {
            const platform = await this.platform.sync(action.raceId);
            return {
              ok: true,
              platform,
              message: `同步完成：${platform.challenges.length} 道题`,
            };
          } catch (err) {
            return {
              ok: false,
              error: `平台同步失败：${(err as Error).message}`,
              platform: this.platform.snapshot(),
            };
          }
        }
        case "platform.materialize":
          return this.materializePlatformChallenge(action);
        case "platform.searchWp": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          try {
            const wpMatches = await this.platform.searchWp(action.challengeId, action.limit ?? 8);
            return {
              ok: true,
              challengeId: action.challengeId,
              wpMatches,
              platform: this.platform.snapshot(),
              message: `命中 ${wpMatches.length} 篇本地 WP`,
            };
          } catch (err) {
            return { ok: false, error: `WP 检索失败：${(err as Error).message}` };
          }
        }
        case "platform.openScene": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          try {
            const challenge = await this.platform.openScene(action.challengeId);
            const taskId = this.platform.taskForChallenge(action.challengeId);
            if (taskId && this.board.getTask(taskId)) {
              this.addPlatformTargets(taskId, challenge);
              if (challenge.withScene && (!challenge.sceneReady || challenge.targets.length === 0)) {
                this.watchSceneUntilReady(challenge.id, taskId);
              }
            }
            if (taskId) this.emitTaskById(taskId);
            return {
              ok: true,
              challengeId: action.challengeId,
              taskId: taskId ?? undefined,
              platform: this.platform.snapshot(),
              message: challenge.targets.length
                ? `靶机已开启：${challenge.targets.map((target) => target.url).join("、")}`
                : "开靶请求已提交；Agent 可先离线分析，地址就绪后会自动注入",
            };
          } catch (err) {
            return { ok: false, error: `开靶失败：${(err as Error).message}` };
          }
        }
        case "platform.closeScene": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          try {
            const challenge = await this.platform.closeScene(action.challengeId);
            return {
              ok: true,
              challengeId: action.challengeId,
              platform: this.platform.snapshot(),
              message: challenge.sceneReady ? "关闭请求已提交，实例仍在回收" : "靶机已关闭",
            };
          } catch (err) {
            return { ok: false, error: `关靶失败：${(err as Error).message}` };
          }
        }
        case "platform.probeScenes": {
          if (!this.platform) return { ok: false, error: "未配置比赛平台" };
          const wanted = action.challengeIds ? new Set(action.challengeIds) : null;
          const challenges = this.platform
            .challenges()
            .filter((challenge) => !wanted || wanted.has(challenge.id));
          const jobs = challenges.flatMap((challenge) =>
            challenge.targets.map((target) => ({ challenge, target })),
          );
          const sceneProbes: PlatformSceneProbeView[] = [];
          for (let index = 0; index < jobs.length; index += 4) {
            const batch = jobs.slice(index, index + 4);
            sceneProbes.push(
              ...(await Promise.all(
                batch.map(({ challenge, target }) =>
                  probePlatformTarget(challenge.id, target),
                ),
              )),
            );
          }
          const healthy = sceneProbes.filter((probe) => probe.ok).length;
          return {
            ok: true,
            sceneProbes,
            message:
              sceneProbes.length === 0
                ? "当前范围没有可探测的靶机"
                : `靶机探测完成：${healthy}/${sceneProbes.length} 正常`,
          };
        }
        case "platform.submitFlag":
          return this.submitPlatformFlag(action);
        case "ir.questions.import":
          return this.importIrQuestions(action);
        case "ir.analyze":
          return this.analyzeIrTask(action);
        case "strategy.plan": {
          if (action.taskId && !this.board.getTask(action.taskId)) {
            return { ok: false, error: `任务不存在：${action.taskId}` };
          }
          return { ok: true, strategyPlan: this.strategyPlan(action.mode ?? "suggest") };
        }
        case "strategy.apply":
          return this.applyStrategyPlan(action);
        case "task.create": {
          // V2-P0-2：answerSpec 可省略；提供时必须是合法 spec，非法直接拒绝。
          let answerSpec = undefined as TaskView["answerSpec"] | undefined;
          if (action.answerSpec !== undefined) {
            const res = validateAnswerSpec(action.answerSpec);
            if (!res.ok) return { ok: false, error: `answerSpec 非法：${res.errors.join("；")}` };
            answerSpec = res.spec!;
          }
          const t = this.board.createTask({
            title: action.title,
            brief: action.brief,
            category: action.category,
            priority: action.priority,
            ...(action.points !== undefined ? { points: action.points } : {}),
            ...(answerSpec ? { answerSpec } : {}),
          });
          // P1-B：建新任务只切焦点，不停旧任务会话。
          this.setTask(t.id);
          return { ok: true };
        }
        case "task.scope.update": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          try {
            const next = this.board.updateTaskScope(action);
            this.emitTaskById(action.taskId);
            return {
              ok: true,
              message:
                `已更新范围数据：denyTargets ${next.denyTargets.length} 条、` +
                `allowedActions ${next.allowedActions.length} 条；scope.enabled 仍由配置决定`,
            };
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
        }
        case "task.update": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          try {
            this.board.updateTaskScheduling(action);
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
          this.emitTaskById(action.taskId);
          return { ok: true, message: "已更新调度字段（priority/points）" };
        }
        case "task.switch":
        case "task.focus": {
          if (action.taskId === this.focusedTaskId) return { ok: true };
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          // P1-B：只切焦点，不停任何会话。
          this.setTask(action.taskId);
          // 把目标任务的会话/历史载入内存：启动时只恢复了当前任务，其它任务的会话
          // 在库里但不在内存里，不载入的话切换过去会是一张空会话列表。
          this.sessions.loadTaskSessions(action.taskId);
          // 切过去后重扫该任务的历史 flag 候选：候选只存在内存里。
          this.recoverTaskSignals(action.taskId);
          return { ok: true };
        }
        case "task.stopAll": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          const stopped = await this.stopTaskSessions(action.taskId);
          if (action.taskId === this.focusedTaskId) this.emitTask();
          return { ok: true, message: `已停止 ${stopped} 个会话（仅任务 ${row.title}）` };
        }
        case "task.archive": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          // P1-D：有非终态会话且未 force → 拒绝；force → 先停该任务全部非终态会话。
          const active = this.board
            .listSessions(action.taskId)
            .filter((s) => this.isActiveStatus(s.status));
          if (active.length > 0 && action.force !== true) {
            return {
              ok: false,
              error:
                `任务「${row.title}」仍有 ${active.length} 个活跃会话；` +
                `请先 task.stopAll，或显式 force=true`,
            };
          }
          if (action.force === true) {
            await this.stopTaskSessions(action.taskId);
            const remaining = await this.waitForTaskIdle(action.taskId);
            if (remaining > 0) {
              return {
                ok: false,
                error: `任务「${row.title}」仍有 ${remaining} 个会话未在超时内退出，未归档`,
              };
            }
          }
          // 板子只负责落库；若并发下又有会话进来，它会返回 requiresStop，不留下
          // “已归档但会话在跑”的脏状态。
          const archived = this.board.archiveTask(action.taskId, { force: action.force === true });
          if (!archived.ok) {
            return {
              ok: false,
              error: archived.error ?? `归档失败：${action.taskId}`,
            };
          }
          // 广播归档视图。因为渲染层 store 的 task.upsert 没有 taskId 过滤，
          // 这里必须在归档后重新推一次当前焦点（或切到新焦点），否则焦点会被
          // 归档任务覆盖。
          this.emitTaskView(action.taskId);
          if (this.focusedTaskId === action.taskId) {
            const next = this.board.listActiveTasks()[0]?.id ?? null;
            this.setTask(next); // next=null 时不发事件，快照 task 为 null（P1-E 处理看板）
          } else {
            this.emitTask();
          }
          return {
            ok: true,
            message:
              `已归档任务「${row.title}」` +
              `${active.length > 0 ? `（已停止 ${active.length} 个会话）` : ""}；` +
              `历史事实/会话保留（会话停止时租约按正常流程释放）`,
          };
        }
        case "task.setStatus": {
          const taskId = action.taskId || this.focusedTaskId;
          if (!taskId) return { ok: false, error: "没有活动任务" };
          this.board.setTaskStatus(taskId, action.status, action.answer);
          // P5-A：人工答案也写持久化候选；改回非 solved 时清空该任务候选/来源，
          // 保持 P1-C 的旧语义（不自动确认/提交）。
          if (action.status === "solved" && action.answer?.trim()) {
            const value = action.answer.trim();
            if (!this.board.getFlagCandidate(taskId, value)) {
              const { spec, specId } = this.answerSpecForTask(taskId);
              const answerType = spec.answerType ?? "text";
              const res = this.board.addFlagCandidate({
                taskId,
                value,
                sessionId: "human",
                witness: null,
                evidence: "E0",
                answerType,
                normalizedValue: canonicalAnswer(value, answerType),
                specId,
              });
              this.board.addFlagSource(res.candidate.id, {
                sessionId: "human",
                witness: null,
                evidence: "E0",
                sourceKind: "human",
              });
            }
          } else if (action.status !== "solved") {
            this.board.clearFlagCandidates(taskId);
          }
          // 只有焦点任务会真的推 task.upsert；后台任务只落库（见 emitTaskById）。
          this.emitTaskById(taskId);
          return { ok: true };
        }
        case "flag.confirm": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          const candidate = this.board.getFlagCandidateById(action.candidateId);
          if (!candidate || candidate.task_id !== action.taskId) {
            return {
              ok: false,
              error: `flag 候选不存在或不属于该任务：${action.candidateId}`,
            };
          }
          // P5-A 语义：已经 solved 且 answer 相同就只翻候选状态，不重复写 answer。
          // 这样「task.setStatus solved 生成 human 候选（status=new）→ flag.confirm」
          // 不会触发 clearFlagCandidates，也不会多一条 answer 事件。
          const alreadySolved = row.status === "solved" && row.answer === candidate.value;
          // 平台题只有 submitPlatformFlag 收到平台明确接受后才能 solved；
          // 本动作最多把候选标成 confirmed，不能把“本地确认”冒充平台通关。
          const platformTask = Boolean(this.platform?.challengeForTask(action.taskId));
          if (!platformTask && !alreadySolved) {
            this.board.setTaskStatus(action.taskId, "solved", candidate.value, "human");
          }
          // 保持 P5-A 的兜底：solved 时若答案不在候选里，补一条 human 候选。
          // confirm 的 candidate 一定存在，这里是防御性分支（竞态/手工数据）。
          if (!this.board.getFlagCandidate(action.taskId, candidate.value)) {
            const res = this.board.addFlagCandidate({
              taskId: action.taskId,
              value: candidate.value,
              sessionId: "human",
              witness: null,
              evidence: "E0",
            });
            this.board.addFlagSource(res.candidate.id, {
              sessionId: "human",
              witness: null,
              evidence: "E0",
            });
          }
          this.board.updateFlagCandidateStatus(candidate.id, "confirmed");
          // 焦点任务推 task.upsert（带 answer/status）；后台任务只落库。
          this.emitTaskById(action.taskId);
          this.emitFlags(action.taskId);
          return {
            ok: true,
            message: platformTask
              ? `已确认 flag 候选；平台题「${row.title}」仍需平台接受后才算 solved`
              : `已确认 flag 候选；任务「${row.title}」标记为已解出`,
          };
        }
        case "flag.reject": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          const candidate = this.board.getFlagCandidateById(action.candidateId);
          if (!candidate || candidate.task_id !== action.taskId) {
            return {
              ok: false,
              error: `flag 候选不存在或不属于该任务：${action.candidateId}`,
            };
          }
          // 只改候选状态；不写 task.answer、不改任务状态、不删除候选（保留审计）。
          this.board.updateFlagCandidateStatus(candidate.id, "false_positive");
          this.emitFlags(action.taskId);
          return { ok: true, message: `已标记候选为误报（任务「${row.title}」）` };
        }
        case "flag.export": {
          const format = action.format;
          if (format !== "md" && format !== "csv" && format !== "json") {
            return { ok: false, error: `format 非法：${String(format)}（允许：md, csv, json）` };
          }
          if (action.taskId !== undefined) {
            const row = this.board.getTask(action.taskId);
            if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
            if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          }
          const tasks = this.flagExportTasks(action.taskId);
          const count = tasks.reduce((n, t) => n + t.candidates.length, 0);
          const now = Date.now();
          const content =
            format === "md"
              ? exportFlagsMarkdown(tasks, now, count)
              : format === "csv"
                ? exportFlagsCsv(tasks)
                : exportFlagsJson(tasks, now, count);
          // 只记 format/count；不记导出内容/flag 明文。导出本身不写文件。
          this.board.recordFlagExport({ taskId: action.taskId ?? null, format, count });
          return {
            ok: true,
            message: `已生成 ${count} 条候选的 ${format} 导出`,
            content,
          };
        }
        case "awd.export":
        case "ir.export": {
          const format = action.format;
          if (format !== "md" && format !== "csv" && format !== "json") {
            return { ok: false, error: `format 非法：${String(format)}（允许：md, csv, json）` };
          }
          const taskId = action.taskId ?? this.focusedTaskId;
          if (!taskId) return { ok: false, error: "没有活动任务，无法导出" };
          const row = this.board.getTask(taskId);
          if (!row) return { ok: false, error: `任务不存在：${taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${taskId}` };
          if (action.type === "awd.export") {
            const view = this.awdViewForTask(taskId);
            if (!view) return { ok: false, error: `任务不是 AWD：${taskId}` };
            const content = exportAwd(view, format);
            const count =
              view.services.length +
              view.flags.reduce((n, g) => n + g.candidates.length, 0) +
              view.patches.length +
              view.checks.length +
              view.attacks.length;
            this.board.audit({
              sessionId: null,
              actor: "human",
              action: "awd.export",
              detail: { taskId, format, count },
            });
            return { ok: true, message: `已生成 AWD ${format} 导出（${count} 项）`, content };
          }
          const view = this.irViewForTask(taskId);
          if (!view) return { ok: false, error: `任务不是 IR：${taskId}` };
          const content = exportIr(view, format);
          const count = view.evidence.length + view.timeline.length + view.questions.length;
          this.board.audit({
            sessionId: null,
            actor: "human",
            action: "ir.export",
            detail: { taskId, format, count },
          });
          return { ok: true, message: `已生成 IR ${format} 导出（${count} 项）`, content };
        }
        case "flag.submit": {
          const row = this.board.getTask(action.taskId);
          if (!row) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          const candidate = this.board.getFlagCandidateById(action.candidateId);
          if (!candidate || candidate.task_id !== action.taskId) {
            return {
              ok: false,
              error: `flag 候选不存在或不属于该任务：${action.candidateId}`,
            };
          }
          // 运行时兜底：契约只允许 manual/dry_run；伪造的 command 必须可读拒绝。
          const mode = (action.mode ?? "manual") as string;
          if (mode === "command") {
            return { ok: false, error: "command 模式未实现（用户决策：WP6 评估前不做）" };
          }
          if (mode !== "manual" && mode !== "dry_run") {
            return { ok: false, error: `mode 非法：${mode}（允许：manual, dry_run）` };
          }
          if (candidate.status === "false_positive") {
            return { ok: false, error: "误报候选不能提交；请先重新确认为有效候选" };
          }
          if (mode === "dry_run") {
            // 只构造 argv 字符串数组：不启动进程、不写文件、不改候选状态。
            const argv = buildSubmitArgv(row, candidate.value);
            return {
              ok: true,
              mode: "dry_run",
              argv,
              message: "dry-run：只预览 argv，未执行、未写文件、未改候选状态",
            };
          }
          // manual：只记录人工提交时间；不执行命令、不调用平台 API。
          const submittedAt = Date.now();
          this.board.updateFlagSubmitStatus(candidate.id, "manual", submittedAt);
          this.emitFlags(action.taskId);
          return {
            ok: true,
            mode: "manual",
            value: candidate.value,
            instructions:
              "复制 flag 到比赛平台手动提交；本应用不会自动提交、不会调用平台 API。" +
              "提交后点『我已提交』记录时间。",
            message: "已记录人工提交时间",
          };
        }
        case "attachment.import": {
          const taskId = action.taskId || this.focusedTaskId;
          if (!taskId) return { ok: false, error: "没有活动任务，先建任务" };
          const row = this.board.getTask(taskId);
          if (!row) return { ok: false, error: `任务不存在：${taskId}` };
          if (row.archived) return { ok: false, error: `任务已归档：${taskId}` };
          const root = this.workDir ?? this.workspaceRoot;
          const res = await importAttachments({ workRoot: root, taskId, paths: action.paths });
          if (!res.ok) return { ok: false, error: res.error ?? "附件导入失败" };
          try {
            this.board.audit({
              sessionId: null,
              actor: "human",
              action: "attachment.import",
              detail: {
                taskId,
                files: res.imported?.length ?? 0,
                taskFileCount: res.taskFileCount ?? 0,
                taskTotalBytes: res.taskTotalBytes ?? 0,
                note: action.note ?? null,
              },
            });
          } catch {
            /* 审计失败不能回滚已成功的导入 */
          }
          // V2-P0-2：附件扫描走任务 AnswerSpec，命中生成**候选**（E1，带路径/行号/偏移）。
          // 扫描失败不能影响已成功的导入；二进制/无命中文件不写候选。
          const { spec, specId } = this.answerSpecForTask(taskId);
          const scanHits: Array<{
            relativePath: string;
            line?: number;
            offset?: number;
            answerType: string;
            normalizedValue: string;
            value: string;
          }> = [];
          const scanWarnings: Array<{ relativePath: string; warning: string }> = [];
          const taskDir = join(root, taskId);
          for (const file of res.imported ?? []) {
            try {
              const scan = await scanAttachmentAnswers({
                taskDir,
                relativePath: `attachments/${file.relativePath}`,
                spec,
              });
              if (scan.warning) {
                scanWarnings.push({ relativePath: `attachments/${file.relativePath}`, warning: scan.warning });
              }
              for (const hit of scan.hits) {
                scanHits.push({
                  relativePath: hit.relativePath,
                  ...(hit.line !== undefined ? { line: hit.line } : {}),
                  ...(hit.offset !== undefined ? { offset: hit.offset } : {}),
                  answerType: hit.answerType,
                  normalizedValue: hit.normalizedValue,
                  value: hit.value,
                });
              }
            } catch (err) {
              scanWarnings.push({
                relativePath: `attachments/${file.relativePath}`,
                warning: (err as Error).message,
              });
            }
          }
          for (const hit of scanHits) {
            this.noteFlagCandidate(taskId, hit.value, null, {
              evidence: "E1",
              answerType: hit.answerType as AnswerType,
              normalizedValue: hit.normalizedValue,
              specId,
              sourceKind: "attachment",
              sourcePath: hit.relativePath,
              line: hit.line ?? null,
              offset: hit.offset ?? null,
            });
          }
          if (scanHits.length > 0 || scanWarnings.length > 0) {
            try {
              // 审计只记数量/路径/类型，不写答案明文。
              this.board.audit({
                sessionId: null,
                actor: "system",
                action: "attachment.scan",
                detail: {
                  taskId,
                  hitCount: scanHits.length,
                  sourcePaths: [...new Set(scanHits.map((h) => h.relativePath))],
                  answerTypes: [...new Set(scanHits.map((h) => h.answerType))],
                  warnings: scanWarnings,
                },
              });
            } catch {
              /* 审计失败不能回滚已成功的导入 */
            }
          }
          // 只有焦点任务推增量；后台任务的清单等下次快照。
          this.emitTaskById(taskId);
          return {
            ok: true,
            message:
              `已导入 ${res.imported?.length ?? 0} 个文件到任务「${row.title}」的 attachments/` +
              `（该任务附件 ${res.taskFileCount ?? 0} 个 / ${res.taskTotalBytes ?? 0} 字节）`,
          };
        }
        case "artifact.refresh": {
          const taskId = action.taskId || this.focusedTaskId;
          if (!taskId) return { ok: false, error: "没有活动任务" };
          const row = this.board.getTask(taskId);
          if (!row) return { ok: false, error: `任务不存在：${taskId}` };
          const artifacts = this.taskArtifacts(taskId);
          // 后台任务也带 taskId 广播；渲染层只接受焦点任务的事件（P1-E 规则）。
          this.bus.emit({ type: "artifact.updated", taskId, artifacts });
          return { ok: true, message: `已刷新 ${artifacts.length} 个工件` };
        }
        case "target.add": {
          const res = this.board.addTarget({
            taskId: action.taskId,
            value: action.value,
            kind: action.kind,
            notes: action.notes,
          });
          if (!res.ok) return { ok: false, error: res.error ?? "目标添加失败" };
          // 焦点任务推 task.upsert（带 targets）；后台任务只落库，等切焦点后的快照。
          this.emitTaskById(action.taskId);
          return { ok: true, message: `已添加目标 ${action.value}` };
        }
        case "target.update": {
          const res = this.board.updateTarget({
            taskId: action.taskId,
            targetId: action.targetId,
            status: action.status,
            notes: action.notes,
          });
          if (!res.ok) return { ok: false, error: res.error ?? "目标更新失败" };
          this.emitTaskById(action.taskId);
          return { ok: true, message: "目标已更新" };
        }
        case "target.remove": {
          const res = this.board.removeTarget({
            taskId: action.taskId,
            targetId: action.targetId,
          });
          if (!res.ok) return { ok: false, error: res.error ?? "目标移除失败" };
          this.emitTaskById(action.taskId);
          return { ok: true, message: "目标已移除" };
        }
        case "session.start": {
          // P1-C：接受任意**存在且未归档**的任务，不再要求它是 UI 焦点。
          const taskId = action.taskId || this.focusedTaskId;
          if (!taskId) return { ok: false, error: "没有活动任务，先建任务" };
          const targetTask = this.board.getTask(taskId);
          if (!targetTask) return { ok: false, error: `任务不存在：${taskId}` };
          if (targetTask.archived) return { ok: false, error: `任务已归档：${taskId}` };
          // 配额在启动任何进程之前检查：每任务 3 / 全局 8（归档任务不占全局名额）。
          const quota = this.quotaError(taskId);
          if (quota) return { ok: false, error: quota };
          const spec = this.specProvider(action.agent);
          if (!spec) return { ok: false, error: `agent 不可用（未安装或适配器缺失）：${action.agent}` };
          // 一旦有人开始做题，任务栏就从「待解」变「解题中」（已解出/已放弃不覆盖）。
          // P1-C：改的是**目标任务**的状态，不是焦点任务。
          const startedFromOpen = targetTask.status === "open";
          if (startedFromOpen) {
            this.board.setTaskStatus(taskId, "solving");
            this.emitTaskById(taskId);
          }
          let rec: SessionRecord;
          try {
            rec = await this.sessions.startSession({
              taskId,
              spec,
              agent: action.agent,
              role: action.role,
              tier: action.tier,
              model: action.model ?? this.models[action.agent],
            });
          } catch (err) {
            // A3：启动失败（含握手超时）时，若这是唯一活跃会话，把**目标任务**退回
            // 「待解」——之前任务停在「解题中」却没有会话在跑。
            const active = this.sessions
              .listSessions(taskId)
              .some((s) => !["stopped", "failed", "blocked", "done"].includes(s.status));
            if (startedFromOpen && !active && this.board.getTask(taskId)?.status === "solving") {
              this.board.setTaskStatus(taskId, "open");
              this.emitTaskById(taskId);
            }
            return { ok: false, error: (err as Error).message };
          }
          // 用户显式勾选「全部放行」：给本会话发一条通配授权。
          // 必须在推出会话/发送简报之前生效，否则 agent 的第一条权限请求仍会弹审批。
          if (action.allowAll && this.permissions) {
            const grant = this.permissions.grantAll({
              agentId: rec.agent,
              sessionId: rec.id,
              scope: "session",
            });
            if (grant.ok) {
              this.board.audit({
                sessionId: rec.id,
                actor: "human",
                action: "permission.grant_all",
                detail: { scope: "session", agentId: rec.agent, sessions: [rec.id] },
              });
              this.publishPermissions();
            } else {
              this.publishStreamUpdate(rec.id, {
                ts: Date.now(),
                kind: "other",
                text: `全部放行授权失败：${grant.error ?? "未知错误"}`,
              });
            }
          }
          // R18：所有异步回调统一走 publish*，由 Hub 做任务过滤，禁止直接 bus.emit。
          this.publishSessionRec(rec);
          // 起完会话立刻把简报包发出去，这是 §7.3 的设计（迟到加入者靠简报而不是历史）
          void this.sessions
            .sendBriefing(rec.id)
            .then(() => {
              const latest = this.sessions.getSession(rec.id);
              if (latest) this.publishSessionRec(latest);
            })
            .catch((err: Error) =>
              this.publishStreamUpdate(rec.id, {
                ts: Date.now(),
                kind: "other",
                text: `简报注入失败：${err.message}`,
              }),
            );
          return { ok: true };
        }
        case "session.stop": {
          const rec = this.currentSession(action.sessionId);
          if (!rec) return { ok: false, error: `会话不属于当前任务或不存在：${action.sessionId}` };
          // 统一收尾：审批 → 进程 → session 授权 / 内存状态 / MCP token。
          await this.stopAndCleanup(rec);
          const latest = this.sessions.getSession(action.sessionId);
          if (latest) this.publishSessionRec(latest);
          return { ok: true };
        }
        case "session.remove": {
          const rec = this.currentSession(action.sessionId);
          if (!rec) return { ok: false, error: `会话不属于当前任务或不存在：${action.sessionId}` };
          // removeSession 内部会停进程；审批与授权清理放在同一套收尾里。
          this.approvals?.denyAllOf(action.sessionId);
          await this.sessions.removeSession(action.sessionId);
          this.onSessionTerminal(action.sessionId);
          // 渲染层据此把标签与窗格一并撤下；历史仍在库里（hub:history 不受影响）。
          this.bus.emit({ type: "session.removed", sessionId: action.sessionId, taskId: rec.taskId });
          return { ok: true };
        }
        case "session.prompt": {
          const rec = this.promptableSession(action.sessionId);
          if (!rec) {
            return { ok: false, error: `会话不存在或所属任务已归档：${action.sessionId}` };
          }
          if (["stopped", "failed", "blocked", "done"].includes(rec.status)) {
            return { ok: false, error: `会话已结束（${rec.status}），请新建会话` };
          }
          const queued = rec.status === "running" || rec.status === "waiting_approval";
          void this.sessions
            .prompt(action.sessionId, action.text)
            .then(() => {
              const latest = this.sessions.getSession(action.sessionId);
              if (latest) this.publishSessionRec(latest);
            })
            .catch((err: Error) =>
              this.publishStreamUpdate(action.sessionId, {
                ts: Date.now(),
                kind: "other",
                text: `prompt 失败：${err.message}`,
              }),
            );
          return {
            ok: true,
            message: queued ? "已排队：会在当前一轮结束后送达该会话" : undefined,
          };
        }
        case "session.interrupt": {
          const rec = this.currentSession(action.sessionId);
          if (!rec) return { ok: false, error: `会话不属于当前任务或不存在：${action.sessionId}` };
          if (!["running", "waiting_approval"].includes(rec.status)) {
            return { ok: false, error: "当前没有正在进行的推理" };
          }
          // 卡在审批里的「打断」必须同时清掉 pending 审批；否则 session/cancel 之后
          // 请求还挂着，agent 既不能继续也不会结束，排队提示也等不到。
          this.approvals?.denyAllOf(action.sessionId);
          this.sessions.interrupt(action.sessionId);
          return { ok: true, message: "已打断当前这一轮；已排队的提示会随后送达" };
        }
        case "session.setTier": {
          const rec = this.currentSession(action.sessionId);
          if (!rec) return { ok: false, error: `会话不存在或不属于当前任务：${action.sessionId}` };
          // 档位不只是策略判定：codex/dsh 的权限模式是在 spawn 时注入的（mode /
          // DSH_PERMISSION_MODE），运行中改策略只会造成「UI 显示已收紧、agent 仍不问」
          // 的假象。诚实返回不支持，比返回 ok:true 安全。
          return {
            ok: false,
            error: "运行中不支持切换档位：请在新建会话时选择档位（agent 侧权限模式在启动时注入）",
          };
        }
        case "approval.decide": {
          if (!this.approvals) return { ok: false, error: "审批队列未接入" };
          const decision = action.decision === "approve" ? "approved" : "denied";
          const before = this.approvals.get(action.approvalId);
          const ok = this.approvals.decide(action.approvalId, decision, action.remember);
          if (!ok) return { ok: false, error: `审批项不存在或已决：${action.approvalId}` };
          // 规则学习：人工放行 + 勾了"记住" → 落一条 allow 规则（§9.5）
          if (action.remember && decision === "approved" && before) {
            // 旧的会话级策略规则保留：即使授权文件读不出来，本次进程内仍能生效。
            this.policy?.rememberAllow(before.sessionId, before.action, before.command ?? "");
            const grant = this.rememberGrant(before, action.rememberScope === "agent" ? "agent" : "session");
            // 即使落盘失败，内存授权也可能已生效；无条件推一版，让 UI 与真实状态一致。
            this.publishPermissions();
            if (!grant.ok) {
              return { ok: true, message: grant.error };
            }
          }
          return { ok: true };
        }
        case "permission.revoke": {
          if (!this.permissions) return { ok: false, error: "授权存储未接入" };
          const n = this.permissions.revoke(action.agentId, action.grantId);
          this.publishPermissions();
          const persistWarning =
            n > 0 && this.permissions.persistError
              ? `；但写入授权文件失败：${this.permissions.persistError}（重启后可能恢复）`
              : "";
          return {
            ok: true,
            message: n > 0 ? `已撤销 ${n} 条授权${persistWarning}` : "没有找到匹配的授权",
          };
        }
        case "permission.grantAll": {
          if (!this.permissions) return { ok: false, error: "授权存储未接入" };
          // P1-B：action.taskId 只是契约透传；跨任务批量逻辑留 P1-E/后续，
          // 这里仍只按焦点任务取会话，避免一次误放后台任务。
          // 全局放行是持久化设置，不依赖当前任务；其余 scope 需要活动任务。
          if (action.scope !== "global" && !this.focusedTaskId) {
            return { ok: false, error: "没有活动任务" };
          }
          const isActive = (s: SessionRecord): boolean =>
            !["blocked", "stopped", "failed", "done"].includes(s.status);
          const taskSessions = this.focusedTaskId ? this.sessions.listSessions(this.focusedTaskId) : [];
          let targets: SessionRecord[] = [];
          let agentId = action.agentId ?? null;
          if (action.scope === "session") {
            const rec = action.sessionId ? this.currentSession(action.sessionId) : null;
            if (!rec) {
              return { ok: false, error: `会话不存在或不属于当前任务：${action.sessionId ?? "?"}` };
            }
            if (!isActive(rec)) {
              return { ok: false, error: `会话已结束（${rec.status}），不能授予全部放行` };
            }
            targets = [rec];
            agentId = rec.agent;
          } else if (action.scope === "agent") {
            if (!agentId) return { ok: false, error: "缺少 agentId" };
            targets = taskSessions.filter((s) => s.agent === agentId && isActive(s));
          } else {
            targets = taskSessions.filter(isActive);
          }
          const granted: string[] = [];
          const errors: string[] = [];
          if (action.scope === "agent" && agentId) {
            const r = this.permissions.grantAll({ agentId, scope: "agent" });
            // 落盘失败时内存授权已经生效，仍要推给 UI；错误单独返回给用户。
            if (r.grant) granted.push(`agent:${agentId}`);
            if (!r.ok) errors.push(r.error ?? "agent 全部放行失败");
          } else if (action.scope === "global") {
            const r = this.permissions.grantAll({ scope: "global" });
            if (r.grant) granted.push("global");
            if (!r.ok) errors.push(r.error ?? "全局全部放行失败");
          } else {
            for (const rec of targets) {
              const r = this.permissions.grantAll({
                agentId: rec.agent,
                sessionId: rec.id,
                scope: "session",
              });
              if (r.ok) granted.push(rec.id);
              else errors.push(`${rec.id}: ${r.error ?? "授权失败"}`);
            }
          }
          // 用户点的是「不再逐条」：已挂起的审批也一并放行。
          const targetIds = new Set(targets.map((s) => s.id));
          const pendingIds = (this.approvals?.list() ?? [])
            .filter((a) => a.status === "pending" && targetIds.has(a.sessionId))
            .map((a) => a.id);
          const approved = this.approvals?.bulk(pendingIds, "approved") ?? 0;
          this.board.audit({
            sessionId: action.scope === "session" ? action.sessionId ?? null : null,
            actor: "human",
            action: "permission.grant_all",
            detail: { scope: action.scope, agentId, sessions: targets.map((s) => s.id), approved },
          });
          if (granted.length) this.publishPermissions();
          const scopeText =
            action.scope === "agent"
              ? `agent=${agentId}`
              : action.scope === "global"
                ? "全局（所有 agent / 所有会话，重启后仍生效）"
                : `${granted.length} 个会话`;
          return {
            ok: errors.length === 0,
            error: errors.join("；") || undefined,
            message:
              `已全部放行（${scopeText}），同时放行 ${approved} 条待审批；` +
              `硬阻断与工作目录边界仍生效`,
          };
        }
        case "approval.bulk": {
          if (!this.approvals) return { ok: false, error: "审批队列未接入" };
          const n = this.approvals.bulk(
            action.ids,
            action.decision === "approve" ? "approved" : "denied",
          );
          return { ok: true, error: n === 0 ? "没有匹配的待批项" : undefined };
        }
        default:
          return { ok: false, error: `未知动作：${(action as { type: string }).type}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private specFor(agentId: string): AgentSpec | null {
    const found = installedAgents().find((a) => a.id === agentId);
    if (!found?.launch) return null;
    return {
      command: found.launch.command,
      args: found.launch.args,
      // spawn 的工作目录也只是兜底；真正的会话 cwd 由 SessionManager 统一设为 workDir
      cwd: this.workDir ?? this.workspaceRoot,
      label: found.id,
    };
  }

  /** 记下自述文本（审批卡中栏）并顺手识别 flag 候选。 */
  private ingestUpdate(sessionId: string, update: StreamUpdate): void {
    if (update.kind === "agent_message" || update.kind === "agent_thought") {
      const txt = update.text ?? "";
      if (txt.trim()) {
        const list = this.recentText.get(sessionId) ?? [];
        list.push(txt);
        if (list.length > 40) list.splice(0, list.length - 40);
        this.recentText.set(sessionId, list);
      }
      // 只在 agent_message（最终回复）里识别，思考过程的碎片容易拼出假答案。
      // R17：按会话累计后再扫，处理 flag{...} 跨 chunk 的情况。
      if (update.kind === "agent_message") {
        const rec = this.sessions.getSession(sessionId);
        const taskId = rec?.taskId ?? this.focusedTaskId;
        const prev = this.flagScanText.get(sessionId) ?? "";
        const next = (prev + txt).slice(-16_384);
        this.flagScanText.set(sessionId, next);
        const { spec, specId } = this.answerSpecForTask(taskId);
        // 流式文本只是候选：证据固定 E0；行号/偏移相对 16KB 窗口，不落库。
        for (const hit of detectAnswers(next, spec, { evidence: "E0", maxHits: 50 })) {
          this.noteFlagCandidate(taskId, hit.value, sessionId, {
            evidence: "E0",
            answerType: hit.answerType,
            normalizedValue: hit.normalizedValue,
            specId,
            sourceKind: "agent_message",
          });
        }
      }
    }
  }

  /**
   * 已知且未隐藏的会话（R18 fail-closed）。
   *
   * 未知 session 一律丢弃：生产路径里所有合法会话都先由 SessionManager 注册，
   * 放行未知 id 只会给跨任务/陈旧回调留后门。P1-B 允许后台任务事件继续推送，
   * 由渲染层按 taskId 丢弃非焦点事件。
   */
  private knownSession(sessionId: string): SessionRecord | null {
    const rec = this.sessions.getSession(sessionId);
    if (!rec || rec.hidden) return null;
    return rec;
  }

  /** 当前焦点任务内的会话；用于 dispatch 的跨任务防护。 */
  private currentSession(sessionId: string): SessionRecord | null {
    if (!this.focusedTaskId) return null;
    const rec = this.sessions.getSession(sessionId);
    if (!rec || rec.taskId !== this.focusedTaskId || rec.hidden) return null;
    return rec;
  }

  /**
   * P1-C：`session.prompt` 可作用于任意**非归档任务**的会话（不再要求焦点）。
   *
   * 只放宽 prompt：停止/打断/移除仍走 `currentSession`，避免“后台会话被一条
   * 陈旧 UI 消息误停”。批量的按任务停止用 `task.stopAll` / 收敛。
   */
  private promptableSession(sessionId: string): SessionRecord | null {
    const rec = this.sessions.getSession(sessionId);
    if (!rec || rec.hidden) return null;
    const task = this.board.getTask(rec.taskId);
    if (!task || task.archived) return null;
    return rec;
  }

  /**
   * 人工选择「本会话始终允许 / 对该 agent 永久允许」后写入授权。
   *
   * 只使用审批创建时由主进程算好的 category/highRisk/rememberable —— 渲染进程
   * 无法伪造这些字段（approval.decide 只传 approvalId 与 scope）。
   */
  private rememberGrant(
    view: ApprovalView,
    scope: "session" | "agent",
  ): { ok: boolean; error?: string } {
    if (!this.permissions) return { ok: false, error: "授权存储未接入" };
    if (!view.category) return { ok: false, error: "该审批项缺少操作类别，仅本次放行" };
    if (view.rememberable !== true) {
      return { ok: false, error: "高风险操作默认不支持一键放行；本次仅放行" };
    }
    const rec = this.sessions.getSession(view.sessionId);
    if (!rec) return { ok: false, error: "会话已结束，无法记住该授权" };
    const profile: OperationProfile = {
      category: view.category as OperationCategory,
      label: view.categoryLabel ?? view.category,
      risk: view.risk,
      highRisk: view.highRisk ?? false,
      allowlisted: false,
      rememberable: true,
      matchText: view.command ?? "",
    };
    const res = this.permissions.grant({
      agentId: rec.agent,
      sessionId: view.sessionId,
      scope,
      profile,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true };
  }

  /** 把最新授权列表推给渲染层（快照另外也会带一份，作为首屏数据源）。 */
  private publishPermissions(): void {
    if (!this.permissions) return;
    const valid = new Set(
      this.focusedTaskId ? this.sessions.listSessions(this.focusedTaskId).map((s) => s.id) : [],
    );
    this.bus.emit({ type: "permission.updated", grants: this.permissions.list(valid) });
  }

  publishStream(sessionId: string, raw: Record<string, unknown>): void {
    const rec = this.knownSession(sessionId);
    if (!rec) return;
    const update = normalizeUpdate(raw);
    if (!update) return;
    this.ingestUpdate(sessionId, update);
    this.bus.emit({ type: "session.stream", sessionId, taskId: rec.taskId, update });
  }

  publishStreamUpdate(sessionId: string, update: StreamUpdate): void {
    const rec = this.knownSession(sessionId);
    if (!rec) return;
    this.ingestUpdate(sessionId, update);
    this.bus.emit({ type: "session.stream", sessionId, taskId: rec.taskId, update });
  }

  publishHealth(sessionId: string): void {
    const rec = this.knownSession(sessionId);
    if (!rec) return;
    this.bus.emit({ type: "health", sessionId, taskId: rec.taskId, health: this.healthOf(sessionId) });
  }

  publishSessionRec(rec: SessionRecord): void {
    // P1-B：后台会话仍要推事件（带 taskId），由渲染层丢弃非焦点事件；
    // hidden（R20 已移除）的会话不发布，避免迟到回调把它画回 UI。
    if (rec.hidden) return;
    this.bus.emit({ type: "session.upsert", session: toSessionView(rec) });
  }

  /** 审批事件统一入口（P1-B：仍只推焦点任务；全局列表在快照 approvalsAll）。 */
  publishApproval(view: ApprovalView): void {
    if (this.focusedTaskId && view.taskId !== this.focusedTaskId) return;
    const taskTitle = this.board.getTask(view.taskId)?.title ?? null;
    // P4-C 批次 2：新字段只在队列/调用方提供时保留；旧视图缺省补 null，
    // 旧渲染层不读也不炸。快照 approvalsAll 直接来自队列，队列已填同样的字段。
    const approval: ApprovalView = {
      ...view,
      taskTitle,
      ruleId: view.ruleId ?? view.rule ?? null,
      scopeTarget: view.scopeTarget ?? null,
    };
    this.bus.emit({ type: "approval.upsert", approval });
  }

  /**
   * 把 `afterId` 之后的事件推给渲染层。返回本页读到的最大事件 id（空页返回 afterId）。
   *
   * 返回值的用途（A11 修复）：`readSinceForTask` 默认只读 200 条，调用方必须用
   * 返回值做游标、循环分页到排空为止——若直接推进到 `lastEventId()`，
   * 一次积压超 200 条时中间的台账/flag 候选会被永久跳过。
   */
  publishBoardSince(afterId: number): number {
    // P1-B：台账仍只推焦点任务；后台任务的事件留在库里，切过去后重新按任务读。
    const rawRows = this.focusedTaskId
      ? this.board.readSinceForTask(afterId, this.focusedTaskId)
      : this.board.readSince(afterId);
    // 黑板事实上报了 flag → 任务栏显示候选，但**不**自动判 solved。
    for (const row of rawRows) {
      if (row.kind !== "fact" && row.kind !== "deadend") continue;
      if (row.session_id) this.markProgress(row.session_id);
      if (row.kind !== "fact") continue;
      if (this.focusedTaskId && row.subject !== this.focusedTaskId) continue;
      try {
        const body = JSON.parse(row.body) as { content?: unknown; evidence?: unknown };
        const taskId = row.subject ?? this.focusedTaskId;
        const { spec, specId } = this.answerSpecForTask(taskId);
        const evidence = (
          body.evidence === "E2" ? "E2" : body.evidence === "E1" ? "E1" : row.witness ? "E1" : "E0"
        ) as "E0" | "E1" | "E2";
        for (const hit of detectAnswers(
          typeof body.content === "string" ? body.content : null,
          spec,
          { evidence, maxHits: 50 },
        )) {
          this.noteFlagCandidate(taskId, hit.value, row.session_id, {
            witness: row.witness,
            evidence,
            answerType: hit.answerType,
            normalizedValue: hit.normalizedValue,
            specId,
            sourceKind: "fact",
            sourcePath: row.witness,
          });
        }
      } catch {
        /* body 不是 JSON：忽略 */
      }
    }
    const rows = rawRows.map(toBoardEvent);
    if (rows.length) {
      this.bus.emit({ type: "board.appended", taskId: this.focusedTaskId ?? undefined, events: rows });
    }
    return rows.length ? (rawRows[rawRows.length - 1]?.id ?? afterId) : afterId;
  }
}
