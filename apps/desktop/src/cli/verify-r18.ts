/**
 * R18 确定性验收 —— 三个已复现问题的回归。
 *
 *  A. 多任务焦点（P1-B/P1-C 行为变更）：切任务只切 UI 焦点，旧会话继续运行；
 *     旧任务的延迟回调必须带 taskId，渲染层丢弃非焦点事件；
 *     P1-C 起旧任务的 start/prompt 允许（任意非归档任务），stop/interrupt 仍只允许焦点。
 *  B. 关闭没有超时：agent 卡在待批、且无视 session/close 时，session.stop
 *     必须先拒审批，再在 5 秒内返回并收掉进程。
 *  C. 正常退出竞态：shutdown 必须等进程真退出、状态落成 stopped 之后，
 *     调用方才能关库；不能出现 database is not open / incident。
 *  C2. 故障注入 kill 无效：shutdown 在统一总预算内返回 timedOut，先完成
 *     状态/租约/intent 收尾并 disposed，关库后的迟到 exit 不得再碰 board。
 *  D. 停止多个会话后 wire.jsonl 句柄不随历史增长。
 *  E. spawn ENOENT 不掀主进程；关闭后的请求快速 reject、不挂 pending。
 *
 * 用法：npm run verify:r18
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import { SessionManager } from "../main/session/manager.ts";
import { AcpClient } from "../main/acp/client.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { applyEvent, emptyState } from "../renderer/store.ts";
import type {
  ApprovalView,
  HubEvent,
  SessionView,
  TaskView,
} from "../../../../packages/shared-protocol/events.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "r18");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FAKE_AGENT = join(HERE, "fake-agent.ts");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  check(`等待条件超时：${label}`, false, `${timeoutMs}ms`);
  return false;
}

/** 整个套件共享：正常退出路径不应留下未处理的数据库错误。 */
const asyncErrors: string[] = [];
process.on("unhandledRejection", (reason) => {
  asyncErrors.push(String((reason as Error)?.message ?? reason));
});

function fakeSpec(env: Record<string, string>, cwd: string) {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd,
    env,
    label: "fake-agent",
  };
}

function taskView(id: string): TaskView {
  return {
    id,
    title: "t",
    brief: "b",
    status: "open",
    answer: null,
    solvedBy: null,
    createdAt: 0,
  };
}

function sessionView(id: string, taskId: string): SessionView {
  return {
    id,
    taskId,
    agent: "claude",
    role: "lead",
    tier: "guarded",
    status: "idle",
    acpSession: "acp-x",
    pid: null,
    model: null,
    startedAt: 0,
    endedAt: null,
  };
}

// ---------------------------------------------------------------- A 事件隔离

