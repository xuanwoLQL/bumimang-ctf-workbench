/**
 * Lane B · 第 10 轮 ·「多会话真并行」钱截图：起 3 个真实 claude 会话（lead/verify/recon，
 * 混合档位）跑同一道题，把中栏三会话各自**独立**的实时事件流截下来 —— 这是产品核心
 * 体验「1 加到 3 省时间」（多会话并行）的画面证据，接 HANDOVER 第五节第 1 条、也是
 * VERIFY-briefing-fanout（Lane A 的 17/17 确定性机制验收）之后缺的「画面那一半」。
 *
 * R14（2026-10-13）注：中栏从「三窗格并排」改成「浏览器标签页」（用户明确要求）——
 * 三窗格仍在 DOM 里（2 隐藏 + 1 可见），每个窗格各自的 stream / 健康度 / 角色断言
 * 不变；原「并排 left 递增」的视觉断言已按新布局改写为「3 标签 + 1 可见窗格占满舞台」。
 *
 * 全程经冻结契约 `window.bumimang`（HubApi）：session.start / session.prompt /
 * approval.decide / session.stop 都走 IPC 契约；任务用 `board.createTask` 建（契约里
 * `task.create` 动作内部调的就是同一个方法，bridge 需要 taskId 才能建，这是结构要求
 * 不是绕过）。
 *
 * 流程（分两段，一段错开、一段并发）：
 *   A. 简报包继承（错开）：lead 先起 → 写一条死路（含唯一标记）→ 再快速相继起 verify/recon
 *      → 断言 verify/recon 的简报包（dead_ends / do_not）带上了 lead 写的死路。
 *   B. 真并行（并发）：三轮会话都在跑 → 给三个会话各发一条不同的第二轮 prompt → 三窗格
 *      各自实时流（R14 起以标签页切换查看，不再并排）→ 截图 + 断言（3 会话 / 角色各异 /
 *      混合档位 / 每会话独立 session.stream / 每会话独立 health(toolCalls/boardReads/syncLag)）。
 *
 * 与 R8/R9 的关键差异：
 *   - 给 BoardBridge 接了 `onBoardRead → mgr.noteBoardRead`，让健康度的 boardReads /
 *     syncLag 有真实值（生产 main.ts 还没接这条，本验收把这条补上，好让「每会话独立
 *     健康度」可被实测）。
 *   - 在总线上挂了一个订阅，逐条计数每个会话收到的 session.stream（每会话独立证据）。
 *
 * 只 import、不修改 src/main（Lane A 的 lane）；契约 events.ts 冻结未动。claude 若在
 * 简报轮/写死路轮发来真实审批，像真人一样 approval.decide approve 自动放行并如实记录。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/real-parallel-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|step|real-parallel|ALL_PASS"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { HubSnapshot, SessionHealth } from "../../../packages/shared-protocol/events.ts";
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
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "verify-real-parallel");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

const AGENT = "claude";
/** 唯一标记：断言「简报继承的就是 lead 这一轮写的死路」 */
const MARKER = "BM-PARALLEL-10";
const DEAD_END_DESCRIPTION = `lead 已探明：验收目标 A 的路径 X 走不通（${MARKER}）`;
const DEAD_END_SCOPE = "demo";

const TASK_TITLE = "并行验收：三角色共享黑板演示";
const TASK_BRIEF =
  "这是一个验证多会话并行的演示任务，没有真实目标。你的工作方式被限定为：只使用共享黑板的工具" +
  "（blackboard_read_since / blackboard_declare_dead_end / blackboard_submit_fact / blackboard_query_view 等）" +
  "和文字报告；不要运行 shell 命令、不要读写任何文件、不要联网。按简报里的角色说明与黑板纪律行动。";

const LEAD_PROMPT =
  `请在共享黑板上声明一条死路。用 blackboard_declare_dead_end 工具写入，参数照下面写：\n` +
  `- description = "${DEAD_END_DESCRIPTION}"\n` +
  `- scope = "${DEAD_END_SCOPE}"\n\n` +
  `这是并行验收演示：不需要真的去扫描或尝试任何目标，只调用工具写入即可。写完就结束，不要再做别的事。`;

