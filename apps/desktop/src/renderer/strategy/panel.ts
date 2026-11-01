/**
 * V2-P0-3：作战建议面板。
 *
 * 只消费 `HubActionResult.strategyPlan`；不自己算 EV/优先级，也不自己决定开谁。
 * 默认“建议 + 勾选后一键应用”；continue/verify/abandon/reallocate 只展示，不可应用。
 * 不新增“一键自动打全场”按钮；competition-auto 只能通过显式配置/调用开启。
 */

import type {
  StrategyAction,
  StrategyPlanView,
  StrategyRecommendationView,
} from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import { el } from "../dom.ts";
import { notify } from "../notice.ts";

export const STRATEGY_ACTION_LABEL: Record<StrategyAction, string> = {
  continue: "继续",
  start_session: "启动会话",
  stop_session: "停止会话",
  switch_role: "换线",
  verify: "验证",
  abandon: "止损/放弃",
  reallocate: "再分配",
};

export interface StrategyRowView {
  id: string;
  action: StrategyAction;
  actionLabel: string;
  taskTitle: string;
  evText: string;
  confidenceText: string;
  reason: string;
  risk: string;
  doNotText: string;
  applicable: boolean;
  sessionText: string | null;
}

export interface StrategyPanelModel {
  rows: StrategyRowView[];
  noActionRows: string[];
  summary: string;
  limitedBy: string;
  emptyText: string | null;
  applicableCount: number;
}

export function buildStrategyPanelModel(plan: StrategyPlanView | null): StrategyPanelModel {
  if (!plan) {
    return {
      rows: [],
      noActionRows: [],
      summary: "尚未生成建议",
      limitedBy: "",
      emptyText: "点「生成建议」：按分值、优先级、时间、证据、成本和风险给出可解释的作战建议。",
      applicableCount: 0,
    };
  }
  const rows = plan.recommendations.map((r: StrategyRecommendationView) => ({
    id: r.id,
    action: r.action,
    actionLabel: STRATEGY_ACTION_LABEL[r.action] ?? r.action,
    taskTitle: r.taskTitle,
    evText: `EV ${r.expectedValue.toFixed(2)} · 置信 ${Math.round(r.confidence * 100)}%`,
    confidenceText: `成功率 ${r.score.successProbability.toFixed(2)} · 证据 ${r.score.marginalEvidence.toFixed(2)} · 时间 ${r.score.timeCostMinutes}分 · 成本 ${r.score.costWeight}`,
    reason: r.reason,
    risk: r.risk,
    doNotText: r.doNot.length ? `不要：${r.doNot.join("；")}` : "",
    applicable: r.applicable,
    sessionText: r.sessionId ? `${r.sessionId}${r.role ? ` · ${r.role}` : ""}${r.tier ? ` · ${r.tier}` : ""}` : r.role ? `${r.role}${r.tier ? ` · ${r.tier}` : ""}` : null,
  }));
  return {
    rows,
    noActionRows: plan.noAction.map((n) => `${n.taskTitle}：${n.reason}`),
    summary: plan.summary,
    limitedBy: plan.limitedBy.length ? `受限：${plan.limitedBy.join("、")}` : "",
    emptyText: plan.recommendations.length === 0 ? "当前没有可执行建议；看下方“现在不做”的原因。" : null,
    applicableCount: rows.filter((r) => r.applicable).length,
  };
}

