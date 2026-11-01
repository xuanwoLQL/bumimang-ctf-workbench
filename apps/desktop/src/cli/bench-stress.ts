/**
 * P6-C 批次 1.6c：mock 高倍率 stream 压测。
 *
 * 输入：第 1 批真实 stream（94,407 条；agent_thought 92,436；最大行 655B；
 *       最大 thought 块 35,652 字符）。没有真实文件时用固定 seed 生成同特征数据。
 *
 * 覆盖：
 *  - 真实 SessionStreamSink（80ms throttle）回放：flush 总时间/单 flush max/块/文本；
 *  - Store + 8 个 no-op 订阅者，132 次 session.upsert/health：store.emit 纯开销；
 *  - headless Edge（真实 styles.css）按真实 per-flush 窗口文本/末块文本做
 *    patchBlock + scrollHeight + scrollTop 合成 DOM 基准。
 *
 * 不覆盖（需真实 Electron）：真实 renderLeft/panel DOM、真实 Chromium 主线程调度、
 * 真实 IPC 背压；这三项由 D5 日志在第 2 批观测。
 *
 * 不启动 Electron/agent，不访问靶场，不烧 token。
 *
 * 用法：
 *   node --expose-gc apps/desktop/src/cli/bench-stress.ts \
 *     --stream=.ui-run/sessions/s7/stream.jsonl \
 *     --out=evidence/p6c-b16-stress.json
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  SessionStreamSink,
  MAX_THOUGHT_TEXT,
  MAX_WINDOW_TEXT,
  fitWindowStart,
} from "../renderer/panes/model.ts";
import { Store, applySnapshot, applyEvent } from "../renderer/store.ts";
import { buildMultiTaskMockSnapshot } from "../renderer/mock/data.ts";
import type { HubEvent, StreamUpdate } from "../../../../packages/shared-protocol/events.ts";

type Update = StreamUpdate & { ts: number };

interface FlushLog {
  ts: number;
  blocks: number;
  lastKind: string | null;
  lastText: number;
  visibleText: number;
}

const REPO = "D:/agent/xuanwo";
const WINDOW_MS = 80;
const CONV_WINDOW = 120;

function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const kv = process.argv.find((a) => a.startsWith(`${flag}=`));
  return kv ? kv.slice(flag.length + 1) : fallback;
}

function mb(n: number): number {
  return Math.round((n / 1024 / 1024) * 100) / 100;
}

function stats(values: number[]): { median: number; p95: number; max: number } {
  const s = values.slice().sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return {
    median: Math.round(p(0.5) * 100) / 100,
    p95: Math.round(p(0.95) * 100) / 100,
    max: Math.round((s[s.length - 1] ?? 0) * 100) / 100,
  };
}

function loadReal(streamPath: string): {
  updates: Update[];
  input: Record<string, unknown>;
} {
  const text = fs.readFileSync(streamPath, "utf8");
  const lines = text.trim().split(/\r?\n/);
  const updates: Update[] = [];
  for (const line of lines) {
    try {
      const u = JSON.parse(line) as Update;
      if (typeof u.ts === "number") updates.push(u);
    } catch {
      /* skip bad line */
    }
  }
  updates.sort((a, b) => a.ts - b.ts || ((a.seq ?? 0) - (b.seq ?? 0)));
  return {
    updates,
    input: {
      mode: "real",
      path: streamPath,
      bytes: fs.statSync(streamPath).size,
      sha256: createHash("sha256").update(text).digest("hex"),
      lines: lines.length,
      updates: updates.length,
    },
  };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 固定 seed 回退：计数/时间跨度/最大行与第 1 批一致；不是真实数据。 */