/** 第二轮给三个角色各自不同的 prompt —— 让三窗格显示各自内容，也顺便验证「简报已被消化」。 */
const ROUND2 = {
  lead: `你是 lead。请调用 blackboard_read_since 同步黑板，然后用一句话汇报你之前写的那条死路（${DEAD_END_DESCRIPTION}），并说明 lead 下一步该带大家做什么。只调用这一个黑板工具，然后说一句话就结束。`,
  verify: `你是 verify。请调用 blackboard_read_since 同步黑板，然后独立复述你在黑板上看到的那条死路（引用原文），并给出一句你的验证结论。只调用这一个黑板工具，然后说一句话就结束。`,
  recon: `你是 recon。请调用 blackboard_read_since 同步黑板，然后用一句话汇报你从黑板读到的全部内容。只调用这一个黑板工具，然后说一句话就结束。`,
};

/** 三个角色 / 混合档位（lead=受控，verify=自主，recon=受控） */
const FANOUT: Array<{ role: "lead" | "verify" | "recon"; tier: "autonomous" | "guarded" }> = [
  { role: "lead", tier: "guarded" },
  { role: "verify", tier: "autonomous" },
  { role: "recon", tier: "guarded" },
];

// 独立 userData，避免与 Lane A 的 main.ts 抢文件锁。
app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-real-parallel"));
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
/** 全程自动放行的真实审批（简报轮 / 写死路轮 / 第二轮）。放行 ≠ 种数据。 */
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

/** 每会话收到的 session.stream 计数（总线订阅，逐条按 sessionId 计数 —— 每会话独立证据）。 */
const streamBySession = new Map<string, number>();
/** 每会话前几条 stream 样本（证明内容确实各是各的）。 */
const streamSamples = new Map<string, Array<{ kind: string; title?: string; text?: string }>>();

const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
let rendererGone: string | null = null;

async function cleanup(): Promise<void> {
  const s = sessions;
  const br = bridge;
  const b = board;
  sessions = null;
  bridge = null;
  board = null;
  s?.shutdown();
  br?.stop();
  // shutdown() 会 kill claude 子进程；其 onAgentExit 是异步 fire-and-forget，会写黑板。
  // 等它跑完再关库，否则撞 "database is not open"。
  await sleep(600);
  b?.close();
}

/**
 * 照 Lane A 的 main.ts 原样接线，两处增强（都在我 lane 内）：
 *   1. BoardBridge 接 `onBoardRead → mgr.noteBoardRead`（生产 main.ts 还没接，这里接上
 *      好让健康度 boardReads/syncLag 有真实值）；
 *   2. 总线上挂一个订阅，逐条计数每会话的 session.stream。
 */
async function bootstrap(): Promise<{ hub: HubService; bus: EventBus; approvals: ApprovalQueue; taskId: string }> {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORKSPACE, { recursive: true });

  const b = Blackboard.open(path.join(WORKSPACE, "board.db"));
  board = b;

  const t = b.createTask({ title: TASK_TITLE, brief: TASK_BRIEF });

  const runId = newRunId();
  let mgr!: SessionManager;
  const br = new BoardBridge({
    board: b,
    taskId: t.id,
    runId,
    onBoardRead: (sessionId) => mgr.noteBoardRead(sessionId),
  });
  await br.start();
  bridge = br;

  const policy = new PolicyEngine({ repoRoot: REPO_ROOT, packId: "competition" });
  step(`策略引擎已加载：${policy.name}${policy.fellBackToMinimal ? "（回落到最小安全集）" : ""}`);
  const bus = new EventBus();

  let hub!: HubService;
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

  // 逐条计数每会话的 session.stream —— 每会话独立证据。
  bus.on((e) => {
    if (e.type === "session.stream") {
      streamBySession.set(e.sessionId, (streamBySession.get(e.sessionId) ?? 0) + 1);
      const arr = streamSamples.get(e.sessionId) ?? [];
      if (arr.length < 24) {
        arr.push({ kind: e.update.kind, title: e.update.title, text: (e.update.text ?? "").slice(0, 100) });
        streamSamples.set(e.sessionId, arr);
      }
    }
  });

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
    width: 1600,
    height: 950,
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

