/**
 * V2.1b：IR 工具配置与解析（可迁移）。
 *
 * 配置查找顺序：
 *  1. BUMIMANG_IR_TOOLS_CONFIG 显式文件（不存在/坏 JSON 报错，不回退）
 *  2. userData/ir-tools.json（用户级；不存在继续）
 *  3. 开发态 <repo>/config/ir-tools.json（仅 !isPackaged）
 *  4. 无配置 → 空 tools，继续走 BUMIMANG_* env 和 PATH
 *
 * 工具解析优先级：配置路径 > BUMIMANG_* > PATH。
 * 打包态不读取 resources/app-source/config/ir-tools.json（发行包只放 example），
 * 避免把安装包绑死到开发机绝对路径。显式配置/环境变量指向不存在路径时返回
 * PATH_ERROR，不静默回退（Doctor 要能区分路径错误）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findExecutable } from "./spawn.ts";

export type IrToolKey =
  | "tshark"
  | "capinfos"
  | "text2pcap"
  | "evtxecmd"
  | "volatility"
  | "yaraPython"
  | "yaraScan";

export interface IrToolPaths {
  tshark?: string;
  capinfos?: string;
  text2pcap?: string;
  evtxecmd?: string;
  volatility?: string;
  yaraPython?: string;
  yaraScan?: string;
}

export interface LoadedIrToolConfig {
  /** 实际读取的配置文件；未找到时为 null。 */
  path: string | null;
  tools: IrToolPaths;
  error?: string;
}

export type IrToolSource = "config" | "env" | "path" | null;

export interface IrToolResolution {
  key: IrToolKey;
  /** 解析到的绝对路径；未找到/路径错误时为 null。 */
  path: string | null;
  source: IrToolSource;
  /** 配置/环境变量里写的原始值（用于 Doctor 显示）。 */
  configuredPath?: string;
  /** 路径错误原因（配置/环境变量指向不存在路径）。 */
  error?: string;
}

export const IR_TOOL_ENV: Record<IrToolKey, { envVar: string; defaultName: string }> = {
  tshark: { envVar: "BUMIMANG_TSHARK", defaultName: "tshark" },
  capinfos: { envVar: "BUMIMANG_CAPINFOS", defaultName: "capinfos" },
  text2pcap: { envVar: "BUMIMANG_TEXT2PCAP", defaultName: "text2pcap" },
  evtxecmd: { envVar: "BUMIMANG_EVTXECMD", defaultName: "EvtxECmd" },
  volatility: { envVar: "BUMIMANG_VOLATILITY", defaultName: "vol" },
  yaraPython: { envVar: "BUMIMANG_YARA_PYTHON", defaultName: "python" },
  yaraScan: { envVar: "BUMIMANG_YARA_SCAN", defaultName: "yara-scan.py" },
};

const CONFIG_KEYS: Record<string, IrToolKey> = {
  tshark: "tshark",
  capinfos: "capinfos",
  text2pcap: "text2pcap",
  evtxecmd: "evtxecmd",
  evtxecmd_exe: "evtxecmd",
  volatility: "volatility",
  vol: "volatility",
  yarapython: "yaraPython",
  yara_scan: "yaraScan",
  yarascan: "yaraScan",
};

export type IrToolConfigSource = "explicit" | "userData" | "dev";

export interface LoadedIrToolConfig {
  /** 实际读取的配置文件；未找到时为 null。 */
  path: string | null;
  source: IrToolConfigSource | null;
  tools: IrToolPaths;
  error?: string;
}

