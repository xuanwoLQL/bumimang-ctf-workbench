/**
 * Lane B · 第 21 轮 · 打包产物上的「UI 拒绝 → blocked」端到端（证明 L-4 / L-4b 真的进了 dist）。
 *
 * 为什么存在：Lane A 在 09:40 重打了 dist，把 08:42 的 L-4（prompt() 不再把 blocked
 * 覆盖回 idle）与 08:44 的 L-4b（退避计数改用"请求内容签名"）一起进了产物。但 08:24
 * 那版 dist 里**没有**这两处 —— 此前 ui-deny-blocked.ts 只对 DEV electron
 * （node_modules\electron\dist\electron.exe + 现场剥 TS 的 src/main）跑过，那验的是
 * **源码**，不是打包产物。本脚本把同一条链在**真实 app.asar 打包产物**上重跑一遍：
 *
 *   起 guarded claude 会话 → prompt 它写 demo.txt → 在真实 DOM 里点「拒绝」按钮两次
 *   （同一动作两次，命中 L-4b 的"内容签名"计数阈值 2）→ 断言会话终态 blocked、
 *   会话卡是「被策略切断」（红边框，不是崩溃）、台账多 scope=blocked 死路。
 *
 * 做法（零 mock、零 import src/main）：把 `dist\win-unpacked\不迷茫.exe` 拉起来
 * （--no-sandbox --remote-debugging-port），用 CDP 连上**真实 app.asar 渲染进程**。
 * 起会话 / prompt 走冻结契约 `window.bumimang.dispatch`（真实 IPC）；「拒绝」走真实
 * DOM 按钮 `.click()`（按钮自己的监听器 → decide() → ctx.hub.dispatch → 真实 IPC），
 * 不是 window.bumimang.dispatch 直发 approval.decide。
 *
 * 打包态与 dev ui-deny-blocked.ts 的一个**关键差异**（本脚本按打包态的真实语义走）：
 *   - dev 入口自己 bootstrap 队列时用 `denials.note(sessionId, decision.rule)` —— 按**规则 id** 计数；
 *   - 打包态 main.ts 用 `denials.note(sessionId, approvalSignature(detail) || decision.rule)`
 *     —— 按**请求内容签名**（title/command/path/target/kind）计数（L-4b）。
 * 所以 dev 里拒「demo.txt + demo2.txt」两件不同的事也能 blocked（都命中 tier-guarded-default），
 * 打包态里**必须同一动作**。本脚本因此让两次 prompt 都写**同一个 demo.txt**。
 *
 * 运行（Windows，Node ≥24，需先 npm run pack:dir 出产物）：
 *   node apps/desktop/electron/packaged-ui-deny.mjs 9334
 * 可执行文件路径可用 env BUMIMANG_EXE 覆盖（默认自动找 dist\win-unpacked\*.exe）。
 * 输出：docs/logs/packaged-ui-deny.png（终态截图）+ packaged-ui-deny.json（证据）。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");
const PORT = Number(process.argv[2] ?? 9334);
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

/** 两次 prompt 写同一个文件 → 同一「内容签名」→ 退避计数到 2（L-4b 语义）。 */
const PROMPT_TEXT =
  "请在当前目录创建一个名为 demo.txt 的文件，内容写一行 hello。只做这一件事，完成后就结束。";
const RETRY_PROMPT_TEXT =
  "请再次尝试：在当前目录创建 demo.txt 文件，内容写一行 hello。只做这一件事，完成后就结束。";
const NEUTRAL_TITLE = "打包态 UI 拒绝验收";
const NEUTRAL_BRIEF =
  "本任务仅用于验证工作台的人工审批拒绝链路，暂无具体目标，等待后续指令。";

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

