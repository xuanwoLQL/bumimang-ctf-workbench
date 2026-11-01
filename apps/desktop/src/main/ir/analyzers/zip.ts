/**
 * V2-P0-4：ZIP 分析器。
 *
 * 复用 artifacts/zip 的 slip/加密/限额校验；解压到系统临时目录，
 * 再对文本/脚本条目跑 text-log / webshell；完成后清理。
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IrAnalysisResult, IrAnalyzer, IrContext, IrInput } from "../registry.ts";
import { emptyResult } from "../registry.ts";
import { extractZip, inspectZip } from "../../artifacts/zip.ts";
import { textLogAnalyzer } from "./text-log.ts";
import { webshellAnalyzer } from "./webshell.ts";

function isZip(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(4);
      const n = readSync(fd, buf, 0, 4, 0);
      if (n < 4) return false;
      return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export const zipAnalyzer: IrAnalyzer = {
  id: "zip",
  title: "压缩包枚举",
  detect(input: IrInput, _ctx: IrContext): boolean {
    return input.kind === "file" && (input.relativePath.toLowerCase().endsWith(".zip") || isZip(input.absolutePath));
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(zipAnalyzer, input);
    const maxFiles = Math.min(ctx.limits.maxFiles, 200);
    const maxTotal = Math.min(ctx.limits.maxBytesPerFile * 8, 64 * 1024 * 1024);
    let info;
    try {
      info = await inspectZip(input.absolutePath, { maxFiles, maxTotalBytes: maxTotal });
    } catch (err) {
      base.warnings.push(`ZIP 校验失败：${(err as Error).message}`);
      return base;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "bumimang-ir-zip-"));
    try {
      const files = await extractZip(input.absolutePath, dir, { maxFiles, maxTotalBytes: maxTotal });
      let analyzed = 0;
      let hitFacts = 0;
      for (const file of files) {
        if (analyzed >= maxFiles) break;
        const abs = path.join(dir, ...file.relativePath.split("/"));
        const rel = `${input.relativePath}!/${file.relativePath}`;
        const child: IrInput = {
          taskId: input.taskId,
          workDir: input.workDir,
          absolutePath: abs,
          relativePath: rel,
          kind: "file",
          size: file.size,
        };
        for (const analyzer of [textLogAnalyzer, webshellAnalyzer]) {
          try {
            if (!(await analyzer.detect(child, ctx))) continue;
            const res = await analyzer.analyze(child, ctx);
            base.facts.push(...res.facts);
            base.timeline.push(...res.timeline);
            base.iocs.push(...res.iocs);
            base.warnings.push(...res.warnings.map((w) => `${rel}: ${w}`));
            hitFacts += res.facts.length;
          } catch (err) {
            base.warnings.push(`${rel} [${analyzer.id}] 失败：${(err as Error).message}`);
          }
        }
        analyzed++;
      }
      base.facts.push({
        schema: "ir.zip.summary",
        data: {
          path: input.relativePath,
          entries: info.fileCount,
          analyzed,
          factHits: hitFacts,
          totalBytes: info.totalBytes,
        },
        evidence: "E1",
        witness: input.relativePath,
      });
    } catch (err) {
      base.warnings.push(`ZIP 解压/分析失败：${(err as Error).message}`);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不阻塞 */
      }
    }
    // 限额：统一截断。
    base.facts = base.facts.slice(0, ctx.limits.maxFacts);
    base.timeline = base.timeline.slice(0, ctx.limits.maxTimeline);
    base.iocs = base.iocs.slice(0, ctx.limits.maxIocs);
    return base;
  },
};
