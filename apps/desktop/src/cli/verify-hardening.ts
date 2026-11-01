/**
 * 安全加固验收（审查 P1/P2/P3 的回归）：
 *
 * 1. guarded 档下 fs/read、terminal/create 的 approve 必须转人工；
 * 2. allow 规则不能被 rawInput 自由文本伪造；block 优先于 allow；
 * 3. 审批落库/通知失败不能让 Promise 悬挂或把主进程掀掉；
 * 4. 「全部放行」通配授权只跳过审批，不绕过 block / 工作目录边界；
 * 5. Hub 的 workDir / pid / setTier / 统一收尾行为；
 * 6. IPC 动作校验拒绝非法 tier 与未知动作。
 *
 * 运行：node apps/desktop/src/cli/verify-hardening.ts
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { AcpClient } from "../main/acp/client.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { newRunId } from "../main/session/manager.ts";
import { DEFAULT_PERMISSION_CONFIG, profileOperation } from "../main/permission/profile.ts";
import { PermissionStore } from "../main/permission/store.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { validateHubAction } from "../main/electron/validate-action.ts";
import type { SessionRecord } from "../main/session/manager.ts";
import type { HubEvent } from "../../../../packages/shared-protocol/events.ts";

const REPO = "D:/agent/xuanwo";
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
let failures = 0;

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const eq = (name: string, actual: unknown, expected: unknown): void =>
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

const dir = mkdtempSync(path.join(tmpdir(), "bumimang-hardening-"));
const workRoot = path.join(dir, "work", "task-review");
mkdirSync(workRoot, { recursive: true });
const outsideFile = path.join(dir, "outside-secret.txt");
writeFileSync(outsideFile, "SECRET_OUTSIDE\n", "utf8");
const insideFile = path.join(workRoot, "inside.txt");
writeFileSync(insideFile, "INSIDE_RELATIVE\n", "utf8");

const engine = new PolicyEngine({ repoRoot: REPO, packId: "competition" });
const fakeAgent = path.resolve(import.meta.dirname, "fake-fs-agent.ts");

async function main(): Promise<void> {
  console.log("================ 1. 策略规则：allow 不可伪造，block 优先 ================\n");

  const spoof = engine.evaluate({
    action: "session/request_permission",
    sessionId: "s-h",
    tier: "guarded",
    detail: {
      name: "Bash",
      title: "Bash",
      kind: "execute",
      rawInput: { command: "echo blackboard_read_since" },
    },
  });
  check(
    "rawInput 里塞黑板工具名不能命中 allow 规则",
    spoof.verdict !== "allow",
    `verdict=${spoof.verdict} rule=${spoof.rule}`,
  );

  const legit = engine.evaluate({
    action: "session/request_permission",
    sessionId: "s-h",
    tier: "guarded",
    detail: {
      toolName: "mcp__blackboard__blackboard_read_since",
      title: "mcp__blackboard__blackboard_read_since",
      kind: "other",
    },
  });
  eq("真正的黑板工具仍然放行", legit.verdict, "allow");

  const blockWins = engine.evaluate({
    action: "session/request_permission",
    sessionId: "s-h",
    tier: "guarded",
    detail: {
      toolName: "mcp__blackboard__blackboard_read_since",
      title: "mcp__blackboard__blackboard_read_since",
      kind: "execute",
      rawInput: { command: "cobaltstrike-client.exe" },
    },
  });
  eq("block 规则优先于 allow（硬阻断不可被盖掉）", blockWins.verdict, "block");

  console.log("\n================ 2. 审批队列：持久化失败必须结算 ================\n");

  let decidePersistCalls = 0;
  const q1 = new ApprovalQueue({
    onUpsert: () => undefined,
    onPersist: (view) => {
      decidePersistCalls += 1;
      if (view.status !== "pending") throw new Error("模拟 SQLite 写入失败");
    },
    timeoutMs: 1000,
    onError: () => undefined,
  });
  const p1 = q1.request({
    taskId: "t",
    sessionId: "s1",
    action: "session/request_permission",
    detail: { title: "run something" },
    rule: "tier-guarded-default",
    reason: "受控档转人工",
  });
  let p1settled = false;
  void p1.then(
    () => {
      p1settled = true;
    },
    () => {
      p1settled = true;
    },
  );
  await sleep(10);
  const pending1 = q1.list().find((v) => v.status === "pending")!;
  let decideThrew = false;
  try {
    q1.decide(pending1.id, "approved");
  } catch {
    decideThrew = true;
  }
  await sleep(30);
  check(
    "裁决时落库抛错：decide 不抛、pending 清空、Promise 仍结算",
    !decideThrew && p1settled && q1.pendingCount() === 0,
    `threw=${decideThrew} settled=${p1settled} pending=${q1.pendingCount()} persistCalls=${decidePersistCalls}`,
  );

  let timeoutPersistCalls = 0;
  const q2 = new ApprovalQueue({
    onUpsert: () => undefined,
    onPersist: () => {
      timeoutPersistCalls += 1;
      throw new Error("模拟 SQLite 写入失败");
    },
    timeoutMs: 20,
    onError: () => undefined,
  });
  const p2 = q2.request({
    taskId: "t",
    sessionId: "s2",
    action: "session/request_permission",
    detail: { title: "run something" },
    rule: "tier-guarded-default",
    reason: "受控档转人工",
  });
  let p2settled = false;
  void p2.then(
    () => {
      p2settled = true;
    },
    () => {
      p2settled = true;
    },
  );
  await sleep(120);
  check(
    "超时路径落库抛错：不产生未捕获异常，Promise 按超时拒绝",
    p2settled && q2.pendingCount() === 0 && timeoutPersistCalls >= 2,
    `settled=${p2settled} pending=${q2.pendingCount()} persistCalls=${timeoutPersistCalls}`,
  );

  let denyPersistCalls = 0;
  const q3 = new ApprovalQueue({
    onUpsert: () => undefined,
    onPersist: (view) => {
      denyPersistCalls += 1;
      if (view.status !== "pending") throw new Error("模拟 SQLite 写入失败");
    },
    timeoutMs: 1000,
    onError: () => undefined,
  });
  const p3 = q3.request({
    taskId: "t",
    sessionId: "s3",
    action: "session/request_permission",
    detail: { title: "run something" },
    rule: "tier-guarded-default",
    reason: "受控档转人工",
  });
  let p3settled = false;
  void p3.then(
    () => {
      p3settled = true;
    },
    () => {
      p3settled = true;
    },
  );
  await sleep(10);
  q3.denyAllOf("s3");
  await sleep(30);
  check(
    "清场时落库抛错：仍结算为 denied",
    p3settled && q3.pendingCount() === 0,
    `settled=${p3settled} pending=${q3.pendingCount()} persistCalls=${denyPersistCalls}`,
  );

  console.log("\n================ 3. 全部放行：只跳过审批 ================\n");

  const permFile = path.join(dir, "permissions.json");
  const store = new PermissionStore({ filePath: permFile, config: DEFAULT_PERMISSION_CONFIG });
  const execProfile = profileOperation(
    { kind: "execute", title: "run nmap 10.0.0.9", rawInput: { command: "nmap 10.0.0.9" } },
    DEFAULT_PERMISSION_CONFIG,
  );
  eq("前置：高风险执行不可被普通一键放行", store.match({ agentId: "claude", sessionId: "s1", profile: execProfile }), null);
  const gs = store.grantAll({ agentId: "claude", sessionId: "s1", scope: "session" });
  check("本会话全部放行成功", gs.ok, JSON.stringify(gs));
  check(
    "通配授权命中高风险执行",
    store.match({ agentId: "claude", sessionId: "s1", profile: execProfile })?.category === "all",
  );
  check(
    "通配授权不串到别的会话",
    store.match({ agentId: "claude", sessionId: "s2", profile: execProfile }) === null,
  );
  const ga = store.grantAll({ agentId: "codex", scope: "agent" });
  check("该 agent 永久全部放行成功", ga.ok, JSON.stringify(ga));
  const reloaded = new PermissionStore({ filePath: permFile, config: DEFAULT_PERMISSION_CONFIG });
  check(
    "agent 通配授权重启后仍生效",
    reloaded.match({ agentId: "codex", sessionId: "s99", profile: execProfile })?.category === "all",
  );
  check(
    "agent 通配授权只对自己 agent 生效",
    reloaded.match({ agentId: "claude", sessionId: "s99", profile: execProfile }) === null,
  );

  const gg = store.grantAll({ scope: "global" });
  check("全局全部放行成功", gg.ok, JSON.stringify(gg));
  check(
    "全局授权对所有 agent / 会话生效",
    store.match({ agentId: "claude", sessionId: "s-new", profile: execProfile })?.id === "global:all" &&
      store.match({ agentId: "opencode", sessionId: "s-other", profile: execProfile })?.category === "all",
  );
  check(
    "全局授权出现在授权列表",
    store.list().some((g) => g.id === "global:all" && g.agentId === "*"),
  );
  const reloadedGlobal = new PermissionStore({ filePath: permFile, config: DEFAULT_PERMISSION_CONFIG });
  check(
    "全局授权重启后仍生效",
    reloadedGlobal.match({ agentId: "claude", sessionId: "s99", profile: execProfile })?.id === "global:all",
  );
  reloadedGlobal.revoke("*");
  check(
    "撤销 agentId=* 关闭全局授权",
    reloadedGlobal.match({ agentId: "claude", sessionId: "s99", profile: execProfile }) === null,
  );
  const reloadedOff = new PermissionStore({ filePath: permFile, config: DEFAULT_PERMISSION_CONFIG });
  check(
    "全局授权关闭后持久化，不因重启复活",
    reloadedOff.match({ agentId: "claude", sessionId: "s99", profile: execProfile }) === null,
  );

  console.log("\n================ 4. 客户端反向调用：approve 必须转人工 ================\n");

  async function runFakeAgent(input: {
    allow: boolean;
    readPath: string;
    skipTerminal?: boolean;
  }): Promise<{ approvalCalls: number; out: Record<string, any> }> {
    const outPath = path.join(dir, `fake-out-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    let approvalCalls = 0;
    const client = AcpClient.spawn(
      {
        command: process.execPath,
        args: [fakeAgent],
        cwd: workRoot,
        label: "fake-fs",
        env: {
          FAKE_OUT: outPath,
          FAKE_TARGET: outsideFile,
          FAKE_READ_PATH: input.readPath,
          FAKE_WORKROOT: workRoot,
          ...(input.skipTerminal ? { FAKE_SKIP_TERMINAL: "1" } : {}),
        },
      },
      {
        policy: engine,
        sessionId: "s-hardening",
        tier: "guarded",
        workRoot,
        onUpdate: () => undefined,
        log: () => undefined,
        onExit: () => undefined,
        onApprovalRequired: async () => {
          approvalCalls += 1;
          return input.allow;
        },
      },
    );
    await client.initialize();
    await client.newSession({ cwd: workRoot });
    await client.waitForExit(8000);
    client.kill();
    const out = existsSync(outPath)
      ? (JSON.parse(readFileSync(outPath, "utf8")) as Record<string, any>)
      : {};
    return { approvalCalls, out };
  }

  const denied = await runFakeAgent({ allow: false, readPath: outsideFile });
  check(
    "拒绝时 fs/read 与 terminal/create 都进入审批并失败",
    denied.approvalCalls === 2 &&
      denied.out.fsRead?.code === -32603 &&
      denied.out.terminalCreate?.code === -32603,
    `approvalCalls=${denied.approvalCalls} out=${JSON.stringify(denied.out)}`,
  );

  const allowed = await runFakeAgent({ allow: true, readPath: outsideFile });
  check(
    "人工放行后 fs/read 与 terminal/create 才执行",
    allowed.approvalCalls === 2 &&
      String(allowed.out.fsRead?.contentHead ?? "").includes("SECRET_OUTSIDE") &&
      String(allowed.out.terminalOutput?.outputHead ?? "").includes("SECRET_OUTSIDE"),
    `approvalCalls=${allowed.approvalCalls} out=${JSON.stringify(allowed.out)}`,
  );

  const relative = await runFakeAgent({ allow: true, readPath: "inside.txt", skipTerminal: true });
  check(
    "相对路径按工作目录解析（不是主进程 cwd）",
    relative.approvalCalls === 1 &&
      String(relative.out.fsRead?.contentHead ?? "").includes("INSIDE_RELATIVE") &&
      !String(relative.out.fsRead?.contentHead ?? "").includes("SECRET_OUTSIDE"),
    `approvalCalls=${relative.approvalCalls} out=${JSON.stringify(relative.out)}`,
  );

  console.log("\n================ 5. IPC 动作校验 ================\n");

  let badTier = false;
  try {
    validateHubAction({ type: "session.start", taskId: "t", agent: "claude", role: "lead", tier: "guarded " });
  } catch {
    badTier = true;
  }
  check("非法 tier（尾随空格）被拒绝", badTier);
  let unknown = false;
  try {
    validateHubAction({ type: "session.hack" });
  } catch {
    unknown = true;
  }
  check("未知动作类型被拒绝", unknown);
  let missingSession = false;
  try {
    validateHubAction({ type: "permission.grantAll", scope: "session" });
  } catch {
    missingSession = true;
  }
  check("scope=session 缺 sessionId 被拒绝", missingSession);
  check(
    "合法 grantAll 正常通过",
    validateHubAction({ type: "permission.grantAll", scope: "all" }).type === "permission.grantAll",
  );
  check(
    "scope=global 无需 sessionId / agentId",
    validateHubAction({ type: "permission.grantAll", scope: "global" }).scope === "global",
  );

  console.log("\n================ 6. Hub：workDir / pid / setTier / 统一收尾 ================\n");

  const board = Blackboard.open(path.join(dir, "board.db"));
  const task = board.createTask({ title: "加固验收", brief: "verify-hardening" });
  const bus = new EventBus();
  const approvals = new ApprovalQueue({
    onUpsert: (view) => bus.emit({ type: "approval.upsert", approval: view }),
    timeoutMs: 5000,
    onPersist: () => undefined,
  });
  const permissions = new PermissionStore({ filePath: path.join(dir, "hub-permissions.json"), config: DEFAULT_PERMISSION_CONFIG });

  const sessionsMap = new Map<string, SessionRecord>();
  const stopped: string[] = [];
  const mkRec = (id: string, status: string, agent = "claude"): SessionRecord => ({
    id,
    taskId: task.id,
    agent,
    role: "lead",
    tier: "guarded",
    acpSession: `acp-${id}`,
    pid: 4000 + sessionsMap.size,
    status,
    toolCalls: 0,
    lastBoardReadAt: 0,
    boardReads: 0,
    expectedExit: false,
    model: null,
    startedAt: Date.now(),
    endedAt: null,
  });
  sessionsMap.set("s-active", mkRec("s-active", "idle"));
  const fakeSessions = {
    listSessions: (taskId?: string): SessionRecord[] =>
      [...sessionsMap.values()].filter((s) => !s.hidden && (!taskId || s.taskId === taskId)),
    getSession: (id: string): SessionRecord | undefined => sessionsMap.get(id),
    stopSession: async (id: string): Promise<void> => {
      stopped.push(id);
      const rec = sessionsMap.get(id);
      if (rec) {
        rec.status = "stopped";
        rec.endedAt = Date.now();
      }
    },
    removeSession: async (id: string): Promise<void> => {
      stopped.push(id);
      const rec = sessionsMap.get(id);
      if (rec) rec.status = "stopped";
    },
    prompt: async (): Promise<string> => "end_turn",
    interrupt: (): void => undefined,
    loadTaskSessions: (): void => undefined,
    sendBriefing: async (): Promise<Record<string, never>> => ({}),
    historyOf: (): never[] => [],
    syncLag: (): number => 0,
    startSession: async (): Promise<SessionRecord> => sessionsMap.get("s-active")!,
    shutdown: async (): Promise<{
      allExited: boolean;
      timedOut: boolean;
      pendingSessions: string[];
      closeErrors: never[];
    }> => ({ allExited: true, timedOut: false, pendingSessions: [], closeErrors: [] }),
  };

  const hub = new HubService({
    board,
    sessions: fakeSessions as never,
    bus,
    workspaceRoot: dir,
    workDir: workRoot,
    approvals,
    policy: engine,
    permissions,
  });
  hub.setTask(task.id);

  const snap = hub.snapshot();
  eq("SessionView.pid 使用真实 pid（不再是固定 null）", snap.sessions[0]?.pid, 4000);
  eq("快照任务带任务专属工作目录", snap.task?.workDir, path.join(workRoot, task.id));

  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));
  hub.setTask(task.id);
  const upsert = events.find((e) => e.type === "task.upsert");
  eq(
    "增量 task.upsert 也带 workDir",
    upsert && upsert.type === "task.upsert" ? upsert.task.workDir : undefined,
    path.join(workRoot, task.id),
  );

  const pending = approvals.request({
    taskId: task.id,
    sessionId: "s-active",
    action: "session/request_permission",
    detail: { title: "run nmap 10.0.0.9" },
    rule: "tier-guarded-default",
    reason: "受控档转人工",
  });
  let pendingApproved = false;
  void pending.then((o) => {
    pendingApproved = o.decision === "approved";
  });
  await sleep(10);
  const grantAllRes = await hub.dispatch({
    type: "permission.grantAll",
    scope: "session",
    sessionId: "s-active",
  });
  check("Hub 本会话全部放行成功", grantAllRes.ok, JSON.stringify(grantAllRes));
  await sleep(10);
  check("已挂起的审批被一并放行", pendingApproved);
  check(
    "Hub 侧通配授权命中高风险执行",
    permissions.match({ agentId: "claude", sessionId: "s-active", profile: execProfile })?.category === "all",
  );

  const tierRes = await hub.dispatch({ type: "session.setTier", sessionId: "s-active", tier: "autonomous" });
  eq("运行中切换档位返回明确失败（不再假成功）", tierRes.ok, false);

  const stopRes = await hub.dispatch({ type: "session.stop", sessionId: "s-active" });
  check("session.stop 成功", stopRes.ok, JSON.stringify(stopRes));
  check("stop 真的调用了 SessionManager.stopSession", stopped.includes("s-active"));
  eq(
    "stop 后本会话通配授权被清掉",
    permissions.match({ agentId: "claude", sessionId: "s-active", profile: execProfile }),
    null,
  );

  const globalRes = await hub.dispatch({ type: "permission.grantAll", scope: "global" });
  check("Hub 全局全部放行成功", globalRes.ok, JSON.stringify(globalRes));
  check(
    "Hub 全局授权对所有 agent 生效",
    permissions.match({ agentId: "codex", sessionId: "s-any", profile: execProfile })?.id === "global:all",
  );
  const revokeGlobalRes = await hub.dispatch({ type: "permission.revoke", agentId: "*" });
  check("Hub 撤销全局授权成功", revokeGlobalRes.ok, JSON.stringify(revokeGlobalRes));
  eq(
    "Hub 撤销后全局授权不再命中",
    permissions.match({ agentId: "codex", sessionId: "s-any", profile: execProfile }),
    null,
  );

  // P1-B 行为变更：task.create 只切焦点，不再自动停旧会话、不再清授权；
  // 显式 task.stopAll 才停会话并清理授权。
  sessionsMap.set("s-auto", mkRec("s-auto", "idle"));
  permissions.grantAll({ agentId: "claude", sessionId: "s-auto", scope: "session" });
  const createRes = await hub.dispatch({ type: "task.create", title: "下一题", brief: "切换任务" });
  check("task.create 成功", createRes.ok, JSON.stringify(createRes));
  check("切焦点不再自动停止旧会话", !stopped.includes("s-auto"));
  check(
    "切焦点不清旧会话授权",
    permissions.match({ agentId: "claude", sessionId: "s-auto", profile: execProfile }) !== null,
  );
  const stopAllRes = await hub.dispatch({ type: "task.stopAll", taskId: task.id });
  check("task.stopAll 成功", stopAllRes.ok, JSON.stringify(stopAllRes));
  check("task.stopAll 才停止旧会话", stopped.includes("s-auto"));
  eq(
    "task.stopAll 后旧会话授权被清掉",
    permissions.match({ agentId: "claude", sessionId: "s-auto", profile: execProfile }),
    null,
  );

  console.log("\n================ 7. MCP 令牌随会话撤销 ================\n");

  const bridge = new BoardBridge({ board, taskId: task.id, runId: newRunId() });
  await bridge.start();
  const env = bridge.envForSession("s-mcp", task.id);
  const pipe = env.find((e) => e.name === "BUMIMANG_PIPE")!.value;
  const token = env.find((e) => e.name === "BUMIMANG_TOKEN")!.value;

  const connectHello = (tok: string): Promise<{ authenticated: boolean; socket: net.Socket }> =>
    new Promise((resolve) => {
      const socket = net.connect(pipe);
      let buf = "";
      let done = false;
      const finish = (authenticated: boolean): void => {
        if (done) return;
        done = true;
        resolve({ authenticated, socket });
      };
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.includes("\n")) finish(buf.includes('"ok":true'));
      });
      socket.on("close", () => finish(false));
      socket.on("error", () => finish(false));
      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: 1, token: tok, sessionId: "s-mcp" }) + "\n");
      });
      setTimeout(() => finish(false), 1000);
    });

  const before = await connectHello(token);
  check("撤销前旧 token 可以认证 MCP 管道", before.authenticated);
  bridge.revokeSession("s-mcp");
  await sleep(100);
  const after = await connectHello(token);
  check("撤销后旧 token 不能再认证", !after.authenticated);
  after.socket.destroy();
  bridge.stop();

  board.close();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================ ${passed}/${results.length} 通过 ================`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
