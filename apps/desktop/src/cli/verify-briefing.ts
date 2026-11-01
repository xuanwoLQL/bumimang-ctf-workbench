/**
 * 简报包扇出验收 —— 架构文档 §7.3 的确定性验证。
 *
 * 为什么它是要紧的一条：整个"多会话并行不重复劳动"的主张，全押在**迟到加入者拿到的是
 * 蒸馏后的状态**这件事上。如果简报漏了队友的死路/意图/租约，第 2、3 个会话就会重做
 * 第 1 个已经做完的事——那"1 加到 3 省时间"就是假的。
 *
 * M1 验过两会话的"死路继承"。这里补的是三会话扇出 + 意图/租约 + 自我排除 + 崩溃记录。
 *
 * 用法：npm run verify:briefing
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Blackboard } from "../main/blackboard/board.ts";
import { buildBriefing, renderBriefingPrompt } from "../main/briefing/build.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "briefing");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  console.log("========== 简报包扇出验收（三会话）==========\n");

  const board = Blackboard.open(join(WORK, `board-${Date.now()}.db`));
  const task = board.createTask({
    title: "本地门户找入口",
    brief: "target/index.html 是一个内部门户，有 /admin 登录表单。",
  });

  // ---- s1 干活：写死路、登记意图、占资源 ----
  board.insertSession({ id: "s1", taskId: task.id, agent: "claude", role: "lead", tier: "guarded", status: "running" });
  board.declareDeadEnd({
    taskId: task.id,
    sessionId: "s1",
    description: "/admin 弱口令不可用，已试 20 个常见口令",
    scope: "http:/admin",
  });
  board.submitFact({
    taskId: task.id,
    sessionId: "s1",
    content: "登录表单的 action 提交到 /admin",
    witness: "Read target/index.html",
  });
  const intent = board.openIntent({
    taskId: task.id,
    sessionId: "s1",
    description: "爆破 /admin 的 CSRF token 生成方式",
  });
  const lease = board.acquireLease({ resource: "target:127.0.0.1", sessionId: "s1", taskId: task.id });
  eq("s1 拿到目标租约（前置）", lease.status, "WON");

  // ---- 扇出：s2 加入 ----
  board.insertSession({ id: "s2", taskId: task.id, agent: "claude", role: "verify", tier: "autonomous", status: "idle" });
  const b2 = buildBriefing(board, { taskId: task.id, role: "verify", sessionId: "s2" });
  const prompt2 = renderBriefingPrompt(b2);

  check(
    "s2 的简报带上了 s1 的死路",
    b2.dead_ends.some((d) => d.includes("/admin 弱口令不可用")),
    JSON.stringify(b2.dead_ends),
  );
  check(
    "死路进了 do_not（不只是陈列，而是明确禁止）",
    b2.do_not.some((d) => d.includes("不要重复尝试") && d.includes("/admin 弱口令不可用")),
    JSON.stringify(b2.do_not.filter((d) => d.includes("/admin"))),
  );
  check(
    "s2 的简报带上了 s1 正在做的意图（in_flight）",
    b2.in_flight.some((i) => i.intent.includes("CSRF token") && i.by === "s1"),
    JSON.stringify(b2.in_flight),
  );
  check(
    "s1 的意图进了 do_not（防重复劳动）",
    b2.do_not.some((d) => d.includes("不要重复做") && d.includes("CSRF token")),
    JSON.stringify(b2.do_not.filter((d) => d.includes("CSRF"))),
  );
  check(
    "s2 的简报带上了被占用的资源（leases_held）",
    b2.leases_held.some((l) => l.resource === "target:127.0.0.1" && l.holder === "s1"),
    JSON.stringify(b2.leases_held),
  );
  check(
    "被占资源进了 do_not（拿不到就别等）",
    b2.do_not.some((d) => d.includes("不要占用 target:127.0.0.1")),
    JSON.stringify(b2.do_not.filter((d) => d.includes("target:"))),
  );
  check(
    "s2 拿到了 s1 的事实（带证据等级）",
    b2.facts_verified.some((f) => f.includes("登录表单的 action")),
    JSON.stringify(b2.facts_verified),
  );
  check(
    "简报正文（真正发给 agent 的 prompt）里也带着这些禁令",
    prompt2.includes("不要重复尝试") && prompt2.includes("CSRF token"),
    `prompt 长度 ${prompt2.length}`,
  );
  check(
    "简报里带了黑板同步纪律",
    prompt2.includes("blackboard_read_since") && prompt2.includes("每完成 3 个工具调用"),
    b2.sync_protocol.call,
  );

  // ---- 自我排除：s1 自己的简报不该叫它避开自己 ----
  const b1 = buildBriefing(board, { taskId: task.id, role: "lead", sessionId: "s1" });
  check(
    "s1 自己的简报不会叫它避开自己的意图（自我排除）",
    !b1.in_flight.some((i) => i.by === "s1"),
    JSON.stringify(b1.in_flight),
  );
  check(
    "s1 自己的简报不会叫它别占自己已占的资源",
    !b1.do_not.some((d) => d.includes("不要占用 target:127.0.0.1")),
    JSON.stringify(b1.do_not.filter((d) => d.includes("target:"))),
  );

  // ---- 崩溃记录：s2 崩了，扇出 s3 ----
  board.setSessionStatus("s2", "failed");
  board.declareDeadEnd({
    taskId: task.id,
    sessionId: "s2",
    description: "上一会话（s2）崩溃退出（code=1 signal=null），不要假设它的中间结论成立",
    scope: "incident",
  });
  board.insertSession({ id: "s3", taskId: task.id, agent: "claude", role: "recon", tier: "autonomous", status: "idle" });
  const b3 = buildBriefing(board, { taskId: task.id, role: "recon", sessionId: "s3" });
  check(
    "s3 的简报带上了崩溃事故记录",
    b3.incidents.some((i) => i.includes("s2") && i.includes("崩溃")),
    JSON.stringify(b3.incidents),
  );
  check(
    "崩溃记录同时进了 do_not",
    b3.do_not.some((d) => d.includes("崩溃")),
    JSON.stringify(b3.do_not.filter((d) => d.includes("崩溃"))),
  );
  check(
    "s3 同时继承了 s1 的死路与意图（多层继承）",
    b3.dead_ends.some((d) => d.includes("/admin 弱口令不可用")) &&
      b3.in_flight.some((i) => i.intent.includes("CSRF token")),
    `dead_ends=${b3.dead_ends.length} in_flight=${b3.in_flight.length}`,
  );

  // ---- 同步起点 ----
  eq(
    "简报的 after_id 等于写入时刻的黑板末尾（拉模式从正确位置开始）",
    b3.sync_protocol.after_id,
    board.lastEventId(),
  );

  // ---- 第三个会话看的是同一块黑板 ----
  const leasesNow = board.listAllLeases();
  check(
    "租约是全局可见的（三个会话看同一块黑板）",
    leasesNow.some((l) => l.resource === "target:127.0.0.1" && l.holder === "s1"),
    JSON.stringify(leasesNow.map((l) => `${l.resource}@${l.holder}`)),
  );
  void intent;

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n========== ${passed}/${results.length} 通过 ==========`);
  board.close();
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
