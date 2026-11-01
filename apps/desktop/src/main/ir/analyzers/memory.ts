/**
 * V2-P0-4：内存镜像分析器（Volatility 3，可选）。
 *
 * 工具路径：BUMIMANG_VOLATILITY 或 PATH；缺失时返回可操作 warning。
 * 只跑只读插件（pslist/netscan）；不注入、不 dump、不改镜像。
 */

import path from "node:path";
import type { IrAnalysisResult, IrAnalyzer, IrContext, IrInput, IrIoc } from "../registry.ts";
import { emptyResult, toolLogFromResult } from "../registry.ts";

export interface VolProcess {
  pid?: string;
  ppid?: string;
  name?: string;
  createTime?: string;
}

export interface VolNet {
  proto?: string;
  local?: string;
  remote?: string;
  state?: string;
  pid?: string;
  owner?: string;
}

function headerIndex(header: string, names: string[]): Record<string, number> {
  const cols = header.trim().split(/\s{2,}|\t+/).map((c) => c.trim());
  const out: Record<string, number> = {};
  for (const n of names) out[n] = cols.findIndex((c) => c.toLowerCase() === n.toLowerCase());
  return out;
}

export function parseVolPslist(text: string): VolProcess[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const idx = headerIndex(lines[0]!, ["PID", "PPID", "ImageFileName", "CreateTime"]);
  const out: VolProcess[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s{2,}|\t+/);
    const pick = (name: string): string | undefined => {
      const i = idx[name];
      return i !== undefined && i >= 0 ? cells[i] : undefined;
    };
    const proc: VolProcess = {};
    const pid = pick("PID");
    const ppid = pick("PPID");
    const name = pick("ImageFileName");
    const createTime = pick("CreateTime");
    if (pid) proc.pid = pid;
    if (ppid) proc.ppid = ppid;
    if (name) proc.name = name;
    if (createTime) proc.createTime = createTime;
    if (proc.name || proc.pid) out.push(proc);
    if (out.length >= 2000) break;
  }
  return out;
}

export function parseVolNetscan(text: string): VolNet[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const idx = headerIndex(lines[0]!, ["Proto", "LocalAddr", "ForeignAddr", "State", "PID", "Owner"]);
  const out: VolNet[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s{2,}|\t+/);
    const pick = (name: string): string | undefined => {
      const i = idx[name];
      return i !== undefined && i >= 0 ? cells[i] : undefined;
    };
    const net: VolNet = {};
    const proto = pick("Proto");
    const local = pick("LocalAddr");
    const remote = pick("ForeignAddr");
    const state = pick("State");
    const pid = pick("PID");
    const owner = pick("Owner");
    if (proto) net.proto = proto;
    if (local) net.local = local;
    if (remote) net.remote = remote;
    if (state) net.state = state;
    if (pid) net.pid = pid;
    if (owner) net.owner = owner;
    if (net.remote || net.local) out.push(net);
    if (out.length >= 2000) break;
  }
  return out;
}

const IP_PORT = /(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/g;

export const memoryAnalyzer: IrAnalyzer = {
  id: "memory",
  title: "内存镜像",
  detect(input: IrInput, _ctx: IrContext): boolean {
    return input.kind === "file" && /\.(raw|mem|dmp|vmem|dump)$/i.test(path.extname(input.relativePath));
  },
  async analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult> {
    const base = emptyResult(memoryAnalyzer, input);
    const tool = ctx.resolveTool("BUMIMANG_VOLATILITY", "vol");
    if (!tool) {
      base.warnings.push("未安装 Volatility 3（可设置 BUMIMANG_VOLATILITY 指向 vol/vol.py）；内存镜像未分析");
      return base;
    }
    const ps = await ctx.runCommand(tool, ["-f", input.absolutePath, "windows.pslist"], {
      timeoutMs: ctx.limits.toolTimeoutMs,
      maxOutputBytes: ctx.limits.maxToolOutputBytes,
    });
    base.toolLogs.push(toolLogFromResult("vol pslist", ps));
    if (ps.timedOut) base.warnings.push(`Volatility pslist 超时（${ctx.limits.toolTimeoutMs}ms）`);
    const processes = ps.ok ? parseVolPslist(ps.stdout) : [];
    if (!ps.ok) base.warnings.push(`Volatility pslist 失败（exit=${ps.exitCode ?? "?"}）：${ps.stderr.slice(0, 300)}`);

    const net = await ctx.runCommand(tool, ["-f", input.absolutePath, "windows.netscan"], {
      timeoutMs: ctx.limits.toolTimeoutMs,
      maxOutputBytes: ctx.limits.maxToolOutputBytes,
    });
    base.toolLogs.push(toolLogFromResult("vol netscan", net));
    if (net.timedOut) base.warnings.push(`Volatility netscan 超时（${ctx.limits.toolTimeoutMs}ms）`);
    const nets = net.ok ? parseVolNetscan(net.stdout) : [];
    if (!net.ok) base.warnings.push(`Volatility netscan 失败（exit=${net.exitCode ?? "?"}）：${net.stderr.slice(0, 300)}`);

    const iocMap = new Map<string, IrIoc>();
    const add = (type: IrIoc["type"], value: string): void => {
      if (!value) return;
      const key = `${type}:${value}`;
      const cur = iocMap.get(key);
      if (cur) cur.count++;
      else iocMap.set(key, { type, value, count: 1, evidence: "E1", witness: input.relativePath });
    };
    for (const p of processes) {
      if (p.name) add("process", p.name);
    }
    for (const n of nets) {
      if (n.owner) add("process", n.owner);
      for (const m of `${n.local ?? ""} ${n.remote ?? ""}`.matchAll(IP_PORT)) add("ip", m[1]!);
    }
    base.iocs = [...iocMap.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, ctx.limits.maxIocs);
    base.facts.push({
      schema: "ir.memory.summary",
      data: {
        path: input.relativePath,
        processes: processes.slice(0, 200),
        connections: nets.slice(0, 200),
        iocs: base.iocs.slice(0, 100),
      },
      evidence: "E1",
      witness: input.relativePath,
    });
    if (processes.length === 0 && nets.length === 0) {
      base.warnings.push("Volatility 未解析出进程/网络（插件名或镜像格式可能不匹配）");
    }
    return base;
  },
};
