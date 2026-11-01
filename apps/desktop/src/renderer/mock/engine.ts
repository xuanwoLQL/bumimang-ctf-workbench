/**
 * Mock HubApi：在真实主进程（Lane A 的 `hub:snapshot` / `hub:event` / `hub:action`）接上之前，
 * 用进程内实现撑起整个渲染进程。
 *
 * 它严格实现契约的 `HubApi` 三个方法，外加 `start()/stop()` 用来模拟一条
 * 高频 `session.stream` 事件流，方便 T7 的节流在真实浏览器里肉眼可见。
 * 纯逻辑、无 DOM，可被 smoke 测试直接 import。
 *
 * P1-E：默认仍是旧的 2 任务 mock（旧 smoke 断言逐条保留）；`{ multiTask: true }`
 * 时给出 3 任务（1 个 archived）/ 每任务 2 会话 / 跨任务审批的多任务世界。
 * 内部用 allSessions/allApprovals 保存全部任务的数据，`snapshot()` 只吐焦点任务
 * 的 sessions/approvals，和真实 Hub 的快照语义一致。
 */
import type {
  ApprovalView,
  ArtifactPreview,
  ArtifactView,
  AttachmentPickKind,
  AttachmentPickResult,
  AttachmentView,
  FlagCandidateView,
  HubApi,
  HubAction,
  HubEvent,
  HubSnapshot,
  ActionResult,
  PermissionGrantView,
  SessionView,
  StreamUpdate,
  TargetView,
} from "../contract.ts";
import {
  buildMockSnapshot,
  buildMultiTaskMockSnapshot,
  buildMultiTaskMockSessions,
  buildMockScoreboard,
  mockFlagsForTask,
  MOCK_ARTIFACTS,
  MOCK_ATTACHMENTS,
} from "./data.ts";
import { applySnapshot, applyEvent, Store, isActiveSessionStatus } from "../store.ts";

type ProxyStateChangedEvent = Extract<HubEvent, { type: "proxy.state.changed" }>;

export interface MockHubApi extends HubApi {
  start(): void;
  stop(): void;
  /** P6-B 批次 2b：测试/演示用，广播代理真实状态变化。 */
  emitProxyState(proxy: ProxyStateChangedEvent["proxy"]): void;
}

export interface MockOptions {
  /** 使用 P1-E 的 3 任务世界（1 个 archived、每任务 2 会话）。 */
  multiTask?: boolean;
  /** 多任务世界的技能库状态；默认 configured（P2-C）。 */
  skillMode?: "configured" | "unconfigured" | "none";
  /** 直接指定初始快照（测试/演示用）；优先级高于 multiTask。 */
  snapshot?: HubSnapshot;
  /** P5-C：多任务世界的 flag 候选；none = 已知无候选（flags: []）。 */
  flags?: "present" | "none";
  /** P5-D：多任务世界的提交历史；none = 全部未提交。 */
  submits?: "present" | "none";
  /**
   * P6-C 2.3：full-UI mock 高倍率 stream（仅测试页 ?stress=1）。
   * 200 条 agent_thought / 50ms + 周期性 health/session.upsert；默认关闭。
   */
  stress?: boolean;
  /** P6-C 2.3：用真实 stream 回放（测试 preload 注入；仅 ?stress=replay）。 */
  stressStream?: StreamUpdate[];
}

function cloneFlagCandidates(list: FlagCandidateView[]): FlagCandidateView[] {
  return list.map((f) => ({ ...f, sources: f.sources.map((s) => ({ ...s })) }));
}

