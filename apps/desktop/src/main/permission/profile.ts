/**
 * 权限请求的「操作画像」—— 把 ACP 的 request_permission 压成可匹配的类别 + 风险。
 *
 * 为什么需要它：
 *  - UI 要显示「这次是文件写入还是执行命令」，并决定是否允许「始终允许」；
 *  - 一键放行必须按**操作类型**匹配，而不是按某一条命令的全文（否则同一条命令改个参数
 *     又会弹窗），也不能按「什么都能放」的宽泛规则（否则删除/任意命令也被放行）。
 *
 * 安全边界（默认，可由 config/permissions.json 覆盖）：
 *  - 只有 `eligibleCategories` 里的类别允许被记住；
 *  - `highRiskCategories` 默认包含 execute / delete / credential / network / other，
 *    必须逐条人工放行；确实要纳入一键放行，必须在 `highRiskAllowlist` 写显式正则。
 *  - 分类失败（未知工具）一律按 other → 高风险处理（fail closed）。
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RiskLevel } from "../../../../../packages/shared-protocol/events.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { configPath, readJsonObject } from "../config/loader.ts";
import { isInsideDir } from "../acp/client.ts";

export type OperationCategory = "read" | "write" | "delete" | "execute" | "network" | "credential" | "other";

export interface PermissionConfig {
  eligibleCategories: OperationCategory[];
  highRiskCategories: OperationCategory[];
  /** 高风险动作的显式白名单；正则按不区分大小写匹配标题/命令。 */
  highRiskAllowlist: string[];
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  eligibleCategories: ["read", "write"],
  highRiskCategories: ["execute", "delete", "credential", "network", "other"],
  highRiskAllowlist: [],
};

const CATEGORY_ALIAS: Record<string, OperationCategory> = {
  read: "read",
  view: "read",
  list: "read",
  glob: "read",
  grep: "read",
  search: "read",
  write: "write",
  edit: "write",
  create: "write",
  patch: "write",
  apply_patch: "write",
  applypatch: "write",
  delete: "delete",
  remove: "delete",
  execute: "execute",
  exec: "execute",
  terminal: "execute",
  command: "execute",
  shell: "execute",
  bash: "execute",
  network: "network",
  fetch: "network",
  webfetch: "network",
  http: "network",
  credential: "credential",
  other: "other",
};

const CATEGORY_LABEL: Record<OperationCategory, string> = {
  read: "读取文件/目录",
  write: "写入/编辑文件",
  delete: "删除文件",
  execute: "执行命令",
  network: "网络访问",
  credential: "凭据访问",
  other: "其他/未知操作",
};

const CREDENTIAL_RE =
  /(mimikatz|sekurlsa|logonpasswords|lsass|hashdump|ntds\.dit|sam\s+dump|credential|密码|凭据)/i;
const DELETE_RE = /(\brm\b|\brmdir\b|\bdel\b|\berase\b|\bunlink\b|remove-item|\bshred\b|rm\s+-rf|diskpart|format\s+[a-z]:|\bdrop\s+table\b)/i;
const EXECUTE_RE = /(\b(run|exec|execute|bash|sh|zsh|cmd|powershell|pwsh|shell|terminal)\b|命令|执行)/i;
const NETWORK_RE = /(\b(curl|wget|nc|ncat|netcat|nmap|ssh|scp|ftp|http|https|fetch|websearch|request)\b|网络|联网)/i;
const READ_RE = /(\b(read|view|cat|type|list|ls|dir|glob|grep|search|find|stat)\b|读取|查看)/i;
const WRITE_RE = /(\b(write|edit|create|patch|apply|save|upload)\b|写入|编辑|保存)/i;
const DELETE_VERB_RE = /(\b(delete|remove|rm|rmdir|unlink|erase|shred)\b|删除|移除)/i;

export interface OperationProfile {
  category: OperationCategory;
  label: string;
  risk: RiskLevel;
  /** 是否属于高风险（默认不能一键放行）。 */
  highRisk: boolean;
  /** 是否命中 highRiskAllowlist 的显式白名单。 */
  allowlisted: boolean;
  /** 是否允许「本会话始终允许 / 对该 agent 永久允许」。 */
  rememberable: boolean;
  /** 规范化后的匹配文本，仅用于日志/排障。 */
  matchText: string;
}

function arrOfStrings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

function normalizeCategory(v: string): OperationCategory | null {
  return CATEGORY_ALIAS[v.trim().toLowerCase()] ?? null;
}

/** 读取 config/permissions.json；字段缺失/写错时逐项回落到安全默认值。 */
export function loadPermissionConfig(opts: {
  repoRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
}): LoadedConfig<PermissionConfig> {
  const file = configPath({
    name: "permissions.json",
    envVar: "BUMIMANG_PERMISSION_CONFIG",
    ...opts,
  });
  const raw = readJsonObject(file);
  if (!raw) {
    return {
      config: { ...DEFAULT_PERMISSION_CONFIG },
      path: existsSync(file) ? file : null,
      error: existsSync(file) ? `权限配置无法解析，已回落到内置默认：${file}` : undefined,
    };
  }
  const eligible = arrOfStrings(raw.eligibleCategories)
    ?.map(normalizeCategory)
    .filter((x): x is OperationCategory => x !== null);
  const highRisk = arrOfStrings(raw.highRiskCategories)
    ?.map(normalizeCategory)
    .filter((x): x is OperationCategory => x !== null);
  const allowlist = arrOfStrings(raw.highRiskAllowlist)?.filter((s) => s.trim().length > 0) ?? [];
  return {
    config: {
      eligibleCategories: eligible?.length ? eligible : [...DEFAULT_PERMISSION_CONFIG.eligibleCategories],
      highRiskCategories: highRisk?.length ? highRisk : [...DEFAULT_PERMISSION_CONFIG.highRiskCategories],
      highRiskAllowlist: allowlist,
    },
    path: file,
  };
}

