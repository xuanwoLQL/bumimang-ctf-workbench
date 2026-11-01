/**
 * Lane B · R13 · 亮色主题 + 会话对话流 + 左栏引擎列表（真实桥 + 真实 claude）。
 *
 * 三个改动各自的可验证事实：
 *   1. 亮色主题：body 背景是 #f6f8fa、前景是 #1f2328、面板是白色（不再是暗色 #0d1117）。
 *   2. 会话对话流：中栏窗格把 `session.stream` 渲染成对话块（.conv-block），
 *      tool_call 是一个离散的「工具步」（.conv-tool）且带状态（由 tool_call_update 原地刷新），
 *      agent_message / agent_thought 累加进各自的块——不是平铺行。
 *   3. 左栏引擎列表：snapshot.agents 每一家一行，已安装的带可用「＋」（点它按该 agent 起会话），
 *      未安装的灰显 + 附安装提示 + 「＋」禁用。
 *
 * 对话截图需要真实内容：点左栏 claude 旁的「＋」（走 UI 路径起会话）→ 等 idle →
 * 派发 session.prompt 让它在工作区写一个文件（实测 3/3 触发 tool_call + 审批）→
 * 在「审批 pending + 窗格已有工具步」那一刻截图到 docs/logs/light-conversation.png。
 *
 * 只 import、不修改 src/main（Lane A 的 lane）；契约 events.ts 冻结未动。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/r13-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|step|r13"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { HubSnapshot } from "../../../packages/shared-protocol/events.ts";
import { Blackboard } from "../src/main/blackboard/board.ts";
import { BoardBridge } from "../src/main/mcp-host/bridge.ts";
import { PolicyEngine } from "../src/main/policy/engine.ts";
import { ApprovalQueue, DenialTracker } from "../src/main/approval/queue.ts";
import { SessionManager, newRunId } from "../src/main/session/manager.ts";
import { EventBus, HubService } from "../src/main/hub/hub.ts";
import { installedAgents } from "../src/main/discovery/detect.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "verify-r13");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

const AGENT = "claude";
/** 让 claude 写文件 —— 实测这是它唯一会发 request_permission 的场景，且伴随 tool_call。 */
const PROMPT_TEXT =
  "请在当前目录创建一个名为 demo.txt 的文件，内容写一行 hello。只做这一件事，完成后就结束。";

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-r13"));
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

function step(msg: string): void {
  process.stdout.write(`[step] ${new Date().toISOString().slice(11, 19)} ${msg}\n`);
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
let rendererGone: string | null = null;

async function cleanup(): Promise<void> {
  sessions?.shutdown();
  bridge?.stop();
  await sleep(500);
  board?.close();
}

/** 照 Lane A 的 main.ts 原样接线：真实策略引擎 + 真实审批队列 + 真实会话管理器。 */
async function bootstrap(): Promise<{ hub: HubService; bus: EventBus; taskId: string }> {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORKSPACE, { recursive: true });

  const b = Blackboard.open(path.join(WORKSPACE, "board.db"));
  board = b;

  const t = b.createTask({
    title: "R13 验收任务",
    brief: "本任务仅用于验证亮色主题、对话流与引擎列表，写文件动作留给 session.prompt。",
  });

  const runId = newRunId();
  const br = new BoardBridge({ board: b, taskId: t.id, runId });
  await br.start();
  bridge = br;

  const policy = new PolicyEngine({ repoRoot: REPO_ROOT, packId: "competition" });
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
      step(`onApprovalRequired：session=${sessionId} rule=${decision.rule}`);
      const o = await approvals.request({
        taskId,
        sessionId,
        action: "session/request_permission",
        detail,
        rule: decision.rule,
        reason: decision.reason,
      });
      if (o.decidedBy === "human" && o.decision === "denied") denials.note(sessionId, decision.rule);
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

  return { hub, bus, taskId: t.id };
}

