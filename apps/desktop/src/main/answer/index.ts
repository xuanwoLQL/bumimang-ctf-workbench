/**
 * V2-P0-2：统一答案注册表入口。
 *
 * 主进程其它模块只从这里取答案检测/扫描能力，避免再出现第二套正则。
 */

export {
  ANSWER_MODES,
  ANSWER_TYPES,
  ANSWER_NORMALIZERS,
  DEFAULT_ANSWER_SPEC,
  DEFAULT_FLAG_PATTERN,
  DEFAULT_SPEC_ID,
  answerSpecId,
  parseAnswerSpec,
  renderAnswerTemplate,
  validateAnswerSpec,
  type AnswerSpecValidation,
} from "./spec.ts";
export {
  detectAnswers,
  extractFlagCompat,
  compileAnswerSpec,
  type AnswerHit,
  type AnswerDetectContext,
  type CompiledAnswerSpec,
} from "./detectors.ts";
export {
  DEFAULT_SCAN_LIMITS,
  scanAttachmentAnswers,
  scanBufferAnswers,
  scanTextFile,
  scanZipAnswers,
  type AnswerFileHit,
  type FileScanResult,
  type ScanLimits,
} from "./file-scan.ts";
export { applyNormalizers, canonicalAnswer } from "./normalize.ts";
