/**
 * Lane B · R-1 徽标 + blocked 终态验收（真实桥，非 mock）。
 *
 * 复用 Lane A 的核心（Blackboard / BoardBridge / SessionManager / HubService /
 * PolicyEngine），照主进程入口把三条 IPC 通道接上，再挂 preload，让渲染进程真的连上
 * `window.bumimang`。**不 spawn 任何 agent**，所以跑得快、无 flake。它证明两件事：
 *
 *   1. R-1：真实后端现在把策略包放进快照（HubSnapshot.policy）。左栏「规则包」徽标
 *      必须显示真实包名 `policy-engine(<pack.name>)`（不再是占位「—」），且没有回落
 *      到最小安全集（fellBackToMinimal=false 时不该有「已回落最小安全集」小字）。
 *   2. §9.6：SessionStatus 现在有 `blocked`（策略切断的终态）。UI 必须把它画成
 *      「被策略切断」，而不是画成崩溃（failed）或人工停止（stopped）。blocked 会话
 *      经真实 EventBus → hub:event 通道注入（与 SessionManager.markBlocked →
 *      publishSessionRec → bus.emit 同一条路），渲染进程按事件画卡。
 *
 * 只 import、不修改 src/main（那是 Lane A 的 lane）；也不碰 packages/shared-protocol/events.ts（冻结）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/r1-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|R1|shot"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { SessionView } from "../../../packages/shared-protocol/events.ts";
import { Blackboard } from "../src/main/blackboard/board.ts";
import { BoardBridge } from "../src/main/mcp-host/bridge.ts";
import { PassthroughPolicy } from "../src/main/policy/policy.ts";
import { PolicyEngine, loadPack } from "../src/main/policy/engine.ts";
import { ApprovalQueue } from "../src/main/approval/queue.ts";
import { SessionManager, newRunId } from "../src/main/session/manager.ts";
import { EventBus, HubService } from "../src/main/hub/hub.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "verify-r1");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

// 独立 userData，避免与其它 verify 入口抢文件锁。
app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-r1"));
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

let win: BrowserWindow | null = null;
let board: Blackboard | null = null;
let bridge: BoardBridge | null = null;
/** R17 之后渲染层按真实任务 id 过滤 session.upsert；注入必须用真 id，不能再写死 "task-r1"。 */
let currentTaskId = "";
let sessions: SessionManager | null = null;
let bus: EventBus | null = null;
let gatePolicy: PolicyEngine | null = null;

const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
let rendererGone: string | null = null;

async function cleanup(): Promise<void> {
  sessions?.shutdown();
  bridge?.stop();
  await sleep(300);
  board?.close();
}

async function bootstrap(): Promise<HubService> {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORKSPACE, { recursive: true });

  const b = Blackboard.open(path.join(WORKSPACE, "board.db"));
  board = b;

  const t = b.createTask({
    title: "R-1 验收任务",
    brief: "只验证策略包徽标与 blocked 终态渲染，不起任何 agent。",
  });
  currentTaskId = t.id;

  const runId = newRunId();
  const br = new BoardBridge({ board: b, taskId: t.id, runId });
  await br.start();
  bridge = br;

  const busLocal = new EventBus();
  bus = busLocal;

  let hub!: HubService;
  const approvals = new ApprovalQueue({
    onUpsert: (view) => busLocal.emit({ type: "approval.upsert", approval: view }),
    intentSummary: (sid) => hub.intentSummary(sid),
  });
  // 真实策略引擎：读 rules/competition.json，名字会被填进快照的 policy 字段。
  gatePolicy = new PolicyEngine({ repoRoot: REPO_ROOT, packId: "competition" });

  const mgr = new SessionManager({
    board: b,
    bridge: br,
    policy: new PassthroughPolicy(),
    workspaceRoot: WORKSPACE,
    onLine: (line) => process.stdout.write(`${line}\n`),
    onStream: (sessionId, raw) => hub.publishStream(sessionId, raw),
    onSessionChange: (rec) => hub.publishSessionRec(rec),
  });
  sessions = mgr;

  hub = new HubService({
    board: b,
    sessions: mgr,
    bus: busLocal,
    workspaceRoot: WORKSPACE,
    models: {},
    approvals,
    policy: gatePolicy,
  });
  hub.setTask(t.id);

  return hub;
}

