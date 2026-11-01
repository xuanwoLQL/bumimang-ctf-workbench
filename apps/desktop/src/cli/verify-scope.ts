/**
 * P4-A 目标 CRUD 验收（A 组：目标数据模型 + Hub 契约 + 快照）。
 *
 * 范围（严格）：
 *  - `target.add` / `target.update` / `target.remove` 走 Hub；
 *  - 快照只有**焦点任务**带 `targets`，并带 `denyTargets` / `scopeNotes`；
 *  - 非法 taskId / targetId / value / kind / notes 被拒且有可读错误；
 *  - 归档任务不能加目标；
 *  - 跨任务隔离：A 的 target 不出现在 B，同值可在不同任务各自存在。
 *
 * 明确不测：策略判定（P4-C）、CIDR/IP 解析与匹配（P4-B）、代理（P4-D）。
 * 用法：npm run verify:scope
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { ApprovalQueue } from "../main/approval/queue.ts";
import { validateHubAction } from "../main/electron/validate-action.ts";
import { parseTarget } from "../main/scope/parse.ts";
import { cidrContains, matchTargets } from "../main/scope/match.ts";
import { extractTargets } from "../main/scope/extract.ts";
import { PolicyEngine, loadPack } from "../main/policy/engine.ts";
import { loadAppConfig, type ScopeConfig } from "../main/config/loader.ts";
import { proxyEnvForSession } from "../main/session/manager.ts";
import { ScopeProxyService, type ProxyAuditEntry } from "../main/scope/proxy.ts";
import { ProcessRegistry } from "../main/reliability/process-registry.ts";
import { buildScopeStatusView } from "../renderer/store.ts";
import type { SessionManager } from "../main/session/manager.ts";
import type {
  ApprovalView,
  HubAction,
  HubEvent,
  TargetView,
  TaskView,
} from "../../../../packages/shared-protocol/events.ts";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
/** 仓库根：verify-gate 子进程、规则包与 config/app.json 都从这里解析。 */
const REPO = resolve(import.meta.dirname, "../../../..");

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function expectThrow(name: string, fn: () => unknown, includes?: string): void {
  try {
    fn();
    check(name, false, "没有抛错");
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    check(name, includes ? msg.includes(includes) : true, msg);
  }
}

/** 这些断言只读 Hub/DB；会话管理器永远返回空列表即可（本组不起任何进程）。 */
const emptySessions = {
  listSessions: () => [],
  getSession: () => undefined,
  syncLag: () => 0,
  historyOf: () => [],
} as unknown as SessionManager;

