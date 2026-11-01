/**
 * V2-P0-4：IR 分析编排。
 *
 * - 输入枚举：任务目录内 attachments/evidence/artifacts（或调用方指定路径）；
 * - 路径安全：realpath + 根包含；跳过 symlink/junction；
 * - 每个分析器独立 try/catch；失败只变成 warning，不影响其它分析器；
 * - 输出按 limits 截断并写 warning；sha256 流式计算。
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveWithinTask } from "../artifacts/preview.ts";
import type { IrAnalyzer, IrContext, IrInput, IrLimits, IrAnalysisResult } from "./registry.ts";
import { DEFAULT_IR_LIMITS, type IrRegistry } from "./registry.ts";
import { sha256File } from "./spawn.ts";

export interface CollectInputsOptions {
  taskId: string;
  taskDir: string;
  /** 任务内相对路径或任务内绝对路径；缺省扫描 attachments/evidence/artifacts。 */
  paths?: string[];
  limits?: Partial<IrLimits>;
}

export interface CollectInputsResult {
  inputs: IrInput[];
  warnings: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function within(taskDir: string, abs: string): boolean {
  const rel = path.relative(taskDir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function walk(dir: string, taskDir: string, depth: number, maxDepth: number, maxFiles: number, out: IrInput[], warnings: string[]): void {
  if (depth > maxDepth) {
    warnings.push(`目录深度超过 ${maxDepth}，已跳过：${toPosix(path.relative(taskDir, dir))}`);
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`目录不可读：${toPosix(path.relative(taskDir, dir))}（${(err as Error).message}）`);
    return;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) {
      warnings.push(`文件数超过上限 ${maxFiles}，已截断`);
      return;
    }
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      warnings.push(`跳过符号链接/junction：${toPosix(path.relative(taskDir, abs))}`);
      continue;
    }
    if (ent.isDirectory()) {
      walk(abs, taskDir, depth + 1, maxDepth, maxFiles, out, warnings);
      continue;
    }
    if (!ent.isFile()) continue;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!within(taskDir, real)) {
      warnings.push(`跳过越界路径：${toPosix(path.relative(taskDir, abs))}`);
      continue;
    }
    let size = 0;
    try {
      size = statSync(real).size;
    } catch {
      continue;
    }
    out.push({
      taskId: "",
      workDir: taskDir,
      absolutePath: real,
      relativePath: toPosix(path.relative(taskDir, real)),
      kind: "file",
      size,
    });
  }
}

function resolveOne(taskDir: string, raw: string): string {
  const absRaw = path.isAbsolute(raw) ? raw : resolveWithinTask(taskDir, raw);
  const real = realpathSync(absRaw);
  if (!within(taskDir, real)) throw new Error(`路径越界：${raw}`);
  return real;
}

