/**
 * Lane B · R10 首次启动引导（first-run guide）验收。
 *
 * 背景（docs/HANDOVER.md §5 第 7 条）：agent 检测有「灰显 + 安装提示」，但新手没有
 * 一个地方一次性回答「开始之前该知道什么」。本轮在渲染进程加了一块 dismissible 浮层
 * （`renderer/first-run.ts`），四段话：
 *   1. 哪些引擎可用、哪些真的会产生审批（数据源 snapshot.agents[].permissionBehavior）；
 *   2. 什么会打断你（只讲实测过的事实，并明确小样本、边界未完全摸清）；
 *   3. 数据存在哪（打包态 %APPDATA%\bumimang\，开发态 .ui-run\）；
 *   4. 一行「怎么开始」（＋ 新任务 → 简报 → agent + guarded）。
 * dismissal 记在渲染进程自己的 localStorage 里（**不加契约字段、不碰主进程**）。
 *
 * 做法同 gate-empty-verify：ipcMain.handle 返回受控合成快照，走 preload →
 * window.bumimang → ipcRenderer 的真实路径。**不 import、不修改 src/main**；
 * 不碰 packages/shared-protocol/events.ts（冻结，只读类型）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/first-run-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|shot"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import type { HubSnapshot } from "../../../packages/shared-protocol/events.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

/**
 * 这条套件的前提是「首次启动」，而 dismissal 是记在 userData 的 localStorage 里的 ——
 * 上一轮跑完留下的 profile 会让引导不再出现（套件从第一条断言就红）。
 * 所以每次开跑先把自己那份 profile 清干净（T14 复跑时踩到，属套件自身的卫生问题）。
 */
const FIRST_RUN_PROFILE = path.join(REPO_ROOT, ".ui-run", "electron-profile-first-run");
rmSync(FIRST_RUN_PROFILE, { recursive: true, force: true });
app.setPath("userData", FIRST_RUN_PROFILE);
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

/**
 * 合成快照：4 家 agent，其中 dsh 故意标成**未安装** —— 这条 fixture 现在还兼职验证
 * 「没装 → 灰显 + 给安装提示」那条分支（T14 之后本机真机全是已装，真机复现不出这个分支）。
 */
