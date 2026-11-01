/**
 * Lane B · 第 9 轮 · 黑板台账「钱截图」：真实 claude 经冻结契约起会话，把一条**真实死路**
 * 写进共享黑板（blackboard_declare_dead_end），等快照出现非空 deadEnds，截图非空台账。
 *
 * 这是 BLACKBOARD 这个核心差异点的第一张真实视觉证据 —— 台账面板此前从未显示过
 * **由真实 agent 生产**的内容（T9 只有 mock；T13 只有合成 board.appended 事件）。
 * L-3 修复后（MCP 子进程用 ELECTRON_RUN_AS_NODE=1 起来），写路径第一次可以端到端走通：
 *
 *   1. 经冻结契约 `window.bumimang.dispatch` 派发 `session.start {agent:"claude", tier:"guarded"}`
 *   2. 等会话 idle（含自动注入的简报轮；简报里已写明「确认某条路走不通 → blackboard_declare_dead_end」）
 *   3. 派发 `session.prompt`：让 claude 用 blackboard_declare_dead_end 写一条带唯一标记的死路
 *   4. 轮询 `snapshot.board.deadEnds`，等本轮 prompt 之后的新条目出现（≤150s；期间若 claude 发来审批，自动放行并如实记录）
 *   5. 触发一次与 dispatch 路径相同的 `publishBoardSince(0)`，让台账 DOM 重拉快照后截图
 *   6. 断言：条目文字与我要求的一致（含唯一标记 + /admin）、by 是 agent 会话、createdAt 在本轮 prompt 之后、
 *      wire.jsonl 里真有 blackboard_declare_dead_end 的 tool_call、audit 表里 deadend.declare 的 actor 是会话
 *
 * 附带观测（第 9 轮实测）：claude 读完简报后，可能在简报轮就主动调 blackboard_declare_dead_end
 * 写一条死路 —— 这本身是写路径有效的更强证据，本入口不要求「派发 prompt 前黑板必须为空」。
 *
 * 只 import、不修改 src/main（Lane A 的 lane）；契约 events.ts 冻结未动。
 * 若 claude 在超时内没写，如实截图并记录，绝不种入假条目。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/real-board-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|step|real-board"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { DeadEndView, HubSnapshot } from "../../../packages/shared-protocol/events.ts";
import { Blackboard } from "../src/main/blackboard/board.ts";
import { BoardBridge } from "../src/main/mcp-host/bridge.ts";
import { PolicyEngine } from "../src/main/policy/engine.ts";
import { ApprovalQueue, DenialTracker } from "../src/main/approval/queue.ts";
import { SessionManager, newRunId } from "../src/main/session/manager.ts";
import { EventBus, HubService } from "../src/main/hub/hub.ts";
import { installedAgents } from "../src/main/discovery/detect.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 验证专用工作区：每次运行清空，不污染 Lane A 的 .ui-run/board.db */
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "verify-real-board");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

const AGENT = "claude";
/** 唯一标记：断言「这条死路就是我这一轮要求的」，也用于在 wire.jsonl 里搜到真实 tool_call */
const MARKER = "BM-VERIFY-9";
const DEAD_END_DESCRIPTION = `/admin 后台弱口令爆破不可用（已试 top20 常见口令，均被拒绝；${MARKER}）`;
const DEAD_END_SCOPE = "http";
const PROMPT_TEXT =
  `请在共享黑板上声明一条死路。用 blackboard_declare_dead_end 工具写入，参数照下面写：\n` +
  `- description = "${DEAD_END_DESCRIPTION}"\n` +
  `- scope = "${DEAD_END_SCOPE}"\n\n` +
  `这是对共享黑板写路径的验收演示：不需要真的去扫描或尝试任何目标，只调用工具写入即可。写完就结束，不要再做别的事。`;

// 独立 userData，避免与 Lane A 的 main.ts 抢文件锁。
app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-real-board"));
app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

