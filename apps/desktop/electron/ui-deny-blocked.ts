/**
 * Lane B · 第 17 轮 ·「UI 上点拒绝」补上审批链最后一环。
 *
 * 背景（docs/done/VERIFY-concurrency-and-blocked.md 末节）：Lane A 验过「拒绝 → 退避 →
 * blocked 终态」这条链，但那是**从队列直接 decide** 的（测试自己调了 queue.decide()）。
 * 从来没有人走过真实用户的那条路：
 *
 *   UI 拒绝按钮（DOM `[data-act="deny"]` 的 click）
 *     → `decide()` → `ctx.hub.dispatch({type:"approval.decide", decision:"deny"})`
 *     → 真实 IPC（preload `window.bumimang`）→ 主进程 `hub.dispatch`
 *     → ApprovalQueue.decide("denied") → DenialTracker（同规则 2 次）→ markBlocked
 *     → 会话卡画成「被策略切断」（blocked，红边框）而不是「崩溃」（failed，仅红字）
 *     → 台账多一条 scope=blocked 死路。
 *
 * 本入口把这条链在**真实后端、真实 claude、真实窗口**里完整跑一遍，零 mock、零种审批：
 *
 *   1. 经冻结契约 `window.bumimang.dispatch` 起 guarded claude 会话
 *   2. 等 idle（简报轮若触发审批，像真人一样放行——这不是本轮测的 deny 路径）
 *   3. `session.prompt` 让 claude 创建 demo.txt → 等 pending（claude 写文件前真问）
 *   4. **点 UI 里的「拒绝」按钮**（DOM 真实按钮 .click()，不是直接 dispatch approval.decide）
 *   5. 同一规则（tier-guarded-default）再拒一次：优先等 claude 自发重试，没有则 prompt 它重试第二个文件
 *   6. 断言：会话终态 blocked、会话卡是「被策略切断」视觉（不是崩溃）、台账多 scope=blocked 死路
 *   7. 截图 docs/logs/ui-deny-blocked.png
 *
 * 只 import、不修改 src/main（Lane A 的 lane）；契约 events.ts 冻结未动。
 * 若第二次 deny 在合理时间内诱发不出来，如实记录「一次 deny 端到端已验」，绝不种审批代替。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/ui-deny-blocked.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|step|ALL_PASS|结果"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { ApprovalView, HubSnapshot } from "../../../packages/shared-protocol/events.ts";
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
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "verify-ui-deny");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

const AGENT = "claude";
/** 让 claude 写文件 —— 实测这是它最可靠会发 session/request_permission 的场景 */
const PROMPT_TEXT =
  "请在当前目录创建一个名为 demo.txt 的文件，内容写一行 hello。只做这一件事，完成后就结束。";
/** 第一次拒绝后、若 claude 没自发重试，用第二个文件诱发第二次请求（同规则 tier-guarded-default） */
const RETRY_PROMPT_TEXT =
  "请再次尝试：在当前目录创建另一个文件 demo2.txt，内容写一行 world。只做这一件事，完成后就结束。";

