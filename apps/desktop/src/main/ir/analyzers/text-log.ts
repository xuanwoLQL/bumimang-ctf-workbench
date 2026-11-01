/**
 * V2-P0-4：文本/日志分析器（纯 JS，无外部工具）。
 *
 * 只做“证据整理”：时间线、IP/URL/账号/命令/IOC、可疑行。
 * 不推断最终答案；问题映射由 questions.ts 在证据之上生成候选。
 */

import path from "node:path";
import type {
  IrAnalysisResult,
  IrAnalyzer,
  IrContext,
  IrInput,
  IrIoc,
  IrTimelineEvent,
} from "../registry.ts";
import { emptyResult } from "../registry.ts";
import { looksText, readTextHead } from "../analyzer.ts";

const TEXT_EXT = new Set([
  ".log",
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".md",
  ".conf",
  ".ini",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".php",
  ".jsp",
  ".jspx",
  ".asp",
  ".aspx",
  ".sh",
  ".ps1",
  ".bat",
  ".py",
  ".js",
  ".evtx.txt",
]);

const IPS = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URLS = /\bhttps?:\/\/[^\s"'<>]+/gi;
const ACCOUNTS =
  /(?:user(?:name)?|account|账号|用户名|login)\s*[:=]\s*([A-Za-z0-9_.\\$-]{1,64})/gi;
const COMMAND_LINE =
  /(?:^|[;&|]\s*|\s)(?:sudo\s+)?(?:bash|sh|cmd(?:\.exe)?|powershell(?:\.exe)?|python[0-9.]*|curl|wget|nc|ncat|ssh|scp|chmod|chattr|crontab|systemctl|net|reg|schtasks|mimikatz|procdump)\b[^\r\n]*/gim;
const SUSPICIOUS =
  /(webshell|behinder|godzilla|冰蝎|哥斯拉|eval\s*\(|base64_decode\s*\(|assert\s*\(|shell_exec\s*\(|system\s*\(|passthru\s*\(|powershell\s+-enc|mshta|rundll32|certutil\s+-urlcache|bitsadmin|schtasks\s+\/create|reg\s+add|miner|xmrig|ransom|\.locked|net\s+user\s+\S+\s+\/add|mimikatz|sekurlsa|lsass)/i;

function validIp(v: string): boolean {
  return v.split(".").every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseTimestamp(line: string, now: number): number | null {
  // ISO / 常见 "YYYY-MM-DD HH:mm:ss"
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(line);
  if (iso) {
    const ms = Date.parse(`${iso[1]}T${iso[2]}${iso[3] ?? "Z"}`);
    if (Number.isFinite(ms)) return ms;
  }
  // Apache: 25/Oct/2026:13:45:00 +0800
  const apache = /(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2})\s+([+-]\d{4})/.exec(line);
  if (apache) {
    const mon = MONTHS[apache[2]!.toLowerCase()];
    if (mon !== undefined) {
      const isoStr = `${apache[3]}-${String(mon + 1).padStart(2, "0")}-${apache[1]}T${apache[4]}${apache[5]!.slice(0, 3)}:${apache[5]!.slice(3)}`;
      const ms = Date.parse(isoStr);
      if (Number.isFinite(ms)) return ms;
    }
  }
  // Syslog: Oct 25 13:45:00（无年份，用 now 的年份）
  const syslog = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})/.exec(line.trim());
  if (syslog) {
    const mon = MONTHS[syslog[1]!.toLowerCase()];
    if (mon !== undefined) {
      const year = new Date(now).getUTCFullYear();
      const ms = Date.parse(`${year}-${String(mon + 1).padStart(2, "0")}-${syslog[2]!.padStart(2, "0")}T${syslog[3]}Z`);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

export const textLogAnalyzer: IrAnalyzer = {
  id: "text-log",
  title: "文本/日志分析",
  detect(input: IrInput, _ctx: IrContext): boolean {
    if (input.kind !== "file") return false;
    const ext = extOf(input.relativePath);
    if (TEXT_EXT.has(ext)) return looksText(input.absolutePath);
    // 无扩展名：只在文件头像文本时尝试。
    return !ext && looksText(input.absolutePath);
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(textLogAnalyzer, input);
    const read = readTextHead(input.absolutePath, ctx.limits.maxBytesPerFile);
    if (read.truncated) base.warnings.push(`文件超过 ${ctx.limits.maxBytesPerFile} 字节，只分析前部`);
    if (!read.text) return base;

    const iocMap = new Map<string, IrIoc>();
    const addIoc = (type: IrIoc["type"], value: string, firstSeen?: number): void => {
      const key = `${type}:${value}`;
      const cur = iocMap.get(key);
      if (cur) {
        cur.count++;
        if (firstSeen !== undefined && (cur.firstSeen === undefined || firstSeen < cur.firstSeen)) {
          cur.firstSeen = firstSeen;
        }
      } else {
        iocMap.set(key, {
          type,
          value,
          count: 1,
          ...(firstSeen !== undefined ? { firstSeen } : {}),
          evidence: "E1",
          witness: `${input.relativePath}:1`,
        });
      }
    };

    let lineNo = 0;
    let suspicious = 0;
    let timelineAdded = 0;
    for (const rawLine of read.text.split(/\r?\n/)) {
      lineNo++;
      if (!rawLine.trim()) continue;
      const line = rawLine.slice(0, 4096);
      const ts = parseTimestamp(line, ctx.now);
      const lineIps = [...line.matchAll(IPS)].map((m) => m[0]).filter(validIp);
      const lineUrls = [...line.matchAll(URLS)].map((m) => m[0]);
      const accounts = [...line.matchAll(ACCOUNTS)].map((m) => m[1]!);
      const commands = [...line.matchAll(COMMAND_LINE)].map((m) => m[0]!.trim());
      for (const ip of lineIps) addIoc("ip", ip, ts ?? undefined);
      for (const url of lineUrls) addIoc("url", url, ts ?? undefined);
      for (const account of accounts) addIoc("account", account, ts ?? undefined);
      for (const command of commands) addIoc("command", command, ts ?? undefined);
      const isSuspicious = SUSPICIOUS.test(line);
      if (isSuspicious) suspicious++;
      const interesting = lineIps.length || lineUrls.length || accounts.length || commands.length || isSuspicious;
      if (ts !== null && interesting && timelineAdded < ctx.limits.maxTimeline) {
        const event: IrTimelineEvent = {
          at: ts,
          source: "log",
          event: line.slice(0, 300),
          ...(isSuspicious ? { impact: "suspicious" } : {}),
          evidence: "E1",
          witness: `${input.relativePath}:${lineNo}`,
        };
        base.timeline.push(event);
        timelineAdded++;
        if (timelineAdded >= ctx.limits.maxTimeline) base.warnings.push("时间线达到上限，后续行未加入时间线");
      }
      if (isSuspicious && base.facts.length < 200) {
        base.facts.push({
          schema: "ir.suspicious_line",
          data: {
            path: input.relativePath,
            line: lineNo,
            text: line.slice(0, 500),
            ...(ts !== null ? { at: ts } : {}),
          },
          evidence: "E1",
          witness: `${input.relativePath}:${lineNo}`,
        });
      }
    }

    base.iocs = [...iocMap.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, ctx.limits.maxIocs);
    base.facts.push({
      schema: "ir.log.summary",
      data: {
        path: input.relativePath,
        lines: lineNo,
        suspiciousLines: suspicious,
        timeline: base.timeline.length,
        iocs: base.iocs.length,
        topIps: base.iocs.filter((i) => i.type === "ip").slice(0, 10).map((i) => ({ value: i.value, count: i.count })),
        topUrls: base.iocs.filter((i) => i.type === "url").slice(0, 10).map((i) => ({ value: i.value, count: i.count })),
        accounts: base.iocs.filter((i) => i.type === "account").map((i) => i.value).slice(0, 20),
        commands: base.iocs.filter((i) => i.type === "command").map((i) => i.value).slice(0, 20),
      },
      evidence: "E1",
      witness: input.relativePath,
    });
    if (read.truncated) base.warnings.push("文本被截断；后续内容未分析");
    return base;
  },
};
