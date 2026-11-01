/**
 * P6-A：benchmark manifest 校验 + dry-run 计划。
 *
 * 本步只做：
 *  - 读 manifest JSON（只读）；
 *  - 校验 challeng schema / expectedFlagFile 存在；
 *  - 打印计划（题数 × 重复 × 会话数 × 时间上界）。
 *
 * 明确不做：启动任何真实/fake agent、烧 token、写结果文件、启动子进程。
 * 真实跑在 P6-C 实现；非 dry-run 会返回可读错误，不静默降级。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateAnswerSpec } from "../main/answer/spec.ts";
import type { AnswerSpec } from "../../../../packages/shared-protocol/events.ts";

const CATEGORIES = new Set(["web", "misc", "crypto", "reverse", "pwn", "pentest", "ir", "awd", "unknown"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const RESET_MODES = new Set(["manual", "local-script"]);
const ROLES = new Set(["lead", "verify", "recon", "scribe"]);
const TIERS = new Set(["guarded", "autonomous"]);
const DEFAULT_MANIFEST = "benchmarks/challenges.example.json";

export interface BenchChallenge {
  id: string;
  category: string;
  difficulty: string;
  brief: string;
  attachments: string[];
  targets: string[];
  /** 旧字段：兼容现有 manifest（flag 标准答案文件）。 */
  expectedFlagFile: string;
  /** V2-P0-6：通用答案标准文件；与 expectedFlagFile 至少一个存在。 */
  expectedAnswerFile?: string;
  /** V2-P0-6：答案格式；缺省按默认 flag{...}。 */
  answerSpec?: AnswerSpec;
  /** V2-P0-6：重置方式；只接受人工或用户提供的本地脚本，不接受平台 API。 */
  resetMode?: "manual" | "local-script";
  allowedTargets?: string[];
  forbiddenActions?: string[];
  agent?: string;
  role?: string;
  tier?: "guarded" | "autonomous";
  budget?: { tokens?: number | null; wallMs?: number | null };
  timeoutMs: number;
  maxSessions: number;
}

export interface BenchManifest {
  version: 1;
  challenges: BenchChallenge[];
}

export interface BenchOptions {
  dry: boolean;
  manifestPath: string;
  challengeId?: string;
  repeats: number;
  sessions: number;
  repoRoot?: string;
  /** 测试用计数钩子；dry-run 永远不应调用。 */
  hooks?: { onAgentStart?: () => void };
  help?: boolean;
}

export interface BenchPlan {
  manifestPath: string;
  repeats: number;
  sessions: number;
  challenges: BenchChallenge[];
  runCount: number;
  sessionCount: number;
  /** 串行上界：sessionCount × 单题最大 timeoutMs；实际会话并行，仅作预算。 */
  estimatedWallMs: number;
}

export interface BenchResult {
  ok: boolean;
  error?: string;
  plan?: BenchPlan;
}

