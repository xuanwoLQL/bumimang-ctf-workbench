/**
 * P2-A 技能索引 / 路径安全 / 配置 / 快照字段验收（A/B/C 三组）。
 *
 * A：索引构建 —— 用 .ui-run/skills-fixture 的最小技能目录，断言 docs/wps/scripts、
 *    packages、builtAt、构建日志、只读头几行、懒构建缓存。
 * B：路径越界 —— ../、绝对路径、盘符、NUL、symlink/junction、扩展名、大小上限。
 * C：未配置 —— 解析顺序、config 默认值、configured=false 的可读错误、快照字段不炸。
 *
 * 不测 skill_search/skill_read/run_weapon（P2-B 再写）。
 * 不读取真实 D:\agent\skill；全部使用 .ui-run 下的 fixture。
 *
 * 用法：npm run verify:skills
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadAppConfig } from "../main/config/loader.ts";
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  MAX_SKILL_FILE_BYTES,
  resolveWithinRoot,
  isSafePath,
  type SkillPathErrorCode,
} from "../main/skill/paths.ts";
import {
  buildSkillIndex,
  createSkillRuntime,
  resolveSkillRoot,
  withSkillStatus,
  type SkillDoc,
} from "../main/skill/index.ts";
import { skillSearch, skillRead, skillList } from "../main/skill/tools.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager } from "../main/session/manager.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { buildBriefing } from "../main/briefing/build.ts";
import type { HubSnapshot } from "../../../../packages/shared-protocol/events.ts";

const ROOT = process.cwd();
const RUN = path.join(ROOT, ".ui-run");
const FIXTURE = path.join(RUN, "skills-fixture");
const OUTSIDE = path.join(RUN, "skills-fixture-outside");
const CONFIG_REPO = path.join(RUN, "skills-config-repo");
const RESOLVE = path.join(RUN, "skills-resolve");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function rejected(
  name: string,
  fn: () => unknown,
  expectedCode?: SkillPathErrorCode,
): void {
  try {
    fn();
    check(name, false, "未抛错（应拒绝）");
  } catch (err) {
    const e = err as Error & { code?: string };
    const codeOk = expectedCode ? e.code === expectedCode : true;
    check(name, codeOk, `${e.name}/${e.code ?? "?"}: ${e.message}`);
  }
}

function file(rel: string, content: string): string {
  const p = path.join(FIXTURE, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

function fullEnv(extra: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...base, ...extra };
}

/** 用真实 MCP stdio 客户端拉一次 tools/list（不触发任何 skill 调用，不需要桥）。 */
async function listMcpTools(extra: Record<string, string>): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "apps", "desktop", "src", "main", "mcp-host", "server.ts")],
    env: fullEnv({
      BUMIMANG_PIPE: "\\\\.\\pipe\\bumimang-verify-skills-none",
      BUMIMANG_TOKEN: "verify-tools-list",
      BUMIMANG_SESSION: "verify-skills",
      ...extra,
    }),
    stderr: "pipe",
    cwd: ROOT,
  });
  const client = new Client({ name: "verify-skills", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.listTools();
    return res.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** 错误令牌：桥应直接断开连接，不返回任何 result。 */
function rawBadHello(pipeName: string, token: string, sessionId: string): Promise<{ closed: boolean; result: unknown }> {
  return new Promise((resolve) => {
    const sock = connect(pipeName);
    let buf = "";
    let result: unknown = null;
    let done = false;
    const finish = (closed: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ closed, result });
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id: 0, method: "board.hello", token, sessionId }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        try {
          result = (JSON.parse(buf.slice(0, i)) as { result?: unknown }).result ?? null;
        } catch {
          result = null;
        }
      }
    });
    sock.on("close", () => finish(true));
    sock.on("error", () => undefined);
    setTimeout(() => finish(false), 2000);
  });
}

/** 正确令牌：hello 通过后连续发若干 RPC，收集结果。 */
function rawCalls(
  pipeName: string,
  token: string,
  sessionId: string,
  calls: Array<{ id: number; method: string; params: Record<string, unknown> }>,
): Promise<Record<number, Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const sock = connect(pipeName);
    const out: Record<number, Record<string, unknown>> = {};
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id: 0, method: "board.hello", token, sessionId }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        if (msg.id === 0) {
          if (msg.error) {
            sock.destroy();
            reject(new Error(msg.error));
            return;
          }
          for (const c of calls) sock.write(JSON.stringify(c) + "\n");
          continue;
        }
        if (msg.error) {
          out[msg.id] = { __error: msg.error };
        } else {
          out[msg.id] = (msg.result ?? {}) as Record<string, unknown>;
        }
        if (Object.keys(out).length === calls.length) {
          sock.destroy();
          resolve(out);
        }
      }
    });
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, 5000);
  });
}