interface Harness {
  dir: string;
  board: Blackboard;
  hub: HubService;
  events: HubEvent[];
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bumimang-scope-"));
  const board = Blackboard.open(join(dir, "board.db"));
  const bus = new EventBus();
  const events: HubEvent[] = [];
  bus.on((e) => events.push(e));
  const hub = new HubService({
    board,
    sessions: emptySessions,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    maxSessionsPerTask: 3,
    maxSessionsTotal: 8,
  });
  return {
    dir,
    board,
    hub,
    events,
    cleanup: () => {
      board.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function validationContext(h: Harness): {
  task: (taskId: string) => { archived: boolean } | undefined;
  target: (taskId: string, targetId: string) => unknown;
} {
  return {
    task: (taskId) => {
      const row = h.board.getTask(taskId);
      return row ? { archived: Boolean(row.archived) } : undefined;
    },
    target: (taskId, targetId) => h.board.getTarget?.(taskId, targetId),
  };
}

async function createTask(h: Harness, title: string): Promise<string> {
  const res = await h.hub.dispatch({ type: "task.create", title, brief: `${title} brief` });
  check(`创建任务「${title}」`, res.ok, JSON.stringify(res));
  const id = h.hub.currentTaskId;
  check(`任务「${title}」成为焦点`, Boolean(id), String(id));
  return id!;
}

async function addTarget(
  h: Harness,
  action: Extract<HubAction, { type: "target.add" }>,
  label: string,
): Promise<void> {
  const res = await h.hub.dispatch(action);
  check(label, res.ok, JSON.stringify(res));
}

function targetValues(list: TargetView[] | undefined): string[] {
  return (list ?? []).map((t) => t.value).sort();
}

function tv(value: string, kind: TargetView["kind"] = "host", id = `t-${value}`): TargetView {
  return { id, taskId: "task-fixture", value, kind, status: "unknown", notes: null, createdAt: 0 };
}

function extractedValues(res: ReturnType<typeof extractTargets>): string[] {
  return res.candidates.map((c) => c.value);
}

/**
 * P4-B：纯函数层。
 *
 * 只测 parse / match / extract；不读 DB、不调 Hub、不测策略判定。
 * 失败信息里带 actual/expected，便于定位边界。
 */
function partB(): void {
  console.log("\n================ P4-B B 组：解析 / 匹配 / 提取 ================\n");

  // ---------- B1：parseTarget ----------
  console.log("---------- B1 parseTarget ----------");
  const parsed = (v: string) => parseTarget(v);
  eq("B1 IPv4 → host", parsed("10.1.2.3").kind, "host");
  eq("B1 IPv4 规范化", parsed("10.1.2.3").normalized, "10.1.2.3");
  eq("B1 IPv4:port → host", parsed("10.1.2.3:8080").kind, "host");
  eq("B1 IPv4:port 规范化", parsed("10.1.2.3:8080").normalized, "10.1.2.3:8080");
  eq("B1 CIDR → cidr", parsed("10.0.0.0/8").kind, "cidr");
  eq("B1 CIDR 规范化", parsed("10.0.0.0/8").normalized, "10.0.0.0/8");
  eq("B1 CIDR 主机位被掩掉", parsed("10.1.2.3/8").normalized, "10.0.0.0/8");
  eq("B1 URL → url", parsed("http://10.1.2.3:8080/admin").kind, "url");
  eq("B1 URL 提取 host:port", parsed("http://10.1.2.3:8080/admin").normalized, "10.1.2.3:8080");
  eq("B1 URL 提取 host", parsed("https://example.com/x").normalized, "example.com");
  eq("B1 URL 显式端口保留", parsed("http://example.com:443/path").normalized, "example.com:443");
  eq("B1 localhost:port → host", parsed("localhost:8080").kind, "host");
  eq("B1 裸域名 → host", parsed("example.com").kind, "host");
  eq("B1 域名小写规范化", parsed("EXAMPLE.COM").normalized, "example.com");
  eq("B1 IPv6 → unknown", parsed("::1").kind, "unknown");
  eq("B1 IPv6 reason", parsed("::1").reason, "ipv6-not-supported");
  eq("B1 方括号 IPv6:port → unknown", parsed("[::1]:80").reason, "ipv6-not-supported");
  eq("B1 空串 → unknown", parsed("").kind, "unknown");
  eq("B1 空串 reason", parsed("").reason, "empty");
  eq("B1 含空格 → unknown", parsed("10.0.0.1 ").kind, "unknown");
  eq("B1 含空格 reason", parsed("10.0.0.1 ").reason, "whitespace");
  eq("B1 非法 IPv4 → unknown", parsed("10.0.0.256").reason, "invalid-ipv4");
  eq("B1 非法 CIDR prefix → unknown", parsed("10.0.0.0/33").reason, "invalid-cidr");
  eq("B1 版本号样 → unknown", parsed("1.2.3").kind, "unknown");
  eq("B1 非法端口 → unknown", parsed("10.0.0.1:99999").reason, "invalid-port");
  eq("B1 端口 0 → unknown", parsed("10.0.0.1:0").reason, "invalid-port");
  eq("B1 NUL → unknown", parsed("10.0.0.1\0").reason, "nul");
  eq("B1 非 ASCII → unknown", parsed("例子.com").reason, "non-ascii");
  eq("B1 空 URL → unknown", parsed("http://").kind, "unknown");
  eq("B1 超长 → unknown", parsed("a".repeat(300)).kind, "unknown");
  eq("B1 带路径 URL 仍能解析", parsed("http://10.0.0.1/a/b?x=1").normalized, "10.0.0.1");

  // ---------- B2：cidrContains ----------
  console.log("\n---------- B2 cidrContains ----------");
  check("B2 /8 包含网络地址", cidrContains("10.0.0.0/8", "10.0.0.0"));
  check("B2 /8 包含边界 10.255.255.255", cidrContains("10.0.0.0/8", "10.255.255.255"));
  check("B2 /8 包含 10.1.2.3", cidrContains("10.0.0.0/8", "10.1.2.3"));
  check("B2 /8 不包含 11.0.0.0", !cidrContains("10.0.0.0/8", "11.0.0.0"));
  check("B2 /8 不包含 9.255.255.255", !cidrContains("10.0.0.0/8", "9.255.255.255"));
  check("B2 /32 只包含自身", cidrContains("10.0.0.0/32", "10.0.0.0") && !cidrContains("10.0.0.0/32", "10.0.0.1"));
  check("B2 /0 包含边界", cidrContains("0.0.0.0/0", "0.0.0.0") && cidrContains("0.0.0.0/0", "255.255.255.255"));
  check("B2 带主机位的 CIDR 按掩码判断", cidrContains("10.1.2.3/8", "10.200.0.1"));
  check("B2 非法 prefix 返回 false", !cidrContains("10.0.0.0/33", "10.0.0.1"));
  check("B2 缺 prefix 返回 false", !cidrContains("10.0.0.0", "10.0.0.1"));
  check("B2 IPv6 CIDR 返回 false", !cidrContains("::/0", "::1"));
  check("B2 非法 IP 返回 false", !cidrContains("10.0.0.0/8", "999.1.1.1"));

  // ---------- B3：matchTargets ----------
  console.log("\n---------- B3 matchTargets ----------");
  const m = (targets: TargetView[], value: string, kind: TargetView["kind"] = "host", deny: string[] = []) =>
    matchTargets(targets, { kind, value }, deny);

  eq("B3 CIDR 内 → in", m([tv("10.0.0.0/8", "cidr")], "10.1.2.3").verdict, "in");
  eq("B3 CIDR 命中值", m([tv("10.0.0.0/8", "cidr")], "10.1.2.3").matchedBy, "10.0.0.0/8");
  eq("B3 CIDR 外 → out", m([tv("10.0.0.0/8", "cidr")], "8.8.8.8").verdict, "out");
  eq("B3 非法候选 → unknown", m([tv("10.0.0.0/8", "cidr")], "999.1.1.1").verdict, "unknown");
  eq("B3 deny 精确优先 → out", m([tv("8.0.0.0/8", "cidr")], "8.8.8.8", "host", ["8.8.8.8"]).verdict, "out");
  eq("B3 deny CIDR 优先 → out", m([tv("10.1.2.3")], "10.1.2.3", "host", ["10.0.0.0/8"]).verdict, "out");
  eq("B3 deny 命中 reason", m([tv("8.0.0.0/8", "cidr")], "8.8.8.8", "host", ["8.8.8.8"]).reason, "denied-by-deny-target");
  eq("B3 空 targets → out", m([], "10.1.2.3").verdict, "out");
  eq("B3 非法 targets → unknown", m([tv("not-a-target", "host")], "10.1.2.3").verdict, "unknown");
  eq("B3 host:port 精确匹配 → in", m([tv("10.1.2.3:8080")], "10.1.2.3:8080").verdict, "in");
  eq("B3 host:port 不同端口 → out", m([tv("10.1.2.3:8080")], "10.1.2.3:80").verdict, "out");
  eq("B3 host:port target 对裸 host → out", m([tv("10.1.2.3:8080")], "10.1.2.3").verdict, "out");
  eq("B3 无端口 host 接受任意端口 → in", m([tv("10.1.2.3")], "10.1.2.3:80").verdict, "in");
  eq("B3 CIDR 忽略端口 → in", m([tv("10.0.0.0/8", "cidr")], "10.1.2.3:8080").verdict, "in");
  eq("B3 URL host 匹配 → in", m([tv("https://example.com", "url")], "example.com", "url").verdict, "in");
  eq("B3 URL 端口匹配 → in", m([tv("http://example.com:8080", "url")], "example.com:8080", "url").verdict, "in");
  eq("B3 URL 端口不同 → out", m([tv("http://example.com:8080", "url")], "example.com:80", "url").verdict, "out");
  eq("B3 域名 vs CIDR → unknown", m([tv("10.0.0.0/8", "cidr")], "example.com").verdict, "unknown");
  eq("B3 域名大小写不敏感", m([tv("example.com")], "EXAMPLE.COM").verdict, "in");
  eq("B3 未知候选 kind → unknown", m([tv("10.0.0.0/8", "cidr")], "10.1.2.3", "unknown").verdict, "unknown");
  eq("B3 候选 IPv6 → unknown", m([tv("10.0.0.0/8", "cidr")], "::1").verdict, "unknown");

  // ---------- B4：extractTargets ----------
  console.log("\n---------- B4 extractTargets ----------");
  eq("B4 curl URL 提取 IP", extractedValues(extractTargets("curl http://10.1.2.3/x")).join(","), "10.1.2.3");
  eq("B4 curl URL 提取 8.8.8.8", extractedValues(extractTargets("curl http://8.8.8.8")).join(","), "8.8.8.8");
  eq("B4 文件路径不提取", extractedValues(extractTargets("ls ./a/b")).length, 0);
  eq("B4 版本号不提取", extractedValues(extractTargets("gcc -v 1.2.3")).length, 0);
  eq("B4 nmap CIDR 提取", extractedValues(extractTargets("nmap 10.0.0.0/8")).join(","), "10.0.0.0/8");
  eq("B4 CIDR 不重复提取内部 IP", extractTargets("nmap 10.0.0.0/8").candidates.length, 1);
  eq("B4 /etc/passwd 不提取", extractedValues(extractTargets("cat /etc/passwd")).length, 0);
  eq("B4 echo 版本号不提取", extractedValues(extractTargets('echo "1.2.3"')).length, 0);
  eq("B4 python 参数 IP 提取", extractedValues(extractTargets("python3 script.py 10.0.0.1")).join(","), "10.0.0.1");
  eq("B4 host:port 提取", extractedValues(extractTargets("curl 10.1.2.3:8080/admin")).join(","), "10.1.2.3:8080");
  eq("B4 localhost:port 提取", extractedValues(extractTargets("ping localhost:8080")).join(","), "localhost:8080");
  const badCidr = extractTargets("nmap 10.0.0.0/33");
  eq("B4 非法 CIDR 不产生候选", badCidr.candidates.length, 0);
  check("B4 非法 CIDR 进 unknowns", badCidr.unknowns.includes("10.0.0.0/33"), JSON.stringify(badCidr.unknowns));
  const ipv6 = extractTargets("curl http://[::1]/");
  eq("B4 IPv6 URL 不产生候选", ipv6.candidates.length, 0);
  check("B4 IPv6 URL 进 unknowns", ipv6.unknowns.length > 0, JSON.stringify(ipv6.unknowns));
  eq("B4 URL 裸域名提取", extractedValues(extractTargets("curl http://example.com/x")).join(","), "example.com");
  eq("B4 裸域名默认不提取", extractedValues(extractTargets("echo example.com")).length, 0);
  eq(
    "B4 白名单裸域名提取",
    extractedValues(extractTargets("echo example.com", { bareDomainAllowlist: ["example.com"] })).join(","),
    "example.com",
  );
  eq(
    "B4 白名单 TLD 提取",
    extractedValues(extractTargets("echo example.org", { bareDomainAllowlist: ["org"] })).join(","),
    "example.org",
  );
  eq("B4 引号内 URL 提取", extractedValues(extractTargets('curl "http://10.1.2.3/x"')).join(","), "10.1.2.3");
  eq("B4 参数中的裸 IP 提取", extractedValues(extractTargets("ssh 10.0.0.1 22")).join(","), "10.0.0.1");
  eq("B4 五段数字不提取", extractedValues(extractTargets("foo 1.2.3.4.5")).length, 0);
  eq("B4 Windows 路径不提取", extractedValues(extractTargets("type C:\\Windows\\win.ini")).length, 0);
  eq("B4 Windows 路径中的 IP 不提取", extractedValues(extractTargets("type C:\\Windows\\10.0.0.1")).length, 0);
  eq("B4 Windows 路径中的 host:port 不提取", extractedValues(extractTargets("type C:\\Windows\\10.0.0.1:8080")).length, 0);
  eq("B4 IPv6 内嵌 IPv4 不提取", extractedValues(extractTargets("nmap ::ffff:10.0.0.1")).length, 0);
  eq("B4 重复目标去重", extractTargets("curl http://10.1.2.3/a http://10.1.2.3/b").candidates.length, 1);
  eq(
    "B4 CIDR + 单 IP 都提取",
    extractedValues(extractTargets("nmap 10.0.0.0/8 10.1.2.3")).join(","),
    "10.0.0.0/8,10.1.2.3",
  );
  const withSpan = extractTargets("curl http://10.1.2.3/x");
  check(
    "B4 span 指向原文 URL",
    withSpan.candidates[0]?.span[0] === 5 &&
      withSpan.candidates[0]?.span[1] === 22 && // [start, end)；URL 共 17 字符，5 + 17 = 22
      "curl http://10.1.2.3/x".slice(...withSpan.candidates[0].span).includes("10.1.2.3"),
    JSON.stringify(withSpan.candidates[0]),
  );
  const badPortUrl = extractTargets("curl http://10.1.2.3:99999/x");
  eq("B4 非法端口 URL 不产生候选", badPortUrl.candidates.length, 0);
  check("B4 非法端口 URL 进 unknowns", badPortUrl.unknowns.length > 0, JSON.stringify(badPortUrl.unknowns));
  eq("B4 主机位 CIDR 规范化", extractedValues(extractTargets("nmap 10.1.2.3/8")).join(","), "10.0.0.0/8");
}

/**
 * P4-C：策略判定与范围上下文。
 *
 * 这一组故意先写成“红测”：在 engine/acp/config/rules 尚未实现 scope 能力时，
 * 只有 C0（旧 52 条）和 C3（enabled=false 旧行为）应当是绿的，其余新断言应当红。
 * 这样能证明我们不是先改实现再补测试。
 */
function scopeCfg(enabled: boolean, outOfScopeAction: "block" | "approve" = "approve"): ScopeConfig {
  return { enabled, outOfScopeAction, proxy: { enabled: false } };
}

function evalScope(
  engine: PolicyEngine,
  input: {
    action: string;
    sessionId: string;
    tier?: "autonomous" | "guarded";
    detail: Record<string, unknown>;
    target?: { kind: "host" | "cidr" | "url" | "unknown"; value: string };
    inScope?: "in" | "out" | "unknown";
    allowedActions?: string[];
    taskId?: string;
  },
) {
  return engine.evaluate({
    action: input.action,
    sessionId: input.sessionId,
    tier: input.tier,
    taskId: input.taskId,
    detail: input.detail,
    ...(input.inScope
      ? {
          scope: {
            target: input.target,
            inScope: input.inScope,
            allowedActions: input.allowedActions,
          },
        }
      : {}),
  });
}

async function partC(): Promise<void> {
  console.log("\n================ P4-C C 组：策略判定 / 作用域 / 审计 ================\n");

  // ---------- C0：锁旧 52 条（不改 verify-gate，直接用子进程跑它） ----------
  console.log("---------- C0 旧策略断言锁定 ----------");
  const gate = spawnSync(process.execPath, [join(REPO, "apps/desktop/src/cli/verify-gate.ts")], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60000,
  });
  const gateOut = `${gate.stdout ?? ""}\n${gate.stderr ?? ""}`;
  check(
    "C0 verify-gate 旧 52 条仍全绿（子进程，零改动）",
    gate.status === 0 && gateOut.includes("52/52"),
    `exit=${String(gate.status)} has52=${gateOut.includes("52/52")}`,
  );

  // ---------- C1：config scope 默认值 ----------
  console.log("\n---------- C1 config scope ----------");
  const emptyRepo = mkdtempSync(join(tmpdir(), "bumimang-scope-cfg-"));
  const badRepo = mkdtempSync(join(tmpdir(), "bumimang-scope-badcfg-"));
  try {
    const defaults = loadAppConfig({ repoRoot: emptyRepo, isPackaged: false, resourcesPath: "", env: {} });
    eq("C1 缺省 scope.enabled=false（默认关闭）", defaults.config.scope?.enabled, false);
    eq("C1 缺省 outOfScopeAction=approve（误报不默认 block）", defaults.config.scope?.outOfScopeAction, "approve");
    eq("C1 缺省 proxy.enabled=false（P4-D 占位）", defaults.config.scope?.proxy?.enabled, false);

    const repoCfg = loadAppConfig({ repoRoot: REPO, isPackaged: false, resourcesPath: "", env: {} });
    eq("C1 仓库 config/app.json scope.enabled=false", repoCfg.config.scope?.enabled, false);
    eq("C1 仓库 config/app.json outOfScopeAction=approve", repoCfg.config.scope?.outOfScopeAction, "approve");
    eq("C1 仓库 config/app.json proxy.enabled=false", repoCfg.config.scope?.proxy?.enabled, false);

    mkdirSync(join(badRepo, "config"), { recursive: true });
    writeFileSync(
      join(badRepo, "config", "app.json"),
      JSON.stringify({
        scope: { enabled: true, outOfScopeAction: "bogus", proxy: { enabled: true } },
      }),
      "utf8",
    );
    const bad = loadAppConfig({ repoRoot: badRepo, isPackaged: false, resourcesPath: "", env: {} });
    eq("C1 非法 outOfScopeAction 回落到 approve", bad.config.scope?.outOfScopeAction, "approve");
    eq("C1 显式 scope.enabled=true 被读取", bad.config.scope?.enabled, true);
    eq("C1 proxy.enabled 占位被读取（仍不启动代理）", bad.config.scope?.proxy?.enabled, true);

    writeFileSync(
      join(badRepo, "config", "app.json"),
      JSON.stringify({ scope: { enabled: "true", outOfScopeAction: "block" } }),
      "utf8",
    );
    const stringEnabled = loadAppConfig({ repoRoot: badRepo, isPackaged: false, resourcesPath: "", env: {} });
    eq("C1 scope.enabled 只认布尔 true（字符串不开启）", stringEnabled.config.scope?.enabled, false);
    eq("C1 outOfScopeAction=block 被读取", stringEnabled.config.scope?.outOfScopeAction, "block");
  } finally {
    rmSync(emptyRepo, { recursive: true, force: true });
    rmSync(badRepo, { recursive: true, force: true });
  }

  // ---------- C2：规则包只加 no-out-of-scope，六条旧规则不改 ----------
  console.log("\n---------- C2 规则包 ----------");
  const pack = loadPack(REPO, "competition");
  check("C2 competition 包可加载", Boolean(pack), `rules=${pack?.rules.length ?? 0}`);
  eq("C2 规则数=7（六条旧 + no-out-of-scope）", pack?.rules.length, 7);
  const oldIds = [
    "blackboard-tools-are-internal",
    "no-c2-tools",
    "no-c2-tools-via-permission",
    "credential-actions-need-human",
    "write-outside-workspace-needs-human",
    "external-network-needs-human",
  ];
  const allIds = new Set((pack?.rules ?? []).map((r) => r.id));
  check(
    "C2 六条旧规则 id 全在",
    oldIds.every((id) => allIds.has(id)),
    oldIds.filter((id) => !allIds.has(id)).join(",") || "ok",
  );
  const scopeRule = pack?.rules.find((r) => r.id === "no-out-of-scope");
  eq("C2 no-out-of-scope 使用 out_of_scope 匹配", scopeRule?.match.out_of_scope, true);
  check(
    "C2 六条旧规则没有加 scope 字段",
    (pack?.rules ?? [])
      .filter((r) => oldIds.includes(r.id))
      .every((r) => r.match.out_of_scope !== true && r.match.target_regex === undefined),
  );

  // ---------- C3：enabled=false 必须逐字走旧逻辑 ----------
  console.log("\n---------- C3 enabled=false 旧行为 ----------");
  const disabledBlock = new PolicyEngine({
    repoRoot: REPO,
    packId: "competition",
    scope: scopeCfg(false, "block"),
  });
  const disabledOut = evalScope(disabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c3",
    tier: "autonomous",
    detail: { title: "curl http://8.8.8.8/x" },
    target: { kind: "host", value: "8.8.8.8" },
    inScope: "out",
  });
  eq("C3 enabled=false：范围外 curl 仍按旧规则 approve（不 block）", disabledOut.verdict, "approve");
  eq("C3 enabled=false：规则仍是旧 external-network", disabledOut.rule, "external-network-needs-human");

  const disabledRead = evalScope(disabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c3",
    tier: "autonomous",
    detail: { title: "read README.md" },
    target: { kind: "host", value: "8.8.8.8" },
    inScope: "out",
  });
  eq("C3 enabled=false：无规则动作仍 allow", disabledRead.verdict, "allow");
  eq("C3 enabled=false：仍是自主档兜底", disabledRead.rule, "tier-autonomous-default");

