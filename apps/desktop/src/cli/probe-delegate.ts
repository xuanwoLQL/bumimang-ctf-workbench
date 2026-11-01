/**
 * 委托行为探针 —— 填 ARCHITECTURE §16.2 里最要紧的那一行。
 *
 * 问题：agent 执行命令时，是**委托给客户端**（走 `terminal/create`，我们能在事前拦），
 * 还是**自己执行**（只发 `session/update` 报告，我们只能事后观测）？
 *
 * 这一行决定了 C7 能不能成立、M3 审批队列要为哪种情况设计。
 *
 * 用法：npm run probe:delegate
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AcpClient } from "../main/acp/client.ts";
import { PassthroughPolicy } from "../main/policy/policy.ts";
import { installedAgents } from "../main/discovery/detect.ts";

const ROOT = "D:/agent/xuanwo/.probe/delegate";

const CMD_PROMPT =
  "请用 shell 执行这条命令并把它的原始输出贴给我：echo bumimang-delegate-probe\n" +
  "只做这一件事。执行完后立刻结束。";

interface Counts {
  terminalCreate: number;
  terminalOther: number;
  fsRead: number;
  fsWrite: number;
  permission: number;
  toolCall: number;
  toolCallUpdate: number;
  outputSeen: string[];
}

async function probeOne(
  id: string,
  title: string,
  launch: { command: string; args: string[] },
): Promise<void> {
  const cwd = join(ROOT, id);
  mkdirSync(cwd, { recursive: true });

  const c: Counts = {
    terminalCreate: 0,
    terminalOther: 0,
    fsRead: 0,
    fsWrite: 0,
    permission: 0,
    toolCall: 0,
    toolCallUpdate: 0,
    outputSeen: [],
  };

  const client = AcpClient.spawn(
    { command: launch.command, args: launch.args, cwd, label: id },
    {
      policy: new PassthroughPolicy(),
      sessionId: `delegate-${id}`,
      log: (entry) => {
        if (entry.dir !== "in") return;
        const m = entry.message as Record<string, unknown>;
        if (m.method !== "session/update") return;
        const upd = (m.params as Record<string, unknown>)?.update as
          | Record<string, unknown>
          | undefined;
        const kind = String(upd?.sessionUpdate ?? "");
        if (kind === "tool_call") c.toolCall += 1;
        if (kind === "tool_call_update") c.toolCallUpdate += 1;
        if (kind === "agent_message_chunk") {
          const content = upd?.content as Record<string, unknown> | undefined;
          const txt = String(content?.text ?? "");
          if (txt.includes("bumimang-delegate-probe")) c.outputSeen.push(txt.trim().slice(0, 100));
        }
      },
      onUpdate: () => undefined,
      onExit: () => undefined,
      // 每一次客户端反向调用都会先过策略引擎，所以在这里记账
      onClientCall: (action: string) => {
        if (action === "terminal/exec") c.terminalCreate += 1;
        else if (action.startsWith("terminal/")) c.terminalOther += 1;
        else if (action === "fs/read") c.fsRead += 1;
        else if (action === "fs/write") c.fsWrite += 1;
        else if (action === "session/request_permission") c.permission += 1;
      },
    },
  );

  console.log(`\n================ ${title} ================`);
  try {
    await client.initialize();
    const ses = (await client.newSession({ cwd, mcpServers: [] })) as Record<string, unknown>;
    const sessionId = String(ses.sessionId);
    const modelOpt = (ses.configOptions as Array<Record<string, unknown>> | undefined)?.find(
      (o) => o.id === "model",
    );
    console.log(`model = ${String(modelOpt?.currentValue ?? "?")}`);
    const res = (await client.prompt(sessionId, CMD_PROMPT)) as { stopReason: string };
    console.log(`stopReason = ${res.stopReason}`);
  } catch (err) {
    console.log(`FAIL: ${(err as Error).message}`);
  } finally {
    client.kill();
  }

  console.log(
    `客户端收到的反向调用： terminal/create=${c.terminalCreate}  terminal/*其他=${c.terminalOther}  ` +
      `fs/read=${c.fsRead}  fs/write=${c.fsWrite}  request_permission=${c.permission}`,
  );
  console.log(`agent 侧报告： tool_call=${c.toolCall}  tool_call_update=${c.toolCallUpdate}`);
  const delegated = c.terminalCreate > 0 || c.fsRead > 0 || c.fsWrite > 0;
  console.log(`→ 结论：${delegated ? "**会委托**（事前可拦）" : "**不委托**（只能事后观测）"}`);
  if (c.outputSeen.length) {
    console.log(`  命令输出确实回来了：${JSON.stringify(c.outputSeen[0])}`);
  }
}

async function main(): Promise<void> {
  const agents = installedAgents();
  if (!agents.length) {
    console.log("没有检测到可用 agent。");
    return;
  }
  for (const a of agents) {
    await probeOne(a.id, a.title, a.launch!);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
