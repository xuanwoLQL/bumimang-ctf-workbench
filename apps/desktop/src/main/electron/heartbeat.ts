/**
 * P6-C 2.7a / D7a：renderer 心跳解析与分类。
 *
 * renderer 每 5s 上报：
 *   [renderer heartbeat] visibility=hidden prevVisibility=visible gapMs=60001 throttled=1
 *
 * 分类规则：
 * - hidden 或 prevVisibility=hidden → throttled-hidden（Chromium 后台 timer 节流，不是 stall）；
 * - visible/visible 且 gap > 15s → stall（renderer 自己测到的真实长 gap）；
 * - 旧格式没有字段 → unknown/none，保持兼容。
 *
 * 这个模块只做纯函数，方便 verify/临时 harness 直接测试；不改变任何 UI/调度行为。
 */

export type RendererVisibility = "visible" | "hidden" | "unknown";

export interface RendererHeartbeat {
  visibility: RendererVisibility;
  gapMs: number | null;
  throttled: boolean;
}

export type HeartbeatEventKind = "none" | "throttled-hidden" | "stall";
export type HeartbeatMissingKind = "none" | "throttled-hidden" | "stall" | "missing-unknown";

export function parseRendererHeartbeat(message: string): RendererHeartbeat | null {
  if (!message.includes("[renderer heartbeat]")) return null;
  const vis = /(?:^|\s)visibility=(visible|hidden)(?:\s|$)/.exec(message)?.[1];
  const gapRaw = /(?:^|\s)gapMs=([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(message)?.[1];
  const throttled = /(?:^|\s)throttled=1(?:\s|$)/.test(message);
  return {
    visibility: (vis as RendererVisibility | undefined) ?? "unknown",
    gapMs: gapRaw == null ? null : Number(gapRaw),
    throttled,
  };
}

export function classifyHeartbeatEvent(
  hb: RendererHeartbeat,
  thresholdMs = 15_000,
): HeartbeatEventKind {
  if (hb.gapMs == null || hb.gapMs <= thresholdMs) return "none";
  return hb.throttled || hb.visibility === "hidden" ? "throttled-hidden" : "stall";
}

export function classifyHeartbeatMissing(
  visibility: RendererVisibility,
  missingMs: number,
  thresholdMs = 15_000,
): HeartbeatMissingKind {
  if (missingMs <= thresholdMs) return "none";
  if (visibility === "hidden") return "throttled-hidden";
  if (visibility === "visible") return "stall";
  return "missing-unknown";
}
