/**
 * P5-C 批次 2：flag 面板。
 *
 * 职责：
 *  - `buildFlagPanelView(state)` 纯视图模型（smoke 直接验证）；
 *  - `createFlagsPanel(container, ctx)` 右栏 DOM 面板：候选列表、确认/误报、导出。
 *
 * 边界：
 *  - 确认/误报只对 `status=new` 显示按钮；confirmed / false_positive 不显示，避免误操作；
 *  - 确认/误报前走 `openConfirmModal` 二次确认；
 *  - 导出调 `flag.export` 拿 `ActionResult.content`，**不写文件**；当前 IPC 没有保存
 *    对话框能力，所以弹窗展示内容 + 复制按钮，由用户自行保存；
 *  - 不做提交入口（P5-D）。
 */
import type { FlagCandidateView } from "./contract.ts";
import type { AppState } from "./store.ts";
import { applySnapshot } from "./store.ts";
import type { UiCtx } from "./ctx.ts";
import { el, clear } from "./dom.ts";
import { notify } from "./notice.ts";
import { openConfirmModal } from "./task.ts";

export type FlagExportFormat = "md" | "csv" | "json";

export const FLAG_EXPORT_FORMATS: readonly FlagExportFormat[] = ["md", "csv", "json"];

export type FlagPanelKind = "no-task" | "unknown" | "empty" | "ready";

export interface FlagPanelSourceView {
  sessionId: string | null;
  witness: string | null;
  evidence: string;
  seenAt: number;
  text: string;
}

export interface FlagPanelCandidateView {
  id: string;
  taskId: string;
  value: string;
  status: "new" | "confirmed" | "false_positive";
  statusLabel: string;
  evidence: string;
  firstSeen: number;
  firstSeenText: string;
  sources: FlagPanelSourceView[];
  /** 只对 status=new 为 true（批次 2 的按钮可见性规则）。 */
  canConfirm: boolean;
  canReject: boolean;
  /** P5-D：new/confirmed 可提交；false_positive 不显示提交入口。 */
  canSubmit: boolean;
  /** P5-D：已记录过人工提交。 */
  isSubmitted: boolean;
  submittedAt: number | null;
  submittedAtText: string | null;
  submitStatus: string | null;
}

export interface FlagPanelView {
  kind: FlagPanelKind;
  taskId: string | null;
  taskTitle: string | null;
  count: number;
  candidates: FlagPanelCandidateView[];
  exportFormats: readonly FlagExportFormat[];
  emptyText: string | null;
  unknownText: string | null;
}

const STATUS_LABEL: Record<FlagCandidateView["status"], string> = {
  new: "待确认",
  confirmed: "已确认",
  false_positive: "误报",
};

/** 固定格式（UTC），避免 smoke 受本机时区/本地化影响。 */
function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function sourceText(s: {
  sessionId: string | null;
  witness: string | null;
  evidence: string;
  seenAt: number;
}): string {
  return `${s.sessionId ?? "system"} · ${s.witness ?? "无 witness"} · ${s.evidence} · ${formatTime(s.seenAt)}`;
}

/**
 * 纯视图模型：不碰 DOM，smoke 可直接调用。
 *
 * `flagsStatus="unknown"` 表示快照没带 flags（旧快照/旧主进程），必须显示「未知」，
 * 不能显示成「无候选」；`flags=[]` + known 才是真正的空列表。
 */
