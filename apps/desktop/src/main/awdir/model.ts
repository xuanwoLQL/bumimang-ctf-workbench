/**
 * WP9-A：AWD / IR 只读模型派生（纯函数，无 DB/Electron/fs/网络）。
 *
 * 输入是现有 Hub 快照的 facts/targets/flags/attachments/artifacts；
 * 输出是可选 AwdView/IrView。结构化 fact 约定：
 *   content = {"schema":"awd.round","v":1,...}
 * 解析失败/字段缺失只记 warning + 跳过该条，不猜、不抛错。
 */
import type {
  ArtifactView,
  AttachmentView,
  AwdAttackView,
  AwdCheckView,
  AwdFlagRoundView,
  AwdPatchView,
  AwdRoundView,
  AwdServiceView,
  AwdView,
  EvidenceLevel,
  FactView,
  FlagCandidateView,
  IrEvidenceView,
  IrQuestionView,
  IrTimelineView,
  IrView,
  ScoreboardView,
  SessionView,
  TargetStatus,
  TargetView,
} from "../../../../../packages/shared-protocol/events.ts";

interface StructuredFact {
  fact: FactView;
  schema: string;
  data: Record<string, unknown>;
}

export interface AwdModelInput {
  taskId: string;
  facts: FactView[];
  targets: TargetView[];
  flags: FlagCandidateView[];
  sessions?: SessionView[];
  scoreboard?: ScoreboardView;
}

export interface IrModelInput {
  taskId: string;
  facts: FactView[];
  attachments?: AttachmentView[];
  artifacts?: ArtifactView[];
  /** V2-P0-4：IR 答案候选存在 flag_candidates；视图从这里取候选值。 */
  flags?: FlagCandidateView[];
}

export interface AwdModelResult {
  view: AwdView;
  warnings: string[];
}
export interface IrModelResult {
  view: IrView;
  warnings: string[];
}

const EVIDENCE: EvidenceLevel[] = ["E0", "E1", "E2"];
const TARGET_STATUS: TargetStatus[] = ["unknown", "alive", "owned"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}
function evidence(v: unknown): EvidenceLevel | null {
  return typeof v === "string" && (EVIDENCE as string[]).includes(v) ? (v as EvidenceLevel) : null;
}
function targetStatus(v: unknown): TargetStatus | null {
  if (typeof v === "string" && (TARGET_STATUS as string[]).includes(v)) return v as TargetStatus;
  if (v === "up") return "alive";
  if (v === "down") return "unknown";
  return null;
}

