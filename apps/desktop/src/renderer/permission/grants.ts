/**
 * 「一键放行」授权管理弹窗。
 *
 * 入口在左栏引擎面板底部（授权管理）以及每个已授权 agent 的 `授权 N` 按钮。
 * 支持：
 *  - 查看某个 agent 的授权（永久 / 仅本会话）；
 *  - 单条撤销；
 *  - 撤销某个 agent 的全部授权。
 *
 * 数据源是快照里的 `permissionGrants`；主进程在授权变化时推 `permission.updated`，
 * 所以弹窗开着也会实时刷新。
 */
import type { PermissionGrantView } from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import { el, clear } from "../dom.ts";
import { notify } from "../notice.ts";

const SCOPE_LABEL: Record<PermissionGrantView["scope"], string> = {
  session: "仅本会话",
  agent: "永久（该 agent）",
};

/** 全局通配授权在主进程里以固定 id / agentId="*" 表示，不是普通 agent 授权。 */
function isGlobalGrant(g: PermissionGrantView): boolean {
  return g.id === "global:all" || g.agentId === "*";
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ts);
  }
}

export function openPermissionModal(ctx: UiCtx, agentFilter?: string): void {
  const overlay = el("div", { class: "task-overlay" });
  const list = el("div", { class: "perm-list" });
  let unsub: (() => void) | null = null;

  const close = (): void => {
    unsub?.();
    unsub = null;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  function revoke(agentId: string, grantId?: string): void {
    void ctx.hub.dispatch({ type: "permission.revoke", agentId, grantId }).then((res) => {
      if (!res?.ok) notify(`撤销失败：${res?.error ?? "未知错误"}`, "error");
      else notify(res.message ?? "已撤销", "info");
    });
  }

  function render(): void {
    const all = ctx.store.get().permissionGrants;
    const grants = agentFilter ? all.filter((g) => g.agentId === agentFilter) : all;
    clear(list);

    if (grants.length === 0) {
      list.appendChild(
        el("div", { class: "perm-empty" }, [
          el("div", { class: "perm-empty-title" }, "还没有一键放行授权"),
          el(
            "div",
            { class: "perm-empty-hint" },
            "在审批卡上点「本会话始终允许」「对该 agent 永久允许」或「全局全部允许」后，会在这里出现，可随时撤销。",
          ),
        ]),
      );
      return;
    }

    const groups = new Map<string, PermissionGrantView[]>();
    for (const g of grants) {
      const arr = groups.get(g.agentId) ?? [];
      arr.push(g);
      groups.set(g.agentId, arr);
    }

    for (const [agentId, items] of groups) {
      const globalGroup = agentId === "*" || items.some(isGlobalGrant);
      const head = el("div", { class: "perm-group-head" }, [
        el("span", { class: "perm-group-agent" }, globalGroup ? "全局（所有 agent）" : agentId),
        el("span", { class: "perm-group-count" }, `${items.length} 条`),
        el(
          "button",
          {
            class: "btn btn-deny perm-revoke-all",
            "data-agent": agentId,
            title: globalGroup ? "关闭全局全部放行" : "撤销该 agent 的全部授权",
          },
          globalGroup ? "关闭全局放行" : "撤销该 agent 全部授权",
        ),
      ]);
      head.querySelector(".perm-revoke-all")?.addEventListener("click", () => revoke(agentId));

      const rows = items.map((g) => {
        const row = el("div", { class: "perm-row", "data-grant": g.id }, [
          el("div", { class: "perm-row-main" }, [
            el("span", { class: `perm-category risk-${g.risk}` }, g.label),
            el(
              "span",
              { class: "perm-scope" },
              isGlobalGrant(g) ? "全局（所有 agent / 所有会话）" : SCOPE_LABEL[g.scope],
            ),
            g.sessionId ? el("code", { class: "perm-session" }, g.sessionId) : null,
          ]),
          el("div", { class: "perm-row-meta" }, `授权时间：${fmtTime(g.createdAt)}`),
          el(
            "button",
            { class: "btn btn-cancel perm-revoke", "data-grant": g.id, title: "撤销这一条授权" },
            "撤销",
          ),
        ]);
        row.querySelector(".perm-revoke")?.addEventListener("click", () => revoke(g.agentId, g.id));
        return row;
      });
      list.appendChild(el("section", { class: "perm-group" }, [head, ...rows]));
    }
  }

  const modal = el("div", { class: "task-modal perm-modal" }, [
    el("h3", { class: "task-modal-title" }, agentFilter ? `授权管理 · ${agentFilter}` : "授权管理（一键放行）"),
    el(
      "div",
      { class: "perm-note" },
      "「永久」授权写入本地配置文件，重启后仍生效；「仅本会话」授权在会话结束或应用退出时清除。" +
        "「全局全部允许」会写入 permissions.json，对所有 agent / 所有会话生效，重启后仍保留，" +
        "必须在这里点「关闭全局放行」显式撤销。" +
        "执行命令、删除文件、凭据访问、网络访问和未知操作默认不参与按类别的「始终允许」；" +
        "但显式点击「全部放行」会生成一条「全部操作（含高风险）」通配授权，可在这里单条撤销。" +
        "通配授权（含全局）只跳过人工审批，不绕过硬阻断规则与工作目录边界。",
    ),
    list,
    el("div", { class: "task-form-actions" }, [
      el("button", { class: "btn btn-cancel perm-close" }, "关闭"),
    ]),
  ]);

  modal.querySelector(".perm-close")?.addEventListener("click", close);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  unsub = ctx.store.subscribe(render);
  render();
  document.body.appendChild(overlay);
}
