/**
 * 会话管理器 —— 架构文档 §7。
 *
 * M1 范围：任务创建、会话起停、简报包注入、扇出、崩溃清理。
 * 不含 UI，策略引擎为 passthrough 占位（§12 里程碑表）。
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { AcpClient, type AgentSpec } from "../acp/client.ts";
import type { Blackboard } from "../blackboard/board.ts";
import type { Policy, PolicyDecisionRecord } from "../policy/policy.ts";
import type { ScopeConfig } from "../config/loader.ts";
import { buildBriefing, renderBriefingPrompt, type BriefingPacket } from "../briefing/build.ts";
import type { SkillRuntime } from "../skill/index.ts";
import type { BoardBridge } from "../mcp-host/bridge.ts";
import type { ProcessRegistry } from "../reliability/process-registry.ts";
import type { StreamUpdate, TargetView } from "../../../../../packages/shared-protocol/events.ts";
import { normalizeUpdate, redactSecrets } from "../stream/normalize.ts";

/** 每个会话最多回放多少条历史（防止一次重启把几万条 wire 事件全读进内存）。 */
const MAX_HISTORY = 2000;
/** 重启时最多恢复多少个历史会话（同一任务）。 */
const MAX_RESTORE = 20;
/** 终态：不再接受新 prompt，也不能被 prompt 结束时的 idle 覆盖。 */
const TERMINAL_STATUSES = ["blocked", "stopped", "failed", "done"];
/**
 * 正常退出的总预算（R18）。
 * close 与 waitForExit 共用这一个 deadline，绝不允许「close 等 3s，再额外等 3s」。
 */
const SHUTDOWN_BUDGET_MS = 4000;

/**
 * P4-C：把一次策略判定写进黑板 `events`（kind=note）+ audit 索引。
 *
 * 用现有的 board.note，不改 board schema：event body 是 `{text:"policy.decision {json}"}`，
 * JSON 里含 target/rule/verdict/inScope/scopeEnabled，足以回答“为什么放行/拦截”。
 * 刻意不写命令全文，避免 flag/token 进事件链。
 */
export function writePolicyAudit(
  board: Blackboard,
  taskId: string,
  record: PolicyDecisionRecord,
): void {
  const payload = {
    action: record.action,
    rule: record.rule,
    verdict: record.verdict,
    reason: record.reason,
    target: record.target,
    inScope: record.inScope,
    scopeEnabled: record.scopeEnabled,
    allowedActions: record.allowedActions ?? [],
  };
  board.note({
    taskId,
    sessionId: record.sessionId,
    text: `policy.decision ${JSON.stringify(payload)}`,
  });
}

/**
 * P4-D 批次 2：只把代理 env 放进**这次会话的 spawn env**，绝不修改
 * `process.env`。代理未启用/未启动（url=null）时返回空对象，会话照常启动。
 */
export function proxyEnvForSession(
  scope: ScopeConfig | undefined,
  url: string | null,
): Record<string, string> {
  if (scope?.proxy?.enabled !== true || !url) return {};
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: "",
  };
}

export interface ShutdownResult {
  /** 所有带进程的会话都确认退出了 */
  allExited: boolean;
  /** 有会话在总预算内没有退出 */
  timedOut: boolean;
  /** 超时后由 SessionManager 强制收尾的会话（不会再触碰已关闭的黑板） */
  pendingSessions: string[];
  /** close 请求失败/超时的明细；不会被静默吞掉 */
  closeErrors: Array<{ sessionId: string; message: string }>;
}

export interface SessionRecord {
  id: string;
  taskId: string;
  agent: string;
  role: string;
  tier: string;
  acpSession: string | null;
  /** agent 进程 pid（契约 SessionView.pid；重启后从库里恢复） */
  pid?: number | null;
  status: string;
  toolCalls: number;
  lastBoardReadAt: number;
  boardReads: number;
  expectedExit: boolean;
  /** 会话级模型覆盖；null 表示用 agent 默认 */
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  /** 因策略拦截被主动终止（§9.6）。用来和"崩溃"区分开 */
  blocked?: boolean;
  /** P7-B：MCP 子进程异常断开；独立字段，不改 session.status。 */
  mcpUnavailable?: boolean;
  /**
   * 关标签移除标记（R20 session.remove）：只隐藏、不删除。
   * 记录留在内存里是为了让迟到的 exit/流回调还能正常收尾落库，
   * 但 `listSessions` 与 Hub 的发布路径都会把它过滤掉。
   */
  hidden?: boolean;
}

export interface StartSessionInput {
  taskId: string;
  spec: AgentSpec;
  agent: string;
  role: string;
  tier: "autonomous" | "guarded";
  /** 会话级模型覆盖；不传就用 agent 自己的默认（可能落在需要登录的模型上） */
  model?: string;
}

export class SessionManager {
  private board: Blackboard;
  private bridge: BoardBridge;
  private policy: Policy;
  /** P4-C：范围策略配置（关闭时不提取目标）。 */
  private scope?: ScopeConfig;
  /** P4-D：按会话签发代理 URL；未启用/启动失败时返回 null（不注入 env）。 */
  private proxyUrlForSession?: (sessionId: string, taskId: string) => string | null;
  /**
   * R18 生命周期闸门。
   * finalizing：超时收尾进行中，迟到的 exit 不得再走常规 onAgentExit（避免与收尾交叉写）。
   * disposed：收尾已完成，任何迟到 exit 一律不得再访问 board。
   */
  private finalizing = false;
  private disposed = false;
  private shutdownPromise: Promise<ShutdownResult> | null = null;
  private shutdownResult: ShutdownResult | null = null;
  private workspaceRoot: string;
  /** agent 唯一可写根目录（R16）。会话 cwd 与聊天产物都落在它下面。 */
  private workRoot: string;
  private sessions = new Map<string, SessionRecord>();
  private clients = new Map<string, AcpClient>();
  private seq = 0;
  private briefings = new Map<string, BriefingPacket>();
  private onLine: (line: string) => void;
  private wireLogs = new Map<string, WriteStream>();
  /**
   * 对话历史（R16）。
   *
   * - `streamHistories`：内存里的归一化事件，`history()` 直接返回它；
   * - `streamSeqs`：每会话单调序号，重启后回放与实时事件用 seq 去重；
   * - `streamLogs`：`sessions/<id>/stream.jsonl` 追加写，重启后优先读它；
   * - `promptChains`：人工提示按会话串行，避免 ACP 并发 prompt。
   */
  private streamHistories = new Map<string, StreamUpdate[]>();
  private streamSeqs = new Map<string, number>();
  private streamLogs = new Map<string, WriteStream>();
  private promptChains = new Map<string, Promise<unknown>>();
  /**
   * `toolCallId → 动作名`（T14）。
   *
   * dsh 的 `session/request_permission` **只带 toolCallId**，没有 title / kind，
   * 于是审批卡会渲染成「未命名工具调用」。而它前面那条 `tool_call` update 是带
   * 工具名的 —— 在这里按 toolCallId 关联起来，审批时把名字补进 detail.title，
   * 渲染层不用改就有可读的卡片（契约也不用动：`ApprovalView.command` 直接吃 title）。
   */
  private toolTitles = new Map<string, string>();
  /**
   * 正在等待人工审批的请求数（R17）。
   *
   * 审批等待期会话必须是 `waiting_approval`，而不是继续显示 `running`；并发审批
   * 用计数而不是布尔，避免第一个放行就把状态提前改回 running。
   */
  private approvalDepth = new Map<string, number>();

