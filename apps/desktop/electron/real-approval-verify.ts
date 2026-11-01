/**
 * Lane B · 第 8 轮 ·「钱截图」：真实 claude 会话在真实窗口里触发一次真实审批，端到端。
 *
 * 背景（GATE-INPUT-STARVED.md 末节）：三家 agent 只有 claude 在「写文件」时会发
 * `session/request_permission`（1 次）。所以「人工审批边界」在 claude 上开箱成立。
 * 本入口把这条链完整跑一遍 —— 不种审批、不 fake agent、不用 mock：
 *
 *   1. 经冻结契约 `window.bumimang.dispatch` 派发 `session.start {agent:"claude", tier:"guarded"}`
 *   2. 等会话 idle（含自动注入的简报轮）
 *   3. 派发 `session.prompt`：让 claude 在当前目录创建 demo.txt
 *   4. 轮询 `snapshot.approvals`，等 pending 出现（claude 写文件前会问）
 *   5. 那一刻截图到 docs/logs/real-approval.png，并断言卡片三栏：命令/目标、自述意图、命中规则
 *   6. 派发 `approval.decide approve`，确认 pending 消失、会话继续（demo.txt 落地）
 *
 * 只 import、不修改 src/main（Lane A 的 lane）；契约 events.ts 冻结未动。
 * 若 claude 在超时内没问，如实记录并截图证据，绝不种审批代替。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/real-approval-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|step|real-approval"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { ApprovalView, HubSnapshot, SessionView } from "../../../packages/shared-protocol/events.ts";
import { Blackboard } from "../src/main/blackboard/board.ts";
import { BoardBridge } from "../src/main/mcp-host/bridge.ts";
import { PolicyEngine } from "../src/main/policy/engine.ts";
import { ApprovalQueue, DenialTracker } from "../src/main/approval/queue.ts";
import { SessionManager, newRunId } from "../src/main/session/manager.ts";
import { EventBus, HubService } from "../src/main/hub/hub.ts";
import { installedAgents } from "../src/main/discovery/detect.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 验证专用工作区：每次运行清空，避免跨进程会话主键碰撞 + 不污染 Lane A 的 .ui-run/board.db */
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "verify-real-approval");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

const AGENT = "claude";
/** 让 claude 写文件 —— 实测这是它唯一会发 request_permission 的场景 */
const PROMPT_TEXT =
  "请在当前目录创建一个名为 demo.txt 的文件，内容写一行 hello。只做这一件事，完成后就结束。";

// 独立 userData，避免与 Lane A 的 main.ts 抢文件锁。
app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-real-approval"));
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
/** 简报轮里 claude 真实发来、被人工放行的审批（证明「放行 ≠ 种审批」） */
const briefingApprovals: Array<{ id: string; action: string; command: string | null; rule: string | null }> = [];
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
 * SessionManager 的 onApprovalRequired 指向队列。这是「真实闸门」的定义 —— 与主入口
 * 唯一区别是跑在 Lane B 自己的验证工作区、用独立 userData。
 */
async function bootstrap(): Promise<{ hub: HubService; bus: EventBus; approvals: ApprovalQueue; taskId: string }> {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORKSPACE, { recursive: true });

  const b = Blackboard.open(path.join(WORKSPACE, "board.db"));
  board = b;

  // 中性简报：不指定任何目标，避免简报轮就让 claude 去探索文件系统（实测那种探索会触发
  // shell 权限请求，把会话卡在简报轮，demo.txt 的写入反而不干净）。写入动作留给 session.prompt。
  const t = b.createTask({
    title: "验收演示任务",
    brief: "本任务仅用于验证工作台的人工审批链路，暂无具体目标，等待后续指令。",
  });

  const runId = newRunId();
  const br = new BoardBridge({ board: b, taskId: t.id, runId });
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
    // 唯一的事前闸门：策略说 approve 就向人工要放行（§9.2）
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
  // 这里写兼容两代的 handler（PROGRESS.md 01:44 的坑）。
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

/** 递归找 demo.txt（claude 可能写在 session cwd / spawn cwd / 子目录） */
function findFile(dir: string, name: string, depth = 0): string | null {
  if (depth > 6) return null;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as never;
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "electron-profile-real-approval") continue;
      const hit = findFile(p, name, depth + 1);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return null;
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