  // ---------- C4/C5：enabled=true + out ----------
  console.log("\n---------- C4/C5 enabled=true + out ----------");
  const enabledBlock = new PolicyEngine({
    repoRoot: REPO,
    packId: "competition",
    scope: scopeCfg(true, "block"),
  });
  const outBlock = evalScope(enabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c4",
    tier: "autonomous",
    detail: { title: "curl http://8.8.8.8/x" },
    target: { kind: "host", value: "8.8.8.8" },
    inScope: "out",
  });
  eq("C4 enabled=true + out + block → block", outBlock.verdict, "block");
  eq("C4 命中 no-out-of-scope", outBlock.rule, "no-out-of-scope");

  const enabledApprove = new PolicyEngine({
    repoRoot: REPO,
    packId: "competition",
    scope: scopeCfg(true, "approve"),
  });
  const outApprove = evalScope(enabledApprove, {
    action: "session/request_permission",
    sessionId: "s-c5",
    tier: "autonomous",
    detail: { title: "curl http://8.8.8.8/x" },
    target: { kind: "host", value: "8.8.8.8" },
    inScope: "out",
  });
  eq("C5 enabled=true + out + approve → approve", outApprove.verdict, "approve");
  eq("C5 命中 no-out-of-scope", outApprove.rule, "no-out-of-scope");

  // ---------- C6：enabled=true + in 必须回到旧规则 ----------
  console.log("\n---------- C6 enabled=true + in ----------");
  const inCurl = evalScope(enabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c6",
    tier: "autonomous",
    detail: { title: "curl http://10.1.2.3/x" },
    target: { kind: "host", value: "10.1.2.3" },
    inScope: "in",
  });
  eq("C6 in：旧网络规则仍 approve", inCurl.verdict, "approve");
  eq("C6 in：规则不是 no-out-of-scope", inCurl.rule, "external-network-needs-human");

  const inRead = evalScope(enabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c6",
    tier: "autonomous",
    detail: { title: "read README.md" },
    target: { kind: "host", value: "10.1.2.3" },
    inScope: "in",
  });
  eq("C6 in + 自主档无规则 → allow", inRead.verdict, "allow");
  eq("C6 in + 自主档 → tier-autonomous-default", inRead.rule, "tier-autonomous-default");

  const inCred = evalScope(enabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c6",
    tier: "guarded",
    detail: { title: "run mimikatz sekurlsa::logonpasswords" },
    target: { kind: "host", value: "10.1.2.3" },
    inScope: "in",
  });
  eq("C6 in + 凭据 → approve（旧规则仍生效）", inCred.verdict, "approve");

  const inC2 = evalScope(enabledBlock, {
    action: "terminal/exec",
    sessionId: "s-c6",
    detail: { command: "cobaltstrike-client.exe --connect 1.2.3.4" },
    target: { kind: "host", value: "10.1.2.3" },
    inScope: "in",
  });
  eq("C6 in + C2 → block（旧硬阻断不被 scope 覆盖）", inC2.verdict, "block");

  // ---------- C7：unknown 按 outOfScopeAction 兜底 ----------
  console.log("\n---------- C7 enabled=true + unknown ----------");
  const unknownApprove = evalScope(enabledApprove, {
    action: "session/request_permission",
    sessionId: "s-c7",
    tier: "autonomous",
    detail: { title: "curl http://[::1]/" },
    target: { kind: "unknown", value: "http://[::1]/" },
    inScope: "unknown",
  });
  eq("C7 unknown + approve → approve", unknownApprove.verdict, "approve");
  eq("C7 unknown + approve 命中 no-out-of-scope", unknownApprove.rule, "no-out-of-scope");

  const unknownBlock = evalScope(enabledBlock, {
    action: "session/request_permission",
    sessionId: "s-c7",
    tier: "autonomous",
    detail: { title: "curl http://[::1]/" },
    target: { kind: "unknown", value: "http://[::1]/" },
    inScope: "unknown",
  });
  eq("C7 unknown + block → block", unknownBlock.verdict, "block");
  eq("C7 unknown + block 命中 no-out-of-scope", unknownBlock.rule, "no-out-of-scope");

  // ---------- C8：target_regex ----------
  console.log("\n---------- C8 target_regex ----------");
  const regexEngine = new PolicyEngine({
    repoRoot: REPO,
    packId: "competition",
    scope: scopeCfg(true, "approve"),
  });
  regexEngine.addSessionRule("s-c8", {
    id: "target-10",
    match: { action: "session/request_permission", target_regex: "^10\\." },
    verdict: "approve",
    reason: "C8：10/8 目标需人工",
  });
  const regexHit = evalScope(regexEngine, {
    action: "session/request_permission",
    sessionId: "s-c8",
    tier: "autonomous",
    detail: { title: "read README.md" },
    target: { kind: "host", value: "10.1.2.3" },
    inScope: "in",
  });
  eq("C8 target_regex 命中范围目标", regexHit.rule, "target-10");
  eq("C8 target_regex verdict=approve", regexHit.verdict, "approve");

  const regexNoTarget = evalScope(regexEngine, {
    action: "session/request_permission",
    sessionId: "s-c8",
    tier: "autonomous",
    detail: { title: "read README.md" },
  });
  eq("C8 无 target 时 target_regex 不命中", regexNoTarget.rule, "tier-autonomous-default");

  const disabledRegex = new PolicyEngine({
    repoRoot: REPO,
    packId: "competition",
    scope: scopeCfg(false, "approve"),
  });
  disabledRegex.addSessionRule("s-c8", {
    id: "target-10",
    match: { action: "session/request_permission", target_regex: "^10\\." },
    verdict: "approve",
    reason: "C8：10/8 目标需人工",
  });
  const disabledRegexHit = evalScope(disabledRegex, {
    action: "session/request_permission",
    sessionId: "s-c8",
    tier: "autonomous",
    detail: { title: "read README.md" },
    target: { kind: "host", value: "10.1.2.3" },
    inScope: "in",
  });
  eq("C8 enabled=false 时 target_regex 不生效", disabledRegexHit.rule, "tier-autonomous-default");

  // ---------- C9：ACP 目标提取（纯函数入口） ----------
  console.log("\n---------- C9 ACP 目标提取 ----------");
  let deriveScopeContext: ((input: Record<string, unknown>) => unknown) | undefined;
  try {
    const mod = (await import("../main/acp/client.ts")) as Record<string, unknown>;
    deriveScopeContext = mod.deriveScopeContext as typeof deriveScopeContext;
  } catch (err) {
    check("C9 动态加载 acp/client 失败", false, (err as Error).message);
  }
  check("C9 acp/client 导出 deriveScopeContext", typeof deriveScopeContext === "function");
  if (typeof deriveScopeContext === "function") {
    const targets = [tv("10.0.0.0/8", "cidr")];
    const disabledCtx = deriveScopeContext({
      action: "session/request_permission",
      detail: { title: "curl http://8.8.8.8/x" },
      enabled: false,
      targets,
      denyTargets: [],
    }) as { inScope?: string; target?: { kind: string; value: string } } | undefined;
    eq("C9 enabled=false 不提取目标", disabledCtx, undefined);

    const outCtx = deriveScopeContext({
      action: "session/request_permission",
      detail: { title: "curl http://8.8.8.8/x" },
      enabled: true,
      targets,
      denyTargets: [],
    }) as { inScope?: string; target?: { kind: string; value: string } } | undefined;
    eq("C9 范围外候选 → inScope=out", outCtx?.inScope, "out");
    eq("C9 记录范围外目标", outCtx?.target?.value, "8.8.8.8");
    eq("C9 URL 候选 kind=url（P4-B 保留来源形态）", outCtx?.target?.kind, "url");

    const inCtx = deriveScopeContext({
      action: "session/request_permission",
      detail: { title: "curl http://10.1.2.3/x" },
      enabled: true,
      targets,
      denyTargets: [],
    }) as { inScope?: string } | undefined;
    eq("C9 范围内候选 → inScope=in", inCtx?.inScope, "in");

    const multiCtx = deriveScopeContext({
      action: "session/request_permission",
      detail: { title: "curl http://10.1.2.3/x http://8.8.8.8/y" },
      enabled: true,
      targets,
      denyTargets: [],
    }) as { inScope?: string } | undefined;
    eq("C9 多个目标取最严格 → out", multiCtx?.inScope, "out");

    const termCtx = deriveScopeContext({
      action: "terminal/exec",
      detail: { command: "nmap", args: ["-p80", "10.1.2.3"] },
      enabled: true,
      targets,
      denyTargets: [],
    }) as { inScope?: string } | undefined;
    eq("C9 terminal/exec 命令+参数提取 → in", termCtx?.inScope, "in");

    const unknownCtx = deriveScopeContext({
      action: "session/request_permission",
      detail: { title: "curl http://[::1]/" },
      enabled: true,
      targets,
      denyTargets: [],
    }) as { inScope?: string } | undefined;
    eq("C9 无法解析的目标 → inScope=unknown", unknownCtx?.inScope, "unknown");

    const denyCtx = deriveScopeContext({
      action: "session/request_permission",
      detail: { title: "curl http://10.1.2.3/x" },
      enabled: true,
      targets,
      denyTargets: ["10.1.2.3"],
    }) as { inScope?: string } | undefined;
    eq("C9 denyTargets 优先 → out", denyCtx?.inScope, "out");
  }

  // ---------- C10：每次判定写 events（target/rule/verdict） ----------
  console.log("\n---------- C10 策略判定审计 ----------");
  let writePolicyAudit:
    | ((board: Blackboard, taskId: string, record: Record<string, unknown>) => void)
    | undefined;
  try {
    const mod = (await import("../main/session/manager.ts")) as Record<string, unknown>;
    writePolicyAudit = mod.writePolicyAudit as typeof writePolicyAudit;
  } catch (err) {
    check("C10 动态加载 manager 失败", false, (err as Error).message);
  }
  check("C10 manager 导出 writePolicyAudit", typeof writePolicyAudit === "function");
  if (typeof writePolicyAudit === "function") {
    const dir = mkdtempSync(join(tmpdir(), "bumimang-scope-audit-"));
    const board = Blackboard.open(join(dir, "board.db"));
    try {
      const task = board.createTask({ title: "C10 审计", brief: "" });
      const records: Array<Record<string, unknown>> = [];
      const auditEnabled = new PolicyEngine({
        repoRoot: REPO,
        packId: "competition",
        scope: scopeCfg(true, "block"),
        onDecision: (record: Record<string, unknown>) => {
          records.push(record);
          writePolicyAudit!(board, task.id, record);
        },
      });
      evalScope(auditEnabled, {
        action: "session/request_permission",
        taskId: task.id,
        sessionId: "s-c10",
        tier: "autonomous",
        detail: { title: "read README.md" },
      });
      evalScope(auditEnabled, {
        action: "session/request_permission",
        taskId: task.id,
        sessionId: "s-c10",
        tier: "guarded",
        detail: { title: "run mimikatz sekurlsa::logonpasswords" },
      });
      evalScope(auditEnabled, {
        action: "terminal/exec",
        taskId: task.id,
        sessionId: "s-c10",
        detail: { command: "cobaltstrike-client.exe" },
      });
      evalScope(auditEnabled, {
        action: "session/request_permission",
        taskId: task.id,
        sessionId: "s-c10",
        tier: "autonomous",
        detail: { title: "curl http://8.8.8.8/x" },
        target: { kind: "host", value: "8.8.8.8" },
        inScope: "out",
      });

      const auditDisabled = new PolicyEngine({
        repoRoot: REPO,
        packId: "competition",
        scope: scopeCfg(false, "block"),
        onDecision: (record: Record<string, unknown>) => {
          records.push(record);
          writePolicyAudit!(board, task.id, record);
        },
      });
      evalScope(auditDisabled, {
        action: "session/request_permission",
        taskId: task.id,
        sessionId: "s-c10",
        tier: "autonomous",
        detail: { title: "curl http://8.8.8.8/x" },
        target: { kind: "host", value: "8.8.8.8" },
        inScope: "out",
      });

      eq("C10 每次判定都触发 onDecision", records.length, 5);
      const rows = board.raw(
        "SELECT body FROM events WHERE subject = ? AND body LIKE '%policy.decision%' ORDER BY id ASC",
        task.id,
      ) as Array<{ body: string }>;
      eq("C10 每次判定写一条 events", rows.length, 5);
      const payloads = rows.map((r) => {
        const body = JSON.parse(r.body) as { text?: string };
        const text = String(body.text ?? "");
        const prefix = "policy.decision ";
        return JSON.parse(text.startsWith(prefix) ? text.slice(prefix.length) : "{}") as Record<
          string,
          unknown
        >;
      });
      check(
        "C10 events 含 action/rule/verdict/target/inScope",
        payloads.every(
          (p) =>
            typeof p.action === "string" &&
            typeof p.rule === "string" &&
            typeof p.verdict === "string" &&
            "target" in p &&
            "inScope" in p,
        ),
        JSON.stringify(payloads[0]),
      );
      eq("C10 无目标判定 target 为空", payloads[0]?.target, null);
      eq("C10 无目标判定 inScope 为空", payloads[0]?.inScope, null);
      const outPayload = payloads[3] as {
        target?: { kind?: string; value?: string };
        verdict?: string;
        rule?: string;
      };
      eq("C10 范围外判定记录 target.value", outPayload?.target?.value, "8.8.8.8");
      eq("C10 范围外判定记录 target.kind", outPayload?.target?.kind, "host");
      eq("C10 范围外判定记录 verdict", outPayload?.verdict, "block");
      eq("C10 范围外判定记录 rule", outPayload?.rule, "no-out-of-scope");
      const disabledPayload = payloads[4] as {
        target?: unknown;
        verdict?: string;
        rule?: string;
        scopeEnabled?: boolean;
      };
      eq("C10 enabled=false 时 target 字段为空", disabledPayload?.target, null);
      eq("C10 enabled=false 时 verdict 走旧逻辑", disabledPayload?.verdict, "approve");
      eq("C10 enabled=false 时 rule 仍是旧 external-network", disabledPayload?.rule, "external-network-needs-human");
      eq("C10 enabled=false 审计记录 scopeEnabled=false", disabledPayload?.scopeEnabled, false);
    } finally {
      board.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * P4-D 之前的批次 2 验收：
 *  - ApprovalView.scopeTarget/ruleId 的队列填充与 Hub 兜底；
 *  - 审批卡目标来源 helper（main 在 no-out-of-scope 命中时使用）；
 *  - 误报降级：真实改 config 文件 → loadAppConfig 重读 → 新 engine 判定。
 *
 * 这一组先红后绿；A/B/C 239 条不动。
 */
function writeScopeConfig(repo: string, action: "block" | "approve", enabled = true): void {
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "app.json"),
    JSON.stringify({
      scope: { enabled, outOfScopeAction: action, proxy: { enabled: false } },
    }),
    "utf8",
  );
}

