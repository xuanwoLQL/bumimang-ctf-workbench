/**
 * P3-C：任务目录工件扫描（只读）。
 *
 * 与附件清单不同，工件是 agent/人在任务 workdir 里产生的普通文件：
 * `evidence/*.txt`、`artifacts/*`、任务根目录下的输出等。`attachments/`
 * 由附件面板单独展示，这里跳过，避免重复。
 *
 * 安全/性能边界：
 *  - 只读 `lstat`，不跟随 symlink/junction；realpath 必须在任务目录内；
 *  - 跳过 `node_modules/.git/dist/build/target` 等重目录；
 *  - 最多 500 个文件、深度 6；超出部分不列（不报错）；
 *  - 不读文件内容，只按扩展名分类；真正预览时由 preview.ts 再做魔数/大小校验。
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { ArtifactView } from "../../../../../packages/shared-protocol/events.ts";

export const ARTIFACT_LIMITS = {
  maxFiles: 500,
  maxDepth: 6,
} as const;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".cache",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
]);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".xml", ".html", ".htm", ".svg",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".ps1", ".bat", ".cmd",
  ".c", ".h", ".cpp", ".hpp", ".java", ".go", ".rs", ".rb", ".pl", ".php", ".sql",
  ".yml", ".yaml", ".toml", ".ini", ".conf", ".cfg", ".csv", ".tsv", ".env",
]);

export function classifyArtifactKind(path: string): ArtifactView["kind"] {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 列出一个任务目录下的工件（不含 `attachments/` 与附件清单）。
 * 任务目录不存在/不可读时返回空数组；任何单个条目出错都跳过，不影响其他条目。
 */
export function listArtifacts(taskDir: string): ArtifactView[] {
  let root: string;
  try {
    root = realpathSync(taskDir);
  } catch {
    return [];
  }

  const out: ArtifactView[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= ARTIFACT_LIMITS.maxFiles || depth > ARTIFACT_LIMITS.maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (const ent of entries) {
      if (out.length >= ARTIFACT_LIMITS.maxFiles) break;
      const abs = join(dir, ent.name);
      // 根目录的 attachments/ 与 attachments.json 归附件面板，不重复列。
      if (depth === 0 && (ent.name === "attachments" || ent.name === "attachments.json")) continue;
      if (ent.name.startsWith(".import-")) continue;
      if (ent.isSymbolicLink()) continue;
      let st: Stats;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        continue;
      }
      if (!isInside(root, real)) continue;
      const rel = toPosix(relative(root, abs));
      if (!rel || rel.startsWith("..") || rel.includes("\0")) continue;
      const kind = classifyArtifactKind(rel);
      out.push({
        path: rel,
        name: basename(rel),
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        kind,
        // 二进制也允许 hex 预览；真正是否可预览由 preview.ts 的大小/魔数决定。
        previewable: true,
      });
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path, "zh-CN"));
  return out;
}
