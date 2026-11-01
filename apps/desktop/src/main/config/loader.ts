/**
 * 应用级配置加载（不依赖 Electron，便于 CLI 验收直接跑）。
 *
 * 配置来源优先级：
 *  1. 环境变量显式指定（`BUMIMANG_CONFIG` / `BUMIMANG_PERMISSION_CONFIG`）
 *  2. 打包态：`<resources>/app-source/config/*.json`（electron-builder extraResources 拷贝）
 *  3. 开发态：`<repo>/config/*.json`
 *
 * 约定：配置里允许写相对路径，但它相对于**配置文件所在目录**解析；绝对路径原样使用。
 * 这样代码里不需要再硬编码任何盘符。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type SkillMcpMode = "auto" | "on" | "off";

export type OutOfScopeAction = "block" | "approve";

/**
 * P4-C：范围策略配置。
 *
 * 默认值刻意是 **关闭 + approve**：
 *  - `enabled:false`：P4-B 的提取仍是启发式，未在真实 agent 环境验证误报率；
 *    默认开启会让误报直接变成审批/拦截。
 *  - `outOfScopeAction:"approve"`：即使显式开启，也只转人工，不直接 block。
 *    比赛现场若要“资格优先”，可改成 `block`；误 block 时改回 `approve` 并重启。
 *  - `proxy.enabled`：P4-D 的占位，本步不启动任何代理。
 */
export interface ScopeConfig {
  enabled: boolean;
  outOfScopeAction: OutOfScopeAction;
  /**
   * P4-D：代理端口。0 = 随机端口（默认）；只有 proxy.enabled=true 时才尝试启动。
   * 批 1 只做占位；批 2 才真正消费。
   */
  proxy: { enabled: boolean; port?: number };
}

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  enabled: false,
  outOfScopeAction: "approve",
  proxy: { enabled: false, port: 0 },
};

export interface SkillConfig {
  /** 是否注册 run_weapon（P2-A 只加载，默认 false）。 */
  allowRunWeapon: boolean;
  /** 技能 MCP 工具注册模式（P2-A 只加载，默认 auto）。 */
  mcpMode: SkillMcpMode;
}

export interface PlatformConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  raceId?: string;
  username?: string;
  /** 本地显示用队名；平台昵称/组织路径不能可靠代表队名。 */
  teamName?: string;
  desKey: string;
  insecureTls: boolean;
  autoConnect: boolean;
  autoSync: boolean;
  /** 只在 E2 证据候选出现时自动调用平台提交，默认开启。 */
  autoSubmit: boolean;
  syncIntervalSeconds: number;
  wpDir?: string;
}

export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  enabled: true,
  provider: "auto",
  baseUrl: "",
  desKey: "",
  insecureTls: false,
  autoConnect: false,
  autoSync: false,
  autoSubmit: false,
  syncIntervalSeconds: 30,
};

export interface AppConfig {
  /** agent 工作根目录。未配置时由 main.ts 按运行形态回落到仓库/可执行文件旁的 work/。 */
  workDir?: string;
  /**
   * P1-A 只加载不消费：每任务活跃会话上限（P1-B 才执行）。
   * 非法/非正整数时视为未配置，由调用方决定默认值。
   */
  maxSessionsPerTask?: number;
  /** P1-A 只加载不消费：全局活跃会话上限（P1-B 才执行）。 */
  maxSessionsTotal?: number;
  /**
   * 技能库根目录（P2-A）。相对路径按配置文件所在目录解析。
   * 代码里的解析顺序：BUMIMANG_SKILL_DIR → 本字段 → 开发态 <repo>/../skill → 打包态 resources。
   */
  skillDir?: string;
  /** 技能工具开关（P2-A 只加载，P2-B 才消费）。 */
  skill: SkillConfig;
  /** P4-C：目标范围策略。默认关闭；proxy 只是 P4-D 占位。 */
  scope: ScopeConfig;
  /** 比赛平台连接、自动同步与本地 WP 目录。 */
  platform: PlatformConfig;
  /**
   * P3-B 批次 2：`cmd:` 证据回放开关。只由 `BUMIMANG_EVIDENCE_REPLAY=1` 开启；
   * 配置文件不提供这个字段，缺省/其它值一律 false。
   */
  evidenceReplay: boolean;
}

