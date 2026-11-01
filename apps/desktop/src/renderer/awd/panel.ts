/**
 * WP9-B1：AWD 只读面板。
 *
 * 只读渲染 HubSnapshot.awd（category=awd）；不新增 Hub action、不自动扫描/
 * 利用/开环境、不接平台。开始/结束轮次、补丁/检查/攻击等写入仍走现有黑板/
 * 审批路径（本步不新增按钮）。
 */
import type { AwdView, FlagCandidateView } from "../contract.ts";
import type { AppState } from "../store.ts";
import { el } from "../dom.ts";
import type { UiCtx } from "../ctx.ts";
import { openExportModal } from "../flags.ts";
import { notify } from "../notice.ts";
import { openConfirmModal } from "../task.ts";

type ExportFormat = "md" | "csv" | "json";
const EXPORT_FORMATS: readonly ExportFormat[] = ["md", "csv", "json"];

async function exportAwdPanel(ctx: UiCtx, format: ExportFormat): Promise<void> {
  const taskId = ctx.store.get().task?.id;
  if (!taskId) {
    notify("没有活动任务，无法导出", "error");
    return;
  }
  try {
    const res = await ctx.hub.dispatch({ type: "awd.export", taskId, format });
    if (!res?.ok) {
      notify(`导出失败：${res?.error ?? "未知错误"}`, "error");
      return;
    }
    if (typeof res.content !== "string") {
      notify("后端没有返回导出内容（旧主进程？）", "error");
      return;
    }
    openExportModal(res.content, format, {
      title: `导出 AWD（${format}）`,
      note: "主进程只返回内容，没有写文件；请复制后自行保存。不接平台、不自动提交。",
    });
  } catch (err) {
    notify(`导出失败：${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

export interface AwdPanelModel {
  roundText: string;
  serviceRows: string[];
  flagRows: string[];
  patchRows: string[];
  checkRows: string[];
  attackRows: string[];
  warnings: string[];
}

function fmtRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatAwdRemaining(
  round: AwdView["round"],
  now = Date.now(),
): string {
  if (!round) return "未开始轮次";
  if (round.state === "ended" || (round.endsAt > 0 && round.endsAt <= now)) {
    return `第 ${round.number} 轮 · 已结束`;
  }
  if (round.endsAt <= 0) return `第 ${round.number} 轮 · ${round.state} · 剩余 未知`;
  return `第 ${round.number} 轮 · ${round.state} · 剩余 ${fmtRemaining(round.endsAt - now)}`;
}

export function awdVisible(state: Pick<AppState, "task" | "awd">): boolean {
  return state.task?.category === "awd" && Boolean(state.awd);
}

/** 纯视图模型：smoke 可直接断言；DOM 只负责把行渲染成节点。 */
export function buildAwdPanelModel(view: AwdView, now = Date.now()): AwdPanelModel {
  return {
    roundText: formatAwdRemaining(view.round, now),
    serviceRows: view.services.map((s) =>
      [
        s.name,
        s.target,
        s.status,
        s.ownerSessionId ? `负责 ${s.ownerSessionId}` : "未指派",
        s.patchStatus ? `补丁 ${s.patchStatus}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    flagRows: view.flags.flatMap((g) =>
      g.candidates.map((c) =>
        [
          `第 ${g.round} 轮`,
          c.value,
          c.status,
          c.evidence,
          c.submittedAt != null ? "已提交" : "未提交",
        ].join(" · "),
      ),
    ),
    patchRows: view.patches.map((p) =>
      [`${p.service} / ${p.vuln}`, p.status, p.evidence, p.witness ?? "无 witness"].join(" · "),
    ),
    checkRows: view.checks.map((c) => [`第 ${c.round} 轮`, c.item, c.status, c.evidence ?? "无证据"].join(" · ")),
    attackRows: view.attacks.map((a) =>
      [`${a.attacker} → ${a.target}`, a.action, a.result, a.evidence ?? "无证据"].join(" · "),
    ),
    warnings: view.warnings ?? [],
  };
}

/** 批量 manual 提交只允许 confirmed 且尚未记录提交的候选。 */
export function submittableAwdFlags(view: AwdView): FlagCandidateView[] {
  return view.flags
    .flatMap((g) => g.candidates)
    .filter((c) => c.status === "confirmed" && c.submittedAt == null);
}

async function recordBatch(
  ctx: UiCtx,
  taskId: string,
  selected: FlagCandidateView[],
): Promise<void> {
  let ok = 0;
  let failed = 0;
  let firstError = "";
  for (const c of selected) {
    try {
      const res = await ctx.hub.dispatch({
        type: "flag.submit",
        taskId,
        candidateId: c.id,
        mode: "manual",
      });
      if (res?.ok) ok += 1;
      else {
        failed += 1;
        if (!firstError) firstError = res?.error ?? "未知错误";
      }
    } catch (err) {
      failed += 1;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
    }
  }
  if (failed === 0) {
    notify(`已记录 ${ok} 个 flag 的人工提交时间（未调用平台 API）`, "info");
  } else {
    notify(`已记录 ${ok} 个，失败 ${failed} 个：${firstError}`, "error");
  }
}

function flagBlock(view: AwdView, taskId: string, ctx: UiCtx): HTMLElement {
  const eligible = submittableAwdFlags(view);
  const list = el("ul", { class: "awd-list" });
  if (view.flags.length === 0) {
    list.appendChild(el("li", { class: "awd-empty" }, "暂无 flag 候选"));
  } else {
    for (const group of view.flags) {
      for (const c of group.candidates) {
        const canSubmit = c.status === "confirmed" && c.submittedAt == null;
        const check = el("input", {
          type: "checkbox",
          class: "awd-flag-check",
          "data-awd-flag": c.id,
          title: canSubmit ? "勾选后批量记录 manual 提交" : "只有 confirmed 且未提交的候选可批量记录",
        }) as HTMLInputElement;
        check.disabled = !canSubmit;
        list.appendChild(
          el("li", { class: "awd-flag-row" }, [
            check,
            el(
              "span",
              { class: "awd-flag-text" },
              [
                `第 ${group.round} 轮`,
                c.value,
                c.status,
                c.evidence,
                c.submittedAt != null ? "已提交" : "未提交",
              ].join(" · "),
            ),
          ]),
        );
      }
    }
  }
  const batch = el(
    "button",
    {
      class: "btn export-btn",
      type: "button",
      "data-awd-batch-submit": "1",
      title: "勾选 confirmed 且未提交的候选；一次人工确认后逐条记录 manual 提交（不调平台 API）",
    },
    "批量记录提交（manual）",
  ) as HTMLButtonElement;
  batch.disabled = eligible.length === 0;
  batch.addEventListener("click", () => {
    const section = batch.closest(".awd-section") as HTMLElement | null;
    const checked = section
      ? [...section.querySelectorAll<HTMLInputElement>("input[data-awd-flag]:checked")].map(
          (x) => x.getAttribute("data-awd-flag") ?? "",
        )
      : [];
    const selected = eligible.filter((c) => checked.includes(c.id));
    if (selected.length === 0) {
      notify("先勾选 confirmed 且未提交的候选", "error");
      return;
    }
    openConfirmModal({
      title: "批量记录 flag 提交（manual）",
      lines: [
        `已选 ${selected.length} 个候选（仅记录 submitted_at）：`,
        ...selected.map((c) => `· ${c.value}`),
        "本应用不会调用平台 API、不会自动提交；请先到比赛平台手动提交，再确认记录。",
      ],
      confirmText: "确认记录",
      onConfirm: () => {
        void recordBatch(ctx, taskId, selected);
      },
    });
  });
  return el("section", { class: "awd-section" }, [
    el("div", { class: "awd-subtitle" }, "Flag 轮换"),
    list,
    el("div", { class: "awd-batch-row" }, [batch]),
  ]);
}

function listBlock(title: string, rows: string[], empty: string): HTMLElement {
  const list = el("ul", { class: "awd-list" });
  if (rows.length === 0) {
    list.appendChild(el("li", { class: "awd-empty" }, empty));
  } else {
    for (const row of rows) list.appendChild(el("li", { class: "awd-row" }, row));
  }
  return el("section", { class: "awd-section" }, [
    el("div", { class: "awd-subtitle" }, title),
    list,
  ]);
}

export function createAwdPanel(host: HTMLElement, ctx: UiCtx): void {
  const body = el("div", { class: "panel-body" });
  const exportRow = el("div", { class: "export-row" }, [
    el("span", { class: "export-label" }, "导出："),
    ...EXPORT_FORMATS.map((format) => {
      const btn = el(
        "button",
        { class: "btn export-btn", type: "button", "data-awd-export": format, title: `导出 AWD ${format}（只返回内容，不写文件）` },
        format,
      );
      btn.addEventListener("click", () => void exportAwdPanel(ctx, format));
      return btn;
    }),
  ]);
  const section = el("section", { class: "panel awd-panel" }, [
    el("h2", { class: "panel-title" }, "AWD（只读）"),
    body,
  ]);
  host.appendChild(section);

  const render = (): void => {
    const state = ctx.store.get();
    const show = awdVisible(state);
    section.style.display = show ? "" : "none";
    if (!show || !state.awd) return;
    const taskId = state.task?.id;
    if (!taskId) return;
    const model = buildAwdPanelModel(state.awd);
    const round = el("div", { class: "awd-round" }, model.roundText);
    body.replaceChildren(
      exportRow,
      round,
      listBlock("服务", model.serviceRows, "暂无服务"),
      flagBlock(state.awd, taskId, ctx),
      listBlock("补丁", model.patchRows, "暂无补丁"),
      listBlock("防守检查", model.checkRows, "暂无检查"),
      listBlock("攻击日志", model.attackRows, "暂无攻击记录"),
    );
    if (model.warnings.length > 0) {
      body.appendChild(listBlock("解析告警", model.warnings, "无"));
    }
  };

  ctx.store.subscribeWorkspace(render);
  render();
  // 只刷新轮次倒计时文本；不重建整栏、不发任何 action。
  setInterval(() => {
    const state = ctx.store.get();
    if (!awdVisible(state) || !state.awd) return;
    const node = body.querySelector(".awd-round");
    if (node) node.textContent = formatAwdRemaining(state.awd.round);
  }, 1000);
}