function snapshot(): HubSnapshot {
  return {
    task: {
      id: "task-fr",
      title: "示例任务：本地 HTML 目标",
      brief: "工作目录中的 target/index.html 是一个内部门户页面，含 /admin 登录表单。",
      status: "solving",
      answer: null,
      solvedBy: null,
      createdAt: Date.now(),
    },
    sessions: [],
    approvals: [],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {},
    agents: [
      {
        id: "opencode",
        title: "OpenCode",
        installed: true,
        installHint: "npm i -g opencode-ai",
        maturity: "稳定",
        permissionBehavior: "requests_by_default",
      },
      {
        id: "codex",
        title: "Codex",
        installed: true,
        installHint: "npm i -g @agentclientprotocol/codex-acp",
        maturity: "稳定",
        permissionBehavior: "requests_by_default",
      },
      {
        id: "claude",
        title: "Claude Code",
        installed: true,
        installHint: "npm i -g @agentclientprotocol/claude-agent-acp",
        maturity: "稳定",
        permissionBehavior: "requests_by_default",
      },
      {
        id: "dsh",
        title: "DeepSeek Harness",
        installed: false,
        installHint: "适配器仍为 RC：npm i -g @deepseek-ai/dsh-acp",
        maturity: "RC",
        permissionBehavior: "unknown",
      },
    ],
    policy: { packId: "competition", name: "policy-engine(比赛合规包)", fellBackToMinimal: false },
  };
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

/** 首启浮层 DOM 探针：读面板标题 / 持久化键 / 四段内容。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const panel = q(".first-run-panel");
  if (!panel) return { present: false };
  const storageKey = panel.getAttribute("data-storage-key");
  let dismissedBefore = null;
  try { dismissedBefore = storageKey ? localStorage.getItem(storageKey) : null; } catch { dismissedBefore = "ERR"; }
  const sections = Array.from(panel.querySelectorAll(".first-run-section")).map((sec) => ({
    head: (sec.querySelector(".first-run-section-head")?.textContent || "").trim(),
    text: (sec.textContent || "").trim(),
  }));
  return {
    present: true,
    title: (panel.querySelector(".first-run-title")?.textContent || "").trim(),
    storageKey,
    dismissedBefore,
    producing: (panel.querySelector(".first-run-producing")?.textContent || "").trim(),
    nonproducing: (panel.querySelector(".first-run-nonproducing")?.textContent || "").trim(),
    hedge: (panel.querySelector(".first-run-hedge")?.textContent || "").trim(),
    sections,
    panelCount: document.querySelectorAll(".first-run-panel").length,
  };
})()`;

/** 点「知道了」→ 面板消失 + localStorage 记住。 */
const DISMISS_JS = `(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = q(".first-run-panel");
  if (!panel) return { ok: false, reason: "no-panel" };
  const storageKey = panel.getAttribute("data-storage-key");
  const btn = q(".first-run-dismiss");
  if (!btn) return { ok: false, reason: "no-btn" };
  btn.click();
  for (let i = 0; i < 40; i++) {
    await sleep(50);
    if (!document.querySelector(".first-run-panel")) break;
  }
  const gone = !document.querySelector(".first-run-panel");
  let stored = null;
  try { stored = storageKey ? localStorage.getItem(storageKey) : null; } catch { stored = "ERR"; }
  return { ok: gone, stored, storageKey, panelCount: document.querySelectorAll(".first-run-panel").length };
})()`;

interface ProbeResult {
  present: boolean;
  title?: string;
  storageKey?: string | null;
  dismissedBefore?: string | null;
  producing?: string;
  nonproducing?: string;
  hedge?: string;
  sections?: Array<{ head: string; text: string }>;
  panelCount?: number;
}

function sectionByHead(p: ProbeResult, headPart: string): { head: string; text: string } | undefined {
  return (p.sections ?? []).find((s) => s.head.includes(headPart));
}

async function runVerify(): Promise<void> {
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelector(".first-run-panel") !== null;
    })()`,
    12000,
    100,
  );
  check("首启：真实桥 + 三栏 + 引导浮层在 12s 内就绪", ready);

  const p = await evalJs<ProbeResult>(PROBE_JS);

  // —— 浮层出现与基本形状 ——
  check("浮层存在且只出现一块", p.present === true && p.panelCount === 1, `present=${p.present} count=${p.panelCount}`);
  check("标题是「开始之前」", p.title === "开始之前", `title="${p.title}"`);

  // —— 第 1 段：哪些引擎会产生审批（数据源 permissionBehavior）——
  const producing = p.producing ?? "";
  const nonproducing = p.nonproducing ?? "";
  check(
    "产生审批一行点名三家（OpenCode / Codex / Claude Code）",
    ["OpenCode", "Codex", "Claude Code"].every((t) => producing.includes(t)),
    producing,
  );
  check(
    "产生审批一行不含未安装的 DeepSeek Harness",
    !producing.includes("DeepSeek Harness"),
    producing,
  );
  check(
    "不会产生审批一行点名 DeepSeek Harness 并标注未安装",
    nonproducing.includes("DeepSeek Harness") && nonproducing.includes("未安装"),
    nonproducing,
  );

  // —— 第 2 段：什么会打断你（实测 + 不过度断言）——
  const interruption = sectionByHead(p, "打断")?.text ?? "";
  check(
    "打断段：写文件会问（3/3）+ echo 不问（3/3）+ 读源码/命名管道/grep 会问",
    interruption.includes("写文件") &&
      interruption.includes("3/3") &&
      interruption.includes("echo") &&
      interruption.includes("不请求") &&
      interruption.includes("读源码") &&
      interruption.includes("命名管道") &&
      interruption.includes("grep"),
    interruption,
  );
  const hedge = p.hedge ?? "";
  check("打断段：明确小样本、边界未完全摸清（不过度断言）", hedge.includes("样本") && hedge.includes("边界"), hedge);

  // —— 第 3 段：数据在哪 ——
  const dataLoc = sectionByHead(p, "数据")?.text ?? "";
  check(
    "数据段：打包态 %APPDATA%\\bumimang\\ + 开发态 .ui-run",
    dataLoc.includes("%APPDATA%") && dataLoc.includes("bumimang") && dataLoc.includes(".ui-run"),
    dataLoc,
  );

  // —— 第 4 段：怎么开始 ——
  const start = sectionByHead(p, "怎么开始")?.text ?? "";
  check("开始段：新任务 → 简报 → agent + guarded", start.includes("新任务") && start.includes("简报") && start.includes("guarded"), start);

  // —— 持久化不是契约字段，而是渲染进程 localStorage ——
  check(
    "dismissal 键是渲染层本地 localStorage 键（非契约字段）",
    typeof p.storageKey === "string" && (p.storageKey as string).startsWith("bumimang.") && (p.storageKey as string).includes("firstRun"),
    `key="${p.storageKey}"`,
  );
  check("首次启动（未 dismiss）localStorage 还没有该键", p.dismissedBefore === null, `before="${p.dismissedBefore}"`);

  // —— 截图（dismiss 之前，浮层可见）——
  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await screenshot("first-run-guide.png");
  check("引导截图写入 docs/logs/first-run-guide.png", shot.length > 0, shot);

  // —— dismiss：点「知道了」→ 面板消失 + 记住 ——
  const d = await evalJs<{ ok: boolean; stored?: string | null; storageKey?: string | null; panelCount?: number }>(DISMISS_JS);
  check("点「知道了」后浮层从 DOM 消失", d.ok === true && d.panelCount === 0, `ok=${d.ok} count=${d.panelCount}`);
  check("dismiss 记进 localStorage（值为 1）", d.stored === "1", `stored="${d.stored}" key="${d.storageKey}"`);

  // —— 重新加载：记住 dismissal，不再 nag ——
  const storageKey = p.storageKey as string;
  await win!.loadURL(`${RENDERER_SCHEME}://./renderer.html`);
  await sleep(1400); // 给 bootstrap（含 snapshot → showFirstRunGuide）充分时间
  const reloaded = await evalJs<{ stored: string | null; panelPresent: boolean; cols: number }>(
    `(async () => {
      let stored = null;
      try { stored = localStorage.getItem(${JSON.stringify(storageKey)}); } catch { stored = "ERR"; }
      return {
        stored,
        panelPresent: !!document.querySelector(".first-run-panel"),
        cols: document.querySelectorAll("#app > .col").length,
      };
    })()`,
  );
  check("重新加载后 dismissal 仍在 localStorage", reloaded.stored === "1", `stored="${reloaded.stored}"`);
  check("重新加载后引导不再出现（不 nag）", reloaded.panelPresent === false && reloaded.cols === 3, `panel=${reloaded.panelPresent} cols=${reloaded.cols}`);

  // —— 崩溃 / 泄漏检测 ——
  check("渲染进程没崩（render-process-gone 为空）", rendererGone === null, `gone=${rendererGone}`);
  const consoleErrors = consoleLogs.filter((c) => c.level === "error");
  check(
    "渲染进程无未捕获异常（console error 为空）",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).map((c) => c.message).join(" | "),
  );

  await finish(shot, p, d, reloaded);
}

async function finish(
  shot: string,
  probe: ProbeResult,
  dismiss: Record<string, unknown>,
  reloaded: Record<string, unknown>,
): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    channel: HUB_CHANNELS.snapshot,
    injection: "受控合成快照经 ipcMain.handle + 真实 preload/ipcRenderer 通道",
    screenshot: shot,
    probe,
    dismiss,
    reloaded,
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "first-run-guide.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== FIRST-RUN-VERIFY · 首次启动引导 ==\n\n");
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
    ipcMain.handle(HUB_CHANNELS.snapshot, () => snapshot());
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

// 兜底：任何情况下 90 秒内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（90s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "first-run-guide.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 90000);