function readConfigFile(file: string, source: IrToolConfigSource): LoadedIrToolConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { path: file, source, tools: {}, error: `IR 工具配置解析失败：${(err as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { path: file, source, tools: {}, error: `IR 工具配置必须是 JSON 对象：${file}` };
  }
  const obj = raw as Record<string, unknown>;
  const tools: IrToolPaths = {};
  for (const [rawKey, value] of Object.entries(obj)) {
    if (rawKey.startsWith("_")) continue;
    const key = CONFIG_KEYS[rawKey.toLowerCase()];
    if (!key) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(path.dirname(file), value);
    tools[key] = resolved;
  }
  return { path: file, source, tools };
}

/**
 * 读取工具配置。查找顺序：
 *  1. BUMIMANG_IR_TOOLS_CONFIG（显式；不存在/坏 JSON = error，不回退）
 *  2. userData/ir-tools.json（存在才读；不存在继续）
 *  3. 开发态 <repo>/config/ir-tools.json（仅 !isPackaged；存在才读）
 *  4. 无配置 → 空 tools；由 Resolver 继续走 BUMIMANG_* env 和 PATH
 *
 * 打包态**不读取** resources/app-source/config/ir-tools.json（发行包只放 example，
 * 不放开发机绝对路径），避免把发行包绑死到开发机目录。
 */
export function loadIrToolConfig(opts: {
  repoRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
}): LoadedIrToolConfig {
  const env = opts.env ?? process.env;
  const explicit = env.BUMIMANG_IR_TOOLS_CONFIG?.trim();
  if (explicit) {
    const file = path.resolve(explicit);
    if (!existsSync(file)) {
      return {
        path: null,
        source: "explicit",
        tools: {},
        error: `BUMIMANG_IR_TOOLS_CONFIG 指向的文件不存在：${file}`,
      };
    }
    return readConfigFile(file, "explicit");
  }

  const candidates: Array<{ file: string; source: IrToolConfigSource }> = [];
  if (opts.userDataDir?.trim()) {
    candidates.push({ file: path.join(path.resolve(opts.userDataDir), "ir-tools.json"), source: "userData" });
  }
  if (!opts.isPackaged) {
    candidates.push({ file: path.join(opts.repoRoot, "config", "ir-tools.json"), source: "dev" });
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.file)) return readConfigFile(candidate.file, candidate.source);
  }
  return { path: null, source: null, tools: {} };
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 解析单个工具；显式配置/环境变量指向不存在路径时返回 PATH_ERROR，不静默回退。 */
export function resolveIrTool(input: {
  key: IrToolKey;
  tools?: IrToolPaths;
  env?: NodeJS.ProcessEnv;
  /** PATH 查找函数（测试可注入）。 */
  find?: (name: string) => string | null;
}): IrToolResolution {
  const env = input.env ?? process.env;
  const meta = IR_TOOL_ENV[input.key];
  const configured = input.tools?.[input.key];
  if (configured) {
    if (existsFile(configured)) return { key: input.key, path: configured, source: "config", configuredPath: configured };
    return {
      key: input.key,
      path: null,
      source: "config",
      configuredPath: configured,
      error: `配置路径不存在或不是文件：${configured}`,
    };
  }
  const envValue = env[meta.envVar]?.trim();
  if (envValue) {
    const resolved = path.isAbsolute(envValue) ? path.normalize(envValue) : path.resolve(envValue);
    if (existsFile(resolved)) {
      return { key: input.key, path: resolved, source: "env", configuredPath: envValue };
    }
    return {
      key: input.key,
      path: null,
      source: "env",
      configuredPath: envValue,
      error: `${meta.envVar} 指向的路径不存在或不是文件：${resolved}`,
    };
  }
  const found = (input.find ?? ((n: string) => findExecutable(n, env)))(meta.defaultName);
  if (found) return { key: input.key, path: found, source: "path" };
  return { key: input.key, path: null, source: null };
}

/** 供 IR 分析器 ctx.resolveTool 使用：按 envVar 反查 key，优先 config，再 env/PATH。 */
export function createIrToolResolver(
  config: LoadedIrToolConfig,
  env: NodeJS.ProcessEnv = process.env,
): (envVar: string, defaultName: string) => string | null {
  const byEnv = new Map<string, IrToolKey>(
    Object.entries(IR_TOOL_ENV).map(([key, meta]) => [meta.envVar, key as IrToolKey]),
  );
  return (envVar: string, defaultName: string): string | null => {
    const key =
      byEnv.get(envVar) ??
      (Object.values(IR_TOOL_ENV).find((m) => m.defaultName.toLowerCase() === defaultName.toLowerCase())
        ?.envVar
        ? byEnv.get(
            Object.values(IR_TOOL_ENV).find((m) => m.defaultName.toLowerCase() === defaultName.toLowerCase())!
              .envVar,
          )
        : undefined);
    if (!key) {
      const found = findExecutable(defaultName, env);
      return found;
    }
    const resolved = resolveIrTool({ key, tools: config.tools, env });
    return resolved.path;
  };
}
