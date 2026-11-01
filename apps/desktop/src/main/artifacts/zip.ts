/**
 * P3-A 最小 ZIP 解析 —— 只支持 store(0) / deflate(8)。
 *
 * 安全策略（全部在真正解压之前完成，失败不写任何目标文件）：
 *  - 拒绝加密（GPB bit0 / bit6 / bit13）、ZIP64（EOCD/中央目录/本地头任一迹象）；
 *  - 拒绝多卷、未知压缩方法、损坏的中央目录、CRC 不匹配；
 *  - 拒绝绝对路径、盘符、`..`、NUL、反斜杠逃逸、Windows 非法字符/设备名；
 *  - 拒绝 symlink（Unix mode S_IFLNK）、Windows reparse point、其它特殊文件模式。
 *    ZIP 没有标准 hardlink 条目；本实现从不调用 link()，所有条目都按普通文件写出，
 *    因此即使外部把硬链接塞进 ZIP，也只会得到一份普通文件拷贝，不会产生硬链接。
 *  - 解压由调用方给一个临时目录；失败由调用方清理。
 *
 * 不用外部 unzip、不 shell out；只用 node:zlib 的 inflateRaw + 流式读写。
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { normalizeRelativePath } from "./preview.ts";

export type ZipErrorCode =
  | "bad-signature"
  | "zip64"
  | "encrypted"
  | "method"
  | "multi-disk"
  | "path"
  | "symlink"
  | "duplicate"
  | "limit"
  | "empty"
  | "corrupt"
  | "crc"
  | "io";

export class ZipError extends Error {
  code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export interface ZipFileInfo {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface ZipInspection {
  files: Array<{ relativePath: string; size: number }>;
  fileCount: number;
  totalBytes: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_CENTRAL_ENTRIES = 5000;
/** 中央目录常驻内存，必须有硬上限（恶意 zip 可以把 cdSize 写成几 GB）。 */
const MAX_CD_BYTES = 16 * 1024 * 1024;

interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: 0 | 8;
  flags: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  dataStart: number;
}

// CRC-32（IEEE 802.3），用于校验 ZIP 条目内容。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, buf: Buffer): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function crc32Of(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

async function readExact(
  fh: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead <= 0) break;
    off += bytesRead;
  }
  if (off !== length) throw new ZipError("corrupt", "ZIP 文件被截断");
  return buf;
}

function hasZip64Extra(extra: Buffer): boolean {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) throw new ZipError("corrupt", "ZIP extra 字段长度越界");
    if (id === 0x0001) return true;
    p += 4 + len;
  }
  return false;
}

function decodeName(nameBuf: Buffer): string {
  // UTF-8 标志位（bit 11）之外仍按 UTF-8 解码：Windows 资源管理器/zips 通常写 UTF-8；
  // CP437 非 ASCII 名极少见，解码失败时会被路径校验挡下，不会静默写错文件。
  return nameBuf.toString("utf8");
}

function validateEntryName(rawName: string, flags: number): { name: string; isDirectory: boolean } {
  if (rawName.includes("\0")) throw new ZipError("path", "ZIP 条目名包含 NUL");
  let text = rawName.replace(/\\/g, "/");
  let isDirectory = false;
  while (text.endsWith("/")) {
    isDirectory = true;
    text = text.slice(0, -1);
  }
  if (!text) throw new ZipError("path", "ZIP 条目名为空");
  try {
    return { name: normalizeRelativePath(text), isDirectory };
  } catch (err) {
    throw new ZipError("path", `ZIP 条目路径非法：${JSON.stringify(rawName)}（${(err as Error).message}）`);
  }
}

function validateLinkAttributes(versionMadeBy: number, externalAttrs: number): void {
  // Windows DOS 属性里的 reparse point（junction/symlink）一律拒绝。
  if ((externalAttrs & 0x0400) !== 0) {
    throw new ZipError("symlink", "ZIP 含 Windows reparse point（symlink/junction），拒绝解压");
  }
  const os = (versionMadeBy >> 8) & 0xff;
  if (os !== 3 && os !== 19) return; // 3=Unix, 19=OS X
  const mode = (externalAttrs >>> 16) & 0xffff;
  if (mode === 0) return;
  const type = mode & 0xf000;
  if (type === 0xa000) throw new ZipError("symlink", "ZIP 含 symlink 条目，拒绝解压");
  if (type !== 0 && type !== 0x8000 && type !== 0x4000) {
    throw new ZipError("symlink", "ZIP 含特殊文件条目（设备/FIFO/socket 等），拒绝解压");
  }
}

