/**
 * 补两个真实的验证缺口（交接文档 §5 第 1 条）：
 *
 *  A. 并发抢租约 —— 20 个会话同时抢同一个资源，只能有一个 WON。
 *     M1 验过"租约能拿能放、崩溃会释放"，但没验过并发。
 *
 *  B. blocked 终态端到端 —— §9.6 说"同一条规则被拒两次就终结会话"。
 *     退避计数有单元断言，但"真会话被 markBlocked 之后进程干净退出、死路留在台账里"
 *     从来没验过——因为没有 agent 会重复发同一个权限请求。现在假 agent 支持了（FAKE_REPEAT）。
 *
 * 用法：npm run verify:concurrency
 */

import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { ApprovalQueue, DenialTracker } from "../main/approval/queue.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";
import { REPO_ROOT } from "./test-root.ts";

const ROOT = REPO_ROOT;
const WORK = join(ROOT, ".ui-run", "concurrency");
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

async function partA(): Promise<void> {
  console.log("\n================ A 并发抢租约 ================\n");
  const dir = join(WORK, "a");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "并发抢租约", brief: "20 个会话抢同一个资源" });
  for (let i = 1; i <= 20; i += 1) {
    board.insertSession({
      id: `s${i}`,
      taskId: task.id,
      agent: "claude",
      role: "lead",
      tier: "autonomous",
      status: "idle",
    });
  }

  const outcomes = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      board.acquireLease({ resource: "target:10.0.0.9", sessionId: `s${i + 1}`, taskId: task.id }),
    ),
  );
  const won = outcomes.filter((o) => o.status === "WON");
  const lost = outcomes.filter((o) => o.status === "LOST");
  eq("20 个并发抢占里只有 1 个 WON", won.length, 1);
  eq("其余 19 个都是 LOST", lost.length, 19);

  const lease = board.getLease("target:10.0.0.9");
  check(
    "库里只留一条租约，持有者就是那个 WON 的会话",
    Boolean(lease) && lease!.holder === won[0]?.holder,
    `holder=${lease?.holder} 期望=${won[0]?.holder}`,
  );
  eq("LOST 的返回里带了当前持有者（拿不到要知道被谁占着）", Boolean(lost[0]?.holder), true);
  eq("租约表里不会有多条（资源是主键，天然互斥）", board.listAllLeases().length, 1);
  board.close();
}