/** 经冻结契约派发一个动作，等它返回 {ok}。 */
async function dispatchAction(action: unknown, waitMs: number): Promise<{ ok: boolean; error?: string }> {
  const type = (action as { type: string }).type;
  await evalJs<boolean>(`(() => {
    window.__act = { done: false, result: null, error: null };
    window.bumimang.dispatch(${JSON.stringify(action)})
      .then((r) => { window.__act = { done: true, result: r, error: null }; })
      .catch((e) => { window.__act = { done: true, result: null, error: String((e && e.message) || e) }; });
    return true;
  })()`);
  const done = await poll(`window.__act && window.__act.done === true`, waitMs, 250, `dispatch ${type}`);
  const res = await evalJs<{ result: { ok?: boolean; error?: string } | null; error: string | null }>(
    `({ result: window.__act ? window.__act.result : null, error: window.__act ? window.__act.error : null })`,
  );
  return { ok: done && res.result?.ok === true, error: res.result?.error ?? res.error ?? undefined };
}

/** 自动放行当前所有 pending 审批（经冻结契约 approval.decide），如实记录。返回放行条数。 */
async function drainPending(phase: string): Promise<number> {
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
    await dispatchAction({ type: "approval.decide", approvalId: a.id, decision: "approve" }, 10000);
  }
  return pending.length;
}

/** 等一个会话 idle，期间像真人一样放行它真实发来的审批。 */
async function waitForIdle(sessionId: string, timeoutMs: number, label: string): Promise<{ idle: boolean; drained: number }> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const c = s.sessions.find((x) => x.id === sessionId);
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      drained += await drainPending(label);
      continue;
    }
    if (c && c.status === "idle") {
      step(`[${label}] 会话 ${sessionId} idle（期间放行 ${drained} 条）`);
      return { idle: true, drained };
    }
    await sleep(1000);
  }
  step(`[${label}] 等 idle 超时（${timeoutMs}ms），已放行 ${drained} 条`);
  return { idle: false, drained };
}

/** 等黑板出现 promptAt 之后的新死路。期间放行审批。 */
async function waitForDeadEnd(promptAt: number, timeoutMs: number): Promise<{ appeared: boolean; drained: number }> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      drained += await drainPending("dead-end-turn");
      continue;
    }
    if (s.board.deadEnds.some((d) => d.createdAt >= promptAt)) {
      step(`黑板出现本轮新死路（${Date.now() - start}ms）`);
      return { appeared: true, drained };
    }
    await sleep(1000);
  }
  step(`等黑板死路超时（${timeoutMs}ms），放行 ${drained} 条`);
  return { appeared: false, drained };
}

/** 等一组会话全部 idle（简报轮跑完）且都拿到非零 toolCalls / boardReads。 */
async function waitForAllIdle(
  ids: string[],
  timeoutMs: number,
): Promise<{ idle: boolean; drained: number; health: Record<string, SessionHealth> }> {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      drained += await drainPending("parallel-briefing");
      continue;
    }
    const all = ids.map((id) => s.sessions.find((x) => x.id === id));
    const allIdle = all.every((c) => c && c.status === "idle");
    const allToolCalls = ids.every((id) => (s.health[id]?.toolCalls ?? 0) > 0);
    const allBoardReads = ids.every((id) => (s.health[id]?.boardReads ?? 0) > 0);
    if (allIdle && allToolCalls && allBoardReads) {
      step(`三会话全部 idle 且 toolCalls/boardReads 非零（${Date.now() - start}ms，放行 ${drained} 条）`);
      return { idle: true, drained, health: s.health };
    }
    await sleep(1000);
  }
  step(`等三会话 idle 超时（${timeoutMs}ms），放行 ${drained} 条`);
  return { idle: false, drained, health: (await getSnapshot()).health };
}

