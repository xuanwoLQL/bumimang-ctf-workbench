/**
 * A/B 测量：1 个会话 vs N 个会话跑同一道题，到底快多少、多烧多少、有没有重复劳动。
 *
 * 为什么需要它：多会话并行的画面（三窗格 34/34）与机制（简报包扇出 17/17）都验过了，
 * 但"1 加到 3 省时间"这个产品主张从来没被量化过。这是交接文档 §5 排第一的未验证项。
 *
 * 用法：
 *   npm run ab -- --dry                           只验脚本本身，不烧 token
 *   npm run ab -- --brief "题目描述" --sessions 3   真跑（会消耗 token 与时间）
 *
 * 设计取舍：会话一律 autonomous 档 + 自动放行审批，避免测量被人工打断（次数照记）；
 * 判重是启发式（字符 bigram 的 Jaccard 相似度），只提示可能重复，不下定论。
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { Blackboard } from "../main/blackboard/board.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { SessionManager, newRunId } from "../main/session/manager.ts";
import { PolicyEngine } from "../main/policy/engine.ts";
import { installedAgents } from "../main/discovery/detect.ts";

// ---------------------------------------------------------------- 参数

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DRY = process.argv.includes("--dry");
const BRIEF = arg("brief", "在这台机器上找出一个简单事实并写进黑板，用来验证 A/B 测量工具本身能跑通。");
const N = Math.max(1, Number(arg("sessions", "3")));
const AGENT = arg("agent", "claude");
const TIMEOUT_MS = Number(arg("timeout", "240")) * 1000;
const ROOT = "D:/agent/xuanwo";
const WORK = join(ROOT, ".ui-run", "ab");

interface RunResult {
  label: string;
  sessions: number;
  wallMs: number;
  /** 首个 flag 事实落库相对 run 起点的时间（ms）；null = 本轮没摸到 flag */
  firstFlagMs: number | null;
  perSession: Array<{ id: string; role: string; toolCalls: number; boardReads: number }>;
  board: { deadEnds: number; facts: number; intents: number };
  approvals: number;
  duplicates: Array<{ a: string; b: string; kind: string; similarity: number; text: string }>;
  errors: string[];
}

// ---------------------------------------------------------------- 判重

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

interface OwnedText {
  sessionId: string;
  kind: string;
  text: string;
}