/** 审批卡片 DOM 探针（三栏内容一次取回） */
const CARD_PROBE_JS = `(() => {
  const card = document.querySelector(".ap-card.ap-pending");
  if (!card) return { rendered: false };
  const text = (sel) => { const n = card.querySelector(sel); return n ? (n.textContent || "").trim() : null; };
  return {
    rendered: true,
    action: text(".ap-action"),
    command: text(".ap-command"),
    commandIsEmpty: !!card.querySelector(".ap-command.ap-command-empty"),
    target: text(".ap-target"),
    intent: text(".ap-intent"),
    intentIsEmpty: !!card.querySelector(".ap-intent.ap-intent-empty"),
    rule: text(".ap-rule"),
    risk: text(".ap-risk"),
    history: text(".ap-history"),
    hasApproveBtn: !!card.querySelector('[data-act="approve"]'),
  };
})()`;

/** 从 wire.jsonl 提取 claude 真实发来的 request_permission / policy 判定行，作硬证据。 */
function readWireEvidence(sessionId: string): Array<Record<string, unknown>> {
  const p = path.join(WORKSPACE, "sessions", sessionId, "wire.jsonl");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const s = JSON.stringify(obj);
      if (s.includes("request_permission") || s.includes("policy")) out.push(obj);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.slice(-24);
}

/** 把待批审批里还没决的（本轮的第二个及以后）也放行，让会话能自然收尾。 */
async function approveAllPending(): Promise<number> {
  const snap = await getSnapshot();
  const pending = snap.approvals.filter((a) => a.status === "pending");
  for (const a of pending) {
    step(`补充放行：${a.id}（${a.command ?? a.action}）`);
    await evalJs<boolean>(
      `window.bumimang.dispatch({ type: "approval.decide", approvalId: ${JSON.stringify(a.id)}, decision: "approve" }).then(() => true)`,
    );
  }
  return pending.length;
}

/**
 * 等会话 idle，但简报轮里 claude 若真的发来审批（探索/读环境这类），像真人一样放行。
 * 这些审批是 claude 真实发来的，放行 ≠ 种审批；不放行的话会话会永远卡在简报轮。
 * 返回：是否在超时内 idle。
 */
