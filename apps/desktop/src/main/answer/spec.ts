/**
 * V2-P0-2：AnswerSpec 解析、校验与默认值。
 *
 * 目标：把“只认 flag{...}”收敛成一份统一模型。旧任务没有 answer_spec 时，
 * 这里返回默认 spec，行为与旧版一致；typed/freeform 只产生候选，不自动确认。
 *
 * 纯函数：不读 DB、不读文件、不调外部服务。
 */

import type {
  AnswerMode,
  AnswerNormalizer,
  AnswerSpec,
  AnswerType,
  EvidenceLevel,
} from "../../../../../packages/shared-protocol/events.ts";

export const ANSWER_MODES: readonly AnswerMode[] = ["flag_regex", "typed", "freeform"];

export const ANSWER_TYPES: readonly AnswerType[] = [
  "flag",
  "ip",
  "timestamp",
  "hash",
  "path",
  "process",
  "command",
  "account",
  "text",
];

export const ANSWER_NORMALIZERS: readonly AnswerNormalizer[] = [
  "trim",
  "lower",
  "upper",
  "strip_quotes",
  "collapse_ws",
  "normalize_path",
  "base64_decode",
  "hex_decode",
];

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ["E0", "E1", "E2"];

/** 默认 flag 正则：与旧 normalize/scan 的交集，限定 3–256 个非空白字符。 */
export const DEFAULT_FLAG_PATTERN = "flag\\{[^}\\s]{3,256}\\}";

export const DEFAULT_ANSWER_SPEC: AnswerSpec = {
  mode: "flag_regex",
  pattern: DEFAULT_FLAG_PATTERN,
  answerType: "flag",
  normalizers: ["trim"],
  caseSensitive: false,
  requiredEvidence: "E1",
};

export const DEFAULT_SPEC_ID = "default-flag-v1";

export interface AnswerSpecValidation {
  ok: boolean;
  errors: string[];
  /** 校验通过的完整 spec（补默认值）。 */
  spec?: AnswerSpec;
}

const MAX_PATTERN = 512;
const MAX_TEMPLATE = 512;
const MAX_FIELD = 256;
const MAX_ALIASES = 32;
const MAX_ALIAS_LEN = 256;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function defaultType(mode: AnswerMode): AnswerType {
  return mode === "flag_regex" ? "flag" : "text";
}

function defaultPattern(mode: AnswerMode, answerType: AnswerType): string | undefined {
  if (mode === "flag_regex") return DEFAULT_FLAG_PATTERN;
  if (mode === "typed" && answerType === "flag") return DEFAULT_FLAG_PATTERN;
  return undefined;
}