function parseStructured(fact: FactView, warnings: string[]): StructuredFact | null {
  const text = fact.content.trim();
  if (!text.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    if (text.includes('"schema":"awd.') || text.includes('"schema":"ir.')) {
      warnings.push(`${fact.id}: JSON 解析失败（结构化 fact）`);
    }
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const schema = str(obj.schema);
  if (!schema || (!schema.startsWith("awd.") && !schema.startsWith("ir."))) return null;
  if (obj.v !== undefined && obj.v !== 1) {
    warnings.push(`${fact.id}: 不支持的 schema 版本 ${String(obj.v)}（${schema}）`);
    return null;
  }
  return { fact, schema, data: obj };
}

function sortedStructured(facts: FactView[], warnings: string[]): StructuredFact[] {
  const out: StructuredFact[] = [];
  for (const f of facts) {
    const p = parseStructured(f, warnings);
    if (p) out.push(p);
  }
  return out;
}

/**
 * AWD 只读聚合。
 * - round：取 round 号最大的 awd.round fact；
 * - services：targets 为主，awd.service fact 按 target/name enrich；无 target 的 fact 也列出；
 * - flags：awd.flag fact 映射 candidateId→round；未映射归 round=0；
 * - patches/checks/attacks：逐条结构化 fact。
 */
export function parseAwdFacts(input: AwdModelInput): AwdModelResult {
  const warnings: string[] = [];
  const structured = sortedStructured(input.facts, warnings);
  const bySchema = (schema: string): StructuredFact[] => structured.filter((s) => s.schema === schema);

  let round: AwdRoundView | null = null;
  for (const s of bySchema("awd.round")) {
    const number = int(s.data.round) ?? 1;
    const startedAt = num(s.data.startedAt) ?? 0;
    const duration = num(s.data.durationMs);
    const endsAt = num(s.data.endsAt) ?? (duration !== null ? startedAt + duration : startedAt);
    const rawState = str(s.data.state);
    const state: AwdRoundView["state"] =
      rawState === "idle" || rawState === "running" || rawState === "ended"
        ? rawState
        : endsAt > 0
          ? "ended"
          : "idle";
    if (startedAt <= 0) warnings.push(`${s.fact.id}: awd.round 缺 startedAt`);
    if (!round || number >= round.number) {
      round = { number, startedAt, endsAt, state };
    }
  }

  const serviceFacts = bySchema("awd.service").map((s) => ({
    id: s.fact.id,
    name: str(s.data.name) ?? str(s.data.target) ?? s.fact.id,
    target: str(s.data.target) ?? str(s.data.name) ?? "",
    status: targetStatus(s.data.status),
    ownerSessionId: str(s.data.ownerSessionId),
    patchStatus: str(s.data.patchStatus),
  }));
  const sessionIds = new Set((input.sessions ?? []).map((s) => s.id));
  const used = new Set<string>();
  const services: AwdServiceView[] = [];
  for (const t of input.targets) {
    const f =
      serviceFacts.find((x) => !used.has(x.id) && (x.target === t.value || x.name === t.value)) ?? null;
    if (f) used.add(f.id);
    if (f?.ownerSessionId && sessionIds.size > 0 && !sessionIds.has(f.ownerSessionId)) {
      warnings.push(`${f.id}: ownerSessionId ${f.ownerSessionId} 不在当前会话列表`);
    }
    services.push({
      id: t.id,
      name: f?.name ?? t.value,
      target: t.value,
      status: f?.status ?? t.status,
      ownerSessionId: f?.ownerSessionId ?? null,
      patchStatus: f?.patchStatus ?? null,
    });
  }
  for (const f of serviceFacts) {
    if (used.has(f.id)) continue;
    if (!f.target && !f.name) continue;
    services.push({
      id: `awd-service:${f.id}`,
      name: f.name,
      target: f.target,
      status: f.status ?? "unknown",
      ownerSessionId: f.ownerSessionId ?? null,
      patchStatus: f.patchStatus ?? null,
    });
  }

  const roundOf = new Map<string, number>();
  for (const s of bySchema("awd.flag")) {
    const candidateId = str(s.data.candidateId);
    const n = int(s.data.round);
    if (!candidateId || n === null) {
      warnings.push(`${s.fact.id}: awd.flag 缺 candidateId/round`);
      continue;
    }
    roundOf.set(candidateId, n);
  }
  const groups = new Map<number, FlagCandidateView[]>();
  for (const f of input.flags) {
    const n = roundOf.get(f.id) ?? 0;
    if (roundOf.has(f.id)) roundOf.delete(f.id);
    const list = groups.get(n) ?? [];
    list.push(f);
    groups.set(n, list);
  }
  for (const leftover of roundOf.keys()) warnings.push(`awd.flag: candidate ${leftover} 不存在`);
  const flags: AwdFlagRoundView[] = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, candidates]) => ({
      round: n,
      candidates,
      confirmed: candidates.filter((c) => c.status === "confirmed").length,
      submitted: candidates.filter((c) => c.submittedAt != null).length,
    }));

  const patches: AwdPatchView[] = [];
  for (const s of bySchema("awd.patch")) {
    const service = str(s.data.service);
    const vuln = str(s.data.vuln);
    if (!service || !vuln) {
      warnings.push(`${s.fact.id}: awd.patch 缺 service/vuln`);
      continue;
    }
    const rawStatus = str(s.data.status);
    const status: AwdPatchView["status"] =
      rawStatus === "proposed" || rawStatus === "applied" || rawStatus === "verified" || rawStatus === "failed"
        ? rawStatus
        : "proposed";
    patches.push({
      id: s.fact.id,
      service,
      vuln,
      status,
      evidence: evidence(s.data.evidence) ?? "E0",
      witness: str(s.data.witness),
    });
  }

  const checks: AwdCheckView[] = [];
  for (const s of bySchema("awd.check")) {
    const item = str(s.data.item);
    if (!item) {
      warnings.push(`${s.fact.id}: awd.check 缺 item`);
      continue;
    }
    const rawStatus = str(s.data.status);
    const status: AwdCheckView["status"] =
      rawStatus === "ok" || rawStatus === "fail" || rawStatus === "todo" ? rawStatus : "todo";
    checks.push({
      round: int(s.data.round) ?? 0,
      item,
      status,
      evidence: str(s.data.evidence),
    });
  }

  const attacks: AwdAttackView[] = [];
  for (const s of bySchema("awd.attack")) {
    const attacker = str(s.data.attacker);
    const target = str(s.data.target);
    const action = str(s.data.action);
    const result = str(s.data.result);
    if (!attacker || !target || !action || !result) {
      warnings.push(`${s.fact.id}: awd.attack 缺 attacker/target/action/result`);
      continue;
    }
    attacks.push({
      id: s.fact.id,
      attacker,
      target,
      action,
      result,
      evidence: str(s.data.evidence),
      at: num(s.data.at) ?? 0,
    });
  }

  const view: AwdView = {
    taskId: input.taskId,
    round,
    services,
    flags,
    patches,
    checks,
    attacks,
    ...(input.scoreboard ? { scoreboard: input.scoreboard } : {}),
    warnings,
  };
  return { view, warnings };
}