async function waitForIdleDraining(sessionId: string, timeoutMs: number): Promise<{ idle: boolean; drained: number }> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const c = s.sessions.find((x) => x.id === sessionId);
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      for (const a of pending) {
        step(`简报轮触发真实审批 → 人工放行：${a.id} rule=${a.rule} cmd=${(a.command ?? a.action).slice(0, 90)}`);
        briefingApprovals.push({ id: a.id, action: a.action, command: a.command, rule: a.rule });
        await evalJs<boolean>(
          `window.bumimang.dispatch({ type: "approval.decide", approvalId: ${JSON.stringify(a.id)}, decision: "approve" }).then(() => true)`,
        );
        drained += 1;
      }
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

  // 拿到会话 id
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

  // —— 3. 派发 session.prompt ——
  // 基线：发 prompt 前审批队列应为空（若简报轮就触发了审批，那是另一个发现，先记下来）
  const baseSnap = await getSnapshot();
  const pendingBefore = baseSnap.approvals.filter((a) => a.status === "pending").length;
  check("派发 prompt 前审批队列为空（基线）", pendingBefore === 0, `pendingBefore=${pendingBefore}`);
  const promptDispatchAt = Date.now();
  step(`派发 session.prompt：${PROMPT_TEXT}`);
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

  // —— 4. 轮询快照等 pending（claude 写文件前会问）——
  step("开始轮询 snapshot.approvals，等 claude 发 session/request_permission（≤120s）");
  const pendingAppeared = await poll(
    `(async () => { const s = await window.bumimang.snapshot(); return s.approvals.some((a) => a.status === "pending"); })()`,
    120000,
    1000,
    "pending 审批出现",
  );

  if (!pendingAppeared) {
    // 合法发现：claude 没问。如实截图留证，绝不种审批。
    const shot = await screenshot("real-approval-timeout.png");
    const snapT = await getSnapshot();
    check("claude 在 120s 内向审批队列发来 pending（核心）", false, `approvals=${snapT.approvals.length} sessions=${snapT.sessions.map((s) => `${s.agent}:${s.status}`).join(",")}`);
    await finish({
      outcome: "claude-did-not-ask",
      screenshot: shot,
      approvalsAtTimeout: snapT.approvals.map((a) => ({ id: a.id, status: a.status, action: a.action })),
      sessionsAtTimeout: snapT.sessions,
    });
    return;
  }

  // 等 DOM 卡片画出来（approval.upsert 事件回流 → 渲染）
  const cardDrew = await poll(`document.querySelectorAll(".ap-card.ap-pending").length >= 1`, 10000, 200, "审批卡片渲染");
  await sleep(600); // 让 paint 安定再截

  const snapPending = await getSnapshot();
  const pendingApproval = snapPending.approvals.find((a) => a.status === "pending");
  check("快照里有一条 pending 审批", Boolean(pendingApproval), pendingApproval ? `id=${pendingApproval.id}` : "无");
  check(
    "pending 的 action 是 session/request_permission（唯一事前闸门动作）",
    pendingApproval?.action === "session/request_permission",
    `action=${pendingApproval?.action}`,
  );
  check(
    "这条 pending 是本轮 prompt 触发的（createdAt 在 prompt 派发之后）",
    Boolean(pendingApproval && pendingApproval.createdAt >= promptDispatchAt),
    `createdAt=${pendingApproval?.createdAt} promptAt=${promptDispatchAt}`,
  );

  // —— 5. 截图 + 断言卡片三栏 ——
  const shot = await screenshot("real-approval.png");
  const card = await evalJs<Record<string, unknown>>(CARD_PROBE_JS);
  check("审批卡片在真实窗口里渲染", card.rendered === true);
  check(
    "左栏：命令/目标（command 有真实 tool 标题）",
    card.rendered === true && typeof card.command === "string" && (card.command as string).length > 0 && card.commandIsEmpty !== true,
    `command="${card.command}" commandIsEmpty=${card.commandIsEmpty}`,
  );
  check(
    "左栏：目标行渲染（command/target 常为 null → 诚实占位「目标：—」也算）",
    card.rendered === true && typeof card.target === "string" && (card.target as string).length > 0,
    `target="${card.target}"`,
  );
  check(
    "右栏：命中规则 = tier-guarded-default（guarded 档兜底转人工）",
    card.rule === "命中规则：tier-guarded-default",
    `rule="${card.rule}"`,
  );
  check(
    "右栏：风险等级渲染",
    typeof card.risk === "string" && (card.risk as string).length > 0,
    `risk="${card.risk}"`,
  );
  // 中栏：claude 通常在工具调用前会说点什么（自述文本），非 null 是强证据；空则如实记录。
  const intentIsReal = card.rendered === true && typeof card.intent === "string" && (card.intent as string).length > 0 && card.intentIsEmpty !== true;
  check(
    "中栏：agent 自述意图（claude 工具调用前的真实文本）",
    intentIsReal,
    intentIsReal ? `intent="${String(card.intent).slice(0, 120)}"` : `intent="${card.intent}"（空 → 占位「暂无自述意图」，如实记录）`,
  );
  check("卡片有待批按钮（放行/拒绝）", card.hasApproveBtn === true);

  // —— 6. 派发 approval.decide approve ——
  const approvalId = pendingApproval?.id;
  step(`派发 approval.decide approve：${approvalId}`);
  await evalJs<boolean>(`(() => {
    window.__decide = { done: false, result: null, error: null };
    window.bumimang.dispatch({ type: "approval.decide", approvalId: ${JSON.stringify(approvalId)}, decision: "approve" })
      .then((r) => { window.__decide = { done: true, result: r, error: null }; })
      .catch((e) => { window.__decide = { done: true, result: null, error: String((e && e.message) || e) }; });
    return true;
  })()`);
  const decideDone = await poll(`window.__decide && window.__decide.done === true`, 10000, 250, "approval.decide 返回");
  const decideRes = await evalJs<{ result: { ok?: boolean; error?: string } | null; error: string | null }>(
    `({ result: window.__decide ? window.__decide.result : null, error: window.__decide ? window.__decide.error : null })`,
  );
  check("approval.decide 返回 {ok:true}", decideDone && decideRes.result?.ok === true, JSON.stringify(decideRes.result ?? decideRes.error));

  const pendingGone = await poll(
    `(async () => { const s = await window.bumimang.snapshot(); return !s.approvals.some((a) => a.status === "pending"); })()`,
    20000,
    500,
    "pending 消失",
  );
  check("放行后 pending 从快照消失", pendingGone);

  // 已决卡片（最近已决 · 已放行）
  await sleep(300);
  const decidedProbe = await evalJs<{ decidedStatus: string | null; decidedCount: number }>(
    `(() => {
      const cards = Array.from(document.querySelectorAll(".ap-card.ap-decided"));
      const first = cards[0];
      return {
        decidedCount: cards.length,
        decidedStatus: first && first.querySelector(".ap-status") ? first.querySelector(".ap-status").textContent.trim() : null,
      };
    })()`,
  );
  check(
    "审批面板「最近已决」出现「已放行」",
    decidedProbe.decidedCount >= 1 && decidedProbe.decidedStatus === "已放行",
    `decidedCount=${decidedProbe.decidedCount} status="${decidedProbe.decidedStatus}"`,
  );

  // 会话继续：claude 拿到放行后完成写入 → 回到 idle；若它又问了第二个权限，补充放行让它收尾。
  const continued = await poll(
    `(async () => {
      const s = await window.bumimang.snapshot();
      const c = s.sessions.find((x) => x.id === ${JSON.stringify(sessionId)});
      return !!c && c.status === "idle";
    })()`,
    120000,
    1000,
    "放行后会话回到 idle",
  );
  if (!continued) {
    const extra = await approveAllPending();
    step(`idle 未到，补充放行 ${extra} 条后继续等`);
    await poll(
      `(async () => { const s = await window.bumimang.snapshot(); const c = s.sessions.find((x) => x.id === ${JSON.stringify(sessionId)}); return !!c && c.status === "idle"; })()`,
      60000,
      1000,
      "再次等 idle",
    );
  }
  const sessAfter = (await getSnapshot()).sessions.find((s) => s.id === sessionId);
  check("会话继续运行并回到 idle", sessAfter?.status === "idle", `status=${sessAfter?.status}`);

  // demo.txt 落地（claude 在 session cwd 或 spawn cwd 或子目录写）
  const found = findFile(WORKSPACE, "demo.txt");
  const fileInfo = found
    ? { path: found, bytes: (() => { try { return readFileSync(found, "utf8"); } catch { return "<unreadable>"; } })() }
    : null;
  check("放行后 demo.txt 真的落盘", Boolean(found), found ? `path=${found} content=${JSON.stringify(fileInfo?.bytes)}` : "未找到 demo.txt");

  await finish({
    outcome: "claude-asked-and-approved",
    screenshot: shot,
    sessionId,
    promptText: PROMPT_TEXT,
    briefingDrained: drained,
    briefingApprovals,
    pendingApproval: pendingApproval
      ? {
          id: pendingApproval.id,
          action: pendingApproval.action,
          command: pendingApproval.command,
          target: pendingApproval.target,
          intentSummary: pendingApproval.intentSummary,
          rule: pendingApproval.rule,
          risk: pendingApproval.risk,
          sameKindCount: pendingApproval.sameKindCount,
        }
      : null,
    cardProbe: card,
    afterDecide: {
      pendingGone,
      decidedProbe,
      sessionStatus: sessAfter?.status ?? null,
      demoFile: fileInfo,
    },
    wireEvidence: readWireEvidence(sessionId),
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
    outcome,
    timeline,
    assertions,
    consoleLogs: consoleLogs.slice(-200),
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  const jsonPath = path.join(LOGS_DIR, "real-approval.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== REAL-APPROVAL-VERIFY · claude 真实审批端到端 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n结果：${outcome}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (extra.screenshot) process.stdout.write(`截图：${String(extra.screenshot)}\n`);
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

// 兜底：任何情况下 540 秒内必须退出，避免挂死留下残留进程（真实 claude 多轮 + 简报轮可能很慢）。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（540s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "real-approval.json"),
    JSON.stringify({ timeout: true, timeline, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  void cleanup().then(() => app.exit(9));
}, 540000);