function setupFixture(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  rmSync(CONFIG_REPO, { recursive: true, force: true });
  rmSync(RESOLVE, { recursive: true, force: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(path.join(OUTSIDE, "secret.txt"), "outside secret\n", "utf8");
  // E 组 junction 用例用 .md：先过扩展名白名单，再在 realpath 复核时被 escape 拒绝。
  writeFileSync(path.join(OUTSIDE, "secret.md"), "outside secret md\n", "utf8");

  file("skills/ctf-0day/SKILL.md", "# ctf-0day 技能\n\n用于 fixture 的 0day 技能入口。\n");
  file("skills/ctf-0day/知识库/SSTI.md", "# SSTI 知识库\n\n模板注入：先测 {{7*7}} 与 ${7*7}。\n");
  const longLines = ["# 长文档", ""];
  for (let i = 1; i <= 60; i++) longLines.push(`第 ${i} 行：普通占位内容`);
  longLines[51] = "DEEP-MARKER-SHOULD-NOT-BE-INDEXED";
  file("skills/ctf-0day/知识库/long.md", longLines.join("\n") + "\n");
  file("skills/ctf-solver/SKILL.md", "# ctf-solver 技能\n\n用于 fixture 的 CTF 解题入口。\n");
  file("skills/ctf-solver/SSTI.idx.md", "# SSTI 索引\n\n- SSTI.md\n- SSTI.idx.md\n");
  file("skills/ctf-solver/PAYLOAD-CHEATSHEET.md", "# Payload Cheatsheet\n\n{{7*7}}\n");
  file("skills/ctf-solver/AI-SEARCH-INDEX.md", "# AI Search Index\n\nSSTI 关键词。\n");
  file(
    "skills/ctf-solver/wp-index.jsonl",
    [
      JSON.stringify({
        id: "fixture-wp-1",
        title: "Fixture SSTI WP",
        contest: "FixtureCTF 2026",
        year: "2026",
        category: "web",
        tags: ["SSTI", "Jinja2"],
        upstream_path: "CTF大赛WP集合/fixture-1.md",
        one_liner: "fixture one liner",
      }),
      JSON.stringify({
        id: "fixture-wp-2",
        title: "Fixture Crypto WP",
        contest: "FixtureCTF 2026",
        year: "2026",
        category: "crypto",
        tags: ["RSA"],
        local_path: "CTF大赛WP集合/fixture-2.md",
      }),
    ].join("\n") + "\n",
  );
  file(
    "skills/ctf-solver/script-index.jsonl",
    JSON.stringify({
      name: "x.py",
      package: "fixture-tools",
      relative_path: "tools/x.py",
      upstream_path: "CTF常用脚本及工具/tools/x.py",
      size: 123,
      lines: 4,
      description: "fixture script",
    }) + "\n",
  );
  file("skills/ctf-solver/data.json", "{\"fixture\":true}\n");
  file("skills/ctf-solver/evil.exe", "MZ fixture\n");

  // junction 逃逸样本：link-out -> .ui-run/skills-fixture-outside
  try {
    symlinkSync(OUTSIDE, path.join(FIXTURE, "skills", "ctf-solver", "link-out"), "junction");
  } catch (err) {
    check("B：创建 junction 逃逸样本", false, (err as Error).message);
  }
  // 文件 symlink 需要额外权限；能建就测，不能建不当作失败（junction 已覆盖真实逃逸）。
  try {
    symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(FIXTURE, "skills", "ctf-solver", "link-file.md"), "file");
  } catch {
    /* 无权限时跳过；junction 用例仍在 */
  }
}

function setupConfigRepo(): void {
  mkdirSync(path.join(CONFIG_REPO, "config"), { recursive: true });
  writeFileSync(
    path.join(CONFIG_REPO, "config", "app.json"),
    JSON.stringify({
      skillDir: "skills-local",
      skill: { allowRunWeapon: true, mcpMode: "on" },
    }),
    "utf8",
  );
}

function setupResolveDirs(): void {
  for (const name of ["env", "config", "dev"]) {
    mkdirSync(path.join(RESOLVE, name), { recursive: true });
  }
  mkdirSync(path.join(RESOLVE, "packaged", "app-source", "skill"), { recursive: true });
}

function docKindCount(docs: SkillDoc[], kind: SkillDoc["kind"]): number {
  return docs.filter((d) => d.kind === kind).length;
}

setupFixture();
setupConfigRepo();
setupResolveDirs();

// ---------------------------------------------------------------- A 索引构建
console.log("\n================ A 索引构建（fixture）================\n");
{
  const fixtureRoot = realpathSync(FIXTURE);
  const logs: string[] = [];
  const index = buildSkillIndex(fixtureRoot, { log: (line) => logs.push(line) });

  eq("A：索引根目录是 realpath", index.root, fixtureRoot);
  eq("A：发现两个技能包", index.packages.join(","), "ctf-0day,ctf-solver");
  eq("A：docs 总数与目录一致", index.docs.length, 7);
  eq("A：SKILL.md 数量", docKindCount(index.docs, "skill"), 2);
  eq("A：知识库文档数量", docKindCount(index.docs, "knowledge"), 2);
  eq("A：idx 文档数量", docKindCount(index.docs, "idx"), 1);
  eq("A：cheatsheet 数量", docKindCount(index.docs, "cheatsheet"), 1);
  eq("A：search-index 数量", docKindCount(index.docs, "search-index"), 1);
  const sstiDoc = index.docs.find((d) => d.path === "skills/ctf-0day/知识库/SSTI.md");
  eq("A：知识库文档标题", sstiDoc?.title, "SSTI 知识库");
  check("A：知识库文档只带摘要", (sstiDoc?.text.length ?? 0) > 0 && (sstiDoc?.text.length ?? 0) < 4000, `len=${sstiDoc?.text.length}`);
  const longDoc = index.docs.find((d) => d.path === "skills/ctf-0day/知识库/long.md");
  check("A：只读前 N 行，深层标记未被索引", !!longDoc && !longDoc.text.includes("DEEP-MARKER-SHOULD-NOT-BE-INDEXED"), `len=${longDoc?.text.length}`);
  eq("A：wps 数量", index.wps.length, 2);
  eq("A：wps 第一条 id", index.wps[0]?.id, "fixture-wp-1");
  eq("A：wps 第一条 title", index.wps[0]?.title, "Fixture SSTI WP");
  eq("A：wps tags 解析", index.wps[0]?.tags.join(","), "SSTI,Jinja2");
  eq("A：wps path 取 upstream_path", index.wps[0]?.path, "CTF大赛WP集合/fixture-1.md");
  eq("A：scripts 数量", index.scripts.length, 1);
  eq("A：script name", index.scripts[0]?.name, "x.py");
  eq("A：script relativePath", index.scripts[0]?.relativePath, "tools/x.py");
  eq("A：script package", index.scripts[0]?.package, "fixture-tools");
  eq("A：script size", index.scripts[0]?.size, 123);
  eq("A：script lines", index.scripts[0]?.lines, 4);
  check("A：builtAt > 0", index.builtAt > 0, `builtAt=${index.builtAt}`);
  check("A：durationMs 已记录", index.durationMs >= 0, `durationMs=${index.durationMs}`);
  eq("A：fileCount 与目录一致", index.fileCount, 11);
  check("A：totalBytes > 0", index.totalBytes > 0, `totalBytes=${index.totalBytes}`);
  const logText = logs.join("\n");
  check("A：构建日志含文件数/字节数/耗时", /files=\d+/.test(logText) && /bytes=\d+/.test(logText) && /耗时=\d+ms/.test(logText), logText.split("\n")[0]);

  const runtime = createSkillRuntime({
    env: { BUMIMANG_SKILL_DIR: fixtureRoot },
    log: () => {},
  });
  const before = runtime.status();
  eq("A：懒构建前 builtAt=null", before.builtAt, null);
  eq("A：懒构建前 configured=true", before.configured, true);
  const built = runtime.ensureIndex();
  const after = runtime.status();
  check("A：懒构建后 builtAt > 0", after.builtAt === built.builtAt && after.builtAt > 0, `builtAt=${after.builtAt}`);
  check("A：重复 ensureIndex 复用缓存", runtime.ensureIndex() === built);
}

// ---------------------------------------------------------------- B 路径越界
console.log("\n================ B 路径越界 ================\n");
{
  const root = realpathSync(FIXTURE);
  const okSkill = resolveWithinRoot(root, "skills/ctf-0day/SKILL.md", { allowedExtensions: DEFAULT_ALLOWED_EXTENSIONS });
  eq("B：合法相对路径解析到 realpath", okSkill, realpathSync(path.join(FIXTURE, "skills/ctf-0day/SKILL.md")));
  check("B：中文目录合法路径通过", isSafePath(root, "skills/ctf-0day/知识库/SSTI.md"));
  check("B：.json 扩展名通过", isSafePath(root, "skills/ctf-solver/data.json", { allowedExtensions: DEFAULT_ALLOWED_EXTENSIONS }));

  rejected("B：拒绝空路径", () => resolveWithinRoot(root, ""), "empty");
  rejected("B：拒绝 ../ 逃逸", () => resolveWithinRoot(root, "../skills-fixture-outside/secret.txt"), "traversal");
  rejected("B：拒绝反斜杠 .. 逃逸", () => resolveWithinRoot(root, "..\\skills-fixture-outside\\secret.txt"), "traversal");
  rejected("B：拒绝中途 .. 逃逸", () => resolveWithinRoot(root, "skills/ctf-0day/../../skills-fixture-outside/secret.txt"), "traversal");
  rejected("B：拒绝盘符路径", () => resolveWithinRoot(root, "D:/not-the-skill-root/SKILL.md"), "drive");
  rejected("B：拒绝 Windows 绝对路径", () => resolveWithinRoot(root, "C:\\Windows\\win.ini"), "drive");
  rejected("B：拒绝 POSIX 绝对路径", () => resolveWithinRoot(root, "/etc/passwd"), "absolute");
  rejected("B：拒绝 UNC 路径", () => resolveWithinRoot(root, "\\\\server\\share\\x.md"), "absolute");
  rejected("B：拒绝 NUL", () => resolveWithinRoot(root, "skills/ctf-0day/SKILL.md\0.txt"), "nul");
  rejected("B：拒绝非白名单扩展名", () => resolveWithinRoot(root, "skills/ctf-solver/evil.exe", { allowedExtensions: DEFAULT_ALLOWED_EXTENSIONS }), "extension");
  rejected("B：拒绝不存在的文件", () => resolveWithinRoot(root, "skills/ctf-0day/nope.md"), "missing");
  rejected("B：拒绝 junction 逃逸", () => resolveWithinRoot(root, "skills/ctf-solver/link-out/secret.txt"), "escape");
  if (existsSync(path.join(FIXTURE, "skills", "ctf-solver", "link-file.md"))) {
    rejected("B：拒绝文件 symlink 逃逸", () => resolveWithinRoot(root, "skills/ctf-solver/link-file.md"), "escape");
  } else {
    console.log("SKIP  B：文件 symlink 样本（当前账户无 symlink 权限；junction 已覆盖逃逸）");
  }

  writeFileSync(path.join(FIXTURE, "skills", "ctf-solver", "big.md"), "x".repeat(MAX_SKILL_FILE_BYTES + 1), "utf8");
  rejected(
    "B：拒绝超过 256KB 的文件",
    () => resolveWithinRoot(root, "skills/ctf-solver/big.md", { allowedExtensions: [".md"], maxBytes: MAX_SKILL_FILE_BYTES }),
    "size",
  );
  check("B：isSafePath 对越界返回 false", isSafePath(root, "../skills-fixture-outside/secret.txt") === false);
}

// ---------------------------------------------------------------- C 未配置 / 配置
console.log("\n================ C 未配置 / 配置解析 ================\n");
{
  const loaded = loadAppConfig({ repoRoot: CONFIG_REPO, isPackaged: false, resourcesPath: "", env: {} });
  eq("C：skillDir 相对配置目录解析", loaded.config.skillDir, path.resolve(CONFIG_REPO, "config", "skills-local"));
  eq("C：skill.allowRunWeapon 读取", loaded.config.skill?.allowRunWeapon, true);
  eq("C：skill.mcpMode 读取", loaded.config.skill?.mcpMode, "on");

  const emptyRepo = path.join(RUN, "skills-empty-repo");
  rmSync(emptyRepo, { recursive: true, force: true });
  const defaults = loadAppConfig({ repoRoot: emptyRepo, isPackaged: false, resourcesPath: "", env: {} });
  eq("C：缺省 skillDir 为 undefined", defaults.config.skillDir, undefined);
  eq("C：缺省 allowRunWeapon=false", defaults.config.skill?.allowRunWeapon, false);
  eq("C：缺省 mcpMode=auto", defaults.config.skill?.mcpMode, "auto");

  mkdirSync(path.join(emptyRepo, "config"), { recursive: true });
  writeFileSync(
    path.join(emptyRepo, "config", "app.json"),
    JSON.stringify({ skill: { mcpMode: "bogus", allowRunWeapon: "yes" } }),
    "utf8",
  );
  const invalid = loadAppConfig({ repoRoot: emptyRepo, isPackaged: false, resourcesPath: "", env: {} });
  eq("C：非法 mcpMode 回落 auto", invalid.config.skill?.mcpMode, "auto");
  eq("C：非布尔 allowRunWeapon 回落 false", invalid.config.skill?.allowRunWeapon, false);

  const envDir = path.join(RESOLVE, "env");
  const configDir = path.join(RESOLVE, "config");
  const devDir = path.join(RESOLVE, "dev");
  const packagedResources = path.join(RESOLVE, "packaged");
  const fromEnv = resolveSkillRoot({
    env: { BUMIMANG_SKILL_DIR: envDir },
    configSkillDir: configDir,
    repoRoot: ROOT,
    devSkillDir: devDir,
    isPackaged: true,
    resourcesPath: packagedResources,
  });
  eq("C：解析顺序 env 优先", fromEnv.source, "env");
  eq("C：env 根目录 canonical", fromEnv.root, realpathSync(envDir));

  const fromConfig = resolveSkillRoot({ env: {}, configSkillDir: configDir, devSkillDir: devDir, repoRoot: ROOT, isPackaged: false });
  eq("C：无 env 时 config 优先", fromConfig.source, "config");
  eq("C：config 根目录", fromConfig.root, realpathSync(configDir));

  const fromDev = resolveSkillRoot({ env: {}, configSkillDir: path.join(RESOLVE, "no-config"), devSkillDir: devDir, repoRoot: ROOT, isPackaged: false });
  eq("C：config 缺失时开发态探测", fromDev.source, "dev");

  const fromPackaged = resolveSkillRoot({
    env: {},
    configSkillDir: path.join(RESOLVE, "no-config"),
    devSkillDir: path.join(RESOLVE, "no-dev"),
    repoRoot: ROOT,
    isPackaged: true,
    resourcesPath: packagedResources,
  });
  eq("C：打包态 resources 兜底", fromPackaged.source, "packaged");
  eq("C：打包态根目录", fromPackaged.root, realpathSync(path.join(packagedResources, "app-source", "skill")));

  const badEnv = resolveSkillRoot({
    env: { BUMIMANG_SKILL_DIR: path.join(RESOLVE, "missing-env") },
    configSkillDir: configDir,
    devSkillDir: devDir,
    repoRoot: ROOT,
    isPackaged: false,
  });
  eq("C：显式 env 不存在时 configured=false", badEnv.root, null);
  eq("C：显式 env 不存在时 source=env", badEnv.source, "env");
  check("C：env 错误文案可读", (badEnv.error ?? "").includes("BUMIMANG_SKILL_DIR"), badEnv.error ?? "");

  const none = resolveSkillRoot({
    env: {},
    configSkillDir: path.join(RESOLVE, "no-config"),
    devSkillDir: path.join(RESOLVE, "no-dev"),
    repoRoot: ROOT,
    isPackaged: false,
  });
  eq("C：全部候选缺失 root=null", none.root, null);
  eq("C：全部候选缺失 source=null", none.source, null);
  check("C：未配置错误文案可读", (none.error ?? "").includes("未配置技能库"), none.error ?? "");

  const runtime = createSkillRuntime({
    env: {},
    configSkillDir: path.join(RESOLVE, "no-config"),
    devSkillDir: path.join(RESOLVE, "no-dev"),
    repoRoot: ROOT,
    isPackaged: false,
    log: () => {},
  });
  const status = runtime.status();
  eq("C：未配置 configured=false", status.configured, false);
  eq("C：未配置 root=null", status.root, null);
  eq("C：未配置 packages=[]", status.packages.length, 0);
  eq("C：未配置 builtAt=null", status.builtAt, null);
  check("C：未配置 error 可读", (status.error ?? "").includes("未配置技能库"), status.error ?? "");
  rejected("C：未配置时 ensureIndex 抛可读错误", () => runtime.ensureIndex());

  const base = {
    task: null,
    tasks: [],
    sessions: [],
    approvals: [],
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
    health: {},
    agents: [],
  } as unknown as HubSnapshot;
  const attached = withSkillStatus(base, status);
  eq("C：快照 skill.configured=false", attached.skill.configured, false);
  check("C：快照旧字段保持", attached.task === null && Array.isArray(attached.tasks));
  check("C：快照 skill 可 JSON 序列化", JSON.parse(JSON.stringify(attached)).skill.configured === false);
  check("C：旧快照不带 skill 也不炸", !("skill" in base));
}

// ---------------------------------------------------------------- D 简报注入
console.log("\n================ D 简报注入 ================\n");
{
  const BRIEF_MAX = 8 * 1024;
  const dbFile = path.join(RUN, "skills-briefing.db");
  rmSync(dbFile, { recursive: true, force: true });
  const board = Blackboard.open(dbFile);
  const skill = { configured: true, root: realpathSync(FIXTURE), packages: ["ctf-0day", "ctf-solver"] };

  const webTask = board.createTask({ title: "D web", brief: "一个门户站，附件是一份源码。", category: "web" });
  const irTask = board.createTask({ title: "D ir", brief: "一台被入侵的服务器，需要应急。", category: "ir" });
  const unknownTask = board.createTask({ title: "D unknown", brief: "来源不明的题。", category: "unknown" });
  const miscTask = board.createTask({ title: "D misc", brief: "杂项题。", category: "misc" });

  const webP = buildBriefing(board, { taskId: webTask.id, role: "lead", sessionId: "d-web", skill });
  const webPBytes = Buffer.byteLength(JSON.stringify(webP), "utf8");
  eq("D：web 简报带 playbook", webP.playbook?.category, "web");
  check("D：web playbook 标题是 Web 检查表", (webP.playbook?.title ?? "").includes("Web"), webP.playbook?.title ?? "");
  check(
    "D：web checklist 10–20 条",
    (webP.playbook?.steps.length ?? 0) >= 10 && (webP.playbook?.steps.length ?? 0) <= 20,
    `steps=${webP.playbook?.steps.length}`,
  );
  const webSteps = (webP.playbook?.steps ?? []).join(" ");
  check("D：web checklist 覆盖 SSTI/上传/目录", webSteps.includes("SSTI") && webSteps.includes("上传") && webSteps.includes("目录"), webSteps.slice(0, 120));
  check("D：web 简报带 skill_routing", (webP.skill_routing?.suggestions.length ?? 0) > 0, `suggestions=${webP.skill_routing?.suggestions.length}`);
  eq("D：skill_routing.root 指向 fixture", webP.skill_routing?.root, realpathSync(FIXTURE));
  check(
    "D：web routing 给出 SSTI 路径提示",
    (webP.skill_routing?.suggestions ?? []).some((s) => s.path.includes("SSTI")),
    JSON.stringify((webP.skill_routing?.suggestions ?? []).map((s) => s.path)),
  );
  check("D：knowledge_tools 可用并带调用示例", webP.knowledge_tools?.available === true && (webP.knowledge_tools?.skill_search?.example ?? "").includes("skill_search"), JSON.stringify(webP.knowledge_tools));
  check("D：evidence_convention 完整", !!webP.evidence_convention?.E0 && !!webP.evidence_convention?.E1 && !!webP.evidence_convention?.E2 && !!webP.evidence_convention?.rule);
  check("D：简报序列化 ≤ 8KB", webPBytes <= BRIEF_MAX, `bytes=${webPBytes}`);
  check("D：旧字段仍保留", Array.isArray(webP.facts_verified) && Array.isArray(webP.dead_ends) && Array.isArray(webP.do_not) && !!webP.sync_protocol);

  const irP = buildBriefing(board, { taskId: irTask.id, role: "verify", sessionId: "d-ir", skill });
  const irSteps = (irP.playbook?.steps ?? []).join(" ");
  check("D：ir playbook 是应急检查表", (irP.playbook?.title ?? "").includes("应急"), irP.playbook?.title ?? "");
  check("D：ir checklist 含日志/时间线/取证", irSteps.includes("日志") && irSteps.includes("时间线") && irSteps.includes("取证"), irSteps.slice(0, 120));

  const unknownP = buildBriefing(board, { taskId: unknownTask.id, role: "recon", sessionId: "d-unknown", skill });
  check("D：unknown 走通用 checklist", (unknownP.playbook?.title ?? "").includes("通用"), unknownP.playbook?.title ?? "");
  check(
    "D：unknown 通用 checklist 仍 10–20 条",
    (unknownP.playbook?.steps.length ?? 0) >= 10 && (unknownP.playbook?.steps.length ?? 0) <= 20,
    `steps=${unknownP.playbook?.steps.length}`,
  );

  const webReconP = buildBriefing(board, { taskId: webTask.id, role: "recon", sessionId: "d-web-recon", skill });
  check(
    "D：角色会改变检查表（lead ≠ recon）",
    (webP.playbook?.steps ?? []).join("|") !== (webReconP.playbook?.steps ?? []).join("|"),
    `lead=${webP.playbook?.steps.length} recon=${webReconP.playbook?.steps.length}`,
  );

  const noSkill = buildBriefing(board, {
    taskId: webTask.id,
    role: "lead",
    sessionId: "d-none",
    skill: { configured: false, root: null, packages: [] },
  });
  check("D：未配置技能库时 skill_routing 明确写“无技能库”", (noSkill.skill_routing?.note ?? "").includes("无技能库"), noSkill.skill_routing?.note ?? "");
  eq("D：未配置技能库时 knowledge_tools.available=false", noSkill.knowledge_tools?.available, false);
  eq("D：未配置技能库时 playbook 仍存在", noSkill.playbook?.category, "web");
  const noSkillBytes = Buffer.byteLength(JSON.stringify(noSkill), "utf8");
  check("D：未配置技能库时简报仍 ≤ 8KB", noSkillBytes <= BRIEF_MAX, `bytes=${noSkillBytes}`);

  // 小黑板基线：同 category/role 的 suggestions 数量，用来对比超长时是否被截断。
  const miscBase = buildBriefing(board, { taskId: miscTask.id, role: "recon", sessionId: "d-misc-base", skill });
  const baseSuggestionCount = miscBase.skill_routing?.suggestions.length ?? 0;

  // 超大黑板：40 条死路 + 40 条事实 + 5KB brief，强制触发截断。
  const bigTask = board.createTask({ title: "D big", brief: "B".repeat(5000), category: "misc" });
  for (let i = 0; i < 40; i++) {
    board.declareDeadEnd({
      taskId: bigTask.id,
      sessionId: "d-big",
      description: `死路 ${i}：` + "这条路已经试过但走不通，原因写在这里。".repeat(8),
    });
    board.submitFact({
      taskId: bigTask.id,
      sessionId: "d-big",
      content: `事实 ${i}：` + "已确认的细节内容。".repeat(10),
      witness: `evidence/fact-${i}.txt`,
    });
  }
  const bigP = buildBriefing(board, { taskId: bigTask.id, role: "recon", sessionId: "d-big", skill });
  const bigBytes = Buffer.byteLength(JSON.stringify(bigP), "utf8");
  check("D：超大黑板序列化仍 ≤ 8KB", bigBytes <= BRIEF_MAX, `bytes=${bigBytes}`);
  check("D：超长时 evidence_convention 未被截断", !!bigP.evidence_convention?.E0 && !!bigP.evidence_convention?.E1 && !!bigP.evidence_convention?.E2 && !!bigP.evidence_convention?.rule);
  eq("D：超长时 do_not 条目不丢", bigP.do_not.length, 40);
  check(
    "D：超长时 suggestions 被截断",
    (bigP.skill_routing?.suggestions.length ?? 0) < baseSuggestionCount,
    `base=${baseSuggestionCount} big=${bigP.skill_routing?.suggestions.length}`,
  );
  check("D：超长时 board 展示被截断", bigP.facts_verified.length < 40 || bigP.dead_ends.length < 40, `facts=${bigP.facts_verified.length} dead=${bigP.dead_ends.length}`);
  check("D：超长时 playbook 仍在", (bigP.playbook?.steps.length ?? 0) >= 10, `steps=${bigP.playbook?.steps.length}`);

  // 旧调用路径（不传 skill）：不能崩，按“未配置技能库”处理。
  const legacy = buildBriefing(board, { taskId: webTask.id, role: "lead", sessionId: "d-legacy" });
  check("D：不传 skill 的旧调用不崩且标注无技能库", (legacy.skill_routing?.note ?? "").includes("无技能库") && !!legacy.playbook);

  board.close();
}

// ---------------------------------------------------------------- E MCP 技能工具
console.log("\n================ E MCP 技能工具 ================\n");
{
  const root = realpathSync(FIXTURE);
  const index = buildSkillIndex(root, { log: () => {} });

  const hits = skillSearch(index, "SSTI");
  check(
    "E：skill_search(\"SSTI\") 命中 SSTI 路径",
    hits.some((h) => h.path.includes("SSTI")),
    JSON.stringify(hits.slice(0, 3).map((h) => `${h.kind}:${h.path}`)),
  );
  check(
    "E：命中字段完整（path/line/snippet/title/kind/score）",
    hits.every(
      (h) =>
        typeof h.path === "string" &&
        typeof h.line === "number" &&
        typeof h.snippet === "string" &&
        typeof h.title === "string" &&
        typeof h.kind === "string" &&
        typeof h.score === "number",
    ),
    `hits=${hits.length}`,
  );
  const wp = skillSearch(index, "SSTI", "wp");
  check("E：source=wp 只返回 wp-index 命中", wp.length > 0 && wp.every((h) => h.kind === "wp"), JSON.stringify(wp.map((h) => h.kind)));
  const scripts = skillSearch(index, "x.py", "scripts");
  check("E：source=scripts 只返回 script-index 命中", scripts.length > 0 && scripts.every((h) => h.kind === "script"), JSON.stringify(scripts.map((h) => h.kind)));
  const core = skillSearch(index, "SSTI", "core");
  check("E：source=core 不含 wp/scripts", core.length > 0 && core.every((h) => h.kind !== "wp" && h.kind !== "script"), JSON.stringify(core.map((h) => h.kind)));
  eq("E：limit 生效", skillSearch(index, "SSTI", "all", 1).length, 1);

  const read = skillRead(root, "skills/ctf-0day/知识库/SSTI.md");
  check("E：skill_read 正常读", read.content.includes("模板注入"), `len=${read.content.length}`);
  check("E：skill_read 返回 totalLines", read.totalLines >= 1, `totalLines=${read.totalLines}`);
  const sliced = skillRead(root, "skills/ctf-0day/知识库/SSTI.md", 0, 1);
  eq("E：offset/limit 按行切片", sliced.content.split(/\r?\n/).length, 1);

  rejected("E：skill_read 拒绝 ../ 逃逸", () => skillRead(root, "../skills-fixture-outside/secret.txt"), "traversal");
  rejected("E：skill_read 拒绝绝对路径", () => skillRead(root, "/etc/passwd"), "absolute");
  rejected("E：skill_read 拒绝盘符", () => skillRead(root, "D:/x/y.md"), "drive");
  rejected("E：skill_read 拒绝 NUL", () => skillRead(root, "skills/ctf-0day/SKILL.md\0.txt"), "nul");
  rejected("E：skill_read 拒绝 junction 逃逸", () => skillRead(root, "skills/ctf-solver/link-out/secret.md"), "escape");
  if (existsSync(path.join(FIXTURE, "skills", "ctf-solver", "link-file.md"))) {
    rejected("E：skill_read 拒绝文件 symlink 逃逸", () => skillRead(root, "skills/ctf-solver/link-file.md"), "escape");
  } else {
    console.log("SKIP  E：文件 symlink 样本（无 symlink 权限；junction 已覆盖）");
  }

  const bigRead = skillRead(root, "skills/ctf-solver/big.md");
  check(
    "E：超过 256KB 截断并标记",
    bigRead.truncated === true && Buffer.byteLength(bigRead.content, "utf8") <= MAX_SKILL_FILE_BYTES,
    `truncated=${bigRead.truncated} bytes=${Buffer.byteLength(bigRead.content, "utf8")}`,
  );

  const list = skillList(index);
  eq("E：skill_list 返回两个包", list.packages.map((p) => p.name).join(","), "ctf-0day,ctf-solver");
  eq("E：skill_list docs 总数", list.totals.docs, 7);
  eq("E：skill_list 知识库总数", list.totals.knowledge, 2);
  eq("E：skill_list wps 总数", list.totals.wps, 2);
  eq("E：skill_list scripts 总数", list.totals.scripts, 1);
  eq("E：skill_list 按包统计知识库", list.packages.find((p) => p.name === "ctf-0day")?.knowledge, 2);
}

// ---- E2：MCP 注册模式（真实 stdio server + 客户端 tools/list）----
{
  const root = realpathSync(FIXTURE);
  const onTools = await listMcpTools({ BUMIMANG_SKILL_MCP: "on", BUMIMANG_SKILL_DIR: root });
  check(
    "E：BUMIMANG_SKILL_MCP=on 注册 skill_search/skill_read/skill_list",
    ["skill_search", "skill_read", "skill_list"].every((n) => onTools.includes(n)),
    JSON.stringify(onTools),
  );
  const offTools = await listMcpTools({ BUMIMANG_SKILL_MCP: "off", BUMIMANG_SKILL_DIR: root });
  check("E：BUMIMANG_SKILL_MCP=off 不注册 skill_*", !offTools.some((n) => n.startsWith("skill_")), JSON.stringify(offTools));
  check("E：off 时黑板工具仍在", offTools.includes("blackboard_read_since"), JSON.stringify(offTools));
  const autoTools = await listMcpTools({ BUMIMANG_SKILL_MCP: "auto", BUMIMANG_SKILL_DIR: root });
  check("E：auto（默认）注册 skill_*", autoTools.includes("skill_search"), JSON.stringify(autoTools));
}

// ---- E3：桥路由 + 令牌 ----
{
  const root = realpathSync(FIXTURE);
  const dbFile = path.join(RUN, "skills-bridge.db");
  rmSync(dbFile, { recursive: true, force: true });
  const board = Blackboard.open(dbFile);
  const task = board.createTask({ title: "E bridge", brief: "桥路由验收" });
  board.insertSession({ id: "e-s1", taskId: task.id, agent: "fake", role: "lead", tier: "guarded", status: "running" });

  const logs: string[] = [];
  const runtime = createSkillRuntime({ env: { BUMIMANG_SKILL_DIR: root }, log: () => {} });
  const bridge = new BoardBridge({
    board,
    taskId: task.id,
    runId: `skills-e-${Date.now()}`,
    log: (m) => logs.push(m),
    skill: runtime,
  });
  await bridge.start();
  const token = bridge.envForSession("e-s1", task.id).find((e) => e.name === "BUMIMANG_TOKEN")!.value;

  const bad = await rawBadHello(bridge.pipeName, "wrong-token", "e-s1");
  check("E：令牌错误时所有 skill 工具拒绝（连接直接断开）", bad.closed && bad.result === null, `closed=${bad.closed} result=${JSON.stringify(bad.result)}`);

  const good = await rawCalls(bridge.pipeName, token, "e-s1", [
    { id: 1, method: "skill.search", params: { query: "SSTI", source: "all", sessionId: "e-s1" } },
    { id: 2, method: "skill.read", params: { path: "skills/ctf-0day/知识库/SSTI.md", sessionId: "e-s1" } },
    { id: 3, method: "skill.list", params: { sessionId: "e-s1" } },
  ]);
  const searchRes = good[1] as { hits?: Array<{ path: string }>; __error?: string };
  const readRes = good[2] as { content?: string; __error?: string };
  const listRes = good[3] as { packages?: Array<{ name: string }>; __error?: string };
  check("E：带令牌可调用 skill_search", (searchRes?.hits?.length ?? 0) > 0, JSON.stringify(searchRes).slice(0, 200));
  check("E：带令牌可调用 skill_read", (readRes?.content ?? "").includes("模板注入"), JSON.stringify(readRes).slice(0, 200));
  check("E：带令牌可调用 skill_list", (listRes?.packages ?? []).length === 2, JSON.stringify(listRes).slice(0, 200));
  check("E：bridge 记录 skill 工具审计日志", logs.some((l) => l.includes("skill_search")), JSON.stringify(logs.slice(-4)));

  bridge.stop();
  board.close();
}

// ---- E4：SessionManager 接线（首次启动懒构建 + MCP env + 简报）----
{
  const root = realpathSync(FIXTURE);
  const dir = path.join(RUN, "skills-manager");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "work"), { recursive: true });
  const board = Blackboard.open(path.join(dir, "board.db"));
  const task = board.createTask({ title: "E manager", brief: "验会话启动接线", category: "web" });
  const bridge = new BoardBridge({ board, taskId: task.id, runId: `skills-mgr-${Date.now()}`, log: () => {} });
  await bridge.start();

  const runtime = createSkillRuntime({ env: { BUMIMANG_SKILL_DIR: root }, log: () => {} });
  eq("E：首次会话启动前索引未构建", runtime.status().builtAt, null);
  const mgr = new SessionManager({
    board,
    bridge,
    policy: null as never,
    workspaceRoot: dir,
    workRoot: path.join(dir, "work"),
    skill: runtime,
    skillMcpMode: "auto",
    onLine: () => undefined,
  });
  const rec = await mgr.startSession({
    taskId: task.id,
    spec: {
      command: process.execPath,
      args: [path.join(ROOT, "apps", "desktop", "src", "cli", "fake-agent.ts")],
      cwd: path.join(dir, "work"),
      label: "fake-agent",
      env: { FAKE_NO_PERMISSION: "1" },
    },
    agent: "fake",
    role: "lead",
    tier: "guarded",
  });
  check("E：首次会话启动触发 ensureIndex", (runtime.status().builtAt ?? 0) > 0, `builtAt=${runtime.status().builtAt}`);

  await new Promise((r) => setTimeout(r, 150));
  const wire = readFileSync(path.join(dir, "sessions", rec.id, "wire.jsonl"), "utf8");
  check("E：MCP env 注入 BUMIMANG_SKILL_MCP=auto", wire.includes("BUMIMANG_SKILL_MCP") && wire.includes('"value":"auto"'), wire.includes("BUMIMANG_SKILL_MCP") ? "found" : "missing");
  check("E：MCP env 注入 BUMIMANG_SKILL_DIR", wire.includes("BUMIMANG_SKILL_DIR"), wire.includes("BUMIMANG_SKILL_DIR") ? "found" : "missing");

  const packet = await mgr.sendBriefing(rec.id);
  eq("E：manager 简报按 category 注入 playbook", packet.playbook?.category, "web");
  eq("E：manager 简报带技能库根", packet.skill_routing?.root, root);
  check("E：manager 简报 knowledge_tools 可用", packet.knowledge_tools?.available === true);

  await mgr.shutdown();
  bridge.stop();
  board.close();
}

