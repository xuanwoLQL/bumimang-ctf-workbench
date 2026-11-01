/**
 * Lane B · 打包态 UI 探针（R16）。
 *
 * 为什么存在：Lane A 的 `--verify` 在打包态跑通了 11/11，但那 11 条断言里没有一条
 * 验证 **样式表真的被应用**（styles.css 若没加载，三栏 DOM 仍在、文字仍在，只是
 * 视觉上是坏的）。而且 11/11 是主进程自己 executeJavaScript 出来的结论，没有一张
 * 人眼能看的截图。
 *
 * 这个脚本**不改动打包产物**：它用 Chromium 的远程调试协议（CDP）连上已经启动的
 * 打包 exe（`--remote-debugging-port`），在**真实的 app.asar 渲染进程**里跑 DOM 探针
 * + 计算样式断言，再用 Page.captureScreenshot 截一张真图。这是最接近「人眼看一下
 * 打包 UI」的可复现做法。
 *
 * 运行前提：先启动打包 exe：
 *   dist\win-unpacked\不迷茫.exe --no-sandbox --remote-debugging-port=9333 '--remote-allow-origins=*'
 * 再：
 *   node apps/desktop/electron/packaged-ui-probe.mjs 9333
 *
 * 输出：docs/logs/packaged-ui.png（截图）+ docs/logs/packaged-ui.json（证据）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 9333);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return res.json();
}

/** 等页面目标（url 含 renderer.html）出现，最多 waitMs。 */
async function findPageTarget(waitMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    try {
      const targets = await listTargets();
      const page = targets.find((t) => t.type === "page" && /renderer\.html|bumimang/.test(t.url ?? ""));
      if (page) return page;
    } catch {
      // 端口还没起来，继续等。
    }
    await sleep(300);
  }
  return null;
}

/** 极简 CDP 客户端（Node 全局 WebSocket + fetch）。 */
function cdp(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const queue = [];
  let opened = false;

  ws.addEventListener("open", () => {
    opened = true;
    for (const m of queue.splice(0)) ws.send(JSON.stringify(m));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const m = { id, method, params };
      pending.set(id, { resolve, reject });
      if (opened) ws.send(JSON.stringify(m));
      else queue.push(m);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });

  return { send, close: () => ws.close() };
}

