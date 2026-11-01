/**
 * 权限增强端到端验收（真 ACP 接线，假 agent）：
 *
 *  1. 预先给 agent=fake 写入一条「文件写入」永久授权；
 *  2. 假 agent 通过 `session/request_permission` 请求写文件 → 主进程命中授权，
 *     **不创建审批项**，直接返回 allow；
 *  3. 同一个 agent 请求执行命令 → 高风险不可记住，仍然进入审批队列；
 *  4. 审批视图带 category/highRisk/rememberable，供 UI 禁用「始终允许」。
 *
 * 运行：node apps/desktop/src/cli/verify-permission-autoallow.ts
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Blackboard } from "../main/blackboard/board.ts";
import { SessionManager } from "../main/session/manager.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import { PermissionStore } from "../main/permission/store.ts";
import {
  DEFAULT_PERMISSION_CONFIG,
  applyWorkRootBoundary,
  profileOperation,
} from "../main/permission/profile.ts";
import type { OperationProfile } from "../main/permission/profile.ts";
import type { Policy } from "../main/policy/policy.ts";

let failures = 0;
const rows: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  rows.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  return null;
}

const dir = mkdtempSync(path.join(tmpdir(), "bumimang-autoallow-"));
const workRoot = path.join(dir, "work");
mkdirSync(workRoot, { recursive: true });
const board = Blackboard.open(path.join(dir, "board.db"));
const task = board.createTask({ title: "权限自动放行验收", brief: "假 agent 触发 request_permission" });
const taskWork = path.join(workRoot, task.id);
mkdirSync(taskWork, { recursive: true });

const permissions = new PermissionStore({
  filePath: path.join(dir, "permissions.json"),
  config: DEFAULT_PERMISSION_CONFIG,
});

function profileForTask(detail: Record<string, unknown>, taskId: string): OperationProfile {
  return applyWorkRootBoundary(profileOperation(detail, DEFAULT_PERMISSION_CONFIG), detail, path.join(workRoot, taskId));
}

const policy: Policy = {
  name: "verify-autoallow",
  evaluate: () => ({ verdict: "approve", rule: "test-guarded-default", reason: "验收：一律转人工/授权" }),
};

const approvalViews: Array<Record<string, unknown>> = [];
let queue!: ApprovalQueue;
let approvalRequests = 0;
queue = new ApprovalQueue({
  timeoutMs: 3000,
  classify: (detail, ctx) => profileForTask(detail, ctx.taskId),
  onUpsert: (view) => {
    approvalViews.push(view as unknown as Record<string, unknown>);
    if (view.status === "pending") {
      approvalRequests += 1;
      // 高风险执行命令的用例：人工（这里用脚本）放行，避免挂住。
      setTimeout(() => queue.decide(view.id, "approved"), 30);
    }
  },
});

const fakeAgent = path.resolve(import.meta.dirname, "fake-agent.ts");

const mgr = new SessionManager({
  board,
  // 本用例不经过 MCP 桥；SessionManager 只需要 envForSession。
  bridge: { envForSession: () => [] } as never,
  policy,
  workspaceRoot: dir,
  workRoot,
  onLine: () => undefined,
  onApprovalRequired: async (sessionId, taskId, detail, decision) => {
    const profile = profileForTask(detail, taskId);
    const rec = mgr.getSession(sessionId);
    if (rec) {
      const grant = permissions.match({ agentId: rec.agent, sessionId, profile });
      if (grant) {
        console.log(`[autoallow] 命中授权 ${grant.id}，跳过审批（session=${sessionId}）`);
        return true;
      }
    }
    const o = await queue.request({
      taskId,
      sessionId,
      action: "session/request_permission",
      detail,
      rule: decision.rule,
      reason: decision.reason,
    });
    return o.decision === "approved";
  },
});

function specFor(outFile: string, env: Record<string, string>) {
  return {
    command: process.execPath,
    args: [fakeAgent],
    cwd: taskWork,
    label: "fake",
    env: {
      FAKE_OUT: outFile,
      FAKE_STAY_ALIVE: "1",
      ...env,
    },
  };
}

/** 与真实写入请求同形的 detail，用于预先授权。 */
function writeDetail(file: string): Record<string, unknown> {
  return { kind: "edit", title: file, rawInput: { filepath: file, diff: "+hello" } };
}

