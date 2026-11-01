/**
 * Lane B · 审批面板「真实形状」渲染验证（不进 mock 旧形状，也不 spawn 真 agent）。
 *
 * 任务 1 的可运行验收：mock 快照里的审批已经是 Lane A 队列会产出的真实形状
 * （action=session/request_permission、命令/目标/意图常为 null、有已决项、
 * sameKindCount>1）。本入口在真实 Chromium 窗口里渲染它们，并对审批面板 DOM 做断言：
 *   - 待批按风险排序（blocked/high 在前），高危长命令完整呈现（word-break）
 *   - command/target/intentSummary = null 时显示占位而不是崩掉 / 显示 undefined
 *   - 已决项折叠在「最近已决」区，只读、带状态徽标、无放行/拒绝按钮
 *   - sameKindCount > 1 显示退避「重复」提示
 *   - 左栏「引擎可用 N · 未安装 M」摘要（扇出按钮之上）
 * 不加载 preload → resolveHub() 回落到进程内 mock（transports 是 mock，ApprovalView 是真实形状）。
 *
 * 运行（Windows，stdout 必须用管道不能 `>` 重定向）：
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/approval-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|approval-verify\]|RENDER"
 */
import { app, BrowserWindow, protocol } from "electron";
import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-approval"));
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

const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
let rendererGone: string | null = null;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(win: BrowserWindow, cond: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await win.webContents.executeJavaScript(cond, true)) as boolean) return true;
    } catch {
      /* 页面未就绪 */
    }
    await sleep(intervalMs);
  }
  return false;
}

function run(): void {
  registerRendererProtocol();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#f6f8fa",
    title: "不迷茫 · 审批面板验证",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { level?: string | number; message?: string } | undefined;
    const legacyMessage = args[2] as string | undefined;
    const message = typeof ev?.message === "string" ? ev.message : (legacyMessage ?? String(args[2] ?? ""));
    const level = ev?.level ?? args[1] ?? "log";
    consoleLogs.push({ level: String(level), message });
  });
  win.webContents.on("did-fail-load", (_e: unknown, code: number, desc: string, url: string) => {
    loadFailures.push({ code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e: unknown, details: { reason: string }) => {
    rendererGone = details.reason;
  });

  void (async () => {
    try {
      await win.loadURL(`${RENDERER_SCHEME}://./renderer.html`);

      const ready = await pollUntil(
        win,
        `document.querySelectorAll(".ap-card").length >= 5`,
        10000,
        100,
      );
      check("审批面板在 10s 内画出 ≥5 张卡片（4 待批 + 1 已决）", ready);

      const probe = (await win.webContents.executeJavaScript(PROBE_JS, true)) as Record<string, unknown>;

      // —— 待批 / 已决分区 ——
      check("待批区 4 条", probe.pendingCards === 4, `pending=${probe.pendingCards}`);
      check("已决区 1 条", probe.decidedCards === 1, `decided=${probe.decidedCards}`);
      check("「最近已决」折叠区标题存在", probe.decidedHeader === true, `header="${probe.decidedHeaderText}"`);

      // —— 风险排序（blocked/high 在前）——
      const risks = (probe.pendingRiskOrder as string[]) ?? [];
      check("待批按风险排序（blocked/high 在前）", risks[0] === "blocked" && risks[1] === "high", `order=${risks.join(",")}`);

      // —— 高危 + 长命令 ——
      check("高危长命令完整呈现（含 mimikatz，无截断）", probe.hasLongCommand === true, `len=${probe.longCommandLen}`);
      check("长命令卡带 word-break 换行类", probe.longCommandBreaks === true);

      // —— null 字段不破 ——
      check("command=null 显示占位「（未提供命令全文）」", probe.nullCommandPlaceholder === true, `text="${probe.nullCommandText}"`);
      check("target=null 显示「目标：—」", probe.nullTargetCount === 1, `count=${probe.nullTargetCount}`);
      check("intentSummary=null 显示「暂无自述意图」", probe.nullIntentCount === 1, `count=${probe.nullIntentCount}`);
      check("渲染进程没有把 null 打成 undefined", probe.undefinedLeak === false);

      // —— sameKindCount > 1 退避 ——
      check("sameKindCount>1 显示退避「重复」提示", probe.repeatCount >= 1, `count=${probe.repeatCount} text="${probe.repeatText}"`);

      // —— 权限增强：一键放行的两个范围入口 ——
      const acts = (probe.pendingActs as string[][]) ?? [];
      const expectedActs = ["approve", "approve-session", "approve-agent", "deny"];
      check(
        "每张待批卡都有 放行 / 本会话始终允许 / 对该 agent 永久允许 / 拒绝 四个入口",
        acts.length === 4 && acts.every((a) => expectedActs.every((x) => a.includes(x))),
        JSON.stringify(acts),
      );
      const labels = (probe.pendingRememberLabels as Array<[string | null, string | null]>) ?? [];
      check(
        "两个记住选项文案明确区分「本会话」与「该 agent 永久」",
        labels.length === 4 &&
          labels.every(([s, a]) => s === "本会话始终允许" && a === "对该 agent 永久允许"),
        JSON.stringify(labels),
      );

      // —— 已决项只读 ——
      check("已决项带状态徽标「已放行」", probe.decidedStatusText === "已放行", `text="${probe.decidedStatusText}"`);
      check("已决项没有放行/拒绝按钮（只读）", probe.decidedActionButtons === 0, `buttons=${probe.decidedActionButtons}`);

      // —— 左栏引擎可用性摘要 ——
      // T14 之后 dsh 已接入（本机注册表命中），四家全可用；R15 修过 cold-start，这里同步。
      check("左栏「引擎可用 N · 未安装 M」摘要", probe.agentsSummaryText === "引擎可用 4 · 未安装 0", `text="${probe.agentsSummaryText}"`);

      // —— 截图证据 ——
      await sleep(400); // 等首帧真正合成，避免 capturePage 抓到未绘制的空帧
      mkdirSync(LOGS_DIR, { recursive: true });
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      const pngPath = path.join(LOGS_DIR, "approval-verify.png");
      writeFileSync(pngPath, png);
      writeFileSync(pngPath.replace(/\.png$/, ".jpg"), img.toJPEG(82));
      check("截图写入成功", png.length > 0 && !img.isEmpty(), `${pngPath} (${png.length} bytes)`);

      const rendererErrors = consoleLogs.filter((c) => c.level === "error");
      check("渲染进程无 console.error", rendererErrors.length === 0, `errors=${rendererErrors.length}`);

      const pass = assertions.every((a) => a.pass);
      const evidence = {
        generatedAt: new Date().toISOString(),
        electron: process.versions.electron,
        node: process.versions.node,
        bridge: "mock transport（ApprovalView 为真实形状）",
        scheme: `${RENDERER_SCHEME}://./renderer.html`,
        assertions,
        domProbe: probe,
        consoleLogs,
        loadFailures,
        rendererGone,
        screenshot: pngPath,
        pass,
      };
      writeFileSync(path.join(LOGS_DIR, "approval-verify.json"), JSON.stringify(evidence, null, 2));

      process.stdout.write("\n== APPROVAL-VERIFY · 审批面板真实形状 ==\n\n");
      for (const a of assertions) process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  — " + a.detail : ""}\n`);
      process.stdout.write(`\n截图：${pngPath}\n证据：${path.join(LOGS_DIR, "approval-verify.json")}\n`);
      const failed = assertions.filter((a) => !a.pass);
      process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);
      app.exit(pass ? 0 : 1);
    } catch (err) {
      process.stdout.write(`[approval-verify] 异常：${(err as Error).stack ?? String(err)}\n`);
      app.exit(2);
    }
  })();
}