export function buildFlagPanelView(
  state: Pick<AppState, "task" | "flags" | "flagsStatus">,
): FlagPanelView {
  const task = state.task ?? null;
  const rawFlags = Array.isArray(state.flags) ? state.flags : [];
  // 明确 "unknown" 优先于 flags=[]（旧快照的 [] 是占位，不是“真的没有候选”）。
  // flagsStatus 缺席但 flags 是数组的旧调用方按 known 处理。
  const known =
    state.flagsStatus === "known" ||
    (state.flagsStatus === undefined && Array.isArray(state.flags));
  const candidates: FlagPanelCandidateView[] = rawFlags.map((f) => {
    const status: FlagCandidateView["status"] =
      f.status === "confirmed" || f.status === "false_positive" ? f.status : "new";
    const submittedAt = typeof f.submittedAt === "number" && f.submittedAt > 0 ? f.submittedAt : null;
    const submitStatus = f.submitStatus ?? null;
    return {
      id: f.id,
      taskId: f.taskId,
      value: f.value,
      status,
      statusLabel: STATUS_LABEL[status],
      evidence: f.evidence,
      firstSeen: f.firstSeen,
      firstSeenText: formatTime(f.firstSeen),
      sources: (Array.isArray(f.sources) ? f.sources : []).map((s) => ({
        sessionId: s.sessionId ?? null,
        witness: s.witness ?? null,
        evidence: s.evidence,
        seenAt: s.seenAt,
        text: sourceText({
          sessionId: s.sessionId ?? null,
          witness: s.witness ?? null,
          evidence: s.evidence,
          seenAt: s.seenAt,
        }),
      })),
      canConfirm: status === "new",
      canReject: status === "new",
      canSubmit: status === "new" || status === "confirmed",
      isSubmitted: submittedAt !== null,
      submittedAt,
      submittedAtText: submittedAt !== null ? formatTime(submittedAt) : null,
      submitStatus,
    };
  });
  const kind: FlagPanelKind = !task
    ? "no-task"
    : !known
      ? "unknown"
      : candidates.length === 0
        ? "empty"
        : "ready";
  return {
    kind,
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? null,
    count: candidates.length,
    candidates,
    exportFormats: FLAG_EXPORT_FORMATS,
    emptyText:
      kind === "empty"
        ? "当前焦点任务还没有 flag 候选；agent 命中 flag{...} 或 submit_fact 后会出现在这里。"
        : null,
    unknownText:
      kind === "unknown"
        ? "候选状态未知（旧快照未带 flags 字段）；等待主进程快照或切回任务后重试。"
        : null,
  };
}

async function refreshSnapshot(ctx: UiCtx): Promise<void> {
  try {
    const snap = await ctx.hub.snapshot();
    ctx.store.set(applySnapshot(snap, ctx.store.get()));
  } catch {
    /* 快照失败时保留现有 store；flag.updated 事件仍可能已更新 */
  }
}

export function openExportModal(
  content: string,
  format: FlagExportFormat,
  opts: { title?: string; note?: string } = {},
): void {
  const overlay = el("div", { class: "task-overlay" });
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const textarea = el("textarea", {
    class: "task-form-input task-form-brief",
    readonly: "",
    spellcheck: "false",
    "data-flag-export-format": format,
    "data-export-format": format,
  }) as HTMLTextAreaElement;
  textarea.value = content;
  const copyBtn = el("button", { class: "btn btn-approve", type: "button" }, "复制");
  const closeBtn = el("button", { class: "btn btn-cancel", type: "button" }, "关闭");
  copyBtn.addEventListener("click", () => {
    const done = (): void => notify("已复制导出内容；未写文件", "info");
    textarea.select();
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard?.writeText) {
      void clipboard.writeText(content).then(done).catch(() => {
        try {
          document.execCommand("copy");
          done();
        } catch {
          notify("复制失败；请手动选择文本复制", "error");
        }
      });
      return;
    }
    try {
      document.execCommand("copy");
      done();
    } catch {
      notify("复制失败；请手动选择文本复制", "error");
    }
  });
  closeBtn.addEventListener("click", close);
  const modal = el("div", { class: "task-modal" }, [
    el("h3", { class: "task-modal-title" }, opts.title ?? `导出 flag 候选（${format}）`),
    el(
      "div",
      { class: "task-form-current" },
      opts.note ?? "主进程只返回内容，没有写文件；请复制后自行保存。导出内容含 flag 明文。",
    ),
    textarea,
    el("div", { class: "task-form-actions" }, [closeBtn, copyBtn]),
  ]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  textarea.focus();
  textarea.select();
}

/**
 * P5-D：提交弹窗（manual + 可选 dry-run 预览）。
 *
 * - manual：显示 flag 值 + 复制；用户到平台手动提交后点「我已提交」才调
 *   `flag.submit`（mode 缺省 manual）记录 submitted_at；不自动提交、不调平台 API。
 * - 预览 argv：调 `flag.submit(mode=dry_run)` 只看 argv；**没有执行按钮**。
 */
