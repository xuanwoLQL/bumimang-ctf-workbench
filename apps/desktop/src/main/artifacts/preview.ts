/**
 * P3-A 附件预览 —— 纯读取，不执行、不渲染。
 *
 * 安全边界：
 *  - 所有路径先做语法校验（NUL、绝对路径、盘符、`..`、Windows 非法字符），
 *    再 realpath 复核在任务目录内；路径上任何一段是 symlink/junction 都拒绝。
 *  - 文本按 UTF-8 返回，**HTML/SVG 也只当文本**，交给渲染层用文本节点显示（P3-C）。
 *  - 图片只认 PNG/JPEG/GIF/WebP/BMP 的魔数，返回 data URL；不认 SVG。
 *  - 二进制返回 hex dump；超过上限截断并标记，不做部分解码。
 *  - 不 import child_process / shell / openPath；没有“系统打开”的实现，只有一个
 *    供渲染层参考的白名单判断（可执行/脚本/HTML 一律 false）。
 *
 * 本文件同时提供 import.ts / zip.ts / scan.ts 复用的相对路径校验。
 */

import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ArtifactPathErrorCode =
  | "empty"
  | "nul"
  | "absolute"
  | "drive"
  | "escape"
  | "symlink"
  | "missing"
  | "invalid"
  | "too-long";

export class ArtifactPathError extends Error {
  code: ArtifactPathErrorCode;

  constructor(code: ArtifactPathErrorCode, message: string) {
    super(message);
    this.name = "ArtifactPathError";
    this.code = code;
  }
}

export const PREVIEW_LIMITS = {
  /** 文本最多读 256KB */
  textBytes: 256 * 1024,
  /** 图片最多 2MB（base64 后约 2.7MB 字符串） */
  imageBytes: 2 * 1024 * 1024,
  /** 二进制 hex 最多 4KB 原始字节 */
  hexBytes: 4 * 1024,
} as const;

export interface PreviewLimits {
  textBytes: number;
  imageBytes: number;
  hexBytes: number;
}

export type PreviewKind = "text" | "image" | "hex" | "unsupported";

export interface PreviewResult {
  kind: PreviewKind;
  /** 文本内容 / hex dump / unsupported 的可读说明 */
  content?: string;
  /** 图片 data URL（仅 kind=image） */
  dataUrl?: string;
  /** 是否因为大小上限被截断 */
  truncated?: boolean;
  /** 文件原始大小 */
  totalBytes?: number;
  /** 图片的 MIME（仅 kind=image） */
  mime?: string;
}

const MAX_REL_PATH = 1024;
const MAX_SEGMENT = 255;

/** Windows 上会改变语义或不允许的字符（含控制字符）。冒号同时挡掉 NTFS ADS。 */
const INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED_DOS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 校验并归一化任务内的 POSIX 相对路径。
 *
 * 反斜杠一律当分隔符处理（Windows 上 `..\..\x` 不能因为只按 `/` 切分而漏过）。
 * 拒绝：空路径、NUL、绝对路径、盘符、UNC、`..`/`.`、空段、Windows 非法字符、
 * 结尾空格/点、DOS 设备名、超长。
 */
export function normalizeRelativePath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ArtifactPathError("invalid", "路径必须是字符串");
  }
  if (raw.length === 0) throw new ArtifactPathError("empty", "路径不能为空");
  if (raw.length > MAX_REL_PATH) {
    throw new ArtifactPathError("too-long", `路径过长（>${MAX_REL_PATH}）`);
  }
  if (raw.includes("\0")) throw new ArtifactPathError("nul", "路径包含 NUL 字符");

  const text = raw.replace(/\\/g, "/");
  if (text.startsWith("/")) {
    throw new ArtifactPathError("absolute", "拒绝绝对路径");
  }
  if (/^[A-Za-z]:/.test(text)) {
    throw new ArtifactPathError("drive", "拒绝盘符路径");
  }

  const segments = text.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ArtifactPathError("escape", `拒绝路径段：${JSON.stringify(seg)}`);
    }
    if (seg.length > MAX_SEGMENT) {
      throw new ArtifactPathError("too-long", `路径段过长（>${MAX_SEGMENT}）：${seg.slice(0, 32)}…`);
    }
    if (INVALID_SEGMENT_CHARS.test(seg)) {
      throw new ArtifactPathError("invalid", `路径段含 Windows 非法字符：${JSON.stringify(seg)}`);
    }
    if (/[ .]$/.test(seg)) {
      throw new ArtifactPathError("invalid", `路径段不能以空格或点结尾：${JSON.stringify(seg)}`);
    }
    if (RESERVED_DOS_NAME.test(seg)) {
      throw new ArtifactPathError("invalid", `拒绝 Windows 设备名：${JSON.stringify(seg)}`);
    }
  }
  return segments.join("/");
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * 把任务相对路径解析成真实绝对路径；越界、symlink/junction、缺失都会抛错。
 *
 * `taskDir` 必须是已存在的任务目录；返回的路径已 realpath，且路径上每一段
 * 都不是 symlink/junction（即使它指向任务目录内部也拒绝，避免后续 TOCTOU）。
 */
