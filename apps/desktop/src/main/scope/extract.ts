/**
 * 目标提取（P4-B，纯函数）。
 *
 * 从命令/权限文本里提取**明确**的目标：
 *  - 带 scheme 的 URL；
 *  - IPv4 CIDR；
 *  - host:port（含 localhost:port / IPv4:port）；
 *  - IPv4。
 *
 * 保守原则（控制误报）：
 *  - 裸域名默认不提取，只有显式 `bareDomainAllowlist` 才提取；
 *  - 文件路径、版本号、五段数字、Windows 路径都不当目标；
 *  - 解析失败的目标进 `unknowns`，不产生 candidate；
 *  - CIDR 内部的 IP 不重复提取（整段 CIDR 已覆盖）。
 *
 * 不读 DB / config、不调外部服务、不做策略判定。
 */

import type { ParsedTarget } from "./parse.ts";
import { parseTarget } from "./parse.ts";

export interface ExtractedTarget {
  kind: "host" | "cidr" | "url";
  /** 规范化后的目标（URL 取 host[:port]，CIDR 网络地址已按掩码规范化）。 */
  value: string;
  /** 原文中的 [start, end)；URL 覆盖整段 URL。 */
  span: [number, number];
}

export interface ExtractResult {
  candidates: ExtractedTarget[];
  unknowns: string[];
}

export interface ExtractOptions {
  /**
   * 允许提取的裸域名：
   *  - 含点的条目按 host 精确匹配或子域匹配（`example.com`、`*.example.com`）；
   *  - 不含点的条目按 TLD 匹配（`org`）。
   * 默认空数组 = 不提取任何裸域名。
   */
  bareDomainAllowlist?: string[];
}

const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`\\]+/g;
const CIDR_RE = /(?<![\w.\\\/])(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}(?![\w\\\/.])/g;
const HOST_PORT_RE = /(?<![\w.\\\/:-])([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(\d{1,5})(?!\d)/g;
const IPV4_RE = /(?<![\w.\\\/:])(?:\d{1,3}\.){3}\d{1,3}(?![\w.\\\/])/g;
const DOMAIN_RE =
  /(?<![\w.\\\/@-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?![\w.-])/g;

type Span = [number, number];

function overlaps(span: Span, occupied: Span[]): boolean {
  return occupied.some(([s, e]) => span[0] < e && span[1] > s);
}

/** 去掉 URL 末尾常见的标点；成对括号保留。 */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) return url;
    if (".,;:!?".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === "]" && (url.match(/\[/g)?.length ?? 0) < (url.match(/\]/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function domainAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
    if (!entry) continue;
    if (entry.includes(".")) {
      if (h === entry || h.endsWith(`.${entry}`)) return true;
    } else if (h.slice(h.lastIndexOf(".") + 1) === entry) {
      return true;
    }
  }
  return false;
}

export function extractTargets(text: string, options: ExtractOptions = {}): ExtractResult {
  if (typeof text !== "string" || !text) return { candidates: [], unknowns: [] };

  const candidates: ExtractedTarget[] = [];
  const unknowns: string[] = [];
  const unknownSet = new Set<string>();
  const seen = new Set<string>();
  const occupied: Span[] = [];

  const addUnknown = (raw: string): void => {
    if (!unknownSet.has(raw)) {
      unknownSet.add(raw);
      unknowns.push(raw);
    }
  };

  const addCandidate = (
    parsed: ParsedTarget,
    raw: string,
    span: Span,
    kind: ExtractedTarget["kind"],
  ): void => {
    // 原始 token 占位：防止后续阶段把 URL/端口内的片段再提取一遍。
    occupied.push(span);
    if (parsed.kind === "unknown") {
      addUnknown(raw);
      return;
    }
    if (seen.has(parsed.normalized)) return;
    seen.add(parsed.normalized);
    candidates.push({ kind, value: parsed.normalized, span });
  };

  // 1) URL 优先：整段占位，避免里面的 host/IP 重复出现。
  for (const m of text.matchAll(URL_RE)) {
    const rawWithPunct = m[0];
    const url = trimUrl(rawWithPunct);
    if (!url) continue;
    const start = m.index ?? 0;
    const span: Span = [start, start + url.length];
    if (overlaps(span, occupied)) continue;
    const parsed = parseTarget(url);
    addCandidate(parsed, url, span, "url");
  }

  // 2) CIDR：支持主机位写法，规范化后按网络地址保存。
  for (const m of text.matchAll(CIDR_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const span: Span = [start, start + raw.length];
    if (overlaps(span, occupied)) continue;
    addCandidate(parseTarget(raw), raw, span, "cidr");
  }

  // 3) host:port。host 可以是 IPv4、域名或 localhost。
  for (const m of text.matchAll(HOST_PORT_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const span: Span = [start, start + raw.length];
    if (overlaps(span, occupied)) continue;
    addCandidate(parseTarget(raw), raw, span, "host");
  }

  // 4) 裸 IPv4。lookaround 已排除 CIDR 内部、五段数字和路径片段。
  for (const m of text.matchAll(IPV4_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const span: Span = [start, start + raw.length];
    if (overlaps(span, occupied)) continue;
    addCandidate(parseTarget(raw), raw, span, "host");
  }

  // 5) 裸域名：默认关闭，显式 allowlist 才提取。
  const allowlist = options.bareDomainAllowlist ?? [];
  if (allowlist.length > 0) {
    for (const m of text.matchAll(DOMAIN_RE)) {
      const raw = m[0];
      const start = m.index ?? 0;
      const span: Span = [start, start + raw.length];
      if (overlaps(span, occupied)) continue;
      const parsed = parseTarget(raw);
      if (parsed.kind !== "host") continue;
      if (!domainAllowed(parsed.normalized, allowlist)) continue;
      addCandidate(parsed, raw, span, "host");
    }
  }

  candidates.sort((a, b) => a.span[0] - b.span[0]);
  return { candidates, unknowns };
}
