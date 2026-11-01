/**
 * Electron 主进程入口 —— 架构文档 T5。
 *
 * 它做的三件事：
 *  1. 复用 Lane B 的 `registerRendererProtocol()`（bumimang:// 自定义 scheme，现场剥 TS）
 *  2. 把核心（黑板 / 会话 / Hub 服务）在这里组装起来
 *  3. 打通契约的三条 IPC 通道：hub:snapshot / hub:action / hub:event
 *
 * 复用而不是重写渲染层：`hub.ts` 的 `resolveHub()` 只要看到 `window.bumimang`
 * 就会自动从 mock 切到真实 IPC，所以窗口一加载 preload，T11 的「对接」就完成了。
 *
 * 运行：
 *   node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import {
  RENDERER_SCHEME,
  registerRendererProtocol,
} from "../../../electron/renderer-protocol.ts";
import {
  HUB_CHANNELS,
  type HubEvent,
  type ScopeProxyView,
  type StreamUpdate,
  type TargetView,
} from "../../../../../packages/shared-protocol/events.ts";
import { Blackboard } from "../blackboard/board.ts";
import { BoardBridge } from "../mcp-host/bridge.ts";
import { PassthroughPolicy, type Policy } from "../policy/policy.ts";
import { PolicyEngine } from "../policy/engine.ts";
import { ApprovalQueue, scopeTargetForApproval, type ApprovalService } from "../approval/queue.ts";
import { DenialTracker, approvalSignature } from "../approval/queue.ts";
import { SessionManager, newRunId, writePolicyAudit } from "../session/manager.ts";
import { ScopeProxyService } from "../scope/proxy.ts";
import { ProcessRegistry } from "../reliability/process-registry.ts";
import {
  classifyHeartbeatEvent,
  classifyHeartbeatMissing,
  parseRendererHeartbeat,
  type RendererVisibility,
} from "./heartbeat.ts";
import { EventBus, HubService } from "../hub/hub.ts";
import { loadAppConfig, resolveWorkDir } from "../config/loader.ts";
import { createSkillRuntime, withSkillStatus, type SkillRuntime } from "../skill/index.ts";
import { loadIrToolConfig, createIrToolResolver } from "../ir/tool-config.ts";
import { EvidenceReplayer } from "../evidence/replay.ts";
import { PermissionStore } from "../permission/store.ts";
import { validateHubAction } from "./validate-action.ts";
import {
  applyWorkRootBoundary,
  loadPermissionConfig,
  profileOperation,
} from "../permission/profile.ts";
import type { OperationProfile, PermissionConfig } from "../permission/profile.ts";
import { WpLibrary } from "../platform/wp-library.ts";
import { PlatformService, type PlatformSecretCodec } from "../platform/service.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 界面运行期的独立工作区，不污染 M1 的 .m1 证据目录 */
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
/** --verify：加载窗口后做断言、写证据、退出。用于产出可重跑的验收结果。 */
const VERIFY = process.argv.includes("--verify");
// Competition workbench timers (autopilot, scene probes, stream merging) must
// keep real-time cadence even when the window is occluded or minimized.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// 两个实例会争同一份 SQLite / wire 日志，并把对方的活动会话误恢复成 stopped。
// 比赛工作台只允许一个主进程；第二次启动直接把已有窗口拉到前台。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/**
 * 应用配置（工作目录等）。配置位置见 config/loader.ts：
 * 开发态读 <repo>/config/app.json；打包态读 resources/app-source/config/app.json。
 * 环境变量 BUMIMANG_CONFIG 可指向任意配置文件。
 */
