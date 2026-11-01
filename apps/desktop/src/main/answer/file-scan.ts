/**
 * V2-P0-2：附件/工件答案扫描（文本 + ZIP）。
 *
 * 安全边界：
 *  - 路径一律过 preview.resolveWithinTask（拒绝越界/symlink/junction）；
 *  - 文本扫描前先嗅探 4KB，二进制不按文本扫；
 *  - 分块 + 重叠，跨块命中可拼回；记录任务内相对路径、行号、字节偏移；
 *  - ZIP 只读枚举 + 限量解压到系统临时目录，复用 artifacts/zip 的 slip/加密/限额校验；
 *  - 所有结果只是候选（默认 E1），不确认、不提交。
 */

import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnswerSpec, EvidenceLevel } from "../../../../../packages/shared-protocol/events.ts";
import { extractZip, inspectZip, ZipError } from "../artifacts/zip.ts";
import { looksLikeTextBytes, normalizeRelativePath, resolveWithinTask } from "../artifacts/preview.ts";
import { detectAnswers, type AnswerHit } from "./detectors.ts";

export interface AnswerFileHit extends AnswerHit {
  /** 任务内 POSIX 相对路径；ZIP 内条目形如 `attachments/a.zip!/dir/x.txt`。 */
  relativePath: string;
  evidence: EvidenceLevel;
}

export interface ScanLimits {
  maxBytes?: number;
  chunkBytes?: number;
  overlapBytes?: number;
  maxZipFiles?: number;
  maxZipTotalBytes?: number;
  maxHits?: number;
}

export const DEFAULT_SCAN_LIMITS: Required<ScanLimits> = {
  maxBytes: 4 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  // 答案最长 4096；重叠必须覆盖一个完整答案 + 前缀，避免跨块长答案被截断。
  overlapBytes: 8192,
  maxZipFiles: 200,
  maxZipTotalBytes: 64 * 1024 * 1024,
  maxHits: 500,
};

export interface FileScanResult {
  hits: AnswerFileHit[];
  skipped?: "binary" | "not-file" | "too-large" | "zip-error";
  warning?: string;
  bytesRead: number;
}