function intArg(raw: string, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${field} 必须是整数：${JSON.stringify(raw)}`);
  return n;
}

export function parseBenchArgs(argv: string[]): BenchOptions {
  let dry = true;
  let manifestPath = DEFAULT_MANIFEST;
  let challengeId: string | undefined;
  let repeats = 3;
  let sessions = 1;
  let help = false;

  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少值`);
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry") {
      dry = true;
      continue;
    }
    if (a === "--no-dry") {
      dry = false;
      continue;
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a.startsWith("--manifest=")) {
      manifestPath = a.slice("--manifest=".length);
      continue;
    }
    if (a === "--manifest") {
      manifestPath = take(i, "--manifest");
      i += 1;
      continue;
    }
    if (a.startsWith("--challenge=")) {
      challengeId = a.slice("--challenge=".length);
      continue;
    }
    if (a === "--challenge") {
      challengeId = take(i, "--challenge");
      i += 1;
      continue;
    }
    if (a.startsWith("--repeats=")) {
      repeats = intArg(a.slice("--repeats=".length), "repeats");
      continue;
    }
    if (a === "--repeats") {
      repeats = intArg(take(i, "--repeats"), "repeats");
      i += 1;
      continue;
    }
    if (a.startsWith("--sessions=")) {
      sessions = intArg(a.slice("--sessions=".length), "sessions");
      continue;
    }
    if (a === "--sessions") {
      sessions = intArg(take(i, "--sessions"), "sessions");
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${a}`);
  }

  if (!manifestPath.trim()) throw new Error("manifest 不能为空");
  if (repeats < 1) throw new Error("repeats 必须 >=1");
  if (sessions < 1 || sessions > 3) throw new Error("sessions 必须是 1–3");
  return { dry, manifestPath, challengeId, repeats, sessions, help };
}

export function loadManifest(manifestPath: string, repoRoot = process.cwd()): unknown {
  const abs = isAbsolute(manifestPath) ? manifestPath : resolve(repoRoot, manifestPath);
  if (!existsSync(abs)) throw new Error(`manifest 不存在：${abs}`);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`manifest 读取失败：${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`manifest JSON 解析失败：${(err as Error).message}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(v: unknown, field: string, max = 200_000): string {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`${field} 必须是非空字符串`);
  if (v.length > max) throw new Error(`${field} 过长（>${max}）`);
  return v.trim();
}

function optStringArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return v.map((x) => String(x));
}

export function validateManifest(
  raw: unknown,
  opts: { repoRoot?: string; challengeId?: string } = {},
): BenchManifest {
  const repoRoot = opts.repoRoot ?? process.cwd();
  if (!isRecord(raw)) throw new Error("manifest 必须是对象");
  if (raw.version !== 1) throw new Error(`manifest version 必须是 1（actual=${String(raw.version)}）`);
  if (!Array.isArray(raw.challenges) || raw.challenges.length === 0) {
    throw new Error("challenges 必须是非空数组");
  }

  const ids = new Set<string>();
  const challenges: BenchChallenge[] = raw.challenges.map((item, index) => {
    if (!isRecord(item)) throw new Error(`challenges[${index}] 必须是对象`);
    const id = reqString(item.id, `challenges[${index}].id`, 256);
    if (ids.has(id)) throw new Error(`challenge id 重复：${id}`);
    ids.add(id);

    const category = reqString(item.category, `challenges[${index}].category`, 32);
    if (!CATEGORIES.has(category)) {
      throw new Error(`challenges[${index}].category 非法：${category}（允许：${[...CATEGORIES].join(", ")}）`);
    }
    const difficulty = reqString(item.difficulty, `challenges[${index}].difficulty`, 16);
    if (!DIFFICULTIES.has(difficulty)) {
      throw new Error(`challenges[${index}].difficulty 非法：${difficulty}（允许：easy, medium, hard）`);
    }
    const brief = reqString(item.brief, `challenges[${index}].brief`);
    const attachments = optStringArray(item.attachments, `challenges[${index}].attachments`);
    const targets = optStringArray(item.targets, `challenges[${index}].targets`);
    const rawFlagFile = typeof item.expectedFlagFile === "string" ? item.expectedFlagFile.trim() : "";
    const rawAnswerFile =
      typeof item.expectedAnswerFile === "string" ? item.expectedAnswerFile.trim() : "";
    if (!rawFlagFile && !rawAnswerFile) {
      throw new Error(
        `challenges[${index}] 必须提供 expectedFlagFile 或 expectedAnswerFile（至少一个非空）`,
      );
    }
    const resolveExpected = (rel: string, field: string): string => {
      const abs = isAbsolute(rel) ? rel : resolve(repoRoot, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        throw new Error(`challenges[${index}].${field} 不存在：${abs}`);
      }
      return rel;
    };
    const expectedFlagFile = rawFlagFile ? resolveExpected(rawFlagFile, "expectedFlagFile") : "";
    const expectedAnswerFile = rawAnswerFile
      ? resolveExpected(rawAnswerFile, "expectedAnswerFile")
      : "";

    let answerSpec: AnswerSpec | undefined;
    if (item.answerSpec !== undefined) {
      const res = validateAnswerSpec(item.answerSpec);
      if (!res.ok) {
        throw new Error(`challenges[${index}].answerSpec 非法：${res.errors.join("；")}`);
      }
      answerSpec = res.spec;
    }

    let resetMode: "manual" | "local-script" | undefined;
    if (item.resetMode !== undefined) {
      if (typeof item.resetMode !== "string" || !RESET_MODES.has(item.resetMode)) {
        throw new Error(
          `challenges[${index}].resetMode 只允许 manual|local-script（不接受平台 API/自动开环境）`,
        );
      }
      resetMode = item.resetMode as "manual" | "local-script";
    }
    const allowedTargets = optStringArray(item.allowedTargets, `challenges[${index}].allowedTargets`);
    const forbiddenActions = optStringArray(item.forbiddenActions, `challenges[${index}].forbiddenActions`);

    let agent: string | undefined;
    if (item.agent !== undefined) agent = reqString(item.agent, `challenges[${index}].agent`, 64);
    let role: string | undefined;
    if (item.role !== undefined) {
      const v = reqString(item.role, `challenges[${index}].role`, 16);
      if (!ROLES.has(v)) throw new Error(`challenges[${index}].role 非法：${v}`);
      role = v;
    }
    let tier: "guarded" | "autonomous" | undefined;
    if (item.tier !== undefined) {
      const v = reqString(item.tier, `challenges[${index}].tier`, 16);
      if (!TIERS.has(v)) throw new Error(`challenges[${index}].tier 非法：${v}`);
      tier = v as "guarded" | "autonomous";
    }
    let budget: BenchChallenge["budget"];
    if (item.budget !== undefined) {
      if (!isRecord(item.budget)) throw new Error(`challenges[${index}].budget 必须是对象`);
      const tokens = item.budget.tokens;
      const wallMs = item.budget.wallMs;
      const nonNegIntOrNull = (v: unknown, field: string): number | null | undefined => {
        if (v === undefined || v === null) return v as null | undefined;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          throw new Error(`challenges[${index}].budget.${field} 必须是非负整数或 null`);
        }
        return v;
      };
      budget = { tokens: nonNegIntOrNull(tokens, "tokens") ?? null, wallMs: nonNegIntOrNull(wallMs, "wallMs") ?? null };
    }

    const timeoutMs = intArg(String(item.timeoutMs), `challenges[${index}].timeoutMs`);
    if (timeoutMs <= 0) throw new Error(`challenges[${index}].timeoutMs 必须是正整数`);
    const maxSessions = intArg(String(item.maxSessions), `challenges[${index}].maxSessions`);
    if (maxSessions < 1 || maxSessions > 3) {
      throw new Error(`challenges[${index}].maxSessions 必须是 1–3`);
    }
    return {
      id,
      category,
      difficulty,
      brief,
      attachments,
      targets,
      expectedFlagFile,
      ...(expectedAnswerFile ? { expectedAnswerFile } : {}),
      ...(answerSpec ? { answerSpec } : {}),
      ...(resetMode ? { resetMode } : {}),
      ...(allowedTargets.length ? { allowedTargets } : {}),
      ...(forbiddenActions.length ? { forbiddenActions } : {}),
      ...(agent ? { agent } : {}),
      ...(role ? { role } : {}),
      ...(tier ? { tier } : {}),
      ...(budget ? { budget } : {}),
      timeoutMs,
      maxSessions,
    };
  });

  if (opts.challengeId !== undefined && !ids.has(opts.challengeId)) {
    throw new Error(`challenge 不存在：${opts.challengeId}`);
  }
  return { version: 1, challenges };
}

export function buildBenchPlan(
  manifest: BenchManifest,
  opts: { repeats: number; sessions: number; challengeId?: string; manifestPath?: string },
): BenchPlan {
  const challenges = manifest.challenges.filter(
    (c) => opts.challengeId === undefined || c.id === opts.challengeId,
  );
  if (challenges.length === 0) throw new Error(`challenge 不存在：${opts.challengeId ?? "?"}`);
  if (opts.repeats < 1) throw new Error("repeats 必须 >=1");
  if (opts.sessions < 1 || opts.sessions > 3) throw new Error("sessions 必须是 1–3");
  for (const c of challenges) {
    if (opts.sessions > c.maxSessions) {
      throw new Error(`challenge ${c.id} 的 maxSessions=${c.maxSessions}，请求 sessions=${opts.sessions}`);
    }
  }
  const runCount = challenges.length * opts.repeats;
  const sessionCount = runCount * opts.sessions;
  const maxTimeout = Math.max(...challenges.map((c) => c.timeoutMs));
  return {
    manifestPath: opts.manifestPath ?? "(manifest)",
    repeats: opts.repeats,
    sessions: opts.sessions,
    challenges,
    runCount,
    sessionCount,
    estimatedWallMs: sessionCount * maxTimeout,
  };
}

export function formatBenchPlan(plan: BenchPlan): string {
  const lines: string[] = [
    "不迷茫 · benchmark dry-run",
    `manifest=${plan.manifestPath}`,
    `题数=${plan.challenges.length} repeats=${plan.repeats} sessions=${plan.sessions}`,
    `runs=${plan.runCount} sessions=${plan.sessionCount} 预计最坏墙钟=${(plan.estimatedWallMs / 60000).toFixed(1)} 分钟`,
    "（预计墙钟 = sessionCount × 单题最大 timeoutMs 的串行上界；实际会话并行，仅用于预算）",
    "",
  ];
  for (const c of plan.challenges) {
    const answer = c.answerSpec
      ? `${c.answerSpec.mode}/${c.answerSpec.answerType ?? "text"}`
      : "flag_regex/flag";
    lines.push(
      `- ${c.id}  category=${c.category} difficulty=${c.difficulty} ` +
        `timeout=${(c.timeoutMs / 60000).toFixed(1)}m maxSessions=${c.maxSessions} ` +
        `answer=${answer} expected=${c.expectedAnswerFile ?? c.expectedFlagFile} ` +
        `reset=${c.resetMode ?? "manual"}` +
        (c.agent ? ` agent=${c.agent}` : "") +
        (c.role ? ` role=${c.role}` : "") +
        (c.tier ? ` tier=${c.tier}` : "") +
        (c.budget ? ` budget=${JSON.stringify(c.budget)}` : ""),
    );
  }
  lines.push("", "dry-run：不启动 agent、0 token、不写结果文件。");
  return lines.join("\n");
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  if (!opts.dry) {
    return { ok: false, error: "真实跑在 P6-C 实现；本步只做 dry-run" };
  }
  try {
    const repoRoot = opts.repoRoot ?? process.cwd();
    const raw = loadManifest(opts.manifestPath, repoRoot);
    const manifest = validateManifest(raw, { repoRoot, challengeId: opts.challengeId });
    const plan = buildBenchPlan(manifest, {
      repeats: opts.repeats,
      sessions: opts.sessions,
      challengeId: opts.challengeId,
      manifestPath: opts.manifestPath,
    });
    console.log(formatBenchPlan(plan));
    return { ok: true, plan };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    const opts = parseBenchArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(
        "用法：npm run bench -- --dry [--manifest=path] [--challenge=id] [--repeats=3] [--sessions=1|2|3]\n" +
          "P6-A 只支持 --dry（默认）；真实跑在 P6-C 实现。",
      );
      process.exit(0);
    }
    const res = await runBench({ ...opts, repoRoot: process.cwd() });
    if (!res.ok) {
      console.error(res.error);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    process.exit(2);
  }
}

if (isMain()) void main();
