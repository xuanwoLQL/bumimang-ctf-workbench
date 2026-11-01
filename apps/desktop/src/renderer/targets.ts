/**
 * P4-D 批次 1：焦点任务的目标面板。
 *
 * 数据来自 `TaskView.targets/denyTargets/scopeNotes`（P4-A 契约，Hub 只为焦点任务
 * 填完整列表）。这里只做展示与动作派发，不解析/校验 IP/CIDR/URL —— 校验在
 * `electron/validate-action.ts` 与 board 层。
 *
 * 旧快照没有 targets 字段时显示「旧快照未带目标数据」，不把“未知”伪装成“没有目标”。
 */
import type { HubAction, TargetView, TaskView } from "./contract.ts";
import type { UiCtx } from "./ctx.ts";
import { el } from "./dom.ts";
import { notify } from "./notice.ts";
import { applySnapshot } from "./store.ts";

export const TARGET_PANEL_ACTIONS = ["add", "update", "remove"] as const;
export type TargetPanelAction = (typeof TARGET_PANEL_ACTIONS)[number];

const KIND_LABEL: Record<string, string> = {
  host: "host",
  cidr: "CIDR",
  url: "URL",
};

const STATUS_LABEL: Record<string, string> = {
  unknown: "未知",
  alive: "存活",
  owned: "已拿下",
};

export interface TargetRowView {
  id: string;
  value: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  notes: string | null;
}

export interface TargetPanelView {
  hasTask: boolean;
  taskId: string | null;
  hasTargetData: boolean;
  targetCount: number | null;
  targets: TargetRowView[];
  denyTargets: string[];
  scopeNotes: string | null;
  empty: boolean;
  emptyText: string;
  actions: readonly TargetPanelAction[];
}

export interface TargetBadgeView {
  count: number | null;
  text: string;
  title: string;
}

/** 任务卡上的目标数徽标；只有焦点任务调用（非焦点任务没有 targets 数据）。 */
export function buildTargetBadge(task: TaskView | null): TargetBadgeView | null {
  if (!task) return null;
  if (!Array.isArray(task.targets)) {
    return {
      count: null,
      text: "目标 —",
      title: "旧快照未带 targets 字段；无法显示目标数，点击仍可打开目标面板",
    };
  }
  return {
    count: task.targets.length,
    text: `目标 ${task.targets.length}`,
    title: `授权目标 ${task.targets.length} 个；点击展开目标面板`,
  };
}

/** 目标面板纯视图模型（smoke 直接验证，不依赖 DOM）。 */
export function buildTargetPanelView(task: TaskView | null): TargetPanelView {
  if (!task) {
    return {
      hasTask: false,
      taskId: null,
      hasTargetData: false,
      targetCount: null,
      targets: [],
      denyTargets: [],
      scopeNotes: null,
      empty: true,
      emptyText: "没有活动任务；先创建/聚焦一个任务。",
      actions: TARGET_PANEL_ACTIONS,
    };
  }
  const hasTargetData = Array.isArray(task.targets);
  const targets = (task.targets ?? []).map((t) => ({
    id: t.id,
    value: t.value,
    kind: t.kind,
    kindLabel: KIND_LABEL[t.kind] ?? t.kind,
    status: t.status,
    statusLabel: STATUS_LABEL[t.status] ?? t.status,
    notes: t.notes ?? null,
  }));
  const denyTargets = Array.isArray(task.denyTargets) ? task.denyTargets.slice() : [];
  return {
    hasTask: true,
    taskId: task.id,
    hasTargetData,
    targetCount: hasTargetData ? targets.length : null,
    targets,
    denyTargets,
    scopeNotes: typeof task.scopeNotes === "string" ? task.scopeNotes : null,
    empty: hasTargetData && targets.length === 0,
    emptyText: hasTargetData
      ? "还没有授权目标；scope 开启时，未授权目标会被判定为范围外。"
      : "旧快照未带目标数据（这是“未知”，不是“没有目标”）。",
    actions: TARGET_PANEL_ACTIONS,
  };
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = el("option", { value }, label) as HTMLOptionElement;
  o.selected = selected;
  return o;
}