function registerIpc(hub: HubService, bus: EventBus): void {
  ipcMain.handle(HUB_CHANNELS.snapshot, () => hub.snapshot());
  ipcMain.handle(HUB_CHANNELS.dispatch, async (_e, action: unknown) => {
    const res = await hub.dispatch(action as never);
    win?.webContents.send(HUB_CHANNELS.event, {
      type: "task.upsert",
      task: hub.snapshot().task ?? { id: "", title: "", brief: "", status: "open", answer: null, solvedBy: null, createdAt: 0 },
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
}

async function evalJs<T>(js: string): Promise<T> {
  return (await win!.webContents.executeJavaScript(js, true)) as T;
}

async function poll(condJs: string, timeoutMs: number, intervalMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await win!.webContents.executeJavaScript(condJs, true)) as boolean) {
        step(`poll:${label} 命中（${Date.now() - start}ms）`);
        return true;
      }
    } catch {
      /* 页面还没就绪，继续等 */
    }
    await sleep(intervalMs);
  }
  step(`poll:${label} 超时（${timeoutMs}ms）`);
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
  writeFileSync(pngPath.replace(/\.png$/, ".jpg"), img.toJPEG(82));
  step(`截图 ${name}（${png.length} bytes, ${img.getSize().width}x${img.getSize().height}）`);
  return pngPath;
}

/** 亮色主题探针。 */
const LIGHT_PROBE_JS = `(() => {
  const cs = (s) => { const n = document.querySelector(s); return n ? getComputedStyle(n) : null; };
  const body = cs("body");
  const panel = cs(".panel");
  const pane = cs(".pane");
  const block = cs(".conv-block");
  return {
    bodyBg: body ? body.backgroundColor : null,
    bodyColor: body ? body.color : null,
    panelBg: panel ? panel.backgroundColor : null,
    paneBg: pane ? pane.backgroundColor : null,
    convBlockPresent: !!document.querySelector(".conv-block"),
  };
})()`;

/** 左栏引擎列表探针：逐家核对行 / 可用性 / 「＋」状态 / 安装提示。 */
const AGENT_LIST_PROBE_JS = `(async () => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const snap = await window.bumimang.snapshot();
  const rows = qa(".agent-item").map((row) => {
    const id = row.dataset.agent || null;
    const btn = row.querySelector(".agent-start-btn");
    const hint = row.querySelector(".agent-hint");
    return {
      id,
      installedClass: row.classList.contains("agent-installed"),
      unavailableClass: row.classList.contains("agent-unavailable"),
      btnDisabled: btn ? btn.disabled : null,
      hintText: hint ? (hint.textContent || "").trim() : null,
    };
  });
  return {
    snapAgents: snap.agents.map((a) => ({ id: a.id, installed: a.installed, installHint: a.installHint })),
    rows,
    rowCount: rows.length,
    startBtnCount: qa(".agent-start-btn").length,
  };
})()`;

async function verifyLightTheme(): Promise<void> {
  const p = await evalJs<Record<string, unknown>>(LIGHT_PROBE_JS);
  check("亮色主题：body 背景是 #f6f8fa（rgb 246,248,250）", p.bodyBg === "rgb(246, 248, 250)", `bg=${p.bodyBg}`);
  check("亮色主题：body 前景是深色 #1f2328（rgb 31,35,40）", p.bodyColor === "rgb(31, 35, 40)", `color=${p.bodyColor}`);
  check("亮色主题：面板背景是白色", p.panelBg === "rgb(255, 255, 255)", `panel=${p.panelBg}`);
  check("亮色主题：不再是暗色底 #0d1117", p.bodyBg !== "rgb(13, 17, 23)", `bg=${p.bodyBg}`);
}

async function verifyAgentList(): Promise<string> {
  const p = await evalJs<Record<string, unknown>>(AGENT_LIST_PROBE_JS);
  const snapAgents = (p.snapAgents as Array<{ id: string; installed: boolean; installHint: string }>) ?? [];
  const rows = (p.rows as Array<{ id: string | null; installedClass: boolean; unavailableClass: boolean; btnDisabled: boolean | null; hintText: string | null }>) ?? [];

  check("左栏引擎列表：行数 = snapshot.agents 数", (p.rowCount as number) === snapAgents.length, `rows=${p.rowCount} agents=${snapAgents.length}`);
  check("左栏引擎列表：每家都有一个「＋」按钮", (p.startBtnCount as number) === snapAgents.length, `btns=${p.startBtnCount}`);

  for (const a of snapAgents) {
    const row = rows.find((r) => r.id === a.id);
    if (!row) {
      check(`引擎列表：${a.id} 有对应行`, false, "未找到行");
      continue;
    }
    if (a.installed) {
      check(
        `引擎列表：${a.id} 已安装 → 行可用、「＋」可点`,
        row.installedClass === true && row.unavailableClass === false && row.btnDisabled === false,
        `btnDisabled=${row.btnDisabled}`,
      );
    } else {
      check(
        `引擎列表：${a.id} 未安装 → 灰显 + 附安装提示 + 「＋」禁用`,
        row.unavailableClass === true && row.installedClass === false && row.btnDisabled === true && (row.hintText ?? "").length > 0,
        `hint="${row.hintText}"`,
      );
    }
  }

  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await screenshot("agent-list.png");
  check("agent-list.png 截图写入 docs/logs/", shot.length > 0, shot);
  return shot;
}