function registerIpc(hub: HubService): void {
  ipcMain.handle(HUB_CHANNELS.snapshot, () => hub.snapshot());
  ipcMain.handle(HUB_CHANNELS.dispatch, async (_e, action: unknown) => {
    return hub.dispatch(action as never);
  });
  bus!.on((e) => {
    win?.webContents.send(HUB_CHANNELS.event, e);
  });
}

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
    // Electron 44 新签名 (event, {level, message, ...})；旧签名 (event, level, message, ...)。
    const second = args[1] as { level?: unknown; message?: unknown } | undefined;
    let level: string;
    let message: string;
    if (typeof second === "object" && second !== null && "message" in second) {
      level = String(second.level ?? "log");
      message = String(second.message ?? "");
    } else {
      level = String(args[1] ?? "log");
      message = String(args[2] ?? "");
    }
    consoleLogs.push({ level, message });
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

async function screenshot(name: string): Promise<string> {
  const img = await win!.webContents.capturePage();
  const png = img.toPNG();
  const pngPath = path.join(LOGS_DIR, name);
  writeFileSync(pngPath, png);
  writeFileSync(pngPath.replace(/\.png$/, ".jpg"), img.toJPEG(82));
  process.stdout.write(`[shot] ${name} (${png.length} bytes, ${img.getSize().width}x${img.getSize().height})\n`);
  return pngPath;
}

/** 首屏策略徽标 DOM 探针。 */
const POLICY_PROBE_JS = `(async () => {
  const q = (s) => document.querySelector(s);
  const snap = await window.bumimang.snapshot();
  const badge = q(".policy-pack");
  const name = q(".policy-pack-name");
  const fallback = q(".policy-pack-fallback");
  return {
    snapPolicy: snap.policy || null,
    badgeClass: badge ? badge.className : null,
    badgeName: name ? (name.textContent || "").trim() : null,
    fallbackText: fallback ? (fallback.textContent || "").trim() : null,
  };
})()`;

/** blocked / failed / stopped / running 四个会话经事件注入后的 DOM 探针。 */
const BLOCKED_PROBE_JS = `(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const statusTextOf = (li) => {
    const b = li.querySelector(".status-blocked, .status-failed, .status-stopped, .status-running");
    return b ? (b.textContent || "").trim() : null;
  };
  const borderOf = (li) => {
    const cs = getComputedStyle(li);
    return cs.borderTopColor;
  };
  const blocked = qa(".session-item.session-blocked");
  const failed = qa(".session-item.session-failed");
  const stopped = qa(".session-item.session-stopped");
  const running = qa(".session-item.session-running");
  const blockedPane = qa(".pane-blocked");
  return {
    blockedCards: blocked.length,
    blockedText: blocked[0] ? statusTextOf(blocked[0]) : null,
    blockedTitle: blocked[0] ? (blocked[0].getAttribute("title") || "") : null,
    blockedBorder: blocked[0] ? borderOf(blocked[0]) : null,
    failedText: failed[0] ? statusTextOf(failed[0]) : null,
    failedBorder: failed[0] ? borderOf(failed[0]) : null,
    stoppedText: stopped[0] ? statusTextOf(stopped[0]) : null,
    runningText: running[0] ? statusTextOf(running[0]) : null,
    blockedPaneCount: blockedPane.length,
    blockedPaneStatus: blockedPane[0] ? (blockedPane[0].querySelector(".pane-status") ? blockedPane[0].querySelector(".pane-status").textContent.trim() : null) : null,
    undefinedLeak: (document.body.textContent || "").includes("undefined"),
  };
})()`;

