/**
 * P3-A 附件导入 / ZIP 安全 / 预览验收（A/B/C 三组）。
 *
 * A：导入与落盘 —— 文件、文件夹、zip（store/deflate）；attachments.json 字段；
 *    sha256；POSIX relativePath；200MB/1000 模拟上限；失败不残留；跨任务隔离；
 *    Hub 快照字段；校验器；扫描函数（只返回路径+命中串）。
 * B：ZIP 安全 —— ../、绝对路径、盘符、反斜杠逃逸、NUL、symlink、加密、ZIP64、
 *    坏 CRC、重复名、文件/目录冲突、空 zip、混合导入；拒绝后无残留；解压不产生链接。
 * C：预览与路径 —— 文本/图片/二进制 hex；截断；目录/超大图片 unsupported；
 *    ../、绝对路径、盘符、NUL、junction 越界/内部链接全部拒绝；HTML 不渲染；
 *    可执行文件不提供“系统打开”。
 *
 * 不测 inferEvidence / cmd: 回放（P3-B），不测 renderer（P3-C）。
 * 用法：npm run verify:artifacts
 */

import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  importAttachments,
  readAttachments,
  ATTACHMENT_LIMITS,
} from "../main/artifacts/import.ts";
import { zipCrc32 } from "../main/artifacts/zip.ts";
import {
  ArtifactPathError,
  PREVIEW_LIMITS,
  isSystemOpenAllowed,
  normalizeRelativePath,
  previewAttachment,
  resolveWithinTask,
} from "../main/artifacts/preview.ts";
import { scanAttachmentForFlags } from "../main/artifacts/scan.ts";
import { validateHubAction } from "../main/electron/validate-action.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { BRIDGE_RPC } from "../main/mcp-host/protocol.ts";
import { SessionManager } from "../main/session/manager.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { loadAppConfig } from "../main/config/loader.ts";
import {
  EvidenceReplayer,
  REPLAY_MAX_OUTPUT_BYTES,
  REPLAY_TIMEOUT_MS,
  parseCommandLine,
} from "../main/evidence/replay.ts";
import type { Policy, Verdict } from "../main/policy/policy.ts";
import { ApprovalQueue, type ApprovalRequest, type ApprovalService } from "../main/approval/queue.ts";
import type { HubSnapshot } from "../../../../packages/shared-protocol/events.ts";

const ROOT = process.cwd();
const RUN = join(ROOT, ".ui-run", "artifacts");
const FIXTURE = join(RUN, "fixture");
const WORK = join(RUN, "work");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function listAttachmentsDir(taskDir: string): string[] {
  const dir = join(taskDir, "attachments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function readManifest(taskDir: string): {
  version: number;
  taskId: string;
  files: Array<Record<string, unknown>>;
} {
  try {
    return JSON.parse(readFileSync(join(taskDir, "attachments", "attachments.json"), "utf8"));
  } catch {
    return { version: -1, taskId: "", files: [] };
  }
}

/** 读文件；缺失时返回 "<missing>"，让断言失败而不是让整个套件崩掉。 */
function readTextSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "<missing>";
  }
}

function isPlainFile(file: string): boolean {
  try {
    const st = lstatSync(file);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function attachment(manifest: ReturnType<typeof readManifest>, rel: string): Record<string, unknown> | undefined {
  return manifest.files.find((f) => f.relativePath === rel);
}

function noTemp(taskDir: string): boolean {
  return listAttachmentsDir(taskDir).every((n) => !n.startsWith(".import-"));
}

function fresh(label: string): { root: string; taskId: string; taskDir: string } {
  const root = join(WORK, label);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const taskId = "task-test";
  return { root, taskId, taskDir: join(root, taskId) };
}

// ---------------------------------------------------------------- ZIP fixture 构造

interface ZipItem {
  name?: string;
  nameBuf?: Buffer;
  data?: Buffer;
  method?: 0 | 8;
  flags?: number;
  versionNeeded?: number;
  versionMadeBy?: number;
  externalAttrs?: number;
  extra?: Buffer;
  crcOverride?: number;
}

function buildZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const item of items) {
    const nameBuf = item.nameBuf ?? Buffer.from(item.name ?? "", "utf8");
    const data = item.data ?? Buffer.alloc(0);
    const method = item.method ?? 0;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = item.crcOverride ?? zipCrc32(data);
    const versionNeeded = item.versionNeeded ?? (method === 8 ? 20 : 10);
    const versionMadeBy = item.versionMadeBy ?? ((3 << 8) | 20);
    const isDir = (item.name ?? "").replace(/\\/g, "/").endsWith("/");
    const externalAttrs =
      item.externalAttrs ?? (isDir ? ((0o040755 << 16) >>> 0) : ((0o100644 << 16) >>> 0));
    const flags = item.flags ?? 0;
    const extra = item.extra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const localOffset = offset;
    const localRecord = Buffer.concat([local, nameBuf, extra, comp]);
    locals.push(localRecord);
    offset += localRecord.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([central, nameBuf, extra]));
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function buildFixture(): void {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(WORK, { recursive: true });

  const put = (rel: string, data: Buffer | string): string => {
    const p = join(FIXTURE, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    return p;
  };

  put("text/flag.txt", "题面文本\nFLAG{Fixture_Text_Flag}\nflag{second_hit}\n");
  put("text/note.md", "# note\nhello\n");
  put("folder/a.txt", "folder a\n");
  put("folder/sub/b.bin", Buffer.from([0, 1, 2, 3, 255]));
  put("images/tiny.png", TINY_PNG);
  put("images/fake.png", "<html><script>alert(1)</script></html>");
  put("bin/blob.bin", Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256)));
  put("bin/small.bin", Buffer.from([0, 1, 2, 3, 4, 255]));
  put("big/text-big.txt", "A".repeat(300 * 1024) + "flag{Big_Text_Tail}");
  put("big/image-big.png", Buffer.concat([TINY_PNG.subarray(0, 8), Buffer.alloc(2 * 1024 * 1024)]));
  put("html/page.html", "<script>alert(1)</script>\nflag{HTML_Text}\n");
  put("html/pic.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>\n");
  put("exec/evil.exe", Buffer.from("MZ fake exe"));
  put("reserved/attachments.json", "{}");
  put("dup1/same.txt", "one\n");
  put("dup2/same.txt", "two\n");

  const store = buildZip([
    { name: "readme.txt", data: Buffer.from("store hello\n") },
    { name: "dir/data.bin", data: Buffer.from([0, 1, 2, 255]) },
  ]);
  put("zips/store.zip", store);

  const deflate = buildZip([
    { name: "readme.txt", method: 8, data: Buffer.from("deflate hello\n") },
    { name: "dir/data.bin", method: 8, data: Buffer.from([9, 8, 7, 0]) },
  ]);
  put("zips/deflate.zip", deflate);

  put("zips/evil-slip.zip", buildZip([{ name: "../evil.txt", data: Buffer.from("evil") }]));
  put("zips/evil-abs.zip", buildZip([{ name: "/abs.txt", data: Buffer.from("evil") }]));
  put("zips/evil-drive.zip", buildZip([{ name: "C:/drive.txt", data: Buffer.from("evil") }]));
  put("zips/evil-backslash.zip", buildZip([{ name: "..\\evil.txt", data: Buffer.from("evil") }]));
  put(
    "zips/evil-nul.zip",
    buildZip([
      {
        nameBuf: Buffer.concat([Buffer.from("bad"), Buffer.from([0]), Buffer.from("name.txt")]),
        data: Buffer.from("evil"),
      },
    ]),
  );
  put(
    "zips/evil-symlink.zip",
    buildZip([
      {
        name: "link.txt",
        data: Buffer.from("../../outside.txt"),
        externalAttrs: ((0o120777 << 16) >>> 0),
      },
    ]),
  );
  put(
    "zips/evil-encrypted.zip",
    buildZip([{ name: "secret.txt", data: Buffer.from("ciphertext"), flags: 0x0001 }]),
  );
  put(
    "zips/evil-zip64.zip",
    buildZip([
      {
        name: "big.txt",
        data: Buffer.from("zip64"),
        versionNeeded: 45,
        extra: Buffer.from([0x01, 0x00, 0x00, 0x00]),
      },
    ]),
  );
  put(
    "zips/bad-crc.zip",
    buildZip([
      { name: "good.txt", data: Buffer.from("good") },
      { name: "bad.txt", data: Buffer.from("bad"), crcOverride: (zipCrc32(Buffer.from("bad")) ^ 0xffffffff) >>> 0 },
    ]),
  );
  put(
    "zips/dup-case.zip",
    buildZip([
      { name: "A.txt", data: Buffer.from("a") },
      { name: "a.txt", data: Buffer.from("b") },
    ]),
  );
  put(
    "zips/conflict.zip",
    buildZip([
      { name: "a", data: Buffer.from("file") },
      { name: "a/b", data: Buffer.from("nested") },
    ]),
  );
  put("zips/empty.zip", buildZip([]));
  put("zips/dirs-only.zip", buildZip([{ name: "emptydir/", data: Buffer.alloc(0) }]));
  put(
    "zips/bomb.zip",
    buildZip([{ name: "bomb.txt", method: 8, data: Buffer.alloc(2000, 0x41) }]),
  );
}

