/**
 * V2-P0-2：统一答案检测器。
 *
 * 所有检测器只产生候选（带来源/行号/偏移/证据等级），不确认、不提交。
 * 旧 `flag{...}` 由默认 AnswerSpec 走同一条路径；禁止在别处再写一套正则。
 */

import type {
  AnswerSpec,
  AnswerType,
  EvidenceLevel,
} from "../../../../../packages/shared-protocol/events.ts";
import { applyNormalizers, canonicalAnswer, decodeBase64Loose, decodeHexLoose } from "./normalize.ts";

export interface AnswerHit {
  /** 原始答案（保留大小写/包裹符号），供人工核对。 */
  value: string;
  /** 归一化后的值（去重/导出用）。 */
  normalizedValue: string;
  answerType: AnswerType;
  detectorId: string;
  evidence: EvidenceLevel;
  confidence: number;
  /** 文本内行号（1-based）；未知时缺省。 */
  line?: number;
  /** 文本内字节/字符偏移（0-based）；未知时缺省。 */
  offset?: number;
  /** 是否经过编码层（base64/hex）。 */
  decoded?: "base64" | "hex";
}

export interface AnswerDetectContext {
  evidence?: EvidenceLevel;
  maxHits?: number;
  /** 是否允许 base64/hex 包裹检测（默认 true；内层递归时关闭）。 */
  allowDecode?: boolean;
}

export interface CompiledAnswerSpec {
  spec: AnswerSpec;
  regex: RegExp | null;
}

const MAX_VALUE = 4096;
const DEFAULT_MAX_HITS = 500;

export function compileAnswerSpec(spec: AnswerSpec): CompiledAnswerSpec {
  if (!spec.pattern) return { spec, regex: null };
  try {
    return { spec, regex: new RegExp(spec.pattern, spec.caseSensitive ? "g" : "gi") };
  } catch {
    return { spec, regex: null };
  }
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function safeValue(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.includes("�") || value.includes("\0")) return null;
  if (value.length > MAX_VALUE) return null;
  return value;
}

function makeHit(input: {
  value: string;
  spec: AnswerSpec;
  detectorId: string;
  evidence: EvidenceLevel;
  confidence: number;
  line?: number;
  offset?: number;
  decoded?: "base64" | "hex";
}): AnswerHit | null {
  const raw = safeValue(input.value);
  if (!raw) return null;
  const answerType = input.spec.answerType ?? (input.spec.mode === "flag_regex" ? "flag" : "text");
  const normalized = applyNormalizers(raw, input.spec.normalizers);
  const canonical = canonicalAnswer(normalized, answerType);
  if (!canonical) return null;
  return {
    value: raw,
    normalizedValue: canonical,
    answerType,
    detectorId: input.detectorId,
    evidence: input.evidence,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.decoded ? { decoded: input.decoded } : {}),
  };
}

function detectWithPattern(
  text: string,
  compiled: CompiledAnswerSpec,
  ctx: Required<Pick<AnswerDetectContext, "evidence" | "maxHits">>,
  detectorId: string,
  confidence: number,
): AnswerHit[] {
  const regex = compiled.regex;
  if (!regex) return [];
  const hits: AnswerHit[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    const raw = (m[1] ?? m[0]) as string;
    const offset = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
    const hit = makeHit({
      value: raw,
      spec: compiled.spec,
      detectorId,
      evidence: ctx.evidence,
      confidence,
      line: lineAt(text, offset),
      offset,
    });
    if (hit) hits.push(hit);
    if (hits.length >= ctx.maxHits) break;
  }
  return hits;
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

const TYPE_PATTERNS: Partial<Record<AnswerType, Array<{ re: RegExp; detector: string; confidence: number; validate?: (v: string) => boolean }>>> = {
  ip: [
    {
      re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      detector: "typed-ipv4",
      confidence: 0.8,
      validate: isValidIpv4,
    },
  ],
  hash: [
    {
      re: /\b[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{40}\b|\b[0-9a-fA-F]{32}\b/g,
      detector: "typed-hash",
      confidence: 0.85,
    },
  ],
  timestamp: [
    {
      re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
      detector: "typed-timestamp-iso",
      confidence: 0.8,
    },
    {
      re: /\b\d{4}-\d{2}-\d{2}\b/g,
      detector: "typed-timestamp-date",
      confidence: 0.55,
    },
  ],
  path: [
    {
      re: /(?:\/(?:[A-Za-z0-9._-]+)){2,}/g,
      detector: "typed-path-unix",
      confidence: 0.55,
    },
    {
      re: /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g,
      detector: "typed-path-windows",
      confidence: 0.6,
    },
  ],
  process: [
    {
      re: /\b[A-Za-z0-9_.-]+\.(?:exe|dll|bin|elf)\b/gi,
      detector: "typed-process-image",
      confidence: 0.55,
    },
    {
      re: /(?:进程|process)\s*[:：=]\s*([A-Za-z0-9_.\\/-]{1,128})/gi,
      detector: "typed-process-context",
      confidence: 0.65,
    },
  ],
  command: [
    {
      re: /^[ \t]*(?:sudo\s+)?(?:bash|sh|cmd(?:\.exe)?|powershell(?:\.exe)?|python[0-9.]*|curl|wget|nc|ncat|ssh|scp|chmod|chattr|crontab|systemctl|net|reg|schtasks)\b[^\r\n]*/gim,
      detector: "typed-command-line",
      confidence: 0.5,
    },
  ],
  account: [
    {
      re: /(?:user(?:name)?|account|账号|用户名)\s*[:：=]\s*([A-Za-z0-9_.\\$-]{1,64})/gi,
      detector: "typed-account-context",
      confidence: 0.65,
    },
    {
      re: /(?:home|Users)[\\/]([A-Za-z0-9_.-]{1,64})/gi,
      detector: "typed-account-home",
      confidence: 0.5,
    },
  ],
  text: [
    {
      re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
      detector: "typed-uuid",
      confidence: 0.85,
    },
  ],
};

function detectTypedBuiltins(
  text: string,
  spec: AnswerSpec,
  evidence: EvidenceLevel,
  maxHits: number,
): AnswerHit[] {
  const type = spec.answerType ?? "text";
  const patterns = TYPE_PATTERNS[type] ?? [];
  const hits: AnswerHit[] = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      const raw = (m[1] ?? m[0]) as string;
      if (p.validate && !p.validate(raw)) continue;
      const offset = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
      const hit = makeHit({
        value: raw,
        spec,
        detectorId: p.detector,
        evidence,
        confidence: p.confidence,
        line: lineAt(text, offset),
        offset,
      });
      if (hit) hits.push(hit);
      if (hits.length >= maxHits) break;
    }
    if (hits.length >= maxHits) break;
  }
  return hits;
}

