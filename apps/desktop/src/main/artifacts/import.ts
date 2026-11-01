/**
 * P3-A 附件导入 —— 文件 / 文件夹 / zip 落盘到 `<workRoot>/<taskId>/attachments/`。
 *
 * 行为约定（本轮）：
 *  - 一次动作只允许一种来源类型（全是文件、全是文件夹、或全是 zip），混合直接报错；
 *  - 单任务合计上限 200MB / 1000 个文件（可用 limits 覆盖，测试用）；
 *  - 先完整预检（路径、类型、大小、数量、重名），再解压/复制到
 *    `attachments/.import-<ts>-<rand>/`，全部成功后才 rename 到最终位置；
 *    任何失败都清理临时目录与本次已 rename 的产物，不写半份清单；
 *  - 文件内容流式复制 + 流式 sha256，不把大文件整个读进内存；
 *  - 清单 `attachments.json` 最后原子写入（临时文件 + rename）。
 *
 * 不执行、不预览任何附件；预览在 preview.ts，扫描在 scan.ts（P3-B 才接 Hub）。
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { AttachmentView } from "../../../../../packages/shared-protocol/events.ts";
import {
  ArtifactPathError,
  contentTypeForPath,
  normalizeRelativePath,
} from "./preview.ts";
import { extractZip, inspectZip, ZipError } from "./zip.ts";

export const ATTACHMENT_LIMITS = {
  maxTotalBytes: 200 * 1024 * 1024,
  maxFiles: 1000,
} as const;

/** 一次动作最多导入多少个源路径（防止 UI/脚本一次塞几千个）。 */
export const MAX_IMPORT_PATHS = 100;

export interface ImportLimits {
  maxTotalBytes: number;
  maxFiles: number;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  /** 本次新增的附件（不含导入前已有的） */
  imported?: AttachmentView[];
  /** 导入完成后该任务的附件总数 */
  taskFileCount?: number;
  /** 导入完成后该任务的附件总字节数 */
  taskTotalBytes?: number;
}

interface SourcePlan {
  kind: "file" | "dir" | "zip";
  abs: string;
  top: string;
  /** file: [单文件]；dir: 递归文件；zip: 中央目录文件 */
  files: Array<{ abs?: string; rel: string; size: number; sha256?: string }>;
  totalBytes: number;
}

const MANIFEST_NAME = "attachments.json";

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(() => gate);
  locks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ArtifactPathError || err instanceof ZipError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAttachmentView(v: unknown): v is AttachmentView {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.name === "string" &&
    typeof a.relativePath === "string" &&
    typeof a.size === "number" &&
    typeof a.sha256 === "string" &&
    typeof a.type === "string" &&
    typeof a.source === "string" &&
    typeof a.importedAt === "number"
  );
}