function parseEntryConflicts(entries: ZipEntry[]): void {
  // Windows 文件系统大小写不敏感：同名（忽略大小写）与“文件/目录同路径”都拒绝。
  const types = new Map<string, "file" | "dir">();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    if (types.has(key)) {
      throw new ZipError("duplicate", `ZIP 条目重复（忽略大小写）：${e.name}`);
    }
    types.set(key, e.isDirectory ? "dir" : "file");
  }
  for (const e of entries) {
    if (e.isDirectory) continue;
    const parts = e.name.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (types.get(prefix.toLowerCase()) === "file") {
        throw new ZipError("duplicate", `ZIP 条目路径冲突（文件同时被当作目录）：${prefix}`);
      }
    }
  }
}

async function readZipEntries(zipPath: string): Promise<{ entries: ZipEntry[]; size: number }> {
  const st = await stat(zipPath);
  if (!st.isFile()) throw new ZipError("io", `不是普通文件：${zipPath}`);
  const size = st.size;
  if (size < 22) throw new ZipError("corrupt", "ZIP 文件过短");

  const fh = await open(zipPath, "r");
  try {
    const tailLen = Math.min(size, 22 + 0xffff);
    const tailStart = size - tailLen;
    const tail = await readExact(fh, tailStart, tailLen);

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos < 0) throw new ZipError("bad-signature", "找不到 ZIP EOCD（不是有效 ZIP）");

    const diskNumber = tail.readUInt16LE(eocdPos + 4);
    const cdStartDisk = tail.readUInt16LE(eocdPos + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdPos + 8);
    const totalEntries = tail.readUInt16LE(eocdPos + 10);
    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);
    const commentLen = tail.readUInt16LE(eocdPos + 20);

    if (eocdPos + 22 + commentLen > tail.length) {
      throw new ZipError("corrupt", "ZIP EOCD 注释长度不匹配");
    }
    if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new ZipError("multi-disk", "拒绝多卷 ZIP");
    }
    if (
      totalEntries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      throw new ZipError("zip64", "拒绝 ZIP64（EOCD 出现 ZIP64 哨兵值）");
    }

    const eocdAbs = tailStart + eocdPos;
    if (eocdAbs >= 20) {
      const locator = await readExact(fh, eocdAbs - 20, 4);
      if (locator.readUInt32LE(0) === ZIP64_LOCATOR_SIG) {
        throw new ZipError("zip64", "拒绝 ZIP64（存在 ZIP64 EOCD Locator）");
      }
    }
    if (totalEntries > MAX_CENTRAL_ENTRIES) {
      throw new ZipError("limit", `ZIP 条目过多（>${MAX_CENTRAL_ENTRIES}）`);
    }
    if (cdSize > MAX_CD_BYTES) {
      throw new ZipError("limit", `ZIP 中央目录过大（>${MAX_CD_BYTES} 字节）`);
    }
    if (totalEntries === 0) throw new ZipError("empty", "ZIP 内没有文件");
    if (cdOffset + cdSize > eocdAbs) throw new ZipError("corrupt", "ZIP 中央目录越界");

    const cd = await readExact(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (cursor + 46 > cd.length) throw new ZipError("corrupt", "ZIP 中央目录被截断");
      if (cd.readUInt32LE(cursor) !== CENTRAL_SIG) {
        throw new ZipError("bad-signature", "ZIP 中央目录签名错误");
      }
      const versionMadeBy = cd.readUInt16LE(cursor + 4);
      const versionNeeded = cd.readUInt16LE(cursor + 6);
      const flags = cd.readUInt16LE(cursor + 8);
      const method = cd.readUInt16LE(cursor + 10);
      const crc32 = cd.readUInt32LE(cursor + 16);
      const compSize = cd.readUInt32LE(cursor + 20);
      const uncompSize = cd.readUInt32LE(cursor + 24);
      const nameLen = cd.readUInt16LE(cursor + 28);
      const extraLen = cd.readUInt16LE(cursor + 30);
      const commentLenC = cd.readUInt16LE(cursor + 32);
      const diskStart = cd.readUInt16LE(cursor + 34);
      const externalAttrs = cd.readUInt32LE(cursor + 38);
      const localOffset = cd.readUInt32LE(cursor + 42);
      const entryLen = 46 + nameLen + extraLen + commentLenC;
      if (cursor + entryLen > cd.length) throw new ZipError("corrupt", "ZIP 中央目录条目越界");

      if (versionNeeded >= 45) throw new ZipError("zip64", "拒绝 ZIP64（版本需求 >= 45）");
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new ZipError("zip64", "拒绝 ZIP64（条目出现 ZIP64 哨兵值）");
      }
      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
        throw new ZipError("encrypted", "拒绝加密 ZIP 条目");
      }
      if ((flags & 0x0020) !== 0) throw new ZipError("method", "拒绝 patched-data ZIP 条目");
      if (method !== 0 && method !== 8) {
        throw new ZipError("method", `不支持的 ZIP 压缩方法：${method}（仅 store/deflate）`);
      }
      if (diskStart !== 0) throw new ZipError("multi-disk", "拒绝多卷 ZIP 条目");

      const nameBuf = cd.subarray(cursor + 46, cursor + 46 + nameLen);
      if (nameBuf.includes(0)) throw new ZipError("path", "ZIP 条目名包含 NUL");
      const extra = cd.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
      if (hasZip64Extra(extra)) throw new ZipError("zip64", "拒绝 ZIP64（中央目录 extra 0x0001）");

      const { name, isDirectory } = validateEntryName(decodeName(nameBuf), flags);
      validateLinkAttributes(versionMadeBy, externalAttrs);
      if (isDirectory && (compSize !== 0 || uncompSize !== 0)) {
        throw new ZipError("corrupt", `ZIP 目录条目带数据：${name}`);
      }
      if (method === 0 && !isDirectory && compSize !== uncompSize) {
        throw new ZipError("corrupt", `store 条目压缩/原始大小不一致：${name}`);
      }

      // 本地头：校验签名、方法、加密位、ZIP64 迹象与数据范围。
      if (localOffset + 30 > size) throw new ZipError("corrupt", "ZIP 本地头越界");
      const local = await readExact(fh, localOffset, 30);
      if (local.readUInt32LE(0) !== LOCAL_SIG) {
        throw new ZipError("bad-signature", "ZIP 本地头签名错误");
      }
      const localVersion = local.readUInt16LE(4);
      const localFlags = local.readUInt16LE(6);
      const localMethod = local.readUInt16LE(8);
      const localNameLen = local.readUInt16LE(26);
      const localExtraLen = local.readUInt16LE(28);
      if (localVersion >= 45) throw new ZipError("zip64", "拒绝 ZIP64（本地头版本 >= 45）");
      if ((localFlags & 0x0001) !== 0 || (localFlags & 0x0040) !== 0 || (localFlags & 0x2000) !== 0) {
        throw new ZipError("encrypted", "拒绝加密 ZIP 条目（本地头）");
      }
      if (localMethod !== method) throw new ZipError("corrupt", "ZIP 本地头/中央目录方法不一致");
      if (localOffset + 30 + localNameLen + localExtraLen > size) {
        throw new ZipError("corrupt", "ZIP 本地头名字/extra 越界");
      }
      if (localExtraLen > 0) {
        const localExtra = await readExact(fh, localOffset + 30 + localNameLen, localExtraLen);
        if (hasZip64Extra(localExtra)) throw new ZipError("zip64", "拒绝 ZIP64（本地头 extra 0x0001）");
      }
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      if (dataStart + compSize > size) throw new ZipError("corrupt", "ZIP 条目数据越界");

      entries.push({
        name,
        isDirectory,
        method: method as 0 | 8,
        flags,
        crc32,
        compSize,
        uncompSize,
        localOffset,
        dataStart,
      });
      cursor += entryLen;
    }

    parseEntryConflicts(entries);
    return { entries, size };
  } finally {
    await fh.close();
  }
}

