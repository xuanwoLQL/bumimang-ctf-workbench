/**
 * V2-P0-2：附件答案扫描兼容层。
 *
 * 旧 API `scanAttachmentForFlags` 保留，内部走统一的 AnswerSpec 检测器；
 * 默认仍是 `flag{...}`，因此旧行为不变。新代码应直接用 main/answer/file-scan。
 *
 * 边界：
 *  - 只读；路径走 preview.resolveWithinTask；
 *  - 文本嗅探后分块扫描；二进制跳过（ZIP 走统一扫描器枚举）；
 *  - 返回候选，不落库、不确认、不提交。
 */

import type { AnswerSpec } from "../../../../../packages/shared-protocol/events.ts";
import { DEFAULT_ANSWER_SPEC, scanAttachmentAnswers } from "../answer/index.ts";

export interface FlagScanHit {
  /** 任务内 POSIX 相对路径 */
  relativePath: string;
  /** 实际命中的答案原文（保留大小写） */
  match: string;
  /** V2-P0-2：行号/字节偏移/类型/归一化值；旧调用方可忽略。 */
  line?: number;
  offset?: number;
  answerType?: string;
  normalizedValue?: string;
}

/**
 * 扫描一个任务内文本附件。返回去重后的命中（按首次出现顺序）。
 * 文件不存在/越界/symlink 会抛 ArtifactPathError；非文本返回空数组。
 */
export async function scanAttachmentForFlags(input: {
  taskDir: string;
  relativePath: string;
  maxBytes?: number;
  /** V2-P0-2：任务 AnswerSpec；缺省按默认 flag 规则。 */
  answerSpec?: AnswerSpec;
}): Promise<FlagScanHit[]> {
  const res = await scanAttachmentAnswers({
    taskDir: input.taskDir,
    relativePath: input.relativePath,
    spec: input.answerSpec ?? DEFAULT_ANSWER_SPEC,
    limits: input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : undefined,
  });
  return res.hits.map((h) => ({
    relativePath: h.relativePath,
    match: h.value,
    ...(h.line !== undefined ? { line: h.line } : {}),
    ...(h.offset !== undefined ? { offset: h.offset } : {}),
    ...(h.answerType ? { answerType: h.answerType } : {}),
    ...(h.normalizedValue ? { normalizedValue: h.normalizedValue } : {}),
  }));
}