function loadSynthetic(): { updates: Update[]; input: Record<string, unknown> } {
  const seed = 0x5eed;
  const rnd = lcg(seed);
  const counts: Record<string, number> = {
    agent_thought: 92_436,
    agent_message: 1_531,
    tool_call: 66,
    tool_call_update: 280,
    other: 93,
    user_prompt: 1,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const start = Date.now() - 1_180_000;
  const updates: Update[] = [];
  let seq = 0;
  // Build a kind sequence; add a long contiguous thought run so the max block is ~35KB.
  const sequence: string[] = [];
  for (const [kind, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i += 1) sequence.push(kind);
  }
  // Move 3,000 thoughts together near 1/6 of the stream (long block).
  const thoughtIdx = sequence
    .map((k, i) => (k === "agent_thought" ? i : -1))
    .filter((i) => i >= 0)
    .slice(0, 3000);
  const longRun = thoughtIdx.map((i) => sequence[i]);
  for (const i of thoughtIdx) sequence[i] = "other";
  for (let i = 0; i < longRun.length; i += 1) sequence[Math.floor(total / 6) + i] = "agent_thought";
  for (let i = 0; i < sequence.length; i += 1) {
    const kind = sequence[i]!;
    const ts = start + Math.floor((i / sequence.length) * 1_180_000);
    seq += 1;
    if (kind === "agent_thought") {
      const len = i >= Math.floor(total / 6) && i < Math.floor(total / 6) + longRun.length ? 12 : 1 + Math.floor(rnd() * 12);
      updates.push({ seq, ts, kind, text: "想".repeat(len) });
    } else if (kind === "agent_message") {
      updates.push({ seq, ts, kind, text: "消息".repeat(1 + Math.floor(rnd() * 20)) });
    } else if (kind === "tool_call") {
      updates.push({ seq, ts, kind, title: "tool-" + i, toolKind: "terminal/exec", status: "in_progress" });
    } else if (kind === "tool_call_update") {
      updates.push({ seq, ts, kind, status: i % 2 ? "completed" : "in_progress" });
    } else if (kind === "user_prompt") {
      updates.push({ seq, ts, kind, text: "授权目标：hbc2:23992" });
    } else {
      updates.push({ seq, ts, kind, text: "other" });
    }
  }
  return {
    updates,
    input: { mode: "synthetic", seed, updates: updates.length, counts },
  };
}

function replaySink(updates: Update[]): {
  logs: FlushLog[];
  flushes: number;
  timedFlushes: number;
  totalMs: number;
  maxMs: number;
  msStats: { median: number; p95: number; max: number };
  maxBlocks: number;
  maxLastText: number;
  maxVisibleText: number;
  heapBefore: number;
  heapAfter: number;
  heapGrowthMB: number;
} {
  let lastLog: FlushLog | null = null;
  const logs: FlushLog[] = [];
  const sink = new SessionStreamSink("s7", {
    windowMs: WINDOW_MS,
    schedule: () => 0,
    onFlush: (log) => {
      const blocks = log.blocks;
      const last = blocks[blocks.length - 1];
      // D3：与 panes.ts 共用 fitWindowStart 文本预算，避免压测口径与真实窗口不一致。
      const start = fitWindowStart(blocks, CONV_WINDOW, MAX_WINDOW_TEXT);
      const visibleText = blocks
        .slice(start)
        .reduce((s, b) => s + (b.text?.length ?? 0), 0);
      lastLog = {
        ts: last?.lastTs ?? 0,
        blocks: blocks.length,
        lastKind: last?.kind ?? null,
        lastText: last?.text?.length ?? 0,
        visibleText,
      };
      logs.push(lastLog);
    },
  });

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const flushMs: number[] = [];
  let totalMs = 0;
  let maxMs = 0;
  let timedFlushes = 0;
  let windowStart = updates[0]?.ts ?? 0;

  // First push may auto-flush (throttler lastFlush=-Infinity); measure it too.
  const first = updates[0];
  if (first) {
    const t = performance.now();
    sink.push(first);
    const ms = performance.now() - t;
    totalMs += ms;
    maxMs = Math.max(maxMs, ms);
    flushMs.push(ms);
    timedFlushes += 1;
  }
  for (let i = 1; i < updates.length; i += 1) {
    const u = updates[i]!;
    if (u.ts - windowStart >= WINDOW_MS) {
      const t = performance.now();
      sink.flush();
      const ms = performance.now() - t;
      totalMs += ms;
      maxMs = Math.max(maxMs, ms);
      flushMs.push(ms);
      timedFlushes += 1;
      windowStart = u.ts;
    }
    sink.push(u);
  }
  {
    const t = performance.now();
    sink.flush();
    const ms = performance.now() - t;
    totalMs += ms;
    maxMs = Math.max(maxMs, ms);
    flushMs.push(ms);
    timedFlushes += 1;
  }
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    logs,
    flushes: logs.length,
    timedFlushes,
    totalMs: Math.round(totalMs * 100) / 100,
    maxMs: Math.round(maxMs * 100) / 100,
    msStats: stats(flushMs),
    maxBlocks: logs.reduce((m, l) => Math.max(m, l.blocks), 0),
    maxLastText: logs.reduce((m, l) => Math.max(m, l.lastText), 0),
    maxVisibleText: logs.reduce((m, l) => Math.max(m, l.visibleText), 0),
    heapBefore,
    heapAfter,
    heapGrowthMB: mb(heapAfter - heapBefore),
  };
}