function toSnapshot(
  state: ReturnType<typeof applySnapshot>,
  allSessions: Map<string, SessionView>,
  allApprovals: Map<string, ApprovalView>,
  allFlags: Map<string, FlagCandidateView[]>,
  flagsKnown: boolean,
  scoreboardKnown: boolean,
): HubSnapshot {
  const focusId = state.task?.id ?? null;
  const tasks = state.tasks.map((t) => {
    const list = [...allSessions.values()].filter((s) => s.taskId === t.id);
    const view = {
      ...t,
      runningSessions: list.filter((s) => isActiveSessionStatus(s.status)).length,
      totalSessions: list.length,
    };
    // P5-C：焦点/非焦点任务的候选数量都从 mock 的 per-task 表算；没有表的任务保留快照里的值。
    if (flagsKnown && allFlags.has(t.id)) view.flagCount = (allFlags.get(t.id) ?? []).length;
    // 与真实 Hub 一致：完整 targets/denyTargets/scopeNotes 只给焦点任务。
    if (t.id !== focusId) {
      delete view.targets;
      delete view.denyTargets;
      delete view.scopeNotes;
    }
    return view;
  });
  const focus = state.task ? tasks.find((t) => t.id === state.task?.id) ?? state.task : null;
  const sessions = [...allSessions.values()].filter((s) => s.taskId === focusId);
  const approvals = [...allApprovals.values()].filter((a) => a.taskId === focusId);
  const maxPerTask = state.quota?.maxSessionsPerTask ?? 3;
  const maxTotal = state.quota?.maxSessionsTotal ?? 8;
  const running = [...allSessions.values()].filter((s) => {
    const task = tasks.find((t) => t.id === s.taskId);
    return task && !task.archived && isActiveSessionStatus(s.status);
  }).length;
  const flagCounts = Object.fromEntries(
    tasks.map((t) => [
      t.id,
      allFlags.has(t.id) ? (allFlags.get(t.id) ?? []).length : t.flagCount ?? 0,
    ]),
  );
  return {
    task: focus,
    tasks,
    sessions,
    approvals,
    approvalsAll: [...allApprovals.values()],
    ...(flagsKnown ? { flags: cloneFlagCandidates(allFlags.get(focusId ?? "") ?? []) } : {}),
    ...(scoreboardKnown ? { scoreboard: buildMockScoreboard(tasks, flagCounts) } : {}),
    attachments: state.attachments,
    artifacts: state.artifacts,
    quota: { maxSessionsPerTask: maxPerTask, maxSessionsTotal: maxTotal, runningSessions: running },
    ...(state.scopeStatus
      ? {
          scope: {
            enabled: state.scopeStatus.enabled,
            outOfScopeAction: state.scopeStatus.outOfScopeAction,
            // P6-B 批次 2b：连 state/error 一起往返，事件后再拉快照也能看到真实状态。
            proxy: state.scopeStatus.proxy
              ? { ...state.scopeStatus.proxy }
              : { enabled: false, port: null },
          },
        }
      : {}),
    permissionGrants: state.permissionGrants,
    // P2-C：技能库状态与简报预览随 store 往返；旧世界为 null 时不带字段。
    ...(state.skillStatus
      ? {
          skill: {
            configured: state.skillStatus.configured,
            root: state.skillStatus.root,
            packages: state.skillStatus.packages.slice(),
            builtAt: state.skillStatus.builtAt,
            ...(state.skillStatus.source ? { source: state.skillStatus.source } : {}),
            ...(state.skillStatus.error ? { error: state.skillStatus.error } : {}),
          },
        }
      : {}),
    ...(state.briefingPreview
      ? {
          briefingPreview: {
            playbookTitle: state.briefingPreview.playbookTitle,
            skillRoutingPaths: new Array(state.briefingPreview.skillRoutingCount).fill(""),
            knowledgeToolsAvailable: state.briefingPreview.knowledgeToolsAvailable,
            evidenceRule: state.briefingPreview.evidenceSummary ?? "",
          },
        }
      : {}),
    board: {
      facts: state.facts,
      deadEnds: state.deadEnds,
      leases: state.leases,
      intents: state.intents,
    },
    health: state.health,
    agents: state.agents,
    policy: state.policy ?? undefined,
    workDir: state.workDir ?? "D:\\agent\\xuanwo\\work",
  };
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function extName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "bin";
}