function approvalFixture(taskId: string, overrides: Partial<ApprovalView> = {}): ApprovalView {
  const base: ApprovalView = {
    id: "ap-d",
    taskId,
    sessionId: "s-d",
    action: "session/request_permission",
    command: "curl http://8.8.8.8/x",
    target: null,
    intentSummary: null,
    rule: "external-network-needs-human",
    risk: "medium",
    status: "pending",
    decidedBy: null,
    sameKindCount: 1,
    createdAt: 0,
    decidedAt: null,
  };
  return { ...base, ...overrides };
}

async function partD(): Promise<void> {
  console.log("\n================ P4-D 前 D 组：审批卡字段 / 误报降级 ================\n");

  // ---------- D1：ApprovalQueue 把 scopeTarget/ruleId 放进视图 ----------
  console.log("---------- D1 ApprovalQueue 字段 ----------");
  const upserted: ApprovalView[] = [];
  const queue = new ApprovalQueue({
    onUpsert: (v) => upserted.push(v),
    timeoutMs: 5000,
  });
  const p1 = queue.request({
    taskId: "t-d",
    sessionId: "s-d",
    action: "session/request_permission",
    detail: { title: "curl http://8.8.8.8/x" },
    rule: "no-out-of-scope",
    reason: "目标不在授权范围",
    ruleId: "no-out-of-scope",
    scopeTarget: { kind: "url", value: "8.8.8.8" },
  });
  const v1 = upserted.find(
    (v) => v.rule === "no-out-of-scope" && v.status === "pending",
  );
  eq("D1 队列视图带 scopeTarget.value", v1?.scopeTarget?.value, "8.8.8.8");
  eq("D1 队列视图带 scopeTarget.kind", v1?.scopeTarget?.kind, "url");
  eq("D1 队列视图带 ruleId", v1?.ruleId, "no-out-of-scope");
  eq("D1 队列视图保留旧 rule 字段", v1?.rule, "no-out-of-scope");
  queue.decide(v1!.id, "denied");
  await p1;

  const p2 = queue.request({
    taskId: "t-d",
    sessionId: "s-d",
    action: "session/request_permission",
    detail: { title: "curl http://8.8.8.8/x" },
    rule: "external-network-needs-human",
    reason: "旧网络规则",
    ruleId: "external-network-needs-human",
  });
  const v2 = upserted.find(
    (v) => v.rule === "external-network-needs-human" && v.status === "pending",
  );
  eq("D1 旧规则 scopeTarget=null", v2?.scopeTarget, null);
  eq("D1 旧规则 ruleId=旧规则 id", v2?.ruleId, "external-network-needs-human");
  queue.decide(v2!.id, "denied");
  await p2;

  const p3 = queue.request({
    taskId: "t-d",
    sessionId: "s-d",
    action: "session/request_permission",
    detail: { title: "run mimikatz" },
    rule: "credential-actions-need-human",
    reason: "ruleId 缺省",
  });
  const v3 = upserted.find(
    (v) => v.rule === "credential-actions-need-human" && v.status === "pending",
  );
  eq("D1 ruleId 缺省回落到 rule", v3?.ruleId, "credential-actions-need-human");
  eq("D1 缺省 scopeTarget=null", v3?.scopeTarget, null);
  queue.decide(v3!.id, "denied");
  await p3;

  // ---------- D2：Hub.publishApproval 给旧视图兜底 ----------
  console.log("\n---------- D2 Hub.publishApproval 兜底 ----------");
  const h = makeHarness();
  try {
    const taskId = await createTask(h, "D 审批任务");
    h.hub.publishApproval(approvalFixture(taskId));
    const ev1 = [...h.events].reverse().find((e) => e.type === "approval.upsert") as
      | Extract<HubEvent, { type: "approval.upsert" }>
      | undefined;
    eq("D2 Hub 为旧视图补 ruleId", ev1?.approval.ruleId, "external-network-needs-human");
    eq("D2 Hub 为旧视图补 scopeTarget=null", ev1?.approval.scopeTarget, null);

    h.hub.publishApproval(
      approvalFixture(taskId, {
        id: "ap-d2",
        rule: "no-out-of-scope",
        ruleId: "no-out-of-scope",
        scopeTarget: { kind: "host", value: "8.8.8.8" },
      }),
    );
    const ev2 = [...h.events].reverse().find((e) => e.type === "approval.upsert") as
      | Extract<HubEvent, { type: "approval.upsert" }>
      | undefined;
    eq("D2 Hub 保留 scopeTarget.value", ev2?.approval.scopeTarget?.value, "8.8.8.8");
    eq("D2 Hub 保留 scopeTarget.kind", ev2?.approval.scopeTarget?.kind, "host");
    eq("D2 Hub 保留 ruleId", ev2?.approval.ruleId, "no-out-of-scope");
  } finally {
    h.cleanup();
  }

  // ---------- D3：main 使用的 scopeTarget helper ----------
  console.log("\n---------- D3 scopeTargetForApproval ----------");
  let scopeTargetForApproval:
    | ((input: {
        rule: string | null;
        action: string;
        detail: Record<string, unknown>;
        targets: TargetView[];
        denyTargets: string[];
      }) => { kind: string; value: string } | null)
    | undefined;
  try {
    const mod = (await import("../main/approval/queue.ts")) as Record<string, unknown>;
    scopeTargetForApproval = mod.scopeTargetForApproval as typeof scopeTargetForApproval;
  } catch (err) {
    check("D3 动态加载 queue 失败", false, (err as Error).message);
  }
  check("D3 queue 导出 scopeTargetForApproval", typeof scopeTargetForApproval === "function");
  if (typeof scopeTargetForApproval === "function") {
    const targets = [tv("10.0.0.0/8", "cidr")];
    const out = scopeTargetForApproval({
      rule: "no-out-of-scope",
      action: "session/request_permission",
      detail: { title: "curl http://8.8.8.8/x" },
      targets,
      denyTargets: [],
    });
    eq("D3 范围外目标 value", out?.value, "8.8.8.8");
    eq("D3 范围外目标 kind=url", out?.kind, "url");

    const oldRule = scopeTargetForApproval({
      rule: "external-network-needs-human",
      action: "session/request_permission",
      detail: { title: "curl http://8.8.8.8/x" },
      targets,
      denyTargets: [],
    });
    eq("D3 旧规则返回 null", oldRule, null);

    const unknown = scopeTargetForApproval({
      rule: "no-out-of-scope",
      action: "session/request_permission",
      detail: { title: "curl http://[::1]/" },
      targets,
      denyTargets: [],
    });
    eq("D3 unknown 目标 kind=unknown", unknown?.kind, "unknown");

    const denied = scopeTargetForApproval({
      rule: "no-out-of-scope",
      action: "session/request_permission",
      detail: { title: "curl http://10.1.2.3/x" },
      targets,
      denyTargets: ["10.1.2.3"],
    });
    eq("D3 denyTargets 命中 target value", denied?.value, "10.1.2.3");
  }

  // ---------- D4：真实 config 读盘 → 误报降级 ----------
  console.log("\n---------- D4 config 读盘 / 误报降级 ----------");
  const cfgRepo = mkdtempSync(join(tmpdir(), "bumimang-scope-d4-"));
  try {
    const detail = { title: "curl http://8.8.8.8/x" };
    const target = { kind: "host" as const, value: "8.8.8.8" };
    const evalOut = (engine: PolicyEngine, inScope: "out" | "unknown" = "out") =>
      evalScope(engine, {
        action: "session/request_permission",
        sessionId: "s-d4",
        tier: "autonomous",
        detail,
        target,
        inScope,
      });

    writeScopeConfig(cfgRepo, "block");
    const cfgBlock = loadAppConfig({ repoRoot: cfgRepo, isPackaged: false, resourcesPath: "", env: {} });
    const engineBlock = new PolicyEngine({
      repoRoot: REPO,
      packId: "competition",
      scope: cfgBlock.config.scope,
    });
    const outBlock = evalOut(engineBlock);
    eq("D4 block 配置：out → block", outBlock.verdict, "block");
    eq("D4 block 配置：命中 no-out-of-scope", outBlock.rule, "no-out-of-scope");
    const unknownBlock = evalOut(engineBlock, "unknown");
    eq("D4 block 配置：unknown → block", unknownBlock.verdict, "block");

    writeScopeConfig(cfgRepo, "approve");
    const cfgApprove = loadAppConfig({ repoRoot: cfgRepo, isPackaged: false, resourcesPath: "", env: {} });
    const engineApprove = new PolicyEngine({
      repoRoot: REPO,
      packId: "competition",
      scope: cfgApprove.config.scope,
    });
    const outApprove = evalOut(engineApprove);
    eq("D4 改 approve 后：out → approve", outApprove.verdict, "approve");
    eq("D4 改 approve 后：仍命中 no-out-of-scope", outApprove.rule, "no-out-of-scope");
    const unknownApprove = evalOut(engineApprove, "unknown");
    eq("D4 改 approve 后：unknown → approve", unknownApprove.verdict, "approve");

    writeScopeConfig(cfgRepo, "block");
    const cfgBlockAgain = loadAppConfig({ repoRoot: cfgRepo, isPackaged: false, resourcesPath: "", env: {} });
    const engineBlockAgain = new PolicyEngine({
      repoRoot: REPO,
      packId: "competition",
      scope: cfgBlockAgain.config.scope,
    });
    const outBlockAgain = evalOut(engineBlockAgain);
    eq("D4 改回 block 后（重读盘）：out → block", outBlockAgain.verdict, "block");
    eq("D4 改回 block 后：命中 no-out-of-scope", outBlockAgain.rule, "no-out-of-scope");

    writeScopeConfig(cfgRepo, "block", false);
    const cfgDisabled = loadAppConfig({ repoRoot: cfgRepo, isPackaged: false, resourcesPath: "", env: {} });
    const engineDisabled = new PolicyEngine({
      repoRoot: REPO,
      packId: "competition",
      scope: cfgDisabled.config.scope,
    });
    const outDisabled = evalOut(engineDisabled);
    eq("D4 enabled=false：out 仍走旧规则 approve", outDisabled.verdict, "approve");
    eq("D4 enabled=false：规则仍是旧 external-network", outDisabled.rule, "external-network-needs-human");
    if (typeof scopeTargetForApproval === "function") {
      const disabledScopeTarget = scopeTargetForApproval({
        rule: outDisabled.rule,
        action: "session/request_permission",
        detail,
        targets: [tv("10.0.0.0/8", "cidr")],
        denyTargets: [],
      });
      eq("D4 enabled=false：审批 scopeTarget=null", disabledScopeTarget, null);
    }
  } finally {
    rmSync(cfgRepo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- P4-D 批次 2：代理

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listenHttp(server: ReturnType<typeof createHttpServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("HTTP server 地址不可用"));
      else resolve(addr.port);
    });
  });
}

async function listenNet(server: ReturnType<typeof createNetServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("net server 地址不可用"));
      else resolve(addr.port);
    });
  });
}