export function resolveWithinTask(taskDir: string, rawPath: unknown): string {
  const relPosix = normalizeRelativePath(rawPath);

  let root: string;
  try {
    root = realpathSync(taskDir);
  } catch {
    throw new ArtifactPathError("missing", `任务目录不存在：${taskDir}`);
  }

  const candidate = resolve(root, ...relPosix.split("/"));
  if (isOutside(root, candidate)) {
    throw new ArtifactPathError("escape", `路径逃出任务目录：${relPosix}`);
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ArtifactPathError("missing", `文件不存在：${relPosix}`);
  }
  if (isOutside(root, real)) {
    throw new ArtifactPathError("escape", `路径（realpath）逃出任务目录：${relPosix}`);
  }

  // 逐段 lstat：junction 在 lstat 里表现为 symlink（Windows 实测）。
  let cursor = root;
  for (const seg of relPosix.split("/")) {
    cursor = join(cursor, seg);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      throw new ArtifactPathError("missing", `文件不存在：${relPosix}`);
    }
    if (st.isSymbolicLink()) {
      throw new ArtifactPathError("symlink", `拒绝 symlink/junction：${relPosix}`);
    }
  }
  return real;
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "java",
  "go",
  "rs",
  "rb",
  "php",
  "yaml",
  "yml",
  "ini",
  "conf",
  "cfg",
  "toml",
  "csv",
  "tsv",
  "sql",
  "pem",
  "env",
  "gitignore",
]);

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const CONTENT_TYPES: Record<string, string> = {
  ...IMAGE_MIME,
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  log: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  ps1: "text/plain",
  bat: "text/plain",
  cmd: "text/plain",
  c: "text/x-c",
  h: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  java: "text/x-java",
  go: "text/x-go",
  rs: "text/x-rust",
  rb: "text/x-ruby",
  php: "text/x-php",
  yaml: "application/yaml",
  yml: "application/yaml",
  ini: "text/plain",
  conf: "text/plain",
  cfg: "text/plain",
  toml: "application/toml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  sql: "application/sql",
  pem: "application/x-pem-file",
  pdf: "application/pdf",
  zip: "application/zip",
};

/** 按扩展名给出 MIME（清单里的 `type` 字段）；未知一律 application/octet-stream。 */
export function contentTypeForPath(relativePath: string): string {
  const ext = extname(relativePath).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** 粗略判断一段字节是否像文本：无 NUL、控制字符少、UTF-8 可解码。 */
export function looksLikeTextBytes(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  let control = 0;
  for (const b of buf) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  if (control / buf.length > 0.05) return false;
  // 4KB 采样可能正好切在多字节 UTF-8 字符中间：允许去掉末尾 1–3 字节再试。
  for (let cut = 0; cut <= 3 && cut < buf.length; cut++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, buf.length - cut));
      return true;
    } catch {
      /* 继续尝试缩短尾部 */
    }
  }
  return false;
}

function readPrefix(file: string, maxBytes: number): Buffer {
  const size = statSync(file).size;
  const len = Math.min(size, maxBytes);
  if (len <= 0) return Buffer.alloc(0);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, off);
      if (n <= 0) break;
      off += n;
    }
    return off === len ? buf : buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