// ---------------------------------------------------------------- F2 内置最小技能库（V2-P0-1）
console.log("\n================ F2 内置最小技能库（打包态兜底）================\n");
{
  const builtinRoot = path.join(ROOT, "skill-builtin");
  check("F2 内置包目录存在", existsSync(builtinRoot), builtinRoot);
  const manifestPath = path.join(builtinRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    kind?: string;
    packages?: string[];
    fileCount?: number;
    totalBytes?: number;
  };
  eq("F2 manifest kind", manifest.kind, "builtin-minimal");
  eq("F2 manifest 包", (manifest.packages ?? []).join(","), "ctf-0day,ctf-solver");
  check("F2 manifest 文件数 > 100", (manifest.fileCount ?? 0) > 100, `fileCount=${manifest.fileCount}`);
  check(
    "F2 内置包 < 15MB（不夹带第三方 WP 全文）",
    (manifest.totalBytes ?? Number.MAX_SAFE_INTEGER) < 15 * 1024 * 1024,
    `totalBytes=${manifest.totalBytes}`,
  );
  const builtin = buildSkillIndex(builtinRoot, { log: () => {} });
  check("F2 内置索引识别 2 个包", builtin.packages.join(",") === "ctf-0day,ctf-solver", JSON.stringify(builtin.packages));
  check("F2 内置索引文档 >= 40", builtin.docs.length >= 40, `docs=${builtin.docs.length}`);
  check("F2 内置索引脚本 >= 5", builtin.scripts.length >= 5, `scripts=${builtin.scripts.length}`);
  check("F2 内置索引不含第三方 WP 全文", builtin.wps.length === 0, `wps=${builtin.wps.length}`);
  check(
    "F2 内置包不含平台接口脚本",
    !existsSync(path.join(builtinRoot, "skills", "ctf-0day", "scripts", "hbc.py")) &&
      !existsSync(path.join(builtinRoot, "skills", "ctf-0day", "scripts", "des_ctf_sync.py")),
    "hbc.py / des_ctf_sync.py 均不存在",
  );
  const packagedRuntime = createSkillRuntime({
    env: {},
    isPackaged: true,
    resourcesPath: path.join(RESOLVE, "packaged"),
    log: () => {},
  });
  eq("F2 打包态来源 packaged", packagedRuntime.status().source, "packaged");
}

