/**
 * Lane B · 真实窗口渲染验证入口（不是 Lane A 的 `src/main/electron/main.ts`）。
 *
 * 目的：把 T6–T10 的渲染进程从「纯逻辑 smoke」升级到「真实 Electron 窗口里
 * 真的画出来」。它做三件事：
 *   1. 注册 `bumimang://` 自定义 scheme（renderer-protocol.ts，现场剥 .ts 类型）；
 *   2. 开一个 BrowserWindow，`loadURL("bumimang://./renderer.html")`，让三栏
 *      布局在真实 Chromium 里跑起来；
 *   3. 用 `executeJavaScript` 对三栏做 DOM 断言 + `capturePage` 截图，把证据
 *      写到 `docs/logs/render-verify.{json,png}`。
 *
 * 为什么**不加载 preload**：preload 暴露的 `window.bumimang` 会走真实 IPC
 * （hub:snapshot / hub:event / hub:action），而那些 ipcMain 处理器是 Lane A 的
 * T2/T5/T11 范畴，本文件不实现。不加载 preload → `resolveHub()` 回落到进程内
 * mock，恰好能验证 Lane B 自己拥有的 UI（三栏 / 窗格 / 审批 / 台账 / 扇出）。
 * 真实桥接通后，`hub.ts` 无需改动即可切换。
 *
 * 运行：
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/render-verify.ts --no-sandbox
 */
import { app, BrowserWindow, protocol } from "electron";
import { registerRendererProtocol } from "./renderer-protocol.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEME = "bumimang";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

// 自定义 scheme 需要声明成「标准/安全」源，这样：
//  - 模块 import / fetch 走同一源（supportFetchAPI + corsEnabled）
//  - CSP 里的 'self' 能正确解析到 bumimang:// 这个源
// 必须在 app ready 之前调用。
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
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
}

const consoleLogs: Array<{ level: string; message: string }> = [];
const loadFailures: Array<{ code: number; desc: string; url: string }> = [];
let rendererGone: string | null = null;

function run(): void {
  registerRendererProtocol();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#f6f8fa",
    title: "不迷茫 · 多 agent 并行解题工作台",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 收集渲染进程的 console 输出，作为「有没有报错」的证据。
  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { level?: string | number; message?: string } | undefined;
    const legacyMessage = args[2] as string | undefined;
    const message = typeof ev?.message === "string" ? ev.message : (legacyMessage ?? String(args[2] ?? ""));
    const level = ev?.level ?? args[1] ?? "log";
    consoleLogs.push({ level: String(level), message });
  });

  win.webContents.on(
    "did-fail-load",
    (_e: unknown, code: number, desc: string, url: string) => {
      loadFailures.push({ code, desc, url });
    },
  );

  win.webContents.on("render-process-gone", (_e: unknown, details: { reason: string }) => {
    rendererGone = details.reason;
  });

  void (async () => {
    try {
      await win.loadURL(`${SCHEME}://./renderer.html`);

      // 等三栏真的画出来（最多 8 秒，每 100ms 探一次）。
      const ready = await waitFor(
        win,
        `document.readyState === "complete" &&
         document.querySelectorAll("#app > .col").length === 3 &&
         document.querySelectorAll(".session-item").length >= 3 &&
         document.querySelectorAll(".pane").length >= 3`,
        8000,
        100,
      );
      check("三栏在 8s 内出现", ready);

      // 让 mock 事件流跑几轮，窗格 body 里长出几行再截图。
      await new Promise((r) => setTimeout(r, 1200));

      const probe = await win.webContents.executeJavaScript(PROBE_JS, true);

      // —— 三栏 ——
      check("三栏容器数量 = 3", probe.colCount === 3, `classes=${probe.colClasses.join(",")}`);
      check(
        "#app 是 CSS grid 三列",
        probe.gridDisplay === "grid" && probe.colCount === 3,
        `display=${probe.gridDisplay} cols=${JSON.stringify(probe.gridTemplateColumns)}`,
      );
      check(
        "三栏水平排布（左 < 中 < 右）",
        probe.horizontalOrder === true,
        `lefts=${probe.colRects?.map((r: { x: number }) => r.x).join(",")}`,
      );
      check(
        "三栏均有非零尺寸（真的画出来）",
        probe.painted === true,
        `rects=${JSON.stringify(probe.colRects)}`,
      );

      // —— 内容 ——
      check("窗口标题正确", probe.title.includes("不迷茫"), `title=${probe.title}`);
      check("左栏任务卡渲染", (probe.taskTitle ?? "").includes("10.0.0.9"), `task=${probe.taskTitle}`);
      check("左栏会话列表 ≥3", probe.sessionItems >= 3, `sessions=${probe.sessionItems} agents=${probe.sessionAgents.join(",")}`);
      check("左栏加号按钮存在", probe.hasPlusButton === true, `text=${probe.plusText}`);
      check("中栏窗格 ≥3", probe.panes >= 3, `panes=${probe.panes} agents=${probe.paneAgents.join(",")}`);
      check("右栏审批卡 ≥4", probe.approvalCards >= 4, `cards=${probe.approvalCards} countText=${probe.approvalCountText}`);
      check("右栏台账四区", probe.boardSections === 4, `titles=${JSON.stringify(probe.boardTitles)}`);
      check("冲突事实并列高亮", probe.conflictFacts >= 1, `conflictFacts=${probe.conflictFacts}/${probe.facts}`);

      // —— 截图证据 ——
      mkdirSync(LOGS_DIR, { recursive: true });
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      const pngPath = path.join(LOGS_DIR, "render-verify.png");
      writeFileSync(pngPath, png);
      const jpg = img.toJPEG(82);
      const jpgPath = path.join(LOGS_DIR, "render-verify.jpg");
      writeFileSync(jpgPath, jpg);
      check("截图写入成功", png.length > 0 && !img.isEmpty(), `${pngPath} (${png.length} bytes, ${img.getSize().width}x${img.getSize().height}) + jpg ${jpg.length} bytes`);

      const pass = assertions.every((a) => a.pass);
      const failed = assertions.filter((a) => !a.pass);

      const evidence = {
        generatedAt: new Date().toISOString(),
        electron: process.versions.electron,
        node: process.versions.node,
        windowTitle: probe.title,
        scheme: `${SCHEME}://./renderer.html`,
        assertions,
        domProbe: probe,
        consoleLogs,
        loadFailures,
        rendererGone,
        screenshot: pngPath,
        pass,
      };
      const jsonPath = path.join(LOGS_DIR, "render-verify.json");
      writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

      console.log("\n== RENDER-VERIFY · 真实窗口三栏渲染 ==\n");
      for (const a of assertions) {
        console.log(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}`);
      }
      console.log(`\n截图：${pngPath}`);
      console.log(`证据：${jsonPath}`);
      if (loadFailures.length > 0) {
        console.log(`\nloadFailures: ${JSON.stringify(loadFailures)}`);
      }
      if (rendererGone) {
        console.log(`\nrender-process-gone: ${rendererGone}`);
      }
      const rendererErrors = consoleLogs.filter((c) => c.level === "error");
      if (rendererErrors.length > 0) {
        console.log(`\n渲染进程 console.error 条数：${rendererErrors.length}`);
        for (const e of rendererErrors.slice(0, 8)) console.log(`  [error] ${e.message}`);
      }
      console.log(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}`);
      app.exit(pass ? 0 : 1);
    } catch (err) {
      console.error("RENDER-VERIFY 异常：", err);
      app.exit(2);
    }
  })();
}