function replayStore(): {
  events: number;
  listeners: number;
  totalMs: number;
  maxMs: number;
  msStats: { median: number; p95: number; max: number };
  heapBefore: number;
  heapAfter: number;
  heapGrowthMB: number;
} {
  const snap = buildMultiTaskMockSnapshot("task-mt-b", {});
  const store = new Store(applySnapshot(snap));
  for (let i = 0; i < 8; i += 1) store.subscribe(() => undefined);
  const base = snap.sessions[0];
  if (!base) throw new Error("mock snapshot has no sessions");
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const times: number[] = [];
  let totalMs = 0;
  let maxMs = 0;
  let events = 0;
  for (let i = 0; i < 66; i += 1) {
    const session = {
      ...base,
      id: "s7",
      taskId: "task-mt-b",
      agent: "claude",
      role: "lead" as const,
      tier: "guarded" as const,
      status: i % 2 ? ("running" as const) : ("idle" as const),
      startedAt: Date.now(),
      endedAt: null,
    };
    const t1 = performance.now();
    store.update((s) =>
      applyEvent(s, { type: "session.upsert", session } as HubEvent),
    );
    const ms1 = performance.now() - t1;
    times.push(ms1);
    totalMs += ms1;
    maxMs = Math.max(maxMs, ms1);
    events += 1;
    const t2 = performance.now();
    store.update((s) =>
      applyEvent(s, {
        type: "health",
        sessionId: "s7",
        taskId: "task-mt-b",
        health: { toolCalls: i, boardReads: 1, syncLag: 0 },
      } as HubEvent),
    );
    const ms2 = performance.now() - t2;
    times.push(ms2);
    totalMs += ms2;
    maxMs = Math.max(maxMs, ms2);
    events += 1;
  }
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    events,
    listeners: 8,
    totalMs: Math.round(totalMs * 100) / 100,
    maxMs: Math.round(maxMs * 100) / 100,
    msStats: stats(times),
    heapBefore,
    heapAfter,
    heapGrowthMB: mb(heapAfter - heapBefore),
  };
}