/** 静态证据：app.asar 里必须含 L-4 / L-4b / 渲染层 blocked 文案的源码字面量。 */
function staticAsarCheck(exe) {
  const asarPath = path.join(path.dirname(exe), "resources", "app.asar");
  if (!existsSync(asarPath)) {
    check("app.asar 存在（可静态核验载荷）", false, asarPath);
    return;
  }
  const buf = readFileSync(asarPath);
  const st = statSync(asarPath);
  const markers = [
    ["L-4：prompt() 终态不覆盖（本轮结束时已是终态）", "本轮结束时已是终态"],
    ["L-4：不覆盖回 idle", "不覆盖回 idle"],
    ["L-4b：退避计数按「同一动作」", "同一动作被连续拒绝"],
    ["L-4b：approvalSignature 函数已入包", "approvalSignature"],
    ["渲染层：blocked 文案「被策略切断」", "被策略切断"],
  ];
  for (const [name, m] of markers) {
    check(`静态：app.asar 含 ${name}`, buf.includes(Buffer.from(m, "utf8")), m);
  }
  step(
    `app.asar=${asarPath}（${buf.length} bytes，mtime=${new Date(st.mtimeMs).toISOString()}）`,
  );
}

// ---------------------------------------------------------------- CDP 客户端
async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return res.json();
}

