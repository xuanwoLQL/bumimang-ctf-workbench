/**
 * T8 审批队列 UI（DOM 层）。
 *
 * 三栏卡片（ARCHITECTURE §9.5）：
 *   左：命令全文 + 目标（命令/目标常为 null —— opencode 的权限请求不带）
 *   中：agent 自述意图（无则退化「暂无自述意图」）
 *   右：命中规则 + 风险 + 同类历史（sameKindCount > 1 标重复退避）
 * 待批项支持放行 / 拒绝 / 记住并放行 + 顶部批量；已决项折叠在下方只读展示。
 *
 * 注意：所有文本走 `el()` 的文本节点（createTextNode），天然防注入，
 * 不要再套 escapeHtml —— 那会把 &<> 双重转义成字面量（文本节点不解析实体）。
 */
import type { ApprovalView } from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import {
  pendingApprovals,
  decidedApprovals,
  statusLabel,
  sameKindLabel,
  buildDecideAction,
  buildBulkAction,
  filterApprovals,
  buildTaskGrantAllAction,
} from "./model.ts";
import { el, clear } from "../dom.ts";
import { notify } from "../notice.ts";
import { applySnapshot } from "../store.ts";

const RISK_LABEL: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  blocked: "硬阻断",
};

/** P4-D：把规则 id 变成人可读的短名；未知 id 原样显示。 */
const RULE_LABEL: Record<string, string> = {
  "no-out-of-scope": "目标不在授权范围",
  "external-network-needs-human": "对外网络动作需人工",
  "credential-actions-need-human": "凭据类动作需人工",
  "write-outside-workspace-needs-human": "破坏性文件操作需人工",
  "no-c2-tools": "C2 工具硬阻断",
  "no-c2-tools-via-permission": "C2 工具硬阻断（权限请求）",
  "blackboard-tools-are-internal": "黑板工具内部放行",
  "tier-guarded-default": "受控档兜底",
  "tier-autonomous-default": "自主档兜底",
};

export function approvalRuleLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return RULE_LABEL[id] ?? id;
}

export function approvalScopeTargetText(
  ap: Pick<ApprovalView, "scopeTarget">,
): string | null {
  if (!ap.scopeTarget) return null;
  return `范围目标：${ap.scopeTarget.kind} ${ap.scopeTarget.value}`;
}