function readHead(file: string, max: number): Buffer {
  const size = statSync(file).size;
  const len = Math.min(size, max);
  if (len <= 0) return Buffer.alloc(0);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 扫描一个**已解析为绝对路径**的文本文件。`displayPath` 是给用户看的来源路径。
 * 不在这里做越界检查；调用方必须先过 resolveWithinTask。
 */
export function scanTextFile(input: {
  file: string;
  displayPath: string;
  spec: AnswerSpec;
  limits?: ScanLimits;
}): FileScanResult {
  const limits = { ...DEFAULT_SCAN_LIMITS, ...(input.limits ?? {}) };
  const st = statSync(input.file);
  if (!st.isFile()) return { hits: [], skipped: "not-file", bytesRead: 0 };
  // 文本嗅探：只读前 4KB，二进制不进文本检测器（后续可由 P0-4 插件接手）。
  if (!looksLikeTextBytes(readHead(input.file, 4096))) {
    return { hits: [], skipped: "binary", bytesRead: 0 };
  }

  const max = Math.min(limits.maxBytes, st.size);
  if (max <= 0) return { hits: [], skipped: "too-large", bytesRead: 0 };

  const hits: AnswerFileHit[] = [];
  const seen = new Set<string>();
  const fd = openSync(input.file, "r");
  let bytesRead = 0;
  try {
    let pos = 0;
    let tail = "";
    let lineBase = 1;
    while (pos < max) {
      const len = Math.min(limits.chunkBytes, max - pos);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      bytesRead += n;
      const text = tail + buf.subarray(0, n).toString("utf8");
      const chunkStart = pos - n;
      const base = chunkStart - tail.length;
      const detected = detectAnswers(text, input.spec, {
        evidence: "E1",
        maxHits: Math.max(1, limits.maxHits - hits.length),
      });
      for (const h of detected) {
        const absOffset = base + (h.offset ?? 0);
        const key = `${h.answerType}|${h.normalizedValue}|${absOffset}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          ...h,
          offset: absOffset,
          line: lineBase + ((h.line ?? 1) - 1),
          relativePath: input.displayPath,
          evidence: "E1",
        });
        if (hits.length >= limits.maxHits) break;
      }
      if (hits.length >= limits.maxHits) break;
      const nextTailLen = Math.min(limits.overlapBytes, text.length);
      const nextTail = nextTailLen > 0 ? text.slice(-nextTailLen) : "";
      const consumed = text.slice(0, text.length - nextTail.length);
      lineBase += countNewlines(consumed);
      tail = nextTail;
    }
  } finally {
    closeSync(fd);
  }
  return { hits, bytesRead };
}

/** 扫描任务内一个相对路径：.zip 走压缩包枚举，其余按文本。 */
export async function scanAttachmentAnswers(input: {
  taskDir: string;
  relativePath: string;
  spec: AnswerSpec;
  limits?: ScanLimits;
}): Promise<FileScanResult & { zipEntries?: number }> {
  const rel = normalizeRelativePath(input.relativePath);
  const real = resolveWithinTask(input.taskDir, rel);
  const st = statSync(real);
  if (!st.isFile()) return { hits: [], skipped: "not-file", bytesRead: 0 };
  const limits = { ...DEFAULT_SCAN_LIMITS, ...(input.limits ?? {}) };
  const head = readHead(real, 4);
  const isZip = head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7) && (head[3] === 4 || head[3] === 6 || head[3] === 8);
  if (rel.toLowerCase().endsWith(".zip") || isZip) {
    return scanZipAnswers({ zipFile: real, displayPath: rel, spec: input.spec, limits });
  }
  return scanTextFile({ file: real, displayPath: rel, spec: input.spec, limits });
}

/** ZIP：先 inspect 限额，再解压到临时目录扫描；失败返回可读 warning，不抛到会话层。 */
export async function scanZipAnswers(input: {
  zipFile: string;
  displayPath: string;
  spec: AnswerSpec;
  limits?: ScanLimits;
}): Promise<FileScanResult & { zipEntries?: number }> {
  const limits = { ...DEFAULT_SCAN_LIMITS, ...(input.limits ?? {}) };
  let info;
  try {
    info = await inspectZip(input.zipFile, {
      maxFiles: limits.maxZipFiles,
      maxTotalBytes: limits.maxZipTotalBytes,
    });
  } catch (err) {
    return {
      hits: [],
      skipped: "zip-error",
      warning: err instanceof ZipError ? `${err.code}: ${err.message}` : (err as Error).message,
      bytesRead: 0,
    };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "bumimang-answer-zip-"));
  try {
    const files = await extractZip(input.zipFile, dir, {
      maxFiles: limits.maxZipFiles,
      maxTotalBytes: limits.maxZipTotalBytes,
    });
    const hits: AnswerFileHit[] = [];
    let bytesRead = 0;
    let budget = limits.maxZipTotalBytes;
    for (const f of files) {
      if (hits.length >= limits.maxHits) break;
      const abs = path.join(dir, ...f.relativePath.split("/"));
      const perFileMax = Math.min(limits.maxBytes, Math.max(0, budget));
      if (perFileMax <= 0) break;
      const res = scanTextFile({
        file: abs,
        displayPath: `${input.displayPath}!/${f.relativePath}`,
        spec: input.spec,
        limits: { ...limits, maxBytes: perFileMax, maxHits: limits.maxHits - hits.length },
      });
      bytesRead += res.bytesRead;
      budget -= res.bytesRead;
      hits.push(...res.hits);
    }
    return { hits, bytesRead, zipEntries: info.fileCount };
  } catch (err) {
    return {
      hits: [],
      skipped: "zip-error",
      warning: err instanceof ZipError ? `${err.code}: ${err.message}` : (err as Error).message,
      bytesRead: 0,
      zipEntries: info.fileCount,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 扫描任务内一个 Buffer（测试/插件用）。 */
export function scanBufferAnswers(input: {
  buffer: Buffer;
  displayPath: string;
  spec: AnswerSpec;
  evidence?: EvidenceLevel;
  maxHits?: number;
}): AnswerFileHit[] {
  if (!looksLikeTextBytes(input.buffer.subarray(0, 4096))) return [];
  const text = input.buffer.toString("utf8");
  return detectAnswers(text, input.spec, {
    evidence: input.evidence ?? "E1",
    maxHits: input.maxHits ?? DEFAULT_SCAN_LIMITS.maxHits,
  }).map((h) => ({
    ...h,
    relativePath: input.displayPath,
    evidence: input.evidence ?? "E1",
  }));
}
