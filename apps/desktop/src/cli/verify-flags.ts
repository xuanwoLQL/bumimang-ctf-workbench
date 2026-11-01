/**
 * P5-A flag 候选持久化验收（A 组：只测持久化/快照/来源，不测确认/提交/导出）。
 *
 * 用法：npm run verify:flags
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../main/blackboard/board.ts";
import { EventBus, HubService } from "../main/hub/hub.ts";
import { BoardBridge } from "../main/mcp-host/bridge.ts";
import { BRIDGE_RPC } from "../main/mcp-host/protocol.ts";
import { validateHubAction } from "../main/electron/validate-action.ts";
import { applySnapshot } from "../renderer/store.ts";
import type { HubEvent, HubSnapshot } from "../../../../packages/shared-protocol/events.ts";
import type { SessionManager } from "../main/session/manager.ts";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

const emptySessions = {
  listSessions: () => [],
  getSession: () => undefined,
  syncLag: () => 0,
  historyOf: () => [],
} as unknown as SessionManager;

async function main(): Promise<void> {
  console.log("================ P5-A A 组：flag 候选持久化 ================\n");
  const dir = mkdtempSync(join(tmpdir(), "bumimang-flags-"));
  const dbPath = join(dir, "board.db");
  let board = Blackboard.open(dbPath);
  let hub: HubService | null = null;
  try {
    const a = board.createTask({ title: "flag 任务 A", brief: "" });
    const b = board.createTask({ title: "flag 任务 B", brief: "" });
    const humanTask = board.createTask({ title: "flag 人工答案", brief: "" });

    // ---------- A1：同任务同 flag 去重，多来源证据取最高 ----------
    const c1 = board.addFlagCandidate({
      taskId: a.id,
      value: "flag{same}",
      sessionId: "s1",
      witness: "evidence/a.txt",
      evidence: "E1",
    });
    eq("A1 第一次 addFlagCandidate created=true", c1.created, true);
    eq("A1 候选 value", c1.candidate.value, "flag{same}");
    eq("A1 候选 evidence=E1", c1.candidate.evidence, "E1");
    eq("A1 候选 status=new", c1.candidate.status, "new");
    const src1 = board.addFlagSource(c1.candidate.id, {
      sessionId: "s1",
      witness: "evidence/a.txt",
      evidence: "E1",
      seenAt: 1000,
    });
    const src2 = board.addFlagSource(c1.candidate.id, {
      sessionId: "s2",
      witness: "evidence/b.txt",
      evidence: "E2",
      seenAt: 2000,
    });
    eq("A1 第一条来源 created", src1.created, true);
    eq("A1 第二条来源 created", src2.created, true);
    eq("A1 同任务同 flag 只有 1 条候选", board.listFlagCandidates(a.id).length, 1);
    eq("A1 多来源证据取最高 E2", board.getFlagCandidate(a.id, "flag{same}")?.evidence, "E2");
    const sources = board.listFlagSources(c1.candidate.id);
    eq("A1 来源数量 2", sources.length, 2);
    check(
      "A1 来源按 seen_at 升序",
      sources[0]?.session_id === "s1" && sources[1]?.session_id === "s2",
      sources.map((s) => `${s.session_id}:${s.seen_at}`).join(","),
    );
    const c1b = board.addFlagCandidate({
      taskId: a.id,
      value: "flag{same}",
      sessionId: "s3",
      evidence: "E0",
    });
    eq("A1 重复 addFlagCandidate created=false", c1b.created, false);
    eq("A1 重复 addFlagCandidate 不新增候选", board.listFlagCandidates(a.id).length, 1);

    // 不同任务同 flag 各自一条。
    const cB = board.addFlagCandidate({
      taskId: b.id,
      value: "flag{same}",
      sessionId: "s4",
      witness: "evidence/b.txt",
      evidence: "E2",
    });
    eq("A1 不同任务同 flag 各自一条（B created）", cB.created, true);
    eq("A1 B 任务候选数 1", board.listFlagCandidates(b.id).length, 1);
    eq("A1 A 任务候选数仍 1", board.listFlagCandidates(a.id).length, 1);
    board.addFlagSource(cB.candidate.id, {
      sessionId: "s4",
      witness: "evidence/b.txt",
      evidence: "E2",
      seenAt: 3000,
    });

    // ---------- A2：重启后候选/来源还在 ----------
    board.close();
    board = Blackboard.open(dbPath);
    eq("A2 重启后 A 候选数 1", board.listFlagCandidates(a.id).length, 1);
    eq("A2 重启后 A 来源数 2", board.listFlagSources(c1.candidate.id).length, 2);
    eq("A2 重启后 A 证据仍 E2", board.getFlagCandidate(a.id, "flag{same}")?.evidence, "E2");
    eq("A2 重启后 B 候选数 1", board.listFlagCandidates(b.id).length, 1);

    // ---------- A3：Hub 快照 flags 只暴露焦点任务 ----------
    hub = new HubService({
      board,
      sessions: emptySessions,
      bus: new EventBus(),
      workspaceRoot: dir,
      workDir: join(dir, "work"),
      maxSessionsPerTask: 3,
      maxSessionsTotal: 8,
    });
    hub.setTask(a.id);
    const snapA = hub.snapshot();
    eq("A3 焦点 A flags 数 1", snapA.flags?.length, 1);
    eq("A3 焦点 A flagCount=1", snapA.task?.flagCount, 1);
    eq("A3 焦点 A flagCandidate 兼容字段", snapA.task?.flagCandidate, "flag{same}");
    eq("A3 焦点 A 候选 sources=2", snapA.flags?.[0]?.sources.length, 2);
    eq("A3 焦点 A status=new", snapA.flags?.[0]?.status, "new");
    eq("A3 焦点 A submittedAt=null", snapA.flags?.[0]?.submittedAt, null);
    const bRow = snapA.tasks.find((t) => t.id === b.id);
    eq("A3 非焦点 B flagCandidate 不暴露", bRow?.flagCandidate, null);
    eq("A3 非焦点 B flagCount 仍可见", bRow?.flagCount, 1);

    hub.setTask(b.id);
    const snapB = hub.snapshot();
    eq("A3 焦点 B flags 数 1", snapB.flags?.length, 1);
    eq("A3 焦点 B flagCandidate", snapB.task?.flagCandidate, "flag{same}");
    eq("A3 焦点 B 候选 taskId", snapB.flags?.[0]?.taskId, b.id);
    eq("A3 焦点 B 候选来源数 1", snapB.flags?.[0]?.sources.length, 1);

    // 旧快照不带 flags：renderer store 不炸（可选字段）。
    const legacy = { ...snapB } as HubSnapshot;
    delete (legacy as HubSnapshot & { flags?: unknown }).flags;
    let legacyOk = false;
    try {
      const state = applySnapshot(legacy);
      legacyOk = state.task?.flagCandidate === "flag{same}";
    } catch {
      legacyOk = false;
    }
    check("A3 旧快照不带 flags 不炸", legacyOk);

    // ---------- A4：fact 路径写 store（recoverTaskSignals） ----------
    const factTask = board.createTask({ title: "fact flag", brief: "" });
    board.submitFact({
      taskId: factTask.id,
      sessionId: "s5",
      content: "flag{from_fact}",
      witness: "evidence/fact.txt",
      evidence: "E1",
    });
    hub.setTask(factTask.id);
    hub.recoverTaskSignals(factTask.id);
    const factSnap = hub.snapshot();
    const factCand = (factSnap.flags ?? []).find((f) => f.value === "flag{from_fact}");
    check("A4 fact 路径写入候选", Boolean(factCand), JSON.stringify(factSnap.flags));
    eq("A4 fact 路径证据 E1", factCand?.evidence, "E1");
    eq("A4 fact 路径来源数 1", factCand?.sources.length, 1);
    eq("A4 fact 路径 witness", factCand?.sources[0]?.witness, "evidence/fact.txt");

    // ---------- A5：task.setStatus solved 写候选；改回非 solved 清空 ----------
    hub.setTask(humanTask.id);
    await hub.dispatch({ type: "task.setStatus", taskId: humanTask.id, status: "solved", answer: "flag{human}" });
    const humanSnap = hub.snapshot();
    eq("A5 solved 后候选出现", humanSnap.flags?.length, 1);
    eq("A5 solved 后候选值", humanSnap.flags?.[0]?.value, "flag{human}");
    eq("A5 solved 后 flagCandidate 兼容字段", humanSnap.task?.flagCandidate, "flag{human}");
    eq("A5 solved 后来源 session=human", humanSnap.flags?.[0]?.sources[0]?.sessionId, "human");
    await hub.dispatch({ type: "task.setStatus", taskId: humanTask.id, status: "open" });
    const reopenedSnap = hub.snapshot();
    eq("A5 改回 open 清空候选", reopenedSnap.flags?.length, 0);
    eq("A5 改回 open 清空 flagCandidate", reopenedSnap.task?.flagCandidate, null);

    // ---------- A6：跨任务隔离（A/B 各自快照） ----------
    hub.setTask(a.id);
    const finalA = hub.snapshot();
    check(
      "A6 A 快照不含 B 的候选",
      (finalA.flags ?? []).every((f) => f.taskId === a.id),
      JSON.stringify((finalA.flags ?? []).map((f) => f.taskId)),
    );
    hub.setTask(b.id);
    const finalB = hub.snapshot();
    check(
      "A6 B 快照不含 A 的候选",
      (finalB.flags ?? []).every((f) => f.taskId === b.id),
      JSON.stringify((finalB.flags ?? []).map((f) => f.taskId)),
    );

    // ================================================================
    // B 组：submit_fact 真实桥路径（bridge → fact → Hub 扫描 → store）
    // ================================================================
    console.log("\n================ P5-B B 组：submit_fact 来源 ================\n");
    const h = hub;
    const bridgeFor = (taskId: string): {
      bridge: BoardBridge;
      submit: (sessionId: string, content: string, witness: string | null) => Promise<string>;
    } => {
      const bridge = new BoardBridge({
        board,
        taskId,
        runId: `p5b-${randomUUID()}`,
        workRoot: join(dir, "work"),
      });
      const route = (
        bridge as unknown as {
          route(method: string, params: Record<string, unknown>): Promise<unknown>;
        }
      ).route.bind(bridge);
      return {
        bridge,
        submit: async (sessionId, content, witness) => {
          const r = (await route(BRIDGE_RPC.submitFact, { sessionId, content, witness })) as {
            evidence: string;
          };
          return r.evidence;
        },
      };
    };
    const insertSession = (id: string, taskId: string): void => {
      board.insertSession({
        id,
        taskId,
        agent: "claude",
        role: "lead",
        tier: "guarded",
        status: "idle",
      });
    };

    // B1：witness+E2。
    const e2Task = board.createTask({ title: "B1 E2", brief: "" });
    insertSession("s-b-e2", e2Task.id);
    mkdirSync(join(dir, "work", e2Task.id), { recursive: true });
    writeFileSync(join(dir, "work", e2Task.id, "witness-e2.txt"), "前缀 flag{p5b_e2} 后缀\n");
    const brE2 = bridgeFor(e2Task.id);
    const e2Evidence = await brE2.submit("s-b-e2", "flag{p5b_e2}", "witness-e2.txt");
    eq("B1 submit_fact inferEvidence=E2", e2Evidence, "E2");
    h!.setTask(e2Task.id);
    h!.publishBoardSince(0);
    const e2Cand = board.getFlagCandidate(e2Task.id, "flag{p5b_e2}");
    const e2Sources = e2Cand ? board.listFlagSources(e2Cand.id) : [];
    eq("B1 候选 evidence=E2", e2Cand?.evidence, "E2");
    eq("B1 来源 witness 正确", e2Sources[0]?.witness, "witness-e2.txt");
    eq("B1 来源 evidence=E2", e2Sources[0]?.evidence, "E2");
    eq("B1 来源 session 正确", e2Sources[0]?.session_id, "s-b-e2");
    brE2.bridge.stop();

    // B2：witness+E1。
    const e1Task = board.createTask({ title: "B2 E1", brief: "" });
    insertSession("s-b-e1", e1Task.id);
    mkdirSync(join(dir, "work", e1Task.id), { recursive: true });
    writeFileSync(join(dir, "work", e1Task.id, "witness-e1.txt"), "这里没有提交的 flag\n");
    const brE1 = bridgeFor(e1Task.id);
    const e1Evidence = await brE1.submit("s-b-e1", "flag{p5b_e1}", "witness-e1.txt");
    eq("B2 submit_fact inferEvidence=E1", e1Evidence, "E1");
    h!.setTask(e1Task.id);
    h!.publishBoardSince(0);
    const e1Cand = board.getFlagCandidate(e1Task.id, "flag{p5b_e1}");
    eq("B2 候选 evidence=E1", e1Cand?.evidence, "E1");
    eq("B2 来源 evidence=E1", board.listFlagSources(e1Cand!.id)[0]?.evidence, "E1");
    brE1.bridge.stop();

    // B3：无 witness → E0。
    const e0Task = board.createTask({ title: "B3 E0", brief: "" });
    insertSession("s-b-e0", e0Task.id);
    const brE0 = bridgeFor(e0Task.id);
    const e0Evidence = await brE0.submit("s-b-e0", "flag{p5b_e0}", null);
    eq("B3 submit_fact inferEvidence=E0", e0Evidence, "E0");
    h!.setTask(e0Task.id);
    h!.publishBoardSince(0);
    const e0Cand = board.getFlagCandidate(e0Task.id, "flag{p5b_e0}");
    eq("B3 候选 evidence=E0", e0Cand?.evidence, "E0");
    eq("B3 来源 evidence=E0", board.listFlagSources(e0Cand!.id)[0]?.evidence, "E0");
    brE0.bridge.stop();

    // B4：同 fact 两次提交（不同 session）→ 一条候选、两条来源。
    const multiTask = board.createTask({ title: "B4 多来源", brief: "" });
    insertSession("s-b-m1", multiTask.id);
    insertSession("s-b-m2", multiTask.id);
    const brM1 = bridgeFor(multiTask.id);
    const brM2 = bridgeFor(multiTask.id);
    await brM1.submit("s-b-m1", "flag{p5b_multi}", null);
    await brM2.submit("s-b-m2", "flag{p5b_multi}", null);
    h!.setTask(multiTask.id);
    h!.publishBoardSince(0);
    const multiCand = board.getFlagCandidate(multiTask.id, "flag{p5b_multi}");
    const multiSources = multiCand ? board.listFlagSources(multiCand.id) : [];
    eq("B4 同 flag 候选数 1", board.listFlagCandidates(multiTask.id).length, 1);
    eq("B4 两个 session → 两条来源", multiSources.length, 2);
    check(
      "B4 来源 session 是 m1/m2",
      multiSources.map((s) => s.session_id).sort().join(",") === "s-b-m1,s-b-m2",
      multiSources.map((s) => s.session_id).join(","),
    );
    brM1.bridge.stop();
    brM2.bridge.stop();

    // B5：同 session 同 witness 重复提交 → 来源去重。
    const dedupeTask = board.createTask({ title: "B5 来源去重", brief: "" });
    insertSession("s-b-d", dedupeTask.id);
    const brD = bridgeFor(dedupeTask.id);
    await brD.submit("s-b-d", "flag{p5b_dedupe}", null);
    await brD.submit("s-b-d", "flag{p5b_dedupe}", null);
    h!.setTask(dedupeTask.id);
    h!.publishBoardSince(0);
    const dedupeCand = board.getFlagCandidate(dedupeTask.id, "flag{p5b_dedupe}");
    eq("B5 同 session 同 witness 只一条来源", board.listFlagSources(dedupeCand!.id).length, 1);
    brD.bridge.stop();

    // B6：E0 + E2 → 候选证据 E2。
    const maxTask = board.createTask({ title: "B6 证据最高", brief: "" });
    insertSession("s-b-x1", maxTask.id);
    insertSession("s-b-x2", maxTask.id);
    mkdirSync(join(dir, "work", maxTask.id), { recursive: true });
    writeFileSync(join(dir, "work", maxTask.id, "witness-max.txt"), "flag{p5b_max}\n");
    const brX1 = bridgeFor(maxTask.id);
    const brX2 = bridgeFor(maxTask.id);
    await brX1.submit("s-b-x1", "flag{p5b_max}", null);
    await brX2.submit("s-b-x2", "flag{p5b_max}", "witness-max.txt");
    h!.setTask(maxTask.id);
    h!.publishBoardSince(0);
    const maxCand = board.getFlagCandidate(maxTask.id, "flag{p5b_max}");
    eq("B6 多来源证据取最高 E2", maxCand?.evidence, "E2");
    eq("B6 来源数 2", board.listFlagSources(maxCand!.id).length, 2);
    brX1.bridge.stop();
    brX2.bridge.stop();

    // B7：跨任务隔离。
    const crossA = board.createTask({ title: "B7 A", brief: "" });
    const crossB = board.createTask({ title: "B7 B", brief: "" });
    insertSession("s-b-ca", crossA.id);
    insertSession("s-b-cb", crossB.id);
    const brCA = bridgeFor(crossA.id);
    const brCB = bridgeFor(crossB.id);
    await brCA.submit("s-b-ca", "flag{p5b_cross_a}", null);
    await brCB.submit("s-b-cb", "flag{p5b_cross_b}", null);
    h!.setTask(crossB.id);
    h!.publishBoardSince(0);
    const crossBCand = board.getFlagCandidate(crossB.id, "flag{p5b_cross_b}");
    check("B7 B 焦点只看到 B 的候选", Boolean(crossBCand), JSON.stringify(h!.snapshot().flags));
    eq("B7 A 的 fact 未污染 B", board.getFlagCandidate(crossB.id, "flag{p5b_cross_a}"), undefined);
    h!.setTask(crossA.id);
    h!.publishBoardSince(0);
    check("B7 切到 A 后 A 候选出现", Boolean(board.getFlagCandidate(crossA.id, "flag{p5b_cross_a}")));
    eq("B7 A 的 fact 不写进 B 候选", board.getFlagCandidate(crossB.id, "flag{p5b_cross_a}"), undefined);
    brCA.bridge.stop();
    brCB.bridge.stop();

    // B8：maybeStartConvergence 触发后 fact 来源进 flag_sources。
    const convTask = board.createTask({ title: "B8 收敛来源", brief: "" });
    insertSession("s-b-conv", convTask.id);
    mkdirSync(join(dir, "work", convTask.id), { recursive: true });
    writeFileSync(join(dir, "work", convTask.id, "witness-conv.txt"), "无 flag 内容\n");
    const convRec = {
      id: "s-b-conv",
      taskId: convTask.id,
      agent: "claude",
      role: "lead",
      tier: "guarded",
      acpSession: null,
      status: "running",
      toolCalls: 0,
      lastBoardReadAt: 0,
      boardReads: 0,
      expectedExit: false,
      model: null,
      startedAt: 0,
      endedAt: null,
      hidden: false,
    };
    const convSessions = {
      listSessions: (taskId?: string) => (taskId === convTask.id ? [convRec] : []),
      getSession: (id: string) => (id === convRec.id ? convRec : undefined),
      syncLag: () => 0,
      historyOf: () => [],
    } as unknown as SessionManager;
    const convHub = new HubService({
      board,
      sessions: convSessions,
      bus: new EventBus(),
      workspaceRoot: dir,
      workDir: join(dir, "work"),
      maxSessionsPerTask: 3,
      maxSessionsTotal: 8,
      convergeGraceMs: 300,
    });
    convHub.setTask(convTask.id);
    const brConv = bridgeFor(convTask.id);
    await brConv.submit("s-b-conv", "flag{p5b_conv}", "witness-conv.txt");
    // 先以 E0 从 stream 入库，再让 fact 扫描/maybeStartConvergence 补 E1 来源。
    convHub.publishStreamUpdate("s-b-conv", {
      ts: Date.now(),
      kind: "agent_message",
      text: "结果 flag{p5b_conv}",
    });
    convHub.publishBoardSince(0);
    const convCand = board.getFlagCandidate(convTask.id, "flag{p5b_conv}");
    const convSources = convCand ? board.listFlagSources(convCand.id) : [];
    eq("B8 收敛候选 evidence=E1", convCand?.evidence, "E1");
    check(
      "B8 收敛 fact 来源进 flag_sources",
      convSources.some((s) => s.evidence === "E1" && s.witness === "witness-conv.txt"),
      JSON.stringify(convSources),
    );
    brConv.bridge.stop();

    // ================================================================
    // C 组：P5-C 批次 1 —— 确认 / 误报 / 导出（不提交、不写文件）
    // ================================================================
    console.log("\n================ P5-C C 组：确认 / 误报 / 导出 ================\n");
    type FlagUpdated = {
      type: "flag.updated";
      taskId: string;
      flags: Array<{ id: string; value: string; status: string }>;
    };
    type ExportJson = {
      format?: string;
      candidateCount?: number;
      tasks?: Array<{
        taskId: string;
        title: string;
        status: string;
        candidates: Array<{
          value: string;
          status: string;
          evidence: string;
          sources: Array<{
            sessionId: string | null;
            witness: string | null;
            evidence: string;
            seenAt: number;
          }>;
        }>;
      }>;
    };

    const cBus = new EventBus();
    const cHub = new HubService({
      board,
      sessions: emptySessions,
      bus: cBus,
      workspaceRoot: dir,
      workDir: join(dir, "work"),
      maxSessionsPerTask: 3,
      maxSessionsTotal: 8,
    });
    const cEvents: HubEvent[] = [];
    cBus.on((e) => cEvents.push(e));

    const auditAfter = (after: number) =>
      board.raw("SELECT id, actor, action, detail FROM audit WHERE id > ? ORDER BY id ASC", after) as Array<{
        id: number;
        actor: string;
        action: string;
        detail: string | null;
      }>;
    const eventsAfter = (after: number) =>
      board.raw("SELECT id, kind, subject, body FROM events WHERE id > ? ORDER BY id ASC", after) as Array<{
        id: number;
        kind: string;
        subject: string | null;
        body: string;
      }>;
    const lastAuditId = (): number =>
      Number((board.raw("SELECT COALESCE(MAX(id), 0) AS m FROM audit")[0] as { m: number }).m);
    const listWorkFiles = (): string[] => {
      try {
        return (readdirSync(join(dir, "work"), { recursive: true }) as string[]).map(String).sort();
      } catch {
        return [];
      }
    };
    const parseJson = (s: string | undefined): unknown => {
      try {
        return s ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    };
    const tryValidate = (
      raw: unknown,
      ctx?: unknown,
    ): { ok: boolean; action?: { type: string }; error?: string } => {
      try {
        return { ok: true, action: validateHubAction(raw, ctx as never) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };

    const cTaskA = board.createTask({ title: "C 组任务 A", brief: "" });
    const cTaskB = board.createTask({ title: "C 组任务 B", brief: "" });
    const cCandA1 = board.addFlagCandidate({
      taskId: cTaskA.id,
      value: "flag{c_a1}",
      sessionId: "s-c-a1",
      witness: "evidence/c-a1.txt",
      evidence: "E1",
    });
    board.addFlagSource(cCandA1.candidate.id, {
      sessionId: "s-c-a1",
      witness: "evidence/c-a1.txt",
      evidence: "E1",
      seenAt: 1000,
    });
    const cCandA2 = board.addFlagCandidate({
      taskId: cTaskA.id,
      value: "flag{c_a2}",
      sessionId: "s-c-a2",
      witness: null,
      evidence: "E0",
    });
    const cCandB1 = board.addFlagCandidate({
      taskId: cTaskB.id,
      value: "flag{c_b1}",
      sessionId: "s-c-b1",
      witness: null,
      evidence: "E0",
    });
    cHub.setTask(cTaskA.id);
    cEvents.length = 0;

    // ---------- C1：flag.confirm 写候选状态、answer、solved ----------
    let beforeEvent = board.lastEventId();
    let beforeAudit = lastAuditId();
    const confirmRes = await cHub.dispatch({
      type: "flag.confirm",
      taskId: cTaskA.id,
      candidateId: cCandA1.candidate.id,
    });
    check("C1 flag.confirm 返回 ok", confirmRes.ok === true, JSON.stringify(confirmRes));
    eq(
      "C1 候选 status=confirmed",
      board.listFlagCandidates(cTaskA.id).find((c) => c.id === cCandA1.candidate.id)?.status,
      "confirmed",
    );
    const cTaskARow = board.getTask(cTaskA.id);
    eq("C1 任务 status=solved", cTaskARow?.status, "solved");
    eq("C1 任务 answer=候选值", cTaskARow?.answer, "flag{c_a1}");
    eq("C1 solved_by=human", cTaskARow?.solved_by, "human");
    eq("C1 候选没有被删除（仍 2 条）", board.listFlagCandidates(cTaskA.id).length, 2);
    const confirmEvents = eventsAfter(beforeEvent).filter((e) =>
      e.body.includes('"what":"flag.confirm"'),
    );
    check("C1 events 有 flag.confirm", confirmEvents.length === 1, JSON.stringify(confirmEvents));
    check(
      "C1 flag.confirm 事件不含 flag 明文",
      confirmEvents.every((e) => !e.body.includes("flag{c_a1}")),
      JSON.stringify(confirmEvents),
    );
    const confirmAudit = auditAfter(beforeAudit).filter((a) => a.action === "flag.confirm");
    eq("C1 审计有 flag.confirm", confirmAudit.length, 1);
    check(
      "C1 审计 flag.confirm 不含 flag 明文",
      confirmAudit.every((a) => !String(a.detail ?? "").includes("flag{c_a1}")),
      JSON.stringify(confirmAudit),
    );
    const confirmUpdated = cEvents
      .filter(
        (e) =>
          (e as { type: string }).type === "flag.updated" &&
          (e as { taskId?: string }).taskId === cTaskA.id,
      )
      .pop() as unknown as FlagUpdated | undefined;
    eq("C1 广播 flag.updated taskId", confirmUpdated?.taskId, cTaskA.id);
    eq(
      "C1 flag.updated 里候选已 confirmed",
      confirmUpdated?.flags.find((f) => f.id === cCandA1.candidate.id)?.status,
      "confirmed",
    );
    check(
      "C1 广播 task.upsert 带 answer/status",
      cEvents.some(
        (e) =>
          e.type === "task.upsert" &&
          e.task.id === cTaskA.id &&
          e.task.status === "solved" &&
          e.task.answer === "flag{c_a1}",
      ),
      JSON.stringify(cEvents.map((e) => e.type)),
    );
    eq("C1 A confirm 后 B 候选仍 new", board.getFlagCandidate(cTaskB.id, "flag{c_b1}")?.status, "new");
    eq("C1 A confirm 后 B 任务仍未解", board.getTask(cTaskB.id)?.status, "open");

    // C1b：P5-A 的 task.setStatus solved 先建 human 候选（status=new），
    // 再 confirm 时只翻候选状态，不重复写 answer 事件、不触发 clearFlagCandidates。
    const cSolveTask = board.createTask({ title: "C1b 先 solved 再确认", brief: "" });
    await cHub.dispatch({
      type: "task.setStatus",
      taskId: cSolveTask.id,
      status: "solved",
      answer: "flag{c_solve}",
    });
    const solvedCand = board.listFlagCandidates(cSolveTask.id).find((c) => c.value === "flag{c_solve}");
    check("C1b P5-A solved 生成 human 候选", Boolean(solvedCand));
    eq("C1b P5-A 候选初始 status=new", solvedCand?.status, "new");
    const preAnswerEvents = eventsAfter(0).filter(
      (e) => e.subject === cSolveTask.id && e.kind === "answer",
    ).length;
    const overlapRes = solvedCand
      ? await cHub.dispatch({ type: "flag.confirm", taskId: cSolveTask.id, candidateId: solvedCand.id })
      : { ok: false, error: "no candidate" };
    check("C1b 对 P5-A 候选 confirm 成功", overlapRes.ok === true, JSON.stringify(overlapRes));
    eq(
      "C1b 候选变 confirmed",
      board.listFlagCandidates(cSolveTask.id).find((c) => c.id === solvedCand?.id)?.status,
      "confirmed",
    );
    eq("C1b 候选仍 1 条（没有 DELETE/重复）", board.listFlagCandidates(cSolveTask.id).length, 1);
    eq("C1b task.answer 不变", board.getTask(cSolveTask.id)?.answer, "flag{c_solve}");
    const postAnswerEvents = eventsAfter(0).filter(
      (e) => e.subject === cSolveTask.id && e.kind === "answer",
    ).length;
    eq("C1b confirm 不重复写 answer 事件", postAnswerEvents, preAnswerEvents);

    // ---------- C2：confirm 的拒绝路径 ----------
    cEvents.length = 0;
    const crossConfirm = await cHub.dispatch({
      type: "flag.confirm",
      taskId: cTaskA.id,
      candidateId: cCandB1.candidate.id,
    });
    eq("C2 跨任务 candidateId 被拒", crossConfirm.ok, false);
    eq("C2 跨任务拒绝后 B 候选仍 new", board.getFlagCandidate(cTaskB.id, "flag{c_b1}")?.status, "new");
    const missingConfirm = await cHub.dispatch({
      type: "flag.confirm",
      taskId: cTaskA.id,
      candidateId: "flag-nope",
    });
    eq("C2 不存在的 candidateId 被拒", missingConfirm.ok, false);

    const cArchTask = board.createTask({ title: "C2 已归档", brief: "" });
    const cArchCandidate = board.addFlagCandidate({ taskId: cArchTask.id, value: "flag{c_arch}" });
    board.archiveTask(cArchTask.id, { force: true });
    const archConfirm = await cHub.dispatch({
      type: "flag.confirm",
      taskId: cArchTask.id,
      candidateId: cArchCandidate.candidate.id,
    });
    eq("C2 已归档任务 confirm 被拒", archConfirm.ok, false);
    eq(
      "C2 已归档任务候选仍 new",
      board.getFlagCandidate(cArchTask.id, "flag{c_arch}")?.status,
      "new",
    );

    // ---------- C3：flag.reject 标误报、保留候选、不写 answer ----------
    const cRejTask = board.createTask({ title: "C3 误报", brief: "" });
    const cRejCandidate = board.addFlagCandidate({
      taskId: cRejTask.id,
      value: "flag{c_rej}",
      sessionId: "s-c-rej",
      evidence: "E1",
    });
    cHub.setTask(cRejTask.id);
    cEvents.length = 0;
    beforeEvent = board.lastEventId();
    beforeAudit = lastAuditId();
    const rejectRes = await cHub.dispatch({
      type: "flag.reject",
      taskId: cRejTask.id,
      candidateId: cRejCandidate.candidate.id,
    });
    check("C3 flag.reject 返回 ok", rejectRes.ok === true, JSON.stringify(rejectRes));
    eq(
      "C3 候选 status=false_positive",
      board.getFlagCandidate(cRejTask.id, "flag{c_rej}")?.status,
      "false_positive",
    );
    eq("C3 候选未被删除", board.listFlagCandidates(cRejTask.id).length, 1);
    eq("C3 不写 task.answer", board.getTask(cRejTask.id)?.answer, null);
    eq("C3 不改任务 status", board.getTask(cRejTask.id)?.status, "open");
    const rejectEvents = eventsAfter(beforeEvent).filter((e) =>
      e.body.includes('"what":"flag.reject"'),
    );
    check("C3 events 有 flag.reject", rejectEvents.length === 1, JSON.stringify(rejectEvents));
    check(
      "C3 flag.reject 事件不含 flag 明文",
      rejectEvents.every((e) => !e.body.includes("flag{c_rej}")),
      JSON.stringify(rejectEvents),
    );
    const rejectAudit = auditAfter(beforeAudit).filter((a) => a.action === "flag.reject");
    eq("C3 审计有 flag.reject", rejectAudit.length, 1);
    const rejectUpdated = cEvents
      .filter(
        (e) =>
          (e as { type: string }).type === "flag.updated" &&
          (e as { taskId?: string }).taskId === cRejTask.id,
      )
      .pop() as unknown as FlagUpdated | undefined;
    eq("C3 flag.updated 状态 false_positive", rejectUpdated?.flags[0]?.status, "false_positive");
    eq("C3 A reject 后 B 候选仍 new", board.getFlagCandidate(cTaskB.id, "flag{c_b1}")?.status, "new");

    // ---------- C4：flag.export md/csv/json，不写文件、不记 flag 明文 ----------
    cHub.setTask(cTaskA.id);
    const workBefore = listWorkFiles();
    beforeEvent = board.lastEventId();
    beforeAudit = lastAuditId();
    const expMd = await cHub.dispatch({ type: "flag.export", taskId: cTaskA.id, format: "md" });
    const md = expMd.content ?? "";
    check("C4 md 导出返回 ok", expMd.ok === true, JSON.stringify(expMd));
    check("C4 md content 是字符串", typeof expMd.content === "string" && md.length > 0, `len=${md.length}`);
    check("C4 md 含任务 A 标题", md.includes("C 组任务 A"), md.slice(0, 160));
    check("C4 md 含候选 c_a1/c_a2", md.includes("flag{c_a1}") && md.includes("flag{c_a2}"));
    check("C4 md 含 confirmed 状态", md.includes("confirmed"));
    check("C4 md 含来源 witness", md.includes("evidence/c-a1.txt"));
    check("C4 md 不含 B 任务候选", !md.includes("flag{c_b1}"));
    eq("C4 导出不写文件（work 目录不变）", JSON.stringify(listWorkFiles()), JSON.stringify(workBefore));
    const exportEvents = eventsAfter(beforeEvent).filter((e) =>
      e.body.includes('"what":"flag.export"'),
    );
    check("C4 events 有 flag.export", exportEvents.length === 1, JSON.stringify(exportEvents));
    check(
      "C4 flag.export 事件只记 format/count，不含 flag",
      exportEvents.every(
        (e) =>
          !e.body.includes("flag{c_a1}") &&
          e.body.includes('"format":"md"') &&
          e.body.includes('"count":2'),
      ),
      JSON.stringify(exportEvents),
    );
    const exportAudit = auditAfter(beforeAudit).filter((a) => a.action === "flag.export");
    check(
      "C4 审计有 flag.export（只记 format/count）",
      exportAudit.length === 1 &&
        !String(exportAudit[0]?.detail ?? "").includes("flag{c_a1}") &&
        String(exportAudit[0]?.detail ?? "").includes('"count":2'),
      JSON.stringify(exportAudit),
    );

    const expCsv = await cHub.dispatch({ type: "flag.export", taskId: cTaskA.id, format: "csv" });
    const csv = expCsv.content ?? "";
    check(
      "C4 csv 首行表头",
      csv.split("\n")[0] ===
        "taskId,taskTitle,taskStatus,flag,status,evidence,sources,firstSeen,submittedAt",
      csv.split("\n")[0],
    );
    check("C4 csv 含两行候选", csv.trim().split("\n").length === 3, `lines=${csv.trim().split("\n").length}`);
    check("C4 csv 含 confirmed 与 E1", csv.includes("confirmed") && csv.includes("E1"));
    check("C4 csv 不含 B 任务候选", !csv.includes("flag{c_b1}"));

    const cEscTask = board.createTask({ title: '导出,任务"引号"', brief: "" });
    board.addFlagCandidate({ taskId: cEscTask.id, value: "flag{c_esc}", evidence: "E0" });
    const expEsc = await cHub.dispatch({ type: "flag.export", taskId: cEscTask.id, format: "csv" });
    check(
      "C4 csv 正确转义逗号/引号",
      (expEsc.content ?? "").includes('"导出,任务""引号"""'),
      (expEsc.content ?? "").slice(0, 200),
    );

    const expJson = await cHub.dispatch({ type: "flag.export", taskId: cTaskA.id, format: "json" });
    const parsed = parseJson(expJson.content) as ExportJson | null;
    check("C4 json 可解析", parsed !== null, expJson.content?.slice(0, 200));
    eq("C4 json format", parsed?.format, "json");
    eq("C4 json candidateCount=2", parsed?.candidateCount, 2);
    eq("C4 json 任务数=1", parsed?.tasks?.length, 1);
    eq("C4 json 任务 id", parsed?.tasks?.[0]?.taskId, cTaskA.id);
    eq("C4 json 含两个候选", parsed?.tasks?.[0]?.candidates?.length, 2);
    eq(
      "C4 json 候选状态",
      parsed?.tasks?.[0]?.candidates?.find((c) => c.value === "flag{c_a1}")?.status,
      "confirmed",
    );
    eq(
      "C4 json sources 保留",
      parsed?.tasks?.[0]?.candidates?.find((c) => c.value === "flag{c_a1}")?.sources?.length,
      1,
    );
    check("C4 json 不含 B 任务候选", !(expJson.content ?? "").includes("flag{c_b1}"));

    const expAll = await cHub.dispatch({ type: "flag.export", format: "json" });
    const allParsed = parseJson(expAll.content) as ExportJson | null;
    check(
      "C4 无 taskId 导出全部有候选的任务",
      (allParsed?.tasks ?? []).some((t) => t.taskId === cTaskA.id) &&
        (allParsed?.tasks ?? []).some((t) => t.taskId === cTaskB.id),
      JSON.stringify((allParsed?.tasks ?? []).map((t) => t.taskId)),
    );
    check(
      "C4 全部导出不包含空候选任务",
      (allParsed?.tasks ?? []).every((t) => t.candidates.length > 0),
      JSON.stringify((allParsed?.tasks ?? []).map((t) => [t.taskId, t.candidates.length])),
    );

    // ---------- C5：validate-action 结构/语义校验 ----------
    const vConfirm = tryValidate({
      type: "flag.confirm",
      taskId: cTaskA.id,
      candidateId: cCandA1.candidate.id,
    });
    check("C5 validate confirm", vConfirm.ok && vConfirm.action?.type === "flag.confirm", vConfirm.error);
    const vReject = tryValidate({
      type: "flag.reject",
      taskId: cTaskA.id,
      candidateId: cCandA1.candidate.id,
    });
    check("C5 validate reject", vReject.ok && vReject.action?.type === "flag.reject", vReject.error);
    const vExport = tryValidate({ type: "flag.export", taskId: cTaskA.id, format: "json" });
    check("C5 validate export", vExport.ok && vExport.action?.type === "flag.export", vExport.error);
    const vExportAll = tryValidate({ type: "flag.export", format: "md" });
    check(
      "C5 validate export 无 taskId",
      vExportAll.ok && vExportAll.action?.type === "flag.export",
      vExportAll.error,
    );
    check("C5 非法 format 被拒", !tryValidate({ type: "flag.export", format: "xml" }).ok);
    check(
      "C5 confirm 缺 taskId 被拒",
      !tryValidate({ type: "flag.confirm", candidateId: cCandA1.candidate.id }).ok,
    );
    check("C5 confirm 缺 candidateId 被拒", !tryValidate({ type: "flag.confirm", taskId: cTaskA.id }).ok);
    const ctx = {
      task: (id: string) =>
        id === cTaskA.id ? { archived: false } : id === cArchTask.id ? { archived: true } : undefined,
      candidate: (taskId: string, candidateId: string) =>
        taskId === cTaskA.id && candidateId === cCandA1.candidate.id ? { id: candidateId } : undefined,
    };
    check(
      "C5 ctx 校验 candidate 归属",
      !tryValidate(
        { type: "flag.confirm", taskId: cTaskA.id, candidateId: cCandB1.candidate.id },
        ctx,
      ).ok,
    );
    check(
      "C5 ctx 拒绝已归档任务导出",
      !tryValidate({ type: "flag.export", taskId: cArchTask.id, format: "md" }, ctx).ok,
    );
    check(
      "C5 ctx 通过合法 confirm",
      tryValidate({ type: "flag.confirm", taskId: cTaskA.id, candidateId: cCandA1.candidate.id }, ctx).ok,
    );

    // ---------- C6：跨任务隔离最终检查 ----------
    eq("C6 B 任务最终仍未解", board.getTask(cTaskB.id)?.status, "open");
    eq("C6 B 任务最终无 answer", board.getTask(cTaskB.id)?.answer, null);
    eq("C6 B 候选最终仍 new", board.getFlagCandidate(cTaskB.id, "flag{c_b1}")?.status, "new");
    eq("C6 A 任务最终 solved", board.getTask(cTaskA.id)?.status, "solved");
    eq("C6 A 任务最终 answer", board.getTask(cTaskA.id)?.answer, "flag{c_a1}");
    eq("C6 A 候选最终 confirmed", board.getFlagCandidate(cTaskA.id, "flag{c_a1}")?.status, "confirmed");
    eq("C6 A 第二候选仍 new", board.getFlagCandidate(cTaskA.id, "flag{c_a2}")?.status, "new");

    // ================================================================
    // D 组：P5-D 批次 1 —— flag.submit（manual / dry-run / 拒 command）+ 记分板
    // ================================================================
    console.log("\n================ P5-D D 组：提交 / 记分板 ================\n");
    const p5dDir = mkdtempSync(join(tmpdir(), "bumimang-p5d-"));
    const p5dBoard = Blackboard.open(join(p5dDir, "board.db"));
    const p5dBus = new EventBus();
    const p5dEvents: HubEvent[] = [];
    p5dBus.on((e) => p5dEvents.push(e));
    const p5dHub = new HubService({
      board: p5dBoard,
      sessions: emptySessions,
      bus: p5dBus,
      workspaceRoot: p5dDir,
      workDir: join(p5dDir, "work"),
      maxSessionsPerTask: 3,
      maxSessionsTotal: 8,
    });
    const p5dFiles = (): string[] => {
      try {
        return (readdirSync(p5dDir, { recursive: true }) as string[]).map(String).sort();
      } catch {
        return [];
      }
    };
    const p5dEventsAfter = (after: number) =>
      p5dBoard.raw("SELECT id, subject, body FROM events WHERE id > ? ORDER BY id ASC", after) as Array<{
        id: number;
        subject: string | null;
        body: string;
      }>;
    const p5dAuditAfter = (after: number) =>
      p5dBoard.raw("SELECT id, action, detail FROM audit WHERE id > ? ORDER BY id ASC", after) as Array<{
        id: number;
        action: string;
        detail: string | null;
      }>;
    const p5dLastAuditId = (): number =>
      Number((p5dBoard.raw("SELECT COALESCE(MAX(id), 0) AS m FROM audit")[0] as { m: number }).m);

    try {
      const p5dA = p5dBoard.createTask({ title: "P5D 任务 A", brief: "" });
      const p5dB = p5dBoard.createTask({ title: "P5D 任务 B", brief: "" });
      const p5dC = p5dBoard.createTask({ title: "P5D 任务 C", brief: "" });
      p5dBoard.raw("UPDATE tasks SET points = ? WHERE id = ?", 50, p5dA.id);
      p5dBoard.raw("UPDATE tasks SET points = ? WHERE id = ?", 100, p5dB.id);
      const p5dCandA = p5dBoard.addFlagCandidate({
        taskId: p5dA.id,
        value: "flag{p5d_a}",
        sessionId: "s-p5d-a",
        witness: "evidence/p5d-a.txt",
        evidence: "E1",
      });
      p5dBoard.addFlagSource(p5dCandA.candidate.id, {
        sessionId: "s-p5d-a",
        witness: "evidence/p5d-a.txt",
        evidence: "E1",
      });
      const p5dCandB = p5dBoard.addFlagCandidate({
        taskId: p5dB.id,
        value: "flag{p5d_b}",
        sessionId: "s-p5d-b",
        evidence: "E2",
      });
      p5dBoard.setTaskStatus(p5dB.id, "solved", "flag{p5d_b}");
      p5dHub.setTask(p5dA.id);
      p5dEvents.length = 0;

      // ---------- D1：记分板 ----------
      const p5dSnap = p5dHub.snapshot();
      const p5dSb = p5dSnap.scoreboard;
      check("D1 快照带 scoreboard", Boolean(p5dSb), JSON.stringify(p5dSb));
      eq("D1 scoreboard.total=3", p5dSb?.total, 3);
      eq("D1 scoreboard.solved=1", p5dSb?.solved, 1);
      eq("D1 scoreboard.points=150", p5dSb?.points, 150);
      const p5dSbA = p5dSb?.tasks.find((t) => t.taskId === p5dA.id);
      const p5dSbB = p5dSb?.tasks.find((t) => t.taskId === p5dB.id);
      const p5dSbC = p5dSb?.tasks.find((t) => t.taskId === p5dC.id);
      eq("D1 A points=50", p5dSbA?.points, 50);
      eq("D1 A flagCount=1", p5dSbA?.flagCount, 1);
      eq("D1 A status=open", p5dSbA?.status, "open");
      eq("D1 B status=solved", p5dSbB?.status, "solved");
      eq("D1 B points=100", p5dSbB?.points, 100);
      eq("D1 C points=0", p5dSbC?.points, 0);
      eq("D1 C flagCount=0", p5dSbC?.flagCount, 0);
      eq("D1 TaskView A points", p5dSnap.tasks.find((t) => t.id === p5dA.id)?.points, 50);
      eq("D1 TaskView A submitMode", p5dSnap.task?.submitMode, "manual");
      const p5dDirect = (
        p5dBoard as unknown as {
          getScoreboard?: () => { total: number; solved: number; points: number };
        }
      ).getScoreboard?.();
      eq("D1 board.getScoreboard total", p5dDirect?.total, 3);
      eq("D1 board.getScoreboard solved", p5dDirect?.solved, 1);
      eq("D1 board.getScoreboard points", p5dDirect?.points, 150);

      // ---------- D2：manual ----------
      let p5dBeforeEvent = p5dBoard.lastEventId();
      let p5dBeforeAudit = p5dLastAuditId();
      const p5dManual = await p5dHub.dispatch({
        type: "flag.submit",
        taskId: p5dA.id,
        candidateId: p5dCandA.candidate.id,
      });
      check("D2 manual 返回 ok", p5dManual.ok === true, JSON.stringify(p5dManual));
      eq("D2 manual mode=manual", p5dManual.mode, "manual");
      eq("D2 manual value", p5dManual.value, "flag{p5d_a}");
      check(
        "D2 manual instructions 非空",
        typeof p5dManual.instructions === "string" && p5dManual.instructions.length > 0,
        String(p5dManual.instructions),
      );
      const p5dAfterManual = p5dBoard.getFlagCandidateById(p5dCandA.candidate.id);
      check(
        "D2 候选 submitted_at>0",
        (p5dAfterManual?.submitted_at ?? 0) > 0,
        String(p5dAfterManual?.submitted_at),
      );
      eq("D2 候选 submit_status=manual", p5dAfterManual?.submit_status, "manual");
      eq("D2 manual 不改 task.answer", p5dBoard.getTask(p5dA.id)?.answer, null);
      eq("D2 manual 不改 task.status", p5dBoard.getTask(p5dA.id)?.status, "open");
      const p5dManualEvents = p5dEventsAfter(p5dBeforeEvent).filter((e) =>
        e.body.includes('"what":"flag.submit"'),
      );
      eq("D2 events 有 flag.submit", p5dManualEvents.length, 1);
      check(
        "D2 flag.submit 事件不含 flag 明文",
        p5dManualEvents.every((e) => !e.body.includes("flag{p5d_a}")),
        JSON.stringify(p5dManualEvents),
      );
      const p5dManualAudit = p5dAuditAfter(p5dBeforeAudit).filter((a) => a.action === "flag.submit");
      eq("D2 审计有 flag.submit", p5dManualAudit.length, 1);
      check(
        "D2 审计 flag.submit 不含 flag 明文",
        p5dManualAudit.every((a) => !String(a.detail ?? "").includes("flag{p5d_a}")),
        JSON.stringify(p5dManualAudit),
      );
      const p5dFlagUpdated = p5dEvents
        .filter(
          (e) =>
            (e as { type: string }).type === "flag.updated" &&
            (e as { taskId?: string }).taskId === p5dA.id,
        )
        .pop() as unknown as
        | {
            type: "flag.updated";
            taskId: string;
            flags: Array<{ id: string; submittedAt?: number | null; submitStatus?: string | null }>;
          }
        | undefined;
      eq(
        "D2 flag.updated submitStatus=manual",
        p5dFlagUpdated?.flags.find((f) => f.id === p5dCandA.candidate.id)?.submitStatus,
        "manual",
      );
      eq(
        "D2 flag.updated submittedAt=库值",
        p5dFlagUpdated?.flags.find((f) => f.id === p5dCandA.candidate.id)?.submittedAt,
        p5dAfterManual?.submitted_at,
      );

      // ---------- D3：dry-run（只预览 argv，不执行、不写文件、不改候选） ----------
      p5dBeforeEvent = p5dBoard.lastEventId();
      const p5dSubmittedBefore = p5dAfterManual?.submitted_at ?? null;
      const p5dFilesBefore = p5dFiles();
      const p5dDry = await p5dHub.dispatch({
        type: "flag.submit",
        taskId: p5dA.id,
        candidateId: p5dCandA.candidate.id,
        mode: "dry_run",
      });
      check("D3 dry-run 返回 ok", p5dDry.ok === true, JSON.stringify(p5dDry));
      eq("D3 dry-run mode=dry_run", p5dDry.mode, "dry_run");
      check(
        "D3 dry-run argv 是数组",
        Array.isArray(p5dDry.argv) && p5dDry.argv.length > 0,
        JSON.stringify(p5dDry.argv),
      );
      const p5dAfterDry = p5dBoard.getFlagCandidateById(p5dCandA.candidate.id);
      eq("D3 dry-run 不改 submitted_at", p5dAfterDry?.submitted_at, p5dSubmittedBefore);
      eq("D3 dry-run 不改 submit_status", p5dAfterDry?.submit_status, "manual");
      const p5dDryEvents = p5dEventsAfter(p5dBeforeEvent).filter((e) =>
        e.body.includes('"what":"flag.submit"'),
      );
      eq("D3 dry-run 不写 flag.submit 事件", p5dDryEvents.length, 0);
      eq("D3 dry-run 不写文件", JSON.stringify(p5dFiles()), JSON.stringify(p5dFilesBefore));

      // ---------- D4：command 明确拒绝 ----------
      const p5dCmd = await p5dHub.dispatch({
        type: "flag.submit",
        taskId: p5dA.id,
        candidateId: p5dCandA.candidate.id,
        mode: "command",
      } as never);
      check("D4 command 被拒", p5dCmd.ok === false, JSON.stringify(p5dCmd));
      check(
        "D4 command 错误可读",
        String(p5dCmd.error ?? "").includes("command 模式未实现"),
        String(p5dCmd.error),
      );
      const p5dAfterCmd = p5dBoard.getFlagCandidateById(p5dCandA.candidate.id);
      eq("D4 command 不改 submitted_at", p5dAfterCmd?.submitted_at, p5dSubmittedBefore);
      eq("D4 command 不改 submit_status", p5dAfterCmd?.submit_status, "manual");

      // ---------- D5：导出补 submit_status / submitted_at ----------
      const p5dCsv = await p5dHub.dispatch({ type: "flag.export", taskId: p5dA.id, format: "csv" });
      check(
        "D5 csv 含 submit_status=manual",
        (p5dCsv.content ?? "").includes("manual"),
        (p5dCsv.content ?? "").split("\n")[1] ?? "",
      );
      check(
        "D5 csv 含 submitted_at",
        /\d{4}-\d\d-\d\dT/.test(p5dCsv.content ?? ""),
        (p5dCsv.content ?? "").split("\n")[1] ?? "",
      );
      const p5dJson = await p5dHub.dispatch({ type: "flag.export", taskId: p5dA.id, format: "json" });
      const p5dParsed = parseJson(p5dJson.content) as {
        tasks?: Array<{
          candidates?: Array<{ value?: string; submitStatus?: string; submittedAt?: number }>;
        }>;
      } | null;
      const p5dJsonCand = p5dParsed?.tasks?.[0]?.candidates?.find(
        (c) => c.value === "flag{p5d_a}",
      );
      eq("D5 JSON submitStatus=manual", p5dJsonCand?.submitStatus, "manual");
      check(
        "D5 JSON submittedAt>0",
        (p5dJsonCand?.submittedAt ?? 0) > 0,
        String(p5dJsonCand?.submittedAt),
      );
      const p5dMd = await p5dHub.dispatch({ type: "flag.export", taskId: p5dA.id, format: "md" });
      check(
        "D5 md 含提交状态",
        (p5dMd.content ?? "").includes("manual"),
        (p5dMd.content ?? "").slice(0, 200),
      );

      // ---------- D6：跨任务隔离 / 记分板不被提交影响 ----------
      eq(
        "D6 B 候选未被 A 提交影响（submit_status）",
        p5dBoard.getFlagCandidateById(p5dCandB.candidate.id)?.submit_status,
        null,
      );
      eq(
        "D6 B 候选未被 A 提交影响（submitted_at）",
        p5dBoard.getFlagCandidateById(p5dCandB.candidate.id)?.submitted_at,
        null,
      );
      const p5dSbAfterSubmit = p5dHub.snapshot().scoreboard;
      eq("D6 manual 不改 scoreboard.points", p5dSbAfterSubmit?.points, 150);
      eq("D6 manual 不改 scoreboard.solved", p5dSbAfterSubmit?.solved, 1);

      // ---------- D7：validate-action ----------
      const p5dVManual = tryValidate({
        type: "flag.submit",
        taskId: p5dA.id,
        candidateId: p5dCandA.candidate.id,
      });
      check(
        "D7 validate manual",
        p5dVManual.ok && p5dVManual.action?.type === "flag.submit",
        p5dVManual.error,
      );
      const p5dVDry = tryValidate({
        type: "flag.submit",
        taskId: p5dA.id,
        candidateId: p5dCandA.candidate.id,
        mode: "dry_run",
      });
      check(
        "D7 validate dry_run",
        p5dVDry.ok && p5dVDry.action?.type === "flag.submit",
        p5dVDry.error,
      );
      const p5dVCmd = tryValidate({
        type: "flag.submit",
        taskId: p5dA.id,
        candidateId: p5dCandA.candidate.id,
        mode: "command",
      });
      check(
        "D7 validate command 被拒且可读",
        !p5dVCmd.ok && String(p5dVCmd.error).includes("command 模式未实现"),
        p5dVCmd.error,
      );
      check(
        "D7 validate 缺 candidateId 被拒",
        !tryValidate({ type: "flag.submit", taskId: p5dA.id }).ok,
        "missing candidateId",
      );
      const p5dCtx = {
        task: (id: string) => (id === p5dA.id ? { archived: false } : undefined),
        candidate: (taskId: string, candidateId: string) =>
          taskId === p5dA.id && candidateId === p5dCandA.candidate.id
            ? { id: candidateId }
            : undefined,
      };
      check(
        "D7 ctx 校验候选归属",
        !tryValidate(
          { type: "flag.submit", taskId: p5dA.id, candidateId: p5dCandB.candidate.id },
          p5dCtx,
        ).ok,
      );
      check(
        "D7 ctx 通过合法提交",
        tryValidate(
          { type: "flag.submit", taskId: p5dA.id, candidateId: p5dCandA.candidate.id },
          p5dCtx,
        ).ok,
      );

      // ---------- D8：flag/submit 相关代码零进程/零网络 ----------
      const p5dHubSrc = readFileSync(new URL("../main/hub/hub.ts", import.meta.url), "utf8");
      const p5dSubmitStart = p5dHubSrc.indexOf('case "flag.submit"');
      const p5dSubmitEnd = p5dHubSrc.indexOf('case "attachment.import"', p5dSubmitStart);
      const p5dSubmitBlock =
        p5dSubmitStart >= 0 && p5dSubmitEnd > p5dSubmitStart
          ? p5dHubSrc.slice(p5dSubmitStart, p5dSubmitEnd)
          : "";
      check("D8 hub flag.submit 代码块存在", p5dSubmitStart >= 0, `start=${p5dSubmitStart}`);
      check(
        "D8 hub flag.submit 无 child_process/spawn/exec",
        !/\bchild_process\b|\bspawn\b|\bexec(?:File|Sync)?\b/.test(p5dSubmitBlock),
        p5dSubmitBlock.slice(0, 160),
      );
      check(
        "D8 hub flag.submit 无 fetch/http/axios",
        !/\bfetch\s*\(|https?\.request|axios/.test(p5dSubmitBlock),
        p5dSubmitBlock.slice(0, 160),
      );
      const p5dBoardSrc = readFileSync(
        new URL("../main/blackboard/board.ts", import.meta.url),
        "utf8",
      );
      const p5dSubmitApiStart = p5dBoardSrc.indexOf("updateFlagSubmitStatus");
      const p5dSubmitApiBlock =
        p5dSubmitApiStart >= 0 ? p5dBoardSrc.slice(p5dSubmitApiStart, p5dSubmitApiStart + 3000) : "";
      check(
        "D8 board 提交 API 无 child_process/spawn/exec",
        !/\bchild_process\b|\bspawn\b|\bexec(?:File|Sync)?\b/.test(p5dSubmitApiBlock),
        p5dSubmitApiBlock.slice(0, 160),
      );
      const p5dValidateSrc = readFileSync(
        new URL("../main/electron/validate-action.ts", import.meta.url),
        "utf8",
      );
      const p5dVStart = p5dValidateSrc.indexOf('case "flag.submit"');
      const p5dVEnd = p5dValidateSrc.indexOf('case "permission.revoke"', p5dVStart);
      const p5dVBlock =
        p5dVStart >= 0 && p5dVEnd > p5dVStart ? p5dValidateSrc.slice(p5dVStart, p5dVEnd) : "";
      check("D8 validate flag.submit 代码块存在", p5dVStart >= 0, `start=${p5dVStart}`);
      check(
        "D8 validate flag.submit 无 process/network",
        !/\bchild_process\b|\bspawn\b|\bexec(?:File|Sync)?\b|\bfetch\s*\(|https?\.request|axios/.test(
          p5dVBlock,
        ),
        p5dVBlock.slice(0, 160),
      );

      // ---------- D9：归档任务仍计入记分板（只读聚合，不删历史） ----------
      const p5dArch = p5dBoard.archiveTask(p5dC.id, { force: true });
      check("D9 归档任务成功", p5dArch.ok === true, JSON.stringify(p5dArch));
      const p5dSbArch = p5dHub.snapshot().scoreboard;
      eq("D9 归档后 total 仍 3", p5dSbArch?.total, 3);
      eq("D9 归档后 points 仍 150", p5dSbArch?.points, 150);
      check(
        "D9 归档任务仍在 scoreboard",
        Boolean(p5dSbArch?.tasks.some((t) => t.taskId === p5dC.id)),
        JSON.stringify(p5dSbArch?.tasks.map((t) => t.taskId)),
      );

    } finally {
      p5dBoard.close();
      rmSync(p5dDir, { recursive: true, force: true });
    }

  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
