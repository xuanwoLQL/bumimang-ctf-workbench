/**
 * V2.1：真实 IR 烟测（禁止 mock 冒充真实）。
 *
 * 状态严格区分：
 *  - REAL_PASS：真实工具 + 真实样本 + 真实进程 + 真实解析通过
 *  - REAL_SKIP：工具或样本不存在（不计入 PASS）
 *  - REAL_FAIL：工具/样本存在但执行/参数/解析/断言失败
 *
 * EVTX：复制本机 System.evtx 到临时目录，真实 EvtxECmd -> CSV -> 平台解析。
 * PCAP：用确定性 Python 脚本生成离线 DNS+HTTP PCAP，真实 capinfos + tshark。
 * 内存：没有真实 Windows 内存镜像时明确 REAL_SKIP/BLOCKED，不用 Kali vmem 冒充。
 * YARA：只报告独立工具存在，未接入 IR 流程。
 *
 * 用法：
 *   npm run verify:ir-real
 *   npm run verify:ir-real -- --require-real
 *
 * --require-real：EVTX 或 PCAP 不是 REAL_PASS 时 exit 非 0；任何 REAL_FAIL 始终 exit 非 0。
 * 证据：evidence/v3-ir-reality/ir-real.json / ir-real.txt
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_IR_LIMITS,
  buildTsharkArgs,
  evtxAnalyzer,
  loadIrToolConfig,
  parseEvtxCsv,
  parseTsharkCsv,
  pcapAnalyzer,
  resolveIrTool,
  runCommandSafe,
  sha256File,
  type IrAnalysisResult,
  type IrContext,
  type IrInput,
  type IrToolPaths,
} from "../main/ir/index.ts";
import { findExecutable } from "../main/ir/spawn.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import type { SessionManager } from "../main/session/manager.ts";
import { createIrToolResolver } from "../main/ir/tool-config.ts";

const ROOT = process.cwd();
const RUN = path.join(ROOT, ".ui-run", "v3-ir-real");
const OUT_DIR = path.join(ROOT, "evidence", "v3-ir-reality");
const REQUIRE_REAL = process.argv.includes("--require-real");
const KEEP_TEMP = process.argv.includes("--keep-temp");

function irUserDataDir(): string | undefined {
  const explicit = process.env.BUMIMANG_IR_USER_CONFIG_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const appData = process.env.APPDATA?.trim();
  if (appData) return path.join(appData, "bumimang");
  return undefined;
}

type RealStatus = "REAL_PASS" | "REAL_SKIP" | "REAL_FAIL";

interface CommandEvidence {
  command: string;
  argv: string[];
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  stdoutSummary?: string;
  stderrSummary?: string;
}

interface RealCheck {
  id: "evtx" | "pcap" | "memory" | "yara";
  required: boolean;
  status: RealStatus;
  reason: string;
  tool?: string;
  toolPath?: string;
  toolVersion?: string;
  samplePath?: string;
  sampleSha256?: string;
  sampleBytes?: number;
  commands: CommandEvidence[];
  counts?: Record<string, number>;
  fieldPresence?: Record<string, boolean>;
  warnings?: string[];
  map?: {
    dir: string;
    files: number;
    loaded: number;
    failed: string[];
    note?: string;
  };
  keyEventMapping?: Record<
    string,
    { present: number; mapped: number; payload: number; status: "verified" | "incomplete" | "no-sample" }
  >;
}

const checks: RealCheck[] = [];

async function probeVersion(
  check: RealCheck,
  command: string,
  args: string[],
  regex: RegExp,
  cwd: string,
): Promise<string | undefined> {
  const res = await runCommandSafe(command, args, { cwd, timeoutMs: 20_000, maxOutputBytes: 256 * 1024 });
  check.commands.push(cmdEvidence(command, args, res));
  const m = regex.exec(`${res.stdout}\n${res.stderr}`);
  return m?.[1];
}

function summarize(text: string, max = 400): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function cmdEvidence(
  command: string,
  argv: string[],
  res: Awaited<ReturnType<typeof runCommandSafe>>,
): CommandEvidence {
  return {
    command,
    argv,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    stdoutBytes: res.stdoutBytes,
    stderrBytes: res.stderrBytes,
    truncated: res.truncated,
    stdoutSummary: summarize(res.stdout),
    stderrSummary: summarize(res.stderr),
  };
}

function irCtx(taskId: string, workDir: string, tools: IrToolPaths): IrContext {
  return {
    taskId,
    workDir,
    now: Date.now(),
    limits: DEFAULT_IR_LIMITS,
    runCommand: (command, args, opts) =>
      runCommandSafe(command, args, {
        cwd: workDir,
        timeoutMs: opts?.timeoutMs ?? DEFAULT_IR_LIMITS.toolTimeoutMs,
        maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_IR_LIMITS.maxToolOutputBytes,
      }),
    resolveTool: (envVar, defaultName) => {
      const key =
        envVar === "BUMIMANG_TSHARK"
          ? "tshark"
          : envVar === "BUMIMANG_CAPINFOS"
            ? "capinfos"
            : envVar === "BUMIMANG_EVTXECMD"
              ? "evtxecmd"
              : envVar === "BUMIMANG_VOLATILITY"
                ? "volatility"
                : null;
      if (key) return resolveIrTool({ key, tools }).path;
      return findExecutable(defaultName);
    },
    audit: () => undefined,
    log: () => undefined,
  };
}

const KEY_EVENT_IDS = ["4624", "4625", "4688", "4697", "7045", "1102"] as const;

function keyEventStats(rows: Array<{ eventId?: number; mapDescription?: string; payload: string }>): RealCheck["keyEventMapping"] {
  const out: NonNullable<RealCheck["keyEventMapping"]> = {};
  for (const id of KEY_EVENT_IDS) {
    const matching = rows.filter((r) => r.eventId === Number(id));
    const mapped = matching.filter((r) => Boolean((r.mapDescription ?? "").trim())).length;
    const payload = matching.filter((r) => Boolean((r.payload ?? "").trim())).length;
    out[id] = {
      present: matching.length,
      mapped,
      payload,
      status:
        matching.length === 0
          ? "no-sample"
          : mapped === matching.length && payload === matching.length
            ? "verified"
            : "incomplete",
    };
  }
  return out;
}

async function runEvtxReal(tools: IrToolPaths): Promise<RealCheck> {  const check: RealCheck = { id: "evtx", required: true, status: "REAL_SKIP", reason: "", commands: [] };
  const tool = resolveIrTool({ key: "evtxecmd", tools });
  check.tool = "EvtxECmd";
  check.toolPath = tool.path ?? tool.configuredPath ?? undefined;
  if (tool.error) {
    check.status = "REAL_FAIL";
    check.reason = tool.error;
    return check;
  }
  if (!tool.path) {
    check.reason = "EvtxECmd 未解析到（config/env/PATH 均无）";
    return check;
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const sample = path.join(systemRoot, "System32", "winevt", "Logs", "System.evtx");
  if (!existsSync(sample) || !statSync(sample).isFile()) {
    check.reason = `真实 EVTX 样本不存在：${sample}`;
    return check;
  }
  const dir = path.join(RUN, "evtx");
  mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, "System.evtx");
  copyFileSync(sample, copy);
  check.samplePath = sample;
  check.sampleBytes = statSync(copy).size;
  check.sampleSha256 = await sha256File(copy);
  check.toolVersion = await probeVersion(
    check,
    tool.path,
    ["--help"],
    /EvtxECmd version ([\d.]+)/i,
    dir,
  );

  const outDir = path.join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, "events.csv");
  const direct = await runCommandSafe(
    tool.path,
    ["-f", copy, "--csv", outDir, "--csvf", "events.csv"],
    { cwd: dir, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 },
  );
  check.commands.push(cmdEvidence(tool.path, ["-f", copy, "--csv", outDir, "--csvf", "events.csv"], direct));
  if (!direct.ok) {
    check.status = "REAL_FAIL";
    check.reason = `EvtxECmd 执行失败 exit=${direct.exitCode ?? "?"}`;
    return check;
  }
  if (!existsSync(csvPath)) {
    check.status = "REAL_FAIL";
    check.reason = "EvtxECmd 未生成 events.csv";
    return check;
  }
  const csvText = readFileSync(csvPath, "utf8");
  const csvLines = csvText.split(/\r?\n/).filter((l) => l.trim()).length;
  const rows = parseEvtxCsv(csvText);
  check.warnings = [];
  const mapDir = path.join(path.dirname(tool.path), "Maps");
  let mapFiles = 0;
  try {
    mapFiles = readdirSync(mapDir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    /* Maps 目录不可读时保留 0 */
  }
  const mapLoaded = Number(/Maps loaded:\s*(\d+)/i.exec(direct.stdout)?.[1] ?? 0);
  const mapFailed = [...direct.stdout.matchAll(/Error loading map file (.+?\.map):/gi)].map((m) => path.basename(m[1]!));
  check.map = {
    dir: mapDir,
    files: mapFiles,
    loaded: mapLoaded,
    failed: mapFailed,
    ...(mapFailed.length
      ? { note: `${mapFailed.length} 个重复键 map 加载失败；Maps loaded ${mapLoaded}/${mapFiles}，属已知局部告警` }
      : {}),
  };
  if (mapFailed.length) {
    check.warnings.push(
      `EvtxECmd map 局部告警：${mapLoaded}/${mapFiles} 加载，${mapFailed.length} 个重复键失败（${mapFailed.join(", ")}）`,
    );
  }

  // 关键 EventID 映射：System.evtx 里有 7045；Security.evtx 里补 4624/4625/4688/4697/1102。
  const securitySample = path.join(systemRoot, "System32", "winevt", "Logs", "Security.evtx");
  const keyRows = [...rows];
  if (existsSync(securitySample)) {
    const secDir = path.join(dir, "security");
    const secOut = path.join(secDir, "out");
    mkdirSync(secOut, { recursive: true });
    const secCopy = path.join(secDir, "Security.evtx");
    copyFileSync(securitySample, secCopy);
    const secArgs = [
      "-f",
      secCopy,
      "--inc",
      "4624,4625,4688,4697,7045,1102",
      "--csv",
      secOut,
      "--csvf",
      "security.csv",
    ];
    const sec = await runCommandSafe(tool.path, secArgs, {
      cwd: secDir,
      timeoutMs: 180_000,
      maxOutputBytes: 1024 * 1024,
    });
    check.commands.push(cmdEvidence(tool.path, secArgs, sec));
    const secCsv = path.join(secOut, "security.csv");
    if (sec.ok && existsSync(secCsv)) {
      keyRows.push(...parseEvtxCsv(readFileSync(secCsv, "utf8")));
    } else {
      check.warnings.push(`Security.evtx 关键事件提取失败：exit=${sec.exitCode ?? "?"}`);
    }
  } else {
    check.warnings.push("Security.evtx 不存在；4624/4625/4688/4697/1102 关键映射未验证");
  }
  check.keyEventMapping = keyEventStats(keyRows);
  const keyVerified = Object.entries(check.keyEventMapping).filter(([, v]) => v.status === "verified").length;
  const keyNoSample = Object.entries(check.keyEventMapping).filter(([, v]) => v.status === "no-sample").map(([k]) => k);
  const keyIncomplete = Object.entries(check.keyEventMapping).filter(([, v]) => v.status === "incomplete").map(([k]) => k);
  if (keyIncomplete.length) {
    check.warnings.push(`关键事件映射不完整：${keyIncomplete.join(", ")}`);
  }
  if (keyNoSample.length) {
    check.warnings.push(`本机样本无这些关键事件，无法验证映射：${keyNoSample.join(", ")}`);
  }
  check.counts = {
    csvLines,
    parsedRows: rows.length,
    withTime: rows.filter((r) => r.at).length,
    withEventId: rows.filter((r) => r.eventId !== undefined).length,
    withChannel: rows.filter((r) => r.channel).length,
    withComputer: rows.filter((r) => r.computer).length,
    withUser: rows.filter((r) => r.user).length,
    withPayload: rows.filter((r) => r.payload).length,
    withMapDescription: rows.filter((r) => Boolean((r.mapDescription ?? "").trim())).length,
    mapFiles,
    mapsLoaded: mapLoaded,
    mapFailed: mapFailed.length,
    keyVerified,
    keyNoSample: keyNoSample.length,
    keyIncomplete: keyIncomplete.length,
  };
  check.fieldPresence = {
    TimeCreated: check.counts.withTime > 0,
    EventId: check.counts.withEventId > 0,
    Channel: check.counts.withChannel > 0,
    Computer: check.counts.withComputer > 0,
    UserNameOrUserId: check.counts.withUser > 0,
    Payload: check.counts.withPayload > 0,
    MapDescription: check.counts.withMapDescription > 0,
  };
  if (csvLines <= 1 || rows.length === 0) {
    check.status = "REAL_FAIL";
    check.reason = `CSV 行数=${csvLines}、解析行数=${rows.length}；0 条记录不能算真实通过`;
    return check;
  }
  if (rows.length <= 5000) {
    check.status = "REAL_FAIL";
    check.reason = `EVTX 全量扫描覆盖不足：只解析 ${rows.length} 行（<=5000），不能证明后段事件可用`;
    return check;
  }
  if (!Object.values(check.fieldPresence).every(Boolean)) {
    check.status = "REAL_FAIL";
    check.reason = `真实 CSV 字段缺失：${JSON.stringify(check.fieldPresence)}`;
    return check;
  }

  const input: IrInput = {
    taskId: "real-evtx",
    workDir: dir,
    absolutePath: copy,
    relativePath: "evidence/System.evtx",
    kind: "file",
    size: check.sampleBytes,
    sha256: check.sampleSha256,
  };
  const ctx = irCtx("real-evtx", dir, tools);
  const analyzed: IrAnalysisResult = await evtxAnalyzer.analyze(input, ctx);
  check.commands.push(
    ...analyzed.toolLogs.map((t) => ({
      command: t.tool,
      argv: t.argv,
      exitCode: t.exitCode,
      durationMs: t.durationMs,
      stdoutBytes: t.stdoutBytes,
      stderrBytes: t.stderrBytes,
      truncated: t.truncated,
    })),
  );
  const summary = analyzed.facts.find((f) => f.schema === "ir.evtx.summary");
  const events = Number(summary?.data.events ?? 0);
  const totalScanned = Number(summary?.data.totalScanned ?? 0);
  const totalMatched = Number(summary?.data.totalMatched ?? 0);
  const displayedTimeline = Number(summary?.data.displayedTimeline ?? analyzed.timeline.length);
  const truncatedForDisplay = summary?.data.truncatedForDisplay === true;
  const coverage = String(summary?.data.coverage ?? "unknown");
  check.counts = {
    ...check.counts,
    analyzerFacts: analyzed.facts.length,
    analyzerTimeline: analyzed.timeline.length,
    analyzerIocs: analyzed.iocs.length,
    analyzerEvents: events,
    analyzerTotalScanned: totalScanned,
    analyzerTotalMatched: totalMatched,
    analyzerDisplayedTimeline: displayedTimeline,
    analyzerTruncatedForDisplay: truncatedForDisplay ? 1 : 0,
  };
  check.warnings = [...(check.warnings ?? []), ...analyzed.warnings].slice(0, 10);
  if (events <= 0 || analyzed.timeline.length === 0 || analyzed.facts.length === 0) {
    check.status = "REAL_FAIL";
    check.reason = `真实分析结果为空：events=${events}, timeline=${analyzed.timeline.length}, facts=${analyzed.facts.length}`;
    return check;
  }
  if (totalScanned < rows.length || totalScanned <= 5000 || coverage !== "full") {
    check.status = "REAL_FAIL";
    check.reason = `EVTX 全量扫描覆盖不足：totalScanned=${totalScanned}, rows=${rows.length}, coverage=${coverage}`;
    return check;
  }
  if (!analyzed.toolLogs.some((t) => t.ok)) {
    check.status = "REAL_FAIL";
    check.reason = "EvtxECmd 真实执行未返回成功";
    return check;
  }
  check.status = "REAL_PASS";
  check.reason =
    `真实 EvtxECmd + System.evtx：CSV ${csvLines} 行、全量扫描 ${totalScanned} 行、` +
    `展示时间线 ${displayedTimeline}（truncatedForDisplay=${truncatedForDisplay}）、IOC ${analyzed.iocs.length}；` +
    `map ${mapLoaded}/${mapFiles}、关键事件 verified=${keyVerified}/no-sample=${keyNoSample.length}/incomplete=${keyIncomplete.length}`;
  return check;
}