const assertions: Assertion[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  assertions.push({ name, pass, detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
}

const timeline: Array<{ t: number; msg: string }> = [];
/** 全程自动放行的真实审批（简报轮 + 写死路那一轮）。放行 ≠ 种数据，全部如实记录。 */
const autoApproved: Array<{
  phase: string;
  id: string;
  action: string;
  command: string | null;
  rule: string | null;
  decidedAt: number;
}> = [];
function step(msg: string): void {
  const t = Date.now();
  timeline.push({ t, msg });
  process.stdout.write(`[step] ${new Date(t).toISOString().slice(11, 19)} ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let win: BrowserWindow | null = null;
let board: Blackboard | null = null;
let bridge: BoardBridge | null = null;
let sessions: SessionManager | null = null;

const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
const bridgeLogs: string[] = [];
let rendererGone: string | null = null;

async function cleanup(): Promise<void> {
  sessions?.shutdown();
  bridge?.stop();
  // shutdown() 会 kill claude 子进程；其 onAgentExit 是异步 fire-and-forget，会写黑板。
  // 等它跑完再关库，否则撞 "database is not open"。
  await sleep(500);
  board?.close();
}

/**
 * 照 Lane A 的 main.ts 原样接线：PolicyEngine（guarded 档）+ 真实 ApprovalQueue +
 * SessionManager 的 onApprovalRequired 指向队列。唯一区别是跑在 Lane B 自己的验证工作区、
 * 用独立 userData，并额外给 BoardBridge 挂 log 以观测「MCP 子进程真的连上了」（L-3 的证据）。
 */
async function bootstrap(): Promise<{ hub: HubService; bus: EventBus; approvals: ApprovalQueue; taskId: string }> {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORKSPACE, { recursive: true });

  const b = Blackboard.open(path.join(WORKSPACE, "board.db"));
  board = b;

  const t = b.createTask({
    title: "验收演示任务",
    brief: "本任务仅用于验证共享黑板的写路径（agent 经 MCP 写死路），暂无实际目标。",
  });

  const runId = newRunId();
  const br = new BoardBridge({
    board: b,
    taskId: t.id,
    runId,
    log: (m) => {
      bridgeLogs.push(m);
      step(`[bridge] ${m}`);
    },
  });
  await br.start();
  bridge = br;

  const policy = new PolicyEngine({ repoRoot: REPO_ROOT, packId: "competition" });
  step(`策略引擎已加载：${policy.name}${policy.fellBackToMinimal ? "（回落到最小安全集）" : ""}`);
  const bus = new EventBus();

  let hub!: HubService;
  let mgr!: SessionManager;
  const approvals = new ApprovalQueue({
    onUpsert: (view) => bus.emit({ type: "approval.upsert", approval: view }),
    intentSummary: (sid) => hub.intentSummary(sid),
  });
  const denials = new DenialTracker(2, (sid, rule, n) => {
    void mgr.markBlocked(sid, `同一规则被连续拒绝 ${n} 次（${rule}）`);
  });

  mgr = new SessionManager({
    board: b,
    bridge: br,
    policy,
    workspaceRoot: WORKSPACE,
    onLine: (line) => process.stdout.write(`${line}\n`),
    onStream: (sessionId, raw) => hub.publishStream(sessionId, raw),
    onSessionChange: (rec) => hub.publishSessionRec(rec),
    onApprovalRequired: async (sessionId, taskId, detail, decision) => {
      step(`onApprovalRequired 触发：session=${sessionId} rule=${decision.rule} title=${JSON.stringify(detail.title ?? null)}`);
      const o = await approvals.request({
        taskId,
        sessionId,
        action: "session/request_permission",
        detail,
        rule: decision.rule,
        reason: decision.reason,
      });
      if (o.decidedBy === "human" && o.decision === "denied") denials.note(sessionId, decision.rule);
      step(`审批队列返回：${d}`);
      return o.decision === "approved";
    },
  });
  sessions = mgr;

  hub = new HubService({
    board: b,
    sessions: mgr,
    bus,
    workspaceRoot: WORKSPACE,
    models: {},
    approvals,
    policy,
  });
  hub.setTask(t.id);

  return { hub, bus, approvals, taskId: t.id };
}

function registerIpc(hub: HubService, bus: EventBus): void {
  ipcMain.handle(HUB_CHANNELS.snapshot, () => hub.snapshot());
  ipcMain.handle(HUB_CHANNELS.dispatch, async (_e, action: unknown) => {
    const res = await hub.dispatch(action as never);
    win?.webContents.send(HUB_CHANNELS.event, {
      type: "task.upsert",
      task: hub.snapshot().task ?? {
        id: "", title: "", brief: "", status: "open", answer: null, solvedBy: null, createdAt: 0,
      },
    });
    if (hub.currentTaskId) hub.publishBoardSince(0);
    return res;
  });
  bus.on((e) => {
    win?.webContents.send(HUB_CHANNELS.event, e);
  });
}

async function createWindow(hub: HubService, bus: EventBus): Promise<void> {
  const preloadPath = path.join(HERE, "preload.cjs");
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#f6f8fa",
    title: "不迷茫",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    loadFailures.push({ code, desc, url });
  });
  // Electron 44 的 console-message 签名是 (event,{level,message})；旧代 (event,level,message)。
  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { level?: string | number; message?: string } | undefined;
    const legacyMessage = args[2] as string | undefined;
    const message = typeof ev?.message === "string" ? ev.message : (legacyMessage ?? String(args[2] ?? ""));
    const level = ev?.level ?? args[1] ?? "log";
    consoleLogs.push({ level: String(level), message });
  });
  win.webContents.on("render-process-gone", (_e, details: { reason: string }) => {
    rendererGone = details.reason;
  });

  registerIpc(hub, bus);
  registerRendererProtocol();
  await win.loadURL(`${RENDERER_SCHEME}://./renderer.html`);
  step("窗口已加载");
}

async function evalJs<T>(js: string): Promise<T> {
  return (await win!.webContents.executeJavaScript(js, true)) as T;
}

/** 轮询渲染进程里的一个异步 JS 条件（IIFE），直到为真或超时。 */
async function poll(condJs: string, timeoutMs: number, intervalMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await win!.webContents.executeJavaScript(condJs, true)) as boolean) {
        step(`poll:${label} 命中（${Date.now() - start}ms）`);
        return true;
      }
    } catch (e) {
      lastErr = String((e as Error).message ?? e);
    }
    await sleep(intervalMs);
  }
  step(`poll:${label} 超时（${timeoutMs}ms）${lastErr ? ` lastErr=${lastErr}` : ""}`);
  return false;
}

