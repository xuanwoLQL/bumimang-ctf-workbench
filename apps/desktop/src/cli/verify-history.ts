/**
 * 对话历史 / 任务状态 / 工作目录 —— R16 的确定性验收。
 *
 * 三件事必须成立，否则「重启后和没用过一样」的抱怨就还在：
 *  1. 每次 append 都写 `sessions/<id>/stream.jsonl`，重启后能读回同一段对话；
 *  2. 老会话（升级前只有 wire.jsonl）也能从线日志反推出对话；
 *  3. 重启恢复的会话不会被误标成 running（它没有活进程），但历史仍可回看；
 *  4. 任务「已解出 / 待解」落库，改回待解时不会留着旧答案；
 *  5. 工作目录包含性判断不会把 `work-evil` 当成 `work` 的子目录。
 *
 * 用法：npm run verify:history
 */

import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { Blackboard } from "../main/blackboard/board.ts";
import { SessionManager } from "../main/session/manager.ts";
import { isInsideDir } from "../main/acp/client.ts";
import { extractFlag, redactSecrets } from "../main/stream/normalize.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { BRIDGE_RPC } from "../main/mcp-host/protocol.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import { buildBriefing } from "../main/briefing/build.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "history-verify");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function newManager(board: Blackboard, workRoot: string): SessionManager {
  return new SessionManager({
    board,
    // 恢复路径不碰 bridge / policy；这里只验证持久化，不 spawn agent。
    bridge: null as never,
    policy: null as never,
    workspaceRoot: WORK,
    workRoot,
    onLine: () => undefined,
  });
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  console.log("========== 对话历史 / 任务状态 / 工作目录验收 ==========\n");

  const dbPath = join(WORK, "board.db");
  const workRoot = join(WORK, "work");
  mkdirSync(workRoot, { recursive: true });
  const board = Blackboard.open(dbPath);
  const task = board.createTask({ title: "R16 历史验收", brief: "验证重启后对话还在" });

  // ---------- 1. 新格式：stream.jsonl 原样读回 ----------
  board.insertSession({ id: "s1", taskId: task.id, agent: "codex", role: "lead", tier: "guarded", status: "running" });
  const s1Dir = join(WORK, "sessions", "s1");
  mkdirSync(s1Dir, { recursive: true });
  const historyLines = [
    { seq: 1, ts: 1_700_000_000_001, kind: "user_prompt", text: "先看 /robots.txt" },
    { seq: 2, ts: 1_700_000_000_002, kind: "agent_message", text: "我看到 Disallow: /backup" },
    { seq: 3, ts: 1_700_000_000_003, kind: "tool_call", title: "curl /backup/", toolKind: "execute", status: "in_progress" },
  ];
  writeFileSync(join(s1Dir, "stream.jsonl"), historyLines.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");

  // R17：flag 被流式 chunk 拆开（flag{sp + lit_ok}），重启后重扫历史要能拼回来。
  board.insertSession({ id: "s-flag", taskId: task.id, agent: "codex", role: "verify", tier: "guarded", status: "idle" });
  const sFlagDir = join(WORK, "sessions", "s-flag");
  mkdirSync(sFlagDir, { recursive: true });
  writeFileSync(
    join(sFlagDir, "stream.jsonl"),
    [
      { seq: 1, ts: 1_700_000_000_201, kind: "agent_message", text: "结果是 flag{sp" },
      { seq: 2, ts: 1_700_000_000_202, kind: "agent_message", text: "lit_ok}" },
    ].map((u) => JSON.stringify(u)).join("\n") + "\n",
    "utf8",
  );

  // R17：旧进程留下的租约 / claimed 意图不能继续出现在新会话的简报里。
  const lease = board.acquireLease({ resource: "target:r17", sessionId: "s1", taskId: task.id });
  eq("前置：s1 拿到租约", lease.status, "WON");
  const intent = board.openIntent({ taskId: task.id, sessionId: "s1", description: "旧进程没做完的事" });

  const mgr1 = newManager(board, workRoot);
  mgr1.restoreSessions(task.id);
  const h1 = mgr1.historyOf("s1");
  eq("重启后对话条数一致", h1.length, 3);
  eq("第一块是人工提示（不是简报）", h1[0]?.kind, "user_prompt");
  eq("第一块内容原样保留", h1[0]?.text, "先看 /robots.txt");
  eq("块序号连续", h1.map((u) => u.seq).join(","), "1,2,3");
  eq("重启后会话不会假装还在跑", mgr1.getSession("s1")?.status, "stopped");
  eq("库里也落成 stopped（end_at 有值）", board.listSessions(task.id)[0]?.ended_at != null, true);
  eq("旧会话的租约已释放", board.listAllLeases().some((l) => l.holder === "s1"), false);
  eq(
    "旧会话的意图已 abandon",
    board.listIntents(task.id).find((i) => i.id === intent.id)?.status,
    "abandoned",
  );
  check(
    "释放过资源的旧会话留了一条 incident 死路",
    board.listDeadEnds(task.id).some((d) => d.scope === "incident" && d.description.includes("s1")),
    JSON.stringify(board.listDeadEnds(task.id).map((d) => d.description)),
  );
  check(
    "恢复后新事件从历史末尾继续编号",
    (() => {
      (mgr1 as unknown as { recordUserPrompt(id: string, text: string): void }).recordUserPrompt("s1", "补充：看响应头");
      const h = mgr1.historyOf("s1");
      return h.length === 4 && h[3]?.seq === 4 && h[3]?.kind === "user_prompt";
    })(),
  );

  // ---------- 2. 老格式：没有 stream.jsonl，从 wire.jsonl 反推 ----------
  board.insertSession({ id: "s2", taskId: task.id, agent: "claude", role: "verify", tier: "guarded", status: "idle" });
  const s2Dir = join(WORK, "sessions", "s2");
  mkdirSync(s2Dir, { recursive: true });
  const wire = [
    { ts: 1_700_000_000_101, dir: "out", message: { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "acp-s2", prompt: [{ type: "text", text: "你是一支多 agent 解题队中的一员……（简报）" }] } } },
    { ts: 1_700_000_000_102, dir: "out", message: { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "acp-s2", prompt: [{ type: "text", text: "试试备份目录" }] } } },
    { ts: 1_700_000_000_103, dir: "in", message: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-s2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "备份目录 403，换路径" } } } } },
    { ts: 1_700_000_000_104, dir: "in", message: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-s2", update: { sessionUpdate: "tool_call", title: "curl /backup/", kind: "execute", status: "failed" } } } },
  ];
  writeFileSync(join(s2Dir, "wire.jsonl"), wire.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  mgr1.restoreSessions(task.id);
  const h2 = mgr1.historyOf("s2");
  eq("老会话从 wire.jsonl 反推出 3 条（跳过简报 prompt）", h2.length, 3);
  eq("老会话的第一条是人工 prompt", h2[0]?.kind, "user_prompt");
  eq("简报没有被当成用户发言", h2[0]?.text, "试试备份目录");
  eq("agent 消息被还原", h2[1]?.kind, "agent_message");
  eq("工具状态被还原", h2[2]?.status, "failed");

  // ---------- 3. 任务状态：已解出 / 改回待解 ----------
  board.setTaskStatus(task.id, "solved", "flag{restart_me}", "s1");
  let t = board.getTask(task.id);
  eq("标记已解出后状态落库", t?.status, "solved");
  eq("答案落库", t?.answer, "flag{restart_me}");
  eq("解题人落库", t?.solved_by, "s1");
  board.setTaskStatus(task.id, "open");
  t = board.getTask(task.id);
  eq("改回待解后状态是 open", t?.status, "open");
  eq("改回待解会清掉旧答案", t?.answer ?? null, null);
  eq("改回待解会清掉解题人", t?.solved_by ?? null, null);

  // ---------- 4. 新建任务后，MCP 写入必须落到新任务（R17） ----------
  const task2 = board.createTask({ title: "第二个任务", brief: "验证任务隔离" });
  board.insertSession({ id: "s-new", taskId: task2.id, agent: "codex", role: "lead", tier: "guarded", status: "idle" });
  // 桥启动时仍指向旧任务 —— 模拟真实 bug 条件；route 必须用 sessionId 查库纠正。
  const bridge = new BoardBridge({ board, taskId: task.id, runId: "r17-task-isolation" });
  const route = (
    bridge as unknown as { route(method: string, params: Record<string, unknown>): Promise<unknown> }
  ).route.bind(bridge);
  await route(BRIDGE_RPC.submitFact, {
    sessionId: "s-new",
    content: "新任务的事实 flag{t2_fact}",
    witness: "target/flag.txt",
  });
  check(
    "新任务的 MCP 事实写进新任务",
    board.listFacts(task2.id).some((f) => f.content.includes("flag{t2_fact}")),
    JSON.stringify(board.listFacts(task2.id).map((f) => f.content)),
  );
  check(
    "旧任务没有被新任务的写入污染",
    board.listFacts(task.id).every((f) => !f.content.includes("flag{t2_fact}")),
    JSON.stringify(board.listFacts(task.id).map((f) => f.content)),
  );
  const t2Rows = board.readSinceForTask(0, task2.id);
  check(
    "按任务读黑板只返回本任务事件",
    t2Rows.length > 0 && t2Rows.every((r) => r.subject === task2.id || r.session_id === "s-new"),
    `${t2Rows.length} 条，subject=${JSON.stringify([...new Set(t2Rows.map((r) => r.subject))])}`,
  );

  // ---------- 4b. 租约按任务隔离 + 过期回收（R18） ----------
  const oldLease = board.acquireLease({ resource: "target:old-task", sessionId: "s1", taskId: task.id });
  eq("前置：旧任务拿到 target:old-task", oldLease.status, "WON");
  eq("新任务看不到旧任务租约", board.listLeases(task2.id).length, 0);
  const b2 = buildBriefing(board, { taskId: task2.id, role: "lead", sessionId: "s-new" });
  check("新任务简报的 leases_held 为空", b2.leases_held.length === 0, JSON.stringify(b2.leases_held));
  check(
    "新任务简报的 do_not 不含旧任务租约",
    b2.do_not.every((d) => !d.includes("target:old-task")),
    JSON.stringify(b2.do_not),
  );
  const leaseView = (await route(BRIDGE_RPC.queryView, {
    sessionId: "s-new",
    view: "leases",
  })) as unknown[];
  check("MCP leases 视图只返回本任务租约", Array.isArray(leaseView) && leaseView.length === 0, JSON.stringify(leaseView));
  const leaseHub = new HubService({
    board,
    sessions: mgr1,
    bus: new EventBus(),
    workspaceRoot: WORK,
    workDir: workRoot,
  });
  leaseHub.setTask(task2.id);
  eq("快照 leases 只返回本任务租约", leaseHub.snapshot().board.leases.length, 0);

  board.acquireLease({ resource: "target:ttl", sessionId: "s-new", taskId: task2.id, ttlMs: 500 });
  eq("TTL 内租约可见", board.listLeases(task2.id).some((l) => l.resource === "target:ttl"), true);
  await new Promise((r) => setTimeout(r, 550));
  eq("TTL 过期后不再返回", board.listLeases(task2.id).some((l) => l.resource === "target:ttl"), false);
  const reclaimed = board.acquireLease({ resource: "target:ttl", sessionId: "s1", taskId: task.id });
  eq("过期租约可被另一任务重新抢占（回收正确）", reclaimed.status, "WON");
  board.releaseLease("target:ttl", "s1", "test cleanup");
  board.releaseLease("target:old-task", "s1", "test cleanup");

  // ---------- 4c. A2：releaseLease 必须校验 holder ----------
  board.acquireLease({ resource: "target:holder", sessionId: "s1", taskId: task.id });
  eq(
    "非 holder 不能放掉别人的租约",
    board.releaseLease("target:holder", "s-new", "越权尝试"),
    false,
  );
  eq(
    "租约仍握在原 holder 手里",
    board.listLeases(task.id).find((l) => l.resource === "target:holder")?.holder,
    "s1",
  );
  eq("holder 本人可以放", board.releaseLease("target:holder", "s1", "正常释放"), true);
  board.acquireLease({ resource: "target:system-rel", sessionId: "s1", taskId: task.id });
  eq("系统路径（sessionId=null）保留旁路", board.releaseLease("target:system-rel", null, "系统清理"), true);

  // 真·命名管道回归：模拟 MCP 子进程带着陈旧 BUMIMANG_TASK 连接管道提交事实。
  await bridge.start();
  const token = bridge
    .envForSession("s-new", task.id) // 故意传旧任务，模拟桥启动时固定的 env
    .find((e) => e.name === "BUMIMANG_TOKEN")?.value ?? "";
  const replies = await new Promise<Array<{ id: number; result?: unknown; error?: string }>>((resolve, reject) => {
    const sock = connect(bridge.pipeName);
    let buf = "";
    const got: Array<{ id: number; result?: unknown; error?: string }> = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("管道 RPC 超时"));
    }, 5000);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: 0, method: BRIDGE_RPC.hello, token, sessionId: "s-new" }) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        got.push(msg);
        if (msg.id === 0) {
          sock.write(
            JSON.stringify({
              id: 1,
              method: BRIDGE_RPC.submitFact,
              params: {
                sessionId: "s-new",
                taskId: task.id, // 陈旧 env；桥必须以库里的 s-new.task_id 为准
                content: "管道回归 flag{pipe_fact}",
                witness: "target/flag.txt",
              },
            }) + "\n",
          );
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          sock.end();
          resolve(got);
        }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  bridge.stop();
  check("命名管道 RPC 收到成功应答", replies.some((r) => r.id === 1 && !r.error), JSON.stringify(replies));
  check(
    "真实管道写入仍落到会话所属的新任务",
    board.listFacts(task2.id).some((f) => f.content.includes("flag{pipe_fact}")),
    JSON.stringify(board.listFacts(task2.id).map((f) => f.content)),
  );

  // ---------- 5. 工作目录包含性 ----------
  check("工作目录自身算在内", isInsideDir(workRoot, workRoot));
  check("子目录算在内", isInsideDir(workRoot, join(workRoot, "scan", "out.txt")));
  check("前缀相同的兄弟目录不算（work-evil ≠ work）", !isInsideDir(workRoot, `${workRoot}-evil`));
  check("上级目录不算", !isInsideDir(workRoot, join(workRoot, "..")));

  // junction / symlink 逃逸：work/escape -> outside，字面上仍在 work 下，必须判越界。
  const outside = join(WORK, "outside");
  mkdirSync(outside, { recursive: true });
  const escape = join(workRoot, "escape");
  try {
    symlinkSync(outside, escape, "junction");
    check(
      "junction 指向工作目录外 → 判越界",
      !isInsideDir(workRoot, join(escape, "x.txt")),
      `link=${escape} -> ${outside}`,
    );
  } catch (err) {
    check("junction 指向工作目录外 → 判越界", false, `无法创建 junction：${(err as Error).message}`);
  }

  // ---------- 6. flag 候选识别 ----------
  eq("从消息里识别 flag", extractFlag("提交：flag{r16_ok}"), "flag{r16_ok}");
  eq("大小写不敏感", extractFlag("FLAG{ABC}"), "FLAG{ABC}");
  eq("普通文本不误报", extractFlag("没有 flag 在这里"), null);

  // ---------- 7. 真·重开数据库：证明不是内存幻觉 ----------
  mgr1.shutdown();
  board.close();
  const board2 = Blackboard.open(dbPath);
  const mgr2 = newManager(board2, workRoot);
  mgr2.restoreSessions(task.id);
  const reopened = mgr2.historyOf("s1");
  eq("关库重开后历史仍在", reopened.length, 3);
  eq("重开后任务状态仍是待解", board2.getTask(task.id)?.status, "open");

  // 重启后从历史重扫 flag 候选（跨 chunk）
  const hubBus = new EventBus();
  const hubEvents: Array<{ type: string; sessionId?: string }> = [];
  hubBus.on((e) => hubEvents.push({ type: e.type, sessionId: "sessionId" in e ? (e as { sessionId: string }).sessionId : undefined }));
  const hub = new HubService({
    board: board2,
    sessions: mgr2,
    bus: hubBus,
    workspaceRoot: WORK,
    workDir: workRoot,
  });
  hub.setTask(task.id);
  hub.recoverTaskSignals();
  eq("重启后能拼回跨 chunk 的 flag 候选", hub.snapshot().task?.flagCandidate, "flag{split_ok}");
  const snap = hub.snapshot();
  check(
    "快照只显示当前任务的会话（旧任务 s-new 被隔离）",
    snap.sessions.length === 3 && snap.sessions.every((s) => s.taskId === task.id),
    JSON.stringify(snap.sessions.map((s) => `${s.id}:${s.taskId === task.id ? "current" : "other"}`)),
  );

  // ---------- 8. R19 任务切换：listTasks + task.switch ----------
  const allTasks = board2.listTasks();
  check(
    "listTasks 返回全部任务（含旧任务）",
    allTasks.length === 2 && allTasks.some((t) => t.id === task.id) && allTasks.some((t) => t.id === task2.id),
    JSON.stringify(allTasks.map((t) => t.id)),
  );
  check(
    "快照暴露 tasks 列表（当前 + 旧任务）",
    hub.snapshot().tasks.length === 2,
    JSON.stringify(hub.snapshot().tasks.map((t) => t.id)),
  );
  const swOk = await hub.dispatch({ type: "task.switch", taskId: task2.id });
  eq("task.switch 切到旧任务成功", swOk.ok, true);
  eq("切换后当前任务变了", hub.snapshot().task?.id, task2.id);
  const t2snap = hub.snapshot();
  check(
    "切换后旧任务的会话载入内存（不再空列表）",
    t2snap.sessions.length === 1 && t2snap.sessions[0]?.id === "s-new",
    JSON.stringify(t2snap.sessions.map((s) => `${s.id}:${s.status}`)),
  );
  const swBad = await hub.dispatch({ type: "task.switch", taskId: "task-nonexistent" });
  eq("切到不存在的任务 → 拒绝", swBad.ok, false);
  // 切回原任务，保持收尾状态一致。
  await hub.dispatch({ type: "task.switch", taskId: task.id });

  // ---------- 9. R20 session.remove：关标签只隐藏、不删除 ----------
  board2.insertSession({ id: "s-rm", taskId: task.id, agent: "claude", role: "scribe", tier: "guarded", status: "idle" });
  const srmDir = join(WORK, "sessions", "s-rm");
  mkdirSync(srmDir, { recursive: true });
  writeFileSync(
    join(srmDir, "stream.jsonl"),
    JSON.stringify({ seq: 1, ts: 1_700_000_000_301, kind: "agent_message", text: "s-rm 的对话历史" }) + "\n",
    "utf8",
  );
  mgr2.loadTaskSessions(task.id);
  check(
    "前置：s-rm 已载入内存并出现在快照",
    hub.snapshot().sessions.some((s) => s.id === "s-rm"),
    JSON.stringify(hub.snapshot().sessions.map((s) => s.id)),
  );
  const rmRes = await hub.dispatch({ type: "session.remove", sessionId: "s-rm" });
  eq("session.remove 返回 ok", rmRes.ok, true);
  check(
    "发布 session.removed 事件",
    hubEvents.some((e) => e.type === "session.removed" && e.sessionId === "s-rm"),
    JSON.stringify(hubEvents.map((e) => e.type)),
  );
  check(
    "移除后快照不再含该会话",
    !hub.snapshot().sessions.some((s) => s.id === "s-rm"),
    JSON.stringify(hub.snapshot().sessions.map((s) => s.id)),
  );
  check(
    "库里也不列出隐藏会话",
    !board2.listSessions(task.id).some((s) => s.id === "s-rm"),
    JSON.stringify(board2.listSessions(task.id).map((s) => s.id)),
  );
  // 恢复 = hidden 翻回 0：行还在、状态已 settle 成 stopped —— 证明「先停后隐藏」两步都落了库
  board2.setSessionHidden("s-rm", false);
  const restoredRow = board2.listSessions(task.id).find((s) => s.id === "s-rm");
  eq("恢复后行还在且状态 stopped", restoredRow?.status, "stopped");
  board2.setSessionHidden("s-rm", true); // 恢复现场，验证重启行为
  const rmAgain = await hub.dispatch({ type: "session.remove", sessionId: "s-rm" });
  eq("重复移除被拒", rmAgain.ok, false);
  const rmOtherTask = await hub.dispatch({ type: "session.remove", sessionId: "s-new" });
  eq("移除其它任务的会话被拒（当前任务隔离）", rmOtherTask.ok, false);

  mgr2.shutdown();
  board2.close();

  // ---------- 9b. 关库重开：隐藏会话不会被恢复进内存 ----------
  const board3 = Blackboard.open(dbPath);
  const mgr3 = newManager(board3, workRoot);
  mgr3.restoreSessions(task.id);
  check(
    "重启后隐藏会话不在会话列表",
    !mgr3.listSessions(task.id).some((s) => s.id === "s-rm"),
    JSON.stringify(mgr3.listSessions(task.id).map((s) => s.id)),
  );
  check(
    "重启后库列表也不含隐藏会话",
    !board3.listSessions(task.id).some((s) => s.id === "s-rm"),
    JSON.stringify(board3.listSessions(task.id).map((s) => s.id)),
  );
  check(
    "stream.jsonl 磁盘历史未删（只隐藏、不删除）",
    existsSync(join(srmDir, "stream.jsonl")),
    srmDir,
  );
  check(
    "隐藏会话不产生 stale 恢复的 incident 死路",
    !board3.listDeadEnds(task.id).some((d) => d.scope === "incident" && d.description.includes("s-rm")),
    JSON.stringify(board3.listDeadEnds(task.id).map((d) => d.description)),
  );

  // ---------- 10. A11：积压超 200 条事件时，分页排空不能跳事件 ----------
  const pageBus = new EventBus();
  const pageCounts: number[] = [];
  pageBus.on((e) => {
    if (e.type === "board.appended") pageCounts.push(e.events.length);
  });
  const hub3 = new HubService({
    board: board3,
    sessions: mgr3,
    bus: pageBus,
    workspaceRoot: WORK,
    workDir: workRoot,
  });
  hub3.setTask(task.id);
  // 每次 acquire+release 各写 1 条 events（audit 在另一张表，不算），100 次 ≈ 200 条新事件，
  // 加上前几节留下的 ≈ 20 条，稳超 LIMIT 200。
  for (let i = 0; i < 100; i++) {
    board3.acquireLease({ resource: `target:a11-${i}`, sessionId: "s1", taskId: task.id });
    board3.releaseLease(`target:a11-${i}`, "s1", "a11 测试");
  }
  const taskEvents = (
    board3.raw(
      `SELECT COUNT(*) AS c FROM events
       WHERE subject = ? OR session_id IN (SELECT id FROM sessions WHERE task_id = ?)`,
      task.id,
      task.id,
    ) as Array<{ c: number }>
  )[0]?.c;
  const globalLast = board3.lastEventId();
  let cursor = 0;
  let drained = 0;
  let pages = 0;
  while (cursor < globalLast) {
    const before = pageCounts.length;
    const lastRead = hub3.publishBoardSince(cursor);
    if (lastRead <= cursor) break;
    cursor = lastRead;
    pages += 1;
    drained += pageCounts.slice(before).reduce((a, b) => a + b, 0);
  }
  check(
    "积压超 200 条时仍分页排空（事件数不多不少）",
    taskEvents > 200 && drained === taskEvents,
    `taskEvents=${taskEvents} drained=${drained} pages=${pages}`,
  );
  check("分页确实走了多页（LIMIT 200 生效）", pages >= 2, `pages=${pages}`);

  // ---------- 11. A7：按会话令牌 + 连接绑定 + 日志脱敏 ----------
  const bridgeA7 = new BoardBridge({ board: board3, taskId: task.id, runId: "r25-a7" });
  await bridgeA7.start();
  const tokOf = (env: Array<{ name: string; value: string }>): string =>
    env.find((e) => e.name === "BUMIMANG_TOKEN")?.value ?? "";
  const envA7a = bridgeA7.envForSession("s1", task.id);
  const envA7b = bridgeA7.envForSession("s2", task.id);
  check(
    "按会话签发不同令牌（不再是全局一个）",
    tokOf(envA7a) !== tokOf(envA7b) && tokOf(envA7a).length > 16,
    `${tokOf(envA7a).slice(0, 6)}… vs ${tokOf(envA7b).slice(0, 6)}…`,
  );

  const pipeRpc = (
    hello: Record<string, unknown>,
    reqs: Array<Record<string, unknown>>,
  ): Promise<Array<{ id: number; result?: unknown; error?: string }>> =>
    new Promise((resolve, reject) => {
      const sock = connect(bridgeA7.pipeName);
      let buf = "";
      const got: Array<{ id: number; result?: unknown; error?: string }> = [];
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("A7 管道 RPC 超时"));
      }, 5000);
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write(JSON.stringify({ id: 0, ...hello }) + "\n"));
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
          got.push(msg);
          const next = reqs.find((r) => (r.__after as number) === msg.id);
          if (next) sock.write(JSON.stringify(next) + "\n");
          if (got.some((g) => (g as { error?: string }).error)) {
            clearTimeout(timer);
            sock.end();
            resolve(got);
          }
          if (got.length >= 1 + reqs.length) {
            clearTimeout(timer);
            sock.end();
            resolve(got);
          }
        }
      });
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // 错误令牌场景：服务端直接断连、无任何应答——close 即终态。
      sock.on("close", () => {
        clearTimeout(timer);
        resolve(got);
      });
    });

  const badHello = await pipeRpc({ method: BRIDGE_RPC.hello, token: "deadbeef", sessionId: "s1" }, []);
  check("错误令牌连接被断开（无 ok 应答）", badHello.length === 0, JSON.stringify(badHello).slice(0, 100));

  const impostor = await pipeRpc(
    { method: BRIDGE_RPC.hello, token: tokOf(envA7a), sessionId: "s1" },
    [
      {
        __after: 0,
        id: 1,
        method: BRIDGE_RPC.submitFact,
        params: { sessionId: "s2", content: "越权事实 flag{a7_impostor}", witness: null },
      },
    ],
  );
  check(
    "请求体冒用其它 sessionId 被拒绝（连接已绑定 s1）",
    impostor.some((r) => r.id === 1 && r.error !== undefined),
    JSON.stringify(impostor),
  );
  check(
    "冒用被拒后库里没有越权事实",
    !board3.listFacts(task.id).some((f) => f.content.includes("flag{a7_impostor}")),
    "",
  );

  const legit = await pipeRpc(
    { method: BRIDGE_RPC.hello, token: tokOf(envA7a), sessionId: "s1" },
    [
      {
        __after: 0,
        id: 1,
        method: BRIDGE_RPC.submitFact,
        params: { sessionId: "s1", content: "正常事实 flag{a7_ok}", witness: "cmd: cat /flag" },
      },
    ],
  );
  check(
    "绑定身份提交自己的事实成功",
    legit.some((r) => r.id === 1 && r.result !== undefined),
    JSON.stringify(legit),
  );
  bridgeA7.stop();

  // 日志脱敏（redactSecrets）
  check(
    "JSON 形态的 BUMIMANG_TOKEN 被打码",
    !redactSecrets('{"name":"BUMIMANG_TOKEN","value":"7664f227aa47f43f95fbeb7b2de3c"}').includes("7664f227"),
    redactSecrets('{"name":"BUMIMANG_TOKEN","value":"7664f227aa47f43f95fbeb7b2de3c"}'),
  );
  eq(
    "env 形态的 BUMIMANG_TOKEN=hex 被打码",
    redactSecrets("BUMIMANG_TOKEN=abcdef0123456789"),
    "BUMIMANG_TOKEN=***",
  );
  eq("普通文本不受影响", redactSecrets("无敏感内容 hello"), "无敏感内容 hello");

  // ---------- 12. A6 哈希链回滚恢复 + A4 审批落库 ----------
  // A6-a：事务回滚后，内存链尾必须退回事务前的值（tx 级快照恢复）。
  // 当前公共 API 都是「先 INSERT 后 appendEvent」，没有 appendEvent 之后再失败的可达路径，
  // 所以用重复主键制造一次真回滚，验证下一次成功事件仍接在回滚前的链尾上。
  const tailBefore = (board3.raw("SELECT hash FROM events ORDER BY id DESC LIMIT 1") as Array<{ hash: string }>)[0]?.hash;
  let rolledBack = false;
  try {
    board3.insertSession({ id: "s1", taskId: task.id, agent: "x", role: "lead", tier: "guarded", status: "idle" });
  } catch {
    rolledBack = true;
  }
  check("重复主键插入触发事务回滚", rolledBack, "");
  board3.setSessionStatus("s1", "stopped"); // 回滚后的下一次成功事件
  const tailRows = board3.raw("SELECT hash, prev_hash FROM events ORDER BY id DESC LIMIT 2") as Array<{ hash: string; prev_hash: string }>;
  eq("回滚后的新事件接在回滚前链尾上", tailRows[0]?.prev_hash, tailBefore);
  eq("链尾前一行的 hash 与记录一致", tailRows[1]?.hash, tailBefore);

  // A6-b：全链一致性——每条事件的 prev_hash 必须等于前一条的 hash。
  const chain = board3.raw("SELECT id, hash, prev_hash FROM events ORDER BY id ASC") as Array<{ id: number; hash: string; prev_hash: string }>;
  const chainOk = chain.every((r, i) => i === 0 || r.prev_hash === chain[i - 1]!.hash);
  check("全部事件链条一致（无悬空 prev_hash）", chainOk, `events=${chain.length}`);

  // A4：审批落库（pending → 人工裁决 → 超时），并写 kind=approval 的黑板事件。
  const qA4 = new ApprovalQueue({
    onUpsert: () => undefined,
    onPersist: (v) =>
      board3.upsertApproval({
        id: v.id,
        taskId: v.taskId,
        sessionId: v.sessionId,
        action: v.action,
        command: v.command,
        intentSummary: v.intentSummary,
        risk: v.risk,
        rule: v.rule,
        status: v.status,
        decidedBy: v.decidedBy,
        decidedAt: v.decidedAt,
        createdAt: v.createdAt,
      }),
    timeoutMs: 300,
  });
  const rA4 = qA4.request({
    taskId: task.id,
    sessionId: "s1",
    action: "session/request_permission",
    detail: { title: "approval 落库测试" },
    rule: "r-a4",
    reason: "t",
  });
  const pendingRow = (board3.raw("SELECT status FROM approvals ORDER BY created_at DESC LIMIT 1") as Array<{ status: string }>)[0];
  eq("请求落库为 pending", pendingRow?.status, "pending");
  const pendingId = (board3.raw("SELECT id FROM approvals ORDER BY created_at DESC LIMIT 1") as Array<{ id: string }>)[0]?.id;
  qA4.decide(pendingId, "denied");
  const oA4 = await rA4;
  eq("人工拒绝的决定者是人类", oA4.decidedBy, "human");
  const deniedRow = (board3.raw("SELECT status, decided_by FROM approvals WHERE id = ?", pendingId) as Array<{ status: string; decided_by: string }>)[0];
  eq("裁决落库 denied + human", `${deniedRow?.status}/${deniedRow?.decided_by}`, "denied/human");
  const rA4t = qA4.request({
    taskId: task.id,
    sessionId: "s2",
    action: "session/request_permission",
    detail: { title: "无人应答" },
    rule: null,
    reason: "t",
  });
  const oA4t = await rA4t; // 300ms 超时
  eq("超时的决定者是 policy", oA4t.decidedBy, "policy");
  const timeoutRow = (board3.raw("SELECT status, decided_by FROM approvals ORDER BY created_at DESC LIMIT 1") as Array<{ status: string; decided_by: string }>)[0];
  eq("超时落库 timeout + policy", `${timeoutRow?.status}/${timeoutRow?.decided_by}`, "timeout/policy");
  const approvalEvents = board3.raw("SELECT kind FROM events WHERE kind = 'approval'") as Array<{ kind: string }>;
  check("审批写入 kind=approval 黑板事件（可审计）", approvalEvents.length >= 2, `approval events=${approvalEvents.length}`);

  mgr3.shutdown();
  board3.close();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================ ${passed}/${results.length} 通过 ================`);
  if (passed !== results.length) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
