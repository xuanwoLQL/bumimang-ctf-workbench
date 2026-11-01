/**
 * Lane B · R14 · 中栏「浏览器式标签页」验收 + 截图（受控快照 + 真实桥）。
 *
 * 用户要求把中栏从「多个会话窗格并排」改成「浏览器标签页」：顶部一条标签栏
 * （每会话一个标签，agent + 角色 + 状态点 + 关闭 ×），末尾一个「+」；下方只有
 * 一个可见窗格，占满中栏剩余高度。本脚本验收的可验证事实：
 *
 *   1. 标签栏存在（.pane-tabs），N 个会话恰好 N 个标签（.pane-tab），末尾有「+」；
 *   2. 同一时刻**只有一个**窗格可见（.pane.pane-active === 1，其余 .pane-hidden），
 *      可见窗格与激活标签指向同一会话；
 *   3. 点标签切换可见窗格；
 *   4. **切换不丢历史**：给 s1 注入一条带唯一标记的 agent_message → 切到 s2 → 再切回 s1，
 *      标记与块数原样还在（窗格 DOM 只隐藏不销毁）；
 *   5. blocked 标签的状态点读「被策略切断」且复用现有语义色（红色 rgb(218,54,51)），
 *      不与 failed「崩溃」混同；
 *   6. 末尾「+」复用扇出入口（点它打开 .fanout-overlay）。
 *
 * 截图写到 docs/logs/tabs.png（含 3 个会话，标签栏 + 激活窗格的对话流都可见）。
 *
 * 只 import、不修改 src/main（Lane A 的 lane）；契约 events.ts 冻结未动。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/tabs-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|shot"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { HubSnapshot } from "../../../packages/shared-protocol/events.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-tabs"));
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
const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
let rendererGone: string | null = null;

/** 受控快照：3 个会话（s1 running / s2 running / s3 blocked），标签栏可见。 */
function buildSnapshot(): HubSnapshot {
  const NOW = Date.now();
  const mk = (
    id: string,
    agent: string,
    role: "lead" | "verify" | "recon" | "scribe",
    tier: "guarded" | "autonomous",
    status: "running" | "blocked",
  ): HubSnapshot["sessions"][number] => ({
    id,
    taskId: "task-1",
    agent,
    role,
    tier,
    status,
    acpSession: status === "running" ? `acp-${id}` : null,
    pid: status === "running" ? 8000 + id.length : null,
    model: null,
    startedAt: NOW - 60_000,
    endedAt: status === "blocked" ? NOW - 30_000 : null,
  });
  return {
    task: {
      id: "task-1",
      title: "不迷茫 · 夜间靶场：拿下 10.0.0.9",
      brief: "同一道题，三个会话用标签页切换着看。",
      status: "solving",
      answer: null,
      solvedBy: null,
      createdAt: NOW - 300_000,
    },
    sessions: [
      mk("s1", "opencode", "lead", "guarded", "running"),
      mk("s2", "codex", "verify", "autonomous", "running"),
      mk("s3", "opencode", "recon", "autonomous", "blocked"),
    ],
    approvals: [],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {
      s1: { toolCalls: 4, boardReads: 1, syncLag: 2 },
      s2: { toolCalls: 9, boardReads: 0, syncLag: 10 },
    },
    agents: [
      { id: "opencode", title: "opencode", installed: true, installHint: "", maturity: "稳定", permissionBehavior: "requests_by_default" },
      { id: "codex", title: "Codex", installed: true, installHint: "", maturity: "稳定", permissionBehavior: "requests_by_default" },
    ],
    policy: { packId: "competition", name: "京津冀决赛合规包", fellBackToMinimal: false },
  };
}