async function getSnapshot(): Promise<HubSnapshot> {
  return (await evalJs<HubSnapshot>(`window.bumimang.snapshot()`));
}

async function screenshot(name: string): Promise<string> {
  const img = await win!.webContents.capturePage();
  const png = img.toPNG();
  const pngPath = path.join(LOGS_DIR, name);
  writeFileSync(pngPath, png);
  const jpgPath = pngPath.replace(/\.png$/, ".jpg");
  writeFileSync(jpgPath, img.toJPEG(82));
  step(`截图 ${name}（${png.length} bytes, ${img.getSize().width}x${img.getSize().height}）`);
  return pngPath;
}

/** 台账 DOM 探针（死路区）。 */
const BOARD_PROBE_JS = `(() => {
  const deads = Array.from(document.querySelectorAll(".board-list.deadends li.deadend"));
  const titles = Array.from(document.querySelectorAll(".board-panel .board-title"))
    .map((n) => (n.textContent || "").trim());
  return {
    deadEndCount: deads.length,
    descs: deads.map((d) => (d.querySelector(".deadend-desc") ? d.querySelector(".deadend-desc").textContent.trim() : "")),
    bys: deads.map((d) => (d.querySelector(".deadend-by") ? d.querySelector(".deadend-by").textContent.trim() : "")),
    titles,
    emptyBanner: !!document.querySelector(".board-empty-banner"),
  };
})()`;

