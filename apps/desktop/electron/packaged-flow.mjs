/**
 * Lane B · 第 18 轮 · 打包态真实用户流程（R8）。
 *
 * 为什么存在：打包态此前只验过两件事 —— Lane A 的 `--verify`（主进程自己
 * executeJavaScript 出来的 11 条自检，没有人眼/真实点击）和 R16 的 CDP 静态探针
 * （只截首屏、只查样式）。从来没有人把一个**真实用户流程**在打包产物上走完：
 *
 *   点「＋ 新任务」→ 填真实标题 + 简报 → 确认新任务变当前
 *     → 点「＋ 扇出会话」选 claude + guarded → 等简报轮
 *     → 看会话窗格实时流 + 健康度走动 → 审批出现 → UI 上决定 → UI 反映决定
 *
 * 而且打包态的数据落在 `%APPDATA%\bumimang\`（不是仓库，app.asar 只读），任何路径
 * 假设错了都只有真人驱动打包产物才会现形。本脚本顺带断言了这一点（board.db / wire.jsonl
 * 都必须在 %APPDATA% 下）。
 *
 * 做法（零 mock、零 import src/main）：把 `dist\win-unpacked\不迷茫.exe` 拉起来
 * （--remote-debugging-port），用 CDP 连上**真实 app.asar 渲染进程**，做真实 DOM
 * 点击（.click() 走它自己的监听器 → ctx.hub.dispatch → 真实 IPC），不是
 * window.bumimang.dispatch 直发。每一步截图 + 断言，证据写 docs/logs/packaged-flow.json。
 *
 * 运行（Windows，Node ≥24，需先 npm run pack 出产物）：
 *   node apps/desktop/electron/packaged-flow.mjs 9333
 *
 * 脚本自己会先 taskkill 残留的「不迷茫.exe」，结束后按 PID 清掉自己拉起的进程。
 * 若端口被占、或前次运行卡死留下进程，先手工：
 *   taskkill /F /T /IM "不迷茫.exe"
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");
const PORT = Number(process.argv[2] ?? 9333);
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

/** 真实标题 + 简报。简报是重点：会被注入每个会话的简报包，简报轮里 claude 就会动手。 */
const NEW_TITLE = "打包态真实用户流程 · 端到端冒烟";
const NEW_BRIEF =
  "请在当前目录创建一个名为 packaged-flow.txt 的文本文件，内容写一行 packaged flow ok。这是唯一任务，完成后就结束。";

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
function findPackagedExe() {
  const dir = path.join(REPO_ROOT, "dist", "win-unpacked");
  const exes = readdirSync(dir).filter(
    (f) => f.endsWith(".exe") && !/elevate|setup|update|uninstall/i.test(f),
  );
  if (exes.length === 0) throw new Error(`在 ${dir} 没找到打包 exe（先 npm run pack）`);
  return path.join(dir, exes[0]);
}

// ---------------------------------------------------------------- CDP 客户端
async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return res.json();
}

async function findPageTarget(waitMs = 90000) {
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

async function screenshot(name) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(shot.data, "base64");
  const p = path.join(LOGS_DIR, name);
  writeFileSync(p, png);
  step(`截图 ${name}（${png.length} bytes）`);
  return p;
}