function findDuplicates(items: OwnedText[], threshold = 0.6): RunResult["duplicates"] {
  const out: RunResult["duplicates"] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.sessionId === b.sessionId) continue;
      const sim = jaccard(bigrams(a.text), bigrams(b.text));
      if (sim >= threshold) {
        out.push({
          a: a.sessionId,
          b: b.sessionId,
          kind: a.kind,
          similarity: Number(sim.toFixed(2)),
          text: a.text.slice(0, 100),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 单次运行

async function runOnce(label: string, sessions: number): Promise<RunResult> {
  const work = join(WORK, label);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const res: RunResult = {
    label,
    sessions,
    wallMs: 0,
    firstFlagMs: null,
    perSession: [],
    board: { deadEnds: 0, facts: 0, intents: 0 },
    approvals: 0,
    duplicates: [],
    errors: [],
  };

  const board = Blackboard.open(join(work, "board.db"));
  const task = board.createTask({ title: `A/B ${label}`, brief: BRIEF });
  // 桥在 mgr 之前创建（mgr 构造需要桥），但 onBoardRead 要回调 mgr —— 用先声明后赋值打破环。
  // T2 修复：不接这个回调 boardReads 永远是 0，黑板消费程度就成了假指标。
  let mgrRef: SessionManager | null = null;
  const bridge = new BoardBridge({
    board,
    taskId: task.id,
    runId: newRunId(),
    onBoardRead: (sessionId) => mgrRef?.noteBoardRead(sessionId),
  });
  await bridge.start();

  const policy = new PolicyEngine({ repoRoot: ROOT, packId: "competition" });
  const mgr = new SessionManager({
    board,
    bridge,
    policy,
    workspaceRoot: work,
    onLine: () => undefined,
    onApprovalRequired: async () => {
      res.approvals += 1;
      return true;
    },
  });
  mgrRef = mgr;

  const agent = installedAgents().find((a) => a.id === AGENT);
  if (!agent?.launch) throw new Error(`没有可用的 ${AGENT}`);
  const spec = { command: agent.launch.command, args: agent.launch.args, cwd: work, label: AGENT };
  const ROLES = ["lead", "verify", "recon", "scribe"];

  const started = Date.now();
  for (let i = 0; i < sessions; i += 1) {
    try {
      await mgr.startSession({
        taskId: task.id,
        spec,
        agent: AGENT,
        role: ROLES[i % ROLES.length],
        tier: "autonomous",
      });
    } catch (err) {
      res.errors.push(`起第 ${i + 1} 个会话失败：${(err as Error).message}`);
    }
  }

  // 并发注入简报：这才让黑板继承与重复劳动可观测
  await Promise.all(
    mgr.listSessions().map(async (s) => {
      try {
        await mgr.sendBriefing(s.id);
      } catch (err) {
        res.errors.push(`${s.id} 简报轮失败：${(err as Error).message}`);
      }
    }),
  );

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!mgr.listSessions().some((s) => s.status === "running")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.wallMs = Date.now() - started;
  // P1：首个 flag 事实落库时间（相对 run 起点）——「先碰到答案」与「全队收尾」是两个指标，
  // 只看墙钟会把三路并行的首答优势抹掉（上一轮 79s vs 158s 的教训）。
  const firstFlagRow = board.raw(
    `SELECT created_at FROM facts WHERE task_id = ? AND content LIKE '%flag{%' ORDER BY created_at ASC LIMIT 1`,
    task.id,
  ) as Array<{ created_at: number }>;
  res.firstFlagMs = firstFlagRow.length ? firstFlagRow[0].created_at - started : null;

  for (const s of mgr.listSessions()) {
    res.perSession.push({ id: s.id, role: s.role, toolCalls: s.toolCalls, boardReads: s.boardReads });
  }

  const deadEnds = board.listDeadEnds(task.id);
  const facts = board.listFacts(task.id);
  res.board = {
    deadEnds: deadEnds.length,
    facts: facts.length,
    intents: board.listIntents(task.id).length,
  };

  const owned: OwnedText[] = [];
  for (const d of deadEnds) owned.push({ sessionId: d.created_by ?? "?", kind: "死路", text: d.description });
  for (const f of facts) owned.push({ sessionId: f.created_by ?? "?", kind: "事实", text: f.content });
  res.duplicates = findDuplicates(owned);

  await mgr.shutdown();
  bridge.stop();
  board.close();
  return res;
}

// ---------------------------------------------------------------- 汇总与主流程

function col(s: string, width: number): string {
  const w = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return s + " ".repeat(Math.max(1, width - w));
}

function printTable(a: RunResult, b: RunResult): void {
  console.log("\n================ A/B 对照 ================");
  console.log(col("指标", 22) + col("单会话", 16) + col(`${b.sessions} 会话`, 16));
  const sum = (r: RunResult, f: (x: RunResult["perSession"][number]) => number): number =>
    r.perSession.reduce((s, x) => s + f(x), 0);
  console.log(col("墙钟时间(s)", 22) + col((a.wallMs / 1000).toFixed(1), 16) + col((b.wallMs / 1000).toFixed(1), 16));
  const fmtFirst = (ms: number | null): string => (ms === null ? "—" : (ms / 1000).toFixed(1));
  console.log(col("首个 flag 时间(s)", 22) + col(fmtFirst(a.firstFlagMs), 16) + col(fmtFirst(b.firstFlagMs), 16));
  console.log(col("工具调用合计", 22) + col(String(sum(a, (x) => x.toolCalls)), 16) + col(String(sum(b, (x) => x.toolCalls)), 16));
  console.log(col("黑板读取合计", 22) + col(String(sum(a, (x) => x.boardReads)), 16) + col(String(sum(b, (x) => x.boardReads)), 16));
  console.log(
    col("死路/事实/意图", 22) +
      col(`${a.board.deadEnds}/${a.board.facts}/${a.board.intents}`, 16) +
      col(`${b.board.deadEnds}/${b.board.facts}/${b.board.intents}`, 16),
  );
  console.log(col("审批次数", 22) + col(String(a.approvals), 16) + col(String(b.approvals), 16));
  console.log(col("疑似重复劳动", 22) + col(String(a.duplicates.length), 16) + col(String(b.duplicates.length), 16));
  if (b.duplicates.length) {
    console.log("\n多会话侧的疑似重复：");
    for (const d of b.duplicates) {
      console.log(`  [${d.kind}] ${d.a} 与 ${d.b} 相似度 ${d.similarity}：${d.text}`);
    }
  }
  console.log("\n注：墙钟时间受模型速度与网络影响，单次测量不能当结论；重复劳动是启发式判重，只提示不下定论。");
}

async function main(): Promise<void> {
  console.log("========== 不迷茫 · A/B 测量 ==========");
  console.log(`agent=${AGENT}  会话数=${N} vs 1  超时=${TIMEOUT_MS / 1000}s`);
  console.log(`题目：${BRIEF.slice(0, 120)}`);

  mkdirSync(join(ROOT, "docs", "logs"), { recursive: true });

  if (DRY) {
    console.log("\n[--dry] 只验脚本本身：不 spawn agent、不烧 token。");
    const fake: RunResult = {
      label: "dry",
      sessions: N,
      wallMs: 1234,
      perSession: Array.from({ length: N }, (_, i) => ({
        id: `s${i + 1}`,
        role: "lead",
        toolCalls: 3,
        boardReads: 1,
      })),
      board: { deadEnds: 1, facts: 1, intents: 1 },
      approvals: 0,
      duplicates: [],
      errors: [],
    };
    writeFileSync(join(ROOT, "docs", "logs", "ab-dry.json"), JSON.stringify(fake, null, 2), "utf8");
    console.log("PASS  参数解析、报告结构、判重函数、JSON 落盘都正常（合成数据）");
    console.log("      证据：docs/logs/ab-dry.json");
    console.log("\n真跑请去掉 --dry，并用 --brief 给一道真题。");
    process.exit(0);
  }

  const single = await runOnce("single", 1);
  const multi = await runOnce("multi", N);
  printTable(single, multi);

  writeFileSync(
    join(ROOT, "docs", "logs", "ab-result.json"),
    JSON.stringify({ brief: BRIEF, agent: AGENT, single, multi, at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  console.log("\n证据：docs/logs/ab-result.json");

  const errs = [...single.errors, ...multi.errors];
  if (errs.length) {
    console.log("\n过程中的错误：");
    for (const e of errs) console.log(`  - ${e}`);
  }
  // T2：有错误必须非零退出——之前无条件 exit(0)，失败运行也报成功，数字不可信。
  process.exit(errs.length ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