export function collectIrInputs(opts: CollectInputsOptions): CollectInputsResult {
  const limits = { ...DEFAULT_IR_LIMITS, ...(opts.limits ?? {}) };
  const taskDir = realpathSync(opts.taskDir);
  const inputs: IrInput[] = [];
  const warnings: string[] = [];
  const roots = opts.paths && opts.paths.length > 0 ? opts.paths : ["attachments", "evidence", "artifacts"];
  for (const raw of roots) {
    let real: string;
    try {
      real = resolveOne(taskDir, raw);
    } catch (err) {
      if (opts.paths && opts.paths.length > 0) warnings.push((err as Error).message);
      continue;
    }
    let st;
    try {
      st = lstatSync(real);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      inputs.push({
        taskId: opts.taskId,
        workDir: taskDir,
        absolutePath: real,
        relativePath: toPosix(path.relative(taskDir, real)),
        kind: "dir",
      });
      walk(real, taskDir, 0, limits.maxDepth, limits.maxFiles, inputs, warnings);
    } else if (st.isFile()) {
      inputs.push({
        taskId: opts.taskId,
        workDir: taskDir,
        absolutePath: real,
        relativePath: toPosix(path.relative(taskDir, real)),
        kind: "file",
        size: st.size,
      });
    }
  }
  // 去重（目录输入 + 文件输入可能重复）
  const seen = new Set<string>();
  const unique = inputs.filter((i) => {
    const key = `${i.kind}:${i.absolutePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const input of unique) input.taskId = opts.taskId;
  return { inputs: unique, warnings };
}

export interface RunIrAnalysisOptions {
  inputs: IrInput[];
  registry: IrRegistry;
  ctx: IrContext;
  concurrency?: number;
}

export interface IrAnalysisBundle {
  results: IrAnalysisResult[];
  warnings: string[];
  inputs: IrInput[];
  durationMs: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function trimResult(result: IrAnalysisResult, limits: IrLimits): IrAnalysisResult {
  const out: IrAnalysisResult = {
    ...result,
    facts: result.facts.slice(0, limits.maxFacts),
    timeline: result.timeline.slice(0, limits.maxTimeline),
    iocs: result.iocs.slice(0, limits.maxIocs),
    warnings: result.warnings.slice(0, limits.maxWarnings),
    toolLogs: result.toolLogs.slice(0, 50),
  };
  if (result.facts.length > out.facts.length) out.warnings.push(`facts 超过上限 ${limits.maxFacts}，已截断`);
  if (result.timeline.length > out.timeline.length) out.warnings.push(`timeline 超过上限 ${limits.maxTimeline}，已截断`);
  if (result.iocs.length > out.iocs.length) out.warnings.push(`iocs 超过上限 ${limits.maxIocs}，已截断`);
  return out;
}

export async function runIrAnalysis(opts: RunIrAnalysisOptions): Promise<IrAnalysisBundle> {
  const started = Date.now();
  const warnings: string[] = [];
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  const perInput = await mapLimit(opts.inputs, concurrency, async (input) => {
    const results: IrAnalysisResult[] = [];
    let analyzers: IrAnalyzer[] = [];
    try {
      analyzers = await opts.registry.detect(input, opts.ctx);
    } catch (err) {
      warnings.push(`${input.relativePath}: detect 失败（${(err as Error).message}）`);
      return results;
    }
    if (input.kind === "file" && !input.sha256) {
      try {
        input.sha256 = await sha256File(input.absolutePath);
      } catch (err) {
        warnings.push(`${input.relativePath}: sha256 计算失败（${(err as Error).message}）`);
      }
    }
    for (const analyzer of analyzers) {
      try {
        opts.ctx.audit?.("ir.analyzer.start", {
          analyzer: analyzer.id,
          input: input.relativePath,
          kind: input.kind,
        });
        const result = trimResult(await analyzer.analyze(input, opts.ctx), opts.ctx.limits);
        results.push(result);
        warnings.push(...result.warnings.map((w) => `${input.relativePath} [${analyzer.id}] ${w}`));
        opts.ctx.audit?.("ir.analyzer.done", {
          analyzer: analyzer.id,
          input: input.relativePath,
          facts: result.facts.length,
          timeline: result.timeline.length,
          iocs: result.iocs.length,
          warnings: result.warnings.length,
          tools: result.toolLogs.length,
        });
      } catch (err) {
        const msg = `${input.relativePath} [${analyzer.id}] 分析失败：${(err as Error).message}`;
        warnings.push(msg);
        opts.ctx.audit?.("ir.analyzer.error", { analyzer: analyzer.id, input: input.relativePath });
      }
    }
    return results;
  });
  return {
    results: perInput.flat(),
    warnings: warnings.slice(0, DEFAULT_IR_LIMITS.maxWarnings),
    inputs: opts.inputs,
    durationMs: Date.now() - started,
  };
}

/** 快速判断文件头是否像文本（供分析器复用）。 */
export function looksText(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      const head = buf.subarray(0, n);
      let bad = 0;
      for (const b of head) {
        if (b === 0) return false;
        if (b < 7 || (b > 13 && b < 32)) bad++;
      }
      return head.length === 0 || bad / head.length < 0.1;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function readTextHead(file: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const st = statSync(file);
  const len = Math.min(st.size, maxBytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    return { text: buf.subarray(0, n).toString("utf8"), truncated: st.size > len, bytes: n };
  } finally {
    closeSync(fd);
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
