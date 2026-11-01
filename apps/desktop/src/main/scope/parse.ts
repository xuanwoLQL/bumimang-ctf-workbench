/**
 * 目标解析（P4-B，纯函数）。
 *
 * 只做语法解析与规范化：
 *  - IPv4 / IPv4 CIDR（IPv6 明确返回 unknown + `ipv6-not-supported`）；
 *  - URL（提取 host，保留显式端口；不查 DNS）；
 *  - host:port、裸域名、localhost。
 *
 * **不读 DB / config，不调外部服务，不做策略判定。**
 * 解析失败一律返回 `kind=unknown` + 可读 `reason`，不抛错、不误判成 IPv4/host。
 */

export interface ParsedTarget {
  kind: "host" | "cidr" | "url" | "unknown";
  normalized: string;
  reason?: string;
}

const MAX_RAW_LENGTH = 4096;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const URL_SCHEMES = new Set(["http:", "https:", "ftp:", "ws:", "wss:"]);

function unknown(reason: string): ParsedTarget {
  return { kind: "unknown", normalized: "", reason };
}

/** 严格 IPv4：四段十进制、每段 0–255、拒绝前导零（避免八进制歧义）。 */
function parseIpv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipv4ToString(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function parsePort(s: string): string | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  if (n < 1 || n > 65535) return null;
  return String(n);
}

/** 主机名：ASCII、label 1–63、不以连字符开头/结尾、TLD 不能全数字。 */
function normalizeHostname(raw: string): string | null {
  let host = raw.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  const labels = host.split(".");
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH) return null;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  // 单标签主机名只有 localhost 有明确语义；命令里的裸单词/参数太容易误判成 host。
  if (labels.length === 1 && labels[0] !== "localhost") return null;
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return null; // 1.2.3 / 999.999 这类版本/数字串不当域名
  return host;
}

/** host[:port]；host 可以是 IPv4 或域名。 */
function parseHostPort(raw: string): ParsedTarget {
  const colon = raw.indexOf(":");
  if (colon < 0) {
    if (/^\d+(?:\.\d+){3}$/.test(raw)) {
      return parseIpv4(raw) === null ? unknown("invalid-ipv4") : { kind: "host", normalized: raw };
    }
    const host = normalizeHostname(raw);
    return host ? { kind: "host", normalized: host } : unknown("invalid-host");
  }
  if (raw.indexOf(":", colon + 1) >= 0) return unknown("ipv6-not-supported");
  const hostPart = raw.slice(0, colon);
  const portPart = raw.slice(colon + 1);
  if (!hostPart || !portPart) return unknown("invalid-host");
  const port = parsePort(portPart);
  if (!port) return unknown("invalid-port");
  if (/^\d+(?:\.\d+){3}$/.test(hostPart)) {
    if (parseIpv4(hostPart) === null) return unknown("invalid-ipv4");
    return { kind: "host", normalized: `${hostPart}:${port}` };
  }
  const host = normalizeHostname(hostPart);
  return host ? { kind: "host", normalized: `${host}:${port}` } : unknown("invalid-host");
}

function parseCidr(raw: string): ParsedTarget {
  const slash = raw.indexOf("/");
  if (slash < 0 || raw.indexOf("/", slash + 1) >= 0) return unknown("invalid-cidr");
  const ipPart = raw.slice(0, slash);
  const prefixPart = raw.slice(slash + 1);
  if (ipPart.includes(":")) return unknown("ipv6-not-supported");
  const ip = parseIpv4(ipPart);
  if (ip === null) return unknown("invalid-cidr");
  if (!/^(0|[1-9]|[12]\d|3[0-2])$/.test(prefixPart)) return unknown("invalid-cidr");
  const prefix = Number(prefixPart);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { kind: "cidr", normalized: `${ipv4ToString((ip & mask) >>> 0)}/${prefix}` };
}

function parseUrl(raw: string): ParsedTarget {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(raw);
  if (!m) return unknown("invalid-url");
  const scheme = `${m[1]!.toLowerCase()}:`;
  if (!URL_SCHEMES.has(scheme)) return unknown("unsupported-scheme");
  let authority = m[2]!;
  if (!authority) return unknown("invalid-url");
  // userinfo 不属于目标；取最后一个 @ 之后。
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  if (!authority) return unknown("invalid-url");
  if (authority.startsWith("[") || authority.includes("[")) return unknown("ipv6-not-supported");
  const hp = parseHostPort(authority);
  if (hp.kind === "unknown") return hp;
  return { kind: "url", normalized: hp.normalized };
}

/**
 * 解析单个目标。
 *
 * 规范化结果：
 *  - IPv4 → `a.b.c.d`；IPv4 CIDR → 掩码后的 `network/prefix`；
 *  - host:port → 小写 host + 规范端口；URL → 提取 host[:port]（保留显式端口）；
 *  - 非法/不支持 → `unknown` + reason。
 */
export function parseTarget(value: string): ParsedTarget {
  if (typeof value !== "string") return unknown("not-a-string");
  if (!value) return unknown("empty");
  if (value.length > MAX_RAW_LENGTH) return unknown("too-long");
  if (value.includes("\0")) return unknown("nul");
  if (/\s/.test(value)) return unknown("whitespace");
  if (/[^\x21-\x7e]/.test(value)) return unknown("non-ascii");

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return parseUrl(value);

  // 非 URL 的 IPv6（裸 ::1、[::1]:80 等）明确标记不支持，不落到 host。
  if (
    value.startsWith("[") ||
    value.includes("[") ||
    (value.includes(":") && value.split(":").length > 2)
  ) {
    return unknown("ipv6-not-supported");
  }

  if (value.includes("/")) return parseCidr(value);
  return parseHostPort(value);
}

/**
 * 判断一个已解析的 host 是否是 IPv4（用于 CIDR 匹配）。
 * 端口会被忽略；域名返回 null（不查 DNS）。
 */
export function ipv4OfHost(host: string): string | null {
  const withoutPort = host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
  return parseIpv4(withoutPort) === null ? null : withoutPort;
}