/** 安全读清单：文件缺失/损坏都返回 []，供快照使用（不能因为清单坏了就白屏）。 */
export function readAttachments(taskDir: string): AttachmentView[] {
  const manifest = join(taskDir, "attachments", MANIFEST_NAME);
  if (!existsSync(manifest)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      version?: unknown;
      files?: unknown;
    };
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return [];
    // 只暴露路径合法的条目；损坏条目不能把 ../ 之类带进快照/预览入口。
    return parsed.files.filter(isAttachmentView).filter((f) => {
      try {
        return normalizeRelativePath(f.relativePath) === f.relativePath;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** 导入路径用：清单存在但结构不对时拒绝覆盖。 */
function readManifestStrict(taskDir: string, taskId: string): AttachmentView[] {
  const manifest = join(taskDir, "attachments", MANIFEST_NAME);
  if (!existsSync(manifest)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    throw new Error(`${MANIFEST_NAME} 损坏，拒绝覆盖；请先人工修复或删除`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${MANIFEST_NAME} 结构非法，拒绝覆盖`);
  }
  const m = parsed as { version?: unknown; taskId?: unknown; files?: unknown };
  if (m.version !== 1 || !Array.isArray(m.files)) {
    throw new Error(`${MANIFEST_NAME} 版本/结构非法（需要 version=1 与 files 数组）`);
  }
  if (typeof m.taskId === "string" && m.taskId !== taskId) {
    throw new Error(`${MANIFEST_NAME} 属于另一个任务（${m.taskId}），拒绝导入`);
  }
  const files: AttachmentView[] = [];
  for (const f of m.files) {
    if (!isAttachmentView(f)) throw new Error(`${MANIFEST_NAME} 存在字段不完整的条目`);
    if (!Number.isFinite(f.size) || f.size < 0) {
      throw new Error(`${MANIFEST_NAME} 存在非法 size：${f.relativePath}`);
    }
    if (!Number.isFinite(f.importedAt) || f.importedAt <= 0) {
      throw new Error(`${MANIFEST_NAME} 存在非法 importedAt：${f.relativePath}`);
    }
    if (!f.name || !f.type || !f.source) {
      throw new Error(`${MANIFEST_NAME} 存在空 name/type/source：${f.relativePath}`);
    }
    let normalized: string;
    try {
      normalized = normalizeRelativePath(f.relativePath);
    } catch (err) {
      throw new Error(`${MANIFEST_NAME} 存在非法 relativePath：${(err as Error).message}`);
    }
    if (normalized !== f.relativePath) {
      throw new Error(`${MANIFEST_NAME} 的 relativePath 不是 POSIX 规范形式：${f.relativePath}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(f.sha256)) {
      throw new Error(`${MANIFEST_NAME} 存在非法 sha256：${f.relativePath}`);
    }
    files.push(f);
  }
  return files;
}

function assertSafeTaskId(taskId: string): string {
  const normalized = normalizeRelativePath(taskId);
  if (normalized.includes("/")) {
    throw new ArtifactPathError("invalid", `taskId 不能包含路径分隔符：${taskId}`);
  }
  if (normalized === "." || normalized === "..") {
    throw new ArtifactPathError("invalid", `taskId 非法：${taskId}`);
  }
  return normalized;
}

function sourceKind(abs: string): "file" | "dir" | "zip" {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new ArtifactPathError("symlink", `源路径是 symlink/junction，拒绝导入：${abs}`);
  }
  if (st.isDirectory()) return "dir";
  if (!st.isFile()) {
    throw new ArtifactPathError("invalid", `源路径不是普通文件/文件夹：${abs}`);
  }
  return extname(abs).toLowerCase() === ".zip" ? "zip" : "file";
}

function walkSource(dirAbs: string, prefix = ""): Array<{ abs: string; rel: string; size: number }> {
  const out: Array<{ abs: string; rel: string; size: number }> = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = join(dirAbs, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new ArtifactPathError("symlink", `文件夹内包含 symlink/junction，拒绝导入：${abs}`);
    }
    if (st.isDirectory()) {
      out.push(...walkSource(abs, rel));
    } else if (st.isFile()) {
      try {
        normalizeRelativePath(rel);
      } catch (err) {
        throw new ArtifactPathError(
          (err as ArtifactPathError).code ?? "invalid",
          `文件夹内有非法文件名：${abs}（${(err as Error).message}）`,
        );
      }
      out.push({ abs, rel, size: st.size });
    } else {
      throw new ArtifactPathError("invalid", `文件夹内包含特殊文件，拒绝导入：${abs}`);
    }
  }
  return out;
}

async function copyFileStreaming(
  src: string,
  dest: string,
  maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new ArtifactPathError("too-long", "超过单任务附件总大小上限"));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(
    createReadStream(src, { highWaterMark: 64 * 1024 }),
    meter,
    createWriteStream(dest, { flags: "wx" }),
  );
  return { size, sha256: hash.digest("hex") };
}

function writeManifest(taskDir: string, taskId: string, files: AttachmentView[]): void {
  const dir = join(taskDir, "attachments");
  const manifest = join(dir, MANIFEST_NAME);
  const tmp = join(dir, `.${MANIFEST_NAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const sorted = [...files].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  const payload = { version: 1, taskId, files: sorted };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, manifest);
}

/**
 * 导入附件。永不抛错：失败以 `{ok:false,error}` 返回，并保证不留下本次的部分产物。
 */
export async function importAttachments(input: {
  workRoot: string;
  taskId: string;
  paths: string[];
  limits?: Partial<ImportLimits>;
}): Promise<ImportResult> {
  const limits: ImportLimits = { ...ATTACHMENT_LIMITS, ...(input.limits ?? {}) };
  return withLock(resolve(input.workRoot, input.taskId), () =>
    importAttachmentsInner(input, limits),
  );
}

async function importAttachmentsInner(
  input: { workRoot: string; taskId: string; paths: string[] },
  limits: ImportLimits,
): Promise<ImportResult> {
  let tempRoot: string | null = null;
  let attachmentsExisted = false;
  let taskDirExisted = false;
  let createdAttachments = false;
  let createdTaskDir = false;
  let taskDir = "";
  let attachmentsDir = "";
  const renamed: string[] = [];

  try {
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new Error("paths 不能为空");
    }
    if (input.paths.length > MAX_IMPORT_PATHS) {
      throw new Error(`一次最多导入 ${MAX_IMPORT_PATHS} 个路径（收到 ${input.paths.length} 个）`);
    }

    let workRoot: string;
    try {
      workRoot = realpathSync(input.workRoot);
    } catch {
      throw new Error(`工作目录不存在：${input.workRoot}`);
    }
    ensureDir(workRoot);
    const taskId = assertSafeTaskId(input.taskId);
    taskDir = join(workRoot, taskId);
    attachmentsDir = join(taskDir, "attachments");

    taskDirExisted = existsSync(taskDir);
    attachmentsExisted = existsSync(attachmentsDir);
    if (attachmentsExisted) {
      const st = lstatSync(attachmentsDir);
      if (st.isSymbolicLink()) {
        throw new ArtifactPathError("symlink", `附件目录是 symlink/junction，拒绝写入：${attachmentsDir}`);
      }
      if (!st.isDirectory()) throw new Error(`附件路径不是目录：${attachmentsDir}`);
    }
    if (taskDirExisted) {
      const stTask = lstatSync(taskDir);
      if (stTask.isSymbolicLink()) {
        throw new ArtifactPathError("symlink", `任务目录是 symlink/junction，拒绝写入：${taskDir}`);
      }
      if (!stTask.isDirectory()) {
        throw new Error(`任务路径不是目录：${taskDir}`);
      }
      const real = realpathSync(taskDir);
      const prefixWin = `${workRoot.toLowerCase()}\\`;
      const prefixPosix = `${workRoot.toLowerCase()}/`;
      if (real !== taskDir && !real.toLowerCase().startsWith(prefixWin) && !real.toLowerCase().startsWith(prefixPosix)) {
        throw new ArtifactPathError("escape", `任务目录逃出工作根：${taskDir}`);
      }
    }

    const existing = readManifestStrict(taskDir, taskId);
    let existingBytes = 0;
    for (const f of existing) existingBytes += f.size;
    const existingPaths = new Set(existing.map((f) => f.relativePath.toLowerCase()));

    // ---- 预检：类型一致、路径合法、上限、重名 ----
    const kinds = new Set<string>();
    const plans: SourcePlan[] = [];
    let newFiles = 0;
    let newBytes = 0;

    for (const raw of input.paths) {
      if (typeof raw !== "string" || raw.length === 0) throw new Error("paths 中存在空路径");
      if (raw.includes("\0")) throw new Error("paths 中存在 NUL 字符");
      if (!isAbsolute(raw)) throw new Error(`导入路径必须是绝对路径：${raw}`);
      const abs = resolve(raw);
      const kind = sourceKind(abs);
      kinds.add(kind);
      if (kinds.size > 1) {
        throw new Error("P3-A 只允许单一路径类型：文件、文件夹、zip 不能混在一次导入里");
      }

      const topRaw = kind === "zip" ? basename(abs, extname(abs)) : basename(abs);
      let top: string;
      try {
        top = normalizeRelativePath(topRaw);
      } catch (err) {
        throw new Error(`导入项名称非法：${(err as Error).message}`);
      }
      if (top.toLowerCase() === MANIFEST_NAME.toLowerCase()) {
        throw new Error(`${MANIFEST_NAME} 是保留文件名，不能作为附件名`);
      }

      if (kind === "file") {
        const st = lstatSync(abs);
        const rel = top;
        if (existingPaths.has(rel.toLowerCase())) throw new Error(`附件已存在：${rel}`);
        if (existsSync(join(attachmentsDir, rel))) throw new Error(`目标已存在：${rel}`);
        plans.push({ kind, abs, top, files: [{ abs, rel, size: st.size }], totalBytes: st.size });
        newFiles += 1;
        newBytes += st.size;
      } else if (kind === "dir") {
        const files = walkSource(abs);
        if (files.length === 0) throw new Error(`文件夹内没有文件：${abs}`);
        if (existingPaths.has(top.toLowerCase()) || existsSync(join(attachmentsDir, top))) {
          throw new Error(`目标已存在：${top}`);
        }
        let total = 0;
        for (const f of files) {
          const rel = normalizeRelativePath(`${top}/${f.rel}`);
          if (existingPaths.has(rel.toLowerCase())) throw new Error(`附件已存在：${rel}`);
          total += f.size;
        }
        plans.push({ kind, abs, top, files, totalBytes: total });
        newFiles += files.length;
        newBytes += total;
      } else {
        const remainingFiles = limits.maxFiles - existing.length - newFiles;
        const remainingBytes = limits.maxTotalBytes - existingBytes - newBytes;
        if (remainingFiles <= 0 || remainingBytes <= 0) {
          throw new Error(`超过单任务附件上限（${limits.maxFiles} 个文件 / ${limits.maxTotalBytes} 字节）`);
        }
        const inspection = await inspectZip(abs, {
          maxFiles: remainingFiles,
          maxTotalBytes: remainingBytes,
        });
        if (existingPaths.has(top.toLowerCase()) || existsSync(join(attachmentsDir, top))) {
          throw new Error(`目标已存在：${top}`);
        }
        const files = inspection.files.map((f) => ({
          rel: normalizeRelativePath(`${top}/${f.relativePath}`),
          size: f.size,
        }));
        for (const f of files) {
          if (existingPaths.has(f.rel.toLowerCase())) throw new Error(`附件已存在：${f.rel}`);
        }
        plans.push({ kind, abs, top, files, totalBytes: inspection.totalBytes });
        newFiles += inspection.fileCount;
        newBytes += inspection.totalBytes;
      }
    }

    if (existing.length + newFiles > limits.maxFiles) {
      throw new Error(
        `超过单任务附件数量上限（${existing.length + newFiles}/${limits.maxFiles} 个文件）`,
      );
    }
    if (existingBytes + newBytes > limits.maxTotalBytes) {
      throw new Error(
        `超过单任务附件总大小上限（${existingBytes + newBytes}/${limits.maxTotalBytes} 字节）`,
      );
    }

    // 本次新增相对路径之间也不能重名（忽略大小写）。
    const newPathSet = new Set<string>();
    for (const plan of plans) {
      for (const f of plan.files) {
        const key = f.rel.toLowerCase();
        if (newPathSet.has(key)) throw new Error(`本次导入存在重复路径：${f.rel}`);
        newPathSet.add(key);
      }
    }
    const topSet = new Set<string>();
    for (const plan of plans) {
      const key = plan.top.toLowerCase();
      if (topSet.has(key)) throw new Error(`本次导入存在重复目标：${plan.top}`);
      topSet.add(key);
    }

    // ---- 落盘：临时目录 → 逐个校验 → 原子 rename ----
    mkdirSync(attachmentsDir, { recursive: true });
    createdAttachments = !attachmentsExisted;
    createdTaskDir = !taskDirExisted;
    ensureDir(taskDir);

    tempRoot = join(attachmentsDir, `.import-${Date.now()}-${randomBytes(4).toString("hex")}`);
    mkdirSync(tempRoot, { recursive: true });

    const importedAt = Date.now();
    const views: AttachmentView[] = [];
    let stagedBytes = 0;

    for (const plan of plans) {
      const stage = join(tempRoot, plan.top);
      if (plan.kind === "file") {
        const f = plan.files[0];
        const max = limits.maxTotalBytes - existingBytes - stagedBytes;
        const info = await copyFileStreaming(f.abs!, stage, max);
        stagedBytes += info.size;
        views.push(makeView(f.rel, info.size, info.sha256, importedAt));
      } else if (plan.kind === "dir") {
        for (const f of plan.files) {
          const dest = join(stage, ...f.rel.split("/"));
          const max = limits.maxTotalBytes - existingBytes - stagedBytes;
          const info = await copyFileStreaming(f.abs!, dest, max);
          stagedBytes += info.size;
          views.push(makeView(`${plan.top}/${f.rel}`, info.size, info.sha256, importedAt));
        }
      } else {
        const remainingFiles = limits.maxFiles - existing.length - views.length;
        const remainingBytes = limits.maxTotalBytes - existingBytes - stagedBytes;
        const infos = await extractZip(plan.abs, stage, {
          maxFiles: remainingFiles,
          maxTotalBytes: remainingBytes,
        });
        for (const info of infos) {
          stagedBytes += info.size;
          views.push(makeView(`${plan.top}/${info.relativePath}`, info.size, info.sha256, importedAt));
        }
      }
    }

    const finalCount = existing.length + views.length;
    if (finalCount > limits.maxFiles) {
      throw new Error(`超过单任务附件数量上限（${finalCount}/${limits.maxFiles} 个文件）`);
    }
    if (existingBytes + stagedBytes > limits.maxTotalBytes) {
      throw new Error(
        `超过单任务附件总大小上限（${existingBytes + stagedBytes}/${limits.maxTotalBytes} 字节）`,
      );
    }

    for (const plan of plans) {
      const dest = join(attachmentsDir, plan.top);
      if (existsSync(dest)) throw new Error(`目标已存在：${plan.top}`);
      renameSync(join(tempRoot, plan.top), dest);
      renamed.push(dest);
    }

    writeManifest(taskDir, taskId, [...existing, ...views]);
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;

    return {
      ok: true,
      imported: views,
      taskFileCount: finalCount,
      taskTotalBytes: existingBytes + stagedBytes,
    };
  } catch (err) {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    for (const dest of renamed) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        /* 回滚尽力而为 */
      }
    }
    if (attachmentsDir) {
      // writeManifest 的临时文件（rename 失败时可能残留）不能留下。
      try {
        for (const name of readdirSync(attachmentsDir)) {
          if (name.startsWith(`.${MANIFEST_NAME}.tmp-`)) {
            rmSync(join(attachmentsDir, name), { force: true });
          }
        }
      } catch {
        /* 目录不存在/不可读：忽略 */
      }
    }
    if (createdAttachments && attachmentsDir) {
      try {
        rmdirSync(attachmentsDir);
      } catch {
        /* 非空/不存在都忽略 */
      }
    }
    if (createdTaskDir && taskDir) {
      try {
        rmdirSync(taskDir);
      } catch {
        /* 非空/不存在都忽略 */
      }
    }
    return { ok: false, error: errorMessage(err) };
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function makeView(relativePath: string, size: number, sha256: string, importedAt: number): AttachmentView {
  return {
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    size,
    sha256,
    type: contentTypeForPath(relativePath),
    source: "upload",
    importedAt,
  };
}