  constructor(opts: {
    board: Blackboard;
    bridge: BoardBridge;
    policy: Policy;
    /** P4-C：范围策略配置；缺席时关闭，AcpClient 不提取目标。 */
    scope?: ScopeConfig;
    /** P4-D：代理 URL 提供者；只在 config proxy.enabled 时调用。 */
    proxyUrlForSession?: (sessionId: string, taskId: string) => string | null;
    workspaceRoot: string;
    /** agent 唯一可写根目录；不传时退化为 workspaceRoot（兼容旧脚本） */
    workRoot?: string;
    onLine?: (line: string) => void;
    /** 旧观测钩子：直接把 ACP 原始 update 交给 Hub（验证脚本仍在用） */
    onStream?: (sessionId: string, rawUpdate: Record<string, unknown>) => void;
    /**
     * 新观测钩子：归一化且已分配 seq 的 update（生产路径）。
     * 与 onStream 二选一：传了它就不再调用 onStream，避免同一事件被推两遍。
     */
    onStreamUpdate?: (sessionId: string, update: StreamUpdate) => void;
    /** 观测钩子：会话状态变化时通知 Hub */
    onSessionChange?: (rec: SessionRecord) => void;
    /** 唯一的事前闸门：策略判定为 approve 时向人工要放行 */
    onApprovalRequired?: (
      sessionId: string,
      taskId: string,
      detail: Record<string, unknown>,
      decision: { rule: string; reason: string },
      action: string,
    ) => Promise<boolean>;
    /** R18 故障注入：替换真实 kill（只给确定性回调用） */
    killHook?: (sessionId: string) => void;
    /** 会话进入终态后的统一清理回调（Hub 注入：审批 / 授权 / 内存状态） */
    onSessionTerminal?: (sessionId: string) => void;
    /** P7-B：进程登记（PID + OS 启动时间；启动 stale 清理/退出清理）。 */
    processRegistry?: ProcessRegistry;
    /** P7-B：MCP 子进程异常断开时通知（主进程广播 mcp.unavailable）。 */
    onMcpUnavailable?: (sessionId: string, taskId: string) => void;
    /**
     * P2-B：技能库运行期状态。传入后：
     *  - 首次 startSession 触发 ensureIndex()（懒构建；构建失败只记日志，不阻断会话）；
     *  - 启动会话时把 BUMIMANG_SKILL_DIR / BUMIMANG_SKILL_MCP 注入 MCP 子进程 env；
     *  - 简报按 task.category + role 注入 playbook/skill_routing/knowledge_tools。
     */
    skill?: SkillRuntime;
    /** P2-B：技能 MCP 注册模式；默认 auto。未配置技能库时强制 off。 */
    skillMcpMode?: "auto" | "on" | "off";
  }) {
    this.board = opts.board;
    this.bridge = opts.bridge;
    this.policy = opts.policy;
    this.scope = opts.scope;
    this.proxyUrlForSession = opts.proxyUrlForSession;
    this.workspaceRoot = opts.workspaceRoot;
    this.workRoot = opts.workRoot ?? opts.workspaceRoot;
    this.onLine = opts.onLine ?? ((l) => process.stdout.write(`${l}\n`));
    this.onStream = opts.onStream;
    this.onStreamUpdate = opts.onStreamUpdate;
    this.onSessionChange = opts.onSessionChange;
    this.onApprovalRequired = opts.onApprovalRequired;
    this.killHook = opts.killHook;
    this.onSessionTerminal = opts.onSessionTerminal;
    this.processRegistry = opts.processRegistry;
    this.onMcpUnavailable = opts.onMcpUnavailable;
    this.skill = opts.skill;
    this.skillMcpMode = opts.skillMcpMode ?? "auto";
  }

  private onStream?: (sessionId: string, rawUpdate: Record<string, unknown>) => void;
  private onStreamUpdate?: (sessionId: string, update: StreamUpdate) => void;
  private onSessionChange?: (rec: SessionRecord) => void;
  private onApprovalRequired?: (
    sessionId: string,
    taskId: string,
    detail: Record<string, unknown>,
    decision: { rule: string; reason: string },
    action: string,
  ) => Promise<boolean>;
  private killHook?: (sessionId: string) => void;
  private processRegistry?: ProcessRegistry;
  private onMcpUnavailable?: (sessionId: string, taskId: string) => void;
  private onSessionTerminal?: (sessionId: string) => void;
  /** P2-B：技能库运行期状态（可缺席；缺席时 MCP env 写 off，简报写“无技能库”）。 */
  private skill?: SkillRuntime;
  private skillMcpMode: "auto" | "on" | "off";

  /**
   * 会话终态的统一清理：MCP token、审批深度、工具名缓存，并通知 Hub 清审批/授权。
   * 幂等；stop / remove / 崩溃 / 策略终止 / 启动回滚都会走这里。
   */
  private notifyTerminal(sessionId: string): void {
    for (const k of [...this.toolTitles.keys()]) {
      if (k.startsWith(`${sessionId}::`)) this.toolTitles.delete(k);
    }
    this.approvalDepth.delete(sessionId);
    // 撤销该会话的 MCP 令牌并断开已认证的管道：即使 taskkill /T 之后仍有
    // MCP 子进程残留，它也无法再写黑板（审查 P2）。
    this.bridge?.revokeSession?.(sessionId);
    try {
      this.onSessionTerminal?.(sessionId);
    } catch {
      /* Hub 清理失败不能反过来影响进程收尾 */
    }
  }

  log(line: string): void {
    this.onLine(line);
  }

  getBriefing(sessionId: string): BriefingPacket | undefined {
    return this.briefings.get(sessionId);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** 诊断/验收：当前仍打开的 wire.jsonl 句柄数。 */
  get openWireLogCount(): number {
    return this.wireLogs.size;
  }

  /** 诊断/验收：是否已完成退出收尾（迟到 exit 不再触碰 board）。 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  listSessions(taskId?: string): SessionRecord[] {
    const all = [...this.sessions.values()].filter((s) => !s.hidden);
    return taskId ? all.filter((s) => s.taskId === taskId) : all;
  }

  /** 记一条 tool_call 的动作名，供审批卡按 toolCallId 取名（T14；见 toolTitles 的注释） */
  private rememberToolTitle(sessionId: string, upd: Record<string, unknown>): void {
    const kind = String(upd.sessionUpdate ?? "");
    if (kind !== "tool_call" && kind !== "tool_call_update") return;
    const id = upd.toolCallId;
    const title = upd.title;
    if (typeof id !== "string" || !id || typeof title !== "string" || !title) return;
    this.toolTitles.set(`${sessionId}::${id}`, title);
    // 长会话会推上百条 tool_call，给个上限免得无界增长（Map 保序，删最早的一批）
    if (this.toolTitles.size > 5000) {
      let n = 1000;
      for (const k of this.toolTitles.keys()) {
        if (n-- <= 0) break;
        this.toolTitles.delete(k);
      }
    }
  }

  /**
   * 审批 detail 的动作名补全：dsh 的权限请求只有 toolCallId，用它查出前面那条
   * `tool_call` 的名字。/ 已有真名（claude / opencode / codex 都会带 title）时原样返回。
   */
  private withToolTitle(sessionId: string, detail: Record<string, unknown>): Record<string, unknown> {
    const id = detail.toolCallId;
    if (typeof id !== "string") return detail;
    const remembered = this.toolTitles.get(`${sessionId}::${id}`);
    if (!remembered) return detail;
    const current = typeof detail.title === "string" ? detail.title : "";
    const hasName = typeof detail.toolName === "string" && detail.toolName.trim().length > 0;
    if (current && current !== "未命名工具调用") {
      // 标题已经可读（claude/opencode），但规则引擎还需要结构化工具名。
      // 原生 toolName 优先；没有就用 tool_call update 里记住的名字。
      return hasName ? detail : { ...detail, toolName: remembered };
    }
    // 从 tool_call update 补全的名字就是该工具的结构化身份；同时写 toolName，
    // 让 allow 规则走 tool_regex 而不是匹配自由文本。
    return { ...detail, title: remembered, toolName: remembered, titleFrom: "tool_call" };
  }

  /** 审批开始：会话进入 waiting_approval（并发审批按深度计数）。 */
  private beginApproval(sessionId: string): void {
    const depth = (this.approvalDepth.get(sessionId) ?? 0) + 1;
    this.approvalDepth.set(sessionId, depth);
    const rec = this.sessions.get(sessionId);
    if (!rec || TERMINAL_STATUSES.includes(rec.status) || rec.status === "waiting_approval") return;
    rec.status = "waiting_approval";
    this.board.setSessionStatus(sessionId, "waiting_approval");
    this.onSessionChange?.(rec);
  }

  /** 审批结束：只有所有并发审批都结束时才回到 running；终态优先。 */
  private endApproval(sessionId: string): void {
    const depth = (this.approvalDepth.get(sessionId) ?? 1) - 1;
    if (depth > 0) {
      this.approvalDepth.set(sessionId, depth);
      return;
    }
    this.approvalDepth.delete(sessionId);
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.status !== "waiting_approval") return;
    rec.status = "running";
    this.board.setSessionStatus(sessionId, "running");
    this.onSessionChange?.(rec);
  }

