/**
 * codex 黑板工具回归验收 —— 修「MCP tool call requires approval」与「未命名工具调用」。
 *
 * 背景（用户实测 + AIxVuln 交付物里的 install-notes 同时印证）：
 *  - codex 的 `session/request_permission` 只带 toolCallId / kind，工具名在前一条
 *    `tool_call` update 里。早先我们只在审批卡片上补名字，策略引擎看到的是空标题，
 *    于是 `blackboard_read_since` 命中「受控档无规则 → 转人工」，每次同步都弹审批。
 *  - codex 在 `approval_policy = "never"`（agent-full-access）下，MCP 工具若没有
 *    `readOnlyHint` 注解，会直接报 `MCP tool call requires approval, but approval
 *    policy is never`。我们给只读工具补了注解。
 *
 * 这条验收用真实的 codex + 真实 MCP stdio 黑板，走 SessionManager 的 guarded 档
 * （workspace-write），要求：
 *   1. MCP 子进程起来并校验通过；
 *   2. codex 真的调用了 blackboard_read_since；
 *   3. 这次调用**没有**转人工（approvals = 0），证明 enrichDetail 在判定前生效；
 *   4. 对话历史里没有 approval policy / requires approval 之类报错。
 *
 * 用法：npm run verify:codex-mcp
 */

import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { installedAgents } from "../main/discovery/detect.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "codex-mcp");
const PROMPT =
  "请调用 blackboard_read_since 工具一次，after_id 传 0，读取黑板。然后只回复一句 READY，不要做别的事。";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  console.log("========== codex 黑板 MCP 回归（guarded / workspace-write）==========\n");

  const agent = installedAgents().find((a) => a.id === "codex");
  if (!agent?.launch) throw new Error("本机没有可用的 codex-acp");

  const board = Blackboard.open(join(WORK, "board.db"));
  const task = board.createTask({ title: "codex 黑板回归", brief: "验证 MCP 工具不再触发审批报错" });

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
      console.log(`  [read] ${sessionId} after=${afterId} 返回 ${returned} 条`);
    },
  });
  await bridge.start();

  let approvals = 0;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: WORK,
    workRoot: WORK,
    onLine: (l) => {
      if (l.includes("codex 闸门")) console.log(`  [manager] ${l}`);
    },
    // 若黑板读取仍走人工，这一行会让流程继续，但 approvals 会 > 0 —— 验收照样失败。
    onApprovalRequired: async (detail) => {
      approvals += 1;
      console.log(`  [approval] ${JSON.stringify(detail).slice(0, 300)}`);
      return true;
    },
  });

  let error: string | null = null;
  let recId = "";
  try {
    const rec = await mgr.startSession({
      taskId: task.id,
      spec: { command: agent.launch.command, args: agent.launch.args, cwd: WORK, label: "codex" },
      agent: "codex",
      role: "lead",
      tier: "guarded",
    });
    recId = rec.id;
    console.log(`会话已起：${rec.id} acpSession=${rec.acpSession}`);

    // 简报轮可能已经让它读一次黑板；先等它跑完，再发显式指令，避免 prompt 并发。
    try {
      await mgr.sendBriefing(rec.id);
    } catch (err) {
      console.log(`简报轮异常（不直接判失败）：${(err as Error).message}`);
    }
    await mgr.prompt(rec.id, PROMPT);

    // 等黑板读取回调（最多 30s）
    for (let i = 0; i < 30 && boardReads.length === 0; i++) await sleep(1000);
    await sleep(1500);
  } catch (err) {
    error = (err as Error).message;
  }

  const history = recId ? mgr.historyOf(recId) : [];
  const texts = history
    .filter((u) => u.kind === "agent_message" || u.kind === "agent_thought" || u.kind === "other")
    .map((u) => u.text ?? "")
    .join("\n");
  const approvalError = /requires approval|approval policy|未命名工具调用/.test(texts);
  const toolCalls = history
    .filter((u) => u.kind === "tool_call")
    .map((u) => u.title ?? "")
    .filter(Boolean);

  check("codex 会话正常结束（prompt 没抛协议错误）", !error, error ?? "无");
  check(
    "MCP 子进程起来并连上命名管道",
    bridgeLogs.some((l) => l.includes("校验通过")),
    bridgeLogs.find((l) => l.includes("校验通过")) ?? JSON.stringify(bridgeLogs.slice(-5)),
  );
  check(
    "codex 真的调用了 blackboard_read_since",
    boardReads.length > 0,
    `onBoardRead ${boardReads.length} 次；工具调用：${JSON.stringify(toolCalls)}`,
  );
  check(
    "黑板读取没有转人工（enrichDetail 在策略判定前生效）",
    boardReads.length > 0 && approvals === 0,
    `approvals=${approvals}`,
  );
  check(
    "对话里没有 approval policy / requires approval 报错",
    !approvalError,
    approvalError ? texts.slice(-500) : "干净",
  );

  await mgr.shutdown();
  bridge.stop();
  board.close();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n========== ${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