async function runHubPcapReal(
  pcap: string,
  tools: IrToolPaths,
): Promise<{ ok: boolean; reason: string; counts: Record<string, number> }> {
  const dir = path.join(RUN, "hub");
  mkdirSync(dir, { recursive: true });
  const board = Blackboard.open(path.join(dir, "board.db"));
  const stubSessions = { listSessions: () => [], historyOf: () => [] } as unknown as SessionManager;
  const hub = new HubService({
    board,
    sessions: stubSessions,
    bus: new EventBus(),
    workspaceRoot: dir,
    workDir: dir,
    specFor: () => null,
    convergeGraceMs: 0,
    irToolResolver: createIrToolResolver({ path: null, tools }),
  });
  try {
    const created = await hub.dispatch({
      type: "task.create",
      title: "真实 PCAP IR",
      brief: "真实 tshark 端到端",
      category: "ir",
    });
    if (!created.ok) return { ok: false, reason: `创建 IR 任务失败：${created.error ?? "?"}`, counts: {} };
    const taskId = hub.currentTaskId!;
    const attachments = path.join(dir, taskId, "attachments");
    mkdirSync(attachments, { recursive: true });
    const copied = path.join(attachments, "real.pcap");
    copyFileSync(pcap, copied);
    const imported = await hub.dispatch({
      type: "ir.questions.import",
      taskId,
      text: "攻击者 IP 是什么？",
    });
    if (!imported.ok) return { ok: false, reason: `导入问题失败：${imported.error ?? "?"}`, counts: {} };
    const analyzed = await hub.dispatch({ type: "ir.analyze", taskId });
    if (!analyzed.ok) return { ok: false, reason: `Hub ir.analyze 失败：${analyzed.error ?? "?"}`, counts: {} };
    const snap = hub.snapshot();
    const ir = snap.ir;
    const candidates = ir?.questions.flatMap((q) => q.candidates ?? []) ?? [];
    const ipCandidate = candidates.some((c) => c.value === "10.1.2.3");
    const exported = await hub.dispatch({ type: "ir.export", taskId, format: "md" });
    const exportHasCandidate = (exported.content ?? "").includes("10.1.2.3");
    const counts = {
      inputs: analyzed.irAnalysis?.inputs ?? 0,
      facts: analyzed.irAnalysis?.facts ?? 0,
      timeline: analyzed.irAnalysis?.timeline ?? 0,
      iocs: analyzed.irAnalysis?.iocs ?? 0,
      candidates: candidates.length,
      irQuestions: ir?.questions.length ?? 0,
      exportHasCandidate: exportHasCandidate ? 1 : 0,
    };
    if (!ipCandidate || !exportHasCandidate) {
      return {
        ok: false,
        reason: `Hub 端到端候选/导出失败：candidate=${ipCandidate}, export=${exportHasCandidate}, ir=${Boolean(ir)}`,
        counts,
      };
    }
    return {
      ok: true,
      reason: `Hub 端到端：inputs=${counts.inputs}, facts=${counts.facts}, timeline=${counts.timeline}, 候选=${counts.candidates}, 导出含候选`,
      counts,
    };
  } finally {
    board.close();
  }
}