export interface LoadedConfig<T> {
  config: T;
  /** 实际读到的配置文件；没有配置文件时为 null。 */
  path: string | null;
  /** 读了但解析失败时的原因；调用方负责决定是否告警。 */
  error?: string;
}

/** 读取一个 JSON 对象；文件不存在/解析失败都返回 null，绝不让配置问题把应用带崩。 */
export function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 计算某个配置文件的位置（不读盘）。 */
export function configPath(opts: {
  name: string;
  envVar: string;
  repoRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const explicit = opts.env?.[opts.envVar]?.trim();
  if (explicit) return path.resolve(explicit);
  return opts.isPackaged
    ? path.join(opts.resourcesPath, "app-source", "config", opts.name)
    : path.join(opts.repoRoot, "config", opts.name);
}

/** 把配置里的路径解析成绝对路径（相对路径按配置文件目录解析）。 */
export function resolveConfiguredPath(value: string, baseDir: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

/**
 * P7-C：workDir 的可移植解析。
 *
 * 顺序：`BUMIMANG_WORK_DIR`（新）→ `BUMIMANG_WORKDIR`（旧，兼容）→
 * config.workDir → 开发态 `<repo>/work` → 打包态 `<documents>/bumimang/work`。
 * config.workDir 已由 loadAppConfig 解析成绝对路径；这里再 resolve 一次幂等。
 */
export function resolveWorkDir(opts: {
  env?: NodeJS.ProcessEnv;
  configWorkDir?: string;
  repoRoot: string;
  isPackaged: boolean;
  documentsPath: string;
}): string {
  const envRaw =
    opts.env?.BUMIMANG_WORK_DIR?.trim() || opts.env?.BUMIMANG_WORKDIR?.trim();
  if (envRaw) return path.resolve(envRaw);
  if (opts.configWorkDir?.trim()) return path.resolve(opts.configWorkDir);
  if (!opts.isPackaged) return path.join(opts.repoRoot, "work");
  return path.join(opts.documentsPath, "bumimang", "work");
}

/**
 * 解析 scope 段。非法/缺失一律回落到安全默认：
 *  - 只有布尔 `true` 才开启；
 *  - `outOfScopeAction` 只认 `"block"`，其余（含缺失/拼错）都是 `"approve"`；
 *  - `proxy.enabled` 只认布尔 `true`（P4-D 才消费）。
 */
function parseScopeConfig(raw: unknown): ScopeConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const proxyRaw =
    obj.proxy && typeof obj.proxy === "object" && !Array.isArray(obj.proxy)
      ? (obj.proxy as Record<string, unknown>)
      : {};
  const rawPort = proxyRaw.port;
  const port =
    typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535
      ? rawPort
      : 0;
  return {
    enabled: obj.enabled === true,
    outOfScopeAction: obj.outOfScopeAction === "block" ? "block" : "approve",
    proxy: { enabled: proxyRaw.enabled === true, port },
  };
}

function parsePlatformConfig(raw: unknown, baseDir: string): PlatformConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  const intervalRaw =
    typeof obj.syncIntervalSeconds === "number" &&
    Number.isInteger(obj.syncIntervalSeconds) &&
    obj.syncIntervalSeconds >= 10 &&
    obj.syncIntervalSeconds <= 3600
      ? obj.syncIntervalSeconds
      : DEFAULT_PLATFORM_CONFIG.syncIntervalSeconds;
  const wpRaw = typeof obj.wpDir === "string" && obj.wpDir.trim() ? obj.wpDir.trim() : undefined;
  return {
    enabled: bool(obj.enabled, DEFAULT_PLATFORM_CONFIG.enabled),
    provider: str(obj.provider, DEFAULT_PLATFORM_CONFIG.provider),
    baseUrl: str(obj.baseUrl, DEFAULT_PLATFORM_CONFIG.baseUrl).replace(/\/+$/, ""),
    raceId: str(obj.raceId, "") || undefined,
    username: str(obj.username, "") || undefined,
    teamName: str(obj.teamName, "") || undefined,
    desKey: str(obj.desKey, DEFAULT_PLATFORM_CONFIG.desKey),
    insecureTls: bool(obj.insecureTls, DEFAULT_PLATFORM_CONFIG.insecureTls),
    autoConnect: bool(obj.autoConnect, DEFAULT_PLATFORM_CONFIG.autoConnect),
    autoSync: bool(obj.autoSync, DEFAULT_PLATFORM_CONFIG.autoSync),
    autoSubmit: bool(obj.autoSubmit, DEFAULT_PLATFORM_CONFIG.autoSubmit),
    syncIntervalSeconds: intervalRaw,
    wpDir: wpRaw ? resolveConfiguredPath(wpRaw, baseDir) : undefined,
  };
}