  /** 起一个会话：spawn agent → initialize → session/new（带上黑板的 MCP 入口）。 */
  async startSession(input: StartSessionInput): Promise<SessionRecord> {
    // 序号从库里算，避免跨进程撞主键（见 Blackboard.maxSessionSeq 的说明）
    this.seq = Math.max(this.seq, this.board.maxSessionSeq()) + 1;
    const sessionId = `s${this.seq}`;
    const sessionDir = join(this.workspaceRoot, "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    // R27（A1）：任务专属工作目录 <workRoot>/<taskId>——同任务多会话共享、跨任务隔离。
    // 之前所有任务的会话共用同一个 work 根，A 任务的脚本/产物/witness 会互相可见甚至覆盖。
    const taskWork = join(this.workRoot, input.taskId);
    mkdirSync(taskWork, { recursive: true });
    this.wireLogs.set(
      sessionId,
      createWriteStream(join(sessionDir, "wire.jsonl"), { flags: "a" }),
    );
    // R16：对话历史单独落盘。它是归一化后的 UI 事件，和 wire.jsonl 的原始协议日志分开：
    // 前者用于重启后恢复对话，后者用于排障与证据。
    this.streamLogs.set(
      sessionId,
      createWriteStream(join(sessionDir, "stream.jsonl"), { flags: "a" }),
    );

    const rec: SessionRecord = {
      id: sessionId,
      taskId: input.taskId,
      agent: input.agent,
      role: input.role,
      tier: input.tier,
      acpSession: null,
      status: "starting",
      toolCalls: 0,
      lastBoardReadAt: 0,
      boardReads: 0,
      expectedExit: false,
      model: input.model ?? null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.sessions.set(sessionId, rec);
    this.board.insertSession({
      id: sessionId,
      taskId: input.taskId,
      agent: input.agent,
      role: input.role,
      tier: input.tier,
      status: "starting",
    });

    // §4.2 步骤 1/2：主进程生成令牌与配置，agent 作为 MCP 客户端再拉起 MCP 子进程
    // P2-B：首次会话启动触发技能索引懒构建（不阻断会话；技能库扫描只在首次发生）。
    const skillRoot = this.skill?.root ?? null;
    const skillMcpMode: "auto" | "on" | "off" = skillRoot ? this.skillMcpMode : "off";
    if (this.skill && skillRoot) {
      try {
        this.skill.ensureIndex();
      } catch (err) {
        this.log(`[${sessionId}] 技能索引构建失败（会话继续）：${(err as Error).message}`);
      }
    }
    const mcpEntry = {
      name: "blackboard",
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "mcp-host", "server.ts")],
      env: [
        // 关键：在 Electron 主进程里 process.execPath 是 **electron.exe**，不是 node。
        // 直接拿它去跑 stdio MCP 服务器会起不来（agent 侧连不上，Lane B 实测 claude
        // 为此花了一整轮简报去逆向排障，见 BLOCKED L-3）。
        // ELECTRON_RUN_AS_NODE=1 让同一个二进制以纯 Node 形态运行 —— 这样打包后
        // 也不依赖队友机器上装没装 node（符合 C8）。
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "BUMIMANG_WORKDIR", value: taskWork },
        // P2-B：技能库状态注入给 MCP 子进程；未配置时 off（不注册 skill_*，避免假工具）。
        ...(skillRoot ? [{ name: "BUMIMANG_SKILL_DIR", value: skillRoot }] : []),
        { name: "BUMIMANG_SKILL_MCP", value: skillMcpMode },
        ...this.bridge.envForSession(sessionId, input.taskId),
      ],
    };

