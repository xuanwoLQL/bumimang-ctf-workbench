/**
 * V2-P0-4：文件系统 / 目录分析器（纯 JS，只读元数据）。
 *
 * 只对 kind=dir 生效；不读文件内容（Webshell/日志由其它分析器读）。
 * 输出：近期修改文件、Web 根/启动项/计划任务等可疑路径、按 mtime 的时间线。
 * 所有路径必须已在 collectIrInputs 中过 realpath/根包含；这里再做一次防御。
 */

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { IrAnalysisResult, IrAnalyzer, IrContext, IrInput } from "../registry.ts";
import { emptyResult } from "../registry.ts";

const SUSPICIOUS_PATH =
  /(webshell|shell|backdoor|behinder|godzilla|miner|xmrig|ransom|\.locked$|\/tmp\/|startup|cron|systemd\/system|authorized_keys|\.ssh\/|win\.ini|web\.config)/i;
const EXEC_EXT = new Set([".exe", ".dll", ".ps1", ".bat", ".cmd", ".sh", ".elf", ".so", ".scr", ".vbs", ".js"]);

function within(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface Found {
  abs: string;
  rel: string;
  size: number;
  mtime: number;
  mode: number;
}

function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  maxFiles: number,
  out: Found[],
  warnings: string[],
): void {
  if (depth > maxDepth || out.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`目录不可读：${path.relative(root, dir)}（${(err as Error).message}）`);
    return;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) {
      warnings.push(`文件数超过上限 ${maxFiles}，已截断`);
      return;
    }
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      warnings.push(`跳过符号链接/junction：${path.relative(root, abs)}`);
      continue;
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!within(root, real)) {
      warnings.push(`跳过越界路径：${path.relative(root, abs)}`);
      continue;
    }
    if (ent.isDirectory()) {
      walk(root, real, depth + 1, maxDepth, maxFiles, out, warnings);
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      const st = lstatSync(real);
      out.push({
        abs: real,
        rel: path.relative(root, real).split(path.sep).join("/"),
        size: st.size,
        mtime: st.mtimeMs,
        mode: st.mode,
      });
    } catch {
      /* 文件在扫描期间消失 */
    }
  }
}

export const filesystemAnalyzer: IrAnalyzer = {
  id: "filesystem",
  title: "文件系统 / 目录",
  detect(input: IrInput, _ctx: IrContext): boolean {
    return input.kind === "dir";
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(filesystemAnalyzer, input);
    const files: Found[] = [];
    walk(input.absolutePath, input.absolutePath, 0, ctx.limits.maxDepth, ctx.limits.maxFiles, files, base.warnings);
    if (files.length === 0) {
      base.warnings.push(`目录为空或不可读：${input.relativePath}`);
      return base;
    }
    const recentCutoff = ctx.now - 30 * 24 * 3600_000;
    const recent = files.filter((f) => f.mtime >= recentCutoff).sort((a, b) => b.mtime - a.mtime);
    const suspicious = files.filter((f) => {
      const ext = path.extname(f.rel).toLowerCase();
      return SUSPICIOUS_PATH.test(f.rel) || EXEC_EXT.has(ext);
    });
    for (const f of recent.slice(0, 100)) {
      base.timeline.push({
        at: Math.round(f.mtime),
        source: "file",
        event: `${f.rel} 修改（${f.size} 字节）`,
        evidence: "E1",
        witness: f.rel,
      });
    }
    for (const f of suspicious.slice(0, 100)) {
      base.facts.push({
        schema: "ir.file_suspicious",
        data: {
          path: f.rel,
          size: f.size,
          mtime: Math.round(f.mtime),
          reason: SUSPICIOUS_PATH.test(f.rel) ? "path-pattern" : "executable-extension",
        },
        evidence: "E1",
        witness: f.rel,
      });
      base.iocs.push({
        type: "path",
        value: f.rel,
        count: 1,
        firstSeen: Math.round(f.mtime),
        evidence: "E1",
        witness: f.rel,
      });
    }
    base.facts.push({
      schema: "ir.file.summary",
      data: {
        root: input.relativePath,
        files: files.length,
        recent: recent.length,
        suspicious: suspicious.length,
        topRecent: recent.slice(0, 20).map((f) => ({ path: f.rel, mtime: Math.round(f.mtime), size: f.size })),
        suspiciousPaths: suspicious.slice(0, 50).map((f) => f.rel),
      },
      evidence: "E1",
      witness: input.relativePath,
    });
    if (base.timeline.length > 0) {
      base.timeline.sort((a, b) => a.at - b.at);
    }
    return base;
  },
};