export function createApprovals(container: HTMLElement, ctx: UiCtx): { dispose(): void } {
  /** 默认只看当前任务；用户可一键切到全部任务。 */
  let onlyCurrent = true;

  /**
   * 后台审批的实时事件仍只推焦点（P1-B/C 的已知边界），所以后台项裁决后
   * 重新拉一次快照，保证 approvalsAll / 配额 / 任务计数是权威值。
   */
  function refreshFromSnapshot(): void {
    void ctx.hub
      .snapshot()
      .then((snap) => ctx.store.set(applySnapshot(snap, ctx.store.get())))
      .catch(() => undefined);
  }

  function decide(
    id: string,
    decision: "approve" | "deny",
    remember?: "session" | "agent",
  ): void {
    void ctx.hub.dispatch(buildDecideAction(id, decision, remember)).then((res) => {
      if (res?.ok) refreshFromSnapshot();
    });
  }

  /** 关闭全局放行（持久化设置，agentId="*" 是主进程约定的撤销入口）。 */
  function revokeGlobal(): void {
    void ctx.hub
      .dispatch({ type: "permission.revoke", agentId: "*" })
      .then((res) => {
        if (!res?.ok) notify(`关闭全局放行失败：${res?.error ?? "未知错误"}`, "error");
        else notify(res.message ?? "已关闭全局放行", "info");
      });
  }

  /** 一键全部放行：不再逐条弹审批，同时放行已挂起的项。 */
  function grantAll(
    scope: "session" | "all" | "global",
    opts: { sessionId?: string; taskId?: string } = {},
  ): void {
    void ctx.hub
      .dispatch({ type: "permission.grantAll", scope, sessionId: opts.sessionId, taskId: opts.taskId })
      .then((res) => {
        if (!res?.ok) notify(`全部放行失败：${res?.error ?? "未知错误"}`, "error");
        else {
          notify(res.message ?? "已全部放行", "info");
          refreshFromSnapshot();
        }
      });
  }

  function card(ap: ApprovalView): HTMLElement {
    const pending = ap.status === "pending";
    const scopeTargetText = approvalScopeTargetText(ap);
    const ruleId = ap.ruleId ?? ap.rule ?? null;
    const ruleLabel = approvalRuleLabel(ruleId);

    const taskTitle = ap.taskTitle ?? ap.taskId;
    const left = el("div", { class: "ap-left" }, [
      el(
        "div",
        { class: "ap-task", title: `任务 id：${ap.taskId}` },
        `任务：${taskTitle} · ${ap.taskId}`,
      ),
      el("div", { class: "ap-action" }, ap.action),
      ap.command
        ? el("div", { class: "ap-command", title: ap.command }, ap.command)
        : el("div", { class: "ap-command ap-command-empty" }, "（未提供命令全文）"),
      el("div", { class: "ap-target" }, ap.target ? `目标：${ap.target}` : "目标：—"),
      scopeTargetText
        ? el(
            "div",
            { class: "ap-target", "data-scope-target": "1", title: "策略判定时的结构化范围目标" },
            scopeTargetText,
          )
        : null,
    ]);
    const mid = el("div", { class: "ap-mid" }, [
      el("div", { class: "ap-mid-label" }, "agent 自述意图"),
      ap.intentSummary
        ? el("div", { class: "ap-intent" }, ap.intentSummary)
        : el("div", { class: "ap-intent ap-intent-empty" }, "暂无自述意图"),
    ]);
    const right = el("div", { class: "ap-right" }, [
      el(
        "div",
        { class: "ap-rule", "data-rule-id": ruleId ?? "" },
        ruleId
          ? `命中规则：${ruleLabel}（${ruleId}）`
          : "命中规则：—（默认档位兜底）",
      ),
      el(
        "div",
        { class: "ap-category", title: "操作类别：一键放行按类别匹配，不按单条命令全文" },
        `类别：${ap.categoryLabel ?? ap.category ?? "未分类"}`,
      ),
      el("div", { class: `ap-risk risk-${ap.risk}` }, `风险：${RISK_LABEL[ap.risk] ?? ap.risk}`),
      ap.highRisk
        ? el(
            "div",
            { class: "ap-high-risk-note" },
            ap.rememberable
              ? "高风险：已在 config/permissions.json 的 highRiskAllowlist 中显式放行，可被记住"
              : "高风险：默认只能逐条放行（执行命令 / 删除文件 / 凭据 / 网络 / 未知操作）",
          )
        : null,
      el(
        "div",
        { class: ap.sameKindCount > 1 ? "ap-history ap-repeat" : "ap-history" },
        sameKindLabel(ap.sameKindCount),
      ),
    ]);

    if (pending) {
      // 只有主进程判定 rememberable 的类别才给「始终允许」；高风险默认禁用。
      // 旧快照没有 rememberable 字段时按旧行为允许（向后兼容）。
      const canRemember = ap.rememberable !== false;
      const rememberTitle = canRemember
        ? "同类操作不再弹窗；本会话授权进程退出即失效，agent 授权写入本地配置并在重启后仍生效"
        : "高风险操作默认不支持一键放行；如确需纳入，请在 config/permissions.json 的 highRiskAllowlist 中显式配置";
      const sessionBtn = el(
        "button",
        {
          class: "btn btn-approve-remember",
          "data-act": "approve-session",
          disabled: canRemember ? null : "",
          title: rememberTitle,
        },
        "本会话始终允许",
      );
      const agentBtn = el(
        "button",
        {
          class: "btn btn-approve-agent",
          "data-act": "approve-agent",
          disabled: canRemember ? null : "",
          title: rememberTitle,
        },
        "对该 agent 永久允许",
      );
      const sameTask = ap.taskId === ctx.store.get().task?.id;
      const grantAllBtn = sameTask
        ? el(
            "button",
            {
              class: "btn btn-approve-all",
              "data-act": "approve-all",
              title:
                "本会话所有需人工审批的动作自动放行（含执行/删除/凭据/网络）。" +
                "硬阻断规则与工作目录边界仍然生效；可在授权管理里撤销。",
            },
            "本会话全部允许",
          )
        : null;
      const actions = el("div", { class: "ap-actions" }, [
        el("button", { class: "btn btn-approve", "data-act": "approve" }, "放行"),
        sessionBtn,
        agentBtn,
        grantAllBtn,
        el("button", { class: "btn btn-deny", "data-act": "deny" }, "拒绝"),
      ]);
      actions.querySelector('[data-act="approve"]')?.addEventListener("click", () => decide(ap.id, "approve"));
      sessionBtn.addEventListener("click", () => {
        if (canRemember) decide(ap.id, "approve", "session");
      });
      agentBtn.addEventListener("click", () => {
        if (canRemember) decide(ap.id, "approve", "agent");
      });
      grantAllBtn?.addEventListener("click", () => grantAll("session", { sessionId: ap.sessionId }));
      actions.querySelector('[data-act="deny"]')?.addEventListener("click", () => decide(ap.id, "deny"));
      // 卡片类带风险（ap-high / ap-blocked…），驱动边框色 + 排序断言
      return el(
        "article",
        { class: `ap-card ap-pending ap-${ap.risk}`, "data-id": ap.id, "data-task-id": ap.taskId },
        [left, mid, right, actions],
      );
    }

    const verdict = el("div", { class: "ap-actions ap-verdict" }, [
      el("span", { class: `ap-status ap-status-${ap.status}` }, statusLabel(ap.status)),
      ap.decidedBy ? el("span", { class: "ap-decided-by" }, `by ${ap.decidedBy}`) : null,
    ]);
    return el(
      "article",
      { class: `ap-card ap-decided ap-${ap.risk}`, "data-id": ap.id, "data-task-id": ap.taskId },
      [left, mid, right, verdict],
    );
  }

  function render(): void {
    const st = ctx.store.get();
    // P1-E：全局队列优先读 approvalsAll；旧快照没有时回退到焦点 approvals。
    // 归档任务不进入可操作队列（历史审批仍留在快照数据里，避免误放已归档任务）。
    const activeTaskIds = new Set(st.tasks.filter((t) => t.archived !== true).map((t) => t.id));
    const rawAll = st.approvalsAll.length > 0 ? st.approvalsAll : st.approvals;
    const all = st.tasks.length > 0 ? rawAll.filter((a) => activeTaskIds.has(a.taskId)) : rawAll;
    const filtered = filterApprovals(all, { onlyCurrent, taskId: st.task?.id ?? null });
    const pending = pendingApprovals(filtered);
    const decided = decidedApprovals(filtered);
    const allPending = pendingApprovals(all);
    // 全局授权以 agentId="*" 的合成项出现在 permissionGrants 里；开启后按钮变成关闭入口，
    // 让这个跨重启生效的高危状态始终可见、可一键收回。
    const globalOn = (st.permissionGrants ?? []).some(
      (g) => g.id === "global:all" || g.agentId === "*",
    );
    clear(container);

    const filterBtn = el(
      "button",
      {
        class: `btn ap-filter${onlyCurrent ? " ap-filter-on" : ""}`,
        "data-bulk": "filter",
        title: onlyCurrent
          ? "当前只显示焦点任务的审批；点击查看全部任务的审批（批量放行仍只作用于当前过滤结果）"
          : "当前显示全部任务；点击回到只看当前任务",
      },
      onlyCurrent ? "只看当前任务" : "查看全部任务",
    );
    const taskGrantBtn = el(
      "button",
      {
        class: "btn btn-approve-all",
        "data-bulk": "grant-all-task",
        disabled: st.task ? null : "",
        title:
          "对当前焦点任务的所有活跃会话全部放行（含高风险）；不会跨任务。" +
          "硬阻断规则与工作目录边界仍然生效。",
      },
      "本任务全部允许",
    );
    const header = el("div", { class: "ap-header" }, [
      el("div", { class: "ap-header-line" }, [
        el(
          "span",
          { class: "ap-count" },
          `待审批 ${pending.length} 条${!onlyCurrent && allPending.length !== pending.length ? `（全部 ${allPending.length}）` : ""}`,
        ),
        filterBtn,
      ]),
      el("div", { class: "ap-bulk" }, [
        el("button", { class: "btn btn-approve", "data-bulk": "approve" }, "全放行"),
        el("button", { class: "btn btn-deny", "data-bulk": "deny" }, "全拒绝"),
        taskGrantBtn,
        el(
          "button",
          {
            class: globalOn ? "btn btn-deny" : "btn btn-approve-all",
            "data-bulk": globalOn ? "revoke-global" : "grant-all",
            title: globalOn
              ? "全局放行已开启（写入本地 permissions.json，重启后仍生效）。点击关闭。"
              : "所有 agent、所有会话都不再逐条审批（含高风险），写入本地 permissions.json，重启后仍生效。" +
                "硬阻断规则与工作目录边界仍然生效；可在授权管理里撤销。",
          },
          globalOn ? "关闭全局放行" : "全局全部允许",
        ),
      ]),
    ]);
    container.appendChild(header);

    if (pending.length === 0) {
      // 空 ≠ 一切正常（GATE-INPUT-STARVED）：真实 agent 在默认配置下可能从不请求授权，
      // 闸门「已武装但上游没水」。空状态要诚实交代两种可能，并亮出当前规则包，让用户
      // 看到闸门确实已加载 —— 而不是看到空就以为「没有风险」。
      const policy = ctx.store.get().policy;
      container.appendChild(
        el("div", { class: "ap-empty" }, [
          el("div", { class: "ap-empty-title" }, "暂无待审批"),
          el("div", { class: "ap-empty-gate" }, [
            el("span", { class: "ap-empty-gate-label" }, "规则包"),
            el("span", { class: "ap-empty-gate-name" }, policy ? policy.name : "—"),
            policy?.fellBackToMinimal
              ? el("span", { class: "ap-empty-gate-fallback" }, "已回落最小安全集")
              : null,
          ]),
          el("div", { class: "ap-empty-reasons" }, [
            el("div", { class: "ap-empty-reason-lead" }, "空有两种可能，不一定是一切正常："),
            el("div", { class: "ap-empty-reason" }, "① 还没出现需要审批的关键动作（命令执行 / 文件写入等）。"),
            el(
              "div",
              { class: "ap-empty-reason" },
              "② 该 agent 默认不请求授权（如 opencode 的 permission.edit/bash 未开启）—— 有会话在跑而这里一直空，多半是这一条。",
            ),
            el(
              "div",
              { class: "ap-empty-reason" },
              "③ 想不再逐条审批：扇出时勾选「全部放行」，或点面板顶部「全局全部允许」；已有挂起项时也可点卡片上的「本会话全部允许」。硬阻断与工作目录边界仍生效。",
            ),
          ]),
        ]),
      );
    } else {
      for (const ap of pending) container.appendChild(card(ap));
    }

    header.querySelector('[data-bulk="approve"]')?.addEventListener("click", () => {
      void ctx.hub.dispatch(buildBulkAction(pending.map((a) => a.id), "approve")).then((res) => {
        if (res?.ok) refreshFromSnapshot();
      });
    });
    header.querySelector('[data-bulk="deny"]')?.addEventListener("click", () => {
      void ctx.hub.dispatch(buildBulkAction(pending.map((a) => a.id), "deny")).then((res) => {
        if (res?.ok) refreshFromSnapshot();
      });
    });
    header.querySelector('[data-bulk="filter"]')?.addEventListener("click", () => {
      onlyCurrent = !onlyCurrent;
      render();
    });
    header.querySelector('[data-bulk="grant-all-task"]')?.addEventListener("click", () => {
      const action = buildTaskGrantAllAction(st.task?.id ?? null);
      if (!action) {
        notify("没有活动任务，不能按任务全部放行", "error");
        return;
      }
      void ctx.hub.dispatch(action).then((res) => {
        if (!res?.ok) notify(`本任务全部放行失败：${res?.error ?? "未知错误"}`, "error");
        else {
          notify(res.message ?? "已对本任务全部放行", "info");
          refreshFromSnapshot();
        }
      });
    });
    header.querySelector('[data-bulk="grant-all"]')?.addEventListener("click", () => grantAll("global"));
    header.querySelector('[data-bulk="revoke-global"]')?.addEventListener("click", revokeGlobal);

    if (decided.length > 0) {
      container.appendChild(
        el("div", { class: "ap-decided-header" }, `最近已决 ${decided.length} 条`),
      );
      for (const ap of decided) container.appendChild(card(ap));
    }
  }

  const unsub = ctx.store.subscribeWorkspace(render);
  render();
  return { dispose: unsub };
}