async function partA(): Promise<void> {
  console.log("\n================ A 切任务只切焦点，旧事件带 taskId ================\n");
  const dir = join(WORK, "a");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const promptOut = join(dir, "prompts.jsonl");

  const board = Blackboard.open(join(dir, "board.db"));
  const taskA = board.createTask({ title: "旧任务", brief: "切走后旧回调迟到" });
  const taskB = board.createTask({ title: "新任务", brief: "不能看到旧任务事件" });
  const bridge = new BoardBridge({ board, taskId: taskA.id, runId: `r18-a-${randomUUID()}` });
  await bridge.start();

  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));

  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => {
      hub.publishSessionRec(rec);
      hub.publishHealth(rec.id);
    },
  });
  const spec = fakeSpec(
    {
      FAKE_NO_PERMISSION: "1",
      FAKE_STAY_ALIVE: "1",
      FAKE_PROMPT_DELAY_MS: "400",
      FAKE_PROMPT_OUT: promptOut,
    },
    join(dir, "work"),
  );
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    specFor: () => spec,
  });
  hub.setTask(taskA.id);

  const started = await hub.dispatch({
    type: "session.start",
    taskId: taskA.id,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  eq("前置：旧任务会话启动成功", started.ok, true);
  const old = mgr.listSessions(taskA.id)[0];
  check("前置：拿到旧任务会话", Boolean(old), old?.id ?? "missing");
  if (!old) return;

  const promptRes = await hub.dispatch({ type: "session.prompt", sessionId: old.id, text: "旧任务的提示" });
  eq("前置：旧任务 prompt 已受理（结果会延迟返回）", promptRes.ok, true);
  const oldUpsertsBeforeSwitch = events.filter(
    (e) => e.type === "session.upsert" && e.session.taskId === taskA.id,
  ).length;
  check("前置：切任务前确实推送过旧任务 session.upsert", oldUpsertsBeforeSwitch > 0, String(oldUpsertsBeforeSwitch));

  // 立刻切到新任务。旧会话的两个 prompt（简报 + 人工提示）都还在 400ms 延迟里。
  // P1-B：走真实 task.focus（只切焦点，不停旧会话）。
  const focused = await hub.dispatch({ type: "task.focus", taskId: taskB.id });
  eq("task.focus 成功", focused.ok, true);
  const switchIndex = events.length;
  const switchAt = Date.now();

  // P1-C 行为变更：session.start / session.prompt 从“只允许焦点任务”放宽为
  // “允许任意非归档任务”。旧任务仍在跑，所以允许给它追加会话与提示；
  // stop/interrupt/remove 仍只允许焦点任务（后台批量停止走 task.stopAll）。
  const acceptedStart = await hub.dispatch({
    type: "session.start",
    taskId: taskA.id,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  eq("旧 taskId 的 session.start 被允许（非归档任务）", acceptedStart.ok, true);
  const acceptedPrompt = await hub.dispatch({ type: "session.prompt", sessionId: old.id, text: "后台补一条提示" });
  eq("旧任务的 session.prompt 被允许（非归档任务）", acceptedPrompt.ok, true);
  const rejectedStop = await hub.dispatch({ type: "session.stop", sessionId: old.id });
  eq("旧任务的 session.stop 仍被拒绝（后台停止走 task.stopAll）", rejectedStop.ok, false);
  const rejectedInterrupt = await hub.dispatch({ type: "session.interrupt", sessionId: old.id });
  eq("旧任务的 session.interrupt 仍被拒绝", rejectedInterrupt.ok, false);
  check("被拒绝的 stop 没有真的停掉旧会话", mgr.getSession(old.id)?.status !== "stopped", String(mgr.getSession(old.id)?.status));

  // 直接调用统一入口，验证过滤不依赖 dispatch 的前置校验。
  const oldRec = mgr.getSession(old.id)!;
  hub.publishSessionRec(oldRec);
  hub.publishStreamUpdate(old.id, { ts: Date.now(), kind: "other", text: "旧任务的迟到流" });
  hub.publishHealth(old.id);
  hub.publishApproval({ id: "ap-old", taskId: taskA.id } as ApprovalView);

  // fail-closed：未注册的 session 也必须丢弃，而不是「查不到就放行」。
  const unknownBefore = events.length;
  hub.publishStream("s-unknown", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "未知会话的流" },
  });
  hub.publishStreamUpdate("s-unknown", { ts: Date.now(), kind: "other", text: "未知会话的更新" });
  hub.publishHealth("s-unknown");
  const unknownEvents = events
    .slice(unknownBefore)
    .filter((e) => (e.type === "session.stream" || e.type === "health") && e.sessionId === "s-unknown");
  eq("未知 session 的 stream/health 全部被丢弃（fail-closed）", unknownEvents.length, 0);

  // 等假 agent 把两次延迟 prompt 都回完，并确认应答发生在切任务之后。
  const promptLines = (): Array<{ ts: number; id: number }> =>
    existsSync(promptOut)
      ? readFileSync(promptOut, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { ts: number; id: number })
      : [];
  // P1-C：旧会话的简报 + 人工提示、后台新会话的简报 + 后台补的提示，共 4 次。
  await waitFor(() => promptLines().length >= 4, 5000, "四次延迟 prompt 应答");
  const lines = promptLines();
  eq("四次延迟 prompt 都已完成", lines.length, 4);
  check(
    "四次回调都发生在切任务之后（不是空跑）",
    lines.length === 4 && lines.every((l) => l.ts >= switchAt),
    JSON.stringify(lines),
  );
  await sleep(100); // 让 .then 里的 publish* 微任务全部执行

  const after = events.slice(switchIndex);
  const oldSessions = after.filter((e) => e.type === "session.upsert" && e.session.taskId === taskA.id);
  const oldStreams = after.filter((e) => e.type === "session.stream" && e.sessionId === old.id);
  const oldHealth = after.filter((e) => e.type === "health" && e.sessionId === old.id);
  const oldApprovals = after.filter((e) => e.type === "approval.upsert" && e.approval.taskId === taskA.id);
  check("切焦点后旧 session.upsert 仍推送", oldSessions.length > 0, `count=${oldSessions.length}`);
  check(
    "旧 session.upsert 全部带 taskId A",
    oldSessions.every((e) => e.type === "session.upsert" && e.session.taskId === taskA.id),
  );
  check("切焦点后旧 session.stream 仍推送", oldStreams.length > 0, `count=${oldStreams.length}`);
  check(
    "旧 session.stream 全部带 taskId A",
    oldStreams.every((e) => e.type === "session.stream" && e.taskId === taskA.id),
  );
  check("切焦点后旧 health 仍推送", oldHealth.length > 0, `count=${oldHealth.length}`);
  check(
    "旧 health 全部带 taskId A",
    oldHealth.every((e) => e.type === "health" && e.taskId === taskA.id),
  );
  eq("审批事件仍只推焦点任务（全局列表走快照）", oldApprovals.length, 0);
  eq("新任务快照里没有旧任务会话", hub.snapshot().sessions.length, 0);

  // 渲染层最后一道防线：即使主进程推了非焦点事件，也不能进焦点 store。
  const stateB = { ...emptyState(), task: taskView(taskB.id) };
  const ignored = applyEvent(stateB, { type: "session.upsert", session: sessionView("s-old", taskA.id) });
  eq("渲染层丢弃任务不匹配的 session.upsert", ignored.sessions.length, 0);
  const ignoredHealth = applyEvent(stateB, {
    type: "health",
    sessionId: "s-old",
    taskId: taskA.id,
    health: { toolCalls: 9, boardReads: 0, syncLag: 9 },
  });
  eq("渲染层丢弃任务不匹配的 health", Object.keys(ignoredHealth.health).length, 0);
  const ignoredStream = applyEvent(stateB, {
    type: "session.stream",
    sessionId: "s-old",
    taskId: taskA.id,
    update: { ts: 0, kind: "other", text: "background" },
  });
  eq("渲染层丢弃任务不匹配的 session.stream", ignoredStream === stateB, true);
  const ignoredBoard = applyEvent(stateB, { type: "board.appended", taskId: taskA.id, events: [] });
  eq("渲染层丢弃任务不匹配的 board.appended", ignoredBoard === stateB, true);
  const stateWithB = applyEvent(stateB, {
    type: "session.upsert",
    session: sessionView("s-new", taskB.id),
  });
  const ignoredRemove = applyEvent(stateWithB, { type: "session.removed", sessionId: "s-new", taskId: taskA.id });
  eq("渲染层丢弃任务不匹配的 session.removed", ignoredRemove.sessions.length, 1);
  const applied = applyEvent(stateB, { type: "session.upsert", session: sessionView("s-new", taskB.id) });
  eq("渲染层接受当前任务的 session.upsert", applied.sessions.length, 1);

  // A2：真实任务切换路径 —— 通过 hub.dispatch(task.create) 而不是 setTask。
  const startB = await hub.dispatch({
    type: "session.start",
    taskId: taskB.id,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  eq("前置：新任务里也能起会话", startB.ok, true);
  const bRec = mgr.listSessions(taskB.id)[0];
  check("前置：拿到新任务会话", Boolean(bRec), bRec?.id ?? "missing");
  if (bRec) {
    const bPrompt = await hub.dispatch({ type: "session.prompt", sessionId: bRec.id, text: "B 的延迟提示" });
    eq("前置：新任务 prompt 已受理", bPrompt.ok, true);
  }
  const created = await hub.dispatch({ type: "task.create", title: "任务 C", brief: "dispatch 真切换" });
  const createIndex = events.length;
  eq("hub.dispatch(task.create) 成功", created.ok, true);
  check(
    "task.create 真的切换了当前任务",
    hub.currentTaskId !== taskB.id && hub.snapshot().task?.id === hub.currentTaskId,
    `current=${hub.currentTaskId}`,
  );
  if (bRec) {
    await sleep(600); // B 的两次 prompt 都还在 400ms 延迟里；等它们回来证明会话没被停
    check(
      "task.create 后旧任务会话仍 running（切题不停会话）",
      mgr.getSession(bRec.id)?.status !== "stopped",
      String(mgr.getSession(bRec.id)?.status),
    );
  }
  await sleep(200);
  const afterCreate = events.slice(createIndex);
  const bSessionsAfter = afterCreate.filter(
    (e) => e.type === "session.upsert" && e.session.taskId === taskB.id,
  );
  const bStreamsAfter = afterCreate.filter(
    (e) => e.type === "session.stream" && e.sessionId === bRec?.id,
  );
  const bHealthAfter = afterCreate.filter((e) => e.type === "health" && e.sessionId === bRec?.id);
  check(
    "task.create 后旧任务事件全部带 taskId B（不是无事件）",
    bSessionsAfter.every((e) => e.type === "session.upsert" && e.session.taskId === taskB.id) &&
      bStreamsAfter.every((e) => e.type === "session.stream" && e.taskId === taskB.id) &&
      bHealthAfter.every((e) => e.type === "health" && e.taskId === taskB.id),
    JSON.stringify(afterCreate.map((e) => e.type)),
  );
  check(
    "task.create 后旧任务仍有状态/健康事件",
    bSessionsAfter.length > 0 || bHealthAfter.length > 0,
    `upserts=${bSessionsAfter.length} health=${bHealthAfter.length}`,
  );
  eq("task.create 后的新任务快照为空", hub.snapshot().sessions.length, 0);

  await mgr.stopSession(old.id);
  await mgr.shutdown();
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- B 关闭超时

async function partB(): Promise<void> {
  console.log("\n================ B 待批 + 无视 close 时 stop 有界 ================\n");
  const dir = join(WORK, "b");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const fakeOut = join(dir, "fake-out.json");

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "关闭超时", brief: "permission pending + close ignored" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r18-b-${randomUUID()}` });
  await bridge.start();

  let hub!: HubService;
  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));
  const queue = new ApprovalQueue({
    // 只走 Hub 的统一入口；断言从真实 EventBus 上取，而不是看 onUpsert 的入参。
    onUpsert: (v) => hub.publishApproval(v),
    timeoutMs: 60_000,
  });
  let approvalSeen = false;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onApprovalRequired: async (sessionId, taskId, detail, decision) => {
      approvalSeen = true;
      const o = await queue.request({
        taskId,
        sessionId,
        action: "session/request_permission",
        detail,
        rule: decision.rule,
        reason: decision.reason,
      });
      return o.decision === "approved";
    },
  });
  const spec = fakeSpec(
    {
      FAKE_TITLE: "run mimikatz sekurlsa::logonpasswords",
      FAKE_OUT: fakeOut,
      FAKE_IGNORE_CLOSE: "1",
      FAKE_STAY_ALIVE: "1",
    },
    join(dir, "work"),
  );
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    approvals: queue,
    specFor: () => spec,
  });
  hub.setTask(task.id);

  const rec = await mgr.startSession({
    taskId: task.id,
    spec,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  await waitFor(() => approvalSeen && queue.pendingCount() === 1, 5000, "审批项挂起");
  eq("前置：审批项处于 pending", queue.pendingCount(), 1);

  const t0 = Date.now();
  const stopped = await hub.dispatch({ type: "session.stop", sessionId: rec.id });
  const elapsed = Date.now() - t0;
  eq("session.stop 返回成功", stopped.ok, true);
  check("stop 在 5 秒内返回（close 有界）", elapsed < 5000, `${elapsed}ms`);
  eq("stop 后没有待批项", queue.pendingCount(), 0);
  check("审批面板里也不再有 pending", queue.list().every((v) => v.status !== "pending"), JSON.stringify(queue.list().map((v) => v.status)));
  check(
    "审批先被拒（agent 收到了 cancelled 应答）",
    existsSync(fakeOut) &&
      (() => {
        try {
          const body = JSON.parse(readFileSync(fakeOut, "utf8")) as { result?: { outcome?: { outcome?: string } } };
          return body.result?.outcome?.outcome === "cancelled";
        } catch {
          return false;
        }
      })(),
    existsSync(fakeOut) ? readFileSync(fakeOut, "utf8").slice(0, 200) : "fake-out.json 不存在",
  );
  check(
    "真实 EventBus 收到当前任务的 approval.upsert（denied）",
    events.some(
      (e) =>
        e.type === "approval.upsert" &&
        e.approval.sessionId === rec.id &&
        e.approval.status === "denied",
    ),
    JSON.stringify(events.filter((e) => e.type === "approval.upsert").map((e) => e.approval.status)),
  );
  // 旧/其它任务的审批：走真实队列 + 真实 EventBus，仍必须被 Hub 过滤掉。
  const otherTask = board.createTask({ title: "另一个任务", brief: "审批不能串台" });
  const otherDecision = queue.request({
    taskId: otherTask.id,
    sessionId: "s-other",
    action: "session/request_permission",
    detail: { title: "other task action" },
    rule: "test",
    reason: "任务过滤断言",
  });
  const otherPending = queue.list().find((v) => v.taskId === otherTask.id && v.status === "pending");
  check("前置：其它任务的审批已进入队列", Boolean(otherPending), otherPending?.id ?? "missing");
  if (otherPending) queue.decide(otherPending.id, "denied");
  eq("其它任务审批的决策返回 denied", (await otherDecision).decision, "denied");
  eq(
    "旧/其它任务的 approval.upsert 被 Hub 过滤",
    events.filter((e) => e.type === "approval.upsert" && e.approval.taskId === otherTask.id).length,
    0,
  );
  await waitFor(() => mgr.getSession(rec.id)?.status === "stopped", 3000, "会话落成 stopped");
  eq("会话终态是 stopped", mgr.getSession(rec.id)?.status, "stopped");

  const pidRow = (board.raw("SELECT pid FROM sessions WHERE id = ?", rec.id) as Array<{ pid: number | null }>)[0];
  const pid = pidRow?.pid ?? null;
  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  check("close 超时后进程被 finally 杀掉", pid !== null && !alive, `pid=${String(pid)} alive=${alive}`);

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- C 正常退出

async function partC(): Promise<void> {
  console.log("\n================ C 正常退出：先等进程退出，再关库 ================\n");
  const dir = join(WORK, "c");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "正常退出", brief: "shutdown 必须可等待" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r18-c-${randomUUID()}` });
  await bridge.start();

  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
  });
  const spec = fakeSpec({ FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1" }, join(dir, "work"));
  const rec = await mgr.startSession({
    taskId: task.id,
    spec,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });

  const pidRow = (board.raw("SELECT pid FROM sessions WHERE id = ?", rec.id) as Array<{ pid: number | null }>)[0];
  const pid = pidRow?.pid ?? null;
  let aliveBefore = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      aliveBefore = true;
    } catch {
      aliveBefore = false;
    }
  }
  check("前置：会话非终态且进程还活着", rec.status !== "stopped" && aliveBefore, `status=${rec.status} pid=${String(pid)} alive=${aliveBefore}`);

  const t0 = Date.now();
  const result = await mgr.shutdown();
  const elapsed = Date.now() - t0;
  check("shutdown 在 5 秒内完成", elapsed < 5000, `${elapsed}ms`);
  eq("正常 shutdown 返回 allExited=true", result.allExited, true);
  eq("正常 shutdown 返回 timedOut=false", result.timedOut, false);
  eq("正常 shutdown 没有 closeErrors", result.closeErrors.length, 0);
  eq("正常 shutdown 后 wire 句柄为 0", mgr.openWireLogCount, 0);

  eq("shutdown 返回时会话已是 stopped（内存）", mgr.getSession(rec.id)?.status, "stopped");
  eq("shutdown 返回时会话已是 stopped（库里）", board.getSession(rec.id)?.status, "stopped");
  const row = board.listSessions(task.id).find((s) => s.id === rec.id);
  check("结束时间已落库", row?.ended_at != null, String(row?.ended_at));
  check(
    "正常退出没有写 incident",
    board.listDeadEnds(task.id).every((d) => d.scope !== "incident"),
    JSON.stringify(board.listDeadEnds(task.id).map((d) => d.scope)),
  );
  let aliveAfter = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      aliveAfter = true;
    } catch {
      aliveAfter = false;
    }
  }
  check("shutdown 返回前 agent 进程已退出", pid !== null && !aliveAfter, `pid=${String(pid)} alive=${aliveAfter}`);

  // 关键顺序：等到这里才允许关库。之后任何迟到回调都会立刻暴露成 unhandledRejection。
  board.close();
  await sleep(400);
  eq("关库后没有 database is not open 之类的未处理异常", asyncErrors.filter((e) => /database is not open|database is closed|ERR_INVALID_STATE/i.test(e)).length, 0);
  eq("整套流程没有未处理异常", asyncErrors.length, 0);
  const secondNormal = await mgr.shutdown(); // 幂等：第二次不能再写库
  eq("关库后第二次 shutdown 仍返回 allExited=true", secondNormal.allExited, true);
  eq("关库后第二次 shutdown 后仍无未处理异常", asyncErrors.length, 0);
  bridge.stop();
}