// ---------------------------------------------------------------- Hub 夹具

interface HubHarness {
  dir: string;
  board: Blackboard;
  bridge: BoardBridge;
  mgr: SessionManager;
  hub: HubService;
  cleanup: () => Promise<void>;
}

async function makeHub(label: string): Promise<HubHarness> {
  const dir = join(RUN, "hub", label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });

  const board = Blackboard.open(join(dir, "board.db"));
  const bridge = new BoardBridge({
    board,
    taskId: "bootstrap",
    runId: `verify-artifacts-${label}-${randomUUID()}`,
  });
  await bridge.start();
  const bus = new EventBus();
  let hub!: HubService;
  const mgr = new SessionManager({
    board,
    bridge,
    policy: new PolicyEngine({ repoRoot: ROOT, packId: "competition" }),
    workspaceRoot: dir,
    workRoot: join(dir, "work"),
    onLine: () => undefined,
    onStreamUpdate: () => undefined,
    onSessionChange: () => undefined,
  });
  hub = new HubService({
    board,
    sessions: mgr,
    bus,
    workspaceRoot: dir,
    workDir: join(dir, "work"),
    maxSessionsPerTask: 3,
    maxSessionsTotal: 8,
    specFor: () => null,
  });

  return {
    dir,
    board,
    bridge,
    mgr,
    hub,
    cleanup: async () => {
      await mgr.shutdown();
      bridge.stop();
      board.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- A 组

async function partA(): Promise<void> {
  console.log("================ A 组：附件导入与落盘 ================\n");

  eq("A：CRC-32 已知答案（123456789）", zipCrc32(Buffer.from("123456789")) >>> 0, 0xcbf43926);
  eq("A：默认上限 200MB / 1000", `${ATTACHMENT_LIMITS.maxTotalBytes}/${ATTACHMENT_LIMITS.maxFiles}`, `${200 * 1024 * 1024}/1000`);

  // ---- 单文件 ----
  {
    const t = fresh("a-file");
    const src = join(FIXTURE, "text", "flag.txt");
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: [src] });
    check("A：单文件导入成功", r.ok, JSON.stringify(r));
    check("A：attachments.json 存在", existsSync(join(t.taskDir, "attachments", "attachments.json")));
    const m = readManifest(t.taskDir);
    eq("A：manifest version=1", m.version, 1);
    eq("A：manifest taskId 正确", m.taskId, t.taskId);
    eq("A：manifest 文件数=1", m.files.length, 1);
    const f = m.files[0] ?? {};
    eq("A：name=flag.txt", f.name, "flag.txt");
    eq("A：relativePath=flag.txt", f.relativePath, "flag.txt");
    eq("A：relativePath 无反斜杠", String(f.relativePath).includes("\\"), false);
    eq("A：size 正确", f.size, statSync(src).size);
    eq("A：sha256 正确", f.sha256, sha256File(src));
    eq("A：type=text/plain", f.type, "text/plain");
    eq("A：source=upload", f.source, "upload");
    check("A：importedAt 是数字", typeof f.importedAt === "number" && f.importedAt > 0, String(f.importedAt));
    eq("A：落盘内容一致", readTextSafe(join(t.taskDir, "attachments", "flag.txt")), readTextSafe(src));
    eq("A：导入结果 taskFileCount=1", r.taskFileCount, 1);
    eq("A：导入结果 taskTotalBytes 正确", r.taskTotalBytes, statSync(src).size);
  }

  // ---- 文件夹 ----
  {
    const t = fresh("a-dir");
    const src = join(FIXTURE, "folder");
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: [src] });
    check("A：文件夹导入成功", r.ok, JSON.stringify(r));
    const m = readManifest(t.taskDir);
    eq("A：文件夹文件数=2", m.files.length, 2);
    const a = attachment(m, "folder/a.txt");
    const b = attachment(m, "folder/sub/b.bin");
    check("A：文件夹内 a.txt 有清单项", Boolean(a));
    check("A：文件夹内 sub/b.bin 有清单项", Boolean(b));
    eq("A：a.txt sha256 正确", a?.sha256, sha256File(join(src, "a.txt")));
    eq("A：b.bin sha256 正确", b?.sha256, sha256File(join(src, "sub", "b.bin")));
    eq("A：文件夹 relativePath 全 POSIX", m.files.every((x) => !String(x.relativePath).includes("\\")), true);
    eq("A：b.bin 类型 octet-stream", b?.type, "application/octet-stream");
  }

  // ---- zip store / deflate ----
  for (const kind of ["store", "deflate"] as const) {
    const t = fresh(`a-zip-${kind}`);
    const src = join(FIXTURE, "zips", `${kind}.zip`);
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: [src] });
    check(`A：${kind} zip 导入成功`, r.ok, JSON.stringify(r));
    const m = readManifest(t.taskDir);
    eq(`A：${kind} zip 文件数=2`, m.files.length, 2);
    const readme = attachment(m, `${kind}/readme.txt`);
    const data = attachment(m, `${kind}/dir/data.bin`);
    check(`A：${kind} zip readme 有清单项`, Boolean(readme));
    check(`A：${kind} zip 嵌套目录有清单项`, Boolean(data));
    eq(
      `A：${kind} zip readme 内容正确`,
      readTextSafe(join(t.taskDir, "attachments", kind, "readme.txt")),
      kind === "store" ? "store hello\n" : "deflate hello\n",
    );
  }

  // ---- 多个 zip 一次导入 ----
  {
    const t = fresh("a-zip-multi");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "store.zip"), join(FIXTURE, "zips", "deflate.zip")],
    });
    check("A：多个 zip 一次导入成功", r.ok, JSON.stringify(r));
    const m = readManifest(t.taskDir);
    eq("A：多个 zip 共 4 个文件", m.files.length, 4);
    check("A：两个 zip 前缀不冲突", Boolean(attachment(m, "store/readme.txt")) && Boolean(attachment(m, "deflate/readme.txt")));
  }

  // ---- 上限（模拟小上限，不真造 200MB） ----
  {
    const t = fresh("a-limit-bytes");
    const src = join(FIXTURE, "big", "text-big.txt");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [src],
      limits: { maxTotalBytes: 1024, maxFiles: 1000 },
    });
    check("A：超过总大小被拒", !r.ok && /总大小/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：超限后没有 attachments 目录", existsSync(join(t.taskDir, "attachments")), false);
  }
  {
    const t = fresh("a-limit-files");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "folder")],
      limits: { maxTotalBytes: 1024 * 1024, maxFiles: 1 },
    });
    check("A：超过文件数被拒", !r.ok && /数量/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：文件数超限后没有 attachments 目录", existsSync(join(t.taskDir, "attachments")), false);
  }
  {
    const t = fresh("a-limit-zip-files");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "store.zip")],
      limits: { maxTotalBytes: 1024 * 1024, maxFiles: 1 },
    });
    check("A：zip 文件数超限被拒", !r.ok && /文件数/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：zip 文件数超限无残留", existsSync(join(t.taskDir, "attachments")), false);
  }
  {
    const t = fresh("a-limit-zip-bytes");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "bomb.zip")],
      limits: { maxTotalBytes: 1000, maxFiles: 1000 },
    });
    check("A：zip 解压总大小超限被拒", !r.ok && /总大小/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：zip 解压超限无残留", existsSync(join(t.taskDir, "attachments")), false);
  }

  // ---- 失败不残留 ----
  {
    const t = fresh("a-failure");
    const first = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("A：失败测试的前置导入成功", first.ok, JSON.stringify(first));
    const beforeListing = listAttachmentsDir(t.taskDir);
    const beforeManifest = readTextSafe(join(t.taskDir, "attachments", "attachments.json"));

    const missing = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "no-such-file.bin")],
    });
    check("A：不存在路径被拒", !missing.ok && /no-such|不存在|ENOENT/i.test(missing.error ?? ""), JSON.stringify(missing));
    eq("A：失败后 attachments 目录列表不变", JSON.stringify(listAttachmentsDir(t.taskDir)), JSON.stringify(beforeListing));
    eq("A：失败后 manifest 不变", readTextSafe(join(t.taskDir, "attachments", "attachments.json")), beforeManifest);
    check("A：失败后无临时目录", noTemp(t.taskDir));

    const again = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("A：重复导入被拒", !again.ok && /已存在/.test(again.error ?? ""), JSON.stringify(again));
    eq("A：重复导入后文件数不变", readManifest(t.taskDir).files.length, 1);
  }
  {
    const t = fresh("a-bad-crc");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "bad-crc.zip")],
    });
    check("A：坏 CRC zip 被拒", !r.ok && /CRC/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：坏 CRC 后无 attachments 目录", existsSync(join(t.taskDir, "attachments")), false);
    eq("A：坏 CRC 后无任务目录残留", existsSync(t.taskDir), false);
  }

  // ---- 混合 / 相对路径 / 空目录 / symlink / 保留名 / 重名 ----
  {
    const t = fresh("a-mixed");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "text", "flag.txt"), join(FIXTURE, "folder")],
    });
    check("A：文件+文件夹混合被拒", !r.ok && /单一路径类型/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：混合导入无写入", existsSync(join(t.taskDir, "attachments")), false);
  }
  {
    const t = fresh("a-relative");
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: ["text/flag.txt"] });
    check("A：相对路径被拒", !r.ok && /绝对路径/.test(r.error ?? ""), JSON.stringify(r));
  }
  {
    const t = fresh("a-empty-dir");
    const empty = join(FIXTURE, "empty-dir");
    mkdirSync(empty, { recursive: true });
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: [empty] });
    check("A：空文件夹被拒", !r.ok && /没有文件/.test(r.error ?? ""), JSON.stringify(r));
  }
  {
    const t = fresh("a-symlink-src");
    const link = join(FIXTURE, "link-src");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join(FIXTURE, "folder"), link, "junction");
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: [link] });
    check("A：文件夹来源 junction 被拒", !r.ok && /symlink|junction/i.test(r.error ?? ""), JSON.stringify(r));
  }
  {
    const t = fresh("a-reserved");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "reserved", "attachments.json")],
    });
    check("A：保留文件名被拒", !r.ok && /保留/.test(r.error ?? ""), JSON.stringify(r));
  }
  {
    const t = fresh("a-dup-top");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "dup1", "same.txt"), join(FIXTURE, "dup2", "same.txt")],
    });
    check("A：同名文件重复被拒", !r.ok && /重复/.test(r.error ?? ""), JSON.stringify(r));
  }
  {
    const t = fresh("a-bad-task");
    const r = await importAttachments({ workRoot: t.root, taskId: "../evil", paths: [join(FIXTURE, "text", "flag.txt")] });
    check("A：非法 taskId 被拒", !r.ok, JSON.stringify(r));
  }
  {
    const t = fresh("a-missing-workroot");
    const r = await importAttachments({
      workRoot: join(t.root, "nope"),
      taskId: "task-x",
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("A：工作目录不存在被拒", !r.ok && /工作目录/.test(r.error ?? ""), JSON.stringify(r));
  }

  // ---- 损坏/非法清单 ----
  {
    const t = fresh("a-manifest-corrupt");
    mkdirSync(join(t.taskDir, "attachments"), { recursive: true });
    writeFileSync(join(t.taskDir, "attachments", "attachments.json"), "{not json");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("A：损坏的 attachments.json 拒绝覆盖", !r.ok && /损坏/.test(r.error ?? ""), JSON.stringify(r));
    eq(
      "A：损坏的清单保持原样",
      readTextSafe(join(t.taskDir, "attachments", "attachments.json")),
      "{not json",
    );
    eq("A：损坏清单安全读返回空", readAttachments(t.taskDir).length, 0);
  }
  {
    const t = fresh("a-manifest-invalid-path");
    mkdirSync(join(t.taskDir, "attachments"), { recursive: true });
    writeFileSync(
      join(t.taskDir, "attachments", "attachments.json"),
      JSON.stringify({
        version: 1,
        taskId: t.taskId,
        files: [
          {
            name: "evil",
            relativePath: "../evil",
            size: 1,
            sha256: "0".repeat(64),
            type: "text/plain",
            source: "upload",
            importedAt: 1,
          },
        ],
      }),
    );
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("A：非法 relativePath 的清单拒绝导入", !r.ok && /relativePath/.test(r.error ?? ""), JSON.stringify(r));
    eq("A：安全读过滤非法 relativePath", readAttachments(t.taskDir).length, 0);
  }
  {
    const t = fresh("a-taskdir-junction");
    const outside = join(t.root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, t.taskDir, "junction");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("A：任务目录是 junction 时拒绝写入", !r.ok && /symlink|junction/i.test(r.error ?? ""), JSON.stringify(r));
    eq("A：junction 目标未被写入", existsSync(join(outside, "attachments")), false);
  }

  // ---- 跨任务隔离 ----
  {
    const root = join(WORK, "a-isolation");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const ra = await importAttachments({
      workRoot: root,
      taskId: "task-a",
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    const rb = await importAttachments({
      workRoot: root,
      taskId: "task-b",
      paths: [join(FIXTURE, "text", "note.md")],
    });
    check("A：隔离测试 A 导入成功", ra.ok, JSON.stringify(ra));
    check("A：隔离测试 B 导入成功", rb.ok, JSON.stringify(rb));
    const a = readAttachments(join(root, "task-a"));
    const b = readAttachments(join(root, "task-b"));
    eq("A：A 任务只有自己的附件", a.map((f) => f.relativePath).join(","), "flag.txt");
    eq("A：B 任务只有自己的附件", b.map((f) => f.relativePath).join(","), "note.md");
  }

  // ---- 扫描（只建函数、不接 Hub） ----
  {
    const t = fresh("a-scan");
    const src = join(FIXTURE, "text", "flag.txt");
    const r = await importAttachments({ workRoot: t.root, taskId: t.taskId, paths: [src] });
    check("A：扫描前置导入成功", r.ok, JSON.stringify(r));
    const hits = await scanAttachmentForFlags({ taskDir: t.taskDir, relativePath: "attachments/flag.txt" });
    eq("A：扫描命中 2 条", hits.length, 2);
    check("A：扫描保留路径", hits.every((h) => h.relativePath === "attachments/flag.txt"), JSON.stringify(hits));
    eq("A：大小写不敏感的命中保留原文", hits.map((h) => h.match).join(","), "FLAG{Fixture_Text_Flag},flag{second_hit}");
    const binHits = await scanAttachmentForFlags({
      taskDir: t.taskDir,
      relativePath: "attachments/flag.txt",
      maxBytes: 5,
    });
    eq("A：扫描 maxBytes 生效（前缀无 flag）", binHits.length, 0);

    const preview = previewAttachment({ taskDir: t.taskDir, relativePath: "attachments/flag.txt" });
    eq("A：导入后的附件可按任务相对路径预览", preview.kind, "text");
    check("A：预览内容含导入的 flag", (preview.content ?? "").includes("FLAG{Fixture_Text_Flag}"));
  }

  // ---- Hub 快照 / 动作 / 校验 ----
  {
    const h = await makeHub("snapshot");
    try {
      const created = await h.hub.dispatch({ type: "task.create", title: "附件验收", brief: "P3-A" });
      check("A：Hub 创建任务成功", created.ok, JSON.stringify(created));
      const taskIdA = h.hub.currentTaskId!;
      const imported = await h.hub.dispatch({
        type: "attachment.import",
        paths: [join(FIXTURE, "text", "flag.txt")],
        note: "验收",
      });
      check("A：Hub attachment.import 成功", imported.ok, JSON.stringify(imported));

      const snap = h.hub.snapshot();
      eq("A：HubSnapshot.attachments 是焦点清单", snap.attachments?.length, 1);
      eq("A：快照 task.attachmentCount=1", snap.task?.attachmentCount, 1);
      eq("A：快照 task.attachments 带完整清单", snap.task?.attachments?.length, 1);
      eq("A：快照 tasks 里该任务 attachmentCount=1", snap.tasks.find((t) => t.id === taskIdA)?.attachmentCount, 1);

      const createdB = await h.hub.dispatch({ type: "task.create", title: "后台任务", brief: "B" });
      check("A：Hub 创建后台任务成功", createdB.ok, JSON.stringify(createdB));
      const taskIdB = h.hub.currentTaskId!;
      const bgImport = await h.hub.dispatch({
        type: "attachment.import",
        taskId: taskIdA,
        paths: [join(FIXTURE, "text", "note.md")],
      });
      check("A：后台任务导入成功", bgImport.ok, JSON.stringify(bgImport));
      const snapB = h.hub.snapshot();
      eq("A：焦点 B 的快照附件为空", snapB.attachments?.length, 0);
      eq("A：A 的附件不出现在 B 的快照", snapB.task?.attachments?.length, 0);
      eq("A：B 的看板能看到 A 的附件数量", snapB.tasks.find((t) => t.id === taskIdA)?.attachmentCount, 2);

      const switched = await h.hub.dispatch({ type: "task.switch", taskId: taskIdA });
      check("A：切回 A 成功", switched.ok, JSON.stringify(switched));
      eq("A：切回后快照附件=2", h.hub.snapshot().attachments?.length, 2);

      const refresh = await h.hub.dispatch({ type: "artifact.refresh" });
      // P3-C：占位已替换为真实扫描；断言从“返回占位错误”更新为“刷新成功并带工件数”。
      check("A：artifact.refresh 已实现（P3-C）", refresh.ok === true && /工件/.test(refresh.message ?? ""), JSON.stringify(refresh));

      const archived = await h.hub.dispatch({ type: "task.archive", taskId: taskIdA });
      check("A：归档 A 成功（无会话）", archived.ok, JSON.stringify(archived));
      const afterArchive = await h.hub.dispatch({
        type: "attachment.import",
        taskId: taskIdA,
        paths: [join(FIXTURE, "text", "flag.txt")],
      });
      check("A：归档任务不能再导入附件", !afterArchive.ok && /归档/.test(afterArchive.error ?? ""), JSON.stringify(afterArchive));

      const v1 = validateHubAction({ type: "attachment.import", paths: [join(FIXTURE, "text", "flag.txt")] });
      eq("A：校验器接受 attachment.import", v1.type, "attachment.import");
      const v2 = validateHubAction({ type: "attachment.import", taskId: "task-x", paths: ["C:\\a.txt"], note: "n" });
      eq("A：校验器透传 taskId/note", `${(v2 as { taskId?: string }).taskId}/${(v2 as { note?: string }).note}`, "task-x/n");
      const v3 = validateHubAction({ type: "artifact.refresh", taskId: "task-x" });
      eq("A：校验器接受 artifact.refresh", v3.type, "artifact.refresh");

      const rejects: Array<[string, unknown]> = [
        ["空 paths", { type: "attachment.import", paths: [] }],
        ["非数组 paths", { type: "attachment.import", paths: "x" }],
        ["非字符串 path", { type: "attachment.import", paths: [1] }],
        ["空字符串 path", { type: "attachment.import", paths: ["  "] }],
        ["NUL path", { type: "attachment.import", paths: ["C:\\a\0b"] }],
        ["101 个 path", { type: "attachment.import", paths: Array.from({ length: 101 }, () => "C:\\a") }],
        ["超长 path", { type: "attachment.import", paths: ["C:\\" + "a".repeat(5000)] }],
      ];
      for (const [label, action] of rejects) {
        let threw = false;
        try {
          validateHubAction(action);
        } catch {
          threw = true;
        }
        check(`A：校验器拒绝${label}`, threw);
      }
    } finally {
      await h.cleanup();
    }
  }
}

// ---------------------------------------------------------------- B 组

async function partB(): Promise<void> {
  console.log("\n================ B 组：ZIP 安全 ================\n");

  const cases: Array<{ file: string; keyword: RegExp; label: string }> = [
    { file: "evil-slip.zip", keyword: /路径/, label: "../ 逃逸" },
    { file: "evil-abs.zip", keyword: /绝对路径/, label: "绝对路径" },
    { file: "evil-drive.zip", keyword: /盘符/, label: "盘符" },
    { file: "evil-backslash.zip", keyword: /路径/, label: "反斜杠 ..\\ 逃逸" },
    { file: "evil-nul.zip", keyword: /NUL/, label: "NUL 文件名" },
    { file: "evil-symlink.zip", keyword: /symlink|符号链接/i, label: "symlink" },
    { file: "evil-encrypted.zip", keyword: /加密/, label: "加密" },
    { file: "evil-zip64.zip", keyword: /ZIP64/i, label: "ZIP64" },
    { file: "bad-crc.zip", keyword: /CRC/, label: "坏 CRC" },
    { file: "dup-case.zip", keyword: /重复/, label: "大小写重复" },
    { file: "conflict.zip", keyword: /冲突/, label: "文件/目录冲突" },
    { file: "empty.zip", keyword: /没有文件/, label: "空 zip" },
    { file: "dirs-only.zip", keyword: /没有文件/, label: "只有目录" },
  ];

  for (const c of cases) {
    const t = fresh(`b-${c.file.replace(/[^a-z0-9]/gi, "-")}`);
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", c.file)],
    });
    check(`B：拒绝${c.label}`, !r.ok && c.keyword.test(r.error ?? ""), JSON.stringify(r));
    eq(`B：拒绝${c.label}后无 attachments 目录`, existsSync(join(t.taskDir, "attachments")), false);
    eq(`B：拒绝${c.label}后无任务目录残留`, existsSync(t.taskDir), false);
  }

  // store/deflate 正常解压 + 不产生链接
  for (const kind of ["store", "deflate"] as const) {
    const t = fresh(`b-ok-${kind}`);
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", `${kind}.zip`)],
    });
    check(`B：${kind} zip 正常导入`, r.ok, JSON.stringify(r));
    const paths = ["readme.txt", "dir/data.bin"].map((p) => join(t.taskDir, "attachments", kind, ...p.split("/")));
    check(
      `B：${kind} 解压产物都是普通文件（非链接）`,
      paths.every((p) => isPlainFile(p)),
    );
    eq(`B：${kind} 无临时目录`, noTemp(t.taskDir), true);
  }

  // 混合 zip/文件、zip/文件夹
  {
    const t = fresh("b-mixed-file");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "store.zip"), join(FIXTURE, "text", "flag.txt")],
    });
    check("B：zip+文件混合被拒", !r.ok && /单一路径类型/.test(r.error ?? ""), JSON.stringify(r));
  }
  {
    const t = fresh("b-mixed-dir");
    const r = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "store.zip"), join(FIXTURE, "folder")],
    });
    check("B：zip+文件夹混合被拒", !r.ok && /单一路径类型/.test(r.error ?? ""), JSON.stringify(r));
  }

  // 导入已有 manifest 后再失败：清单与文件都不变
  {
    const t = fresh("b-rollback");
    const ok = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "store.zip")],
    });
    check("B：回滚测试前置导入成功", ok.ok, JSON.stringify(ok));
    const before = listAttachmentsDir(t.taskDir);
    const manifestBefore = readTextSafe(join(t.taskDir, "attachments", "attachments.json"));
    const bad = await importAttachments({
      workRoot: t.root,
      taskId: t.taskId,
      paths: [join(FIXTURE, "zips", "bad-crc.zip")],
    });
    check("B：坏 CRC 覆盖导入被拒", !bad.ok, JSON.stringify(bad));
    eq("B：失败后目录列表不变", JSON.stringify(listAttachmentsDir(t.taskDir)), JSON.stringify(before));
    eq("B：失败后 manifest 不变", readTextSafe(join(t.taskDir, "attachments", "attachments.json")), manifestBefore);
  }
}

