/**
 * 技能库工具（P2-B）：skill_search / skill_read / skill_list。
 *
 * 三个工具都是只读、纯函数式（输入索引/根目录，返回数据），由主进程的 bridge 路由调用；
 * MCP 子进程只做转发（同进程、同会话令牌，不绕过桥）。
 *
 * 路径安全：skill_read 一律过 paths.resolveWithinRoot（realpath + 根包含 + 拒绝
 * symlink/junction 逃逸）；256KB 上限在读取时截断并标记，不是直接拒绝。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DEFAULT_ALLOWED_EXTENSIONS, MAX_SKILL_FILE_BYTES, resolveWithinRoot } from "./paths.ts";
import type { SkillDocKind, SkillIndex } from "./index.ts";

export const SKILL_SEARCH_SOURCES = ["all", "core", "ctf", "wp", "scripts"] as const;
export type SkillSearchSource = (typeof SKILL_SEARCH_SOURCES)[number];

export type SkillHitKind = SkillDocKind | "wp" | "script";

export interface SkillSearchHit {
  path: string;
  line: number;
  snippet: string;
  title: string;
  kind: SkillHitKind;
  score: number;
}

export interface SkillReadResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines: number;
}

export interface SkillListPackage {
  name: string;
  path: string;
  docs: number;
  knowledge: number;
}

export interface SkillListResult {
  root: string;
  builtAt: number;
  category?: string;
  packages: SkillListPackage[];
  totals: { packages: number; docs: number; knowledge: number; wps: number; scripts: number };
}

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_READ_LINES = 400;
const MAX_SNIPPET_CHARS = 240;

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function normalizeQuery(query: unknown): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

function parseSource(source: unknown): SkillSearchSource {
  if (source === undefined || source === null || source === "") return "all";
  if (typeof source === "string" && (SKILL_SEARCH_SOURCES as readonly string[]).includes(source)) {
    return source as SkillSearchSource;
  }
  throw new Error(`未知 source：${String(source)}（可选：${SKILL_SEARCH_SOURCES.join("|")}）`);
}

function parseLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(n)));
}

/** 用首次出现位置生成 snippet 与行号；未命中时给开头摘要。 */
function snippetFor(text: string, query: string): { snippet: string; line: number } {
  const idx = text.toLowerCase().indexOf(query);
  if (idx < 0) {
    const head = text.split(/\r?\n/).slice(0, 2).join(" ");
    return { snippet: clip(head, MAX_SNIPPET_CHARS), line: 0 };
  }
  const before = text.slice(Math.max(0, idx - 60), idx);
  const after = text.slice(idx, Math.min(text.length, idx + query.length + 100));
  const line = (text.slice(0, idx).match(/\n/g)?.length ?? 0) + 1;
  return { snippet: `…${clip(`${before}${after}`, MAX_SNIPPET_CHARS)}…`, line };
}

function scoreFor(haystack: string, title: string, pathText: string, query: string): number {
  const hay = haystack.toLowerCase();
  if (!hay.includes(query)) return 0;
  let score = 1;
  if (title.toLowerCase().includes(query)) score += 5;
  if (pathText.toLowerCase().includes(query)) score += 3;
  const occurrences = hay.split(query).length - 1;
  return score + Math.min(3, Math.max(0, occurrences - 1));
}

function docAllowedForSource(path: string, source: SkillSearchSource): boolean {
  if (source === "all" || source === "core") return true;
  if (source === "ctf") return path.startsWith("skills/ctf-solver/");
  return false;
}

/**
 * 检索已构建的内存索引（docs/wps/scripts）。不读文件、不扫目录。
 *
 * source 语义：
 *  - all：文档 + WP 索引 + 脚本索引
 *  - core：技能文档（SKILL.md / 知识库 / .idx.md / cheatsheet / AI 索引）
 *  - ctf：ctf-solver 文档 + 脚本索引
 *  - wp：只返回 wp-index 命中
 *  - scripts：只返回 script-index 命中
 */
