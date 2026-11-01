/**
 * Lane B · 每会话计分卡验证 + 截图证据。
 *
 * 用「真实 IPC 通道 + 受控快照」（同 blocked-hostile-verify 的做法：ipcMain.handle
 * 返回合成快照，走 preload → window.bumimang → ipcRenderer 的真实路径），把三个
 * 活动量明显不同的会话喂给渲染进程，验证窗格头部条 + 左栏会话卡里的计分卡：
 *
 *   - 墙钟时长：running 用 startedAt→now，终态用 startedAt→endedAt（s3=30s）
 *   - 工具 / 读板 / 滞后：来自 SessionHealth（s3 无 health → 滞后「—」而非假 0）
 *   - 审批：按 ApprovalView.sessionId 归属（s1=2 / s2=3 / s3=0）
 *   - 写板：只数 board.facts + board.deadEnds 里 by===sessionId 的条数，
 *     不计入意图认领 / 租约持锁（s1 有 lease+intent，写板仍=3 而非 5）
 *
 * 截图写到 docs/logs/session-scorecard.png（+ .jpg），JSON 证据写到
 * docs/logs/scorecard-verify.json。只 import、不修改 src/main；不碰冻结契约。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/scorecard-verify.ts --no-sandbox 2>&1 |
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

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-scorecard"));
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

/** 受控快照：三个会话活动量刻意拉出差距，时间戳相对 Date.now()，让计分卡可扫读。 */
function buildSnapshot(): HubSnapshot {
  const NOW = Date.now();
  return {
    task: {
      id: "task-1",
      title: "不迷茫 · 夜间靶场：拿下 10.0.0.9",
      brief: "同一道题，三个会话并排跑：一个领跑、一个复核、一个侦察（已因策略切断终止）。",
      status: "solving",
      answer: null,
      solvedBy: null,
    },
    sessions: [
      {
        id: "s1",
        taskId: "task-1",
        agent: "claude",
        role: "lead",
        tier: "guarded",
        status: "running",
        acpSession: "acp-s1",
        pid: 8123,
        model: null,
        startedAt: NOW - 3 * 60 * 1000, // 已运行 ~3m
        endedAt: null,
      },
      {
        id: "s2",
        taskId: "task-1",
        agent: "codex",
        role: "verify",
        tier: "autonomous",
        status: "running",
        acpSession: "acp-s2",
        pid: 8124,
        model: null,
        startedAt: NOW - 90 * 1000, // 已运行 ~1m30s，但工具调用更多（87）
        endedAt: null,
      },
      {
        id: "s3",
        taskId: "task-1",
        agent: "opencode",
        role: "recon",
        tier: "autonomous",
        status: "blocked", // 策略切断终态，无 health（滞后显示「—」）
        acpSession: null,
        pid: null,
        model: null,
        startedAt: NOW - 10 * 60 * 1000,
        endedAt: NOW - 10 * 60 * 1000 + 30 * 1000, // 历时 30s
      },
    ],
    approvals: [
      { id: "ap1", taskId: "task-1", sessionId: "s1", action: "session/request_permission", command: "mimikatz", target: null, intentSummary: null, rule: "credential-actions-need-human", risk: "high", status: "pending", decidedBy: null, sameKindCount: 1, createdAt: NOW - 100_000, decidedAt: null },
      { id: "ap2", taskId: "task-1", sessionId: "s1", action: "session/request_permission", command: null, target: null, intentSummary: null, rule: null, risk: "medium", status: "pending", decidedBy: null, sameKindCount: 1, createdAt: NOW - 90_000, decidedAt: null },
      { id: "ap3", taskId: "task-1", sessionId: "s2", action: "session/request_permission", command: "nmap", target: "10.0.0.9", intentSummary: null, rule: null, risk: "low", status: "pending", decidedBy: null, sameKindCount: 1, createdAt: NOW - 80_000, decidedAt: null },
      { id: "ap4", taskId: "task-1", sessionId: "s2", action: "session/request_permission", command: "curl", target: null, intentSummary: null, rule: null, risk: "low", status: "pending", decidedBy: null, sameKindCount: 1, createdAt: NOW - 70_000, decidedAt: null },
      { id: "ap5", taskId: "task-1", sessionId: "s2", action: "session/request_permission", command: "dir", target: null, intentSummary: null, rule: null, risk: "low", status: "approved", decidedBy: "human", sameKindCount: 1, createdAt: NOW - 60_000, decidedAt: NOW - 50_000 },
    ],
    board: {
      facts: [
        { id: "f1", content: "10.0.0.9 开放 22 / 80 / 8080", status: "verified", evidence: "E2", witness: "nmap", by: "s1" },
        { id: "f2", content: "/admin 后台存在弱口令", status: "candidate", evidence: "E1", witness: null, by: "s1" },
        { id: "f3", content: "/admin 弱口令复测失败", status: "challenged", evidence: "E1", witness: null, by: "s2" },
        { id: "f4", content: "10.0.0.9 是 Windows Server 2016", status: "candidate", evidence: "E0", witness: null, by: "s3" },
      ],
      deadEnds: [
        { id: "d1", description: "/admin 弱口令不可用", scope: null, reopenWhen: null, by: "s1", createdAt: NOW - 120_000 },
        { id: "d2", description: "8080 是 CDN 反代", scope: null, reopenWhen: null, by: "s3", createdAt: NOW - 110_000 },
      ],
      // 意图认领 + 租约持锁：两者都「不是写入」，不该被计进写板数（见 scorecard.ts 口径）。
      leases: [{ resource: "target:10.0.0.9", holder: "s1", acquiredAt: NOW - 60_000, expiresAt: NOW + 60_000 }],
      intents: [{ id: "i1", description: "枚举 Web 入口", status: "claimed", claimedBy: "s1" }],
    },
    health: {
      s1: { toolCalls: 42, boardReads: 5, syncLag: 3 },
      s2: { toolCalls: 87, boardReads: 2, syncLag: 9 },
      // s3 故意不给 health：计分卡应显示「滞后 —」而不是假装 0。
    },
    agents: [
      { id: "claude", title: "Claude", installed: true, installHint: "", maturity: "稳定", permissionBehavior: "requests_by_default" },
      { id: "codex", title: "Codex", installed: true, installHint: "", maturity: "稳定", permissionBehavior: "requests_by_default" },
      { id: "opencode", title: "opencode", installed: true, installHint: "", maturity: "稳定", permissionBehavior: "requests_by_default" },
    ],
    policy: { packId: "competition", name: "京津冀决赛合规包", fellBackToMinimal: false },
  };
}

