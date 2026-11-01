/**
 * R-3 · 新建 / 切换任务（DOM 层）。
 *
 * 契约早就有 `task.create`，但渲染进程一直没有入口 —— 首屏永远停在主进程冷启动时
 * 自动种下的「示例任务」上，新手没法换上自己 09:00 的真实挑战。这里加一个最小入口：
 * 点左栏任务卡上的「＋ 新任务」弹一个表单，填标题 + 简报（brief 是重点，会被注入
 * 每个会话的简报包），派发 `task.create`。
 *
 * 主进程收到后 `setTask` + 推 `task.upsert`（Lane A 的 hub 已实现），快照里的 task
 * 随之变成新任务，左栏任务卡跟着 store 重绘。所以这里只管「发出去 + 反馈」，不用
 * 自己改 store —— 那会是第二份真相。
 */
import type { UiCtx } from "./ctx.ts";
import type { AnswerSpec, AnswerType, AttachmentPickKind, TaskCategory, TaskView } from "./contract.ts";
import type { AppState } from "./store.ts";
import { isActiveSessionStatus, buildSkillStatusView } from "./store.ts";
import { buildAttachmentSelectionView, type AttachmentSelectionState } from "./artifacts.ts";
import { el } from "./dom.ts";
import { notify } from "./notice.ts";
import { taskStatusLabel } from "./session-status.ts";

const CATEGORY_LABEL: Record<TaskCategory, string> = {
  web: "Web",
  misc: "Misc",
  crypto: "Crypto",
  reverse: "Reverse",
  pwn: "Pwn",
  pentest: "渗透",
  ir: "应急",
  awd: "AWD",
  unknown: "未分类",
};

export function taskCategoryLabel(category: TaskCategory | undefined): string {
  return CATEGORY_LABEL[category ?? "unknown"] ?? "未分类";
}

/**
 * P1-E 的 category 下拉选项（P2-C 只做验证与导出，不重做组件）。
 * 契约的 `TaskCategory` 有 9 个值，这里保持同一顺序，`unknown` 永远可选。
 */
export const TASK_CATEGORY_OPTIONS: readonly TaskCategory[] = [
  "web", "misc", "crypto", "reverse", "pwn", "pentest", "ir", "awd", "unknown",
];

export interface TaskCategoryOption {
  value: TaskCategory;
  label: string;
}

export function buildTaskCategoryOptions(): TaskCategoryOption[] {
  return TASK_CATEGORY_OPTIONS.map((value) => ({ value, label: taskCategoryLabel(value) }));
}

/** 只把契约内的值发给后端；非法/缺失一律归一为 unknown（不静默发脏数据）。 */
export function normalizeTaskCategory(value: string | null | undefined): TaskCategory {
  return value != null && (TASK_CATEGORY_OPTIONS as readonly string[]).includes(value)
    ? (value as TaskCategory)
    : "unknown";
}

export type TaskPriorityParse = { ok: true; value: number | undefined } | { ok: false; error: string };

/** 优先级：空 = 用默认 0；非空必须是 0–100 的整数。 */
export function parseTaskPriority(raw: string): TaskPriorityParse {
  const text = raw.trim();
  if (text === "") return { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return { ok: false, error: "优先级必须是 0–100 的整数" };
  }
  return { ok: true, value };
}

/**
 * P2-C：创建任务弹窗 / 任务卡的技能库提示。
 *
 * 只在「未配置」或「错误」时返回文案；旧快照的「未知/未检测」不误报为未配置。
 * 这是提示，不是禁用：调用方不得据此禁用创建/启动。
 */
export function buildTaskSkillWarning(state: Pick<AppState, "skillStatus">): string | null {
  const view = buildSkillStatusView(state);
  return view.showWarning ? view.warningText : null;
}

export interface TaskBoardRow {
  task: TaskView;
  id: string;
  title: string;
  category: TaskCategory;
  categoryLabel: string;
  statusLabel: string;
  running: number;
  total: number;
  /** 附件数量（P3-C；旧快照缺席时为 0）。 */
  attachmentCount: number;
  /** P5-C：持久化 flag 候选数量（旧快照缺席时焦点任务回退到当前 flags 长度）。 */
  flagCount: number;
  isFocus: boolean;
  isArchived: boolean;
  flagCandidate: string | null;
}

