/**
 * P7-A · verify:reliability A 组（启动备份/迁移回滚/哈希链）
 * 不启动 agent、不碰真实 .probe 备份库；全部用临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Blackboard, checkEventChain } from "../main/blackboard/board.ts";
import { backupBeforeOpen, listBackups } from "../main/reliability/backup.ts";
import { resolveWorkDir } from "../main/config/loader.ts";
import { resolveSkillRoot } from "../main/skill/index.ts";
import { ProcessRegistry } from "../main/reliability/process-registry.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { BRIDGE_RPC } from "../main/mcp-host/protocol.ts";
import { SessionManager } from "../main/session/manager.ts";
import { PassthroughPolicy } from "../main/policy/policy.ts";
import { applyEvent, emptyState } from "../renderer/store.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}
function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitOpen(sock: ReturnType<typeof connect>, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket open timeout")), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitLine(sock: ReturnType<typeof connect>, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("socket line timeout")), timeoutMs);
    const onData = (chunk: string): void => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.off("data", onData);
      resolve(buf.slice(0, i));
    };
    sock.on("data", onData);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p7a-reliability-"));
  const backupRoot = path.join(root, "backups");
  process.env.BUMIMANG_BACKUP_DIR = backupRoot;

  // ---------- A1：备份存在且内容一致 ----------
  const db1 = path.join(root, "a1.db");
  let b = Blackboard.open(db1, { backup: false });
  const t = b.createTask({ title: "备份任务", brief: "A1" });
  b.close();
  const before = sha(db1);
  const bak1 = backupBeforeOpen(db1);
  check("A1 备份返回路径", Boolean(bak1), String(bak1));
  check("A1 备份 db 存在", Boolean(bak1 && fs.existsSync(path.join(bak1, "board.db"))));
  check("A1 备份内容 sha256 一致", Boolean(bak1) && sha(path.join(bak1!, "board.db")) === before, before);
  check("A1 listBackups 含本次备份", Boolean(bak1) && listBackups().includes(bak1!));

  // ---------- A2：迁移失败自动恢复，原数据不丢 ----------
  const db2 = path.join(root, "a2.db");
  b = Blackboard.open(db2, { backup: false });
  const t2 = b.createTask({ title: "迁移失败任务", brief: "A2" });
  b.close();
  const raw = new DatabaseSync(db2);
  const tasksBefore = (raw.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  const eventsBefore = (raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  raw.exec(`
    PRAGMA user_version = 2;
    DROP TABLE IF EXISTS flag_sources;
    DROP TABLE IF EXISTS flag_candidates;
    CREATE TABLE flag_candidates (id TEXT PRIMARY KEY);
  `);
  raw.close();
  let threw = false;
  let errMsg = "";
  try {
    Blackboard.open(db2, { backup: true });
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  check("A2 迁移失败抛出可读错误", threw && /备份|迁移/.test(errMsg), errMsg.slice(0, 160));
  const after = new DatabaseSync(db2, { readOnly: true });
  const tasksAfter = (after.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  const eventsAfter = (after.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  after.close();
  check("A2 恢复后 tasks 数量不丢", tasksAfter === tasksBefore, `${tasksBefore}->${tasksAfter}`);
  check("A2 恢复后 events 数量不丢", eventsAfter === eventsBefore, `${eventsBefore}->${eventsAfter}`);
  check("A2 恢复出的任务仍在", tasksAfter >= 1 && eventsAfter >= 1);

  // ---------- A3：滚动清理保留最近 5 份，不删当前 ----------
  const db3 = path.join(root, "a3.db");
  b = Blackboard.open(db3, { backup: false });
  b.createTask({ title: "滚动任务", brief: "A3" });
  b.close();
  const made: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const p = backupBeforeOpen(db3);
    if (p) made.push(p);
    await sleep(5);
  }
  const listed = listBackups();
  check("A3 备份保留 5 份", listed.length === 5, `listed=${listed.length}`);
  check("A3 最新备份仍在", Boolean(made.at(-1)) && listed.includes(made.at(-1)!));
  check("A3 最旧备份已清理", Boolean(made[0]) && !listed.includes(made[0]));

  // ---------- A4：哈希链断裂检测，不自动截断 ----------
  const db4 = path.join(root, "a4.db");
  b = Blackboard.open(db4, { backup: false });
  b.createTask({ title: "链任务", brief: "A4" });
  b.close();
  const raw4 = new DatabaseSync(db4);
  const first = raw4.prepare("SELECT id FROM events ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
  const countBefore4 = (raw4.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  raw4.prepare("UPDATE events SET prev_hash = 'broken' WHERE id = ?").run(first!.id);
  raw4.close();
  const reopened = Blackboard.open(db4, { backup: false });
  const health = reopened.getHealthChain();
  reopened.close();
  const raw4b = new DatabaseSync(db4, { readOnly: true });
  const countAfter4 = (raw4b.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  raw4b.close();
  check("A4 检测到断链", health.ok === false, JSON.stringify(health));
  check("A4 brokenAt 指向首个断点", health.brokenAt === first?.id, `${health.brokenAt} vs ${first?.id}`);
  check("A4 不自动截断事件", countAfter4 === countBefore4, `${countBefore4}->${countAfter4}`);
  check("checkEventChain 独立可用", checkEventChain(new DatabaseSync(db4, { readOnly: true })).ok === false);

  // ---------- B1：残留清理 + PID 复用保护 ----------
  const regFile = path.join(root, "registry", "processes.json");
  const starts = new Map<number, number>([
    [41001, 1000],
    [41002, 1000],
    [41003, 1000],
  ]);
  const alive = new Set([41001, 41002, 41003]);
  const killed: number[] = [];
  const regOpts = {
    filePath: regFile,
    getStartTime: (pid: number) => starts.get(pid) ?? null,
    isAlive: (pid: number) => alive.has(pid),
    killPid: (pid: number) => killed.push(pid),
  };
  const reg1 = new ProcessRegistry(regOpts);
  reg1.registerPid(41001, "agent", { taskId: "t1", sessionId: "s1" });
  reg1.registerPid(41002, "agent", { taskId: "t1", sessionId: "s2" });
  const cleanup1 = new ProcessRegistry(regOpts).cleanupStale();
  check("B1 匹配 PID+启动时间的残留被清理", cleanup1.killed.includes(41001) && cleanup1.killed.includes(41002), JSON.stringify(cleanup1));
  check("B1 清理后登记表为空", new ProcessRegistry(regOpts).list().length === 0);
  new ProcessRegistry(regOpts).registerPid(41003, "agent", { taskId: "t1", sessionId: "s3" });
  starts.set(41003, 9000); // 模拟 PID 复用：OS 启动时间不符
  const killsBeforeReuse = killed.length;
  const cleanupReuse = new ProcessRegistry(regOpts).cleanupStale();
  check("B1 PID 复用不误杀", !cleanupReuse.killed.includes(41003) && killed.length === killsBeforeReuse, JSON.stringify(cleanupReuse));
  starts.set(41004, 1000);
  alive.add(41004);
  const regGuard = new ProcessRegistry(regOpts);
  regGuard.registerPid(41004, "agent", { taskId: "t1", sessionId: "s4" });
  check("B1 isPidCurrent 匹配时为 true", regGuard.isPidCurrent(41004) === true);
  starts.set(41004, 9000);
  check("B1 isPidCurrent 复用时为 false", regGuard.isPidCurrent(41004) === false);

  // ---------- B2：MCP socket 断开 → onMcpUnavailable；revoke 不误报 ----------
  const b2 = Blackboard.open(path.join(root, "b2.db"), { backup: false });
  const task2 = b2.createTask({ title: "MCP 测试", brief: "B2" });
  b2.insertSession({ id: "s-mcp", taskId: task2.id, agent: "claude", role: "lead", tier: "guarded", status: "running" });
  const unavailable: string[] = [];
  const bridge = new BoardBridge({
    board: b2,
    taskId: task2.id,
    runId: `p7b-${Date.now()}`,
    onMcpUnavailable: (sid) => unavailable.push(sid),
  });
  await bridge.start();
  const env = bridge.envForSession("s-mcp", task2.id);
  const token = env.find((e) => e.name === "BUMIMANG_TOKEN")?.value ?? "";
  const sock1 = connect(bridge.pipeName);
  await waitOpen(sock1);
  const hello1 = waitLine(sock1);
  sock1.write(JSON.stringify({ id: 0, method: BRIDGE_RPC.hello, token, sessionId: "s-mcp" }) + "\n");
  const helloLine = await hello1;
  check("B2 MCP hello 成功", helloLine.includes('"ok":true'), helloLine.slice(0, 120));
  sock1.destroy();
  await sleep(250);
  check("B2 MCP 断开触发 onMcpUnavailable", unavailable.includes("s-mcp"), JSON.stringify(unavailable));
  const sock2 = connect(bridge.pipeName);
  await waitOpen(sock2);
  const hello2 = waitLine(sock2);
  sock2.write(JSON.stringify({ id: 0, method: BRIDGE_RPC.hello, token, sessionId: "s-mcp" }) + "\n");
  await hello2;
  const beforeRevoke = unavailable.length;
  bridge.revokeSession("s-mcp");
  await sleep(250);
  check("B2 revoke 不误报 MCP 崩溃", unavailable.length === beforeRevoke, JSON.stringify(unavailable));
  bridge.stop();
  b2.close();

  // ---------- B3：SessionManager 标记 mcpUnavailable + 事件回调 ----------
  const b3 = Blackboard.open(path.join(root, "b3.db"), { backup: false });
  const task3 = b3.createTask({ title: "MCP manager", brief: "B3" });
  b3.insertSession({ id: "s-mgr", taskId: task3.id, agent: "claude", role: "lead", tier: "guarded", status: "running" });
  const events: Array<{ sessionId: string; taskId: string }> = [];
  const mgr = new SessionManager({
    board: b3,
    bridge: {} as BoardBridge,
    policy: new PassthroughPolicy(),
    workspaceRoot: root,
    onMcpUnavailable: (sessionId, taskId) => events.push({ sessionId, taskId }),
  });
  mgr.loadTaskSessions(task3.id);
  // loadTaskSessions 会把非终态恢复会话收敛为 stopped（生产恢复语义）；B3 只测标记逻辑，
  // 这里把测试记录改回 running，不改变产品恢复行为。
  const rec3 = mgr.getSession("s-mgr");
  check("B3 测试会话已载入", Boolean(rec3));
  if (rec3) {
    rec3.status = "running";
    rec3.endedAt = null;
  }
  const marked = mgr.markMcpUnavailable("s-mgr");
  check("B3 manager 标记成功", marked === true);
  check("B3 独立字段 mcpUnavailable=true", mgr.getSession("s-mgr")?.mcpUnavailable === true);
  check("B3 status 不变", mgr.getSession("s-mgr")?.status === "running", String(mgr.getSession("s-mgr")?.status));
  check("B3 事件回调一次", events.length === 1 && events[0]?.sessionId === "s-mgr", JSON.stringify(events));
  check("B3 幂等（第二次 false）", mgr.markMcpUnavailable("s-mgr") === false);
  b3.close();

  // ---------- B4：renderer store 接受 mcp.unavailable ----------
  const st = {
    ...emptyState(),
    task: { id: "t" } as never,
    sessions: [
      {
        id: "s",
        taskId: "t",
        agent: "claude",
        role: "lead",
        tier: "guarded",
        status: "running",
        acpSession: null,
        pid: null,
        model: null,
        startedAt: 0,
        endedAt: null,
      },
    ],
    sessionMeta: { s: { taskId: "t", status: "running" } },
  } as never;
  const afterStore = applyEvent(st, { type: "mcp.unavailable", sessionId: "s", taskId: "t" }) as {
    sessions: Array<{ id: string; mcpUnavailable?: boolean }>;
  };
  check("B4 store 标记 mcpUnavailable", afterStore.sessions[0]?.mcpUnavailable === true, JSON.stringify(afterStore.sessions[0]));

  // ---------- C1：workDir 可移植解析 ----------
  const wdBase = {
    repoRoot: "C:/repo",
    isPackaged: false,
    documentsPath: "C:/Users/x/Documents",
  };
  const wdEnvNew = resolveWorkDir({ ...wdBase, env: { BUMIMANG_WORK_DIR: "C:/tmp/new" } });
  check("C1 BUMIMANG_WORK_DIR 优先", wdEnvNew === path.resolve("C:/tmp/new"), wdEnvNew);
  const wdEnvOld = resolveWorkDir({ ...wdBase, env: { BUMIMANG_WORKDIR: "C:/tmp/old" } });
  check("C1 BUMIMANG_WORKDIR 兼容", wdEnvOld === path.resolve("C:/tmp/old"), wdEnvOld);
  const wdCfg = resolveWorkDir({ ...wdBase, env: {}, configWorkDir: "C:/cfg/work" });
  check("C1 config.workDir 优先于开发态", wdCfg === path.resolve("C:/cfg/work"), wdCfg);
  const wdDev = resolveWorkDir({ ...wdBase, env: {} });
  check("C1 开发态 <repo>/work", wdDev === path.join("C:/repo", "work"), wdDev);
  const wdPkg = resolveWorkDir({ ...wdBase, env: {}, isPackaged: true });
  check("C1 打包态 <documents>/bumimang/work", wdPkg === path.join("C:/Users/x/Documents", "bumimang", "work"), wdPkg);

  // ---------- C2：skillDir 五级解析（复用 skill/index 的现有实现） ----------
  const skillBase = { repoRoot: "C:/repo", devSkillDir: "C:/dev-skill" };
  const envRoot = resolveSkillRoot({
    ...skillBase,
    env: { BUMIMANG_SKILL_DIR: "C:/env-skill" },
    exists: (p) => p === path.resolve("C:/env-skill"),
  });
  check("C2 env 优先", envRoot.source === "env" && envRoot.root === path.resolve("C:/env-skill"), JSON.stringify(envRoot));
  const envMissing = resolveSkillRoot({
    ...skillBase,
    env: { BUMIMANG_SKILL_DIR: "C:/missing" },
    exists: () => false,
  });
  check("C2 env 指向不存在目录直接报错", envMissing.root === null && envMissing.source === "env" && Boolean(envMissing.error), JSON.stringify(envMissing));
  const cfgRoot = resolveSkillRoot({
    ...skillBase,
    env: {},
    configSkillDir: "C:/cfg-skill",
    exists: (p) => p === path.resolve("C:/cfg-skill"),
  });
  check("C2 config 第二级", cfgRoot.source === "config", JSON.stringify(cfgRoot));
  const devRoot = resolveSkillRoot({
    ...skillBase,
    env: {},
    isPackaged: false,
    exists: (p) => path.resolve(p) === path.resolve("C:/dev-skill"),
  });
  check("C2 开发态第三级", devRoot.source === "dev", JSON.stringify(devRoot));
  const pkgRoot = resolveSkillRoot({
    ...skillBase,
    env: {},
    isPackaged: true,
    resourcesPath: "C:/res",
    exists: (p) => p === path.join(path.resolve("C:/res"), "app-source", "skill"),
  });
  check("C2 打包态第四级 resources/app-source/skill", pkgRoot.source === "packaged", JSON.stringify(pkgRoot));
  const noneRoot = resolveSkillRoot({ ...skillBase, env: {}, isPackaged: false, exists: () => false });
  check("C2 全缺省 configured=false", noneRoot.root === null && noneRoot.source === null, JSON.stringify(noneRoot));

  // ---------- C3：config/app.json 无 D:\ 硬编码 ----------
  const appConfigText = fs.readFileSync("config/app.json", "utf8");
  check("C3 config/app.json 无盘符硬编码", !/[A-Za-z]:[\\/]/.test(appConfigText), appConfigText.match(/[A-Za-z]:[\\/][^\"]*/)?.[0] ?? "");

  // ---------- C4：electron-builder 排除测试/文档/证据，并内置最小技能库 ----------
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    build?: { files?: string[]; extraResources?: Array<{ from: string; to: string }> };
  };
  const buildFiles = pkg.build?.files ?? [];
  check("C4 asar 排除 cli/verify/bench", buildFiles.includes("!apps/desktop/src/cli/**"), JSON.stringify(buildFiles));
  check("C4 asar 排除 benchmarks/evidence/docs", ["!benchmarks/**", "!evidence/**", "!docs/**"].every((p) => buildFiles.includes(p)), JSON.stringify(buildFiles));
  // V2-P0-1：旧需求是“skill 外置”，导致安装包无知识库；现在要求内置最小库随包分发。
  const skillRes = (pkg.build?.extraResources ?? []).find((r) => r.to === "app-source/skill");
  check(
    "C4 内置 skill 打包到 app-source/skill",
    skillRes?.from === "skill-builtin" && fs.existsSync("skill-builtin/manifest.json"),
    JSON.stringify(skillRes ?? null),
  );
  check(
    "C4 内置 skill 含路由/知识库索引/脚本索引",
    fs.existsSync("skill-builtin/skills/ctf-0day/SKILL.md") &&
      fs.existsSync("skill-builtin/skills/ctf-solver/SKILL.md") &&
      fs.existsSync("skill-builtin/skills/ctf-solver/AI-SEARCH-INDEX.md") &&
      fs.existsSync("skill-builtin/skills/ctf-0day/scripts/script-index.jsonl"),
    "skill-builtin 关键文件",
  );
  check(
    "C4 内置 skill 不含第三方 WP 全文与平台接口脚本",
    !fs.existsSync("skill-builtin/skills/ctf-solver/CTF大赛WP集合") &&
      !fs.existsSync("skill-builtin/skills/ctf-solver/WP汇总") &&
      !fs.existsSync("skill-builtin/skills/ctf-0day/scripts/hbc.py") &&
      !fs.existsSync("skill-builtin/skills/ctf-0day/scripts/des_ctf_sync.py"),
    "excludes 生效",
  );

  console.log(`\n${pass}/${pass + fail} PASS`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