function detectFreeform(text: string, evidence: EvidenceLevel, maxHits: number): AnswerHit[] {
  const re = /^[ \t]*(?:答案|answer|flag(?:\s+is)?|结果)\s*[:：=]\s*(.{1,512})$/gim;
  const hits: AnswerHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const offset = m.index + m[0].indexOf(m[1]);
    const hit = makeHit({
      value: m[1],
      spec: { mode: "freeform", answerType: "text", normalizers: ["trim"] },
      detectorId: "freeform-keyword",
      evidence: "E0",
      confidence: 0.35,
      line: lineAt(text, offset),
      offset,
    });
    if (hit) hits.push(hit);
    if (hits.length >= maxHits) break;
  }
  // freeform 只产生候选；证据固定 E0（调用方传入的 evidence 不抬高它）。
  void evidence;
  return hits;
}

function detectDecodedWrappers(
  text: string,
  spec: AnswerSpec,
  evidence: EvidenceLevel,
  maxHits: number,
): AnswerHit[] {
  const hits: AnswerHit[] = [];
  const b64 = /[A-Za-z0-9+/]{16,}={0,2}/g;
  let m: RegExpExecArray | null;
  while ((m = b64.exec(text)) !== null) {
    const decoded = decodeBase64Loose(m[0]);
    if (!decoded) continue;
    const inner = detectAnswers(decoded, spec, {
      evidence,
      maxHits: Math.max(1, maxHits - hits.length),
      allowDecode: false,
    });
    for (const h of inner) {
      hits.push({
        ...h,
        decoded: "base64",
        detectorId: `base64:${h.detectorId}`,
        offset: m.index,
        line: lineAt(text, m.index),
      });
      if (hits.length >= maxHits) return hits;
    }
  }
  const hex = /\b(?:[0-9a-fA-F]{2}){8,}\b/g;
  while ((m = hex.exec(text)) !== null) {
    const decoded = decodeHexLoose(m[0]);
    if (!decoded) continue;
    const inner = detectAnswers(decoded, spec, {
      evidence,
      maxHits: Math.max(1, maxHits - hits.length),
      allowDecode: false,
    });
    for (const h of inner) {
      hits.push({
        ...h,
        decoded: "hex",
        detectorId: `hex:${h.detectorId}`,
        offset: m.index,
        line: lineAt(text, m.index),
      });
      if (hits.length >= maxHits) return hits;
    }
  }
  return hits;
}

/**
 * 从一段文本里检测候选。顺序：
 *   1. spec.pattern / 默认 flag 正则；
 *   2. typed 内置检测器（仅 typed 模式且没有 pattern 时）；
 *   3. freeform 关键词行（仅 freeform 模式）；
 *   4. base64/hex 包裹（可选）。
 * 返回按 (answerType, normalizedValue, line, offset) 去重后的命中。
 */
export function detectAnswers(
  text: string | null | undefined,
  spec: AnswerSpec,
  ctx: AnswerDetectContext = {},
): AnswerHit[] {
  if (!text) return [];
  const evidence = ctx.evidence ?? "E1";
  const maxHits = Math.max(1, Math.min(5000, ctx.maxHits ?? DEFAULT_MAX_HITS));
  const compiled = compileAnswerSpec(spec);
  const hits: AnswerHit[] = [];

  if (compiled.regex) {
    hits.push(
      ...detectWithPattern(
        text,
        compiled,
        { evidence, maxHits },
        spec.mode === "flag_regex" ? "flag-regex" : "typed-pattern",
        spec.mode === "freeform" ? 0.5 : 0.9,
      ),
    );
  } else if (spec.mode === "typed") {
    hits.push(...detectTypedBuiltins(text, spec, evidence, maxHits));
  } else if (spec.mode === "freeform") {
    hits.push(...detectFreeform(text, evidence, maxHits));
  }

  if (ctx.allowDecode !== false && hits.length < maxHits) {
    hits.push(...detectDecodedWrappers(text, spec, evidence, maxHits - hits.length));
  }

  const seen = new Set<string>();
  const out: AnswerHit[] = [];
  for (const h of hits) {
    const key = `${h.answerType}|${h.normalizedValue}|${h.line ?? ""}|${h.offset ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= maxHits) break;
  }
  return out;
}

/** 旧 API 兼容：默认 flag 规则，返回第一个命中值。 */
export function extractFlagCompat(text: string | null | undefined): string | null {
  const hit = detectAnswers(text, {
    mode: "flag_regex",
    pattern: "flag\\{[^}\\s]{3,256}\\}",
    answerType: "flag",
    normalizers: ["trim"],
    caseSensitive: false,
    requiredEvidence: "E1",
  })[0];
  return hit ? hit.value : null;
}
