/**
 * V2-P0-4：Webshell / 可疑脚本启发式分析器（纯 JS）。
 *
 * 只读文件内容，输出候选事实与证据；不执行、不落盘、不访问网络。
 * 误报可能：signals/score 供人工复核，不自动确认。
 */

import path from "node:path";
import type { IrAnalysisResult, IrAnalyzer, IrContext, IrInput } from "../registry.ts";
import { emptyResult } from "../registry.ts";
import { looksText, readTextHead } from "../analyzer.ts";

const SCRIPT_EXT = new Set([".php", ".phtml", ".php5", ".jsp", ".jspx", ".asp", ".aspx", ".ashx", ".asmx"]);

interface Signal {
  id: string;
  re: RegExp;
  weight: number;
  label: string;
}

const SIGNALS: Signal[] = [
  { id: "eval", re: /\beval\s*\(/i, weight: 2, label: "eval()" },
  { id: "assert", re: /\bassert\s*\(/i, weight: 1, label: "assert()" },
  { id: "base64_decode", re: /\bbase64_decode\s*\(/i, weight: 2, label: "base64_decode()" },
  { id: "shell_exec", re: /\b(?:shell_exec|system|passthru|exec|popen|proc_open)\s*\(/i, weight: 2, label: "命令执行函数" },
  { id: "request", re: /\$_(?:POST|GET|REQUEST|COOKIE)\s*\[/i, weight: 1, label: "用户输入直接进入" },
  { id: "jsp_runtime", re: /Runtime\.getRuntime\(\)\.exec|ProcessBuilder/i, weight: 2, label: "JSP 命令执行" },
  { id: "aspx_process", re: /ProcessStartInfo|cmd\.exe|powershell/i, weight: 2, label: "ASPX 进程启动" },
  { id: "behinder", re: /behinder|冰蝎|e45e329feb5d925b/i, weight: 3, label: "冰蝎特征" },
  { id: "godzilla", re: /godzilla|哥斯拉|pass\s*=\s*["']\w+["'].*key/i, weight: 3, label: "哥斯拉特征" },
  { id: "fromcharcode", re: /fromCharCode|unescape\s*\(/i, weight: 1, label: "JS 编码混淆" },
  { id: "long_base64", re: /(?:[A-Za-z0-9+/]{80,}={0,2})/, weight: 1, label: "长 Base64 块" },
  { id: "obfuscated", re: /\$[A-Za-z_]\w*\s*\(\s*\$[A-Za-z_]\w*\s*\(\s*\$/i, weight: 2, label: "多层变量函数调用" },
];

export const webshellAnalyzer: IrAnalyzer = {
  id: "webshell",
  title: "Webshell / 可疑脚本",
  detect(input: IrInput, _ctx: IrContext): boolean {
    if (input.kind !== "file") return false;
    const ext = path.extname(input.relativePath).toLowerCase();
    return SCRIPT_EXT.has(ext) || looksText(input.absolutePath) && /<\?php|<%@|<%|eval\s*\(/i.test(readTextHead(input.absolutePath, 8192).text);
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(webshellAnalyzer, input);
    const read = readTextHead(input.absolutePath, Math.min(ctx.limits.maxBytesPerFile, 2 * 1024 * 1024));
    if (!read.text) return base;
    const hits = SIGNALS.filter((s) => s.re.test(read.text));
    const score = hits.reduce((n, h) => n + h.weight, 0);
    if (hits.length === 0 || score < 2) return base;
    base.facts.push({
      schema: "ir.webshell",
      data: {
        path: input.relativePath,
        score,
        signals: hits.map((h) => h.label),
        size: input.size ?? read.bytes,
        truncated: read.truncated,
      },
      evidence: "E1",
      witness: input.relativePath,
    });
    base.warnings.push(
      `可疑脚本：${input.relativePath}（score=${score}，${hits.map((h) => h.label).join(", ")}）；需人工确认`,
    );
    base.iocs.push({
      type: "path",
      value: input.relativePath,
      count: 1,
      evidence: "E1",
      witness: input.relativePath,
    });
    return base;
  },
};
