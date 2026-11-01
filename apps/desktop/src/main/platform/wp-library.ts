/**
 * 本地 WP 知识库。
 *
 * D:\hzw\CTF 这类目录有大量题解、附件和历史比赛资料。这里不把全文塞进提示词：
 *  - 只索引标题、路径、分类和开头一小段；
 *  - 按题名/方向检索最相关的几篇；
 *  - 开题时只复制命中的 WP 到任务目录的 reference/wp/，agent 通过普通文件工具精读。
 */

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { WpMatchView } from "../../../../../packages/shared-protocol/events.ts";

interface WpIndexFile {
  version: 3;
  root: string;
  builtAt: number;
  files: WpRecord[];
  truncated: boolean;
}

export interface WpRecord {
  path: string;
  title: string;
  category: string | null;
  preview: string;
  size: number;
  mtime: number;
}

export interface WpLibraryStatus {
  root: string | null;
  indexed: boolean;
  count: number;
  error: string | null;
}

export interface ChallengeSearchInput {
  title: string;
  direction: string;
  description?: string;
}

export interface CopiedWp {
  title: string;
  source: string;
  relativePath: string;
  score: number;
}

const INDEX_VERSION = 3;
const MAX_FILES = 8000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const HEAD_BYTES = 12 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "site-packages",
]);
// 题解以 Markdown/TXT 为主；HTML 目录里混有大量题目页面和 PoC，索引后噪声过高。
const TEXT_EXT = new Set([".md", ".txt"]);

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  const n = normalize(value);
  if (!n) return [];
  const words = n.split(" ").filter((word) => word.length >= 2);
  const compact = n.replace(/\s+/g, "");
  if (compact.length >= 2) words.push(compact);
  return [...new Set(words)].slice(0, 20);
}

function titleFromText(text: string, fallback: string): string {
  const md = /^#\s+(.+)$/m.exec(text);
  if (md?.[1]?.trim()) return md[1].trim().slice(0, 180);
  const html = /<title[^>]*>\s*([^<]+)\s*<\/title>/i.exec(text);
  if (html?.[1]?.trim()) return html[1].trim().replace(/\s+/g, " ").slice(0, 180);
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length >= 3);
  return (firstLine || fallback.replace(/\.[^.]+$/, "")).slice(0, 180);
}

function categoryFromPath(path: string): string | null {
  const p = path.toLowerCase();
  for (const category of ["web", "pwn", "crypto", "reverse", "misc", "forensics", "ir", "awd"]) {
    if (p.includes(`/${category}/`) || p.includes(`-${category}`) || p.includes(`\\${category}\\`)) {
      return category;
    }
  }
  if (p.includes("逆向")) return "reverse";
  if (p.includes("密码")) return "crypto";
  if (p.includes("杂项")) return "misc";
  if (p.includes("应急")) return "ir";
  return null;
}

function looksLikePromptInjection(row: Pick<WpRecord, "title" | "path" | "preview">): boolean {
  const text = `${row.title}\n${row.path}\n${row.preview}`.toLowerCase();
  return (
    /ignore\s+(all\s+)?previous\s+instructions/.test(text) ||
    /disregard\s+(all\s+)?previous\s+instructions/.test(text) ||
    /output\s+the\s+number\s+\d+/.test(text) ||
    /!!!.*ransomware\s+warning.*!!!/.test(text) ||
    /you\s+must\s+(now\s+)?follow\s+these\s+instructions/.test(text)
  );
}

async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const result = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function safeName(title: string, source: string): string {
  const clean = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "wp";
  const suffix = createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `${clean}-${suffix}.md`;
}

export class WpLibrary {
  readonly root: string | null;
  private readonly cachePath: string;
  private index: WpIndexFile | null = null;
  private loading: Promise<WpIndexFile> | null = null;
  private error: string | null = null;

  constructor(opts: { root?: string; cachePath: string }) {
    this.root = opts.root ? resolve(opts.root) : null;
    this.cachePath = opts.cachePath;
  }

  status(): WpLibraryStatus {
    return {
      root: this.root,
      indexed: Boolean(this.index),
      count: this.index?.files.length ?? 0,
      error: this.error,
    };
  }

  async ensureIndex(): Promise<WpIndexFile | null> {
    if (!this.root) return null;
    if (this.index) return this.index;
    if (this.loading) return this.loading;
    this.loading = this.loadOrBuild();
    try {
      this.index = await this.loading;
      this.error = null;
      return this.index;
    } catch (err) {
      this.error = (err as Error).message;
      return null;
    } finally {
      this.loading = null;
    }
  }

