/**
 * 技能库内存索引（P2-A）。
 *
 * 目标：为后续 skill_search / skill_read / 简报注入提供**懒构建**的元数据索引。
 * 约束：
 *  - 不在启动时扫描整个技能库；首次 ensureIndex() 才构建。
 *  - 文档只读开头 N 行（默认 20 行 / 8KB），不读全文。
 *  - wp-index.jsonl / script-index.jsonl 本身是元数据，逐行解析。
 *  - 所有文件读取都过 paths.resolveWithinRoot（realpath + 根包含 + 拒绝 symlink/junction 逃逸）。
 *  - 索引可从源重建；构建失败只影响 status().error，不影响应用启动。
 */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { resolveWithinRoot } from "./paths.ts";

export type SkillDocKind = "skill" | "knowledge" | "idx" | "cheatsheet" | "search-index";

export interface SkillDoc {
  /** 相对 skill root 的 POSIX 路径。 */
  path: string;
  title: string;
  kind: SkillDocKind;
  /** 开头 N 行摘要，不是全文。 */
  text: string;
  size: number;
}

export interface SkillWp {
  id: string;
  title: string;
  contest?: string;
  year?: string;
  category?: string;
  tags: string[];
  /** 元数据里的 local_path / upstream_path / wp_url；不保证是本地可读文件。 */
  path: string;
  oneLiner?: string;
}

export interface SkillScript {
  name: string;
  relativePath: string;
  package?: string;
  size?: number;
  lines?: number;
  description?: string;
}

export interface SkillIndex {
  /** realpath 后的技能库根。 */
  root: string;
  packages: string[];
  docs: SkillDoc[];
  wps: SkillWp[];
  scripts: SkillScript[];
  builtAt: number;
  durationMs: number;
  /** 实际遍历到的普通文件数（不含被跳过的 symlink/junction 与 node_modules/.git/__pycache__）。 */
  fileCount: number;
  /** 上述文件的总字节数。 */
  totalBytes: number;
  warnings: string[];
}

export interface SkillStatus {
  configured: boolean;
  root: string | null;
  packages: string[];
  builtAt: number | null;
  /** 根目录来源：env / config / dev / packaged；未配置时为 null（env 指向坏目录时保留 env 供排障）。 */
  source: SkillRootSource | null;
  error?: string;
}

export type SkillRootSource = "env" | "config" | "dev" | "packaged";

export interface ResolveSkillRootOptions {
  env?: NodeJS.ProcessEnv;
  /** 已由 config/loader.ts 解析成绝对路径。 */
  configSkillDir?: string;
  repoRoot?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  /** 测试/调用方显式覆盖开发态候选；不传则用 <repoRoot>/../skill。 */
  devSkillDir?: string;
  /** 测试注入；默认用 statSync().isDirectory()。 */
  exists?: (p: string) => boolean;
}

export interface SkillRootResolution {
  root: string | null;
  source: SkillRootSource | null;
  error?: string;
}

export interface BuildSkillIndexOptions {
  log?: (line: string) => void;
}

export interface SkillRuntimeOptions extends ResolveSkillRootOptions {
  log?: (line: string) => void;
}

const HEAD_BYTES = 8 * 1024;
const HEAD_LINES = 20;
const MAX_EXCERPT_CHARS = 4000;
const MAX_DEPTH = 12;

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 解析技能库根。顺序严格按计划 §5.3：
 *   BUMIMANG_SKILL_DIR → config.skillDir → 开发态 <repo>/../skill → 打包态 resources/app-source/skill。
 * 显式 env 指向不存在目录时直接报错（不静默回退）；config 缺失/不存在则继续尝试后面的候选。
 */
export function resolveSkillRoot(opts: ResolveSkillRootOptions = {}): SkillRootResolution {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isDirectory;

  const envRaw = env.BUMIMANG_SKILL_DIR?.trim();
  if (envRaw) {
    const p = path.resolve(envRaw);
    if (exists(p)) return { root: canonical(p), source: "env" };
    return {
      root: null,
      source: "env",
      error: `BUMIMANG_SKILL_DIR 指向的目录不存在：${p}`,
    };
  }

  let configError: string | undefined;
  const configRaw = opts.configSkillDir?.trim();
  if (configRaw) {
    const p = path.resolve(configRaw);
    if (exists(p)) return { root: canonical(p), source: "config" };
    configError = `config/app.json 的 skillDir 不存在：${p}`;
  }

  if (!opts.isPackaged) {
    const dev = opts.devSkillDir ?? (opts.repoRoot ? path.resolve(opts.repoRoot, "..", "skill") : null);
    if (dev && exists(dev)) return { root: canonical(dev), source: "dev" };
  }

  if (opts.isPackaged && opts.resourcesPath) {
    const p = path.join(opts.resourcesPath, "app-source", "skill");
    if (exists(p)) return { root: canonical(p), source: "packaged" };
  }

  const detail = configError ? `（${configError}）` : "";
  return {
    root: null,
    source: null,
    error:
      `未配置技能库：请设置 BUMIMANG_SKILL_DIR 或 config/app.json 的 skillDir；` +
      `开发态可把技能库放在仓库同级 skill/${detail}`,
  };
}