export interface TaskBoardQuota {
  runningSessions: number;
  maxSessionsTotal: number;
  maxSessionsPerTask: number;
  /** 全局 running/max，如 "4/8"。 */
  totalText: string;
  /** 焦点任务 running/每任务上限，如 "2/3"。 */
  perTaskText: string;
  nearLimit: boolean;
  title: string;
}

export interface TaskBoardView {
  active: TaskBoardRow[];
  archived: TaskBoardRow[];
  focus: TaskBoardRow | null;
  backgroundRunning: number;
  archivedOpen: boolean;
  showArchived: boolean;
  quota: TaskBoardQuota | null;
}

/**
 * 任务看板的纯视图模型（smoke 直接验证，不依赖 DOM）。
 *
 * `tasks` 始终包含 archived；折叠只影响 `showArchived` 与 UI 是否渲染归档区。
 * 计数优先用快照里的 runningSessions/totalSessions；旧快照没有时，焦点任务
 * 用当前 sessions 现算，其他任务退化为 0（不猜）。
 */
export function buildTaskBoardView(
  state: Pick<AppState, "task" | "tasks" | "sessions" | "quota" | "flags">,
  opts: { archivedOpen?: boolean } = {},
): TaskBoardView {
  const focusId = state.task?.id ?? null;
  const focusRunning = state.sessions.filter((s) => !["blocked", "stopped", "failed", "done"].includes(s.status)).length;
  const focusTotal = state.sessions.length;
  // P5-C：焦点任务的 flags 数组是候选数量的权威来源；旧快照没有该字段时为 0。
  const focusFlagCount = Array.isArray(state.flags) ? state.flags.length : 0;
  const rows: TaskBoardRow[] = (state.tasks ?? []).map((t) => {
    const isFocus = t.id === focusId;
    const running =
      typeof t.runningSessions === "number" ? t.runningSessions : isFocus ? focusRunning : 0;
    const total =
      typeof t.totalSessions === "number" ? t.totalSessions : isFocus ? focusTotal : 0;
    return {
      task: t,
      id: t.id,
      title: t.title,
      category: t.category ?? "unknown",
      categoryLabel: taskCategoryLabel(t.category),
      statusLabel: taskStatusLabel(t.status),
      running,
      total,
      attachmentCount: t.attachmentCount ?? t.attachments?.length ?? 0,
      flagCount:
        typeof t.flagCount === "number" ? Math.max(0, t.flagCount) : isFocus ? focusFlagCount : 0,
      isFocus,
      isArchived: t.archived === true,
      flagCandidate: t.flagCandidate ?? null,
    };
  });
  const active = rows.filter((r) => !r.isArchived);
  const archived = rows.filter((r) => r.isArchived);
  const focus = active.find((r) => r.isFocus) ?? null;
  const backgroundRunning = active
    .filter((r) => !r.isFocus)
    .reduce((sum, r) => sum + r.running, 0);
  const q = state.quota;
  const quota: TaskBoardQuota | null = q
    ? {
        runningSessions: q.runningSessions,
        maxSessionsTotal: q.maxSessionsTotal,
        maxSessionsPerTask: q.maxSessionsPerTask,
        totalText: `${q.runningSessions}/${q.maxSessionsTotal}`,
        perTaskText: `${focus?.running ?? 0}/${q.maxSessionsPerTask}`,
        nearLimit: q.maxSessionsTotal > 0 && q.runningSessions / q.maxSessionsTotal >= 0.75,
        title:
          `全局运行 ${q.runningSessions}/${q.maxSessionsTotal} 个非终态会话；` +
          `每任务上限 ${q.maxSessionsPerTask}；归档任务不计入全局配额`,
      }
    : null;
  return {
    active,
    archived,
    focus,
    backgroundRunning,
    archivedOpen: opts.archivedOpen === true,
    showArchived: opts.archivedOpen === true,
    quota,
  };
}

