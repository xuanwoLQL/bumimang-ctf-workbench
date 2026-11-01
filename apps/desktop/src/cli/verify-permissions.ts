/**
 * 权限增强验收（纯逻辑，无 Electron）：
 *  - 操作分类：文件写入可记住；执行命令 / 删除 / 凭据 / 网络 / 未知默认不可记住；
 *  - highRiskAllowlist 能显式放行高风险动作；
 *  - 按 agent 的永久授权会落盘，重开后仍命中；不同 agent 不串；
 *  - 本会话授权只对当前 session 生效；
 *  - 撤销入口（单条 / 某 agent 全部）真的清掉授权。
 *
 * 运行：node apps/desktop/src/cli/verify-permissions.ts
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_PERMISSION_CONFIG,
  applyWorkRootBoundary,
  profileOperation,
} from "../main/permission/profile.ts";
import type { PermissionConfig } from "../main/permission/profile.ts";
import { PermissionStore } from "../main/permission/store.ts";
import { loadAppConfig } from "../main/config/loader.ts";

let failures = 0;
const rows: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  rows.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}

const writeProfile = profileOperation(
  { kind: "edit", title: "Write demo.txt", rawInput: { filepath: "D:/x/demo.txt", diff: "+hello" } },
  DEFAULT_PERMISSION_CONFIG,
);
const execProfile = profileOperation(
  { kind: "execute", title: "run nmap 10.0.0.9", rawInput: { command: "nmap 10.0.0.9" } },
  DEFAULT_PERMISSION_CONFIG,
);
const deleteProfile = profileOperation(
  { kind: "execute", title: "rm -rf D:/agent/xuanwo/work", rawInput: { command: "rm -rf D:/agent/xuanwo/work" } },
  DEFAULT_PERMISSION_CONFIG,
);
const credentialProfile = profileOperation(
  { kind: "execute", title: "mimikatz sekurlsa::logonpasswords" },
  DEFAULT_PERMISSION_CONFIG,
);
const unknownProfile = profileOperation({ title: "未命名工具调用" }, DEFAULT_PERMISSION_CONFIG);
const readProfile = profileOperation({ kind: "read", title: "Read README.md" }, DEFAULT_PERMISSION_CONFIG);
const networkProfile = profileOperation({ title: "curl https://example.com" }, DEFAULT_PERMISSION_CONFIG);

console.log("\n== 操作分类 / 安全边界 ==");
check("文件写入 → write 且可记住", writeProfile.category === "write" && writeProfile.rememberable, JSON.stringify(writeProfile));
check("读取 → read 且可记住", readProfile.category === "read" && readProfile.rememberable, JSON.stringify(readProfile));
check("执行命令 → execute 且高风险不可记住", execProfile.category === "execute" && !execProfile.rememberable, JSON.stringify(execProfile));
check("删除文件 → 高风险不可记住", deleteProfile.highRisk && !deleteProfile.rememberable, JSON.stringify(deleteProfile));
check("凭据访问 → 高风险不可记住", credentialProfile.highRisk && !credentialProfile.rememberable, JSON.stringify(credentialProfile));
check("网络访问 → 高风险不可记住", networkProfile.highRisk && !networkProfile.rememberable, JSON.stringify(networkProfile));
check("未知操作 → other 且按高风险处理（fail closed）", unknownProfile.category === "other" && !unknownProfile.rememberable, JSON.stringify(unknownProfile));

const allowlistCfg: PermissionConfig = {
  ...DEFAULT_PERMISSION_CONFIG,
  highRiskAllowlist: ["^nmap\\s+10\\.0\\.0\\.9$"],
};
const allowlistedExec = profileOperation(
  { kind: "execute", title: "run nmap 10.0.0.9", rawInput: { command: "nmap 10.0.0.9" } },
  allowlistCfg,
);
check("highRiskAllowlist 命中后允许记住（显式白名单）", allowlistedExec.allowlisted && allowlistedExec.rememberable, JSON.stringify(allowlistedExec));
check("白名单不误伤未命中的命令", !profileOperation({ kind: "execute", title: "rm -rf /" }, allowlistCfg).rememberable);

console.log("\n== 授权持久化 / 作用域 / 撤销 ==");
const dir = mkdtempSync(path.join(tmpdir(), "bumimang-perm-verify-"));
const file = path.join(dir, "permissions.json");
try {
  const store = new PermissionStore({ filePath: file, config: DEFAULT_PERMISSION_CONFIG });
  const agentGrant = store.grant({ agentId: "claude", sessionId: "s1", scope: "agent", profile: writeProfile });
  check("对该 agent 永久允许写入成功", agentGrant.ok, JSON.stringify(agentGrant));
  check("授权文件已落盘", existsSync(file), file);

  const reloaded = new PermissionStore({ filePath: file, config: DEFAULT_PERMISSION_CONFIG });
  check(
    "重开后仍命中该 agent 的同类操作",
    reloaded.match({ agentId: "claude", sessionId: "s99", profile: writeProfile }) !== null,
  );
  check(
    "不同 agent 不会串用授权",
    reloaded.match({ agentId: "codex", sessionId: "s99", profile: writeProfile }) === null,
  );
  check(
    "不同操作类别不会串用授权",
    reloaded.match({ agentId: "claude", sessionId: "s99", profile: readProfile }) === null,
  );
  const anotherWrite = profileOperation({ kind: "edit", title: "Write another.txt" }, DEFAULT_PERMISSION_CONFIG);
  check(
    "同 agent 下换一个文件写入仍命中（按操作类型，不按单条命令全文）",
    reloaded.match({ agentId: "claude", sessionId: "s99", profile: anotherWrite }) !== null,
  );
  check(
    "同类授权不会把执行命令也放行",
    reloaded.match({ agentId: "claude", sessionId: "s99", profile: execProfile }) === null,
  );

  const sessionGrant = reloaded.grant({ agentId: "codex", sessionId: "s2", scope: "session", profile: readProfile });
  check("本会话始终允许写入成功", sessionGrant.ok, JSON.stringify(sessionGrant));
  check(
    "本会话授权只对当前 session 生效",
    reloaded.match({ agentId: "codex", sessionId: "s2", profile: readProfile }) !== null &&
      reloaded.match({ agentId: "codex", sessionId: "s3", profile: readProfile }) === null,
  );

  const rejected = reloaded.grant({ agentId: "claude", sessionId: "s1", scope: "agent", profile: execProfile });
  check("高风险操作拒绝被记住（主进程侧兜底）", rejected.ok === false, rejected.error ?? "");

  const persisted = JSON.parse(readFileSync(file, "utf8")) as { grants: Array<{ agentId: string; category: string }> };
  check(
    "落盘文件只包含 agent 级授权（session 级不落盘）",
    persisted.grants.length === 1 && persisted.grants[0].agentId === "claude" && persisted.grants[0].category === "write",
    JSON.stringify(persisted),
  );

  check("单条撤销生效", reloaded.revoke("claude", "agent:claude:write") === 1 && reloaded.match({ agentId: "claude", sessionId: "s1", profile: writeProfile }) === null);
  check("撤销某 agent 全部授权（含会话级）", reloaded.revoke("codex") === 1 && reloaded.list().filter((g) => g.agentId === "codex").length === 0);

  const reloadedEmpty = new PermissionStore({ filePath: file, config: DEFAULT_PERMISSION_CONFIG });
  check("撤销后重开仍为空（文件同步更新）", reloadedEmpty.list().length === 0, JSON.stringify(reloadedEmpty.list()));

  console.log("\n== 工作目录边界 ==");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const inside = applyWorkRootBoundary(
    writeProfile,
    { kind: "edit", title: "Write demo.txt", rawInput: { filepath: "demo.txt" } },
    workRoot,
  );
  check("工作目录内的写入可记住", inside.rememberable && !inside.highRisk, JSON.stringify(inside));
  const outsideRelative = applyWorkRootBoundary(
    writeProfile,
    { kind: "edit", title: "Write escape.txt", rawInput: { filepath: "../escape.txt" } },
    workRoot,
  );
  check(
    "工作目录外的相对路径写入升级为高风险、不可记住",
    !outsideRelative.rememberable && outsideRelative.highRisk,
    JSON.stringify(outsideRelative),
  );
  const outsideAbsolute = applyWorkRootBoundary(
    writeProfile,
    { kind: "edit", title: "D:/Windows/System32/drivers/etc/hosts", rawInput: { filepath: "D:/Windows/System32/drivers/etc/hosts" } },
    workRoot,
  );
  check(
    "工作目录外的绝对路径写入升级为高风险、不可记住",
    !outsideAbsolute.rememberable && outsideAbsolute.highRisk,
    JSON.stringify(outsideAbsolute),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n== 工作目录配置 ==");
const appCfg = loadAppConfig({ repoRoot: path.resolve(import.meta.dirname, "../../../.."), isPackaged: false, resourcesPath: "" });
check("config/app.json 能解析出 workDir", Boolean(appCfg.config.workDir), JSON.stringify(appCfg));
check("默认工作目录指向 D:/agent/xuanwo/work", appCfg.config.workDir === path.normalize("D:/agent/xuanwo/work"), String(appCfg.config.workDir));

const passed = rows.filter((r) => r.pass).length;
console.log(`\n================ ${passed}/${rows.length} 通过 ================`);
if (failures > 0) process.exitCode = 1;
