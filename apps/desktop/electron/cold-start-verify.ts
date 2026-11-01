/**
 * Lane B · R11 冷启动「陌生人 QA」验收 + 截图。
 *
 * 目的：不再以「造它的人」的眼光看界面，而是复现一个 09:00 打开空应用的新手所看到的
 * 一切，并把 R11 修的几处首次体验（中栏空状态 / 闸门已武装绿标 / 任务状态中文化 /
 * 扇出弹窗的「选哪个 agent」提示）断言 + 截屏成证据。
 *
 * 与 Lane A 的 main.ts 同款接线（PolicyEngine competition 档 + 真实 ApprovalQueue +
 * DenialTracker + SessionManager），只是工作区独立、空 board.db —— 所以首屏 = 真实
 * 冷启动：1 个自动种下的示例任务、0 会话、0 审批、黑板为空、4 家 agent 检测结果。
 *
 * 只 import、不修改 src/main（那是 Lane A 的 lane）。
 *
 * 运行（Windows，注意 stdout 必须用管道不能 `>` 重定向）：
 *   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
 *   node_modules\electron\dist\electron.exe apps/desktop/electron/cold-start-verify.ts --no-sandbox 2>&1 |
 *     Select-String -Pattern "PASS|FAIL|shot|verify\]"
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { registerRendererProtocol, RENDERER_SCHEME } from "./renderer-protocol.ts";
import { HUB_CHANNELS } from "../../../packages/shared-protocol/events.ts";
import { Blackboard } from "../src/main/blackboard/board.ts";
import { BoardBridge } from "../src/main/mcp-host/bridge.ts";
import { PolicyEngine } from "../src/main/policy/engine.ts";
import { ApprovalQueue, DenialTracker } from "../src/main/approval/queue.ts";
import { SessionManager, newRunId } from "../src/main/session/manager.ts";
import { EventBus, HubService } from "../src/main/hub/hub.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACE = path.join(REPO_ROOT, ".ui-run", "cold-start");
const LOGS_DIR = path.join(REPO_ROOT, "docs", "logs");

app.setPath("userData", path.join(REPO_ROOT, ".ui-run", "electron-profile-cold-start"));
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
let board: Blackboard | null = null;
let bridge: BoardBridge | null = null;
let sessions: SessionManager | null = null;

const consoleLogs: Array<{ level: string; message: string }> = [];
let rendererGone: string | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function cleanup(): Promise<void> {
  sessions?.shutdown();
  bridge?.stop();
  await sleep(400);
  board?.close();
}

async function bootstrap(): Promise<{ hub: HubService; bus: EventBus; taskId: string }> {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORKSPACE, { recursive: true });

  const b = Blackboard.open(path.join(WORKSPACE, "board.db"));
  board = b;

  // 与 main.ts 相同：先建任务再建桥；示例任务是主进程冷启动时自动种下的。
  const t = b.createTask({
    title: "示例任务：本地 HTML 目标",
    brief: "工作目录中的 target/index.html 是一个内部门户页面，含 /admin 登录表单。",
  });

  const runId = newRunId();
  const br = new BoardBridge({ board: b, taskId: t.id, runId });
  await br.start();
  bridge = br;

  const policy = new PolicyEngine({ repoRoot: REPO_ROOT, packId: "competition" });
  const bus = new EventBus();

  let hub!: HubService;
  let mgr!: SessionManager;
  const approvals = new ApprovalQueue({
    onUpsert: (view) => bus.emit({ type: "approval.upsert", approval: view }),
    intentSummary: (sid) => hub.intentSummary(sid),
  });
  const denials = new DenialTracker(2, (sid, rule, n) => {
    void mgr.markBlocked(sid, `同一规则被连续拒绝 ${n} 次（${rule}）`);
  });

  mgr = new SessionManager({
    board: b,
    bridge: br,
    policy,
    workspaceRoot: WORKSPACE,
    onLine: (line) => process.stdout.write(`${line}\n`),
    onStream: (sessionId, raw) => hub.publishStream(sessionId, raw),
    onSessionChange: (rec) => hub.publishSessionRec(rec),
    onApprovalRequired: async (sessionId, taskId, detail, decision) => {
      const o = await approvals.request({
        taskId,
        sessionId,
        action: "session/request_permission",
        detail,
        rule: decision.rule,
        reason: decision.reason,
      });
      if (o.decidedBy === "human" && o.decision === "denied") denials.note(sessionId, decision.rule);
      return o.decision === "approved";
    },
  });
  sessions = mgr;

  hub = new HubService({
    board: b,
    sessions: mgr,
    bus,
    workspaceRoot: WORKSPACE,
    models: {},
    approvals,
    policy,
  });
  hub.setTask(t.id);

  return { hub, bus, taskId: t.id };
}

function registerIpc(hub: HubService, bus: EventBus): void {
  ipcMain.handle(HUB_CHANNELS.snapshot, () => hub.snapshot());
  ipcMain.handle(HUB_CHANNELS.dispatch, async (_e, action: unknown) => {
    const res = await hub.dispatch(action as never);
    win?.webContents.send(HUB_CHANNELS.event, {
      type: "task.upsert",
      task: hub.snapshot().task ?? { id: "", title: "", brief: "", status: "open", answer: null, solvedBy: null, createdAt: 0 },
    });
    if (hub.currentTaskId) hub.publishBoardSince(0);
    return res;
  });
  bus.on((e) => {
    win?.webContents.send(HUB_CHANNELS.event, e);
  });
}

async function createWindow(hub: HubService, bus: EventBus): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#f6f8fa",
    title: "不迷茫",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { level?: string | number; message?: string } | undefined;
    const legacyMessage = args[2] as string | undefined;
    const message = typeof ev?.message === "string" ? ev.message : (legacyMessage ?? String(args[2] ?? ""));
    const level = ev?.level ?? args[1] ?? "log";
    consoleLogs.push({ level: String(level), message });
  });
  win.webContents.on("render-process-gone", (_e, details: { reason: string }) => {
    rendererGone = details.reason;
  });

  registerIpc(hub, bus);
  registerRendererProtocol();
  await win.loadURL(`${RENDERER_SCHEME}://./renderer.html`);
}

async function evalJs<T>(js: string): Promise<T> {
  return (await win!.webContents.executeJavaScript(js, true)) as T;
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

/** 冷启动首屏 DOM 探针：一个新手打开空应用看到的一切。 */
const COLD_PROBE_JS = `(async () => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (s) => q(s) ? (q(s).textContent || "").trim() : null;
  const snap = await window.bumimang.snapshot();
  return {
    hasBridge: typeof window.bumimang === "object" && window.bumimang !== null,
    cols: qa("#app > .col").length,
    taskTitle: txt(".task-title"),
    taskStatus: txt(".task-status-badge"),
    policyLabel: txt(".policy-pack-label"),
    policyName: txt(".policy-pack-name"),
    policyArmed: txt(".policy-pack-armed"),
    policyFallback: txt(".policy-pack-fallback"),
    sessionEmptyTitle: txt(".session-empty-title"),
    sessionEmptyHint: txt(".session-empty-hint"),
    agentsSummary: txt(".agents-summary"),
    plusText: txt(".btn-plus"),
    plusHint: txt(".btn-plus-hint"),
    plusPrimary: !!q(".btn-plus.btn-plus-primary"),
    centerEmptyTitle: txt(".pane-empty-title"),
    centerEmptyDesc: txt(".pane-empty-desc"),
    approvalEmptyTitle: txt(".ap-empty-title"),
    approvalGateName: txt(".ap-empty-gate-name"),
    approvalReasonLead: txt(".ap-empty-reason-lead"),
    boardEmptyTitle: txt(".board-empty-title"),
    boardEmptyDesc: txt(".board-empty-desc"),
    snapTask: !!snap.task,
    snapSessions: snap.sessions.length,
    snapApprovals: snap.approvals.length,
    snapAgents: snap.agents.length,
    snapPolicyName: snap.policy ? snap.policy.name : null,
    snapPolicyFellBack: snap.policy ? snap.policy.fellBackToMinimal : null,
    snapAgentBehavior: Object.fromEntries(snap.agents.map((a) => [a.id, a.permissionBehavior ?? null])),
  };
})()`;

