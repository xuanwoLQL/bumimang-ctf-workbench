/**
 * T10 加号扇出交互（DOM 层）。
 *
 * 点加号 → 选 agent + 角色 + 档位（可选模型）→ 发出 `hub:action`（`session.start`）。
 * 顶部给「可用 / 未安装」两个计数（§6：只检测不安装，未安装灰显 + 附安装提示），
 * 选中某个 agent 时下方显示它的成熟度备注（已安装）或安装提示（未安装）。
 * 另带「一键扇出」预设：三个引擎同时上这道题（ARCHITECTURE §7.2）。
 *
 * R11（首次用户体验）修了两处「陌生人会卡住」的地方：
 *  1. 扇出是异步的（spawn agent 要几秒到几十秒），此前点完直接关窗、结果被丢弃，
 *     失败时用户只看到「点了没反应」。现在派发前先弹「正在启动…」，失败把 error 弹出来。
 *  2. 「选哪个 agent」对新手是隐形决策 —— 弹窗里补一条已知行为提示 + 选中 agent 时
 *     把「默认会不会请求授权」写进成熟度一行（数据源是快照的 permissionBehavior，R-2）。
 */
import type { Role, Tier } from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import {
  buildStartAction,
  buildPresetActions,
  agentUsability,
  agentOptionLabel,
  gateNoteFor,
  fanoutGateNote,
  ROLES,
  TIERS,
  ROLE_LABEL,
  TIER_LABEL,
} from "./model.ts";
import { el } from "../dom.ts";
import { notify } from "../notice.ts";
import { tierNoteFor } from "../gate.ts";