/** 轻量发现技能包：只看 <root>/skills 的一级目录，不扫描内容。 */
export function discoverPackages(root: string | null): string[] {
  if (!root) return [];
  try {
    return readdirSync(path.join(root, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface WalkedFile {
  abs: string;
  rel: string;
}

function walkFiles(root: string, warnings: string[]): WalkedFile[] {
  const out: WalkedFile[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      warnings.push(`目录深度超过 ${MAX_DEPTH}，已跳过：${toPosix(path.relative(root, dir))}`);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`目录不可读 ${toPosix(path.relative(root, dir))}：${(err as Error).message}`);
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        warnings.push(`跳过符号链接/junction：${toPosix(path.relative(root, abs))}`);
        continue;
      }
      if (ent.isDirectory()) {
        visit(abs, depth + 1);
      } else if (ent.isFile()) {
        out.push({ abs, rel: toPosix(path.relative(root, abs)) });
      }
    }
  };
  visit(root, 0);
  return out;
}

function readHead(abs: string): string {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function titleOf(head: string, rel: string): string {
  const m = /^#\s+(.+)$/m.exec(head);
  if (m && m[1].trim()) return m[1].trim();
  return path
    .basename(rel)
    .replace(/\.idx\.md$/i, "")
    .replace(/\.(md|jsonl|json)$/i, "");
}

function excerptOf(head: string): string {
  const lines = head.split(/\r?\n/).slice(0, HEAD_LINES).join("\n").trim();
  return lines.length > MAX_EXCERPT_CHARS ? lines.slice(0, MAX_EXCERPT_CHARS) : lines;
}

function docKindOf(rel: string, base: string): SkillDocKind | null {
  if (base === "SKILL.md") return "skill";
  if (/\.idx\.md$/i.test(base)) return "idx";
  if (rel.split("/").includes("知识库") && /\.md$/i.test(base)) return "knowledge";
  if (base === "PAYLOAD-CHEATSHEET.md") return "cheatsheet";
  if (base === "AI-SEARCH-INDEX.md") return "search-index";
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
}

function parseJsonl(real: string, rel: string, warnings: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let bad = 0;
  for (const line of readFileSync(real, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
      } else {
        bad++;
      }
    } catch {
      bad++;
    }
  }
  if (bad > 0) warnings.push(`${rel} 有 ${bad} 行无法解析`);
  return out;
}

/**
 * 构建内存索引。调用方负责懒加载；本函数是同步的，构建 51MB 目录也只在首次触发。
 */
export function buildSkillIndex(rootInput: string, opts: BuildSkillIndexOptions = {}): SkillIndex {
  const started = Date.now();
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  let root: string;
  try {
    root = realpathSync(rootInput);
  } catch {
    throw new Error(`技能库根目录不存在：${rootInput}`);
  }

  const warnings: string[] = [];
  const files = walkFiles(root, warnings);
  let totalBytes = 0;
  for (const f of files) {
    try {
      totalBytes += statSync(f.abs).size;
    } catch {
      /* 文件在扫描期间消失：不影响索引 */
    }
  }

  const docs: SkillDoc[] = [];
  const wps: SkillWp[] = [];
  const scripts: SkillScript[] = [];

  for (const f of files) {
    const base = path.basename(f.abs);
    const kind = docKindOf(f.rel, base);
    if (kind) {
      try {
        const real = resolveWithinRoot(root, f.rel, { allowedExtensions: [".md"] });
        const head = readHead(real);
        docs.push({
          path: f.rel,
          title: titleOf(head, f.rel),
          kind,
          text: excerptOf(head),
          size: statSync(real).size,
        });
      } catch (err) {
        warnings.push(`读取文档失败 ${f.rel}：${(err as Error).message}`);
      }
      continue;
    }

    if (base === "wp-index.jsonl") {
      try {
        const real = resolveWithinRoot(root, f.rel, { allowedExtensions: [".jsonl"] });
        const rows = parseJsonl(real, f.rel, warnings);
        for (const row of rows) {
          const local = str(row.local_path);
          const upstream = str(row.upstream_path);
          const url = str(row.wp_url);
          wps.push({
            id: str(row.id) ?? `wp-${wps.length + 1}`,
            title: str(row.title) ?? "(无标题)",
            contest: str(row.contest),
            year: str(row.year),
            category: str(row.category),
            tags: strArray(row.tags),
            path: local || upstream || url || "",
            oneLiner: str(row.one_liner),
          });
        }
      } catch (err) {
        warnings.push(`读取 wp-index 失败 ${f.rel}：${(err as Error).message}`);
      }
      continue;
    }

    if (base === "script-index.jsonl") {
      try {
        const real = resolveWithinRoot(root, f.rel, { allowedExtensions: [".jsonl"] });
        const rows = parseJsonl(real, f.rel, warnings);
        for (const row of rows) {
          const relativePath = str(row.relative_path) ?? str(row.upstream_path) ?? str(row.name) ?? "";
          scripts.push({
            name: str(row.name) ?? (path.basename(relativePath) || "(未命名脚本)"),
            relativePath,
            package: str(row.package),
            size: num(row.size),
            lines: num(row.lines),
            description: str(row.description),
          });
        }
      } catch (err) {
        warnings.push(`读取 script-index 失败 ${f.rel}：${(err as Error).message}`);
      }
    }
  }

  docs.sort((a, b) => a.path.localeCompare(b.path));
  wps.sort((a, b) => a.id.localeCompare(b.id));
  scripts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const builtAt = Date.now();
  const durationMs = builtAt - started;
  const index: SkillIndex = {
    root,
    packages: discoverPackages(root),
    docs,
    wps,
    scripts,
    builtAt,
    durationMs,
    fileCount: files.length,
    totalBytes,
    warnings,
  };
  log(
    `[skill] 索引构建完成：root=${root} files=${files.length} bytes=${totalBytes} ` +
      `docs=${docs.length} wps=${wps.length} scripts=${scripts.length} 耗时=${durationMs}ms`,
  );
  if (warnings.length > 0) {
    log(`[skill] 索引警告 ${warnings.length} 条（首条：${warnings[0]}）`);
  }
  return index;
}

/**
 * 技能库运行期状态：解析根 + 懒索引。
 * P2-A 只把它放进快照；P2-B 才消费 ensureIndex()。
 */
export class SkillRuntime {
  readonly root: string | null;
  readonly source: SkillRootSource | null;
  readonly resolutionError?: string;
  private readonly logLine: (line: string) => void;
  private index: SkillIndex | null = null;
  private buildError: string | undefined;

  constructor(opts: SkillRuntimeOptions = {}) {
    const resolution = resolveSkillRoot(opts);
    this.root = resolution.root;
    this.source = resolution.source;
    this.resolutionError = resolution.error;
    this.logLine = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  }

  status(): SkillStatus {
    const root = this.root;
    const packages = this.index ? this.index.packages : discoverPackages(root);
    const builtAt = this.index ? this.index.builtAt : null;
    if (!root) {
      return {
        configured: false,
        root: null,
        packages: [],
        builtAt: null,
        source: this.source,
        error: this.resolutionError ?? "未配置技能库",
      };
    }
    if (this.buildError) {
      return {
        configured: true,
        root,
        packages,
        builtAt,
        source: this.source,
        error: this.buildError,
      };
    }
    return { configured: true, root, packages, builtAt, source: this.source };
  }

  ensureIndex(): SkillIndex {
    if (!this.root) throw new Error(this.resolutionError ?? "未配置技能库");
    if (this.index) return this.index;
    try {
      this.index = buildSkillIndex(this.root, { log: this.logLine });
      this.buildError = undefined;
      return this.index;
    } catch (err) {
      this.buildError = `技能索引构建失败：${(err as Error).message}`;
      throw err;
    }
  }

  getIndex(): SkillIndex | null {
    return this.index;
  }
}

export function createSkillRuntime(opts: SkillRuntimeOptions = {}): SkillRuntime {
  return new SkillRuntime(opts);
}

/** 把技能状态作为可选字段挂到快照上；旧字段原样保留。 */
export function withSkillStatus<T extends object>(
  snapshot: T,
  status: SkillStatus,
): T & { skill: SkillStatus } {
  return { ...snapshot, skill: status };
}