/** 通用的危险动作确认浮层（归档 / 停止全部 / flag 确认与误报共用）。 */
export function openConfirmModal(opts: {
  title: string;
  lines: string[];
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  const overlay = el("div", { class: "task-overlay" });
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const confirmBtn = el(
    "button",
    { class: opts.danger ? "btn btn-deny" : "btn btn-approve", "data-act": "confirm" },
    opts.confirmText,
  );
  confirmBtn.addEventListener("click", () => {
    close();
    opts.onConfirm();
  });
  const modal = el("div", { class: `task-modal${opts.danger ? " task-modal-danger" : ""}` }, [
    el("h3", { class: "task-modal-title" }, opts.title),
    ...opts.lines.map((line) => el("div", { class: "task-form-current" }, line)),
    el("div", { class: "task-form-actions" }, [
      el("button", { class: "btn btn-cancel" }, "取消"),
      confirmBtn,
    ]),
  ]);
  modal.querySelector(".btn-cancel")?.addEventListener("click", close);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

/** P1-E：归档入口。有活会话时必须明确点 force，文案写清会先停哪些会话。 */
export function openTaskArchiveModal(ctx: UiCtx, task: TaskView): void {
  if (task.archived) {
    notify("任务已归档", "info");
    return;
  }
  const running =
    typeof task.runningSessions === "number"
      ? Math.max(0, task.runningSessions)
      : task.id === ctx.store.get().task?.id
        ? ctx.store.get().sessions.filter((s) => isActiveSessionStatus(s.status)).length
        : 0;
  const lines = running > 0
    ? [
        `任务「${task.title}」还有 ${running} 个非终态会话在跑。`,
        "继续归档会先停止这些会话（force），然后归档本任务。",
        "其他任务的会话不受影响；历史事实/会话仍保留可查。",
      ]
    : [
        `任务「${task.title}」当前没有非终态会话。`,
        "归档后任务从活跃看板折叠到「已归档」，历史事实/会话仍保留可查。",
      ];
  openConfirmModal({
    title: "归档任务",
    lines,
    confirmText: running > 0 ? "停止并归档（force）" : "确认归档",
    danger: true,
    onConfirm: () => {
      notify(running > 0 ? "正在停止会话并归档…" : "正在归档…", "info");
      void ctx.hub
        .dispatch({ type: "task.archive", taskId: task.id, force: running > 0 })
        .then((res) => {
          if (!res?.ok) notify(`归档失败：${res?.error ?? "未知错误"}`, "error");
          else notify(res.message ?? `已归档：${task.title}`, "info");
        });
    },
  });
}

/** P1-E：停止全部入口（只停本任务，不归档）。 */
export function openTaskStopAllModal(ctx: UiCtx, task: TaskView): void {
  const running =
    typeof task.runningSessions === "number"
      ? Math.max(0, task.runningSessions)
      : task.id === ctx.store.get().task?.id
        ? ctx.store.get().sessions.filter((s) => isActiveSessionStatus(s.status)).length
        : 0;
  if (running === 0) {
    notify("该任务没有在跑的会话", "info");
    return;
  }
  openConfirmModal({
    title: "停止本任务全部会话",
    lines: [
      `将停止任务「${task.title}」的 ${running} 个非终态会话。`,
      "不会停止其他任务，也不会归档任务；历史保留。",
    ],
    confirmText: `停止 ${running} 个会话`,
    danger: true,
    onConfirm: () => {
      notify("正在停止会话…", "info");
      void ctx.hub.dispatch({ type: "task.stopAll", taskId: task.id }).then((res) => {
        if (!res?.ok) notify(`停止失败：${res?.error ?? "未知错误"}`, "error");
        else notify(res.message ?? "已停止本任务会话", "info");
      });
    },
  });
}

export function openTaskModal(ctx: UiCtx): void {
  const current = ctx.store.get().task;

  let titleInput: HTMLInputElement;
  let briefInput: HTMLTextAreaElement;
  let categoryInput: HTMLSelectElement;
  let priorityInput: HTMLInputElement;

  titleInput = el("input", {
    class: "task-form-input",
    type: "text",
    placeholder: "标题（如：京津冀决赛 · 10.0.0.13 门户打点）",
  });
  briefInput = el("textarea", {
    class: "task-form-input task-form-brief",
    placeholder: "简报（brief）：把靶场地址、账号、授权边界、要拿什么写清楚——这段会注入每个会话的简报包。",
  });
  const categoryOptions = buildTaskCategoryOptions();
  categoryInput = el(
    "select",
    { class: "task-form-input", title: "题型分类（用于任务看板与后续 playbook 路由）" },
    categoryOptions.map((c) =>
      el("option", { value: c.value, selected: c.value === "unknown" ? "" : null }, c.label),
    ),
  ) as HTMLSelectElement;
  priorityInput = el("input", {
    class: "task-form-input",
    type: "number",
    min: "0",
    max: "100",
    step: "1",
    placeholder: "优先级（可选，0–100；越大越靠前）",
    title: "优先级（可选，0–100 的整数）",
  }) as HTMLInputElement;
  const pointsInput = el("input", {
    class: "task-form-input",
    type: "number",
    min: "0",
    max: "1000000",
    step: "1",
    placeholder: "分值 points（可选；策略层优先于 priority）",
    title: "题目分值（可选，0–1000000 的整数；用于战略调度评分）",
  }) as HTMLInputElement;

  // V2-P0-2：答案格式。默认 flag_regex + flag{...}；留空/不改 = 旧行为。
  const ANSWER_MODES: Array<{ value: AnswerSpec["mode"]; label: string }> = [
    { value: "flag_regex", label: "flag 正则（默认）" },
    { value: "typed", label: "typed（IP/时间/hash/路径/进程/账号/命令）" },
    { value: "freeform", label: "freeform（自然语言，仅候选）" },
  ];
  const ANSWER_TYPES: AnswerType[] = [
    "flag",
    "ip",
    "timestamp",
    "hash",
    "path",
    "process",
    "command",
    "account",
    "text",
  ];
  const answerModeInput = el(
    "select",
    { class: "task-form-input", title: "答案模式：flag 正则 / typed 字段 / freeform 自然语言" },
    ANSWER_MODES.map((m) => el("option", { value: m.value }, m.label)),
  ) as HTMLSelectElement;
  const answerTypeInput = el(
    "select",
    { class: "task-form-input", title: "答案类型；typed 模式决定内置检测器" },
    ANSWER_TYPES.map((t) => el("option", { value: t }, t)),
  ) as HTMLSelectElement;
  const answerEvidenceInput = el(
    "select",
    { class: "task-form-input", title: "候选至少达到该证据等级才适合确认；系统仍不自动确认" },
    ["E1", "E0", "E2"].map((e) => el("option", { value: e }, `证据 ≥ ${e}`)),
  ) as HTMLSelectElement;
  const answerPatternInput = el("input", {
    class: "task-form-input",
    type: "text",
    placeholder: "自定义正则（可选）例：DASCTF\\{[^}\\s]{3,128}\\}",
    title: "留空 = 默认 flag{...}；有捕获组时取第 1 组",
  }) as HTMLInputElement;
  const answerTemplateInput = el("input", {
    class: "task-form-input",
    type: "text",
    placeholder: "导出模板（可选）例：${value}",
    title: "支持 ${value} ${answerType} ${taskTitle} ${candidateId}",
  }) as HTMLInputElement;

  const answerSpecHint = el(
    "div",
    { class: "task-status-hint", "data-answer-spec-hint": "1" },
    "默认只识别 flag{...}。比赛用 DASCTF{}/ctfshow{}/UUID/hash/IR 答题卡时，在这里改成对应模式；候选仍需人工确认。",
  );
  answerModeInput.addEventListener("change", () => {
    if (answerModeInput.value === "typed" && answerTypeInput.value === "flag") {
      answerTypeInput.value = "text";
    }
    if (answerModeInput.value === "flag_regex") answerTypeInput.value = "flag";
  });

  function buildAnswerSpec(): AnswerSpec | null {
    const mode = answerModeInput.value as AnswerSpec["mode"];
    const answerType = answerTypeInput.value as AnswerType;
    const pattern = answerPatternInput.value.trim();
    const requiredEvidence = answerEvidenceInput.value as "E0" | "E1" | "E2";
    const template = answerTemplateInput.value.trim();
    const changed =
      mode !== "flag_regex" || answerType !== "flag" || pattern !== "" || requiredEvidence !== "E1" || template !== "";
    if (!changed) return null;
    const spec: AnswerSpec = { mode, answerType, requiredEvidence, normalizers: ["trim"] };
    if (pattern) spec.pattern = pattern;
    if (template) spec.exportTemplate = template;
    return spec;
  }

  // P3-C：附件选择。一次只允许一种来源类型；任务先创建，再导入附件。
  const attachmentState: AttachmentSelectionState = {
    kind: null,
    paths: [],
    importing: false,
    error: null,
  };
  let taskCreated = false;

  const attachStatus = el("div", { class: "task-attachment-status" });
  const attachButtons: HTMLButtonElement[] = [];

  function renderAttachmentStatus(): void {
    const view = buildAttachmentSelectionView(attachmentState);
    attachStatus.textContent = view.importingText
      ? view.importingText
      : view.error
        ? `附件：${view.error}`
        : view.count > 0
          ? `已选择 ${view.count} 个${view.kindLabel}：${view.pathsText}`
          : "可选：文件 / 文件夹 / ZIP（三选一；导入失败不会回滚已创建的任务）";
    for (const b of attachButtons) b.disabled = attachmentState.importing || taskCreated;
    confirmBtn.disabled = attachmentState.importing || taskCreated;
  }

  async function pick(kind: AttachmentPickKind): Promise<void> {
    if (attachmentState.importing || taskCreated) return;
    if (typeof ctx.hub.pickAttachments !== "function") {
      attachmentState.error = "当前环境不支持系统文件选择（需要 Electron 主进程）";
      renderAttachmentStatus();
      notify(attachmentState.error, "error");
      return;
    }
    try {
      const res = await ctx.hub.pickAttachments(kind);
      if (res.canceled) return;
      if (res.error) {
        attachmentState.error = res.error;
        renderAttachmentStatus();
        notify(`选择附件失败：${res.error}`, "error");
        return;
      }
      const paths = res.paths.filter((p) => typeof p === "string" && p.trim().length > 0);
      if (paths.length === 0) return;
      attachmentState.kind = kind;
      attachmentState.paths = paths;
      attachmentState.error = null;
      renderAttachmentStatus();
    } catch (err) {
      attachmentState.error = (err as Error).message ?? String(err);
      renderAttachmentStatus();
      notify(`选择附件失败：${attachmentState.error}`, "error");
    }
  }

  async function create(): Promise<void> {
    if (attachmentState.importing || taskCreated) return;
    const title = titleInput.value.trim();
    const brief = briefInput.value.trim();
    if (!title || !brief) {
      notify("标题和简报都不能为空", "error");
      return;
    }
    const priorityParsed = parseTaskPriority(priorityInput.value);
    if (!priorityParsed.ok) {
      notify(priorityParsed.error, "error");
      return;
    }
    const pointsRaw = pointsInput.value.trim();
    let points: number | undefined;
    if (pointsRaw) {
      const n = Number(pointsRaw);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
        notify("分值必须是 0–1000000 的整数", "error");
        return;
      }
      points = n;
    }
    const answerSpec = buildAnswerSpec();
    const pendingPaths = attachmentState.paths.slice();
    attachmentState.importing = true;
    attachmentState.error = null;
    renderAttachmentStatus();
    notify("正在创建任务…", "info");
    try {
      const res = await ctx.hub.dispatch({
        type: "task.create",
        title,
        brief,
        category: normalizeTaskCategory(categoryInput.value),
        priority: priorityParsed.value,
        ...(points !== undefined ? { points } : {}),
        ...(answerSpec ? { answerSpec } : {}),
      });
      if (!res?.ok) {
        attachmentState.importing = false;
        attachmentState.error = `创建任务失败：${res?.error ?? "未知错误"}`;
        renderAttachmentStatus();
        notify(attachmentState.error, "error");
        return;
      }
      taskCreated = true;
      if (pendingPaths.length === 0) {
        close();
        notify("已创建并切为当前焦点（不会停其他任务会话）", "info");
        return;
      }
      // 任务已创建；附件导入失败不回滚任务，也不阻塞用户继续。
      attachmentState.importing = true;
      renderAttachmentStatus();
      notify("任务已创建，正在导入附件…", "info");
      let taskId: string | undefined;
      try {
        const snap = await ctx.hub.snapshot();
        taskId = snap.task?.id;
      } catch {
        /* 焦点兜底：attachment.import 不传 taskId 时由 Hub 用当前焦点 */
      }
      const imported = await ctx.hub.dispatch({
        type: "attachment.import",
        ...(taskId ? { taskId } : {}),
        paths: pendingPaths,
        note: "task.create 附件选择",
      });
      if (imported?.ok) {
        attachmentState.importing = false;
        close();
        notify(imported.message ?? `已创建任务并导入 ${pendingPaths.length} 个附件`, "info");
      } else {
        attachmentState.importing = false;
        attachmentState.error = `任务已创建，但附件导入失败：${imported?.error ?? "未知错误"}；可在右栏工件面板补导入`;
        confirmBtn.textContent = "任务已创建";
        renderAttachmentStatus();
        notify(attachmentState.error, "error");
      }
    } catch (err) {
      attachmentState.importing = false;
      const reason = (err as Error).message ?? String(err);
      attachmentState.error = taskCreated
        ? `任务已创建，但附件导入失败：${reason}；可在右栏工件面板补导入`
        : `创建任务失败：${reason}`;
      if (taskCreated) confirmBtn.textContent = "任务已创建";
      renderAttachmentStatus();
      notify(attachmentState.error, "error");
    }
  }

  const confirmBtn = el("button", { class: "btn btn-approve" }, "创建并切换");
  confirmBtn.addEventListener("click", create);

  const pickFilesBtn = el("button", { class: "btn btn-small", type: "button" }, "选择文件") as HTMLButtonElement;
  const pickFolderBtn = el("button", { class: "btn btn-small", type: "button" }, "选择文件夹") as HTMLButtonElement;
  const pickZipBtn = el("button", { class: "btn btn-small", type: "button" }, "选择 ZIP") as HTMLButtonElement;
  attachButtons.push(pickFilesBtn, pickFolderBtn, pickZipBtn);
  pickFilesBtn.addEventListener("click", () => void pick("files"));
  pickFolderBtn.addEventListener("click", () => void pick("folder"));
  pickZipBtn.addEventListener("click", () => void pick("zip"));

  const currentNote = current
    ? el("div", { class: "task-form-current" }, `当前焦点：${current.title}（新建后切到新任务，不会停其他任务会话）`)
    : null;
  // P2-C：技能库未配置/错误时在弹窗顶部明确提示；只是提示，不禁用「创建并切换」。
  const skillWarning = buildTaskSkillWarning(ctx.store.get());
  const skillWarningNote = skillWarning
    ? el("div", { class: "task-form-current", "data-skill-warning": "1" }, skillWarning)
    : null;

  const overlay = el("div", { class: "task-overlay" });
  const modal = el("div", { class: "task-modal" }, [
    el("h3", { class: "task-modal-title" }, "新建任务（切为当前焦点）"),
    skillWarningNote,
    currentNote,
    el("label", { class: "task-form-label" }, ["标题", titleInput]),
    el("label", { class: "task-form-label" }, ["简报（brief）· 会注入每个会话的简报包", briefInput]),
    el("div", { class: "task-form-row" }, [
      el("label", { class: "task-form-label task-form-half" }, ["题型 category", categoryInput]),
      el("label", { class: "task-form-label task-form-half" }, ["优先级 priority", priorityInput]),
    ]),
    el("div", { class: "task-form-row" }, [
      el("label", { class: "task-form-label task-form-half" }, ["分值 points（策略评分用）", pointsInput]),
      el("label", { class: "task-form-label task-form-half" }, ["答案模式 answerSpec.mode", answerModeInput]),
    ]),
    el("div", { class: "task-form-row" }, [
      el("label", { class: "task-form-label task-form-half" }, ["答案类型 answerSpec.answerType", answerTypeInput]),
      el("label", { class: "task-form-label task-form-half" }, ["证据要求 requiredEvidence", answerEvidenceInput]),
    ]),
    el("div", { class: "task-form-row" }, [
      el("label", { class: "task-form-label task-form-half" }, ["自定义正则 pattern（可选）", answerPatternInput]),
      el("label", { class: "task-form-label task-form-half" }, ["导出模板 exportTemplate（可选）", answerTemplateInput]),
    ]),
    answerSpecHint,
    el("div", { class: "task-form-label task-attachment-field" }, [
      "附件（可选）· 文件 / 文件夹 / ZIP",
      el("div", { class: "task-attachment-picker" }, [pickFilesBtn, pickFolderBtn, pickZipBtn]),
      attachStatus,
    ]),
    el("div", { class: "task-form-actions" }, [confirmBtn, el("button", { class: "btn btn-cancel" }, "取消")]),
  ]);
  renderAttachmentStatus();

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  modal.querySelector(".btn-cancel")?.addEventListener("click", close);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  titleInput.focus();
}

/**
 * R19：切换任务。
 *
 * R17 之前任务数据一直落在库里，但界面只有「新建任务（替换当前）」、没有「切回
 * 旧任务」的入口。P1-B 起 `task.switch` 只切焦点、不停会话；这里列出非归档任务，
 * 点一个派发 `task.switch`，快照随 `task.upsert` 重拉。
 */
export function openTaskSwitchModal(ctx: UiCtx): void {
  const currentId = ctx.store.get().task?.id;
  const tasks = (ctx.store.get().tasks ?? []).filter((t) => t.archived !== true);

  const overlay = el("div", { class: "task-overlay" });
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  const switchTo = (t: TaskView): void => {
    if (t.id === currentId) return;
    notify("正在切换任务…", "info");
    close();
    void ctx.hub.dispatch({ type: "task.switch", taskId: t.id }).then((res) => {
      if (!res?.ok) notify(`切换任务失败：${res?.error ?? "未知错误"}`, "error");
      else notify(`已切换到：${t.title}`, "info");
    });
  };

  const rows = tasks.map((t) => {
    const isCurrent = t.id === currentId;
    const row = el(
      "button",
      {
        class: `task-switch-item${isCurrent ? " task-switch-current" : ""}`,
        type: "button",
        disabled: isCurrent ? "" : null,
        title: isCurrent ? "当前任务" : `切换到「${t.title}」`,
      },
      [
        el("span", { class: "task-switch-title" }, t.title),
        el("span", { class: `task-status-badge task-status-${t.status}` }, taskStatusLabel(t.status)),
        isCurrent ? el("span", { class: "task-switch-current-tag" }, "当前") : null,
      ],
    );
    if (!isCurrent) row.addEventListener("click", () => switchTo(t));
    return el("li", { class: "task-switch-li" }, [row]);
  });

  const modal = el("div", { class: "task-modal" }, [
    el("h3", { class: "task-modal-title" }, "切换任务"),
    tasks.length > 0
      ? el("ul", { class: "task-switch-list" }, rows)
      : el("div", { class: "task-form-current" }, "还没有其他任务，点「＋ 新任务」新建。"),
    el("div", { class: "task-form-actions" }, [el("button", { class: "btn btn-cancel" }, "取消")]),
  ]);

  modal.querySelector(".btn-cancel")?.addEventListener("click", close);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

/**
 * R16：人工确认任务状态（解出 / 待解）。
 *
 * 为什么不自动把「检测到 flag{...}」写成 solved：模型会幻觉，工具输出也会出现
 * 示例 flag。自动识别只把候选显示出来，最终由人点这一下确认。
 */
export function openTaskStatusModal(ctx: UiCtx, task: TaskView): void {
  const input = el("input", {
    class: "task-form-input",
    type: "text",
    placeholder: "flag / 答案（可留空）",
    value: task.answer ?? task.flagCandidate ?? "",
  }) as HTMLInputElement;

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const setStatus = (status: "solved" | "open" | "abandoned"): void => {
    const answer = input.value.trim();
    if (status === "solved" && !answer && !task.flagCandidate) {
      notify("先填写 flag / 答案，或让 agent 先识别出候选", "error");
      return;
    }
    close();
    void ctx.hub
      .dispatch({
        type: "task.setStatus",
        taskId: task.id,
        status,
        answer: status === "solved" ? answer || task.flagCandidate || undefined : undefined,
      })
      .then((res) => {
        if (!res?.ok) notify(`更新任务状态失败：${res?.error ?? "未知错误"}`, "error");
        else notify(status === "solved" ? "已标记为解出" : status === "abandoned" ? "已标记为放弃" : "已改回待解", "info");
      });
  };

  const solveBtn = el("button", { class: "btn btn-approve" }, "标记已解出");
  solveBtn.addEventListener("click", () => setStatus("solved"));
  const abandonBtn = el("button", { class: "btn btn-cancel" }, "标记已放弃");
  abandonBtn.addEventListener("click", () => setStatus("abandoned"));
  const reopenBtn = el("button", { class: "btn btn-cancel" }, "改回待解");
  reopenBtn.addEventListener("click", () => setStatus("open"));
  const cancelBtn = el("button", { class: "btn btn-cancel" }, "取消");
  cancelBtn.addEventListener("click", close);

  const candidateNote = task.flagCandidate
    ? el("div", { class: "task-form-current" }, `自动识别到的候选：${task.flagCandidate}`)
    : null;

  const overlay = el("div", { class: "task-overlay" });
  const modal = el("div", { class: "task-modal" }, [
    el("h3", { class: "task-modal-title" }, "任务状态"),
    el("div", { class: "task-form-current" }, `${task.title} · 当前：${taskStatusLabel(task.status)}`),
    candidateNote,
    el("label", { class: "task-form-label" }, ["flag / 答案（放弃 / 待解可留空）", input]),
    el("div", { class: "task-form-actions" }, [reopenBtn, abandonBtn, cancelBtn, solveBtn]),
  ]);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
