/**
 * 目标匹配（P4-B，纯函数）。
 *
 * 输入是显式的目标列表 + 一个待判定目标，输出 `in` / `out` / `unknown`。
 * 这是给 P4-C 策略层用的**数据**，不是 block/allow 判定。
 *
 * 规则：
 *  - IPv4 CIDR：按位包含；端口不参与；
 *  - host / host:port / URL：host 不区分大小写；target 带端口时 candidate 必须同端口，
 *    target 不带端口时接受任意端口；
 *  - denyTargets 优先于 targets；
 *  - 域名无法与 CIDR 判定（不查 DNS）→ unknown，而不是猜测。
 *
 * 不读 DB、不读 config、不调外部服务，不做策略判定。
 */

import type { TargetView } from "../../../../../packages/shared-protocol/events.ts";
import { ipv4OfHost, parseTarget } from "./parse.ts";

export type MatchVerdict = "in" | "out" | "unknown";

export interface MatchResult {
  verdict: MatchVerdict;
  /** 命中的 raw target / deny 值（未命中时缺省）。 */
  matchedBy?: string;
  reason?: string;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function splitHostPort(value: string): { host: string; port: string | null } {
  const i = value.indexOf(":");
  if (i < 0) return { host: value, port: null };
  return { host: value.slice(0, i), port: value.slice(i + 1) };
}

/** IPv4 CIDR 是否包含某个 IPv4；非法输入一律 false。 */
export function cidrContains(cidr: string, ip: string): boolean {
  if (ip.includes(":")) return false; // 端口或 IPv6 都不是 cidrContains 的输入
  const parsedCidr = parseTarget(cidr);
  if (parsedCidr.kind !== "cidr") return false;
  const parsedIp = parseTarget(ip);
  if (parsedIp.kind !== "host" || parsedIp.normalized !== ip) return false;
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  const slash = parsedCidr.normalized.lastIndexOf("/");
  const netInt = ipv4ToInt(parsedCidr.normalized.slice(0, slash));
  const prefix = Number(parsedCidr.normalized.slice(slash + 1));
  if (netInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((netInt & mask) >>> 0);
}

interface Candidate {
  host: string;
  port: string | null;
  isIpv4: boolean;
}

function candidateOf(normalized: string): Candidate {
  const { host, port } = splitHostPort(normalized);
  return { host: host.toLowerCase(), port, isIpv4: ipv4OfHost(host) !== null };
}

type TargetMatch = "match" | "no" | "unresolved";

function targetMatches(target: ReturnType<typeof parseTarget>, candidate: Candidate): TargetMatch {
  if (target.kind === "cidr") {
    if (!candidate.isIpv4) return "unresolved";
    return cidrContains(target.normalized, candidate.host) ? "match" : "no";
  }
  if (target.kind !== "host" && target.kind !== "url") return "no";
  const t = candidateOf(target.normalized);
  if (t.host !== candidate.host) return "no";
  // target 显式带端口时，candidate 必须同端口；target 无端口则接受任意端口。
  if (t.port !== null && t.port !== candidate.port) return "no";
  return "match";
}

/**
 * 匹配一个候选目标。
 *
 * `denyTargets` 是显式拒绝值（P4-A 的 tasks.deny_targets），可为空。
 * 返回 `in` 表示命中授权目标且未被 deny；`out` 表示明确不在范围内；
 * `unknown` 表示无法判定（候选非法、域名 vs CIDR、目标列表全非法）。
 */
export function matchTargets(
  targets: TargetView[],
  candidate: { kind: string; value: string },
  denyTargets: string[] = [],
): MatchResult {
  if (candidate.kind === "unknown") {
    return { verdict: "unknown", reason: "candidate-kind-unknown" };
  }
  const parsedCandidate = parseTarget(candidate.value);
  if (parsedCandidate.kind === "unknown") {
    return { verdict: "unknown", reason: `candidate-${parsedCandidate.reason ?? "invalid"}` };
  }
  if (parsedCandidate.kind === "cidr") {
    return { verdict: "unknown", reason: "candidate-is-cidr" };
  }
  const c = candidateOf(parsedCandidate.normalized);

  // 1) deny 优先。deny CIDR 对域名无法判定时保持 unknown，不猜。
  let denyUnresolved: string | undefined;
  for (const raw of denyTargets) {
    const d = parseTarget(raw);
    if (d.kind === "unknown") continue;
    const res = targetMatches(d, c);
    if (res === "match") {
      return { verdict: "out", matchedBy: raw, reason: "denied-by-deny-target" };
    }
    if (res === "unresolved") denyUnresolved = raw;
  }
  if (denyUnresolved !== undefined) {
    return { verdict: "unknown", matchedBy: denyUnresolved, reason: "deny-target-unresolved" };
  }

  // 2) 授权目标。列表为空 = 没有授权任何目标，明确 out；
  //    列表非空但全部解析失败 = unknown（配置坏了，不猜测）。
  if (targets.length === 0) return { verdict: "out", reason: "no-targets" };
  let validTargets = 0;
  let allowUnresolved = false;
  for (const target of targets) {
    const t = parseTarget(target.value);
    if (t.kind === "unknown") continue;
    validTargets++;
    const res = targetMatches(t, c);
    if (res === "match") {
      return { verdict: "in", matchedBy: target.value, reason: "matched-target" };
    }
    if (res === "unresolved") allowUnresolved = true;
  }

  if (validTargets === 0) {
    return { verdict: "unknown", reason: "no-valid-targets" };
  }
  if (allowUnresolved) {
    return { verdict: "unknown", reason: "hostname-cannot-match-cidr" };
  }
  return { verdict: "out", reason: "not-in-targets" };
}