async function waitFor(
  win: BrowserWindow,
  cond: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = (await win.webContents.executeJavaScript(cond, true)) as boolean;
      if (ok) return true;
    } catch {
      // 页面还没起来时 executeJavaScript 会抛，继续等。
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 在渲染进程里跑的 DOM 探针：返回可序列化的三栏/内容事实。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const app = q("#app");
  const cols = qa("#app > .col");
  const cs = app ? getComputedStyle(app) : null;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const left = q(".col-left"), center = q(".col-center"), right = q(".col-right");
  const colRects = cols.map(rect);
  return {
    title: document.title,
    docUrl: location.href,
    htmlHead: document.documentElement ? document.documentElement.outerHTML.slice(0, 300) : null,
    readyState: document.readyState,
    colCount: cols.length,
    colClasses: cols.map((c) => c.className),
    gridDisplay: cs ? cs.display : null,
    gridTemplateColumns: cs ? cs.gridTemplateColumns : null,
    colRects,
    horizontalOrder: (() => {
      if (!left || !center || !right) return false;
      const a = left.getBoundingClientRect().left;
      const b = center.getBoundingClientRect().left;
      const c = right.getBoundingClientRect().left;
      return a < b && b < c;
    })(),
    painted: colRects.length === 3 && colRects.every((r) => r && r.w > 0 && r.h > 0),
    taskTitle: q(".task-title") ? q(".task-title").textContent : null,
    sessionItems: qa(".session-item").length,
    sessionAgents: qa(".session-agent").map((e) => e.textContent),
    panes: qa(".pane").length,
    paneAgents: qa(".pane-agent").map((e) => e.textContent),
    approvalCards: qa(".ap-card").length,
    approvalCountText: q(".ap-count") ? q(".ap-count").textContent : null,
    boardSections: qa(".board-section").length,
    boardTitles: qa(".board-title").map((e) => e.textContent),
    facts: qa(".fact").length,
    conflictFacts: qa(".fact-conflict").length,
    hasPlusButton: !!q(".btn-plus"),
    plusText: q(".btn-plus") ? q(".btn-plus").textContent.trim() : null,
  };
})()`;

app.whenReady().then(run);

// 兜底：任何情况下 60 秒内必须退出，避免挂死。
setTimeout(() => {
  console.error("RENDER-VERIFY 超时，强制退出");
  app.exit(3);
}, 60000);