/** 目标面板 DOM。调用方只在焦点任务且面板展开时插入。 */
export function renderTargetsPanel(ctx: UiCtx, task: TaskView): HTMLElement {
  const view = buildTargetPanelView(task);
  const refresh = (): void => {
    void ctx.hub
      .snapshot()
      .then((snap) => ctx.store.set(applySnapshot(snap, ctx.store.get())))
      .catch(() => undefined);
  };
  const run = (action: HubAction, okText: string, onOk?: () => void): void => {
    void ctx.hub
      .dispatch(action)
      .then((res) => {
        if (!res?.ok) notify(`目标操作失败：${res?.error ?? "未知错误"}`, "error");
        else {
          notify(res.message ?? okText, "info");
          onOk?.();
          refresh();
        }
      })
      .catch((err: unknown) => notify(`目标操作失败：${(err as Error).message}`, "error"));
  };

  const section = el("section", {
    class: "panel target-panel",
    "data-target-panel": "1",
    "data-target-count": view.targetCount === null ? "unknown" : String(view.targetCount),
  }, [
    el("div", { class: "task-head" }, [
      el("h2", { class: "panel-title" }, "目标"),
      el(
        "span",
        { class: "task-status-hint" },
        view.hasTargetData ? `${view.targetCount} 个授权目标` : "旧快照未带目标数据",
      ),
    ]),
    view.scopeNotes
      ? el("div", { class: "task-status-hint" }, `范围备注：${view.scopeNotes}`)
      : null,
    view.denyTargets.length > 0
      ? el(
          "div",
          { class: "task-status-hint", "data-deny-targets": "1" },
          `拒绝目标（deny 优先）：${view.denyTargets.join("、")}`,
        )
      : null,
    view.empty ? el("div", { class: "task-status-hint" }, view.emptyText) : null,
  ]);

  const list = el("ul", { class: "agent-list" });
  for (const t of view.targets) {
    const target = (task.targets ?? []).find((x) => x.id === t.id) as TargetView | undefined;
    if (!target) continue;
    const statusSelect = el(
      "select",
      { class: "task-form-input", "data-target-status": target.id },
      [
        option("unknown", "未知", target.status === "unknown"),
        option("alive", "存活", target.status === "alive"),
        option("owned", "已拿下", target.status === "owned"),
      ],
    ) as HTMLSelectElement;
    const notesInput = el("input", {
      class: "task-form-input",
      "data-target-notes": target.id,
      placeholder: "备注（可选）",
      value: target.notes ?? "",
    }) as HTMLInputElement;
    const saveBtn = el("button", {
      class: "btn btn-small",
      "data-act": "target-update",
      "data-target-id": target.id,
      title: "保存状态/备注（走 target.update）",
    }, "保存");
    const removeBtn = el("button", {
      class: "btn btn-small btn-deny",
      "data-act": "target-remove",
      "data-target-id": target.id,
      title: "移除该目标（走 target.remove）",
    }, "移除");
    saveBtn.addEventListener("click", () => {
      run(
        {
          type: "target.update",
          taskId: task.id,
          targetId: target.id,
          status: statusSelect.value as TargetView["status"],
          notes: notesInput.value,
        },
        "目标已更新",
      );
    });
    removeBtn.addEventListener("click", () => {
      run({ type: "target.remove", taskId: task.id, targetId: target.id }, "目标已移除");
    });
    const meta = el("div", { class: "agent-item-main" }, [
      el("div", { class: "agent-title" }, [
        el("code", {}, t.value),
        " ",
        el("span", { class: "task-category" }, t.kindLabel),
        " ",
        el("span", { class: "task-board-status" }, t.statusLabel),
      ]),
      t.notes ? el("div", { class: "agent-hint" }, t.notes) : null,
      el("div", { class: "task-form-row" }, [
        el("label", { class: "task-form-half" }, [el("span", { class: "task-form-label" }, "状态"), statusSelect]),
        el("label", { class: "task-form-half" }, [el("span", { class: "task-form-label" }, "备注"), notesInput]),
      ]),
      el("div", { class: "task-admin-row" }, [saveBtn, removeBtn]),
    ]);
    list.appendChild(
      el("li", { class: "agent-item target-row", "data-target-id": target.id }, [meta]),
    );
  }
  if (view.targets.length > 0) section.appendChild(list);

  // 添加目标：只做非空检查；路径/格式校验走 validate-action 与 board。
  const valueInput = el("input", {
    class: "task-form-input",
    "data-target-add-value": "1",
    placeholder: "IP / CIDR / URL / host:port",
  }) as HTMLInputElement;
  const kindSelect = el(
    "select",
    { class: "task-form-input", "data-target-add-kind": "1" },
    [option("host", "host", true), option("cidr", "CIDR", false), option("url", "URL", false)],
  ) as HTMLSelectElement;
  const notesInput = el("input", {
    class: "task-form-input",
    "data-target-add-notes": "1",
    placeholder: "备注（可选）",
  }) as HTMLInputElement;
  const addBtn = el("button", {
    class: "btn btn-small",
    "data-act": "target-add",
    title: "添加授权目标（走 target.add）",
  }, "添加目标");
  addBtn.addEventListener("click", () => {
    const value = valueInput.value.trim();
    if (!value) {
      notify("目标值不能为空", "error");
      return;
    }
    const notes = notesInput.value.trim();
    run(
      {
        type: "target.add",
        taskId: task.id,
        value,
        kind: kindSelect.value as "host" | "cidr" | "url",
        ...(notes ? { notes } : {}),
      },
      "目标已添加",
      () => {
        valueInput.value = "";
        notesInput.value = "";
      },
    );
  });
  section.appendChild(
    el("div", { class: "target-add", "data-target-add-row": "1" }, [
      el("div", { class: "task-form-row" }, [
        el("label", { class: "task-form-half" }, [
          el("span", { class: "task-form-label" }, "新增目标"),
          valueInput,
        ]),
        el("label", { class: "task-form-half" }, [
          el("span", { class: "task-form-label" }, "类型"),
          kindSelect,
        ]),
      ]),
      el("label", { class: "task-form-label" }, [
        el("span", { class: "task-form-label" }, "备注"),
        notesInput,
      ]),
      el("div", { class: "task-admin-row" }, [addBtn]),
    ]),
  );

  // V2-P0-5：范围数据编辑（denyTargets / scopeNotes / allowedActions）。
  // 只改任务数据；scope.enabled 仍由 config/app.json 决定，这里不会偷偷开启。
  const denyScopeInput = el("textarea", {
    class: "task-form-input target-scope-input",
    "data-scope-deny": "1",
    placeholder: "拒绝目标（每行一个；deny 优先）",
  }) as HTMLTextAreaElement;
  denyScopeInput.value = view.denyTargets.join("\n");
  const notesScopeInput = el("textarea", {
    class: "task-form-input target-scope-input",
    "data-scope-notes": "1",
    placeholder: "范围备注（只打 10.0.0.0/8 等）",
  }) as HTMLTextAreaElement;
  notesScopeInput.value = view.scopeNotes ?? "";
  const allowedScopeInput = el("input", {
    class: "task-form-input",
    "data-scope-allowed": "1",
    placeholder: "允许动作（逗号分隔，如 terminal/exec,fs/write；空 = 不限制）",
    value: (task.allowedActions ?? []).join(","),
  }) as HTMLInputElement;
  const saveScopeBtn = el("button", {
    class: "btn btn-small",
    "data-act": "scope-update",
    title: "保存 denyTargets/scopeNotes/allowedActions（走 task.scope.update）",
  }, "保存范围");
  const splitList = (raw: string): string[] =>
    [...new Set(raw.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean))];
  saveScopeBtn.addEventListener("click", () => {
    run(
      {
        type: "task.scope.update",
        taskId: task.id,
        denyTargets: splitList(denyScopeInput.value),
        scopeNotes: notesScopeInput.value.trim() || null,
        allowedActions: splitList(allowedScopeInput.value),
      },
      "范围数据已更新",
    );
  });
  section.appendChild(
    el("div", { class: "target-scope-editor", "data-scope-editor": "1" }, [
      el("div", { class: "task-form-label" }, "范围控制（仅数据 + 审计；scope.enabled 由配置决定）"),
      el("label", { class: "task-form-label" }, ["拒绝目标 denyTargets", denyScopeInput]),
      el("label", { class: "task-form-label" }, ["范围备注 scopeNotes", notesScopeInput]),
      el("label", { class: "task-form-label" }, ["允许动作 allowedActions", allowedScopeInput]),
      el("div", { class: "task-status-hint" }, "allowedActions 非空且 scope.enabled=true 时，未列出的动作转人工；不能绕过硬阻断。"),
      el("div", { class: "task-admin-row" }, [saveScopeBtn]),
    ]),
  );

  return section;
}
