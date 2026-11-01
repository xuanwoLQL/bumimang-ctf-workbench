/**
 * V2-P0-4：EVTX 分析器（EvtxECmd，可选）。
 *
 * 工具路径：BUMIMANG_EVTXECMD 或 PATH；缺失时返回可操作 warning。
 * 只读解析 CSV；不执行 payload、不访问网络。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IrAnalysisResult, IrAnalyzer, IrContext, IrInput, IrIoc } from "../registry.ts";
import { emptyResult, toolLogFromResult } from "../registry.ts";

export interface EvtxRow {
  at?: number;
  eventId?: number;
  channel?: string;
  computer?: string;
  user?: string;
  mapDescription?: string;
  payload: string;
}

function parseCsvLine(line: string): string[] {
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
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
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

export function parseEvtxCsv(text: string, opts: { maxRows?: number } = {}): EvtxRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.length < 2) return [];
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const idx = (name: string): number => header.indexOf(name);
  const userIdx = idx("username") >= 0 ? idx("username") : idx("user");
  const userIdIdx = idx("userid");
  const col = {
    time: idx("timecreated") >= 0 ? idx("timecreated") : idx("timestamp"),
    eventId: idx("eventid"),
    channel: idx("channel"),
    computer: idx("computer"),
    user: userIdx,
    userId: userIdIdx,
    mapDescription: idx("mapdescription"),
    payload: idx("payload") >= 0 ? idx("payload") : idx("mapdescription"),
  };
  const rows: EvtxRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const rawTime = col.time >= 0 ? cells[col.time] ?? "" : "";
    const ms = rawTime ? Date.parse(rawTime) : NaN;
    const eventId = col.eventId >= 0 ? Number(cells[col.eventId]) : NaN;
    // EvtxECmd 的列可能是 UserName / Username / UserId；逐行回退，避免空 UserName 丢账号。
    const rawUser =
      (col.user >= 0 ? cells[col.user] ?? "" : "").trim() ||
      (col.userId >= 0 ? cells[col.userId] ?? "" : "").trim();
    rows.push({
      ...(Number.isFinite(ms) ? { at: ms } : {}),
      ...(Number.isFinite(eventId) ? { eventId } : {}),
      ...(col.channel >= 0 && cells[col.channel] ? { channel: cells[col.channel] } : {}),
      ...(col.computer >= 0 && cells[col.computer] ? { computer: cells[col.computer] } : {}),
      ...(rawUser ? { user: rawUser } : {}),
      ...(col.mapDescription >= 0 && cells[col.mapDescription]
        ? { mapDescription: cells[col.mapDescription] }
        : {}),
      payload: col.payload >= 0 ? cells[col.payload] ?? "" : cells.join(" ").slice(0, 2000),
    });
    if (rows.length >= maxRows) break;
  }
  return rows;
}

const EVENT_IMPACT: Record<number, string> = {
  4624: "登录成功",
  4625: "登录失败",
  4688: "进程创建",
  7045: "服务安装",
  4697: "服务安装",
  4720: "账号创建",
  4732: "加入特权组",
  4672: "特殊权限登录",
  1102: "日志被清除",
  104: "日志被清除",
};

const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HASH_RE = /\b[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{40}\b|\b[0-9a-fA-F]{32}\b/g;
/** EVTX CSV 全量扫描预算；超过时明确失败/告警，不静默只看头部。 */
const MAX_EVTX_CSV_BYTES = 256 * 1024 * 1024;
const KEY_EVENT_IDS = [4624, 4625, 4688, 4697, 7045, 1102] as const;