const APP_CONFIG = loadAppConfig({
  repoRoot: REPO_ROOT,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
/**
 * V2.1：IR 工具配置（显式路径 > BUMIMANG_* env > PATH）。
 * 打包态读 resources/app-source/config/ir-tools.json；开发态读 config/ir-tools.json。
 */
const IR_TOOLS = loadIrToolConfig({
  repoRoot: REPO_ROOT,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  // 用户级配置：%APPDATA%\bumimang\ir-tools.json（不写安装目录）。
  userDataDir: path.join(app.getPath("appData"), app.getName()),
});
const IR_TOOL_RESOLVER = createIrToolResolver(IR_TOOLS);
/**
 * 权限配置（哪些操作类别允许一键放行、高风险白名单）。
 * 与工作目录配置分开，便于安全边界单独审阅。
 */
const PERMISSION_CONFIG: Readonly<{
  config: PermissionConfig;
  path: string | null;
  error?: string;
}> = loadPermissionConfig({
  repoRoot: REPO_ROOT,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
/**
 * 技能库状态（P2-A）：只解析根目录 + 懒索引占位。
 * 启动时**不扫描**技能库；ensureIndex() 由 P2-B 的检索/简报首次触发。
 * 解析顺序见 skill/index.ts：BUMIMANG_SKILL_DIR → config.skillDir → 开发态 <repo>/../skill
 * → 打包态 resources/app-source/skill；代码不写死盘符。
 */
const SKILL: SkillRuntime = createSkillRuntime({
  env: process.env,
  configSkillDir: APP_CONFIG.config.skillDir,
  repoRoot: REPO_ROOT,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
/**
 * 运行期工作区（黑板 db、各会话目录、Electron profile）。
 *
 * **打包后不能写在源码树里**：`import.meta.url` 会指向 `app.asar` 内的路径，那是只读的，
 * 一写就崩。所以打包态改用 `%APPDATA%\<productName>\workspace`（Electron 的 userData），
 * 这也正好符合架构文档"配置写用户目录、不硬编码盘符"的约定（C8）。
 *
 * `--verify` 用独立目录并每次清空：验收要确定性，不能被上一轮的历史任务/会话影响。
 */
const WORKSPACE = VERIFY
  ? // 打包后 REPO_ROOT 指向 app.asar 内部（只读），验证工作区必须放到可写的临时目录；
    // 开发态仍用仓库 .ui-run，便于复跑与看证据。
    app.isPackaged
    ? path.join(app.getPath("temp"), "bumimang-verify-main")
    : path.join(REPO_ROOT, ".ui-run", "verify-main")
  : app.isPackaged
    ? path.join(app.getPath("userData"), "workspace")
    : path.join(REPO_ROOT, ".ui-run");
/**
 * agent 工作根目录（R16）。ACP 文件写入与命令 cwd 越界会被拒绝；不是 OS 级 jail。
 *
 * 优先级（P7-C：可移植，不把盘符写死在代码/config）：
 *  1. `BUMIMANG_WORK_DIR`（新）/ `BUMIMANG_WORKDIR`（旧，兼容）
 *  2. `config/app.json` 的 `workDir`
 *  3. 开发态 `<repo>/work`
 *  4. 打包态 `<documents>/bumimang/work`
 *
 * 目录不存在时由 bootstrap 里的 ensureWorkRoot 自动创建。
 */
function resolveWorkRoot(): string {
  return resolveWorkDir({
    env: process.env,
    configWorkDir: APP_CONFIG.config.workDir,
    repoRoot: REPO_ROOT,
    isPackaged: app.isPackaged,
    documentsPath: app.getPath("documents"),
  });
}

/**
 * P7-C：检测旧 workDir 数据但**不自动迁移**。
 * 旧路径默认是 `<repo>/work`，也可用 BUMIMANG_LEGACY_WORKDIR 指定（如旧版 D:/.../work）。
 * 只有旧路径存在且新路径为空时才提示。
 */
function warnLegacyWorkRoot(actual: string): void {
  const legacyRaw = process.env.BUMIMANG_LEGACY_WORKDIR?.trim() || path.join(REPO_ROOT, "work");
  const legacy = path.resolve(legacyRaw);
  if (legacy === path.resolve(actual) || !existsSync(legacy)) return;
  let empty = true;
  try {
    empty = readdirSync(actual).length === 0;
  } catch {
    empty = true;
  }
  if (!empty) return;
  process.stderr.write(
    `[main] 检测到旧工作目录 ${legacy}，新目录 ${actual} 为空；` +
      `不会自动迁移。请手动确认后复制，或设置 BUMIMANG_WORK_DIR=${legacy} 继续用旧目录。\n`,
  );
}
// 打包态 --verify 完全沙箱化，连工作目录也不碰用户的 %APPDATA%；
// 开发态仍按配置解析（本机即仓库 work/），让验收看到真实路径。
let WORK_ROOT = VERIFY && app.isPackaged ? path.join(WORKSPACE, "work") : resolveWorkRoot();

/**
 * 结合任务专属工作目录判断一次权限请求的操作画像。
 *
 * - 先按 tool kind / 标题归类（读/写/执行/删除…）；
 * - 文件写入若显式指向 `<WORK_ROOT>/<taskId>` 之外，升级为高风险且不可记住。
 */
function profileForTask(detail: Record<string, unknown>, taskId: string): OperationProfile {
  const base = profileOperation(detail, PERMISSION_CONFIG.config);
  return applyWorkRootBoundary(base, detail, path.join(WORK_ROOT, taskId));
}

/**
 * P4-C 批次 2：审批卡的结构化目标。
 *
 * 只对 no-out-of-scope 命中调用；从同一 request detail + 当前任务 targets 重算，
 * 不重跑 policy.evaluate、不缓存全局状态。ruleId 直接来自 decision.rule。
 */
function approvalScopeTargetFromBoard(
  board: Blackboard,
  taskId: string,
  action: string,
  detail: Record<string, unknown>,
  rule: string,
): { kind: string; value: string } | null {
  try {
    const scopeRow = board.getTaskScope(taskId);
    const targets = board.listTargets(taskId).map(
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
    return scopeTargetForApproval({
      rule,
      action,
      detail,
      targets,
      denyTargets: scopeRow?.denyTargets ?? [],
    });
  } catch (err) {
    process.stderr.write(
      `[permission] 审批目标重算失败（task=${taskId}）：${(err as Error).message}\n`,
    );
    return null;
  }
}

/** 规则包位置：开发态在仓库 rules/；打包态由 electron-builder 拷进 resources/app-source/ */
const RULES_ROOT = app.isPackaged ? path.join(process.resourcesPath, "app-source") : REPO_ROOT;
/** 证据（截图 / JSON）落盘位置：打包态写不进 asar，也写不到 docs/ */
const EVIDENCE_DIR = app.isPackaged
  ? path.join(app.getPath("userData"), "evidence")
  : path.join(REPO_ROOT, "docs", "logs");

if (VERIFY) {
  // 上一轮 --verify 可能留下 profile / board.db，导致断言受历史状态影响。
  rmSync(WORKSPACE, { recursive: true, force: true });
}

// 两个 Electron 实例共用默认 userData 目录会互相抢文件锁（实测报
// "另一个程序正在使用此文件" 然后直接退出）。本项目里 Lane A 与 Lane B
// 会同时跑 Electron，所以必须给本项目一个独立 profile。
app.setPath("userData", path.join(WORKSPACE, "electron-profile"));
// 验证/无头场景不需要 GPU，关掉能省掉一堆 cache 报错
if (VERIFY) app.disableHardwareAcceleration();

/**
 * 建立工作目录，并放一份给 agent / 人看的说明（只在缺失时写，不覆盖用户文件）。
 *
 * 配置指向的盘符不存在（例如换到一台没有 D: 的机器）时，不要让应用直接起不来：
 * 回退到应用 workspace 下的 work/，并在 stderr 明确说明。返回值是实际使用的根目录。
 */
function ensureWorkRoot(root: string): string {
  let actual = root;
  try {
    mkdirSync(actual, { recursive: true });
  } catch (err) {
    const fallback = path.join(WORKSPACE, "work");
    if (path.resolve(fallback) === path.resolve(actual)) throw err;
    process.stderr.write(
      `[main] 配置的工作目录不可用（${actual}）：${(err as Error).message}\n` +
        `[main] 已回退到 ${fallback}；请修改 config/app.json 的 workDir 或设置 BUMIMANG_WORKDIR。\n`,
    );
    actual = fallback;
    mkdirSync(actual, { recursive: true });
  }
  const readme = path.join(actual, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# 不迷茫 · agent 工作目录",
        "",
        "这个目录是 agent 的工作目录；所有产物都放这里。",
        "",
        "- 所有脚本、下载、扫描结果、报告都写入这里（或子目录）。",
        "- 应用会拒绝工作目录外的 ACP 文件写入和命令 cwd；shell 里用绝对路径绕行不在硬隔离范围内。",
        "- 会话的 cwd 已经设为本目录；codex / dsh 的 workspace-write 沙箱根也是它。",
        "- 运行时状态（board.db、wire/stream 日志）不在这里，在应用的 workspace 目录。",
        "- 想换位置：设置环境变量 `BUMIMANG_WORK_DIR`（新名）或旧名 `BUMIMANG_WORKDIR`，",
        "  或在 config/app.json 写 workDir（相对配置文件目录）；不写则用用户文档目录/bumimang/work。",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return actual;
}

/** 首次运行种一个本地示例目标，避免「任务描述说 target/index.html，agent 却找不到」。 */
function seedSampleTarget(root: string): void {
  const target = path.join(root, "target", "index.html");
  if (existsSync(target)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    [
      "<!doctype html>",
      '<html lang="zh-CN"><head><meta charset="utf-8"><title>内部门户</title></head>',
      "<body>",
      "<h1>内部门户</h1>",
      '<form action="/admin" method="post">',
      '<label>用户名 <input name="user"></label>',
      '<label>密码 <input name="pass" type="password"></label>',
      '<button type="submit">登录</button>',
      "</form>",
      "<!-- 示例目标：仅用于验证工作目录与工具链；真实比赛请在任务简报里写靶场地址 -->",
      "</body></html>",
    ].join("\n"),
    "utf8",
  );
}

/** 黑板事件推送游标：避免每次动作都把全部历史事件重新推一遍。 */
let boardCursor = 0;

// 自定义 scheme 必须在 app ready 之前声明成标准/安全源，
// 否则 renderer.html 里的 ES module import 会被 CJS/CORS 规则挡掉。
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

let win: BrowserWindow | null = null;
app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
let board: Blackboard | null = null;
let bridge: BoardBridge | null = null;
let sessions: SessionManager | null = null;
/** P4-D 批次 2：本地范围代理（默认关；启动失败时保持 null）。 */
let scopeProxy: ScopeProxyService | null = null;
/** 代理子进程登记（WP7 预告；只做代理进程）。 */
let proxyRegistry: ProcessRegistry | null = null;

// P6-C 批次 1.6b / D5：可观测性。只计数/打日志，不改变任何行为。
let ipcEventSends = 0;
let ipcStreamSends = 0;
let obsStarted = false;
// P6-C 2.1 / D5.2：renderer 心跳。renderer 每 5s console.log("[renderer heartbeat]")，
// 主进程的 console-message 转发时更新；>15s 没更新就记日志。
// P6-C 2.7a / D7a：renderer 额外上报 visibilityState + 自测 gapMs + throttled；
// hidden 的 60s gap 标记 throttled-hidden，visible 的真实 gap 才告警 stall。
let lastRendererHeartbeat = Date.now();
let lastHeartbeatWarn = 0;
let lastRendererVisibility: RendererVisibility = "unknown";

function obsLog(message: string): void {
  // 与现有 [main]/[session] 日志同一 stdout；行数受控（lag 仅 >100ms，RSS/IPC 每 30s）。
  process.stdout.write(`[obs ${new Date().toISOString()}] ${message}\n`);
}

function startObservability(): void {
  if (obsStarted) return;
  obsStarted = true;
  let lastTick = process.hrtime.bigint();
  let lastIpc = 0;
  const lagTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const deltaMs = Number(now - lastTick) / 1e6;
    lastTick = now;
    const lagMs = deltaMs - 5000;
    if (lagMs > 100) {
      obsLog(`event-loop lag ${lagMs.toFixed(0)}ms (interval ${deltaMs.toFixed(0)}ms)`);
    }
    // D5.2 / D7a：按 renderer 上报的 visibility 区分 hidden 节流与 visible stall。
    // - hidden：Chromium 后台 timer 节流，标 throttled-hidden，不再误报“main thread blocked”；
    // - visible/unknown：才是需要看的 stall / missing。
    const missing = Date.now() - lastRendererHeartbeat;
    const missingKind = classifyHeartbeatMissing(lastRendererVisibility, missing);
    if (missingKind !== "none" && Date.now() - lastHeartbeatWarn > 30000) {
      lastHeartbeatWarn = Date.now();
      if (missingKind === "throttled-hidden") {
        obsLog(`renderer heartbeat throttled-hidden ${missing}ms (visibility=hidden)`);
      } else if (missingKind === "stall") {
        obsLog(`renderer heartbeat stall ${missing}ms (no heartbeat, visibility=visible)`);
      } else {
        obsLog(`renderer heartbeat missing ${missing}ms (visibility=unknown; 旧 renderer 未上报)`);
      }
    }
  }, 5000);
  lagTimer.unref();
  const rssTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const ipcDelta = ipcEventSends - lastIpc;
    lastIpc = ipcEventSends;
    let processSummary = "unavailable";
    try {
      processSummary = app
        .getAppMetrics()
        .map((m) => `${m.type}:${m.pid}:${Math.round(m.memory.workingSetSize / 1024)}MB`)
        .join(",");
    } catch {
      /* getAppMetrics 不可用时保留 unavailable */
    }
    obsLog(
      `rss=${(mem.rss / 1048576).toFixed(1)}MB heapUsed=${(mem.heapUsed / 1048576).toFixed(1)}MB ` +
        `external=${(mem.external / 1048576).toFixed(1)}MB ` +
        `ipcDelta30s=${ipcDelta} ipcTotal=${ipcEventSends} streamTotal=${ipcStreamSends} ` +
        `processes=[${processSummary}] ` +
        `queueDepth=不可观测（Electron webContents.send 未公开）`,
    );
  }, 30000);
  rssTimer.unref();
  obsLog(
    "observability on: unresponsive/responsive/render-process-gone + event-loop lag(5s, log >100ms) " +
      "+ RSS/IPC(30s); queueDepth=不可观测",
  );
}

// P6-C 2.2 / D2：renderer IPC 层的 session.stream 合并。
// 不改 Hub 的 bus 事件（verify 套件直接订阅 Hub）；只减少 webContents.send 次数。
// 相邻 agent_thought 合并文本（保留最后一个 seq/ts），tool_call/agent_message/其他不合并。
const STREAM_FLUSH_MS = 80;
const MAX_STREAM_BUFFER = 2000;
interface StreamBuffer {
  taskId?: string;
  updates: StreamUpdate[];
}
const streamBuffers = new Map<string, StreamBuffer>();
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

function mergeThoughtUpdates(updates: StreamUpdate[]): StreamUpdate[] {
  const out: StreamUpdate[] = [];
  let thought: StreamUpdate | null = null;
  for (const u of updates) {
    if (u.kind === "agent_thought") {
      if (!thought) {
        thought = { ...u };
      } else {
        thought.text = (thought.text ?? "") + (u.text ?? "");
        thought.ts = u.ts;
        if (typeof u.seq === "number") thought.seq = u.seq;
      }
    } else {
      if (thought) {
        out.push(thought);
        thought = null;
      }
      out.push(u);
    }
  }
  if (thought) out.push(thought);
  return out;
}

function flushStreamEvents(): void {
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
  if (streamBuffers.size === 0) return;
  const entries = [...streamBuffers.entries()];
  streamBuffers.clear();
  for (const [sessionId, buf] of entries) {
    for (const update of mergeThoughtUpdates(buf.updates)) {
      ipcEventSends += 1;
      ipcStreamSends += 1;
      try {
        win?.webContents.send(HUB_CHANNELS.event, {
          type: "session.stream",
          sessionId,
          taskId: buf.taskId,
          update,
        });
      } catch {
        /* renderer 已销毁 */
      }
    }
  }
}

function queueStreamEvent(e: Extract<HubEvent, { type: "session.stream" }>): void {
  const buf = streamBuffers.get(e.sessionId) ?? { taskId: e.taskId, updates: [] };
  if (e.taskId !== undefined) buf.taskId = e.taskId;
  buf.updates.push(e.update);
  streamBuffers.set(e.sessionId, buf);
  if (buf.updates.length >= MAX_STREAM_BUFFER) {
    flushStreamEvents();
    return;
  }
  if (!streamFlushTimer) {
    const timer = setTimeout(flushStreamEvents, STREAM_FLUSH_MS);
    timer.unref();
    streamFlushTimer = timer;
  }
}

async function bootstrap(): Promise<{
  hub: HubService;
  bus: EventBus;
  flushBoard: () => void;
}> {
  mkdirSync(WORKSPACE, { recursive: true });
  WORK_ROOT = ensureWorkRoot(WORK_ROOT);
  warnLegacyWorkRoot(WORK_ROOT);
  // 授权文件放在 workspace（与 board.db 同级）：开发态 .ui-run/permissions.json，
  // 打包态 %APPDATA%\bumimang\workspace\permissions.json。不放 agent 工作目录，
  // 避免 agent 自己改写授权文件。
  const permissionStore = new PermissionStore({
    filePath: path.join(WORKSPACE, "permissions.json"),
    config: PERMISSION_CONFIG.config,
  });
  process.stdout.write(
    `[main] 权限配置：${PERMISSION_CONFIG.path ?? "内置默认"}；授权文件：${permissionStore.path}\n`,
  );
  if (PERMISSION_CONFIG.error) process.stderr.write(`[main] ${PERMISSION_CONFIG.error}\n`);
  if (permissionStore.persistError) process.stderr.write(`[main] 授权文件读取：${permissionStore.persistError}\n`);
  /** 自动放行审计去重：同一会话 + 同一授权只记一条黑板事件，避免每次工具调用都刷台账。 */
  const autoAllowAudited = new Set<string>();

  let b: Blackboard;
  try {
    // P7-A：启动前备份 + 迁移失败自动恢复；不静默重置。
    b = Blackboard.open(path.join(WORKSPACE, "board.db"), { backup: !VERIFY });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[main] board.db 启动失败：${msg}\n`);
    if (!VERIFY) {
      try {
        dialog.showErrorBox(
          "不迷茫 · 数据文件启动失败",
          `${msg}\n\n应用不会静默重置 board.db。请检查备份目录或数据文件；修复后再启动。`,
        );
      } catch {
        /* dialog 不可用时 stderr 已有记录 */
      }
    }
    app.exit(1);
    return;
  }
  board = b;

  // P4-D 批次 2：本地范围代理。默认关；启动失败只降级网络出口，不阻塞会话。
  // P6-B 批次 2a：代理实例上报真实状态；runtimeScope 先建好，状态回调只改展示字段。
  // P7-B：持久化进程登记 + 启动清理（PID + OS 启动时间校验，不误杀 PID 复用）。
  proxyRegistry = new ProcessRegistry({
    filePath: path.join(WORKSPACE, "process-registry.json"),
  });
  try {
    const stale = proxyRegistry.cleanupStale((m) => process.stderr.write(`${m}\n`));
    if (stale.killed.length > 0) {
      process.stdout.write(`[main] 启动清理残留进程：${stale.killed.join(",")}\n`);
    }
  } catch (err) {
    process.stderr.write(`[main] 残留进程清理失败：${(err as Error).message}\n`);
  }
  const proxyEnabled = APP_CONFIG.config.scope.proxy.enabled;
  /** Hub 构造后才可用；代理启动阶段回调先只更新 runtimeScope。 */
  let hubRef: HubService | null = null;
  const runtimeScope = {
    enabled: APP_CONFIG.config.scope.enabled,
    outOfScopeAction: APP_CONFIG.config.scope.outOfScopeAction,
    proxy: {
      enabled: proxyEnabled,
      port: null as number | null,
      state: (proxyEnabled ? "starting" : "stopped") as ScopeProxyView["state"],
    } as ScopeProxyView,
  };
  if (proxyEnabled) {
    try {
      scopeProxy = new ScopeProxyService({
        port: APP_CONFIG.config.scope.proxy.port ?? 0,
        resolveScope: (taskId) => {
          const task = b.getTask(taskId);
          if (!task) return null;
          const scopeRow = b.getTaskScope(taskId);
          return {
            targets: b.listTargets(taskId).map(
              (t): TargetView => ({
                id: t.id,
                taskId: t.task_id,
                value: t.value,
                kind: t.kind as TargetView["kind"],
                status: t.status as TargetView["status"],
                notes: t.notes,
                createdAt: t.created_at,
              }),
            ),
            denyTargets: scopeRow?.denyTargets ?? [],
          };
        },
        audit: (entry) => {
          try {
            const detail = {
              host: entry.host,
              port: entry.port,
              verdict: entry.verdict,
              timestamp: entry.timestamp,
              reason: entry.reason ?? null,
            };
            if (entry.taskId) {
              // 和策略审计同一出口：黑板 events（kind=note），不写 body。
              b.note({
                taskId: entry.taskId,
                sessionId: entry.sessionId,
                text: `proxy.request ${JSON.stringify(detail)}`,
              });
            } else {
              b.audit({
                sessionId: entry.sessionId,
                actor: "proxy",
                action: "scope.proxy",
                detail,
              });
            }
          } catch (err) {
            process.stderr.write(`[proxy] 审计写入失败：${(err as Error).message}\n`);
          }
        },
        registry: proxyRegistry,
        // 只更新展示状态：enabled 保持 config 意图，port 只在 running 时保留。
        // 不改代理启停、不改会话恢复/配额/审批。
        onStateChange: (s) => {
          runtimeScope.proxy = {
            enabled: proxyEnabled,
            port: s.state === "running" ? s.port : null,
            state: s.state,
            ...(s.error ? { error: s.error } : {}),
          };
          hubRef?.setScopeProxyRuntime(runtimeScope.proxy);
        },
      });
      const info = await scopeProxy.start();
      process.stdout.write(
        `[main] 本地范围代理已启动：${info.address}:${info.port}（只对遵守 HTTP_PROXY 的工具生效）\n`,
      );
    } catch (err) {
      // 真实状态（failed + error）已由 onStateChange 写入 runtimeScope；这里只丢弃实例。
      scopeProxy = null;
      process.stderr.write(
        `[main] 本地范围代理启动失败（会话照常启动，网络代理未注入）：${(err as Error).message}\n`,
      );
    }
  } else {
    process.stdout.write("[main] 本地范围代理关闭（scope.proxy.enabled=false）\n");
  }

  // P1-D：重启恢复全部**非归档**任务，而不是只接回最近一个。
  // 第一次运行（库里一个任务都没有）才种示例任务；如果只剩归档任务，
  // 不擅自新建，焦点为 null（P1-E 的看板会处理空状态）。
  const hadAnyTask = b.listTasks().length > 0;
  const sample = hadAnyTask
    ? null
    : b.createTask({
        title: "示例任务：本地 HTML 目标",
        brief: "工作目录中的 target/index.html 是一个内部门户页面，含 /admin 登录表单。",
      });
  const activeTasks = b.listActiveTasks();
  // 焦点：优先上次焦点（当前未持久化），否则取 createdAt 最新的非归档任务。
  const focusTaskId = activeTasks[0]?.id ?? null;
  for (const task of activeTasks) {
    mkdirSync(path.join(WORK_ROOT, task.id), { recursive: true });
  }
  if (sample) seedSampleTarget(path.join(WORK_ROOT, sample.id));
  process.stdout.write(
    `[main] 非归档任务 ${activeTasks.length} 个；焦点=${focusTaskId ?? "无"}\n`,
  );
  process.stdout.write(`[main] 工作目录（agent 工作区根）：${WORK_ROOT}\n`);
  const skillStatus = SKILL.status();
  process.stdout.write(
    skillStatus.configured
      ? `[main] 技能库：${skillStatus.root}（${skillStatus.packages.join(", ") || "未识别技能包"}；索引懒构建）\n`
      : `[main] 技能库未配置：${skillStatus.error ?? "无可用路径"}\n`,
  );
  process.stdout.write(
    IR_TOOLS.path
      ? `[main] IR 工具配置：${IR_TOOLS.path}（source=${IR_TOOLS.source}）\n`
      : `[main] IR 工具配置：无（继续 BUMIMANG_* env / PATH）${IR_TOOLS.error ? `；${IR_TOOLS.error}` : ""}\n`,
  );

  const bus = new EventBus();
  const secretCodec: PlatformSecretCodec = {
    encrypt: (plain) => {
      try {
        return safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(plain).toString("base64")
          : null;
      } catch {
        return null;
      }
    },
    decrypt: (encrypted) => {
      try {
        return safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(encrypted, "base64"))
          : null;
      } catch {
        return null;
      }
    },
  };
  const wpLibrary = new WpLibrary({
    root: APP_CONFIG.config.platform.wpDir,
    cachePath: path.join(WORKSPACE, "wp-index.json"),
  });
  const platform = new PlatformService({
    config: APP_CONFIG.config.platform,
    statePath: path.join(WORKSPACE, "platform-state.json"),
    secretPath: path.join(WORKSPACE, "platform-credentials.bin"),
    wpLibrary,
    secretCodec,
    env: process.env,
    onChange: (view) => bus.emit({ type: "platform.updated", platform: view }),
  });
  const runId = newRunId();
  // 会话管理器与 Hub 互相引用（会话变化要通知 Hub，Hub 又要持有会话管理器）。
  // 用先声明后赋值打破这个环，回调只在运行期触发，不存在 TDZ 问题。
  let hub!: HubService;
  let mgr!: SessionManager;

  // 黑板写入后主动推增量给 UI（R16）；游标避免把全部历史事件重推一遍。
  // A11：readSinceForTask 每页最多 200 条，必须用返回的末条 id 分页排空——
  // 一次积压超 200 条时直接推进到 lastEventId() 会永久跳过中间的台账与 flag 候选。
  const flushBoard = (): void => {
    if (!hub) return;
    let guard = 0;
    while (boardCursor < b.lastEventId()) {
      const lastRead = hub.publishBoardSince(boardCursor);
      if (lastRead <= boardCursor) break; // 本页无进展（空页/异常），防死循环
      boardCursor = lastRead;
      if (++guard > 100) break; // 极端写入速率下的保险丝
    }
  };

  // P3-B 批次 2：证据回放。桥先于策略/审批创建，用延迟引用注入；
  // 默认关（APP_CONFIG.config.evidenceReplay 只认 BUMIMANG_EVIDENCE_REPLAY=1）。
  let replayPolicy: Policy | undefined;
  let replayApproval: ApprovalService | undefined;
  const replay = new EvidenceReplayer({
    enabled: APP_CONFIG.config.evidenceReplay,
    policy: () => replayPolicy,
    approval: () => replayApproval,
  });

  // 先建任务，再建桥 —— 桥要按 taskId 过滤视图，顺序反了会拿到空视图。
  // 注意：一个进程里同一个管道名只能有一个监听者，所以桥只建一次。
  const br = new BoardBridge({
    board: b,
    taskId: focusTaskId ?? "",
    runId,
    workRoot: WORK_ROOT,
    // P2-B：技能库只读工具走同一条桥（同会话令牌/审计）；首次 skill_* 调用才构建索引。
    skill: SKILL,
    // P3-B 批次 2：cmd: 回放（默认关）；未开启时 cmd: 仍判 E1。
    replay,
    onBoardRead: (sid) => {
      mgr?.noteBoardRead(sid);
      hub?.publishHealth(sid);
    },
    onBoardWrite: () => flushBoard(),
    // P7-B：MCP 子进程异常断开（正常 revoke/stop 不会触发）→ 标记会话不可用。
    onMcpUnavailable: (sid) => {
      mgr?.markMcpUnavailable(sid);
    },
    // P7-B：MCP 子进程 PID 也登记；正常断开/崩溃后从登记表移除。
    onMcpConnected: (sid, pid, taskId) => {
      if (pid) proxyRegistry?.registerPid(pid, "mcp", { taskId, sessionId: sid });
    },
    onMcpClosed: (_sid, pid) => {
      proxyRegistry?.unregister(pid);
    },
  });
  await br.start();
  bridge = br;

  // 规则包：默认 competition（当届合规包），可用 BUMIMANG_RULES 覆盖
  const packId = process.env.BUMIMANG_RULES ?? "competition";
  const policy = new PolicyEngine({
    repoRoot: RULES_ROOT,
    packId,
    // P4-C：scope 默认关闭；开启后由下面 AcpClient 的提取结果驱动。
    scope: APP_CONFIG.config.scope,
    // P4-C：每次判定写黑板 events（target/rule/verdict），enabled=false 也写。
    onDecision: (record) => {
      const taskId =
        record.taskId ??
        (record.sessionId ? b.getSession(record.sessionId)?.task_id : undefined);
      if (!taskId) {
        // 还没有任务归属（例如引擎被 CLI/测试直接调用）：至少留 audit 索引。
        try {
          b.audit({
            sessionId: record.sessionId,
            actor: "policy",
            action: "policy.decision",
            detail: record,
          });
        } catch {
          /* 审计失败不能影响判定 */
        }
        return;
      }
      try {
        writePolicyAudit(b, taskId, record);
      } catch (err) {
        process.stderr.write(
          `[policy] 审计写入失败（session=${record.sessionId} task=${taskId}）：${(err as Error).message}\n`,
        );
      }
    },
  });
  replayPolicy = policy;
  process.stdout.write(
    `[main] 策略引擎已加载：${policy.name}${policy.fellBackToMinimal ? "（规则包缺失，已回落到内置最小安全集）" : ""}\n`,
  );
  process.stdout.write(
    `[main] 证据回放：${replay.isEnabled() ? "已开启（BUMIMANG_EVIDENCE_REPLAY=1）" : "关闭（默认；cmd: 只判 E1）"}\n`,
  );

  // 审批队列要等 Hub 存在才能拿 intentSummary，所以用延迟引用
  const approvals = new ApprovalQueue({
    onUpsert: (view) => {
      // R18：审批事件也走 Hub 的统一任务过滤入口，调用方不再手写 if。
      hub?.publishApproval(view);
    },
    intentSummary: (sid) => hub.intentSummary(sid),
    // 权限增强：审批卡上显示「读/写/执行…」并决定能否一键放行。
    classify: (detail, ctx) => profileForTask(detail, ctx.taskId),
    // A4：请求/裁决/超时/清场四类变化都落库——重启后能回答「谁批准了什么」。
    onPersist: (view) => {
      b.upsertApproval({
        id: view.id,
        taskId: view.taskId,
        sessionId: view.sessionId,
        action: view.action,
        command: view.command,
        intentSummary: view.intentSummary,
        risk: view.risk,
        rule: view.rule,
        status: view.status,
        decidedBy: view.decidedBy,
        decidedAt: view.decidedAt,
        createdAt: view.createdAt,
        scopeTarget: view.scopeTarget ?? null,
      });
    },
    // 落库/通知失败必须可观测，并且不能阻塞审批结算（queue 内部已保证结算）。
    onError: (err, view, phase) => {
      process.stderr.write(`[approval] ${phase} 回调失败（${view.id}）：${err.message}\n`);
      try {
        b.audit({
          sessionId: view.sessionId,
          actor: "system",
          action: "approval.persist_error",
          detail: { phase, approvalId: view.id, error: err.message },
        });
        flushBoard();
      } catch {
        /* 黑板也不可用时只保留 stderr */
      }
    },
  });
  replayApproval = approvals;
  // §9.6 拒绝退避：**同一个动作**被拒 N 次就终结该会话，免得人工被同一条命令反复打断。
  // 注意计数的键是"请求内容签名"而不是策略规则 id —— 受控档下不命中具体规则的请求
  // rule id 全是 `tier-guarded-default`，用它计数会把两件无关的事算成重复违规。
  const denialThreshold = Math.max(1, Number(process.env.BUMIMANG_DENIAL_THRESHOLD ?? "2"));
  const denials = new DenialTracker(denialThreshold, (sid, sig, n) => {
    void mgr.markBlocked(sid, `同一动作被连续拒绝 ${n} 次（${sig}）`);
  });

  mgr = new SessionManager({
    board: b,
    bridge: br,
    policy,
    // P4-C：scope 配置；manager 只把任务 targets 透传给 AcpClient。
    // P4-D 批次 2：proxyUrlForSession 只在 proxy.enabled 时被调用；未启动返回 null。
    scope: APP_CONFIG.config.scope,
    proxyUrlForSession: (sessionId, taskId) =>
      scopeProxy?.urlForSession(sessionId, taskId) ?? null,
    workspaceRoot: WORKSPACE,
    workRoot: WORK_ROOT,
    // P2-B：首次会话启动触发 ensureIndex；简报按 category/role 注入；MCP env 注入技能库状态。
    skill: SKILL,
    skillMcpMode: APP_CONFIG.config.skill?.mcpMode ?? "auto",
    onLine: (line) => process.stdout.write(`${line}\n`),
    // R16：生产路径用归一化 + 带 seq 的事件（持久化与实时推送共用同一份）
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => {
      hub.publishSessionRec(rec);
      hub.publishHealth(rec.id);
    },
    // P7-B：agent 进程登记；MCP 异常断开时广播事件（不自动重启）。
    processRegistry: proxyRegistry ?? undefined,
    onMcpUnavailable: (sessionId, taskId) => {
      bus.emit({ type: "mcp.unavailable", sessionId, taskId });
    },
    // 唯一的事前闸门：策略说 approve 就向人工要放行（§9.2）。
    // 权限增强：先查该 agent / 该会话是否已有同类操作的授权；命中则不弹窗。
    // 注意这里只会收到策略 verdict=approve 的请求；block 在更早的层就拒绝了，
    // 已授权规则不可能把 block 变成 allow。
    onApprovalRequired: async (sessionId, taskId, detail, decision, action) => {
      const rec = mgr.getSession(sessionId);
      // fail closed：终态会话、taskId 不匹配、任务不存在/已归档的迟到请求一律拒绝。
      // P1-C：不再因为“不是当前焦点任务”而拒绝——后台任务也能起会话并请求审批；
      // 审批事件仍由 Hub 只推焦点任务，全局列表走快照 approvalsAll（P1-E 做视图）。
      const approvalTask = rec ? b.getTask(rec.taskId) : undefined;
      if (
        !rec ||
        rec.taskId !== taskId ||
        ["blocked", "stopped", "failed", "done"].includes(rec.status) ||
        !approvalTask ||
        approvalTask.archived
      ) {
        process.stderr.write(
          `[permission] 拒绝迟到/终态审批：session=${sessionId} ` +
            `status=${rec?.status ?? "missing"} task=${rec?.taskId ?? "?"} ` +
            `archived=${approvalTask?.archived ?? "?"}\n`,
        );
        return false;
      }
      const profile = profileForTask(detail, taskId);
      const grant = permissionStore.match({
        agentId: rec.agent,
        sessionId,
        profile,
      });
      if (grant) {
        process.stdout.write(
          `[permission] 命中已授权规则，自动放行：agent=${rec.agent} session=${sessionId} ` +
            `action=${action} category=${profile.category} scope=${grant.scope}\n`,
        );
        const auditKey = `${sessionId}|${grant.id}`;
        if (!autoAllowAudited.has(auditKey)) {
          autoAllowAudited.add(auditKey);
          b.audit({
            sessionId,
            actor: "system",
            action: "permission.auto_allowed",
            detail: {
              agent: rec.agent,
              action,
              category: profile.category,
              grantId: grant.id,
              scope: grant.scope,
              rule: decision.rule,
            },
          });
          flushBoard();
        }
        return true;
      }
      const o = await approvals.request({
        taskId,
        sessionId,
        // fs/read、terminal/exec 与 request_permission 共用同一道人工闸门；
        // 审批卡上的 action 必须反映真实来源，不能一律写成 request_permission。
        action,
        detail,
        rule: decision.rule,
        reason: decision.reason,
        ruleId: decision.rule,
        // P4-C 批次 2：只有 no-out-of-scope 命中才补结构化目标。用同一 request
        // detail + 当前任务 targets 重算，不重跑 policy.evaluate、不缓存全局状态。
        scopeTarget:
          decision.rule === "no-out-of-scope" && APP_CONFIG.config.scope.enabled
            ? approvalScopeTargetFromBoard(b, taskId, action, detail, decision.rule)
            : null,
      });
      // A4：只有**人工**拒绝才计退避。超时（policy 兜底）不是 agent 的错，
      // 之前把两次超时累计成重复违规、甚至触发 markBlocked，是错的。
      if (o.decidedBy === "human" && o.decision === "denied") {
        denials.note(sessionId, approvalSignature(detail) || decision.rule);
      }
      return o.decision === "approved";
    },
    // 会话进入终态的统一下游清理（停止 / 崩溃 / 策略终止 / 启动回滚都会调）。
    // hub 在下面才构造，闭包运行时已赋值。
    onSessionTerminal: (sessionId) => {
      // 会话结束后撤销代理 token，避免旧会话的 proxy URL 继续可用。
      scopeProxy?.releaseSession(sessionId);
      hub?.onSessionTerminal(sessionId);
    },
  });
  sessions = mgr;

  hub = new HubService({
    board: b,
    sessions: mgr,
    bus,
    workspaceRoot: WORKSPACE,
    workDir: WORK_ROOT,
    // 会话级模型覆盖：opencode 的默认模型已是可用的 deepseek-flash，无需覆盖；
    // codex / claude 用它们各自配置里的默认模型（实测都能 end_turn）。
    models: {},
    approvals,
    policy,
    permissions: permissionStore,
    // P1-C：配额从 config/app.json 读取（默认 3 / 8），在 Hub 的 session.start 路径执行。
    maxSessionsPerTask: APP_CONFIG.config.maxSessionsPerTask,
    maxSessionsTotal: APP_CONFIG.config.maxSessionsTotal,
    platform,
    // V2.1：IR 工具解析（config > env > PATH）。
    irToolResolver: IR_TOOL_RESOLVER,
    // P4-D：快照带范围/代理状态；P6-B 批次 2a：带代理真实 state/error。
    scope: runtimeScope,
    // R24 收敛：首个带证据的 flag 候选出现后，宽限期满停止还在跑的队友会话。
    // BUMIMANG_CONVERGE=off 关闭；BUMIMANG_CONVERGE_GRACE_MS 调宽限（默认 30s）。
    convergeGraceMs:
      process.env.BUMIMANG_CONVERGE === "off"
        ? 0
        : Number(process.env.BUMIMANG_CONVERGE_GRACE_MS ?? 30_000),
  });
  // P6-B 批次 2a：Hub 已就绪；后续代理状态变化（崩溃/主动关闭）可更新快照并广播。
  hubRef = hub;
  hub.setTask(focusTaskId);

  // 平台连接在后台完成：窗口先出，题目缓存立即可见；凭据解密/网络请求不阻塞 UI。
  if (!VERIFY && APP_CONFIG.config.platform.enabled) {
    void platform.autoConnect().catch((err: Error) => {
      process.stderr.write(`[platform] 自动连接失败：${err.message}\n`);
    });
    if (APP_CONFIG.config.platform.autoSync) {
      const intervalMs = APP_CONFIG.config.platform.syncIntervalSeconds * 1000;
      const timer = setInterval(() => {
        const state = platform.snapshot();
        if (state.status !== "connected") return;
        void platform
          .sync()
          .then(() => hub.reconcilePlatformSolvedTasks())
          .catch((err: Error) => {
            process.stderr.write(`[platform] 定时同步失败：${err.message}\n`);
          });
      }, intervalMs);
      timer.unref();
    }
  }

  // P1-D 启动恢复：
  //  1. 全局 stale 恢复只跑一次（上一进程的非终态会话 → stopped，释放其租约/意图）；
  //  2. 逐任务 restoreSessions（幂等；不再重复全局扫描）；
  //  3. 按 task_id 清理上一进程遗留的租约/意图，不能把 A 的泄漏到 B；
  //  4. 逐任务重扫 flag 候选/黑板信号，不整表加载。
  mgr.recoverStaleSessions();
  for (const task of activeTasks) {
    mgr.restoreSessions(task.id, { recover: false });
    b.releaseStaleLeases(task.id);
    b.abandonStaleIntents(task.id);
    hub.recoverTaskSignals(task.id);
  }
  boardCursor = b.lastEventId();

  return { hub, bus, flushBoard };
}

/**
 * IPC 入口的纵深防御：只接受本窗口、且当前 frame 仍是受信自定义 scheme 的调用。
 *
 * preload 把完整 dispatch 暴露给页面，所以「页面被导航到远程内容」就等于把
 * Hub 动作面交给远程页面。sender 校验 + 导航拦截一起做才成立。
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!win || event.sender !== win.webContents) return false;
  const url = event.senderFrame?.url ?? "";
  return url.startsWith(`${RENDERER_SCHEME}://`);
}

function registerIpc(
  hub: HubService,
  bus: EventBus,
  flushBoard: () => void,
  skill: SkillRuntime,
): void {
  const denyUntrusted = (): never => {
    throw new Error("拒绝来自非受信渲染进程的 IPC 调用");
  };
  ipcMain.handle(HUB_CHANNELS.snapshot, (event) => {
    if (!isTrustedSender(event)) denyUntrusted();
    // P2-A：skill 是可选加法字段；旧渲染层不读它也能工作。
    // P7-A：healthChain 只告警；旧渲染层/旧快照没有该字段。
    const snap = withSkillStatus(hub.snapshot(), skill.status());
    return board ? { ...snap, healthChain: board.getHealthChain() } : snap;
  });
  ipcMain.handle(HUB_CHANNELS.history, (event, sessionId: unknown) => {
    if (!isTrustedSender(event)) denyUntrusted();
    const sid = typeof sessionId === "string" ? sessionId.slice(0, 128) : "";
    return hub.history(sid);
  });
  // P3-C：只读预览。路径由渲染层从快照派生；Hub 再做 realpath/越界校验。
  ipcMain.handle(HUB_CHANNELS.artifactPreview, (event, raw: unknown) => {
    if (!isTrustedSender(event)) denyUntrusted();
    const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const taskId =
      typeof payload.taskId === "string" && payload.taskId.trim()
        ? payload.taskId.trim().slice(0, 128)
        : undefined;
    const relPath = typeof payload.path === "string" ? payload.path.slice(0, 4096) : "";
    if (!relPath) {
      return { kind: "unsupported", content: "路径为空", error: "路径为空" };
    }
    return hub.previewArtifact(taskId, relPath);
  });
  // P3-C：系统选择器只返回绝对路径；导入仍走 attachment.import（P3-A 的校验/落盘）。
  ipcMain.handle(HUB_CHANNELS.attachmentPick, async (event, raw: unknown) => {
    if (!isTrustedSender(event)) denyUntrusted();
    const kind = raw === "folder" || raw === "zip" ? raw : "files";
    const opts: OpenDialogOptions =
      kind === "folder"
        ? { title: "选择附件文件夹", properties: ["openDirectory"] }
        : kind === "zip"
          ? {
              title: "选择 ZIP 附件",
              properties: ["openFile"],
              filters: [{ name: "ZIP", extensions: ["zip"] }],
            }
          : { title: "选择附件文件", properties: ["openFile", "multiSelections"] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return { canceled: res.canceled, paths: res.canceled ? [] : res.filePaths };
  });
  ipcMain.handle(HUB_CHANNELS.dispatch, async (event, raw: unknown) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: "拒绝来自非受信渲染进程的 IPC 调用" };
    }
    let action;
    try {
      action = validateHubAction(raw);
    } catch (err) {
      return { ok: false, error: `非法动作：${(err as Error).message}` };
    }
    const res = await hub.dispatch(action);
    // 动作往往会改状态，推一版任务视图给渲染进程。用 currentTaskView 而不是整份
    // snapshot：后者每次都会重新探测 agent（本机约 300ms/次）。
    ipcEventSends += 1;
    win?.webContents.send(HUB_CHANNELS.event, {
      type: "task.upsert",
      task: hub.currentTaskView() ?? {
        id: "",
        title: "",
        brief: "",
        status: "open",
        answer: null,
        solvedBy: null,
        createdAt: 0,
      },
    });
    flushBoard();
    return res;
  });
  // 总线上的事件直接透传给渲染进程
  bus.on((e) => {
    if ((e.type === "session.stream" || e.type === "health") && !hub.isWorkspaceView()) {
      return;
    }
    // D2：session.stream 在 IPC 层 80ms 合并；其余事件立即发送。
    if (e.type === "session.stream") {
      queueStreamEvent(e);
      return;
    }
    ipcEventSends += 1;
    win?.webContents.send(HUB_CHANNELS.event, e);
  });
}

async function createWindow(
  hub: HubService,
  bus: EventBus,
  flushBoard: () => void,
  skill: SkillRuntime,
): Promise<void> {
  const preloadPath = path.join(HERE, "preload.cjs");
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#0f1216",
    title: "不迷茫",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // preload 只用 require("electron")，沙箱渲染进程允许；生产打包不传 --no-sandbox 时
      // 由 Chromium 提供 OS 级隔离。开发脚本里的 --no-sandbox 仍会关闭它（仅限本机调试）。
      sandbox: true,
    },
  });

  // 纵深防御：preload 把 dispatch 暴露给页面，所以页面一旦被导航到远程内容，
  // 远程页面就会拿到完整 Hub 动作面。禁止新窗口、禁止离开自定义 scheme。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${RENDERER_SCHEME}://`)) {
      event.preventDefault();
      process.stdout.write(`[main] 已阻止导航：${url}\n`);
    }
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!url.startsWith(`${RENDERER_SCHEME}://`)) {
      event.preventDefault();
      process.stdout.write(`[main] 已阻止重定向：${url}\n`);
    }
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    process.stdout.write(`[main] 已拒绝网页权限请求：${permission}\n`);
    callback(false);
  });

  win.once("ready-to-show", () => win?.show());
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stdout.write(`[main] 页面加载失败 ${code} ${desc} ${url}\n`);
  });
  win.webContents.on("console-message", (_e, level, message) => {
    // D5.2 / D7a：renderer heartbeat 带 visibility/gap；记录可见性切换，
    // hidden 的 gap 标 throttled-hidden，visible 的真实 gap 标 stall。
    const hb = parseRendererHeartbeat(message);
    if (hb) {
      const prevVisibility = lastRendererVisibility;
      lastRendererHeartbeat = Date.now();
      lastRendererVisibility = hb.visibility;
      if (
        prevVisibility !== "unknown" &&
        hb.visibility !== "unknown" &&
        prevVisibility !== hb.visibility
      ) {
        obsLog(`renderer visibility ${prevVisibility} -> ${hb.visibility}`);
        lastHeartbeatWarn = 0;
      }
      const eventKind = classifyHeartbeatEvent(hb);
      if (eventKind !== "none" && Date.now() - lastHeartbeatWarn > 30000) {
        lastHeartbeatWarn = Date.now();
        if (eventKind === "throttled-hidden") {
          obsLog(
            `renderer heartbeat throttled-hidden gapMs=${Math.round(hb.gapMs ?? 0)} (visibility=${hb.visibility})`,
          );
        } else {
          obsLog(
            `renderer heartbeat stall gapMs=${Math.round(hb.gapMs ?? 0)} (visibility=${hb.visibility})`,
          );
        }
      }
    }
    process.stdout.write(`[renderer:${level}] ${message}\n`);
  });
  // P6-C 批次 1.6b / D5：renderer 健康事件（只日志，不改变行为）。
  win.webContents.on("unresponsive", () => {
    obsLog("renderer unresponsive");
  });
  win.webContents.on("responsive", () => {
    obsLog("renderer responsive");
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    obsLog(
      `renderer process gone reason=${String(details.reason)} exitCode=${String(details.exitCode)}`,
    );
  });
  startObservability();

  registerIpc(hub, bus, flushBoard, skill);
  registerRendererProtocol();
  await win.loadURL(`${RENDERER_SCHEME}://./renderer.html`);
  process.stdout.write("[main] 窗口已加载\n");

  if (VERIFY) {
    await runVerify(hub);
  }
}

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * 验收断言 —— 证明「渲染进程确实连上了真实 IPC」而不是回落到 mock。
 * 这是 T11 的实质内容：hub.ts 的 resolveHub() 看到 window.bumimang 就切真实桥。
 */