/** IR 只读聚合：附件/工件 + ir.evidence/ir.timeline/ir.question。 */
export function parseIrFacts(input: IrModelInput): IrModelResult {
  const warnings: string[] = [];
  const structured = sortedStructured(input.facts, warnings);
  const bySchema = (schema: string): StructuredFact[] => structured.filter((s) => s.schema === schema);

  const evidence: IrEvidenceView[] = [];
  for (const a of input.attachments ?? []) {
    evidence.push({
      id: `attachment:${a.relativePath}`,
      kind: "attachment",
      path: a.relativePath,
      sha256: a.sha256,
      evidence: "E0",
      witness: null,
      source: a.source,
      addedAt: a.importedAt,
    });
  }
  for (const a of input.artifacts ?? []) {
    evidence.push({
      id: `artifact:${a.path}`,
      kind: a.kind,
      path: a.path,
      evidence: "E0",
      witness: null,
      source: "artifact",
      addedAt: a.mtime,
    });
  }
  for (const s of bySchema("ir.evidence")) {
    const path = str(s.data.path);
    if (!path) {
      warnings.push(`${s.fact.id}: ir.evidence 缺 path`);
      continue;
    }
    evidence.push({
      id: s.fact.id,
      kind: str(s.data.kind) ?? "fact",
      path,
      sha256: str(s.data.sha256) ?? undefined,
      evidence: evidenceOf(s.data.evidence),
      witness: str(s.data.witness),
      source: str(s.data.source) ?? "fact",
      addedAt: num(s.data.addedAt) ?? 0,
    });
  }

  const timeline: IrTimelineView[] = [];
  for (const s of bySchema("ir.timeline")) {
    const source = str(s.data.source);
    const event = str(s.data.event);
    if (!source || !event) {
      warnings.push(`${s.fact.id}: ir.timeline 缺 source/event`);
      continue;
    }
    timeline.push({
      id: s.fact.id,
      at: num(s.data.at) ?? 0,
      source,
      event,
      impact: str(s.data.impact) ?? undefined,
      evidence: str(s.data.evidence),
    });
  }
  timeline.sort((a, b) => a.at - b.at);

  const questions: IrQuestionView[] = [];
  for (const s of bySchema("ir.question")) {
    const question = str(s.data.question);
    if (!question) {
      warnings.push(`${s.fact.id}: ir.question 缺 question`);
      continue;
    }
    const rawStatus = str(s.data.status);
    const status: IrQuestionView["status"] =
      rawStatus === "answered" || rawStatus === "verified" || rawStatus === "open" ? rawStatus : "open";
    questions.push({
      id: str(s.data.id) ?? s.fact.id,
      question,
      status,
      answer: str(s.data.answer),
      evidence: str(s.data.evidence),
      candidates: [],
      gaps: [],
    });
  }

  // V2-P0-4：答案候选事实只存 candidateId/来源/缺口，不存明文；值从 flag_candidates 取。
  const flagsById = new Map((input.flags ?? []).map((f) => [f.id, f]));
  for (const s of bySchema("ir.answer_candidate")) {
    const questionId = str(s.data.questionId);
    const candidateId = str(s.data.candidateId);
    if (!questionId || !candidateId) {
      warnings.push(`${s.fact.id}: ir.answer_candidate 缺 questionId/candidateId`);
      continue;
    }
    const q = questions.find((x) => x.id === questionId);
    if (!q) {
      warnings.push(`${s.fact.id}: answer_candidate 指向不存在的问题 ${questionId}`);
      continue;
    }
    const flag = flagsById.get(candidateId);
    if (!flag) {
      warnings.push(`${s.fact.id}: answer_candidate 指向不存在的候选 ${candidateId}（可能已被清理）`);
      continue;
    }
    q.candidates = q.candidates ?? [];
    q.candidates.push({
      candidateId,
      value: flag.value,
      answerType: flag.answerType,
      confidence: num(s.data.confidence) ?? 0,
      evidence: evidenceOf(s.data.evidence),
      witness: flag.sources[0]?.witness ?? null,
      sources: strArray(s.data.sources),
      gaps: strArray(s.data.gaps),
    });
  }
  for (const s of bySchema("ir.answer_gap")) {
    const questionId = str(s.data.questionId);
    const q = questions.find((x) => x.id === questionId);
    if (!q) continue;
    q.gaps = [...new Set([...(q.gaps ?? []), ...strArray(s.data.gaps)])];
  }

  const analysis: NonNullable<IrView["analysis"]> = [];
  for (const s of bySchema("ir.analysis")) {
    analysis.push({
      analyzerId: str(s.data.analyzerId) ?? "unknown",
      input: str(s.data.input) ?? "",
      sha256: str(s.data.sha256) ?? undefined,
      facts: num(s.data.facts) ?? 0,
      timeline: num(s.data.timeline) ?? 0,
      iocs: num(s.data.iocs) ?? 0,
      warnings: strArray(s.data.warnings),
      tools: Array.isArray(s.data.tools)
        ? (s.data.tools as Array<Record<string, unknown>>).map((t) => ({
            tool: str(t.tool) ?? "tool",
            ok: t.ok === true,
            exitCode: typeof t.exitCode === "number" ? t.exitCode : null,
            timedOut: t.timedOut === true,
            durationMs: num(t.durationMs) ?? 0,
          }))
        : [],
      generatedAt: num(s.data.generatedAt) ?? 0,
    });
  }

  const view: IrView = {
    taskId: input.taskId,
    evidence,
    timeline,
    questions,
    attachments: input.attachments ?? [],
    artifacts: input.artifacts ?? [],
    analysis,
    warnings,
  };
  return { view, warnings };
}

function evidenceOf(v: unknown): EvidenceLevel {
  return evidence(v) ?? "E0";
}