export function skillSearch(
  index: SkillIndex,
  query: unknown,
  source: unknown = "all",
  limit: unknown = DEFAULT_SEARCH_LIMIT,
): SkillSearchHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const src = parseSource(source);
  const max = parseLimit(limit);
  const hits: SkillSearchHit[] = [];

  if (src !== "wp" && src !== "scripts") {
    for (const doc of index.docs) {
      if (!docAllowedForSource(doc.path, src)) continue;
      const hay = `${doc.title}\n${doc.path}\n${doc.text}`;
      const score = scoreFor(hay, doc.title, doc.path, q);
      if (score <= 0) continue;
      const { snippet, line } = snippetFor(doc.text, q);
      hits.push({ path: doc.path, line, snippet, title: doc.title, kind: doc.kind, score });
    }
  }

  if (src === "all" || src === "ctf" || src === "scripts") {
    for (const script of index.scripts) {
      const hay = `${script.name}\n${script.relativePath}\n${script.package ?? ""}\n${script.description ?? ""}`;
      const score = scoreFor(hay, script.name, script.relativePath, q);
      if (score <= 0) continue;
      hits.push({
        path: toPosix(script.relativePath),
        line: 0,
        snippet: clip(script.description || `${script.name}（${script.package ?? "脚本"}）`, MAX_SNIPPET_CHARS),
        title: script.name,
        kind: "script",
        score,
      });
    }
  }

  if (src === "all" || src === "wp") {
    for (const wp of index.wps) {
      const hay = `${wp.id}\n${wp.title}\n${wp.contest ?? ""}\n${wp.category ?? ""}\n${wp.tags.join(" ")}\n${wp.oneLiner ?? ""}`;
      const score = scoreFor(hay, wp.title, wp.path, q);
      if (score <= 0) continue;
      hits.push({
        path: wp.path,
        line: 0,
        snippet: clip(wp.oneLiner || `${wp.contest ?? ""} ${wp.tags.join(" ")}`, MAX_SNIPPET_CHARS),
        title: wp.title,
        kind: "wp",
        score,
      });
    }
  }

  const seen = new Set<string>();
  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
    .filter((h) => {
      const key = `${h.kind}:${h.path}:${h.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

/**
 * 读取技能库内的文件（只读）。
 *
 * - 路径必须过 resolveWithinRoot：`..`、绝对路径、盘符、NUL、symlink/junction 逃逸全部拒绝；
 * - 最多返回 256KB；超过时截断并标记 truncated；
 * - offset/limit 按行切片（limit 默认 400 行）。
 */
export function skillRead(root: string, relativePath: unknown, offset: unknown = 0, limit?: unknown): SkillReadResult {
  if (typeof relativePath !== "string") throw new Error("skill_read 的 path 必须是字符串");
  const rel = toPosix(relativePath);
  const real = resolveWithinRoot(root, rel, { allowedExtensions: DEFAULT_ALLOWED_EXTENSIONS });

  const st = statSync(real);
  const toRead = Math.min(st.size, MAX_SKILL_FILE_BYTES);
  const buf = Buffer.alloc(toRead);
  const fd = openSync(real, "r");
  let read = 0;
  try {
    while (read < toRead) {
      const n = readSync(fd, buf, read, toRead - read, read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }

  const text = buf.subarray(0, read).toString("utf8");
  const byteTruncated = st.size > MAX_SKILL_FILE_BYTES;
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  const startRaw = Number(offset);
  const start = Number.isFinite(startRaw) ? Math.max(0, Math.min(lines.length, Math.floor(startRaw))) : 0;
  const limitRaw = Number(limit);
  const count = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_READ_LINES;
  const content = lines.slice(start, start + count).join("\n");
  const lineTruncated = start > 0 || start + count < lines.length;

  return { path: rel, content, truncated: byteTruncated || lineTruncated, totalLines };
}

/** 列出技能包、文档/知识库/脚本数量；category 仅回显（调用方可按需再筛）。 */
export function skillList(index: SkillIndex, category?: unknown): SkillListResult {
  const packages: SkillListPackage[] = index.packages.map((name) => {
    const prefix = `skills/${name}/`;
    const docs = index.docs.filter((d) => d.path.startsWith(prefix));
    return {
      name,
      path: `skills/${name}`,
      docs: docs.length,
      knowledge: docs.filter((d) => d.kind === "knowledge").length,
    };
  });
  return {
    root: index.root,
    builtAt: index.builtAt,
    ...(typeof category === "string" && category ? { category } : {}),
    packages,
    totals: {
      packages: packages.length,
      docs: index.docs.length,
      knowledge: index.docs.filter((d) => d.kind === "knowledge").length,
      wps: index.wps.length,
      scripts: index.scripts.length,
    },
  };
}