async function runVerify(hub: HubService): Promise<void> {
  const out: Assertion[] = [];
  const check = (name: string, pass: boolean, detail = ""): void => {
    out.push({ name, pass, detail });
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
  };

  // 给渲染进程一点时间跑完首屏
  await new Promise((r) => setTimeout(r, 1500));

  // 硬超时：验证模式绝不能挂住。之前几次 --verify 卡死留下了残留进程占着 profile，
  // 所以这里无论断言进行到哪一步，到点就写证据并退出。
  const hardStop = setTimeout(() => {
    const logDir0 = EVIDENCE_DIR;
    mkdirSync(logDir0, { recursive: true });
    writeFileSync(
      path.join(logDir0, "ui-verify.json"),
      JSON.stringify({ passed: 0, total: out.length, timeout: true, assertions: out }, null, 2),
      "utf8",
    );
    process.stdout.write("[verify] 硬超时退出\n");
    app.exit(9);
  }, 25000);

  const probe = (await win!.webContents.executeJavaScript(`(async () => {
    const out = { hasBridge: false, snapshotOk: false, taskTitle: null, agentCount: 0,
                  sessionCount: 0, workDir: null, taskId: null, taskWorkDir: null,
                  historyOk: false, taskStatus: null,
                  workDirShown: false, columns: [], bodyText: "",
                  grantAllOk: false, globalGrantOk: false, globalRevoked: false,
                  badActionRejected: false,
                  allowAllCheckbox: false, hasGrantAllBtn: false };
    out.hasBridge = typeof window.bumimang === "object" && window.bumimang !== null;
    if (out.hasBridge) {
      const snap = await window.bumimang.snapshot();
      out.snapshotOk = !!snap;
      out.taskTitle = snap && snap.task ? snap.task.title : null;
      out.agentCount = snap && snap.agents ? snap.agents.length : 0;
      out.sessionCount = snap && snap.sessions ? snap.sessions.length : 0;
      out.workDir = snap && snap.workDir ? snap.workDir : null;
      out.taskId = snap && snap.task ? snap.task.id : null;
      out.taskWorkDir = snap && snap.task ? (snap.task.workDir ?? null) : null;
      // R16：历史通道必须真的存在；未知会话应返回空数组（而不是报错/undefined）。
      const hist = await window.bumimang.history("no-such-session");
      out.historyOk = Array.isArray(hist) && hist.length === 0;
      out.policyName = snap && snap.policy ? snap.policy.name : null;
      out.policyFellBack = snap && snap.policy ? snap.policy.fellBackToMinimal : null;
      out.gateAware = (snap && snap.agents ? snap.agents : [])
        .filter(a => a.permissionBehavior === "requests_by_default")
        .map(a => a.id);
      out.gateNeedsConfig = (snap && snap.agents ? snap.agents : [])
        .filter(a => a.permissionBehavior === "needs_config")
        .map(a => a.id);
      // 一键全权：IPC 通道可用，且非法 tier 会被主进程校验拒绝（不会静默落到 autonomous）。
      const grantRes = await window.bumimang.dispatch({ type: "permission.grantAll", scope: "all" });
      out.grantAllOk = Boolean(grantRes && grantRes.ok);
      const globalRes = await window.bumimang.dispatch({ type: "permission.grantAll", scope: "global" });
      out.globalGrantOk = Boolean(globalRes && globalRes.ok);
      const revokeGlobalRes = await window.bumimang.dispatch({ type: "permission.revoke", agentId: "*" });
      out.globalRevoked = Boolean(revokeGlobalRes && revokeGlobalRes.ok);
      const badRes = await window.bumimang.dispatch({
        type: "session.start", taskId: out.taskId, agent: "claude", role: "lead", tier: "guarded "
      });
      out.badActionRejected = Boolean(badRes && badRes.ok === false);
      out.hasGrantAllBtn = Boolean(
        document.querySelector('[data-bulk="grant-all"], [data-bulk="revoke-global"]'),
      );
      // 打开扇出弹窗，确认「全部放行」勾选存在，再点取消关闭。
      const plus = document.querySelector(".btn-plus");
      if (plus) plus.click();
      await new Promise(r => setTimeout(r, 80));
      out.allowAllCheckbox = Boolean(document.querySelector(".fanout-check"));
      const cancel = document.querySelector(".fanout-overlay .btn-cancel");
      if (cancel) cancel.click();
    }
    out.columns = Array.from(document.querySelectorAll(".col-left, .col-mid, .col-right, main"))
      .map(n => n.className || n.tagName.toLowerCase())
      .slice(0, 5);
    out.panelTitles = Array.from(document.querySelectorAll(".panel-title"))
      .map(n => (n.textContent || "").trim());
    const badge = document.querySelector(".task-status-badge");
    out.taskStatus = badge ? (badge.textContent || "").trim() : null;
    out.workDirShown = Boolean(out.taskWorkDir) &&
      (document.body.innerText || "").includes(out.taskWorkDir);
    out.bodyText = (document.body.innerText || "").slice(0, 300);
    return out;
  })()`)) as {
    hasBridge: boolean;
    snapshotOk: boolean;
    taskTitle: string | null;
    agentCount: number;
    sessionCount: number;
    workDir: string | null;
    taskId: string | null;
    taskWorkDir: string | null;
    historyOk: boolean;
    taskStatus: string | null;
    workDirShown: boolean;
    policyName: string | null;
    policyFellBack: boolean | null;
    gateAware: string[];
    gateNeedsConfig: string[];
    grantAllOk: boolean;
    globalGrantOk: boolean;
    globalRevoked: boolean;
    badActionRejected: boolean;
    allowAllCheckbox: boolean;
    hasGrantAllBtn: boolean;
    columns: string[];
    panelTitles: string[];
    bodyText: string;
  };

  check("preload 暴露了 window.bumimang（真实 IPC 路径，不是 mock）", probe.hasBridge);
  check("hub:snapshot 通道可用并返回快照", probe.snapshotOk);
  check("快照里有任务", Boolean(probe.taskTitle), `task="${probe.taskTitle}"`);
  check("快照里有 agent 检测结果（4 家）", probe.agentCount === 4, `agents=${probe.agentCount}`);
  check(
    "快照带上了当前策略规则包（应 Lane B 请求 R-1）",
    probe.policyName !== null,
    `pack="${probe.policyName}" 回落到最小安全集=${probe.policyFellBack}`,
  );
  check(
    "快照标出三家的审批输入能力（claude 原生 / opencode 注入配置 / codex 切 workspace-write）",
    ["claude", "opencode", "codex"].every((id) => probe.gateAware.includes(id)),
    `会有审批输入=${JSON.stringify(probe.gateAware)} 需配置=${JSON.stringify(probe.gateNeedsConfig)}`,
  );
  check(
    "快照带上了受限工作目录（agent 工作区）",
    typeof probe.workDir === "string" && probe.workDir.length > 0,
    `workDir="${probe.workDir}"`,
  );
  check("hub:history 通道可用（未知会话返回空数组）", probe.historyOk);
  check("IPC：permission.grantAll 通道可用（一键全权）", probe.grantAllOk);
  check("IPC：scope=global 全局放行通道可用", probe.globalGrantOk);
  check("IPC：agentId=* 可关闭全局放行", probe.globalRevoked);
  check("IPC：非法 tier 被运行时校验拒绝（不会静默落到自主档）", probe.badActionRejected);
  check("扇出弹窗有「全部放行」勾选", probe.allowAllCheckbox);
  check("审批面板有「全局全部允许」入口", probe.hasGrantAllBtn);
  check(
    "任务栏显示「待解 / 已解出」状态徽标",
    probe.taskStatus !== null && probe.taskStatus.length > 0,
    `badge="${probe.taskStatus}"`,
  );
  check("任务卡显示受限工作目录（任务专属）", probe.workDirShown, `taskWorkDir="${probe.taskWorkDir}"`);
  check(
    "快照任务带任务专属工作目录（<根>/<taskId>）",
    probe.taskWorkDir !== null &&
      probe.taskId !== null &&
      probe.taskWorkDir === path.join(probe.workDir ?? "", probe.taskId),
    `taskWorkDir="${probe.taskWorkDir}" root="${probe.workDir}" taskId="${probe.taskId}"`,
  );
  check(
    "渲染进程画出了三栏（真实选择器：.col-left / .col-mid / .col-right）",
    probe.columns.length >= 3,
    `命中：${JSON.stringify(probe.columns)}`,
  );
  check(
    "面板标题都在（会话 / 审批队列 / 黑板台账）",
    ["会话", "审批队列", "黑板台账"].every((t) => probe.panelTitles.some((p) => p.includes(t))),
    `标题：${JSON.stringify(probe.panelTitles)}`,
  );
  check("页面有实际文本内容（没白屏）", probe.bodyText.trim().length > 20, `${probe.bodyText.trim().length} 字符`);

  // 真正走一次 hub:action → 核心 → 事件回流，验证 action 通道
  const act = (await win!.webContents.executeJavaScript(
    `window.bumimang.dispatch({ type: "task.create", title: "验收任务", brief: "由 --verify 创建" })`,
  )) as { ok: boolean; error?: string };
  check("hub:action 通道可派发动作", Boolean(act?.ok), JSON.stringify(act));

  const after = hub.snapshot();
  check(
    "动作真的改到了核心状态",
    after.task?.title === "验收任务",
    `核心里的任务标题 = "${after.task?.title}"`,
  );

  // R16：任务栏「待解 → 已解出」必须真的跟着动作走（核心 + 渲染层 + DB）。
  const taskStatus = (await win!.webContents.executeJavaScript(`(async () => {
    const snap = await window.bumimang.snapshot();
    const res = await window.bumimang.dispatch({
      type: "task.setStatus", taskId: snap.task.id, status: "solved", answer: "flag{verify_ok}"
    });
    await new Promise(r => setTimeout(r, 200));
    return {
      ok: res && res.ok,
      badge: (document.querySelector(".task-status-badge") || {}).textContent || null,
      answer: (document.querySelector(".task-answer") || {}).textContent || null,
    };
  })()`)) as { ok: boolean; badge: string | null; answer: string | null };
  check("task.setStatus 动作成功", Boolean(taskStatus.ok), JSON.stringify(taskStatus));
  check("任务栏徽标从「待解」变「已解出」", taskStatus.badge === "已解出", `badge="${taskStatus.badge}"`);
  check("任务栏显示人工确认的答案", taskStatus.answer === "flag{verify_ok}", `answer="${taskStatus.answer}"`);
  check("任务状态已落库（重启仍在）", hub.snapshot().task?.status === "solved", `status=${hub.snapshot().task?.status}`);

  const passed = out.filter((o) => o.pass).length;
  const summary = { passed, total: out.length, assertions: out };
  const logDir = EVIDENCE_DIR;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, "ui-verify.json"), JSON.stringify(summary, null, 2), "utf8");
  process.stdout.write(
    `\n[verify] ${passed}/${out.length} 通过，证据写入 ${path.join(logDir, "ui-verify.json")}\n`,
  );

  setTimeout(() => app.quit(), 300);
}

