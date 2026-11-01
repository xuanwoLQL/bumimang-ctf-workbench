/**
 * V2-P0-4：IR 分析器注册表与统一结果模型。
 *
 * 所有分析器只产生候选/证据，不确认、不提交；外部工具通过 ctx.runCommand
 * （安全参数数组）调用，缺失工具返回可读 warning。
 */

import type { AnswerType, EvidenceLevel } from "../../../../../packages/shared-protocol/events.ts";
import type { IrCommandResult } from "./spawn.ts";

export type IrInputKind = "file" | "dir";

export interface IrInput {
  taskId: string;
  /** 任务工作目录（绝对路径）；所有路径必须在此目录内。 */
  workDir: string;
  /** 绝对路径；目录分析时 kind=dir。 */
  absolutePath: string;
  /** 任务内 POSIX 相对路径（用于 witness/来源）。 */
  relativePath: string;
  kind: IrInputKind;
  size?: number;
  sha256?: string;
}

export interface IrLimits {
  maxBytesPerFile: number;
  maxTimeline: number;
  maxIocs: number;
  maxFacts: number;
  maxWarnings: number;
  maxFiles: number;
  maxDepth: number;
  toolTimeoutMs: number;
  maxToolOutputBytes: number;
}

export const DEFAULT_IR_LIMITS: IrLimits = {
  maxBytesPerFile: 8 * 1024 * 1024,
  maxTimeline: 2000,
  maxIocs: 500,
  maxFacts: 500,
  maxWarnings: 100,
  maxFiles: 500,
  maxDepth: 4,
  toolTimeoutMs: 20_000,
  maxToolOutputBytes: 4 * 1024 * 1024,
};

export interface IrStructuredFact {
  schema: string;
  data: Record<string, unknown>;
  evidence: EvidenceLevel;
  witness?: string | null;
}

export interface IrTimelineEvent {
  at: number;
  source: string;
  event: string;
  impact?: string;
  evidence: EvidenceLevel;
  witness?: string | null;
}

export interface IrIoc {
  type:
    | "ip"
    | "domain"
    | "url"
    | "account"
    | "process"
    | "command"
    | "path"
    | "hash"
    | "other";
  value: string;
  count: number;
  firstSeen?: number;
  evidence: EvidenceLevel;
  witness?: string | null;
}

export interface IrAnswerCandidate {
  questionId?: string;
  question?: string;
  field?: AnswerType;
  value: string;
  answerType: AnswerType;
  confidence: number;
  evidence: EvidenceLevel;
  witness?: string | null;
  sources?: string[];
  gaps?: string[];
}

export interface IrToolLog {
  tool: string;
  argv: string[];
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  version?: string;
}

export interface IrAnalysisResult {
  analyzerId: string;
  analyzerTitle: string;
  input: IrInput;
  facts: IrStructuredFact[];
  timeline: IrTimelineEvent[];
  iocs: IrIoc[];
  answerCandidates: IrAnswerCandidate[];
  warnings: string[];
  toolLogs: IrToolLog[];
}

export interface IrContext {
  taskId: string;
  workDir: string;
  now: number;
  limits: IrLimits;
  runCommand: (command: string, args: string[], opts?: { timeoutMs?: number; maxOutputBytes?: number }) => Promise<IrCommandResult>;
  resolveTool: (envVar: string, defaultName: string) => string | null;
  audit?: (action: string, detail: Record<string, unknown>) => void;
  log?: (line: string) => void;
}

export interface IrAnalyzer {
  id: string;
  title: string;
  detect(input: IrInput, ctx: IrContext): boolean | Promise<boolean>;
  analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult>;
}

export function emptyResult(analyzer: IrAnalyzer, input: IrInput): IrAnalysisResult {
  return {
    analyzerId: analyzer.id,
    analyzerTitle: analyzer.title,
    input,
    facts: [],
    timeline: [],
    iocs: [],
    answerCandidates: [],
    warnings: [],
    toolLogs: [],
  };
}

export class IrRegistry {
  private analyzers = new Map<string, IrAnalyzer>();

  register(analyzer: IrAnalyzer): this {
    if (this.analyzers.has(analyzer.id)) throw new Error(`IR 分析器重复注册：${analyzer.id}`);
    this.analyzers.set(analyzer.id, analyzer);
    return this;
  }

  list(): IrAnalyzer[] {
    return [...this.analyzers.values()];
  }

  get(id: string): IrAnalyzer | undefined {
    return this.analyzers.get(id);
  }

  async detect(input: IrInput, ctx: IrContext): Promise<IrAnalyzer[]> {
    const out: IrAnalyzer[] = [];
    for (const a of this.analyzers.values()) {
      try {
        if (await a.detect(input, ctx)) out.push(a);
      } catch (err) {
        ctx.log?.(`[ir] 分析器 ${a.id} detect 失败：${(err as Error).message}`);
      }
    }
    return out;
  }
}

export function toolLogFromResult(tool: string, result: IrCommandResult): IrToolLog {
  return {
    tool,
    argv: result.argv,
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
  };
}
