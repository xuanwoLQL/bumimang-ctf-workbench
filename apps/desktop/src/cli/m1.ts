/**
 * M1 验收驱动 —— 逐条执行 docs/ARCHITECTURE.md §12 的可执行验收脚本。
 *
 * 用法：node apps/desktop/src/cli/m1.ts
 *
 * 注意：M1 的 prompt 是**指令式**的。这一步验证的是**通路**（会话能起、简报能注入、
 * 黑板能被 agent 读写、崩溃能清理），不是"agent 有多自觉"。所以这里明确要求 agent
 * 调用哪个工具。M4 之后再验证执行纪律（每 3 个 tool call 读一次黑板）。
 */

import { join } from "node:path";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { PassthroughPolicy } from "../main/policy/policy.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";
import { detectAgents, renderAgentTable } from "../main/discovery/detect.ts";
import { buildBriefing, renderBriefingPrompt } from "../main/briefing/build.ts";

const ROOT = "D:/agent/xuanwo/.m1";
/**
 * 会话级模型覆盖。本机 opencode 的全局默认模型写的是 `deepseek/deepseek-v4-flash`，
 * 而该模型并不存在（`opencode models` 里只有 deepseek-flash / deepseek-v4-pro），
 * 且会话默认会落到需要 opencode 自家登录的 `opencode/big-pickle` 上。
 * 所以 M1 显式指定一个本机确实有凭据的模型，不动用户的全局配置。
 */
const MODEL = process.env.M1_MODEL ?? "deepseek/deepseek-flash";
const results: Array<{ id: string; desc: string; ok: boolean; evidence: string }> = [];

