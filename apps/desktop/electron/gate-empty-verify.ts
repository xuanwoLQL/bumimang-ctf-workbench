/**
 * Lane B · GATE-INPUT-STARVED 空状态与安静提示验收（受控快照 + 真实桥）。
 *
 * 背景（docs/done/GATE-INPUT-STARVED.md）：真实 opencode 在默认配置下从不请求授权，
 * 闸门「已武装但上游没水」。于是「审批面板为空」不再是「一切正常」——它要么是
 * 「还没出现需要审批的动作」，要么是「该 agent 根本不请求授权」。本轮要验收两点：
 *
 *   1. 审批面板空状态：不再只写一句「暂无待审批」，而是
 *      - 亮出当前规则包（snapshot.policy，让用户看到闸门确实已加载）；
 *      - 老实交代两种可能（没风险 vs agent 不请求授权）。
 *   2. 会话窗格安静提示：running + 0 审批 + 0 读黑板、且跑过阈值（30s）时，
 *      窗格底部显示一句平静、事实性的提示；否则保持沉默。
 *
 * 做法同 blocked-hostile-verify：ipcMain.handle 返回受控合成快照，走 preload →
 * window.bumimang → ipcRenderer 的真实路径。**不 import、不修改 src/main**；
 * 不碰 packages/shared-protocol/events.ts（冻结，只读）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/gate-empty-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|GATE|shot"
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

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-gate-empty"));
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

const POLICY_NAME = "policy-engine(比赛合规包)";

/** 合成快照：4 个 running 会话，覆盖安静提示的全部边界条件。 */
function snapshot(): HubSnapshot {
  const now = Date.now();
  const mkSession = (
    id: string,
    opts: { startedAt: number; boardReads?: number },
  ): HubSnapshot["sessions"][number] => ({
    id,
    taskId: "task-gate",
    agent: "opencode",
    role: "lead",
    tier: "guarded",
    status: "running",
    acpSession: null,
    pid: null,
    model: null,
    startedAt: opts.startedAt,
    endedAt: null,
  });

  return {
    task: null,
    sessions: [
      // 跑了 60s、0 审批、0 读黑板 → 应该给安静提示
      mkSession("s-old-quiet", { startedAt: now - 60_000 }),
      // 刚跑 5s → 未达阈值，不给提示
      mkSession("s-recent", { startedAt: now - 5_000 }),
      // 跑了 60s 但读过黑板 → 不给提示
      mkSession("s-reads-board", { startedAt: now - 60_000, boardReads: 2 }),
      // 跑了 60s 但问过授权（有一条已决审批）→ 不给提示
      mkSession("s-has-approval", { startedAt: now - 60_000 }),
    ],
    approvals: [
      {
        id: "ap-decided-1",
        taskId: "task-gate",
        sessionId: "s-has-approval",
        action: "session/request_permission",
        command: "dir",
        target: "工作目录内",
        intentSummary: null,
        rule: null,
        risk: "low",
        status: "approved",
        decidedBy: "human",
        sameKindCount: 1,
        createdAt: now - 30_000,
        decidedAt: now - 20_000,
      },
    ],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {
      "s-reads-board": { toolCalls: 3, boardReads: 2, syncLag: 0 },
    },
    agents: [{ id: "opencode", title: "opencode", installed: true, installHint: "", maturity: "稳定" }],
    policy: { packId: "competition", name: POLICY_NAME, fellBackToMinimal: false },
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

/** 审批面板空状态 + 各会话安静提示的 DOM 探针。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => q(s) ? (q(s).textContent || "").trim() : null;
  const quietOf = (id) => {
    const pane = q('.pane[data-session="' + id + '"]');
    const hint = pane ? pane.querySelector(".pane-quiet") : null;
    return hint
      ? { on: hint.classList.contains("pane-quiet-on"), text: (hint.textContent || "").trim() }
      : null;
  };
  const reasons = q(".ap-empty-reasons");
  return {
    approvalEmptyTitle: txt(".ap-empty-title"),
    gateName: txt(".ap-empty-gate-name"),
    gateFallback: txt(".ap-empty-gate-fallback"),
    reasonLead: reasons ? (reasons.querySelector(".ap-empty-reason-lead")?.textContent || "").trim() : null,
    reasonTexts: reasons ? Array.from(reasons.querySelectorAll(".ap-empty-reason")).map((n) => (n.textContent || "").trim()) : [],
    quietOld: quietOf("s-old-quiet"),
    quietRecent: quietOf("s-recent"),
    quietReadsBoard: quietOf("s-reads-board"),
    quietHasApproval: quietOf("s-has-approval"),
    panes: document.querySelectorAll(".pane").length,
    bodyText: document.body.textContent || "",
  };
})()`;

async function runVerify(): Promise<void> {
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelector(".ap-empty-title") !== null &&
             document.querySelectorAll(".pane").length === 4;
    })()`,
    12000,
    100,
  );
  check("真实桥 + 三栏 + 4 窗格 + 审批空状态在 12s 内就绪", ready);

  const p = await evalJs<Record<string, unknown>>(PROBE_JS);

  // —— 审批面板空状态 ——
  check("审批空状态标题仍是「暂无待审批」", (p.approvalEmptyTitle as string) === "暂无待审批", `title="${p.approvalEmptyTitle}"`);
  check(
    "空状态亮出当前规则包（闸门确实已加载）",
    (p.gateName as string) === POLICY_NAME,
    `gate="${p.gateName}"`,
  );
  check("规则包未回落 → 无「已回落最小安全集」小字", p.gateFallback === null, `fallback="${p.gateFallback}"`);
  check(
    "空状态交代了两种可能（引导句存在）",
    typeof p.reasonLead === "string" && (p.reasonLead as string).length > 0,
    `lead="${p.reasonLead}"`,
  );
  const reasons = (p.reasonTexts as string[]) || [];
  check("两种可能都有（① 还没出现关键动作）", reasons.some((r) => r.includes("还没出现需要审批的关键动作")), `reasons=${JSON.stringify(reasons)}`);
  check("两种可能都有（② agent 默认不请求授权）", reasons.some((r) => r.includes("不请求授权")), `reasons=${JSON.stringify(reasons)}`);
  check("空状态没有把「空」说成「一切正常」", !(p.bodyText as string).includes("一切正常，"), "body 未出现误导读法");

  // —— 会话安静提示 ——
  const quietOld = p.quietOld as { on: boolean; text: string } | null;
  check(
    "跑了 60s + 0 审批 + 0 读黑板 → 窗格出现安静提示",
    quietOld !== null && quietOld.on === true && quietOld.text.includes("尚无审批请求、未读黑板"),
    JSON.stringify(quietOld),
  );
  check(
    "提示是平静事实性的（点名「可能…不请求授权」）",
    quietOld !== null && quietOld.text.includes("不请求授权"),
    quietOld ? quietOld.text : "null",
  );
  const quietRecent = p.quietRecent as { on: boolean; text: string } | null;
  check("刚启动 5s（未达阈值）→ 不给提示", quietRecent === null || quietRecent.on === false, JSON.stringify(quietRecent));
  const quietReadsBoard = p.quietReadsBoard as { on: boolean; text: string } | null;
  check("读过黑板 → 不给提示", quietReadsBoard === null || quietReadsBoard.on === false, JSON.stringify(quietReadsBoard));
  const quietHasApproval = p.quietHasApproval as { on: boolean; text: string } | null;
  check("问过授权（有已决审批）→ 不给提示", quietHasApproval === null || quietHasApproval.on === false, JSON.stringify(quietHasApproval));

  // —— 崩溃 / 泄漏检测 ——
  check("渲染进程没崩（render-process-gone 为空）", rendererGone === null, `gone=${rendererGone}`);
  const consoleErrors = consoleLogs.filter((c) => c.level === "error");
  check(
    "渲染进程无未捕获异常（console error 为空）",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).map((c) => c.message).join(" | "),
  );
  check("没有把 null/undefined 打成 undefined 字面量", !(p.bodyText as string).includes("undefined"));

  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await screenshot("gate-empty.png");
  check("空状态 + 安静提示截图写入 docs/logs/", shot.length > 0, shot);

  await finish(shot, p);
}

async function finish(shot: string, probe: Record<string, unknown>): Promise<void> {
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
    assertions,
    consoleLogs,
    loadFailures,
    rendererGone,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "gate-empty-verify.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== GATE-EMPTY-VERIFY · 空状态诚实化 + 会话安静提示 ==\n\n");
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
    path.join(LOGS_DIR, "gate-empty-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 90000);