let current: HubSnapshot = buildSnapshot();

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

/** 把「窗格计分卡 / 会话卡计分卡 / 健康指标」按 data-session 抓出来。 */
const PROBE_JS = `(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const bySession = (sel) => {
    const out = {};
    for (const n of qa(sel)) out[n.dataset.session] = (n.textContent || "").trim();
    return out;
  };
  const health = {};
  for (const n of qa(".pane-health")) {
    health[n.dataset.session] = { text: (n.textContent || "").trim(), cls: n.className };
  }
  const body = document.body.textContent || "";
  return {
    panes: qa(".pane").length,
    paneScorecards: bySession(".pane-scorecard"),
    sessionScorecards: bySession(".session-scorecard"),
    health,
    sessionItems: qa(".session-item").length,
    undefinedLeak: body.includes("undefined"),
    nanLeak: body.includes("NaN"),
  };
})()`;

async function runVerify(): Promise<void> {
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll(".pane").length === 3 &&
             document.querySelectorAll(".pane-scorecard").length === 3 &&
             document.querySelectorAll(".session-scorecard").length === 3;
    })()`,
    12000,
    100,
  );
  check("真实桥 + 三窗格 + 计分卡在 12s 内就绪", ready);

  const p = await evalJs<Record<string, unknown>>(PROBE_JS);
  const pane = p.paneScorecards as Record<string, string>;
  const card = p.sessionScorecards as Record<string, string>;
  const health = p.health as Record<string, { text: string; cls: string }>;

  check("三个窗格各有一条计分卡", Object.keys(pane).length === 3, JSON.stringify(pane));
  check("三个会话卡各有一条紧凑计分卡", Object.keys(card).length === 3, JSON.stringify(card));

  // —— s1（claude / lead / guarded / running）：3m、42 工具、5 读板、3 滞后、2 审批、3 写板 ——
  const s1 = pane.s1 ?? "";
  check(
    "s1 计分卡：墙钟「已运行 3m」+ 六字段全对",
    s1.startsWith("已运行 3m") && s1.endsWith(" · 工具 42 · 读板 5 · 滞后 3 · 审批 2 · 写板 3"),
    s1,
  );

  // —— s2（codex / verify / autonomous / running）：1m30s、87 工具、滞后 9、3 审批、1 写板 ——
  const s2 = pane.s2 ?? "";
  check(
    "s2 计分卡：墙钟「已运行 1m」+ 工具 87 + 滞后 9 + 写板 1",
    s2.startsWith("已运行 1m") && s2.endsWith(" · 工具 87 · 读板 2 · 滞后 9 · 审批 3 · 写板 1"),
    s2,
  );

  // —— s3（opencode / recon / blocked）：无 health，滞后必须诚实显示「—」，不是假 0 ——
  const s3 = pane.s3 ?? "";
  check(
    "s3 计分卡：终态「历时 30s」+ 无 health 滞后「—」+ 审批 0 + 写板 2",
    s3 === "历时 30s · 工具 0 · 读板 0 · 滞后 — · 审批 0 · 写板 2",
    s3,
  );

  // —— 写板归属：意图认领 + 租约持锁不计入（s1 有 lease + intent，仍=3 而非 5）——
  check("写板只数事实+死路（s1=3，不含租约/意图）", s1.includes("写板 3") && !s1.includes("写板 5"), s1);

  // —— 左栏会话卡的紧凑计分卡（三数）——
  check("左栏 s1 紧凑卡：已运行 + 工具 42 + 写板 3", (card.s1 ?? "").startsWith("已运行 3m") && (card.s1 ?? "").endsWith(" · 工具 42 · 写板 3"), card.s1 ?? "");
  check("左栏 s3 紧凑卡：历时 30s + 写板 2", (card.s3 ?? "") === "历时 30s · 工具 0 · 写板 2", card.s3 ?? "");

  // —— 原有健康指标没被破坏（同步滞后仍带色阶）——
  check("健康指标 s1「同步 3 · tool 42」完好", health.s1?.text === "同步 3 · tool 42", health.s1?.text ?? "null");
  check("健康指标 s2 滞后 9 → 黄色档（>8）", (health.s2?.cls ?? "").includes("sync-yellow"), health.s2?.cls ?? "null");

  // —— 诚实性：没有把缺数字段打成 undefined / NaN ——
  check("渲染进程没有把 null/undefined 打成 undefined 字面量", p.undefinedLeak === false);
  check("渲染进程没有把缺数字段打成 NaN 字面量", p.nanLeak === false);

  // —— 墙钟会走：running 会话的计分卡 5s 后时长必须变化（低频计时器真的在刷新）——
  const tickBefore = ((await evalJs<Record<string, unknown>>(PROBE_JS)).paneScorecards as Record<string, string>).s1 ?? "";
  await sleep(6000); // 等一个 5s 低频计时器周期
  const tickAfter = ((await evalJs<Record<string, unknown>>(PROBE_JS)).paneScorecards as Record<string, string>).s1 ?? "";
  check(
    "墙钟真的在走（6s 后 s1 计分卡时长变化）",
    tickBefore.length > 0 && tickAfter.length > 0 && tickBefore !== tickAfter,
    `before="${tickBefore}" after="${tickAfter}"`,
  );

  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await screenshot("session-scorecard.png");
  check("截图写入 docs/logs/session-scorecard.png", shot.length > 0, shot);

  await finish(shot, { probe: p, tickBefore, tickAfter });
}

async function finish(shot: string, extra: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    channel: HUB_CHANNELS.event,
    injection: "受控合成快照经 ipcMain.handle + 真实 preload/ipcRenderer 通道",
    screenshot: shot,
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "scorecard-verify.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== SCORECARD-VERIFY · 每会话计分卡 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n截图：${shot}\n`);
  process.stdout.write(`证据：${jsonPath}\n`);
  if (loadFailures.length > 0) process.stdout.write(`\nloadFailures: ${JSON.stringify(loadFailures)}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  const consoleErrors = consoleLogs.filter((c) => c.level === "error");
  if (consoleErrors.length > 0) {
    process.stdout.write(`\n渲染进程 console.error 条数：${consoleErrors.length}\n`);
    for (const e of consoleErrors.slice(0, 5)) process.stdout.write(`  [error] ${e.message}\n`);
  }
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

// 兜底：任何情况下 60 秒内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（60s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(
    path.join(LOGS_DIR, "scorecard-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 60000);