async function listenOnPort(
  server: ReturnType<typeof createNetServer>,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: { close(cb: () => void): void; listening: boolean }): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function runCurl(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, out, err });
    };
    const child = spawn(
      "curl",
      ["-sS", "--max-time", "10", "-w", "\nHTTP_STATUS:%{http_code}", "-x", proxyUrl, targetUrl],
      {
        windowsHide: true,
        env: {
          ...process.env,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          all_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
        },
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
    });
    child.stderr.on("data", (d: string) => {
      err += d;
    });
    child.on("error", (e) => {
      err += e.message;
      done(-1);
    });
    child.on("close", (code) => done(code));
  });
}

function proxyToken(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

function rawConnect(proxyPort: number, target: string, token: string): Promise<string> {
  const basic = Buffer.from(`bumimang:${token}`).toString("base64");
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const socket = netConnect(proxyPort, "127.0.0.1");
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* 已关闭 */
      }
      resolve(data || "<empty>");
    };
    const timer = setTimeout(done, 5000);
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
      );
    });
    socket.on("data", (d: Buffer) => {
      data += d.toString("utf8");
      if (data.includes("\r\n\r\n")) done();
    });
    socket.on("error", (err) => {
      data += `\n[error] ${err.message}`;
      done();
    });
    socket.on("close", done);
  });
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

function proxyScopeCfg(enabled: boolean, proxyEnabled: boolean, port = 0): ScopeConfig {
  return { enabled, outOfScopeAction: "approve", proxy: { enabled: proxyEnabled, port } };
}