// ------------------------------------------------ C2 shutdown 超时 + 迟到 exit

async function partCTimeout(): Promise<void> {
  console.log("\n================ C2 shutdown 超时：kill 失效 + 迟到 exit ================\n");
  const dir = join(WORK, "c2");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "退出超时", brief: "kill 注入失效" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r18-c2-${randomUUID()}` });
  await bridge.start();

  let killCalls = 0;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    // 故障注入：模拟 taskkill 完全不生效。
    killHook: () => {
      killCalls += 1;
    },
  });
  const spec = fakeSpec(
    {
      FAKE_NO_PERMISSION: "1",
      FAKE_IGNORE_CLOSE: "1",
      FAKE_STAY_ALIVE: "1",
    },
    join(dir, "work"),
  );
  const rec = await mgr.startSession({
    taskId: task.id,
    spec,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  board.acquireLease({ resource: "target:shutdown-timeout", sessionId: rec.id, taskId: task.id });
  const intent = board.openIntent({ taskId: task.id, sessionId: rec.id, description: "退出超时的在途意图" });
  eq("前置：wire 句柄已打开", mgr.openWireLogCount, 1);

  const pidRow = (board.raw("SELECT pid FROM sessions WHERE id = ?", rec.id) as Array<{ pid: number | null }>)[0];
  const pid = pidRow?.pid ?? null;
  check("前置：拿到 agent pid", pid !== null && pid > 0, `pid=${String(pid)}`);

  const t0 = Date.now();
  const result = await mgr.shutdown();
  const elapsed = Date.now() - t0;
  check("超时 shutdown 在 5 秒总预算内返回", elapsed < 5000, `${elapsed}ms`);
  eq("超时 shutdown 返回 allExited=false", result.allExited, false);
  eq("超时 shutdown 返回 timedOut=true", result.timedOut, true);
  check(
    "pendingSessions 明确列出未退出的会话",
    result.pendingSessions.includes(rec.id),
    JSON.stringify(result.pendingSessions),
  );
  check("close 超时没有被静默吞掉", result.closeErrors.some((e) => e.sessionId === rec.id), JSON.stringify(result.closeErrors));
  check("故障注入生效（kill 被调用但进程未死）", killCalls > 0, `killCalls=${killCalls}`);
  eq("超时返回前 SessionManager 已进入 disposed", mgr.isDisposed, true);

  eq("超时返回时内存状态不是 running/idle", mgr.getSession(rec.id)?.status, "stopped");
  eq("超时返回时库里状态不是 running/idle", board.getSession(rec.id)?.status, "stopped");
  const row = board.listSessions(task.id).find((s) => s.id === rec.id);
  check("超时路径也把 ended_at 落库", row?.ended_at != null, String(row?.ended_at));
  eq("超时路径释放了租约", board.listLeases(task.id).some((l) => l.holder === rec.id), false);
  eq(
    "超时路径 abandon 了 intent",
    board.listIntents(task.id).find((i) => i.id === intent.id)?.status,
    "abandoned",
  );
  eq("超时路径关闭了 wire 句柄", mgr.openWireLogCount, 0);

  let aliveBeforeClose = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      aliveBeforeClose = true;
    } catch {
      aliveBeforeClose = false;
    }
  }
  check("关库前进程确实还活着（不是假超时）", aliveBeforeClose, `pid=${String(pid)} alive=${aliveBeforeClose}`);

  // 关键顺序：shutdown 已经 disposed，现在才关库。
  board.close();
  // 补触发一次迟到 exit：kill 注入只影响 AcpClient，这里用系统 taskkill 强行收进程。
  if (pid) {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      3000,
      "迟到 exit 前的进程退出",
    );
  }
  await sleep(400);

  eq(
    "关库后迟到 exit 没有 database is not open",
    asyncErrors.filter((e) => /database is not open|database is closed|ERR_INVALID_STATE/i.test(e)).length,
    0,
  );
  eq("关库后迟到 exit 没有未处理异常", asyncErrors.length, 0);
  const second = await mgr.shutdown();
  eq("关库后第二次 shutdown 返回同一 timedOut 结果", second.timedOut, true);
  eq("关库后第二次 shutdown 仍不写已关闭数据库", asyncErrors.length, 0);
  eq("第二次 shutdown 后 wire 句柄仍为 0", mgr.openWireLogCount, 0);
  bridge.stop();
}

// ---------------------------------------------------------------- D wire 句柄

async function partWireLogs(): Promise<void> {
  console.log("\n================ D 停止多个会话后 wire 句柄不增长 ================\n");
  const dir = join(WORK, "d");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "wire 句柄", brief: "多会话收尾" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r18-d-${randomUUID()}` });
  await bridge.start();
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
  });
  const spec = fakeSpec({ FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1" }, join(dir, "work"));

  for (let i = 1; i <= 3; i += 1) {
    const rec = await mgr.startSession({
      taskId: task.id,
      spec,
      agent: "claude",
      role: "lead",
      tier: "guarded",
    });
    eq(`第 ${i} 个会话启动后只有 1 个 wire 句柄`, mgr.openWireLogCount, 1);
    await mgr.stopSession(rec.id);
    await waitFor(() => mgr.getSession(rec.id)?.status === "stopped", 3000, `第 ${i} 个会话停止`);
    await waitFor(() => mgr.openWireLogCount === 0, 1000, `第 ${i} 个 wire 句柄关闭`);
    eq(`第 ${i} 个会话停止后 wire 句柄为 0（不随历史增长）`, mgr.openWireLogCount, 0);
  }

  const result = await mgr.shutdown();
  eq("wire 用例收尾后所有进程退出", result.allExited, true);
  eq("wire 用例收尾后 wire 句柄为 0", mgr.openWireLogCount, 0);
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- E spawn 错误

async function settleWithin(
  promises: Promise<unknown>[],
  timeoutMs: number,
): Promise<{ done: boolean; results: PromiseSettledResult<unknown>[] }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ done: false; results: PromiseSettledResult<unknown>[] }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false, results: [] }), timeoutMs);
  });
  const settled = Promise.allSettled(promises).then((results) => ({ done: true as const, results }));
  const out = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return out;
}