// 独立 userData，避免与 Lane A 的 main.ts 抢文件锁。
app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-ui-deny"));
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
/** 每一次经 UI 拒绝按钮点掉的审批（deny 的完整留痕） */
const denyEvents: Array<{
  approvalId: string;
  action: string;
  command: string | null;
  rule: string | null;
  risk: string | null;
  sameKindCount: number;
  clickLabel: string | null;
  clickReason: string;
  deniedStatus: string | null;
  deniedBy: string | null;
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

  // 中性简报：不指定任何目标，避免简报轮就让 claude 去探索文件系统（那种探索会触发
  // shell 权限请求，把会话卡在简报轮，demo.txt 的写入反而不干净）。写入动作留给 session.prompt。
  const t = b.createTask({
    title: "验收演示任务（UI 拒绝）",
    brief: "本任务仅用于验证工作台的人工审批拒绝链路，暂无具体目标，等待后续指令。",
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

/** 派发一个 HubAction（经冻结契约 window.bumimang.dispatch，即真实 IPC）。 */
async function dispatchAction(action: unknown, timeoutMs = 15000): Promise<{ done: boolean; result: { ok?: boolean; error?: string } | null; error: string | null }> {
  await evalJs<boolean>(`(() => {
    window.__act = { done: false, result: null, error: null };
    window.bumimang.dispatch(${JSON.stringify(action)})
      .then((r) => { window.__act = { done: true, result: r, error: null }; })
      .catch((e) => { window.__act = { done: true, result: null, error: String((e && e.message) || e) }; });
    return true;
  })()`);
  const done = await poll(`window.__act && window.__act.done === true`, timeoutMs, 250, "action 返回");
  const res = await evalJs<{ result: { ok?: boolean; error?: string } | null; error: string | null }>(
    `({ result: window.__act ? window.__act.result : null, error: window.__act ? window.__act.error : null })`,
  );
  return { done, ...res };
}

/**
 * 本轮的「钱动作」：在真实 UI 里点「拒绝」按钮。
 *
 * 不是 `window.bumimang.dispatch({type:"approval.decide", decision:"deny"})` —— 那正是 Lane A
 * 已经验过的「队列直接 decide」。这里找到渲染出来的审批卡片里的 `[data-act="deny"]` 按钮，
 * 对它 .click()，走它自己的 click 监听器 → decide() → ctx.hub.dispatch → 真实 IPC 的完整路径。
 */
async function clickDenyButton(approvalId: string): Promise<{ clicked: boolean; reason: string; label: string | null }> {
  const present = await poll(
    `document.querySelector('.ap-card.ap-pending[data-id=${JSON.stringify(approvalId)}]') !== null`,
    8000,
    200,
    `拒绝按钮卡片就绪（${approvalId}）`,
  );
  if (!present) return { clicked: false, reason: "card-not-rendered", label: null };
  return await evalJs<{ clicked: boolean; reason: string; label: string | null }>(`(() => {
    const card = document.querySelector('.ap-card.ap-pending[data-id=${JSON.stringify(approvalId)}]');
    if (!card) return { clicked: false, reason: "card-gone", label: null };
    const btn = card.querySelector('[data-act="deny"]');
    if (!btn) return { clicked: false, reason: "deny-button-missing", label: null };
    const label = (btn.textContent || "").trim();
    btn.click();
    return { clicked: true, reason: "clicked", label };
  })()`);
}

/**
 * 从 wire.jsonl 提取硬证据：claude 真实发来的 request_permission 行（含 policy 判定），
 * 以及每轮 turn 的 stopReason（deny #1 应 end_turn、deny #2 应 cancelled —— 后者是
 * markBlocked 的 cancel 生效、进而触发 prompt() 覆盖 blocked→idle 的直接证据）。
 */
function readWireEvidence(sessionId: string): Array<Record<string, unknown>> {
  const p = path.join(WORKSPACE, "sessions", sessionId, "wire.jsonl");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const s = JSON.stringify(obj);
      if (s.includes("request_permission") || s.includes("stopReason")) {
        // 压缩：只留能说明问题的最小字段，避免证据 JSON 被 1500 行 wire 撑爆
        out.push({
          ts: (obj as { ts?: number }).ts ?? null,
          dir: (obj as { dir?: string }).dir ?? null,
          method: ((obj as { message?: { method?: string; result?: { stopReason?: string }; params?: { toolCall?: { name?: string; title?: string } } } }).message?.method) ?? null,
          stopReason: ((obj as { message?: { result?: { stopReason?: string } } }).message?.result?.stopReason) ?? null,
          toolTitle: ((obj as { message?: { params?: { toolCall?: { title?: string } } } }).message?.params?.toolCall?.title) ?? null,
          rule: ((obj as { message?: { policy?: { rule?: string } } }).message?.policy?.rule) ?? null,
        });
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.slice(-40);
}

/** 把待批审批里还没决的放行，让会话能自然收尾（简报轮）。 */
async function approveAllPending(): Promise<number> {
  const snap = await getSnapshot();
  const pending = snap.approvals.filter((a) => a.status === "pending");
  for (const a of pending) {
    step(`补充放行：${a.id}（${a.command ?? a.action}）`);
    await dispatchAction({ type: "approval.decide", approvalId: a.id, decision: "approve" }, 10000);
  }
  return pending.length;
}

/**
 * 等会话 idle，但简报轮里 claude 若真的发来审批（探索/读环境这类），像真人一样放行。
 * 这些审批是 claude 真实发来的，放行 ≠ 种审批；不放行的话会话会永远卡在简报轮。
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
        await dispatchAction({ type: "approval.decide", approvalId: a.id, decision: "approve" }, 10000);
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

/** 会话卡 DOM 探针：blocked（被策略切断）与 failed（崩溃）的视觉必须分得清。 */
function sessionCardProbeJs(sessionId: string): string {
  return `(() => {
    const item = document.querySelector('.session-item[data-id=${JSON.stringify(sessionId)}]');
    if (!item) return { rendered: false };
    const blockedBadge = item.querySelector('.status-blocked');
    const failedBadge = item.querySelector('.status-failed');
    const stoppedBadge = item.querySelector('.status-stopped');
    return {
      rendered: true,
      hasBlockedClass: item.classList.contains('session-blocked'),
      hasFailedClass: item.classList.contains('session-failed'),
      blockedText: blockedBadge ? blockedBadge.textContent.trim() : null,
      hasFailedBadge: !!failedBadge,
      hasStoppedBadge: !!stoppedBadge,
      title: item.getAttribute('title'),
      badges: Array.from(item.querySelectorAll('.badge')).map((b) => b.textContent.trim()),
    };
  })()`;
}

/**
 * 诱发第二次 pending：先等 claude 自发重试（同一轮里再问 / 换动作再问），
 * 会话 idle 且仍无 pending 时，发一次重试 prompt（第二个文件）。返回新 pending 或 null。
 */
async function provokeSecondPending(sessionId: string, excludeIds: string[], deadlineMs: number): Promise<ApprovalView | null> {
  let retries = 0;
  const deadline = Date.now() + deadlineMs;
  step(`开始诱发第二次审批（同规则），预算 ${deadlineMs}ms`);
  while (Date.now() < deadline) {
    const snap = await getSnapshot();
    const p = snap.approvals.find((a) => a.status === "pending" && !excludeIds.includes(a.id));
    if (p) return p;
    const c = snap.sessions.find((x) => x.id === sessionId);
    if (c && c.status === "idle" && retries < 2) {
      retries += 1;
      step(`会话 idle 且无新 pending → 发送第 ${retries} 次重试 prompt（第二个文件）`);
      await dispatchAction({ type: "session.prompt", sessionId, text: RETRY_PROMPT_TEXT }, 15000);
      await sleep(3000);
      continue;
    }
    await sleep(2000);
  }
  step(`诱发第二次审批超时（${deadlineMs}ms），已重试 prompt ${retries} 次`);
  return null;
}

/** 把一次 UI 拒绝的完整结果记进 denyEvents，并断言该条在快照里已是 denied（human 决定）。 */
async function recordDeny(a: ApprovalView, idx: number): Promise<void> {
  const clickRes = await clickDenyButton(a.id);
  check(`第 ${idx} 次拒绝：UI「拒绝」按钮被真实点击（DOM .click()）`, clickRes.clicked === true, `label="${clickRes.label}" reason=${clickRes.reason}`);
  const deniedOk = await poll(
    `(async () => { const s = await window.bumimang.snapshot(); const x = s.approvals.find(v => v.id === ${JSON.stringify(a.id)}); return !!x && x.status === "denied"; })()`,
    10000,
    250,
    `第 ${idx} 次 deny 生效（快照 status=denied）`,
  );
  const snap = await getSnapshot();
  const after = snap.approvals.find((v) => v.id === a.id);
  check(`第 ${idx} 次拒绝：审批项变成已拒绝且由 human 决定`, deniedOk && after?.status === "denied" && after?.decidedBy === "human", `status=${after?.status} decidedBy=${after?.decidedBy}`);
  denyEvents.push({
    approvalId: a.id,
    action: a.action,
    command: a.command,
    rule: a.rule,
    risk: a.risk,
    sameKindCount: a.sameKindCount,
    clickLabel: clickRes.label,
    clickReason: clickRes.reason,
    deniedStatus: after?.status ?? null,
    deniedBy: after?.decidedBy ?? null,
  });
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
  const startRes = await dispatchAction({ type: "session.start", taskId, agent: AGENT, role: "lead", tier: "guarded" }, 150000);
  check("session.start 返回 {ok:true}", startRes.done && startRes.result?.ok === true, JSON.stringify(startRes.result ?? startRes.error));

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

  // —— 3. 派发 session.prompt（写 demo.txt）——
  const baseSnap = await getSnapshot();
  const pendingBefore = baseSnap.approvals.filter((a) => a.status === "pending").length;
  check("派发 prompt 前审批队列为空（基线）", pendingBefore === 0, `pendingBefore=${pendingBefore}`);
  const promptDispatchAt = Date.now();
  step(`派发 session.prompt：${PROMPT_TEXT}`);
  const promptRes = await dispatchAction({ type: "session.prompt", sessionId, text: PROMPT_TEXT }, 15000);
  check("session.prompt 返回 {ok:true}", promptRes.done && promptRes.result?.ok === true, JSON.stringify(promptRes.result ?? promptRes.error));

  // —— 4. 轮询快照等第一个 pending ——
  step("开始轮询 snapshot.approvals，等 claude 发 session/request_permission（≤120s）");
  const pendingAppeared = await poll(
    `(async () => { const s = await window.bumimang.snapshot(); return s.approvals.some((a) => a.status === "pending"); })()`,
    120000,
    1000,
    "第一个 pending 审批出现",
  );

  if (!pendingAppeared) {
    // 合法发现：claude 没问。如实截图留证，绝不种审批。
    const shot = await screenshot("ui-deny-blocked-timeout.png");
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

  const snapPending = await getSnapshot();
  const firstPending = snapPending.approvals.find((a) => a.status === "pending");
  check("快照里有一条 pending 审批", Boolean(firstPending), firstPending ? `id=${firstPending.id}` : "无");
  check(
    "pending 的 action 是 session/request_permission（唯一事前闸门动作）",
    firstPending?.action === "session/request_permission",
    `action=${firstPending?.action}`,
  );
  check(
    "这条 pending 是本轮 prompt 触发的（createdAt 在 prompt 派发之后）",
    Boolean(firstPending && firstPending.createdAt >= promptDispatchAt),
    `createdAt=${firstPending?.createdAt} promptAt=${promptDispatchAt}`,
  );
  const firstId = firstPending?.id;
  if (!firstId) {
    await finish({ outcome: "no-pending-id" });
    return;
  }

  // —— 5. 第一次拒绝：点 UI「拒绝」按钮 ——
  step(`第一次拒绝：点 UI「拒绝」按钮（${firstId}）`);
  await recordDeny(firstPending, 1);

  // —— 6. 诱发第二次审批并再次经 UI 拒绝 ——
  const second = await provokeSecondPending(sessionId, [firstId], 240000);

  let blocked = false;
  if (second) {
    step(`第二次审批出现（${second.id}，rule=${second.rule}）→ 点 UI「拒绝」按钮`);
    await recordDeny(second, 2);
    // —— 7. 等 blocked 终态 ——
    const blockedOk = await poll(
      `(async () => { const s = await window.bumimang.snapshot(); const c = s.sessions.find(x => x.id === ${JSON.stringify(sessionId)}); return !!c && c.status === "blocked"; })()`,
      30000,
      500,
      "会话进入 blocked 终态",
    );
    blocked = blockedOk;
  } else {
    step("第二次审批未能在预算内诱发 —— 如实记录「一次 deny 端到端已验」");
  }

  // —— 8. 终态断言 + 截图 ——
  const snapFinal = await getSnapshot();
  const sessFinal = snapFinal.sessions.find((s) => s.id === sessionId);
  const blockedDeadEnd = snapFinal.board.deadEnds.find((d) => d.scope === "blocked");

  if (blocked) {
    // 等 DOM 把 blocked 画出来（session.upsert 事件回流 → 左栏会话卡重绘）
    await poll(`document.querySelector('.session-item[data-id=${JSON.stringify(sessionId)}].session-blocked') !== null`, 10000, 300, "会话卡 blocked 视觉渲染");
    await poll(
      `(async () => { const s = await window.bumimang.snapshot(); return s.board.deadEnds.some(d => d.scope === "blocked"); })()`,
      10000,
      300,
      "台账 scope=blocked 死路出现在快照",
    );
    await sleep(600); // 让 paint 安定再截

    const shot = await screenshot("ui-deny-blocked.png");
    const dom = await evalJs<Record<string, unknown>>(sessionCardProbeJs(sessionId));
    const deadendsDom = await evalJs<string[]>(`(() => Array.from(document.querySelectorAll('.deadend .deadend-desc')).map((n) => n.textContent.trim()))()`);
    const deadend = snapFinal.board.deadEnds.find((d) => d.scope === "blocked");
    const incident = snapFinal.board.deadEnds.find((d) => d.scope === "incident");

    // 快照层断言（权威）
    check("会话终态是 blocked（不是 failed/stopped）", sessFinal?.status === "blocked", `status=${sessFinal?.status}`);
    check("终态不是崩溃 failed", sessFinal?.status !== "failed", `status=${sessFinal?.status}`);
    check("终态不是人工停止 stopped", sessFinal?.status !== "stopped", `status=${sessFinal?.status}`);
    check(
      "台账多了一条 scope=blocked 的死路（策略切断，不是崩溃）",
      Boolean(deadend),
      deadend ? `desc=${deadend.description} by=${deadend.by}` : "无 scope=blocked 死路",
    );
    check(
      "没有 scope=incident 的崩溃死路（blocked ≠ 崩溃）",
      !incident,
      incident ? `desc=${incident.description}` : "无 incident 死路（正确）",
    );

    // DOM 层断言（视觉：blocked 红边框 + 「被策略切断」，不是崩溃「崩溃」）
    check("会话卡在真实窗口里渲染", dom.rendered === true);
    check("会话卡带 session-blocked 类（红边框视觉）", dom.rendered === true && dom.hasBlockedClass === true, `hasBlockedClass=${dom.hasBlockedClass}`);
    check("会话卡不带 session-failed 类（不是崩溃视觉）", dom.rendered === true && dom.hasFailedClass === false, `hasFailedClass=${dom.hasFailedClass}`);
    check("会话卡徽标文字是「被策略切断」（不是「崩溃」）", dom.rendered === true && dom.blockedText === "被策略切断", `blockedText="${dom.blockedText}"`);
    check("会话卡没有 failed 徽标", dom.rendered === true && dom.hasFailedBadge === false, `hasFailedBadge=${dom.hasFailedBadge}`);
    check("会话卡没有 stopped 徽标", dom.rendered === true && dom.hasStoppedBadge === false, `hasStoppedBadge=${dom.hasStoppedBadge}`);
    check(
      "会话卡 title 说明「策略切断」（非崩溃）",
      dom.rendered === true && typeof dom.title === "string" && dom.title.includes("策略切断"),
      `title=${dom.title}`,
    );
    check(
      "台账面板渲染出该死路（含「被策略拦截」）",
      deadendsDom.some((d) => d.includes("被策略拦截")),
      `deadends=${JSON.stringify(deadendsDom)}`,
    );

    // 两次拒绝确实是同一规则（阈值 2 的语义：同规则连续拒绝）
    const rules = denyEvents.map((d) => d.rule);
    check(
      "两次拒绝命中同一规则（tier-guarded-default）",
      denyEvents.length >= 2 && new Set(rules).size === 1 && rules[0] === "tier-guarded-default",
      `rules=${JSON.stringify(rules)}`,
    );

    await finish({
      outcome: "blocked-via-ui-two-denies",
      screenshot: shot,
      sessionId,
      promptText: PROMPT_TEXT,
      retryPromptText: RETRY_PROMPT_TEXT,
      briefingDrained: drained,
      briefingApprovals,
      denyEvents,
      final: {
        sessionStatus: sessFinal?.status ?? null,
        deadEnd: deadend ? { id: deadend.id, description: deadend.description, scope: deadend.scope, by: deadend.by } : null,
        incidentDeadEnd: incident ? { description: incident.description } : null,
        sessionCardDom: dom,
        boardDeadEndsDom: deadendsDom,
      },
      wireEvidence: readWireEvidence(sessionId),
    });
  } else {
    // 诚实收尾。区分两种情况：
    //  a) 第二次审批诱发不出来 → 一次 deny 端到端已验，也是价值；
    //  b) 两次都拒了、markBlocked 也跑了，但会话没进 blocked → 主进程真 bug（prompt() 覆盖）。
    await sleep(600);
    const shot = await screenshot("ui-deny-blocked.png");
    const dom = await evalJs<Record<string, unknown>>(sessionCardProbeJs(sessionId));
    const deadendsDom = await evalJs<string[]>(`(() => Array.from(document.querySelectorAll('.deadend .deadend-desc')).map((n) => n.textContent.trim()))()`);
    check(
      "第一次 deny 已端到端验证（UI 按钮 → 队列 → denied）",
      denyEvents.length >= 1 && denyEvents[0].deniedStatus === "denied" && denyEvents[0].deniedBy === "human",
      JSON.stringify(denyEvents[0]),
    );
    if (second) {
      // 两次都拒了，但会话没进 blocked —— 这是主进程真 bug，不是诱发失败。
      check(
        "第二次 deny 也经 UI 端到端验证（denied + human）",
        denyEvents.length >= 2 && denyEvents[1].deniedStatus === "denied" && denyEvents[1].deniedBy === "human",
        JSON.stringify(denyEvents[1]),
      );
      check(
        "两次拒绝命中同一规则（阈值 2 的语义）",
        denyEvents.length >= 2 && new Set(denyEvents.map((d) => d.rule)).size === 1 && denyEvents[0].rule === "tier-guarded-default",
        `rules=${JSON.stringify(denyEvents.map((d) => d.rule))}`,
      );
      check(
        "markBlocked 已执行（死路 scope=blocked 已写库）",
        Boolean(blockedDeadEnd),
        blockedDeadEnd ? `desc=${blockedDeadEnd.description}` : "无 scope=blocked 死路",
      );
      check(
        "台账面板渲染出该死路（含「被策略拦截」）",
        deadendsDom.some((d) => d.includes("被策略拦截")),
        `deadends=${JSON.stringify(deadendsDom)}`,
      );
      check(
        "会话终态是 blocked（未通过 —— 主进程 prompt() 把 blocked 覆盖回 idle）",
        false,
        `sessionStatus=${sessFinal?.status}`,
      );
      await finish({
        outcome: "two-denies-but-session-not-blocked",
        screenshot: shot,
        sessionId,
        promptText: PROMPT_TEXT,
        retryPromptText: RETRY_PROMPT_TEXT,
        briefingDrained: drained,
        briefingApprovals,
        denyEvents,
        final: {
          sessionStatus: sessFinal?.status ?? null,
          deadEnds: snapFinal.board.deadEnds.map((d) => ({ id: d.id, scope: d.scope, description: d.description })),
          sessionCardDom: dom,
          boardDeadEndsDom: deadendsDom,
        },
        wireEvidence: readWireEvidence(sessionId),
      });
    } else {
      check(
        "第二次 deny 未能在预算内诱发（如实报告，不种审批）",
        false,
        `sessionStatus=${sessFinal?.status} approvals=${snapFinal.approvals.map((a) => `${a.status}:${a.action}`).join(",")}`,
      );
      await finish({
        outcome: "one-deny-only",
        screenshot: shot,
        sessionId,
        promptText: PROMPT_TEXT,
        retryPromptText: RETRY_PROMPT_TEXT,
        briefingDrained: drained,
        briefingApprovals,
        denyEvents,
        final: {
          sessionStatus: sessFinal?.status ?? null,
          deadEnds: snapFinal.board.deadEnds.map((d) => ({ id: d.id, scope: d.scope, description: d.description })),
          sessionCardDom: dom,
        },
        wireEvidence: readWireEvidence(sessionId),
      });
    }
  }
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
    retryPromptText: RETRY_PROMPT_TEXT,
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
  const jsonPath = path.join(LOGS_DIR, "ui-deny-blocked.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== UI-DENY-BLOCKED · UI 上点拒绝 → blocked 终态端到端 ==\n\n");
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

// 兜底：任何情况下 900 秒内必须退出，避免挂死留下残留进程（真实 claude 两轮 + 简报轮 + 二次诱发可能很慢）。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（900s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "ui-deny-blocked.json"),
    JSON.stringify({ timeout: true, timeline, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  void cleanup().then(() => app.exit(9));
}, 900000);
