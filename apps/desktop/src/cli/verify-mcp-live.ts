/**
 * 黑板对真实 agent 可达性验收 —— 验 BLOCKED L-3 是否真的修好了。
 *
 * 为什么必须用真实 agent 验：MCP 子进程是 **agent 去 spawn** 的（agent 才是 MCP 客户端），
 * 我们用假 agent 测不出"Spawn 一个 stdio MCP 服务器"这条路径。而 Lane B 实测真实 claude
 * 连不上黑板，为此花了一整轮简报逆向排障 —— 那条链只有真 agent 走得通。
 *
 * 判断信号有两个（都要满足）：
 *   1. 主进程的命名管道收到了连接并校验通过（说明 MCP 子进程真的起来了）
 *   2. agent 调用了黑板工具（onBoardRead 触发，说明工具面对 agent 是可见可用的）
 *
 * 用法：npm run verify:mcp-live
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { installedAgents } from "../main/discovery/detect.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "mcp-live");
const AGENT_ID = process.argv.includes("--opencode") ? "opencode" : "claude";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  console.log(`========== 黑板可达性（真实 ${AGENT_ID}）==========`);

  const agent = installedAgents().find((a) => a.id === AGENT_ID);
  if (!agent?.launch) throw new Error(`没有可用的 ${AGENT_ID}`);

  const board = Blackboard.open(join(WORK, "board.db"));
  const task = board.createTask({ title: "黑板可达性验收", brief: "验证真实 agent 能否连上黑板 MCP" });

  const bridgeLogs: string[] = [];
  const boardReads: Array<{ sessionId: string; afterId: number; returned: number }> = [];
  const bridge = new BoardBridge({
    board,
    taskId: task.id,
    runId: newRunId(),
    log: (m) => {
      bridgeLogs.push(m);
      console.log(`  [bridge] ${m}`);
    },
    onBoardRead: (sessionId, afterId, returned) => {
      boardReads.push({ sessionId, afterId, returned });
      console.log(`  [read] ${sessionId} 读了黑板 after=${afterId} 返回 ${returned} 条`);
    },
  });
  await bridge.start();
  console.log(`管道：${bridge.pipeName}`);

  const policy = new PolicyEngine({ repoRoot: ROOT, packId: "competition" });
  let approved = 0;
  const mgr = new SessionManager({
    board,
    bridge,
    policy,
    workspaceRoot: WORK,
    onLine: () => undefined,
    onApprovalRequired: async () => {
      approved += 1;
      return true; // 一律放行，避免 agent 卡在等审批上
    },
  });

  const rec = await mgr.startSession({
    taskId: task.id,
    spec: { command: agent.launch.command, args: agent.launch.args, cwd: WORK, label: AGENT_ID },
    agent: AGENT_ID,
    role: "lead",
    tier: "autonomous",
  });
  console.log(`会话已起：${rec.id} acpSession=${rec.acpSession}`);

  // 简报里带 sync_protocol，会要求 agent 调 blackboard_read_since
  console.log("注入简报包（内含黑板纪律）…");
  try {
    await mgr.sendBriefing(rec.id);
  } catch (err) {
    console.log(`简报轮异常：${(err as Error).message}`);
  }

  // 再给它一点时间清理
  await sleep(3000);

  const authed = bridgeLogs.some((l) => l.includes("校验通过"));
  check(
    "MCP 子进程真的起来了并连上命名管道（L-3 的核心）",
    authed,
    authed ? bridgeLogs.find((l) => l.includes("校验通过"))! : `bridge 日志：${JSON.stringify(bridgeLogs)}`,
  );
  check(
    "agent 调用过黑板工具（工具面对它是可见可用的）",
    boardReads.length > 0,
    `onBoardRead 触发 ${boardReads.length} 次`,
  );
  console.log(`\n附带观测：agent 期间触发的权限请求 ${approved} 次（自动放行）`);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n========== ${passed}/${results.length} 通过 ==========`);

  await mgr.shutdown();
  bridge.stop();
  board.close();
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
