/**
 * Agent 检测 —— 架构文档 §6。
 *
 * C3：只检测，不安装。找不到就灰显 + 给一条可复制的安装提示。
 * 原则："检测可以尽力，启动不能猜。"
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentDescriptor {
  id: "opencode" | "codex" | "claude" | "dsh";
  title: string;
  /** ACP 启动方式；未安装时为 null */
  launch: { command: string; args: string[] } | null;
  installed: boolean;
  /** 未安装时给用户复制的安装提示 */
  installHint: string;
  /** 实测到的成熟度备注（§6.2） */
  maturity: string;
  /**
   * 在本应用里，这家 agent 会不会有审批输入（决定 guarded 档有没有东西可拦）。
   *
   * 语义：**选这家 + guarded 档，审批面板会不会有东西**（不是"它原生默认会不会问"）：
   *  - claude：原生就会（写文件/跑命令都发 request_permission）
   *  - opencode：原生不问，但本应用按会话注入 `permission.edit/bash="ask"`
   *    （`OPENCODE_CONFIG_CONTENT`，见 session/manager.ts）
   *  - codex：原生不问，但本应用在 guarded 档下把它切到原生 mode `workspace-write`
   *    （工作区内可写，越界写才问；**Windows 上联网不保证被沙箱拦截**。
   *    `session/set_config_option`，见 session/manager.ts）
   *  - dsh：原生默认 `workspace-write`（不问），但本应用按档位注入
   *    `DSH_PERMISSION_MODE`（guarded → `read-only`，见 session/manager.ts）
   */
  permissionBehavior: "requests_by_default" | "needs_config" | "unknown";
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync("where", [cmd], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/** `where` 的全部结果（npm 会生成 .cmd / .ps1 / 无扩展名三个垫片） */
function whereAll(cmd: string): string[] {
  try {
    return execFileSync("where", [cmd], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && existsSync(s));
  } catch {
    return [];
  }
}

/**
 * 把命令解析成"Node 能直接 spawn 的 (command, args)"。
 *
 * Windows 上的坑：npm 全局包生成的是 `.cmd` / `.ps1` 垫片，Node 的 spawn 不能直接执行
 * `.cmd`（Node 18.20 之后出于安全考虑禁止了）。所以对 `.cmd` 走 `cmd.exe /c`，
 * 真实 `.exe` 才直连。
 */
function resolveLaunch(
  name: string,
  extraArgs: string[] = [],
): { command: string; args: string[] } | null {
  const all = whereAll(name);
  if (!all.length) return null;
  const cmdShim = all.find((p) => p.toLowerCase().endsWith(".cmd"));
  if (cmdShim) {
    return { command: "cmd.exe", args: ["/c", cmdShim, ...extraArgs] };
  }
  const exe = all.find((p) => p.toLowerCase().endsWith(".exe")) ?? all[0];
  return { command: exe, args: extraArgs };
}

/** 用户手填的路径覆盖（最高优先级）—— §6.1 第 1 级 */
function userOverrides(): Record<string, string> {
  const p = join(homedir(), "AppData", "Roaming", "不迷茫", "agents.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------ dsh（T14）

/**
 * dsh 的 CLI 相对「桌面版安装目录」的位置。
 *
 * 为什么不像别家那样找 PATH 上的命令：npm 上的 `@deepseek-ai/dsh-acp` 是 cordis 插件、
 * **没有 bin 字段**，`npm i -g` 永远不会生成 `dsh-acp` 命令（旧版 detect 找的就是它，
 * 设计上必然查不到）。真正的入口是 DeepSeek Harness 桌面版自带的 CLI：
 * `<安装目录>\resources\runtime\cli\bin\dsh.cmd`，`--profile acp` 起出来就是标准
 * ACP v1 stdio server（实测见 docs/DSH-INTEGRATION-RECON.md）。
 * 桌面版自带一个「把 dsh 写进用户 PATH」的管理器，但默认没启用 —— 所以不能指望 PATH。
 */
const DSH_CLI_REL = join("resources", "runtime", "cli", "bin", "dsh.cmd");
/** 安装目录名（默认叫 "DeepSeek Harness"，大小写/分隔符不保证一致） */
const DSH_DIR_RE = /^deepseek[ _-]?harness$/i;

export type DshSource = "override" | "path" | "known" | "registry";

export interface DshDiscovery {
  /** 可直接 spawn 的启动方式；没找到为 null */
  launch: { command: string; args: string[] } | null;
  /** dsh.cmd / dsh.exe 的真实路径 */
  cli: string | null;
  /** 桌面版安装目录（若 CLI 路径符合约定） */
  installDir: string | null;
  /** 命中来源，用于验收断言与排障 */
  source: DshSource | null;
}

export interface DshProbeOptions {
  /** 覆盖「常见安装根目录」列表（验收脚本注入临时目录：证明解析不依赖任何本机路径） */
  roots?: string[];
  /** 跳过注册表探测（验收脚本用，免得把「本机装没装」耦合进断言） */
  skipRegistry?: boolean;
}

/** PATH 上的 dsh / dsh.cmd（桌面版启用那个 PATH 管理器后会有） */
function dshOnPath(): string | null {
  const all = whereAll("dsh");
  return all.find((p) => /\.(cmd|bat)$/i.test(p)) ?? all.find((p) => /\.exe$/i.test(p)) ?? null;
}

/** 已知安装根目录（全部由 env 推导，不写死任何盘符/本机路径） */
function knownInstallRoots(): string[] {
  const roots: string[] = [];
  const push = (p: string | undefined): void => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  push(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined);
  push(process.env.LOCALAPPDATA);
  push(process.env.ProgramFiles);
  push(process.env["ProgramFiles(x86)"]);
  push(process.env.ProgramData);
  // 系统盘根目录：便携版可能直接解在 C:\DeepSeek Harness
  push(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : undefined);
  return roots;
}

/**
 * 在若干根目录下找 dsh.cmd：先试「根目录本身就是安装目录」，再扫它的一级子目录里
 * 名字像 `DeepSeek Harness` 的那种。**只看目录名 + 固定的相对路径**，所以装在任何
 * 位置都成立（本机是 D:\agent\DeepSeek Harness，属于自定义目录）。
 */
export function findDshUnderRoots(roots: string[]): { cli: string; dir: string } | null {
  for (const root of roots) {
    const direct = join(root, DSH_CLI_REL);
    if (existsSync(direct)) return { cli: direct, dir: root };
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // 不存在的根 / 无权限：跳过
    }
    for (const name of entries) {
      if (!DSH_DIR_RE.test(name)) continue;
      const dir = join(root, name);
      const cli = join(dir, DSH_CLI_REL);
      if (existsSync(cli)) return { cli, dir };
    }
  }
  return null;
}

/**
 * 从一个「可能指向 dsh CLI / 安装目录 / 命令名」的值解析出 CLI 路径。
 * agents.json 里用户手填的 dsh 允许三种写法，免得队友去猜该填哪一层。
 */
function resolveDshValue(value: string): string | null {
  const raw = value.trim().replace(/^"|"$/g, "");
  if (!raw) return null;
  if (existsSync(raw)) {
    try {
      if (!statSync(raw).isDirectory()) return raw; // 直接指到 .cmd / .exe
    } catch {
      return null; // 权限 / 竞态：当作没找到
    }
    // 目录：可能是安装目录本身，也可能它的上面一层
    for (const rel of [DSH_CLI_REL, join("cli", "bin", "dsh.cmd"), "dsh.cmd"]) {
      const p = join(raw, rel);
      if (existsSync(p)) return p;
    }
    return findDshUnderRoots([raw])?.cli ?? null;
  }
  return dshOnPath(); // 裸命令名
}

/**
 * 注册表卸载项里的安装位置 —— 装到自定义目录（本机就是 D:\agent\...）时唯一可靠的发现途径。
 *
 * 用 `reg.exe` 而不是 PowerShell 的注册表提供程序：后者启动一次要几百毫秒，
 * reg 只需几十毫秒，且这是每次 snapshot 都会走的路径。
 */
export function dshFromRegistry(): { cli: string; dir: string } | null {
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const key of keys) {
    let out = "";
    try {
      out = execFileSync("reg.exe", ["query", key, "/s", "/f", "DeepSeek Harness", "/d"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 8000,
      }).toString();
    } catch {
      continue; // 键不存在 / 没有匹配：reg 以非 0 退出，属正常
    }
    const dir = installDirFromRegOutput(out);
    if (!dir) continue;
    const cli = join(dir, DSH_CLI_REL);
    if (existsSync(cli)) return { cli, dir };
  }
  return null;
}

/** 从 `reg query ... /s /f` 的输出里取安装目录（InstallLocation → DisplayIcon → UninstallString） */
function installDirFromRegOutput(out: string): string | null {
  const valueOf = (name: string): string | null => {
    const m = out.match(new RegExp(`^\\s+${name}\\s+REG_[A-Z_]+\\s+(.+?)\\s*$`, "m"));
    return m ? m[1].replace(/^"|"$/g, "") : null;
  };
  const loc = valueOf("InstallLocation");
  if (loc && existsSync(loc)) return loc;
  const icon = valueOf("DisplayIcon"); // "D:\...\DeepSeek Harness.exe,0"
  if (icon) {
    const p = icon.replace(/,\s*-?\d+\s*$/, "");
    if (existsSync(p)) return dirname(p);
  }
  const un = valueOf("UninstallString"); // "\"D:\...\Uninstall ….exe\" /currentuser"
  if (un) {
    const p = un.match(/^"([^"]+)"/)?.[1] ?? un.split(/\s+/)[0];
    if (p && existsSync(p)) return dirname(p);
  }
  return null;
}