    /**
     * 按会话武装权限闸门 —— 都只在 spawn 时注入环境变量，不碰任何 agent 的配置文件。
     *
     * opencode（B-3）：实测（apps/desktop/src/cli/verify-arm-opencode.ts）它默认不问，
     * 但只要配置里有 `permission.edit/bash = "ask"` 就会发 `session/request_permission`。
     * `OPENCODE_CONFIG_CONTENT` 能在**运行时按会话注入**这段配置——不写用户的
     * `~/.config/opencode/opencode.jsonc`，也不需要在仓库里放文件。关掉：`BUMIMANG_ARM_OPENCODE=off`。
     *
     * dsh（T14）：实测（apps/desktop/src/cli/verify-dsh-live.ts）它默认 `workspace-write`
     * 不问（写工作区内的文件 request_permission=0，文件真被写）；起服务时给
     * `DSH_PERMISSION_MODE=read-only` 就会问（request_permission=1，选项 allow-once/reject-once）。
     * 所以档位映射与 codex 同构：guarded → read-only；autonomous 保持它的默认 workspace-write
     * （沙箱仍封在工作区，只是人不拦）。关掉：`BUMIMANG_ARM_DSH=off`。
     */
    const sessionEnv: Record<string, string> = {};
    if (input.agent === "opencode" && (process.env.BUMIMANG_ARM_OPENCODE ?? "on") !== "off") {
      sessionEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        permission: { edit: "ask", bash: "ask" },
      });
    }
    if (input.agent === "dsh" && (process.env.BUMIMANG_ARM_DSH ?? "on") !== "off") {
      sessionEnv.DSH_PERMISSION_MODE = input.tier === "guarded" ? "read-only" : "workspace-write";
    }
    // P4-D：代理 env 只加进本次会话的 spawn env；不碰 process.env。
    // provider 返回 null（未启动/启动失败）时不注入，会话照常启动。
    let proxyUrl: string | null = null;
    if (this.scope?.proxy?.enabled === true && this.proxyUrlForSession) {
      try {
        proxyUrl = this.proxyUrlForSession(sessionId, input.taskId);
      } catch (err) {
        this.log(`[${sessionId}] 代理 URL 获取失败（会话继续）：${(err as Error).message}`);
      }
    }
    const proxyEnv = proxyEnvForSession(this.scope, proxyUrl);
    Object.assign(sessionEnv, proxyEnv);
    if (Object.keys(proxyEnv).length > 0) {
      this.log(`[${sessionId}] 本地范围代理已注入会话 env（仅本会话进程，不污染主进程）`);
    }
    const spec: AgentSpec = Object.keys(sessionEnv).length
      ? { ...input.spec, env: { ...(input.spec.env ?? {}), ...sessionEnv } }
      : input.spec;
    if (sessionEnv.DSH_PERMISSION_MODE) {
      this.log(
        `[${sessionId}] dsh 闸门已武装：DSH_PERMISSION_MODE=${sessionEnv.DSH_PERMISSION_MODE}（${input.tier} 档）`,
      );
    }

    // A3：从 spawn 到握手全过程的失败（含超时）都要回滚，不能留幽灵会话。
    let client: AcpClient | null = null;
    try {
    client = AcpClient.spawn(spec, {
      policy: this.policy,
      sessionId,
      tier: input.tier,
      // P4-C：scope 关闭时 AcpClient 不调用 getScopeTargets，也不做目标提取。
      scope: this.scope,
      taskId: input.taskId,
      getScopeTargets: () => {
        const scopeRow = this.board.getTaskScope(input.taskId);
        const targets = this.board.listTargets(input.taskId).map(
          (t): TargetView => ({
            id: t.id,
            taskId: t.task_id,
            value: t.value,
            kind: t.kind as TargetView["kind"],
            status: t.status as TargetView["status"],
            notes: t.notes,
            createdAt: t.created_at,
          }),
        );
        return {
          targets,
          denyTargets: scopeRow?.denyTargets ?? [],
          allowedActions: scopeRow?.allowedActions ?? [],
        };
      },
      workRoot: taskWork,
      /**
       * 关键（R16 修的 codex 根因）：工具名补全必须在策略判定**之前**。
       * codex 的权限请求只带 toolCallId；补全后 `mcp.blackboard.blackboard_read_since`
       * 才能命中 competition 包里置顶的「黑板工具内部状态」放行规则。
       */
      enrichDetail: (detail) => this.withToolTitle(sessionId, detail),
      killImpl: this.killHook ? () => this.killHook!(sessionId) : undefined,
      // P7-B：killTree 前校验 PID + OS 启动时间，避免 PID 复用误杀。
      killGuard: this.processRegistry
        ? (pid: number) => this.processRegistry!.isPidCurrent(pid)
        : undefined,
      onApprovalRequired: async (detail, decision, action) => {
        this.beginApproval(sessionId);
        try {
          return this.onApprovalRequired
            ? await this.onApprovalRequired(sessionId, input.taskId, detail, decision, action)
            : false;
        } finally {
          this.endApproval(sessionId);
        }
      },
      log: (entry) => {
        // 全量线日志落盘：M1 之后要能回答"agent 到底把哪些动作委托给了我们"
        // R25（A7）：简报携带的 mcpServers env 会出现在 out 消息里，令牌必须先脱敏。
        this.wireLogs.get(sessionId)?.write(redactSecrets(JSON.stringify(entry)) + "\n");
        if (entry.dir !== "in") return;
        const m = entry.message as Record<string, unknown>;
        if (m.method !== "session/update") return;
        const upd = (m.params as Record<string, unknown>)?.update as
          | Record<string, unknown>
          | undefined;
        // 只数新建的工具调用（tool_call）；tool_call_update 是同一次调用的进度推送，
        // 数进去会让 §7.4 的同步健康度指标失真。
        if (upd?.sessionUpdate === "tool_call") {
          rec.toolCalls += 1;
          this.board.countToolCalls(sessionId);
          this.onSessionChange?.(rec);
        }
      },
      onUpdate: (params) => {
        const upd = (params.update ?? params) as Record<string, unknown>;
        this.rememberToolTitle(sessionId, upd);
        const normalized = normalizeUpdate(upd);
        if (normalized) {
          // 生产路径：落盘 + 带 seq 推给 Hub。验证脚本没传 onStreamUpdate，
          // 仍走老的 raw 入口（保持既有套件行为）。
          this.appendStream(sessionId, normalized);
          if (!this.onStreamUpdate) this.onStream?.(sessionId, upd);
        } else {
          this.onStream?.(sessionId, upd);
        }
      },
      onExit: (code, signal) => {
        void this.onAgentExit(sessionId, code, signal);
      },
    });
    this.clients.set(sessionId, client);
    rec.pid = client.pid ?? null;
    // P7-B：agent 进程（含其拉起的 MCP 树）登记；stale 清理按 PID+OS 启动时间校验。
    this.processRegistry?.registerPid(rec.pid, "agent", {
      taskId: rec.taskId,
      sessionId,
    }, rec.startedAt);

    const initRes = (await this.withStartupDeadline(client.initialize(), sessionId, "initialize")) as {
      protocolVersion: number;
      agentInfo?: Record<string, unknown>;
    };
    this.log(
      `[${sessionId}] initialize -> protocolVersion=${initRes.protocolVersion} agent=${JSON.stringify(initRes.agentInfo ?? {})}`,
    );

    /**
     * 会话 cwd = 工作目录（R16），不再是 `workspace/sessions/<id>`。
     *
     * 这一条同时解决三件事：
     *  1. 所有 agent 的相对路径产物都落在 `work/` 下（用户明确要求）；
     *  2. codex 的 workspace-write / dsh 的 workspace-write 沙箱根 = 这个 cwd；
     *  3. 多个会话共享同一道题的文件（队友写的脚本，另一个会话能直接看到）。
     * 运行时状态（wire/stream 日志、board.db）仍在 `workspace/sessions/<id>`，不混在一起。
     */
    const skillsDir = join(homedir(), ".agents", "skills");
    const additionalDirectories =
      input.agent === "codex" && existsSync(skillsDir) ? [skillsDir] : undefined;
    const newRes = await this.withStartupDeadline(
      client.newSession({
        cwd: taskWork,
        mcpServers: [mcpEntry],
        additionalDirectories,
      }),
      sessionId,
      "session/new",
    );
    rec.acpSession = newRes.sessionId;

    // 会话级模型选择：agent 在 configOptions 里声明可选值，我们挑一个真能用的。
    // 这一步是必要的 —— 否则会落在 agent 的默认模型上，而那个可能需要它自家登录。
    if (input.model) {
      const res = (newRes as Record<string, unknown>).configOptions as
        | Array<{
            id: string;
            type?: string;
            currentValue?: unknown;
            options?: Array<{ value: string; name: string }>;
          }>
        | undefined;
      const modelOpt = res?.find((o) => o.id === "model");
      const available = (modelOpt?.options ?? []).map((o) => o.value);
      if (modelOpt && available.includes(input.model)) {
        await this.withStartupDeadline(
          client.setConfigOption({
            sessionId: rec.acpSession,
            configId: "model",
            value: input.model,
          }),
          sessionId,
          "session/set_config_option",
        );
        this.log(`[${sessionId}] session/set_config_option model=${input.model}`);
      } else {
        this.log(
          `[${sessionId}] 模型 ${input.model} 不在可选列表（当前 ${String(modelOpt?.currentValue ?? "?")}），` +
            `可选：${available.join(", ")}`,
        );
      }
    }

    /**
     * 武装 codex 的权限闸门 —— 用 ACP 原生的 session mode，不需要任何配置文件。
     *
     * codex-acp 2.2.2 的 mode 语义（从它的 agent mode 定义里核对过）：
     *
     *   read-only        沙箱只读，networkAccess=false；写文件/联网会被沙箱**直接拒绝**
     *   workspace-write  工作区内可写；写工作区外走 on-request 审批
     *                    （Windows 实测：联网可能不经过审批直接放行 —— 见 R17 验收）
     *   agent（默认）      workspace-write + 自动复核，只问被判为不安全的动作
     *   agent-full-access 全放开（approvalPolicy=never）
     *
     * R16 修正：早先把 guarded 映射成 `read-only`，结果是 codex 想读工作区外的技能
     * 文件、或 curl 目标时直接吃 sandbox 报错（会话日志里是 Access denied / exit 1），
     * 而不是产生一张可放行的审批卡。现在改为 **guarded → workspace-write**：
     * 工作区内正常干活，越界写才来问人。autonomous 保持 codex 默认的
     * `agent`（自动复核）。
     * 关掉：设 `BUMIMANG_ARM_CODEX=off`。
     */
    if (
      input.agent === "codex" &&
      input.tier === "guarded" &&
      (process.env.BUMIMANG_ARM_CODEX ?? "on") !== "off"
    ) {
      try {
        await client.setConfigOption({
          sessionId: rec.acpSession,
          configId: "mode",
          value: "workspace-write",
        });
        this.log(
          `[${sessionId}] codex 闸门已武装：mode=workspace-write（guarded 档；越界写才问；` +
            `Windows 上联网不保证被拦）`,
        );
      } catch (err) {
        this.log(`[${sessionId}] codex mode 覆盖失败（闸门可能未武装）：${(err as Error).message}`);
      }
    }

    rec.status = "idle";
    this.board.setAcpSession(sessionId, newRes.sessionId, client.pid);
    this.board.setSessionStatus(sessionId, "idle");
    this.onSessionChange?.(rec);
    this.log(
      `[${sessionId}] session/new -> acpSession=${newRes.sessionId} pid=${client.pid ?? "?"}`,
    );
    return rec;
    } catch (err) {
      await this.rollbackStart(sessionId, err as Error);
      throw err;
    }
  }

  /**
   * A3 启动超时上限（每步握手都套）。按调用时读环境变量，测试才能现场调短。
   * BUMIMANG_START_TIMEOUT_MS，默认 30s。
   */
  private withStartupDeadline<T>(p: Promise<T>, sessionId: string, label: string): Promise<T> {
    const ms = Number(process.env.BUMIMANG_START_TIMEOUT_MS ?? 30_000);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`启动超时：${label} 超过 ${ms}ms（${sessionId}）`)),
        ms,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * A3 启动失败回滚：杀进程、关日志句柄、库里标 failed、内存撤记录。
   * 顺序：先落库、再撤内存、最后 kill——迟到的 exit 回调找不到 rec 就自然短路。
   */
  private async rollbackStart(sessionId: string, err: Error): Promise<void> {
    const rec = this.sessions.get(sessionId);
    const client = this.clients.get(sessionId);
    if (rec) {
      rec.status = "failed";
      rec.endedAt = Date.now();
    }
    this.board.setSessionStatus(sessionId, "failed");
    this.sessions.delete(sessionId);
    this.clients.delete(sessionId);
    this.promptChains.delete(sessionId);
    client?.kill();
    this.closeSessionLogs(sessionId);
    this.notifyTerminal(sessionId);
    this.log(`[${sessionId}] 启动失败已回滚（库里标 failed）：${err.message}`);
  }

  /** 首条 prompt 注入简报包（§7.3）。简报不记为「用户发言」，否则会污染对话历史。 */
  async sendBriefing(sessionId: string): Promise<BriefingPacket> {
    const rec = this.mustGet(sessionId);
    // P2-B：简报按 task.category（board 里已落库）+ role 注入 playbook/路由；
    // 技能库未配置时 buildBriefing 会写“无技能库”，不静默降级。
    const skillStatus = this.skill?.status();
    const packet = buildBriefing(this.board, {
      taskId: rec.taskId,
      role: rec.role,
      sessionId,
      // R27（A1）：简报里的工作目录是任务专属目录。
      workDir: join(this.workRoot, rec.taskId),
      skill: skillStatus
        ? {
            configured: skillStatus.configured,
            root: skillStatus.root,
            packages: skillStatus.packages,
            source: skillStatus.source,
            mcpMode: skillStatus.root ? this.skillMcpMode : "off",
          }
        : undefined,
    });
    this.briefings.set(sessionId, packet);
    await this.promptInternal(sessionId, renderBriefingPrompt(packet), false);
    return packet;
  }

  /**
   * 人工提示（R16）。
   *
   * 串行：同一会话的 prompt 排队，避免在 agent 正在跑一轮时并发 `session/prompt`
   * 把它打断或触发协议错误。排队中的提示**立即**进对话历史，用户能看到自己说了什么，
   * 也能在窗口里看到它等当前轮结束。
   */
  async prompt(sessionId: string, text: string): Promise<string> {
    return this.promptInternal(sessionId, text, true);
  }

  private promptInternal(sessionId: string, text: string, recordUserPrompt: boolean): Promise<string> {
    const rec = this.mustGet(sessionId);
    if (TERMINAL_STATUSES.includes(rec.status)) {
      return Promise.reject(new Error(`会话已结束（${rec.status}），请新建会话`));
    }
    if (recordUserPrompt) this.recordUserPrompt(sessionId, text);
    const prev = this.promptChains.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.promptNow(sessionId, text));
    // 存一个吞掉错误的链尾：上一条失败不能卡住下一条，但调用方拿到的仍是原始 promise。
    this.promptChains.set(sessionId, run.catch(() => undefined));
    return run;
  }

  private async promptNow(sessionId: string, text: string): Promise<string> {
    const rec = this.mustGet(sessionId);
    if (TERMINAL_STATUSES.includes(rec.status)) {
      throw new Error(`会话已结束（${rec.status}），请新建会话`);
    }
    const client = this.mustClient(sessionId);
    rec.status = "running";
    this.board.setSessionStatus(sessionId, "running");
    this.onSessionChange?.(rec);
    this.log(`[${sessionId}] >>> prompt (${text.length} chars)`);
    const res = await client.prompt(rec.acpSession!, text);
    this.log(`[${sessionId}] <<< stopReason=${res.stopReason}`);
    /**
     * 关键：这一轮**中途**可能已经被别的路径改成终态，最常见的来源是 §9.6 的退避：
     * 权限请求发生在 prompt 轮内部，同一条规则被拒到阈值时 `markBlocked()` 会 cancel 本会话，
     * 于是这里挂着的 `client.prompt` 以 stopReason="cancelled" 结束、本轮 promise 随即 resolve。
     * 若无条件落 idle，就把 blocked 覆盖成 idle（内存与库里都是），会话卡永远画不出「被策略切断」。
     *
     * 这个竞态只在"真实 agent + 真人在 UI 上拒绝"这条路径上出现，合成测试抓不到
     * （假 agent 不在 prompt() 调用中，见 BLOCKED L-4）。所以用终态集合兜住，而不是特判 blocked。
     */
    if (TERMINAL_STATUSES.includes(rec.status)) {
      this.log(`[${sessionId}] 本轮结束时已是终态 ${rec.status}，不覆盖回 idle`);
      this.onSessionChange?.(rec);
      return res.stopReason;
    }
    rec.status = "idle";
    this.board.setSessionStatus(sessionId, "idle");
    this.onSessionChange?.(rec);
    return res.stopReason;
  }

  /** 打断当前一轮（session/cancel）。进程与已排队提示都保留。 */
  interrupt(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    const client = this.clients.get(sessionId);
    if (!rec?.acpSession || !client) return;
    client.cancel(rec.acpSession);
    this.log(`[${sessionId}] 人工打断当前轮（session/cancel）`);
  }

  /** 人工提示先落历史：用户发出去立刻可见，不必等 agent 开始处理。 */
  private recordUserPrompt(sessionId: string, text: string): void {
    const update: StreamUpdate = { ts: Date.now(), kind: "user_prompt", text };
    this.appendStream(sessionId, update);
    if (!this.onStreamUpdate) {
      this.onStream?.(sessionId, { sessionUpdate: "user_prompt", text });
    }
  }

  /** 历史 / 实时共用的唯一追加点：分配 seq、写 stream.jsonl、推 Hub。 */
  private appendStream(sessionId: string, update: StreamUpdate): void {
    // R25（A7）：令牌等敏感凭据不落盘、不进内存历史（文本与工具标题都过一遍）。
    if (update.text) update.text = redactSecrets(update.text);
    if (update.title) update.title = redactSecrets(update.title);
    update.seq = (this.streamSeqs.get(sessionId) ?? 0) + 1;
    this.streamSeqs.set(sessionId, update.seq);
    const hist = this.streamHistories.get(sessionId) ?? [];
    hist.push(update);
    if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
    this.streamHistories.set(sessionId, hist);
    this.streamLogs.get(sessionId)?.write(JSON.stringify(update) + "\n");
    this.onStreamUpdate?.(sessionId, update);
  }

  /** 渲染层拉历史（R16）。返回副本，调用方改不到内部状态。 */
  historyOf(sessionId: string): StreamUpdate[] {
    return (this.streamHistories.get(sessionId) ?? []).slice();
  }

  /**
   * 重启后恢复当前任务的历史会话（R16）。
   *
   * 旧进程已经不在了，所以非终态会话统一标成 `stopped`（不是 failed：没有人崩溃，
   * 是应用正常关闭）。对话事件优先读 `stream.jsonl`；老会话没有它时从 `wire.jsonl`
   * 反推，保证升级前跑过的会话也能看到历史。
   */
  /**
   * 上次进程留下的未收尾会话（R17）。
   *
   * 旧进程已经没了，但它的租约和 claimed 意图还留在库里；不过这一遍，新会话的
   * 简报会把「s1 正在做 XXX」当成 in_flight，直接误导队友。所以启动时统一：
   * 释放租约 → abandon 意图 → 标 stopped；只有真的持有资源时才留一条 incident 死路。
   */
  recoverStaleSessions(): void {
    for (const row of this.board.listSessions()) {
      if (TERMINAL_STATUSES.includes(row.status)) continue;
      const released = this.board.releaseAllLeasesOf(row.id, "应用重启：上一进程已结束");
      const abandoned = this.board.abandonIntentsOf(row.id);
      if (released.length > 0 || abandoned > 0) {
        this.board.declareDeadEnd({
          taskId: row.task_id,
          sessionId: row.id,
          description:
            `上一进程结束时会话（${row.id}）尚未收尾：已释放租约 ${released.length} 个、` +
            `放弃意图 ${abandoned} 条；不要假设它的中间结论成立`,
          scope: "incident",
        });
      }
      this.board.setSessionStatus(row.id, "stopped");
      this.log(
        `[recover] ${row.id}（${row.status}）→ stopped；释放租约 ${released.length}、放弃意图 ${abandoned}`,
      );
    }
  }

  /**
   * 恢复某任务的会话（P1-D 启动路径可逐任务调用）。
   *
   * `recover !== false` 时先做全局 stale 清理（兼容旧调用）；启动路径已经
   * 显式 `recoverStaleSessions()` 全局跑过一次，逐任务恢复时传 `{recover:false}`，
   * 避免每个任务重复扫全表。`loadTaskSessions` 按会话 id 去重，重复调用幂等。
   */
  restoreSessions(taskId: string, opts: { recover?: boolean } = {}): void {
    if (opts.recover !== false) this.recoverStaleSessions();
    this.loadTaskSessions(taskId);
  }

  /**
   * 只把某任务的会话与历史载入内存（不碰全局 stale 恢复）。
   *
   * 启动路径用 `restoreSessions`（recoverStaleSessions + 载入）；`task.switch` 用这个 ——
   * 切换任务时不能再跑一遍 recoverStaleSessions，否则会把刚被 settleCurrentTask 停掉、
   * 退出回调还没落库的会话误判成「上一进程遗留」，写出虚假的 incident 死路。
   */
  loadTaskSessions(taskId: string): void {
    const rows = this.board.listSessions(taskId).slice(-MAX_RESTORE);
    for (const row of rows) {
      if (this.sessions.has(row.id)) continue;
      const status = TERMINAL_STATUSES.includes(row.status) ? row.status : "stopped";
      if (status !== row.status) {
        this.board.setSessionStatus(row.id, status);
      }
      const rec: SessionRecord = {
        id: row.id,
        taskId: row.task_id,
        agent: row.agent,
        role: row.role,
        tier: row.tier,
        acpSession: row.acp_session,
        pid: row.pid ?? null,
        status,
        toolCalls: row.tool_calls ?? 0,
        lastBoardReadAt: 0,
        boardReads: 0,
        expectedExit: true,
        model: null,
        startedAt: row.started_at,
        endedAt: row.ended_at ?? Date.now(),
        blocked: status === "blocked",
      };
      this.sessions.set(rec.id, rec);
      const history = this.loadHistory(rec.id);
      this.streamHistories.set(rec.id, history);
      this.streamSeqs.set(rec.id, history.reduce((m, u) => Math.max(m, u.seq ?? 0), 0));
    }
    this.seq = Math.max(this.seq, this.board.maxSessionSeq());
    if (rows.length) {
      this.log(`[restore] 已恢复 ${rows.length} 个历史会话（任务 ${taskId}）`);
    }
  }

  /** 优先读 stream.jsonl；没有则从 wire.jsonl 反推（兼容升级前的会话）。 */
  private loadHistory(sessionId: string): StreamUpdate[] {
    const dir = join(this.workspaceRoot, "sessions", sessionId);
    const streamPath = join(dir, "stream.jsonl");
    const out: StreamUpdate[] = [];
    let seq = 0;

    if (existsSync(streamPath)) {
      try {
        for (const line of readFileSync(streamPath, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const u = JSON.parse(line) as StreamUpdate;
            if (!u || typeof u.ts !== "number" || typeof u.kind !== "string") continue;
            seq += 1;
            out.push({ ...u, seq: typeof u.seq === "number" ? u.seq : seq });
          } catch {
            /* 半行 / 损坏行：跳过 */
          }
        }
      } catch {
        /* 读不了就当没有 */
      }
    }

    if (out.length === 0) {
      const wirePath = join(dir, "wire.jsonl");
      if (existsSync(wirePath)) {
        try {
          for (const line of readFileSync(wirePath, "utf8").split(/\r?\n/)) {
            if (!line.trim()) continue;
            let entry: { dir?: string; message?: Record<string, unknown> };
            try {
              entry = JSON.parse(line) as typeof entry;
            } catch {
              continue;
            }
            const msg = entry.message;
            if (!msg) continue;
            if (entry.dir === "out" && msg.method === "session/prompt") {
              const params = msg.params as Record<string, unknown> | undefined;
              const blocks = params?.prompt as Array<{ type?: string; text?: string }> | undefined;
              const text = blocks?.find((b) => b.type === "text")?.text;
              // 简报是系统注入，不是人说的话；识别它的固定开头并跳过。
              if (text && !text.startsWith("你是一支多 agent 解题队中的一员")) {
                seq += 1;
                out.push({ seq, ts: Number((entry as { ts?: number }).ts ?? Date.now()), kind: "user_prompt", text });
              }
              continue;
            }
            if (entry.dir !== "in" || msg.method !== "session/update") continue;
            const params = msg.params as Record<string, unknown> | undefined;
            const upd = params?.update as Record<string, unknown> | undefined;
            if (!upd) continue;
            const normalized = normalizeUpdate(upd);
            if (!normalized) continue;
            seq += 1;
            out.push({ ...normalized, seq, ts: Number((entry as { ts?: number }).ts ?? normalized.ts) });
          }
        } catch {
          /* 读不了就当没有 */
        }
      }
    }

    return out.length > MAX_HISTORY ? out.slice(-MAX_HISTORY) : out;
  }

  /** 记一次黑板读取（由 bridge 回调驱动，§7.4）。 */
  noteBoardRead(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    rec.boardReads += 1;
    rec.lastBoardReadAt = rec.toolCalls;
  }

  /** 同步健康度：距上次读黑板过了多少个 tool call（§7.4）。 */
  syncLag(sessionId: string): number {
    const rec = this.sessions.get(sessionId);
    if (!rec) return 0;
    return rec.toolCalls - rec.lastBoardReadAt;
  }

  /** 主动终止：先 cancel 停当前轮，再 close 终止（§7.7 的 cancel/close 分工）。 */
  async stopSession(sessionId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    const client = this.clients.get(sessionId);
    if (!rec || !client) return;
    rec.expectedExit = true;
    try {
      if (rec.acpSession) {
        client.cancel(rec.acpSession);
        try {
          // R18：close 自身有 3s 上限，坏 agent 不会把 stop 永远挂住。
          await client.closeSession(rec.acpSession);
        } catch {
          /* close 超时/不被支持时忽略，交给 finally 的 kill */
        }
      }
    } finally {
      // 无论 close 抛错、超时还是被取消，都必须落到 kill。
      client.kill();
      // R18：停止即收尾，wire 句柄不能留到应用全局 shutdown。
      this.closeSessionLogs(sessionId);
      // 统一清理：MCP token、审批深度、工具名缓存、session 授权。
      this.notifyTerminal(sessionId);
    }
  }

  /**
   * 关标签移除（R20）：先停（若还有进程），再隐藏 —— 只隐藏、不删除。
   *
   * 记录留在 sessions map 里（带 hidden 标记）：迟到的 exit 回调要能找到 rec 才能
   * 正常把终态落库；`listSessions` 与 Hub 发布路径负责让它从 UI 消失。
   * 历史（stream.jsonl 与内存副本）原样保留，用户定的语义就是可回看。
   */
  async removeSession(sessionId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    rec.expectedExit = true; // 别让 onAgentExit 把这次停止当成崩溃
    await this.stopSession(sessionId);
    if (!TERMINAL_STATUSES.includes(rec.status)) {
      rec.status = "stopped";
      rec.endedAt = Date.now();
      this.board.setSessionStatus(sessionId, "stopped");
    }
    rec.hidden = true;
    this.board.setSessionHidden(sessionId, true);
    this.promptChains.delete(sessionId);
    // 内存里挂着的历史保留（可回看）；重启后 hidden=1 的行不会再被载入。
    this.log(`[${sessionId}] 已移除（隐藏，历史保留）：${rec.status}`);
  }

  /** 关闭某会话的 wire/stream 写句柄；重复调用安全。 */
  private closeSessionLogs(sessionId: string): void {
    this.wireLogs.get(sessionId)?.end();
    this.wireLogs.delete(sessionId);
    this.streamLogs.get(sessionId)?.end();
    this.streamLogs.delete(sessionId);
  }

  /** 模拟崩溃：直接杀进程，不走 cancel/close（验收断言 6/7 用）。 */
  killSessionHard(sessionId: string, delayMs = 0): void {
    const rec = this.sessions.get(sessionId);
    const client = this.clients.get(sessionId);
    if (!rec || !client) return;
    rec.expectedExit = false;
    setTimeout(() => client.kill(), delayMs);
  }

  /**
   * P7-B：MCP 子进程异常断开。
   * - 只标记独立字段 mcpUnavailable，不改 status（会话可能仍在跑）；
   * - 不自动重启 MCP；
   * - 广播 session.upsert（带字段）+ mcp.unavailable 事件，UI 显示提示与新建会话入口。
   */
  markMcpUnavailable(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec) return false;
    if (rec.mcpUnavailable) return false;
    if (TERMINAL_STATUSES.includes(rec.status)) return false;
    rec.mcpUnavailable = true;
    this.log(`[${sessionId}] MCP 不可用（子进程断开）；不自动重启，请新建会话`);
    this.onSessionChange?.(rec);
    this.onMcpUnavailable?.(sessionId, rec.taskId);
    return true;
  }

  /**
   * 因策略拦截终止会话 —— §9.6 / §7.7。
   *
   * 与"崩溃"和"人工停止"都不同：这是**策略判定**造成的终态，所以要留 dead_end
   * 让队友（和后续会话的简报）知道这条线被规则掐了，而不是踩了坑。
   */
  async markBlocked(sessionId: string, reason: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    const client = this.clients.get(sessionId);
    if (!rec) return;
    rec.blocked = true;
    rec.expectedExit = true; // 别让 onAgentExit 当成崩溃
    rec.status = "blocked";
    rec.endedAt = Date.now();
    this.board.setSessionStatus(sessionId, "blocked");
    this.board.declareDeadEnd({
      taskId: rec.taskId,
      sessionId,
      description: `会话（${sessionId}）被策略拦截并终止：${reason}`,
      scope: "blocked",
    });
    this.onSessionChange?.(rec);
    this.log(`[${sessionId}] 转 blocked：${reason}`);
    try {
      if (client && rec.acpSession) {
        client.cancel(rec.acpSession);
        try {
          await client.closeSession(rec.acpSession);
        } catch {
          /* close 超时/不被支持时忽略 */
        }
      }
    } finally {
      // R18：策略终止也必须保证进程被收掉，不能因为 close 挂起留下孤儿。
      client?.kill();
      this.closeSessionLogs(sessionId);
      this.promptChains.delete(sessionId);
      this.notifyTerminal(sessionId);
    }
  }

  /**
   * 会话退出处理 —— §8.6。
   * 崩溃：租约立即释放、intent 标 abandoned、留一条事故记录给后续简报包。
   */
  private async onAgentExit(
    sessionId: string,
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    // R18：shutdown 已超时收尾/已 disposed 后，迟到 exit 绝不能再访问 board。
    // 这不是吞异常：终态、租约、intent、句柄都已在 shutdown() 返回前同步收尾。
    if (this.finalizing || this.disposed) {
      this.closeSessionLogs(sessionId);
      this.notifyTerminal(sessionId);
      return;
    }
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    // P7-B：进程已退出，登记表同步移除。
    this.processRegistry?.unregister(rec.pid);
    // 进程退出即撤销该会话的 MCP 令牌，并清掉审批/授权/内存状态。
    this.notifyTerminal(sessionId);
    this.promptChains.delete(sessionId);
    this.closeSessionLogs(sessionId);
    const released = this.board.releaseAllLeasesOf(sessionId, "session exit");
    const abandoned = this.board.abandonIntentsOf(sessionId);
    if (rec.expectedExit) {
      // 若这次退出是策略拦截造成的，保留 blocked 终态，不要覆盖成 stopped
      if (rec.blocked) {
        this.onSessionChange?.(rec);
        this.log(`[${sessionId}] 已按策略拦截终止`);
        return;
      }
      rec.status = "stopped";
      rec.endedAt = Date.now();
      this.board.setSessionStatus(sessionId, "stopped");
      this.onSessionChange?.(rec);
      this.log(`[${sessionId}] 已按预期停止（code=${code ?? "null"}）`);
      return;
    }
    rec.status = "failed";
    rec.endedAt = Date.now();
    this.board.setSessionStatus(sessionId, "failed");
    this.onSessionChange?.(rec);
    this.board.declareDeadEnd({
      taskId: rec.taskId,
      sessionId,
      description: `上一会话（${sessionId}）崩溃退出（code=${code ?? "null"} signal=${signal ?? "null"}），不要假设它的中间结论成立`,
      scope: "incident",
    });
    this.log(
      `[${sessionId}] 异常退出（code=${code ?? "null"} signal=${signal ?? "null"}）` +
        ` → 释放租约 ${released.length} 个、abandon intent ${abandoned} 条`,
    );
  }

  /**
   * 正常退出（R18）。
   *
   * 顺序不能反：先把所有非终态会话标成 expectedExit，再 cancel/close/kill，
   * 最后**等进程真的退出**。否则 Electron 的 before-quit 会先 `board.close()`，
   * 迟到的 onAgentExit 再去写库就是 `database is not open`，还会误记 failed/incident。
   *
   * close 与 waitForExit 共用同一个绝对 deadline。超时路径会在返回前同步把
   * 状态/租约/intent/句柄全部收尾，并进入 disposed，迟到 exit 不再触碰 board。
   */
  shutdown(): Promise<ShutdownResult> {
    if (this.disposed) {
      if (this.shutdownResult) return Promise.resolve(this.shutdownResult);
      return Promise.reject(new Error("SessionManager 已 disposed，但上次 shutdown 未完成"));
    }
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<ShutdownResult> {
    const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
    const live = [...this.clients.entries()];
    // 1. 先统一标记：退出回调无论多晚到，都按「预期停止」处理。
    for (const [sessionId] of live) {
      const rec = this.sessions.get(sessionId);
      if (rec && !TERMINAL_STATUSES.includes(rec.status)) rec.expectedExit = true;
    }
    // 没有活客户端的非终态会话（恢复出来的/启动失败的）不会有 exit 回调，
    // 直接在这里落 stopped，避免库里留下永远 running 的幽灵。
    for (const rec of this.sessions.values()) {
      if (this.clients.has(rec.id) || TERMINAL_STATUSES.includes(rec.status)) continue;
      rec.expectedExit = true;
      rec.status = "stopped";
      rec.endedAt = Date.now();
      this.board.setSessionStatus(rec.id, "stopped");
      this.onSessionChange?.(rec);
    }

    const closeErrors: Array<{ sessionId: string; message: string }> = [];
    // 2. 并发停止；close 和 wait 都只花 deadline 之内剩余的时间。
    const outcomes = await Promise.all(
      live.map(async ([sessionId, client]) => {
        const rec = this.sessions.get(sessionId);
        try {
          if (rec?.acpSession) {
            client.cancel(rec.acpSession);
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              closeErrors.push({ sessionId, message: "关闭预算已用尽，未发送 close" });
            } else {
              try {
                await client.closeSession(rec.acpSession, remaining);
              } catch (err) {
                const message = (err as Error).message;
                closeErrors.push({ sessionId, message });
                this.log(`[${sessionId}] session/close 失败或超时：${message}`);
              }
            }
          }
        } finally {
          client.kill();
        }
        const left = deadline - Date.now();
        // 3. 等真退出。exit 回调会同步写完 stopped 状态与租约清理，之后才关库。
        const exited = left > 0 ? await client.waitForExit(left) : client.hasExited;
        if (!exited) this.log(`[${sessionId}] 退出超时：进程未在总预算 ${SHUTDOWN_BUDGET_MS}ms 内结束`);
        return { sessionId, exited };
      }),
    );

    const pendingSessions = outcomes.filter((o) => !o.exited).map((o) => o.sessionId);
    const timedOut = pendingSessions.length > 0;
    if (timedOut) {
      // 先关门，再收尾：从这一刻起任何迟到的 exit 都只能走 onAgentExit 的 disposed 分支。
      this.finalizing = true;
      try {
        for (const sessionId of pendingSessions) {
          const rec = this.sessions.get(sessionId);
          if (rec) this.finalizeTimedOutSession(rec);
          else this.closeSessionLogs(sessionId);
        }
      } finally {
        this.finalizing = false;
        this.disposed = true;
      }
    } else {
      this.disposed = true;
    }

    // exit 回调是微任务形式启动的；让它们把黑板写入跑完再返回。
    await new Promise<void>((resolve) => setImmediate(resolve));

    this.clients.clear();
    for (const sessionId of [...new Set([...this.sessions.keys()])]) {
      this.closeSessionLogs(sessionId);
      // 退出前撤销所有 MCP 令牌并清空审批/授权内存状态；幂等。
      this.notifyTerminal(sessionId);
    }
    this.promptChains.clear();

    const result: ShutdownResult = {
      allExited: !timedOut,
      timedOut,
      pendingSessions,
      closeErrors,
    };
    this.shutdownResult = result;
    return result;
  }

  /**
   * 超时会话的同步收尾。
   *
   * 必须在 board.close() 之前完成：状态落终态、租约释放、intent abandon、
   * wire/stream 句柄关闭。调用方之后即使再收到 exit，也不能再写库。
   */
  private finalizeTimedOutSession(rec: SessionRecord): void {
    rec.expectedExit = true;
    if (!TERMINAL_STATUSES.includes(rec.status)) {
      rec.status = "stopped";
      rec.endedAt = Date.now();
      this.board.setSessionStatus(rec.id, "stopped");
    }
    const released = this.board.releaseAllLeasesOf(rec.id, "shutdown timeout");
    const abandoned = this.board.abandonIntentsOf(rec.id);
    this.closeSessionLogs(rec.id);
    this.promptChains.delete(rec.id);
    for (const k of this.toolTitles.keys()) {
      if (k.startsWith(`${rec.id}::`)) this.toolTitles.delete(k);
    }
    this.onSessionChange?.(rec);
    this.notifyTerminal(rec.id);
    this.log(
      `[${rec.id}] shutdown 超时收尾：状态=${rec.status}，释放租约 ${released.length} 个、` +
        `abandon intent ${abandoned} 条；后续迟到 exit 不再写库`,
    );
  }

  private mustGet(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`未知会话：${sessionId}`);
    return rec;
  }

  private mustClient(sessionId: string): AcpClient {
    const c = this.clients.get(sessionId);
    if (!c) throw new Error(`会话无 ACP 客户端：${sessionId}`);
    return c;
  }
}

export function newRunId(): string {
  return randomUUID().slice(0, 8);
}
