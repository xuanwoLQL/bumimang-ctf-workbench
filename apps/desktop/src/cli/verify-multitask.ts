/**
 * WP1 多任务验收（P1-C：A–E 五组）。
 *
 * A：3 任务 × 2 fake 会话 = 6 个非终态；快照 tasks/counts/quota。
 * B：切焦点不停会话；快照 sessions 只属于焦点；task.switch 与 task.focus 等价；
 *    task.stopAll(A) 只停 A。
 * C：审批隔离 —— A、B 各一条 pending；approvalsAll 带 taskId/taskTitle；处理 A 不影响 B。
 * D：收敛按任务 —— A 首答只停 A 的队友，B 不动；note 只写 A 的黑板；
 *    快照 flagCandidate 只暴露焦点任务。
 * E：配额 —— 每任务第 4 个被拒（3/3）、全局第 9 个被拒（8/8）、停一个后可再启动；
 *    归档任务不计入全局配额，也不能再起会话。
 * F：重启恢复全部非归档任务 —— 子进程创建 3 任务/6 会话后非优雅退出；父进程重开 DB
 *    后 3 任务 6 会话都在；stale lease/intent 按任务清理，A 的资源不泄漏到 B。
 * G：归档 —— 有活会话需 force；归档不删历史；焦点回退；task.stopAll 不归档。
 *
 * 用法：npm run verify:multitask
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { SessionManager } from "../main/session/manager.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import type { HubEvent, HubSnapshot, Role, TaskCategory } from "../../../../packages/shared-protocol/events.ts";

const ROOT = process.cwd();
const WORK = join(ROOT, ".ui-run", "multitask");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FAKE_AGENT = join(HERE, "fake-agent.ts");
const ACTIVE = new Set(["starting", "idle", "running", "waiting_approval", "waiting_lease"]);

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

interface Harness {
  dir: string;
  board: Blackboard;
  bridge: BoardBridge;
  mgr: SessionManager;
  hub: HubService;
  bus: EventBus;
  events: HubEvent[];
  approvals?: ApprovalQueue;
  cleanup: () => Promise<void>;
}

/** P1-C 新增场景的独立夹具：每组建自己的临时库/工作目录，避免配额互相污染。 */
async function makeHarness(
  label: string,
  env: Record<string, string>,
  opts: { convergeGraceMs?: number; approvals?: boolean } = {},
): Promise<Harness> {
  const dir = join(WORK, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const bridge = new BoardBridge({ board, taskId: "bootstrap", runId: `multitask-${label}-${randomUUID()}` });
  await bridge.start();

  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));

  let hub!: HubService;
  let approvals: ApprovalQueue | undefined;
  if (opts.approvals) {
    approvals = new ApprovalQueue({
      onUpsert: (view) => hub.publishApproval(view),
      timeoutMs: 15_000,
    });
  }

  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => {
      hub.publishSessionRec(rec);
      hub.publishHealth(rec.id);
    },
    onApprovalRequired: approvals
      ? async (sessionId, taskId, detail, decision, action) => {
          const o = await approvals!.request({
            taskId,
            sessionId,
            action,
            detail,
            rule: decision.rule,
            reason: decision.reason,
          });
          return o.decision === "approved";
        }
      : undefined,
  });

  const spec = {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: join(dir, "work"),
    env: { FAKE_STAY_ALIVE: "1", ...env },
    label: "fake-agent",
  };
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    approvals,
    maxSessionsPerTask: 3,
    maxSessionsTotal: 8,
    convergeGraceMs: opts.convergeGraceMs,
    specFor: () => spec,
  });

  return {
    dir,
    board,
    bridge,
    mgr,
    hub,
    bus,
    events,
    approvals,
    cleanup: async () => {
      await mgr.shutdown();
      bridge.stop();
      board.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createTask(
  h: Harness,
  title: string,
  category: TaskCategory,
  priority: number,
): Promise<string> {
  const res = await h.hub.dispatch({ type: "task.create", title, brief: `${title} brief`, category, priority });
  check(`创建任务 ${title} 成功`, res.ok, JSON.stringify(res));
  const id = h.hub.currentTaskId;
  check(`任务 ${title} 成为焦点`, Boolean(id), String(id));
  return id!;
}

async function start(
  h: Harness,
  taskId: string,
  role: Role = "lead",
): Promise<{ ok: boolean; error?: string; id: string | null }> {
  const res = await h.hub.dispatch({
    type: "session.start",
    taskId,
    agent: "claude",
    role,
    tier: "guarded",
  });
  const rows = h.mgr.listSessions(taskId);
  return { ok: res.ok, error: res.error, id: rows[rows.length - 1]?.id ?? null };
}

function activeIds(h: Harness, taskId: string): string[] {
  return h.mgr
    .listSessions(taskId)
    .filter((s) => ACTIVE.has(s.status))
    .map((s) => s.id);
}

async function partAB(): Promise<void> {
  console.log("================ P1-B/P1-C A 三任务 × 两会话 ================\n");
  const dir = join(WORK, "a");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const bridge = new BoardBridge({ board, taskId: "bootstrap", runId: `multitask-${randomUUID()}` });
  await bridge.start();

  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));

  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: (sessionId, update) => hub.publishStreamUpdate(sessionId, update),
    onSessionChange: (rec) => {
      hub.publishSessionRec(rec);
      hub.publishHealth(rec.id);
    },
  });
  const spec = {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: join(dir, "work"),
    env: { FAKE_NO_PERMISSION: "1", FAKE_STAY_ALIVE: "1" },
    label: "fake-agent",
  };
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    maxSessionsPerTask: 3,
    maxSessionsTotal: 8,
    specFor: () => spec,
  });

  const startTwo = async (taskId: string): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      const res = await hub.dispatch({
        type: "session.start",
        taskId,
        agent: "claude",
        role: "lead",
        tier: "guarded",
      });
      check(`任务 ${taskId} 第 ${i + 1} 个会话启动成功`, res.ok, JSON.stringify(res));
    }
  };
  const createTask = async (title: string, category: TaskCategory, priority: number): Promise<string> => {
    const res = await hub.dispatch({ type: "task.create", title, brief: `${title} brief`, category, priority });
    check(`创建任务 ${title} 成功`, res.ok, JSON.stringify(res));
    const id = hub.currentTaskId;
    check(`任务 ${title} 成为焦点`, Boolean(id), String(id));
    return id!;
  };
  const activeIds = (taskId: string): string[] =>
    mgr
      .listSessions(taskId)
      .filter((s) => ACTIVE.has(s.status))
      .map((s) => s.id);

  const aId = await createTask("A", "web", 10);
  await startTwo(aId);
  const bId = await createTask("B", "misc", 5);
  eq("task.create(B) 后 A 的 2 个会话仍活跃", activeIds(aId).length, 2);
  await startTwo(bId);
  const cId = await createTask("C", "pwn", 1);
  eq("task.create(C) 后 B 的 2 个会话仍活跃", activeIds(bId).length, 2);
  await startTwo(cId);

  const snapA: HubSnapshot = hub.snapshot();
  eq("快照 tasks 有 3 条", snapA.tasks.length, 3);
  for (const [label, id] of [
    ["A", aId],
    ["B", bId],
    ["C", cId],
  ] as const) {
    const t = snapA.tasks.find((x) => x.id === id);
    eq(`任务 ${label} runningSessions=2`, t?.runningSessions, 2);
    eq(`任务 ${label} totalSessions=2`, t?.totalSessions, 2);
  }
  eq("全局 quota.runningSessions=6", snapA.quota?.runningSessions, 6);
  eq("quota.maxSessionsPerTask=3", snapA.quota?.maxSessionsPerTask, 3);
  eq("quota.maxSessionsTotal=8", snapA.quota?.maxSessionsTotal, 8);
  eq("A 任务 category 保留", snapA.tasks.find((x) => x.id === aId)?.category, "web");
  eq("A 任务 priority 保留", snapA.tasks.find((x) => x.id === aId)?.priority, 10);

  console.log("\n---------- B 切焦点 / stopAll ----------");
  const focusB = await hub.dispatch({ type: "task.focus", taskId: bId });
  check("task.focus(B) 成功", focusB.ok, JSON.stringify(focusB));
  eq("切焦点后 A 的 2 个会话仍活跃", activeIds(aId).length, 2);
  const snapB = hub.snapshot();
  eq("焦点 B 的快照 sessions=2", snapB.sessions.length, 2);
  check(
    "焦点 B 的快照里全是 B 的会话",
    snapB.sessions.every((s) => s.taskId === bId),
    JSON.stringify(snapB.sessions.map((s) => [s.id, s.taskId])),
  );

  const switchA = await hub.dispatch({ type: "task.switch", taskId: aId });
  check("task.switch(A) 成功", switchA.ok, JSON.stringify(switchA));
  const snapSwA = hub.snapshot();
  eq("task.switch 回 A 后快照 sessions=2", snapSwA.sessions.length, 2);
  check(
    "task.switch 回 A 后快照里全是 A 的会话",
    snapSwA.sessions.every((s) => s.taskId === aId),
    JSON.stringify(snapSwA.sessions.map((s) => [s.id, s.taskId])),
  );
  const switchIds = snapSwA.sessions.map((s) => s.id).sort();

  await hub.dispatch({ type: "task.focus", taskId: bId });
  await hub.dispatch({ type: "task.switch", taskId: aId });
  const focusIds = hub.snapshot().sessions.map((s) => s.id).sort();
  eq("task.switch 与 task.focus 等价", JSON.stringify(focusIds), JSON.stringify(switchIds));

  // 显式停 A：焦点故意留在 B，验证只停目标任务。
  await hub.dispatch({ type: "task.focus", taskId: bId });
  const stopAll = await hub.dispatch({ type: "task.stopAll", taskId: aId });
  check("task.stopAll(A) 成功", stopAll.ok, JSON.stringify(stopAll));
  await waitFor(() => activeIds(aId).length === 0, 3000, "A 会话停止");
  eq("task.stopAll(A) 后 A 无活跃会话", activeIds(aId).length, 0);
  eq("task.stopAll(A) 后 B 仍有 2 个活跃会话", activeIds(bId).length, 2);
  eq("task.stopAll(A) 后 C 仍有 2 个活跃会话", activeIds(cId).length, 2);
  eq("焦点仍在 B", hub.currentTaskId, bId);

  await sleep(100);
  const aStopped = events.filter(
    (e) => e.type === "session.upsert" && e.session.taskId === aId && e.session.status === "stopped",
  );
  check("A 的停止事件带 taskId", aStopped.length >= 2, `stopped=${aStopped.length}`);

  await mgr.shutdown();
  bridge.stop();
  board.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- C 审批隔离