function mockSha(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function mockAttachment(path: string, index: number): AttachmentView {
  const name = baseName(path);
  const type = extName(name);
  return {
    name,
    relativePath: name,
    size: 1024 + index * 137,
    sha256: mockSha(name),
    type,
    source: "upload",
    importedAt: Date.now(),
  };
}

/** mock 预览：HTML/SVG 只返回文本，图片只返回 PNG data URL，二进制返回 hex。 */
function mockArtifactPreview(path: string): ArtifactPreview {
  const p = path.replace(/\\/g, "/");
  if (p.includes("\0") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) {
    return { kind: "unsupported", content: "路径越界", error: "路径越界" };
  }
  const ext = extName(p);
  if (ext === "html" || ext === "htm") {
    return {
      kind: "text",
      content: "<script>alert('xss')</script>\n<h1>HTML 只当文本</h1>",
      totalBytes: 52,
    };
  }
  if (ext === "svg") {
    return {
      kind: "text",
      content: '<svg onload="alert(1)"><text>SVG 只当文本</text></svg>',
      totalBytes: 48,
    };
  }
  if (["txt", "md", "log", "json", "csv", "yml", "yaml"].includes(ext)) {
    return {
      kind: "text",
      content: `mock 预览：${p}\nflag{mock_preview}`,
      totalBytes: 64,
    };
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) {
    return {
      kind: "image",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nK0AAAAASUVORK5CYII=",
      mime: "image/png",
      totalBytes: 68,
    };
  }
  return {
    kind: "hex",
    content: "00000000  4d 5a 90 00 03 00 00 00  04 00 00 00 ff ff 00 00  |MZ..............|",
    totalBytes: 1024,
  };
}

/** P5-C：mock 导出（与主进程同格式；只返回字符串，不写文件）。 */
function mockExportFlags(
  format: "md" | "csv" | "json",
  task: { id: string; title: string; status: string },
  flags: FlagCandidateView[],
): string {
  const iso = (ms: number): string => new Date(ms).toISOString();
  if (format === "json") {
    return JSON.stringify(
      {
        format: "json",
        taskCount: 1,
        candidateCount: flags.length,
        tasks: [
          {
            taskId: task.id,
            title: task.title,
            status: task.status,
            candidates: flags.map((f) => ({
              id: f.id,
              value: f.value,
              status: f.status,
              evidence: f.evidence,
              firstSeen: f.firstSeen,
              submittedAt: f.submittedAt ?? null,
              submitStatus: f.submitStatus ?? null,
              sources: f.sources.map((s) => ({ ...s })),
            })),
          },
        ],
      },
      null,
      2,
    );
  }
  if (format === "csv") {
    const rows = [
      "taskId,taskTitle,taskStatus,flag,status,evidence,sources,firstSeen,submittedAt",
    ];
    for (const f of flags) {
      const sources = f.sources
        .map((s) => `${s.sessionId ?? "system"}@${s.witness ?? "-"}(${s.evidence})`)
        .join("; ");
      rows.push(
        [
          task.id,
          task.title,
          task.status,
          f.value,
          f.status,
          f.evidence,
          sources,
          iso(f.firstSeen),
          f.submittedAt ? iso(f.submittedAt) : "",
        ]
          .map((v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
          .join(","),
      );
    }
    return rows.join("\n");
  }
  const lines = [
    "# Flag 导出",
    "",
    `## 任务：${task.title}（${task.id}）`,
    `任务状态：${task.status}；候选数：${flags.length}`,
    "",
    "| flag | 状态 | 证据 | 首次发现 |",
    "| --- | --- | --- | --- |",
  ];
  for (const f of flags) {
    lines.push(`| ${f.value} | ${f.status} | ${f.evidence} | ${iso(f.firstSeen)} |`);
  }
  return lines.join("\n");
}

let counter = 10;

export function createMockHub(opts: MockOptions = {}): MockHubApi {
  const flagsMode = opts.flags ?? "present";
  const submitsMode = opts.submits ?? "present";
  const initial =
    opts.snapshot ??
    (opts.multiTask
      ? buildMultiTaskMockSnapshot("task-mt-b", {
          skill: opts.skillMode ?? "configured",
          flags: flagsMode,
          submits: submitsMode,
        })
      : buildMockSnapshot());
  const store = new Store(applySnapshot(initial));
  const allSessions = new Map<string, SessionView>();
  const initialSessions = opts.multiTask && !opts.snapshot
    ? buildMultiTaskMockSessions()
    : opts.snapshot
      ? opts.snapshot.sessions
      : initial.sessions;
  for (const s of initialSessions) allSessions.set(s.id, { ...s });
  const allApprovals = new Map<string, ApprovalView>();
  for (const a of initial.approvalsAll ?? initial.approvals) allApprovals.set(a.id, { ...a });
  // P5-C：per-task 候选表（真实 Hub 只把焦点任务的列表放进快照）。
  const flagsKnown = opts.snapshot ? Array.isArray(opts.snapshot.flags) : Boolean(opts.multiTask);
  const scoreboardKnown = opts.snapshot
    ? Array.isArray(opts.snapshot.scoreboard)
    : Boolean(opts.multiTask);
  const allFlags = new Map<string, FlagCandidateView[]>();
  if (opts.snapshot) {
    const focusId = opts.snapshot.task?.id;
    if (focusId && Array.isArray(opts.snapshot.flags)) {
      allFlags.set(focusId, cloneFlagCandidates(opts.snapshot.flags));
    }
  } else if (opts.multiTask) {
    for (const t of initial.tasks) {
      const list =
        flagsMode === "none" ? [] : mockFlagsForTask(t.id, submitsMode);
      allFlags.set(t.id, cloneFlagCandidates(list));
    }
  }

  const listeners = new Set<(e: HubEvent) => void>();
  /** 会话 → mock 历史（R16 的接口形状；真实实现由主进程从 stream.jsonl 读） */
  const histories = new Map<string, StreamUpdate[]>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (e: HubEvent) => {
    store.update((s) => applyEvent(s, e));
    for (const l of listeners) l(e);
  };

  /** mock 侧的通配授权：只为让 UI 的「全部放行」按钮在无主进程时也有反馈。 */
  const grantAllFor = (
    sessionId: string,
    agentId: string,
    scope: "session" | "agent" | "global",
  ): void => {
    const grant: PermissionGrantView = {
      id:
        scope === "global"
          ? "global:all"
          : scope === "agent"
            ? `agent:${agentId}:all`
            : `sess:${sessionId}:all`,
      agentId: scope === "global" ? "*" : agentId,
      scope: scope === "session" ? "session" : "agent",
      sessionId: scope === "session" ? sessionId : null,
      category: "all",
      label:
        scope === "global"
          ? "全局全部放行（所有 agent / 所有会话）"
          : "全部操作（含高风险，显式全部放行）",
      risk: "high",
      createdAt: Date.now(),
    };
    const grants = store
      .get()
      .permissionGrants.filter((g) => g.id !== grant.id)
      .concat(grant);
    emit({ type: "permission.updated", grants });
  };

  const findTask = (taskId: string) => store.get().tasks.find((t) => t.id === taskId);
  const sessionOf = (sessionId: string) => allSessions.get(sessionId);
  const flagsOf = (taskId: string): FlagCandidateView[] => allFlags.get(taskId) ?? [];
  const emitFlags = (taskId: string): void => {
    if (!flagsKnown) return;
    emit({ type: "flag.updated", taskId, flags: cloneFlagCandidates(flagsOf(taskId)) });
  };

  const hub: MockHubApi = {
    async snapshot(): Promise<HubSnapshot> {
      return toSnapshot(store.get(), allSessions, allApprovals, allFlags, flagsKnown, scoreboardKnown);
    },

    async history(sessionId: string): Promise<StreamUpdate[]> {
      return (histories.get(sessionId) ?? []).slice();
    },

    async previewArtifact(taskId: string | undefined, path: string): Promise<ArtifactPreview> {
      const id = taskId || store.get().task?.id;
      if (!id) return { kind: "unsupported", content: "没有活动任务", error: "没有活动任务" };
      if (!findTask(id)) {
        return { kind: "unsupported", content: `任务不存在：${id}`, error: `任务不存在：${id}` };
      }
      return mockArtifactPreview(path);
    },

    async pickAttachments(kind: AttachmentPickKind): Promise<AttachmentPickResult> {
      // mock 不弹真实系统框；返回固定演示路径，让浏览器直开也能看到导入闭环。
      const paths =
        kind === "folder"
          ? ["D:\\mock\\附件文件夹"]
          : kind === "zip"
            ? ["D:\\mock\\bundle.zip"]
            : ["D:\\mock\\题目说明.txt", "D:\\mock\\screenshot.png"];
      return { canceled: false, paths };
    },

    async dispatch(action: HubAction): Promise<ActionResult> {
      switch (action.type) {
        case "session.start": {
          const task = findTask(action.taskId);
          if (!task) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          const session: SessionView = {
            id: `s${counter++}`,
            taskId: action.taskId,
            agent: action.agent,
            role: action.role,
            tier: action.tier,
            status: "starting",
            acpSession: null,
            pid: null,
            model: action.model ?? null,
            startedAt: Date.now(),
            endedAt: null,
          };
          allSessions.set(session.id, session);
          emit({ type: "session.upsert", session });
          if (action.allowAll) grantAllFor(session.id, session.agent, "session");
          // 模拟握手：300ms 后转 running，让窗格出现状态流转。
          setTimeout(() => {
            const live = allSessions.get(session.id);
            if (!live) return;
            const next = { ...live, status: "running" as const, pid: 9000 + counter };
            allSessions.set(session.id, next);
            emit({ type: "session.upsert", session: next });
          }, 300);
          return { ok: true };
        }
        case "session.stop": {
          const s = sessionOf(action.sessionId);
          if (!s) return { ok: false, error: "session not found" };
          const next = { ...s, status: "stopped" as const, endedAt: Date.now() };
          allSessions.set(s.id, next);
          emit({ type: "session.upsert", session: next });
          return { ok: true };
        }
        case "session.remove": {
          const s = sessionOf(action.sessionId);
          if (!s) return { ok: false, error: "session not found" };
          allSessions.delete(action.sessionId);
          histories.delete(action.sessionId);
          emit({ type: "session.removed", sessionId: action.sessionId, taskId: s.taskId });
          return { ok: true };
        }
        case "session.setTier": {
          if (!sessionOf(action.sessionId)) return { ok: false, error: "session not found" };
          // 与真实主进程一致：agent 侧权限模式在启动时注入，运行中不假装成功。
          return { ok: false, error: "运行中不支持切换档位：请在新建会话时选择档位" };
        }
        case "permission.grantAll": {
          if (action.scope === "global") {
            grantAllFor("", "*", "global");
            return { ok: true, message: "mock: 已全局全部放行（硬阻断仍生效）" };
          }
          const focusId = store.get().task?.id ?? null;
          const targetTask = action.taskId ?? focusId;
          if (!targetTask) return { ok: false, error: "没有活动任务" };
          // 与 P1-B/C 主进程当前实现一致：scope=all 只作用于焦点/指定任务，
          // 不会因为传了 taskId 就偷偷跨到其他任务。
          const taskSessions = [...allSessions.values()].filter((s) => s.taskId === targetTask);
          const targets =
            action.scope === "session"
              ? taskSessions.filter((s) => s.id === action.sessionId)
              : action.scope === "agent"
                ? taskSessions.filter((s) => s.agent === action.agentId)
                : taskSessions.filter((s) => isActiveSessionStatus(s.status));
          for (const s of targets) grantAllFor(s.id, s.agent, "session");
          if (action.scope === "agent" && action.agentId) {
            grantAllFor("", action.agentId, "agent");
          }
          return { ok: true, message: "mock: 已全部放行（硬阻断仍生效）" };
        }
        case "session.prompt": {
          const s = sessionOf(action.sessionId);
          if (!s) return { ok: false, error: "session not found" };
          const userUpdate: StreamUpdate = { ts: Date.now(), kind: "user_prompt", text: action.text };
          const hist = histories.get(s.id) ?? [];
          hist.push(userUpdate);
          histories.set(s.id, hist);
          emit({ type: "session.stream", sessionId: s.id, taskId: s.taskId, update: userUpdate });
          // 模拟 agent 回一句，让 mock 模式下也能看到「提示 → 回应」的闭环。
          setTimeout(() => {
            const reply: StreamUpdate = {
              ts: Date.now(),
              kind: "agent_message",
              text: `（mock）收到提示：${action.text.slice(0, 60)}`,
            };
            const h = histories.get(s.id) ?? [];
            h.push(reply);
            histories.set(s.id, h);
            emit({ type: "session.stream", sessionId: s.id, taskId: s.taskId, update: reply });
          }, 400);
          return { ok: true, message: s.status === "running" ? "已排队" : undefined };
        }
        case "session.interrupt":
          return { ok: true };
        case "permission.revoke": {
          // mock 只演示 UI 闭环：真正持久化在 Electron 主进程。
          emit({
            type: "permission.updated",
            grants: store.get().permissionGrants.filter((g) =>
              g.agentId !== action.agentId || (action.grantId && g.id !== action.grantId),
            ),
          });
          return { ok: true };
        }
        case "task.setStatus": {
          const task = store.get().task;
          if (!task || (action.taskId && action.taskId !== task.id)) {
            return { ok: false, error: "task not found" };
          }
          const solved = action.status === "solved";
          const nextAnswer = solved ? action.answer?.trim() || task.answer : null;
          // P5-C：与主进程一致——solved 时补一条 human 候选；改回非 solved 清空候选。
          let nextFlags = flagsOf(task.id);
          if (solved && nextAnswer) {
            if (!nextFlags.some((f) => f.value === nextAnswer)) {
              const now = Date.now();
              nextFlags = [
                ...nextFlags,
                {
                  id: `flag-mock-${counter++}`,
                  taskId: task.id,
                  value: nextAnswer,
                  status: "new",
                  evidence: "E0",
                  firstSeen: now,
                  sources: [{ sessionId: "human", witness: null, evidence: "E0", seenAt: now }],
                  submittedAt: null,
                  submitStatus: null,
                },
              ];
            }
          } else if (!solved) {
            nextFlags = [];
          }
          allFlags.set(task.id, nextFlags);
          if (flagsKnown) emitFlags(task.id);
          emit({
            type: "task.upsert",
            task: {
              ...task,
              status: action.status,
              // 与主进程一致：改回待解时清掉旧答案，避免把旧 flag 当成当前答案。
              answer: nextAnswer,
              solvedBy: solved ? task.solvedBy ?? "human" : null,
              flagCount: nextFlags.length,
              flagCandidate: solved
                ? nextFlags.find((f) => f.value === nextAnswer)?.value ?? null
                : null,
            },
          });
          return { ok: true };
        }
        case "flag.confirm": {
          const task = findTask(action.taskId);
          if (!task) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          if (task.id !== store.get().task?.id) {
            return { ok: false, error: "mock 只支持焦点任务的 flag 操作" };
          }
          const list = flagsOf(action.taskId);
          const candidate = list.find((f) => f.id === action.candidateId);
          if (!candidate) {
            return { ok: false, error: `flag 候选不存在或不属于该任务：${action.candidateId}` };
          }
          const nextFlags = list.map((f) =>
            f.id === candidate.id ? { ...f, status: "confirmed" as const } : f,
          );
          allFlags.set(action.taskId, nextFlags);
          emitFlags(action.taskId);
          emit({
            type: "task.upsert",
            task: {
              ...task,
              status: "solved",
              answer: candidate.value,
              solvedBy: "human",
              flagCount: nextFlags.length,
              updatedAt: Date.now(),
            },
          });
          return { ok: true, message: `mock: 已确认候选；任务「${task.title}」标记为已解出` };
        }
        case "flag.reject": {
          const task = findTask(action.taskId);
          if (!task) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          if (task.id !== store.get().task?.id) {
            return { ok: false, error: "mock 只支持焦点任务的 flag 操作" };
          }
          const list = flagsOf(action.taskId);
          const candidate = list.find((f) => f.id === action.candidateId);
          if (!candidate) {
            return { ok: false, error: `flag 候选不存在或不属于该任务：${action.candidateId}` };
          }
          const nextFlags = list.map((f) =>
            f.id === candidate.id ? { ...f, status: "false_positive" as const } : f,
          );
          allFlags.set(action.taskId, nextFlags);
          emitFlags(action.taskId);
          return { ok: true, message: `mock: 已标记候选为误报（任务「${task.title}」）` };
        }
        case "flag.export": {
          const taskId = action.taskId || store.get().task?.id;
          if (!taskId) return { ok: false, error: "没有活动任务" };
          const task = findTask(taskId);
          if (!task) return { ok: false, error: `任务不存在：${taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${taskId}` };
          const format = action.format;
          if (format !== "md" && format !== "csv" && format !== "json") {
            return { ok: false, error: `format 非法：${String(format)}` };
          }
          const flags = flagsOf(taskId);
          return {
            ok: true,
            message: `mock: 已生成 ${flags.length} 条候选的 ${format} 导出`,
            content: mockExportFlags(format, task, flags),
          };
        }
        case "flag.submit": {
          const taskId = action.taskId || store.get().task?.id;
          if (!taskId) return { ok: false, error: "没有活动任务" };
          const task = findTask(taskId);
          if (!task) return { ok: false, error: `任务不存在：${taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${taskId}` };
          const list = flagsOf(taskId);
          const candidate = list.find((f) => f.id === action.candidateId);
          if (!candidate) {
            return { ok: false, error: `flag 候选不存在或不属于该任务：${action.candidateId}` };
          }
          const mode = (action.mode ?? "manual") as string;
          if (mode === "command") {
            return { ok: false, error: "command 模式未实现（用户决策：WP6 评估前不做）" };
          }
          if (mode !== "manual" && mode !== "dry_run") {
            return { ok: false, error: `mode 非法：${mode}（允许：manual, dry_run）` };
          }
          if (candidate.status === "false_positive") {
            return { ok: false, error: "误报候选不能提交；请先重新确认为有效候选" };
          }
          if (mode === "dry_run") {
            return {
              ok: true,
              mode: "dry_run",
              argv: [candidate.value],
              message: "mock dry-run：只预览 argv，不执行、不写文件、不改候选状态",
            };
          }
          const submittedAt = Date.now();
          allFlags.set(
            taskId,
            list.map((f) =>
              f.id === candidate.id
                ? { ...f, submittedAt, submitStatus: "manual" }
                : f,
            ),
          );
          emitFlags(taskId);
          return {
            ok: true,
            mode: "manual",
            value: candidate.value,
            instructions:
              "复制 flag 到比赛平台手动提交；本应用不会自动提交、不会调用平台 API。",
            message: "mock: 已记录人工提交时间",
          };
        }
        case "attachment.import": {
          const taskId = action.taskId || store.get().task?.id;
          if (!taskId) return { ok: false, error: "没有活动任务" };
          const task = findTask(taskId);
          if (!task) return { ok: false, error: `任务不存在：${taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${taskId}` };
          const existing = task.attachments ?? [];
          const added = action.paths.map((p, i) => mockAttachment(p, existing.length + i));
          const attachments = [...existing, ...added];
          emit({
            type: "task.upsert",
            task: { ...task, attachments, attachmentCount: attachments.length, updatedAt: Date.now() },
          });
          return { ok: true, message: `mock: 已导入 ${added.length} 个文件` };
        }
        case "artifact.refresh": {
          const taskId = action.taskId || store.get().task?.id;
          if (!taskId) return { ok: false, error: "没有活动任务" };
          const task = findTask(taskId);
          if (!task) return { ok: false, error: `任务不存在：${taskId}` };
          const artifacts = MOCK_ARTIFACTS.map((a) => ({ ...a }));
          emit({ type: "artifact.updated", taskId, artifacts });
          return { ok: true, message: `mock: 已刷新 ${artifacts.length} 个工件` };
        }
        case "target.add": {
          const task = findTask(action.taskId);
          if (!task) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (task.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          const value = String(action.value ?? "").trim();
          if (!value || value.includes("\0") || value.length > 256) {
            return { ok: false, error: "目标 value 非空、<=256 且不能含 NUL" };
          }
          const kind = action.kind ?? "host";
          if (!["host", "cidr", "url"].includes(kind)) {
            return { ok: false, error: `目标 kind 非法：${kind}` };
          }
          if (action.notes !== undefined && action.notes.length > 4096) {
            return { ok: false, error: "目标 notes 过长（>4096）" };
          }
          const existing = task.targets ?? [];
          if (existing.some((t) => t.value === value)) {
            return { ok: false, error: `目标已存在：${value}` };
          }
          const target: TargetView = {
            id: `tg-${counter++}`,
            taskId: task.id,
            value,
            kind: kind as TargetView["kind"],
            status: "unknown",
            notes: action.notes ?? null,
            createdAt: Date.now(),
          };
          emit({
            type: "task.upsert",
            task: {
              ...task,
              targets: [...existing, target],
              denyTargets: task.denyTargets ?? [],
              scopeNotes: task.scopeNotes ?? null,
              updatedAt: Date.now(),
            },
          });
          return { ok: true, message: "mock: 目标已添加" };
        }
        case "target.update": {
          const task = findTask(action.taskId);
          if (!task) return { ok: false, error: `任务不存在：${action.taskId}` };
          const existing = task.targets ?? [];
          const target = existing.find((t) => t.id === action.targetId);
          if (!target) return { ok: false, error: `目标不存在：${action.targetId}` };
          if (
            action.status !== undefined &&
            !["unknown", "alive", "owned"].includes(action.status)
          ) {
            return { ok: false, error: `目标 status 非法：${action.status}` };
          }
          if (action.notes !== undefined && action.notes.length > 4096) {
            return { ok: false, error: "目标 notes 过长（>4096）" };
          }
          const next: TargetView = {
            ...target,
            status: action.status ?? target.status,
            notes: action.notes !== undefined ? action.notes : target.notes,
          };
          emit({
            type: "task.upsert",
            task: {
              ...task,
              targets: existing.map((t) => (t.id === target.id ? next : t)),
              updatedAt: Date.now(),
            },
          });
          return { ok: true, message: "mock: 目标已更新" };
        }
        case "target.remove": {
          const task = findTask(action.taskId);
          if (!task) return { ok: false, error: `任务不存在：${action.taskId}` };
          const existing = task.targets ?? [];
          if (!existing.some((t) => t.id === action.targetId)) {
            return { ok: false, error: `目标不存在：${action.targetId}` };
          }
          emit({
            type: "task.upsert",
            task: {
              ...task,
              targets: existing.filter((t) => t.id !== action.targetId),
              updatedAt: Date.now(),
            },
          });
          return { ok: true, message: "mock: 目标已移除" };
        }
        case "task.create": {
          const task = {
            id: `task-${counter++}`,
            title: action.title,
            brief: action.brief,
            status: "open" as const,
            answer: null,
            solvedBy: null,
            createdAt: Date.now(),
            category: action.category ?? ("unknown" as const),
            priority: action.priority ?? 0,
            runningSessions: 0,
            totalSessions: 0,
            updatedAt: Date.now(),
            archived: false,
            attachments: [],
            attachmentCount: 0,
            targets: [],
            denyTargets: [],
            scopeNotes: null,
            flagCandidate: null,
          };
          emit({ type: "task.upsert", task });
          return { ok: true };
        }
        case "task.switch":
        case "task.focus": {
          const t = findTask(action.taskId);
          if (!t) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (t.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          emit({ type: "task.upsert", task: t });
          // P5-C：切焦点后把新焦点的候选列表推给 store（真实 Hub 走快照）。
          emitFlags(t.id);
          return { ok: true };
        }
        case "task.stopAll": {
          const t = findTask(action.taskId);
          if (!t) return { ok: false, error: `任务不存在：${action.taskId}` };
          let stopped = 0;
          for (const s of [...allSessions.values()]) {
            if (s.taskId !== action.taskId || !isActiveSessionStatus(s.status)) continue;
            const next = { ...s, status: "stopped" as const, endedAt: Date.now() };
            allSessions.set(s.id, next);
            emit({ type: "session.upsert", session: next });
            stopped++;
          }
          return { ok: true, message: `已停止 ${stopped} 个会话（仅任务 ${t.title}）` };
        }
        case "task.archive": {
          const t = findTask(action.taskId);
          if (!t) return { ok: false, error: `任务不存在：${action.taskId}` };
          if (t.archived) return { ok: false, error: `任务已归档：${action.taskId}` };
          const active = [...allSessions.values()].filter(
            (s) => s.taskId === t.id && isActiveSessionStatus(s.status),
          );
          if (active.length > 0 && action.force !== true) {
            return { ok: false, error: `任务「${t.title}」仍有 ${active.length} 个活跃会话；请先 task.stopAll，或显式 force=true` };
          }
          for (const s of active) {
            const next = { ...s, status: "stopped" as const, endedAt: Date.now() };
            allSessions.set(s.id, next);
            emit({ type: "session.upsert", session: next });
          }
          const archived = { ...t, archived: true, runningSessions: 0, updatedAt: Date.now() };
          emit({ type: "task.upsert", task: archived });
          if (store.get().task === null || store.get().task?.id === t.id) {
            const next = store.get().tasks.find((x) => !x.archived);
            if (next) emit({ type: "task.upsert", task: next });
          }
          return { ok: true, message: `已归档任务「${t.title}」；历史保留` };
        }
        case "approval.decide":
          return decide(action.approvalId, action.decision);
        case "approval.bulk": {
          for (const id of action.ids) decide(id, action.decision);
          return { ok: true };
        }
        default: {
          const _exhaustive: never = action;
          return { ok: false, error: "unknown action" };
        }
      }
    },

    onEvent(cb: (e: HubEvent) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    emitProxyState(proxy: ProxyStateChangedEvent["proxy"]): void {
      emit({ type: "proxy.state.changed", proxy });
    },

    start(): void {
      if (timer != null) return;
      if (opts.stress) {
        const focusId = initial.task?.id ?? null;
        const focusSessions = [...allSessions.values()].filter(
          (s) => !focusId || s.taskId === focusId,
        );
        const target =
          focusSessions.find((s) => s.status === "running") ??
          focusSessions[0] ??
          [...allSessions.values()][0];
        if (!target) return;
        const replay = opts.stressStream;
        let seq = 1_000_000;
        let i = 0;
        let idx = 0;
        timer = setInterval(() => {
          if (replay && replay.length > 0) {
            const end = Math.min(replay.length, idx + 200);
            for (; idx < end; idx += 1) {
              const u = replay[idx]!;
              emit({
                type: "session.stream",
                sessionId: target.id,
                taskId: target.taskId,
                update: u,
              });
              i += 1;
              if (u.kind === "tool_call") {
                emit({
                  type: "health",
                  sessionId: target.id,
                  taskId: target.taskId,
                  health: { toolCalls: i, boardReads: 1, syncLag: 0 },
                });
                emit({
                  type: "session.upsert",
                  session: { ...target, status: "running" },
                });
              }
              if (idx % 1000 === 0) {
                emit({ type: "board.appended", taskId: target.taskId, events: [] });
              }
            }
            if (idx >= replay.length && timer) {
              clearInterval(timer);
              timer = null;
            }
            return;
          }
          for (let k = 0; k < 200; k += 1) {
            seq += 1;
            i += 1;
            emit({
              type: "session.stream",
              sessionId: target.id,
              taskId: target.taskId,
              update: { seq, ts: Date.now(), kind: "agent_thought", text: "思考" },
            });
          }
          if (i % 400 === 0) {
            emit({
              type: "health",
              sessionId: target.id,
              taskId: target.taskId,
              health: { toolCalls: i, boardReads: 1, syncLag: 0 },
            });
          }
          if (i % 2000 === 0) {
            emit({
              type: "session.upsert",
              session: { ...target, status: "running" },
            });
          }
        }, 50);
        return;
      }
      timer = setInterval(() => tick(), 250);
    },

    stop(): void {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  function decide(approvalId: string, decision: "approve" | "deny"): ActionResult {
    const ap = allApprovals.get(approvalId);
    if (!ap) return { ok: false, error: "approval not found" };
    const next = {
      ...ap,
      status: decision === "approve" ? ("approved" as const) : ("denied" as const),
      decidedBy: "human" as const,
      decidedAt: Date.now(),
    };
    allApprovals.set(approvalId, next);
    emit({ type: "approval.upsert", approval: next });
    return { ok: true };
  }

  function tick(): void {
    const running = [...allSessions.values()].filter((s) => s.status === "running");
    if (running.length === 0) return;
    const s = running[Math.floor(Math.random() * running.length)];
    const roll = Math.random();
    let update: StreamUpdate;
    if (roll < 0.2) {
      update = { ts: Date.now(), kind: "agent_thought", text: "……" };
    } else if (roll < 0.4) {
      update = { ts: Date.now(), kind: "tool_call", title: `read ${s.agent}/notes.md`, toolKind: "fs/read_text_file" };
    } else {
      update = { ts: Date.now(), kind: "tool_call_update", status: "in_progress" };
    }
    emit({ type: "session.stream", sessionId: s.id, taskId: s.taskId, update });
  }

  return hub;
}
