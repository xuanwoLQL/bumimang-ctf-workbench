/**
 * 渲染进程纯逻辑冒烟测试（无 DOM、无 Electron）。
 *
 * 覆盖 T6–T10 里可脱离浏览器验证的部分：mock 快照形状、状态折叠、
 * 流式事件节流聚合、审批排序/批量、台账冲突检测、扇出动作构造、
 * 以及 Mock HubApi 的 dispatch 事件回放。
 *
 * 运行：`node apps/desktop/src/renderer/smoke.ts`
 */
import type { HubEvent, HubSnapshot, StreamUpdate } from "./contract.ts";
import { buildMockSnapshot, buildMultiTaskMockSnapshot, buildUnconfiguredSkillMockSnapshot, buildScopeMockSnapshot, buildProxyStateMockSnapshot } from "./mock/data.ts";
import {
  buildTaskBoardView,
  buildTaskSkillWarning,
  TASK_CATEGORY_OPTIONS,
  buildTaskCategoryOptions,
  normalizeTaskCategory,
  parseTaskPriority,
} from "./task.ts";
import { filterApprovals, buildTaskGrantAllAction } from "./approval/model.ts";
import { selectPaneSessions } from "./panes/model.ts";
import { createMockHub } from "./mock/engine.ts";
import {
  applySnapshot,
  applyEvent,
  Store,
  emptyState,
  buildSkillStatusView,
  buildBriefingPreview,
  buildScopeStatusView,
  SKILL_UNCONFIGURED_WARNING,
} from "./store.ts";
import { StreamThrottler, aggregateStream } from "./throttle.ts";
import { SessionStreamSink, sessionQuietHint, QUIET_HINT_AFTER_MS, MAX_THOUGHT_TEXT, MAX_WINDOW_TEXT, fitWindowStart } from "./panes/model.ts";
import {
  sortApprovals,
  pendingApprovals,
  decidedApprovals,
  statusLabel,
  sameKindLabel,
  groupBatches,
  buildDecideAction,
  buildBulkAction,
} from "./approval/model.ts";
import { findConflicts, isChallenged, normalizeContent } from "./board/model.ts";
import { buildStartAction, buildPresetActions, agentUsability, gateNoteFor, fanoutGateNote, PRESET_THREE_ENGINES } from "./fanout/model.ts";
import { sessionGateArmed, gateBadge, tierNoteFor } from "./gate.ts";
import { sessionStatusLabel, isTerminalStatus, SESSION_STATUS_LABEL } from "./session-status.ts";
import { buildScorecard, fmtElapsed, scorecardText, scorecardTextCompact, scorecardTitle } from "./scorecard.ts";
import { FIRST_RUN_KEY, buildFirstRunGuide, producingAgents, nonProducingAgents } from "./first-run.ts";
import { awdVisible, buildAwdPanelModel, formatAwdRemaining, submittableAwdFlags } from "./awd/panel.ts";
import { buildIrPanelModel, irVisible } from "./ir/panel.ts";
import {
  buildArtifactPanelView,
  buildAttachmentSelectionView,
  buildArtifactPreviewView,
  canSystemOpenArtifact,
} from "./artifacts.ts";
import { buildTargetBadge, buildTargetPanelView, TARGET_PANEL_ACTIONS } from "./targets.ts";
import { buildFlagPanelView, FLAG_EXPORT_FORMATS } from "./flags.ts";
import { approvalRuleLabel, approvalScopeTargetText } from "./approval/approval.ts";

let failures = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${name}${detail ? "  └─ " + detail : ""}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "  └─ " + detail : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

const up = (kind: StreamUpdate["kind"], extra: Partial<StreamUpdate> = {}): StreamUpdate => ({
  ts: Date.now(),
  kind,
  ...extra,
});

// ---------------------------------------------------------------- T6 骨架 + mock
section("T6 渲染进程骨架 · mock 快照与状态折叠");

const snap = buildMockSnapshot();
ok("快照有任务", snap.task?.id === "task-1", `task=${snap.task?.title}`);
ok("快照有 ≥2 会话", snap.sessions.length >= 2, `sessions=${snap.sessions.length}`);
ok("快照有 pending 审批", snap.approvals.some((a) => a.status === "pending"), `approvals=${snap.approvals.length}`);
ok(
  "快照有四类黑板视图",
  snap.board.facts.length > 0 && snap.board.deadEnds.length > 0 && snap.board.intents.length > 0 && snap.board.leases.length > 0,
  `facts=${snap.board.facts.length} deadEnds=${snap.board.deadEnds.length} intents=${snap.board.intents.length} leases=${snap.board.leases.length}`,
);
ok("快照有健康度", Object.keys(snap.health).length >= 1, `health keys=${Object.keys(snap.health).join(",")}`);
ok("快照有 4 个 agent 描述", snap.agents.length === 4, snap.agents.map((a) => `${a.id}${a.installed ? "" : "(未安装)"}`).join(" "));

const state = applySnapshot(snap);
ok("applySnapshot 折叠数量一致", state.sessions.length === snap.sessions.length && state.facts.length === snap.board.facts.length);

const store = new Store(emptyState());
store.set(applySnapshot(snap));
store.update((s) =>
  applyEvent(s, {
    type: "session.upsert",
    session: { ...snap.sessions[0], status: "stopped" },
  }),
);
ok("applyEvent(session.upsert) 原地 upsert", store.get().sessions[0].status === "stopped");

// ---------------------------------------------------------------- 会话状态文案 / 终态
section("会话状态文案 · blocked 是终态且不同于崩溃");

{
  ok("九个 SessionStatus 都有文案", Object.keys(SESSION_STATUS_LABEL).length === 9, Object.keys(SESSION_STATUS_LABEL).join(","));
  ok("blocked 文案明确是「策略切断」", sessionStatusLabel("blocked") === "被策略切断", sessionStatusLabel("blocked"));
  ok("failed 文案是「崩溃」而非「策略切断」", sessionStatusLabel("failed") === "崩溃" && sessionStatusLabel("failed") !== sessionStatusLabel("blocked"));
  ok("stopped 文案是「已停止」", sessionStatusLabel("stopped") === "已停止");
  ok(
    "blocked/done/failed/stopped 是终态，running/starting 不是",
    isTerminalStatus("blocked") && isTerminalStatus("done") && isTerminalStatus("failed") && isTerminalStatus("stopped") &&
      !isTerminalStatus("running") && !isTerminalStatus("starting") && !isTerminalStatus("idle"),
  );
}

// ---------------------------------------------------------------- T7 节流
section("T7 多窗格 · 流式事件节流聚合");

{
  const agg = aggregateStream([
    up("tool_call_update"),
    up("tool_call_update", { status: "done" }),
    up("tool_call", { title: "nmap 10.0.0.9" }),
    up("tool_call", { title: "curl /admin" }),
    up("agent_message", { text: "端口已探明" }),
  ]);
  ok("aggregateStream 折叠 tool_call_update", agg.toolCallUpdates === 2, `collapsed=${agg.toolCallUpdates}`);
  ok("aggregateStream 只数 tool_call", agg.toolCalls === 2, `toolCalls=${agg.toolCalls}`);
  ok("aggregateStream 保留重要事件", agg.items.length === 3, `items=${agg.items.length}`);
  ok("aggregateStream 取到最近 status", agg.lastStatus === "done");
}

{
  // 150 条事件 → 最多 2 次 flush（节流生效）
  let now = 0;
  const tasks: Array<() => void> = [];
  const flushed: number[] = [];
  const th = new StreamThrottler({
    windowMs: 100,
    now: () => now,
    schedule: (fn) => {
      tasks.push(fn);
      return tasks.length;
    },
    onFlush: (batch) => flushed.push(batch.length),
  });
  for (let i = 0; i < 150; i++) th.push(up("tool_call_update"));
  now = 100;
  for (const t of tasks) t();
  const total = flushed.reduce((a, b) => a + b, 0);
  ok("150 条事件被节流成 ≤2 次 flush", flushed.length <= 2, `flushes=${flushed.length}`);
  ok("节流不丢事件", total === 150, `total=${total}`);
}

{
  const sink = new SessionStreamSink("s1", { windowMs: 80, schedule: () => 0 });
  for (let i = 0; i < 150; i++) sink.push(up("tool_call_update"));
  for (let i = 0; i < 3; i++) sink.push(up("tool_call", { title: `cmd ${i}` }));
  sink.push(up("agent_message", { text: "结论" }));
  sink.flush();
  const log = sink.snapshot();
  ok("sink 折叠 150 条 tool_call_update", log.collapsed === 150, `collapsed=${log.collapsed}`);
  ok("sink 计数 3 条 tool_call", log.toolCalls === 3, `toolCalls=${log.toolCalls}`);
  ok("sink 保留 4 个对话块（3 工具 + 1 消息）", log.blocks.length === 4, `blocks=${log.blocks.length}`);
  ok(
    "sink 块顺序：3 个 tool 步在前 + 1 条消息收尾",
    log.blocks.filter((b) => b.kind === "tool").length === 3 && log.blocks[3]?.kind === "message",
    log.blocks.map((b) => b.kind).join(","),
  );
}

{
  // R16：历史回放与实时事件重叠时按 seq 去重；user_prompt 单独成块。
  const sink = new SessionStreamSink("s2", { windowMs: 80, schedule: () => 0 });
  sink.push(up("user_prompt", { seq: 1, text: "看 /robots.txt" }));
  sink.push(up("agent_message", { seq: 2, text: "发现 /backup" }));
  sink.push(up("agent_message", { seq: 2, text: "发现 /backup" })); // 重复的实时回放
  sink.push(up("agent_message", { seq: 1, text: "旧事件" })); // 迟到的旧事件
  sink.flush();
  const log = sink.snapshot();
  ok("seq 去重：重复/迟到的事件不再计块", log.blocks.length === 2, `blocks=${log.blocks.length}`);
  ok("user_prompt 单独渲染成「你」块", log.blocks[0]?.kind === "user" && log.blocks[0]?.text === "看 /robots.txt",
    log.blocks.map((b) => `${b.kind}:${b.text ?? ""}`).join(" | "));
}

{
  // R13：对话积累 —— 文本增量累加进同一个块；tool_call + tool_call_update 合成一步。
  const sink = new SessionStreamSink("s2", { windowMs: 80, schedule: () => 0 });
  sink.push(up("agent_message", { text: "第一" }));
  sink.push(up("agent_message", { text: "段" }));
  sink.push(up("tool_call", { title: "write demo.txt", toolKind: "fs/write" }));
  sink.push(up("tool_call_update", { status: "in_progress" }));
  sink.push(up("tool_call_update", { status: "completed" }));
  sink.push(up("agent_thought", { text: "想想" }));
  sink.flush();
  const log = sink.snapshot();
  const msg = log.blocks.find((b) => b.kind === "message");
  const tool = log.blocks.find((b) => b.kind === "tool");
  ok("消息块：两条 agent_message 累加成一个块", msg !== undefined && msg.text === "第一段", msg?.text ?? "null");
  ok("工具步：tool_call + tool_call_update 合成一步", log.blocks.filter((b) => b.kind === "tool").length === 1, `tools=${log.blocks.filter((b) => b.kind === "tool").length}`);
  ok("工具步：状态被原地更新为 completed", tool?.status === "completed", tool?.status ?? "null");
  ok("思考块独立成块", log.blocks.some((b) => b.kind === "thought" && b.text === "想想"));
}

// ---------------------------------------------------------------- 会话安静提示（GATE-INPUT-STARVED）
section("会话安静提示 · 0 审批 + 0 读黑板跑了有一阵");

{
  const base = { status: "running" as const, approvalsForSession: 0, boardReads: 0, now: 100_000 };
  const hint = sessionQuietHint({ ...base, startedAt: base.now - QUIET_HINT_AFTER_MS - 1 });
  ok("running + 0 审批 + 0 读黑板 + 超阈值 → 给提示", hint !== null, hint ?? "null");
  ok("提示是平静事实性的（含「不请求授权」）", (hint ?? "").includes("不请求授权"), hint ?? "null");

  ok(
    "刚启动（未达阈值）→ 不给提示",
    sessionQuietHint({ ...base, startedAt: base.now - QUIET_HINT_AFTER_MS + 5000 }) === null,
  );
  ok("非 running 状态 → 不给提示", sessionQuietHint({ ...base, status: "blocked", startedAt: 0 }) === null);
  ok("问过一次（有审批）→ 不给提示", sessionQuietHint({ ...base, approvalsForSession: 1, startedAt: 0 }) === null);
  ok("读过黑板 → 不给提示", sessionQuietHint({ ...base, boardReads: 1, startedAt: 0 }) === null);

  ok("时长格式：秒", sessionQuietHint({ ...base, startedAt: base.now - 45_000 })!.includes("45 秒"));
  ok(
    "时长格式：分秒",
    sessionQuietHint({ ...base, startedAt: base.now - (60_000 + 5_000) })!.includes("1 分 5 秒"),
  );
}

// ---------------------------------------------------------------- 每会话计分卡
section("每会话计分卡 · 墙钟/工具/读板/滞后/审批/写板");

{
  const mk = (id: string, now: number) =>
    buildScorecard({
      session: snap.sessions.find((x) => x.id === id)!,
      health: snap.health[id],
      approvals: snap.approvals,
      facts: snap.board.facts,
      deadEnds: snap.board.deadEnds,
      now,
    });

  {
    const now = snap.sessions[0].startedAt + 60_000;
    const s1 = mk("s1", now);
    const s2 = mk("s2", now);
    const s3 = mk("s3", now);
    ok("running 会话 elapsed = now - startedAt", s1.elapsedMs === 60_000, `elapsed=${s1.elapsedMs}`);
    ok("终态会话 elapsed 用 endedAt - startedAt（不看 now）", s3.elapsedMs === 1000, `elapsed=${s3.elapsedMs}`);
    ok("活动量来自 health（s1）", s1.toolCalls === 42 && s1.boardReads === 5 && s1.syncLag === 3, `tool=${s1.toolCalls} reads=${s1.boardReads} lag=${s1.syncLag}`);
    ok("无 health 的会话：tool/reads 归 0、syncLag 为 null（不是假 0）", s3.toolCalls === 0 && s3.boardReads === 0 && s3.syncLag === null, `lag=${s3.syncLag}`);
    ok("审批按 sessionId 归属：s1=2 / s2=3 / s3=0", s1.approvals === 2 && s2.approvals === 3 && s3.approvals === 0, `s1=${s1.approvals} s2=${s2.approvals} s3=${s3.approvals}`);
    ok(
      "写板 = 事实+死路按 by 归属：s1=3 / s2=1 / s3=2",
      s1.boardWrites === 3 && s2.boardWrites === 1 && s3.boardWrites === 2,
      `s1=${s1.boardWrites} s2=${s2.boardWrites} s3=${s3.boardWrites}`,
    );
    ok(
      "写板不计入意图认领/租约持锁（s1 有 i2 认领 + 租约，仍=3）",
      s1.boardWrites === 3,
      `s1=${s1.boardWrites}`,
    );
    ok(
      "tick：now 前进 5s，running 会话 elapsed 跟着涨",
      buildScorecard({ session: snap.sessions[0], health: snap.health.s1, approvals: [], facts: [], deadEnds: [], now: now + 5000 }).elapsedMs === 65_000,
    );
    ok(
      "elapsed 钳到 ≥0（endedAt < startedAt 不出现负数）",
      buildScorecard({
        session: { ...snap.sessions[0], endedAt: snap.sessions[0].startedAt - 1000 },
        health: undefined,
        approvals: [],
        facts: [],
        deadEnds: [],
        now: snap.sessions[0].startedAt,
      }).elapsedMs === 0,
    );
  }

  {
    ok(
      "fmtElapsed：秒 / 分秒 / 整分 / 时分 / 时",
      fmtElapsed(42_000) === "42s" &&
        fmtElapsed(200_000) === "3m20s" &&
        fmtElapsed(300_000) === "5m" &&
        fmtElapsed(3_720_000) === "1h2m" &&
        fmtElapsed(36_000_000) === "10h",
      `42s=${fmtElapsed(42_000)} 3m20s=${fmtElapsed(200_000)} 5m=${fmtElapsed(300_000)} 1h2m=${fmtElapsed(3_720_000)}`,
    );
  }

  {
    const now = snap.sessions[0].startedAt + 200_000; // 3m20s
    const s1 = mk("s1", now);
    const s3 = mk("s3", now);
    ok(
      "scorecardText 六字段齐全 + 运行用「已运行」",
      scorecardText(s1) === "已运行 3m20s · 工具 42 · 读板 5 · 滞后 3 · 审批 2 · 写板 3",
      scorecardText(s1),
    );
    ok(
      "scorecardText 终态用「历时」+ 无 health 滞后显示「—」",
      scorecardText(s3).startsWith("历时") && scorecardText(s3).includes("滞后 —") && scorecardText(s3).includes("审批 0") && scorecardText(s3).includes("写板 2"),
      scorecardText(s3),
    );
    ok(
      "scorecardTextCompact 只留「多久 + 干了多少活」三数",
      scorecardTextCompact(s1) === "已运行 3m20s · 工具 42 · 写板 3",
      scorecardTextCompact(s1),
    );
    ok(
      "scorecardTitle 交代写板口径（事实+死路，意图/租约不计入）",
      scorecardTitle(s1).includes("事实 + 死路") && scorecardTitle(s1).includes("不计入"),
      scorecardTitle(s1),
    );
  }
}