/** 从 wire.jsonl 提取「agent 真的调了 blackboard_declare_dead_end」的硬证据。 */
function readWireEvidence(sessionId: string): { declareLines: unknown[]; markerLines: number } {
  const p = path.join(WORKSPACE, "sessions", sessionId, "wire.jsonl");
  if (!existsSync(p)) return { declareLines: [], markerLines: 0 };
  const text = readFileSync(p, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const declareLines: unknown[] = [];
  let markerLines = 0;
  for (const line of lines) {
    if (line.includes("blackboard_declare_dead_end") || line.includes("declare_dead_end")) {
      try {
        declareLines.push(JSON.parse(line));
      } catch {
        declareLines.push({ raw: line.slice(0, 600) });
      }
    }
    if (line.includes(MARKER)) markerLines += 1;
  }
  return { declareLines: declareLines.slice(-12), markerLines };
}

/** 自动放行当前所有 pending 审批，并如实记录。返回放行条数。 */
async function approveAllPending(phase: string): Promise<number> {
  const snap = await getSnapshot();
  const pending = snap.approvals.filter((a) => a.status === "pending");
  for (const a of pending) {
    step(`[${phase}] 自动放行真实审批：${a.id} rule=${a.rule} cmd=${(a.command ?? a.action).slice(0, 90)}`);
    autoApproved.push({
      phase,
      id: a.id,
      action: a.action,
      command: a.command,
      rule: a.rule,
      decidedAt: Date.now(),
    });
    await evalJs<boolean>(
      `window.bumimang.dispatch({ type: "approval.decide", approvalId: ${JSON.stringify(a.id)}, decision: "approve" }).then(() => true)`,
    );
  }
  return pending.length;
}

/** 等会话 idle，但简报轮里 claude 若真的发来审批（探索/读环境），像真人一样放行并记录。 */
async function waitForIdleDraining(sessionId: string, timeoutMs: number): Promise<{ idle: boolean; drained: number }> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const c = s.sessions.find((x) => x.id === sessionId);
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      drained += await approveAllPending("briefing");
      continue;
    }
    if (c && c.status === "idle") {
      step(`会话 idle（简报轮完成，期间放行 ${drained} 条真实审批）`);
      return { idle: true, drained };
    }
    await sleep(1000);
  }
  step(`等 idle 超时（${timeoutMs}ms），已放行 ${drained} 条`);
  return { idle: false, drained };
}

/**
 * 等黑板出现本轮 prompt 之后的新死路（≤timeoutMs）。期间若 claude 发来审批，自动放行，
 * 别让「等审批」卡住写路径。返回是否出现、放行条数。
 */
async function waitForDeadEnd(promptAt: number, timeoutMs: number): Promise<{ appeared: boolean; drained: number }> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      drained += await approveAllPending("dead-end-turn");
      continue;
    }
    if (s.board.deadEnds.some((d) => d.createdAt >= promptAt)) {
      step(`黑板出现本轮新死路（${Date.now() - start}ms）`);
      return { appeared: true, drained };
    }
    await sleep(1000);
  }
  step(`等黑板死路超时（${timeoutMs}ms），自动放行 ${drained} 条`);
  return { appeared: false, drained };
}