async function partC(): Promise<void> {
  console.log("\n================ C 审批隔离（跨任务）================\n");
  const h = await makeHarness("c", {}, { approvals: true });
  try {
    const aId = await createTask(h, "审批 A", "web", 10);
    const bId = await createTask(h, "审批 B", "misc", 5); // 焦点 B

    // P1-C：焦点在 B 时也能给后台任务 A 起会话。
    const aStart = await start(h, aId, "lead");
    check("C：非焦点任务 A 能起会话", aStart.ok, aStart.error ?? "");
    const bStart = await start(h, bId, "verify");
    check("C：焦点任务 B 能起会话", bStart.ok, bStart.error ?? "");
    if (!aStart.ok || !bStart.ok || !aStart.id || !bStart.id) return;

    await waitFor(
      () => (h.approvals?.list() ?? []).filter((a) => a.status === "pending").length >= 2,
      5000,
      "两个任务各产生一条审批",
    );
    const pending = (h.approvals?.list() ?? []).filter((a) => a.status === "pending");
    eq("C：两个任务各一条待审批", pending.length, 2);
    const aAp = pending.find((a) => a.taskId === aId);
    const bAp = pending.find((a) => a.taskId === bId);
    check("C：审批带正确的 taskId（A/B 各一条）", Boolean(aAp && bAp), JSON.stringify(pending.map((p) => p.taskId)));
    if (!aAp || !bAp) return;

    const snap = h.hub.snapshot();
    eq("C：快照 approvalsAll 有两条", snap.approvalsAll?.length, 2);
    eq("C：焦点快照 approvals 只有 B 的一条", snap.approvals?.length, 1);
    eq("C：焦点快照审批属于 B", snap.approvals?.[0]?.taskId, bId);
    eq("C：approvalsAll 的 A 任务标题正确", snap.approvalsAll?.find((a) => a.id === aAp.id)?.taskTitle, "审批 A");
    eq("C：approvalsAll 的 B 任务标题正确", snap.approvalsAll?.find((a) => a.id === bAp.id)?.taskTitle, "审批 B");

    const decideA = await h.hub.dispatch({ type: "approval.decide", approvalId: aAp.id, decision: "approve" });
    check("C：处理 A 的审批成功", decideA.ok, JSON.stringify(decideA));
    eq("C：A 的审批已 approved", h.approvals?.get(aAp.id)?.status, "approved");
    eq("C：B 的审批仍 pending", h.approvals?.get(bAp.id)?.status, "pending");
    check("C：处理 A 不影响 B 会话", activeIds(h, bId).includes(bStart.id), JSON.stringify(activeIds(h, bId)));

    // 清理：B 的 pending 审批先拒掉，避免超时定时器拖住进程。
    h.approvals?.denyAllOf(bStart.id);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------- D 收敛按任务

async function partD(): Promise<void> {
  console.log("\n================ D 收敛按任务（首答只停本任务队友）================\n");
  const h = await makeHarness(
    "d",
    { FAKE_NO_PERMISSION: "1", FAKE_PROMPT_DELAY_MS: "800" },
    { convergeGraceMs: 300 },
  );
  try {
    const aId = await createTask(h, "收敛 A", "web", 10);
    const bId = await createTask(h, "收敛 B", "misc", 5); // 焦点 B
    const a1 = await start(h, aId, "lead");
    const a2 = await start(h, aId, "verify");
    const b1 = await start(h, bId, "lead");
    const b2 = await start(h, bId, "verify");
    check(
      "D：两个任务各起 2 个会话（含非焦点任务 A）",
      a1.ok && a2.ok && b1.ok && b2.ok,
      JSON.stringify([a1, a2, b1, b2]),
    );
    if (!a1.id || !a2.id || !b1.id || !b2.id) return;

    // 让 A 的队友处于 running，宽限期才能命中「正在跑」。
    const busy = await h.hub.dispatch({ type: "session.prompt", sessionId: a2.id, text: "保持干活" });
    check("D：后台任务 A 的会话可 prompt", busy.ok, JSON.stringify(busy));

    // A 的黑板写入带 E1 证据的 fact；再由 A 的首答者发一条 agent_message 触发候选。
    h.board.submitFact({
      taskId: aId,
      sessionId: a1.id,
      content: "flag{conv_task_a}",
      witness: "cmd: cat /flag",
      evidence: "E1",
    });
    h.hub.publishStreamUpdate(a1.id, {
      ts: Date.now(),
      kind: "agent_message",
      text: "已拿到 flag{conv_task_a}",
    });

    await waitFor(
      () => h.mgr.getSession(a2.id)?.status === "stopped",
      5000,
      "A 的队友被收敛停止",
    );
    eq("D：A 的队友被收敛停止", h.mgr.getSession(a2.id)?.status, "stopped");
    check("D：A 的首答者没有被停", h.mgr.getSession(a1.id)?.status !== "stopped", String(h.mgr.getSession(a1.id)?.status));
    eq("D：B 的 2 个会话仍活跃", activeIds(h, bId).length, 2);

    const aNotes = h.board.readSinceForTask(0, aId).filter((r) => r.kind === "note");
    eq("D：A 黑板写入 1 条收敛 note", aNotes.length, 1);
    let noteText = "";
    try {
      noteText = (JSON.parse(aNotes[0]?.body ?? "{}") as { text?: string }).text ?? "";
    } catch {
      /* 断言会失败 */
    }
    check(
      "D：收敛 note 属于 A 且包含 flag",
      aNotes[0]?.subject === aId && noteText.includes("flag{conv_task_a}"),
      JSON.stringify({ subject: aNotes[0]?.subject, noteText: noteText.slice(0, 120) }),
    );
    const bNotes = h.board.readSinceForTask(0, bId).filter((r) => r.kind === "note");
    eq("D：B 黑板没有收敛 note", bNotes.length, 0);

    // 快照只暴露焦点任务的 flagCandidate（B 是焦点，A 是后台）。
    h.board.submitFact({
      taskId: bId,
      sessionId: b1.id,
      content: "flag{only_b}",
      witness: null,
      evidence: "E0",
    });
    h.hub.recoverTaskSignals(bId);
    const snap = h.hub.snapshot();
    eq(
      "D：焦点 B 的 flagCandidate 暴露",
      snap.tasks.find((t) => t.id === bId)?.flagCandidate,
      "flag{only_b}",
    );
    eq(
      "D：非焦点 A 的 flagCandidate 不暴露",
      snap.tasks.find((t) => t.id === aId)?.flagCandidate,
      null,
    );
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------- E 配额

async function partE(): Promise<void> {
  console.log("\n================ E 配额（每任务 3 / 全局 8）================\n");
  const h = await makeHarness("e", { FAKE_NO_PERMISSION: "1" });
  try {
    const aId = await createTask(h, "配额 A", "web", 10);
    const bId = await createTask(h, "配额 B", "misc", 5);
    const cId = await createTask(h, "配额 C", "pwn", 1); // 焦点 C

    for (let i = 0; i < 3; i++) {
      const r = await start(h, aId, i === 0 ? "lead" : "verify");
      check(`E：A 第 ${i + 1} 个会话启动成功`, r.ok, r.error ?? "");
    }
    eq("E：A 有 3 个活跃会话", activeIds(h, aId).length, 3);
    eq("E：非焦点任务 A 启动后状态置 solving", h.board.getTask(aId)?.status, "solving");

    const aFourth = await start(h, aId);
    check(
      "E：每任务第 4 个会话被拒（3/3）",
      !aFourth.ok && (aFourth.error ?? "").includes("3/3"),
      aFourth.error ?? "ok",
    );

    for (let i = 0; i < 3; i++) {
      const r = await start(h, bId, i === 0 ? "lead" : "verify");
      check(`E：B 第 ${i + 1} 个会话启动成功`, r.ok, r.error ?? "");
    }
    for (let i = 0; i < 2; i++) {
      const r = await start(h, cId, i === 0 ? "lead" : "verify");
      check(`E：C 第 ${i + 1} 个会话启动成功`, r.ok, r.error ?? "");
    }
    eq("E：全局达到 8 个活跃会话", h.hub.snapshot().quota?.runningSessions, 8);

    const cNinth = await start(h, cId);
    check(
      "E：全局第 9 个会话被拒（8/8）",
      !cNinth.ok && (cNinth.error ?? "").includes("8/8"),
      cNinth.error ?? "ok",
    );

    // 停一个 A 会话：focus A 后走 session.stop（stop 仍只允许焦点任务）。
    await h.hub.dispatch({ type: "task.focus", taskId: aId });
    const aActive = activeIds(h, aId);
    const stop = await h.hub.dispatch({ type: "session.stop", sessionId: aActive[0] });
    check("E：停一个 A 会话成功", stop.ok, JSON.stringify(stop));
    await waitFor(() => activeIds(h, aId).length === 2, 3000, "A 活跃数降到 2");
    eq("E：停一个后全局配额回到 7", h.hub.snapshot().quota?.runningSessions, 7);

    const cThird = await start(h, cId, "scribe");
    check("E：停一个后 C 能再启动第 3 个", cThird.ok, cThird.error ?? "");
    eq("E：C 达到 3 个活跃会话", activeIds(h, cId).length, 3);

    const cFourth = await start(h, cId);
    check(
      "E：C 的第 4 个会话被拒（3/3）",
      !cFourth.ok && (cFourth.error ?? "").includes("3/3"),
      cFourth.error ?? "ok",
    );
    eq("E：此时全局仍为 8", h.hub.snapshot().quota?.runningSessions, 8);

    // 归档任务不计入全局配额，也不能再起会话（真正的归档落库留 P1-D，
    // 这里直接改列模拟 archived=1）。
    h.board.raw("UPDATE tasks SET archived = 1 WHERE id = ?", aId);
    eq("E：归档后全局配额排除 A（8-2=6）", h.hub.snapshot().quota?.runningSessions, 6);
    const archivedStart = await start(h, aId);
    check(
      "E：归档任务不能再起会话",
      !archivedStart.ok && (archivedStart.error ?? "").includes("已归档"),
      archivedStart.error ?? "ok",
    );

    // 归档释放的配额可被新任务使用。
    const dId = await createTask(h, "配额 D", "crypto", 0);
    const dFirst = await start(h, dId);
    check("E：归档释放的配额可给新任务", dFirst.ok, dFirst.error ?? "");
    eq("E：新任务启动后全局为 7", h.hub.snapshot().quota?.runningSessions, 7);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------- F 重启恢复全部任务

async function partF(): Promise<void> {
  console.log("\n================ F 重启恢复全部非归档任务 ================\n");
  const dir = join(WORK, "f");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const dbPath = join(dir, "board.db");
  const markerPath = join(dir, "marker.json");
  const childPath = join(dir, "child.ts");

  // 子进程只写库，不 close、不优雅收尾：模拟主进程被杀。
  const childScript = `
const { writeFileSync } = await import("node:fs");
const { Blackboard } = await import(process.argv[4]);
const db = Blackboard.open(process.argv[2]);
const tasks = ["A", "B", "C"].map((x) => db.createTask({ title: "F-" + x, brief: "F " + x + " brief" }));
const sessions = [];
for (let i = 0; i < tasks.length; i++) {
  for (let j = 0; j < 2; j++) {
    const id = "fs-" + i + "-" + j;
    db.insertSession({ id, taskId: tasks[i].id, agent: "claude", role: j === 0 ? "lead" : "verify", tier: "guarded", status: "running" });
    sessions.push({ id, taskId: tasks[i].id, index: i, slot: j });
  }
}
const pick = (taskId, slot) => sessions.find((s) => s.taskId === taskId && s.slot === slot).id;
const a = tasks[0].id, b = tasks[1].id;
const a1 = pick(a, 0), b1 = pick(b, 0);
db.acquireLease({ resource: "target:a", sessionId: a1, taskId: a });
const aRunningIntent = db.openIntent({ taskId: a, sessionId: a1, description: "A running intent" }).id;
db.acquireLease({ resource: "target:b", sessionId: b1, taskId: b });
const bRunningIntent = db.openIntent({ taskId: b, sessionId: b1, description: "B running intent" }).id;
db.acquireLease({ resource: "ghost:a", sessionId: "ghost-a", taskId: a });
const aGhostIntent = db.openIntent({ taskId: a, sessionId: "ghost-a", description: "A ghost intent" }).id;
db.acquireLease({ resource: "ghost:b", sessionId: "ghost-b", taskId: b });
const bGhostIntent = db.openIntent({ taskId: b, sessionId: "ghost-b", description: "B ghost intent" }).id;
writeFileSync(process.argv[3], JSON.stringify({
  tasks: tasks.map((t) => t.id),
  sessions,
  leases: { a: "target:a", b: "target:b", ghostA: "ghost:a", ghostB: "ghost:b" },
  intents: { aRunning: aRunningIntent, aGhost: aGhostIntent, bRunning: bRunningIntent, bGhost: bGhostIntent }
}));
process.exit(0);
`;
  writeFileSync(childPath, childScript, "utf8");
  const boardUrl = pathToFileURL(join(ROOT, "apps/desktop/src/main/blackboard/board.ts")).href;
  const child = spawnSync(process.execPath, [childPath, dbPath, markerPath, boardUrl], {
    cwd: ROOT,
    encoding: "utf8",
  });
  check(
    "F：子进程创建 3 任务/6 会话后非优雅退出",
    child.status === 0 && existsSync(markerPath),
    `status=${child.status} stderr=${(child.stderr ?? "").slice(-300)}`,
  );
  if (child.status !== 0 || !existsSync(markerPath)) return;

  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    tasks: string[];
    sessions: Array<{ id: string; taskId: string; index: number; slot: number }>;
    leases: { a: string; b: string; ghostA: string; ghostB: string };
    intents: { aRunning: string; aGhost: string; bRunning: string; bGhost: string };
  };
  const [aId, bId, cId] = marker.tasks;
  const a1 = marker.sessions.find((s) => s.taskId === aId && s.slot === 0)!.id;
  const b1 = marker.sessions.find((s) => s.taskId === bId && s.slot === 0)!.id;

  const board = Blackboard.open(dbPath);
  const bridge = new BoardBridge({ board, taskId: aId, runId: `multitask-f-${randomUUID()}` });
  await bridge.start();
  const bus = new EventBus();
  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
  });
  const spec = { command: process.execPath, args: [FAKE_AGENT], cwd: join(dir, "work"), env: { FAKE_NO_PERMISSION: "1" }, label: "fake-agent" };
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    specFor: () => spec,
  });

  try {
    eq("F：重启前库里有 3 个任务", board.listTasks().length, 3);
    eq("F：重启前库里有 6 个非终态会话", board.listSessions().filter((s) => s.status === "running").length, 6);
    eq("F：A 的孤儿租约归属 A", board.getLease(marker.leases.ghostA)?.task_id, aId);
    check(
      "F：A 的租约不出现在 B 的视图",
      board.listLeases(bId).every((l) => l.resource !== marker.leases.ghostA),
      JSON.stringify(board.listLeases(bId).map((l) => l.resource)),
    );

    // 按任务清理 stale 资源：只动自己任务的孤儿，不动运行会话/别的任务。
    const releaseFn = (board as unknown as {
      releaseStaleLeases?: (taskId: string, now?: number) => string[];
    }).releaseStaleLeases;
    if (typeof releaseFn === "function") {
      const releasedA = releaseFn.call(board, aId);
      check("F：releaseStaleLeases(A) 释放 A 的孤儿租约", releasedA.includes(marker.leases.ghostA), JSON.stringify(releasedA));
      check(
        "F：releaseStaleLeases(A) 不动 B 的孤儿租约",
        board.getLease(marker.leases.ghostB) !== undefined,
        String(board.getLease(marker.leases.ghostB)?.resource ?? "missing"),
      );
      check(
        "F：releaseStaleLeases(A) 不动本任务运行会话的租约",
        board.getLease(marker.leases.a) !== undefined,
        String(board.getLease(marker.leases.a)?.resource ?? "missing"),
      );
    } else {
      check("F：releaseStaleLeases 已实现", false, "missing");
    }

    const abandonFn = (board as unknown as {
      abandonStaleIntents?: (taskId: string) => number;
    }).abandonStaleIntents;
    if (typeof abandonFn === "function") {
      const n = abandonFn.call(board, aId);
      const aGhost = board.listIntents(aId).find((i) => i.id === marker.intents.aGhost);
      const aRunning = board.listIntents(aId).find((i) => i.id === marker.intents.aRunning);
      const bGhost = board.listIntents(bId).find((i) => i.id === marker.intents.bGhost);
      check("F：abandonStaleIntents(A) 放弃 A 的孤儿意图", n >= 1 && aGhost?.status === "abandoned", `n=${n} status=${aGhost?.status}`);
      check("F：abandonStaleIntents(A) 不动本任务运行会话的意图", aRunning?.status === "claimed", String(aRunning?.status));
      check("F：abandonStaleIntents(A) 不动 B 的孤儿意图", bGhost?.status === "claimed", String(bGhost?.status));
    } else {
      check("F：abandonStaleIntents 已实现", false, "missing");
    }

    // 启动顺序：选焦点 → 全局 recover 一次 → 逐任务 restore/stale/signals。
    const activeTasks = board.listTasks().filter((t) => t.archived === 0);
    eq("F：有 3 个非归档任务待恢复", activeTasks.length, 3);
    const focusId = activeTasks[0]?.id ?? null;
    eq("F：焦点取最新非归档任务", focusId, cId);
    hub.setTask(focusId);
    mgr.recoverStaleSessions();
    for (const t of activeTasks) {
      mgr.restoreSessions(t.id, { recover: false });
      const release = (board as unknown as { releaseStaleLeases?: (taskId: string, now?: number) => string[] }).releaseStaleLeases;
      const abandon = (board as unknown as { abandonStaleIntents?: (taskId: string) => number }).abandonStaleIntents;
      if (typeof release === "function") release.call(board, t.id);
      if (typeof abandon === "function") abandon.call(board, t.id);
      hub.recoverTaskSignals(t.id);
    }

    eq("F：恢复后 3 个任务都在", board.listTasks().filter((t) => t.archived === 0).length, 3);
    eq("F：恢复后内存里有 6 个会话", mgr.listSessions().length, 6);
    for (const [label, id] of [["A", aId], ["B", bId], ["C", cId]] as const) {
      const rows = mgr.listSessions(id);
      eq(`F：任务 ${label} 恢复 2 个会话`, rows.length, 2);
      check(`F：任务 ${label} 的会话都是终态 stopped`, rows.every((s) => s.status === "stopped"), JSON.stringify(rows.map((s) => s.status)));
    }
    eq("F：所有租约已清空", board.listAllLeases().length, 0);
    for (const id of [marker.intents.aRunning, marker.intents.aGhost, marker.intents.bRunning, marker.intents.bGhost]) {
      const intent = [...board.listIntents(aId), ...board.listIntents(bId)].find((i) => i.id === id);
      eq(`F：意图 ${id} 已 abandoned`, intent?.status, "abandoned");
    }
    const aDead = board.listDeadEnds(aId).map((d) => d.description).join("\n");
    const bDead = board.listDeadEnds(bId).map((d) => d.description).join("\n");
    check("F：A 的 stale 资源 incident 按任务归 A", aDead.includes(a1) && !aDead.includes(b1), aDead.slice(0, 200));
    check("F：B 的 stale 资源 incident 按任务归 B", bDead.includes(b1) && !bDead.includes(a1), bDead.slice(0, 200));
    check(
      "F：A 的租约释放事件不出现在 B 的视图",
      board.readSinceForTask(0, bId).every((r) => !r.body.includes(marker.leases.ghostA)),
      "",
    );

    // 幂等：重复恢复不重复创建会话。
    mgr.restoreSessions(cId, { recover: false });
    eq("F：重复 restoreSessions 不重复创建会话", mgr.listSessions().length, 6);

    const snap = hub.snapshot();
    eq("F：快照 tasks 仍为 3 条", snap.tasks.length, 3);
    eq("F：快照焦点是最新非归档任务", snap.task?.id, focusId);
    for (const t of snap.tasks) {
      eq(`F：任务 ${t.title} runningSessions=0`, t.runningSessions, 0);
      eq(`F：任务 ${t.title} totalSessions=2`, t.totalSessions, 2);
    }
  } finally {
    await mgr.shutdown();
    bridge.stop();
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- G 归档

async function partG(): Promise<void> {
  console.log("\n================ G 归档（活动会话需 force；不删历史）================\n");
  const h = await makeHarness("g", { FAKE_NO_PERMISSION: "1" });
  try {
    const aId = await createTask(h, "归档 A", "web", 10);
    const bId = await createTask(h, "归档 B", "misc", 5); // 焦点 B
    const a1 = await start(h, aId, "lead");
    const a2 = await start(h, aId, "verify");
    const b1 = await start(h, bId, "lead");
    check("G：前置 2+1 个会话启动成功", a1.ok && a2.ok && b1.ok, JSON.stringify([a1, a2, b1]));
    if (!a1.id || !a2.id || !b1.id) return;
    h.board.submitFact({
      taskId: aId,
      sessionId: a1.id,
      content: "flag{archive_keep}",
      witness: null,
      evidence: "E0",
    });

    await h.hub.dispatch({ type: "task.focus", taskId: aId });
    const denied = await h.hub.dispatch({ type: "task.archive", taskId: aId });
    check(
      "G：有活会话时 archive 被拒（文案含会话数与 force）",
      !denied.ok && (denied.error ?? "").includes("2") && (denied.error ?? "").includes("force"),
      denied.error ?? "ok",
    );
    eq("G：被拒后任务未归档", h.board.getTask(aId)?.archived, 0);
    eq("G：被拒后 A 的 2 个会话仍活跃", activeIds(h, aId).length, 2);

    const forced = await h.hub.dispatch({ type: "task.archive", taskId: aId, force: true });
    check("G：force 归档成功", forced.ok, JSON.stringify(forced));
    await waitFor(() => activeIds(h, aId).length === 0, 3000, "A 的会话被停止");
    eq("G：A 已归档", h.board.getTask(aId)?.archived, 1);
    eq("G：焦点回退到最新非归档任务 B", h.hub.currentTaskId, bId);
    eq("G：快照焦点是 B", h.hub.snapshot().task?.id, bId);
    check(
      "G：快照 tasks 仍含 A 且 archived=true",
      h.hub.snapshot().tasks.find((t) => t.id === aId)?.archived === true,
      JSON.stringify(h.hub.snapshot().tasks.find((t) => t.id === aId)),
    );
    eq("G：A 的历史会话仍可查", h.board.listSessions(aId).length, 2);
    eq("G：A 的历史事实仍可查", h.board.listFacts(aId).length, 1);
    eq("G：B 的会话不受影响", activeIds(h, bId).length, 1);

    const aUpserts = h.events.filter(
      (e) => e.type === "task.upsert" && e.task.id === aId && e.task.archived === true,
    );
    check("G：归档广播 task.upsert(archived=true)", aUpserts.length >= 1, `count=${aUpserts.length}`);
    const upserts = h.events.filter((e) => e.type === "task.upsert");
    const lastUpsert = upserts[upserts.length - 1];
    eq(
      "G：归档焦点后最后一条 task.upsert 是新焦点 B",
      lastUpsert && lastUpsert.type === "task.upsert" ? lastUpsert.task.id : null,
      bId,
    );

    const archivedStart = await start(h, aId);
    check("G：归档任务不能再起会话", !archivedStart.ok && (archivedStart.error ?? "").includes("已归档"), archivedStart.error ?? "ok");
    const archivedFocus = await h.hub.dispatch({ type: "task.focus", taskId: aId });
    check("G：归档任务不能再成为焦点", !archivedFocus.ok && (archivedFocus.error ?? "").includes("已归档"), archivedFocus.error ?? "ok");
    const again = await h.hub.dispatch({ type: "task.archive", taskId: aId });
    check("G：重复归档被拒", !again.ok && (again.error ?? "").includes("已归档"), again.error ?? "ok");

    // task.stopAll 只停会话，不归档。
    const stopAll = await h.hub.dispatch({ type: "task.stopAll", taskId: bId });
    check("G：task.stopAll(B) 成功", stopAll.ok, JSON.stringify(stopAll));
    await waitFor(() => activeIds(h, bId).length === 0, 3000, "B 会话停止");
    eq("G：task.stopAll 不归档", h.board.getTask(bId)?.archived, 0);

    // 归档全部任务 → 焦点回退到 null；再建任务能恢复焦点。
    const cId = await createTask(h, "归档 C", "pwn", 0);
    const archC = await h.hub.dispatch({ type: "task.archive", taskId: cId });
    check("G：无会话任务可直接归档", archC.ok, JSON.stringify(archC));
    eq("G：归档 C 后焦点回退到 B", h.hub.currentTaskId, bId);
    const archB = await h.hub.dispatch({ type: "task.archive", taskId: bId });
    check("G：归档最后一个非归档任务成功", archB.ok, JSON.stringify(archB));
    eq("G：全部归档后焦点为 null", h.hub.currentTaskId, null);
    eq("G：全部归档后快照 task=null", h.hub.snapshot().task, null);
    eq("G：全部归档后快照 tasks 仍含 3 条", h.hub.snapshot().tasks.length, 3);
    const dId = await createTask(h, "归档 D", "crypto", 0);
    eq("G：全归档后可新建任务恢复焦点", h.hub.currentTaskId, dId);
  } finally {
    await h.cleanup();
  }
}

async function main(): Promise<void> {
  await partAB();
  await partC();
  await partD();
  await partE();
  await partF();
  await partG();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: Error) => {
  console.error(err);
  process.exitCode = 1;
});
