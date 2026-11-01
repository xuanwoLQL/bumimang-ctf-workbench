/** V2-P0-4：IR 分析器入口。 */
export {
  DEFAULT_IR_LIMITS,
  IrRegistry,
  emptyResult,
  toolLogFromResult,
  type IrAnalysisResult,
  type IrAnalyzer,
  type IrAnswerCandidate,
  type IrContext,
  type IrInput,
  type IrInputKind,
  type IrIoc,
  type IrLimits,
  type IrStructuredFact,
  type IrTimelineEvent,
  type IrToolLog,
} from "./registry.ts";
export { collectIrInputs, runIrAnalysis, readTextHead, looksText, type CollectInputsResult, type IrAnalysisBundle } from "./analyzer.ts";
export { findExecutable, resolveTool, runCommandSafe, sha256File, type IrCommandResult } from "./spawn.ts";
export { textLogAnalyzer, parseTimestamp } from "./analyzers/text-log.ts";
export { webshellAnalyzer } from "./analyzers/webshell.ts";
export { filesystemAnalyzer } from "./analyzers/filesystem.ts";
export { zipAnalyzer } from "./analyzers/zip.ts";
export { pcapAnalyzer, parseTsharkCsv, parseTsharkCsvLine, buildTsharkArgs, PCAP_TSHARK_FIELDS } from "./analyzers/pcap.ts";
export { evtxAnalyzer, parseEvtxCsv } from "./analyzers/evtx.ts";
export { memoryAnalyzer, parseVolPslist, parseVolNetscan } from "./analyzers/memory.ts";
export { parseIrQuestions, mapQuestionCandidates, type IrQuestion } from "./questions.ts";
export {
  IR_TOOL_ENV,
  loadIrToolConfig,
  resolveIrTool,
  createIrToolResolver,
  type IrToolKey,
  type IrToolPaths,
  type IrToolResolution,
  type IrToolConfigSource,
  type LoadedIrToolConfig,
} from "./tool-config.ts";

import { IrRegistry } from "./registry.ts";
import { textLogAnalyzer } from "./analyzers/text-log.ts";
import { webshellAnalyzer } from "./analyzers/webshell.ts";
import { filesystemAnalyzer } from "./analyzers/filesystem.ts";
import { zipAnalyzer } from "./analyzers/zip.ts";
import { pcapAnalyzer } from "./analyzers/pcap.ts";
import { evtxAnalyzer } from "./analyzers/evtx.ts";
import { memoryAnalyzer } from "./analyzers/memory.ts";

/** 内置分析器集合（不含外部工具也能工作的文本/Webshell/文件系统/ZIP）。 */
export function createDefaultIrRegistry(): IrRegistry {
  return new IrRegistry()
    .register(textLogAnalyzer)
    .register(webshellAnalyzer)
    .register(filesystemAnalyzer)
    .register(zipAnalyzer)
    .register(pcapAnalyzer)
    .register(evtxAnalyzer)
    .register(memoryAnalyzer);
}
