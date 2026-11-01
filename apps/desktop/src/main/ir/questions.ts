/**
 * V2-P0-4：IR 问题清单与候选答案映射。
 *
 * 输入：问题文本 + 已完成的分析结果（IOC/时间线/事实）。
 * 输出：每个问题的候选答案（带置信度/证据/来源/缺口）；**不确认、不提交**。
 */

import type { AnswerType } from "../../../../../packages/shared-protocol/events.ts";
import type {
  IrAnalysisResult,
  IrAnswerCandidate,
  IrIoc,
  IrStructuredFact,
  IrTimelineEvent,
} from "./registry.ts";

export interface IrQuestion {
  id: string;
  question: string;
  field?: AnswerType;
}

export function parseIrQuestions(text: string): IrQuestion[] {
  const out: IrQuestion[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const [i, item] of parsed.entries()) {
          if (!item || typeof item !== "object") continue;
          const obj = item as Record<string, unknown>;
          const q = typeof obj.question === "string" ? obj.question : typeof obj.text === "string" ? obj.text : "";
          if (!q.trim()) continue;
          out.push({
            id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `q${i + 1}`,
            question: q.trim().slice(0, 1000),
            ...(typeof obj.field === "string" ? { field: obj.field as AnswerType } : {}),
          });
          if (out.length >= 100) break;
        }
        return out;
      }
    } catch {
      /* 不是 JSON，按行解析 */
    }
  }
  let n = 0;
  for (const raw of trimmed.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    line = line.replace(/^(?:\d+[.、)]|[-*])\s*/, "").trim();
    if (!line) continue;
    n++;
    out.push({ id: `q${n}`, question: line.slice(0, 1000) });
    if (out.length >= 100) break;
  }
  return out;
}

interface EvidencePool {
  iocs: IrIoc[];
  timeline: IrTimelineEvent[];
  facts: IrStructuredFact[];
  results: IrAnalysisResult[];
}

function poolOf(results: IrAnalysisResult[]): EvidencePool {
  return {
    results,
    iocs: results.flatMap((r) => r.iocs),
    timeline: results.flatMap((r) => r.timeline).sort((a, b) => a.at - b.at),
    facts: results.flatMap((r) => r.facts),
  };
}