async function partB(): Promise<void> {
  console.log("\n================ B blocked 终态端到端 ================\n");
  const dir = join(WORK, "b");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: "blocked 终态", brief: "同一规则被拒两次" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: newRunId() });
  await bridge.start();

  const upserts: Array<{ id: string; status: string }> = [];
  const queue = new ApprovalQueue({
    onUpsert: (v) => upserts.push({ id: v.id, status: v.status }),
    timeoutMs: 8000,
    onTimeout: "denied",
  });

  let markBlockedCalled: string | null = null;
  const statusDuringApproval: string[] = [];
  let mgr!: SessionManager;
  const denials = new DenialTracker(2, (sid, rule) => {
    markBlockedCalled = `${sid}|${rule}`;
    void mgr.markBlocked(sid, `同一规则被连续拒绝（${rule}）`);
  });

  mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: dir,
    onLine: () => undefined,
    onApprovalRequired: async (sessionId, _taskId, detail, decision) => {
      // R17：审批等待期必须是 waiting_approval（不是 running）。
      statusDuringApproval.push(mgr.getSession(sessionId)?.status ?? "missing");
      const pending = queue.request({
        taskId: task.id,
        sessionId,
        action: "session/request_permission",
        detail,
        rule: decision.rule,
        reason: decision.reason,
      });
      // 人工立刻点"拒绝"。queue.request() 在 Promise executor 里同步调用 onUpsert，
      // 所以此刻 upserts 的最后一条就是刚创建的那条待批项。
      const created = upserts[upserts.length - 1];
      if (created) queue.decide(created.id, "denied");
      const o = await pending;
      // A4：只有人工拒绝才计退避（这里确实是人工点拒绝，decidedBy=human）。
      if (o.decidedBy === "human" && o.decision === "denied") denials.note(sessionId, decision.rule);
      return o.decision === "approved";
    },
  });

  const rec = await mgr.startSession({
    taskId: task.id,
    spec: {
      command: process.execPath,
      args: [FAKE_AGENT],
      cwd: dir,
      env: {
        FAKE_TITLE: "run mimikatz sekurlsa::logonpasswords",
        FAKE_OUT: join(dir, "fake-out.json"),
        FAKE_REPEAT: "2",
      },
      label: "fake-agent",
    },
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });

  for (let i = 0; i < 60 && markBlockedCalled === null; i += 1) await sleep(200);
  await sleep(2000);

  check("两次拒绝触发了终止（DenialTracker 回调）", markBlockedCalled !== null, String(markBlockedCalled));
  check(
    "审批等待期会话状态是 waiting_approval",
    statusDuringApproval.length > 0 && statusDuringApproval.every((s) => s === "waiting_approval"),
    JSON.stringify(statusDuringApproval),
  );
  eq("会话终态是 blocked（不是 failed、不是 stopped）", rec.status, "blocked");
  eq("库里也记成 blocked", board.getSession(rec.id)?.status, "blocked");

  // 之前只验了"终态正确"，没验"进程真的没了"（L4 完成文档里记的缺口）。这里补上：
  // markBlocked 会 cancel + close + kill，所以那之后 agent 进程应当不复存在。
  const pidRow = (board.raw("SELECT pid FROM sessions WHERE id = ?", rec.id) as Array<{ pid: number | null }>)[0];
  const pid = pidRow?.pid ?? null;
  check("库里记下了该会话的 pid（前置：否则没法验进程）", pid !== null && pid > 0, `pid=${String(pid)}`);
  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0); // 信号 0 = 只探活性，不真发信号
      alive = true;
    } catch {
      alive = false;
    }
  }
  check("markBlocked 之后 agent 进程确实退出了（不留孤儿）", pid !== null && !alive, `pid=${String(pid)} alive=${alive}`);

  // 反面对照：正常跑完的会话，进程也应当已经退出（不是只有被 blocked 才收）
  const runningNow = mgr.listSessions().filter((s) => s.status === "running").length;
  eq("此刻没有仍在 running 的会话（收尾干净）", runningNow, 0);

  const blockedDeadEnds = board.listDeadEnds(task.id).filter((d) => d.scope === "blocked");
  check(
    "留了一条 scope=blocked 的死路（让队友知道这条线被规则掐了）",
    blockedDeadEnds.length === 1,
    JSON.stringify(blockedDeadEnds.map((d) => d.description.slice(0, 60))),
  );
  check(
    "没有写崩溃记录（blocked 不是崩溃，不该误导后续简报）",
    board.listDeadEnds(task.id).every((d) => d.scope !== "incident"),
    JSON.stringify(board.listDeadEnds(task.id).map((d) => d.scope)),
  );
  // upsert 同一条会出现两次（创建时 + 决策时），所以按 id 去重再数
  const distinct = [...new Set(upserts.map((u) => u.id))];
  eq("两次请求各进过一次审批队列（按 id 去重）", distinct.length, 2);
  // 注意：upserts 是**事件日志**（同一条会记 pending 与 denied 两次），
  // 不能拿它当"当前状态"来断言。当前状态要看队列自己。
  eq("队列里没有待批项（不会永久挂起）", queue.pendingCount(), 0);
  check(
    "队列视图里也没有 pending",
    queue.list().every((v) => v.status !== "pending"),
    JSON.stringify(queue.list().map((v) => v.status)),
  );
  eq(
    "两次请求的事件里各出现过一次 denied（人工确实拒了）",
    upserts.filter((u) => u.status === "denied").length,
    2,
  );
  check(
    "假 agent 收到了应答（拒绝要回给 agent）",
    existsSync(join(dir, "fake-out.json")),
    "fake-out.json 已生成",
  );

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  console.log("========== 补两个验证缺口 ==========");
  await partA();
  await partB();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n========== ${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