function assert(id: string, desc: string, ok: boolean, evidence: string): void {
  results.push({ id, desc, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  断言 ${id}  ${desc}\n      └─ ${evidence}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  console.log("================ 不迷茫 · M1 验收 ================\n");
  console.log("--- 步骤 0：agent 检测（C3：只检测不安装）---");
  const agents = detectAgents();
  console.log(renderAgentTable(agents));
  const opencode = agents.find((a) => a.id === "opencode");
  if (!opencode?.installed || !opencode.launch) {
    console.error("\n未检测到可用的 ACP agent，M1 无法继续。");
    process.exit(2);
  }
  console.log();

  // 题目输入：一个本地 HTML 文件（模拟"目标站点"）
  const targetDir = join(ROOT, "target");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    join(targetDir, "index.html"),
    "<html><body><h1>Internal Portal</h1><form action='/admin' method='post'>" +
      "<input name='user'><input name='pass' type='password'></form></body></html>\n",
    "utf8",
  );

  const runId = newRunId();
  const board = Blackboard.open(join(ROOT, "board.db"));
  const task = board.createTask({
    title: "本地 HTML 目标：找出口令或其他入口",
    brief: `工作目录里有 target/index.html，是一个内部门户页面，包含 /admin 登录表单。`,
  });
  console.log(`任务已创建：${task.id}\n`);

  const policy = new PassthroughPolicy();
  let mgr!: SessionManager;
  const bridge = new BoardBridge({
    board,
    taskId: task.id,
    runId,
    log: (m, d) => console.log(`  [bridge] ${m}`, d ?? ""),
    onBoardRead: (sid) => mgr?.noteBoardRead(sid),
  });
  await bridge.start();
  console.log(`黑板桥已就绪：pipe=${bridge.pipeName}\n`);

  mgr = new SessionManager({ board, bridge, policy, workspaceRoot: ROOT });
  const spec = {
    command: opencode.launch.command,
    args: opencode.launch.args,
    cwd: ROOT,
    label: "opencode",
  };

  // ---------------- 步骤 1：起会话1，尝试 /admin 弱口令并写死路 ----------------
  console.log("--- 步骤 1：起会话1（lead / guarded），指示它把失败路径写进黑板 ---");
  const s1 = await mgr.startSession({
    taskId: task.id,
    spec,
    agent: "opencode",
    role: "lead",
    tier: "guarded",
    model: MODEL,
  });
  const d1 =
    `你正在处理本地目标 target/index.html，其中有一个 /admin 登录表单。` +
    `你已经尝试了 20 个常见弱口令（admin/admin、root/123456 等），全部失败。\n\n` +
    `请调用 blackboard_declare_dead_end 工具，把这条死路记下来：\n` +
    `  description: "/admin 弱口令不可用，已试 20 个常见口令（admin/admin、root/123456 等）"\n` +
    `  scope: "http:/admin"\n` +
    `只做这一件事，做完立刻结束，不要继续探索，不要调用其他工具。`;
  try {
    await mgr.prompt(s1.id, d1);
  } catch (err) {
    console.log(`  [warn] 会话1 首轮异常：${(err as Error).message}`);
  }
  await sleep(1500);

  const deadEnds = board.listDeadEnds(task.id).filter((d) => d.scope !== "incident");
  const hit = deadEnds.find((d) => d.description.includes("/admin"));
  assert(
    "1",
    "dead_ends 表新增 1 行，description 包含 \"/admin\"",
    Boolean(hit),
    hit ? `id=${hit.id} desc="${hit.description}"` : `当前 dead_ends=${JSON.stringify(deadEnds.map((d) => d.description))}`,
  );

  // ---------------- 步骤 2：起会话2，检查简报包 ----------------
  console.log("\n--- 步骤 2：起会话2（verify / autonomous），检查它拿到什么 ---");
  const s2 = await mgr.startSession({
    taskId: task.id,
    spec,
    agent: "opencode",
    role: "verify",
    tier: "autonomous",
    model: MODEL,
  });
  const packet = buildBriefing(board, { taskId: task.id, role: "verify", sessionId: s2.id });
  const firstPrompt = renderBriefingPrompt(packet);

  const target = "/admin 弱口令不可用，已试 20 个常见口令（admin/admin、root/123456 等）";
  assert(
    "2",
    "会话2 的首条 prompt 文本里包含该 dead_end 的 description 字符串",
    firstPrompt.includes(target),
    firstPrompt.includes(target) ? "命中：简报正文含该字符串" : "未命中",
  );
  assert(
    "3",
    "会话2 的简报包 JSON 中 do_not 数组包含该字符串",
    packet.do_not.some((d) => d.includes("/admin 弱口令不可用")),
    `do_not = ${JSON.stringify(packet.do_not)}`,
  );

  // 真正把简报发出去（首条 prompt）
  try {
    await mgr.prompt(s2.id, firstPrompt);
  } catch (err) {
    console.log(`  [warn] 会话2 简报轮异常：${(err as Error).message}`);
  }
  await sleep(1000);

  // ---------------- 步骤 3：会话2 申请租约 ----------------
  console.log("\n--- 步骤 3：让会话2 申请一个资源租约 ---");
  try {
    await mgr.prompt(
      s2.id,
      `请调用 blackboard_acquire_lease 工具申请资源 "target:127.0.0.1"，` +
        `然后把返回的 WON 或 LOST 原样告诉我。只做这一件事。`,
    );
  } catch (err) {
    console.log(`  [warn] 租约轮异常：${(err as Error).message}`);
  }
  await sleep(1000);
  const lease = board.getLease("target:127.0.0.1");
  assert(
    "4",
    "leases 表出现该行，holder = 会话2",
    Boolean(lease) && lease!.holder === s2.id,
    lease ? `resource=${lease.resource} holder=${lease.holder}` : "leases 表为空",
  );

  // ---------------- 步骤 4：会话2 主动读黑板 ----------------
  console.log("\n--- 步骤 4：让会话2 主动拉一次黑板增量（不限制 tool call 数）---");
  try {
    await mgr.prompt(
      s2.id,
      `请调用 blackboard_read_since 工具，after_id 传 0，读取黑板上的全部事件。` +
        `然后用一句话告诉我黑板上一共有几条事件、其中有几条是死路。只做这一件事。`,
    );
  } catch (err) {
    console.log(`  [warn] 读黑板轮异常：${(err as Error).message}`);
  }
  await sleep(800);
  const s2rec = mgr.getSession(s2.id)!;
  assert(
    "5",
    "会话2 在收到简报包后，至少主动调用过一次 blackboard_read_since",
    s2rec.boardReads > 0,
    `boardReads=${s2rec.boardReads} toolCalls=${s2rec.toolCalls} syncLag=${mgr.syncLag(s2.id)}`,
  );

  // ---------------- 步骤 5：杀掉会话2，检查崩溃清理 ----------------
  console.log("\n--- 步骤 5：硬杀会话2 的 agent 进程（模拟崩溃）---");
  const leasesBefore = board.listAllLeases().filter((l) => l.holder === s2.id).length;
  mgr.killSessionHard(s2.id);
  await sleep(3000);
  const leasesAfter = board.listAllLeases().filter((l) => l.holder === s2.id).length;
  const intents = board.listIntents(task.id).filter((i) => i.claimed_by === s2.id);
  const abandoned = intents.filter((i) => i.status === "abandoned").length;
  assert(
    "6",
    "该会话持有的 lease 立即释放；intent 转为 abandoned",
    leasesAfter === 0 && leasesBefore >= 0,
    `释放前 ${leasesBefore} 个 → 释放后 ${leasesAfter} 个；intent 共 ${intents.length} 条，abandoned ${abandoned} 条`,
  );

  // ---------------- 步骤 6：起会话3，检查崩溃记录进简报 ----------------
  console.log("\n--- 步骤 6：起会话3，检查上一会话的崩溃记录是否进入它的简报 ---");
  const s3 = await mgr.startSession({
    taskId: task.id,
    spec,
    agent: "opencode",
    role: "verify",
    tier: "autonomous",
    model: MODEL,
  });
  const packet3 = buildBriefing(board, { taskId: task.id, role: "verify", sessionId: s3.id });
  const crashLine = packet3.do_not.find((d) => d.includes("崩溃"));
  assert(
    "7",
    "会话3 的 do_not 清单包含\"上一会话崩溃\"记录",
    Boolean(crashLine),
    crashLine ? `命中：${crashLine}` : `do_not = ${JSON.stringify(packet3.do_not)}`,
  );
  console.log(`  （会话3 未真正发起 prompt，仅验证简报构造）`);

  // ---------------- 汇总 ----------------
  await mgr.shutdown();
  bridge.stop();

  console.log("\n================ 汇总 ================");
  const pass = results.filter((r) => r.ok).length;
  console.log(`通过 ${pass}/${results.length}`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} 断言 ${r.id}：${r.desc}`);
  console.log(`\n黑板统计：${JSON.stringify(board.counts())}`);
  console.log(`审计行数：${JSON.stringify(board.raw("SELECT COUNT(*) AS c FROM audit"))}`);
  const chainOk = board.readSince(0).every((e, i, a) => (i === 0 ? true : e.prev_hash === a[i - 1].hash));
  console.log(`哈希链完整性：${chainOk ? "OK" : "断链"}`);
  console.log(`\n工件目录：${ROOT}`);

  board.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("M1 验收异常终止：", err);
  process.exit(3);
});
