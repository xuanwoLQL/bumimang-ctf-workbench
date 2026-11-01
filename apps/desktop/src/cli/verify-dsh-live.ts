/**
 * T14 验收 —— 把 dsh（DeepSeek Harness）接成第四家 agent 的**实跑**验证。
 *
 * 断言四组（施工清单 §3.3 的那四条 + 发现/停会话）：
 *   1. 发现：detect.ts 能从桌面版安装目录解析出 `dsh.cmd`，并包成 `cmd.exe /c ... --profile acp`；
 *      **且解析是「目录名 + 固定相对路径」驱动的**——脚本造一个临时安装树来证明不依赖本机路径。
 *   2. 握手：protocolVersion=1 / agentInfo.name=deepseek-harness-acp / sessionCapabilities 有 close；
 *      `session/new` 返回 model + reasoning_effort 两个 config option。
 *   3. 闸门（走应用自己的 SessionManager 路径，不是裸探针）：
 *      autonomous 档 → `DSH_PERMISSION_MODE=workspace-write` → request_permission=0 且文件真被写；
 *      guarded 档 → `read-only` → request_permission=1、选项含 allow-once（kind=allow_once）、
 *      放行后文件真被写；同一档位**拒绝**时文件不被写（证明闸门真的挡住）。
 *   4. 停会话：`session/close` 真的被回应（wire 日志里 out 一条、in 一条响应）。
 *
 * 会调用大模型（一次 flash 提示／每个档位各一次），烧极少 token。
 * 用法：npm run verify:dsh-live
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../main/acp/client.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { detectAgents, resolveDshLaunch } from "../main/discovery/detect.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";

const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "dsh-live");
const PROMPT = "在当前工作目录创建文件 mode-probe.txt，内容写 hello。只做这一件事，做完就结束。";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 递归找一个文件（dsh 可能把文件写在会话 cwd 或其 sessions/<id> 下） */
function findFile(dir: string, name: string, depth = 4): string | null {
  if (depth < 0) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e === name) return join(dir, e);
  }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      if (readdirSync(p).length >= 0) {
        const hit = findFile(p, name, depth - 1);
        if (hit) return hit;
      }
    } catch {
      /* 不是目录 */
    }
  }
  return null;
}

// ------------------------------------------------------------------ 1. 发现

console.log("========== 1. 发现（detect.ts 的 dsh 三级解析）==========");
const dsh = detectAgents().find((a) => a.id === "dsh");
check("dsh 出现在检测结果里", Boolean(dsh));
check("未安装提示不再指向 npm @deepseek-ai/dsh-acp", !/npm i -g/i.test(dsh?.installHint ?? ""), dsh?.installHint ?? "");
check(
  "launch 是 cmd.exe /c <dsh.cmd> --profile acp",
  dsh?.launch?.command === "cmd.exe" &&
    /dsh\.cmd$/i.test(dsh.launch.args[1] ?? "") &&
    dsh.launch.args.slice(2).join(" ") === "--profile acp",
  JSON.stringify(dsh?.launch ?? null),
);
eq("permissionBehavior 是按档武装（requests_by_default）", dsh?.permissionBehavior, "requests_by_default");

const real = dsh?.launch ? { cli: dsh.launch.args[1], installed: true } : { cli: null, installed: false };
check("本机解析到了 dsh.cmd（存在性）", Boolean(real.cli && existsSync(real.cli)), real.cli ?? "未找到");
const realProbe = resolveDshLaunch({});
console.log(`  来源=${realProbe.source} 安装目录=${realProbe.installDir}`);