// ---------------------------------------------------------------- T8 审批
section("T8 审批队列 · 排序 / 批量");

{
  const pending = pendingApprovals(snap.approvals);
  ok("pendingApprovals 过滤出 4 条", pending.length === 4, `pending=${pending.length}`);
  const risks = pending.map((a) => a.risk);
  ok("风险排序：blocked/high 在前", risks[0] === "blocked" && risks[1] === "high", `order=${risks.join(",")}`);
  const sorted = sortApprovals(snap.approvals);
  ok("sortApprovals 风险优先", sorted[0].risk === "blocked", `first=${sorted[0].risk}`);
}

{
  const batches = groupBatches(pendingApprovals(snap.approvals));
  ok("groupBatches 同会话同动作聚批", batches.every((b) => b.ids.length >= 1), `batches=${batches.length}`);
  ok("buildDecideAction 形状正确", buildDecideAction("ap1", "approve").type === "approval.decide");
  ok("buildBulkAction 形状正确", buildBulkAction(["ap1", "ap2"], "deny").type === "approval.bulk");
}

// ---------------------------------------------------------------- T8b 审批面板 · 真实形状 / 空字段 / 已决
section("T8b 审批面板 · 真实形状 / 空字段 / 已决");

{
  const nullish = snap.approvals.find((a) => a.command === null && a.intentSummary === null);
  ok("mock 里有 command/target/intentSummary 全 null 的审批", Boolean(nullish), `id=${nullish?.id}`);
  const highLong = snap.approvals.find((a) => a.risk === "high" && typeof a.command === "string" && a.command.length > 60);
  ok("mock 里有高危 + 长命令的审批", Boolean(highLong), `cmd len=${highLong?.command?.length}`);

  const decided = decidedApprovals(snap.approvals);
  ok("decidedApprovals 过滤出已决项", decided.length === 1 && decided.every((a) => a.status !== "pending"), `decided=${decided.length}`);
  ok("decidedApprovals 最近决断在前", decided[0]?.id === "ap5", `first=${decided[0]?.id}`);

  const sorted = sortApprovals(snap.approvals);
  ok("含 null 字段不破坏风险排序", sorted[0].risk === "blocked" && sorted[1].risk === "high", `order=${sorted.map((a) => a.risk).join(",")}`);

  ok(
    "statusLabel 覆盖全部 ApprovalStatus",
    statusLabel("pending") === "待审批" &&
      statusLabel("approved") === "已放行" &&
      statusLabel("denied") === "已拒绝" &&
      statusLabel("timeout") === "已超时" &&
      statusLabel("auto") === "已自动放行",
    `approved="${statusLabel("approved")}" denied="${statusLabel("denied")}"`,
  );
  ok("sameKindLabel 区分首次与重复", sameKindLabel(1) !== sameKindLabel(3), `1="${sameKindLabel(1)}" 3="${sameKindLabel(3)}"`);
  ok("sameKindLabel >1 提示重复", sameKindLabel(3).includes("重复"), sameKindLabel(3));
}

// ---------------------------------------------------------------- T9 台账
section("T9 黑板台账 · 冲突检测");

{
  const conflicts = findConflicts(snap.board.facts);
  ok("findConflicts 找到并列冲突", conflicts.length === 1, `groups=${conflicts.length}`);
  const group = conflicts[0];
  ok("冲突组内 2 条事实", group.facts.length === 2, `facts=${group.facts.map((f) => f.status).join("+")}`);
  ok("normalizeContent 归一化", normalizeContent("  A   B ") === "a b");
  ok("isChallenged 标出被质疑事实", snap.board.facts.some(isChallenged));
}

// ---------------------------------------------------------------- T10 扇出
section("T10 加号扇出 · 动作构造");

{
  const a = buildStartAction("task-1", { agent: "opencode", role: "lead", tier: "guarded" });
  ok("buildStartAction 形状正确", a.type === "session.start" && a.agent === "opencode" && a.role === "lead" && a.tier === "guarded");
  const preset = buildPresetActions("task-1");
  ok("一键扇出 = 3 个动作", preset.length === PRESET_THREE_ENGINES.length && preset.length === 3, `count=${preset.length}`);
  ok("预设覆盖三引擎", preset.every((p) => p.type === "session.start"), `agents=${preset.map((p) => (p as { agent: string }).agent).join(",")}`);

  const u = agentUsability(snap.agents);
  ok("agentUsability 统计可用/未安装（T14：mock 里四家都装了）",
    u.usable === 4 && u.notInstalled === 0, `usable=${u.usable} notInstalled=${u.notInstalled}`);
  ok("agent 描述带 installHint / maturity", snap.agents.every((a) => typeof a.installHint === "string" && typeof a.maturity === "string"));
}

// ---------------------------------------------------------------- R-4 扇出文案跟字段走
section("R-4 扇出文案 · 由 permissionBehavior 现算，不硬编码哪家会问");

{
  ok("mock 快照的 4 家 agent 都带 permissionBehavior（与 detect.ts 一致）",
    snap.agents.every((a) => typeof a.permissionBehavior === "string"),
    snap.agents.map((a) => `${a.id}=${a.permissionBehavior}`).join(" "));

  const ask = gateNoteFor("requests_by_default") ?? "";
  ok("requests_by_default → 「本应用运行它时会主动请求授权」，且不再说「开箱」",
    ask.includes("会主动请求授权") && ask.includes("本应用运行它时") && !ask.includes("开箱"),
    ask);
  ok("needs_config / unknown 合并成同一条「不一定有审批输入」",
    gateNoteFor("needs_config") === gateNoteFor("unknown") &&
      (gateNoteFor("needs_config") ?? "").includes("不一定有审批输入"),
    `needs_config="${gateNoteFor("needs_config")}" unknown="${gateNoteFor("unknown")}"`);
  ok("缺席 / 其它值 → null（静默降级，UI 只少一条提示）",
    gateNoteFor(undefined) === null && gateNoteFor("bogus" as never) === null,
    String(gateNoteFor(undefined)));

  const note = fanoutGateNote(snap.agents);
  const askList = note.slice(note.indexOf("会主动请求授权的：") + "会主动请求授权的：".length, note.indexOf("；不保证会问")).trim();
  const unsureList = note.slice(note.indexOf("不保证会问的：") + "不保证会问的：".length, note.indexOf("（审批队列")).trim();
  ok("弹窗提示由快照现算：Codex / Claude / opencode 三家都并入「会主动请求授权」",
    ["Codex", "Claude", "opencode"].every((x) => askList.includes(x)),
    `ask="${askList}"`);
  ok("弹窗提示：四家都并入「会主动请求授权」（dsh 已按档武装，没人再落在「不保证会问」）",
    unsureList === "无",
    `unsure="${unsureList}"`);
  ok("弹窗提示不再出现旧的硬编码断言「只有」", !note.includes("只有"), note);

  const emptyNote = fanoutGateNote([]);
  ok("空 agents 不崩：两组名单都是「无」",
    emptyNote.includes("会主动请求授权的：无") && emptyNote.includes("不保证会问的：无"),
    emptyNote);
}

// ---------------------------------------------------------------- R-5 档位不对称
section("R-5 档位不对称 · 闸门是否武装由 agent + tier 推导");

{
  ok("claude 两档都会问（armed）",
    sessionGateArmed("claude", "guarded") === "armed" && sessionGateArmed("claude", "autonomous") === "armed");
  ok("opencode 两档都会问（armed）",
    sessionGateArmed("opencode", "guarded") === "armed" && sessionGateArmed("opencode", "autonomous") === "armed");
  ok("codex：guarded（workspace-write）与 autonomous（agent 自动复核）都可能问（armed）",
    sessionGateArmed("codex", "guarded") === "armed" && sessionGateArmed("codex", "autonomous") === "armed");
  ok("dsh：guarded 会问（armed）、autonomous 不问（not_armed）—— 与 codex 同构（T14 按档注入 DSH_PERMISSION_MODE）",
    sessionGateArmed("dsh", "guarded") === "armed" && sessionGateArmed("dsh", "autonomous") === "not_armed");
  ok("未知 agent（未来新增）→ unknown",
    sessionGateArmed("future-x", "guarded") === "unknown");

  ok("徽标文案：armed → 「闸门已武装」+ gate-armed",
    gateBadge("claude", "guarded").text === "闸门已武装" && gateBadge("claude", "guarded").cls === "gate-armed");
  ok("徽标文案：not_armed → 「闸门未武装」+ gate-not-armed（dsh autonomous 空面板）",
    gateBadge("dsh", "autonomous").text === "闸门未武装" && gateBadge("dsh", "autonomous").cls === "gate-not-armed",
    gateBadge("dsh", "autonomous").title);
  ok("徽标文案：unknown → 「闸门未知」+ gate-unknown（拿未来 agent 试，dsh 已不是未知）",
    gateBadge("future-x", "guarded").text === "闸门未知" && gateBadge("future-x", "guarded").cls === "gate-unknown");

  const claudeNote = tierNoteFor("claude");
  const codexNote = tierNoteFor("codex");
  const dshNote = tierNoteFor("dsh");
  ok("claude / opencode 的档位说明：两档都会问、档位只决定转人工",
    claudeNote === tierNoteFor("opencode") && (claudeNote ?? "").includes("两档都会请求授权") && (claudeNote ?? "").includes("转人工"),
    claudeNote ?? "");
  ok("codex 的档位说明：workspace-write / 自动复核",
    (codexNote ?? "").includes("workspace-write") && (codexNote ?? "").includes("自动复核"),
    codexNote ?? "");
  ok("dsh 的档位说明：guarded 会问、autonomous 空面板",
    (dshNote ?? "").includes("guarded 会问") && (dshNote ?? "").includes("审批面板会一直空"),
    dshNote ?? "");
  ok("未知 agent 的档位说明 → null（静默）", tierNoteFor("future-x") === null);
}

// ---------------------------------------------------------------- R10 首次启动引导
section("R10 首次启动引导 · 内容由 snapshot.agents 现算");

{
  const produce = producingAgents(snap.agents);
  const nonProduce = nonProducingAgents(snap.agents);
  ok("会产生审批 = 四家 requests_by_default 且已安装（codex/claude/opencode/dsh）",
    produce.length === 4 && ["codex", "claude", "opencode", "dsh"].every((id) => produce.some((a) => a.id === id)),
    produce.map((a) => a.id).join(","));
  ok("不会产生审批 = 空（四家都装了、都会按档武装）",
    nonProduce.length === 0,
    nonProduce.map((a) => `${a.id}${a.installed ? "" : "(未安装)"}`).join(","));

  ok("dismissal 持久化键是渲染层本地键（不是契约字段）",
    typeof FIRST_RUN_KEY === "string" && FIRST_RUN_KEY.startsWith("bumimang.") && FIRST_RUN_KEY.includes("firstRun"),
    FIRST_RUN_KEY);

  const guide = buildFirstRunGuide(snap.agents);
  ok("引导标题「开始之前」", guide.title === "开始之前", guide.title);

  const s1 = guide.sections[0];
  const producingLine = s1.lines.find((l) => l.kind === "producing")?.text ?? "";
  const nonproducingLine = s1.lines.find((l) => l.kind === "nonproducing")?.text ?? "";
  ok("agent 段：产生审批一行点名三家（按快照 title），不含未安装的那家",
    produce.every((a) => producingLine.includes(a.title)) &&
      nonProduce.every((a) => !producingLine.includes(a.title)),
    producingLine);
  ok("agent 段：不会产生审批一行写「无」（名单为空时不硬凑）",
    nonproducingLine.includes("无"),
    nonproducingLine);

  const s2 = guide.sections[1];
  const interruption = s2.lines.map((l) => l.text).join(" ");
  ok("打断段：写文件会问（3/3）+ echo 不问（3/3）+ 读源码/命名管道/grep 会问",
    interruption.includes("写文件") && interruption.includes("3/3") &&
      interruption.includes("echo") && interruption.includes("不请求") &&
      interruption.includes("读源码") && interruption.includes("命名管道") && interruption.includes("grep"),
    interruption);
  ok("打断段：明确小样本、边界未摸清（不过度断言）",
    s2.lines.some((l) => l.kind === "hedge" && l.text.includes("样本") && l.text.includes("边界")),
    s2.lines.find((l) => l.kind === "hedge")?.text ?? "");

  const s3 = guide.sections[2];
  const dataLoc = s3.lines.map((l) => l.text).join(" ");
  ok("数据段：打包态 %APPDATA%\\bumimang\\ + 开发态 .ui-run",
    dataLoc.includes("%APPDATA%") && dataLoc.includes("bumimang") && dataLoc.includes(".ui-run"),
    dataLoc);

  const s4 = guide.sections[3];
  const start = s4.lines.map((l) => l.text).join(" ");
  ok("开始段：新任务 → 简报 → agent + guarded",
    start.includes("新任务") && start.includes("简报") && start.includes("guarded"),
    start);
}

// ---------------------------------------------------------------- P1-E 多任务看板 / 焦点视图
section("P1-E 多任务看板 · 焦点缓存 / 后台计数 / 全局审批");