// ---------------------------------------------------------------- C 组

function setupPreviewTask(): string {
  const taskDir = join(RUN, "preview", "task-prep");
  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "hello.txt"), "hello preview\n");
  writeFileSync(join(taskDir, "big.txt"), "A".repeat(300 * 1024));
  writeFileSync(join(taskDir, "tiny.png"), TINY_PNG);
  writeFileSync(join(taskDir, "fake.png"), "<html>not an image</html>");
  writeFileSync(join(taskDir, "small.bin"), Buffer.from([0, 1, 2, 3, 4, 255]));
  writeFileSync(join(taskDir, "binary-as.txt"), Buffer.from([0x66, 0x00, 0x6c, 0x61, 0x67]));
  writeFileSync(join(taskDir, "blob.bin"), Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256)));
  writeFileSync(join(taskDir, "big.png"), Buffer.concat([TINY_PNG.subarray(0, 8), Buffer.alloc(2 * 1024 * 1024)]));
  writeFileSync(join(taskDir, "page.html"), "<script>alert(1)</script>\nflag{HTML_Text}\n");
  writeFileSync(join(taskDir, "pic.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>\n");
  writeFileSync(join(taskDir, "evil.exe"), Buffer.from("MZ"));
  writeFileSync(join(taskDir, "flag.txt"), "flag{scan_me}\nFLAG{SCAN_ME_TOO}\n");
  mkdirSync(join(taskDir, "sub"), { recursive: true });
  writeFileSync(join(taskDir, "sub", "inside.txt"), "inside\n");

  const outside = join(RUN, "preview", "outside");
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "secret\n");

  const linkOut = join(taskDir, "link-out");
  const linkIn = join(taskDir, "link-in");
  try {
    lstatSync(linkOut);
  } catch {
    symlinkSync(outside, linkOut, "junction");
  }
  try {
    lstatSync(linkIn);
  } catch {
    symlinkSync(join(taskDir, "sub"), linkIn, "junction");
  }
  return taskDir;
}