async function runVerify(hub: HubService, approvals: ApprovalQueue, taskId: string): Promise<void> {
  // —— 首屏就绪 ——
  const ready = await poll(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3;
    })()`,
    12000,
    100,
    "窗口就绪",
  );
  check("真实窗口 + 真实桥就绪（三栏渲染）", ready);

  const installed = installedAgents();
  const claude = installed.find((a) => a.id === AGENT);
  check(`本机有可用的 ${AGENT} 适配器`, Boolean(claude?.launch), claude ? `${claude.launch!.command} ${claude.launch!.args.join(" ")}` : "未检测到");

  if (!claude?.launch) {
    await finish({ outcome: "claude-not-installed" });
    return;
  }

  // —— 1. 经冻结契约派发 session.start ——
  step(`派发 session.start agent=${AGENT} tier=guarded`);
  await evalJs<boolean>(`(() => {
    window.__start = { done: false, result: null, error: null };
    window.bumimang.dispatch(${JSON.stringify({ type: "session.start", taskId, agent: AGENT, role: "lead", tier: "guarded" })})
      .then((r) => { window.__start = { done: true, result: r, error: null }; })
      .catch((e) => { window.__start = { done: true, result: null, error: String((e && e.message) || e) }; });
    return true;
  })()`);

  const startDone = await poll(`window.__start && window.__start.done === true`, 150000, 1000, "session.start 返回");
  const startRes = await evalJs<{ result: { ok?: boolean; error?: string } | null; error: string | null }>(
    `({ result: window.__start ? window.__start.result : null, error: window.__start ? window.__start.error : null })`,
  );
  check("session.start 返回 {ok:true}", startDone && startRes.result?.ok === true, JSON.stringify(startRes.result ?? startRes.error));

  const snap0 = await getSnapshot();
  const sess0 = snap0.sessions.find((s) => s.agent === AGENT);
  check("快照里出现 claude 会话", Boolean(sess0), sess0 ? `id=${sess0.id} status=${sess0.status}` : JSON.stringify(snap0.sessions.map((s) => `${s.agent}:${s.status}`)));
  const sessionId = sess0?.id;
  if (!sessionId) {
    await finish({ outcome: "no-session" });
    return;
  }

  // —— 2. 等会话 idle（简报轮若触发真实审批，像真人一样放行后再等）——
  const { idle: idleOk, drained } = await waitForIdleDraining(sessionId, 300000);
  check("claude 会话进入 idle（简报轮完成）", idleOk, `期间放行 ${drained} 条简报轮真实审批`);
  const sessIdle = (await getSnapshot()).sessions.find((s) => s.id === sessionId);
  check("idle 状态确认", sessIdle?.status === "idle", `status=${sessIdle?.status}`);

  // —— 3. 基线：派发 prompt 前，黑板死路可能有、审批队列应为空 ——
  // 实测：claude 读完简报（§7.3 + §5.1 的写纪律）后，可能在简报轮就**主动**调
  // blackboard_declare_dead_end 写一条死路 —— 那是写路径有效的更强证据，不是夹具，
  // 因此这里不要求「必须为空」，只断言「没有任何非 agent 来源的死路」（防夹具污染）。
  const baseSnap = await getSnapshot();
  const preDeadEnds = baseSnap.board.deadEnds;
  const deadEndsBefore = preDeadEnds.length;
  const pendingBefore = baseSnap.approvals.filter((a) => a.status === "pending").length;
  check(
    "派发 prompt 前黑板里没有非 agent 来源的死路（零条 或 全是简报轮 agent 写的）",
    preDeadEnds.every((d) => d.by === sessionId),
    `deadEndsBefore=${deadEndsBefore} by=${[...new Set(preDeadEnds.map((d) => d.by))].join(",") || "—"}`,
  );
  check("派发 prompt 前审批队列为空（基线）", pendingBefore === 0, `pendingBefore=${pendingBefore}`);
  const shotBeforePrompt = await screenshot("real-board-before-prompt.png");

  const promptDispatchAt = Date.now();
  step(`派发 session.prompt：${PROMPT_TEXT.slice(0, 80)}…`);
  await evalJs<boolean>(`(() => {
    window.__prompt = { done: false, result: null, error: null };
    window.bumimang.dispatch({ type: "session.prompt", sessionId: ${JSON.stringify(sessionId)}, text: ${JSON.stringify(PROMPT_TEXT)} })
      .then((r) => { window.__prompt = { done: true, result: r, error: null }; })
      .catch((e) => { window.__prompt = { done: true, result: null, error: String((e && e.message) || e) }; });
    return true;
  })()`);
  const promptDone = await poll(`window.__prompt && window.__prompt.done === true`, 15000, 250, "session.prompt 返回");
  const promptRes = await evalJs<{ result: { ok?: boolean; error?: string } | null; error: string | null }>(
    `({ result: window.__prompt ? window.__prompt.result : null, error: window.__prompt ? window.__prompt.error : null })`,
  );
  check("session.prompt 返回 {ok:true}", promptDone && promptRes.result?.ok === true, JSON.stringify(promptRes.result ?? promptRes.error));

  // —— 4. 轮询 snapshot.board.deadEnds 等真实条目（≤150s）——
  step("开始轮询 snapshot.board.deadEnds，等 claude 用 blackboard_declare_dead_end 写入（≤150s）");
  const { appeared, drained: turnDrained } = await waitForDeadEnd(promptDispatchAt, 150000);

  if (!appeared) {
    // 合法发现：claude 没写。如实截图留证，绝不种入。
    const shot = await screenshot("real-board-timeout.png");
    const snapT = await getSnapshot();
    check("claude 在 150s 内向黑板写入死路（核心）", false, `deadEnds=${snapT.board.deadEnds.length} sessions=${snapT.sessions.map((s) => `${s.agent}:${s.status}`).join(",")}`);
    await finish({
      outcome: "claude-did-not-record",
      screenshot: shot,
      deadEndsAtTimeout: snapT.board.deadEnds,
      sessionsAtTimeout: snapT.sessions,
      wireEvidence: readWireEvidence(sessionId),
    });
    return;
  }

  // —— 5. 取到新条目 + 断言它的内容/来源 ——
  const snapHit = await getSnapshot();
  const newDeadEnds = snapHit.board.deadEnds.filter((d) => d.createdAt >= promptDispatchAt);
  const target = newDeadEnds.find((d) => (d.description ?? "").includes(MARKER)) ?? newDeadEnds[0];
  check("快照里出现本轮新死路（核心）", newDeadEnds.length >= 1, `本轮新增 ${newDeadEnds.length} 条`);
  check(
    "死路文字与我要求的一致（含 /admin）",
    Boolean(target && (target.description ?? "").includes("/admin")),
    `description="${target?.description}"`,
  );
  check(
    "死路文字含本轮唯一标记（非陈旧/非夹具数据）",
    Boolean(target && (target.description ?? "").includes(MARKER)),
    `description="${target?.description}"`,
  );
  check(
    "死路的 by 是 agent 会话（经 MCP 写入，非测试夹具种入）",
    Boolean(target && target.by === sessionId),
    `by="${target?.by}" sessionId=${sessionId}`,
  );
  check(
    "死路 createdAt 在本轮 prompt 派发之后",
    Boolean(target && target.createdAt >= promptDispatchAt),
    `createdAt=${target?.createdAt} promptAt=${promptDispatchAt}`,
  );

  // scope 是我要求的 http（次要；claude 若省略则如实记）
  check("死路 scope 是我要求的 http", Boolean(target && target.scope === DEAD_END_SCOPE), `scope="${target?.scope}"`);

  // —— 6. L-3 证据：MCP 子进程真的连上并校验通过（这条写路径的前提）——
  const authed = bridgeLogs.some((l) => l.includes("校验通过"));
  check("MCP 子进程连上命名管道并校验通过（L-3 修复在本轮写路径上生效）", authed, authed ? bridgeLogs.find((l) => l.includes("校验通过"))! : `bridge 日志：${JSON.stringify(bridgeLogs)}`);

  // —— 7. 触发一次与 dispatch 路径相同的 board 推送，让台账 DOM 重拉快照后截图 ——
  // 生产 wiring 里 MCP 写不直接推 board.appended（见文档「没做什么」），这里用 HubService
  // 公开的 publishBoardSince —— 与 registerIpc 的 dispatch 处理完全相同，不种任何数据。
  hub.publishBoardSince(0);
  const domDrew = await poll(`document.querySelectorAll(".board-list.deadends li.deadend").length >= 1`, 10000, 200, "台账 DOM 画出死路");
  await sleep(600); // 让 paint 安定再截

  const shot = await screenshot("real-board.png");
  const boardProbe = await evalJs<Record<string, unknown>>(BOARD_PROBE_JS);
  check("台账面板在真实窗口里画出非空死路区（DOM）", boardProbe.deadEndCount >= 1 && boardProbe.emptyBanner !== true, JSON.stringify(boardProbe.titles));
  check(
    "台账 DOM 里的死路描述含本轮唯一标记",
    Array.isArray(boardProbe.descs) && (boardProbe.descs as string[]).some((t) => t.includes(MARKER)),
    `descs=${JSON.stringify(boardProbe.descs)}`,
  );
  check(
    "台账 DOM 里的 by 是 agent 会话",
    Array.isArray(boardProbe.bys) && (boardProbe.bys as string[]).some((t) => t.includes(sessionId)),
    `bys=${JSON.stringify(boardProbe.bys)}`,
  );

  // —— 8. 硬证据：wire.jsonl + audit 表 ——
  const wireEvidence = readWireEvidence(sessionId);
  check(
    "wire.jsonl 里真有 blackboard_declare_dead_end 的 tool_call（agent 真实调用）",
    wireEvidence.declareLines.length > 0,
    `匹配 ${wireEvidence.declareLines.length} 行`,
  );
  check("wire.jsonl 里出现本轮唯一标记（参数原样到达主进程）", wireEvidence.markerLines > 0, `markerLines=${wireEvidence.markerLines}`);

  const auditRows = (board?.raw(
    "SELECT id, ts, session_id, actor, action, detail FROM audit WHERE action='deadend.declare' ORDER BY id DESC LIMIT 10",
  ) ?? []) as unknown[];
  check(
    "audit 表里有 deadend.declare，actor 是 agent 会话（落库者非人类/非夹具）",
    auditRows.some((r) => (r as { actor?: string }).actor === sessionId),
    `audit 行数=${auditRows.length}`,
  );
  const eventRows = (board?.raw(
    "SELECT id, ts, session_id, kind FROM events WHERE kind='deadend' ORDER BY id DESC LIMIT 10",
  ) ?? []) as unknown[];
  check("events 表里追加了 deadend 事件（哈希链随之增长）", eventRows.length >= 1, `event 行数=${eventRows.length}`);

  await finish({
    outcome: "agent-recorded-dead-end",
    screenshot: shot,
    screenshotBeforePrompt: shotBeforePrompt,
    sessionId,
    promptText: PROMPT_TEXT,
    mark: MARKER,
    deadEndsBefore,
    briefingDrained: drained,
    turnDrained,
    targetDeadEnd: target
      ? { id: target.id, description: target.description, scope: target.scope, reopenWhen: target.reopenWhen, by: target.by, createdAt: target.createdAt }
      : null,
    boardProbe,
    wireEvidence,
    auditEvidence: auditRows,
    eventEvidence: eventRows,
    bridgeLogs,
  });
}

async function finish(extra: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);
  const outcome = String(extra.outcome ?? "unknown");

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    bridge: "real (window.bumimang via preload.cjs)",
    scheme: `${RENDERER_SCHEME}://./renderer.html`,
    agent: AGENT,
    promptText: PROMPT_TEXT,
    mark: MARKER,
    outcome,
    timeline,
    assertions,
    autoApproved,
    consoleLogs: consoleLogs.slice(-200),
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  const jsonPath = path.join(LOGS_DIR, "real-board.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== REAL-BOARD-VERIFY · 真实 claude 写黑板端到端 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n结果：${outcome}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (extra.screenshot) process.stdout.write(`截图：${String(extra.screenshot)}\n`);
  if (extra.screenshotBeforePrompt) process.stdout.write(`派发 prompt 前截图：${String(extra.screenshotBeforePrompt)}\n`);
  if (autoApproved.length > 0) process.stdout.write(`\n自动放行审批 ${autoApproved.length} 条（详见 real-board.json 的 autoApproved）\n`);
  if (loadFailures.length > 0) process.stdout.write(`\nloadFailures: ${JSON.stringify(loadFailures)}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);

  await cleanup();
  app.exit(pass ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    const { hub, bus, approvals, taskId } = await bootstrap();
    await createWindow(hub, bus);
    await sleep(800);
    await runVerify(hub, approvals, taskId);
  } catch (err) {
    process.stdout.write(`[verify] 异常退出：${(err as Error).stack ?? String(err)}\n`);
    await cleanup();
    app.exit(2);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  void cleanup();
});

// 兜底：任何情况下 600 秒内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（600s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "real-board.json"),
    JSON.stringify({ timeout: true, timeline, assertions, autoApproved, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  void cleanup().then(() => app.exit(9));
}, 600000);