function imageMimeIfValid(ext: string, head: Buffer): string | null {
  if (ext === "png") {
    return head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
      ? IMAGE_MIME.png
      : null;
  }
  if (ext === "jpg" || ext === "jpeg") {
    return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      ? IMAGE_MIME.jpg
      : null;
  }
  if (ext === "gif") {
    const sig = head.subarray(0, 6).toString("ascii");
    return sig === "GIF87a" || sig === "GIF89a" ? IMAGE_MIME.gif : null;
  }
  if (ext === "webp") {
    return head.length >= 12 &&
      head.subarray(0, 4).toString("ascii") === "RIFF" &&
      head.subarray(8, 12).toString("ascii") === "WEBP"
      ? IMAGE_MIME.webp
      : null;
  }
  if (ext === "bmp") {
    return head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d ? IMAGE_MIME.bmp : null;
  }
  return null;
}

function hexDump(buf: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < buf.length; offset += 16) {
    const slice = buf.subarray(offset, offset + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  return lines.join("\n");
}

/**
 * 预览一个任务内附件。
 *
 * 只读：不会执行、不会写入、不会 openPath。路径越界或 symlink/junction 会抛
 * `ArtifactPathError`。目录 / 超大图片返回 `unsupported`（超大图片带 truncated）。
 */
export function previewAttachment(input: {
  taskDir: string;
  relativePath: string;
  limits?: Partial<PreviewLimits>;
}): PreviewResult {
  const limits: PreviewLimits = { ...PREVIEW_LIMITS, ...(input.limits ?? {}) };
  const real = resolveWithinTask(input.taskDir, input.relativePath);
  const st = statSync(real);
  if (!st.isFile()) {
    return { kind: "unsupported", content: "只能预览普通文件", totalBytes: st.size };
  }
  const size = st.size;
  const rel = normalizeRelativePath(input.relativePath);
  const ext = extname(rel).slice(1).toLowerCase();

  // 图片：先看大小，再看魔数；魔数不符不按图片返回（避免 content-type 混淆）。
  if (IMAGE_MIME[ext]) {
    if (size > limits.imageBytes) {
      return {
        kind: "unsupported",
        truncated: true,
        totalBytes: size,
        content: `图片超过预览上限（${limits.imageBytes} 字节），未生成 data URL`,
      };
    }
    const whole = readPrefix(real, size);
    const mime = imageMimeIfValid(ext, whole.subarray(0, 16));
    if (mime) {
      return {
        kind: "image",
        mime,
        dataUrl: `data:${mime};base64,${whole.toString("base64")}`,
        truncated: false,
        totalBytes: size,
      };
    }
    // 魔数不符：继续按文本/hex 判断，绝不返回 image。
  }

  let textLike = false;
  if (TEXT_EXTENSIONS.has(ext)) {
    // 文本扩展名仍要先看前 4KB：`.txt` 里塞二进制（含 NUL）时走 hex，不按文本渲染。
    const head = readPrefix(real, Math.min(size, 4096));
    textLike = !head.includes(0);
  } else if (!IMAGE_MIME[ext]) {
    const head = readPrefix(real, Math.min(size, 4096));
    textLike = looksLikeTextBytes(head);
  }

  if (textLike) {
    const buf = readPrefix(real, Math.min(size, limits.textBytes));
    return {
      kind: "text",
      content: buf.toString("utf8"),
      truncated: size > limits.textBytes,
      totalBytes: size,
    };
  }

  const buf = readPrefix(real, Math.min(size, limits.hexBytes));
  return {
    kind: "hex",
    content: hexDump(buf),
    truncated: size > limits.hexBytes,
    totalBytes: size,
  };
}

/** 允许“系统打开”的扩展名（P3-C 渲染层用；P3-A 只提供判断，不实现打开）。 */
const SYSTEM_OPEN_ALLOWED = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
]);

/**
 * 可执行/脚本/HTML/快捷方式一律 false（fail-closed）。
 *
 * P3-A 不调用系统打开；这个函数只是把“哪些扩展名可以交给系统打开”固化成
 * 可测试的规则，P3-C 的 UI 必须走它。
 */
export function isSystemOpenAllowed(relativePath: string): boolean {
  const ext = extname(relativePath).slice(1).toLowerCase();
  return SYSTEM_OPEN_ALLOWED.has(ext);
}