let current: HubSnapshot = buildSnapshot();

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#f6f8fa",
    title: "不迷茫",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    loadFailures.push({ code, desc, url });
  });
  win.webContents.on("console-message", (...args: unknown[]) => {
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

function sendStream(sessionId: string, update: { ts: number; kind: string; text?: string; title?: string; toolKind?: string; status?: string }): void {
  win!.webContents.send(HUB_CHANNELS.event, { type: "session.stream", sessionId, update } as never);
}

/** 标签页/窗格结构的 DOM 探针。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const rect = (s) => {
    const n = q(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const tabs = qa(".pane-tab");
  const panes = qa(".pane");
  const activePanes = qa(".pane.pane-active");
  const hiddenPanes = qa(".pane.pane-hidden");
  const activeTabs = qa(".pane-tab.pane-tab-active");
  const tabOf = (id) => tabs.find((t) => t.dataset.session === id) || null;
  const statusOf = (id) => {
    const t = tabOf(id);
    if (!t) return null;
    const st = t.querySelector(".pane-tab-status");
    if (!st) return null;
    return { text: (st.textContent || "").trim(), cls: st.className, color: getComputedStyle(st).color };
  };
  const paneOf = (id) => q('.pane[data-session="' + id + '"]');
  return {
    tabBar: !!q(".pane-tabs"),
    tabBarHidden: q(".pane-tabs") ? q(".pane-tabs").classList.contains("pane-tabs-hidden") : true,
    tabCount: tabs.length,
    closeCount: qa(".pane-tab-close").length,
    addExists: !!q(".pane-tab-add"),
    paneCount: panes.length,
    activePaneCount: activePanes.length,
    hiddenPaneCount: hiddenPanes.length,
    activeTabCount: activeTabs.length,
    activeTabSession: activeTabs[0] ? activeTabs[0].dataset.session : null,
    activePaneSession: activePanes[0] ? activePanes[0].dataset.session : null,
    tabSessions: tabs.map((t) => t.dataset.session),
    s1Status: statusOf("s1"),
    s3Status: statusOf("s3"),
    s1Blocks: (() => { const p = paneOf("s1"); return p ? p.querySelectorAll(".conv-block").length : 0; })(),
    s1ConvText: (() => { const p = paneOf("s1"); const c = p ? p.querySelector(".conv-text") : null; return c ? c.textContent : null; })(),
    centerRect: rect(".col-center"),
    stageRect: rect(".pane-stage"),
    activePaneRect: rect(".pane.pane-active"),
    undefinedLeak: (document.body.textContent || "").includes("undefined"),
  };
})()`;

async function runVerify(): Promise<void> {
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelectorAll(".pane-tab").length === 3 &&
             document.querySelectorAll(".pane").length === 3;
    })()`,
    12000,
    100,
  );
  check("真实桥 + 三栏 + 标签栏（3 标签 / 3 窗格）在 12s 内就绪", ready);

  const p0 = await evalJs<Record<string, unknown>>(PROBE_JS);

  // —— 1. 标签栏存在 + N 标签 ——
  check("标签栏存在且未隐藏", p0.tabBar === true && p0.tabBarHidden === false, `hidden=${p0.tabBarHidden}`);
  check("3 个会话恰好 3 个标签", p0.tabCount === 3, `tabs=${p0.tabCount} sessions=${JSON.stringify(p0.tabSessions)}`);
  check("每个标签都有一个关闭「×」", p0.closeCount === 3, `close=${p0.closeCount}`);
  check("标签栏末尾有「+」", p0.addExists === true);

  // —— 2. 只有一个可见窗格 ——
  check("3 个窗格都在 DOM（只隐藏不销毁）", p0.paneCount === 3, `panes=${p0.paneCount}`);
  check("同一时刻只有一个可见窗格", p0.activePaneCount === 1 && p0.hiddenPaneCount === 2, `active=${p0.activePaneCount} hidden=${p0.hiddenPaneCount}`);
  check("恰好一个激活标签", p0.activeTabCount === 1, `activeTabs=${p0.activeTabCount}`);
  check("激活标签与可见窗格指向同一会话", p0.activeTabSession === p0.activePaneSession && p0.activeTabSession === "s1", `tab=${p0.activeTabSession} pane=${p0.activePaneSession}`);

  // —— 1b. 激活窗格占满中栏剩余高度（R14 要求：不再并排挤压到 ~300px）——
  const stageRect = p0.stageRect as { h: number } | null;
  const paneRect = p0.activePaneRect as { h: number } | null;
  check(
    "激活窗格占满标签栏下方的舞台高度",
    stageRect !== null && paneRect !== null && paneRect.h >= stageRect.h - 2 && paneRect.h > 500,
    `paneH=${paneRect?.h} stageH=${stageRect?.h}（旧版并排上限 320px）`,
  );

  // —— 3. blocked 标签状态点：读「被策略切断」+ 红色 ——
  const s3 = p0.s3Status as { text: string; cls: string; color: string } | null;
  check("blocked 标签状态点读「被策略切断」", s3 !== null && s3.text === "被策略切断", JSON.stringify(s3));
  check("blocked 标签复用现有语义色（红色 rgb(218,54,51)）", s3 !== null && s3.color === "rgb(218, 54, 51)", `color=${s3?.color}`);
  check("blocked 标签带 status-blocked 类", s3 !== null && (s3.cls ?? "").includes("status-blocked"), `cls=${s3?.cls}`);
  check("running 标签状态点读「运行中」", (p0.s1Status as { text: string } | null)?.text === "运行中", JSON.stringify(p0.s1Status));

  // —— 4. 点标签切换可见窗格 ——
  const clickTab = (id: string): Promise<boolean> =>
    evalJs<boolean>(`(() => { const t = document.querySelector('.pane-tab[data-session=${JSON.stringify(id)}]'); if (!t) return false; t.click(); return true; })()`);
  check("点击 s2 标签成功派发", await clickTab("s2"));
  const p2 = await evalJs<Record<string, unknown>>(PROBE_JS);
  check("点击后可见窗格切到 s2", p2.activePaneSession === "s2" && p2.activeTabSession === "s2", `pane=${p2.activePaneSession} tab=${p2.activeTabSession}`);
  check("仍只有一个可见窗格（s1/s3 隐藏）", p2.activePaneCount === 1 && p2.hiddenPaneCount === 2, `active=${p2.activePaneCount} hidden=${p2.hiddenPaneCount}`);

  // —— 5. 切换不丢历史：s1 注入标记 → 切走 → 切回，标记仍在 ——
  sendStream("s1", { ts: Date.now(), kind: "tool_call", title: "read target/index.html", toolKind: "fs/read_text_file" });
  sendStream("s1", { ts: Date.now(), kind: "agent_message", text: "TABS-MARKER-42 端口已探明" });
  await sleep(350); // 等 80ms 节流窗口 flush
  const pMarked = await evalJs<Record<string, unknown>>(PROBE_JS);
  const markedText = (pMarked.s1ConvText as string | null) ?? "";
  const markedBlocks = (pMarked.s1Blocks as number) ?? 0;
  check("s1 注入后画出对话块（工具步 + 带标记的消息）", markedBlocks >= 2 && markedText.includes("TABS-MARKER-42"), `blocks=${markedBlocks} text="${markedText}"`);

  check("切到 s3 成功", await clickTab("s3"));
  const p3 = await evalJs<Record<string, unknown>>(PROBE_JS);
  check("可见窗格切到 s3（blocked）", p3.activePaneSession === "s3", `pane=${p3.activePaneSession}`);

  check("切回 s1 成功", await clickTab("s1"));
  const pBack = await evalJs<Record<string, unknown>>(PROBE_JS);
  const backText = (pBack.s1ConvText as string | null) ?? "";
  const backBlocks = (pBack.s1Blocks as number) ?? 0;
  check("切回 s1 后仍是同一段对话（标记还在）", pBack.activePaneSession === "s1" && backText.includes("TABS-MARKER-42"), `pane=${pBack.activePaneSession} text="${backText}"`);
  check("切回后 s1 块数没变（未重建、未丢历史）", backBlocks === markedBlocks && backBlocks >= 2, `blocks before=${markedBlocks} after=${backBlocks}`);

  // —— 5b. 窗口化渲染 / 阅读历史 / 回到最新 / 切换耗时 ——
  // 注入 220 个工具步（每步一个块），超过 CONV_WINDOW=120。
  for (let i = 0; i < 220; i++) {
    sendStream("s1", {
      ts: Date.now(),
      kind: "tool_call",
      title: `perf step ${i}`,
      toolKind: "fs/read_text_file",
      status: "completed",
    });
  }
  await sleep(500); // 等节流窗口 + 一次 flush
  const pWindow = await evalJs<{
    rendered: number;
    loadEarlierVisible: boolean;
    loadEarlierText: string;
    bodyScrollTop: number;
    bodyScrollHeight: number;
    bodyClientHeight: number;
  }>(`(() => {
    const pane = document.querySelector('.pane[data-session="s1"]');
    const body = pane?.querySelector('.pane-body');
    const earlier = pane?.querySelector('.conv-load-earlier');
    return {
      rendered: pane ? pane.querySelectorAll('.conv-block').length : -1,
      loadEarlierVisible: !!earlier && getComputedStyle(earlier).display !== 'none',
      loadEarlierText: earlier ? (earlier.textContent || '') : '',
      bodyScrollTop: body ? body.scrollTop : -1,
      bodyScrollHeight: body ? body.scrollHeight : -1,
      bodyClientHeight: body ? body.clientHeight : -1,
    };
  })()`);
  check(
    "窗口化渲染：220 个块只渲染最近 120 个（DOM 有上界）",
    pWindow.rendered === 120,
    `rendered=${pWindow.rendered}`,
  );
  check(
    "窗口前还有内容时显示「加载更早」",
    pWindow.loadEarlierVisible && pWindow.loadEarlierText.includes("加载更早"),
    `visible=${pWindow.loadEarlierVisible} text="${pWindow.loadEarlierText}"`,
  );
  check(
    "执行中默认跟随到底部（scrollTop 接近 scrollHeight）",
    pWindow.bodyScrollTop + pWindow.bodyClientHeight >= pWindow.bodyScrollHeight - 24,
    `top=${pWindow.bodyScrollTop} h=${pWindow.bodyScrollHeight} client=${pWindow.bodyClientHeight}`,
  );

  // 用户主动上滚 → 停止跟随，「回到最新」出现；新消息到达时滚动位置不动。
  await evalJs<void>(`(() => {
    const body = document.querySelector('.pane[data-session="s1"] .pane-body');
    body.scrollTop = 0;
    body.dispatchEvent(new Event('scroll'));
  })()`);
  await sleep(30);
  const beforeReadTop = await evalJs<number>(
    `document.querySelector('.pane[data-session="s1"] .pane-body').scrollTop`,
  );
  const jumpOn = await evalJs<{ on: boolean; text: string; top: number }>(`(() => {
    const pane = document.querySelector('.pane[data-session="s1"]');
    const b = pane?.querySelector('.pane-jump-latest');
    const body = pane?.querySelector('.pane-body');
    return { on: !!b && b.classList.contains('on'), text: b ? (b.textContent || '') : '', top: body ? body.scrollTop : -1 };
  })()`);
  check("用户上滚后出现「回到最新」", jumpOn.on && jumpOn.text.includes("回到最新"), JSON.stringify(jumpOn));

  for (let i = 0; i < 5; i++) {
    sendStream("s1", { ts: Date.now(), kind: "tool_call", title: `new while reading ${i}`, status: "completed" });
  }
  await sleep(400);
  const afterNew = await evalJs<{ top: number; jumpText: string; rendered: number }>(`(() => {
    const pane = document.querySelector('.pane[data-session="s1"]');
    const body = pane?.querySelector('.pane-body');
    const b = pane?.querySelector('.pane-jump-latest');
    return { top: body ? body.scrollTop : -1, jumpText: b ? (b.textContent || '') : '', rendered: pane ? pane.querySelectorAll('.conv-block').length : -1 };
  })()`);
  check(
    "阅读历史时新消息不会把用户拽回顶部/底部（滚动位置保持）",
    Math.abs(afterNew.top - beforeReadTop) <= 2,
    `before=${beforeReadTop} after=${afterNew.top}`,
  );
  check("新消息累计到「回到最新」计数", afterNew.jumpText.includes("5 条新消息"), afterNew.jumpText);

  // 点击「回到最新」→ 恢复跟随。
  await evalJs<boolean>(`(() => { const b = document.querySelector('.pane[data-session="s1"] .pane-jump-latest'); if (!b) return false; b.click(); return true; })()`);
  await sleep(50);
  const pLatest = await evalJs<{ top: number; bottom: number; on: boolean }>(`(() => {
    const pane = document.querySelector('.pane[data-session="s1"]');
    const body = pane?.querySelector('.pane-body');
    const b = pane?.querySelector('.pane-jump-latest');
    return { top: body ? body.scrollTop : -1, bottom: body ? body.scrollHeight - body.clientHeight : -1, on: !!b && b.classList.contains('on') };
  })()`);
  check("点「回到最新」后回到尾部且按钮消失", Math.abs(pLatest.top - pLatest.bottom) <= 24 && !pLatest.on, JSON.stringify(pLatest));

  // 切到 s2（轻量窗格）再切回 s1（120 块的重窗格），测量点击到切换完成的主线程耗时。
  await clickTab("s2");
  const switchMs = await evalJs<number>(`(() => {
    const t = document.querySelector('.pane-tab[data-session="s1"]');
    const t0 = performance.now();
    t.click();
    return performance.now() - t0;
  })()`);
  await sleep(30);
  const pSwitch = await evalJs<Record<string, unknown>>(PROBE_JS);
  check("切回重窗格 s1 成功", pSwitch.activePaneSession === "s1", `pane=${pSwitch.activePaneSession}`);
  check(
    "切回 120 块窗格的同步耗时 < 250ms（旧实现全量 DOM + 重挂约 500ms）",
    switchMs < 250,
    `click→switch=${switchMs.toFixed(1)}ms`,
  );

  // —— 6. 末尾「+」复用扇出入口 ——
  const plusOpened = await evalJs<boolean>(`(() => { const b = document.querySelector(".pane-tab-add"); if (!b) return false; b.click(); return !!document.querySelector(".fanout-overlay"); })()`);
  check("点标签栏「+」打开扇出弹窗（复用 agent + 角色 + 档位）", plusOpened === true);
  await evalJs<boolean>(`(() => { const c = document.querySelector(".fanout-overlay .btn-cancel"); if (c) { c.click(); return true; } return false; })()`);

  // —— 7. R20 点「×」关标签：会话从标签与窗格消失 ——
  const closeS3 = await evalJs<boolean>(
    `(() => { const t = document.querySelector('.pane-tab[data-session="s3"]'); const b = t?.querySelector('.pane-tab-close'); if (!b) return false; b.click(); return true; })()`,
  );
  check("点 s3 标签的 × 成功派发", closeS3 === true);
  await sleep(350); // 等 session.removed 折叠 + 重绘
  const pRemoved = await evalJs<Record<string, unknown>>(PROBE_JS);
  check("关闭后标签数 3 → 2", pRemoved.tabCount === 2, `tabs=${pRemoved.tabCount}`);
  check("关闭后窗格数 3 → 2（s3 窗格销毁）", pRemoved.paneCount === 2, `panes=${pRemoved.paneCount}`);
  check("s3 不在标签里", (pRemoved.tabSessions as string[]).indexOf("s3") === -1, JSON.stringify(pRemoved.tabSessions));
  check(
    "关闭非激活标签不抢焦点（激活仍是 s1）",
    pRemoved.activeTabSession === "s1" && pRemoved.activePaneSession === "s1",
    `tab=${pRemoved.activeTabSession} pane=${pRemoved.activePaneSession}`,
  );

  // —— 崩溃 / 泄漏检测 ——
  check("渲染进程没崩（render-process-gone 为空）", rendererGone === null, `gone=${rendererGone}`);
  const consoleErrors = consoleLogs.filter((c) => c.level === "error");
  check("渲染进程无未捕获异常（console error 为空）", consoleErrors.length === 0, consoleErrors.slice(0, 5).map((c) => c.message).join(" | "));
  check("没有把 null/undefined 打成 undefined 字面量", p0.undefinedLeak === false);

  // —— 截图：3 个会话 + 标签栏 + 激活窗格（s1 的对话流）——
  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await screenshot("tabs.png");
  check("截图写入 docs/logs/tabs.png", shot.length > 0, shot);

  await finish(shot, { initial: p0, afterS2: p2, afterS3: p3, afterBack: pBack });
}

async function finish(shot: string, extra: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    channel: HUB_CHANNELS.event,
    injection: "受控合成快照经 ipcMain.handle + 真实 preload/ipcRenderer 通道；session.stream 经 win.webContents.send('hub:event')",
    screenshot: shot,
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "tabs-verify.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== TABS-VERIFY · 中栏浏览器式标签页 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n截图：${shot}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (loadFailures.length > 0) process.stdout.write(`\nloadFailures: ${JSON.stringify(loadFailures)}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);

  app.exit(pass ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    ipcMain.handle(HUB_CHANNELS.snapshot, () => current);
    ipcMain.handle(HUB_CHANNELS.dispatch, async (_e, action: { type: string; sessionId?: string }) => {
      // R20：桩接上 session.remove —— 从快照撤下并推 session.removed 事件，
      // 与真实主进程行为一致，让「点 × 关标签」能在受控快照下验收。
      if (action.type === "session.remove" && action.sessionId) {
        current = { ...current, sessions: current.sessions.filter((s) => s.id !== action.sessionId) };
        win?.webContents.send(HUB_CHANNELS.event, { type: "session.removed", sessionId: action.sessionId });
      }
      return { ok: true };
    });
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

// 兜底：任何情况下 90 秒内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（90s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "tabs-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 90000);