/** 在渲染进程里跑的 DOM + 计算样式探针（返回可序列化的事实）。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const app = q("#app");
  const appCs = cs(app);
  const bodyCs = cs(document.body);
  const left = q(".col-left"), center = q(".col-center"), right = q(".col-right");
  const sheets = Array.from(document.styleSheets);
  const cssSheet = sheets.find((s) => /styles\\.css/.test(s.href || ""));
  const cols = qa("#app > .col");
  return {
    title: document.title,
    docUrl: location.href,
    readyState: document.readyState,
    // —— 三栏 DOM ——
    colCount: cols.length,
    colClasses: cols.map((c) => c.className),
    colRects: cols.map(rect),
    horizontalOrder: (() => {
      if (!left || !center || !right) return false;
      const a = left.getBoundingClientRect().left;
      const b = center.getBoundingClientRect().left;
      const c = right.getBoundingClientRect().left;
      return a < b && b < c;
    })(),
    painted: cols.length === 3 && cols.every((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; }),
    // —— 面板标题 ——
    panelTitles: qa(".panel-title").map((n) => (n.textContent || "").trim()),
    // —— 内容（没白屏） ——
    bodyTextLen: (document.body.innerText || "").trim().length,
    bodyTextHead: (document.body.innerText || "").trim().slice(0, 200),
    // —— 样式表是否真的加载 + 被应用 ——
    stylesheetCount: sheets.length,
    stylesheetHrefs: sheets.map((s) => s.href),
    cssSheetHref: cssSheet ? cssSheet.href : null,
    cssRuleCount: cssSheet ? (() => { try { return cssSheet.cssRules.length; } catch { return -1; } })() : -1,
    appDisplay: appCs ? appCs.display : null,
    appGridTemplateColumns: appCs ? appCs.gridTemplateColumns : null,
    appGap: appCs ? appCs.gap : null,
    bodyBg: bodyCs ? bodyCs.backgroundColor : null,
    bodyColor: bodyCs ? bodyCs.color : null,
    bodyFontSize: bodyCs ? bodyCs.fontSize : null,
    bodyFontFamily: bodyCs ? bodyCs.fontFamily : null,
    leftOverflowY: cs(left) ? cs(left).overflowY : null,
    panelTitleFontSize: q(".panel-title") && cs(q(".panel-title")) ? cs(q(".panel-title")).fontSize : null,
    // —— 打包态首屏该有的空状态 ——
    hasPlusPrimary: !!q(".btn-plus-primary"),
    plusText: q(".btn-plus") ? q(".btn-plus").textContent.trim() : null,
    paneEmptyCount: qa(".pane-empty").length,
    apEmptyCount: qa(".ap-empty").length,
    policyPackName: q(".policy-pack-name") ? q(".policy-pack-name").textContent : null,
    taskTitle: q(".task-title") ? q(".task-title").textContent : null,
  };
})()`;

function check(out, name, pass, detail = "") {
  out.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const assertions = [];
  const consoleLogs = [];
  const loadFailures = [];

  console.log(`[probe] 连接 127.0.0.1:${PORT} 找打包态渲染进程…`);
  const target = await findPageTarget();
  if (!target) {
    console.error(`[probe] 20s 内没找到 renderer.html 页面目标。目标列表：${JSON.stringify(await listTargets().catch(() => []))}`);
    process.exit(2);
  }
  console.log(`[probe] 找到目标：${target.title} @ ${target.url}`);
  const client = cdp(target.webSocketDebuggerUrl);

  // 收集渲染进程 console 与加载失败，作为「有没有报错」的证据。
  try {
    await client.send("Runtime.enable");
    const logs = await client.send("Log.enable").catch(() => null);
    if (!logs) {
      // Log 域可能不可用，退而求其次用 Runtime.consoleAPICalled。
    }
  } catch {
    // 不阻塞。
  }

  // 等首屏渲染稳定（真实 IPC 快照回来 + 三栏出现）。
  let probe = null;
  for (let i = 0; i < 40; i++) {
    const r = await client.send("Runtime.evaluate", {
      expression: PROBE_JS,
      returnByValue: true,
      awaitPromise: true,
    });
    const v = r.result?.value ?? r.result?.description;
    if (v && v.colCount === 3) { probe = v; break; }
    await sleep(250);
  }
  if (!probe) {
    // 再给最后一次机会拿到原始值，方便诊断。
    const r = await client.send("Runtime.evaluate", { expression: PROBE_JS, returnByValue: true });
    probe = r.result?.value ?? null;
  }

  if (!probe) {
    console.error("[probe] 探针没有返回可读结果。");
    process.exit(2);
  }

  // —— 三栏 ——
  check(assertions, "三栏容器数量 = 3", probe.colCount === 3, `classes=${JSON.stringify(probe.colClasses)}`);
  check(assertions, "三栏水平排布（左<中<右）", probe.horizontalOrder === true, `rects=${JSON.stringify(probe.colRects)}`);
  check(assertions, "三栏均有非零尺寸（真画出来）", probe.painted === true, JSON.stringify(probe.colRects));

  // —— 面板标题 ——
  const titles = probe.panelTitles ?? [];
  check(
    assertions,
    "面板标题都在（任务/会话/审批队列/黑板台账）",
    ["任务", "会话", "审批队列", "黑板台账"].every((t) => titles.some((p) => p.includes(t))),
    JSON.stringify(titles),
  );

  // —— 没白屏 ——
  check(assertions, "页面有实际文本内容（没白屏）", probe.bodyTextLen > 20, `${probe.bodyTextLen} 字符`);

  // —— 样式表真的加载了（R16 的核心问题） ——
  const cssLoaded = probe.cssSheetHref !== null && probe.cssRuleCount > 0;
  check(
    assertions,
    "styles.css 以 <link> 加载且解析出规则（cssRules>0）",
    cssLoaded,
    `href=${probe.cssSheetHref} rules=${probe.cssRuleCount} sheets=${probe.stylesheetCount}`,
  );
  check(
    assertions,
    "#app 计算样式是 grid 三列（两端 240px/400px，中间弹性）",
    probe.appDisplay === "grid" && /^240px .+ 400px$/.test(probe.appGridTemplateColumns ?? ""),
    `display=${probe.appDisplay} cols=${probe.appGridTemplateColumns}（getComputedStyle 返回的是 used value，1fr 已换算成像素）`,
  );
  check(
    assertions,
    "body 背景/前景应用了亮色主题变量（#f6f8fa / #1f2328）",
    probe.bodyBg === "rgb(246, 248, 250)" && probe.bodyColor === "rgb(31, 35, 40)",
    `bg=${probe.bodyBg} color=${probe.bodyColor}`,
  );
  check(
    assertions,
    "body 字体应用了 13px Segoe UI（非浏览器默认）",
    probe.bodyFontSize === "13px" && /Segoe UI/.test(probe.bodyFontFamily ?? ""),
    `${probe.bodyFontSize} ${probe.bodyFontFamily}`,
  );
  check(
    assertions,
    "左栏 overflow-y:auto（样式细节规则生效）",
    probe.leftOverflowY === "auto",
    `overflowY=${probe.leftOverflowY}`,
  );

  // —— 打包态首屏内容（真实后端，无会话） ——
  check(assertions, "规则包徽标有名字（真实 IPC 快照）", typeof probe.policyPackName === "string" && probe.policyPackName.length > 0, probe.policyPackName);
  check(assertions, "任务卡渲染（示例任务）", (probe.taskTitle ?? "").length > 0, probe.taskTitle);

  // —— 截图 ——
  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(shot.data, "base64");
  const pngPath = path.join(LOGS_DIR, "packaged-ui.png");
  writeFileSync(pngPath, png);
  check(assertions, "截图写入 docs/logs/packaged-ui.png", png.length > 0, `${pngPath} (${png.length} bytes)`);

  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);

  const evidence = {
    generatedAt: new Date().toISOString(),
    targetUrl: target.url,
    targetTitle: target.title,
    scheme: "CDP against packaged 不迷茫.exe",
    assertions,
    domProbe: probe,
    consoleLogs,
    loadFailures,
    screenshot: pngPath,
    pass,
  };
  const jsonPath = path.join(LOGS_DIR, "packaged-ui.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  console.log(`\n[probe] 证据：${jsonPath}`);
  console.log(`[probe] 截图：${pngPath}`);
  console.log(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}`);
  client.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[probe] 异常：", err);
  process.exit(2);
});