export function loadAppConfig(opts: {
  repoRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
}): LoadedConfig<AppConfig> {
  const file = configPath({
    name: "app.json",
    envVar: "BUMIMANG_CONFIG",
    ...opts,
  });
  const raw = readJsonObject(file);
  if (!raw) {
    return {
      config: {
        skill: { allowRunWeapon: false, mcpMode: "auto" },
        scope: { ...DEFAULT_SCOPE_CONFIG, proxy: { ...DEFAULT_SCOPE_CONFIG.proxy } },
        platform: { ...DEFAULT_PLATFORM_CONFIG },
        // 配置文件缺失也要尊重显式环境变量；缺省仍是 false。
        evidenceReplay: opts.env?.BUMIMANG_EVIDENCE_REPLAY === "1",
      },
      path: existsSync(file) ? file : null,
      error: existsSync(file) ? `配置无法解析：${file}` : undefined,
    };
  }
  const workDir = typeof raw.workDir === "string" && raw.workDir.trim() ? raw.workDir.trim() : undefined;
  // P1-A：只解析，不执行配额；P1-B 才会用这两个值。
  const positiveInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  // P2-A：只解析 skillDir / skill 开关，不注册工具、不改简报。
  const skillDir =
    typeof raw.skillDir === "string" && raw.skillDir.trim() ? raw.skillDir.trim() : undefined;
  const skillRaw =
    raw.skill && typeof raw.skill === "object" && !Array.isArray(raw.skill)
      ? (raw.skill as Record<string, unknown>)
      : {};
  const mcpMode: SkillMcpMode =
    skillRaw.mcpMode === "on" || skillRaw.mcpMode === "off" || skillRaw.mcpMode === "auto"
      ? skillRaw.mcpMode
      : "auto";
  // P3-B：只认显式 "1"；缺省/"true"/其它值都是关闭。
  const evidenceReplay = opts.env?.BUMIMANG_EVIDENCE_REPLAY === "1";
  return {
    config: {
      workDir: workDir ? resolveConfiguredPath(workDir, path.dirname(file)) : undefined,
      maxSessionsPerTask: positiveInt(raw.maxSessionsPerTask),
      maxSessionsTotal: positiveInt(raw.maxSessionsTotal),
      skillDir: skillDir ? resolveConfiguredPath(skillDir, path.dirname(file)) : undefined,
      skill: { allowRunWeapon: skillRaw.allowRunWeapon === true, mcpMode },
      scope: parseScopeConfig(raw.scope),
      platform: parsePlatformConfig(raw.platform, path.dirname(file)),
      evidenceReplay,
    },
    path: file,
  };
}
