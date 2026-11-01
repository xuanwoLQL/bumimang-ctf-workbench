/**
 * Lane B · 第 22 轮 · 打包产物上的「首次启动引导」端到端（补 R10 的"干净机真装真验"）。
 *
 * 为什么存在：R10 的 first-run-guide 是新增 UI，当时只对 DEV electron
 * （node_modules\electron\dist\electron.exe + 现场剥 TS 的 src/main）跑过 first-run-verify.ts，
 * 那验的是**源码**；R10 doc 也白纸黑字写着「没在干净机器上真装真验」。本轮把这个 loose end
 * 在**真实 app.asar 打包产物**上收掉：
 *
 *   1. 用 FRESH userData 拉起 dist\win-unpacked\不迷茫.exe（localStorage 里没有 dismissal 键）；
 *   2. 断言「开始之前」浮层在首屏就出现、内容与真实快照一致
 *      （产生审批 = 快照里 installed+requests_by_default 的 agent；实测打断事实；数据路径）；
 *   3. 真实 DOM 点「知道了」→ 浮层消失 + localStorage 记 1；
 *   4. reload（同进程）不 nag；再优雅关闭 + 重新拉起（跨进程）仍不 nag —— 即「记住 dismissal」。
 *
 * 做法（零 mock、零 import src/main）：起真实 exe（--no-sandbox --remote-debugging-port），
 * 用 CDP 连上真实 app.asar 渲染进程；所有断言读真实 DOM / 真实 window.bumimang.snapshot()。
 *
 * —— 隔离（本轮的关键结论）——
 *   打包态 userData 默认是 %APPDATA%\bumimang，main.ts 里还会
 *   `app.setPath("userData", path.join(WORKSPACE, "electron-profile"))`，其中 WORKSPACE 派生自
 *   `app.getPath("userData")`。所以想拿到 fresh localStorage：
 *     · APPDATA 环境变量 —— 实测**无效**（Electron/Chromium 走 SHGetFolderPath(CSIDL_APPDATA)
 *       读注册表，不读环境变量；redirect 后 fresh 目录全空、真目录的 DevToolsActivePort 反而更新）；
 *     · --user-data-dir=<dir> —— 实测**有效**（Electron 的 GetUserDataPath() 优先读这个 switch，
 *       于是 WORKSPACE=dir\workspace、final userData=dir\workspace\electron-profile）。
 *   本脚本用 --user-data-dir 指向仓库内 .ui-run\packaged-first-run-userdata\，全程不碰真实
 *   %APPDATA%\bumimang（那是 R11 等轮次的证据）。
 *
 * 运行（Windows，Node ≥24，需先 npm run pack:dir 出产物）：
 *   node apps/desktop/electron/packaged-first-run.mjs 9440
 * 输出：docs/logs/packaged-first-run-{visible,dismissed,reopened}.png + packaged-first-run.json。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");
const PORT = Number(process.argv[2] ?? 9440);
const PORT2 = PORT + 1;

/** FRESH userData 根：--user-data-dir 指向这里；final userData = FRESH_ROOT\workspace\electron-profile。 */
const FRESH_ROOT = path.join(REPO_ROOT, ".ui-run", "packaged-first-run-userdata");
/** localStorage leveldb 落盘位置（final userData\Local Storage\leveldb）。 */
const LEVELDB_DIR = path.join(FRESH_ROOT, "workspace", "electron-profile", "Local Storage", "leveldb");
const FIRST_RUN_KEY = "bumimang.firstRunDismissed.v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 断言 / 时间线
const assertions = [];
const timeline = [];
function check(name, pass, detail = "") {
  assertions.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function step(msg) {
  const t = new Date().toISOString().slice(11, 19);
  timeline.push({ t, msg });
  console.log(`[step] ${t} ${msg}`);
}

// ---------------------------------------------------------------- 找打包 exe
function resolveExe() {
  if (process.env.BUMIMANG_EXE) {
    const p = path.resolve(process.env.BUMIMANG_EXE);
    if (!existsSync(p)) throw new Error(`BUMIMANG_EXE 指向不存在的文件：${p}`);
    return p;
  }
  const dir = path.join(REPO_ROOT, "dist", "win-unpacked");
  const exes = readdirSync(dir).filter(
    (f) => f.endsWith(".exe") && !/elevate|setup|update|uninstall/i.test(f),
  );
  if (exes.length === 0) throw new Error(`在 ${dir} 没找到打包 exe（先 npm run pack:dir）`);
  return path.join(dir, exes[0]);
}

/** 静态证据：app.asar 里必须含 first-run 浮层 + localStorage 键 + 四段内容的源码字面量。 */
function staticAsarCheck(exe) {
  const asarPath = path.join(path.dirname(exe), "resources", "app.asar");
  if (!existsSync(asarPath)) {
    check("app.asar 存在（可静态核验载荷）", false, asarPath);
    return;
  }
  const buf = readFileSync(asarPath);
  const markers = [
    ["标题「开始之前」", "开始之前"],
    ["dismissal localStorage 键", "bumimang.firstRunDismissed.v1"],
    ["产生审批段（permissionBehavior 同源）", "会产生审批"],
    ["实测打断段（写文件 3/3）", "写文件会请求放行（3/3）"],
    ["数据路径段（%APPDATA%\\bumimang）", "%APPDATA%\\bumimang"],
    ["开始段（＋ 新任务 → 简报 → guarded）", "＋ 新任务"],
  ];
  for (const [name, m] of markers) {
    check(`静态：app.asar 含 ${name}`, buf.includes(Buffer.from(m, "utf8")), JSON.stringify(m));
  }
  step(`app.asar=${asarPath}（${buf.length} bytes，mtime=${new Date(statSync(asarPath).mtimeMs).toISOString()}）`);
}

// ---------------------------------------------------------------- CDP 客户端
async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return res.json();
}

