/**
 * WP9-A · verify:awdir（只读模型/契约）
 * 不启动 Electron/agent、不读真实 board；纯合成数据。
 * 不并入 verify:all。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAwdFacts, parseIrFacts } from "../main/awdir/model.ts";
import { exportAwd, exportIr } from "../main/awdir/export.ts";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}
let seq = 0;
function fact(schema: string, data: Record<string, unknown>, id?: string): never {
  return {
    id: id ?? `f${++seq}`,
    content: JSON.stringify({ schema, v: 1, ...data }),
    status: "candidate",
    evidence: "E0",
    witness: null,
    by: null,
  } as never;
}
function target(value: string, status = "alive"): never {
  return {
    id: `t-${value}`,
    taskId: "task-1",
    value,
    kind: "host",
    status,
    notes: null,
    createdAt: 0,
  } as never;
}
function flag(id: string, status = "new", submittedAt: number | null = null): never {
  return {
    id,
    taskId: "task-1",
    value: `flag{${id}}`,
    status,
    evidence: "E2",
    firstSeen: 0,
    sources: [],
    submittedAt,
    submitStatus: submittedAt ? "manual" : null,
  } as never;
}

async function main(): Promise<void> {  // ---------- AWD ----------
  const awdFacts = [
    fact("awd.round", { round: 2, startedAt: 1000, endsAt: 61000, state: "running" }, "r2"),
    fact("awd.round", { round: 1, startedAt: 0, endsAt: 60000, state: "ended" }, "r1"),
    fact("awd.service", { name: "web", target: "h:80", ownerSessionId: "s1", patchStatus: "pending" }, "svc1"),
    fact("awd.service", { name: "db", target: "h:5432", status: "up", ownerSessionId: "s2" }, "svc2"),
    fact("awd.flag", { candidateId: "flag-a", round: 1 }, "fr1"),
    fact("awd.flag", { candidateId: "flag-b", round: 2 }, "fr2"),
    fact("awd.patch", { service: "web", vuln: "sqli", status: "verified", evidence: "E2", witness: "evidence/p.txt" }, "p1"),
    fact("awd.check", { round: 2, item: "ssh 弱口令", status: "ok", evidence: "E1" }, "c1"),
    fact("awd.attack", { attacker: "team1", target: "team2:80", action: "sqli", result: "flag", evidence: "E2", at: 5000 }, "a1"),
  ];
  const awdRes = parseAwdFacts({
    taskId: "task-1",
    facts: awdFacts,
    targets: [target("h:80", "alive"), target("h:8080", "owned")],
    flags: [flag("flag-a", "confirmed", 123), flag("flag-b"), flag("flag-c")],
    sessions: [{ id: "s1" }, { id: "s2" }] as never,
    scoreboard: { tasks: [], solved: 0, total: 0, points: 0 },
  });
  const awd = awdRes.view;
  check("A1 轮次取最大 round", awd.round?.number === 2, JSON.stringify(awd.round));
  check("A1 轮次 state/endsAt", awd.round?.state === "running" && awd.round?.endsAt === 61000, JSON.stringify(awd.round));
  check("A1 服务 target+fact enrich", awd.services[0]?.name === "web" && awd.services[0]?.ownerSessionId === "s1", JSON.stringify(awd.services[0]));
  check("A1 服务 fact-only 也列出", awd.services.some((s) => s.name === "db" && s.status === "alive"), JSON.stringify(awd.services));
  check("A1 flag 按 round 分组", awd.flags.map((f) => f.round).join(",") === "0,1,2", JSON.stringify(awd.flags.map((f) => f.round)));
  check("A1 未映射 flag 归 round=0", awd.flags.find((f) => f.round === 0)?.candidates[0]?.id === "flag-c");
  check("A1 confirmed/submitted 计数", awd.flags.find((f) => f.round === 1)?.confirmed === 1 && awd.flags.find((f) => f.round === 1)?.submitted === 1, JSON.stringify(awd.flags));
  check("A1 patch 解析", awd.patches[0]?.status === "verified" && awd.patches[0]?.evidence === "E2", JSON.stringify(awd.patches));
  check("A1 check/attack 解析", awd.checks[0]?.status === "ok" && awd.attacks[0]?.at === 5000, JSON.stringify({ checks: awd.checks, attacks: awd.attacks }));
  check("A1 scoreboard 透传", awd.scoreboard?.points === 0);

  const bad = parseAwdFacts({
    taskId: "t",
    facts: [
      fact("awd.round", { round: 1, startedAt: 1 }, "ok"),
      { id: "bad", content: '{"schema":"awd.round",', status: "candidate", evidence: "E0", witness: null, by: null } as never,
      fact("awd.round", { round: 2, startedAt: 2 }, "v2"),
      { id: "v2", content: JSON.stringify({ schema: "awd.round", v: 2, round: 3 }), status: "candidate", evidence: "E0", witness: null, by: null } as never,
      { id: "other", content: '{"hello":1}', status: "candidate", evidence: "E0", witness: null, by: null } as never,
    ],
    targets: [],
    flags: [],
  });
  check("A1 坏 JSON/坏版本产生 warning 不抛错", bad.warnings.length === 2, JSON.stringify(bad.warnings));
  check("A1 无关 JSON 不产生 warning", !bad.warnings.some((w) => w.includes("other")), JSON.stringify(bad.warnings));

  const emptyAwd = parseAwdFacts({ taskId: "t", facts: [], targets: [target("h:1")], flags: [] });
  check("A1 空 facts 不抛错", emptyAwd.view.round === null && emptyAwd.view.services.length === 1, JSON.stringify(emptyAwd.view));

  // ---------- IR ----------
  const attachments = [
    { name: "access.log", relativePath: "attachments/access.log", size: 10, sha256: "abc", type: "text", source: "files", importedAt: 100 },
  ] as never[];
  const artifacts = [
    { path: "evidence/out.txt", name: "out.txt", size: 1, mtime: 200, kind: "text", previewable: true },
  ] as never[];
  const irRes = parseIrFacts({
    taskId: "task-ir",
    facts: [
      fact("ir.evidence", { path: "evidence/alert.txt", kind: "file", evidence: "E2", witness: "w", source: "manual", addedAt: 50 }, "e1"),
      fact("ir.timeline", { at: 200, source: "log", event: "login fail", impact: "high", evidence: "E1" }, "t2"),
      fact("ir.timeline", { at: 100, source: "log", event: "first", impact: "low" }, "t1"),
      fact("ir.question", { question: "攻击者 IP?", status: "answered", answer: "1.2.3.4", evidence: "E2" }, "q1"),
      fact("ir.question", { question: "入侵时间?", status: "bogus" }, "q2"),
    ],
    attachments,
    artifacts,
  });
  const ir = irRes.view;
  check("I1 证据板含附件/工件/fact", ir.evidence.length === 3 && ir.evidence.some((e) => e.kind === "attachment") && ir.evidence.some((e) => e.id.startsWith("artifact:")) && ir.evidence.some((e) => e.id === "e1"), JSON.stringify(ir.evidence));
  check("I1 时间线按 at 排序", ir.timeline.map((t) => t.at).join(",") === "100,200", JSON.stringify(ir.timeline));
  check("I1 问题状态/答案", ir.questions[0]?.status === "answered" && ir.questions[0]?.answer === "1.2.3.4", JSON.stringify(ir.questions));
  check("I1 非法问题状态回落 open", ir.questions[1]?.status === "open", JSON.stringify(ir.questions[1]));
  check("I1 附件/工件透传", ir.attachments.length === 1 && ir.artifacts.length === 1);
  const irBad = parseIrFacts({
    taskId: "t",
    facts: [{ id: "bad-ir", content: '{"schema":"ir.question"', status: "candidate", evidence: "E0", witness: null, by: null } as never],
  });
  check("I1 坏 IR fact 产生 warning 不抛错", irBad.warnings.length === 1, JSON.stringify(irBad.warnings));
  check("I1 空 IR 不抛错", parseIrFacts({ taskId: "t", facts: [] }).view.evidence.length === 0);

  // ---------- C1：纯导出 md/csv/json ----------
  const awdMd = exportAwd(awd, "md", 0);
  check("C1 AWD md 含服务/flag", awdMd.includes("web") && awdMd.includes("flag-a") && awdMd.includes("# AWD 导出"), awdMd.slice(0, 120));
  const awdCsv = exportAwd(awd, "csv", 0);
  check("C1 AWD csv 表头/行", awdCsv.startsWith("type,round,name") && awdCsv.includes("service") && awdCsv.includes("flag"), awdCsv.slice(0, 120));
  const awdJson = exportAwd(awd, "json", 0);
  let awdParsed: { services?: unknown[]; flags?: unknown[]; format?: string } | null = null;
  try {
    awdParsed = JSON.parse(awdJson) as typeof awdParsed;
  } catch {
    awdParsed = null;
  }
  check("C1 AWD json 可解析", awdParsed?.format === "json" && awdParsed?.services?.length === awd.services.length, awdJson.slice(0, 120));
  const csvEsc = exportAwd(
    {
      ...awd,
      flags: [
        {
          round: 1,
          candidates: [{ ...awd.flags[1]!.candidates[0]!, value: 'flag{a,"b"}' }],
          confirmed: 0,
          submitted: 0,
        },
      ],
    } as never,
    "csv",
    0,
  );
  check("C1 CSV 引号/逗号转义", csvEsc.includes('"flag{a,""b""}"'), csvEsc.slice(0, 160));

  const irMd = exportIr(ir, "md", 0);
  check("C1 IR md 含证据/时间线/问题", irMd.includes("# IR 导出") && irMd.includes("攻击者 IP") && irMd.includes("first"), irMd.slice(0, 120));
  const irCsv = exportIr(ir, "csv", 0);
  check("C1 IR csv 行", irCsv.startsWith("type,id,path") && irCsv.includes("timeline") && irCsv.includes("question"), irCsv.slice(0, 120));
  const irJson = exportIr(ir, "json", 0);
  let irParsed: { questions?: unknown[]; format?: string } | null = null;
  try {
    irParsed = JSON.parse(irJson) as typeof irParsed;
  } catch {
    irParsed = null;
  }
  check("C1 IR json 可解析", irParsed?.format === "json" && irParsed?.questions?.length === ir.questions.length, irJson.slice(0, 120));

  // ---------- Hub 快照集成（category=awd/ir；不启动 agent） ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p9a-awdir-"));
    const board = Blackboard.open(path.join(dir, "board.db"), { backup: false });
    const v4Tables = [
      "awd_rounds",
      "awd_services",
      "awd_patches",
      "awd_checks",
      "awd_attacks",
      "ir_timeline",
      "ir_questions",
    ];
    const tableNames = new Set(
      (board.raw("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    check("P9-D v4 七张 AWD/IR 表存在", v4Tables.every((t) => tableNames.has(t)), JSON.stringify([...tableNames].filter((t) => t.startsWith("awd_") || t.startsWith("ir_"))));
    check(
      "P9-D v4 表不背填 facts",
      v4Tables.every((t) => (board.raw(`SELECT COUNT(*) AS n FROM ${t}`) as Array<{ n: number }>)[0]!.n === 0),
    );
    const fakeSessions = {
      listSessions: () => [],
      getSession: () => undefined,
      syncLag: () => 0,
      historyOf: () => [],
    } as never;
    const hub = new HubService({
      board,
      sessions: fakeSessions,
      bus: new EventBus(),
      workspaceRoot: dir,
      workDir: dir,
    });
    const awdTask = board.createTask({ title: "AWD", brief: "x", category: "awd" });
    board.submitFact({
      taskId: awdTask.id,
      sessionId: null,
      content: JSON.stringify({ schema: "awd.round", v: 1, round: 1, startedAt: 1000, endsAt: 2000, state: "running" }),
    });
    hub.setTask(awdTask.id);
    const awdSnap = hub.snapshot();
    check("H1 category=awd 快照带 awd", awdSnap.awd?.round?.number === 1, JSON.stringify(awdSnap.awd?.round));
    check("H1 category=awd 不填 ir", awdSnap.ir === undefined);

    const irTask = board.createTask({ title: "IR", brief: "x", category: "ir" });
    board.submitFact({
      taskId: irTask.id,
      sessionId: null,
      content: JSON.stringify({ schema: "ir.timeline", v: 1, at: 100, source: "log", event: "x" }),
    });
    hub.setTask(irTask.id);
    const irSnap = hub.snapshot();
    check("H1 category=ir 快照带 ir", irSnap.ir?.timeline[0]?.event === "x", JSON.stringify(irSnap.ir?.timeline));
    check("H1 category=ir 不填 awd", irSnap.awd === undefined);

    const awdExp = await hub.dispatch({ type: "awd.export", taskId: awdTask.id, format: "json" });
    check("C1 Hub awd.export 返回 content", awdExp.ok === true && typeof awdExp.content === "string" && awdExp.content.includes('"services"'), JSON.stringify({ ok: awdExp.ok, len: awdExp.content?.length }));
    const irExp = await hub.dispatch({ type: "ir.export", taskId: irTask.id, format: "md" });
    check("C1 Hub ir.export 返回 content", irExp.ok === true && typeof irExp.content === "string" && irExp.content.includes("# IR 导出"), JSON.stringify({ ok: irExp.ok, len: irExp.content?.length }));
    const badFmt = await hub.dispatch({ type: "awd.export", taskId: awdTask.id, format: "xml" as never });
    check("C1 Hub 非法 format 拒绝", badFmt.ok === false && String(badFmt.error).includes("format"), JSON.stringify(badFmt));
    const badCat = await hub.dispatch({ type: "awd.export", taskId: irTask.id, format: "json" });
    check("C1 Hub category 不匹配拒绝", badCat.ok === false && String(badCat.error).includes("不是 AWD"), JSON.stringify(badCat));
    const auditExports = board.raw(
      "SELECT action,COUNT(*) AS n FROM audit WHERE action IN ('awd.export','ir.export') GROUP BY action ORDER BY action",
    ) as Array<{ action: string; n: number }>;
    check("C1 Hub 导出审计（不记 content）", auditExports.find((a) => a.action === "awd.export")?.n === 1 && auditExports.find((a) => a.action === "ir.export")?.n === 1, JSON.stringify(auditExports));
    hub.setTask(null);
    const noSnap = hub.snapshot();
    check("H1 无焦点不填 awd/ir", noSnap.awd === undefined && noSnap.ir === undefined);
    board.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- 契约/源码边界 ----------
  const eventsSrc = fs.readFileSync("packages/shared-protocol/events.ts", "utf8");
  check("C1 HubSnapshot 有可选 awd/ir", /awd\?: AwdView/.test(eventsSrc) && /ir\?: IrView/.test(eventsSrc));
  const modelSrc = fs.readFileSync("apps/desktop/src/main/awdir/model.ts", "utf8");
  check("C1 模型无 fs/net/child_process/eval", !/node:fs|node:net|child_process|\beval\s*\(|spawn\s*\(/.test(modelSrc));
  check("C1 模型无 DB 写", !/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE)\b/i.test(modelSrc));
  check("C1 模型只读类型导入", modelSrc.includes("import type"));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  check(
    "C1 verify:awdir 不并入 verify:all",
    !(pkg.scripts?.["verify:all"] ?? "").includes("verify-awdir"),
  );

  console.log(`\n${pass}/${pass + fail} PASS`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