/** 中栏对话流探针：只查指定会话窗格。 */
function convProbe(sessionId: string): string {
  return `(() => {
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const pane = document.querySelector('.pane[data-session=${JSON.stringify(sessionId)}]');
    if (!pane) return { pane: false };
    const tools = Array.from(pane.querySelectorAll(".conv-block.conv-tool")).map((n) => ({
      title: n.querySelector(".conv-title") ? (n.querySelector(".conv-title").textContent || "").trim() : null,
      status: n.querySelector(".conv-tool-status") ? (n.querySelector(".conv-tool-status").textContent || "").trim() : null,
    }));
    return {
      pane: true,
      blockCount: pane.querySelectorAll(".conv-block").length,
      toolSteps: tools.length,
      toolWithStatus: tools.filter((t) => t.status).length,
      messageCount: pane.querySelectorAll(".conv-block.conv-message").length,
      thoughtCount: pane.querySelectorAll(".conv-block.conv-thought").length,
      tools,
    };
  })()`;
}

/** 等会话 idle，但简报轮若触发真实审批就放行（放行 ≠ 种审批）。 */
async function waitForIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const c = s.sessions.find((x) => x.id === sessionId);
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      for (const a of pending) {
        step(`简报轮触发真实审批 → 放行：${a.id} rule=${a.rule}`);
        await evalJs<boolean>(
          `window.bumimang.dispatch({ type: "approval.decide", approvalId: ${JSON.stringify(a.id)}, decision: "approve" }).then(() => true)`,
        );
        drained += 1;
      }
      continue;
    }
    if (c && c.status === "idle") {
      step(`会话 idle（简报轮期间放行 ${drained} 条真实审批）`);
      return true;
    }
    await sleep(1000);
  }
  step(`等 idle 超时（${timeoutMs}ms），已放行 ${drained} 条`);
  return false;
}

