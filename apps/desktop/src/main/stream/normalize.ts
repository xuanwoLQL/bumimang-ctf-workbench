/**
 * ACP `session/update` → 契约 `StreamUpdate` 的归一化（主进程侧）。
 *
 * 为什么从 hub.ts 抽出来：会话管理器现在要把**同一份**归一化结果持久化到
 * `sessions/<id>/stream.jsonl`（R16 对话历史），如果管理器自己再写一套，
 * 重启后回放出来的块类型会和实时流不一致。归一化只能有一份。
 */

import type { AnswerSpec, StreamUpdate } from "../../../../../packages/shared-protocol/events.ts";
import { DEFAULT_FLAG_PATTERN, detectAnswers, extractFlagCompat, type AnswerHit } from "../answer/index.ts";

/**
 * 旧 API 兼容：默认 flag 正则（大小写不敏感）。
 * V2-P0-2 起真正的检测在 main/answer/*；这里只保留导出的正则形状，禁止另写一套检测。
 */
export const FLAG_RE = new RegExp(DEFAULT_FLAG_PATTERN, "i");

export function extractFlag(text: string | undefined | null): string | null {
  return extractFlagCompat(text);
}

/** V2-P0-2：按任务 AnswerSpec 从文本提取全部候选（带行号/偏移/证据等级）。 */
export function extractAnswers(
  text: string | undefined | null,
  spec: AnswerSpec,
  maxHits = 200,
): AnswerHit[] {
  return detectAnswers(text, spec, { evidence: "E0", maxHits });
}

/** 把 ACP 的 session/update 归一化成 UI 能直接吃的 StreamUpdate（§契约） */
export function normalizeUpdate(raw: Record<string, unknown>): StreamUpdate | null {
  const kind = String(raw.sessionUpdate ?? "");
  const ts = Date.now();
  const content = raw.content as Record<string, unknown> | undefined;
  const textFrom = (): string | undefined => {
    const t = content?.text;
    return typeof t === "string" ? t : undefined;
  };
  switch (kind) {
    case "agent_message_chunk":
      return { ts, kind: "agent_message", text: textFrom() };
    case "agent_thought_chunk":
      return { ts, kind: "agent_thought", text: textFrom() };
    case "tool_call":
      return {
        ts,
        kind: "tool_call",
        title: typeof raw.title === "string" ? raw.title : undefined,
        toolKind: typeof raw.kind === "string" ? raw.kind : undefined,
        status: typeof raw.status === "string" ? raw.status : undefined,
      };
    case "tool_call_update":
      return {
        ts,
        kind: "tool_call_update",
        title: typeof raw.title === "string" ? raw.title : undefined,
        status: typeof raw.status === "string" ? raw.status : undefined,
      };
    case "plan":
      return { ts, kind: "plan", text: JSON.stringify(raw).slice(0, 200) };
    case "user_prompt":
      return { ts, kind: "user_prompt", text: textFrom() ?? (typeof raw.text === "string" ? raw.text : undefined) };
    default:
      return kind ? { ts, kind: "other", text: kind } : null;
  }
}

/**
 * R25（A7）：把敏感凭据从日志/流文本里打码。
 *
 * 简报会把 mcpServers 的 env（含 BUMIMANG_TOKEN）带进 prompt，agent 也可能回显环境——
 * 实测 A/B 的 4 个 wire.jsonl 里全部有令牌。所有落盘（wire/stream）与进内存历史前都过这里。
 */
export function redactSecrets(s: string): string {
  // 覆盖两种形态：env 的 `BUMIMANG_TOKEN=<hex>` 与 JSON 的 `"name":"BUMIMANG_TOKEN","value":"<hex>"`。
  // 用非贪婪通配跨过中间包装（"value" 里含 a/e 这类 hex 字符，字符排除法会卡死），
  // 以「≥16 位连续 hex」作为令牌值的判据。
  return s.replace(/BUMIMANG_TOKEN[\s\S]{0,64}?[0-9a-f]{16,}/gi, "BUMIMANG_TOKEN=***");
}