// 临时安装树：证明「目录名 + 固定相对路径」的解析对任意根目录成立（不是写死本机路径）
const altRoot = join(tmpdir(), `dsh-alt-install-${Date.now()}`);
const altDir = join(altRoot, "DeepSeek Harness");
const altRel = join("resources", "runtime", "cli", "bin", "dsh.cmd");
mkdirSync(join(altDir, "resources", "runtime", "cli", "bin"), { recursive: true });
writeFileSync(join(altDir, altRel), "@echo off\r\nrem synthetic shim for detect test\r\n");
const altScan = resolveDshLaunch({ roots: [altRoot], skipRegistry: true });
eq("临时根目录下扫一级子目录能命中（source=known）", altScan.source, "known");
eq("命中的 CLI 路径就是造出来的那个", altScan.cli, join(altDir, altRel));
eq("installDir 反推正确", altScan.installDir, altDir);
const altDirect = resolveDshLaunch({ roots: [altDir], skipRegistry: true });
eq("把安装目录本身当根也能命中", altDirect.cli, join(altDir, altRel));
rmSync(altRoot, { recursive: true, force: true });

// 反面：什么都找不到时必须是「未安装」（launch=null → 渲染层灰显 + 给 installHint）
const emptyRoot = join(tmpdir(), `dsh-empty-${Date.now()}`);
mkdirSync(emptyRoot, { recursive: true });
const none = resolveDshLaunch({ roots: [emptyRoot], skipRegistry: true });
check(
  "找不到时 launch=null、source=null（渲染层据此灰显并显示安装提示）",
  none.launch === null && none.source === null,
  JSON.stringify(none),
);
rmSync(emptyRoot, { recursive: true, force: true });

// ------------------------------------------------------------------ 2. 握手

console.log("\n========== 2. 握手 + session/new（不烧 token）==========");
const hsWork = join(WORK, "handshake");
rmSync(hsWork, { recursive: true, force: true });
mkdirSync(hsWork, { recursive: true });

const hsPolicy = new PolicyEngine({ repoRoot: ROOT, packId: "competition" });
const hsClient = AcpClient.spawn(
  { command: dsh!.launch!.command, args: dsh!.launch!.args, cwd: hsWork, label: "dsh" },
  {
    policy: hsPolicy,
    sessionId: "s-handshake",
    tier: "guarded",
    log: () => undefined,
    onUpdate: () => undefined,
    onExit: () => undefined,
    onClientCall: () => undefined,
  },
);
let initRes: Record<string, unknown> | null = null;
let newRes: { sessionId: string; configOptions?: Array<{ id: string; currentValue?: unknown }> } | null = null;
try {
  initRes = (await hsClient.initialize()) as Record<string, unknown>;
  console.log(`  initialize: protocolVersion=${String(initRes.protocolVersion)} agentInfo=${JSON.stringify(initRes.agentInfo ?? {})}`);
  newRes = (await hsClient.newSession({ cwd: hsWork, mcpServers: [] })) as typeof newRes;
  for (const o of newRes?.configOptions ?? []) {
    console.log(`  config: ${o.id} = ${String(o.currentValue)}`);
  }
} catch (err) {
  check("握手与 session/new 不报错", false, (err as Error).message);
}
eq("initialize.protocolVersion = 1", initRes?.protocolVersion, 1);
eq(
  "agentInfo.name = deepseek-harness-acp",
  (initRes?.agentInfo as Record<string, unknown> | undefined)?.name,
  "deepseek-harness-acp",
);
const caps = (initRes?.agentCapabilities as Record<string, unknown> | undefined)?.sessionCapabilities as
  | Record<string, unknown>
  | undefined;
check("sessionCapabilities 里有 close", caps ? "close" in caps : false, JSON.stringify(caps ?? null));
check("session/new 返回了 sessionId", typeof newRes?.sessionId === "string" && newRes.sessionId.length > 0, String(newRes?.sessionId));
const cfgIds = (newRes?.configOptions ?? []).map((o) => o.id);
check("configOptions 含 model", cfgIds.includes("model"), JSON.stringify(cfgIds));
check("configOptions 含 reasoning_effort", cfgIds.includes("reasoning_effort"), JSON.stringify(cfgIds));
hsClient.kill();

// ------------------------------------------------------- 3. 闸门（走应用路径）

interface TierRun {
  tier: "autonomous" | "guarded";
  /** 本次会话遇到权限请求时，人工的答复 */
  decision: "allow" | "deny";
  permissions: number;
  permissionDetails: Array<Record<string, unknown>>;
  toolCallUpdates: Array<Record<string, unknown>>;
  managerLog: string[];
  file: string | null;
  fileContent: string | null;
  stopReason: string | null;
  closeRequestId: number | null;
  closeResponded: boolean;
  error: string | null;
}

