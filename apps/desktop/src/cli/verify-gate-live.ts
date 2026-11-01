/**
 * T12 闸门活体验收 —— 走真实的 AcpClient 代码路径，验证"权限请求 → 策略 → 人工 → 回传"。
 *
 * 与 `verify:gate` 的区别：那个测的是引擎和队列的纯逻辑；**这个测的是接线**——
 * 客户端收到 ACP 的 `session/request_permission` 之后，是否真的经过策略引擎、
 * 是否真的挂起等人工、放行/拒绝时回给 agent 的到底是什么。
 *
 * 用一个假 ACP agent（fake-agent.ts）当对端，所以不依赖任何模型。
 *
 * 用法：npm run verify:gate-live
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../main/acp/client.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import type { ApprovalView } from "../../../../packages/shared-protocol/events.ts";

const ROOT = "D:/agent/xuanwo";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FAKE_AGENT = path.join(HERE, "fake-agent.ts");
const WORK = path.join(ROOT, ".ui-run", "gate-live");
const LOGS = path.join(ROOT, "docs", "logs");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Scenario {
  label: string;
  title: string;
  /** 人工怎么处理这次审批；null 表示没有审批出现（例如被 block） */
  human: "approved" | "denied" | null;
  outFile: string;
}

async function runScenario(s: Scenario): Promise<Record<string, unknown> | null> {
  console.log(`\n---------- 场景：${s.label} ----------`);
  rmSync(s.outFile, { force: true });
  mkdirSync(WORK, { recursive: true });

  const policy = new PolicyEngine({ repoRoot: ROOT, packId: "competition" });
  const upserts: ApprovalView[] = [];
  const queue = new ApprovalQueue({
    onUpsert: (v) => upserts.push(v),
    intentSummary: () => "假 agent 说：我要执行一条命令",
    timeoutMs: 8000,
    onTimeout: "denied",
  });

  const client = AcpClient.spawn(
    {
      command: process.execPath,
      args: [FAKE_AGENT],
      cwd: WORK,
      env: { FAKE_TITLE: s.title, FAKE_OUT: s.outFile },
      label: "fake-agent",
    },
    {
      policy,
      sessionId: "s-fake",
      tier: "guarded",
      log: () => undefined,
      onUpdate: () => undefined,
      onExit: () => undefined,
      onClientCall: () => undefined,
      onApprovalRequired: async (_detail, decision) => {
        const o = await queue.request({
          taskId: "t-fake",
          sessionId: "s-fake",
          action: "session/request_permission",
          detail: _detail,
          rule: decision.rule,
          reason: decision.reason,
        });
        return o.decision === "approved";
      },
    },
  );

  try {
    await client.initialize();
    const ses = (await client.newSession({ cwd: WORK, mcpServers: [] })) as { sessionId: string };
    check("假 agent 完成握手并建立会话", Boolean(ses.sessionId), `acpSession=${ses.sessionId}`);

    // 等权限请求到达并被策略引擎处理
    for (let i = 0; i < 40 && upserts.length === 0 && !existsSync(s.outFile); i += 1) await sleep(100);

    if (s.human === null) {
      // 期望被硬阻断：不应产生待批项
      eq("被 block 时不进审批队列（没有放行按钮这条路）", upserts.length, 0);
      for (let i = 0; i < 30 && !existsSync(s.outFile); i += 1) await sleep(100);
    } else {
      check("权限请求真的到达了审批队列（挂起等人工）", upserts.length === 1, `upsert=${upserts.length}`);
      if (upserts.length) {
        const v = upserts[0];
        eq("待批项状态为 pending", v.status, "pending");
        eq("命中策略规则可追溯", v.rule !== null, true);
        check("中栏拿到了自述意图", v.intentSummary !== null, String(v.intentSummary).slice(0, 40));
      }
      // 人工决策
      const pending = upserts.find((u) => u.status === "pending");
      if (pending) queue.decide(pending.id, s.human, false);
      for (let i = 0; i < 40 && !existsSync(s.outFile); i += 1) await sleep(100);
    }
  } finally {
    client.kill();
  }

  if (!existsSync(s.outFile)) {
    check("假 agent 收到了客户端的应答", false, `${s.outFile} 未生成`);
    return null;
  }
  const resp = JSON.parse(readFileSync(s.outFile, "utf8")) as {
    result?: { outcome?: { outcome?: string; optionId?: string } };
  };
  return resp as unknown as Record<string, unknown>;
}

async function main(): Promise<void> {
  mkdirSync(LOGS, { recursive: true });
  console.log("========== 闸门活体验收（真实 AcpClient 路径 + 假 agent）==========");

  // 场景 1：凭据类动作 → 策略 approve → 人工放行 → agent 收到 selected
  const allowOut = path.join(LOGS, "gate-live-allow.json");
  const r1 = (await runScenario({
    label: "凭据类动作，人工放行",
    title: "run mimikatz sekurlsa::logonpasswords",
    human: "approved",
    outFile: allowOut,
  })) as { result?: { outcome?: { outcome?: string; optionId?: string } } } | null;
  const outcome1 = r1?.result?.outcome;
  eq("放行后 agent 拿到的 outcome 是 selected", outcome1?.outcome, "selected");
  eq("并且挑的是 allow 语义的 option", outcome1?.optionId, "allow-once");

  // 场景 2：同类动作 → 人工拒绝 → agent 收到 cancelled
  const denyOut = path.join(LOGS, "gate-live-deny.json");
  const r2 = (await runScenario({
    label: "凭据类动作，人工拒绝",
    title: "run mimikatz sekurlsa::logonpasswords",
    human: "denied",
    outFile: denyOut,
  })) as { result?: { outcome?: { outcome?: string } } } | null;
  eq("拒绝后 agent 拿到的 outcome 是 cancelled", r2?.result?.outcome?.outcome, "cancelled");

  // 场景 3：C2 工具 → 策略 block → 不进队列、直接 cancelled
  const blockOut = path.join(LOGS, "gate-live-block.json");
  const r3 = (await runScenario({
    label: "C2 工具命令（硬阻断）",
    title: "cobaltstrike-client.exe --connect 10.0.0.9",
    human: null,
    outFile: blockOut,
  })) as { result?: { outcome?: { outcome?: string } } } | null;
  eq("硬阻断后 agent 拿到的 outcome 是 cancelled（且从未进队列）", r3?.result?.outcome?.outcome, "cancelled");

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n========== ${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

void spawn; // 保留 import 供将来扩展
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