async function runVerify(hub: HubService): Promise<void> {
  // —— 首屏就绪 ——
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelector(".policy-pack") !== null;
    })()`,
    12000,
    100,
  );
  check("真实桥 + 三栏 + 策略徽标在 12s 内就绪", ready);

  // —— R-1：徽标显示真实包名 ——
  const policy = await evalJs<Record<string, unknown>>(POLICY_PROBE_JS);
  const snapPolicy = (policy.snapPolicy ?? null) as { packId?: string; name?: string; fellBackToMinimal?: boolean } | null;

  const pack = loadPack(REPO_ROOT, "competition");
  const expectedName = `policy-engine(${pack?.name ?? "?"})`;
  check("rules/competition.json 能加载（数据源存在）", pack !== null, `pack.name="${pack?.name}"`);

  check("快照带 policy 字段（真实后端填了）", snapPolicy !== null, JSON.stringify(snapPolicy));
  check("policy.packId = competition", snapPolicy?.packId === "competition", `packId=${snapPolicy?.packId}`);
  check(
    "policy.name 是 policy-engine(包名) 形态",
    typeof snapPolicy?.name === "string" && snapPolicy!.name!.startsWith("policy-engine(") && snapPolicy!.name!.endsWith(")"),
    `name="${snapPolicy?.name}"`,
  );
  check(
    "policy.name 与真实引擎/规则包一致",
    snapPolicy?.name === gatePolicy!.name && snapPolicy?.name === expectedName,
    `snapshot="${snapPolicy?.name}" engine="${gatePolicy!.name}" expected="${expectedName}"`,
  );
  check("policy.fellBackToMinimal = false（没有回落）", snapPolicy?.fellBackToMinimal === false, `fellBack=${snapPolicy?.fellBackToMinimal}`);

  check(
    "左栏徽标显示真实包名（不是占位「—」）",
    (policy.badgeName as string) === snapPolicy!.name && (policy.badgeName as string) !== "—",
    `badge="${policy.badgeName}"`,
  );
  check(
    "徽标不再是占位样式（无 policy-pack-none）",
    typeof policy.badgeClass === "string" && !(policy.badgeClass as string).includes("policy-pack-none"),
    `class="${policy.badgeClass}"`,
  );
  check("没有回落提示小字（fellBackToMinimal=false）", policy.fallbackText === null, `fallback="${policy.fallbackText}"`);

  mkdirSync(LOGS_DIR, { recursive: true });
  const policyShot = await screenshot("r1-policy-badge.png");
  check("策略徽标截图写入 docs/logs/", policyShot.length > 0, policyShot);

  // —— blocked 终态（§9.6）：经真实 EventBus → hub:event 通道注入 ——
  // 与 SessionManager.markBlocked → onSessionChange → publishSessionRec → bus.emit 同一条路。
  // 起点数据是合成的，但事件从 bus 之后走的全是真实通道；这里验收的是渲染进程的呈现。
  const mkSession = (id: string, status: SessionView["status"]): SessionView => ({
    id,
    taskId: currentTaskId,
    agent: "opencode",
    role: "lead",
    tier: "guarded",
    status,
    acpSession: null,
    pid: null,
    model: null,
    startedAt: Date.now(),
    endedAt: status === "blocked" || status === "failed" || status === "stopped" ? Date.now() : null,
  });
  bus!.emit({ type: "session.upsert", session: mkSession("s-blocked-1", "blocked") });
  bus!.emit({ type: "session.upsert", session: mkSession("s-failed-1", "failed") });
  bus!.emit({ type: "session.upsert", session: mkSession("s-stopped-1", "stopped") });
  bus!.emit({ type: "session.upsert", session: mkSession("s-running-1", "running") });

  const drew = await pollUntil(`document.querySelectorAll(".session-item.session-blocked").length >= 1`, 5000, 100);
  await sleep(250);
  const b = await evalJs<Record<string, unknown>>(BLOCKED_PROBE_JS);

  check("blocked 会话经事件通道画进左栏", drew && (b.blockedCards as number) === 1, `cards=${b.blockedCards}`);
  check(
    "blocked 文案是「被策略切断」（不是 raw blocked / 不是崩溃）",
    (b.blockedText as string) === "被策略切断",
    `blocked="${b.blockedText}"`,
  );
  check(
    "blocked 卡片带策略切断说明（title）",
    typeof b.blockedTitle === "string" && (b.blockedTitle as string).includes("策略"),
    `title="${b.blockedTitle}"`,
  );
  check("failed 文案是「崩溃」", (b.failedText as string) === "崩溃", `failed="${b.failedText}"`);
  check("stopped 文案是「已停止」", (b.stoppedText as string) === "已停止", `stopped="${b.stoppedText}"`);
  check("running 文案是「运行中」", (b.runningText as string) === "运行中", `running="${b.runningText}"`);
  check(
    "blocked / failed / stopped 三终态文案互不相同",
    (b.blockedText as string) !== (b.failedText as string) &&
      (b.blockedText as string) !== (b.stoppedText as string) &&
      (b.failedText as string) !== (b.stoppedText as string),
    `blocked="${b.blockedText}" failed="${b.failedText}" stopped="${b.stoppedText}"`,
  );
  // 视觉区分：blocked 卡片有红边框（策略切断），failed 卡片没有 —— 不会画得像崩溃。
  check(
    "blocked 卡片红边框、failed 卡片无红边框（视觉上不混同）",
    (b.blockedBorder as string) === "rgb(218, 54, 51)" && (b.failedBorder as string) !== "rgb(218, 54, 51)",
    `blockedBorder=${b.blockedBorder} failedBorder=${b.failedBorder}`,
  );
  check(
    "中栏窗格也带 pane-blocked 且状态文案正确",
    (b.blockedPaneCount as number) >= 1 && (b.blockedPaneStatus as string) === "被策略切断",
    `panes=${b.blockedPaneCount} status="${b.blockedPaneStatus}"`,
  );
  check("没有把 null/undefined 打成 undefined 字面量", b.undefinedLeak === false);

  const blockedShot = await screenshot("r1-blocked.png");
  check("blocked 终态截图写入 docs/logs/", blockedShot.length > 0, blockedShot);

  // —— §9.6 补充（R9 回归）：blocked 中途到达（running → blocked 同会话转换）——
  // 对应 Lane A 的 L-4 修复：prompt() 在 await client.prompt 之后不再无条件落 idle，
  // 若中途 markBlocked 已把会话切成 blocked（终态），就保留 blocked、不覆盖回 idle。
  // 渲染层要保证：同一会话先 running 后 blocked 的事件序列（正是真实拒绝链的事件形态），
  // 卡片/窗格最终停在「被策略切断」，且达到 blocked 之后从未再闪「空闲/运行中」（不回退）。
  bus!.emit({ type: "session.upsert", session: mkSession("s-midturn-1", "running") });
  const ranRunning = await pollUntil(
    `document.querySelector('.session-item[data-id="s-midturn-1"].session-running') !== null`,
    5000,
    100,
  );
  check("中途 blocked 前置：同会话先以 running 画出来", ranRunning);

  const sampleOne = `(() => {
    const li = document.querySelector('.session-item[data-id="s-midturn-1"]');
    if (!li) return null;
    const badge = li.querySelector('.status-blocked, .status-idle, .status-running, .status-failed, .status-stopped');
    return badge ? (badge.textContent || "").trim() : null;
  })()`;
  const samples: string[] = [];
  let sampling = true;
  void (async () => {
    while (sampling) {
      try {
        const t = (await win!.webContents.executeJavaScript(sampleOne, true)) as string | null;
        if (t) samples.push(t);
      } catch {
        /* 页面暂不可用，跳过这一拍 */
      }
      await sleep(12);
    }
  })();
  await sleep(60);
  bus!.emit({ type: "session.upsert", session: mkSession("s-midturn-1", "blocked") });
  await sleep(700);
  sampling = false;
  await sleep(80);

  const midturn = await evalJs<Record<string, unknown>>(`(() => {
    const li = document.querySelector('.session-item[data-id="s-midturn-1"]');
    const badge = li ? li.querySelector('.status-blocked, .status-idle, .status-running, .status-failed, .status-stopped') : null;
    const pane = document.querySelector('.pane[data-session="s-midturn-1"]');
    const paneBadge = pane ? pane.querySelector('.pane-status') : null;
    return {
      cls: li ? li.className : null,
      text: badge ? (badge.textContent || "").trim() : null,
      paneCls: pane ? pane.className : null,
      paneText: paneBadge ? (paneBadge.textContent || "").trim() : null,
    };
  })()`);

  const firstBlockedIdx = samples.indexOf("被策略切断");
  const afterBlocked = firstBlockedIdx >= 0 ? samples.slice(firstBlockedIdx) : [];
  const regressedAfterBlocked = afterBlocked.some((t) => t === "空闲" || t === "运行中");
  check(
    "中途 blocked：卡片最终停在「被策略切断」",
    typeof midturn.cls === "string" && midturn.cls.includes("session-blocked") && midturn.text === "被策略切断",
    `cls=${midturn.cls} text=${midturn.text}`,
  );
  check(
    "中途 blocked：窗格转成 pane-blocked 且状态文案正确（running→blocked 转换路径）",
    typeof midturn.paneCls === "string" && midturn.paneCls.includes("pane-blocked") && midturn.paneText === "被策略切断",
    `paneCls=${midturn.paneCls} paneText=${midturn.paneText}`,
  );
  check(
    "中途 blocked：达到「被策略切断」之后从未再闪「空闲/运行中」（不回退）",
    firstBlockedIdx >= 0 && !regressedAfterBlocked,
    `samples=${samples.length} firstBlocked@${firstBlockedIdx} after=[${afterBlocked.join(",")}]`,
  );

  await finish(policyShot, blockedShot, {
    policyProbe: policy,
    blockedProbe: b,
    midturnProbe: midturn,
    midturnSamples: samples,
  });
}

async function finish(policyShot: string, blockedShot: string, extra: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    bridge: "real (window.bumimang via preload.cjs → ipcMain → HubService)",
    scheme: `${RENDERER_SCHEME}://./renderer.html`,
    screenshots: { policy: policyShot, blocked: blockedShot },
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "r1-verify.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== R1-VERIFY · 策略徽标 + blocked 终态 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n策略徽标截图：${policyShot}\n`);
  process.stdout.write(`blocked 截图：${blockedShot}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (loadFailures.length > 0) process.stdout.write(`\nloadFailures: ${JSON.stringify(loadFailures)}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);

  await cleanup();
  app.exit(pass ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    const hub = await bootstrap();
    registerIpc(hub);
    await createWindow();
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

// 兜底：任何情况下 90 秒内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（90s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "r1-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  void cleanup().then(() => app.exit(9));
}, 90000);