async function runTier(tier: "autonomous" | "guarded", decision: "allow" | "deny" = "allow"): Promise<TierRun> {
  const label = decision === "allow" ? tier : `${tier}+拒绝`;
  console.log(`\n---------- 档位 ${label}（走 SessionManager）----------`);
  const work = join(WORK, decision === "allow" ? tier : `${tier}-deny`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const board = Blackboard.open(join(work, "board.db"));
  const task = board.createTask({ title: `dsh ${tier} 验收`, brief: PROMPT });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: newRunId() });
  await bridge.start();

  const out: TierRun = {
    tier,
    decision,
    permissions: 0,
    permissionDetails: [],
    toolCallUpdates: [],
    managerLog: [],
    file: null,
    fileContent: null,
    stopReason: null,
    closeRequestId: null,
    closeResponded: false,
    error: null,
  };
  let sessionId = "";

  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: work,
    onLine: (l) => out.managerLog.push(l),
    // 注意签名：SessionManager 的钩子是 (sessionId, taskId, detail, decision)
    onApprovalRequired: async (_sessionId, _taskId, detail) => {
      out.permissions += 1;
      out.permissionDetails.push(detail);
      return decision === "allow";
    },
  });

  try {
    const rec = await mgr.startSession({
      taskId: task.id,
      spec: { command: dsh!.launch!.command, args: dsh!.launch!.args, cwd: work, label: "dsh" },
      agent: "dsh",
      role: "lead",
      tier,
    });
    sessionId = rec.id;
    // 原始的 request_permission 与 tool_call 长什么样（从 wire 日志里取，不受我们的归一化影响）
    const wire = join(work, "sessions", sessionId, "wire.jsonl");
    out.stopReason = await mgr.prompt(sessionId, PROMPT);
    await sleep(2500);
    const lines = readFileSync(wire, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const e of lines) {
      const msg = e.message as Record<string, unknown>;
      if (e.dir === "in" && msg?.method === "session/update") {
        const upd = (msg.params as Record<string, unknown>)?.update as Record<string, unknown> | undefined;
        if (upd?.sessionUpdate === "tool_call" || upd?.sessionUpdate === "tool_call_update") {
          out.toolCallUpdates.push(upd);
        }
      }
    }
    out.file = findFile(work, "mode-probe.txt");
    out.fileContent = out.file ? readFileSync(out.file, "utf8").trim() : null;
    // 停会话：看 dsh 有没有回应 session/close（§4 第 2 条：它有持久化，得确认 close 真的被处理）
    await mgr.stopSession(sessionId);
    await sleep(2000);
    const after = readFileSync(wire, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const closeOut = after.find(
      (e) => e.dir === "out" && (e.message as Record<string, unknown>)?.method === "session/close",
    );
    out.closeRequestId = Number((closeOut?.message as Record<string, unknown>)?.id ?? NaN);
    out.closeResponded = after.some(
      (e) => e.dir === "in" && Number((e.message as Record<string, unknown>)?.id) === out.closeRequestId,
    );
  } catch (err) {
    out.error = (err as Error).message;
  } finally {
    await mgr.shutdown();
    bridge.stop();
    board.close();
  }

  console.log(
    `  request_permission=${out.permissions}  tool_call 更新=${out.toolCallUpdates.length}  ` +
      `文件=${out.file ?? "无"}  stopReason=${String(out.stopReason)}  ` +
      `close(${String(out.closeRequestId)}) 有响应=${out.closeResponded}` +
      `${out.error ? `  error=${out.error}` : ""}`,
  );
  for (const p of out.permissionDetails.slice(0, 2)) {
    console.log(`  审批 detail: ${JSON.stringify(p).slice(0, 400)}`);
  }
  const sample = out.toolCallUpdates[0];
  if (sample) console.log(`  首条 tool_call 更新: ${JSON.stringify(sample).slice(0, 300)}`);
  return out;
}