async function partSpawnErrors(): Promise<void> {
  console.log("\n================ E spawn 错误与关闭后请求 ================\n");
  const dir = join(WORK, "e");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const exits: Array<{ code: number | null; signal: string | null }> = [];
  const missing = AcpClient.spawn(
    {
      command: join(dir, "definitely-missing-agent.exe"),
      args: [],
      cwd: dir,
      label: "missing-agent",
    },
    {
      policy: null as never,
      sessionId: "s-spawn",
      onUpdate: () => undefined,
      log: () => undefined,
      onExit: (code, signal) => exits.push({ code, signal }),
    },
  );

  const spawned = await settleWithin(
    [
      missing.initialize(),
      missing.newSession({ cwd: dir }),
      missing.prompt("acp-missing", "必须快速失败"),
    ],
    1500,
  );
  check("spawn 不存在的命令：三个请求都在 1.5s 内落定", spawned.done, `${spawned.results.length} 个`);
  check(
    "spawn 失败时 initialize/newSession/prompt 全部 reject",
    spawned.done && spawned.results.every((r) => r.status === "rejected"),
    JSON.stringify(spawned.results.map((r) => (r.status === "rejected" ? String(r.reason) : r.status))),
  );
  check("spawn 失败后 pending 数量为 0", missing.pendingCount === 0, String(missing.pendingCount));
  eq("spawn 失败触发且只触发一次 onExit", exits.length, 1);
  const waitStart = Date.now();
  const alreadyExited = await missing.waitForExit(100);
  check(
    "spawn 失败后 waitForExit 立即 resolve",
    alreadyExited && Date.now() - waitStart < 50,
    `exited=${alreadyExited} elapsed=${Date.now() - waitStart}ms`,
  );
  await sleep(250);
  eq("spawn error 与 exit 不重复触发 onExit", exits.length, 1);

  // 子进程正常退出后再发请求：必须同步/百毫秒内 reject，不能永久 pending。
  const afterExit: Array<{ code: number | null; signal: string | null }> = [];
  const quick = AcpClient.spawn(
    {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: dir,
      label: "quick-exit",
    },
    {
      policy: null as never,
      sessionId: "s-quick",
      onUpdate: () => undefined,
      log: () => undefined,
      onExit: (code, signal) => afterExit.push({ code, signal }),
    },
  );
  eq("快速退出进程能在 3s 内被观察到", await quick.waitForExit(3000), true);
  const t0 = Date.now();
  const after = await Promise.allSettled([quick.initialize(), quick.prompt("acp-quick", "退出后请求")]);
  const afterElapsed = Date.now() - t0;
  check("进程退出后的 initialize/prompt 都 reject", after.every((r) => r.status === "rejected"), JSON.stringify(after.map((r) => r.status)));
  check("退出后请求在 100ms 内 reject（不挂起）", afterElapsed < 100, `${afterElapsed}ms`);
  eq("退出后请求没有留下 pending", quick.pendingCount, 0);
  eq("快速退出只触发一次 onExit", afterExit.length, 1);
}