function enforceLimits(entries: ZipEntry[], limits: ZipLimits): ZipInspection {
  let fileCount = 0;
  let totalBytes = 0;
  const files: Array<{ relativePath: string; size: number }> = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (e.compSize > limits.maxTotalBytes) {
      throw new ZipError("limit", `ZIP 条目的压缩数据超过大小上限：${e.name}`);
    }
    fileCount++;
    totalBytes += e.uncompSize;
    files.push({ relativePath: e.name, size: e.uncompSize });
  }
  if (fileCount === 0) throw new ZipError("empty", "ZIP 内没有文件");
  if (fileCount > limits.maxFiles) {
    throw new ZipError("limit", `ZIP 文件数超限（${fileCount}/${limits.maxFiles}）`);
  }
  if (totalBytes > limits.maxTotalBytes) {
    throw new ZipError("limit", `ZIP 解压后总大小超限（${totalBytes}/${limits.maxTotalBytes} 字节）`);
  }
  return { files, fileCount, totalBytes };
}

/**
 * 只解析中央目录并做安全/上限校验，不解压、不写盘。
 * 导入层用它做“先校验、后写入”的预检。
 */
export async function inspectZip(zipPath: string, limits: ZipLimits): Promise<ZipInspection> {
  const { entries } = await readZipEntries(zipPath);
  return enforceLimits(entries, limits);
}