async function partE(): Promise<void> {
  console.log("\n================ P4-D E 组：本地代理 ================\n");

  // ---------- E1：config port ----------
  console.log("---------- E1 config proxy.port ----------");
  const repoCfg = loadAppConfig({ repoRoot: REPO, isPackaged: false, resourcesPath: "", env: {} });
  eq("E1 仓库 config proxy.port=0（随机）", repoCfg.config.scope.proxy.port, 0);
  const cfgRepo = mkdtempSync(join(tmpdir(), "bumimang-proxy-cfg-"));
  try {
    mkdirSync(join(cfgRepo, "config"), { recursive: true });
    writeFileSync(
      join(cfgRepo, "config", "app.json"),
      JSON.stringify({ scope: { proxy: { enabled: true, port: 70000 } } }),
      "utf8",
    );
    const invalid = loadAppConfig({
      repoRoot: cfgRepo,
      isPackaged: false,
      resourcesPath: "",
      env: {},
    });
    eq("E1 非法 proxy.port 回落到 0", invalid.config.scope.proxy.port, 0);
    eq("E1 proxy.enabled 从 config 读", invalid.config.scope.proxy.enabled, true);
  } finally {
    rmSync(cfgRepo, { recursive: true, force: true });
  }

  // ---------- E2：监听地址 / 随机端口 / 进程登记 ----------
  console.log("\n---------- E2 监听 127.0.0.1 / 随机端口 / 登记 ----------");
  const noScope = (): { targets: never[]; denyTargets: never[] } => ({
    targets: [],
    denyTargets: [],
  });
  const regA = new ProcessRegistry();
  const regB = new ProcessRegistry();
  const proxyA = new ScopeProxyService({
    port: 0,
    resolveScope: noScope,
    audit: () => undefined,
    registry: regA,
  });
  const proxyB = new ScopeProxyService({
    port: 0,
    resolveScope: noScope,
    audit: () => undefined,
    registry: regB,
  });
  try {
    const [infoA, infoB] = await Promise.all([proxyA.start(), proxyB.start()]);
    eq("E2 代理监听 127.0.0.1", infoA.address, "127.0.0.1");
    check("E2 两次启动端口不同（随机）", infoA.port !== infoB.port, `${infoA.port} vs ${infoB.port}`);
    const recordA = regA.list()[0];
    check(
      "E2 process-registry 登记 pid + startedAt",
      Boolean(recordA) && recordA.pid > 0 && Number.isFinite(recordA.startedAt),
      JSON.stringify(recordA),
    );
    await proxyA.close();
    await proxyB.close();
    eq("E2 关闭后登记清空", regA.list().length, 0);
  } finally {
    await proxyA.close().catch(() => undefined);
    await proxyB.close().catch(() => undefined);
  }

  // ---------- E3：真实 HTTP 服务器 + curl allow/deny + CONNECT + 审计 ----------
  console.log("\n---------- E3 allow/deny / CONNECT / 审计 ----------");
  const httpServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("allow-ok");
  });
  const echoServer = createNetServer((socket) => socket.pipe(socket));
  let httpPort = 0;
  let echoPort = 0;
  const boardDir = mkdtempSync(join(tmpdir(), "bumimang-proxy-e3-"));
  const e3Board = Blackboard.open(join(boardDir, "board.db"));
  const allowTask = e3Board.createTask({ title: "E3 allow", brief: "" });
  const denyTask = e3Board.createTask({ title: "E3 deny", brief: "" });
  const audits: ProxyAuditEntry[] = [];
  const e3Registry = new ProcessRegistry();
  const e3Proxy = new ScopeProxyService({
    port: 0,
    resolveScope: (taskId) =>
      taskId === allowTask.id
        ? {
            targets: [
              {
                id: "e3-http",
                taskId,
                value: `127.0.0.1:${httpPort}`,
                kind: "host",
                status: "unknown",
                notes: null,
                createdAt: 0,
              },
              {
                id: "e3-echo",
                taskId,
                value: `127.0.0.1:${echoPort}`,
                kind: "host",
                status: "unknown",
                notes: null,
                createdAt: 0,
              },
            ],
            denyTargets: [],
          }
        : { targets: [], denyTargets: [] },
    audit: (entry) => {
      audits.push(entry);
      try {
        if (entry.taskId) {
          e3Board.note({
            taskId: entry.taskId,
            sessionId: entry.sessionId,
            text: `proxy.request ${JSON.stringify({
              host: entry.host,
              port: entry.port,
              verdict: entry.verdict,
              timestamp: entry.timestamp,
            })}`,
          });
        } else {
          e3Board.audit({
            sessionId: entry.sessionId,
            actor: "proxy",
            action: "scope.proxy",
            detail: entry,
          });
        }
      } catch {
        /* 测试审计失败也不影响代理 */
      }
    },
    registry: e3Registry,
  });
  let info: { port: number; address: string } | null = null;
  try {
    httpPort = await listenHttp(httpServer);
    echoPort = await listenNet(echoServer);
    info = await e3Proxy.start();
    eq("E3 代理监听地址 127.0.0.1", info.address, "127.0.0.1");
    const e3Hub = new HubService({
      board: e3Board,
      sessions: emptySessions,
      bus: new EventBus(),
      workspaceRoot: boardDir,
      workDir: join(boardDir, "work"),
      scope: {
        enabled: false,
        outOfScopeAction: "approve",
        proxy: { enabled: true, port: info.port },
      },
    });
    const e3HubSnap = e3Hub.snapshot();
    eq("E3 Hub 快照 proxy.port=真实监听端口", e3HubSnap.scope?.proxy?.port, info.port);
    eq("E3 Hub 快照 proxy.enabled 来自 scope 配置", e3HubSnap.scope?.proxy?.enabled, true);
    const allowUrl = e3Proxy.urlForSession("s-e3-allow", allowTask.id);
    const denyUrl = e3Proxy.urlForSession("s-e3-deny", denyTask.id);
    check("E3 会话签发代理 URL", Boolean(allowUrl && denyUrl), `${allowUrl ?? "null"} / ${denyUrl ?? "null"}`);
    if (!allowUrl || !denyUrl) throw new Error("代理 URL 未签发");

    const allowRes = await runCurl(allowUrl, `http://127.0.0.1:${httpPort}/`);
    check(
      "E3 allow：targets 内 host:port 经代理成功（HTTP 200）",
      allowRes.code === 0 &&
        allowRes.out.includes("allow-ok") &&
        allowRes.out.includes("HTTP_STATUS:200"),
      JSON.stringify(allowRes),
    );
    const denyRes = await runCurl(denyUrl, `http://127.0.0.1:${httpPort}/`);
    check(
      "E3 deny：targets 外 host:port 返回 HTTP 403（不转发）",
      denyRes.out.includes("HTTP_STATUS:403") &&
        denyRes.out.includes("blocked by scope proxy") &&
        !denyRes.out.includes("allow-ok"),
      JSON.stringify(denyRes),
    );

    const connectAllow = await rawConnect(info.port, `127.0.0.1:${echoPort}`, proxyToken(allowUrl));
    check(
      "E3 CONNECT allow 返回 200",
      connectAllow.includes("200 Connection Established"),
      connectAllow.slice(0, 100),
    );
    const connectDeny = await rawConnect(info.port, `127.0.0.1:${echoPort}`, proxyToken(denyUrl));
    check("E3 CONNECT deny 返回 403", connectDeny.includes("403"), connectDeny.slice(0, 100));

    await sleep(250);
    const allowAudit = audits.find(
      (a) => a.sessionId === "s-e3-allow" && a.verdict === "allow" && a.port === httpPort,
    );
    const denyAudit = audits.find(
      (a) => a.sessionId === "s-e3-deny" && a.verdict === "out" && a.port === httpPort,
    );
    check(
      "E3 allow 审计含 host/port/verdict/timestamp",
      Boolean(allowAudit) &&
        allowAudit?.host === "127.0.0.1" &&
        allowAudit?.port === httpPort &&
        Number.isFinite(allowAudit?.timestamp),
      JSON.stringify(allowAudit),
    );
    check(
      "E3 deny 审计含 host/port/verdict/timestamp",
      Boolean(denyAudit) &&
        denyAudit?.host === "127.0.0.1" &&
        denyAudit?.port === httpPort &&
        Number.isFinite(denyAudit?.timestamp),
      JSON.stringify(denyAudit),
    );
    check(
      "E3 审计不含请求 body",
      audits.every((a) => !("body" in a) && !("requestBody" in a)),
      JSON.stringify(Object.keys(audits[0] ?? {})),
    );

    const eventRows = e3Board.raw(
      "SELECT body FROM events WHERE body LIKE '%proxy.request%' ORDER BY id ASC",
    ) as Array<{ body: string }>;
    check("E3 每个代理请求写 events（≥4）", eventRows.length >= 4, `events=${eventRows.length}`);
    const payloads = eventRows.map((row) => {
      const body = JSON.parse(row.body) as { text?: string };
      const text = String(body.text ?? "");
      const prefix = "proxy.request ";
      return JSON.parse(text.startsWith(prefix) ? text.slice(prefix.length) : "{}") as Record<
        string,
        unknown
      >;
    });
    check(
      "E3 events 含 host/port/verdict/timestamp 且不含 body",
      payloads.every(
        (p) =>
          typeof p.host === "string" &&
          typeof p.port === "number" &&
          typeof p.verdict === "string" &&
          typeof p.timestamp === "number" &&
          !("body" in p) &&
          !("requestBody" in p),
      ),
      JSON.stringify(payloads[0]),
    );

    // 环境变量只进会话 env；主进程 process.env 不变。
    const beforeEnv = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY,
    };
    const envOn = proxyEnvForSession(proxyScopeCfg(true, true), allowUrl);
    eq("E3 proxy env 注入 HTTP_PROXY", envOn.HTTP_PROXY, allowUrl);
    eq("E3 proxy env 注入 HTTPS_PROXY", envOn.HTTPS_PROXY, allowUrl);
    eq("E3 proxy env 注入 ALL_PROXY", envOn.ALL_PROXY, allowUrl);
    eq("E3 proxy env NO_PROXY 置空", envOn.NO_PROXY, "");
    eq(
      "E3 proxy 关闭时不注入 env",
      JSON.stringify(proxyEnvForSession(proxyScopeCfg(true, false), allowUrl)),
      "{}",
    );
    eq(
      "E3 代理未启动/启动失败（url=null）不注入 env",
      JSON.stringify(proxyEnvForSession(proxyScopeCfg(true, true), null)),
      "{}",
    );
    eq("E3 主进程 HTTP_PROXY 未被修改", process.env.HTTP_PROXY, beforeEnv.HTTP_PROXY);
    eq("E3 主进程 HTTPS_PROXY 未被修改", process.env.HTTPS_PROXY, beforeEnv.HTTPS_PROXY);
    eq("E3 主进程 ALL_PROXY 未被修改", process.env.ALL_PROXY, beforeEnv.ALL_PROXY);
    eq("E3 主进程 NO_PROXY 未被修改", process.env.NO_PROXY, beforeEnv.NO_PROXY);

    const ui = buildScopeStatusView({
      scopeStatus: {
        enabled: true,
        outOfScopeAction: "approve",
        proxy: { enabled: true, port: info.port },
      },
    });
    check(
      "E3 UI 文案明确“可绕过、不宣称拦截”",
      ui.title.includes("仅对遵守代理的工具生效") &&
        ui.title.includes("nmap/raw socket/DNS") &&
        ui.title.includes("仅可事后审计") &&
        ui.headline.includes("仅平台可中介"),
      ui.title,
    );

    const proxyPort = info.port;
    await e3Proxy.close();
    const releaseServer = createNetServer();
    let released = false;
    try {
      await listenOnPort(releaseServer, proxyPort);
      released = true;
    } catch {
      released = false;
    }
    await closeServer(releaseServer);
    check("E3 关闭后端口释放", released, `port=${proxyPort}`);
    eq("E3 关闭后 process-registry 清空", e3Registry.list().length, 0);
  } finally {
    await e3Proxy.close().catch(() => undefined);
    await closeServer(httpServer);
    await closeServer(echoServer);
    e3Board.close();
    rmSync(boardDir, { recursive: true, force: true });
  }

  // ---------- E4：启动失败 / 崩溃降级 ----------
  console.log("\n---------- E4 启动失败 / 崩溃降级 ----------");
  const occupied = createNetServer();
  const occupiedPort = await listenNet(occupied);
  const failing = new ScopeProxyService({
    port: occupiedPort,
    resolveScope: noScope,
    audit: () => undefined,
  });
  let startFailed = false;
  try {
    await failing.start();
  } catch {
    startFailed = true;
  }
  check("E4 端口占用时启动失败可降级（不抛穿）", startFailed && !failing.isRunning());
  await failing.close().catch(() => undefined);
  await closeServer(occupied);

  const crashRegistry = new ProcessRegistry();
  const crashProxy = new ScopeProxyService({
    port: 0,
    resolveScope: noScope,
    audit: () => undefined,
    registry: crashRegistry,
  });
  try {
    await crashProxy.start();
    const pid = crashRegistry.list()[0]?.pid;
    check("E4 崩溃前已登记代理 PID", typeof pid === "number" && pid > 0, String(pid));
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* 已退出 */
      }
    }
    const stopped = await waitFor(() => !crashProxy.isRunning(), 2500);
    check("E4 代理崩溃后 isRunning=false", stopped);
    const crashedEnv = proxyEnvForSession(
      proxyScopeCfg(true, true),
      crashProxy.urlForSession("s-crash", "task-crash"),
    );
    eq("E4 崩溃后会话 env 不注入（会话继续）", JSON.stringify(crashedEnv), "{}");
  } finally {
    await crashProxy.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- P6-B 批次 2a F 组

interface ProxyStateProbe {
  state?: string;
  port?: number | null;
  error?: string;
}

/** 旧实现没有 getState() 时返回 undefined，红测不整组崩掉。 */
function proxyStateOf(svc: ScopeProxyService): ProxyStateProbe | undefined {
  const fn = (svc as unknown as { getState?: () => ProxyStateProbe }).getState;
  return typeof fn === "function" ? fn.call(svc) : undefined;
}

/** 调 Hub 的运行时状态更新；旧实现返回 false（红测不崩）。 */
function pushProxyRuntime(hub: HubService | null, proxy: unknown): boolean {
  if (!hub) return false;
  const fn = (hub as unknown as { setScopeProxyRuntime?: (p: unknown) => void })
    .setScopeProxyRuntime;
  if (typeof fn !== "function") return false;
  fn.call(hub, proxy);
  return true;
}

function proxyOptionsWithState(
  opts: Record<string, unknown>,
  onStateChange: (s: ProxyStateProbe) => void,
): ConstructorParameters<typeof ScopeProxyService>[0] {
  return { ...opts, onStateChange } as unknown as ConstructorParameters<
    typeof ScopeProxyService
  >[0];
}

async function partF(): Promise<void> {
  console.log("\n================ P6-B 批次 2a F 组：代理状态机 / 快照 / 事件 ================\n");
  const noScope = (): { targets: never[]; denyTargets: never[] } => ({
    targets: [],
    denyTargets: [],
  });

  // ---------- F1：启动成功 → starting → running + 真实端口 ----------
  console.log("---------- F1 启动成功：state=running + port ----------");
  const states: ProxyStateProbe[] = [];
  const f1 = new ScopeProxyService(
    proxyOptionsWithState(
      { port: 0, resolveScope: noScope, audit: () => undefined },
      (s) => states.push({ ...s }),
    ),
  );
  try {
    const info = await f1.start();
    const st = proxyStateOf(f1);
    check("F1 启动成功 state=running", st?.state === "running", JSON.stringify(st));
    check(
      "F1 启动成功 port>0 且等于返回端口",
      st?.port === info.port && info.port > 0,
      JSON.stringify({ st, info }),
    );
    check("F1 启动成功 error 为空", !st?.error, JSON.stringify(st));
    check(
      "F1 onStateChange 先 starting 后 running",
      states.length >= 2 &&
        states[0]?.state === "starting" &&
        states[states.length - 1]?.state === "running",
      JSON.stringify(states),
    );
  } catch (err) {
    check("F1 启动成功（不抛错）", false, (err as Error).message);
  } finally {
    await f1.close().catch(() => undefined);
  }

  // ---------- F2：启动失败 → failed + error；快照 enabled 仍是 config 意图 ----------
  console.log("\n---------- F2 启动失败：state=failed + error，快照不撒谎 ----------");
  const occupied = createNetServer();
  const occupiedPort = await listenNet(occupied);
  const failStates: ProxyStateProbe[] = [];
  const f2 = new ScopeProxyService(
    proxyOptionsWithState(
      { port: occupiedPort, resolveScope: noScope, audit: () => undefined },
      (s) => failStates.push({ ...s }),
    ),
  );
  let f2StartError = "";
  try {
    await f2.start();
  } catch (err) {
    f2StartError = (err as Error).message ?? String(err);
  }
  const f2State = proxyStateOf(f2);
  check("F2 端口占用启动失败（有可读错误）", Boolean(f2StartError), f2StartError);
  check("F2 启动失败 state=failed", f2State?.state === "failed", JSON.stringify(f2State));
  check(
    "F2 启动失败 error 非空",
    typeof f2State?.error === "string" && f2State.error.length > 0,
    JSON.stringify(f2State),
  );
  eq("F2 启动失败 port=null", f2State?.port ?? null, null);
  eq("F2 启动失败 isRunning=false", f2.isRunning(), false);
  check(
    "F2 状态序列 starting→failed（没有 running）",
    failStates.length >= 2 &&
      failStates[0]?.state === "starting" &&
      failStates[failStates.length - 1]?.state === "failed" &&
      !failStates.some((s) => s.state === "running"),
    JSON.stringify(failStates),
  );
  const f2Dir = mkdtempSync(join(tmpdir(), "bumimang-proxy-f2-"));
  const f2Board = Blackboard.open(join(f2Dir, "board.db"));
  try {
    const f2Hub = new HubService({
      board: f2Board,
      sessions: emptySessions,
      bus: new EventBus(),
      workspaceRoot: f2Dir,
      workDir: join(f2Dir, "work"),
      scope: {
        enabled: true,
        outOfScopeAction: "approve",
        proxy: {
          enabled: true,
          port: null,
          state: "failed",
          error: f2State?.error ?? "启动失败",
        },
      },
    });
    const snap = f2Hub.snapshot();
    eq("F2 快照 proxy.enabled=true（config 意图）", snap.scope?.proxy?.enabled, true);
    eq("F2 快照 proxy.state=failed（真实状态）", snap.scope?.proxy?.state, "failed");
    eq("F2 快照 proxy.port=null", snap.scope?.proxy?.port ?? null, null);
    check(
      "F2 快照 proxy.error 非空",
      typeof snap.scope?.proxy?.error === "string" && snap.scope.proxy.error.length > 0,
      JSON.stringify(snap.scope?.proxy),
    );
    eq("F2 失败态 urlForSession=null（会话照常启动）", f2.urlForSession("s-f2", "task-f2"), null);
    eq(
      "F2 失败态 proxyEnv 不注入",
      JSON.stringify(proxyEnvForSession(proxyScopeCfg(true, true), null)),
      "{}",
    );
  } finally {
    f2Board.close();
    rmSync(f2Dir, { recursive: true, force: true });
  }
  await f2.close().catch(() => undefined);
  await closeServer(occupied);

  // ---------- F3：运行中崩溃 → failed + 快照/事件更新 ----------
  console.log("\n---------- F3 运行中崩溃：state=failed + 快照/事件更新 ----------");
  const crashStates: ProxyStateProbe[] = [];
  let crashHub: HubService | null = null;
  const crashBus = new EventBus();
  const crashEvents: HubEvent[] = [];
  crashBus.on((e) => crashEvents.push(e));
  const crashRegistry = new ProcessRegistry();
  const f3 = new ScopeProxyService(
    proxyOptionsWithState(
      {
        port: 0,
        resolveScope: noScope,
        audit: () => undefined,
        registry: crashRegistry,
      },
      (s) => {
        crashStates.push({ ...s });
        if (crashHub) {
          pushProxyRuntime(crashHub, {
            enabled: true,
            port: s.state === "running" ? (s.port ?? null) : null,
            state: s.state,
            ...(s.error ? { error: s.error } : {}),
          });
        }
      },
    ),
  );
  const f3Dir = mkdtempSync(join(tmpdir(), "bumimang-proxy-f3-"));
  const f3Board = Blackboard.open(join(f3Dir, "board.db"));
  try {
    const info = await f3.start();
    crashHub = new HubService({
      board: f3Board,
      sessions: emptySessions,
      bus: crashBus,
      workspaceRoot: f3Dir,
      workDir: join(f3Dir, "work"),
      scope: {
        enabled: true,
        outOfScopeAction: "approve",
        proxy: { enabled: true, port: info.port, state: "running" },
      },
    });
    check(
      "F3 Hub 暴露 setScopeProxyRuntime",
      typeof (crashHub as unknown as { setScopeProxyRuntime?: unknown }).setScopeProxyRuntime ===
        "function",
    );
    const pid = crashRegistry.list()[0]?.pid;
    check("F3 崩溃前已登记代理 PID", typeof pid === "number" && pid > 0, String(pid));
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* 已退出 */
      }
    }
    const crashed = await waitFor(() => proxyStateOf(f3)?.state === "failed", 3000);
    const st = proxyStateOf(f3);
    check("F3 崩溃后 state=failed", crashed, JSON.stringify(st));
    check(
      "F3 崩溃后 error 非空",
      typeof st?.error === "string" && st.error.length > 0,
      JSON.stringify(st),
    );
    eq("F3 崩溃后 port=null", st?.port ?? null, null);
    eq("F3 崩溃后 isRunning=false", f3.isRunning(), false);
    check(
      "F3 状态序列包含 running 且终态 failed",
      crashStates.some((s) => s.state === "running") &&
        crashStates[crashStates.length - 1]?.state === "failed",
      JSON.stringify(crashStates),
    );
    const snap = crashHub.snapshot();
    eq("F3 崩溃后快照 state=failed（不撒谎）", snap.scope?.proxy?.state, "failed");
    eq("F3 崩溃后快照 port=null（不再显示旧端口）", snap.scope?.proxy?.port ?? null, null);
    check(
      "F3 崩溃后快照 error 非空",
      typeof snap.scope?.proxy?.error === "string" && snap.scope.proxy.error.length > 0,
      JSON.stringify(snap.scope?.proxy),
    );
    const changed = crashEvents.filter((e) => e.type === "proxy.state.changed");
    const last = changed[changed.length - 1];
    check(
      "F3 崩溃广播 proxy.state.changed",
      last?.type === "proxy.state.changed" && last.proxy.state === "failed",
      JSON.stringify(changed.map((e) => (e.type === "proxy.state.changed" ? e.proxy : e.type))),
    );
    if (last?.type === "proxy.state.changed") {
      eq("F3 事件 port=null", last.proxy.port, null);
      eq("F3 事件 enabled=true（config 意图）", last.proxy.enabled, true);
    }
    eq(
      "F3 崩溃后 urlForSession=null（会话继续，不挂起）",
      f3.urlForSession("s-f3", "task-f3"),
      null,
    );
  } finally {
    await f3.close().catch(() => undefined);
    f3Board.close();
    rmSync(f3Dir, { recursive: true, force: true });
  }

  // ---------- F4：主动关闭 → stopped + port=null ----------
  console.log("\n---------- F4 主动关闭：state=stopped + port=null ----------");
  const stopStates: ProxyStateProbe[] = [];
  let stopHub: HubService | null = null;
  const stopBus = new EventBus();
  const stopEvents: HubEvent[] = [];
  stopBus.on((e) => stopEvents.push(e));
  const f4 = new ScopeProxyService(
    proxyOptionsWithState(
      { port: 0, resolveScope: noScope, audit: () => undefined },
      (s) => {
        stopStates.push({ ...s });
        if (stopHub) {
          pushProxyRuntime(stopHub, {
            enabled: true,
            port: s.state === "running" ? (s.port ?? null) : null,
            state: s.state,
            ...(s.error ? { error: s.error } : {}),
          });
        }
      },
    ),
  );
  const f4Dir = mkdtempSync(join(tmpdir(), "bumimang-proxy-f4-"));
  const f4Board = Blackboard.open(join(f4Dir, "board.db"));
  try {
    const info = await f4.start();
    stopHub = new HubService({
      board: f4Board,
      sessions: emptySessions,
      bus: stopBus,
      workspaceRoot: f4Dir,
      workDir: join(f4Dir, "work"),
      scope: {
        enabled: true,
        outOfScopeAction: "approve",
        proxy: { enabled: true, port: info.port, state: "running" },
      },
    });
    await f4.close();
    const st = proxyStateOf(f4);
    eq("F4 主动关闭 state=stopped", st?.state, "stopped");
    eq("F4 主动关闭 port=null", st?.port ?? null, null);
    eq("F4 主动关闭 isRunning=false", f4.isRunning(), false);
    check(
      "F4 状态序列包含 running 且终态 stopped",
      stopStates.some((s) => s.state === "running") &&
        stopStates[stopStates.length - 1]?.state === "stopped",
      JSON.stringify(stopStates),
    );
    const snap = stopHub.snapshot();
    eq("F4 关闭后快照 state=stopped", snap.scope?.proxy?.state, "stopped");
    eq("F4 关闭后快照 port=null", snap.scope?.proxy?.port ?? null, null);
    const changed = stopEvents.filter((e) => e.type === "proxy.state.changed");
    const last = changed[changed.length - 1];
    check(
      "F4 关闭广播 proxy.state.changed stopped",
      last?.type === "proxy.state.changed" && last.proxy.state === "stopped",
      JSON.stringify(changed.map((e) => (e.type === "proxy.state.changed" ? e.proxy : e.type))),
    );
  } finally {
    await f4.close().catch(() => undefined);
    f4Board.close();
    rmSync(f4Dir, { recursive: true, force: true });
  }

  // ---------- F5：快照归一化 / 旧快照兼容 ----------
  console.log("\n---------- F5 快照归一化 / 旧快照兼容 ----------");
  const f5Dir = mkdtempSync(join(tmpdir(), "bumimang-proxy-f5-"));
  const f5Board = Blackboard.open(join(f5Dir, "board.db"));
  try {
    const hubWith = (proxy: unknown): HubService =>
      new HubService({
        board: f5Board,
        sessions: emptySessions,
        bus: new EventBus(),
        workspaceRoot: f5Dir,
        workDir: join(f5Dir, "work"),
        scope: {
          enabled: true,
          outOfScopeAction: "approve",
          proxy: proxy as { enabled: boolean; port?: number | null },
        },
      });
    const oldSnap = hubWith({ enabled: true, port: 45678 }).snapshot();
    eq("F5 旧式 proxy 无 state：port 保留（向后兼容）", oldSnap.scope?.proxy?.port, 45678);
    eq("F5 旧式 proxy 无 state：state 缺席（不臆造）", oldSnap.scope?.proxy?.state, undefined);
    const runningSnap = hubWith({ enabled: true, port: 45678, state: "running" }).snapshot();
    eq("F5 state=running 保留真实 port", runningSnap.scope?.proxy?.port, 45678);
    const failedSnap = hubWith({
      enabled: true,
      port: 45678,
      state: "failed",
      error: "EADDRINUSE",
    }).snapshot();
    eq("F5 state=failed 时 port 强制 null", failedSnap.scope?.proxy?.port ?? null, null);
    eq("F5 state=failed 保留 error", failedSnap.scope?.proxy?.error, "EADDRINUSE");
    const stoppedSnap = hubWith({ enabled: true, port: 45678, state: "stopped" }).snapshot();
    eq("F5 state=stopped 时 port 强制 null", stoppedSnap.scope?.proxy?.port ?? null, null);
    const bogusSnap = hubWith({ enabled: true, port: 45678, state: "bogus" }).snapshot();
    eq("F5 非法 state 不写进快照", bogusSnap.scope?.proxy?.state, undefined);
    const noScopeHub = new HubService({
      board: f5Board,
      sessions: emptySessions,
      bus: new EventBus(),
      workspaceRoot: f5Dir,
      workDir: join(f5Dir, "work"),
    });
    eq("F5 无 scope 依赖：快照 scope=undefined", noScopeHub.snapshot().scope, undefined);
    let noScopeThrew = false;
    try {
      pushProxyRuntime(noScopeHub, { enabled: true, port: null, state: "failed" });
    } catch {
      noScopeThrew = true;
    }
    check("F5 无 scope 时更新状态不抛错", !noScopeThrew);
  } finally {
    f5Board.close();
    rmSync(f5Dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("================ P4-A A 组：目标 CRUD ================\n");
  const h = makeHarness();
  try {
    // ---------- A1：create + add + 快照焦点 ----------
    console.log("---------- A1 新增目标 / 焦点快照 ----------");
    const aId = await createTask(h, "目标题 A");
    const bId = await createTask(h, "目标题 B");

    // A 不是焦点：数据要落库，但不应推 task.upsert（P1-C 的后台规则）。
    const eventsBeforeA = h.events.filter((e) => e.type === "task.upsert").length;
    await addTarget(
      h,
      { type: "target.add", taskId: aId, value: "10.0.0.0/8", kind: "cidr", notes: "内网段" },
      "A（后台任务）可以加目标",
    );
    eq("后台任务加目标不推 task.upsert", h.events.filter((e) => e.type === "task.upsert").length, eventsBeforeA);
    eq("A 的目标已落库", h.board.listTargets?.(aId).length, 1);

    const eventsBeforeB = h.events.filter((e) => e.type === "task.upsert").length;
    await addTarget(
      h,
      { type: "target.add", taskId: bId, value: "10.1.2.3", kind: "host", notes: "Web 入口" },
      "B（焦点任务）可以加目标",
    );
    check("焦点任务加目标推 task.upsert", h.events.filter((e) => e.type === "task.upsert").length > eventsBeforeB);
    await addTarget(
      h,
      { type: "target.add", taskId: bId, value: "http://10.1.2.3:8080/admin", kind: "url" },
      "同一个任务可以加第二个目标",
    );

    let snap = h.hub.snapshot();
    eq("快照焦点是 B", snap.task?.id, bId);
    eq("焦点快照带 2 个 targets", snap.task?.targets?.length, 2);
    eq("焦点快照 targets 值正确", targetValues(snap.task?.targets).join(","), "10.1.2.3,http://10.1.2.3:8080/admin");
    eq("target 字段 id 非空", Boolean(snap.task?.targets?.[0]?.id), true);
    eq("target 字段 taskId 正确", snap.task?.targets?.[0]?.taskId, bId);
    eq("target 默认 status=unknown", snap.task?.targets?.[0]?.status, "unknown");
    eq("target notes 保留", snap.task?.targets?.[0]?.notes, "Web 入口");
    check("target createdAt 已写入", Number(snap.task?.targets?.[0]?.createdAt) > 0);
    eq("非焦点任务在 tasks 列表里不重复搬 targets", snap.tasks.find((t: TaskView) => t.id === aId)?.targets, undefined);

    await h.hub.dispatch({ type: "task.focus", taskId: aId });
    snap = h.hub.snapshot();
    eq("切到 A 后焦点 targets 是 A 的 1 个", snap.task?.targets?.length, 1);
    eq("A 的 kind=cidr", snap.task?.targets?.[0]?.kind, "cidr");
    eq("A 的 notes 保留", snap.task?.targets?.[0]?.notes, "内网段");
    eq("B 的目标没有混进 A", targetValues(snap.task?.targets).includes("10.1.2.3"), false);

    // 跨任务同值允许（UNIQUE(task_id, value)，不是全局唯一）。
    await addTarget(
      h,
      { type: "target.add", taskId: aId, value: "10.1.2.3", kind: "host" },
      "不同任务可以使用相同的目标值",
    );
    eq("A 现在有 2 个目标", h.board.listTargets?.(aId).length, 2);
    eq("B 的目标数量不受影响", h.board.listTargets?.(bId).length, 2);

    // ---------- A2：update ----------
    console.log("\n---------- A2 更新目标 ----------");
    const bTargets = h.board.listTargets?.(bId) ?? [];
    const hostTargetId = bTargets.find((t) => t.value === "10.1.2.3")?.id ?? "target-missing";
    const upd = await h.hub.dispatch({
      type: "target.update",
      taskId: bId,
      targetId: hostTargetId,
      status: "alive",
      notes: "端口 80/443 开放",
    });
    check("更新目标状态/备注成功", upd.ok, JSON.stringify(upd));
    const updated = h.board.listTargets?.(bId).find((t) => t.id === hostTargetId);
    eq("update 后 status=alive", updated?.status, "alive");
    eq("update 后 notes 已改写", updated?.notes, "端口 80/443 开放");
    eq("update 不改 value", updated?.value, "10.1.2.3");

    const same = await h.hub.dispatch({ type: "target.update", taskId: bId, targetId: hostTargetId, status: "owned" });
    check("只更新 status 时 notes 保持", same.ok && h.board.listTargets?.(bId).find((t) => t.id === hostTargetId)?.notes === "端口 80/443 开放");

    const noSuch = await h.hub.dispatch({ type: "target.update", taskId: bId, targetId: "target-missing", status: "alive" });
    check("更新不存在的 target 被拒", !noSuch.ok && Boolean(noSuch.error), JSON.stringify(noSuch));

    const cross = await h.hub.dispatch({ type: "target.update", taskId: aId, targetId: hostTargetId, status: "owned" });
    check("跨任务更新 target 被拒", !cross.ok && Boolean(cross.error), JSON.stringify(cross));

    // ---------- A3：remove ----------
    console.log("\n---------- A3 移除目标 ----------");
    const del = await h.hub.dispatch({ type: "target.remove", taskId: bId, targetId: hostTargetId });
    check("移除目标成功", del.ok, JSON.stringify(del));
    eq("B 只剩 1 个目标", h.board.listTargets?.(bId).length, 1);
    eq("移除后快照（切回 B）只剩 1 个", (await h.hub.dispatch({ type: "task.focus", taskId: bId }), h.hub.snapshot().task?.targets?.length), 1);

    const delAgain = await h.hub.dispatch({ type: "target.remove", taskId: bId, targetId: hostTargetId });
    check("重复移除被拒", !delAgain.ok && Boolean(delAgain.error), JSON.stringify(delAgain));

    const crossDel = await h.hub.dispatch({
      type: "target.remove",
      taskId: aId,
      targetId: (h.board.listTargets?.(bId) ?? [])[0]?.id ?? "target-missing",
    });
    check("跨任务移除 target 被拒", !crossDel.ok && Boolean(crossDel.error), JSON.stringify(crossDel));

    await addTarget(
      h,
      { type: "target.add", taskId: bId, value: "10.1.2.3", kind: "host" },
      "移除后可以重新添加同一值",
    );

    // ---------- A4：非法输入 ----------
    console.log("\n---------- A4 非法输入 / 归档 ----------");
    const ctx = validationContext(h);
    expectThrow(
      "validate：target.add 缺 taskId 被拒",
      () => validateHubAction({ type: "target.add", value: "10.0.0.1" }, ctx as never),
      "taskId",
    );
    expectThrow(
      "validate：target.add 空 value 被拒",
      () => validateHubAction({ type: "target.add", taskId: aId, value: "   " }, ctx as never),
      "value",
    );
    expectThrow(
      "validate：target.add 超长 value 被拒",
      () => validateHubAction({ type: "target.add", taskId: aId, value: "a".repeat(257) }, ctx as never),
      "256",
    );
    expectThrow(
      "validate：target.add 非法 kind 被拒",
      () => validateHubAction({ type: "target.add", taskId: aId, value: "x", kind: "domain" }, ctx as never),
      "kind",
    );
    expectThrow(
      "validate：target.add 超长 notes 被拒",
      () => validateHubAction({ type: "target.add", taskId: aId, value: "x", notes: "n".repeat(4097) }, ctx as never),
      "notes",
    );
    check(
      "validate：无上下文时只做结构校验（语义由 Hub/board 兜底）",
      validateHubAction({ type: "target.add", taskId: aId, value: "x" }).type === "target.add",
    );
    expectThrow(
      "validate：target.add 不存在的任务被拒",
      () => validateHubAction({ type: "target.add", taskId: "task-nope", value: "x" }, ctx as never),
      "任务不存在",
    );
    expectThrow(
      "validate：target.update 缺 targetId 被拒",
      () => validateHubAction({ type: "target.update", taskId: aId }, ctx as never),
      "targetId",
    );
    expectThrow(
      "validate：target.update 非法 status 被拒",
      () => validateHubAction({ type: "target.update", taskId: aId, targetId: "x", status: "pwned" }, ctx as never),
      "status",
    );
    expectThrow(
      "validate：target.remove 缺 targetId 被拒",
      () => validateHubAction({ type: "target.remove", taskId: aId }, ctx as never),
      "targetId",
    );

    const dup = await h.hub.dispatch({ type: "target.add", taskId: bId, value: "10.1.2.3", kind: "host" });
    check("Hub：重复目标被拒", !dup.ok && Boolean(dup.error), JSON.stringify(dup));

    const badTask = await h.hub.dispatch({ type: "target.add", taskId: "task-nope", value: "1.2.3.4" });
    check("Hub：不存在的任务不能加目标", !badTask.ok && Boolean(badTask.error), JSON.stringify(badTask));

    const cId = await createTask(h, "归档题 C");
    const archived = await h.hub.dispatch({ type: "task.archive", taskId: cId });
    check("C 归档成功", archived.ok, JSON.stringify(archived));
    eq("C 已归档", Boolean(h.board.getTask(cId)?.archived), true);
    expectThrow(
      "validate：归档任务不能加目标",
      () => validateHubAction({ type: "target.add", taskId: cId, value: "10.9.9.9" }, ctx as never),
      "归档",
    );
    const archivedAdd = await h.hub.dispatch({ type: "target.add", taskId: cId, value: "10.9.9.9" });
    check("Hub：归档任务不能加目标", !archivedAdd.ok && Boolean(archivedAdd.error), JSON.stringify(archivedAdd));
    eq("归档任务目标数仍为 0", h.board.listTargets?.(cId).length, 0);

    // 默认 kind=host；合法值原样保留（不做 CIDR/IP 解析，P4-B 才做）。
    const dId = await createTask(h, "默认 kind 题 D");
    await addTarget(h, { type: "target.add", taskId: dId, value: "example.internal" }, "省略 kind 可添加");
    eq("省略 kind 默认 host", h.board.listTargets?.(dId)[0]?.kind, "host");
    await addTarget(h, { type: "target.add", taskId: dId, value: " 10.0.0.1 ", kind: "host" }, "value 两端空白可接受");
    eq("value 会 trim", h.board.listTargets?.(dId).some((t) => t.value === "10.0.0.1"), true);

    // ---------- A5：denyTargets / scopeNotes 只读 ----------
    console.log("\n---------- A5 denyTargets / scopeNotes ----------");
    await h.hub.dispatch({ type: "task.focus", taskId: dId });
    snap = h.hub.snapshot();
    eq("新任务 denyTargets 默认空数组", JSON.stringify(snap.task?.denyTargets), "[]");
    eq("新任务 scopeNotes 默认 null", snap.task?.scopeNotes, null);

    h.board.raw(
      "UPDATE tasks SET deny_targets = ?, scope_notes = ? WHERE id = ?",
      JSON.stringify(["10.9.9.9", "metadata.internal"]),
      "禁止扫描云元数据",
      dId,
    );
    snap = h.hub.snapshot();
    eq("denyTargets 从库里读出 2 条", snap.task?.denyTargets?.length, 2);
    eq("denyTargets 内容正确", (snap.task?.denyTargets ?? []).join(","), "10.9.9.9,metadata.internal");
    eq("scopeNotes 从库里读出", snap.task?.scopeNotes, "禁止扫描云元数据");

    h.board.raw("UPDATE tasks SET deny_targets = ? WHERE id = ?", "not-json", dId);
    snap = h.hub.snapshot();
    eq("损坏的 denyTargets JSON 不炸，按空数组", JSON.stringify(snap.task?.denyTargets), "[]");

    // ---------- A6：审计 / 事件 ----------
    console.log("\n---------- A6 审计与黑板事件 ----------");
    const auditRows = h.board.raw(
      "SELECT action, COUNT(*) AS c FROM audit WHERE action LIKE 'target.%' GROUP BY action",
    ) as Array<{ action: string; c: number }>;
    const auditMap = new Map(auditRows.map((r) => [r.action, Number(r.c)]));
    check("target.add 写审计", (auditMap.get("target.add") ?? 0) >= 5, JSON.stringify(auditRows));
    check("target.update 写审计", (auditMap.get("target.update") ?? 0) >= 2, JSON.stringify(auditRows));
    check("target.remove 写审计", (auditMap.get("target.remove") ?? 0) >= 1, JSON.stringify(auditRows));

    const eventRows = h.board.raw(
      "SELECT body FROM events WHERE subject IN (?, ?) AND body LIKE '%target.%'",
      aId,
      bId,
    ) as Array<{ body: string }>;
    const bodies = eventRows.map((r) => r.body).join("\n");
    check("target.add 写 events（哈希链）", bodies.includes("target.added"));
    check("target.update 写 events", bodies.includes("target.updated"));
    check("target.remove 写 events", bodies.includes("target.removed"));

    const legal = validateHubAction(
      { type: "target.add", taskId: aId, value: " 1.2.3.4 ", kind: "host", notes: "ok" },
      ctx as never,
    );
    eq("validate：合法 target.add 通过", legal.type, "target.add");
    eq("validate：value 被 trim", (legal as { value: string }).value, "1.2.3.4");

    console.log("\n---------- A7 旧快照兼容 ----------");
    const legacyTask = {
      id: "legacy",
      title: "旧快照任务",
      brief: "",
      status: "open",
      answer: null,
      solvedBy: null,
      createdAt: 0,
    } as TaskView;
    check("旧 TaskView 没有 targets 字段也不炸", legacyTask.targets === undefined);
    check("targets 是可选字段（旧 snapshot 兼容）", "targets" in (snap.task ?? {}) === true);
  } finally {
    h.cleanup();
  }

  // P4-B：纯函数层（不依赖上面的 Hub 夹具）。
  partB();

  // P4-C：策略判定 / 作用域 / 审计（先红后绿）。
  await partC();

  // P4-C 批次 2：审批卡字段 / 误报降级。
  await partD();

  // P4-D 批次 2：本地代理（真实本地服务器 + curl）。
  await partE();

  // P6-B 批次 2a：代理状态机 / 快照 / 事件（真实启停 + kill 子进程）。
  await partF();

  // V2-P0-5：任务级范围数据 / allowedActions / 审批审计目标。
  await partG();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * V2-P0-5：范围数据编辑 + allowedActions 前置校验 + 审批审计目标。
 */
async function partG(): Promise<void> {
  console.log("\n================ V2-P0-5 G 组：denyTargets / allowedActions / 审批审计 ================\n");
  const dir = mkdtempSync(join(tmpdir(), "v2-scope-g-"));
  const board = Blackboard.open(join(dir, "board.db"));
  const stubSessions = {
    listSessions: () => [],
    historyOf: () => [],
  } as unknown as SessionManager;
  const hub = new HubService({
    board,
    sessions: stubSessions,
    bus: new EventBus(),
    workspaceRoot: dir,
    workDir: dir,
    specFor: () => null,
    convergeGraceMs: 0,
  });
  try {
    const created = await hub.dispatch({ type: "task.create", title: "范围数据", brief: "" });
    check("G1 创建任务", created.ok, JSON.stringify(created));
    const taskId = hub.currentTaskId!;

    const updated = await hub.dispatch({
      type: "task.scope.update",
      taskId,
      denyTargets: ["10.9.9.9", "metadata.internal"],
      scopeNotes: "只打 10.0.0.0/8；deny 优先",
      allowedActions: ["terminal/exec", "fs/write"],
    });
    check("G1 task.scope.update 成功", updated.ok, JSON.stringify(updated));
    const scope = board.getTaskScope(taskId);
    eq("G1 denyTargets 落库", (scope?.denyTargets ?? []).join(","), "10.9.9.9,metadata.internal");
    eq("G1 scopeNotes 落库", scope?.scopeNotes, "只打 10.0.0.0/8；deny 优先");
    eq("G1 allowedActions 落库", (scope?.allowedActions ?? []).join(","), "terminal/exec,fs/write");
    const view = hub.currentTaskView();
    eq("G1 TaskView.allowedActions", (view?.allowedActions ?? []).join(","), "terminal/exec,fs/write");
    const audits = board.raw(
      "SELECT detail FROM audit WHERE action = 'task.scope.update'",
    ) as Array<{ detail: string }>;
    check("G1 审计记录范围数据", audits.some((a) => a.detail.includes("10.9.9.9") && a.detail.includes("terminal/exec")), JSON.stringify(audits));

    const badArray = await hub.dispatch({
      type: "task.scope.update",
      taskId,
      denyTargets: "10.9.9.9" as never,
    });
    check("G2 非数组 denyTargets 被拒", badArray.ok === false, JSON.stringify(badArray));
    const badEmpty = await hub.dispatch({
      type: "task.scope.update",
      taskId,
      allowedActions: ["" as never],
    });
    check("G2 空 allowedActions 项被拒", badEmpty.ok === false, JSON.stringify(badEmpty));
    const badNotes = await hub.dispatch({
      type: "task.scope.update",
      taskId,
      scopeNotes: "x".repeat(5000),
    });
    check("G2 超长 scopeNotes 被拒", badNotes.ok === false, JSON.stringify(badNotes));

    // 归档任务拒绝。
    const arch = await hub.dispatch({ type: "task.archive", taskId, force: true });
    if (arch.ok) {
      const archivedUpdate = await hub.dispatch({
        type: "task.scope.update",
        taskId,
        denyTargets: ["10.1.1.1"],
      });
      check("G3 归档任务拒绝范围更新", archivedUpdate.ok === false, JSON.stringify(archivedUpdate));
    } else {
      check("G3 归档任务拒绝范围更新（归档前置失败，跳过）", true, JSON.stringify(arch));
    }

    // allowedActions 策略前置校验。
    const engine = new PolicyEngine({
      repoRoot: REPO,
      packId: "competition",
      scope: scopeCfg(true, "approve"),
    });
    const notAllowed = evalScope(engine, {
      action: "terminal/exec",
      sessionId: "s-g",
      tier: "autonomous",
      detail: { command: "echo hi" },
      inScope: "in",
      allowedActions: ["fs/write"],
    });
    check(
      "G4 allowedActions 未包含动作 → 转人工",
      notAllowed.verdict === "approve" && notAllowed.rule === "action-not-allowed",
      JSON.stringify(notAllowed),
    );
    const allowed = evalScope(engine, {
      action: "terminal/exec",
      sessionId: "s-g",
      tier: "autonomous",
      detail: { command: "echo hi" },
      inScope: "in",
      allowedActions: ["terminal/exec"],
    });
    check(
      "G4 allowedActions 包含动作 → 走旧规则（自主档 allow）",
      allowed.verdict === "allow",
      JSON.stringify(allowed),
    );
    const blocked = evalScope(engine, {
      action: "terminal/exec",
      sessionId: "s-g",
      tier: "autonomous",
      detail: { command: "cobaltstrike" },
      inScope: "in",
      allowedActions: ["terminal/exec"],
    });
    check(
      "G4 硬阻断优先于 allowedActions",
      blocked.verdict === "block",
      JSON.stringify(blocked),
    );
    const disabledEngine = new PolicyEngine({
      repoRoot: REPO,
      packId: "competition",
      scope: scopeCfg(false, "approve"),
    });
    const disabled = evalScope(disabledEngine, {
      action: "terminal/exec",
      sessionId: "s-g",
      tier: "autonomous",
      detail: { command: "echo hi" },
      inScope: "in",
      allowedActions: ["fs/write"],
    });
    check(
      "G4 scope 关闭时忽略 allowedActions（旧行为）",
      disabled.verdict === "allow",
      JSON.stringify(disabled),
    );

    // 审批审计：目标 + 决定 + 最终状态都可在 audit 查到。
    board.upsertApproval({
      id: "ap-g-1",
      taskId,
      sessionId: "s-g",
      action: "terminal/exec",
      command: "curl http://10.9.9.9/",
      intentSummary: "验证范围",
      risk: "medium",
      rule: "no-out-of-scope",
      status: "approved",
      decidedBy: "human",
      decidedAt: Date.now(),
      createdAt: Date.now(),
      scopeTarget: { kind: "host", value: "10.9.9.9" },
    });
    const apAudit = board.raw(
      "SELECT detail FROM audit WHERE action = 'approval.approved'",
    ) as Array<{ detail: string }>;
    check(
      "G5 审批审计含目标/规则/决定",
      apAudit.some(
        (a) =>
          a.detail.includes("10.9.9.9") &&
          a.detail.includes("no-out-of-scope") &&
          a.detail.includes("human"),
      ),
      JSON.stringify(apAudit),
    );
  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  check("A 组运行未崩溃", false, (err as Error).message ?? String(err));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
  process.exitCode = 1;
});