async function runVerify(hub: HubService): Promise<void> {
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

  // 关掉 R10 首启引导浮层，让截图干净（不改变任何断言语义）。
  await evalJs<boolean>(
    `(() => { const b = document.querySelector(".first-run-dismiss"); if (b) { b.click(); return true; } return false; })()`,
  );

  // —— 1. 亮色主题 ——
  await verifyLightTheme();

  // —— 2. 左栏引擎列表 ——
  const agentListShot = await verifyAgentList();

  // —— 3. 对话流：点左栏 claude 旁的「＋」起真实会话（走 UI 路径，不是直接 dispatch）——
  const claudeInstalled = installedAgents().some((a) => a.id === AGENT);
  check(`本机有可用的 ${AGENT} 适配器`, claudeInstalled);
  if (!claudeInstalled) {
    await finish({ outcome: "claude-not-installed", agentListShot });
    return;
  }

  const clicked = await evalJs<boolean>(
    `(() => { const b = document.querySelector('.agent-start-btn[data-agent="claude"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  check("点左栏 claude 旁的「＋」成功派发（按钮可点）", clicked === true, `clicked=${clicked}`);

  const sessionAppeared = await poll(
    `(async () => { const s = await window.bumimang.snapshot(); return s.sessions.some((x) => x.agent === "claude"); })()`,
    150000,
    1000,
    "claude 会话出现",
  );
  check("「＋」点后真实后端出现 claude 会话", sessionAppeared);

  const snap0 = await getSnapshot();
  const sess0 = snap0.sessions.find((s) => s.agent === AGENT);
  const sessionId = sess0?.id;
  check("拿到 claude 会话 id", Boolean(sessionId), sess0 ? `id=${sess0.id}` : "无");
  if (!sessionId) {
    await finish({ outcome: "no-session", agentListShot });
    return;
  }

  // —— 等 idle（简报轮）——
  const idleOk = await waitForIdle(sessionId, 300000);
  check("claude 会话进入 idle（简报轮完成）", idleOk);

  // —— 派发 session.prompt：写文件（触发 tool_call + 审批）——
  await evalJs<boolean>(
    `window.bumimang.dispatch({ type: "session.prompt", sessionId: ${JSON.stringify(sessionId)}, text: ${JSON.stringify(PROMPT_TEXT)} }).then(() => true)`,
  );
  step("已派发 session.prompt（写 demo.txt）");

  const pendingAppeared = await poll(
    `(async () => { const s = await window.bumimang.snapshot(); return s.approvals.some((a) => a.status === "pending"); })()`,
    120000,
    1000,
    "pending 审批出现",
  );
  check("claude 写文件前发来 pending 审批（3/3 实测路径）", pendingAppeared);

  // 等窗格画出工具步（会话对话流成形）
  const convDrew = await poll(
    `(() => {
      const pane = document.querySelector('.pane[data-session=${JSON.stringify(sessionId)}]');
      return !!pane && pane.querySelectorAll(".conv-block.conv-tool").length >= 1;
    })()`,
    30000,
    300,
    "窗格出现工具步",
  );

  const conv = await evalJs<Record<string, unknown>>(convProbe(sessionId));
  const toolSteps = (conv.toolSteps as number) ?? 0;
  const toolWithStatus = (conv.toolWithStatus as number) ?? 0;
  const msgOrThought = ((conv.messageCount as number) ?? 0) + ((conv.thoughtCount as number) ?? 0);
  check("中栏窗格渲染出对话流（.conv-block）", convDrew && (conv.pane as boolean) === true && toolSteps >= 1, `blocks=${conv.blockCount} tools=${toolSteps}`);
  check("工具调用是离散的「工具步」（.conv-tool）且带状态（tool_call_update 原地刷新）", toolSteps >= 1 && toolWithStatus >= 1, `tools=${toolSteps} withStatus=${toolWithStatus}`);
  check("对话流含 agent 消息/思考（不是平铺行）", msgOrThought >= 1, `msg=${conv.messageCount} thought=${conv.thoughtCount}`);

  // 此时审批 pending + 窗格有工具步 → 拍「钱截图」
  mkdirSync(LOGS_DIR, { recursive: true });
  const convShot = await screenshot("light-conversation.png");
  check("light-conversation.png 截图写入 docs/logs/", convShot.length > 0, convShot);

  // —— 放行，让 claude 完成写入（顺带验证工具步状态原地刷成「完成」）——
  const pending = (await getSnapshot()).approvals.filter((a) => a.status === "pending");
  for (const a of pending) {
    await evalJs<boolean>(
      `window.bumimang.dispatch({ type: "approval.decide", approvalId: ${JSON.stringify(a.id)}, decision: "approve" }).then(() => true)`,
    );
  }
  step(`已放行 ${pending.length} 条审批`);
  await waitForIdle(sessionId, 120000);

  const convAfter = await evalJs<Record<string, unknown>>(convProbe(sessionId));
  const toolsAfter = (convAfter.tools as Array<{ title: string | null; status: string | null }>) ?? [];
  const anyDone = toolsAfter.some((t) => t.status === "完成");
  check("放行后工具步状态原地刷成「完成」（同一块，不新增条目）", (convAfter.toolSteps as number) >= 1 && anyDone, `tools=${JSON.stringify(toolsAfter)}`);

  await finish({
    outcome: "claude-conversation-verified",
    agentListShot,
    convShot,
    sessionId,
    convBefore: conv,
    convAfter,
  });
}

async function finish(extra: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);
  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    bridge: "real (window.bumimang via preload.cjs)",
    scheme: `${RENDERER_SCHEME}://./renderer.html`,
    agent: AGENT,
    promptText: PROMPT_TEXT,
    assertions,
    consoleLogs: consoleLogs.slice(-200),
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(path.join(LOGS_DIR, "r13-verify.json"), JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== R13-VERIFY · 亮色主题 + 对话流 + 引擎列表 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n证据：${path.join(LOGS_DIR, "r13-verify.json")}\n`);
  if (loadFailures.length > 0) process.stdout.write(`\nloadFailures: ${JSON.stringify(loadFailures)}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);

  await cleanup();
  app.exit(pass ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    const { hub, bus } = await bootstrap();
    await createWindow(hub, bus);
    await sleep(800);
    await runVerify(hub);
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

// 兜底：任何情况下 540 秒内必须退出（真实 claude 多轮 + 简报轮可能很慢）。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（540s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "r13-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  void cleanup().then(() => app.exit(9));
}, 540000);
