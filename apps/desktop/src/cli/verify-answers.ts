/**
 * V2-P0-2 答案模型验收。
 *
 * 覆盖：
 *  A. AnswerSpec 校验/默认值/模板
 *  B. 检测器：旧 flag、自定义前缀、UUID/hash/IP/时间/路径/进程/账号/命令、Base64/hex、freeform
 *  C. 文本文件：行号/偏移、跨块、二进制、超长上限、大小写、空答案、错误格式
 *  D. ZIP：正常条目、slip、炸弹限额、二进制条目、临时目录清理
 *  E. 黑板/Hub：候选去重、多来源、answerType/specId、events/audit 不写明文
 *  F. 错误答案不自动确认（只产生 new 候选，task 仍 open）
 *
 * 用法：npm run verify:answers
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import type { SessionManager } from "../main/session/manager.ts";
import { zipCrc32 } from "../main/artifacts/zip.ts";
import {
  DEFAULT_ANSWER_SPEC,
  answerSpecId,
  canonicalAnswer,
  detectAnswers,
  parseAnswerSpec,
  renderAnswerTemplate,
  scanAttachmentAnswers,
  scanBufferAnswers,
  scanTextFile,
  scanZipAnswers,
  validateAnswerSpec,
} from "../main/answer/index.ts";
import type { AnswerSpec } from "../../../packages/shared-protocol/events.ts";

const ROOT = process.cwd();
const RUN = path.join(ROOT, ".ui-run", "answers");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

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

/** 最小 ZIP 构造器（store/deflate），仅测试用。 */
interface ZipItem {
  name: string;
  data: Buffer;
  method?: 0 | 8;
}
function buildZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const nameBuf = Buffer.from(item.name, "utf8");
    const data = item.data;
    const method = item.method ?? 0;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = zipCrc32(data);
    const versionNeeded = method === 8 ? 20 : 10;
    const versionMadeBy = (3 << 8) | 20;
    const isDir = item.name.endsWith("/");
    const externalAttrs = isDir ? (0o040755 << 16) >>> 0 : (0o100644 << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    const localRecord = Buffer.concat([local, nameBuf, comp]);
    locals.push(localRecord);
    offset += localRecord.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(localOffset, 42);
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

function rmTempZipDirs(): number {
  let n = 0;
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith("bumimang-answer-zip-")) {
      rmSync(path.join(tmpdir(), name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- A. AnswerSpec

section("A. AnswerSpec 校验 / 默认值 / 模板");
{
  const def = validateAnswerSpec({ mode: "flag_regex" });
  check("A1 最小 spec 合法", def.ok, JSON.stringify(def.errors));
  eq("A1 默认类型 flag", def.spec?.answerType, "flag");
  eq("A1 默认证据 E1", def.spec?.requiredEvidence, "E1");
  check("A1 默认 pattern 存在", Boolean(def.spec?.pattern), JSON.stringify(def.spec));

  for (const bad of [
    {},
    { mode: "nope" },
    { mode: "flag_regex", pattern: "(" },
    { mode: "typed", answerType: "nope" },
    { mode: "flag_regex", normalizers: ["nope"] },
    { mode: "flag_regex", requiredEvidence: "E9" },
    { mode: "flag_regex", aliases: [1] },
    { mode: "flag_regex", caseSensitive: "yes" },
  ]) {
    const res = validateAnswerSpec(bad);
    check(`A2 非法 spec 被拒：${JSON.stringify(bad).slice(0, 50)}`, !res.ok, res.errors.join(";"));
  }

  const corrupt = parseAnswerSpec("{not-json");
  eq("A3 损坏 JSON 回落默认", corrupt.spec.mode, "flag_regex");
  check("A3 损坏 JSON 给出可读错误", Boolean(corrupt.error), corrupt.error ?? "");
  eq("A3 null 回落默认", parseAnswerSpec(null).spec.mode, "flag_regex");
  const custom = validateAnswerSpec({
    mode: "flag_regex",
    pattern: "DASCTF\\{[^}\\s]{3,128}\\}",
    answerType: "flag",
    caseSensitive: true,
    normalizers: ["trim", "lower"],
    requiredEvidence: "E2",
    exportTemplate: "flag=${value}",
    aliases: ["DASCTF{x}"],
    field: "q1",
  });
  check("A4 完整 spec 合法", custom.ok, JSON.stringify(custom.errors));
  eq("A4 caseSensitive 保留", custom.spec?.caseSensitive, true);
  eq("A4 requiredEvidence 保留", custom.spec?.requiredEvidence, "E2");
  check("A4 specId 稳定", answerSpecId(custom.spec!) === answerSpecId(custom.spec!), answerSpecId(custom.spec!));
  check("A4 默认 specId 固定", answerSpecId(DEFAULT_ANSWER_SPEC) === "default-flag-v1", answerSpecId(DEFAULT_ANSWER_SPEC));
  eq("A5 模板替换", renderAnswerTemplate("v=${value} t=${answerType} n=${taskTitle}", {
    value: "flag{x}",
    answerType: "flag",
    taskTitle: "题一",
  }), "v=flag{x} t=flag n=题一");
  eq("A5 无模板返回 null", renderAnswerTemplate(undefined, { value: "x" }), null);
  eq("A6 canonical hash 小写", canonicalAnswer("AABBCC", "hash"), "aabbcc");
  eq("A6 canonical path 斜杠", canonicalAnswer("C:\\a\\b", "path"), "C:/a/b");
}

// ---------------------------------------------------------------- B. 检测器

section("B. 检测器：flag / 自定义前缀 / typed / Base64 / freeform");
{
  const hit = detectAnswers("hello flag{abc} FLAG{DEF} flag{a}", DEFAULT_ANSWER_SPEC);
  eq("B1 默认 flag 命中 2 条（3 字符下限）", hit.length, 2);
  eq("B1 保留原文大小写", hit.map((h) => h.value).join(","), "flag{abc},FLAG{DEF}");
  eq("B1 行号", hit[0]?.line, 1);

  const dasctf: AnswerSpec = { mode: "flag_regex", pattern: "DASCTF\\{[^}\\s]{3,128}\\}", answerType: "flag" };
  eq("B2 DASCTF 命中", detectAnswers("x DASCTF{hello_1} y", dasctf)[0]?.value, "DASCTF{hello_1}");
  const ctfshow: AnswerSpec = { mode: "flag_regex", pattern: "ctfshow\\{[^}\\s]{3,128}\\}", answerType: "flag" };
  eq("B2 ctfshow 命中", detectAnswers("ctfshow{abc}", ctfshow)[0]?.value, "ctfshow{abc}");
  const flagUnderscore: AnswerSpec = { mode: "flag_regex", pattern: "flag_[A-Za-z0-9]{3,128}", answerType: "flag" };
  eq("B2 flag_xxx 命中", detectAnswers("flag_deadbeef", flagUnderscore)[0]?.value, "flag_deadbeef");

  const uuidSpec: AnswerSpec = { mode: "typed", answerType: "text" };
  eq(
    "B3 UUID 命中",
    detectAnswers("id=550e8400-e29b-41d4-a716-446655440000", uuidSpec)[0]?.value,
    "550e8400-e29b-41d4-a716-446655440000",
  );
  const hashSpec: AnswerSpec = { mode: "typed", answerType: "hash" };
  const hash = detectAnswers("md5 D41D8CD98F00B204E9800998ECF8427E", hashSpec);
  eq("B3 hash 命中", hash.length, 1);
  eq("B3 hash 归一化小写", hash[0]?.normalizedValue, "d41d8cd98f00b204e9800998ecf8427e");
  eq("B3 40/64 位 hash", detectAnswers("a".repeat(40) + " " + "b".repeat(64), hashSpec).length, 2);
  check("B3 短 hash 不命中", detectAnswers("abc123", hashSpec).length === 0);

  const ipSpec: AnswerSpec = { mode: "typed", answerType: "ip" };
  eq("B4 IP 命中", detectAnswers("from 10.1.2.3", ipSpec)[0]?.value, "10.1.2.3");
  check("B4 非法 IP 不命中", detectAnswers("999.1.2.3", ipSpec).length === 0);

  const tsSpec: AnswerSpec = { mode: "typed", answerType: "timestamp" };
  eq("B5 ISO 时间命中", detectAnswers("at 2026-10-25T13:45:00Z", tsSpec)[0]?.value, "2026-10-25T13:45:00Z");
  eq("B5 日期命中", detectAnswers("on 2026-10-25", tsSpec)[0]?.value, "2026-10-25");

  const pathSpec: AnswerSpec = { mode: "typed", answerType: "path" };
  check("B6 Unix 路径命中", detectAnswers("/var/www/html/index.php", pathSpec).some((h) => h.value === "/var/www/html/index.php"));
  check("B6 Windows 路径命中", detectAnswers("C:\\Windows\\Temp\\a.exe", pathSpec).some((h) => h.value === "C:\\Windows\\Temp\\a.exe"));

  const procSpec: AnswerSpec = { mode: "typed", answerType: "process" };
  check("B7 进程 exe 命中", detectAnswers("evil.exe running", procSpec).some((h) => h.value === "evil.exe"));
  check("B7 进程上下文命中", detectAnswers("进程: powershell.exe", procSpec).some((h) => h.value.includes("powershell")));

  const acctSpec: AnswerSpec = { mode: "typed", answerType: "account" };
  check("B8 账号上下文命中", detectAnswers("user: admin", acctSpec).some((h) => h.value === "admin"));
  check("B8 home 账号命中", detectAnswers("/home/operator", acctSpec).some((h) => h.value === "operator"));

  const cmdSpec: AnswerSpec = { mode: "typed", answerType: "command" };
  check("B9 命令行命中", detectAnswers("curl http://x/y", cmdSpec).some((h) => h.value.startsWith("curl")));

  const b64 = Buffer.from("flag{b64_test}").toString("base64");
  const b64Hit = detectAnswers(b64, DEFAULT_ANSWER_SPEC);
  eq("B10 Base64 包裹命中", b64Hit[0]?.value, "flag{b64_test}");
  eq("B10 Base64 标记 decoded", b64Hit[0]?.decoded, "base64");
  const hex = Buffer.from("flag{hex_test}").toString("hex");
  eq("B10 hex 包裹命中", detectAnswers(hex, DEFAULT_ANSWER_SPEC)[0]?.value, "flag{hex_test}");

  const free = detectAnswers("答案：hello world", { mode: "freeform" });
  eq("B11 freeform 命中", free[0]?.value, "hello world");
  eq("B11 freeform 证据 E0", free[0]?.evidence, "E0");
  const freeNoKeyword = detectAnswers("hello world", { mode: "freeform" });
  eq("B11 freeform 无关键词不命中", freeNoKeyword.length, 0);

  const caseSpec: AnswerSpec = { mode: "flag_regex", pattern: "FLAG\\{[^}]+\\}", caseSensitive: true, answerType: "flag" };
  eq("B12 大小写敏感：小写不命中", detectAnswers("flag{abc}", caseSpec).length, 0);
  eq("B12 大小写敏感：大写命中", detectAnswers("FLAG{abc}", caseSpec)[0]?.value, "FLAG{abc}");

  eq("B13 空文本", detectAnswers("", DEFAULT_ANSWER_SPEC).length, 0);
  eq("B13 null 文本", detectAnswers(null, DEFAULT_ANSWER_SPEC).length, 0);
  eq("B13 错误格式不命中", detectAnswers("flag{abc", DEFAULT_ANSWER_SPEC).length, 0);
  eq("B13 flag{} 不命中", detectAnswers("flag{}", DEFAULT_ANSWER_SPEC).length, 0);
  eq("B13 flag{a} 不命中（3 字符下限）", detectAnswers("flag{a}", DEFAULT_ANSWER_SPEC).length, 0);
}

// ---------------------------------------------------------------- C. 文件扫描

section("C. 文本文件：行号/偏移/跨块/二进制/上限");
{
  const plain = path.join(RUN, "plain.txt");
  writeFileSync(plain, "noise line\nflag{line_two}\n", "utf8");
  const plainRes = scanTextFile({ file: plain, displayPath: "attachments/plain.txt", spec: DEFAULT_ANSWER_SPEC });
  eq("C1 行号", plainRes.hits[0]?.line, 2);
  eq("C1 偏移", plainRes.hits[0]?.offset, 11);
  eq("C1 来源路径", plainRes.hits[0]?.relativePath, "attachments/plain.txt");
  eq("C1 证据 E1", plainRes.hits[0]?.evidence, "E1");

  const cross = path.join(RUN, "cross.txt");
  writeFileSync(cross, "A".repeat(65_530) + " flag{cross_chunk_ok} tail", "utf8");
  const crossRes = scanTextFile({
    file: cross,
    displayPath: "attachments/cross.txt",
    spec: DEFAULT_ANSWER_SPEC,
    limits: { chunkBytes: 65_536, overlapBytes: 8192 },
  });
  eq("C2 跨块命中", crossRes.hits[0]?.value, "flag{cross_chunk_ok}");

  const bin = path.join(RUN, "bin.dat");
  writeFileSync(bin, Buffer.concat([Buffer.from([0, 1, 2, 0, 3]), Buffer.from("flag{binary_should_skip}")]));
  const binRes = scanTextFile({ file: bin, displayPath: "attachments/bin.dat", spec: DEFAULT_ANSWER_SPEC });
  eq("C3 二进制跳过", binRes.skipped, "binary");
  eq("C3 二进制无命中", binRes.hits.length, 0);

  const long = path.join(RUN, "long.txt");
  writeFileSync(long, "B".repeat(1_500_000) + " flag{too_late}\n", "utf8");
  const longRes = scanTextFile({
    file: long,
    displayPath: "attachments/long.txt",
    spec: DEFAULT_ANSWER_SPEC,
    limits: { maxBytes: 1024 * 1024 },
  });
  eq("C4 超过 maxBytes 不命中尾部", longRes.hits.length, 0);
  check("C4 只读上限内字节", longRes.bytesRead <= 1024 * 1024, `bytesRead=${longRes.bytesRead}`);

  const dup = path.join(RUN, "dup.txt");
  writeFileSync(dup, "flag{same} flag{same}\n", "utf8");
  const dupRes = scanTextFile({ file: dup, displayPath: "attachments/dup.txt", spec: DEFAULT_ANSWER_SPEC });
  check("C5 同值不同偏移保留两条位置", dupRes.hits.length === 2, JSON.stringify(dupRes.hits.map((h) => h.offset)));

  const bufRes = scanBufferAnswers({
    buffer: Buffer.from("x flag{buffer_hit}"),
    displayPath: "memory",
    spec: DEFAULT_ANSWER_SPEC,
  });
  eq("C6 Buffer 扫描", bufRes[0]?.value, "flag{buffer_hit}");
}

// ---------------------------------------------------------------- D. ZIP

section("D. ZIP：条目/slip/炸弹/二进制/清理");
{
  rmTempZipDirs();
  const zipOk = path.join(RUN, "ok.zip");
  writeFileSync(zipOk, buildZip([
    { name: "inner.txt", data: Buffer.from("line1\nflag{inside_zip}\n") },
    { name: "bin.dat", data: Buffer.concat([Buffer.from([0, 1, 0]), Buffer.from("flag{zip_binary_skip}")]) },
  ]));
  const okRes = await scanZipAnswers({
    zipFile: zipOk,
    displayPath: "attachments/ok.zip",
    spec: DEFAULT_ANSWER_SPEC,
  });
  eq("D1 ZIP 条目数", okRes.zipEntries, 2);
  eq("D1 ZIP 文本命中", okRes.hits[0]?.value, "flag{inside_zip}");
  eq("D1 ZIP 来源路径", okRes.hits[0]?.relativePath, "attachments/ok.zip!/inner.txt");
  eq("D1 ZIP 行号", okRes.hits[0]?.line, 2);
  check("D1 ZIP 二进制条目不产生命中", !okRes.hits.some((h) => h.value.includes("zip_binary_skip")));

  const slipMarker = path.join(RUN, "evil.txt");
  const zipSlip = path.join(RUN, "slip.zip");
  writeFileSync(zipSlip, buildZip([{ name: "../evil.txt", data: Buffer.from("flag{slip}") }]));
  const slipRes = await scanZipAnswers({
    zipFile: zipSlip,
    displayPath: "attachments/slip.zip",
    spec: DEFAULT_ANSWER_SPEC,
  });
  eq("D2 ZIP slip 被拒", slipRes.skipped, "zip-error");
  check("D2 ZIP slip 有可读 warning", Boolean(slipRes.warning), slipRes.warning ?? "");
  check("D2 ZIP slip 没写出目录外文件", !existsSync(slipMarker), slipMarker);

  const zipBomb = path.join(RUN, "bomb.zip");
  writeFileSync(zipBomb, buildZip([{ name: "big.txt", data: Buffer.from("A".repeat(4096)), method: 8 }]));
  const bombRes = await scanZipAnswers({
    zipFile: zipBomb,
    displayPath: "attachments/bomb.zip",
    spec: DEFAULT_ANSWER_SPEC,
    limits: { maxZipTotalBytes: 1024 },
  });
  eq("D3 ZIP 炸弹限额被拒", bombRes.skipped, "zip-error");
  check("D3 ZIP 炸弹 warning 含 limit", (bombRes.warning ?? "").includes("limit"), bombRes.warning ?? "");

  const zipCorrupt = path.join(RUN, "corrupt.zip");
  writeFileSync(zipCorrupt, Buffer.from("PK\x03\x04not-a-real-zip"));
  const corruptRes = await scanZipAnswers({
    zipFile: zipCorrupt,
    displayPath: "attachments/corrupt.zip",
    spec: DEFAULT_ANSWER_SPEC,
  });
  eq("D4 损坏 ZIP 返回 zip-error", corruptRes.skipped, "zip-error");
  check("D4 损坏 ZIP 有可读 warning", Boolean(corruptRes.warning), corruptRes.warning ?? "");

  const left = readdirSync(tmpdir()).filter((n) => n.startsWith("bumimang-answer-zip-"));
  eq("D5 ZIP 临时目录已清理", left.length, 0);
}

// ---------------------------------------------------------------- E. 黑板/Hub

section("E. 黑板/Hub：去重/多来源/answerType/明文不落事件");
{
  const dir = path.join(RUN, "store");
  mkdirSync(dir, { recursive: true });
  const board = Blackboard.open(path.join(dir, "board.db"));
  const bus = new EventBus();
  const stubSessions = {
    listSessions: () => [],
    historyOf: () => [],
  } as unknown as SessionManager;
  const hub = new HubService({
    board,
    sessions: stubSessions,
    bus,
    workspaceRoot: dir,
    workDir: dir,
    specFor: () => null,
    convergeGraceMs: 0,
  });

  const spec: AnswerSpec = { mode: "typed", answerType: "ip" };
  const created = await hub.dispatch({
    type: "task.create",
    title: "E 答案模型",
    brief: "攻击者 IP",
    answerSpec: spec,
  });
  check("E1 task.create 带 answerSpec 成功", created.ok, JSON.stringify(created));
  const taskId = hub.currentTaskId!;
  const row = board.getTask(taskId);
  check("E1 answer_spec 已落库", typeof row?.answer_spec === "string" && row.answer_spec.includes('"ip"'), row?.answer_spec ?? "null");
  const taskView = hub.currentTaskView();
  eq("E1 TaskView.answerSpec.answerType", taskView?.answerSpec?.answerType, "ip");

  const bad = await hub.dispatch({
    type: "task.create",
    title: "E 非法 spec",
    brief: "",
    answerSpec: { mode: "nope" } as never,
  });
  check("E2 非法 answerSpec 被拒", bad.ok === false && (bad.error ?? "").includes("answerSpec"), JSON.stringify(bad));

  board.submitFact({
    taskId,
    sessionId: "s1",
    content: "攻击者 IP 是 10.1.2.3",
    witness: "logs/a.log",
    evidence: "E1",
  });
  board.submitFact({
    taskId,
    sessionId: "s2",
    content: "再次确认 10.1.2.3",
    witness: "logs/b.log",
    evidence: "E1",
  });
  hub.recoverTaskSignals(taskId);
  const cands = board.listFlagCandidates(taskId);
  eq("E3 同一答案只建一个候选", cands.length, 1);
  eq("E3 候选值", cands[0]?.value, "10.1.2.3");
  eq("E3 answerType=ip", cands[0]?.answer_type, "ip");
  eq("E3 normalizedValue", cands[0]?.normalized_value, "10.1.2.3");
  check("E3 specId 已写入", Boolean(cands[0]?.spec_id), cands[0]?.spec_id ?? "null");
  const sources = board.listFlagSources(cands[0]!.id);
  check("E3 两条来源（不同 witness）", sources.length >= 2, JSON.stringify(sources.map((s) => s.source_path)));
  check("E3 来源带 sourceKind/sourcePath", sources.some((s) => s.source_kind === "fact" && s.source_path === "logs/a.log"));

  const before = board.listFlagCandidates(taskId).length;
  hub.recoverTaskSignals(taskId);
  eq("E4 重复恢复不新增候选", board.listFlagCandidates(taskId).length, before);

  // 错误/无关文本不产生候选。
  board.submitFact({ taskId, sessionId: "s3", content: "没有答案 this is not an ip", evidence: "E0" });
  hub.recoverTaskSignals(taskId);
  eq("E5 无关文本不新增候选", board.listFlagCandidates(taskId).length, 1);

  // 候选事件/审计不写答案明文。
  const lifecycle = board.raw(
    "SELECT body FROM events WHERE kind = 'lifecycle' AND body LIKE '%flag.candidate%'",
  ) as Array<{ body: string }>;
  check("E6 候选事件不含明文", lifecycle.every((e) => !e.body.includes("10.1.2.3")), JSON.stringify(lifecycle));
  check("E6 候选事件含 valueHash", lifecycle.some((e) => e.body.includes("valueHash")), JSON.stringify(lifecycle));
  const sourceEvents = board.raw(
    "SELECT body FROM events WHERE kind = 'lifecycle' AND body LIKE '%flag.source%'",
  ) as Array<{ body: string }>;
  check("E6 来源事件不含明文", sourceEvents.every((e) => !e.body.includes("10.1.2.3")), JSON.stringify(sourceEvents));
  const audits = board.raw(
    "SELECT detail FROM audit WHERE action = 'task.flag_candidate'",
  ) as Array<{ detail: string }>;
  check("E6 候选审计不含明文", audits.every((a) => !a.detail.includes("10.1.2.3")), JSON.stringify(audits));

  // 错误答案不会自动确认/不会把任务标 solved。
  eq("E7 候选状态仍 new", board.listFlagCandidates(taskId)[0]?.status, "new");
  eq("E7 任务仍 open", board.getTask(taskId)?.status, "open");
  eq("E7 任务 answer 仍 null", board.getTask(taskId)?.answer, null);

  // task.setStatus 的 answer 事件不写明文。
  board.setTaskStatus(taskId, "solved", "10.1.2.3", "human");
  const answerEvents = board.raw(
    "SELECT body FROM events WHERE kind = 'answer' AND subject = ?", taskId,
  ) as Array<{ body: string }>;
  check("E8 answer 事件不含明文", answerEvents.every((e) => !e.body.includes("10.1.2.3")), JSON.stringify(answerEvents));
  check("E8 answer 事件含 answerHash", answerEvents.some((e) => e.body.includes("answerHash")), JSON.stringify(answerEvents));

  board.close();
}

// ---------------------------------------------------------------- F. 附件扫描 + 任务 spec

section("F. 附件扫描走任务 AnswerSpec");
{
  const dir = path.join(RUN, "attach");
  mkdirSync(path.join(dir, "attachments"), { recursive: true });
  writeFileSync(path.join(dir, "attachments", "log.txt"), "noise\nDASCTF{attach_custom}\n", "utf8");
  const res = await scanAttachmentAnswers({
    taskDir: dir,
    relativePath: "attachments/log.txt",
    spec: { mode: "flag_regex", pattern: "DASCTF\\{[^}\\s]{3,128}\\}", answerType: "flag" },
  });
  eq("F1 附件自定义前缀命中", res.hits[0]?.value, "DASCTF{attach_custom}");
  eq("F1 附件行号", res.hits[0]?.line, 2);
  const wrong = await scanAttachmentAnswers({
    taskDir: dir,
    relativePath: "attachments/log.txt",
    spec: DEFAULT_ANSWER_SPEC,
  });
  eq("F2 格式不匹配不命中", wrong.hits.length, 0);
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
if (failed > 0) process.exitCode = 1;