async function runPcapReal(tools: IrToolPaths): Promise<RealCheck> {  const check: RealCheck = { id: "pcap", required: true, status: "REAL_SKIP", reason: "", commands: [] };
  const tshark = resolveIrTool({ key: "tshark", tools });
  const capinfos = resolveIrTool({ key: "capinfos", tools });
  check.tool = "tshark + capinfos";
  check.toolPath = `${tshark.path ?? tshark.configuredPath ?? "-"} / ${capinfos.path ?? capinfos.configuredPath ?? "-"}`;
  if (tshark.error || capinfos.error) {
    check.status = "REAL_FAIL";
    check.reason = tshark.error ?? capinfos.error ?? "工具路径错误";
    return check;
  }
  if (!tshark.path || !capinfos.path) {
    check.reason = "tshark/capinfos 未解析到（config/env/PATH 均无）";
    return check;
  }
  const python = findExecutable("python") ?? findExecutable("py");
  const generator = path.join(ROOT, "tools", "v3", "make-v3-pcap.py");
  if (!python || !existsSync(generator)) {
    check.reason = "没有 Python 或确定性 PCAP 生成脚本；无法生成真实离线样本";
    return check;
  }
  const dir = path.join(RUN, "pcap");
  mkdirSync(dir, { recursive: true });
  const pcap = path.join(dir, "real.pcap");
  const gen = await runCommandSafe(python, ["-I", generator, pcap, "6000"], {
    cwd: dir,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  check.commands.push(cmdEvidence(python, ["-I", generator, pcap, "6000"], gen));
  if (!gen.ok || !existsSync(pcap)) {
    check.status = "REAL_FAIL";
    check.reason = `PCAP 生成失败 exit=${gen.exitCode ?? "?"}`;
    return check;
  }
  check.samplePath = "synthetic:evil.example DNS+HTTP (offline)";
  check.sampleBytes = statSync(pcap).size;
  check.sampleSha256 = await sha256File(pcap);
  const tsVersion = await probeVersion(check, tshark.path, ["-v"], /TShark \(Wireshark\) ([\d.]+)/i, dir);
  const capVersion = await probeVersion(check, capinfos.path, ["-v"], /Capinfos \(Wireshark\) ([\d.]+)/i, dir);
  check.toolVersion = `tshark ${tsVersion ?? "?"} / capinfos ${capVersion ?? "?"}`;

  const info = await runCommandSafe(capinfos.path, ["-c", "-t", "-E", "-M", pcap], {
    cwd: dir,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  check.commands.push(cmdEvidence(capinfos.path, ["-c", "-t", "-E", "-M", pcap], info));
  if (!info.ok) {
    check.status = "REAL_FAIL";
    check.reason = `capinfos 执行失败 exit=${info.exitCode ?? "?"}`;
    return check;
  }
  const packets = Number(/Number of packets:\s*(\d+)/i.exec(info.stdout)?.[1] ?? 0);
  if (!(packets > 0)) {
    check.status = "REAL_FAIL";
    check.reason = `capinfos 未识别包数（packets=${packets}）`;
    return check;
  }

  const args = buildTsharkArgs(pcap);
  const ts = await runCommandSafe(tshark.path, args, {
    cwd: dir,
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
  });
  check.commands.push(cmdEvidence(tshark.path, args, ts));
  if (!ts.ok) {
    check.status = "REAL_FAIL";
    check.reason = `tshark 执行失败 exit=${ts.exitCode ?? "?"}`;
    return check;
  }
  const rows = parseTsharkCsv(ts.stdout);
  check.counts = {
    capinfosPackets: packets,
    tsharkExit: ts.exitCode ?? -1,
    tsharkRows: rows.length,
    tsharkStdoutBytes: ts.stdoutBytes,
  };
  if (rows.length === 0) {
    check.status = "REAL_FAIL";
    check.reason = `tshark exit=0 但平台解析 0 行（stdoutBytes=${ts.stdoutBytes}）`;
    return check;
  }
  const expectations = {
    srcIp: rows.some((r) => r.src === "10.1.2.3"),
    dstIp: rows.some((r) => r.dst === "10.9.8.7"),
    dns: rows.some((r) => r.dns === "evil.example"),
    httpHost: rows.some((r) => r.host === "evil.example"),
    httpUri: rows.some((r) => (r.uri ?? "").includes("/shell.jsp")),
    httpMethod: rows.some((r) => r.method === "GET"),
    commaInUri: rows.some((r) => r.uri === "/shell.jsp?x=1,2"),
    sentinelIpAt6000: rows.some((r) => r.src === "203.0.113.66"),
    sentinelHostAt6000: rows.some((r) => r.host === "sentinel.example"),
    sentinelUriAt6000: rows.some((r) => r.uri === "/sentinel?x=9"),
  };
  check.fieldPresence = expectations;
  check.counts = { ...check.counts, withDns: rows.filter((r) => r.dns).length, withHttp: rows.filter((r) => r.method).length };
  if (!Object.values(expectations).every(Boolean)) {
    check.status = "REAL_FAIL";
    check.reason = `真实 tshark 字段断言失败：${JSON.stringify(expectations)}`;
    return check;
  }
  if (rows.length < 6000) {
    check.status = "REAL_FAIL";
    check.reason = `完整扫描断言失败：tshark 只解析 ${rows.length} 行，期望至少 6000（不得用 -c 5000 只看头部）`;
    return check;
  }

  const input: IrInput = {
    taskId: "real-pcap",
    workDir: dir,
    absolutePath: pcap,
    relativePath: "evidence/real.pcap",
    kind: "file",
    size: check.sampleBytes,
    sha256: check.sampleSha256,
  };
  const ctx = irCtx("real-pcap", dir, tools);
  const analyzed: IrAnalysisResult = await pcapAnalyzer.analyze(input, ctx);
  check.commands.push(
    ...analyzed.toolLogs.map((t) => ({
      command: t.tool,
      argv: t.argv,
      exitCode: t.exitCode,
      durationMs: t.durationMs,
      stdoutBytes: t.stdoutBytes,
      stderrBytes: t.stderrBytes,
      truncated: t.truncated,
    })),
  );
  check.counts = {
    ...check.counts,
    analyzerTimeline: analyzed.timeline.length,
    analyzerIocs: analyzed.iocs.length,
    analyzerFacts: analyzed.facts.length,
  };
  check.warnings = analyzed.warnings.slice(0, 10);
  const hasIp = analyzed.iocs.some((i) => i.type === "ip" && i.value === "10.1.2.3");
  const hasDns = analyzed.iocs.some((i) => i.type === "domain" && i.value === "evil.example");
  const hasUrl = analyzed.iocs.some((i) => i.type === "url" && i.value.includes("/shell.jsp"));
  const hasSentinelIp = analyzed.iocs.some((i) => i.type === "ip" && i.value === "203.0.113.66");
  const hasSentinelHost = analyzed.iocs.some((i) => i.type === "domain" && i.value === "sentinel.example");
  const pcapSummary = analyzed.facts.find((f) => f.schema === "ir.pcap.summary");
  const analyzerTotalScanned = Number(pcapSummary?.data.totalScanned ?? 0);
  const analyzerCoverage = String(pcapSummary?.data.coverage ?? "unknown");
  const analyzerTruncatedForScan = pcapSummary?.data.truncatedForScan === true;
  check.counts = {
    ...check.counts,
    analyzerTotalScanned,
    analyzerTotalMatched: Number(pcapSummary?.data.totalMatched ?? 0),
    analyzerDisplayedTimeline: Number(pcapSummary?.data.displayedTimeline ?? 0),
    analyzerDisplayedIocs: Number(pcapSummary?.data.displayedIocs ?? 0),
  };
  if (
    analyzed.timeline.length === 0 ||
    analyzed.facts.length === 0 ||
    !hasIp ||
    !hasDns ||
    !hasUrl ||
    !hasSentinelIp ||
    !hasSentinelHost ||
    analyzerTotalScanned < 6000 ||
    analyzerCoverage !== "full" ||
    analyzerTruncatedForScan
  ) {
    check.status = "REAL_FAIL";
    check.reason =
      `真实 pcap analyzer 结果不足：timeline=${analyzed.timeline.length}, facts=${analyzed.facts.length}, ` +
      `ip=${hasIp}, dns=${hasDns}, url=${hasUrl}, sentinelIp=${hasSentinelIp}, sentinelHost=${hasSentinelHost}, ` +
      `totalScanned=${analyzerTotalScanned}, coverage=${analyzerCoverage}, truncatedForScan=${analyzerTruncatedForScan}`;
    return check;
  }
  const hub = await runHubPcapReal(pcap, tools);
  check.counts = { ...check.counts, ...Object.fromEntries(Object.entries(hub.counts).map(([k, v]) => [`hub_${k}`, v])) };
  if (!hub.ok) {
    check.status = "REAL_FAIL";
    check.reason = hub.reason;
    return check;
  }
  check.status = "REAL_PASS";
  check.reason = `真实 capinfos/tshark：${packets} 包、${rows.length} 行全量扫描；DNS/HTTP/IP + 第6000包 sentinel 命中；analyzer totalScanned=${analyzerTotalScanned} coverage=${analyzerCoverage} timeline=${analyzed.timeline.length}；${hub.reason}`;
  return check;
}

async function runMemoryReal(tools: IrToolPaths): Promise<RealCheck> {
  const check: RealCheck = { id: "memory", required: true, status: "REAL_SKIP", reason: "", commands: [] };
  const vol = resolveIrTool({ key: "volatility", tools });
  check.tool = "Volatility 3";
  check.toolPath = vol.path ?? vol.configuredPath ?? undefined;
  if (vol.error) {
    check.status = "REAL_FAIL";
    check.reason = vol.error;
    return check;
  }
  if (!vol.path) {
    check.reason = "Volatility 未解析到（config/env/PATH 均无）";
    return check;
  }
  const help = await runCommandSafe(vol.path, ["-h"], { cwd: RUN, timeoutMs: 20_000, maxOutputBytes: 256 * 1024 });
  check.commands.push(cmdEvidence(vol.path, ["-h"], help));
  check.toolVersion = /Volatility 3 Framework ([\d.]+)/i.exec(`${help.stdout}\n${help.stderr}`)?.[1];
  check.counts = { helpExit: help.exitCode ?? -1 };
  if (!help.ok || !check.toolVersion) {
    check.status = "REAL_FAIL";
    check.reason = "Volatility 版本/帮助探测失败";
    return check;
  }
  // 只搜索常见工具/项目目录，避免全盘扫描；不处理 5GB Kali vmem 冒充 Windows 镜像。
  const candidates: string[] = [];
  const roots = ["D:\\IR tools", "D:\\Misc tools", "D:\\agent"];
  const suffixes = [".raw", ".mem", ".dmp", ".vmem"];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || candidates.length >= 10) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
      } else if (ent.isFile() && suffixes.includes(path.extname(ent.name).toLowerCase())) {
        try {
          const st = statSync(abs);
          if (st.size > 50 * 1024 * 1024) candidates.push(`${abs} (${st.size} bytes)`);
        } catch {
          /* ignore */
        }
      }
      if (candidates.length >= 10) return;
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root, 0);
  check.counts = { ...check.counts, windowsImageCandidates: candidates.length };
  if (candidates.length === 0) {
    check.status = "REAL_SKIP";
    check.reason =
      "没有真实 Windows 内存镜像；Volatility 版本已探测，但未跑 windows.pslist/netscan。REAL_SKIP/BLOCKED，不能算真实内存解析通过。";
    return check;
  }
  check.status = "REAL_SKIP";
  check.reason =
    `发现 ${candidates.length} 个候选镜像，但未确认是 Windows 镜像；未运行 windows.pslist。` +
    `候选（仅路径/大小）：${candidates.slice(0, 3).join("; ")}。REAL_SKIP/BLOCKED。`;
  return check;
}

async function runYaraCheck(tools: IrToolPaths): Promise<RealCheck> {
  const check: RealCheck = { id: "yara", required: false, status: "REAL_SKIP", reason: "", commands: [] };
  const py = resolveIrTool({ key: "yaraPython", tools });
  const scan = resolveIrTool({ key: "yaraScan", tools });
  check.tool = "YARA (independent)";
  check.toolPath = `${py.path ?? py.configuredPath ?? "-"} / ${scan.path ?? scan.configuredPath ?? "-"}`;
  if (!py.path || !scan.path) {
    check.status = "REAL_SKIP";
    check.reason = "YARA 工具未解析到；不可用";
    return check;
  }
  check.status = "REAL_SKIP";
  check.reason = "YARA 独立工具存在，但平台 IR 流程尚未接入；未执行文件扫描，不计入真实通过。";
  return check;
}

function writeEvidence(config?: ReturnType<typeof loadIrToolConfig>): { jsonPath: string; txtPath: string; summary: string } {
  mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const summary = checks
    .map((c) => `${c.id.toUpperCase()}${c.required ? " [required]" : " [optional]"}: ${c.status}${c.reason ? ` — ${c.reason}` : ""}`)
    .join("\n");
  const realPass = checks.filter((c) => c.status === "REAL_PASS").length;
  const skip = checks.filter((c) => c.status === "REAL_SKIP").length;
  const fail = checks.filter((c) => c.status === "REAL_FAIL").length;
  const requiredNotPass = checks.filter((c) => c.required && c.status !== "REAL_PASS");
  const overall = fail > 0 ? "FAIL" : requiredNotPass.length > 0 ? (REQUIRE_REAL ? "FAIL" : "PARTIAL") : "PASS";
  const payload = {
    generatedAt,
    requireReal: REQUIRE_REAL,
    overall,
    requiredNotPass: requiredNotPass.map((c) => c.id),
    configPath: config?.path ?? null,
    configSource: config?.source ?? null,
    configError: config?.error ?? null,
    statuses: checks.map((c) => ({ id: c.id, required: c.required, status: c.status, reason: c.reason })),
    checks,
    notes: [
      "FIXTURE/MOCK 测试在 verify:ir；本文件只记录真实工具/真实样本。",
      "required：evtx、pcap、memory；optional：yara。",
      "EVTX 样本是临时复制的本机 System.evtx；只保存哈希/统计，不保存完整 CSV/日志内容。",
      "PCAP 是离线确定性合成样本（evil.example），不抓取真实网络流量。",
      "内存没有真实 Windows 镜像时只能 REAL_SKIP/BLOCKED，不能算 REAL_PASS；--require-real 会因此失败。",
      "YARA 未接入平台 IR 流程，不计入真实通过。",
    ],
  };
  const jsonPath = path.join(OUT_DIR, REQUIRE_REAL ? "ir-real-require.json" : "ir-real.json");
  const txtPath = path.join(OUT_DIR, REQUIRE_REAL ? "ir-real-require.txt" : "ir-real.txt");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  const lines = [
    "# V2.1 真实 IR 烟测",
    `生成：${generatedAt}`,
    `overall=${overall}`,
    `--require-real=${REQUIRE_REAL}`,
    `requiredNotPass=${requiredNotPass.map((c) => c.id).join(",") || "none"}`,
    `配置：${config?.path ?? "(未找到)"} source=${config?.source ?? "-"}${config?.error ? `；错误=${config.error}` : ""}`,
    "",
    ...checks.map((c) => {
      const counts = c.counts ? ` counts=${JSON.stringify(c.counts)}` : "";
      const hashes = c.sampleSha256 ? ` sampleSha256=${c.sampleSha256}` : "";
      const fields = c.fieldPresence ? ` fields=${JSON.stringify(c.fieldPresence)}` : "";
      const version = c.toolVersion ? ` toolVersion=${c.toolVersion}` : "";
      const map = c.map
        ? ` map={files:${c.map.files},loaded:${c.map.loaded},failed:${JSON.stringify(c.map.failed)}}`
        : "";
      const keyEvents = c.keyEventMapping ? ` keyEvents=${JSON.stringify(c.keyEventMapping)}` : "";
      return `${c.status} ${c.id}${c.required ? " [required]" : " [optional]"} — ${c.reason}${version}${counts}${hashes}${fields}${map}${keyEvents}`;
    }),
    "",
    "命令：",
    ...checks.flatMap((c) =>
      c.commands.map(
        (cmd) =>
          `- [${c.id}] ${cmd.command} ${cmd.argv.join(" ")} exit=${cmd.exitCode ?? "-"} duration=${cmd.durationMs}ms stdout=${cmd.stdoutBytes}B stderr=${cmd.stderrBytes}B` +
          (cmd.stdoutSummary ? ` stdoutSummary=${cmd.stdoutSummary}` : "") +
          (cmd.stderrSummary ? ` stderrSummary=${cmd.stderrSummary}` : ""),
      ),
    ),
    "",
    ...payload.notes,
  ];
  writeFileSync(txtPath, lines.join("\n") + "\n", "utf8");
  return { jsonPath, txtPath, summary };
}

async function main(): Promise<void> {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const config = loadIrToolConfig({
    repoRoot: ROOT,
    isPackaged: false,
    resourcesPath: "",
    userDataDir: irUserDataDir(),
  });
  checks.push(await runEvtxReal(config.tools));
  checks.push(await runPcapReal(config.tools));
  checks.push(await runMemoryReal(config.tools));
  checks.push(await runYaraCheck(config.tools));
  // 工具配置本身错误（显式配置文件缺失/JSON 损坏/路径错误）不能被当成“只是没装工具”。
  if (config.error) {
    for (const c of checks) {
      if (c.id !== "yara" && c.status === "REAL_SKIP") {
        c.status = "REAL_FAIL";
        c.reason = `工具配置错误：${config.error}；${c.reason}`;
      }
    }
  }
  const ev = writeEvidence(config);
  console.log(`config=${config.path ?? "(env/PATH only)"} source=${config.source ?? "-"}${config.error ? ` error=${config.error}` : ""}`);
  for (const c of checks) {
    console.log(`${c.status}  ${c.id}${c.required ? " [required]" : " [optional]"}  ${c.reason}`);
  }
  const realPass = checks.filter((c) => c.status === "REAL_PASS").length;
  const skip = checks.filter((c) => c.status === "REAL_SKIP").length;
  const fail = checks.filter((c) => c.status === "REAL_FAIL").length;
  const requiredNotPass = checks.filter((c) => c.required && c.status !== "REAL_PASS");
  const overall = fail > 0 ? "FAIL" : requiredNotPass.length > 0 ? (REQUIRE_REAL ? "FAIL" : "PARTIAL") : "PASS";
  console.log(
    `SUMMARY realPass=${realPass} skip=${skip} fail=${fail} requiredNotPass=${requiredNotPass.map((c) => c.id).join(",") || "none"} overall=${overall}`,
  );
  console.log(`evidence=${ev.jsonPath}`);
  if (!KEEP_TEMP) rmSync(RUN, { recursive: true, force: true });

  if (fail > 0 || (REQUIRE_REAL && requiredNotPass.length > 0)) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).message ?? String(err));
  process.exitCode = 2;
});