export function createStrategyPanel(host: HTMLElement, ctx: UiCtx): void {
  let plan: StrategyPlanView | null = null;
  const selected = new Set<string>();
  const section = el("section", { class: "panel strategy-panel" });
  const header = el("div", { class: "strategy-header" }, [
    el("h2", { class: "panel-title" }, "作战建议"),
    el("button", { class: "btn btn-small", type: "button", "data-act": "strategy-plan" }, "生成建议"),
  ]);
  const summary = el("div", { class: "strategy-summary", "data-strategy-summary": "1" }, "尚未生成建议");
  const limited = el("div", { class: "strategy-limited", "data-strategy-limited": "1" });
  const list = el("div", { class: "strategy-list", "data-strategy-list": "1" });
  const noAction = el("div", { class: "strategy-noaction", "data-strategy-noaction": "1" });
  const applyBtn = el(
    "button",
    { class: "btn btn-small", type: "button", "data-act": "strategy-apply", disabled: "" },
    "应用所选",
  );
  const footer = el("div", { class: "strategy-footer" }, [applyBtn]);
  section.append(header, summary, limited, list, noAction, footer);
  host.appendChild(section);

  function render(): void {
    const model = buildStrategyPanelModel(plan);
    summary.textContent = model.summary;
    limited.textContent = model.limitedBy;
    list.replaceChildren();
    if (model.emptyText) {
      list.appendChild(el("div", { class: "strategy-empty" }, model.emptyText));
    }
    for (const row of model.rows) {
      const checkbox = el("input", {
        type: "checkbox",
        "data-strategy-id": row.id,
        ...(row.applicable ? {} : { disabled: "" }),
      }) as HTMLInputElement;
      checkbox.checked = selected.has(row.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(row.id);
        else selected.delete(row.id);
        applyBtn.disabled = selected.size === 0;
      });
      list.appendChild(
        el(
          "div",
          {
            class: `strategy-row${row.applicable ? "" : " strategy-row-advisory"}`,
            "data-strategy-row": row.id,
            "data-strategy-action": row.action,
            "data-applicable": row.applicable ? "1" : "0",
          },
          [
            el("label", { class: "strategy-row-head" }, [
              checkbox,
              el("span", { class: "strategy-action" }, row.actionLabel),
              el("span", { class: "strategy-task" }, row.taskTitle),
              el("span", { class: "strategy-ev" }, row.evText),
            ]),
            el("div", { class: "strategy-reason" }, row.reason),
            el("div", { class: "strategy-meta" }, row.confidenceText),
            row.sessionText ? el("div", { class: "strategy-meta" }, `对象：${row.sessionText}`) : null,
            el("div", { class: "strategy-risk" }, `风险：${row.risk}`),
            row.doNotText ? el("div", { class: "strategy-donot" }, row.doNotText) : null,
          ],
        ),
      );
    }
    noAction.replaceChildren();
    if (model.noActionRows.length) {
      noAction.appendChild(el("div", { class: "strategy-noaction-title" }, "现在不做 / 为什么"));
      for (const reason of model.noActionRows) {
        noAction.appendChild(el("div", { class: "strategy-noaction-row" }, reason));
      }
    }
    applyBtn.disabled = selected.size === 0;
  }

  header.querySelector("[data-act=strategy-plan]")?.addEventListener("click", () => {
    const taskId = ctx.store.get().task?.id;
    if (!taskId) {
      notify("先新建/切换任务，才能生成建议", "error");
      return;
    }
    notify("正在生成作战建议…", "info");
    void ctx.hub
      .dispatch({ type: "strategy.plan", taskId })
      .then((res) => {
        if (!res?.ok) {
          notify(`生成建议失败：${res?.error ?? "未知错误"}`, "error");
          return;
        }
        plan = res.strategyPlan ?? null;
        selected.clear();
        render();
      })
      .catch((err) => notify(`生成建议失败：${(err as Error).message}`, "error"));
  });

  applyBtn.addEventListener("click", () => {
    const taskId = ctx.store.get().task?.id;
    if (!taskId || selected.size === 0) return;
    const ids = [...selected];
    applyBtn.disabled = true;
    notify(`正在应用 ${ids.length} 条建议…`, "info");
    void ctx.hub
      .dispatch({ type: "strategy.apply", taskId, recommendationIds: ids })
      .then((res) => {
        if (res.strategyPlan) {
          plan = res.strategyPlan;
          selected.clear();
          render();
        }
        if (!res?.ok) {
          notify(`应用建议失败：${res?.error ?? "未知错误"}`, "error");
          return;
        }
        notify(res.message ?? "已应用建议", "info");
      })
      .catch((err) => notify(`应用建议失败：${(err as Error).message}`, "error"))
      .finally(() => {
        applyBtn.disabled = selected.size === 0;
      });
  });

  ctx.store.subscribeWorkspace(() => {
    // 切任务后旧计划不再可信；保留展示但清空选择，提醒用户重新生成。
    const taskId = ctx.store.get().task?.id;
    if (plan && taskId && !plan.recommendations.some((r) => r.taskId === taskId)) {
      plan = null;
      selected.clear();
      render();
    }
  });
  render();
}