/** 在渲染进程里跑的 DOM 探针：返回可序列化的审批面板事实。 */
const PROBE_JS = `(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const q = (s) => document.querySelector(s);
  const cards = qa(".ap-card");
  const pending = qa(".ap-card.ap-pending");
  const decided = qa(".ap-card.ap-decided");
  const pendingRiskOrder = pending.map((c) => {
    const found = ["blocked", "high", "medium", "low"].find((r) => c.classList.contains("ap-" + r));
    return found || null;
  });
  const long = cards.find((c) => (c.querySelector(".ap-command")?.textContent || "").includes("mimikatz"));
  const repeat = qa(".ap-history.ap-repeat");
  return {
    totalCards: cards.length,
    pendingCards: pending.length,
    decidedCards: decided.length,
    decidedHeader: !!q(".ap-decided-header"),
    decidedHeaderText: q(".ap-decided-header") ? q(".ap-decided-header").textContent.trim() : null,
    pendingRiskOrder,
    hasLongCommand: !!long,
    longCommandLen: long ? (long.querySelector(".ap-command").textContent || "").length : 0,
    longCommandBreaks: !!long && getComputedStyle(long.querySelector(".ap-command")).wordBreak === "break-all",
    nullCommandPlaceholder: qa(".ap-command-empty").some((n) => (n.textContent || "").includes("未提供命令全文")),
    nullCommandText: q(".ap-command-empty") ? q(".ap-command-empty").textContent.trim() : null,
    nullTargetCount: qa(".ap-target").filter((n) => (n.textContent || "").includes("目标：—")).length,
    nullIntentCount: qa(".ap-intent-empty").filter((n) => (n.textContent || "").includes("暂无自述意图")).length,
    undefinedLeak: (document.body.textContent || "").includes("undefined"),
    repeatCount: repeat.length,
    repeatText: repeat.length ? repeat[0].textContent.trim() : null,
    decidedStatusText: q(".ap-card.ap-decided .ap-status") ? q(".ap-card.ap-decided .ap-status").textContent.trim() : null,
    decidedActionButtons: qa(".ap-card.ap-decided button").length,
    pendingActs: pending.map((c) => Array.from(c.querySelectorAll("button[data-act]")).map((b) => b.getAttribute("data-act"))),
    pendingRememberLabels: pending.map((c) => {
      const s = c.querySelector('[data-act="approve-session"]');
      const a = c.querySelector('[data-act="approve-agent"]');
      return [s ? s.textContent.trim() : null, a ? a.textContent.trim() : null];
    }),
    agentsSummaryText: q(".agents-summary") ? q(".agents-summary").textContent.trim() : null,
  };
})()`;

app.whenReady().then(run);

setTimeout(() => {
  process.stdout.write("[approval-verify] 硬超时退出\n");
  app.exit(3);
}, 60000);