// ---------------------------------------------------------------- I R27 任务专属工作目录

async function partTaskWorkdir(): Promise<void> {
  console.log("\n================ I R27 任务专属工作目录 ================\n");
  const dir = join(WORK, "i");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const taskA = board.createTask({ title: "任务 A", brief: "工作目录隔离" });
  const taskB = board.createTask({ title: "任务 B", brief: "另一个任务" });
  const bridge = new BoardBridge({ board, taskId: taskA.id, runId: `r27-i-${randomUUID()}` });
  await bridge.start();

  const echoA = join(dir, "echo-a.jsonl");
  const echoB = join(dir, "echo-b.jsonl");
  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => hub.publishSessionRec(rec),
  });
  let currentSpec = fakeSpec(
    { FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1", FAKE_ECHO_PROMPT: echoA },
    join(dir, "work"),
  );
  hub = new HubService({
    board,
    sessions: mgr,
    bus: new EventBus(),
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    specFor: () => currentSpec,
  });
  hub.setTask(taskA.id);

  const startedA = await hub.dispatch({ type: "session.start", taskId: taskA.id, agent: "claude", role: "lead", tier: "guarded" });
  eq("前置：任务 A 会话启动成功", startedA.ok, true);
  await waitFor(() => existsSync(echoA), 5000, "A 会话回显简报");
  const echoRowA = JSON.parse(readFileSync(echoA, "utf8").split("\n")[0]) as { workdir: string; text: string };
  const expectedA = join(dir, "work", taskA.id);
  eq("BUMIMANG_WORKDIR 是任务 A 专属目录", echoRowA.workdir, expectedA);
  check("简报正文含任务 A 专属目录", echoRowA.text.includes(expectedA), echoRowA.text.slice(0, 200));
  check("任务 A 目录已创建", existsSync(expectedA), expectedA);
  eq("快照 task.workDir 是任务 A 专属目录", hub.snapshot().task?.workDir ?? null, expectedA);

  currentSpec = fakeSpec(
    { FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1", FAKE_ECHO_PROMPT: echoB },
    join(dir, "work"),
  );
  const sw = await hub.dispatch({ type: "task.switch", taskId: taskB.id });
  eq("前置：切到任务 B（收尾 A 的活会话）", sw.ok, true);
  const startedB = await hub.dispatch({ type: "session.start", taskId: taskB.id, agent: "claude", role: "lead", tier: "guarded" });
  eq("前置：任务 B 会话启动成功", startedB.ok, true);
  await waitFor(() => existsSync(echoB), 5000, "B 会话回显简报");
  const echoRowB = JSON.parse(readFileSync(echoB, "utf8").split("\n")[0]) as { workdir: string; text: string };
  const expectedB = join(dir, "work", taskB.id);
  eq("BUMIMANG_WORKDIR 是任务 B 专属目录", echoRowB.workdir, expectedB);
  check("A/B 两个任务目录互不相同", expectedA !== expectedB, `${expectedA} vs ${expectedB}`);
  eq("快照 task.workDir 是任务 B 专属目录", hub.snapshot().task?.workDir ?? null, expectedB);

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- H A3 启动失败回滚

async function partStartFail(): Promise<void> {
  console.log("\n================ H A3 启动失败：回滚 + 任务状态退回 ================\n");
  const dir = join(WORK, "h");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "启动失败", brief: "握手超时必须回滚" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r26-h-${randomUUID()}` });
  await bridge.start();

  const bus = new EventBus();
  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => hub.publishSessionRec(rec),
  });
  const pidFile = join(dir, "agent.pid");
  const spec = fakeSpec({ FAKE_HANG_INIT: "1", FAKE_PID_FILE: pidFile }, join(dir, "work"));
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    specFor: () => spec,
  });
  hub.setTask(task.id);

  process.env.BUMIMANG_START_TIMEOUT_MS = "500";
  const started = await hub.dispatch({
    type: "session.start",
    taskId: task.id,
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  delete process.env.BUMIMANG_START_TIMEOUT_MS;
  eq("握手超时 → dispatch 返回失败", started.ok, false);
  check("错误信息含超时字样", (started.error ?? "").includes("超时"), started.error ?? "");
  eq("内存里没有幽灵会话", mgr.listSessions(task.id).length, 0);
  const row = (board.raw("SELECT id, status FROM sessions") as Array<{ id: string; status: string }>)[0];
  eq("库里状态标 failed", row?.status, "failed");
  eq("任务状态退回待解（不是解题中）", board.getTask(task.id)?.status, "open");
  eq("wire 句柄已收尾", mgr.openWireLogCount, 0);
  await waitFor(() => existsSync(pidFile), 3000, "挂起的 agent 写出 pid 文件");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  await waitFor(
    () => {
      if (!Number.isFinite(pid) || pid <= 0) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    5000,
    "挂起的 agent 进程被杀",
  );
  check("挂起的 agent 进程已被杀", pid > 0, `pid=${pid}`);
  eq("没有未处理异常", asyncErrors.length, 0);

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- G R24 收敛（首答停止重复劳动）

async function partConverge(): Promise<void> {
  console.log("\n================ G R24 收敛：带证据的首答让队友收尾 ================\n");
  const dir = join(WORK, "g");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "收敛", brief: "首答后队友收尾" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r24-g-${randomUUID()}` });
  await bridge.start();

  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));

  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => {
      hub.publishSessionRec(rec);
      hub.publishHealth(rec.id);
    },
  });
  const spec = fakeSpec(
    { FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1", FAKE_PROMPT_DELAY_MS: "400" },
    join(dir, "work"),
  );
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    specFor: () => spec,
    convergeGraceMs: 300,
  });
  hub.setTask(task.id);

  const a = await hub.dispatch({ type: "session.start", taskId: task.id, agent: "claude", role: "lead", tier: "guarded" });
  const b = await hub.dispatch({ type: "session.start", taskId: task.id, agent: "claude", role: "verify", tier: "guarded" });
  check("前置：两个会话都启动成功", a.ok && b.ok, JSON.stringify([a, b]));
  const [sA, sB] = mgr.listSessions(task.id);
  check("前置：拿到两个会话", Boolean(sA && sB), `${sA?.id},${sB?.id}`);
  if (!sA || !sB) {
    await mgr.shutdown();
    bridge.stop();
    board.close();
    return;
  }

  // 1) E0 无证据裸文本：不触发收敛（sB 在 prompt 轮里保持活跃）
  const keepBusy = await hub.dispatch({ type: "session.prompt", sessionId: sB.id, text: "保持干活" });
  check("前置：sB 收到保持忙碌的提示", keepBusy.ok, JSON.stringify(keepBusy));
  board.submitFact({ taskId: task.id, sessionId: sA.id, content: "flag{conv_e0}", witness: null, evidence: "E0" });
  hub.publishBoardSince(0);
  await sleep(150);
  check("E0 裸文本候选不触发收敛（队友没被停）", mgr.getSession(sB.id)?.status !== "stopped", mgr.getSession(sB.id)?.status ?? "?");
  check(
    "E0 候选也没发收敛提示",
    !events.some(
      (e) =>
        e.type === "session.stream" && e.sessionId === sB.id && (e.update.text ?? "").includes("[收敛]"),
    ),
    "",
  );

  // 2) E1 带证据：触发收敛（继续给 sB 续一轮 prompt，让宽限期命中「正在跑」）
  const keepBusy2 = await hub.dispatch({ type: "session.prompt", sessionId: sB.id, text: "继续干活" });
  check("前置：sB 第二轮提示已受理", keepBusy2.ok, JSON.stringify(keepBusy2));
  board.submitFact({
    taskId: task.id,
    sessionId: sA.id,
    content: "flag{conv_ok}",
    witness: "cmd: dd if=/tmp/flag.txt",
    evidence: "E1",
  });
  hub.publishBoardSince(0);
  await sleep(100);
  check(
    "带证据候选立即给队友发收敛提示（流）",
    events.some(
      (e) =>
        e.type === "session.stream" && e.sessionId === sB.id && (e.update.text ?? "").includes("[收敛]"),
    ),
    "",
  );
  await waitFor(() => mgr.getSession(sB.id)?.status === "stopped", 5000, "宽限期后队友被停止");
  eq("宽限期后队友被停止", mgr.getSession(sB.id)?.status ?? "?", "stopped");
  check("提交候选的会话没有被停", mgr.getSession(sA.id)?.status !== "stopped", mgr.getSession(sA.id)?.status ?? "?");
  eq("库里队友状态落 stopped", board.getSession(sB.id)?.status ?? "?", "stopped");
  eq("没有未处理异常", asyncErrors.length, 0);

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- F R20 session.remove（活进程）