{
  // 先构造一份「契约新字段齐全」的多任务快照；旧 buildMockSnapshot 仍保持旧断言可读。
  const multiTasks = [
    {
      ...snap.tasks[0],
      id: "multi-a",
      title: "多任务 A · Web",
      category: "web" as const,
      priority: 10,
      runningSessions: 2,
      totalSessions: 2,
      archived: false,
      flagCandidate: null,
    },
    {
      ...snap.tasks[0],
      id: "multi-b",
      title: "多任务 B · Crypto",
      category: "crypto" as const,
      priority: 20,
      runningSessions: 2,
      totalSessions: 2,
      archived: false,
      flagCandidate: "flag{multi_b}",
    },
    {
      ...snap.tasks[1],
      id: "multi-arch",
      title: "已归档 · Misc",
      category: "misc" as const,
      priority: 0,
      runningSessions: 0,
      totalSessions: 2,
      archived: true,
      flagCandidate: null,
    },
  ];
  const mb1 = { ...snap.sessions[0], id: "mb1", taskId: "multi-b", status: "running" as const };
  const mb2 = { ...snap.sessions[1], id: "mb2", taskId: "multi-b", status: "idle" as const };
  const ma1 = { ...snap.sessions[0], id: "ma1", taskId: "multi-a", status: "running" as const };
  const ma2 = { ...snap.sessions[1], id: "ma2", taskId: "multi-a", status: "waiting_approval" as const };
  const multiApprovals = [
    { ...snap.approvals[0], id: "ap-a", taskId: "multi-a", taskTitle: "多任务 A · Web", status: "pending" as const },
    { ...snap.approvals[1], id: "ap-b", taskId: "multi-b", taskTitle: "多任务 B · Crypto", status: "pending" as const },
    { ...snap.approvals[4], id: "ap-arch", taskId: "multi-arch", taskTitle: "已归档 · Misc", status: "approved" as const },
  ];
  const multiSnap = {
    ...snap,
    task: multiTasks[1],
    tasks: multiTasks,
    sessions: [mb1, mb2],
    approvals: [multiApprovals[1]],
    approvalsAll: multiApprovals,
    quota: { maxSessionsPerTask: 3, maxSessionsTotal: 8, runningSessions: 4 },
    health: { mb1: snap.health.s1, mb2: snap.health.s2 },
  };
  const multiState = applySnapshot(multiSnap as never) as ReturnType<typeof applySnapshot> & {
    approvalsAll?: unknown;
    quota?: { runningSessions?: number } | null;
  };

  ok("P1-E：快照 tasks 保留全量（含 archived）", multiState.tasks.length === 3, `tasks=${multiState.tasks.length}`);
  ok(
    "P1-E：快照 approvalsAll 保留跨任务审批",
    Array.isArray(multiState.approvalsAll) && (multiState.approvalsAll as unknown[]).length === 3,
    `approvalsAll=${(multiState.approvalsAll as unknown[] | undefined)?.length}`,
  );
  ok("P1-E：快照 quota 被 store 保存", multiState.quota?.runningSessions === 4, JSON.stringify(multiState.quota));
  ok("P1-E：焦点 sessions 只含焦点任务", multiState.sessions.every((s) => s.taskId === "multi-b") && multiState.sessions.length === 2,
    multiState.sessions.map((s) => `${s.id}:${s.taskId}`).join(","));

  const boardClosed = buildTaskBoardView(multiState, { archivedOpen: false });
  const boardOpen = buildTaskBoardView(multiState, { archivedOpen: true });
  ok("P1-E：任务看板渲染 2 个活跃任务", boardClosed?.active?.length === 2, `active=${boardClosed?.active?.length}`);
  ok("P1-E：任务看板有 1 个归档任务", boardClosed?.archived?.length === 1, `archived=${boardClosed?.archived?.length}`);
  ok("P1-E：归档默认折叠", boardClosed?.showArchived === false, `showArchived=${boardClosed?.showArchived}`);
  ok("P1-E：归档展开后可见", boardOpen?.showArchived === true, `showArchived=${boardOpen?.showArchived}`);
  ok("P1-E：后台在跑数只统计非焦点任务", boardClosed?.backgroundRunning === 2, `background=${boardClosed?.backgroundRunning}`);
  ok("P1-E：焦点行被标出", boardClosed?.active?.some((r: any) => r.id === "multi-b" && r.isFocus) === true);
  ok(
    "P1-E：任务行带 category / running / total",
    boardClosed?.active?.some((r: any) => r.id === "multi-a" && r.category === "web" && r.running === 2 && r.total === 2) === true,
    JSON.stringify(boardClosed?.active),
  );
  ok(
    "P1-E：配额显示全局与每任务上限",
    boardClosed?.quota?.totalText === "4/8" && boardClosed?.quota?.perTaskText === "2/3",
    JSON.stringify(boardClosed?.quota),
  );

  const filteredFocus = filterApprovals(multiState.approvalsAll, { onlyCurrent: true, taskId: "multi-b" });
  const filteredAll = filterApprovals(multiState.approvalsAll, { onlyCurrent: false, taskId: "multi-b" });
  ok("P1-E：全局审批默认只看当前任务", filteredFocus.length === 1 && filteredFocus[0]?.id === "ap-b",
    JSON.stringify(filteredFocus.map((a) => a.id)));
  ok("P1-E：审批可一键看全部", filteredAll.length === 3, JSON.stringify(filteredAll.map((a) => a.id)));
  ok("P1-E：跨任务审批带任务标题", filteredAll.every((a) => typeof a.taskTitle === "string" && a.taskTitle.length > 0),
    JSON.stringify(filteredAll.map((a) => a.taskTitle)));
  const filteredPendingIds = pendingApprovals(filteredFocus).map((a) => a.id);
  ok("P1-E：批量放行默认只对焦点过滤结果发 id（不误放 A）",
    filteredPendingIds.includes("ap-b") && !filteredPendingIds.includes("ap-a"),
    JSON.stringify(filteredPendingIds));
  const bulkAction = buildBulkAction(filteredPendingIds, "approve");
  ok("P1-E：批量动作只包含当前过滤结果", bulkAction.type === "approval.bulk" && bulkAction.ids.length === 1 &&
    !bulkAction.ids.includes("ap-a"), JSON.stringify(bulkAction));

  const grantAction = buildTaskGrantAllAction("multi-b");
  ok("P1-E：scope=all 显式带焦点 taskId（不会跨任务）",
    grantAction?.type === "permission.grantAll" && grantAction?.scope === "all" && grantAction?.taskId === "multi-b",
    JSON.stringify(grantAction));

  let countsState = multiState;
  countsState = applyEvent(countsState, { type: "session.upsert", session: ma1 });
  const aAfterUpsert = countsState.tasks.find((t) => t.id === "multi-a");
  ok("P1-E：后台 session.upsert 只加计数、不进焦点列表",
    countsState.sessions.length === 2 &&
      countsState.sessions.every((s) => s.taskId === "multi-b") &&
      aAfterUpsert?.runningSessions === 3 && aAfterUpsert?.totalSessions === 3,
    `sessions=${countsState.sessions.length} A=${aAfterUpsert?.runningSessions}/${aAfterUpsert?.totalSessions}`);
  countsState = applyEvent(countsState, { type: "session.upsert", session: { ...ma1, status: "stopped" } });
  const aAfterStop = countsState.tasks.find((t) => t.id === "multi-a");
  ok("P1-E：后台会话转终态只减 running、不减 total",
    aAfterStop?.runningSessions === 2 && aAfterStop?.totalSessions === 3,
    `A=${aAfterStop?.runningSessions}/${aAfterStop?.totalSessions}`);
  countsState = applyEvent(countsState, { type: "session.removed", sessionId: "ma1", taskId: "multi-a" });
  const aAfterRemove = countsState.tasks.find((t) => t.id === "multi-a");
  ok("P1-E：后台 session.removed 只减 total",
    aAfterRemove?.runningSessions === 2 && aAfterRemove?.totalSessions === 2,
    `A=${aAfterRemove?.runningSessions}/${aAfterRemove?.totalSessions}`);

  const backgroundOnly = applyEvent(multiState, { type: "health", sessionId: "ma1", taskId: "multi-a", health: { toolCalls: 1, boardReads: 1, syncLag: 0 } });
  ok("P1-E：后台 health 不进焦点 store", backgroundOnly.health.ma1 === undefined, JSON.stringify(backgroundOnly.health));
  const backgroundBoard = applyEvent(multiState, { type: "board.appended", taskId: "multi-a", events: [] });
  ok("P1-E：后台 board.appended 不改焦点黑板", backgroundBoard.facts.length === multiState.facts.length);

  const archA = { ...multiTasks[0], archived: true, runningSessions: 0 };
  const afterArchA = applyEvent(multiState, { type: "task.upsert", task: archA });
  ok("P1-E：后台归档不抢焦点", afterArchA.task?.id === "multi-b", afterArchA.task?.id ?? "null");
  ok("P1-E：后台归档仍更新 tasks 里的 archived", afterArchA.tasks.find((t) => t.id === "multi-a")?.archived === true);

  const archB = { ...multiTasks[1], archived: true, runningSessions: 0 };
  const afterArchB = applyEvent(multiState, { type: "task.upsert", task: archB });
  ok("P1-E：归档焦点后 task=null", afterArchB.task === null, afterArchB.task?.id ?? "null");
  ok("P1-E：归档焦点后会话/审批/黑板/健康全清",
    afterArchB.sessions.length === 0 && afterArchB.approvals.length === 0 &&
      afterArchB.facts.length === 0 && afterArchB.deadEnds.length === 0 &&
      afterArchB.leases.length === 0 && afterArchB.intents.length === 0 &&
      Object.keys(afterArchB.health).length === 0,
    `sessions=${afterArchB.sessions.length} approvals=${afterArchB.approvals.length} facts=${afterArchB.facts.length}`);

  const switched = applyEvent(multiState, { type: "task.upsert", task: multiTasks[0] });
  ok("P1-E：切焦点立即清空旧焦点缓存",
    switched.task?.id === "multi-a" && switched.sessions.length === 0 && switched.approvals.length === 0 &&
      switched.facts.length === 0 && Object.keys(switched.health).length === 0,
    `task=${switched.task?.id} sessions=${switched.sessions.length}`);

  const emptySnap = {
    ...multiSnap,
    task: null,
    sessions: [],
    approvals: [],
    health: {},
    board: { facts: [], deadEnds: [], leases: [], intents: [] },
  };
  const empty = applySnapshot(emptySnap as never);
  ok("P1-E：快照 task=null 时焦点视图全空",
    empty.task === null && empty.sessions.length === 0 && empty.approvals.length === 0 &&
      empty.facts.length === 0 && Object.keys(empty.health).length === 0,
    `task=${empty.task?.id ?? "null"} sessions=${empty.sessions.length}`);

  const legacySnap = JSON.parse(JSON.stringify(snap));
  delete legacySnap.approvalsAll;
  delete legacySnap.quota;
  for (const t of legacySnap.tasks) {
    delete t.category; delete t.priority; delete t.runningSessions; delete t.totalSessions;
    delete t.updatedAt; delete t.archived; delete t.flagCandidate;
  }
  const legacy = applySnapshot(legacySnap as never) as ReturnType<typeof applySnapshot> & {
    approvalsAll?: unknown;
    quota?: unknown;
  };
  ok("P1-E：旧快照缺新字段不崩（approvalsAll 回退 approvals）",
    Array.isArray(legacy.approvalsAll) && (legacy.approvalsAll as unknown[]).length === legacy.approvals.length,
    `approvalsAll=${(legacy.approvalsAll as unknown[] | undefined)?.length}`);
  ok("P1-E：旧快照缺 quota 时明确为 null", legacy.quota === null, String(legacy.quota));

  const paneInput = [
    { ...ma1, id: "p1", status: "running" },
    { ...ma2, id: "p2", status: "waiting_approval" },
    { ...mb1, id: "p3", status: "running" },
    { ...mb2, id: "p4", status: "idle" },
    { ...snap.sessions[2], id: "p5", taskId: "multi-b", status: "stopped" },
    { ...snap.sessions[2], id: "p6", taskId: "multi-b", status: "done" },
  ];
  const picked = selectPaneSessions(paneInput, 3);
  ok("P1-E：焦点最多 3 个 pane", picked.length === 3, `picked=${picked.length}`);
  ok("P1-E：pane 优先保留活跃会话", picked.every((s) => !["stopped", "done", "failed", "blocked"].includes(s.status)),
    picked.map((s) => `${s.id}:${s.status}`).join(","));
  const pickedEmpty = selectPaneSessions([], 3);
  ok("P1-E：焦点为 null / 无会话时 pane 选择为空（卸载不崩）", Array.isArray(pickedEmpty) && pickedEmpty.length === 0,
    JSON.stringify(pickedEmpty));
}

// ---------------------------------------------------------------- P2-C 技能库状态 / 未配置提示 / category 验证 / 简报预览
section("P2-C 技能库状态 · 已配置 / 未配置 / 错误 / 旧快照");

