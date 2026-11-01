/**
 * 武装 codex 的权限闸门 —— 用 ACP 原生的 session mode，不需要任何配置文件。
 *
 * 背景：实测 codex 默认不问。查 codex-acp 的 session/new 返回发现它把审批策略暴露成
 * ACP 的 modes（这比"传 env / 改 config.toml"干净得多）：
 *
 *   read-only         Requires approval to edit files and access the internet.
 *   workspace-write   Edit workspace files; ask before writing outside the workspace or network.
 *   agent             Auto review — 只问"被判定为潜在不安全"的动作   ← 默认值
 *   agent-full-access Unrestricted
 *
 * 默认值 agent 是"自动复核"，普通写文件不算不安全，所以它不问。
 *
 * 本脚本对三种 mode 各起一个会话、各让它写一个文件，数 request_permission。
 *
 * R17 已知限制：Windows 上 workspace-write 的写工作区外会请求审批，但**联网不会**
 * （实测 curl https://example.com 返回 200 且 request_permission=0）。所以应用文案
 * 不再承诺「联网会问」；本脚本也不把「0 审批」当成联网已被拦。
 *
 * 用法：npm run verify:arm-codex
 */

import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { AcpClient } from "../main/acp/client.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { installedAgents } from "../main/discovery/detect.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "arm-codex");
const PROMPT = "在当前目录创建一个文件 codex-armed.txt，内容写一行 hello。只做这一件事，做完就结束。";

interface Outcome {
  mode: string;
  permissions: number;
  toolCalls: number;
  error: string | null;
}

async function runMode(mode: string | null): Promise<Outcome> {
  const label = mode ?? "default";
  console.log(`\n---------- mode = ${label} ----------`);
  const work = join(WORK, label);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const agent = installedAgents().find((a) => a.id === "codex");
  if (!agent?.launch) throw new Error("本机没有可用的 codex");

  let permissions = 0;
  let toolCalls = 0;
  const policy = new PolicyEngine({ repoRoot: ROOT, packId: "competition" });

  const client = AcpClient.spawn(
    { command: agent.launch.command, args: agent.launch.args, cwd: work, label: "codex" },
    {
      policy,
      sessionId: "s-codex",
      // guarded：无规则命中的权限请求会按 §9.2 档位兜底转人工，这样 onApprovalRequired 才会被调用
      tier: "guarded",
      log: (entry) => {
        if (entry.dir !== "in") return;
        const m = entry.message as Record<string, unknown>;
        if (m.method !== "session/update") return;
        const upd = (m.params as Record<string, unknown>)?.update as
          | Record<string, unknown>
          | undefined;
        if (String(upd?.sessionUpdate ?? "") === "tool_call") toolCalls += 1;
      },
      onUpdate: () => undefined,
      onExit: () => undefined,
      onClientCall: () => undefined,
      onApprovalRequired: async () => {
        permissions += 1;
        return true;
      },
    },
  );

  let error: string | null = null;
  try {
    await client.initialize();
    const ses = (await client.newSession({ cwd: work, mcpServers: [] })) as {
      sessionId: string;
      configOptions?: Array<{ id: string; currentValue?: unknown }>;
    };
    const sessionId = ses.sessionId;
    const current = ses.configOptions?.find((o) => o.id === "mode")?.currentValue;
    console.log(`会话默认 mode = ${String(current)}`);

    if (mode) {
      await client.setConfigOption({ sessionId, configId: "mode", value: mode });
      console.log(`已 set_config_option mode=${mode}`);
    }

    await client.prompt(sessionId, PROMPT);
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    error = (err as Error).message;
  } finally {
    client.kill();
  }

  console.log(
    `request_permission = ${permissions}   tool_call = ${toolCalls}${error ? `   error=${error}` : ""}`,
  );
  return { mode: label, permissions, toolCalls, error };
}

/**
 * 走应用自己的路径：SessionManager 应该在 guarded 档下把 codex 切到 workspace-write。
 * 前三个场景只证明了"手动设 mode 有效"，这一条才证明**接线生效**。
 */
async function runViaApp(): Promise<Outcome> {
  console.log("\n---------- via-app（走 SessionManager，guarded 档）----------");
  const work = join(WORK, "via-app");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const agent = installedAgents().find((a) => a.id === "codex");
  if (!agent?.launch) throw new Error("本机没有可用的 codex");

  const board = Blackboard.open(join(work, "board.db"));
  const task = board.createTask({ title: "codex 武装验收", brief: PROMPT });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: newRunId() });
  await bridge.start();

  let permissions = 0;
  let toolCalls = 0;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: work,
    onLine: () => undefined,
    onApprovalRequired: async () => {
      permissions += 1;
      return true;
    },
  });

  let error: string | null = null;
  try {
    const rec = await mgr.startSession({
      taskId: task.id,
      spec: { command: agent.launch.command, args: agent.launch.args, cwd: work, label: "codex" },
      agent: "codex",
      role: "lead",
      tier: "guarded",
    });
    await mgr.prompt(rec.id, PROMPT);
    await new Promise((r) => setTimeout(r, 2000));
    toolCalls = rec.toolCalls;
  } catch (err) {
    error = (err as Error).message;
  } finally {
    await mgr.shutdown();
    bridge.stop();
    board.close();
  }

  console.log(
    `request_permission = ${permissions}   tool_call = ${toolCalls}${error ? `   error=${error}` : ""}`,
  );
  return { mode: "via-app(guarded)", permissions, toolCalls, error };
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  console.log("========== 武装 codex 的权限闸门（ACP 原生 mode）==========");

  const results: Outcome[] = [];
  results.push(await runMode("read-only"));
  results.push(await runMode("workspace-write"));
  results.push(await runMode("agent"));
  results.push(await runViaApp());

  console.log("\n================ 对照 ================");
  for (const r of results) {
    console.log(
      `${r.mode.padEnd(18)} request_permission=${String(r.permissions).padEnd(3)} ` +
        `tool_call=${r.toolCalls}${r.error ? "  error=" + r.error : ""}`,
    );
  }
  const best = results.filter((r) => r.permissions > 0).map((r) => r.mode);
  console.log(
    best.length
      ? `\n✅ 会让 codex 请求授权的 mode：${best.join(" / ")}`
      : "\n⚠ 三种 mode 都没让它请求授权 —— 需要换别的办法（改 config.toml 的 approval_policy）。",
  );
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
