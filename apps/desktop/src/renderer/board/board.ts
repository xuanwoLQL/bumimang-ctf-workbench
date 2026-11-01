/**
 * T9 黑板台账视图（DOM 层）。
 *
 * 四类可视化：事实 / 死路 / 意图 / 租约。
 * 冲突事实并列高亮（ARCHITECTURE §8.5：系统只高亮，裁决权归人工）。
 */
import type { FactView } from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import { findConflicts, isChallenged, inConflict, type ConflictGroup } from "./model.ts";
import { el, escapeHtml, clear } from "../dom.ts";

const EVIDENCE_LABEL: Record<string, string> = { E0: "E0", E1: "E1", E2: "E2" };
const FACT_STATUS_LABEL: Record<string, string> = {
  candidate: "候选",
  verified: "已核实",
  challenged: "被质疑",
  retired: "已废弃",
};

function factCard(f: FactView, conflicts: ConflictGroup[]): HTMLElement {
  const cls = ["fact"];
  if (isChallenged(f) || inConflict(conflicts, f.id)) cls.push("fact-conflict");
  cls.push(`fact-${f.status}`);
  const head = el("div", { class: "fact-head" }, [
    el("span", { class: `badge ev-${f.evidence}` }, EVIDENCE_LABEL[f.evidence] ?? f.evidence),
    el("span", { class: `badge fact-status fact-${f.status}` }, FACT_STATUS_LABEL[f.status] ?? f.status),
    f.by ? el("span", { class: "fact-by" }, `by ${escapeHtml(f.by)}`) : null,
  ]);
  const body = el("div", { class: "fact-content" }, f.content);
  const witness = f.witness ? el("div", { class: "fact-witness" }, `witness: ${escapeHtml(f.witness)}`) : null;
  return el("li", { class: cls.join(" "), "data-id": f.id }, [head, body, witness]);
}

export function createBoard(container: HTMLElement, ctx: UiCtx): { dispose(): void } {
  function render(): void {
    const st = ctx.store.get();
    const conflicts = findConflicts(st.facts);
    clear(container);

    // —— 整板为空时给一条醒目的总览，再照常渲染四区结构 ——
    const boardIsEmpty =
      st.facts.length === 0 && st.deadEnds.length === 0 && st.intents.length === 0 && st.leases.length === 0;
    if (boardIsEmpty) {
      container.appendChild(
        el("div", { class: "board-empty-banner" }, [
          el("div", { class: "board-empty-title" }, "黑板为空"),
          el("div", { class: "board-empty-desc" }, "还没有任何台账记录。会话开始后，agent 会把事实 / 死路 / 意图 / 租约写到这里；互相冲突的事实会并列高亮。"),
        ]),
      );
    }

    // —— 事实 ——
    const factsUl = el("ul", { class: "board-list facts" });
    for (const f of st.facts) factsUl.appendChild(factCard(f, conflicts));
    if (st.facts.length === 0) factsUl.appendChild(el("li", { class: "board-empty" }, "暂无事实"));

    // —— 死路 ——
    const deadUl = el("ul", { class: "board-list deadends" });
    for (const d of st.deadEnds) {
      deadUl.appendChild(
        el("li", { class: "deadend", "data-id": d.id }, [
          el("div", { class: "deadend-desc" }, d.description),
          d.reopenWhen ? el("div", { class: "deadend-reopen" }, `reopen_when: ${escapeHtml(d.reopenWhen)}`) : null,
          d.by ? el("div", { class: "deadend-by" }, `by ${escapeHtml(d.by)}`) : null,
        ]),
      );
    }
    if (st.deadEnds.length === 0) deadUl.appendChild(el("li", { class: "board-empty" }, "暂无死路"));

    // —— 意图 ——
    const intentsUl = el("ul", { class: "board-list intents" });
    for (const i of st.intents) {
      intentsUl.appendChild(
        el("li", { class: `intent intent-${i.status}`, "data-id": i.id }, [
          el("div", { class: "intent-desc" }, i.description),
          el("div", { class: "intent-meta" }, [
            el("span", { class: "badge" }, i.status),
            i.claimedBy ? el("span", { class: "intent-claimed" }, `claimed by ${escapeHtml(i.claimedBy)}`) : null,
          ]),
        ]),
      );
    }
    if (st.intents.length === 0) intentsUl.appendChild(el("li", { class: "board-empty" }, "暂无意图"));

    // —— 租约 ——
    const leasesUl = el("ul", { class: "board-list leases" });
    for (const l of st.leases) {
      const remain = l.expiresAt - Date.now();
      leasesUl.appendChild(
        el("li", { class: "lease", "data-resource": l.resource }, [
          el("div", { class: "lease-resource" }, l.resource),
          el("div", { class: "lease-meta" }, `holder ${escapeHtml(l.holder)} · 剩余 ${Math.max(0, Math.round(remain / 1000))}s`),
        ]),
      );
    }
    if (st.leases.length === 0) leasesUl.appendChild(el("li", { class: "board-empty" }, "暂无租约"));

    container.appendChild(
      el("div", { class: "board-section" }, [
        el("h3", { class: "board-title" }, `事实 · ${st.facts.length}`),
        factsUl,
      ]),
    );
    container.appendChild(
      el("div", { class: "board-section" }, [
        el("h3", { class: "board-title" }, `死路 · ${st.deadEnds.length}`),
        deadUl,
      ]),
    );
    container.appendChild(
      el("div", { class: "board-section" }, [
        el("h3", { class: "board-title" }, `意图 · ${st.intents.length}`),
        intentsUl,
      ]),
    );
    container.appendChild(
      el("div", { class: "board-section" }, [
        el("h3", { class: "board-title" }, `租约 · ${st.leases.length}`),
        leasesUl,
      ]),
    );
  }

  const unsub = ctx.store.subscribeWorkspace(render);
  render();
  return { dispose: unsub };
}