/** 校验并补默认值；任何非法字段都返回可读错误，不“猜一个能用的”。 */
export function validateAnswerSpec(raw: unknown): AnswerSpecValidation {
  if (!isRecord(raw)) {
    return { ok: false, errors: ["answerSpec 必须是对象"] };
  }
  const errors: string[] = [];
  const mode = str(raw.mode);
  if (!mode || !(ANSWER_MODES as readonly string[]).includes(mode)) {
    errors.push(`mode 必须是 ${ANSWER_MODES.join("|")}`);
  }
  const answerTypeRaw = str(raw.answerType);
  if (answerTypeRaw !== undefined && !(ANSWER_TYPES as readonly string[]).includes(answerTypeRaw)) {
    errors.push(`answerType 必须是 ${ANSWER_TYPES.join("|")}`);
  }
  const pattern = str(raw.pattern);
  if (pattern !== undefined) {
    if (!pattern || pattern.length > MAX_PATTERN) {
      errors.push(`pattern 长度必须在 1–${MAX_PATTERN}`);
    } else {
      try {
        new RegExp(pattern, "g");
      } catch (err) {
        errors.push(`pattern 不是合法正则：${(err as Error).message}`);
      }
    }
  }
  const normalizersRaw = raw.normalizers;
  let normalizers: AnswerNormalizer[] | undefined;
  if (normalizersRaw !== undefined) {
    if (!Array.isArray(normalizersRaw)) {
      errors.push("normalizers 必须是数组");
    } else {
      normalizers = [];
      for (const n of normalizersRaw) {
        if (typeof n !== "string" || !(ANSWER_NORMALIZERS as readonly string[]).includes(n)) {
          errors.push(`normalizers 含未知项：${String(n)}`);
        } else {
          normalizers.push(n as AnswerNormalizer);
        }
      }
      if (normalizers.length > 8) errors.push("normalizers 最多 8 项");
    }
  }
  if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") {
    errors.push("caseSensitive 必须是布尔值");
  }
  const requiredEvidence = str(raw.requiredEvidence);
  if (
    requiredEvidence !== undefined &&
    !(EVIDENCE_LEVELS as readonly string[]).includes(requiredEvidence)
  ) {
    errors.push("requiredEvidence 必须是 E0|E1|E2");
  }
  const exportTemplate = str(raw.exportTemplate);
  if (exportTemplate !== undefined && (!exportTemplate.trim() || exportTemplate.length > MAX_TEMPLATE)) {
    errors.push(`exportTemplate 长度必须在 1–${MAX_TEMPLATE}`);
  }
  const field = str(raw.field);
  if (field !== undefined && field.length > MAX_FIELD) {
    errors.push(`field 最长 ${MAX_FIELD}`);
  }
  let aliases: string[] | undefined;
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases)) {
      errors.push("aliases 必须是数组");
    } else {
      aliases = [];
      for (const a of raw.aliases) {
        if (typeof a !== "string" || !a.trim() || a.length > MAX_ALIAS_LEN) {
          errors.push(`aliases 含非法项（非空字符串、<=${MAX_ALIAS_LEN}）`);
        } else {
          aliases.push(a.trim());
        }
      }
      if (aliases.length > MAX_ALIASES) errors.push(`aliases 最多 ${MAX_ALIASES} 项`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const typedMode = mode as AnswerMode;
  const answerType = (answerTypeRaw as AnswerType | undefined) ?? defaultType(typedMode);
  const spec: AnswerSpec = {
    mode: typedMode,
    answerType,
    caseSensitive: raw.caseSensitive === true,
    requiredEvidence: (requiredEvidence as EvidenceLevel | undefined) ?? "E1",
    normalizers: normalizers ?? ["trim"],
  };
  const finalPattern = pattern ?? defaultPattern(typedMode, answerType);
  if (finalPattern) spec.pattern = finalPattern;
  if (exportTemplate) spec.exportTemplate = exportTemplate;
  if (field) spec.field = field;
  if (aliases && aliases.length) spec.aliases = aliases;
  return { ok: true, errors: [], spec };
}

/** 宽松读取：非法/缺失都回落默认 spec，并把原因交给调用方记录。 */
export function parseAnswerSpec(raw: unknown): { spec: AnswerSpec; error?: string } {
  if (raw === undefined || raw === null) return { spec: { ...DEFAULT_ANSWER_SPEC } };
  if (typeof raw === "string") {
    if (!raw.trim()) return { spec: { ...DEFAULT_ANSWER_SPEC } };
    try {
      return parseAnswerSpec(JSON.parse(raw));
    } catch {
      return { spec: { ...DEFAULT_ANSWER_SPEC }, error: "answer_spec 不是合法 JSON，已回落默认 flag 规则" };
    }
  }
  const res = validateAnswerSpec(raw);
  if (!res.ok) {
    return {
      spec: { ...DEFAULT_ANSWER_SPEC },
      error: `answerSpec 非法，已回落默认 flag 规则：${res.errors.join("；")}`,
    };
  }
  return { spec: res.spec! };
}

/** 稳定标识：用于候选的 specId，便于区分同一任务换过格式。 */
export function answerSpecId(spec: AnswerSpec): string {
  const canonical = JSON.stringify({
    mode: spec.mode,
    pattern: spec.pattern ?? "",
    answerType: spec.answerType ?? "",
    caseSensitive: spec.caseSensitive === true,
    normalizers: spec.normalizers ?? [],
  });
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  if (spec === DEFAULT_ANSWER_SPEC) return DEFAULT_SPEC_ID;
  return `spec-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** 把导出模板里的占位符替换成实际值；未知占位符原样保留。 */
export function renderAnswerTemplate(
  template: string | undefined,
  values: { value: string; answerType?: string; taskTitle?: string; candidateId?: string },
): string | null {
  if (!template) return null;
  return template
    .replace(/\$\{value\}/g, values.value)
    .replace(/\$\{answerType\}/g, values.answerType ?? "")
    .replace(/\$\{taskTitle\}/g, values.taskTitle ?? "")
    .replace(/\$\{candidateId\}/g, values.candidateId ?? "");
}
