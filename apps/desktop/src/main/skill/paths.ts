/**
 * 技能库路径安全边界（P2-A）。
 *
 * 所有读技能文件的操作都必须先过这里：根目录用 realpath，目标用 realpath 复核，
 * 拒绝 `..` / 绝对路径 / 盘符 / NUL / symlink/junction 逃逸 / 非白名单扩展名 / 超大文件。
 *
 * 这里不读内容、不扫描目录（索引在 index.ts，懒构建）。
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** skill_read 的单文件上限（256KB）。 */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** 技能文件默认扩展名白名单；具体工具可以再收窄。 */
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [".md", ".json", ".jsonl", ".py"];

export type SkillPathErrorCode =
  | "empty"
  | "nul"
  | "absolute"
  | "drive"
  | "traversal"
  | "escape"
  | "extension"
  | "size"
  | "missing"
  | "not-file";

export class SkillPathError extends Error {
  readonly code: SkillPathErrorCode;

  constructor(code: SkillPathErrorCode, message: string) {
    super(message);
    this.name = "SkillPathError";
    this.code = code;
  }
}

export interface ResolveWithinRootOptions {
  /** 允许的扩展名；不传则不检查（索引扫描用）。 */
  allowedExtensions?: readonly string[];
  /** 文件大小上限；超过即拒绝。 */
  maxBytes?: number;
  /** 是否要求目标存在（默认 true）。 */
  mustExist?: boolean;
}

function allowedExtension(file: string, allowed: readonly string[]): boolean {
  return allowed.includes(path.extname(file).toLowerCase());
}

function firstSegmentIsParent(rel: string): boolean {
  return rel.split(path.sep)[0] === ".." || path.isAbsolute(rel);
}

/**
 * 只做语法层检查：不碰文件系统。
 * 拒绝空路径、NUL、盘符、绝对路径、UNC、`.`/`..`/空段。
 */
export function assertSafeRelativePath(relativePath: unknown): string {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new SkillPathError("empty", "技能文件路径不能为空");
  }
  if (relativePath.includes("\0")) {
    throw new SkillPathError("nul", "技能文件路径不能包含 NUL");
  }
  // Windows 盘符（C:、D:）即使不是 path.isAbsolute 也要拒绝。
  if (/^[A-Za-z]:/.test(relativePath)) {
    throw new SkillPathError("drive", `拒绝盘符路径：${relativePath}`);
  }
  // UNC / 协议相对路径。
  if (relativePath.startsWith("\\\\") || relativePath.startsWith("//")) {
    throw new SkillPathError("absolute", `拒绝绝对路径：${relativePath}`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new SkillPathError("absolute", `拒绝绝对路径：${relativePath}`);
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SkillPathError("traversal", `拒绝包含空段/./.. 的路径：${relativePath}`);
  }
  return relativePath;
}

/**
 * 把技能根内的相对路径解析成真实绝对路径。
 *
 * - 根目录不存在 → missing
 * - 语法越界 → traversal/absolute/drive/nul
 * - 目标 realpath 跑出根目录（symlink/junction）→ escape
 * - 扩展名/大小不合规 → extension/size
 */
export function resolveWithinRoot(
  root: string,
  relativePath: string,
  opts: ResolveWithinRootOptions = {},
): string {
  assertSafeRelativePath(relativePath);

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new SkillPathError("missing", `技能库根目录不存在：${root}`);
  }

  const target = path.resolve(rootReal, ...relativePath.split(/[\\/]+/));
  const rel = path.relative(rootReal, target);
  if (!rel || firstSegmentIsParent(rel)) {
    throw new SkillPathError("escape", `路径越界：${relativePath}`);
  }

  if (opts.allowedExtensions && !allowedExtension(target, opts.allowedExtensions)) {
    throw new SkillPathError(
      "extension",
      `不允许的扩展名：${path.extname(target) || "(无)"}（${relativePath}）`,
    );
  }

  if (opts.mustExist === false) return target;

  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    throw new SkillPathError("missing", `技能文件不存在：${relativePath}`);
  }

  // 关键：realpath 之后再看一次是否仍在根内。junction/symlink 指到根外时在这里被拒。
  const realRel = path.relative(rootReal, realTarget);
  if (!realRel || firstSegmentIsParent(realRel)) {
    throw new SkillPathError("escape", `路径经符号链接/junction 越界：${relativePath}`);
  }

  // 扩展名按真实目标再检查一次，避免 `.md` 符号链接指向 `.exe` 这类绕过。
  if (opts.allowedExtensions && !allowedExtension(realTarget, opts.allowedExtensions)) {
    throw new SkillPathError(
      "extension",
      `目标真实扩展名不在白名单：${path.extname(realTarget) || "(无)"}（${relativePath}）`,
    );
  }

  const st = statSync(realTarget);
  if (!st.isFile()) {
    throw new SkillPathError("not-file", `不是普通文件：${relativePath}`);
  }
  if (opts.maxBytes !== undefined && st.size > opts.maxBytes) {
    throw new SkillPathError(
      "size",
      `文件超过大小上限 ${opts.maxBytes} 字节：${relativePath}（${st.size}）`,
    );
  }
  return realTarget;
}

/** 布尔版本，供调用方做快速判定；不吞掉错误类型（需要原因时用 resolveWithinRoot）。 */
export function isSafePath(
  root: string,
  relativePath: string,
  opts: ResolveWithinRootOptions = {},
): boolean {
  try {
    resolveWithinRoot(root, relativePath, opts);
    return true;
  } catch {
    return false;
  }
}
