/**
 * WP9-B2：IR 只读面板。
 *
 * 只读渲染 HubSnapshot.ir（category=ir）：证据板、时间线、问题答题卡。
 * 复用附件/工件；不新增 Hub action、不自动解析日志/内存/PCAP、不接平台。
 * IR 答题卡不做固定问题模板/平台导出格式（用户决定）。
 */
import type { IrView } from "../contract.ts";
import type { AppState } from "../store.ts";
import { el } from "../dom.ts";
import type { UiCtx } from "../ctx.ts";
import { openExportModal } from "../flags.ts";
import { notify } from "../notice.ts";

type ExportFormat = "md" | "csv" | "json";
const EXPORT_FORMATS: readonly ExportFormat[] = ["md", "csv", "json"];

async function exportIrPanel(ctx: UiCtx, format: ExportFormat): Promise<void> {
  const taskId = ctx.store.get().task?.id;
  if (!taskId) {
    notify("没有活动任务，无法导出", "error");
    return;
  }
  try {
    const res = await ctx.hub.dispatch({ type: "ir.export", taskId, format });
    if (!res?.ok) {
      notify(`导出失败：${res?.error ?? "未知错误"}`, "error");
      return;
    }
    if (typeof res.content !== "string") {
      notify("后端没有返回导出内容（旧主进程？）", "error");
      return;
    }
    openExportModal(res.content, format, {
      title: `导出 IR（${format}）`,
      note: "主进程只返回内容，没有写文件；请复制后自行保存。不固定问题模板、不接平台。",
    });
  } catch (err) {
    notify(`导出失败：${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

export interface IrPanelModel {
  evidenceRows: string[];
  timelineRows: string[];
  questionRows: string[];
  analysisRows: string[];
  warnings: string[];
}

function fmtAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "时间未知";
  try {
    return new Date(at).toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return String(at);
  }
}

export function irVisible(state: Pick<AppState, "task" | "ir">): boolean {
  return state.task?.category === "ir" && Boolean(state.ir);
}

/** 纯视图模型：smoke 可直接断言；DOM 只负责把行渲染成节点。 */
export function buildIrPanelModel(view: IrView): IrPanelModel {
  return {
    evidenceRows: view.evidence.map((e) =>
      [
        e.kind,
        e.path,
        e.evidence,
        e.sha256 ? `sha256 ${e.sha256.slice(0, 12)}…` : null,
        e.witness ? `witness ${e.witness}` : null,
        e.source,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    timelineRows: view.timeline.map((t) =>
      [fmtAt(t.at), t.source, t.event, t.impact ? `影响 ${t.impact}` : null, t.evidence ?? null]
        .filter(Boolean)
        .join(" · "),
    ),
    questionRows: view.questions.map((q) => {
      const candidates = (q.candidates ?? [])
        .filter((c) => c.value)
        .map((c) => `${c.value}${c.confidence ? `（${Math.round(c.confidence * 100)}%）` : ""}`)
        .join(" / ");
      const gaps = [...new Set([...(q.gaps ?? []), ...(q.candidates ?? []).flatMap((c) => c.gaps ?? [])])];
      return [
        q.question,
        q.status,
        q.answer ? `已答 ${q.answer}` : "未确认",
        candidates ? `候选 ${candidates}` : null,
        gaps.length ? `缺口 ${gaps.slice(0, 2).join("；")}` : null,
        q.evidence ? `证据 ${q.evidence}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }),
    analysisRows: (view.analysis ?? []).map((a) =>
      [
        a.analyzerId,
        a.input,
        `事实 ${a.facts}`,
        `时间线 ${a.timeline}`,
        `IOC ${a.iocs}`,
        a.tools.length ? `工具 ${a.tools.map((t) => `${t.tool}:${t.ok ? "ok" : t.timedOut ? "timeout" : "fail"}`).join(",")}` : null,
        a.warnings.length ? `告警 ${a.warnings.length}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    warnings: view.warnings ?? [],
  };
}

function listBlock(title: string, rows: string[], empty: string): HTMLElement {
  const list = el("ul", { class: "ir-list" });
  if (rows.length === 0) {
    list.appendChild(el("li", { class: "ir-empty" }, empty));
  } else {
    for (const row of rows) list.appendChild(el("li", { class: "ir-row" }, row));
  }
  return el("section", { class: "ir-section" }, [
    el("div", { class: "ir-subtitle" }, title),
    list,
  ]);
}

export function createIrPanel(host: HTMLElement, ctx: UiCtx): void {
  const body = el("div", { class: "panel-body" });
  const analyzeBtn = el(
    "button",
    { class: "btn btn-small", type: "button", "data-ir-analyze": "1", title: "分析 attachments/evidence/artifacts；只产生证据/候选，不确认、不提交" },
    "分析附件/工件",
  ) as HTMLButtonElement;
  const questionsInput = el("textarea", {
    class: "ir-questions-input",
    placeholder: "问题清单：每行一个问题，或 JSON 数组。例：\n攻击者 IP 是什么？\nWebshell 路径？",
    title: "导入后写 ir.question 事实；分析时生成候选答案",
  }) as HTMLTextAreaElement;
  const importBtn = el(
    "button",
    { class: "btn btn-small", type: "button", "data-ir-questions-import": "1", title: "导入问题清单（不自动回答/提交）" },
    "导入问题",
  ) as HTMLButtonElement;
  const actionRow = el("div", { class: "ir-action-row" }, [analyzeBtn, importBtn]);
  const confirmHint = el(
    "div",
    { class: "task-status-hint" },
    "候选只到 E1，需人工确认；确认/导出在 Flag 候选面板；导出不自动提交。",
  );
  const exportRow = el("div", { class: "export-row" }, [
    el("span", { class: "export-label" }, "导出："),
    ...EXPORT_FORMATS.map((format) => {
      const btn = el(
        "button",
        { class: "btn export-btn", type: "button", "data-ir-export": format, title: `导出 IR ${format}（只返回内容，不写文件）` },
        format,
      );
      btn.addEventListener("click", () => void exportIrPanel(ctx, format));
      return btn;
    }),
  ]);
  const section = el("section", { class: "panel ir-panel" }, [
    el("h2", { class: "panel-title" }, "IR（证据 / 分析）"),
    body,
  ]);
  host.appendChild(section);

  analyzeBtn.addEventListener("click", () => {
    const taskId = ctx.store.get().task?.id;
    if (!taskId) {
      notify("没有活动任务", "error");
      return;
    }
    analyzeBtn.disabled = true;
    notify("正在分析 IR 附件/工件…（大文件/外部工具可能较慢）", "info");
    void ctx.hub
      .dispatch({ type: "ir.analyze", taskId })
      .then((res) => {
        if (!res?.ok) notify(`分析失败：${res?.error ?? "未知错误"}`, "error");
        else notify(res.message ?? "IR 分析完成", "info");
      })
      .catch((err) => notify(`分析失败：${(err as Error).message}`, "error"))
      .finally(() => {
        analyzeBtn.disabled = false;
      });
  });

  importBtn.addEventListener("click", () => {
    const taskId = ctx.store.get().task?.id;
    if (!taskId) {
      notify("没有活动任务", "error");
      return;
    }
    const text = questionsInput.value.trim();
    if (!text) {
      notify("先粘贴问题清单（每行一个或 JSON 数组）", "error");
      return;
    }
    importBtn.disabled = true;
    void ctx.hub
      .dispatch({ type: "ir.questions.import", taskId, text })
      .then((res) => {
        if (!res?.ok) notify(`导入失败：${res?.error ?? "未知错误"}`, "error");
        else {
          questionsInput.value = "";
          notify(res.message ?? "已导入问题清单", "info");
        }
      })
      .catch((err) => notify(`导入失败：${(err as Error).message}`, "error"))
      .finally(() => {
        importBtn.disabled = false;
      });
  });

  const render = (): void => {
    const state = ctx.store.get();
    const show = irVisible(state);
    section.style.display = show ? "" : "none";
    if (!show || !state.ir) return;
    const model = buildIrPanelModel(state.ir);
    body.replaceChildren(
      actionRow,
      confirmHint,
      questionsInput,
      exportRow,
      listBlock("证据板", model.evidenceRows, "暂无证据/附件"),
      listBlock("时间线", model.timelineRows, "暂无时间线"),
      listBlock("问题 / 答题卡", model.questionRows, "暂无问题"),
      listBlock("分析运行", model.analysisRows, "尚未分析（点「分析附件/工件」）"),
    );
    if (model.warnings.length > 0) {
      body.appendChild(listBlock("解析告警", model.warnings, "无"));
    }
  };

  ctx.store.subscribeWorkspace(render);
  render();
}