/** 把 request_permission 的 detail 拼成可读文本（不含选项文案，避免被 "Allow once" 干扰）。 */
function actionText(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  };
  push(detail.title);
  push(detail.name);
  push(detail.kind);
  push(detail.command);
  push(detail.path);
  push(detail.target);
  push(detail.cwd);
  const raw = detail.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    push(r.command);
    push(r.filepath);
    push(r.path);
    push(r.cwd);
    push(r.name);
    push(r.tool);
  }
  return parts.join(" \n ");
}

function inferCategory(kind: string, text: string): OperationCategory {
  const k = normalizeCategory(kind);
  if (k) return k;
  // kind 缺失（dsh 的权限请求只带 toolCallId；名字由 tool_call update 补全）时按标题推断。
  if (DELETE_VERB_RE.test(text)) return "delete";
  if (CREDENTIAL_RE.test(text)) return "credential";
  if (EXECUTE_RE.test(text)) return "execute";
  if (NETWORK_RE.test(text)) return "network";
  if (WRITE_RE.test(text)) return "write";
  if (READ_RE.test(text)) return "read";
  return "other";
}

function matchesAllowlist(patterns: string[], text: string): boolean {
  // 逐个字段匹配，而不是只匹配拼接后的长文本：白名单里写 `^nmap\s+...$`
  // 这类锚定正则时，用户期望的是命中「命令」那一项字段。
  const pieces = text.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, "i");
    } catch {
      // 正则写坏了不能因此放行；忽略该条。
      continue;
    }
    if (re.test(text)) return true;
    for (const piece of pieces) if (re.test(piece)) return true;
  }
  return false;
}

export function profileOperation(
  detail: Record<string, unknown>,
  cfg: PermissionConfig = DEFAULT_PERMISSION_CONFIG,
): OperationProfile {
  const text = actionText(detail);
  const kind = typeof detail.kind === "string" ? detail.kind : "";
  const category = inferCategory(kind, text);
  const forcedHigh = CREDENTIAL_RE.test(text) || DELETE_RE.test(text);
  const highRiskByCategory = cfg.highRiskCategories.includes(category);
  const highRisk = forcedHigh || highRiskByCategory;
  const allowlisted = matchesAllowlist(cfg.highRiskAllowlist, text);
  const risk: RiskLevel = highRisk || allowlisted ? "high" : category === "read" ? "low" : "medium";
  return {
    category,
    label: CATEGORY_LABEL[category],
    risk,
    highRisk,
    allowlisted,
    rememberable: allowlisted || (!highRisk && cfg.eligibleCategories.includes(category)),
    matchText: text.slice(0, 240),
  };
}

/**
 * 文件写入的路径边界：显式指向任务工作目录之外的写入按高风险处理，不允许被记住。
 *
 * 为什么：`permission.edit` 的「同类」如果只按类别匹配，一个永久授权会同时覆盖
 * 工作目录内和目录外的写入；而 agent 自己执行命令时，客户端拿不到 fs/* 调用，
 * `session/request_permission` 是唯一的事前闸门。这里对能拿到路径的请求做包含性检查，
 * 路径未知（标题里没有路径）时保持原判定，避免把正常编辑误伤成高风险。
 */
export function applyWorkRootBoundary(
  profile: OperationProfile,
  detail: Record<string, unknown>,
  workRoot: string,
): OperationProfile {
  if (profile.category !== "write") return profile;
  const raw: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) raw.push(v.trim());
  };
  push(detail.path);
  push(detail.target);
  push(detail.cwd);
  const title = detail.title;
  if (typeof title === "string" && (isAbsolute(title) || /[\\/]/.test(title))) push(title);
  const ri = detail.rawInput;
  if (ri && typeof ri === "object" && !Array.isArray(ri)) {
    const r = ri as Record<string, unknown>;
    push(r.filepath);
    push(r.path);
    push(r.cwd);
  }
  if (raw.length === 0) return profile;
  const outside = raw.some((p) => !isInsideDir(workRoot, isAbsolute(p) ? p : resolve(workRoot, p)));
  if (!outside) return profile;
  return {
    ...profile,
    label: `${profile.label}（工作目录外）`,
    risk: "high",
    highRisk: true,
    rememberable: false,
  };
}

/** 「本会话」授权的稳定 id；agent 授权见 agentGrantId。 */
export function sessionGrantId(sessionId: string, category: string): string {
  return `sess:${sessionId}:${category}`;
}

export function agentGrantId(agentId: string, category: string): string {
  return `agent:${agentId}:${category}`;
}