export const evtxAnalyzer: IrAnalyzer = {
  id: "evtx",
  title: "EVTX 事件日志",
  detect(input: IrInput, _ctx: IrContext): boolean {
    return input.kind === "file" && input.relativePath.toLowerCase().endsWith(".evtx");
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(evtxAnalyzer, input);
    const tool = ctx.resolveTool("BUMIMANG_EVTXECMD", "EvtxECmd");
    if (!tool) {
      base.warnings.push("未安装 EvtxECmd（可设置 BUMIMANG_EVTXECMD 指向 EvtxECmd.exe）；EVTX 未分析");
      return base;
    }
    const outDir = mkdtempSync(path.join(tmpdir(), "bumimang-ir-evtx-"));
    const csvPath = path.join(outDir, "events.csv");
    try {
      const res = await ctx.runCommand(
        tool,
        ["-f", input.absolutePath, "--csv", outDir, "--csvf", "events.csv"],
        { timeoutMs: ctx.limits.toolTimeoutMs, maxOutputBytes: ctx.limits.maxToolOutputBytes },
      );
      base.toolLogs.push(toolLogFromResult("EvtxECmd", res));
      if (res.timedOut) base.warnings.push(`EvtxECmd 超时（${ctx.limits.toolTimeoutMs}ms）`);
      if (!existsSync(csvPath)) {
        base.warnings.push(`EvtxECmd 未生成 CSV（exit=${res.exitCode ?? "?"}）：${res.stderr.slice(0, 300)}`);
        return base;
      }
      const csvSize = statSync(csvPath).size;
      if (csvSize > MAX_EVTX_CSV_BYTES) {
        base.warnings.push(
          `EVTX CSV 超过扫描预算 ${MAX_EVTX_CSV_BYTES} 字节（实际 ${csvSize}）；未做头部截断扫描，结果不可用`,
        );
        return base;
      }
      const rows = parseEvtxCsv(readFileSync(csvPath, "utf8"));
      const totalScanned = rows.length;
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
      const eventIdCounts = new Map<number, number>();
      const channelCounts = new Map<string, number>();
      const keyEventCounts: Record<string, number> = Object.fromEntries(
        KEY_EVENT_IDS.map((id) => [String(id), 0]),
      );
      const priorityTimeline: IrTimelineEvent[] = [];
      const normalTimeline: IrTimelineEvent[] = [];
      const priorityCounts = new Map<number, number>();
      const perKeyCap = Math.max(1, Math.floor(ctx.limits.maxTimeline / KEY_EVENT_IDS.length));
      let totalMatched = 0;
      let timelineCandidates = 0;
      const keySet = new Set<number>(KEY_EVENT_IDS);
      for (const row of rows) {
        if (
          row.at !== undefined ||
          row.eventId !== undefined ||
          row.channel ||
          row.computer ||
          row.user ||
          row.payload
        ) {
          totalMatched++;
        }
        if (row.eventId !== undefined) {
          eventIdCounts.set(row.eventId, (eventIdCounts.get(row.eventId) ?? 0) + 1);
          const k = String(row.eventId);
          if (k in keyEventCounts) keyEventCounts[k] = (keyEventCounts[k] ?? 0) + 1;
        }
        if (row.channel) channelCounts.set(row.channel, (channelCounts.get(row.channel) ?? 0) + 1);
        if (row.user) add("account", row.user, row.at);
        for (const ip of [...row.payload.matchAll(IP_RE)].map((m) => m[0])) add("ip", ip, row.at);
        for (const h of [...row.payload.matchAll(HASH_RE)].map((m) => m[0])) add("hash", h.toLowerCase(), row.at);
        const proc = /(?:NewProcessName|ImageFileName|ProcessName)[":=\s]+([A-Za-z]:\\[^\s",]+|[^\s",]+\.exe)/i.exec(row.payload);
        if (proc) add("process", proc[1]!, row.at);
        if (row.at) {
          timelineCandidates++;
          const impact = row.eventId ? EVENT_IMPACT[row.eventId] : undefined;
          const event: IrTimelineEvent = {
            at: row.at,
            source: "evtx",
            event: `EventID ${row.eventId ?? "?"}${impact ? `（${impact}）` : ""} ${row.channel ?? ""} ${row.user ?? ""} ${row.payload.slice(0, 200)}`.trim(),
            ...(impact ? { impact } : {}),
            evidence: "E1",
            witness: input.relativePath,
          };
          // 关键事件优先保留，避免后段 4624/4625/4688/4697/7045/1102 被展示上限挤掉。
          const isPriority =
            (row.eventId !== undefined && keySet.has(row.eventId)) ||
            impact === "日志被清除" ||
            impact === "账号创建" ||
            impact === "加入特权组";
          if (isPriority) {
            // 每个关键 EventID 独立限额，避免高频 7045/4624 把后段 1102/4697 挤掉。
            const keyId = row.eventId ?? -1;
            const used = priorityCounts.get(keyId) ?? 0;
            if (used < perKeyCap && priorityTimeline.length < ctx.limits.maxTimeline) {
              priorityTimeline.push(event);
              priorityCounts.set(keyId, used + 1);
            }
          } else if (normalTimeline.length < ctx.limits.maxTimeline) {
            normalTimeline.push(event);
          }
        }
      }
      const merged: IrTimelineEvent[] = [];
      const seenWitness = new Set<string>();
      for (const event of [...priorityTimeline, ...normalTimeline]) {
        const key = `${event.at}|${event.event.slice(0, 80)}|${event.witness ?? ""}`;
        if (seenWitness.has(key)) continue;
        seenWitness.add(key);
        merged.push(event);
        if (merged.length >= ctx.limits.maxTimeline) break;
      }
      base.timeline = merged;
      base.iocs = [...iocMap.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, ctx.limits.maxIocs);
      const topEventIds = [...eventIdCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([id, count]) => ({ id, count }));
      const topChannels = [...channelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([channel, count]) => ({ channel, count }));
      base.facts.push({
        schema: "ir.evtx.summary",
        data: {
          path: input.relativePath,
          events: totalScanned,
          totalScanned,
          totalMatched,
          displayedTimeline: base.timeline.length,
          displayedIocs: base.iocs.length,
          truncatedForDisplay:
            timelineCandidates > base.timeline.length || iocMap.size > base.iocs.length,
          truncatedForScan: false,
          coverage: "full",
          keyEventCounts,
          topEventIds,
          topChannels,
          logCleared: (keyEventCounts["1102"] ?? 0) > 0 || rows.some((r) => r.eventId === 104),
          services: (keyEventCounts["7045"] ?? 0) + (keyEventCounts["4697"] ?? 0),
          failedLogons: keyEventCounts["4625"] ?? 0,
          csvBytes: csvSize,
        },
        evidence: "E1",
        witness: input.relativePath,
      });
      if (base.timeline.length > 0) base.timeline.sort((a, b) => a.at - b.at);
      return base;
    } catch (err) {
      base.warnings.push(`EVTX 分析失败：${(err as Error).message}`);
      return base;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
};