function rejectedPath(name: string, fn: () => unknown, codes: string[]): void {
  try {
    fn();
    check(name, false, "未抛错（应拒绝）");
  } catch (err) {
    const e = err as ArtifactPathError;
    check(name, codes.includes(e.code), `${e.name}/${e.code ?? "?"}: ${e.message}`);
  }
}

async function partC(): Promise<void> {
  console.log("\n================ C 组：预览与路径安全 ================\n");

  eq("C：预览默认上限 256KB/2MB/4KB", `${PREVIEW_LIMITS.textBytes}/${PREVIEW_LIMITS.imageBytes}/${PREVIEW_LIMITS.hexBytes}`, `${256 * 1024}/${2 * 1024 * 1024}/${4 * 1024}`);

  const taskDir = setupPreviewTask();

  // 文本
  {
    const p = previewAttachment({ taskDir, relativePath: "hello.txt" });
    eq("C：文本预览 kind=text", p.kind, "text");
    eq("C：文本预览内容", p.content, "hello preview\n");
    eq("C：文本预览 totalBytes", p.totalBytes, Buffer.byteLength("hello preview\n"));
    eq("C：文本预览未截断", p.truncated, false);
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "big.txt" });
    eq("C：大文本 kind=text", p.kind, "text");
    eq("C：大文本标记截断", p.truncated, true);
    eq("C：大文本只返回 256KB", p.content?.length, 256 * 1024);
    eq("C：大文本 totalBytes 是原始大小", p.totalBytes, 300 * 1024);
  }

  // 图片
  {
    const p = previewAttachment({ taskDir, relativePath: "tiny.png" });
    eq("C：图片 kind=image", p.kind, "image");
    check("C：图片 dataUrl 前缀", (p.dataUrl ?? "").startsWith("data:image/png;base64,"), (p.dataUrl ?? "").slice(0, 40));
    eq("C：图片解码后与源文件一致", Buffer.from((p.dataUrl ?? "").split(",")[1] ?? "", "base64").equals(TINY_PNG), true);
    eq("C：图片未截断", p.truncated, false);
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "big.png" });
    eq("C：超大图片 kind=unsupported", p.kind, "unsupported");
    eq("C：超大图片标记截断", p.truncated, true);
    eq("C：超大图片不给 dataUrl", p.dataUrl, undefined);
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "fake.png" });
    check("C：假 PNG（魔数不符）不按图片返回", p.kind !== "image", p.kind);
  }

  // 二进制
  {
    const p = previewAttachment({ taskDir, relativePath: "small.bin" });
    eq("C：小二进制 kind=hex", p.kind, "hex");
    check("C：hex 含偏移", (p.content ?? "").includes("00000000"), (p.content ?? "").slice(0, 60));
    eq("C：小二进制未截断", p.truncated, false);
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "binary-as.txt" });
    eq("C：文本扩展名但含 NUL → hex", p.kind, "hex");
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "blob.bin" });
    eq("C：5KB 二进制 kind=hex", p.kind, "hex");
    eq("C：5KB 二进制标记截断", p.truncated, true);
    eq("C：hex 只取 4KB（256 行）", (p.content ?? "").split("\n").length, 256);
  }

  // 目录 / HTML / SVG
  {
    const p = previewAttachment({ taskDir, relativePath: "sub" });
    eq("C：目录 kind=unsupported", p.kind, "unsupported");
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "page.html" });
    eq("C：HTML 只当文本（不渲染）", p.kind, "text");
    check("C：HTML 原文可见（渲染层必须用文本节点）", (p.content ?? "").includes("<script>"), (p.content ?? "").slice(0, 30));
  }
  {
    const p = previewAttachment({ taskDir, relativePath: "pic.svg" });
    eq("C：SVG 只当文本（不按图片）", p.kind, "text");
  }

  // 预览只读：文件内容不变
  {
    const before = sha256File(join(taskDir, "hello.txt"));
    previewAttachment({ taskDir, relativePath: "hello.txt" });
    eq("C：预览不改文件内容", sha256File(join(taskDir, "hello.txt")), before);
  }

  // 路径越界
  rejectedPath("C：拒绝 ../ 逃逸", () => previewAttachment({ taskDir, relativePath: "../outside/secret.txt" }), ["escape"]);
  rejectedPath("C：拒绝反斜杠 ..\\ 逃逸", () => previewAttachment({ taskDir, relativePath: "..\\outside\\secret.txt" }), ["escape"]);
  rejectedPath("C：拒绝绝对路径", () => previewAttachment({ taskDir, relativePath: "/etc/passwd" }), ["absolute"]);
  rejectedPath("C：拒绝盘符路径", () => previewAttachment({ taskDir, relativePath: "C:/Windows/win.ini" }), ["drive"]);
  rejectedPath("C：拒绝盘符相对路径", () => previewAttachment({ taskDir, relativePath: "C:secret.txt" }), ["drive"]);
  rejectedPath("C：拒绝 NUL 路径", () => previewAttachment({ taskDir, relativePath: "a\0b" }), ["nul"]);
  rejectedPath("C：拒绝不存在文件", () => previewAttachment({ taskDir, relativePath: "nope.txt" }), ["missing"]);
  rejectedPath("C：拒绝越界 junction", () => previewAttachment({ taskDir, relativePath: "link-out/secret.txt" }), ["escape", "symlink"]);
  rejectedPath("C：拒绝任务内 junction", () => previewAttachment({ taskDir, relativePath: "link-in/inside.txt" }), ["symlink"]);
  rejectedPath("C：拒绝空路径", () => previewAttachment({ taskDir, relativePath: "" }), ["empty"]);

  // resolveWithinTask 直接校验
  {
    const real = resolveWithinTask(taskDir, "sub/inside.txt");
    check("C：resolveWithinTask 返回真实路径", real.toLowerCase().endsWith("inside.txt"), real);
  }

  // 可执行文件不提供“系统打开”
  eq("C：exe 不允许系统打开", isSystemOpenAllowed("evil.exe"), false);
  eq("C：bat 不允许系统打开", isSystemOpenAllowed("run.bat"), false);
  eq("C：ps1 不允许系统打开", isSystemOpenAllowed("run.ps1"), false);
  eq("C：hta 不允许系统打开", isSystemOpenAllowed("evil.hta"), false);
  eq("C：html 不允许系统打开", isSystemOpenAllowed("page.html"), false);
  eq("C：svg 不允许系统打开", isSystemOpenAllowed("pic.svg"), false);
  eq("C：lnk 不允许系统打开", isSystemOpenAllowed("shortcut.lnk"), false);
  eq("C：txt 允许系统打开", isSystemOpenAllowed("hello.txt"), true);
  eq("C：png 允许系统打开", isSystemOpenAllowed("tiny.png"), true);

  // normalizeRelativePath
  eq("C：normalize 把反斜杠归一为 POSIX", normalizeRelativePath("a\\b\\c.txt"), "a/b/c.txt");
  rejectedPath("C：normalize 拒绝 ..", () => normalizeRelativePath("a/../../b"), ["escape"]);
  rejectedPath("C：normalize 拒绝盘符", () => normalizeRelativePath("D:/x"), ["drive"]);

  // 扫描：HTML 文本命中；二进制跳过
  {
    const htmlHits = await scanAttachmentForFlags({ taskDir, relativePath: "page.html" });
    eq("C：扫描 HTML 文本命中 1 条", htmlHits.length, 1);
    eq("C：扫描命中串保留大小写", htmlHits[0]?.match, "flag{HTML_Text}");
    const binHits = await scanAttachmentForFlags({ taskDir, relativePath: "blob.bin" });
    eq("C：扫描二进制跳过", binHits.length, 0);
    const txtBinHits = await scanAttachmentForFlags({ taskDir, relativePath: "binary-as.txt" });
    eq("C：扫描含 NUL 的 .txt 跳过", txtBinHits.length, 0);
    const flagHits = await scanAttachmentForFlags({ taskDir, relativePath: "flag.txt" });
    eq("C：扫描大小写不敏感", flagHits.map((h) => h.match).join(","), "flag{scan_me},FLAG{SCAN_ME_TOO}");
  }
  {
    // 大文本 300KB + 末尾 flag：扫描默认读 4MB，仍能命中（预览只看 256KB）
    const bigFlag = join(taskDir, "big-flag.txt");
    writeFileSync(bigFlag, "A".repeat(300 * 1024) + "flag{After_Preview_Window}");
    const hits = await scanAttachmentForFlags({ taskDir, relativePath: "big-flag.txt" });
    eq("C：扫描超过预览窗口仍命中", hits.map((h) => h.match).join(","), "flag{After_Preview_Window}");
  }
}