async function findPageTarget(port, waitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    try {
      const targets = await listTargets(port);
      const page = targets.find((t) => t.type === "page" && /renderer\.html|bumimang/.test(t.url ?? ""));
      if (page) return page;
    } catch {
      // 端口还没起来，继续等。
    }
    await sleep(400);
  }
  return null;
}

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
      }, 30000);
    });
  return { send, close: () => ws.close() };
}

let client = null;
let child = null;
let childLog = [];

/** 启动打包 exe（返回 child）；stdout/stderr 同时进内存（供断言）和 docs/logs 的 run.log。 */
function spawnApp(exe, port) {
  const logStream = createWriteStream(path.join(LOGS_DIR, "packaged-first-run-run.log"), { flags: "a" });
  child = spawn(
    exe,
    ["--no-sandbox", `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${FRESH_ROOT}`],
    { cwd: path.dirname(exe), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const cap = (chunk) => {
    const s = String(chunk);
    childLog.push(s);
    logStream.write(s);
  };
  child.stdout.on("data", cap);
  child.stderr.on("data", cap);
  child.on("exit", (code) => step(`打包进程退出 code=${code ?? "null"}`));
  return child;
}

async function connect(port) {
  const target = await findPageTarget(port);
  if (!target) return null;
  client = cdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable").catch(() => {});
  await client.send("Page.enable").catch(() => {});
  return target;
}

async function evalJs(expr) {
  const r = await client.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluate 异常",
    );
  }
  return r.result?.value;
}

async function poll(condJs, timeoutMs, intervalMs, label) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evalJs(condJs)) {
        step(`poll:${label} 命中（${Date.now() - start}ms）`);
        return true;
      }
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
    await sleep(intervalMs);
  }
  step(`poll:${label} 超时（${timeoutMs}ms）${lastErr ? ` lastErr=${lastErr}` : ""}`);
  return false;
}

async function screenshot(name) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(shot.data, "base64");
  const p = path.join(LOGS_DIR, name);
  writeFileSync(p, png);
  step(`截图 ${name}（${png.length} bytes）`);
  return p;
}