async function findPageTarget(waitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    try {
      const targets = await listTargets();
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

async function getSnapshot() {
  return await evalJs(`window.bumimang.snapshot()`);
}

/** 经冻结契约派发一个 HubAction（真实 IPC）。 */
async function dispatch(action, timeoutMs = 15000) {
  await evalJs(`(() => {
    window.__act = { done: false, result: null, error: null };
    window.bumimang.dispatch(${JSON.stringify(action)})
      .then((r) => { window.__act = { done: true, result: r, error: null }; })
      .catch((e) => { window.__act = { done: true, result: null, error: String((e && e.message) || e) }; });
    return true;
  })()`);
  const done = await poll(`window.__act && window.__act.done === true`, timeoutMs, 250, "action 返回");
  const res = await evalJs(
    `({ result: window.__act ? window.__act.result : null, error: window.__act ? window.__act.error : null })`,
  );
  return { done, ...res };
}

async function screenshot(name) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(shot.data, "base64");
  const p = path.join(LOGS_DIR, name);
  writeFileSync(p, png);
  step(`截图 ${name}（${png.length} bytes）`);
  return p;
}

/** 在真实 UI 里点「拒绝」按钮：.ap-card.ap-pending[data-id] 里的 [data-act="deny"]。 */
async function clickDenyButton(approvalId) {
  const present = await poll(
    `document.querySelector('.ap-card.ap-pending[data-id=${JSON.stringify(approvalId)}]') !== null`,
    8000,
    200,
    `拒绝按钮卡片就绪（${approvalId}）`,
  );
  if (!present) return { clicked: false, reason: "card-not-rendered", label: null };
  return await evalJs(`(() => {
    const card = document.querySelector('.ap-card.ap-pending[data-id=${JSON.stringify(approvalId)}]');
    if (!card) return { clicked: false, reason: "card-gone", label: null };
    const btn = card.querySelector('[data-act="deny"]');
    if (!btn) return { clicked: false, reason: "deny-button-missing", label: null };
    const label = (btn.textContent || "").trim();
    btn.click();
    return { clicked: true, reason: "clicked", label };
  })()`);
}

function sessionCardProbeJs(sessionId) {
  return `(() => {
    const item = document.querySelector('.session-item[data-id=${JSON.stringify(sessionId)}]');
    if (!item) return { rendered: false };
    const blockedBadge = item.querySelector('.status-blocked');
    const failedBadge = item.querySelector('.status-failed');
    const stoppedBadge = item.querySelector('.status-stopped');
    return {
      rendered: true,
      hasBlockedClass: item.classList.contains('session-blocked'),
      hasFailedClass: item.classList.contains('session-failed'),
      blockedText: blockedBadge ? blockedBadge.textContent.trim() : null,
      hasFailedBadge: !!failedBadge,
      hasStoppedBadge: !!stoppedBadge,
      title: item.getAttribute('title'),
      badges: Array.from(item.querySelectorAll('.badge')).map((b) => b.textContent.trim()),
    };
  })()`;
}

/** 从 %APPDATA%\bumimang 的 wire.jsonl 提取硬证据（request_permission 的 title/kind + stopReason）。 */
function readWireEvidence(sessionId) {
  const p = path.join(APPDATA, "bumimang", "workspace", "sessions", sessionId, "wire.jsonl");
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      const m = obj.message;
      if (!m || typeof m !== "object") continue;
      if (m.method === "session/request_permission") {
        out.push({
          ts: obj.ts,
          dir: obj.dir,
          method: m.method,
          title: m.params?.toolCall?.title ?? null,
          kind: m.params?.toolCall?.kind ?? null,
        });
      }
      const sr = m.result?.stopReason;
      if (typeof sr === "string") out.push({ ts: obj.ts, dir: obj.dir, stopReason: sr });
      if (obj.dir === "sys" && m.deny) {
        out.push({
          ts: obj.ts,
          dir: obj.dir,
          denyRule: m.deny.rule ?? null,
          denyTitle: m.deny.detail?.title ?? null,
          denyKind: m.deny.detail?.kind ?? null,
        });
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主流程
const briefingApprovals = [];
const denyEvents = [];

async function dismissFirstRunGuide() {
  const present = await poll(
    `document.querySelector('.first-run-panel') !== null`,
    8000,
    300,
    "首启引导浮层出现",
  );
  if (!present) {
    step("无首启引导浮层（已 dismiss 或未触发）");
    return;
  }
  await evalJs(`document.querySelector('.first-run-dismiss')?.click()`);
  const gone = await poll(`document.querySelector('.first-run-panel') === null`, 8000, 300, "首启引导浮层关闭");
  check("首启引导浮层可关闭（真实 DOM 点「知道了」）", gone);
}

async function waitForIdleDraining(sessionId, timeoutMs) {
  // 先等简报轮真正启动（running 或出现审批），避免 session.start 刚返回、status 还在
  // idle 的窗口里误判"已 idle"。
  await poll(
    `(async()=>{ const s = await window.bumimang.snapshot(); const c = s.sessions.find(x => x.id === ${JSON.stringify(sessionId)}); return !!c && (c.status === "running" || s.approvals.some(a => a.status === "pending")); })()`,
    60000,
    500,
    "简报轮启动（running 或出现审批）",
  );
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await getSnapshot();
    const c = s.sessions.find((x) => x.id === sessionId);
    const pending = s.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      for (const a of pending) {
        step(`简报轮触发真实审批 → 人工放行：${a.id} rule=${a.rule} cmd=${(a.command ?? a.action).slice(0, 90)}`);
        briefingApprovals.push({ id: a.id, action: a.action, command: a.command, rule: a.rule });
        await dispatch({ type: "approval.decide", approvalId: a.id, decision: "approve" }, 10000);
        drained += 1;
      }
      continue;
    }
    if (c && c.status === "idle") {
      step(`会话 idle（简报轮完成，期间放行 ${drained} 条真实审批）`);
      return { idle: true, drained };
    }
    await sleep(1000);
  }
  step(`等 idle 超时（${timeoutMs}ms），已放行 ${drained} 条`);
  return { idle: false, drained };
}

async function provokeSecondPending(sessionId, excludeIds, deadlineMs) {
  let retries = 0;
  const deadline = Date.now() + deadlineMs;
  step(`开始诱发第二次审批（同一动作：再次写 demo.txt），预算 ${deadlineMs}ms`);
  while (Date.now() < deadline) {
    const snap = await getSnapshot();
    const p = snap.approvals.find((a) => a.status === "pending" && !excludeIds.includes(a.id));
    if (p) return p;
    const c = snap.sessions.find((x) => x.id === sessionId);
    if (c && c.status === "idle" && retries < 2) {
      retries += 1;
      step(`会话 idle 且无新 pending → 发送第 ${retries} 次重试 prompt（同一个 demo.txt）`);
      await dispatch({ type: "session.prompt", sessionId, text: RETRY_PROMPT_TEXT }, 15000);
      await sleep(3000);
      continue;
    }
    await sleep(2000);
  }
  step(`诱发第二次审批超时（${deadlineMs}ms），已重试 prompt ${retries} 次`);
  return null;
}

async function recordDeny(a, idx) {
  const clickRes = await clickDenyButton(a.id);
  check(
    `第 ${idx} 次拒绝：UI「拒绝」按钮被真实点击（DOM .click()）`,
    clickRes.clicked === true,
    `label="${clickRes.label}" reason=${clickRes.reason}`,
  );
  const deniedOk = await poll(
    `(async()=>{ const s = await window.bumimang.snapshot(); const x = s.approvals.find(v => v.id === ${JSON.stringify(a.id)}); return !!x && x.status === "denied"; })()`,
    10000,
    250,
    `第 ${idx} 次 deny 生效（快照 status=denied）`,
  );
  const after = (await getSnapshot()).approvals.find((v) => v.id === a.id);
  check(
    `第 ${idx} 次拒绝：审批项变成已拒绝且由 human 决定`,
    deniedOk && after?.status === "denied" && after?.decidedBy === "human",
    `status=${after?.status} decidedBy=${after?.decidedBy}`,
  );
  denyEvents.push({
    approvalId: a.id,
    action: a.action,
    command: a.command,
    rule: a.rule,
    risk: a.risk,
    sameKindCount: a.sameKindCount,
    clickLabel: clickRes.label,
    clickReason: clickRes.reason,
    deniedStatus: after?.status ?? null,
    deniedBy: after?.decidedBy ?? null,
  });
}

async function run() {
  // 0. 清残留（best effort）
  for (const img of ["不迷茫.exe", "electron.exe"]) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/IM", img], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  await sleep(600);

  const exe = resolveExe();
  step(`启动打包产物：${exe}（--no-sandbox --remote-debugging-port=${PORT}）`);
  staticAsarCheck(exe);

  const logStream = createWriteStream(path.join(LOGS_DIR, "packaged-ui-deny-run.log"));
  child = spawn(
    exe,
    ["--no-sandbox", `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*"],
    { cwd: path.dirname(exe), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("exit", (code) => step(`打包进程退出 code=${code ?? "null"}`));

  // 1. 连 CDP
  const target = await findPageTarget();
  if (!target) {
    check("打包 exe 的渲染进程页面目标可达（CDP）", false, "120s 内没找到 renderer 页面");
    await finish({ exe, target: null, outcome: "no-cdp-target" });
    return;
  }
  client = cdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable").catch(() => {});
  await client.send("Page.enable").catch(() => {});

  // 2. 首屏就绪
  const ready = await poll(
    `(async()=>{ return typeof window.bumimang === "object" && window.bumimang !== null && document.querySelectorAll("#app > .col").length === 3; })()`,
    30000,
    300,
    "首屏就绪（真实桥 + 三栏）",
  );
  check("打包态窗口就绪（window.bumimang 真实 IPC + 三栏渲染）", ready);

  await dismissFirstRunGuide();
  const shot0 = await screenshot("packaged-ui-deny-0-initial.png");
  check("截图 0（打包态首屏）写入", existsSync(shot0), shot0);

  const snapInit = await getSnapshot();
  const claudeDesc = snapInit.agents.find((a) => a.id === "claude");
  check(
    "快照里有 agent 检测结果且 claude 已安装可用",
    snapInit.agents.length >= 3 && claudeDesc?.installed === true,
    `agents=${snapInit.agents.map((a) => `${a.id}${a.installed ? "" : "(未装)"}`).join(",")}`,
  );

  // 3. 中性任务（让简报轮不探索文件系统，写文件动作留给 session.prompt）
  step(`派发 task.create（中性简报）：${NEUTRAL_TITLE}`);
  const taskRes = await dispatch({ type: "task.create", title: NEUTRAL_TITLE, brief: NEUTRAL_BRIEF }, 15000);
  check("task.create 返回 {ok:true}", taskRes.done && taskRes.result?.ok === true, JSON.stringify(taskRes.result ?? taskRes.error));
  const taskOk = await poll(
    `(async()=>{ const s = await window.bumimang.snapshot(); return s.task && s.task.title === ${JSON.stringify(NEUTRAL_TITLE)}; })()`,
    15000,
    300,
    "新任务变当前",
  );
  check("中性任务已创建并变当前（task.create 真实 IPC）", taskOk, `title="${NEUTRAL_TITLE}"`);
  const snapTask = await getSnapshot();
  const taskId = snapTask.task?.id;
  check("拿到当前任务 id", Boolean(taskId), `id=${taskId}`);

  // 4. 起 guarded claude 会话
  step(`派发 session.start agent=claude tier=guarded`);
  const startRes = await dispatch(
    { type: "session.start", taskId, agent: "claude", role: "lead", tier: "guarded" },
    150000,
  );
  check("session.start 返回 {ok:true}", startRes.done && startRes.result?.ok === true, JSON.stringify(startRes.result ?? startRes.error));

  const snapS = await getSnapshot();
  const sess = snapS.sessions.find((s) => s.agent === "claude");
  check("快照里出现 claude 会话", Boolean(sess), sess ? `id=${sess.id} status=${sess.status}` : JSON.stringify(snapS.sessions.map((s) => `${s.agent}:${s.status}`)));
  const sessionId = sess?.id;
  if (!sessionId) {
    await finish({ exe, target, outcome: "no-session", finalSnapshot: snapS });
    return;
  }
  check("会话档位是 guarded（guarded 档）", sess.tier === "guarded", `agent=${sess.agent} role=${sess.role} tier=${sess.tier}`);
  step(`会话 id=${sessionId} status=${sess.status}`);

  // 5. 等 idle（简报轮：像真人一样放行真实审批）
  const { idle: idleOk, drained } = await waitForIdleDraining(sessionId, 300000);
  check("claude 会话进入 idle（简报轮完成）", idleOk, `期间放行 ${drained} 条简报轮真实审批`);
  const sessIdle = (await getSnapshot()).sessions.find((s) => s.id === sessionId);
  check("idle 状态确认", sessIdle?.status === "idle", `status=${sessIdle?.status}`);

  // 6. 第一次 prompt：写 demo.txt
  const baseSnap = await getSnapshot();
  const pendingBefore = baseSnap.approvals.filter((a) => a.status === "pending").length;
  check("派发 prompt 前审批队列为空（基线）", pendingBefore === 0, `pendingBefore=${pendingBefore}`);
  const promptDispatchAt = Date.now();
  step(`派发 session.prompt：${PROMPT_TEXT}`);
  const promptRes = await dispatch({ type: "session.prompt", sessionId, text: PROMPT_TEXT }, 15000);
  check("session.prompt 返回 {ok:true}", promptRes.done && promptRes.result?.ok === true, JSON.stringify(promptRes.result ?? promptRes.error));

  const pendingAppeared = await poll(
    `(async()=>{ const s = await window.bumimang.snapshot(); return s.approvals.some((a) => a.status === "pending"); })()`,
    150000,
    1000,
    "第一个 pending 审批出现",
  );
  if (!pendingAppeared) {
    const shot = await screenshot("packaged-ui-deny-timeout.png");
    const snapT = await getSnapshot();
    check(
      "claude 在 150s 内向审批队列发来 pending（核心）",
      false,
      `approvals=${snapT.approvals.length} sessions=${snapT.sessions.map((s) => `${s.agent}:${s.status}`).join(",")}`,
    );
    await finish({
      exe,
      target,
      outcome: "claude-did-not-ask",
      screenshot: shot,
      approvalsAtTimeout: snapT.approvals.map((a) => ({ id: a.id, status: a.status, action: a.action })),
      sessionsAtTimeout: snapT.sessions,
    });
    return;
  }

  const snapPending = await getSnapshot();
  const firstPending = snapPending.approvals.find((a) => a.status === "pending");
  check("快照里有一条 pending 审批", Boolean(firstPending), firstPending ? `id=${firstPending.id}` : "无");
  check(
    "pending 的 action 是 session/request_permission（唯一事前闸门动作）",
    firstPending?.action === "session/request_permission",
    `action=${firstPending?.action}`,
  );
  check(
    "这条 pending 是本轮 prompt 触发的（createdAt 在 prompt 派发之后）",
    Boolean(firstPending && firstPending.createdAt >= promptDispatchAt),
    `createdAt=${firstPending?.createdAt} promptAt=${promptDispatchAt}`,
  );
  const firstId = firstPending?.id;
  if (!firstId) {
    await finish({ exe, target, outcome: "no-pending-id" });
    return;
  }

  const shot1 = await screenshot("packaged-ui-deny-1-pending.png");
  check("截图 1（第一个 pending + 拒绝按钮可见）写入", existsSync(shot1), shot1);

  // 7. 第一次拒绝：点 UI「拒绝」按钮
  step(`第一次拒绝：点 UI「拒绝」按钮（${firstId}）`);
  await recordDeny(firstPending, 1);

  // 8. 诱发第二次（同一动作）并再次拒绝
  const second = await provokeSecondPending(sessionId, [firstId], 240000);

  let blocked = false;
  let blockedDeadEnd = null;
  if (second) {
    step(`第二次审批出现（${second.id}，rule=${second.rule}）→ 点 UI「拒绝」按钮`);
    await recordDeny(second, 2);
    const blockedOk = await poll(
      `(async()=>{ const s = await window.bumimang.snapshot(); const c = s.sessions.find(x => x.id === ${JSON.stringify(sessionId)}); return !!c && c.status === "blocked"; })()`,
      30000,
      500,
      "会话进入 blocked 终态",
    );
    blocked = blockedOk;
  } else {
    step("第二次审批未能在预算内诱发 —— 如实记录");
  }

  // 9. 终态断言 + 截图
  const snapFinal = await getSnapshot();
  const sessFinal = snapFinal.sessions.find((s) => s.id === sessionId);
  blockedDeadEnd = snapFinal.board.deadEnds.find((d) => d.scope === "blocked");

  if (blocked) {
    await poll(
      `document.querySelector('.session-item[data-id=${JSON.stringify(sessionId)}].session-blocked') !== null`,
      10000,
      300,
      "会话卡 blocked 视觉渲染",
    );
    await poll(
      `(async()=>{ const s = await window.bumimang.snapshot(); return s.board.deadEnds.some(d => d.scope === "blocked"); })()`,
      10000,
      300,
      "台账 scope=blocked 死路出现在快照",
    );
    await sleep(600);

    const shot = await screenshot("packaged-ui-deny.png");
    const dom = await evalJs(sessionCardProbeJs(sessionId));
    const deadendsDom = await evalJs(
      `(() => Array.from(document.querySelectorAll('.deadend .deadend-desc')).map((n) => n.textContent.trim()))()`,
    );
    const deadend = snapFinal.board.deadEnds.find((d) => d.scope === "blocked");
    const incident = snapFinal.board.deadEnds.find((d) => d.scope === "incident");

    check("会话终态是 blocked（不是 failed/stopped）", sessFinal?.status === "blocked", `status=${sessFinal?.status}`);
    check("终态不是崩溃 failed", sessFinal?.status !== "failed", `status=${sessFinal?.status}`);
    check("终态不是人工停止 stopped", sessFinal?.status !== "stopped", `status=${sessFinal?.status}`);
    check(
      "台账多了一条 scope=blocked 的死路（策略切断，不是崩溃）",
      Boolean(deadend),
      deadend ? `desc=${deadend.description} by=${deadend.by}` : "无 scope=blocked 死路",
    );
    check(
      "死路文案是 L-4b 的「同一动作」（不是旧的「同一规则」）",
      Boolean(deadend && /同一动作/.test(deadend.description)),
      deadend ? deadend.description : "无",
    );
    check(
      "死路文案含「被策略拦截并终止」且指向本会话",
      Boolean(deadend && /被策略拦截/.test(deadend.description) && deadend.description.includes(sessionId)),
      deadend ? deadend.description : "无",
    );
    check("没有 scope=incident 的崩溃死路（blocked ≠ 崩溃）", !incident, incident ? `desc=${incident.description}` : "无 incident 死路（正确）");

    check("会话卡在真实窗口里渲染", dom.rendered === true);
    check("会话卡带 session-blocked 类（红边框视觉）", dom.rendered === true && dom.hasBlockedClass === true, `hasBlockedClass=${dom.hasBlockedClass}`);
    check("会话卡不带 session-failed 类（不是崩溃视觉）", dom.rendered === true && dom.hasFailedClass === false, `hasFailedClass=${dom.hasFailedClass}`);
    check("会话卡徽标文字是「被策略切断」（不是「崩溃」）", dom.rendered === true && dom.blockedText === "被策略切断", `blockedText="${dom.blockedText}"`);
    check("会话卡没有 failed 徽标", dom.rendered === true && dom.hasFailedBadge === false, `hasFailedBadge=${dom.hasFailedBadge}`);
    check("会话卡没有 stopped 徽标", dom.rendered === true && dom.hasStoppedBadge === false, `hasStoppedBadge=${dom.hasStoppedBadge}`);
    check(
      "会话卡 title 说明「策略切断」（非崩溃）",
      dom.rendered === true && typeof dom.title === "string" && dom.title.includes("策略切断"),
      `title=${dom.title}`,
    );
    check(
      "台账面板渲染出该死路（含「被策略拦截」）",
      deadendsDom.some((d) => d.includes("被策略拦截")),
      `deadends=${JSON.stringify(deadendsDom)}`,
    );
    check(
      "两次拒绝命中同一规则（tier-guarded-default，且是同一动作的两次）",
      denyEvents.length >= 2 && new Set(denyEvents.map((d) => d.rule)).size === 1 && denyEvents[0].rule === "tier-guarded-default",
      `rules=${JSON.stringify(denyEvents.map((d) => d.rule))}`,
    );

    await finish({
      exe,
      target,
      outcome: "blocked-via-ui-two-denies",
      screenshot: shot,
      sessionId,
      promptText: PROMPT_TEXT,
      retryPromptText: RETRY_PROMPT_TEXT,
      briefingDrained: drained,
      briefingApprovals,
      denyEvents,
      final: {
        sessionStatus: sessFinal?.status ?? null,
        deadEnd: deadend ? { id: deadend.id, description: deadend.description, scope: deadend.scope, by: deadend.by } : null,
        incidentDeadEnd: incident ? { description: incident.description } : null,
        sessionCardDom: dom,
        boardDeadEndsDom: deadendsDom,
      },
      wireEvidence: readWireEvidence(sessionId),
    });
  } else {
    await sleep(600);
    const shot = await screenshot("packaged-ui-deny.png");
    const dom = await evalJs(sessionCardProbeJs(sessionId));
    const deadendsDom = await evalJs(
      `(() => Array.from(document.querySelectorAll('.deadend .deadend-desc')).map((n) => n.textContent.trim()))()`,
    );
    check(
      "第一次 deny 已端到端验证（UI 按钮 → 队列 → denied）",
      denyEvents.length >= 1 && denyEvents[0].deniedStatus === "denied" && denyEvents[0].deniedBy === "human",
      JSON.stringify(denyEvents[0]),
    );
    if (second) {
      check(
        "第二次 deny 也经 UI 端到端验证（denied + human）",
        denyEvents.length >= 2 && denyEvents[1].deniedStatus === "denied" && denyEvents[1].deniedBy === "human",
        JSON.stringify(denyEvents[1]),
      );
      check(
        "两次拒绝命中同一规则（阈值 2 的语义）",
        denyEvents.length >= 2 && new Set(denyEvents.map((d) => d.rule)).size === 1 && denyEvents[0].rule === "tier-guarded-default",
        `rules=${JSON.stringify(denyEvents.map((d) => d.rule))}`,
      );
      check("markBlocked 已执行（死路 scope=blocked 已写库）", Boolean(blockedDeadEnd), blockedDeadEnd ? `desc=${blockedDeadEnd.description}` : "无 scope=blocked 死路");
      check("会话终态是 blocked（未通过 —— 打包产物里仍有 prompt() 覆盖）", false, `sessionStatus=${sessFinal?.status}`);
      await finish({
        exe,
        target,
        outcome: "two-denies-but-session-not-blocked",
        screenshot: shot,
        sessionId,
        promptText: PROMPT_TEXT,
        retryPromptText: RETRY_PROMPT_TEXT,
        briefingDrained: drained,
        briefingApprovals,
        denyEvents,
        final: {
          sessionStatus: sessFinal?.status ?? null,
          deadEnds: snapFinal.board.deadEnds.map((d) => ({ id: d.id, scope: d.scope, description: d.description })),
          sessionCardDom: dom,
          boardDeadEndsDom: deadendsDom,
        },
        wireEvidence: readWireEvidence(sessionId),
      });
    } else {
      check(
        "第二次 deny 未能在预算内诱发（如实报告，不种审批）",
        false,
        `sessionStatus=${sessFinal?.status} approvals=${snapFinal.approvals.map((a) => `${a.status}:${a.action}`).join(",")}`,
      );
      await finish({
        exe,
        target,
        outcome: "one-deny-only",
        screenshot: shot,
        sessionId,
        promptText: PROMPT_TEXT,
        retryPromptText: RETRY_PROMPT_TEXT,
        briefingDrained: drained,
        briefingApprovals,
        denyEvents,
        final: {
          sessionStatus: sessFinal?.status ?? null,
          deadEnds: snapFinal.board.deadEnds.map((d) => ({ id: d.id, scope: d.scope, description: d.description })),
          sessionCardDom: dom,
        },
        wireEvidence: readWireEvidence(sessionId),
      });
    }
  }
}

async function finish(extra = {}) {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);
  const exe = extra.exe ? statSync(extra.exe) : null;
  const evidence = {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    scheme: "CDP against packaged 不迷茫.exe (dist/win-unpacked, app.asar)",
    port: PORT,
    exe: extra.exe ?? null,
    exeMtime: exe ? new Date(exe.mtimeMs).toISOString() : null,
    agent: "claude",
    promptText: PROMPT_TEXT,
    retryPromptText: RETRY_PROMPT_TEXT,
    assertions,
    timeline,
    ...extra,
    pass,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  const jsonPath = path.join(LOGS_DIR, "packaged-ui-deny.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  console.log("\n== PACKAGED-UI-DENY · 打包产物上「UI 拒绝 → blocked」端到端 ==\n");
  for (const a of assertions) {
    console.log(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}`);
  }
  console.log(`\n证据：${jsonPath}`);
  if (extra.screenshot) console.log(`截图：${extra.screenshot}`);
  console.log(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}`);

  if (child) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  if (client) client.close();
  process.exit(pass ? 0 : 1);
}

setTimeout(() => {
  console.log("[packaged-ui-deny] 硬超时退出（600s）");
  const evidence = { timeout: true, timeline, assertions, denyEvents, briefingApprovals };
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(path.join(LOGS_DIR, "packaged-ui-deny.json"), JSON.stringify(evidence, null, 2));
  if (child) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  process.exit(9);
}, 600000);

process.on("SIGINT", () => {
  if (child) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  process.exit(130);
});

run().catch((err) => {
  console.error("[packaged-ui-deny] 异常：", err);
  finish({ error: (err && err.stack) || String(err), outcome: "exception" }).catch(() => process.exit(2));
});