// ---------------------------------------------------------------- 主流程
async function run() {
  // 0. 清残留（best effort；失败也继续）
  try {
    spawnSync("taskkill", ["/F", "/T", "/IM", "不迷茫.exe"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(500);

  const exe = findPackagedExe();
  step(`启动打包产物：${exe}（--no-sandbox --remote-debugging-port=${PORT}）`);
  const logStream = createWriteStream(path.join(LOGS_DIR, "packaged-flow-run.log"));
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
    check("打包 exe 的渲染进程页面目标可达（CDP）", false, "90s 内没找到 renderer 页面");
    await finish({ exe, target: null, outcome: "no-cdp-target" });
    return;
  }
  client = cdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable").catch(() => {});
  await client.send("Page.enable").catch(() => {});

  // 2. 等首屏就绪（真实 IPC + 三栏）
  const ready = await poll(
    `(async()=>{ return typeof window.bumimang === "object" && window.bumimang !== null && document.querySelectorAll("#app > .col").length === 3; })()`,
    30000,
    300,
    "首屏就绪（真实桥 + 三栏）",
  );
  check("打包态窗口就绪（window.bumimang 真实 IPC + 三栏渲染）", ready);

  const snapInit = await getSnapshot();
  const claudeDesc = snapInit.agents.find((a) => a.id === "claude");
  check(
    "快照里有 4 家 agent 检测结果且 claude 已安装可用",
    snapInit.agents.length >= 3 && claudeDesc?.installed === true,
    `agents=${snapInit.agents.map((a) => `${a.id}${a.installed ? "" : "(未装)"}`).join(",")}`,
  );
  step(`初始任务：${snapInit.task?.title ?? "（无）"}`);

  const shot1 = await screenshot("packaged-flow-1-initial.png");
  check("截图 1（打包态首屏）写入", existsSync(shot1), shot1);

  // 3. 「＋ 新任务」→ 填标题 + 简报 → 创建并切换
  step(`点「＋ 新任务」按钮（.btn-task-new）`);
  await evalJs(`document.querySelector('.btn-task-new').click()`);
  const taskModalOk = await poll(`document.querySelector('.task-modal') !== null`, 8000, 200, "任务弹窗出现");
  check("「＋ 新任务」弹窗打开", taskModalOk);

  await evalJs(`(() => {
    const title = document.querySelector('.task-modal .task-form-input');
    const brief = document.querySelector('.task-modal .task-form-brief');
    if (!title || !brief) return false;
    title.value = ${JSON.stringify(NEW_TITLE)};
    brief.value = ${JSON.stringify(NEW_BRIEF)};
    title.dispatchEvent(new Event('input', { bubbles: true }));
    brief.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.task-modal .btn-approve').click();
    return true;
  })()`);
  step(`填了标题 + 简报，点了「创建并切换」`);

  const taskChanged = await poll(
    `(async()=>{ const s = await window.bumimang.snapshot(); return s.task && s.task.title === ${JSON.stringify(NEW_TITLE)}; })()`,
    15000,
    300,
    "新任务变当前（快照 task.title 更新）",
  );
  const taskDom = await evalJs(`document.querySelector('.task-title')?.textContent?.trim() ?? null`);
  check("新任务变当前（快照 task.title）", taskChanged, `title="${snapInit.task?.title}" → "${NEW_TITLE}"`);
  check("左栏任务卡 DOM 显示新标题", taskDom === NEW_TITLE, `DOM="${taskDom}"`);

  const shot2 = await screenshot("packaged-flow-2-task-created.png");
  check("截图 2（新任务已创建）写入", existsSync(shot2), shot2);

  // 4. 「＋ 扇出会话」→ 选 claude + lead + guarded → 扇出
  step(`点「＋ 扇出会话」按钮（.btn-plus）`);
  await evalJs(`document.querySelector('.btn-plus').click()`);
  const fanoutOk = await poll(`document.querySelector('.fanout-modal') !== null`, 8000, 200, "扇出弹窗出现");
  check("「＋ 扇出会话」弹窗打开", fanoutOk);

  await evalJs(`(() => {
    const selects = document.querySelectorAll('.fanout-modal .fanout-select');
    if (selects.length < 3) return false;
    const agent = selects[0], role = selects[1], tier = selects[2];
    agent.value = "claude"; agent.dispatchEvent(new Event('change', { bubbles: true }));
    role.value = "lead";   role.dispatchEvent(new Event('change', { bubbles: true }));
    tier.value = "guarded"; tier.dispatchEvent(new Event('change', { bubbles: true }));
    return { agent: agent.value, role: role.value, tier: tier.value };
  })()`).then((sel) => step(`扇出选择：${JSON.stringify(sel)}`));

  const shot3 = await screenshot("packaged-flow-3-fanout.png");
  check("截图 3（扇出弹窗已选 claude/guarded）写入", existsSync(shot3), shot3);

  step(`点「扇出」确认按钮（.fanout-modal .btn-approve）`);
  await evalJs(`document.querySelector('.fanout-modal .btn-approve').click()`);

  const sessionAppeared = await poll(
    `(async()=>{ const s = await window.bumimang.snapshot(); return s.sessions.some(x => x.agent === "claude"); })()`,
    150000,
    1000,
    "claude 会话出现在快照（spawn + ACP 握手）",
  );
  check("claude 会话已创建（快照出现 agent=claude 会话）", sessionAppeared);

  const sessSnap = await getSnapshot();
  const sess = sessSnap.sessions.find((x) => x.agent === "claude");
  if (!sess) {
    check("拿到 claude 会话 id", false, JSON.stringify(sessSnap.sessions.map((s) => `${s.agent}:${s.status}`)));
    await finish({ exe, target, outcome: "no-session", finalSnapshot: sessSnap });
    return;
  }
  const sessionId = sess.id;
  check(
    "会话档位是 guarded（扇出选择生效）",
    sess.tier === "guarded",
    `agent=${sess.agent} role=${sess.role} tier=${sess.tier}`,
  );
  step(`会话 id=${sessionId} status=${sess.status}`);

  const shot4 = await screenshot("packaged-flow-4-session-started.png");
  check("截图 4（会话窗格已出现）写入", existsSync(shot4), shot4);

  // 5. 简报轮：等实时流 + 健康度走动 + 审批（有就 UI 决定）
  const healthStartDom = await evalJs(
    `document.querySelector('.pane-health[data-session=${JSON.stringify(sessionId)}]')?.textContent ?? null`,
  );
  const healthStartSnap = (await getSnapshot()).health[sessionId] ?? null;
  step(`健康度起点：DOM="${healthStartDom}" snapshot=${JSON.stringify(healthStartSnap)}`);

  let streamLines = 0;
  let streamSample = [];
  const decisions = [];
  let sawApproval = false;
  let idle = false;
  const budget = Date.now() + 240000; // 简报轮预算 4 分钟

  while (Date.now() < budget) {
    // 读流
    const sp = await evalJs(`(() => {
      const pane = document.querySelector('.pane[data-session=${JSON.stringify(sessionId)}]');
      if (!pane) return { lines: 0, sample: [] };
      const lines = Array.from(pane.querySelectorAll('.conv-block'));
      return { lines: lines.length, sample: lines.slice(0, 6).map((l) => l.textContent.trim()) };
    })()`);
    if (sp.lines > streamLines) {
      streamLines = sp.lines;
      streamSample = sp.sample;
    }

    // 处理审批：有 pending 就 UI 点「放行」
    const snap = await getSnapshot();
    const pending = snap.approvals.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      sawApproval = true;
      if (!decisions.some((d) => d.id === pending[0].id)) {
        step(`审批出现：${pending[0].id} rule=${pending[0].rule} cmd=${(pending[0].command ?? pending[0].action).slice(0, 80)}`);
      }
      for (const a of pending) {
        const done = decisions.find((d) => d.id === a.id);
        if (done) continue;
        const clickOk = await evalJs(`(() => {
          const card = document.querySelector('.ap-card.ap-pending[data-id=${JSON.stringify(a.id)}]');
          if (!card) return false;
          const btn = card.querySelector('[data-act="approve"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        const decided = await poll(
          `(async()=>{ const s = await window.bumimang.snapshot(); const x = s.approvals.find(v => v.id === ${JSON.stringify(a.id)}); return !!x && x.status === "approved"; })()`,
          15000,
          250,
          `审批 ${a.id} UI 放行生效`,
        );
        const after = (await getSnapshot()).approvals.find((v) => v.id === a.id);
        decisions.push({
          id: a.id,
          action: a.action,
          command: a.command,
          rule: a.rule,
          risk: a.risk,
          clickOk,
          decided,
          status: after?.status ?? null,
          decidedBy: after?.decidedBy ?? null,
        });
        if (sawApproval && decisions.length === 1) {
          const shot5 = await screenshot("packaged-flow-5-approval-decided.png");
          check("截图 5（审批已 UI 决定）写入", existsSync(shot5), shot5);
        }
      }
      continue; // 审批处理完立刻再查，不 sleep
    }

    // 终态判定
    const c = snap.sessions.find((x) => x.id === sessionId);
    if (c && ["idle", "blocked", "failed", "stopped", "done"].includes(c.status) && pending.length === 0) {
      idle = c.status === "idle";
      step(`会话进入终态：${c.status}`);
      break;
    }
    await sleep(2000);
  }

  // —— 流断言 ——
  check("会话窗格有真实流输出（.conv-block > 0）", streamLines > 0, `${streamLines} 块`);
  check(
    "流内容不是空壳（样本行含时间戳 + 类型标签）",
    streamSample.length > 0 && streamSample.some((l) => /\d{2}:\d{2}:\d{2}/.test(l)),
    `样本=${JSON.stringify(streamSample)}`,
  );

  // —— 健康度断言 ——
  const healthEndSnap = (await getSnapshot()).health[sessionId] ?? null;
  const healthEndDom = await evalJs(
    `document.querySelector('.pane-health[data-session=${JSON.stringify(sessionId)}]')?.textContent ?? null`,
  );
  const toolCallsStart = healthStartSnap?.toolCalls ?? 0;
  const toolCallsEnd = healthEndSnap?.toolCalls ?? 0;
  check(
    "健康度走动：snapshot 里 toolCalls 从 0 涨到 > 0（真实工具调用被计数）",
    toolCallsEnd > 0 && toolCallsEnd >= toolCallsStart,
    `toolCalls ${toolCallsStart} → ${toolCallsEnd}`,
  );
  check(
    "健康度走动：窗格健康指示从「同步 N/A」变成带数字（DOM 视觉）",
    healthStartDom !== healthEndDom && healthEndDom !== null && healthEndDom !== "同步 N/A",
    `DOM "${healthStartDom}" → "${healthEndDom}"`,
  );

  // —— 审批断言 ——
  if (sawApproval) {
    check(
      "审批出现且全部经 UI「放行」决定（真实按钮点击，不是直发 dispatch）",
      decisions.length > 0 && decisions.every((d) => d.clickOk === true && d.decided === true),
      `${decisions.length} 条`,
    );
    check(
      "审批决定由 human 落库（decidedBy=human），UI 反映决定",
      decisions.every((d) => d.status === "approved" && d.decidedBy === "human"),
      `status=${decisions.map((d) => d.status).join(",")} decidedBy=${decisions.map((d) => d.decidedBy).join(",")}`,
    );
    const decidedDom = await evalJs(`(() => Array.from(document.querySelectorAll('.ap-card.ap-decided .ap-status')).map((n) => n.textContent.trim()))()`);
    check(
      "审批队列 DOM 渲染出已决卡片（UI 反映决定）",
      decidedDom.length > 0 && decidedDom.some((t) => t.includes("已放行") || t.includes("已拒绝")),
      `已决卡片状态=${JSON.stringify(decidedDom)}`,
    );
  } else {
    check("审批在简报轮出现", false, "如实记录：本流程未出现审批（claude 未请求授权）");
  }

  // 6. 终态 + 路径断言（打包态必须写 %APPDATA%\bumimang\，不是仓库）
  const finalSnap = await getSnapshot();
  const finalSess = finalSnap.sessions.find((x) => x.id === sessionId);
  check("会话在终态快照里存在", Boolean(finalSess), `status=${finalSess?.status}`);
  check("任务标题仍是新建的标题（未被覆盖）", finalSnap.task?.title === NEW_TITLE, finalSnap.task?.title);

  const shot6 = await screenshot("packaged-flow-6-final.png");
  check("截图 6（终态）写入", existsSync(shot6), shot6);

  // —— 打包态路径（本轮的「为什么重要」）——
  const wsDir = path.join(APPDATA, "bumimang", "workspace");
  const boardDb = path.join(wsDir, "board.db");
  const sessionDir = path.join(wsDir, "sessions", sessionId);
  const wirePath = path.join(sessionDir, "wire.jsonl");
  const artifactPath = path.join(sessionDir, "packaged-flow.txt");
  check(
    "board.db 落在 %APPDATA%\\bumimang\\workspace\\（不在仓库）",
    existsSync(boardDb),
    boardDb,
  );
  check(
    "会话 wire.jsonl 落在 %APPDATA%\\bumimang\\workspace\\sessions\\<id>\\（打包态可写）",
    existsSync(wirePath),
    wirePath,
  );
  let wireHasActivity = false;
  if (existsSync(wirePath)) {
    const wire = readFileSync(wirePath, "utf8");
    wireHasActivity = /session\/update|request_permission|agent_message|tool_call/.test(wire);
  }
  check(
    "wire.jsonl 里有真实 claude 活动（session/update 或 request_permission）",
    wireHasActivity,
    `wire.jsonl 命中关键行=${wireHasActivity}`,
  );
  check(
    "claude 真的产出了 packaged-flow.txt（简报轮真实产出落盘）",
    existsSync(artifactPath),
    artifactPath,
  );

  await finish({
    exe,
    target: { url: target.url, title: target.title },
    outcome: idle ? "complete-idle" : "complete-terminal",
    sawApproval,
    sessionId,
    newTitle: NEW_TITLE,
    newBrief: NEW_BRIEF,
    initialTaskTitle: snapInit.task?.title ?? null,
    stream: { lines: streamLines, sample: streamSample },
    health: { startDom: healthStartDom, endDom: healthEndDom, start: healthStartSnap, end: healthEndSnap },
    decisions,
    paths: {
      appdata: APPDATA,
      boardDb,
      wirePath,
      artifactPath,
      boardDbExists: existsSync(boardDb),
      wireExists: existsSync(wirePath),
      artifactExists: existsSync(artifactPath),
    },
    finalSession: finalSess ?? null,
    screenshots: [shot1, shot2, shot3, shot4, shot6],
  });
}

async function finish(extra = {}) {
  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);
  const evidence = {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    scheme: "CDP against packaged 不迷茫.exe (dist/win-unpacked)",
    port: PORT,
    assertions,
    timeline,
    ...extra,
    pass,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  const jsonPath = path.join(LOGS_DIR, "packaged-flow.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  console.log("\n== PACKAGED-FLOW · 打包态真实用户流程 ==\n");
  for (const a of assertions) {
    console.log(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}`);
  }
  console.log(`\n证据：${jsonPath}`);
  console.log(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}`);

  // 清掉自己拉起的进程
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

// 兜底：任何情况 8 分钟内必须退出，避免挂死留下残留进程。
setTimeout(() => {
  console.log("[packaged-flow] 硬超时退出（480s）");
  const evidence = { timeout: true, timeline, assertions };
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(path.join(LOGS_DIR, "packaged-flow.json"), JSON.stringify(evidence, null, 2));
  if (child) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  process.exit(9);
}, 480000);

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
  console.error("[packaged-flow] 异常：", err);
  finish({ error: (err && err.stack) || String(err), outcome: "exception" }).catch(() => process.exit(2));
});
