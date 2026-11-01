/**
 * Lane B · 渲染进程鲁棒性扫（robustness sweep）+ blocked 终态对比。
 *
 * 用「真实 IPC 通道 + 受控快照」（同 push-verify 的做法：ipcMain.handle 返回合成快照，
 * 走 preload → window.bumimang → ipcRenderer 的真实路径），喂给渲染进程一批**故意敌意、
 * 但形状仍是契约 HubSnapshot** 的输入：
 *
 *   - 全空数组（sessions/approvals/board/agents 全空、task=null、policy=null）
 *   - 可选字段 null / undefined（acpSession/pid/model/target/reopenWhen/claimedBy/…）
 *   - syncLag=999（同步健康度极端值）
 *   - sameKindCount=0（退避计数下界）
 *   - 超长字符串（任务标题 / agent 名 / 命令全文 / 自述意图 / 事实 / 资源名）
 *   - policy.fellBackToMinimal=true（回落提示小字）
 *
 * 断言：渲染进程不崩（render-process-gone 为空）、无未捕获异常（console error 为空）、
 * DOM 真的画出来且长字符串不把栏撑爆（scrollWidth 不超 clientWidth）、没有把 null/undefined
 * 打成「undefined」/「NaN」字面量。发现任何崩溃都如实报告。
 *
 * 只 import、不修改 src/main；不碰 packages/shared-protocol/events.ts（冻结）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/blocked-hostile-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|HOSTILE|shot"
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

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-hostile"));
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

const T0 = 1760300000000;
let current: HubSnapshot = emptySnapshot();

// ---------------------------------------------------------------- 敌意快照

function emptySnapshot(): HubSnapshot {
  return {
    task: null,
    sessions: [],
    approvals: [],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {},
    agents: [],
    policy: null,
  } as unknown as HubSnapshot;
}

function hostileSnapshot(): HubSnapshot {
  const LONG_TITLE = "超长任务标题·".repeat(2000); // 1.4 万字符
  const LONG_BRIEF = "超长任务简介·".repeat(2000);
  const LONG_AGENT = "超长Agent名·".repeat(600); // 约 4000 字符
  const LONG_CMD = "echo 1 && ".repeat(1500) + "mimikatz";
  const LONG_INTENT = "自述意图·".repeat(2500);
  const LONG_RESOURCE = "resource/".repeat(600);
  const LONG_FACT = "事实·".repeat(2500);

  return {
    task: {
      id: "task-h",
      title: LONG_TITLE,
      brief: LONG_BRIEF,
      status: "solving",
      answer: null,
      solvedBy: null,
    },
    sessions: [
      {
        id: "s-long",
        taskId: "task-h",
        agent: LONG_AGENT,
        role: "lead",
        tier: "guarded",
        status: "running",
        acpSession: undefined,
        pid: undefined,
        model: null,
        startedAt: T0 + 1000,
        endedAt: null,
      },
      {
        id: "s-blocked-h",
        taskId: "task-h",
        agent: "opencode",
        role: "verify",
        tier: "autonomous",
        status: "blocked",
        acpSession: null,
        pid: null,
        model: null,
        startedAt: T0 + 2000,
        endedAt: T0 + 3000,
      },
    ],
    approvals: [
      {
        id: "ap-zero",
        taskId: "task-h",
        sessionId: "s-long",
        action: "session/request_permission",
        command: null,
        target: undefined,
        intentSummary: null,
        rule: null,
        risk: "high",
        status: "pending",
        decidedBy: null,
        sameKindCount: 0, // 下界：同类首次
        createdAt: T0 + 4000,
        decidedAt: null,
      },
      {
        id: "ap-long",
        taskId: "task-h",
        sessionId: "s-long",
        action: "session/request_permission",
        command: LONG_CMD,
        target: "C:\\Users\\Public\\dump.txt",
        intentSummary: LONG_INTENT,
        rule: "credential-actions-need-human",
        risk: "medium",
        status: "pending",
        decidedBy: null,
        sameKindCount: 2,
        createdAt: T0 + 5000,
        decidedAt: null,
      },
    ],
    board: {
      facts: [{ id: "f-long", content: LONG_FACT, status: "candidate", evidence: "E0", witness: null, by: null }],
      deadEnds: [{ id: "d-long", description: LONG_FACT, scope: null, reopenWhen: undefined, by: null, createdAt: T0 + 6000 }],
      leases: [{ resource: LONG_RESOURCE, holder: "s-long", acquiredAt: T0 + 7000, expiresAt: T0 + 90000 }],
      intents: [{ id: "i-long", description: LONG_FACT, status: "open", claimedBy: null }],
    },
    health: {
      "s-long": { toolCalls: 123, boardReads: 1, syncLag: 999 },
      "s-blocked-h": { toolCalls: 5, boardReads: 5, syncLag: 0 },
    },
    agents: [
      { id: "opencode", title: "opencode", installed: true, installHint: "", maturity: "GA" },
      { id: "dsh", title: LONG_AGENT, installed: false, installHint: "pip install dsh-agent", maturity: "alpha" },
    ],
    policy: { packId: "competition", name: "比赛合规包", fellBackToMinimal: true },
  } as unknown as HubSnapshot;
}

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
    // Electron 44 的新签名是 (event, {level, message, ...})，旧签名是 (event, level, message, ...)。
    // 两种都要接住，未捕获异常会以 level="error" 出现在这里。
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

const EMPTY_PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => q(s) ? (q(s).textContent || "").trim() : null;
  return {
    taskNone: txt(".task-none"),
    sessionEmptyTitle: txt(".session-empty-title"),
    approvalEmptyTitle: txt(".ap-empty-title"),
    boardEmptyTitle: txt(".board-empty-title"),
    agentsSummary: txt(".agents-summary"),
    policyName: txt(".policy-pack-name"),
    plusPrimary: !!q(".btn-plus.btn-plus-primary"),
  };
})()`;

const FANOUT_EMPTY_JS = `(() => {
  const plus = document.querySelector(".btn-plus");
  if (!plus) return { opened: false };
  plus.click();
  const overlay = document.querySelector(".fanout-overlay");
  const selects = overlay ? Array.from(overlay.querySelectorAll(".fanout-select")) : [];
  const agentOptions = selects[0] ? Array.from(selects[0].options).map((o) => o.value) : [];
  const cancel = overlay ? overlay.querySelector(".btn-cancel") : null;
  if (cancel) cancel.click();
  return { opened: !!overlay, selectCount: selects.length, agentOptionCount: agentOptions.length };
})()`;

const HOSTILE_PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (s) => q(s) ? (q(s).textContent || "").trim() : null;
  const fits = (el) => (el ? el.scrollWidth <= el.clientWidth + 1 : true);
  const sessionAgent = q(".session-item .session-agent");
  const taskTitle = q(".task-title");
  const healthEl = q(".pane-health");
  const zeroAp = q('.ap-card[data-id="ap-zero"]');
  const zeroHistory = zeroAp ? zeroAp.querySelector(".ap-history") : null;
  const apCommand = q('.ap-card[data-id="ap-long"] .ap-command');
  const apIntent = q('.ap-card[data-id="ap-long"] .ap-intent');
  const body = document.body.textContent || "";
  return {
    sessionItems: qa(".session-item").length,
    blockedCards: qa(".session-item.session-blocked").length,
    blockedBadgeText: q(".session-item.session-blocked .status-blocked") ? q(".session-item.session-blocked .status-blocked").textContent.trim() : null,
    approvalCards: qa(".ap-card").length,
    facts: qa(".fact").length,
    deadends: qa(".deadend").length,
    intents: qa(".intent").length,
    leases: qa(".lease").length,
    policyName: txt(".policy-pack-name"),
    policyFallback: txt(".policy-pack-fallback"),
    sessionAgentFits: fits(sessionAgent),
    taskTitleFits: fits(taskTitle),
    taskTitleLen: taskTitle ? taskTitle.textContent.length : 0,
    apCommandFits: fits(apCommand),
    apIntentFits: fits(apIntent),
    healthText: healthEl ? healthEl.textContent.trim() : null,
    healthClass: healthEl ? healthEl.className : null,
    zeroHistoryText: zeroHistory ? zeroHistory.textContent.trim() : null,
    zeroIsRepeat: zeroHistory ? zeroHistory.classList.contains("ap-repeat") : false,
    undefinedLeak: body.includes("undefined"),
    nanLeak: body.includes("NaN"),
  };
})()`;

async function runVerify(): Promise<void> {
  // —— 阶段 A：全空数组 + task=null + policy=null ——
  const readyA = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3;
    })()`,
    12000,
    100,
  );
  check("空快照下三栏在 12s 内就绪", readyA);
  const empty = await evalJs<Record<string, unknown>>(EMPTY_PROBE_JS);
  check("空数组：任务显示「暂无任务」", (empty.taskNone as string) === "暂无任务", `task="${empty.taskNone}"`);
  check("空数组：会话显示「还没有会话」", (empty.sessionEmptyTitle as string) === "还没有会话", `sessions="${empty.sessionEmptyTitle}"`);
  check("空数组：审批显示「暂无待审批」", (empty.approvalEmptyTitle as string) === "暂无待审批", `approvals="${empty.approvalEmptyTitle}"`);
  check("空数组：台账显示「黑板为空」", (empty.boardEmptyTitle as string) === "黑板为空", `board="${empty.boardEmptyTitle}"`);
  check("空数组：agents 空 → 「引擎可用 0 · 未安装 0」", (empty.agentsSummary as string) === "引擎可用 0 · 未安装 0", `summary="${empty.agentsSummary}"`);
  check("policy=null → 徽标占位「—」", (empty.policyName as string) === "—", `policy="${empty.policyName}"`);
  check("空数组：加号是 primary「起第一个会话」", empty.plusPrimary === true);

  const fanout = await evalJs<Record<string, unknown>>(FANOUT_EMPTY_JS);
  check(
    "空 agents 下扇出弹窗能打开、0 个 agent 选项、不崩",
    fanout.opened === true && (fanout.selectCount as number) === 3 && (fanout.agentOptionCount as number) === 0,
    JSON.stringify(fanout),
  );

  const emptyShot = await screenshot("hostile-empty.png");
  check("空状态截图写入 docs/logs/", emptyShot.length > 0, emptyShot);

  // —— 阶段 B：敌意满配快照（重载渲染进程，重新走 snapshot 路径）——
  current = hostileSnapshot();
  win!.reload();
  const readyB = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll(".session-item").length >= 2 &&
             document.querySelectorAll(".ap-card").length >= 2;
    })()`,
    12000,
    100,
  );
  check("敌意快照下三栏 + 会话卡 + 审批卡在 12s 内就绪", readyB);

  // 顺手经事件通道再推几条敌意形状的增量（stream 可选字段全缺、health 极端值），
  // 覆盖 applyEvent / 窗格 appendBatch 路径。
  win!.webContents.send(HUB_CHANNELS.event, {
    type: "session.stream",
    sessionId: "s-long",
    update: { ts: Date.now(), kind: "tool_call" },
  });
  win!.webContents.send(HUB_CHANNELS.event, {
    type: "session.stream",
    sessionId: "s-long",
    update: { ts: Date.now(), kind: "agent_message", text: "敌意文本·".repeat(1000) },
  });
  win!.webContents.send(HUB_CHANNELS.event, {
    type: "health",
    sessionId: "s-blocked-h",
    health: { toolCalls: 7, boardReads: 0, syncLag: 999 },
  });
  await sleep(400);

  const h = await evalJs<Record<string, unknown>>(HOSTILE_PROBE_JS);

  // —— 崩溃检测 ——
  check("渲染进程没崩（render-process-gone 为空）", rendererGone === null, `gone=${rendererGone}`);
  const consoleErrors = consoleLogs.filter((c) => c.level === "error");
  check(
    "渲染进程无未捕获异常（console error 为空）",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).map((c) => c.message).join(" | "),
  );

  // —— 敌意内容真的画出来 ——
  check("敌意快照：2 张会话卡（1 running + 1 blocked）", (h.sessionItems as number) === 2, `items=${h.sessionItems}`);
  check("敌意快照：blocked 会话卡存在且文案「被策略切断」", (h.blockedCards as number) === 1 && (h.blockedBadgeText as string) === "被策略切断", `blocked=${h.blockedCards} text="${h.blockedBadgeText}"`);
  check("敌意快照：2 张审批卡", (h.approvalCards as number) === 2, `cards=${h.approvalCards}`);
  check("敌意快照：黑板四区各 1 条", (h.facts as number) === 1 && (h.deadends as number) === 1 && (h.intents as number) === 1 && (h.leases as number) === 1, `facts=${h.facts} deadends=${h.deadends} intents=${h.intents} leases=${h.leases}`);

  // —— 超长字符串不撑爆 ——
  check("超长 agent 名不撑爆左栏（scrollWidth ≤ clientWidth）", (h.sessionAgentFits as boolean) === true, `fits=${h.sessionAgentFits}`);
  check("超长任务标题不撑爆（scrollWidth ≤ clientWidth）", (h.taskTitleFits as boolean) === true, `fits=${h.taskTitleFits} len=${h.taskTitleLen}`);
  check("超长命令全文不撑爆", (h.apCommandFits as boolean) === true, `fits=${h.apCommandFits}`);
  check("超长自述意图不撑爆", (h.apIntentFits as boolean) === true, `fits=${h.apIntentFits}`);

  // —— 极端数值 ——
  check("syncLag=999 → 健康度「同步 999」且红档", (h.healthText as string) === "同步 999 · tool 123" && ((h.healthClass as string) || "").includes("sync-red"), `health="${h.healthText}" class="${h.healthClass}"`);
  check("sameKindCount=0 → 「本会话同类首次出现」且不标重复", (h.zeroHistoryText as string) === "本会话同类首次出现" && h.zeroIsRepeat === false, `text="${h.zeroHistoryText}" repeat=${h.zeroIsRepeat}`);

  // —— 回落提示 + null 不打成 undefined/NaN ——
  check("policy.fellBackToMinimal=true → 回落小字「已回落最小安全集」", (h.policyFallback as string) === "已回落最小安全集", `fallback="${h.policyFallback}"`);
  check("没有把 null/undefined 打成 undefined 字面量", h.undefinedLeak === false);
  check("没有把缺数字段打成 NaN 字面量", h.nanLeak === false);

  const hostileShot = await screenshot("hostile-filled.png");
  check("敌意快照截图写入 docs/logs/", hostileShot.length > 0, hostileShot);

  await finish(emptyShot, hostileShot, { emptyProbe: empty, fanoutProbe: fanout, hostileProbe: h });
}

async function finish(emptyShot: string, hostileShot: string, extra: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    channel: HUB_CHANNELS.event,
    injection: "受控合成快照经 ipcMain.handle + 真实 preload/ipcRenderer 通道",
    screenshots: { empty: emptyShot, hostile: hostileShot },
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    ...extra,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "blocked-hostile-verify.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== BLOCKED-HOSTILE-VERIFY · 敌意输入鲁棒性扫 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n空状态截图：${emptyShot}\n`);
  process.stdout.write(`敌意满配截图：${hostileShot}\n`);
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
    path.join(LOGS_DIR, "blocked-hostile-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 120000);