{
  // 已配置世界：多任务 mock 默认带 skill（root + 2 个包 + 索引时间）。
  const configuredSnap = buildMultiTaskMockSnapshot();
  const configuredState = applySnapshot(configuredSnap);
  const configuredView = buildSkillStatusView(configuredState);

  ok(
    "P2-C mock：已配置世界带 root / 2 个包 / 索引时间",
    configuredSnap.skill?.configured === true &&
      configuredSnap.skill?.root === "D:\\agent\\skill" &&
      configuredSnap.skill?.packages.length === 2 &&
      typeof configuredSnap.skill?.builtAt === "number",
    JSON.stringify(configuredSnap.skill),
  );
  ok(
    "P2-C store：快照 skill 被折叠为 skillStatus（旧快照缺席为 null）",
    configuredState.skillStatus?.configured === true &&
      configuredState.skillStatus?.packages.join(",") === "ctf-0day,ctf-solver",
    JSON.stringify(configuredState.skillStatus),
  );
  ok(
    "P2-C 顶部：已配置显示 root + 包数 + 索引时间",
    configuredView.kind === "configured" &&
      configuredView.headline.includes("D:\\agent\\skill") &&
      configuredView.headline.includes("2 个包") &&
      configuredView.headline.includes("索引时间") &&
      configuredView.builtAtText !== "未构建（懒构建）",
    configuredView.headline,
  );
  ok(
    "V2-P0-1 顶部：已配置显示技能库来源（开发态/内置/外置）",
    configuredView.source === "dev" &&
      configuredView.sourceLabel.includes("开发态") &&
      configuredView.headline.includes("开发态") &&
      configuredView.detail.includes("来源：开发态"),
    `${configuredView.sourceLabel} | ${configuredView.headline}`,
  );
  const packagedSkillSnap = {
    ...configuredSnap,
    skill: { ...(configuredSnap.skill ?? {}), source: "packaged" as const },
  };
  const packagedSkillView = buildSkillStatusView(applySnapshot(packagedSkillSnap as never));
  ok(
    "V2-P0-1 顶部：内置技能库显示「内置（安装包）」",
    packagedSkillView.kind === "configured" &&
      packagedSkillView.source === "packaged" &&
      packagedSkillView.sourceLabel.includes("内置") &&
      packagedSkillView.headline.includes("内置"),
    `${packagedSkillView.sourceLabel} | ${packagedSkillView.headline}`,
  );
  ok(
    "P2-C 顶部：点击展开能看到 root 与 packages",
    configuredView.detail.includes("D:\\agent\\skill") &&
      configuredView.detail.includes("ctf-0day") &&
      configuredView.detail.includes("ctf-solver") &&
      configuredView.packages.length === 2,
    configuredView.detail,
  );
  ok(
    "P2-C 已配置：不出现未配置提示（不误报）",
    configuredView.showWarning === false &&
      configuredView.warningText === null &&
      buildTaskSkillWarning(configuredState) === null,
    `showWarning=${configuredView.showWarning}`,
  );

  // 未配置世界：configured=false + error。未配置只是提示，不是禁用。
  const unconfiguredSnap = buildUnconfiguredSkillMockSnapshot();
  const unconfiguredState = applySnapshot(unconfiguredSnap);
  const unconfiguredView = buildSkillStatusView(unconfiguredState);
  const unconfiguredWarning = buildTaskSkillWarning(unconfiguredState);

  ok(
    "P2-C mock：未配置世界 configured=false 且带 error",
    unconfiguredSnap.skill?.configured === false &&
      unconfiguredSnap.skill?.root === null &&
      (unconfiguredSnap.skill?.packages.length ?? -1) === 0 &&
      typeof unconfiguredSnap.skill?.error === "string",
    JSON.stringify(unconfiguredSnap.skill),
  );
  ok(
    "P2-C 顶部：未配置显示「技能库未配置」",
    unconfiguredView.kind === "unconfigured" &&
      unconfiguredView.label === "技能库未配置" &&
      unconfiguredView.headline.includes("技能库未配置"),
    unconfiguredView.headline,
  );
  ok(
    "P2-C 创建任务弹窗：未配置时给出明确提示",
    unconfiguredWarning === SKILL_UNCONFIGURED_WARNING &&
      (unconfiguredWarning ?? "").includes("agent 将拿不到技能检索") &&
      (unconfiguredWarning ?? "").includes("playbook"),
    unconfiguredWarning ?? "null",
  );
  ok(
    "P2-C 未配置提示不是禁用：仍说「仅能用 playbook 与已有工具」",
    (unconfiguredWarning ?? "").includes("仅能用 playbook 与已有工具") &&
      !(unconfiguredWarning ?? "").includes("禁止") &&
      !(unconfiguredWarning ?? "").includes("无法创建"),
    unconfiguredWarning ?? "null",
  );

  // 错误世界：configured=true 但索引构建失败（error 有值）。
  const errorSnap = {
    ...configuredSnap,
    skill: {
      ...(configuredSnap.skill ?? {}),
      configured: true,
      error: "索引构建失败：EACCES 读取 知识库/SSTI.md",
    },
  };
  const errorView = buildSkillStatusView(applySnapshot(errorSnap as never));
  ok(
    "P2-C 顶部：错误态显示 error 文案",
    errorView.kind === "error" &&
      errorView.label === "技能库错误" &&
      errorView.headline.includes("EACCES"),
    errorView.headline,
  );
  ok(
    "P2-C 错误态也提示但不禁用",
    errorView.showWarning === true &&
      (errorView.warningText ?? "").includes("仍可用 playbook 与已有工具"),
    errorView.warningText ?? "null",
  );

  // 旧快照：不带 skill 字段（buildMockSnapshot 保持 P2-C 之前的形状）。
  const legacySnap = buildMockSnapshot();
  const legacyState = applySnapshot(legacySnap);
  const legacyView = buildSkillStatusView(legacyState);
  ok(
    "P2-C store：旧快照不带 skill 时 skillStatus=null（不炸）",
    legacySnap.skill === undefined && legacyState.skillStatus === null,
    `snap.skill=${String(legacySnap.skill)} store=${String(legacyState.skillStatus)}`,
  );
  ok(
    "P2-C 顶部：旧快照显示「未知/未检测」",
    legacyView.kind === "unknown" &&
      legacyView.label.includes("未检测") &&
      legacyView.headline.includes("未知"),
    `${legacyView.label} | ${legacyView.headline}`,
  );
  ok(
    "P2-C 旧快照不产生未配置提示（不把「未检测」当未配置）",
    legacyView.showWarning === false && buildTaskSkillWarning(legacyState) === null,
    `showWarning=${legacyView.showWarning}`,
  );

  // P1-E category 下拉 / priority 校验：本步只验证，不重做组件。
  const categoryOptions = buildTaskCategoryOptions();
  const categoryValues = categoryOptions.map((o) => o.value);
  ok(
    "P2-C category 下拉：包含 web / ir / unknown（P1-E 已有，本步只验证）",
    categoryValues.includes("web") && categoryValues.includes("ir") && categoryValues.includes("unknown") &&
      TASK_CATEGORY_OPTIONS.length === 9,
    categoryValues.join(","),
  );
  ok(
    "P2-C category 文案：Web / 应急 / 未分类",
    categoryOptions.find((o) => o.value === "web")?.label === "Web" &&
      categoryOptions.find((o) => o.value === "ir")?.label === "应急" &&
      categoryOptions.find((o) => o.value === "unknown")?.label === "未分类",
    categoryOptions.map((o) => `${o.value}=${o.label}`).join(" "),
  );
  ok(
    "P2-C category 未知值归一为 unknown（不把非法值发给后端）",
    normalizeTaskCategory("web") === "web" &&
      normalizeTaskCategory("ir") === "ir" &&
      normalizeTaskCategory("bogus") === "unknown" &&
      normalizeTaskCategory(undefined) === "unknown",
    `web=${normalizeTaskCategory("web")} bogus=${normalizeTaskCategory("bogus")}`,
  );
  ok(
    "P2-C priority 校验：0–100 整数，空为默认",
    parseTaskPriority("50").ok && (parseTaskPriority("50") as { value?: number }).value === 50 &&
      parseTaskPriority("").ok && (parseTaskPriority("") as { value?: number }).value === undefined &&
      parseTaskPriority("0").ok && !parseTaskPriority("101").ok && !parseTaskPriority("-1").ok &&
      !parseTaskPriority("abc").ok,
    JSON.stringify([parseTaskPriority("50"), parseTaskPriority(""), parseTaskPriority("101")]),
  );

  // 简报预览（可选）：只给标题 / 条数 / 可用性 / 证据约定摘要，不给全文。
  const preview = buildBriefingPreview(configuredState);
  ok(
    "P2-C 简报预览：显示 playbook 标题 + routing 条数 + tools 可用",
    preview !== null &&
      preview.playbookTitle === "Web 单题检查表" &&
      preview.routingText === "3 条路径" &&
      preview.knowledgeToolsText === "可用",
    JSON.stringify(preview),
  );
  ok(
    "P2-C 简报预览：不展示全文（只有标题/条数/可用性/摘要）",
    preview !== null &&
      Object.keys(preview).sort().join(",") === "evidenceSummary,knowledgeToolsText,playbookTitle,routingText,title" &&
      (preview.evidenceSummary ?? "").length <= 80,
    JSON.stringify(preview),
  );
  const unconfiguredPreview = buildBriefingPreview(unconfiguredState);
  ok(
    "P2-C 简报预览：未配置世界 routing=0 / tools 不可用（仍显示 playbook）",
    unconfiguredPreview !== null &&
      unconfiguredPreview.playbookTitle === "通用解题检查表" &&
      unconfiguredPreview.routingText === "0 条路径" &&
      unconfiguredPreview.knowledgeToolsText === "不可用",
    JSON.stringify(unconfiguredPreview),
  );
  ok(
    "P2-C 简报预览：无 task / 无简报字段时不显示",
    buildBriefingPreview({ task: null, briefingPreview: configuredState.briefingPreview }) === null &&
      buildBriefingPreview(legacyState) === null,
    `noTask=${String(buildBriefingPreview({ task: null, briefingPreview: configuredState.briefingPreview }))} legacy=${String(buildBriefingPreview(legacyState))}`,
  );
}

// ---------------------------------------------------------------- Mock HubApi 集成
section("Mock HubApi · dispatch 事件回放");