async function main(): Promise<void> {
  console.log("========== 一键放行 · 真 ACP 接线验收 ==========\n");

  const insideFile = path.join(taskWork, "auto-allowed.txt");
  const preGrantProfile = profileForTask(writeDetail(insideFile), task.id);
  check("前置：工作目录内的写入可被记住", preGrantProfile.rememberable, JSON.stringify(preGrantProfile));
  const g = permissions.grant({
    agentId: "fake",
    sessionId: "s-pre",
    scope: "agent",
    profile: preGrantProfile,
  });
  check("前置：写入永久授权落盘", g.ok, JSON.stringify(g));

  // —— 1. 已授权的同类写入：不弹审批 ——
  const out1 = path.join(dir, "fake-out-write.json");
  const rec1 = await mgr.startSession({
    taskId: task.id,
    agent: "fake",
    role: "lead",
    tier: "guarded",
    spec: specFor(out1, { FAKE_KIND: "edit", FAKE_TITLE: insideFile }),
  });
  const answered1 = await waitFor(() => (existsSync(out1) ? JSON.parse(readFileSync(out1, "utf8")) : null), 8000);
  check("假 agent 收到了权限应答", Boolean(answered1), JSON.stringify(answered1));
  check(
    "命中已授权规则 → 直接放行（option=allow-once）",
    answered1?.result?.outcome?.outcome === "selected",
    JSON.stringify(answered1?.result),
  );
  check("已授权请求没有创建审批项（不弹窗）", approvalRequests === 0, `approvalRequests=${approvalRequests}`);
  check("会话正常起来（idle/running）", rec1.status === "idle" || rec1.status === "running", rec1.status);

  // —— 2. 同一 agent 的执行命令：高风险，仍进审批队列 ——
  const out2 = path.join(dir, "fake-out-exec.json");
  await mgr.startSession({
    taskId: task.id,
    agent: "fake",
    role: "verify",
    tier: "guarded",
    spec: specFor(out2, { FAKE_KIND: "execute", FAKE_TITLE: "run something dangerous" }),
  });
  const answered2 = await waitFor(() => (existsSync(out2) ? JSON.parse(readFileSync(out2, "utf8")) : null), 8000);
  check("执行命令没有得到「自动放行」", Boolean(answered2), JSON.stringify(answered2));
  check("执行命令进入了审批队列", approvalRequests === 1, `approvalRequests=${approvalRequests}`);
  const execView = approvalViews.find((v) => v.category === "execute");
  check(
    "审批视图标出 execute + highRisk + 不可记住（UI 会禁用两个记住按钮）",
    execView?.category === "execute" && execView?.highRisk === true && execView?.rememberable === false,
    JSON.stringify(execView),
  );
  check(
    "人工放行后假 agent 才拿到 allow（说明闸门仍生效）",
    answered2?.result?.outcome?.outcome === "selected",
    JSON.stringify(answered2?.result),
  );

  const reloaded = new PermissionStore({
    filePath: path.join(dir, "permissions.json"),
    config: DEFAULT_PERMISSION_CONFIG,
  });
  check(
    "重启后仍能命中该 agent 的写入授权",
    reloaded.match({ agentId: "fake", sessionId: "s-new", profile: preGrantProfile }) !== null,
  );
  check(
    "重启后执行命令仍不命中（高风险类别从未落盘）",
    reloaded.match({
      agentId: "fake",
      sessionId: "s-new",
      profile: profileForTask({ kind: "execute", title: "run something dangerous" }, task.id),
    }) === null,
  );
}

try {
  await main();
} catch (err) {
  check("验收过程未抛异常", false, (err as Error).stack ?? String(err));
} finally {
  try {
    await mgr.shutdown();
  } catch {
    /* 收尾失败不掩盖前面断言 */
  }
  try {
    board.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

const passed = rows.filter((r) => r.pass).length;
console.log(`\n================ ${passed}/${rows.length} 通过 ================`);
if (failures > 0) process.exitCode = 1;