async function partRemove(): Promise<void> {
  console.log("\n================ F R20 session.remove：活会话先停后隐藏 ================\n");
  const dir = join(WORK, "f");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "关标签移除", brief: "移除必须收掉进程" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `r20-f-${randomUUID()}` });
  await bridge.start();

  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));

  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => {
      hub.publishSessionRec(rec);
      hub.publishHealth(rec.id);
    },
  });
  const spec = fakeSpec(
    { FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1", FAKE_PROMPT_DELAY_MS: "400" },
    join(dir, "work"),
  );
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    specFor: () => spec,
  });
  hub.setTask(task.id);

  const started = await hub.dispatch({ type: "session.start", taskId: task.id, agent: "claude", role: "lead", tier: "guarded" });
  eq("前置：会话启动成功", started.ok, true);
  const rec = mgr.listSessions(task.id)[0];
  check("前置：拿到活会话", Boolean(rec), rec?.id ?? "missing");
  if (!rec) {
    await mgr.shutdown();
    bridge.stop();
    board.close();
    return;
  }
  const pidRow = (board.raw("SELECT pid FROM sessions WHERE id = ?", rec.id) as Array<{ pid: number | null }>)[0];
  const pid = pidRow?.pid ?? null;
  const alive = (p: number | null): boolean => {
    if (!p) return false;
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  check("前置：agent 进程还活着", alive(pid), `pid=${String(pid)}`);
  // 发一轮提示让假 agent 开始推流（400ms 延迟应答），随后在回合进行中移除——
  // 同时覆盖「跑着的会话被移除」与「移除后迟到流不再发布」。
  const promptRes = await hub.dispatch({ type: "session.prompt", sessionId: rec.id, text: "移除前的最后一轮" });
  eq("前置：prompt 已受理", promptRes.ok, true);
  await waitFor(
    () => events.filter((e) => e.type === "session.stream" && e.sessionId === rec.id).length > 0,
    5000,
    "会话产出流事件",
  );
  check("前置：会话确实产出过流事件", true, "");

  const rm = await hub.dispatch({ type: "session.remove", sessionId: rec.id });
  eq("session.remove 返回 ok", rm.ok, true);
  check(
    "发布 session.removed 事件",
    events.some((e) => e.type === "session.removed" && e.sessionId === rec.id),
    JSON.stringify(events.map((e) => e.type)),
  );
  await waitFor(() => !alive(pid), 5000, "agent 进程退出");
  check("移除后 agent 进程已死", !alive(pid), `pid=${String(pid)}`);
  eq("内存里状态已是 stopped", mgr.getSession(rec.id)?.status, "stopped");
  eq("库里状态已是 stopped", board.getSession(rec.id)?.status, "stopped");
  const hiddenRow = (board.raw("SELECT hidden FROM sessions WHERE id = ?", rec.id) as Array<{ hidden: number }>)[0];
  eq("库里 hidden=1", hiddenRow?.hidden, 1);
  check(
    "会话列表不再包含被移除会话",
    !mgr.listSessions(task.id).some((s) => s.id === rec.id) && !hub.snapshot().sessions.some((s) => s.id === rec.id),
    JSON.stringify(hub.snapshot().sessions.map((s) => s.id)),
  );
  // 迟到回调：进程 exit 与流事件都还会到，必须被过滤掉，不能把会话画回 UI。
  const before = events.length;
  hub.publishStreamUpdate(rec.id, { ts: Date.now(), kind: "other", text: "移除后的迟到流" });
  hub.publishHealth(rec.id);
  hub.publishSessionRec(rec);
  await sleep(300); // 等真实 exit 回调（若有）走完
  const lateLeaks = events.slice(before).filter((e) => e.type !== "session.removed" && ("sessionId" in e ? e.sessionId === rec.id : false));
  eq("移除后的迟到流/健康/upsert 全部被过滤", lateLeaks.length, 0);
  const removeAgain = await hub.dispatch({ type: "session.remove", sessionId: rec.id });
  eq("重复移除被拒", removeAgain.ok, false);
  eq("移除后 dispatch(stop) 也被拒", (await hub.dispatch({ type: "session.stop", sessionId: rec.id })).ok, false);
  eq("没有未处理异常", asyncErrors.length, 0);

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  console.log("========== R18 回归：事件隔离 / 关闭超时 / 正常退出 ==========");
  await partA();
  await partB();
  await partC();
  await partCTimeout();
  await partWireLogs();
  await partSpawnErrors();
  await partRemove();
  await partConverge();
  await partStartFail();
  await partTaskWorkdir();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n========== ${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