// ---------------------------------------------------------------- F 真实库只读探测
console.log("\n================ F 真实库只读探测（不进 verify:all）================\n");
{
  const realRoot = "D:/agent/skill";
  if (!existsSync(realRoot)) {
    console.log("SKIP  F：真实技能库不存在（D:/agent/skill），跳过");
  } else {
    const started = Date.now();
    const real = buildSkillIndex(realRoot, { log: () => {} });
    const durationMs = Date.now() - started;
    console.log(
      `F：真实库索引 root=${real.root} docs=${real.docs.length} wps=${real.wps.length} ` +
        `scripts=${real.scripts.length} files=${real.fileCount} 耗时=${durationMs}ms`,
    );
    check("F：真实库 wps ≥ 1000", real.wps.length >= 1000, `wps=${real.wps.length}`);
    check("F：真实库 scripts ≥ 100", real.scripts.length >= 100, `scripts=${real.scripts.length}`);
    check("F：真实库索引耗时已记录", durationMs >= 0, `durationMs=${durationMs}`);
    const maxExcerpt = real.docs.reduce((m, d) => Math.max(m, d.text.length), 0);
    check("F：真实库只读摘要（不读全文）", maxExcerpt <= 4000, `maxExcerpt=${maxExcerpt}`);
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
if (failed > 0) process.exitCode = 1;