/** 点加号 → 扇出弹窗探针：agent 下拉 + 「选哪个 agent」提示；选中 claude / codex 验证闸门行为提示来自快照。 */
const FANOUT_PROBE_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const plus = q(".btn-plus");
  if (!plus) return { opened: false };
  plus.click();
  const overlay = q(".fanout-overlay");
  if (!overlay) return { opened: false };
  const selects = Array.from(overlay.querySelectorAll(".fanout-select"));
  const agentSel = selects[0];
  const options = agentSel ? Array.from(agentSel.options).map((o) => ({ v: o.value, disabled: o.disabled })) : [];
  const enabled = options.filter((o) => !o.disabled).map((o) => o.v);
  const disabled = options.filter((o) => o.disabled).map((o) => o.v);
  const detail = () => overlay.querySelector(".fanout-agent-detail") ? overlay.querySelector(".fanout-agent-detail").textContent.trim() : null;
  const gateNote = overlay.querySelector(".fanout-gate-note") ? overlay.querySelector(".fanout-gate-note").textContent.trim() : null;
  const defaultDetail = detail();
  // 选中 claude：验证「会主动请求授权」这一行来自快照的 permissionBehavior（requests_by_default），
  // 而不是渲染层旧的硬编码（R-4 之前是「只有 Claude Code 开箱会问」）。
  let claudeDetail = null;
  if (agentSel && options.some((o) => o.v === "claude" && !o.disabled)) {
    agentSel.value = "claude";
    agentSel.dispatchEvent(new Event("change"));
    claudeDetail = detail();
  }
  // 选中 codex：验证 requests_by_default 的「会主动请求授权」（B-3 续之后 codex 也武装了）。
  let codexDetail = null;
  if (agentSel && options.some((o) => o.v === "codex" && !o.disabled)) {
    agentSel.value = "codex";
    agentSel.dispatchEvent(new Event("change"));
    codexDetail = detail();
  }
  const cancel = overlay.querySelector(".btn-cancel");
  if (cancel) cancel.click();
  return { opened: true, selectCount: selects.length, enabled, disabled, gateNote, agentDetail: defaultDetail, claudeDetail, codexDetail };
})()`;

/** R-3 探针：点「＋ 新任务」→ 填标题 + 简报 → 创建 → 等 task.upsert 重绘 → 回读快照与 DOM。 */
const TASK_CREATE_PROBE_JS = `(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = await window.bumimang.snapshot();
  const btn = q(".btn-task-new");
  if (!btn) return { opened: false, reason: "no-btn" };
  btn.click();
  const overlay = q(".task-overlay");
  if (!overlay) return { opened: false, reason: "no-overlay" };
  const titleInput = overlay.querySelector(".task-form-input[type='text']");
  const briefInput = overlay.querySelector("textarea.task-form-brief");
  if (!titleInput || !briefInput) return { opened: false, reason: "no-inputs" };
  const title = "真任务：10.0.0.13 门户打点";
  const brief = "目标 10.0.0.13 是门户首页，边界内允许打点，找 flag 并提交。";
  titleInput.value = title;
  briefInput.value = brief;
  overlay.querySelector(".btn-approve").click();
  // 等主进程 setTask + task.upsert → store → renderLeft 重绘出新标题（最多 5s）。
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    const t = q(".task-title");
    if (t && t.textContent.trim() === title) break;
  }
  const after = await window.bumimang.snapshot();
  return {
    opened: true,
    beforeId: before.task ? before.task.id : null,
    beforeTitle: before.task ? before.task.title : null,
    afterId: after.task ? after.task.id : null,
    afterTitle: after.task ? after.task.title : null,
    afterBrief: after.task ? after.task.brief : null,
    afterStatus: after.task ? after.task.status : null,
    domTitle: q(".task-title") ? q(".task-title").textContent.trim() : null,
    domBrief: q(".task-brief") ? q(".task-brief").textContent.trim() : null,
    domStatus: q(".task-status-badge") ? q(".task-status-badge").textContent.trim() : null,
  };
})()`;

async function runVerify(): Promise<void> {
  const ready = await pollUntil(
    `(async () => {
      if (typeof window.bumimang !== "object" || window.bumimang === null) return false;
      return document.querySelectorAll("#app > .col").length === 3 &&
             document.querySelector(".policy-pack") !== null &&
             document.querySelector(".session-empty-title") !== null;
    })()`,
    12000,
    100,
  );
  check("冷启动：真实桥 + 三栏 + 空状态在 12s 内就绪", ready);

  const p = await evalJs<Record<string, unknown>>(COLD_PROBE_JS);

  // —— 一个新手看到的冷启动 ——
  check("快照：0 会话 / 0 审批 / 4 家 agent / 有任务", p.snapSessions === 0 && p.snapApprovals === 0 && p.snapAgents === 4 && p.snapTask === true, `sessions=${p.snapSessions} approvals=${p.snapApprovals} agents=${p.snapAgents}`);
  check("R-2/R-4/T14：快照带 permissionBehavior（四家都 = requests_by_default，dsh 已按档武装）",
    (p.snapAgentBehavior as Record<string, unknown>)?.claude === "requests_by_default" &&
    (p.snapAgentBehavior as Record<string, unknown>)?.opencode === "requests_by_default" &&
    (p.snapAgentBehavior as Record<string, unknown>)?.codex === "requests_by_default" &&
    (p.snapAgentBehavior as Record<string, unknown>)?.dsh === "requests_by_default",
    `behavior=${JSON.stringify(p.snapAgentBehavior)}`);
  check("三栏画出来", p.cols === 3);
  check("任务：自动种下的示例任务可见", p.taskTitle === "示例任务：本地 HTML 目标", `task="${p.taskTitle}"`);
  check("R11：任务状态不是英文枚举 open（已中文化）", typeof p.taskStatus === "string" && (p.taskStatus as string).includes("待解"), `status="${p.taskStatus}"`);
  check("R11：规则包徽标带「已武装」绿标", p.policyArmed === "已武装", `armed="${p.policyArmed}"`);
  check("规则包徽标显示真实包名（非「—」）", typeof p.policyName === "string" && (p.policyName as string).length > 0 && p.policyName !== "—", `name="${p.policyName}"`);
  check("未回落最小安全集 → 无回落小字", p.policyFallback === null);
  check("会话空状态：「还没有会话」", p.sessionEmptyTitle === "还没有会话");
  check("引擎可用性摘要（4 家全部可用 —— T14 之后 dsh 也装上了）", p.agentsSummary === "引擎可用 4 · 未安装 0", `summary="${p.agentsSummary}"`);
  check("加号是 primary 且「起第一个会话」", p.plusPrimary === true && p.plusHint === "起第一个会话", `hint="${p.plusHint}"`);
  check("R11：中栏不再空白，有「还没有会话窗格」说明", typeof p.centerEmptyTitle === "string" && (p.centerEmptyTitle as string).length > 0 && (p.centerEmptyDesc as string).includes("扇出"), `title="${p.centerEmptyTitle}"`);
  check("审批空状态：「暂无待审批」+ 亮规则包", p.approvalEmptyTitle === "暂无待审批" && typeof p.approvalGateName === "string" && (p.approvalGateName as string).length > 0, `gate="${p.approvalGateName}"`);
  check("审批空状态交代两种可能", typeof p.approvalReasonLead === "string" && (p.approvalReasonLead as string).length > 0, `lead="${p.approvalReasonLead}"`);
  check("台账空状态：「黑板为空」", p.boardEmptyTitle === "黑板为空" && typeof p.boardEmptyDesc === "string" && (p.boardEmptyDesc as string).length > 0);

  mkdirSync(LOGS_DIR, { recursive: true });
  const shot = await screenshot("cold-start.png");
  check("冷启动截图写入 docs/logs/cold-start.png", shot.length > 0, shot);

  // —— 点加号 → 扇出弹窗（新手选 agent 的关口）——
  const fanout = await evalJs<Record<string, unknown>>(FANOUT_PROBE_JS);
  const enabled = (fanout.enabled as string[]) ?? [];
  const disabled = (fanout.disabled as string[]) ?? [];
  check("扇出弹窗能打开，且恰好 3 个下拉（agent/角色/档位）", fanout.opened === true && fanout.selectCount === 3);
  check("agent 下拉 4 家全部可用（opencode/codex/claude/dsh，dsh 不再是灰显）", enabled.length === 4 && disabled.length === 0, `enabled=${JSON.stringify(enabled)} disabled=${JSON.stringify(disabled)}`);
  check("R-4：弹窗「选哪个 agent」提示由 permissionBehavior 现算（opencode 并入会问、不再写「只有」）", typeof fanout.gateNote === "string" && (fanout.gateNote as string).includes("会主动请求授权") && (fanout.gateNote as string).includes("OpenCode") && (fanout.gateNote as string).includes("Codex") && !(fanout.gateNote as string).includes("只有"), `note="${fanout.gateNote}"`);
  check("R11：选中 agent 的成熟度一行带上闸门行为", typeof fanout.agentDetail === "string" && (fanout.agentDetail as string).length > 0, `detail="${fanout.agentDetail}"`);
  check("R-4：默认选中的 opencode 带「会主动请求授权」（requests_by_default，来自快照）", typeof fanout.agentDetail === "string" && (fanout.agentDetail as string).includes("会主动请求授权"), `detail="${fanout.agentDetail}"`);
  check("R-4：选中 claude 带「会主动请求授权」（requests_by_default，来自快照）", typeof fanout.claudeDetail === "string" && (fanout.claudeDetail as string).includes("会主动请求授权"), `detail="${fanout.claudeDetail}"`);
  check("R-4：选中 codex 带「会主动请求授权」（requests_by_default，来自快照）", typeof fanout.codexDetail === "string" && (fanout.codexDetail as string).includes("会主动请求授权"), `detail="${fanout.codexDetail}"`);

  // —— R-3：新手把自己的真实挑战换成自动种下的示例任务 ——
  const tc = await evalJs<Record<string, unknown>>(TASK_CREATE_PROBE_JS);
  check("R-3：左栏任务卡有「＋ 新任务」入口，点开能出表单", tc.opened === true, `opened=${tc.opened} reason=${tc.reason ?? "—"}`);
  check("R-3：新建任务后 snapshot.task 换成新任务（id 变化，标题/简报正确）",
    typeof tc.afterId === "string" && tc.afterId.length > 0 && tc.afterId !== tc.beforeId &&
    tc.afterTitle === "真任务：10.0.0.13 门户打点" &&
    tc.afterBrief === "目标 10.0.0.13 是门户首页，边界内允许打点，找 flag 并提交。",
    `id ${tc.beforeId} → ${tc.afterId}`);
  check("R-3：左栏任务卡同步重绘出新标题与新简报", tc.domTitle === "真任务：10.0.0.13 门户打点" && tc.domBrief === "目标 10.0.0.13 是门户首页，边界内允许打点，找 flag 并提交。", `title="${tc.domTitle}"`);
  check("R-3：新任务状态中文化（open → 待解）", typeof tc.domStatus === "string" && (tc.domStatus as string).includes("待解"), `status="${tc.domStatus}"`);
  const taskShot = await screenshot("cold-start-task-created.png");
  check("R-3：新任务截图写入 docs/logs/cold-start-task-created.png", taskShot.length > 0, taskShot);

  const pass = assertions.every((a) => a.pass);
  const failed = assertions.filter((a) => !a.pass);
  const evidence = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    bridge: "real (window.bumimang via preload.cjs)",
    scheme: `${RENDERER_SCHEME}://./renderer.html`,
    screenshot: shot,
    probe: p,
    fanout,
    taskCreate: tc,
    assertions,
    consoleLogs,
    rendererGone,
    pass,
  };
  writeFileSync(path.join(LOGS_DIR, "cold-start.json"), JSON.stringify(evidence, null, 2));

  process.stdout.write("\n== COLD-START-VERIFY · 冷启动新手 QA ==\n\n");
  for (const a of assertions) {
    process.stdout.write(`${a.pass ? "PASS" : "FAIL"}  ${a.name}${a.detail ? "  └─ " + a.detail : ""}\n`);
  }
  process.stdout.write(`\n截图：${shot}\n新任务截图：${taskShot}\n证据：${path.join(LOGS_DIR, "cold-start.json")}\n`);
  if (rendererGone) process.stdout.write(`\nrender-process-gone: ${rendererGone}\n`);
  process.stdout.write(`\n${pass ? "ALL_PASS" : `${failed.length} FAILED`}\n`);

  await cleanup();
  app.exit(pass ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    const { hub, bus } = await bootstrap();
    await createWindow(hub, bus);
    await sleep(800);
    await runVerify();
  } catch (err) {
    process.stdout.write(`[verify] 异常退出：${(err as Error).stack ?? String(err)}\n`);
    await cleanup();
    app.exit(2);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  void cleanup();
});

setTimeout(() => {
  process.stdout.write("[verify] 硬超时退出（90s）\n");
  mkdirSync(LOGS_DIR, { recursive: true });
  void cleanup().then(() => app.exit(9));
}, 90000);