  async search(
    challenge: ChallengeSearchInput,
    limit = 8,
  ): Promise<WpMatchView[]> {
    const index = await this.ensureIndex();
    if (!index) return [];
    const queryTokens = tokens(
      `${challenge.title} ${challenge.direction} ${challenge.description ?? ""}`.slice(0, 4000),
    );
    const titleKey = normalize(challenge.title);
    const direction = normalize(challenge.direction);
    const ranked: Array<WpMatchView & { _internal: number }> = [];

    for (const file of index.files) {
      if (looksLikePromptInjection(file)) continue;
      const hay = normalize(`${file.title} ${file.path} ${file.category ?? ""} ${file.preview}`);
      let score = 0;
      const reasons: string[] = [];
      if (titleKey && normalize(file.title).includes(titleKey)) {
        score += 180;
        reasons.push("标题完全命中");
      }
      if (titleKey && normalize(file.path).includes(titleKey.replace(/\s+/g, "-"))) {
        score += 140;
        reasons.push("文件名命中");
      }
      let hits = 0;
      for (const token of queryTokens) {
        if (token.length < 3) continue;
        if (hay.includes(token)) {
          hits += 1;
          score += token.length >= 6 ? 18 : 9;
        }
      }
      if (hits > 0) reasons.push(`关键词 ${hits} 个`);
      if (direction && normalize(`${file.category ?? ""} ${file.path}`).includes(direction)) {
        score += 30;
        reasons.push("方向匹配");
      }
      // 方向词本身太泛化（例如 Misc/Web）不足以构成“可用 WP”。
      // 只返回至少有一个实质关键词命中的结果，避免把历史附件/POC 噪声推给用户。
      if (score < 60) continue;
      ranked.push({
        title: file.title,
        path: file.path,
        category: file.category,
        score,
        reason: reasons.join(" · ") || "相关",
        _internal: score,
      });
    }

    ranked.sort((a, b) => b._internal - a._internal || a.path.localeCompare(b.path));
    return ranked.slice(0, Math.max(1, Math.min(limit, 20))).map(({ _internal, ...item }) => item);
  }

  async copyMatches(
    challenge: ChallengeSearchInput,
    taskDir: string,
    limit = 6,
  ): Promise<CopiedWp[]> {
    const matches = await this.search(challenge, limit);
    if (matches.length === 0) return [];
    // 只复制高置信命中。泛化方向命中的历史附件里可能混有恶意提示词或
    // 与题目无关的源码；宁可少给参考，也不能把污染内容送进 Agent 上下文。
    const selected = matches.filter((match) => match.score >= 120).slice(0, limit);
    if (selected.length === 0) return [];
    const targetDir = join(taskDir, "reference", "wp");
    await mkdir(targetDir, { recursive: true });
    const copied: CopiedWp[] = [];
    for (const match of selected) {
      const source = join(this.root!, ...match.path.split("/"));
      const target = join(targetDir, safeName(match.title, match.path));
      try {
        await copyFile(source, target);
        copied.push({
          title: match.title,
          source: match.path,
          relativePath: toPosix(relative(taskDir, target)),
          score: match.score,
        });
      } catch {
        // 索引命中的文件可能在扫描后被删除；跳过单项，不阻断开题。
      }
    }
    if (copied.length > 0) {
      await writeFile(
        join(targetDir, "manifest.json"),
        `${JSON.stringify({ version: 1, challenge: challenge.title, files: copied }, null, 2)}\n`,
        "utf8",
      );
    }
    return copied;
  }

  private async loadOrBuild(): Promise<WpIndexFile> {
    if (!this.root) throw new Error("未配置 WP 目录");
    const rootStat = await stat(this.root);
    if (!rootStat.isDirectory()) throw new Error(`WP 目录不存在：${this.root}`);

    try {
      const cached = JSON.parse(await readFile(this.cachePath, "utf8")) as WpIndexFile;
      if (
        cached?.version === INDEX_VERSION &&
        cached.root === this.root &&
        Array.isArray(cached.files) &&
        Date.now() - cached.builtAt < 24 * 60 * 60 * 1000
      ) {
        return cached;
      }
    } catch {
      // 没缓存/缓存损坏：重建。
    }

    const files: WpRecord[] = [];
    let truncated = false;
    const visit = async (dir: string): Promise<void> => {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          await visit(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!TEXT_EXT.has(ext)) continue;
        let fileStat;
        try {
          fileStat = await stat(abs);
        } catch {
          continue;
        }
        if (fileStat.size <= 0 || fileStat.size > MAX_FILE_BYTES) continue;
        let head = "";
        try {
          head = await readHead(abs);
        } catch {
          continue;
        }
        const rel = toPosix(relative(this.root!, abs));
        files.push({
          path: rel,
          title: titleFromText(head, basename(abs)),
          category: categoryFromPath(rel),
          preview: head.replace(/\s+/g, " ").slice(0, 600),
          size: fileStat.size,
          mtime: Math.round(fileStat.mtimeMs),
        });
        if (files.length % 80 === 0) {
          await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        }
      }
    };
    await visit(this.root);

    const index: WpIndexFile = {
      version: INDEX_VERSION,
      root: this.root,
      builtAt: Date.now(),
      files,
      truncated,
    };
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      const temp = `${this.cachePath}.tmp-${process.pid}`;
      await writeFile(temp, `${JSON.stringify(index)}\n`, "utf8");
      await rename(temp, this.cachePath);
    } catch {
      // 缓存写入失败不影响本次检索。
    }
    return index;
  }
}