async function replayRenderLeftProxy(): Promise<{
  status: string;
  proxyMs: number | null;
  note: string;
}> {
  try {
    const mod = await import("../renderer/task.ts");
    const snap = buildMultiTaskMockSnapshot("task-mt-b", {});
    const store = new Store(applySnapshot(snap));
    // Warm up.
    mod.buildTaskBoardView(store.get());
    const t = performance.now();
    for (let i = 0; i < 132; i += 1) mod.buildTaskBoardView(store.get());
    const ms = performance.now() - t;
    return {
      status: "pure_view_model_only",
      proxyMs: Math.round(ms * 100) / 100,
      note: "buildTaskBoardView 纯视图模型 132 次；真实 renderLeft DOM 未在无 Electron 环境测量",
    };
  } catch (err) {
    return {
      status: "unavailable",
      proxyMs: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

interface DomPair {
  visibleText: number;
  lastText: number;
}

function pickDomPairs(logs: FlushLog[]): DomPair[] {
  const byKey = new Map<string, DomPair>();
  for (const l of logs) {
    const key = `${l.visibleText}:${l.lastText}`;
    if (!byKey.has(key)) byKey.set(key, { visibleText: l.visibleText, lastText: l.lastText });
  }
  return [...byKey.values()]
    .sort((a, b) => b.visibleText + b.lastText - (a.visibleText + a.lastText))
    .slice(0, 12);
}

function buildDomHtml(pairs: DomPair[], css: string): string {
  const pairsJson = JSON.stringify(pairs);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>#pane{height:500px;width:900px;overflow-y:auto;border:1px solid #ccc}#out{white-space:pre-wrap}</style>
</head><body><div id="pane" class="pane-body"></div><pre id="out"></pre>
<script>
const pairs=${pairsJson};
const pane=document.getElementById('pane');
function makeText(n,salt){const parts=[
'分析目标 hbc2.haobachang.com:23992；/execute 过滤只允许符号；',
'\\\${-##??}\\\${_:\\\$(( \\\${#-}+\\\${##}+\\\${##} )):\\\${##}}\\\${_:\\\${#}:\\\${##}}',
'payload=/????/????/???????; curl -sS --max-time 20 -X POST http://hbc2.haobachang.com:23992/execute -H "Content-Type: application/json"',
'错误信息: /bin/bash: line 1: 0: command not found; cat: /app/static: Is a directory; ',
'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
];let s='';let i=0;while(s.length<n){s+=parts[(i+salt)%parts.length];i++;}return s.slice(0,n);}
function block(text){const b=document.createElement('div');b.className='conv-block conv-thought';const h=document.createElement('div');h.className='conv-head';const t1=document.createElement('span');t1.className='conv-time';t1.textContent='00:00:00';const t2=document.createElement('span');t2.className='conv-label conv-label-thought';t2.textContent='推理';h.append(t1,t2);const x=document.createElement('div');x.className='conv-text';x.textContent=text;b.append(h,x);return b;}
function build(total,last){pane.innerHTML='';const n=120;const rest=Math.max(0,total-last);const per=Math.floor(rest/(n-1));for(let i=0;i<n-1;i++)pane.append(block(makeText(per,i)));pane.append(block(makeText(last,999)));pane.scrollTop=0;}
function patchOnce(){const last=pane.lastElementChild;const text=last.querySelector('.conv-text');const t0=performance.now();if(text.firstChild)text.firstChild.appendData('x');else text.textContent='x';const tr=performance.now();const sh=pane.scrollHeight;const tl=performance.now();pane.scrollTop=pane.scrollHeight;const ts=performance.now();return {replace:tr-t0,layout:tl-tr,scroll:ts-tl,total:ts-t0,scrollHeight:sh};}
function st(a){const s=a.slice().sort((x,y)=>x-y);const p=q=>s[Math.min(s.length-1,Math.floor(q*s.length))];return {median:+p(.5).toFixed(2),p95:+p(.95).toFixed(2),max:+s[s.length-1].toFixed(2)};}
const memBefore=performance.memory?performance.memory.usedJSHeapSize:null;
const out={pairs:pairs.length,results:[],memBefore};
for(const p of pairs){build(p.visibleText,p.lastText);const rows=[];for(let i=0;i<10;i++)rows.push(patchOnce());out.results.push({visibleText:p.visibleText,lastText:p.lastText,replace:st(rows.map(r=>r.replace)),layout:st(rows.map(r=>r.layout)),scroll:st(rows.map(r=>r.scroll)),total:st(rows.map(r=>r.total)),scrollHeight:rows[rows.length-1].scrollHeight});}
out.memAfter=performance.memory?performance.memory.usedJSHeapSize:null;
document.getElementById('out').textContent=JSON.stringify(out,null,2);
</script></body></html>`;
}

function runDomBench(
  pairs: DomPair[],
  edgePath: string,
): {
  status: string;
  error?: string;
  pairs?: number;
  results?: unknown[];
  maxTotalMs?: number;
  maxReplaceMs?: number;
  maxLayoutMs?: number;
  maxScrollMs?: number;
  memBefore?: number | null;
  memAfter?: number | null;
} {
  if (!fs.existsSync(edgePath)) return { status: "unavailable", error: `edge not found: ${edgePath}` };
  const cssPath = path.join(REPO, "apps/desktop/src/renderer/styles.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const htmlPath = path.join(os.tmpdir(), "p6c-b16-stress-dom.html");
  const profile = path.join(os.tmpdir(), "p6c-b16-edge-profile");
  const html = buildDomHtml(pairs, css);
  fs.writeFileSync(htmlPath, html, "utf8");
  fs.rmSync(profile, { recursive: true, force: true });
  const res = spawnSync(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=60000",
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  );
  try {
    if (res.error) return { status: "unavailable", error: res.error.message };
    if (res.status !== 0) return { status: "unavailable", error: `edge exit ${res.status}: ${String(res.stderr).slice(0, 500)}` };
    const m = String(res.stdout).match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m) return { status: "unavailable", error: "no <pre id=out> in edge dump" };
    const txt = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    const parsed = JSON.parse(txt) as {
      pairs: number;
      results: Array<{
        visibleText: number;
        lastText: number;
        replace: { max: number };
        layout: { max: number };
        scroll: { max: number };
        total: { max: number };
      }>;
      memBefore: number | null;
      memAfter: number | null;
    };
    const maxOf = (f: (r: (typeof parsed.results)[number]) => number) =>
      Math.max(0, ...parsed.results.map(f));
    return {
      status: "ok",
      pairs: parsed.pairs,
      results: parsed.results,
      maxTotalMs: maxOf((r) => r.total.max),
      maxReplaceMs: maxOf((r) => r.replace.max),
      maxLayoutMs: maxOf((r) => r.layout.max),
      maxScrollMs: maxOf((r) => r.scroll.max),
      memBefore: parsed.memBefore,
      memAfter: parsed.memAfter,
    };
  } finally {
    fs.rmSync(htmlPath, { force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const streamPath = arg("stream", path.join(REPO, ".ui-run", "sessions", "s7", "stream.jsonl"));
  const outPath = arg("out", path.join(REPO, "evidence", "p6c-b16-stress.json"));
  const edgePath = arg("edge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");

  console.log("== P6-C 1.6c mock stress ==");
  console.log(`input: ${streamPath}`);
  const loaded = fs.existsSync(streamPath) ? loadReal(streamPath) : loadSynthetic();
  console.log(`input mode=${String(loaded.input.mode)} updates=${loaded.updates.length}`);

  const sink = replaySink(loaded.updates);
  console.log(
    `sink: flushes=${sink.flushes} totalMs=${sink.totalMs} maxMs=${sink.maxMs} ` +
      `maxBlocks=${sink.maxBlocks} maxLastText=${sink.maxLastText} maxVisibleText=${sink.maxVisibleText} ` +
      `heapGrowthMB=${sink.heapGrowthMB}`,
  );

  const store = replayStore();
  console.log(
    `store: events=${store.events} listeners=${store.listeners} totalMs=${store.totalMs} ` +
      `maxMs=${store.maxMs} heapGrowthMB=${store.heapGrowthMB}`,
  );

  const renderLeft = await replayRenderLeftProxy();
  console.log(
    `renderLeft: status=${renderLeft.status} proxyMs=${String(renderLeft.proxyMs)} (${renderLeft.note})`,
  );

  const pairs = pickDomPairs(sink.logs);
  console.log(`dom pairs: ${pairs.length} (top by visibleText+lastText)`);
  const dom = runDomBench(pairs, edgePath);
  if (dom.status === "ok") {
    console.log(
      `dom: maxTotalMs=${String(dom.maxTotalMs)} maxReplaceMs=${String(dom.maxReplaceMs)} ` +
        `maxLayoutMs=${String(dom.maxLayoutMs)} maxScrollMs=${String(dom.maxScrollMs)} ` +
        `mem=${String(dom.memBefore)}->${String(dom.memAfter)}`,
    );
  } else {
    console.log(`dom: unavailable (${dom.error})`);
  }

  const thresholds = {
    sinkTotalMs: 1000,
    sinkMaxMs: 50,
    storeTotalMs: 1000,
    domMaxTotalMs: 50,
    heapGrowthMB: 100,
  };
  const failures: string[] = [];
  if (sink.totalMs >= thresholds.sinkTotalMs) failures.push(`sink.totalMs=${sink.totalMs}`);
  if (sink.maxMs >= thresholds.sinkMaxMs) failures.push(`sink.maxMs=${sink.maxMs}`);
  if (store.totalMs >= thresholds.storeTotalMs) failures.push(`store.totalMs=${store.totalMs}`);
  if (dom.status === "ok" && (dom.maxTotalMs ?? 0) >= thresholds.domMaxTotalMs) {
    failures.push(`dom.maxTotalMs=${dom.maxTotalMs}`);
  }
  if (sink.heapGrowthMB >= thresholds.heapGrowthMB) failures.push(`sink.heapGrowthMB=${sink.heapGrowthMB}`);
  if (store.heapGrowthMB >= thresholds.heapGrowthMB) failures.push(`store.heapGrowthMB=${store.heapGrowthMB}`);
  const verdict = failures.length
    ? "fail"
    : dom.status === "ok"
      ? "pass_with_coverage_gap"
      : "pass_partial_no_dom";

  const result = {
    generatedAt: new Date().toISOString(),
    input: loaded.input,
    sink: {
      updates: loaded.updates.length,
      flushes: sink.flushes,
      timedFlushes: sink.timedFlushes,
      totalMs: sink.totalMs,
      maxMs: sink.maxMs,
      msStats: sink.msStats,
      maxBlocks: sink.maxBlocks,
      maxLastText: sink.maxLastText,
      maxVisibleText: sink.maxVisibleText,
      heapBefore: sink.heapBefore,
      heapAfter: sink.heapAfter,
      heapGrowthMB: sink.heapGrowthMB,
    },
    store,
    renderLeft,
    dom,
    d3Model: {
      maxThoughtText: MAX_THOUGHT_TEXT,
      maxWindowText: MAX_WINDOW_TEXT,
      patch: "incremental append + stable head (mirrors panes.ts D3)",
      scroll: "real panes defer scroll to rAF; benchmark still measures layout via scrollHeight",
    },
    thresholds,
    failures,
    verdict,
    coverage: {
      covered: [
        "SessionStreamSink 80ms throttle replay (real counts/sizes)",
        "Store + 8 listeners, 132 session.upsert/health events",
        "patchBlock + scrollHeight + scrollTop on synthetic DOM with real styles.css and real per-flush text sizes",
      ],
      notCovered: [
        "real renderLeft/panel DOM (needs Electron)",
        "real Chromium main-thread scheduling/GC (headless Edge is an approximation)",
        "real IPC backpressure from 94k webContents.send (needs Electron)",
      ],
      note:
        "verdict is based on covered metrics only; pass_with_coverage_gap means stream/pane/store worst-case " +
        "did not hit thresholds, but full-UI DOM/IPC still need D5 observation in batch 2.",
    },
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`verdict: ${verdict}${failures.length ? " failures=" + failures.join(",") : ""}`);
  console.log(`evidence: ${outPath}`);
  if (verdict === "fail") process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