function openSubmitModal(ctx: UiCtx, view: FlagPanelView, candidate: FlagPanelCandidateView): void {
  const taskId = view.taskId;
  if (!taskId) return;
  const overlay = el("div", { class: "task-overlay" });
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  const flagInput = el("input", {
    class: "task-form-input",
    type: "text",
    readonly: "",
    "data-flag-submit-value": candidate.id,
  }) as HTMLInputElement;
  flagInput.value = candidate.value;
  const copyBtn = el(
    "button",
    { class: "btn btn-small", type: "button", "data-act": "flag-copy" },
    "复制 flag",
  );
  copyBtn.addEventListener("click", () => {
    flagInput.select();
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    const done = (): void => notify("已复制 flag；请到平台手动提交", "info");
    if (clipboard?.writeText) {
      void clipboard.writeText(candidate.value).then(done).catch(() => {
        try {
          document.execCommand("copy");
          done();
        } catch {
          notify("复制失败；请手动选择文本复制", "error");
        }
      });
      return;
    }
    try {
      document.execCommand("copy");
      done();
    } catch {
      notify("复制失败；请手动选择文本复制", "error");
    }
  });

  const statusLine = el(
    "div",
    { class: "task-form-current", "data-flag-submit-status": candidate.id },
    candidate.isSubmitted
      ? `已提交：${candidate.submittedAtText}（${candidate.submitStatus ?? "manual"}）`
      : "未提交",
  );
  const submitBtn = el(
    "button",
    { class: "btn btn-approve", type: "button", "data-act": "flag-submit-confirm" },
    "我已提交",
  );
  let submitting = false;
  submitBtn.addEventListener("click", () => {
    if (submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    void (async () => {
      try {
        const res = await ctx.hub.dispatch({
          type: "flag.submit",
          taskId,
          candidateId: candidate.id,
        });
        if (!res?.ok) {
          statusLine.textContent = `记录失败：${res?.error ?? "未知错误"}`;
          submitBtn.disabled = false;
          return;
        }
        statusLine.textContent = "已记录（manual，请到平台提交）";
        await refreshSnapshot(ctx);
      } catch (err) {
        statusLine.textContent = `记录失败：${(err as Error).message ?? String(err)}`;
        submitBtn.disabled = false;
      } finally {
        submitting = false;
      }
    })();
  });

  const manualBox = el("div", { class: "flag-submit-manual" }, [
    el(
      "div",
      { class: "artifact-meta" },
      "本应用不会自动提交、不会调用平台 API；复制 flag 到比赛平台手动提交后，点「我已提交」记录时间。",
    ),
    el("div", { class: "flag-submit-value" }, [flagInput, copyBtn]),
    statusLine,
    el("div", { class: "task-form-actions" }, [submitBtn]),
  ]);

  const previewBody = el(
    "div",
    { class: "task-form-current", "data-flag-preview": candidate.id },
    "切到「预览 argv」后显示；只预览，不执行。",
  );
  let previewLoaded = false;
  async function loadPreview(): Promise<void> {
    if (previewLoaded) return;
    previewLoaded = true;
    previewBody.textContent = "正在生成 argv 预览…";
    try {
      const res = await ctx.hub.dispatch({
        type: "flag.submit",
        taskId,
        candidateId: candidate.id,
        mode: "dry_run",
      });
      if (!res?.ok) {
        previewBody.textContent = `预览失败：${res?.error ?? "未知错误"}`;
        previewLoaded = false;
        return;
      }
      previewBody.textContent = `argv（预览，不执行）：${JSON.stringify(res.argv ?? [])}`;
    } catch (err) {
      previewBody.textContent = `预览失败：${(err as Error).message ?? String(err)}`;
      previewLoaded = false;
    }
  }
  const previewBox = el("div", { class: "flag-submit-preview" }, [
    el("div", { class: "artifact-meta" }, "这是预览，不执行；没有「执行」按钮。"),
    previewBody,
  ]);

  let activeTab: "manual" | "dry_run" = "manual";
  const manualTab = el(
    "button",
    { class: "btn btn-small", type: "button", "data-act": "flag-submit-tab-manual" },
    "manual 提交",
  );
  const previewTab = el(
    "button",
    { class: "btn btn-small", type: "button", "data-act": "flag-submit-tab-preview" },
    "预览 argv",
  );
  const tabBody = el("div", { class: "flag-submit-tab-body" });
  function renderTab(): void {
    manualTab.disabled = activeTab === "manual";
    previewTab.disabled = activeTab === "dry_run";
    clear(tabBody);
    if (activeTab === "manual") {
      tabBody.appendChild(manualBox);
      return;
    }
    tabBody.appendChild(previewBox);
    void loadPreview();
  }
  manualTab.addEventListener("click", () => {
    activeTab = "manual";
    renderTab();
  });
  previewTab.addEventListener("click", () => {
    activeTab = "dry_run";
    renderTab();
  });

  const closeBtn = el("button", { class: "btn btn-cancel", type: "button" }, "关闭");
  closeBtn.addEventListener("click", close);
  const modal = el("div", { class: "task-modal", "data-flag-submit-modal": candidate.id }, [
    el("h3", { class: "task-modal-title" }, "提交 flag（manual）"),
    el("div", { class: "task-form-current" }, `任务：${view.taskTitle ?? taskId}`),
    el("div", { class: "task-form-actions" }, [manualTab, previewTab]),
    tabBody,
    el("div", { class: "task-form-actions" }, [closeBtn]),
  ]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  renderTab();
  flagInput.focus();
  flagInput.select();
}

export function createFlagsPanel(container: HTMLElement, ctx: UiCtx): { dispose(): void } {
  const hint = el("div", { class: "artifact-panel-hint" }, "人工确认/误报/记录提交；不自动提交、不调平台 API");
  const body = el("div", { class: "artifact-panel-body flag-panel-body" });
  const exportButtons = FLAG_EXPORT_FORMATS.map((format) => {
    const btn = el(
      "button",
      {
        class: "btn btn-small",
        type: "button",
        "data-flag-export": format,
        title: `导出焦点任务的候选（${format}），不写文件`,
      },
      `导出 ${format}`,
    );
    btn.addEventListener("click", () => void exportFlags(format));
    return btn;
  });
  container.append(
    el("div", { class: "artifact-panel-tools" }, [hint]),
    el("div", { class: "artifact-import-row" }, [
      el("span", { class: "artifact-panel-hint" }, "导出："),
      ...exportButtons,
    ]),
    body,
  );

  async function confirmCandidate(
    taskId: string,
    candidate: FlagPanelCandidateView,
    taskTitle: string | null,
  ): Promise<void> {
    openConfirmModal({
      title: "确认 flag 候选",
      lines: [
        `任务：${taskTitle ?? taskId}`,
        `候选：${candidate.value}`,
        "确认后任务标记为已解出（answer=候选值）；不会自动提交。",
      ],
      confirmText: "确认并标记已解出",
      onConfirm: () => {
        void (async () => {
          try {
            const res = await ctx.hub.dispatch({
              type: "flag.confirm",
              taskId,
              candidateId: candidate.id,
            });
            if (!res?.ok) notify(`确认失败：${res?.error ?? "未知错误"}`, "error");
            else notify(res.message ?? "已确认 flag 候选", "info");
          } catch (err) {
            notify(`确认失败：${(err as Error).message ?? String(err)}`, "error");
          } finally {
            await refreshSnapshot(ctx);
          }
        })();
      },
    });
  }

  function rejectCandidate(
    taskId: string,
    candidate: FlagPanelCandidateView,
    taskTitle: string | null,
  ): void {
    openConfirmModal({
      title: "标记 flag 候选为误报",
      lines: [
        `任务：${taskTitle ?? taskId}`,
        `候选：${candidate.value}`,
        "只标记误报；不会修改任务答案/状态；候选保留审计。",
      ],
      confirmText: "标记误报",
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const res = await ctx.hub.dispatch({
              type: "flag.reject",
              taskId,
              candidateId: candidate.id,
            });
            if (!res?.ok) notify(`标记误报失败：${res?.error ?? "未知错误"}`, "error");
            else notify(res.message ?? "已标记为误报", "info");
          } catch (err) {
            notify(`标记误报失败：${(err as Error).message ?? String(err)}`, "error");
          } finally {
            await refreshSnapshot(ctx);
          }
        })();
      },
    });
  }

  async function exportFlags(format: FlagExportFormat): Promise<void> {
    const taskId = ctx.store.get().task?.id;
    if (!taskId) {
      notify("没有活动任务，无法导出", "error");
      return;
    }
    try {
      const res = await ctx.hub.dispatch({ type: "flag.export", taskId, format });
      if (!res?.ok) {
        notify(`导出失败：${res?.error ?? "未知错误"}`, "error");
        return;
      }
      if (typeof res.content !== "string") {
        notify("后端没有返回导出内容（旧主进程？）", "error");
        return;
      }
      openExportModal(res.content, format);
    } catch (err) {
      notify(`导出失败：${(err as Error).message ?? String(err)}`, "error");
    }
  }

  function renderCandidate(candidate: FlagPanelCandidateView, view: FlagPanelView): HTMLElement {
    const actions = el("div", { class: "artifact-actions" });
    if (candidate.canConfirm) {
      const confirmBtn = el(
        "button",
        { class: "btn btn-small btn-approve", type: "button", "data-act": "flag-confirm" },
        "确认",
      );
      confirmBtn.addEventListener("click", () => {
        if (view.taskId) void confirmCandidate(view.taskId, candidate, view.taskTitle);
      });
      actions.appendChild(confirmBtn);
    }
    if (candidate.canReject) {
      const rejectBtn = el(
        "button",
        { class: "btn btn-small btn-deny", type: "button", "data-act": "flag-reject" },
        "误报",
      );
      rejectBtn.addEventListener("click", () => {
        if (view.taskId) rejectCandidate(view.taskId, candidate, view.taskTitle);
      });
      actions.appendChild(rejectBtn);
    }
    if (!candidate.canConfirm && !candidate.canReject) {
      actions.appendChild(
        el(
          "span",
          { class: "artifact-panel-hint", title: "已处理；不再显示确认/误报按钮" },
          candidate.status === "confirmed" ? "已确认" : "已标记误报",
        ),
      );
    }
    if (candidate.canSubmit) {
      const submitBtn = el(
        "button",
        { class: "btn btn-small", type: "button", "data-act": "flag-submit" },
        candidate.isSubmitted ? "重新记录提交" : "提交（manual）",
      );
      submitBtn.addEventListener("click", () => {
        if (view.taskId) openSubmitModal(ctx, view, candidate);
      });
      actions.appendChild(submitBtn);
    }
    const sources = el("div", { class: "flag-sources" });
    if (candidate.sources.length === 0) {
      sources.appendChild(el("div", { class: "artifact-meta" }, "无来源记录"));
    } else {
      for (const s of candidate.sources) {
        sources.appendChild(el("div", { class: "artifact-meta", title: s.text }, `来源：${s.text}`));
      }
    }
    return el(
      "li",
      {
        class: `artifact-item flag-item flag-item-${candidate.status}`,
        "data-flag-id": candidate.id,
        "data-flag-status": candidate.status,
      },
      [
        el("div", { class: "artifact-item-head" }, [
          el("span", { class: `badge flag-status-badge flag-status-${candidate.status}` }, candidate.statusLabel),
          el("span", { class: "artifact-name flag-value", title: candidate.value }, [
            el("code", {}, candidate.value),
          ]),
        ]),
        el(
          "div",
          { class: "artifact-meta" },
          `证据 ${candidate.evidence} · 首次 ${candidate.firstSeenText} · ${candidate.sources.length} 个来源`,
        ),
        el(
          "div",
          {
            class: "artifact-meta",
            "data-flag-submit-state": candidate.status,
            "data-flag-submitted": candidate.isSubmitted ? "1" : "0",
          },
          candidate.isSubmitted
            ? `已提交：${candidate.submittedAtText}（${candidate.submitStatus ?? "manual"}）`
            : "未提交",
        ),
        sources,
        actions,
      ],
    );
  }

  function render(): void {
    clear(body);
    const view = buildFlagPanelView(ctx.store.get());
    for (const b of exportButtons) b.disabled = !view.taskId;
    if (view.kind === "no-task") {
      body.appendChild(el("div", { class: "artifact-empty" }, "暂无任务；创建任务后可查看 flag 候选。"));
      return;
    }
    if (view.kind === "unknown") {
      body.appendChild(el("div", { class: "artifact-empty" }, view.unknownText ?? "候选状态未知"));
      return;
    }
    if (view.kind === "empty") {
      body.appendChild(el("div", { class: "artifact-empty" }, view.emptyText ?? "当前任务还没有 flag 候选"));
      return;
    }
    body.appendChild(
      el(
        "div",
        { class: "artifact-section-title", "data-flag-count": String(view.count) },
        `候选（${view.count}）· 焦点任务「${view.taskTitle ?? view.taskId ?? "?"}」`,
      ),
    );
    const list = el("ul", { class: "artifact-list flag-list" });
    for (const candidate of view.candidates) list.appendChild(renderCandidate(candidate, view));
    body.appendChild(list);
  }

  const unsubscribe = ctx.store.subscribeWorkspace(render);
  render();
  return { dispose: unsubscribe };
}