/** 从 wire.jsonl 提取「简报文本（session/prompt）里真的带上了标记」的硬证据。 */
function readWireBriefingEvidence(sessionId: string, marker: string): { promptLines: number; markerLines: number; samples: string[] } {
  const p = path.join(WORKSPACE, "sessions", sessionId, "wire.jsonl");
  if (!existsSync(p)) return { promptLines: 0, markerLines: 0, samples: [] };
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  let promptLines = 0;
  let markerLines = 0;
  const samples: string[] = [];
  for (const line of lines) {
    if (!line.includes(marker)) continue;
    markerLines += 1;
    try {
      const obj = JSON.parse(line) as { message?: { method?: string; params?: { prompt?: Array<{ text?: string }> } } };
      const msg = obj.message;
      if (msg && msg.method === "session/prompt") {
        promptLines += 1;
        const text = (msg.params?.prompt ?? []).map((x) => x.text ?? "").join(" ");
        if (samples.length < 2) samples.push(text.slice(0, 400));
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return { promptLines, markerLines, samples };
}

/** 三窗格 DOM 探针：每窗格的会话 id / 角色 / 档位 / 状态 / 健康度 / 行数 / 位置；
 *  R14 起中栏是标签页，额外报告标签数 / 可见窗格数 / 可见窗格高度（占满舞台的证据）。 */
const PANES_PROBE_JS = `(() => {
  const panes = Array.from(document.querySelectorAll(".pane"));
  const q = (el, sel) => el.querySelector(sel);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const details = panes.map((p) => ({
    sessionId: p.getAttribute("data-session"),
    agent: (q(p, ".pane-agent")?.textContent || "").trim(),
    role: (q(p, ".badge[class*='role-']")?.textContent || "").trim(),
    tier: (q(p, ".badge[class*='tier-']")?.textContent || "").trim(),
    status: (q(p, ".pane-status")?.textContent || "").trim(),
    health: (q(p, ".pane-health")?.textContent || "").trim(),
    lineCount: p.querySelectorAll(".conv-block").length,
    lines: Array.from(p.querySelectorAll(".conv-block")).slice(0, 4).map((n) => (n.textContent || "").trim().slice(0, 90)),
    rect: rect(p),
  }));
  const tabs = Array.from(document.querySelectorAll(".pane-tab"));
  const activePanes = Array.from(document.querySelectorAll(".pane.pane-active"));
  const hiddenPanes = Array.from(document.querySelectorAll(".pane.pane-hidden"));
  return {
    paneCount: panes.length,
    details,
    tabCount: tabs.length,
    tabSessions: tabs.map((t) => t.getAttribute("data-session")),
    activePaneCount: activePanes.length,
    hiddenPaneCount: hiddenPanes.length,
    activePaneRect: activePanes[0] ? rect(activePanes[0]) : null,
  };
})()`;

interface PanesProbe {
  paneCount: number;
  details: Array<{
    sessionId: string | null;
    agent: string;
    role: string;
    tier: string;
    status: string;
    health: string;
    lineCount: number;
    lines: string[];
    rect: { x: number; y: number; w: number; h: number };
  }>;
  tabCount: number;
  tabSessions: Array<string | null>;
  activePaneCount: number;
  hiddenPaneCount: number;
  activePaneRect: { x: number; y: number; w: number; h: number } | null;
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

  // —— A1：起 lead（guarded）——
  step(`派发 session.start agent=${AGENT} role=lead tier=guarded`);
  let r = await dispatchAction({ type: "session.start", taskId, agent: AGENT, role: "lead", tier: "guarded" }, 180000);
  check("lead 会话经冻结契约 session.start 返回 {ok:true}", r.ok, JSON.stringify(r));
  let snap = await getSnapshot();
  const lead = snap.sessions.find((s) => s.role === "lead");
  check("快照里出现 lead 会话", Boolean(lead), lead ? `id=${lead.id} status=${lead.status} tier=${lead.tier}` : JSON.stringify(snap.sessions.map((s) => `${s.role}:${s.status}`)));
  const leadId = lead?.id;
  if (!leadId) {
    await finish({ outcome: "no-lead" });
    return;
  }

  const leadIdle = await waitForIdle(leadId, 300000, "lead-briefing");
  check("lead 会话进入 idle（简报轮完成）", leadIdle.idle, `放行 ${leadIdle.drained} 条真实审批`);

  // lead 写死路
  step("派发 session.prompt 让 lead 写死路");
  r = await dispatchAction({ type: "session.prompt", sessionId: leadId, text: LEAD_PROMPT }, 30000);
  check("lead 派发 prompt 返回 {ok:true}", r.ok, JSON.stringify(r));
  const deadEndPromptAt = Date.now();

  const de = await waitForDeadEnd(deadEndPromptAt, 180000);
  check("lead 在超时内向黑板写入死路（核心）", de.appeared, `放行 ${de.drained} 条`);
  snap = await getSnapshot();
  const newDead =
    snap.board.deadEnds.find((d) => d.createdAt >= deadEndPromptAt && (d.description ?? "").includes(MARKER)) ??
    snap.board.deadEnds.find((d) => d.createdAt >= deadEndPromptAt);
  check("死路文字含本轮唯一标记", Boolean(newDead && (newDead.description ?? "").includes(MARKER)), `description="${newDead?.description}"`);
  check("死路的 by 是 lead 会话（经 MCP 写入，非夹具）", Boolean(newDead && newDead.by === leadId), `by="${newDead?.by}" leadId=${leadId}`);
  check("死路 scope 是 demo", Boolean(newDead && newDead.scope === DEAD_END_SCOPE), `scope="${newDead?.scope}"`);
  const leadHealthMid = (await getSnapshot()).health[leadId];
  check("lead 此时已有非零 toolCalls", (leadHealthMid?.toolCalls ?? 0) > 0, JSON.stringify(leadHealthMid));

  // —— A2：快速相继起 verify（autonomous）+ recon（guarded）——
  step("派发 session.start verify（autonomous）");
  r = await dispatchAction({ type: "session.start", taskId, agent: AGENT, role: "verify", tier: "autonomous" }, 180000);
  check("verify 会话经冻结契约 session.start 返回 {ok:true}", r.ok, JSON.stringify(r));
  step("派发 session.start recon（guarded）—— 与 verify 快速相继");
  r = await dispatchAction({ type: "session.start", taskId, agent: AGENT, role: "recon", tier: "guarded" }, 180000);
  check("recon 会话经冻结契约 session.start 返回 {ok:true}", r.ok, JSON.stringify(r));

  snap = await getSnapshot();
  const verify = snap.sessions.find((s) => s.role === "verify");
  const recon = snap.sessions.find((s) => s.role === "recon");
  const verifyId = verify?.id;
  const reconId = recon?.id;
  check("快照里有 3 个会话", snap.sessions.length === 3, snap.sessions.map((s) => `${s.id}:${s.role}`).join(","));
  check("三个会话 id 互不相同", Boolean(leadId && verifyId && reconId && new Set([leadId, verifyId, reconId]).size === 3), `lead=${leadId} verify=${verifyId} recon=${reconId}`);
  check(
    "三个会话角色各不相同 = lead/verify/recon",
    ["lead", "verify", "recon"].every((role) => snap.sessions.some((s) => s.role === role)),
    snap.sessions.map((s) => s.role).join(","),
  );
  const tiers = new Set(snap.sessions.map((s) => s.tier));
  check("混合档位（autonomous 与 guarded 都在）", tiers.has("autonomous") && tiers.has("guarded"), [...tiers].join(","));

  // —— 步骤 5：后起会话的简报包有没有带上 lead 刚写的死路 ——
  const verifyBriefing = verifyId ? sessions?.getBriefing(verifyId) : undefined;
  const reconBriefing = reconId ? sessions?.getBriefing(reconId) : undefined;
  check(
    "verify 的简报包带上了 lead 写的死路（dead_ends 含标记）",
    Boolean(verifyBriefing?.dead_ends.some((d) => d.includes(MARKER))),
    JSON.stringify(verifyBriefing?.dead_ends ?? null),
  );
  check(
    "recon 的简报包带上了 lead 写的死路（dead_ends 含标记）",
    Boolean(reconBriefing?.dead_ends.some((d) => d.includes(MARKER))),
    JSON.stringify(reconBriefing?.dead_ends ?? null),
  );
  check(
    "简报 do_not 明确禁止重复这条死路（含标记）",
    Boolean(verifyBriefing?.do_not.some((d) => d.includes(MARKER)) || reconBriefing?.do_not.some((d) => d.includes(MARKER))),
    JSON.stringify(verifyBriefing?.do_not ?? reconBriefing?.do_not ?? null),
  );
  const verifyWire = verifyId ? readWireBriefingEvidence(verifyId, MARKER) : { promptLines: 0, markerLines: 0, samples: [] };
  const reconWire = reconId ? readWireBriefingEvidence(reconId, MARKER) : { promptLines: 0, markerLines: 0, samples: [] };
  check(
    "简报文本真的发给了后起会话（wire.jsonl 的 session/prompt 含标记）",
    verifyWire.promptLines > 0 || reconWire.promptLines > 0,
    `verify.promptLines=${verifyWire.promptLines} recon.promptLines=${reconWire.promptLines}`,
  );

  if (!verifyId || !reconId) {
    await finish({ outcome: "missing-later-sessions" });
    return;
  }

  // —— B1：等三个会话全部 idle（简报轮跑完）且 toolCalls/boardReads 非零 ——
  const allIdle = await waitForAllIdle([leadId, verifyId, reconId], 300000);
  check("三个会话全部进入 idle（各自简报轮完成）", allIdle.idle, `放行 ${allIdle.drained} 条`);
  const statuses = (await getSnapshot()).sessions
    .filter((s) => [leadId, verifyId, reconId].includes(s.id))
    .map((s) => `${s.id}:${s.status}`);
  check("三个会话状态都在 running/idle（活着，非 blocked/failed/stopped）", statuses.every((x) => /running|idle/.test(x.split(":")[1] ?? "")), statuses.join(","));

  // —— B2：第二轮给三个会话各发一条不同的 prompt（快速相继 → 真并行）——
  step("第二轮：给三个会话各派发一条不同 prompt（快速相继，随即并发执行）");
  await dispatchAction({ type: "session.prompt", sessionId: leadId, text: ROUND2.lead }, 15000);
  await dispatchAction({ type: "session.prompt", sessionId: verifyId, text: ROUND2.verify }, 15000);
  await dispatchAction({ type: "session.prompt", sessionId: reconId, text: ROUND2.recon }, 15000);

  // 等三窗格都有各自内容 + 三会话都在跑（live），再截。
  const liveOk = await poll(
    `(async () => {
      const s = await window.bumimang.snapshot();
      const ids = ${JSON.stringify([leadId, verifyId, reconId])};
      const running = ids.every((id) => { const c = s.sessions.find((x) => x.id === id); return !!c && c.status === "running"; });
      const panes = Array.from(document.querySelectorAll(".pane"));
      const eachHasLines = panes.length === 3 && panes.every((p) => p.querySelectorAll(".conv-block").length >= 1);
      return running && eachHasLines;
    })()`,
    20000,
    500,
    "三会话 running + 三窗格各有内容",
  );
  await drainPending("round2");
  await sleep(2500); // 让 paint 安定再截

  hub.publishBoardSince(0); // 台账右栏重拉一次（数据是 agent 真写的，只是推一版事件，与 R9 同法）
  await sleep(400);

  // —— B3：截图 + DOM 断言 ——
  const shot = await screenshot("real-parallel.png");
  const probe = await evalJs<PanesProbe>(PANES_PROBE_JS);
  check("中栏画出 3 个窗格", probe.paneCount === 3, `paneCount=${probe.paneCount}`);
  check(
    "三个窗格各自都有非空实时流（每窗格 ≥1 行）",
    probe.details.length === 3 && probe.details.every((d) => d.lineCount >= 1),
    probe.details.map((d) => `${d.sessionId}:${d.lineCount} 行`).join(","),
  );
  check(
    "中栏是标签页：3 标签 + 1 可见窗格占满舞台（R14，不再并排）",
    probe.tabCount === 3 &&
      probe.tabSessions.length === 3 &&
      probe.activePaneCount === 1 &&
      probe.hiddenPaneCount === 2 &&
      probe.activePaneRect !== null &&
      probe.activePaneRect.h > 500,
    `tabs=${JSON.stringify(probe.tabSessions)} active=${probe.activePaneCount} hidden=${probe.hiddenPaneCount} paneH=${probe.activePaneRect?.h}`,
  );
  check(
    "三个窗格头部各显示自己的角色徽标（lead/verify/recon 各一）",
    ["lead", "verify", "recon"].every((role) => probe.details.some((d) => d.role === role)),
    probe.details.map((d) => d.role).join(","),
  );
  check(
    "三个窗格头部各显示自己的健康指标（同步 X · tool Y）",
    probe.details.length === 3 && probe.details.every((d) => /同步 \d+ · tool \d+/.test(d.health)),
    JSON.stringify(probe.details.map((d) => d.health)),
  );

  // —— B4：每会话独立 health + 每会话独立 session.stream ——
  snap = await getSnapshot();
  const ids = [leadId, verifyId, reconId];
  const healthKeys = Object.keys(snap.health);
  check(
    "health 映射有 3 个 key 且正好等于 3 个会话 id（每会话独立，非共享）",
    healthKeys.length === 3 && ids.every((id) => healthKeys.includes(id)),
    JSON.stringify(healthKeys),
  );
  check(
    "每个会话的 health.toolCalls 等于该会话自己的计数（非共享全局计数）",
    ids.every((id) => snap.health[id]?.toolCalls === sessions?.getSession(id)?.toolCalls),
    ids.map((id) => `${id}:health=${snap.health[id]?.toolCalls} rec=${sessions?.getSession(id)?.toolCalls}`).join(" "),
  );
  check(
    "每个会话的 health.boardReads 等于该会话自己的计数",
    ids.every((id) => snap.health[id]?.boardReads === sessions?.getSession(id)?.boardReads),
    ids.map((id) => `${id}:health=${snap.health[id]?.boardReads} rec=${sessions?.getSession(id)?.boardReads}`).join(" "),
  );
  check(
    "health.syncLag 按每会话独立计算（= toolCalls - 上次读黑板的序）",
    ids.every((id) => snap.health[id]?.syncLag === sessions?.syncLag(id)),
    ids.map((id) => `${id}:syncLag=${snap.health[id]?.syncLag}`).join(" "),
  );
  check(
    "三个会话的 toolCalls 并不完全相等（各自独立推进的证据）",
    new Set(ids.map((id) => snap.health[id]?.toolCalls)).size > 1,
    ids.map((id) => `${id}:${snap.health[id]?.toolCalls}`).join(" "),
  );

  const streamCounts = {
    lead: streamBySession.get(leadId) ?? 0,
    verify: streamBySession.get(verifyId) ?? 0,
    recon: streamBySession.get(reconId) ?? 0,
  };
  check(
    "三个会话各自都收到自己的 session.stream 事件（每会话 >0）",
    streamCounts.lead > 0 && streamCounts.verify > 0 && streamCounts.recon > 0,
    JSON.stringify(streamCounts),
  );

  // —— 收尾：经冻结契约停止三个会话（不留下 3 个 agent 在跑）——
  step("收尾：经冻结契约 session.stop 停止三个会话");
  await dispatchAction({ type: "session.stop", sessionId: leadId }, 15000);
  await dispatchAction({ type: "session.stop", sessionId: verifyId }, 15000);
  await dispatchAction({ type: "session.stop", sessionId: reconId }, 15000);
  const stoppedSnap = await getSnapshot();
  const stoppedStatuses = stoppedSnap.sessions.filter((s) => [leadId, verifyId, reconId].includes(s.id)).map((s) => `${s.id}:${s.status}`);
  step(`停止后状态：${stoppedStatuses.join(",")}`);

  await finish({
    outcome: "three-sessions-parallel",
    screenshot: shot,
    sessionIds: { lead: leadId, verify: verifyId, recon: reconId },
    fanout: FANOUT,
    briefing: {
      note: "冻结契约（snapshot/events）不暴露简报包；简报继承在 main 侧 SessionManager.getBriefing + wire.jsonl 上断言（与 R8/R9 同一 import 面）。",
      verify: verifyBriefing ? { dead_ends: verifyBriefing.dead_ends, do_not: verifyBriefing.do_not } : null,
      recon: reconBriefing ? { dead_ends: reconBriefing.dead_ends, do_not: reconBriefing.do_not } : null,
      verifyWire,
      reconWire,
    },
    healthAtEnd: Object.fromEntries(ids.map((id) => [id, snap.health[id]])),
    streamCounts,
    streamSamples: {
      lead: streamSamples.get(leadId) ?? [],
      verify: streamSamples.get(verifyId) ?? [],
      recon: streamSamples.get(reconId) ?? [],
    },
    panesProbe: probe,
    livePollOk: liveOk,
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
    marker: MARKER,
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
  const jsonPath = path.join(LOGS_DIR, "real-parallel.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== REAL-PARALLEL-VERIFY · 三 claude 会话真并行端到端 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n结果：${outcome}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (extra.screenshot) process.stdout.write(`截图：${String(extra.screenshot)}\n`);
  if (autoApproved.length > 0) process.stdout.write(`\n自动放行真实审批 ${autoApproved.length} 条（详见 real-parallel.json 的 autoApproved）\n`);
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

// 兜底：任何情况下 960 秒内必须退出，避免挂死留下残留进程（3 个真实 claude 多轮 + 简报轮可能很慢）。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（960s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "real-parallel.json"),
    JSON.stringify({ timeout: true, timeline, assertions, autoApproved, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  void cleanup().then(() => app.exit(9));
}, 960000);
