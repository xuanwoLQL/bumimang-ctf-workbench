/**
 * V2-P0-4：PCAP 分析器（tshark，可选）。
 *
 * 工具路径：BUMIMANG_TSHARK 或 PATH；缺失时返回可操作 warning，不伪造结果。
 * 只用 tshark 的字段输出（参数数组、shell:false），不导出文件、不执行 payload。
 */

import path from "node:path";
import type { IrAnalysisResult, IrAnalyzer, IrContext, IrInput, IrIoc } from "../registry.ts";
import { emptyResult, toolLogFromResult } from "../registry.ts";

const FIELDS = [
  "frame.time_epoch",
  "ip.src",
  "ip.dst",
  "tcp.dstport",
  "udp.dstport",
  "dns.qry.name",
  "http.request.method",
  "http.host",
  "http.request.uri",
];

/** 供真实烟测复用：字段顺序必须与 parseTsharkCsv 完全一致。 */
export const PCAP_TSHARK_FIELDS: readonly string[] = FIELDS;

/**
 * 真实烟测与生产分析共用的 tshark 参数。
 * 默认**不限制包数**（完整扫描）；只有调用方显式传 limit 才加 `-c`。
 * `quote=d` 让包含逗号/引号的 URI 被正确引用，避免 CSV 字段错位。
 */
export function buildTsharkArgs(file: string, limit?: number): string[] {
  return [
    "-r",
    file,
    "-T",
    "fields",
    "-E",
    "separator=,",
    "-E",
    "quote=d",
    ...FIELDS.flatMap((f) => ["-e", f]),
    ...(limit !== undefined ? ["-c", String(limit)] : []),
  ];
}

/** 解析 tshark CSV 行：支持双引号、"" 转义、以及 tshark 的 `\,` / `\\` 转义。 */
export function parseTsharkCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        cur += line[i + 1]!;
        i++;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === "\\" && (line[i + 1] === "," || line[i + 1] === "\\" || line[i + 1] === '"')) {
      cur += line[i + 1]!;
      i++;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export interface PcapRow {
  at?: number;
  src?: string;
  dst?: string;
  dport?: string;
  dns?: string;
  method?: string;
  host?: string;
  uri?: string;
}

export function parseTsharkCsv(text: string, opts: { maxRows?: number } = {}): PcapRow[] {
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: PcapRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = parseTsharkCsvLine(line);
    if (parts.length < FIELDS.length) continue;
    const epoch = Number(parts[0]);
    rows.push({
      ...(Number.isFinite(epoch) && epoch > 0 ? { at: Math.round(epoch * 1000) } : {}),
      ...(parts[1] ? { src: parts[1] } : {}),
      ...(parts[2] ? { dst: parts[2] } : {}),
      ...(parts[3] || parts[4] ? { dport: parts[3] || parts[4] } : {}),
      ...(parts[5] ? { dns: parts[5] } : {}),
      ...(parts[6] ? { method: parts[6] } : {}),
      ...(parts[7] ? { host: parts[7] } : {}),
      ...(parts[8] ? { uri: parts[8] } : {}),
    });
    if (rows.length >= maxRows) break;
  }
  return rows;
}

export const pcapAnalyzer: IrAnalyzer = {
  id: "pcap",
  title: "PCAP 流量",
  detect(input: IrInput, _ctx: IrContext): boolean {
    if (input.kind !== "file") return false;
    return /\.(pcap|pcapng|cap)$/i.test(path.extname(input.relativePath));
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(pcapAnalyzer, input);
    const tool = ctx.resolveTool("BUMIMANG_TSHARK", "tshark");
    if (!tool) {
      base.warnings.push("未安装 tshark（可设置 BUMIMANG_TSHARK 指向 tshark.exe）；PCAP 未分析");
      return base;
    }
    const args = buildTsharkArgs(input.absolutePath);
    const res = await ctx.runCommand(tool, args, {
      timeoutMs: ctx.limits.toolTimeoutMs,
      maxOutputBytes: ctx.limits.maxToolOutputBytes,
    });
    base.toolLogs.push(toolLogFromResult("tshark", res));
    if (res.timedOut) base.warnings.push(`tshark 超时（${ctx.limits.toolTimeoutMs}ms）`);
    if (res.truncated) base.warnings.push("tshark 输出超过上限，已截断");
    if (!res.ok && !res.stdout) {
      base.warnings.push(`tshark 执行失败（exit=${res.exitCode ?? "?"}）：${res.stderr.slice(0, 300)}`);
      return base;
    }
    const rows = parseTsharkCsv(res.stdout);
    const iocMap = new Map<string, IrIoc>();
    const add = (type: IrIoc["type"], value: string, at?: number): void => {
      if (!value) return;
      const key = `${type}:${value}`;
      const cur = iocMap.get(key);
      if (cur) {
        cur.count++;
        if (at !== undefined && (cur.firstSeen === undefined || at < cur.firstSeen)) cur.firstSeen = at;
      } else {
        iocMap.set(key, {
          type,
          value,
          count: 1,
          ...(at !== undefined ? { firstSeen: at } : {}),
          evidence: "E1",
          witness: input.relativePath,
        });
      }
    };
    let added = 0;
    let totalMatched = 0;
    let timelineCandidates = 0;
    for (const row of rows) {
      if (row.at !== undefined || row.src || row.dst || row.dns || row.host || row.uri) totalMatched++;
      add("ip", row.src!, row.at);
      add("ip", row.dst!, row.at);
      if (row.dns) add("domain", row.dns, row.at);
      if (row.host) add("domain", row.host, row.at);
      if (row.uri) add("url", `http://${row.host ?? row.dst ?? "?"}${row.uri}`, row.at);
      if (row.at) {
        timelineCandidates++;
        if (added < ctx.limits.maxTimeline) {
          const event = [
            row.src ? `${row.src}` : "",
            row.dst ? `→ ${row.dst}${row.dport ? `:${row.dport}` : ""}` : "",
            row.dns ? `DNS ${row.dns}` : "",
            row.method ? `${row.method} ${row.host ?? ""}${row.uri ?? ""}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          if (event) {
            base.timeline.push({
              at: row.at,
              source: "pcap",
              event: event.slice(0, 300),
              evidence: "E1",
              witness: input.relativePath,
            });
            added++;
          }
        }
      }
    }
    base.iocs = [...iocMap.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, ctx.limits.maxIocs);
    if (res.truncated) {
      base.warnings.push("tshark 输出达到上限，扫描为 HEAD_ONLY；不能声称全包覆盖");
    }
    base.facts.push({
      schema: "ir.pcap.summary",
      data: {
        path: input.relativePath,
        packets: rows.length,
        totalScanned: rows.length,
        totalMatched,
        displayedTimeline: base.timeline.length,
        displayedIocs: base.iocs.length,
        truncatedForDisplay: timelineCandidates > base.timeline.length || iocMap.size > base.iocs.length,
        truncatedForScan: res.truncated,
        coverage: res.truncated ? "head_only" : "full",
        timeline: base.timeline.length,
        iocs: base.iocs.length,
        topConversations: base.iocs.filter((i) => i.type === "ip").slice(0, 20).map((i) => ({ value: i.value, count: i.count })),
        dns: base.iocs.filter((i) => i.type === "domain").slice(0, 20).map((i) => i.value),
      },
      evidence: "E1",
      witness: input.relativePath,
    });
    if (base.timeline.length > 0) base.timeline.sort((a, b) => a.at - b.at);
    return base;
  },
};