export function openFanoutModal(ctx: UiCtx): void {
  const task = ctx.store.get().task;
  const agents = ctx.store.get().agents;

  let agentSel: HTMLSelectElement;
  let roleSel: HTMLSelectElement;
  let tierSel: HTMLSelectElement;
  let modelInput: HTMLInputElement;
  let allowAllInput: HTMLInputElement;
  let confirmBtn: HTMLButtonElement;
  let agentDetail: HTMLDivElement;
  let tierDetail: HTMLDivElement;

  const agentOptions = agents.map((a) => {
    const opt = el("option", { value: a.id }, agentOptionLabel(a));
    (opt as HTMLOptionElement).disabled = !a.installed;
    return opt;
  });

  roleSel = el("select", { class: "fanout-select" }, ROLES.map((r) => el("option", { value: r }, ROLE_LABEL[r])));
  tierSel = el("select", { class: "fanout-select" }, TIERS.map((t) => el("option", { value: t }, TIER_LABEL[t])));
  agentSel = el("select", { class: "fanout-select" }, agentOptions);
  modelInput = el("input", { class: "fanout-input", type: "text", placeholder: "模型（留空用 agent 默认）" });
  // 用户想要的「一键全权」：建会话时就给本会话发通配授权，之后不再逐条弹审批。
  allowAllInput = el("input", {
    class: "fanout-check",
    type: "checkbox",
    title: "所有需人工审批的动作自动放行（含执行/删除/凭据/网络）；硬阻断与工作目录边界仍生效",
  }) as HTMLInputElement;

  // 默认选中第一个「可用」的 agent（浏览器对首个 disabled option 的行为不一致）。
  const firstUsable = agents.find((a) => a.installed);
  if (firstUsable) agentSel.value = firstUsable.id;

  agentDetail = el("div", { class: "fanout-agent-detail" }, "");
  // R-5：档位选项旁的一句差异说明，随选中的 agent 变（codex 的 autonomous 档会一直空面板）。
  tierDetail = el("div", { class: "fanout-tier-detail" }, "");
  function refreshAgentDetail(): void {
    const a = agents.find((x) => x.id === agentSel.value);
    if (!a) {
      agentDetail.textContent = "";
      return;
    }
    if (!a.installed) {
      agentDetail.textContent = `安装提示：${a.installHint}`;
      return;
    }
    const gateNote = gateNoteFor(a.permissionBehavior);
    agentDetail.textContent = `成熟度：${a.maturity}${gateNote ? `；${gateNote}` : ""}`;
  }
  function refreshTierDetail(): void {
    const a = agents.find((x) => x.id === agentSel.value);
    tierDetail.textContent = a ? tierNoteFor(a.id) ?? "" : "";
  }
  agentSel.addEventListener("change", () => {
    refreshAgentDetail();
    refreshTierDetail();
  });
  refreshAgentDetail();
  refreshTierDetail();

  // 「选哪个 agent」的已知行为提示：guarded 档能不能产生审批，取决于 agent 会不会问。
  // 文案从快照的 permissionBehavior 现算（fanoutGateNote），不硬编码哪家会问。
  const gateNote = el("div", { class: "fanout-gate-note" }, fanoutGateNote(agents));

  function currentChoice(): {
    agent: string;
    role: Role;
    tier: Tier;
    model?: string;
    allowAll?: boolean;
  } | null {
    const agent = agentSel.value;
    if (!agent || !task) return null;
    const model = modelInput.value.trim() || undefined;
    return {
      agent,
      role: roleSel.value as Role,
      tier: tierSel.value as Tier,
      model,
      allowAll: allowAllInput.checked,
    };
  }

  function startOne(): void {
    const c = currentChoice();
    if (!c || !task) return;
    notify("正在启动会话…（首次启动 agent 可能需几秒到几十秒）", "info");
    close();
    void ctx.hub.dispatch(buildStartAction(task.id, c)).then((res) => {
      if (!res?.ok) notify(`扇出失败：${res?.error ?? "未知错误"}`, "error");
    });
  }

  function startPreset(): void {
    if (!task) return;
    const actions = buildPresetActions(task.id, allowAllInput.checked);
    notify(`正在启动 ${actions.length} 个会话（三引擎）…`, "info");
    close();
    Promise.all(actions.map((a) => ctx.hub.dispatch(a))).then((results) => {
      const failed = results.filter((r) => !r?.ok);
      if (failed.length > 0) {
        notify(
          `扇出失败 ${failed.length}/${results.length}：${failed.map((r) => r?.error ?? "未知错误").join("；")}`,
          "error",
        );
      }
    });
  }

  confirmBtn = el("button", { class: "btn btn-approve" }, "扇出");
  confirmBtn.addEventListener("click", startOne);

  const presetBtn = el("button", { class: "btn btn-preset" }, "一键扇出（三引擎）");
  presetBtn.addEventListener("click", startPreset);

  const hint = task
    ? el("div", { class: "fanout-task" }, `任务：${task.title}`)
    : el("div", { class: "fanout-task fanout-task-none" }, "还没有任务 —— 请先创建任务再扇出。");
  if (!task) confirmBtn.disabled = true;

  const { usable, notInstalled } = agentUsability(agents);
  const summary = el(
    "div",
    { class: "fanout-agents-summary" },
    `可用 ${usable} · 未安装 ${notInstalled}${notInstalled > 0 ? "（未安装的会灰显，选中看安装提示）" : ""}`,
  );

  const overlay = el("div", { class: "fanout-overlay" });
  const modal = el("div", { class: "fanout-modal" }, [
    el("h3", { class: "fanout-title" }, "扇出会话（agent + 角色 + 档位）"),
    hint,
    summary,
    gateNote,
    el("label", { class: "fanout-label" }, ["agent", agentSel, agentDetail]),
    el("label", { class: "fanout-label" }, ["角色", roleSel]),
    el("label", { class: "fanout-label" }, ["档位", tierSel, tierDetail]),
    el("label", { class: "fanout-label" }, ["模型（可选）", modelInput]),
    el("label", { class: "fanout-label fanout-allow-all" }, [
      "权限",
      el("span", { class: "fanout-allow-all-note" }, [
        allowAllInput,
        " 全部放行：本会话不再逐条审批（含执行/删除/凭据/网络）。硬阻断与工作目录边界仍生效。",
      ]),
    ]),
    el("div", { class: "fanout-actions" }, [confirmBtn, presetBtn, el("button", { class: "btn btn-cancel" }, "取消")]),
  ]);

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
}
