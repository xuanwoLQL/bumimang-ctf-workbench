/**
 * ACP 适配器探针 —— 用来填 docs/ARCHITECTURE.md §16.2 那张"四家行为对照表"。
 *
 * 用法：npm run probe
 *
 * 它对每个检测到的 agent 做一次真实握手，把能力声明与 session/new 的完整响应打出来。
 * 表里的每一格都靠这个脚本实测，不靠猜。
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AcpClient } from "../main/acp/client.ts";
import { PassthroughPolicy } from "../main/policy/policy.ts";
import { detectAgents } from "../main/discovery/detect.ts";

const ROOT = "D:/agent/xuanwo/.probe";

async function probeAgent(
  id: string,
  title: string,
  launch: { command: string; args: string[] },
): Promise<void> {
  const cwd = join(ROOT, id);
  mkdirSync(cwd, { recursive: true });
  console.log(`\n================ ${title} ================`);
  const client = AcpClient.spawn(
    { command: launch.command, args: launch.args, cwd, label: id },
    {
      policy: new PassthroughPolicy(),
      sessionId: `probe-${id}`,
      log: () => undefined,
      onUpdate: () => undefined,
      onExit: () => undefined,
    },
  );
  try {
    const init = (await client.initialize()) as Record<string, unknown>;
    console.log("[initialize] protocolVersion =", init.protocolVersion);
    console.log("[initialize] agentInfo       =", JSON.stringify(init.agentInfo ?? {}));
    console.log("[initialize] authMethods     =", JSON.stringify(init.authMethods ?? []));
    console.log("[initialize] agentCapabilities =\n" + JSON.stringify(init.agentCapabilities ?? {}, null, 1));

    const ses = (await client.newSession({ cwd, mcpServers: [] })) as Record<string, unknown>;
    console.log("[session/new] 完整响应 =\n" + JSON.stringify(ses, null, 1).slice(0, 4000));
    if (ses.configOptions) {
      console.log("\n[session/new] configOptions 里与模型/模式相关的选项：");
      for (const opt of ses.configOptions as Array<Record<string, unknown>>) {
        console.log("  -", JSON.stringify(opt).slice(0, 400));
      }
    }

    // 端到端冒烟：用 agent 的**默认**配置跑一轮（不做会话级模型覆盖），
    // 用来验证"agent 自己的配置能不能用"——这正是踩过 Invalid credential 的那个坑。
    const sessionId = String(ses.sessionId);
    const modelOpt = (ses.configOptions as Array<Record<string, unknown>> | undefined)?.find(
      (o) => o.id === "model",
    );
    console.log(`\n[smoke] 默认模型 = ${String(modelOpt?.currentValue ?? "?")}，发起一次 prompt...`);
    try {
      const res = (await client.prompt(sessionId, "只回复两个字：正常。不要调用任何工具。")) as {
        stopReason: string;
      };
      console.log(`[smoke] stopReason = ${res.stopReason}  → 默认配置可用`);
    } catch (err) {
      console.log(`[smoke] FAIL: ${(err as Error).message}`);
      console.log("       ↑ 若报 Invalid credential，说明 agent 的默认模型需要它自家登录，");
      console.log("         需要在会话级用 session/set_config_option 指到有凭据的模型。");
    }
  } catch (err) {
    console.log("FAIL:", (err as Error).message);
  } finally {
    client.kill();
  }
}

async function main(): Promise<void> {
  const agents = detectAgents();
  const usable = agents.filter((a) => a.installed && a.launch);
  if (!usable.length) {
    console.log("没有检测到可用 agent。");
    return;
  }
  for (const a of usable) {
    await probeAgent(a.id, a.title, a.launch!);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