console.log("\n========== 3. 闸门：档位 → DSH_PERMISSION_MODE ==========");
const auto = await runTier("autonomous");
check("autonomous 档注入的是 workspace-write", auto.managerLog.some((l) => l.includes("DSH_PERMISSION_MODE=workspace-write")), auto.managerLog.find((l) => l.includes("DSH_PERMISSION_MODE")) ?? "（无注入日志）");
eq("autonomous 档：request_permission = 0（默认不问）", auto.permissions, 0);
check("autonomous 档：文件真被写了（默认 workspace-write）", Boolean(auto.file), auto.file ?? "未找到 mode-probe.txt");
if (auto.file) eq("autonomous 档：文件内容是 hello", readFileSync(auto.file, "utf8").trim(), "hello");

const guarded = await runTier("guarded");
check("guarded 档注入的是 read-only", guarded.managerLog.some((l) => l.includes("DSH_PERMISSION_MODE=read-only")), guarded.managerLog.find((l) => l.includes("DSH_PERMISSION_MODE")) ?? "（无注入日志）");
eq("guarded 档：request_permission = 1（闸门被武装）", guarded.permissions, 1);
const permOpts = (guarded.permissionDetails[0]?.options as Array<Record<string, unknown>> | undefined) ?? [];
check(
  "guarded 档：选项里有 allow-once（kind=allow_once）——我们的审批链按 kind 前缀选它",
  permOpts.some((o) => o.optionId === "allow-once" && String(o.kind) === "allow_once"),
  JSON.stringify(permOpts),
);
check(
  "guarded 档：选项里有 reject-once",
  permOpts.some((o) => o.optionId === "reject-once" && String(o.kind) === "reject_once"),
  JSON.stringify(permOpts),
);
check(
  "guarded 档：权限请求带 toolCallId（dsh 只给 id、不给动作名）",
  typeof guarded.permissionDetails[0]?.toolCallId === "string" && String(guarded.permissionDetails[0]?.toolCallId).length > 0,
  JSON.stringify(guarded.permissionDetails[0] ?? null).slice(0, 200),
);
const toolNamed = guarded.toolCallUpdates.filter((u) => typeof u.title === "string" && u.title.length > 0);
console.log(
  `  tool_call 更新里带名字的条数=${toolNamed.length}/${guarded.toolCallUpdates.length}` +
    `${toolNamed[0] ? `，例：${JSON.stringify(toolNamed[0].title)}` : ""}`,
);
check(
  "审批卡不再是「未命名工具调用」（detail.title 已按 toolCallId 从 tool_call 关联取名）",
  String(guarded.permissionDetails[0]?.title ?? "") !== "未命名工具调用" && String(guarded.permissionDetails[0]?.title ?? "").length > 0,
  `title=${JSON.stringify(guarded.permissionDetails[0]?.title ?? null)} titleFrom=${JSON.stringify(guarded.permissionDetails[0]?.titleFrom ?? null)}`,
);
check(
  "guarded 档：放行（allow-once）之后动作真的发生了 —— 文件被写",
  Boolean(guarded.file),
  `文件=${guarded.file ?? "无"} 内容=${JSON.stringify(guarded.fileContent)}`,
);

const denied = await runTier("guarded", "deny");
eq("guarded+拒绝 档：request_permission = 1", denied.permissions, 1);
check(
  "guarded+拒绝 档：拒绝之后文件没被写（闸门真的挡住了）",
  !denied.file,
  `文件=${denied.file ?? "无（正确）"}`,
);

console.log("\n========== 4. 停会话：session/close 被回应 ==========");
check("autonomous 档：session/close 有响应", auto.closeResponded, `close id=${String(auto.closeRequestId)}`);
check("guarded 档：session/close 有响应", guarded.closeResponded, `close id=${String(guarded.closeRequestId)}`);
check("guarded+拒绝 档：session/close 有响应", denied.closeResponded, `close id=${String(denied.closeRequestId)}`);

// ------------------------------------------------------------------ 汇总

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n================ dsh 实跑验收：${passed}/${results.length} ${failed.length ? "FAIL" : "ALL_PASS"} ================`);
for (const f of failed) console.log(`FAIL  ${f.name}  — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