/** 首启浮层 DOM 探针：面板标题 / 持久化键 / 四段内容 / 是否只一块。 */
const PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const panel = q(".first-run-panel");
  if (!panel) return { present: false };
  const storageKey = panel.getAttribute("data-storage-key");
  let storedBefore = null;
  try { storedBefore = storageKey ? localStorage.getItem(storageKey) : null; } catch { storedBefore = "ERR"; }
  const sections = Array.from(panel.querySelectorAll(".first-run-section")).map((sec) => ({
    head: (sec.querySelector(".first-run-section-head")?.textContent || "").trim(),
    text: (sec.textContent || "").trim(),
  }));
  return {
    present: true,
    title: (panel.querySelector(".first-run-title")?.textContent || "").trim(),
    storageKey,
    storedBefore,
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

function sectionByHead(p, headPart) {
  return (p.sections ?? []).find((s) => s.head.includes(headPart));
}

/** 磁盘级证据：fresh userData 的 leveldb 日志里是否已写入 dismissal 键（证明 localStorage 落 userData）。 */
function leveldbContainsDismissal() {
  try {
    const files = readdirSync(LEVELDB_DIR).filter((f) => f.endsWith(".log") || f.endsWith(".ldb"));
    for (const f of files) {
      const buf = readFileSync(path.join(LEVELDB_DIR, f));
      if (buf.includes(Buffer.from(FIRST_RUN_KEY, "utf8"))) return { found: true, file: f, bytes: buf.length };
    }
    return { found: false, file: null };
  } catch (e) {
    return { found: false, file: null, error: String(e) };
  }
}

/** 关掉窗口（优雅退出 → localStorage 落盘），等进程退出；超时再 taskkill 兜底。 */
async function closeAppGracefully(exe) {
  try {
    await evalJs(`window.close()`);
    step("已发 window.close()，等优雅退出");
  } catch {
    step("window.close() 未执行（可能已退出），走 taskkill 兜底");
  }
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (child && child.exitCode !== null) {
      step(`进程已退出 code=${child.exitCode}（${Date.now() - start}ms）`);
      return;
    }
    await sleep(400);
  }
  step("优雅退出超时，taskkill 兜底");
  try {
    spawnSync("taskkill", ["/F", "/T", "/IM", path.basename(exe)], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(800);
}

function killChild() {
  if (child && child.exitCode === null) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  if (client) client.close();
}

// ---------------------------------------------------------------- 主流程
async function run() {
  // 0. 清残留（best effort）+ 清 fresh userData（保证真正的「首启」）
  for (const img of ["不迷茫.exe", "electron.exe"]) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/IM", img], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  await sleep(600);
  rmSync(FRESH_ROOT, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  // 截断本轮 run.log（spawnApp 用 append 打开，避免残留上一轮的尾部）
  writeFileSync(path.join(LOGS_DIR, "packaged-first-run-run.log"), "");

  const exe = resolveExe();
  step(`启动打包产物：${exe}（--no-sandbox --user-data-dir=${FRESH_ROOT}）`);
  staticAsarCheck(exe);

  // ============ 第一次启动：首屏引导可见 ============
  spawnApp(exe, PORT);
  const target1 = await connect(PORT);
  if (!target1) {
    check("打包 exe 的渲染进程页面目标可达（CDP）", false, "60s 内没找到 renderer 页面");
    await finish({ exe, outcome: "no-cdp-target" });
    return;
  }

  const ready1 = await poll(
    `(async()=>{ return typeof window.bumimang === "object" && window.bumimang !== null && document.querySelectorAll("#app > .col").length === 3; })()`,
    30000,
    300,
    "首屏就绪（真实桥 + 三栏）",
  );
  check("打包态窗口就绪（window.bumimang 真实 IPC + 三栏渲染）", ready1);

  // 引导浮层在首屏 snapshot 之后同步挂上 —— 等它出现
  const guideVisible = await poll(`document.querySelector('.first-run-panel') !== null`, 15000, 200, "首启引导浮层出现");
  const snap = await evalJs(`window.bumimang.snapshot()`);
  const p = await evalJs(PROBE_JS);

  // —— 出现与基本形状 ——
  check("首屏：引导浮层出现（fresh userData 下未被 dismiss）", guideVisible && p.present === true);
  check("浮层只出现一块", p.panelCount === 1, `count=${p.panelCount}`);
  check("标题是「开始之前」", p.title === "开始之前", `title="${p.title}"`);

  // —— 与真实快照一致：产生审批 = installed + requests_by_default ——
  const agents = snap.agents ?? [];
  const produceTitles = agents.filter((a) => a.installed && a.permissionBehavior === "requests_by_default").map((a) => a.title);
  const nonProduceTitles = agents.filter((a) => !a.installed || a.permissionBehavior !== "requests_by_default").map((a) => a.title);
  step(`快照 agents：产生审批=[${produceTitles.join("、")}] 不产生审批=[${nonProduceTitles.join("、")}]`);
  const producing = p.producing ?? "";
  const nonproducing = p.nonproducing ?? "";
  check(
    "产生审批一行点名快照里 installed+requests_by_default 的每家 agent",
    produceTitles.length > 0 && produceTitles.every((t) => producing.includes(t)),
    producing,
  );
  check(
    "产生审批一行不含任何非 producing agent",
    nonProduceTitles.every((t) => !producing.includes(t)),
    producing,
  );
  check(
    "不会产生审批一行点名各家非 producing agent 且标注（未安装 / 不保证会问）",
    nonProduceTitles.length > 0 &&
      nonProduceTitles.every((t) => nonproducing.includes(t)) &&
      (nonproducing.includes("未安装") || nonproducing.includes("不保证会问")),
    nonproducing,
  );
  const dsh = agents.find((a) => a.id === "dsh");
  if (dsh && !dsh.installed) {
    check("DeepSeek Harness 标「未安装」", nonproducing.includes("DeepSeek Harness") && nonproducing.includes("未安装"), nonproducing);
  }

  // —— 实测打断事实（硬编码自 R10 的实测，与快照无关，但要字面一致）——
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

  // —— 数据路径 ——
  const dataLoc = sectionByHead(p, "数据")?.text ?? "";
  check(
    "数据段：打包态 %APPDATA%\\bumimang\\(workspace + evidence) + 开发态 .ui-run",
    dataLoc.includes("%APPDATA%") && dataLoc.includes("bumimang") && dataLoc.includes("workspace") && dataLoc.includes("evidence") && dataLoc.includes(".ui-run"),
    dataLoc,
  );

  // —— 怎么开始 ——
  const startLine = sectionByHead(p, "怎么开始")?.text ?? "";
  check("开始段：新任务 → 简报 → agent + guarded", startLine.includes("新任务") && startLine.includes("简报") && startLine.includes("guarded"), startLine);

  // —— 持久化键是渲染层 localStorage（不是契约字段）——
  check(
    "dismissal 键是渲染层 localStorage 键（data-storage-key 暴露）",
    typeof p.storageKey === "string" && p.storageKey === FIRST_RUN_KEY,
    `key="${p.storageKey}"`,
  );
  check("首启（fresh userData）localStorage 该键为空", p.storedBefore === null, `before=${JSON.stringify(p.storedBefore)}`);

  // —— 截图：可见态 ——
  const shotVisible = await screenshot("packaged-first-run-visible.png");
  check("截图 packaged-first-run-visible.png 写入", existsSync(shotVisible), shotVisible);

  // ============ dismiss：点「知道了」 ============
  const d = await evalJs(DISMISS_JS);
  check("点「知道了」后浮层从 DOM 消失", d.ok === true && d.panelCount === 0, `ok=${d.ok} count=${d.panelCount} reason=${d.reason}`);
  check("dismiss 记进 localStorage（值为 1）", d.stored === "1", `stored="${d.stored}" key="${d.storageKey}"`);

  const shotDismissed = await screenshot("packaged-first-run-dismissed.png");
  check("截图 packaged-first-run-dismissed.png 写入", existsSync(shotDismissed), shotDismissed);

  // ============ reload（同进程）不 nag ============
  await evalJs(`location.reload()`);
  const reloaded = await poll(
    `(async()=>{ return typeof window.bumimang === "object" && window.bumimang !== null && document.querySelectorAll("#app > .col").length === 3; })()`,
    30000,
    300,
    "reload 后首屏就绪",
  );
  await sleep(1200); // 给 bootstrap（含 snapshot → showFirstRunGuide）充分时间
  const afterReload = await evalJs(`(() => {
    let stored = null; try { stored = localStorage.getItem(${JSON.stringify(FIRST_RUN_KEY)}); } catch { stored = "ERR"; }
    return {
      stored,
      panelPresent: !!document.querySelector(".first-run-panel"),
      cols: document.querySelectorAll("#app > .col").length,
    };
  })()`);
  check("reload 后 dismissal 仍在 localStorage", afterReload.stored === "1", `stored="${afterReload.stored}"`);
  check("reload 后引导不再出现（不 nag）", afterReload.panelPresent === false && afterReload.cols === 3, `panel=${afterReload.panelPresent} cols=${afterReload.cols}`);

  // ============ reopen（跨进程）：优雅关闭 → 重新拉起 ============
  await closeAppGracefully(exe);

  // 优雅退出后 Chromium 才把 localStorage 刷进 leveldb —— 这里做磁盘级证据（localStorage 落在 userData）。
  const ldb = leveldbContainsDismissal();
  check(
    "磁盘级证据：dismissal 键已写入 fresh userData 的 Local Storage/leveldb",
    ldb.found === true,
    `file=${ldb.file}${ldb.error ? ` error=${ldb.error}` : ""}`,
  );

  childLog = [];
  spawnApp(exe, PORT2);
  const target2 = await connect(PORT2);
  if (!target2) {
    check("重启后打包 exe 的渲染进程页面目标可达（CDP）", false, "60s 内没找到 renderer 页面");
    await finish({ exe, outcome: "no-cdp-target-on-reopen", probe: p, dismiss: d, afterReload });
    return;
  }
  const ready2 = await poll(
    `(async()=>{ return typeof window.bumimang === "object" && window.bumimang !== null && document.querySelectorAll("#app > .col").length === 3; })()`,
    30000,
    300,
    "重启后首屏就绪",
  );
  // 等首屏 snapshot 落地（任务卡出现 = store.set 已跑完 = showFirstRunGuide 已决策）再断言
  const snapLanded = await poll(`document.querySelector('.task-card .task-title') !== null`, 15000, 300, "重启后首屏 snapshot 落地（任务卡出现）");
  await sleep(800);
  const afterReopen = await evalJs(`(() => {
    let stored = null; try { stored = localStorage.getItem(${JSON.stringify(FIRST_RUN_KEY)}); } catch { stored = "ERR"; }
    return {
      stored,
      panelPresent: !!document.querySelector(".first-run-panel"),
      cols: document.querySelectorAll("#app > .col").length,
      taskTitle: (document.querySelector(".task-card .task-title")?.textContent || "").trim(),
    };
  })()`);
  check("重启（跨进程）后窗口就绪", ready2 && afterReopen.cols === 3, `cols=${afterReopen.cols}`);
  check("重启后 snapshot 已落地（首屏不是空态）", snapLanded && afterReopen.taskTitle.length > 0, `task="${afterReopen.taskTitle}"`);
  check("重启后 dismissal 仍在 localStorage（跨进程持久化）", afterReopen.stored === "1", `stored="${afterReopen.stored}"`);
  check("重启后引导不再出现（记住 dismissal）", afterReopen.panelPresent === false, `panel=${afterReopen.panelPresent}`);

  const shotReopened = await screenshot("packaged-first-run-reopened.png");
  check("截图 packaged-first-run-reopened.png 写入", existsSync(shotReopened), shotReopened);

  // ============ 健康：渲染进程无 error / 无崩溃 ============
  const rendererErrors = childLog.filter((l) => /\[renderer:error\]/i.test(l) || /render-process-gone|uncaught/i.test(l));
  check(
    "渲染进程无 console error / 无崩溃痕迹",
    rendererErrors.length === 0,
    rendererErrors.slice(0, 5).map((l) => l.trim()).join(" | "),
  );

  await finish({
    exe,
    outcome: "first-run-verified-on-packaged",
    freshUserDataRoot: FRESH_ROOT,
    leveldbDir: LEVELDB_DIR,
    probe: p,
    dismiss: d,
    afterReload,
    afterReopen,
    screenshotVisible: shotVisible,
    screenshotDismissed: shotDismissed,
    screenshotReopened: shotReopened,
  });
}

async function finish(extra = {}) {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);
  const evidence = {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    scheme: "CDP against packaged 不迷茫.exe (dist/win-unpacked, app.asar)",
    isolation: "--user-data-dir (APPDATA env 实测无效，见脚本注释)",
    freshUserDataRoot: FRESH_ROOT,
    localStorageKey: FIRST_RUN_KEY,
    assertions,
    timeline,
    appLogTail: childLog.slice(-40).map((l) => l.trim()),
    ...extra,
    pass,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  const jsonPath = path.join(LOGS_DIR, "packaged-first-run.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  console.log("\n== PACKAGED-FIRST-RUN · 打包产物上的首次启动引导 ==\n");
  for (const a of assertions) {
    console.log(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}`);
  }
  console.log(`\n证据：${jsonPath}`);
  console.log(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}`);

  killChild();
  process.exit(pass ? 0 : 1);
}

setTimeout(() => {
  console.log("[packaged-first-run] 硬超时退出（300s）");
  const evidence = { timeout: true, timeline, assertions, appLogTail: childLog.slice(-40) };
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(path.join(LOGS_DIR, "packaged-first-run.json"), JSON.stringify(evidence, null, 2));
  killChild();
  process.exit(9);
}, 300000);

process.on("SIGINT", () => {
  killChild();
  process.exit(130);
});

run().catch((err) => {
  console.error("[packaged-first-run] 异常：", err);
  finish({ error: (err && err.stack) || String(err), outcome: "exception" }).catch(() => process.exit(2));
});