async function extractOne(
  zipPath: string,
  entry: ZipEntry,
  target: string,
): Promise<{ size: number; sha256: string }> {
  await mkdir(dirname(target), { recursive: true });

  if (entry.uncompSize === 0) {
    await writeFile(target, Buffer.alloc(0), { flag: "wx" });
    if (entry.crc32 !== 0) throw new ZipError("crc", `ZIP 条目 CRC 不匹配（空文件）：${entry.name}`);
    return { size: 0, sha256: createHash("sha256").digest("hex") };
  }

  const hash = createHash("sha256");
  let bytes = 0;
  let crc = 0xffffffff;

  const source = createReadStream(zipPath, {
    start: entry.dataStart,
    end: entry.dataStart + entry.compSize - 1,
    highWaterMark: 64 * 1024,
  });
  const decoder = entry.method === 8 ? createInflateRaw() : new PassThrough();
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > entry.uncompSize) {
        cb(new ZipError("limit", `ZIP 条目实际大小超过声明值：${entry.name}`));
        return;
      }
      hash.update(chunk);
      crc = crc32Update(crc, chunk);
      cb(null, chunk);
    },
  });
  const sink = createWriteStream(target, { flags: "wx" });

  try {
    await pipeline(source, decoder, meter, sink);
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError("corrupt", `ZIP 解压失败：${entry.name}（${(err as Error).message}）`);
  }

  if (bytes !== entry.uncompSize) {
    throw new ZipError("corrupt", `ZIP 条目长度不匹配：${entry.name}`);
  }
  const actualCrc = (crc ^ 0xffffffff) >>> 0;
  if (actualCrc !== entry.crc32) {
    throw new ZipError("crc", `ZIP 条目 CRC 不匹配：${entry.name}`);
  }
  return { size: bytes, sha256: hash.digest("hex") };
}

/**
 * 解压到调用方给的临时目录；返回**文件**条目（路径 / 大小 / sha256）。
 * 目录条目也会建出来（保留空目录），但不计入文件数。
 * 任何失败都会抛出 ZipError；临时目录由调用方清理。
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ZipLimits,
): Promise<ZipFileInfo[]> {
  const { entries } = await readZipEntries(zipPath);
  enforceLimits(entries, limits);
  await mkdir(destDir, { recursive: true });

  const out: ZipFileInfo[] = [];
  for (const entry of entries) {
    const target = join(destDir, ...entry.name.split("/"));
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const info = await extractOne(zipPath, entry, target);
    out.push({ relativePath: entry.name, size: info.size, sha256: info.sha256 });
  }
  return out;
}

/** 测试/诊断用：计算一段 Buffer 的 ZIP CRC-32。 */
export function zipCrc32(buf: Buffer): number {
  return crc32Of(buf);
}