function iocsOf(pool: EvidencePool, type: IrIoc["type"]): IrIoc[] {
  return pool.iocs
    .filter((i) => i.type === type)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function factPaths(pool: EvidencePool, schemas: string[]): Array<{ path: string; witness?: string | null; score?: number }> {
  const out: Array<{ path: string; witness?: string | null; score?: number }> = [];
  for (const f of pool.facts) {
    if (!schemas.includes(f.schema)) continue;
    const path = typeof f.data.path === "string" ? f.data.path : typeof f.data.root === "string" ? f.data.root : null;
    if (!path) continue;
    out.push({
      path,
      witness: f.witness ?? null,
      ...(typeof f.data.score === "number" ? { score: f.data.score } : {}),
    });
  }
  return out;
}

function pickField(question: string): AnswerType {
  const q = question.toLowerCase();
  if (/hash|哈希|md5|sha1|sha256/.test(q)) return "hash";
  if (/攻击者|attacker|来源\s*ip|源\s*ip|ip\s*地址|哪个\s*ip|what\s+ip/.test(q)) return "ip";
  if (/webshell|木马|后门|shell|文件路径|路径|path|文件位置/.test(q)) return "path";
  if (/进程|process|pid/.test(q)) return "process";
  if (/账号|账户|用户|account|user/.test(q)) return "account";
  if (/命令|command|执行了什么|cmd/.test(q)) return "command";
  if (/域名|url|外联|c2|domain|访问了/.test(q)) return "url";
  if (/时间|何时|when|入侵时间|首次|最早|最晚|last|first/.test(q)) return "timestamp";
  return "text";
}

function candidate(input: {
  question: IrQuestion;
  value: string;
  answerType: AnswerType;
  confidence: number;
  witness?: string | null;
  sources?: string[];
  gaps?: string[];
}): IrAnswerCandidate {
  return {
    questionId: input.question.id,
    question: input.question.question,
    field: input.question.field ?? input.answerType,
    value: input.value,
    answerType: input.answerType,
    confidence: input.confidence,
    evidence: "E1",
    ...(input.witness ? { witness: input.witness } : {}),
    sources: input.sources ?? [],
    gaps: input.gaps ?? [],
  };
}

/**
 * 把一个问题的证据映射成候选答案。最多 3 条；没有证据时返回空数组 + gap。
 * 所有候选都是 E1（来自原始文件），不自动确认。
 */
export function mapQuestionCandidates(question: IrQuestion, results: IrAnalysisResult[]): IrAnswerCandidate[] {
  const pool = poolOf(results);
  const field = question.field ?? pickField(question.question);
  const out: IrAnswerCandidate[] = [];

  if (field === "ip") {
    const ips = iocsOf(pool, "ip").slice(0, 3);
    for (const [i, ip] of ips.entries()) {
      out.push(
        candidate({
          question,
          value: ip.value,
          answerType: "ip",
          confidence: i === 0 ? 0.65 : 0.4,
          witness: ip.witness ?? null,
          sources: ip.witness ? [ip.witness] : [],
          gaps: ["候选来自日志/流量出现频次，需人工确认是否为攻击者"],
        }),
      );
    }
  } else if (field === "timestamp") {
    const wantsLast = /最后|最新|last|最晚/.test(question.question.toLowerCase());
    // 入侵时间优先用日志/EVTX/PCAP，而不是文件 mtime；可疑事件再加权。
    const rank = (ev: IrTimelineEvent): number => {
      let n = 0;
      if (ev.source === "log" || ev.source === "evtx" || ev.source === "pcap") n += 10;
      if (ev.source === "file") n -= 5;
      if (ev.impact) n += 5;
      if (/入侵|攻击|失败|清除|进程创建|服务安装|恶意|异常|webshell/i.test(ev.event)) n += 5;
      return n;
    };
    const events = [...pool.timeline].sort(
      (a, b) => rank(b) - rank(a) || (wantsLast ? b.at - a.at : a.at - b.at),
    );
    for (const [i, ev] of events.slice(0, 3).entries()) {
      out.push(
        candidate({
          question,
          value: new Date(ev.at).toISOString(),
          answerType: "timestamp",
          confidence: i === 0 ? 0.6 : 0.4,
          witness: ev.witness ?? null,
          sources: ev.witness ? [ev.witness] : [],
          gaps: ["时间来自单一日志/流量源，需与文件 mtime/EVTX 交叉验证"],
        }),
      );
    }
  } else if (field === "path") {
    const paths = [
      ...factPaths(pool, ["ir.webshell"]).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
      ...factPaths(pool, ["ir.file_suspicious"]),
      ...iocsOf(pool, "path").map((i) => ({ path: i.value, witness: i.witness ?? null })),
    ];
    const seen = new Set<string>();
    for (const p of paths) {
      if (seen.has(p.path)) continue;
      seen.add(p.path);
      out.push(
        candidate({
          question,
          value: p.path,
          answerType: "path",
          confidence: out.length === 0 ? 0.6 : 0.4,
          witness: p.witness ?? null,
          sources: p.witness ? [p.witness] : [],
          gaps: ["路径为可疑文件候选，需人工确认是否为 Webshell/后门"],
        }),
      );
      if (out.length >= 3) break;
    }
  } else if (field === "process") {
    const procs = iocsOf(pool, "process");
    for (const [i, p] of procs.slice(0, 3).entries()) {
      out.push(
        candidate({
          question,
          value: p.value,
          answerType: "process",
          confidence: i === 0 ? 0.6 : 0.4,
          witness: p.witness ?? null,
          sources: p.witness ? [p.witness] : [],
          gaps: ["进程名可能重名，需 PID/命令行交叉验证"],
        }),
      );
    }
  } else if (field === "account") {
    const accounts = iocsOf(pool, "account");
    for (const [i, a] of accounts.slice(0, 3).entries()) {
      out.push(
        candidate({
          question,
          value: a.value,
          answerType: "account",
          confidence: i === 0 ? 0.6 : 0.4,
          witness: a.witness ?? null,
          sources: a.witness ? [a.witness] : [],
          gaps: ["账号需结合登录事件/主机确认"],
        }),
      );
    }
  } else if (field === "command") {
    const commands = iocsOf(pool, "command");
    for (const [i, c] of commands.slice(0, 3).entries()) {
      out.push(
        candidate({
          question,
          value: c.value,
          answerType: "command",
          confidence: i === 0 ? 0.55 : 0.35,
          witness: c.witness ?? null,
          sources: c.witness ? [c.witness] : [],
          gaps: ["命令可能来自正常运维，需结合进程/时间线确认"],
        }),
      );
    }
  } else if (field === "hash") {
    const hashes = iocsOf(pool, "hash");
    for (const [i, h] of hashes.slice(0, 3).entries()) {
      out.push(
        candidate({
          question,
          value: h.value,
          answerType: "hash",
          confidence: i === 0 ? 0.6 : 0.4,
          witness: h.witness ?? null,
          sources: h.witness ? [h.witness] : [],
          gaps: ["hash 需与文件 sha256/威胁情报交叉验证"],
        }),
      );
    }
  } else if (field === "url") {
    const urls = [...iocsOf(pool, "url"), ...iocsOf(pool, "domain")].slice(0, 3);
    for (const [i, u] of urls.entries()) {
      out.push(
        candidate({
          question,
          value: u.value,
          answerType: "url",
          confidence: i === 0 ? 0.55 : 0.35,
          witness: u.witness ?? null,
          sources: u.witness ? [u.witness] : [],
          gaps: ["URL/域名可能包含正常业务流量，需人工确认"],
        }),
      );
    }
  } else {
    // text：只给可疑行/时间线事件作为线索，不猜自然语言答案。
    const lines = pool.facts
      .filter((f) => f.schema === "ir.suspicious_line" && typeof f.data.text === "string")
      .slice(0, 3);
    for (const l of lines) {
      out.push(
        candidate({
          question,
          value: String(l.data.text).slice(0, 500),
          answerType: "text",
          confidence: 0.3,
          witness: l.witness ?? null,
          sources: l.witness ? [l.witness] : [],
          gaps: ["自然语言问题需要人工判断；这里只给出可疑行线索"],
        }),
      );
    }
  }

  if (out.length === 0) {
    return [
      {
        questionId: question.id,
        question: question.question,
        field,
        value: "",
        answerType: field,
        confidence: 0,
        evidence: "E0",
        sources: [],
        gaps: ["未发现可回答该问题的证据；需要补充日志/PCAP/内存或人工分析"],
      },
    ];
  }
  return out;
}
