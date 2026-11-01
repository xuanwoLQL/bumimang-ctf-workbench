/**
 * Lane B · R-5 档位不对称（tier asymmetry）验收 + 截图。
 *
 * 背景（docs/BLOCKED.md R-5）：`guarded` / `autonomous` 这个档位在各家 agent 上语义
 * 不同 —— 对 claude / opencode，档位只决定「问了之后是否转人工」；对 codex / dsh，
 * 档位决定沙箱和它**问不问**（codex guarded → workspace-write 越界才问，autonomous →
 * 默认自动复核；dsh guarded → read-only 会问，autonomous → workspace-write 不问）。
 * guarded 档的审批面板不会永远空，这是本验收要画出来的。
 *
 * 本轮验收两处渲染层的补丁（都在 src/renderer，不碰 src/main，不碰冻结契约）：
 *   1. 扇出弹窗：档位选项旁一句随选中 agent 变的差异说明（gate.tierNoteFor）；
 *   2. 会话卡：每个会话显示「闸门是否真的武装」徽标（gate.gateBadge，由 agent + tier 推导）。
 *
 * 做法同 gate-empty-verify：ipcMain.handle 返回受控合成快照，走 preload →
 * window.bumimang → ipcRenderer 的真实路径。合成的 agents 与 detect.ts 现状一致
 * （四家都已是 requests_by_default；档位差异由 gate.ts 从 agent + tier 现算：
 * codex 两档都可能问，dsh 只有 guarded 问）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/tier-asymmetry-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|verify\]|TIER|shot"
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

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-tier-asym"));
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

/** 合成快照：6 个会话覆盖 (agent × tier) 的闸门武装组合。 */
function snapshot(): HubSnapshot {
  const now = Date.now();
  const mkSession = (
    id: string,
    agent: string,
    tier: "guarded" | "autonomous",
  ): HubSnapshot["sessions"][number] => ({
    id,
    taskId: "task-tier",
    agent,
    role: "lead",
    tier,
    status: "running",
    acpSession: null,
    pid: null,
    model: null,
    startedAt: now - 10_000,
    endedAt: null,
  });

  return {
    task: {
      id: "task-tier",
      title: "示例任务：本地 HTML 目标",
      brief: "档位不对称验收：同一个「档位」在三家 agent 上语义不同。",
      status: "open",
      answer: null,
      solvedBy: null,
      createdAt: now - 60_000,
    },
    sessions: [
      // claude / opencode：两档都会问 → 都 armed。
      mkSession("s-claude-guarded", "claude", "guarded"),
      mkSession("s-claude-auto", "claude", "autonomous"),
      mkSession("s-opencode-auto", "opencode", "autonomous"),
      // codex：guarded 用 workspace-write（越界/联网问）；autonomous 用默认 agent
      // （自动复核，判定不安全时仍会问）→ 两档都可能产生审批卡。
      mkSession("s-codex-guarded", "codex", "guarded"),
      mkSession("s-codex-auto", "codex", "autonomous"),
      // dsh：T14 后由本应用按档注入 DSH_PERMISSION_MODE（guarded → 会问）。
      mkSession("s-dsh-guarded", "dsh", "guarded"),
    ],
    approvals: [],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {},
    agents: [
      { id: "opencode", title: "OpenCode", installed: true, installHint: "", maturity: "GA", permissionBehavior: "requests_by_default" },
      { id: "codex", title: "Codex", installed: true, installHint: "", maturity: "beta", permissionBehavior: "requests_by_default" },
      { id: "claude", title: "Claude Code", installed: true, installHint: "", maturity: "beta", permissionBehavior: "requests_by_default" },
      { id: "dsh", title: "DeepSeek Harness", installed: true, installHint: "（已装，桌面版自带 dsh CLI）", maturity: "桌面版自带 CLI", permissionBehavior: "requests_by_default" },
    ],
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

/** 读每个会话卡上的「闸门是否武装」徽标。 */
const GATES_PROBE_JS = `(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const gateOf = (id) => {
    const item = document.querySelector('.session-item[data-id="' + id + '"]');
    if (!item) return null;
    const badge = Array.from(item.querySelectorAll('.session-badges .badge')).find((b) => /gate-/.test(b.className));
    return badge ? { text: badge.textContent.trim(), cls: badge.className, title: badge.title || "" } : null;
  };
  return {
    items: qa(".session-item").length,
    gates: {
      "s-claude-guarded": gateOf("s-claude-guarded"),
      "s-claude-auto": gateOf("s-claude-auto"),
      "s-opencode-auto": gateOf("s-opencode-auto"),
      "s-codex-guarded": gateOf("s-codex-guarded"),
      "s-codex-auto": gateOf("s-codex-auto"),
      "s-dsh-guarded": gateOf("s-dsh-guarded"),
    },
  };
})()`;

/** 打开扇出弹窗，逐个选中 agent，读档位选项旁的差异说明。 */
const FANOUT_PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const plus = q(".btn-plus");
  if (!plus) return { opened: false, reason: "no-plus" };
  plus.click();
  const overlay = q(".fanout-overlay");
  if (!overlay) return { opened: false, reason: "no-overlay" };
  const selects = Array.from(overlay.querySelectorAll(".fanout-select"));
  const agentSel = selects[0];
  const noteOf = () => {
    const n = overlay.querySelector(".fanout-tier-detail");
    return n ? n.textContent.trim() : null;
  };
  const setAgent = (id) => {
    agentSel.value = id;
    agentSel.dispatchEvent(new Event("change"));
    return noteOf();
  };
  const out = {
    opened: true,
    selectCount: selects.length,
    defaultNote: noteOf(),
    hasTierDetailEl: !!overlay.querySelector(".fanout-tier-detail"),
  };
  for (const id of ["claude", "opencode", "codex"]) {
    if (Array.from(agentSel.options).some((o) => o.value === id && !o.disabled)) {
      out[id] = setAgent(id);
    }
  }
  return out;
})()`;

async function runVerify(): Promise<void> {
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelectorAll(".session-item").length === 6;
    })()`,
    12000,
    100,
  );
  check("真实桥 + 三栏 + 6 个会话卡在 12s 内就绪", ready);

  // —— 会话卡上的「闸门是否武装」徽标 ——
  const gates = await evalJs<Record<string, unknown>>(GATES_PROBE_JS);
  const g = (gates.gates as Record<string, { text: string; cls: string; title: string } | null>) ?? {};
  const expectGate = (id: string, text: string, cls: string, label: string): boolean => {
    const v = g[id];
    return v !== null && v.text === text && v.cls.includes(cls);
  };
  check("会话卡总数 = 6", gates.items === 6, `items=${gates.items}`);
  check("claude + guarded → 闸门已武装（会问）", expectGate("s-claude-guarded", "闸门已武装", "gate-armed", "claude-guarded"), JSON.stringify(g["s-claude-guarded"]));
  check("claude + autonomous → 闸门已武装（仍会问，档位只决定转人工）", expectGate("s-claude-auto", "闸门已武装", "gate-armed", "claude-auto"), JSON.stringify(g["s-claude-auto"]));
  check("opencode + autonomous → 闸门已武装（注入配置，与档位无关）", expectGate("s-opencode-auto", "闸门已武装", "gate-armed", "opencode-auto"), JSON.stringify(g["s-opencode-auto"]));
  check("codex + guarded → 闸门已武装（workspace-write，越界写会问；联网不保证）", expectGate("s-codex-guarded", "闸门已武装", "gate-armed", "codex-guarded"), JSON.stringify(g["s-codex-guarded"]));
  check("codex + autonomous → 闸门已武装（默认自动复核，仍可能问）", expectGate("s-codex-auto", "闸门已武装", "gate-armed", "codex-auto"), JSON.stringify(g["s-codex-auto"]));
  check("dsh + guarded → 闸门已武装（按档注入 read-only，会问）", expectGate("s-dsh-guarded", "闸门已武装", "gate-armed", "dsh-guarded"), JSON.stringify(g["s-dsh-guarded"]));
  check("codex autonomous 的悬停说明交代「自动复核」与联网限制", (g["s-codex-auto"]?.title ?? "").includes("自动复核") && (g["s-codex-auto"]?.title ?? "").includes("联网"), g["s-codex-auto"]?.title ?? "null");

  mkdirSync(LOGS_DIR, { recursive: true });
  const sessionsShot = await screenshot("tier-asymmetry-sessions.png");
  check("会话卡徽标截图写入 docs/logs/tier-asymmetry-sessions.png", sessionsShot.length > 0, sessionsShot);

  // —— 扇出弹窗里的档位差异说明（随选中 agent 变）——
  const fanout = await evalJs<Record<string, unknown>>(FANOUT_PROBE_JS);
  check("扇出弹窗能打开，且恰好 3 个下拉", fanout.opened === true && fanout.selectCount === 3, `opened=${fanout.opened} selects=${fanout.selectCount}`);
  check("档位选项旁有差异说明槽位（.fanout-tier-detail）", fanout.hasTierDetailEl === true);
  const claudeNote = (fanout.claude as string | null) ?? "";
  const opencodeNote = (fanout.opencode as string | null) ?? "";
  const codexNote = (fanout.codex as string | null) ?? "";
  check("选中 claude：档位说明「两档都会请求授权 + 转人工」", claudeNote.includes("两档都会请求授权") && claudeNote.includes("转人工"), claudeNote);
  check("选中 opencode：与 claude 同一条说明", opencodeNote === claudeNote && opencodeNote.includes("两档都会请求授权"), opencodeNote);
  check("选中 codex：档位说明「workspace-write / 自动复核」", codexNote.includes("workspace-write") && codexNote.includes("自动复核"), codexNote);
  check("codex 的说明与 claude/opencode 不同（不对称被说清）", codexNote !== claudeNote, `claude="${claudeNote}" codex="${codexNote}"`);

  // 打开弹窗、选中 codex（档位语义与 claude/opencode 最不同的那家），截一张。
  await evalJs(`(() => {
    const overlay = document.querySelector(".fanout-overlay");
    const agentSel = Array.from(overlay.querySelectorAll(".fanout-select"))[0];
    agentSel.value = "codex";
    agentSel.dispatchEvent(new Event("change"));
  })()`);
  await sleep(150);
  const fanoutShot = await screenshot("tier-asymmetry-fanout-codex.png");
  check("扇出弹窗 codex 档位说明截图写入 docs/logs/", fanoutShot.length > 0, fanoutShot);

  // —— 崩溃 / 泄漏检测 ——
  check("渲染进程没崩（render-process-gone 为空）", rendererGone === null, `gone=${rendererGone}`);
  const consoleErrors = consoleLogs.filter((c) => c.level === "error");
  check("渲染进程无未捕获异常（console error 为空）", consoleErrors.length === 0, consoleErrors.slice(0, 5).map((c) => c.message).join(" | "));

  const bodyText = (await evalJs<string>(`document.body.textContent || ""`)) as string;
  check("没有把 null/undefined 打成 undefined 字面量", !bodyText.includes("undefined"));

  await finish({ sessionsShot, fanoutShot, gates, fanout });
}

async function finish(evidence: Record<string, unknown>): Promise<void> {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const jsonPath = path.join(LOGS_DIR, "tier-asymmetry-verify.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        electron: process.versions.electron,
        node: process.versions.node,
        channel: HUB_CHANNELS.snapshot,
        injection: "受控合成快照经 ipcMain.handle + 真实 preload/ipcRenderer 通道",
        ...evidence,
        assertions,
        consoleLogs,
        loadFailures,
        rendererGone,
        pass,
      },
      null,
      2,
    ),
  );

  process.stdout.write("\n== TIER-ASYMMETRY-VERIFY · R-5 档位不对称 ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n会话卡截图：${evidence.sessionsShot}\n扇出弹窗截图：${evidence.fanoutShot}\n证据：${jsonPath}\n`);
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
    path.join(LOGS_DIR, "tier-asymmetry-verify.json"),
    JSON.stringify({ timeout: true, assertions, consoleLogs, loadFailures, rendererGone }, null, 2),
    "utf8",
  );
  app.exit(9);
}, 90000);