(async () => {
  // P1-E：多任务 mock 世界（3 题，其中 1 个 archived；每任务 2 会话；审批跨任务）
  const multiWorld = buildMultiTaskMockSnapshot();
  ok("P1-E mock：3 个任务（含 1 个 archived）",
    multiWorld.tasks.length === 3 && multiWorld.tasks.filter((t) => t.archived).length === 1,
    JSON.stringify(multiWorld.tasks.map((t) => `${t.id}${t.archived ? "(archived)" : ""}`)));
  ok("P1-E mock：焦点任务 2 个会话、审批队列跨任务",
    multiWorld.task?.id === "task-mt-b" && multiWorld.sessions.length === 2 &&
      multiWorld.sessions.every((s) => s.taskId === "task-mt-b") &&
      (multiWorld.approvalsAll?.length ?? 0) === 3,
    `task=${multiWorld.task?.id} sessions=${multiWorld.sessions.length} approvalsAll=${multiWorld.approvalsAll?.length}`);
  ok("P1-E mock：配额显示 4/8（归档不计入）", multiWorld.quota?.runningSessions === 4,
    JSON.stringify(multiWorld.quota));

  const multiHub = createMockHub({ multiTask: true });
  const multiSnap = await multiHub.snapshot();
  ok("P1-E mock hub：首屏焦点 B、B 的 2 个会话", multiSnap.task?.id === "task-mt-b" && multiSnap.sessions.length === 2,
    `task=${multiSnap.task?.id} sessions=${multiSnap.sessions.map((s) => s.id).join(",")}`);
  const focusA = await multiHub.dispatch({ type: "task.focus", taskId: "task-mt-a" });
  const snapA = await multiHub.snapshot();
  ok("P1-E mock hub：切到 A 后快照换成 A 的 2 个会话",
    focusA.ok && snapA.task?.id === "task-mt-a" && snapA.sessions.length === 2 &&
      snapA.sessions.every((s) => s.taskId === "task-mt-a"),
    `task=${snapA.task?.id} sessions=${snapA.sessions.map((s) => `${s.id}:${s.taskId}`).join(",")}`);
  const focusB = await multiHub.dispatch({ type: "task.switch", taskId: "task-mt-b" });
  const snapB = await multiHub.snapshot();
  ok("P1-E mock hub：切回 B 会话仍在（切题不停、懒加载重建）",
    focusB.ok && snapB.task?.id === "task-mt-b" && snapB.sessions.length === 2 &&
      snapB.sessions.every((s) => s.taskId === "task-mt-b"),
    `task=${snapB.task?.id} sessions=${snapB.sessions.map((s) => s.id).join(",")}`);
  ok("P1-E mock hub：后台 A 的会话仍在跑",
    snapB.tasks.find((t) => t.id === "task-mt-a")?.runningSessions === 2,
    JSON.stringify(snapB.tasks.find((t) => t.id === "task-mt-a")));
  multiHub.stop();

  const hub = createMockHub();
  const events: string[] = [];
  hub.onEvent((e) => events.push(e.type));

  const snap2 = await hub.snapshot();
  ok("mock snapshot 可拉取", snap2.task?.id === "task-1");

  const res = await hub.dispatch({ type: "session.start", taskId: "task-1", agent: "claude", role: "scribe", tier: "guarded" });
  ok("dispatch(session.start) 返回 ok", res.ok === true, JSON.stringify(res));
  ok("session.start 触发 session.upsert", events.includes("session.upsert"));

  const res2 = await hub.dispatch({ type: "approval.decide", approvalId: "ap1", decision: "approve" });
  ok("dispatch(approval.decide) 返回 ok", res2.ok === true);
  const after = await hub.snapshot();
  ok("审批状态已变为 approved", after.approvals.find((a) => a.id === "ap1")?.status === "approved");

  // R16：人工提示 → 历史 → agent 回应
  const scribe = after.sessions.find((s) => s.role === "scribe");
  ok("session.start 的新会话出现在快照里", Boolean(scribe), `sessions=${after.sessions.length}`);
  if (scribe) {
    const promptRes = await hub.dispatch({ type: "session.prompt", sessionId: scribe.id, text: "看 /robots.txt" });
    ok("dispatch(session.prompt) 返回 ok", promptRes.ok === true, JSON.stringify(promptRes));
    const hist1 = await hub.history(scribe.id);
    ok("提示立即进入历史（kind=user_prompt）",
      hist1.length === 1 && hist1[0]?.kind === "user_prompt" && hist1[0]?.text === "看 /robots.txt",
      JSON.stringify(hist1));
    await new Promise((r) => setTimeout(r, 500));
    const hist2 = await hub.history(scribe.id);
    ok("mock agent 的回应也进入历史", hist2.length === 2 && hist2[1]?.kind === "agent_message", JSON.stringify(hist2));
  }

  // R16：任务状态 solved/open 落库（改回待解要清答案）
  await hub.dispatch({ type: "task.setStatus", taskId: "task-1", status: "solved", answer: "flag{mock}" });
  const solved = await hub.snapshot();
  ok("任务可标记已解出", solved.task?.status === "solved" && solved.task?.answer === "flag{mock}",
    `${solved.task?.status} / ${solved.task?.answer}`);
  await hub.dispatch({ type: "task.setStatus", taskId: "task-1", status: "open" });
  const reopened = await hub.snapshot();
  ok("改回待解会清掉旧答案", reopened.task?.status === "open" && reopened.task?.answer === null,
    `${reopened.task?.status} / ${reopened.task?.answer}`);

  // R19：mock 快照带 tasks 列表，task.switch 能切回旧任务
  const withTasks = await hub.snapshot();
  ok("mock 快照带 tasks 列表（含旧任务）", withTasks.tasks.length === 2,
    JSON.stringify(withTasks.tasks.map((t) => t.id)));
  const sw = await hub.dispatch({ type: "task.switch", taskId: "task-0" });
  ok("mock task.switch 切到旧任务", sw.ok === true, JSON.stringify(sw));
  const switched = await hub.snapshot();
  ok("切换后当前任务变了", switched.task?.id === "task-0", switched.task?.id ?? "null");

  // R20：mock session.remove 把会话从列表撤下，历史仍可回看
  await hub.dispatch({ type: "task.switch", taskId: "task-1" });
  const beforeRemove = await hub.snapshot();
  const victim = beforeRemove.sessions[0];
  const rm = victim
    ? await hub.dispatch({ type: "session.remove", sessionId: victim.id })
    : { ok: false, error: "no session" };
  ok("mock session.remove 返回 ok", rm.ok === true, JSON.stringify(rm));
  const afterRemove = await hub.snapshot();
  ok("移除后会话从快照消失", afterRemove.sessions.every((s) => s.id !== victim?.id),
    JSON.stringify(afterRemove.sessions.map((s) => s.id)));
  const rmAgain = victim ? await hub.dispatch({ type: "session.remove", sessionId: victim.id }) : null;
  ok("重复移除被拒", rmAgain?.ok === false, JSON.stringify(rmAgain));

  // P2-C：mock hub 保留 skill / 未配置世界仍可起会话 / 旧世界不带 skill
  const skillHub = createMockHub({ multiTask: true });
  const skillSnap = await skillHub.snapshot();
  ok(
    "P2-C mock hub：快照保留 skill（configured + 2 个包）",
    skillSnap.skill?.configured === true && skillSnap.skill?.packages.length === 2,
    JSON.stringify(skillSnap.skill),
  );
  skillHub.stop();

  const unconfiguredHub = createMockHub({ multiTask: true, skillMode: "unconfigured" });
  const unconfiguredSnap2 = await unconfiguredHub.snapshot();
  const startAnyway = await unconfiguredHub.dispatch({
    type: "session.start",
    taskId: "task-mt-b",
    agent: "claude",
    role: "lead",
    tier: "guarded",
  });
  ok(
    "P2-C 未配置不阻塞：mock 仍允许起会话（提示不是禁用）",
    unconfiguredSnap2.skill?.configured === false && startAnyway.ok === true,
    JSON.stringify(startAnyway),
  );
  unconfiguredHub.stop();

  ok(
    "P2-C 旧 mock 世界仍不带 skill（向后兼容）",
    snap2.skill === undefined,
    String(snap2.skill),
  );

  // ---------------------------------------------------------------- P3-C 附件与工件
  section("P3-C 附件选择 / 工件面板 / 预览");

  const p3cWorld = buildMultiTaskMockSnapshot("task-mt-b");
  ok(
    "P3-C mock 世界带 3 个附件",
    p3cWorld.attachments?.length === 3,
    JSON.stringify(p3cWorld.attachments?.map((a) => a.name)),
  );
  ok(
    "P3-C mock 世界带产物列表",
    (p3cWorld.artifacts?.length ?? 0) >= 4,
    JSON.stringify(p3cWorld.artifacts?.map((a) => a.path)),
  );

  const p3cState = applySnapshot(p3cWorld);
  const p3cStateAny = p3cState as unknown as { attachments?: unknown[]; artifacts?: unknown[] };
  ok(
    "P3-C applySnapshot 读附件",
    p3cStateAny.attachments?.length === 3,
    `attachments=${p3cStateAny.attachments?.length ?? "undefined"}`,
  );
  ok(
    "P3-C applySnapshot 读产物",
    (p3cStateAny.artifacts?.length ?? 0) >= 4,
    `artifacts=${p3cStateAny.artifacts?.length ?? "undefined"}`,
  );

  const p3cPanelState = {
    ...p3cState,
    attachments: p3cWorld.attachments ?? [],
    artifacts: p3cWorld.artifacts ?? [],
  } as typeof p3cState;
  const panel = buildArtifactPanelView(p3cPanelState);
  ok(
    "P3-C 工件面板列出 3 个附件",
    panel.attachments.length === 3,
    `attachments=${panel.attachments.length}`,
  );
  ok(
    "P3-C 工件面板列出产物",
    panel.artifacts.length >= 4,
    `artifacts=${panel.artifacts.length}`,
  );
  ok(
    "P3-C 附件 sha256 短格式",
    panel.attachments[0]?.sha256Short?.endsWith("…") === true,
    String(panel.attachments[0]?.sha256Short),
  );
  ok(
    "P3-C 附件导入时间可读",
    Boolean(panel.attachments[0]?.importedAtText),
    String(panel.attachments[0]?.importedAtText),
  );
  ok(
    "P3-C 工件项不提供系统打开",
    panel.attachments.every((i) => i.systemOpen === false) &&
      panel.artifacts.every((i) => i.systemOpen === false),
    "systemOpen=false",
  );

  const selection = buildAttachmentSelectionView({
    kind: "files",
    paths: ["C:\\a.txt", "C:\\b.png"],
    importing: true,
    error: null,
  });
  ok(
    "P3-C 导入中提示",
    selection.importingText === "正在导入附件…",
    String(selection.importingText),
  );
  ok(
    "P3-C 选择文件计数",
    selection.count === 2 && selection.kindLabel === "文件",
    `${selection.kindLabel}/${selection.count}`,
  );

  const htmlPreview = buildArtifactPreviewView({
    kind: "text",
    content: "<script>alert(1)</script>",
  });
  ok(
    "P3-C HTML 按文本预览",
    htmlPreview.renderKind === "text" && htmlPreview.text?.includes("<script>") === true,
    htmlPreview.renderKind,
  );
  const svgPreview = buildArtifactPreviewView({
    kind: "text",
    content: "<svg onload=alert(1)>",
  });
  ok("P3-C SVG 按文本预览", svgPreview.renderKind === "text", svgPreview.renderKind);
  const badImage = buildArtifactPreviewView({
    kind: "image",
    dataUrl: "data:text/html,<script>alert(1)</script>",
  });
  ok("P3-C 非位图 data URL 拒绝按图片", badImage.renderKind === "unsupported", badImage.renderKind);
  const goodImage = buildArtifactPreviewView({
    kind: "image",
    dataUrl: "data:image/png;base64,AAAA",
    mime: "image/png",
  });
  ok("P3-C 位图 data URL 按图片", goodImage.renderKind === "image", goodImage.renderKind);
  const hexPreview = buildArtifactPreviewView({ kind: "hex", content: "4d 5a" });
  ok("P3-C 二进制按 hex", hexPreview.renderKind === "hex", hexPreview.renderKind);
  ok(
    "P3-C 可执行不提供系统打开",
    canSystemOpenArtifact("tool.exe") === false,
    "false",
  );

  const p3cBoard = buildTaskBoardView(p3cPanelState);
  ok(
    "P3-C 任务卡带附件数量",
    p3cBoard.focus?.attachmentCount === 3,
    String(p3cBoard.focus?.attachmentCount),
  );

  const bgArtifactEvent = applyEvent(p3cState, {
    type: "artifact.updated",
    taskId: "task-mt-a",
    artifacts: [],
  });
  ok(
    "P3-C 后台 artifact.updated 不进焦点",
    ((bgArtifactEvent as unknown as { artifacts?: unknown[] }).artifacts?.length ?? 0) ===
      ((p3cState as unknown as { artifacts?: unknown[] }).artifacts?.length ?? 0),
    "background ignored",
  );
  const focusArtifactEvent = applyEvent(p3cState, {
    type: "artifact.updated",
    taskId: "task-mt-b",
    artifacts: p3cWorld.artifacts ?? [],
  });
  ok(
    "P3-C 焦点 artifact.updated 更新产物",
    ((focusArtifactEvent as unknown as { artifacts?: unknown[] }).artifacts?.length ?? 0) ===
      (p3cWorld.artifacts?.length ?? 0),
    `artifacts=${(focusArtifactEvent as unknown as { artifacts?: unknown[] }).artifacts?.length ?? "undefined"}`,
  );

  const oldState = applySnapshot(buildMockSnapshot());
  ok(
    "P3-C 旧快照无附件不炸",
    ((oldState as unknown as { attachments?: unknown[] }).attachments?.length ?? 0) === 0,
    "attachments=0",
  );
  ok(
    "P3-C 旧快照无产物不炸",
    ((oldState as unknown as { artifacts?: unknown[] }).artifacts?.length ?? 0) === 0,
    "artifacts=0",
  );
  ok(
    "P3-C 旧快照工件面板为空",
    buildArtifactPanelView(oldState as typeof p3cState).empty === true,
    buildArtifactPanelView(oldState as typeof p3cState).emptyText,
  );

  const p3cHub = createMockHub({ multiTask: true });
  const p3cHubSnap = await p3cHub.snapshot();
  ok(
    "P3-C mock hub 快照带附件",
    p3cHubSnap.attachments?.length === 3,
    `attachments=${p3cHubSnap.attachments?.length ?? "undefined"}`,
  );
  ok(
    "P3-C mock hub 快照带产物",
    (p3cHubSnap.artifacts?.length ?? 0) >= 4,
    `artifacts=${p3cHubSnap.artifacts?.length ?? "undefined"}`,
  );
  const refreshRes = await p3cHub.dispatch({ type: "artifact.refresh" });
  ok("P3-C mock artifact.refresh 返回 ok", refreshRes.ok === true, JSON.stringify(refreshRes));
  const p3cPreview =
    typeof p3cHub.previewArtifact === "function"
      ? await p3cHub.previewArtifact("task-mt-b", "attachments/题目说明.txt")
      : null;
  ok("P3-C mock 文本预览", p3cPreview?.kind === "text", JSON.stringify(p3cPreview));
  const p3cPick =
    typeof p3cHub.pickAttachments === "function"
      ? await p3cHub.pickAttachments("files")
      : null;
  ok(
    "P3-C mock 附件选择返回路径",
    (p3cPick?.paths.length ?? 0) > 0,
    JSON.stringify(p3cPick),
  );
  const p3cImport = await p3cHub.dispatch({
    type: "attachment.import",
    taskId: "task-mt-b",
    paths: ["D:\\mock\\补导入.txt"],
  });
  const p3cAfterImport = await p3cHub.snapshot();
  ok(
    "P3-C mock attachment.import 增加附件（可先建任务后补）",
    p3cImport.ok === true && p3cAfterImport.attachments?.length === 4,
    JSON.stringify({ res: p3cImport, attachments: p3cAfterImport.attachments?.length }),
  );
  p3cHub.stop();

  // ---------------------------------------------------------------- P4-D 批次 1
  section("P4-D 范围提示 · 目标面板 · 审批卡目标");

  const scopeDisabledSnap = buildScopeMockSnapshot("disabled");
  const scopeDisabledState = applySnapshot(scopeDisabledSnap);
  const scopeDisabledView = buildScopeStatusView(scopeDisabledState);
  ok(
    "P4-D 范围提示：enabled=false 明确写未启用",
    scopeDisabledView.kind === "disabled" &&
      scopeDisabledView.headline.includes("范围策略未启用") &&
      scopeDisabledView.headline.includes("仅展示与审计"),
    `${scopeDisabledView.kind} / ${scopeDisabledView.headline}`,
  );
  ok(
    "P4-D 范围提示：enabled=false badge=未启用",
    scopeDisabledView.badge === "未启用" && scopeDisabledView.outOfScopeAction === "approve",
    `${scopeDisabledView.badge} / ${scopeDisabledView.outOfScopeAction}`,
  );

  const scopeEnabledSnap = buildScopeMockSnapshot("enabled");
  const scopeEnabledState = applySnapshot(scopeEnabledSnap);
  const scopeEnabledView = buildScopeStatusView(scopeEnabledState);
  ok(
    "P4-D 范围提示：enabled=true 显示 outOfScopeAction",
    scopeEnabledView.kind === "enabled" &&
      scopeEnabledView.headline.includes("范围策略已启用") &&
      scopeEnabledView.headline.includes("approve"),
    `${scopeEnabledView.kind} / ${scopeEnabledView.headline}`,
  );
  ok(
    "P4-D 范围提示：enabled=true badge=已启用",
    scopeEnabledView.badge === "已启用" && scopeEnabledView.proxyEnabled === false,
    `${scopeEnabledView.badge} / proxy=${scopeEnabledView.proxyEnabled}/${scopeEnabledView.proxyPort}`,
  );

  const oldScopeState = applySnapshot(buildMockSnapshot());
  const oldScopeView = buildScopeStatusView(oldScopeState);
  ok(
    "P4-D 范围提示：旧快照无 scope 显示未知",
    oldScopeState.scopeStatus === null &&
      oldScopeView.kind === "unknown" &&
      oldScopeView.headline.includes("范围状态未知"),
    `${oldScopeView.kind} / ${oldScopeView.headline}`,
  );

  const disabledTask = scopeDisabledSnap.task!;
  const disabledPanel = buildTargetPanelView(disabledTask);
  const targetBadge = buildTargetBadge(disabledTask);
  ok(
    "P4-D 目标徽标：焦点任务显示 3 个目标",
    targetBadge?.count === 3 && targetBadge.text === "目标 3",
    JSON.stringify(targetBadge),
  );
  ok(
    "P4-D 目标面板：列出 value/kind/status/notes",
    disabledPanel.targetCount === 3 &&
      disabledPanel.targets.length === 3 &&
      disabledPanel.targets[0]?.value === "10.0.0.0/8" &&
      disabledPanel.targets[0]?.kindLabel === "CIDR" &&
      disabledPanel.targets.some((t) => t.statusLabel === "存活") &&
      disabledPanel.targets.some((t) => t.notes === "后台入口"),
    JSON.stringify(disabledPanel.targets),
  );
  ok(
    "P4-D 目标面板：denyTargets/scopeNotes 可见",
    disabledPanel.denyTargets.length === 2 &&
      disabledPanel.denyTargets.includes("metadata.internal") &&
      disabledPanel.scopeNotes?.includes("仅授权 10.0.0.0/8") === true,
    JSON.stringify({ deny: disabledPanel.denyTargets, notes: disabledPanel.scopeNotes }),
  );
  ok(
    "P4-D 目标面板：增删改动作都存在",
    disabledPanel.actions.includes("add") &&
      disabledPanel.actions.includes("update") &&
      disabledPanel.actions.includes("remove") &&
      TARGET_PANEL_ACTIONS.length === 3,
    disabledPanel.actions.join(","),
  );
  ok(
    "P4-D 目标面板：非焦点任务不带完整 targets（只给焦点）",
    scopeDisabledSnap.tasks.find((t) => t.id === "task-mt-a")?.targets === undefined,
    JSON.stringify(scopeDisabledSnap.tasks.map((t) => `${t.id}:${t.targets?.length ?? "none"}`)),
  );

  const noTargetsSnap = buildScopeMockSnapshot("no-targets");
  const noTargetsPanel = buildTargetPanelView(noTargetsSnap.task);
  ok(
    "P4-D 目标面板：有数据但 0 目标显示空态",
    noTargetsPanel.hasTargetData === true &&
      noTargetsPanel.targetCount === 0 &&
      noTargetsPanel.empty === true &&
      noTargetsPanel.emptyText.includes("还没有授权目标"),
    `${noTargetsPanel.targetCount} / ${noTargetsPanel.emptyText}`,
  );
  const legacyTargetPanel = buildTargetPanelView(buildMockSnapshot().task);
  ok(
    "P4-D 目标面板：旧快照无 targets 不炸且显示未知",
    legacyTargetPanel.hasTargetData === false &&
      legacyTargetPanel.targetCount === null &&
      legacyTargetPanel.emptyText.includes("旧快照未带目标数据"),
    legacyTargetPanel.emptyText,
  );
  ok(
    "P4-D 目标徽标：旧快照显示目标 —（不撒谎为 0）",
    buildTargetBadge(buildMockSnapshot().task)?.count === null &&
      buildTargetBadge(buildMockSnapshot().task)?.text === "目标 —",
    JSON.stringify(buildTargetBadge(buildMockSnapshot().task)),
  );

  const scopeApproval = (scopeDisabledSnap.approvalsAll ?? []).find((a) => a.id === "mt-ap-scope");
  ok(
    "P4-D 审批卡：scopeTarget 显示 kind + value",
    approvalScopeTargetText(scopeApproval!) === "范围目标：url 8.8.8.8",
    approvalScopeTargetText(scopeApproval!) ?? "null",
  );
  ok(
    "P4-D 审批卡：ruleId 可读化",
    scopeApproval?.ruleId === "no-out-of-scope" &&
      approvalRuleLabel(scopeApproval?.ruleId) === "目标不在授权范围",
    `${scopeApproval?.ruleId} / ${approvalRuleLabel(scopeApproval?.ruleId)}`,
  );
  ok(
    "P4-D 审批卡：旧审批无 scopeTarget 不炸",
    approvalScopeTargetText(buildMockSnapshot().approvals[0]) === null,
    "null",
  );

  const p4dHub = createMockHub({ snapshot: buildScopeMockSnapshot("disabled") });
  const p4dSnap0 = await p4dHub.snapshot();
  ok(
    "P4-D mock hub：快照带 scope 与 targets/denyTargets",
    p4dSnap0.scope?.enabled === false &&
      p4dSnap0.scope?.outOfScopeAction === "approve" &&
      p4dSnap0.scope?.proxy?.port === null &&
      p4dSnap0.task?.targets?.length === 3 &&
      (p4dSnap0.task?.denyTargets?.length ?? 0) === 2,
    JSON.stringify({ scope: p4dSnap0.scope, targets: p4dSnap0.task?.targets?.length }),
  );
  const addTargetRes = await p4dHub.dispatch({
    type: "target.add",
    taskId: "task-mt-b",
    value: "10.2.2.2",
    kind: "host",
    notes: "新目标",
  });
  const p4dSnapAdd = await p4dHub.snapshot();
  const addedTarget = p4dSnapAdd.task?.targets?.find((t) => t.value === "10.2.2.2");
  ok(
    "P4-D mock target.add 增加目标",
    addTargetRes.ok === true &&
      p4dSnapAdd.task?.targets?.length === 4 &&
      addedTarget?.kind === "host" &&
      addedTarget?.notes === "新目标",
    JSON.stringify({ res: addTargetRes, targets: p4dSnapAdd.task?.targets?.length }),
  );
  const updateTargetRes = addedTarget
    ? await p4dHub.dispatch({
        type: "target.update",
        taskId: "task-mt-b",
        targetId: addedTarget.id,
        status: "alive",
        notes: "已确认存活",
      })
    : { ok: false, error: "no added target" };
  const p4dSnapUpdate = await p4dHub.snapshot();
  const updatedTarget = p4dSnapUpdate.task?.targets?.find((t) => t.value === "10.2.2.2");
  ok(
    "P4-D mock target.update 更新状态/备注",
    updateTargetRes.ok === true &&
      updatedTarget?.status === "alive" &&
      updatedTarget?.notes === "已确认存活",
    JSON.stringify({ res: updateTargetRes, target: updatedTarget }),
  );
  const removeTargetRes = addedTarget
    ? await p4dHub.dispatch({
        type: "target.remove",
        taskId: "task-mt-b",
        targetId: addedTarget.id,
      })
    : { ok: false, error: "no added target" };
  const p4dSnapRemove = await p4dHub.snapshot();
  ok(
    "P4-D mock target.remove 移除目标",
    removeTargetRes.ok === true &&
      p4dSnapRemove.task?.targets?.length === 3 &&
      !p4dSnapRemove.task?.targets?.some((t) => t.value === "10.2.2.2"),
    JSON.stringify({ res: removeTargetRes, targets: p4dSnapRemove.task?.targets?.length }),
  );
  const duplicateRes = await p4dHub.dispatch({
    type: "target.add",
    taskId: "task-mt-b",
    value: "10.1.2.3",
    kind: "host",
  });
  ok(
    "P4-D mock target.add 拒绝重复值",
    duplicateRes.ok === false,
    JSON.stringify(duplicateRes),
  );
  p4dHub.stop();

  // ---------------------------------------------------------------- P5-C 批次 2
  section("P5-C 批次 2 · Flag 面板 / 确认 / 误报 / 导出");
  const parseFlagJson = (s: string | undefined): unknown => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };

  const flagWorld = buildMultiTaskMockSnapshot();
  ok(
    "P5-C b2：多任务 mock 焦点任务 3 个候选",
    flagWorld.flags?.length === 3 && flagWorld.task?.flagCount === 3,
    JSON.stringify({ flags: flagWorld.flags?.length, flagCount: flagWorld.task?.flagCount }),
  );
  ok(
    "P5-C b2：非焦点任务 flagCount=1",
    flagWorld.tasks.find((t) => t.id === "task-mt-a")?.flagCount === 1,
    JSON.stringify(flagWorld.tasks.map((t) => [t.id, t.flagCount])),
  );
  ok(
    "P5-C b2：快照 flags 只属于焦点任务",
    (flagWorld.flags ?? []).every((f) => f.taskId === "task-mt-b"),
    JSON.stringify((flagWorld.flags ?? []).map((f) => f.taskId)),
  );
  ok(
    "P5-C b2：mock 候选覆盖 new/confirmed",
    (flagWorld.flags ?? []).filter((f) => f.status === "new").length === 2 &&
      (flagWorld.flags ?? []).filter((f) => f.status === "confirmed").length === 1,
    JSON.stringify((flagWorld.flags ?? []).map((f) => f.status)),
  );

  const flagState = applySnapshot(flagWorld);
  ok(
    "P5-C b2：store 读 flags",
    (flagState.flags ?? []).length === 3,
    `flags=${(flagState.flags ?? []).length}`,
  );
  ok(
    "P5-C b2：store flagsStatus=known",
    flagState.flagsStatus === "known",
    String(flagState.flagsStatus),
  );

  const flagPanel = buildFlagPanelView(flagState);
  ok(
    "P5-C b2：flag 面板 ready",
    flagPanel.kind === "ready" && flagPanel.count === 3 && flagPanel.candidates.length === 3,
    JSON.stringify({ kind: flagPanel.kind, count: flagPanel.count, rows: flagPanel.candidates.length }),
  );
  const newFlagRows = flagPanel.candidates.filter((c) => c.status === "new");
  const confirmedFlagRow = flagPanel.candidates.find((c) => c.status === "confirmed");
  ok(
    "P5-C b2：new 候选显示确认/误报按钮",
    newFlagRows.length === 2 && newFlagRows.every((c) => c.canConfirm && c.canReject),
    JSON.stringify(newFlagRows.map((c) => [c.id, c.canConfirm, c.canReject])),
  );
  ok(
    "P5-C b2：confirmed 候选不显示确认/误报按钮",
    Boolean(confirmedFlagRow) && confirmedFlagRow?.canConfirm === false && confirmedFlagRow?.canReject === false,
    JSON.stringify(confirmedFlagRow && [confirmedFlagRow.id, confirmedFlagRow.canConfirm, confirmedFlagRow.canReject]),
  );
  ok(
    "P5-C b2：面板带来源/证据/时间",
    flagPanel.candidates.every(
      (c) => Boolean(c.evidence) && Boolean(c.firstSeenText) && Array.isArray(c.sources),
    ),
    JSON.stringify(flagPanel.candidates.map((c) => [c.evidence, c.firstSeenText, c.sources.length])),
  );
  ok(
    "P5-C b2：导出格式只有 md/csv/json",
    FLAG_EXPORT_FORMATS.join(",") === "md,csv,json" && flagPanel.exportFormats.length === 3,
    FLAG_EXPORT_FORMATS.join(","),
  );

  const boardFlagView = buildTaskBoardView(flagState);
  ok(
    "P5-C b2：任务卡徽标 flagCount（焦点 3）",
    boardFlagView.focus?.flagCount === 3,
    String(boardFlagView.focus?.flagCount),
  );
  ok(
    "P5-C b2：任务卡徽标 flagCount（非焦点 1）",
    boardFlagView.active.find((r) => r.id === "task-mt-a")?.flagCount === 1,
    String(boardFlagView.active.find((r) => r.id === "task-mt-a")?.flagCount),
  );
  ok(
    "P5-C b2：归档任务 flagCount=0",
    boardFlagView.archived.find((r) => r.id === "task-mt-arch")?.flagCount === 0,
    String(boardFlagView.archived.find((r) => r.id === "task-mt-arch")?.flagCount),
  );

  const legacyFlagState = applySnapshot(buildMockSnapshot());
  ok(
    "P5-C b2：旧快照不带 flags 不炸（unknown）",
    (legacyFlagState.flags ?? []).length === 0 && legacyFlagState.flagsStatus === "unknown",
    JSON.stringify({ flags: (legacyFlagState.flags ?? []).length, status: legacyFlagState.flagsStatus }),
  );
  const legacyFlagPanel = buildFlagPanelView(legacyFlagState);
  ok(
    "P5-C b2：旧快照面板显示未知而非无候选",
    legacyFlagPanel.kind === "unknown" && legacyFlagPanel.emptyText === null,
    JSON.stringify({ kind: legacyFlagPanel.kind, emptyText: legacyFlagPanel.emptyText }),
  );

  const emptyFlagWorld = { ...buildMultiTaskMockSnapshot(), flags: [] };
  const emptyFlagState = applySnapshot(emptyFlagWorld);
  ok(
    "P5-C b2：已知无候选 flagsStatus=known",
    emptyFlagState.flagsStatus === "known" && (emptyFlagState.flags ?? []).length === 0,
    JSON.stringify({ status: emptyFlagState.flagsStatus, flags: (emptyFlagState.flags ?? []).length }),
  );
  ok(
    "P5-C b2：无候选面板空态",
    buildFlagPanelView(emptyFlagState).kind === "empty",
    buildFlagPanelView(emptyFlagState).kind,
  );

  const firstNewFlag = (flagState.flags ?? []).find((f) => f.status === "new");
  const updatedFlagList = (flagState.flags ?? []).map((f) =>
    f.id === firstNewFlag?.id ? { ...f, status: "confirmed" as const } : f,
  );
  const flagEventState = applyEvent(flagState, {
    type: "flag.updated",
    taskId: "task-mt-b",
    flags: updatedFlagList,
  });
  ok(
    "P5-C b2：store 接 flag.updated",
    (flagEventState.flags ?? []).find((f) => f.id === firstNewFlag?.id)?.status === "confirmed",
    JSON.stringify((flagEventState.flags ?? []).map((f) => [f.id, f.status])),
  );
  ok(
    "P5-C b2：flag.updated 同步 task.flagCount",
    flagEventState.task?.flagCount === 3,
    String(flagEventState.task?.flagCount),
  );
  const backgroundFlagState = applyEvent(flagState, {
    type: "flag.updated",
    taskId: "task-mt-a",
    flags: [],
  });
  ok(
    "P5-C b2：非焦点 flag.updated 丢弃（P1-E）",
    (backgroundFlagState.flags ?? []).length === 3,
    `flags=${(backgroundFlagState.flags ?? []).length}`,
  );

  const flagHub = createMockHub({ multiTask: true });
  const flagSnap0 = await flagHub.snapshot();
  ok(
    "P5-C b2：mock hub 快照带 3 个候选",
    flagSnap0.flags?.length === 3,
    String(flagSnap0.flags?.length),
  );
  const toRejectFlag = flagSnap0.flags?.find((f) => f.status === "new");
  const rejectFlagRes = toRejectFlag
    ? await flagHub.dispatch({ type: "flag.reject", taskId: "task-mt-b", candidateId: toRejectFlag.id })
    : { ok: false, error: "no new candidate" };
  const flagSnapRejected = await flagHub.snapshot();
  ok(
    "P5-C b2：mock reject 回写 false_positive",
    rejectFlagRes.ok === true &&
      flagSnapRejected.flags?.find((f) => f.id === toRejectFlag?.id)?.status === "false_positive",
    JSON.stringify({ res: rejectFlagRes, flags: flagSnapRejected.flags?.map((f) => [f.id, f.status]) }),
  );
  ok(
    "P5-C b2：mock reject 后候选仍在",
    Boolean(flagSnapRejected.flags?.some((f) => f.id === toRejectFlag?.id)),
    String(flagSnapRejected.flags?.length),
  );
  ok(
    "P5-C b2：mock reject 不改任务状态/答案",
    flagSnapRejected.task?.status === "solving" && flagSnapRejected.task?.answer === null,
    `${flagSnapRejected.task?.status} / ${flagSnapRejected.task?.answer}`,
  );
  const rejectedFlagPanel = buildFlagPanelView(applySnapshot(flagSnapRejected));
  ok(
    "P5-C b2：误报后不再显示确认/误报按钮",
    rejectedFlagPanel.candidates.find((c) => c.id === toRejectFlag?.id)?.canConfirm === false &&
      rejectedFlagPanel.candidates.find((c) => c.id === toRejectFlag?.id)?.canReject === false,
    JSON.stringify(rejectedFlagPanel.candidates.find((c) => c.id === toRejectFlag?.id)),
  );

  const toConfirmFlag = flagSnapRejected.flags?.find((f) => f.status === "new");
  const confirmFlagRes = toConfirmFlag
    ? await flagHub.dispatch({ type: "flag.confirm", taskId: "task-mt-b", candidateId: toConfirmFlag.id })
    : { ok: false, error: "no new candidate" };
  const flagSnapConfirmed = await flagHub.snapshot();
  ok(
    "P5-C b2：mock confirm 回写 confirmed",
    confirmFlagRes.ok === true &&
      flagSnapConfirmed.flags?.find((f) => f.id === toConfirmFlag?.id)?.status === "confirmed",
    JSON.stringify({ res: confirmFlagRes, flags: flagSnapConfirmed.flags?.map((f) => [f.id, f.status]) }),
  );
  ok(
    "P5-C b2：mock confirm 写 task.answer/status",
    flagSnapConfirmed.task?.status === "solved" &&
      flagSnapConfirmed.task?.answer === toConfirmFlag?.value,
    `${flagSnapConfirmed.task?.status} / ${flagSnapConfirmed.task?.answer}`,
  );
  ok(
    "P5-C b2：mock confirm 后 flagCount 仍 3",
    flagSnapConfirmed.task?.flagCount === 3,
    String(flagSnapConfirmed.task?.flagCount),
  );
  ok(
    "P5-C b2：mock confirm 后确认态不再显示按钮",
    buildFlagPanelView(applySnapshot(flagSnapConfirmed)).candidates.find(
      (c) => c.id === toConfirmFlag?.id,
    )?.canReject === false,
    JSON.stringify(
      buildFlagPanelView(applySnapshot(flagSnapConfirmed)).candidates.find(
        (c) => c.id === toConfirmFlag?.id,
      ),
    ),
  );
  const badConfirmFlag = await flagHub.dispatch({
    type: "flag.confirm",
    taskId: "task-mt-b",
    candidateId: "flag-nope",
  });
  ok("P5-C b2：mock confirm 不存在候选被拒", badConfirmFlag.ok === false, JSON.stringify(badConfirmFlag));

  const exportMdFlag = await flagHub.dispatch({ type: "flag.export", taskId: "task-mt-b", format: "md" });
  ok(
    "P5-C b2：mock 导出 md 返回内容",
    exportMdFlag.ok === true &&
      typeof exportMdFlag.content === "string" &&
      exportMdFlag.content.includes("flag{multi_b}"),
    JSON.stringify({ ok: exportMdFlag.ok, len: exportMdFlag.content?.length }),
  );
  const exportCsvFlag = await flagHub.dispatch({ type: "flag.export", taskId: "task-mt-b", format: "csv" });
  ok(
    "P5-C b2：mock 导出 csv 有表头",
    exportCsvFlag.ok === true && (exportCsvFlag.content ?? "").startsWith("taskId,taskTitle"),
    (exportCsvFlag.content ?? "").split("\n")[0],
  );
  const exportJsonFlag = await flagHub.dispatch({ type: "flag.export", taskId: "task-mt-b", format: "json" });
  const exportJsonParsed = parseFlagJson(exportJsonFlag.content) as {
    tasks?: Array<{ candidates?: unknown[] }>;
  } | null;
  ok(
    "P5-C b2：mock 导出 json 可解析且含 3 候选",
    exportJsonFlag.ok === true && exportJsonParsed?.tasks?.[0]?.candidates?.length === 3,
    JSON.stringify({ ok: exportJsonFlag.ok, tasks: exportJsonParsed?.tasks?.length }),
  );
  ok(
    "P5-C b2：导出不含非焦点任务候选",
    !(exportMdFlag.content ?? "").includes("flag{multi_a_1}"),
    "focus-only",
  );

  const noFlagHub = createMockHub({ multiTask: true, flags: "none" } as never);
  const noFlagSnap = await noFlagHub.snapshot();
  const noFlagState = applySnapshot(noFlagSnap);
  ok(
    "P5-C b2：mock 无候选世界",
    noFlagSnap.flags?.length === 0 &&
      noFlagState.flagsStatus === "known" &&
      buildFlagPanelView(noFlagState).kind === "empty",
    JSON.stringify({ flags: noFlagSnap.flags?.length, status: noFlagState.flagsStatus }),
  );
  noFlagHub.stop();
  const legacyFlagHub = createMockHub();
  const legacyFlagSnap = await legacyFlagHub.snapshot();
  ok(
    "P5-C b2：旧 mock 世界仍不带 flags",
    legacyFlagSnap.flags === undefined && applySnapshot(legacyFlagSnap).flagsStatus === "unknown",
    JSON.stringify({ flags: legacyFlagSnap.flags, status: applySnapshot(legacyFlagSnap).flagsStatus }),
  );
  legacyFlagHub.stop();
  flagHub.stop();

  // ---------------------------------------------------------------- P5-D 批次 2
  section("P5-D 批次 2 · 提交弹窗 / 记分板");
  const scoreWorld = buildMultiTaskMockSnapshot();
  ok(
    "P5-D b2：mock 世界带 scoreboard",
    Boolean(scoreWorld.scoreboard) &&
      scoreWorld.scoreboard?.total === 3 &&
      scoreWorld.scoreboard?.solved === 1 &&
      scoreWorld.scoreboard?.points === 175,
    JSON.stringify(scoreWorld.scoreboard),
  );
  const scoreSbA = scoreWorld.scoreboard?.tasks.find((t) => t.taskId === "task-mt-a");
  const scoreSbB = scoreWorld.scoreboard?.tasks.find((t) => t.taskId === "task-mt-b");
  const scoreSbArch = scoreWorld.scoreboard?.tasks.find((t) => t.taskId === "task-mt-arch");
  ok(
    "P5-D b2：scoreboard 各任务 points/flagCount",
    scoreSbA?.points === 50 &&
      scoreSbA?.flagCount === 1 &&
      scoreSbB?.points === 100 &&
      scoreSbB?.flagCount === 3 &&
      scoreSbArch?.points === 25,
    JSON.stringify([scoreSbA, scoreSbB, scoreSbArch]),
  );

  const scoreState = applySnapshot(scoreWorld);
  ok(
    "P5-D b2：store 读 scoreboard",
    Boolean(scoreState.scoreboard) &&
      scoreState.scoreboard?.total === 3 &&
      scoreState.scoreboard?.points === 175,
    JSON.stringify(scoreState.scoreboard),
  );
  const legacyScoreState = applySnapshot(buildMockSnapshot());
  ok(
    "P5-D b2：旧快照不带 scoreboard 不炸",
    legacyScoreState.scoreboard == null,
    String(legacyScoreState.scoreboard),
  );

  const scoreFlagPanel = buildFlagPanelView(scoreState);
  const scoreNewRows = scoreFlagPanel.candidates.filter((c) => c.status === "new");
  const scoreConfirmedRow = scoreFlagPanel.candidates.find((c) => c.status === "confirmed");
  ok(
    "P5-D b2：new 候选可提交",
    scoreNewRows.length === 2 && scoreNewRows.every((c) => c.canSubmit === true),
    JSON.stringify(scoreNewRows.map((c) => [c.id, c.canSubmit])),
  );
  ok(
    "P5-D b2：confirmed 候选可提交",
    Boolean(scoreConfirmedRow) && scoreConfirmedRow?.canSubmit === true,
    JSON.stringify(scoreConfirmedRow && [scoreConfirmedRow.id, scoreConfirmedRow.canSubmit]),
  );
  ok(
    "P5-D b2：mock 有提交历史（confirmed 已 submitted）",
    scoreConfirmedRow?.isSubmitted === true &&
      Boolean(scoreConfirmedRow?.submittedAtText) &&
      scoreConfirmedRow?.submitStatus === "manual",
    JSON.stringify([
      scoreConfirmedRow?.isSubmitted,
      scoreConfirmedRow?.submittedAtText,
      scoreConfirmedRow?.submitStatus,
    ]),
  );
  ok(
    "P5-D b2：未提交候选 isSubmitted=false",
    scoreNewRows.every((c) => c.isSubmitted === false && c.submittedAtText === null),
    JSON.stringify(scoreNewRows.map((c) => [c.id, c.isSubmitted, c.submittedAtText])),
  );

  // 记分板随 task.upsert / flag.updated 更新
  const solvedScoreState = applyEvent(scoreState, {
    type: "task.upsert",
    task: { ...scoreState.task!, status: "solved", answer: "flag{score_solved}" },
  });
  ok(
    "P5-D b2：task.upsert 更新 scoreboard.solved",
    solvedScoreState.scoreboard?.solved === 2,
    String(solvedScoreState.scoreboard?.solved),
  );
  const twoFlagState = applyEvent(scoreState, {
    type: "flag.updated",
    taskId: "task-mt-b",
    flags: (scoreState.flags ?? []).slice(0, 2),
  });
  ok(
    "P5-D b2：flag.updated 更新 scoreboard.flagCount",
    twoFlagState.scoreboard?.tasks.find((t) => t.taskId === "task-mt-b")?.flagCount === 2,
    JSON.stringify(twoFlagState.scoreboard?.tasks.find((t) => t.taskId === "task-mt-b")),
  );

  const scoreHub = createMockHub({ multiTask: true });
  const scoreSnap0 = await scoreHub.snapshot();
  ok(
    "P5-D b2：mock hub 快照带 scoreboard",
    scoreSnap0.scoreboard?.total === 3 &&
      scoreSnap0.scoreboard?.solved === 1 &&
      scoreSnap0.scoreboard?.points === 175,
    JSON.stringify(scoreSnap0.scoreboard),
  );
  const historyCand = scoreSnap0.flags?.find((f) => f.status === "confirmed");
  ok(
    "P5-D b2：mock hub 有提交历史",
    Boolean(historyCand?.submittedAt) && historyCand?.submitStatus === "manual",
    JSON.stringify(historyCand && [historyCand.submittedAt, historyCand.submitStatus]),
  );

  const toSubmit = scoreSnap0.flags?.find((f) => f.status === "new");
  const manualSubmitRes = toSubmit
    ? await scoreHub.dispatch({
        type: "flag.submit",
        taskId: "task-mt-b",
        candidateId: toSubmit.id,
      })
    : { ok: false, error: "no new candidate" };
  ok(
    "P5-D b2：mock manual 提交返回 ok",
    manualSubmitRes.ok === true && manualSubmitRes.mode === "manual",
    JSON.stringify(manualSubmitRes),
  );
  ok(
    "P5-D b2：mock manual 返回 value/instructions",
    manualSubmitRes.value === toSubmit?.value &&
      typeof manualSubmitRes.instructions === "string" &&
      manualSubmitRes.instructions.length > 0,
    JSON.stringify([manualSubmitRes.value, manualSubmitRes.instructions]),
  );
  const scoreSnapSubmitted = await scoreHub.snapshot();
  const submittedCand = scoreSnapSubmitted.flags?.find((f) => f.id === toSubmit?.id);
  ok(
    "P5-D b2：mock manual 回写 submitted_at/manual",
    (submittedCand?.submittedAt ?? 0) > 0 && submittedCand?.submitStatus === "manual",
    JSON.stringify(submittedCand && [submittedCand.submittedAt, submittedCand.submitStatus]),
  );
  ok(
    "P5-D b2：manual 不改 task 状态/答案",
    scoreSnapSubmitted.task?.status === "solving" && scoreSnapSubmitted.task?.answer === null,
    `${scoreSnapSubmitted.task?.status} / ${scoreSnapSubmitted.task?.answer}`,
  );
  ok(
    "P5-D b2：manual 不改 scoreboard points/solved",
    scoreSnapSubmitted.scoreboard?.points === 175 && scoreSnapSubmitted.scoreboard?.solved === 1,
    JSON.stringify(scoreSnapSubmitted.scoreboard),
  );

  const dryCand = scoreSnapSubmitted.flags?.find(
    (f) => f.status === "new" && f.id !== toSubmit?.id,
  );
  const drySubmitRes = dryCand
    ? await scoreHub.dispatch({
        type: "flag.submit",
        taskId: "task-mt-b",
        candidateId: dryCand.id,
        mode: "dry_run",
      })
    : { ok: false, error: "no new candidate" };
  const scoreSnapDry = await scoreHub.snapshot();
  const dryAfter = scoreSnapDry.flags?.find((f) => f.id === dryCand?.id);
  ok(
    "P5-D b2：mock dry-run 返回 argv",
    drySubmitRes.ok === true &&
      drySubmitRes.mode === "dry_run" &&
      Array.isArray(drySubmitRes.argv) &&
      drySubmitRes.argv.length > 0,
    JSON.stringify(drySubmitRes),
  );
  ok(
    "P5-D b2：mock dry-run 不改候选状态",
    dryAfter?.submittedAt == null && dryAfter?.submitStatus == null,
    JSON.stringify(dryAfter && [dryAfter.submittedAt, dryAfter.submitStatus]),
  );

  const cmdSubmitRes = await scoreHub.dispatch({
    type: "flag.submit",
    taskId: "task-mt-b",
    candidateId: toSubmit?.id ?? "flag-nope",
    mode: "command",
  } as never);
  ok(
    "P5-D b2：mock command 被拒且可读",
    cmdSubmitRes.ok === false &&
      String(cmdSubmitRes.error ?? "").includes("command 模式未实现"),
    JSON.stringify(cmdSubmitRes),
  );

  const toRejectSubmit = scoreSnapDry.flags?.find((f) => f.status === "new");
  const rejectForSubmitRes = toRejectSubmit
    ? await scoreHub.dispatch({
        type: "flag.reject",
        taskId: "task-mt-b",
        candidateId: toRejectSubmit.id,
      })
    : { ok: false, error: "no new candidate" };
  const rejectSubmitRes = toRejectSubmit
    ? await scoreHub.dispatch({
        type: "flag.submit",
        taskId: "task-mt-b",
        candidateId: toRejectSubmit.id,
      })
    : { ok: false, error: "no new candidate" };
  const scoreSnapFalsePositive = await scoreHub.snapshot();
  const falsePositivePanel = buildFlagPanelView(applySnapshot(scoreSnapFalsePositive));
  ok(
    "P5-D b2：false_positive 候选不能提交",
    rejectForSubmitRes.ok === true &&
      rejectSubmitRes.ok === false &&
      falsePositivePanel.candidates.find((c) => c.id === toRejectSubmit?.id)?.canSubmit === false,
    JSON.stringify({ rejectForSubmitRes, rejectSubmitRes }),
  );

  const noSubmitHub = createMockHub({ multiTask: true, submits: "none" } as never);
  const noSubmitSnap = await noSubmitHub.snapshot();
  ok(
    "P5-D b2：mock 无提交世界",
    (noSubmitSnap.flags ?? []).length === 3 &&
      (noSubmitSnap.flags ?? []).every((f) => f.submittedAt == null && f.submitStatus == null),
    JSON.stringify((noSubmitSnap.flags ?? []).map((f) => [f.id, f.submittedAt, f.submitStatus])),
  );
  noSubmitHub.stop();

  const crossFocus = await scoreHub.dispatch({ type: "task.focus", taskId: "task-mt-a" });
  const crossSnap = await scoreHub.snapshot();
  ok(
    "P5-D b2：跨任务提交隔离",
    crossFocus.ok === true &&
      (crossSnap.flags ?? []).every((f) => f.taskId === "task-mt-a") &&
      (crossSnap.flags ?? []).every((f) => f.submittedAt == null),
    JSON.stringify(crossSnap.flags),
  );
  scoreHub.stop();

  // ---------------------------------------------------------------- P6-B 批次 2b
  section("P6-B 批次 2b · 代理真实状态显示（限制 A/B UI 闭环）");

  const proxyBaseSnap = buildMultiTaskMockSnapshot("task-mt-b", {
    scope: "disabled",
    targets: "present",
  });
  const proxySnapWith = (proxy: {
    enabled: boolean;
    port: number | null;
    state?: string;
    error?: string;
  }): HubSnapshot => ({
    ...proxyBaseSnap,
    scope: {
      ...(proxyBaseSnap.scope as NonNullable<HubSnapshot["scope"]>),
      proxy: proxy as never,
    },
  });

  const proxyRunningView = buildScopeStatusView(
    applySnapshot(proxySnapWith({ enabled: true, port: 12345, state: "running" })),
  );
  ok(
    "P6-B b2：running 显示真实 port",
    proxyRunningView.proxyState === "running" &&
      proxyRunningView.proxyText?.includes("本地代理运行中") === true &&
      proxyRunningView.proxyText?.includes("12345") === true &&
      proxyRunningView.proxyPort === 12345,
    JSON.stringify({
      state: proxyRunningView.proxyState,
      text: proxyRunningView.proxyText,
      port: proxyRunningView.proxyPort,
    }),
  );
  ok(
    "P6-B b2：running 使用正常色（ok）",
    proxyRunningView.proxyTone === "ok",
    String(proxyRunningView.proxyTone),
  );

  const proxyFailedView = buildScopeStatusView(
    applySnapshot(
      proxySnapWith({ enabled: true, port: null, state: "failed", error: "EADDRINUSE" }),
    ),
  );
  ok(
    "P6-B b2：failed 显示启动失败 + error",
    proxyFailedView.proxyState === "failed" &&
      proxyFailedView.proxyText?.includes("本地代理启动失败") === true &&
      proxyFailedView.proxyText?.includes("EADDRINUSE") === true,
    String(proxyFailedView.proxyText),
  );
  ok(
    "P6-B b2：failed 不显示“已启用”、显示错误色（限制 A）",
    proxyFailedView.proxyText?.includes("已启用") !== true &&
      proxyFailedView.proxyTone === "error" &&
      proxyFailedView.proxyPort === null,
    JSON.stringify({
      text: proxyFailedView.proxyText,
      tone: proxyFailedView.proxyTone,
      port: proxyFailedView.proxyPort,
    }),
  );
  ok(
    "P6-B b2：failed 仍保留 config 意图 proxyEnabled=true",
    proxyFailedView.proxyEnabled === true,
    String(proxyFailedView.proxyEnabled),
  );

  const proxyStoppedView = buildScopeStatusView(
    applySnapshot(proxySnapWith({ enabled: true, port: null, state: "stopped" })),
  );
  ok(
    "P6-B b2：stopped 显示已停止且无 port",
    proxyStoppedView.proxyState === "stopped" &&
      proxyStoppedView.proxyText?.includes("本地代理已停止") === true &&
      proxyStoppedView.proxyPort === null,
    JSON.stringify({ state: proxyStoppedView.proxyState, text: proxyStoppedView.proxyText }),
  );

  const proxyStartingView = buildScopeStatusView(
    applySnapshot(proxySnapWith({ enabled: true, port: null, state: "starting" })),
  );
  ok(
    "P6-B b2：starting 显示启动中",
    proxyStartingView.proxyState === "starting" &&
      proxyStartingView.proxyText?.includes("本地代理启动中") === true,
    String(proxyStartingView.proxyText),
  );

  const proxyLegacyView = buildScopeStatusView(
    applySnapshot(proxySnapWith({ enabled: true, port: null })),
  );
  ok(
    "P6-B b2：旧快照无 state 显示状态未知（不误报已启用）",
    proxyLegacyView.proxyState === "unknown" &&
      proxyLegacyView.proxyText?.includes("状态未知") === true &&
      proxyLegacyView.proxyText?.includes("已启用") !== true,
    JSON.stringify({ state: proxyLegacyView.proxyState, text: proxyLegacyView.proxyText }),
  );

  const proxyLegacyOffView = buildScopeStatusView(
    applySnapshot(proxySnapWith({ enabled: false, port: null })),
  );
  ok(
    "P6-B b2：旧快照 enabled=false 仍显示未启用",
    proxyLegacyOffView.proxyState === "disabled" &&
      proxyLegacyOffView.proxyText?.includes("未启用") === true,
    String(proxyLegacyOffView.proxyText),
  );

  const proxyOffStoppedView = buildScopeStatusView(
    applySnapshot(proxySnapWith({ enabled: false, port: null, state: "stopped" })),
  );
  ok(
    "P6-B b2：config 关闭 + state=stopped 显示未启用（不误报已停止）",
    proxyOffStoppedView.proxyState === "disabled" &&
      proxyOffStoppedView.proxyText?.includes("未启用") === true,
    String(proxyOffStoppedView.proxyText),
  );

  const proxyEventStore = new Store(
    applySnapshot(proxySnapWith({ enabled: true, port: 12345, state: "running" })),
  );
  proxyEventStore.update((s) =>
    applyEvent(s, {
      type: "proxy.state.changed",
      proxy: { enabled: true, port: null, state: "failed", error: "ECONNRESET" },
    } as HubEvent),
  );
  const proxyEventView = buildScopeStatusView(proxyEventStore.get());
  ok(
    "P6-B b2：proxy.state.changed 更新 store + 显示",
    proxyEventView.proxyState === "failed" &&
      proxyEventView.proxyText?.includes("ECONNRESET") === true,
    JSON.stringify({ state: proxyEventView.proxyState, text: proxyEventView.proxyText }),
  );

  proxyEventStore.update((s) =>
    applyEvent(s, {
      type: "proxy.state.changed",
      proxy: { enabled: true, port: 12345, state: "failed", error: "EPIPE" },
    } as HubEvent),
  );
  const proxyEventStalePort = buildScopeStatusView(proxyEventStore.get());
  ok(
    "P6-B b2：failed 事件清空旧 port（限制 B）",
    proxyEventStalePort.proxyPort === null &&
      proxyEventStalePort.proxyText?.includes("EPIPE") === true,
    JSON.stringify({ port: proxyEventStalePort.proxyPort, text: proxyEventStalePort.proxyText }),
  );

  const noScopeProxyStore = new Store(applySnapshot(buildMockSnapshot()));
  noScopeProxyStore.update((s) =>
    applyEvent(s, {
      type: "proxy.state.changed",
      proxy: { enabled: true, port: 12345, state: "running" },
    } as HubEvent),
  );
  ok(
    "P6-B b2：旧快照无 scope 时事件不凭空造范围状态",
    noScopeProxyStore.get().scopeStatus === null,
    JSON.stringify(noScopeProxyStore.get().scopeStatus),
  );

  const proxyHub = createMockHub({
    snapshot: proxySnapWith({ enabled: true, port: 12345, state: "running" }),
  });
  const proxyHubEvents: HubEvent[] = [];
  proxyHub.onEvent((e) => proxyHubEvents.push(e));
  const emitProxy = (
    proxyHub as unknown as { emitProxyState?: (p: unknown) => void }
  ).emitProxyState;
  emitProxy?.call(proxyHub, {
    enabled: true,
    port: null,
    state: "failed",
    error: "EADDRINUSE",
  });
  const proxyHubSnap = await proxyHub.snapshot();
  const proxyHubView = buildScopeStatusView(applySnapshot(proxyHubSnap));
  ok(
    "P6-B b2：mock hub 广播 state.changed 并回写快照",
    proxyHubEvents.some((e) => e.type === "proxy.state.changed") &&
      proxyHubSnap.scope?.proxy?.state === "failed" &&
      proxyHubView.proxyText?.includes("EADDRINUSE") === true,
    JSON.stringify({
      events: proxyHubEvents.map((e) => e.type),
      proxy: proxyHubSnap.scope?.proxy,
      text: proxyHubView.proxyText,
    }),
  );
  proxyHub.stop();

  const proxyWorldRunning = buildProxyStateMockSnapshot("running");
  const proxyWorldRunningView = buildScopeStatusView(applySnapshot(proxyWorldRunning));
  ok(
    "P6-B b2：mock 世界 running(port=12345)",
    proxyWorldRunning.scope?.proxy?.state === "running" &&
      proxyWorldRunning.scope?.proxy?.port === 12345 &&
      proxyWorldRunningView.proxyText?.includes(":12345") === true,
    JSON.stringify(proxyWorldRunning.scope?.proxy),
  );

  const proxyWorldFailed = buildProxyStateMockSnapshot("failed");
  const proxyWorldFailedView = buildScopeStatusView(applySnapshot(proxyWorldFailed));
  ok(
    "P6-B b2：mock 世界 failed(error=EADDRINUSE)",
    proxyWorldFailed.scope?.proxy?.state === "failed" &&
      proxyWorldFailed.scope?.proxy?.error === "EADDRINUSE" &&
      proxyWorldFailedView.proxyText?.includes("EADDRINUSE") === true,
    JSON.stringify(proxyWorldFailed.scope?.proxy),
  );

  const proxyWorldStopped = buildProxyStateMockSnapshot("stopped");
  const proxyWorldStoppedView = buildScopeStatusView(applySnapshot(proxyWorldStopped));
  ok(
    "P6-B b2：mock 世界 stopped",
    proxyWorldStopped.scope?.proxy?.state === "stopped" &&
      proxyWorldStoppedView.proxyText?.includes("已停止") === true,
    JSON.stringify(proxyWorldStopped.scope?.proxy),
  );

  const proxyWorldStarting = buildProxyStateMockSnapshot("starting");
  const proxyWorldStartingView = buildScopeStatusView(applySnapshot(proxyWorldStarting));
  ok(
    "P6-B b2：mock 世界 starting",
    proxyWorldStarting.scope?.proxy?.state === "starting" &&
      proxyWorldStartingView.proxyText?.includes("启动中") === true,
    JSON.stringify(proxyWorldStarting.scope?.proxy),
  );

  const proxyWorldLegacy = buildProxyStateMockSnapshot("legacy");
  const proxyWorldLegacyView = buildScopeStatusView(applySnapshot(proxyWorldLegacy));
  ok(
    "P6-B b2：mock 世界旧快照无 state",
    proxyWorldLegacy.scope?.proxy?.state === undefined &&
      proxyWorldLegacyView.proxyState === "unknown",
    JSON.stringify(proxyWorldLegacy.scope?.proxy),
  );

  const proxyWorldLegacyOff = buildProxyStateMockSnapshot("legacy-disabled");
  const proxyWorldLegacyOffView = buildScopeStatusView(applySnapshot(proxyWorldLegacyOff));
  ok(
    "P6-B b2：mock 世界旧快照 enabled=false",
    proxyWorldLegacyOff.scope?.proxy?.enabled === false &&
      proxyWorldLegacyOffView.proxyState === "disabled",
    JSON.stringify(proxyWorldLegacyOff.scope?.proxy),
  );

  // ---------------------------------------------------------------- P6-C 2.1 / D3
  section("P6-C 2.1 · D3 thought 块上限 / 窗口文本预算");

  const capSink = new SessionStreamSink("s-cap", { windowMs: 80, schedule: () => 0 });
  for (let i = 0; i < 10; i += 1) {
    capSink.push({
      seq: i + 1,
      ts: Date.now(),
      kind: "agent_thought",
      text: "x".repeat(4000),
    });
  }
  capSink.flush();
  const capBlock = capSink.snapshot().blocks[0];
  ok(
    "P6-C 2.1：thought 块超过上限会截断并保留标记",
    (capBlock?.text?.length ?? 0) <= MAX_THOUGHT_TEXT + 20 &&
      capBlock?.text?.includes("前文过长已省略") === true,
    JSON.stringify({ len: capBlock?.text?.length, max: MAX_THOUGHT_TEXT }),
  );

  const msgSink = new SessionStreamSink("s-msg", { windowMs: 80, schedule: () => 0 });
  msgSink.push({ seq: 1, ts: Date.now(), kind: "agent_message", text: "m".repeat(5000) });
  msgSink.flush();
  const msgBlock = msgSink.snapshot().blocks[0];
  ok(
    "P6-C 2.1：message 块不截断",
    msgBlock?.text?.length === 5000,
    JSON.stringify({ len: msgBlock?.text?.length }),
  );

  const windowBlocks = [
    { id: 1, kind: "thought", ts: 0, lastTs: 0, text: "a".repeat(50_000) },
    { id: 2, kind: "thought", ts: 0, lastTs: 0, text: "b".repeat(50_000) },
    { id: 3, kind: "thought", ts: 0, lastTs: 0, text: "c".repeat(50_000) },
  ];
  const windowStart = fitWindowStart(windowBlocks as never, 3, MAX_WINDOW_TEXT);
  ok(
    "P6-C 2.1：fitWindowStart 按文本预算前移",
    windowStart === 1,
    JSON.stringify({ start: windowStart, maxWindowText: MAX_WINDOW_TEXT }),
  );

  // WP9-B1：AWD 只读面板纯模型/可见性。
  {
    const awdView = {
      taskId: "t-awd",
      round: { number: 2, startedAt: 1000, endsAt: 61000, state: "running" },
      services: [{ id: "t1", name: "web", target: "h:80", status: "alive", ownerSessionId: "s1", patchStatus: "pending" }],
      flags: [{ round: 1, candidates: [{ id: "f1", taskId: "t-awd", value: "flag{a}", status: "confirmed", evidence: "E2", firstSeen: 0, sources: [], submittedAt: 1 }], confirmed: 1, submitted: 1 }],
      patches: [{ id: "p1", service: "web", vuln: "sqli", status: "verified", evidence: "E2", witness: "w" }],
      checks: [{ round: 2, item: "ssh", status: "ok", evidence: "E1" }],
      attacks: [{ id: "a1", attacker: "t1", target: "t2:80", action: "sqli", result: "flag", evidence: "E2", at: 1 }],
      warnings: ["bad fact"],
    } as never;
    const model = buildAwdPanelModel(awdView, 1000);
    ok(
      "P9-B1：AWD 轮次倒计时文本",
      formatAwdRemaining(awdView.round, 1000).includes("第 2 轮") &&
        formatAwdRemaining(awdView.round, 1000).includes("剩余 01:00") &&
        formatAwdRemaining({ number: 1, startedAt: 0, endsAt: 10, state: "ended" }, 1000) === "第 1 轮 · 已结束",
      `${formatAwdRemaining(awdView.round, 1000)} | ${formatAwdRemaining({ number: 1, startedAt: 0, endsAt: 10, state: "ended" }, 1000)}`,
    );
    ok(
      "P9-B1：AWD 只读模型汇总",
      model.serviceRows.length === 1 && model.flagRows.length === 1 && model.patchRows.length === 1 &&
        model.checkRows.length === 1 && model.attackRows.length === 1 && model.warnings[0] === "bad fact",
      JSON.stringify(model),
    );
    ok(
      "P9-B1：AWD 面板仅在 category=awd + 视图存在时显示",
      awdVisible({ task: { category: "awd" } as never, awd: awdView }) === true &&
        awdVisible({ task: { category: "web" } as never, awd: awdView }) === false &&
        awdVisible({ task: { category: "awd" } as never, awd: null }) === false,
    );
    ok(
      "P9-B1：AWD 空视图不抛错",
      buildAwdPanelModel({
        taskId: "t",
        round: null,
        services: [],
        flags: [],
        patches: [],
        checks: [],
        attacks: [],
        warnings: [],
      } as never).roundText === "未开始轮次",
    );
    const batchView = {
      ...(awdView as never as Record<string, unknown>),
      flags: [
        {
          round: 1,
          candidates: [
            { id: "ok", taskId: "t", value: "flag{ok}", status: "confirmed", evidence: "E2", firstSeen: 0, sources: [], submittedAt: null },
            { id: "done", taskId: "t", value: "flag{done}", status: "confirmed", evidence: "E2", firstSeen: 0, sources: [], submittedAt: 1 },
            { id: "new", taskId: "t", value: "flag{new}", status: "new", evidence: "E2", firstSeen: 0, sources: [], submittedAt: null },
          ],
          confirmed: 2,
          submitted: 1,
        },
      ],
    } as never;
    ok(
      "P9-C2：批量提交仅选 confirmed 且未提交",
      submittableAwdFlags(batchView).map((c) => c.id).join(",") === "ok",
      JSON.stringify(submittableAwdFlags(batchView).map((c) => c.id)),
    );
  }

  // WP9-B2：IR 只读面板纯模型/可见性。
  {
    const irView = {
      taskId: "t-ir",
      evidence: [
        { id: "attachment:access.log", kind: "attachment", path: "attachments/access.log", sha256: "abcdef123456", evidence: "E0", source: "files", addedAt: 1 },
        { id: "e2", kind: "file", path: "evidence/alert.txt", evidence: "E2", witness: "w", source: "manual", addedAt: 2 },
      ],
      timeline: [
        { id: "t1", at: 100, source: "log", event: "first" },
        { id: "t2", at: 200, source: "log", event: "second", impact: "high", evidence: "E1" },
      ],
      questions: [
        { id: "q1", question: "攻击者 IP?", status: "answered", answer: "1.2.3.4", evidence: "E2" },
        { id: "q2", question: "入侵时间?", status: "open" },
      ],
      attachments: [],
      artifacts: [],
      warnings: ["bad fact"],
    } as never;
    const model = buildIrPanelModel(irView);
    ok(
      "P9-B2：IR 证据板/时间线/问题模型",
      model.evidenceRows.length === 2 && model.timelineRows.length === 2 &&
        model.timelineRows[0]?.includes("first") && model.timelineRows[1]?.includes("second") &&
        model.questionRows[0]?.includes("1.2.3.4") && model.warnings[0] === "bad fact",
      JSON.stringify(model),
    );
    ok(
      "P9-B2：IR 面板仅在 category=ir + 视图存在时显示",
      irVisible({ task: { category: "ir" } as never, ir: irView }) === true &&
        irVisible({ task: { category: "awd" } as never, ir: irView }) === false &&
        irVisible({ task: { category: "ir" } as never, ir: null }) === false,
    );
    ok(
      "P9-B2：IR 空视图不抛错",
      buildIrPanelModel({
        taskId: "t",
        evidence: [],
        timeline: [],
        questions: [],
        attachments: [],
        artifacts: [],
        warnings: [],
      } as never).evidenceRows.length === 0,
    );
  }

  // P7-B：mcp.unavailable 只标记会话，不改状态；旧快照无字段。
  {
    const mcpBase = {
      ...emptyState(),
      task: { id: "task-mcp" } as never,
      sessions: [
        {
          id: "s-mcp",
          taskId: "task-mcp",
          agent: "claude",
          role: "lead",
          tier: "guarded",
          status: "running",
          acpSession: null,
          pid: null,
          model: null,
          startedAt: 0,
          endedAt: null,
        },
      ],
      sessionMeta: { "s-mcp": { taskId: "task-mcp", status: "running" } },
    } as never;
    const mcpAfter = applyEvent(mcpBase, {
      type: "mcp.unavailable",
      sessionId: "s-mcp",
      taskId: "task-mcp",
    }) as { sessions: Array<{ id: string; status: string; mcpUnavailable?: boolean }> };
    ok(
      "P7-B：mcp.unavailable 标记会话但不改 status",
      mcpAfter.sessions[0]?.mcpUnavailable === true && mcpAfter.sessions[0]?.status === "running",
      JSON.stringify(mcpAfter.sessions[0]),
    );
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