/** CLI 路径 → 桌面版安装目录（按约定的相对路径反推；对不上就 null） */
function installDirOf(cli: string): string | null {
  const lower = cli.toLowerCase().replace(/\//g, "\\");
  const suffix = "\\" + DSH_CLI_REL.replace(/\//g, "\\").toLowerCase();
  return lower.endsWith(suffix) ? cli.slice(0, cli.length - suffix.length) : null;
}

/** `.cmd` 垫片不能直接 spawn（Node 18.20+ 禁止执行 .cmd），必须包一层 cmd.exe /c */
function wrapDshLaunch(cli: string): { command: string; args: string[] } {
  return /\.exe$/i.test(cli)
    ? { command: cli, args: ["--profile", "acp"] }
    : { command: "cmd.exe", args: ["/c", cli, "--profile", "acp"] };
}

/**
 * dsh 的三级解析（T14 施工清单第 1 条）：
 *   用户 override（agents.json 的 dsh）→ PATH 上的 dsh / dsh.cmd → 常见安装位置（env 推导的根目录 + 注册表）。
 * 找到的一律包成 `cmd.exe /c <dsh.cmd> --profile acp`。
 */
export function resolveDshLaunch(opts: DshProbeOptions = {}): DshDiscovery {
  const find = (
    hit: { cli: string; dir?: string } | null,
    source: DshSource,
  ): DshDiscovery | null =>
    hit
      ? {
          launch: wrapDshLaunch(hit.cli),
          cli: hit.cli,
          installDir: hit.dir ?? installDirOf(hit.cli),
          source,
        }
      : null;

  const override = userOverrides().dsh;
  if (override) {
    const cli = resolveDshValue(override);
    const hit = find(cli ? { cli } : null, "override");
    if (hit) return hit;
  }
  const pathCli = dshOnPath();
  const onPath = find(pathCli ? { cli: pathCli } : null, "path");
  if (onPath) return onPath;
  const known = find(findDshUnderRoots(opts.roots ?? knownInstallRoots()), "known");
  if (known) return known;
  if (!opts.skipRegistry) {
    const reg = find(dshFromRegistry(), "registry");
    if (reg) return reg;
  }
  return { launch: null, cli: null, installDir: null, source: null };
}

/**
 * 探测结果缓存。
 *
 * 为什么需要：`HubService.snapshot()` 每次都会调 detectAgents，而一次探测要跑
 * 多个 `where` 和注册表查询（本机实测约 300ms）。UI 每个动作/每次台账刷新都会
 * 拉快照，不缓存会把主进程拖成瓶颈。默认 30s；`BUMIMANG_DETECT_TTL_MS=0` 可关闭
 * （测试里需要改环境后立即重探时用）。
 */
let detectCache: { at: number; agents: AgentDescriptor[] } | null = null;

export function invalidateAgentCache(): void {
  detectCache = null;
}

function cloneAgent(a: AgentDescriptor): AgentDescriptor {
  return {
    ...a,
    launch: a.launch ? { command: a.launch.command, args: [...a.launch.args] } : null,
  };
}

export function detectAgents(): AgentDescriptor[] {
  const ttl = Math.max(0, Number(process.env.BUMIMANG_DETECT_TTL_MS ?? "30000"));
  if (ttl > 0 && detectCache) {
    const age = Date.now() - detectCache.at;
    if (age >= 0 && age < ttl) return detectCache.agents.map(cloneAgent);
  }
  const agents = probeAgents();
  if (ttl > 0) detectCache = { at: Date.now(), agents: agents.map(cloneAgent) };
  return agents;
}

function probeAgents(): AgentDescriptor[] {
  const overrides = userOverrides();
  const out: AgentDescriptor[] = [];

  // opencode：自带 `opencode acp` 子命令，无需额外适配器
  {
    const launch = overrides.opencode
      ? { command: overrides.opencode, args: ["acp"] }
      : resolveLaunch("opencode", ["acp"]);
    out.push({
      id: "opencode",
      title: "OpenCode",
      launch,
      installed: Boolean(launch),
      installHint: "npm i -g opencode-ai",
      maturity: "ACP 原生子命令，握手实测通过（protocolVersion=1）",
      // 本应用会自动武装（session/manager.ts 注入 OPENCODE_CONFIG_CONTENT）
      permissionBehavior: "requests_by_default",
    });
  }

  // codex：官方 ACP 适配器 @agentclientprotocol/codex-acp
  {
    const launch = resolveLaunch("codex-acp");
    out.push({
      id: "codex",
      title: "Codex",
      launch,
      installed: Boolean(launch),
      installHint: "npm i -g @agentclientprotocol/codex-acp",
      maturity: launch
        ? "官方适配器已安装；凭据继承 ~/.codex/config.toml 的 custom provider"
        : "未检测到适配器（本机只有 codex CLI 本体）",
      // 本应用在 guarded 档下把它切到原生 mode workspace-write（越界写会问；联网不保证）
      permissionBehavior: "requests_by_default",
    });
  }

  // claude：官方 ACP 适配器 @agentclientprotocol/claude-agent-acp
  {
    const launch = resolveLaunch("claude-agent-acp");
    out.push({
      id: "claude",
      title: "Claude Code",
      launch,
      installed: Boolean(launch),
      installHint: "npm i -g @agentclientprotocol/claude-agent-acp",
      maturity: launch
        ? "官方适配器已安装；凭据继承 ~/.claude/settings.json 的 env（CC Switch 写入）"
        : "未检测到适配器（本机只有 claude CLI 本体）",
      permissionBehavior: "requests_by_default",
    });
  }

  // dsh：DeepSeek Harness 桌面版自带 CLI，`--profile acp` = 标准 ACP v1 stdio server
  {
    const found = resolveDshLaunch();
    out.push({
      id: "dsh",
      title: "DeepSeek Harness",
      launch: found.launch,
      installed: Boolean(found.launch),
      installHint:
        "装 DeepSeek Harness 桌面版（它自带 dsh CLI）；装到非常规位置时，" +
        "把 %APPDATA%\\不迷茫\\agents.json 的 dsh 指到 <安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd",
      maturity: found.launch
        ? "桌面版自带 CLI；--profile acp 是标准 ACP v1 stdio server（握手实测通过）"
        : "未检测到 dsh CLI：桌面版未安装，或装在非常规位置（可用 agents.json 的 dsh 指定）",
      // 本应用按档位注入 DSH_PERMISSION_MODE（session/manager.ts：guarded→read-only）
      permissionBehavior: "requests_by_default",
    });
  }

  return out;
}

/** 已安装的 agent（供会话管理器挑选） */
export function installedAgents(): AgentDescriptor[] {
  return detectAgents().filter((a) => a.installed && a.launch);
}

export function renderAgentTable(agents: AgentDescriptor[]): string {
  const lines = ["检测到的 agent："];
  for (const a of agents) {
    lines.push(
      a.installed
        ? `  [可用] ${a.title.padEnd(18)} ${a.launch!.command} ${a.launch!.args.join(" ")}`
        : `  [未装] ${a.title.padEnd(18)} 安装提示：${a.installHint}`,
    );
  }
  return lines.join("\n");
}