// ---------------------------------------------------------------- D 组

interface EvidenceHarness {
  dir: string;
  board: Blackboard;
  bridge: BoardBridge;
  taskId: string;
  taskDir: string;
  sessionId: string;
  submit: (content: string, witness: string | null) => Promise<string>;
  cleanup: () => void;
}

/**
 * D 组夹具：走真实 `BoardBridge.route(board.submit_fact)`，不直接调私有 inferEvidence。
 * 这样锁的是「MCP 提交事实」这条真实路径，而不是某个内部函数。
 */
function makeEvidenceHarness(label: string, replay?: EvidenceReplayer): EvidenceHarness {
  const dir = join(RUN, "evidence", label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const board = Blackboard.open(join(dir, "board.db"));
  const task = board.createTask({ title: `证据验收 ${label}`, brief: "D/E 组" });
  const sessionId = "s-evidence";
  board.insertSession({ id: sessionId, taskId: task.id, agent: "claude", role: "lead", tier: "guarded", status: "idle" });
  const taskDir = join(dir, "work", task.id);
  mkdirSync(taskDir, { recursive: true });
  const bridge = new BoardBridge({
    board,
    taskId: task.id,
    runId: `verify-artifacts-${label}-${randomUUID()}`,
    workRoot: join(dir, "work"),
    replay,
  });
  const route = (
    bridge as unknown as {
      route(method: string, params: Record<string, unknown>): Promise<unknown>;
    }
  ).route.bind(bridge);
  return {
    dir,
    board,
    bridge,
    taskId: task.id,
    taskDir,
    sessionId,
    submit: async (content, witness) => {
      const r = (await route(BRIDGE_RPC.submitFact, { sessionId, content, witness })) as { evidence: string };
      return r.evidence;
    },
    cleanup: () => {
      bridge.stop();
      board.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function partD(): Promise<void> {
  console.log("================ D 组：证据判级（锁旧语义 + 事实文本扩展）================\n");

  const h = makeEvidenceHarness("d-main");
  try {
    mkdirSync(join(h.taskDir, "evidence"), { recursive: true });
    writeFileSync(join(h.taskDir, "plain.txt"), "这里没有提交内容\n");
    writeFileSync(join(h.taskDir, "evidence", "out.txt"), "命令回显：flag{D_FILE_FLAG}\n");
    writeFileSync(join(h.taskDir, "evidence", "other-flag.txt"), "flag{D_OTHER_FLAG}\n");
    writeFileSync(join(h.taskDir, "evidence", "fact.txt"), "line1\n管理员密码是 hunter2\nline3\n");
    writeFileSync(join(h.taskDir, "evidence", "fact-extra.txt"), "前缀 管理员密码是 hunter2 后缀\n");
    writeFileSync(join(h.taskDir, "evidence", "fact-partial.txt"), "管理员密码是 hunter2\n");
    const outside = join(h.dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "flag{D_OUTSIDE_FLAG}\n");
    symlinkSync(outside, join(h.taskDir, "link-out"), "junction");

    // ---- 旧语义：这些断言在改 inferEvidence 之前就必须全绿 ----
    eq("D：无 witness → E0", await h.submit("flag{D_FILE_FLAG}", null), "E0");
    eq("D：空 witness → E0", await h.submit("flag{D_FILE_FLAG}", ""), "E0");
    eq("D：空白 witness → E0", await h.submit("flag{D_FILE_FLAG}", "   "), "E0");
    eq("D：witness 是任务内真实文件但不含提交内容 → E1", await h.submit("flag{D_FILE_FLAG}", "plain.txt"), "E1");
    eq("D：witness 文件含提交的 flag → E2", await h.submit("flag{D_FILE_FLAG}", "evidence/out.txt"), "E2");
    eq("D：witness 任务内绝对路径含 flag → E2", await h.submit("flag{D_FILE_FLAG}", join(h.taskDir, "evidence", "out.txt")), "E2");
    eq("D：witness 带引号仍能解析 → E2", await h.submit("flag{D_FILE_FLAG}", '"evidence/out.txt"'), "E2");
    eq(
      "D：witness 相对路径指向任务目录外 → E1（现有语义不是 error）",
      await h.submit("flag{D_FILE_FLAG}", "../../outside/secret.txt"),
      "E1",
    );
    eq("D：witness 绝对路径指向任务目录外 → E1", await h.submit("flag{D_FILE_FLAG}", join(outside, "secret.txt")), "E1");
    eq("D：witness 指向目录而非文件 → E1", await h.submit("flag{D_FILE_FLAG}", "evidence"), "E1");
    eq("D：witness 经 junction 逃逸 → E1", await h.submit("flag{D_FILE_FLAG}", "link-out/secret.txt"), "E1");
    eq("D：witness 不存在 → E1", await h.submit("flag{D_FILE_FLAG}", "nope.txt"), "E1");
    eq("D：文件含 flag 但提交内容不含该 flag → E1", await h.submit("这里没有 flag", "evidence/out.txt"), "E1");
    eq("D：提交 flag A、文件含 flag B → E1", await h.submit("flag{D_FILE_FLAG}", "evidence/other-flag.txt"), "E1");
    eq(
      "D：内容含 flag 且文件含该 flag → E2（flag 优先）",
      await h.submit("flag{D_FILE_FLAG} 管理员密码是 hunter2", "evidence/out.txt"),
      "E2",
    );

    // 没有 workRoot 的桥：witness 只能到 E1（旧行为）
    {
      const noRoot = new BoardBridge({
        board: h.board,
        taskId: h.taskId,
        runId: `verify-artifacts-d-noroot-${randomUUID()}`,
      });
      const route = (
        noRoot as unknown as {
          route(method: string, params: Record<string, unknown>): Promise<unknown>;
        }
      ).route.bind(noRoot);
      const r = (await route(BRIDGE_RPC.submitFact, {
        sessionId: h.sessionId,
        content: "flag{D_FILE_FLAG}",
        witness: "evidence/out.txt",
      })) as { evidence: string };
      eq("D：没有 workRoot 时 witness 只到 E1", r.evidence, "E1");
      noRoot.stop();
    }

    // ---- 新语义：事实文本 → E2（改 inferEvidence 之前应为红）----
    eq("D：witness 文件含提交的事实文本（无 flag）→ E2", await h.submit("管理员密码是 hunter2", "evidence/fact.txt"), "E2");
    eq(
      "D：事实文本按包含匹配（文件有前后缀）→ E2",
      await h.submit("管理员密码是 hunter2", "evidence/fact-extra.txt"),
      "E2",
    );
    eq("D：空事实文本不算命中 → E1", await h.submit("", "evidence/fact.txt"), "E1");
    eq("D：空白事实文本不算命中 → E1", await h.submit("  \n\t ", "evidence/fact.txt"), "E1");
    eq(
      "D：文件只含事实文本的一部分 → E1",
      await h.submit("管理员密码是 hunter2 且可以登录", "evidence/fact-partial.txt"),
      "E1",
    );
  } finally {
    h.cleanup();
  }

  // ---- 附件扫描接入 Hub：生成候选 + 审计不含答案明文（V2-P0-2）----
  const scanHub = await makeHub("d-scan");
  try {
    const created = await scanHub.hub.dispatch({ type: "task.create", title: "扫描验收", brief: "D 组" });
    check("D：扫描夹具创建任务成功", created.ok, JSON.stringify(created));
    const taskId = scanHub.hub.currentTaskId!;
    const imported = await scanHub.hub.dispatch({
      type: "attachment.import",
      paths: [join(FIXTURE, "text", "flag.txt")],
    });
    check("D：扫描夹具导入含 flag 附件成功", imported.ok, JSON.stringify(imported));

    const scans = scanHub.board.raw("SELECT detail FROM audit WHERE action = 'attachment.scan'") as Array<{
      detail: string;
    }>;
    eq("D：附件扫描命中写一条审计", scans.length, 1);
    let detail: { hitCount?: number; sourcePaths?: string[]; answerTypes?: string[] } = {};
    try {
      detail = JSON.parse(scans[0]?.detail ?? "{}");
    } catch {
      /* 解析失败按空处理，由下面的断言报出来 */
    }
    eq("D：扫描审计记录命中数量", detail.hitCount, 2);
    check(
      "D：扫描审计不写答案明文",
      !JSON.stringify(detail).includes("Fixture_Text_Flag") && !JSON.stringify(detail).includes("second_hit"),
      JSON.stringify(detail),
    );
    check(
      "D：扫描审计路径是任务内相对路径（单层 attachments/ 前缀）",
      (detail.sourcePaths ?? []).length > 0 &&
        (detail.sourcePaths ?? []).every(
          (p) => p.startsWith("attachments/") && !p.startsWith("attachments/attachments/"),
        ),
      JSON.stringify(detail.sourcePaths),
    );
    check(
      "D：扫描审计记录答案类型",
      (detail.answerTypes ?? []).includes("flag"),
      JSON.stringify(detail.answerTypes),
    );
    const scanCandidates = scanHub.board.listFlagCandidates(taskId);
    eq("D：附件扫描生成 2 个候选", scanCandidates.length, 2);
    const upper = scanCandidates.find((c) => c.value === "FLAG{Fixture_Text_Flag}");
    check("D：候选 answerType=flag", upper?.answer_type === "flag", JSON.stringify(upper));
    check("D：候选 normalized_value 已写入", Boolean(upper?.normalized_value), JSON.stringify(upper));
    const upperSources = upper ? scanHub.board.listFlagSources(upper.id) : [];
    check(
      "D：候选来源带附件路径/行号/偏移",
      upperSources.some(
        (s) =>
          typeof s.source_path === "string" &&
          s.source_path.startsWith("attachments/") &&
          s.line === 2 &&
          typeof s.byte_offset === "number",
      ),
      JSON.stringify(upperSources),
    );
    eq("D：扫描不写事实", scanHub.board.listFacts(taskId).length, 0);
    const flagAudits = scanHub.board.raw("SELECT action FROM audit WHERE action = 'task.flag_candidate'") as unknown[];
    eq("D：扫描产生 task.flag_candidate 审计（2 条）", flagAudits.length, 2);

    const beforeClean = (
      scanHub.board.raw("SELECT detail FROM audit WHERE action = 'attachment.scan'") as unknown[]
    ).length;
    const cleanImport = await scanHub.hub.dispatch({
      type: "attachment.import",
      paths: [join(FIXTURE, "text", "note.md")],
    });
    check("D：无 flag 附件导入成功", cleanImport.ok, JSON.stringify(cleanImport));
    const afterClean = (
      scanHub.board.raw("SELECT detail FROM audit WHERE action = 'attachment.scan'") as unknown[]
    ).length;
    eq("D：无 flag 附件不写扫描审计", afterClean, beforeClean);

    const binImport = await scanHub.hub.dispatch({
      type: "attachment.import",
      paths: [join(FIXTURE, "bin", "small.bin")],
    });
    check("D：二进制附件导入成功", binImport.ok, JSON.stringify(binImport));
    const afterBin = (
      scanHub.board.raw("SELECT detail FROM audit WHERE action = 'attachment.scan'") as unknown[]
    ).length;
    eq("D：二进制附件不写扫描审计", afterBin, afterClean);
  } finally {
    await scanHub.cleanup();
  }
}

// ---------------------------------------------------------------- E 组

const E_FLAG = "flag{E_REPLAY_FLAG}";

/** 生成一条不经过 shell 的 node 命令；路径含空格，用双引号包住。 */
function nodeCommand(code: string): string {
  return `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`;
}

function replayAudits(board: Blackboard): Array<Record<string, unknown>> {
  const rows = board.raw("SELECT detail FROM audit WHERE action = 'evidence.replay' ORDER BY id") as Array<{
    detail: string;
  }>;
  return rows.map((row) => {
    try {
      return JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
}

async function partE(): Promise<void> {
  console.log("================ E 组：cmd: 回放（默认关 / 开启 / 策略 / 审计）================\n");

  // ---- 1. 默认关：loader 三处缺省都必须是 false ----
  const emptyRepo = join(RUN, "e-config-empty");
  rmSync(emptyRepo, { recursive: true, force: true });
  mkdirSync(emptyRepo, { recursive: true });
  const cfgDefault = loadAppConfig({ repoRoot: emptyRepo, isPackaged: false, resourcesPath: "", env: {} });
  eq("E：loader 缺省 evidenceReplay=false", cfgDefault.config.evidenceReplay, false);
  const cfgOn = loadAppConfig({
    repoRoot: emptyRepo,
    isPackaged: false,
    resourcesPath: "",
    env: { BUMIMANG_EVIDENCE_REPLAY: "1" },
  });
  eq("E：BUMIMANG_EVIDENCE_REPLAY=1 时 true", cfgOn.config.evidenceReplay, true);
  const cfgTrue = loadAppConfig({
    repoRoot: emptyRepo,
    isPackaged: false,
    resourcesPath: "",
    env: { BUMIMANG_EVIDENCE_REPLAY: "true" },
  });
  eq("E：env=true 不开启（只认 1）", cfgTrue.config.evidenceReplay, false);
  const cfgRepo = loadAppConfig({ repoRoot: ROOT, isPackaged: false, resourcesPath: "", env: {} });
  eq("E：仓库 config/app.json 缺省也是 false", cfgRepo.config.evidenceReplay, false);

  eq("E：默认超时 30s", REPLAY_TIMEOUT_MS, 30_000);
  eq("E：默认输出上限 1MB", REPLAY_MAX_OUTPUT_BYTES, 1024 * 1024);

  // ---- 2. argv 解析：无 shell，保留引号内空格 ----
  const argv = parseCommandLine(`"${process.execPath}" -e "console.log('a b')"`);
  eq("E：argv 解析为 3 段", argv.length, 3);
  eq("E：argv[0] 是 node 可执行文件", argv[0], process.execPath);
  eq("E：argv[2] 保留引号内空格", argv[2], "console.log('a b')");

  // ---- 3. 策略/审批桩：可在用例间切换 verdict ----
  let policyVerdict: Verdict = "allow";
  const policy: Policy = {
    name: "verify-artifacts-e-policy",
    evaluate: () => ({ verdict: policyVerdict, rule: `e-${policyVerdict}`, reason: "E 组桩策略" }),
  };
  let approvalDecision: "approved" | "denied" = "approved";
  const approvalCalls: ApprovalRequest[] = [];
  const approval: ApprovalService = {
    request: async (input) => {
      approvalCalls.push(input);
      return { decision: approvalDecision, decidedBy: "human" as const };
    },
  };

  // ---- 4. 默认关：cmd: 不执行、判 E1、审计证明没 spawn ----
  const off = makeEvidenceHarness(
    "e-off",
    new EvidenceReplayer({ enabled: false, policy: () => policy, approval: () => approval }),
  );
  try {
    const marker = join(off.taskDir, "off-ran.txt");
    const r = await off.submit(
      E_FLAG,
      `cmd:${nodeCommand(`require('fs').writeFileSync('off-ran.txt','1'); console.log('${E_FLAG}')`)}`,
    );
    eq("E：默认关 cmd: 判 E1", r, "E1");
    eq("E：默认关不执行命令（marker 不存在）", existsSync(marker), false);
    eq("E：默认关未进审批", approvalCalls.length, 0);
    const a = replayAudits(off.board).at(-1);
    eq("E：默认关审计 status=disabled", a?.status, "disabled");
    eq("E：默认关审计 ran=false", a?.ran, false);
    eq("E：默认关审计 matched=false", a?.matched, false);
    eq("E：默认关没有策略判定", a?.policyVerdict, null);
  } finally {
    off.cleanup();
  }

  // ---- 5. 开启 + allow：命中 / cwd / 非零退出 / block / approve ----
  const on = makeEvidenceHarness(
    "e-on",
    new EvidenceReplayer({ enabled: true, policy: () => policy, approval: () => approval }),
  );
  try {
    policyVerdict = "allow";
    approvalCalls.length = 0;
    const marker = join(on.taskDir, "on-ran.txt");
    const r = await on.submit(
      E_FLAG,
      `cmd:${nodeCommand(`require('fs').writeFileSync('on-ran.txt','1'); console.log('${E_FLAG}')`)}`,
    );
    eq("E：开启且 stdout 命中 → E2", r, "E2");
    eq("E：开启后命令真的执行（marker 存在）", existsSync(marker), true);
    const a = replayAudits(on.board).at(-1);
    eq("E：命中审计 status=ok", a?.status, "ok");
    eq("E：命中审计 ran=true", a?.ran, true);
    eq("E：命中审计 exitCode=0", a?.exitCode, 0);
    eq("E：命中审计 matched=true", a?.matched, true);
    eq("E：命中审计 policyVerdict=allow", a?.policyVerdict, "allow");
    check("E：审计不含 flag 明文", !JSON.stringify(a).includes(E_FLAG), JSON.stringify(a));
    check("E：审计 command 已脱敏", String(a?.command).includes("flag{***}"), String(a?.command));
    console.log(`E 审计样例（脱敏）：${JSON.stringify(a)}`);

    const cwdCmd = nodeCommand(`require('fs').writeFileSync('cwd.txt', process.cwd()); console.log('${E_FLAG}')`);
    eq("E：cwd 命令命中 → E2", await on.submit(E_FLAG, `cmd:${cwdCmd}`), "E2");
    const cwdFile = join(on.taskDir, "cwd.txt");
    eq(
      "E：cwd 是任务 workdir",
      existsSync(cwdFile) ? resolve(readFileSync(cwdFile, "utf8")) : "<missing>",
      resolve(on.taskDir),
    );

    const nz = nodeCommand(`console.log('${E_FLAG}'); process.exit(3)`);
    eq("E：非零退出 → E1", await on.submit(E_FLAG, `cmd:${nz}`), "E1");
    const anz = replayAudits(on.board).at(-1);
    eq("E：非零退出审计 status=failed", anz?.status, "failed");
    eq("E：非零退出 exitCode=3", anz?.exitCode, 3);
    eq("E：非零退出 matched=false", anz?.matched, false);

    policyVerdict = "block";
    approvalCalls.length = 0;
    const blockMarker = join(on.taskDir, "block-ran.txt");
    eq(
      "E：策略 block → E1",
      await on.submit(
        E_FLAG,
        `cmd:${nodeCommand(`require('fs').writeFileSync('block-ran.txt','1'); console.log('${E_FLAG}')`)}`,
      ),
      "E1",
    );
    eq("E：策略 block 不执行（marker 不存在）", existsSync(blockMarker), false);
    eq("E：策略 block 不进审批", approvalCalls.length, 0);
    const ab = replayAudits(on.board).at(-1);
    eq("E：block 审计 status=blocked", ab?.status, "blocked");
    eq("E：block 审计 policyVerdict=block", ab?.policyVerdict, "block");
    eq("E：block 审计 ran=false", ab?.ran, false);

    policyVerdict = "approve";
    approvalDecision = "approved";
    approvalCalls.length = 0;
    const apprMarker = join(on.taskDir, "approve-ran.txt");
    eq(
      "E：approve + 人工批准 → E2",
      await on.submit(
        E_FLAG,
        `cmd:${nodeCommand(`require('fs').writeFileSync('approve-ran.txt','1'); console.log('${E_FLAG}')`)}`,
      ),
      "E2",
    );
    eq("E：approve 后命令执行", existsSync(apprMarker), true);
    eq("E：approve 进审批一次", approvalCalls.length, 1);
    eq("E：审批 action=evidence/replay", approvalCalls[0]?.action, "evidence/replay");
    const firstApproval = approvalCalls[0];
    check(
      "E：审批请求不含 flag 明文",
      firstApproval === undefined || !JSON.stringify(firstApproval).includes(E_FLAG),
      JSON.stringify(firstApproval),
    );
    const aa = replayAudits(on.board).at(-1);
    eq("E：approve 审计 status=ok", aa?.status, "ok");
    eq("E：approve 审计 approvalDecision=approved", aa?.approvalDecision, "approved");

    approvalDecision = "denied";
    approvalCalls.length = 0;
    const denyMarker = join(on.taskDir, "deny-ran.txt");
    eq(
      "E：approve + 人工拒绝 → E1",
      await on.submit(
        E_FLAG,
        `cmd:${nodeCommand(`require('fs').writeFileSync('deny-ran.txt','1'); console.log('${E_FLAG}')`)}`,
      ),
      "E1",
    );
    eq("E：人工拒绝不执行（marker 不存在）", existsSync(denyMarker), false);
    eq("E：人工拒绝进审批一次", approvalCalls.length, 1);
    const ad = replayAudits(on.board).at(-1);
    eq("E：denied 审计 status=denied", ad?.status, "denied");
    eq("E：denied 审计 ran=false", ad?.ran, false);

    // 真实 ApprovalQueue：approve 确实进入队列，人工批准后才执行。
    // 用一个“待批即批准”的 onUpsert 模拟人工裁决；验证的是队列接线，不是 UI。
    const queueViews: Array<{ action: string; command: string | null; status: string }> = [];
    let realQueue: ApprovalQueue;
    realQueue = new ApprovalQueue({
      onUpsert: (view) => {
        queueViews.push({ action: view.action, command: view.command, status: view.status });
        if (view.status === "pending") realQueue.decide(view.id, "approved");
      },
      timeoutMs: 1000,
    });
    const real = makeEvidenceHarness(
      "e-real-approval",
      new EvidenceReplayer({ enabled: true, policy: () => policy, approval: () => realQueue }),
    );
    try {
      policyVerdict = "approve";
      eq(
        "E：真实 ApprovalQueue 人工批准 → E2",
        await real.submit(E_FLAG, `cmd:${nodeCommand(`console.log('${E_FLAG}')`)}`),
        "E2",
      );
      const approvedView = queueViews.find((v) => v.action === "evidence/replay" && v.status === "approved");
      eq("E：真实队列收到 evidence/replay 审批", approvedView?.action, "evidence/replay");
      eq("E：真实队列审批已被人工批准", approvedView?.status, "approved");
      check(
        "E：真实队列审批 command 脱敏",
        approvedView?.command === null || !String(approvedView?.command).includes(E_FLAG),
        JSON.stringify(approvedView),
      );
    } finally {
      real.cleanup();
    }

    // 开启回放不影响文件 witness 的越界拒绝
    const outside = join(on.dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "flag{E_OUTSIDE}\n");
    symlinkSync(outside, join(on.taskDir, "link-out"), "junction");
    eq("E：开启回放后目录外 witness 仍 E1", await on.submit(E_FLAG, "../../outside/secret.txt"), "E1");
    eq("E：开启回放后 junction witness 仍 E1", await on.submit(E_FLAG, "link-out/secret.txt"), "E1");
    eq("E：开启回放后目录 witness 仍 E1", await on.submit(E_FLAG, "evidence"), "E1");

    eq("E：空 cmd 判 E1", await on.submit(E_FLAG, "cmd:   "), "E1");
    const ae = replayAudits(on.board).at(-1);
    eq("E：空 cmd 审计 status=invalid", ae?.status, "invalid");
    eq("E：空 cmd 不执行", ae?.ran, false);
  } finally {
    on.cleanup();
  }

  // ---- 6. 超时：只降级 E1，不崩 ----
  policyVerdict = "allow";
  approvalDecision = "approved";
  const to = makeEvidenceHarness(
    "e-timeout",
    new EvidenceReplayer({
      enabled: true,
      policy: () => policy,
      approval: () => approval,
      timeoutMs: 300,
    }),
  );
  try {
    const t0 = Date.now();
    eq("E：超时 → E1", await to.submit(E_FLAG, `cmd:${nodeCommand("setTimeout(()=>{}, 5000)")}`), "E1");
    const elapsed = Date.now() - t0;
    check("E：超时在 3s 内返回", elapsed < 3000, `elapsed=${elapsed}ms`);
    const a = replayAudits(to.board).at(-1);
    eq("E：超时审计 status=timeout", a?.status, "timeout");
    eq("E：超时审计 ran=true", a?.ran, true);
    eq("E：超时审计 matched=false", a?.matched, false);
  } finally {
    to.cleanup();
  }

  // ---- 7. 输出上限：stdout/stderr 各 1MB（用小上限验证截断逻辑）----
  const cap = makeEvidenceHarness(
    "e-cap",
    new EvidenceReplayer({
      enabled: true,
      policy: () => policy,
      approval: () => approval,
      maxOutputBytes: 1024,
    }),
  );
  try {
    eq(
      "E：stdout 超过上限截断后 flag 不可见 → E1",
      await cap.submit(
        E_FLAG,
        `cmd:${nodeCommand(`process.stdout.write('A'.repeat(2000) + '${E_FLAG}', () => {})`)}`,
      ),
      "E1",
    );
    const a = replayAudits(cap.board).at(-1);
    eq("E：stdout 截断标记", a?.stdoutTruncated, true);
    eq("E：stdout 保留 1024B", a?.stdoutBytes, 1024);
    eq("E：stdout 截断后 matched=false", a?.matched, false);

    eq(
      "E：stderr 超限但 stdout 命中 → E2",
      await cap.submit(
        E_FLAG,
        `cmd:${nodeCommand(`process.stderr.write('B'.repeat(2000)); console.log('${E_FLAG}')`)}`,
      ),
      "E2",
    );
    const a2 = replayAudits(cap.board).at(-1);
    eq("E：stderr 截断标记", a2?.stderrTruncated, true);
    eq("E：stderr 保留 1024B", a2?.stderrBytes, 1024);
    eq("E：stderr 截断不影响 stdout 命中", a2?.matched, true);
  } finally {
    cap.cleanup();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  buildFixture();
  const parts: Array<[string, () => Promise<void>]> = [
    ["A", partA],
    ["B", partB],
    ["C", partC],
    ["D", partD],
    ["E", partE],
  ];
  for (const [label, part] of parts) {
    try {
      await part();
    } catch (err) {
      check(`${label} 组崩溃`, false, (err as Error).message);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n================ ${results.length - failed.length}/${results.length} 通过 ================`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("verify:artifacts 崩溃：", err);
  process.exitCode = 1;
});
