/**
 * B-3 实测：能不能在不碰全局配置的前提下，把 opencode 的权限闸门武装起来。
 *
 * 背景：实测 opencode 默认不问（写文件、跑命令都直接做）。但它的配置 schema 有
 * `permission` 段（`edit`/`bash` 等可设为 "ask"）。关键是**怎么把这段配置喂给它**，
 * 且不写用户的 `~/.config/opencode/opencode.jsonc`。

 * 已查到的配置层级（官方文档）：Remote → Global → Custom(`OPENCODE_CONFIG`) →
 * Project(`opencode.json`) → `.opencode` → Inline(`OPENCODE_CONFIG_CONTENT`) → Managed，
 * **各层是合并而非替换**，后面的覆盖前面的同名键。
 *
 * 本脚本对照两种情形，看权限请求次数：
 *   baseline  不注入任何配置           → 预期 0（与之前实测一致）
 *   project   在会话工作目录放 opencode.json
 *   inline    注入 OPENCODE_CONFIG_CONTENT 环境变量
 *
 * 用法：npm run verify:arm-opencode
 */

import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { AcpClient } from "../main/acp/client.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { installedAgents } from "../main/discovery/detect.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "arm");
const ARM_CONFIG = { permission: { edit: "ask", bash: "ask" } };
const PROMPT =
  "在当前目录创建一个文件 armed.txt，内容写一行 hello。只做这一件事，做完就结束。";

interface Outcome {
  label: string;
  permissions: number;
  toolCalls: number;
  error: string | null;
  wrote: boolean;
}

async function run(
  label: string,
  opts: { projectConfig?: boolean; inlineConfig?: boolean },
): Promise<Outcome> {
  console.log(`\n---------- ${label} ----------`);
  const work = join(WORK, label);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // 情形二：项目级 —— 在会话工作目录放一个 opencode.json
  if (opts.projectConfig) {
    writeFileSync(join(work, "opencode.json"), JSON.stringify(ARM_CONFIG, null, 2), "utf8");
    console.log("已写入项目级 opencode.json：", JSON.stringify(ARM_CONFIG));
  }

  const agent = installedAgents().find((a) => a.id === "opencode");
  if (!agent?.launch) throw new Error("本机没有可用的 opencode");

  let permissions = 0;
  let toolCalls = 0;
  const policy = new PolicyEngine({ repoRoot: ROOT, packId: "competition" });
  const env: Record<string, string> = {};
  // 情形三：内联 —— 用官方文档里的运行时覆盖变量
  if (opts.inlineConfig) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(ARM_CONFIG);
    console.log("已注入 OPENCODE_CONFIG_CONTENT");
  }

  const client = AcpClient.spawn(
    { command: agent.launch.command, args: agent.launch.args, cwd: work, env, label: "opencode" },
    {
      policy,
      sessionId: "s-arm",
      tier: "autonomous",
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
      onClientCall: (action) => {
        if (action === "session/request_permission") permissions += 1;
      },
      onApprovalRequired: async () => true,
    },
  );

  let error: string | null = null;
  try {
    await client.initialize();
    const ses = (await client.newSession({ cwd: work, mcpServers: [] })) as { sessionId: string };
    await client.prompt(ses.sessionId, PROMPT);
  } catch (err) {
    error = (err as Error).message;
  } finally {
    client.kill();
  }

  const armedPath = join(work, "armed.txt");
  const wrote = existsSync(armedPath);
  const body = wrote ? readFileSync(armedPath, "utf8").trim().slice(0, 40) : "";

  console.log(
    `request_permission = ${permissions}   tool_call = ${toolCalls}   文件写入 = ${wrote}` +
      (wrote ? `（内容 ${JSON.stringify(body)}）` : ""),
  );
  if (error) console.log(`error: ${error}`);
  return { label, permissions, toolCalls, error, wrote };
}

/**
 * 走应用自己的路径：SessionManager 应该在 spawn opencode 时自动注入武装配置。
 * 这一条才是"接线生效"的证据——前三个场景只证明了环境变量本身有效。
 */
async function runViaSessionManager(): Promise<Outcome> {
  const work = join(WORK, "via-app");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const agent = installedAgents().find((a) => a.id === "opencode");
  if (!agent?.launch) throw new Error("本机没有可用的 opencode");

  const board = Blackboard.open(join(work, "board.db"));
  const task = board.createTask({ title: "武装验收", brief: PROMPT });
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
      spec: { command: agent.launch.command, args: agent.launch.args, cwd: work, label: "opencode" },
      agent: "opencode",
      role: "lead",
      // 用 guarded：无规则命中的权限请求会按 §9.2 的档位兜底转人工，
      // 这样 onApprovalRequired 才会被调用（autonomous 档会直接放行，计数不到）
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

  // 会话的 cwd 是 per-session 目录，不是在 work 根下，所以要递归找
  const wrote = findFile(work, "armed.txt");
  console.log(
    `request_permission = ${permissions}   tool_call = ${toolCalls}   文件写入 = ${wrote}` +
      (error ? `   error=${error}` : ""),
  );
  return { label: "via-app", permissions, toolCalls, error, wrote };
}

/** 在目录树里找一个文件（会话 cwd 是 .ui-run/arm/via-app/sessions/sN） */
function findFile(dir: string, name: string): boolean {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(cur, e.name));
      else if (e.name === name) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  console.log("========== B-3 实测：武装 opencode 的权限闸门 ==========");

  const base = await run("baseline", {});
  const proj = await run("project", { projectConfig: true });
  const inline = await run("inline", { inlineConfig: true });

  // 第四个场景：走**应用自己**的路径（SessionManager），证明接线生效而不只是环境变量生效
  console.log("\n---------- via-app（走 SessionManager，应用自己武装）----------");
  const viaApp = await runViaSessionManager();

  console.log("\n================ 对照 ================");
  for (const o of [base, proj, inline, viaApp]) {
    console.log(
      `${o.label.padEnd(10)} request_permission=${String(o.permissions).padEnd(3)} ` +
        `tool_call=${String(o.toolCalls).padEnd(3)} 文件写入=${o.wrote}${o.error ? "  error=" + o.error : ""}`,
    );
  }
  const best = [proj, inline].filter((o) => o.permissions > 0).map((o) => o.label);
  console.log(
    best.length
      ? `\n✅ 可用：${best.join(" / ")}（不碰全局配置即可武装）`
      : "\n⚠ 两种非全局方式都没能让它请求授权 —— 只能回退到「产出一条命令给用户手动改全局」。",
  );
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