app.whenReady().then(async () => {
  const { hub, bus, flushBoard } = await bootstrap();
  await createWindow(hub, bus, flushBoard, SKILL);
});

app.on("window-all-closed", () => {
  app.quit();
});

let shuttingDown = false;
let allowQuit = false;
app.on("before-quit", (event) => {
  // R18：先阻止这次退出，等会话真正收尾（含 exit 回调写库）后再 quit。
  // 否则 board.close() 会先执行，迟到的 onAgentExit 报 database is not open。
  // 收尾期间的重复退出请求也一律拦住，避免第二次 quit 抢在关库之前把进程带走。
  if (allowQuit) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    let shutdownError: Error | null = null;
    let result: Awaited<ReturnType<SessionManager["shutdown"]>> | undefined;
    try {
      result = await sessions?.shutdown();
    } catch (err) {
      shutdownError = err instanceof Error ? err : new Error(String(err));
    }
    // 先完成所有可做的收尾，再明确地把失败报告出去；不能静默当成成功退出。
    // P4-D：先关代理，避免子进程/端口在 board.close 后仍存活。
    try {
      await scopeProxy?.close();
    } catch (err) {
      process.stderr.write(`[main] 代理关闭失败：${(err as Error).message}\n`);
    }
    scopeProxy = null;
    try {
      const stopped = await proxyRegistry?.terminateAll(1500);
      if (stopped && stopped.timedOut.length > 0) {
        process.stderr.write(`[main] 代理进程未在宽限内退出：${stopped.timedOut.join(",")}\n`);
      }
    } catch (err) {
      process.stderr.write(`[main] 代理进程清理失败：${(err as Error).message}\n`);
    }
    proxyRegistry = null;
    // D2：把最后 80ms 内缓冲的 stream 刷给 renderer，再关桥/库。
    flushStreamEvents();
    bridge?.stop();
    board?.close();
    allowQuit = true;
    if (shutdownError) {
      process.stderr.write(`[main] 退出收尾失败：${shutdownError.message}\n`);
      process.exitCode = 1;
      app.exit(1);
      return;
    }
    if (result?.timedOut) {
      process.stderr.write(
        `[main] 退出收尾超时：${result.pendingSessions.join(",") || "?"} 未退出，` +
          `已强制落 stopped 并关闭黑板（exit=1）\n`,
      );
      process.exitCode = 1;
      app.exit(1);
      return;
    }
    if (result && !result.allExited) {
      process.stderr.write(`[main] 退出收尾未确认所有进程退出（exit=1）\n`);
      process.exitCode = 1;
      app.exit(1);
      return;
    }
    app.quit();
  })();
});
