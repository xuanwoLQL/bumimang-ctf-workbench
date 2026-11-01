/**
 * V2-P0-2：答案归一化链。
 *
 * 只在候选层面使用；原始 value 始终保留，便于人工核对与导出。
 * base64/hex 解码失败时原样返回（不把半截解码结果当答案）。
 */

import type { AnswerNormalizer, AnswerType } from "../../../../../packages/shared-protocol/events.ts";

function printableRatio(text: string): number {
  if (!text) return 0;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d) {
      printable++;
    } else if (code > 0x7f) {
      // 非 ASCII 的 UTF-8 文本（中文答案）也算可打印；控制字符不算。
      printable++;
    }
  }
  return printable / [...text].length;
}

export function decodeBase64Loose(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 8192) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  if (trimmed.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (!decoded || printableRatio(decoded) < 0.9) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function decodeHexLoose(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 8192 || trimmed.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    if (!decoded || printableRatio(decoded) < 0.9) return null;
    return decoded;
  } catch {
    return null;
  }
}

function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function normalizePathValue(text: string): string {
  let v = text.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (v.length > 1 && v.endsWith("/")) v = v.slice(0, -1);
  return v;
}

/** 按顺序应用 normalizer；解码类失败时保留原值。 */
export function applyNormalizers(value: string, normalizers: AnswerNormalizer[] | undefined): string {
  let out = value;
  for (const n of normalizers ?? ["trim"]) {
    switch (n) {
      case "trim":
        out = out.trim();
        break;
      case "lower":
        out = out.toLowerCase();
        break;
      case "upper":
        out = out.toUpperCase();
        break;
      case "strip_quotes":
        out = stripQuotes(out);
        break;
      case "collapse_ws":
        out = out.replace(/\s+/g, " ").trim();
        break;
      case "normalize_path":
        out = normalizePathValue(out);
        break;
      case "base64_decode":
        out = decodeBase64Loose(out) ?? out;
        break;
      case "hex_decode":
        out = decodeHexLoose(out) ?? out;
        break;
      default:
        break;
    }
  }
  return out;
}

/** 去重键：hash/ip/账号按大小写不敏感，其余保留大小写。 */
export function canonicalAnswer(value: string, type: AnswerType | undefined): string {
  const base = value.trim();
  if (type === "hash" || type === "ip" || type === "account") return base.toLowerCase();
  if (type === "path") return normalizePathValue(base);
  return base;
}
