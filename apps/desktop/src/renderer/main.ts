/**
 * 渲染进程入口（由 renderer.html 以 module 方式加载）。
 *
 * 布局（T6）：三栏
 *   左：任务树 + 会话列表 + 加号（扇出）
 *   中：多窗格（每会话一个，T7）
 *   右：审批队列（T8）+ 黑板台账（T9）
 */
import type { HubEvent } from "./contract.ts";
import { resolveHub, isMock } from "./hub.ts";
import {
  Store,
  emptyState,
  applySnapshot,
  applyEvent,
  buildSkillStatusView,
  buildBriefingPreview,
  buildScopeStatusView,
  buildScoreboardView,
} from "./store.ts";
import type { UiCtx } from "./ctx.ts";
import { el, clear } from "./dom.ts";
import { buildTargetBadge, renderTargetsPanel } from "./targets.ts";
import { sessionStatusLabel, taskStatusLabel } from "./session-status.ts";
import { createPanes, type PanesApi } from "./panes/panes.ts";
import { createArtifactsPanel, renderAttachmentList } from "./artifacts.ts";
import { createFlagsPanel } from "./flags.ts";
import { createAwdPanel } from "./awd/panel.ts";
import { createIrPanel } from "./ir/panel.ts";
import { createStrategyPanel } from "./strategy/panel.ts";
import { createApprovals } from "./approval/approval.ts";
import { createBoard } from "./board/board.ts";
import { openFanoutModal } from "./fanout/fanout.ts";
import {
  buildTaskBoardView,
  openTaskArchiveModal,
  openTaskModal,
  openTaskStatusModal,
  openTaskStopAllModal,
  openTaskSwitchModal,
} from "./task.ts";
import { buildScorecard, scorecardTextCompact, scorecardTitle } from "./scorecard.ts";
import { gateBadge } from "./gate.ts";
import { showFirstRunGuide } from "./first-run.ts";
import { notify } from "./notice.ts";
import { openPermissionModal } from "./permission/grants.ts";
import type { TaskBoardRow } from "./task.ts";
import { createCompetitionUi } from "./competition/dashboard.ts";

/** P1-E：归档区默认折叠；展开状态是纯 UI 状态，不写回主进程。 */
let taskBoardArchivedOpen = false;
/** P2-C：技能库明细默认收起；点顶部状态条展开 root / packages。 */
let skillDetailOpen = false;
/** P4-D：焦点任务目标面板默认收起；任务卡徽标点击展开。 */
let targetsPanelOpen = false;

const ACTIVE_SESSION_STATUS = new Set(["starting", "idle", "running", "waiting_approval", "waiting_lease"]);

/** R13：左栏某个引擎旁的「＋」—— 用该 agent 直接起一个会话（lead · guarded，唯一从零到有产出的路径）。 */
function startAgentSession(ctx: UiCtx, agentId: string): void {
  const taskId = ctx.store.get().task?.id;
  if (!taskId) {
    notify("先新建任务，才能起会话", "error");
    return;
  }
  notify("正在启动会话…（首次启动 agent 可能需几秒到几十秒）", "info");
  void ctx.hub
    .dispatch({ type: "session.start", taskId, agent: agentId, role: "lead", tier: "guarded" })
    .then((res) => {
      if (!res?.ok) notify(`启动失败：${res?.error ?? "未知错误"}`, "error");
    });
}

function renderLeft(container: HTMLElement, ctx: UiCtx): void {
  const st = ctx.store.get();
  clear(container);

  // —— P2-C 技能库状态：顶部常驻指示，点击展开 root / packages。——
  // 数据来自 HubSnapshot.skill?（P2-A）；旧快照没有该字段时显示「未知/未检测」，
  // 不误报为「未配置」，也不阻塞创建任务/启动会话。未配置只是提示。
  const skill = buildSkillStatusView(st);
  const skillBadge =
    skill.kind === "configured"
      ? "已配置"
      : skill.kind === "unconfigured"
        ? "未配置"
        : skill.kind === "error"
          ? "错误"
          : "未检测";
  const skillRow = el(
    "button",
    {
      class: `policy-pack${skill.kind === "configured" ? "" : " policy-pack-none"}`,
      type: "button",
      "data-skill-kind": skill.kind,
      title: `${skill.title}\n点击${skillDetailOpen ? "收起" : "展开"} root / packages`,
    },
    [
      el("span", { class: "policy-pack-label" }, "技能库"),
      el(
        "span",
        { class: "policy-pack-name" },
        skill.kind === "configured" ? `${skill.packageCount} 个包` : skill.label,
      ),
      el(
        "span",
        { class: skill.kind === "configured" ? "policy-pack-armed" : "policy-pack-fallback" },
        skillBadge,
      ),
    ],
  );
  skillRow.addEventListener("click", () => {
    skillDetailOpen = !skillDetailOpen;
    renderLeft(container, ctx);
  });
  container.appendChild(skillRow);
  // 顶部摘要：已配置时含 root + 包数 + 索引时间；未配置/错误/未检测各有明确文案。
  container.appendChild(
    el("div", { class: "task-form-current", "data-skill-headline": skill.kind, title: skill.title }, skill.headline),
  );
  if (skillDetailOpen) {
    container.appendChild(
      el("div", { class: "task-form-current", "data-skill-detail": "1" }, skill.detail),
    );
  }

  // —— 当前策略规则包（数据来自 snapshot.policy，缺席显示「—」）。
  // R11：新手会问「闸门到底武装了没有」—— 光看包名不知道。真实规则包在跑时补一个
  // 「已武装」绿标；回落最小安全集时给黄字（fellBackToMinimal）。——
  container.appendChild(
    el(
      "div",
      { class: st.policy ? "policy-pack" : "policy-pack policy-pack-none", title: "当前生效的策略规则包（闸门）" },
      [
        el("span", { class: "policy-pack-label" }, "规则包"),
        el("span", { class: "policy-pack-name" }, st.policy ? st.policy.name : "—"),
        st.policy && !st.policy.fellBackToMinimal
          ? el("span", { class: "policy-pack-armed" }, "已武装")
          : null,
        st.policy?.fellBackToMinimal
          ? el("span", { class: "policy-pack-fallback" }, "已回落最小安全集")
          : null,
      ],
    ),
  );

  // —— P4-D 范围状态：enabled=false 明确写“仅展示与审计”；旧快照写“未知”。——
  // P6-B 批次 2b：代理行按真实 state 显示；failed 用红色错误色，running 用绿色。
  const scopeView = buildScopeStatusView(st);
  const proxyClass =
    scopeView.proxyTone === "ok"
      ? "policy-pack-name policy-pack-armed"
      : scopeView.proxyTone === "error"
        ? "policy-pack-name status-failed"
        : scopeView.proxyTone === "warn"
          ? "policy-pack-name policy-pack-fallback"
          : "policy-pack-label";
  container.appendChild(
    el(
      "div",
      {
        class: `policy-pack scope-pack${scopeView.kind === "enabled" ? "" : " policy-pack-none"}`,
        "data-scope-kind": scopeView.kind,
        "data-proxy-state": scopeView.proxyState,
        title: scopeView.title,
      },
      [
        el("span", { class: "policy-pack-label" }, "范围"),
        el("span", { class: "policy-pack-name" }, scopeView.headline),
        el(
          "span",
          { class: scopeView.kind === "enabled" ? "policy-pack-armed" : "policy-pack-fallback" },
          scopeView.badge,
        ),
        el(
          "span",
          {
            class: proxyClass,
            "data-proxy-state": scopeView.proxyState,
            title: scopeView.proxyTitle,
          },
          scopeView.proxyText,
        ),
      ],
    ),
  );

  // —— 引擎列表（R13）：左栏直接列出本机已检测到的 agent，每个带一个「＋」按该 agent 起会话 ——
  // 未安装的灰显 + 附安装提示，其「＋」禁用。数据源 snapshot.agents（§6 检测结果，只检测不安装）。
  // 权限增强：已授权的 agent 额外显示「授权 N」，点开可逐条撤销。
  const grantsByAgent = new Map<string, number>();
  for (const g of st.permissionGrants) {
    grantsByAgent.set(g.agentId, (grantsByAgent.get(g.agentId) ?? 0) + 1);
  }
  const agentList = el("ul", { class: "agent-list" });
  for (const a of st.agents) {
    const canStart = a.installed && Boolean(st.task);
    const grantCount = grantsByAgent.get(a.id) ?? 0;
    const startBtn = el(
      "button",
      {
        class: "agent-start-btn",
        "data-agent": a.id,
        disabled: canStart ? null : "",
        title: a.installed
          ? st.task
            ? `用 ${a.title} 起一个会话（lead · guarded）`
            : "先新建任务，才能起会话"
          : `未安装：${a.installHint}`,
      },
      "+",
    );
    if (canStart) startBtn.addEventListener("click", () => startAgentSession(ctx, a.id));
    const permBtn =
      grantCount > 0
        ? el(
            "button",
            {
              class: "agent-perm-btn",
              "data-agent": a.id,
              title: `管理 ${a.title} 的「一键放行」授权（${grantCount} 条）`,
            },
            `授权 ${grantCount}`,
          )
        : null;
    permBtn?.addEventListener("click", () => openPermissionModal(ctx, a.id));
    agentList.appendChild(
      el(
        "li",
        {
          class: `agent-item ${a.installed ? "agent-installed" : "agent-unavailable"}`,
          "data-agent": a.id,
          title: a.installed ? a.maturity : `未安装：${a.installHint}`,
        },
        [
          el("div", { class: "agent-item-main" }, [
            el("span", { class: "agent-title" }, a.title),
            a.installed ? null : el("span", { class: "agent-hint" }, a.installHint),
          ]),
          el("div", { class: "agent-item-actions" }, [permBtn, startBtn]),
        ],
      ),
    );
  }
  if (st.agents.length === 0) {
    agentList.appendChild(el("li", { class: "agent-list-empty" }, "未检测到引擎"));
  }
  // 撤销入口始终存在：即使某个 agent 的授权数为 0，也能从这里查看规则说明。
  const managePermBtn = el(
    "button",
    { class: "btn btn-perm-manage", title: "查看 / 撤销本会话和按 agent 的永久授权" },
    st.permissionGrants.length > 0 ? `授权管理（${st.permissionGrants.length}）` : "授权管理",
  );
  managePermBtn.addEventListener("click", () => openPermissionModal(ctx));
  container.appendChild(
    el("section", { class: "panel agent-panel" }, [
      el("h2", { class: "panel-title" }, "引擎"),
      agentList,
      el("div", { class: "agent-perm-manage-row" }, [managePermBtn]),
    ]),
  );

  // —— P1-E 任务看板：全量任务（含 archived）都在这里；焦点高亮、后台在跑数、配额、归档折叠 ——
  const boardView = buildTaskBoardView(st, { archivedOpen: taskBoardArchivedOpen });
  const makeBoardRow = (row: TaskBoardRow): HTMLElement => {
    const item = el(
      "li",
      {
        class:
          `task-board-item${row.isFocus ? " task-board-focus" : ""}` +
          `${row.isArchived ? " task-board-archived" : ""}`,
        "data-task-id": row.id,
        "data-focus": row.isFocus ? "1" : "0",
        "data-archived": row.isArchived ? "1" : "0",
        title: row.isArchived
          ? `已归档任务（历史保留）：${row.title}`
          : row.isFocus
            ? `当前焦点：${row.title}`
            : `点击切到「${row.title}」`,
      },
      [
        el("div", { class: "task-board-main" }, [
          el("div", { class: "task-board-title" }, row.title),
          el("div", { class: "task-board-badges" }, [
            el("span", { class: "task-category" }, row.categoryLabel),
            el(
              "span",
              { class: `task-board-status task-status-${row.task.status}` },
              row.statusLabel,
            ),
            row.isFocus ? el("span", { class: "task-focus-tag" }, "焦点") : null,
            !row.isFocus && row.running > 0
              ? el("span", { class: "task-bg-tag", title: "非焦点任务中正在运行的会话" }, `后台 ${row.running} 在跑`)
              : null,
            row.flagCount > 0
              ? el(
                  "span",
                  {
                    class: "task-flag-tag task-flag-count-tag",
                    title: `持久化 flag 候选 ${row.flagCount} 个（确认/误报后变化）`,
                    "data-flag-count": String(row.flagCount),
                  },
                  `Flag ${row.flagCount}`,
                )
              : row.flagCandidate
                ? el("span", { class: "task-flag-tag", title: "自动识别到的 flag 候选，未经人工确认" }, "flag 候选")
                : null,
            row.attachmentCount > 0
              ? el("span", { class: "task-attachment-tag", title: "已导入附件数量" }, `附件 ${row.attachmentCount}`)
              : null,
            row.isArchived ? el("span", { class: "task-archived-tag" }, "已归档") : null,
          ]),
          el("div", { class: "task-board-counts" }, `${row.running}/${row.total} 会话`),
          row.isArchived && row.task.answer
            ? el("div", { class: "task-board-answer" }, ["答案：", el("code", {}, row.task.answer)])
            : null,
        ]),
        row.isArchived
          ? null
          : el("div", { class: "task-board-actions" }, [
              row.isFocus
                ? null
                : el("button", { class: "btn btn-small btn-task-focus", "data-act": "focus" }, "聚焦"),
              row.running > 0
                ? el("button", { class: "btn btn-small btn-task-stop-all", "data-act": "stop-all" }, "停止全部")
                : null,
              el("button", { class: "btn btn-small btn-task-archive", "data-act": "archive" }, "归档"),
            ]),
      ],
    );
    if (!row.isArchived && !row.isFocus) {
      item.addEventListener("click", () => {
        void ctx.hub.dispatch({ type: "task.focus", taskId: row.id }).then((res) => {
          if (!res?.ok) notify(`切换焦点失败：${res?.error ?? "未知错误"}`, "error");
        });
      });
    }
    item.querySelector('[data-act="focus"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      void ctx.hub.dispatch({ type: "task.focus", taskId: row.id }).then((res) => {
        if (!res?.ok) notify(`切换焦点失败：${res?.error ?? "未知错误"}`, "error");
      });
    });
    item.querySelector('[data-act="stop-all"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      openTaskStopAllModal(ctx, row.task);
    });
    item.querySelector('[data-act="archive"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      openTaskArchiveModal(ctx, row.task);
    });
    return item;
  };

  const boardList = el("ul", { class: "task-board-list" });
  for (const row of boardView.active) boardList.appendChild(makeBoardRow(row));
  if (boardView.active.length === 0) {
    boardList.appendChild(
      el("li", { class: "task-board-empty" }, "无活跃任务；已归档任务可在下方展开查看历史。"),
    );
  }
  const archiveToggle =
    boardView.archived.length > 0
      ? el(
          "button",
          {
            class: `btn btn-small task-archive-toggle${boardView.archivedOpen ? " on" : ""}`,
            "data-act": "toggle-archived",
            "aria-expanded": boardView.archivedOpen ? "true" : "false",
          },
          `${boardView.archivedOpen ? "▾" : "▸"} 已归档（${boardView.archived.length}）`,
        )
      : null;
  archiveToggle?.addEventListener("click", () => {
    taskBoardArchivedOpen = !taskBoardArchivedOpen;
    renderLeft(container, ctx);
  });
  const archivedList = el("ul", { class: "task-board-list task-board-archived-list" });
  if (boardView.archivedOpen) {
    for (const row of boardView.archived) archivedList.appendChild(makeBoardRow(row));
  }
  container.appendChild(
    el("section", { class: "panel task-board-panel" }, [
      el("div", { class: "task-board-head" }, [
        el("h2", { class: "panel-title" }, "任务看板"),
        el("div", { class: "task-board-summary" }, [
          el(
            "span",
            {
              class: `task-background${boardView.backgroundRunning > 0 ? " on" : ""}`,
              title: "非焦点任务中正在运行的会话数（后台继续跑，不占本页 DOM）",
            },
            `后台 ${boardView.backgroundRunning} 个在跑`,
          ),
          boardView.quota
            ? el(
                "span",
                {
                  class: `task-quota${boardView.quota.nearLimit ? " near" : ""}`,
                  title: boardView.quota.title,
                },
                `配额 ${boardView.quota.totalText} · 每任务 ${boardView.quota.perTaskText}`,
              )
            : el(
                "span",
                { class: "task-quota task-quota-none", title: "旧快照没有配额字段；主进程接入后显示" },
                "配额 —",
              ),
        ]),
      ]),
      boardList,
      archiveToggle,
      boardView.archivedOpen ? archivedList : null,
    ]),
  );

  // —— 任务树 ——
  // R-3：新手要能把自动种下的示例任务换成自己 09:00 的真实挑战。契约有 task.create，
  // 这里只补一个最小入口（弹窗填标题 + 简报）；主进程 setTask + task.upsert 后这里重绘。
  const newTaskBtn = el("button", { class: "btn btn-task-new", title: "新建任务并切换为当前任务" }, "＋ 新任务");
  newTaskBtn.addEventListener("click", () => openTaskModal(ctx));
  // R19/P1-B：有一个以上**非归档**任务时才给「切换」入口；切题只切焦点、不停会话。
  const switchableTasks = st.tasks.filter((t) => t.archived !== true);
  const switchBtn =
    switchableTasks.length > 1
      ? el("button", { class: "btn btn-task-switch", title: "切换焦点到另一个任务（不会停任何会话）" }, "切换")
      : null;
  switchBtn?.addEventListener("click", () => openTaskSwitchModal(ctx));
  const taskHead = el("div", { class: "task-head" }, [el("h2", { class: "panel-title" }, "任务"), switchBtn, newTaskBtn]);
  if (st.task) {
    const task = st.task;
    const solveBtn = el(
      "button",
      { class: "btn btn-task-solve", title: "人工确认 flag / 任务是否解出" },
      task.status === "solved" ? "修改答案" : "标记已解出",
    );
    solveBtn.addEventListener("click", () => openTaskStatusModal(ctx, task));
    // P4-D：目标数徽标只给焦点任务（非焦点任务快照没有 targets 列表）。
    const targetBadge = buildTargetBadge(task);
    const targetToggleBtn = targetBadge
      ? el(
          "button",
          {
            class: "btn btn-small",
            "data-act": "targets-toggle",
            "data-target-count": targetBadge.count === null ? "unknown" : String(targetBadge.count),
            title: targetBadge.title,
          },
          targetBadge.text,
        )
      : null;
    targetToggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      targetsPanelOpen = !targetsPanelOpen;
      renderLeft(container, ctx);
    });
    const focusFlagCount =
      typeof task.flagCount === "number" ? Math.max(0, task.flagCount) : st.flags.length;
    const statusRow = el("div", { class: "task-status-row" }, [
      el(
        "span",
        { class: `task-status-badge task-status-${task.status}`, title: "任务状态（人工确认）" },
        taskStatusLabel(task.status),
      ),
      task.answer ? el("code", { class: "task-answer", title: "人工确认的 flag / 答案" }, task.answer) : null,
      focusFlagCount > 0
        ? el(
            "span",
            {
              class: "task-flag-tag task-flag-count-tag",
              title: `持久化 flag 候选 ${focusFlagCount} 个；见右栏 Flag 候选面板`,
              "data-flag-count": String(focusFlagCount),
            },
            `Flag ${focusFlagCount}`,
          )
        : null,
      // 已解出也要保留入口：可以改答案或改回待解。
      solveBtn,
      targetToggleBtn,
    ]);
    const candidateNote =
      task.flagCandidate && task.status !== "solved"
        ? el("div", { class: "task-flag-candidate", title: "自动识别，未经人工确认" }, [
            "检测到 flag 候选：",
            el("code", {}, task.flagCandidate),
            "（确认请点「标记已解出」）",
          ])
        : null;
    const focusRow = boardView.focus;
    const focusRunning = focusRow?.running ?? st.sessions.filter((s) => ACTIVE_SESSION_STATUS.has(s.status)).length;
    const focusTotal = focusRow?.total ?? st.sessions.length;
    const focusMeta = el(
      "div",
      { class: "task-focus-meta", title: "题型 / 优先级 / 本任务会话数（焦点视图）" },
      `${focusRow?.categoryLabel ?? "未分类"} · 优先级 ${task.priority ?? 0} · ${focusRunning}/${focusTotal} 会话`,
    );
    // V2-P0-2：答案格式摘要；未配置时不显示（旧任务行为不变）。
    const answerSpecNote = task.answerSpec
      ? el(
          "div",
          { class: "task-status-hint", "data-answer-spec": "1", title: "任务级 AnswerSpec；候选仍需人工确认" },
          `答案格式：${task.answerSpec.mode}/${task.answerSpec.answerType ?? "flag"}` +
            `${task.answerSpec.pattern ? ` · ${task.answerSpec.pattern}` : ""}` +
            ` · 证据 ≥ ${task.answerSpec.requiredEvidence ?? "E1"}`,
        )
      : null;
    // P2-C：技能库未配置/错误时，任务卡也明确提示（提示不是禁用，仍可起会话）。
    const skillView = buildSkillStatusView(st);
    const skillWarningNote =
      skillView.showWarning && skillView.warningText
        ? el("div", { class: "task-status-hint", "data-skill-warning": "task" }, skillView.warningText)
        : null;
    // P2-C 简报预览（可选字段）：只给标题 / 路径条数 / 工具可用性 / 证据约定摘要，不展示全文。
    const briefing = buildBriefingPreview(st);
    const briefingNote = briefing
      ? el(
          "div",
          {
            class: "task-workdir",
            title: "简报预览：只显示标题 / 路径条数 / 工具可用性 / 证据约定摘要，不展示全文",
          },
          [
            "简报预览：",
            el("code", {}, briefing.playbookTitle),
            ` · skill_routing ${briefing.routingText} · knowledge_tools ${briefing.knowledgeToolsText}`,
            briefing.evidenceSummary
              ? el("div", { class: "task-status-hint" }, `证据约定：${briefing.evidenceSummary}`)
              : null,
          ],
        )
      : null;
    const stopAllBtn = el(
      "button",
      { class: "btn btn-small btn-task-stop-all", title: "只停止当前焦点任务的会话，不影响其他任务" },
      `停止本任务会话${focusRunning > 0 ? `（${focusRunning}）` : ""}`,
    );
    stopAllBtn.addEventListener("click", () => openTaskStopAllModal(ctx, task));
    const archiveBtn = el(
      "button",
      { class: "btn btn-small btn-task-archive", title: "归档当前任务；有活会话时会先确认 force" },
      "归档任务",
    );
    archiveBtn.addEventListener("click", () => openTaskArchiveModal(ctx, task));
    const taskAdmin = el("div", { class: "task-admin-row" }, [stopAllBtn, archiveBtn]);
    // R27（A1）：任务卡显示任务专属目录（同任务多会话共享、跨任务隔离）；
    // 契约缺席时退回快照根目录。
    const taskWorkDir = task.workDir ?? st.workDir;
    const workDirNote = taskWorkDir
      ? el("div", { class: "task-workdir", title: "该任务专属的 agent 工作目录（同任务会话共享、跨任务隔离）" }, [
          "工作目录：",
          el("code", {}, taskWorkDir),
        ])
      : null;
    // P3-C：焦点任务卡显示附件摘要；完整列表/预览在右栏工件面板。
    const focusAttachments = st.attachments.length > 0 ? st.attachments : (task.attachments ?? []);
    const attachmentList = renderAttachmentList(focusAttachments);
    // P4-D：目标面板只在用户点开时插入；数据仍来自焦点任务快照。
    const targetPanel = targetsPanelOpen ? renderTargetsPanel(ctx, task) : null;
    container.appendChild(
      el("section", { class: "panel task-card" }, [
        taskHead,
        el("div", { class: "task-title" }, task.title),
        el("div", { class: "task-brief" }, task.brief),
        focusMeta,
        answerSpecNote,
        skillWarningNote,
        briefingNote,
        statusRow,
        candidateNote,
        task.answer ? null : el("div", { class: "task-status-hint" }, "解出 flag 后点「标记已解出」，任务栏会从「待解」变「已解出」。"),
        taskAdmin,
        workDirNote,
        attachmentList,
        targetPanel,
      ]),
    );
  } else {
    container.appendChild(
      el("section", { class: "panel task-card task-card-none" }, [
        taskHead,
        el("div", { class: "task-none task-none-title" }, "无活跃任务"),
        el(
          "div",
          { class: "task-status-hint" },
          "所有任务已归档，或还没有任务。点「＋ 新任务」继续；已归档任务可在上方任务看板展开查看历史。",
        ),
        st.workDir ? el("div", { class: "task-workdir" }, ["工作目录：", el("code", {}, st.workDir)]) : null,
      ]),
    );
  }

  // —— 会话列表 ——
  const list = el("ul", { class: "session-list" });
  for (const s of st.sessions) {
    // blocked 是策略切断（§9.6 拒绝退避）的终态，跟 failed（崩溃）/ stopped（人工停止）分开：
    // 文案用「被策略切断」，卡片给红边框 + title 说明，绝不能画得像个崩溃。
    const blocked = s.status === "blocked";
    // R-5：闸门是否真的武装（会问/不会问）由 agent + tier 推导，见 gate.ts 顶部的同步注释。
    const gate = gateBadge(s.agent, s.tier);
    // 每会话计分卡（紧凑版）：徽标行下方一行小字，一眼看到「跑了多久 + 干了多少活」。
    // 完整六字段在窗格头部条里，这里只留三个最直观的。
    const sc = buildScorecard({
      session: s,
      health: st.health[s.id],
      approvals: st.approvals,
      facts: st.facts,
      deadEnds: st.deadEnds,
      now: Date.now(),
    });
    list.appendChild(
      el(
        "li",
        {
          class: `session-item session-${s.status}`,
          "data-id": s.id,
          title: blocked
            ? "该会话因同一动作被策略连续拒绝，已按 §9.6 拒绝退避终止（策略切断，非崩溃）"
            : null,
        },
        [
          el("div", { class: "session-badges" }, [
            el("span", { class: "session-agent" }, s.agent),
            el("span", { class: `badge role-${s.role}` }, s.role),
            el("span", { class: `badge tier-${s.tier}` }, s.tier),
            el("span", { class: `badge ${gate.cls}`, title: gate.title }, gate.text),
            el("span", { class: `badge status-${s.status}` }, sessionStatusLabel(s.status)),
          ]),
          el("div", { class: "session-scorecard", "data-session": s.id, title: scorecardTitle(sc) }, scorecardTextCompact(sc)),
        ],
      ),
    );
  }
  if (st.sessions.length === 0) {
    list.appendChild(
      el("li", { class: "session-empty" }, [
        el("div", { class: "session-empty-title" }, st.task ? "还没有会话" : "无活跃任务"),
        el(
          "div",
          { class: "session-empty-hint" },
          st.task
            ? "下一步：点下方「+ 扇出」起第一个会话（选 agent + 角色 + 档位）。"
            : "先在上方点「＋ 新任务」创建任务，才能起会话。",
        ),
      ]),
    );
  }
  container.appendChild(
    el("section", { class: "panel session-panel" }, [el("h2", { class: "panel-title" }, "会话"), list]),
  );

  // —— 加号（扇出）：没有会话时是明显的下一步 ——
  const firstSession = st.sessions.length === 0;
  const usableAgents = st.agents.filter((a) => a.installed).length;
  const notInstalledAgents = st.agents.length - usableAgents;
  container.appendChild(
    el("div", { class: "agents-summary" }, `引擎可用 ${usableAgents} · 未安装 ${notInstalledAgents}`),
  );
  const plus = el(
    "button",
    {
      class: `${firstSession ? "btn-plus btn-plus-primary" : "btn-plus"}${st.task ? "" : " btn-plus-disabled"}`,
      title: st.task ? "扇出会话（agent + 角色 + 档位）" : "先新建任务，才能起会话",
      disabled: st.task ? null : "",
    },
    [
      el("span", { class: "btn-plus-icon" }, "+ 扇出会话"),
      el("span", { class: "btn-plus-hint" }, st.task ? (firstSession ? "起第一个会话" : "再加一个") : "先新建任务"),
    ],
  );
  if (st.task) plus.addEventListener("click", () => openFanoutModal(ctx));
  else plus.addEventListener("click", () => notify("先新建任务，才能起会话", "error"));
  container.appendChild(plus);
}

/**
 * P5-D：记分板面板（只读）。
 *
 * 折叠时只显示摘要「已解 N/M · X 分」；展开后列任务（title/status/points/flagCount）。
 * 归档任务保留并灰显（与批次 1 的 scoreboard 语义一致），不改任何任务状态。
 */
function createScoreboardPanel(container: HTMLElement, ctx: UiCtx): { dispose(): void } {
  let expanded = false;
  const summaryBtn = el(
    "button",
    {
      class: "btn btn-small scoreboard-summary",
      type: "button",
      "data-act": "scoreboard-toggle",
      title: "记分板：已解/总数/总分；点击展开任务列表",
    },
    "记分板 —",
  );
  const body = el("div", { class: "scoreboard-body" });
  container.append(summaryBtn, body);

  function render(): void {
    const state = ctx.store.get();
    const view = buildScoreboardView(state);
    summaryBtn.disabled = view.kind !== "ready";
    summaryBtn.textContent =
      view.kind === "ready" ? `${view.summaryText} ${expanded ? "▾" : "▸"}` : "记分板未知";
    clear(body);
    if (view.kind === "unknown") {
      body.appendChild(
        el("div", { class: "artifact-empty" }, view.unknownText ?? "记分板未知"),
      );
      return;
    }
    if (!expanded) return;
    const list = el("ul", { class: "scoreboard-list" });
    for (const row of view.tasks) {
      list.appendChild(
        el(
          "li",
          {
            class:
              `task-board-item scoreboard-row${row.archived ? " task-board-archived" : ""}` +
              `${row.isFocus ? " task-board-focus" : ""}`,
            "data-scoreboard-task": row.taskId,
            "data-archived": row.archived ? "1" : "0",
            "data-points": String(row.points),
            "data-flag-count": String(row.flagCount),
          },
          [
            el("div", { class: "task-board-main" }, [
              el("div", { class: "task-board-title" }, row.title),
              el("div", { class: "task-board-badges" }, [
                el(
                  "span",
                  { class: `task-board-status task-status-${row.status}` },
                  taskStatusLabel(row.status),
                ),
                el("span", { class: "task-quota" }, `${row.points} 分`),
                el("span", { class: "task-flag-tag" }, `Flag ${row.flagCount}`),
                row.archived ? el("span", { class: "task-archived-tag" }, "已归档") : null,
                row.isFocus ? el("span", { class: "task-focus-tag" }, "焦点") : null,
              ]),
            ]),
          ],
        ),
      );
    }
    body.appendChild(list);
  }

  summaryBtn.addEventListener("click", () => {
    expanded = !expanded;
    render();
  });
  const unsubscribe = ctx.store.subscribeWorkspace(render);
  render();
  return { dispose: unsubscribe };
}

/**
 * P6-C 2.1 / D5.2：renderer 侧可观测性。
 *
 * - PerformanceObserver(longtask)：>100ms 的长任务写 console.warn，主进程的
 *   console-message 会转发到 [renderer:...] 日志；
 * - 5s heartbeat：主进程据此判断 renderer 主线程是否长时间没让出事件循环
 *   （批次 2 run 2 页面卡住时 main-process RSS/lag 稳定，unresponsive 也没触发，
 *   只有 CDP evaluate 超时；heartbeat missing 是更直接的信号）。
 * 只打日志，不改变 UI 行为。
 */
function startRendererObservability(): void {
  try {
    if (typeof PerformanceObserver !== "undefined") {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 100) {
            console.warn(
              `[renderer longtask] duration=${entry.duration.toFixed(1)}ms name=${entry.name}`,
            );
          }
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    /* longtask 不可用（旧 Chromium/测试环境）：只保留 heartbeat */
  }
  let lastBeat = performance.now();
  let lastVisibility = document.visibilityState;
  setInterval(() => {
    const now = performance.now();
    const gapMs = Math.max(0, now - lastBeat);
    lastBeat = now;
    const visibility = document.visibilityState;
    const prevVisibility = lastVisibility;
    lastVisibility = visibility;
    // D7a：把 renderer 自己的 5s 间隔实测值一起上报。main 侧据此区分
    // 「窗口 hidden 被 Chromium 节流」与「visible 时真的 stall」。
    // throttled：当前或上一拍处于 hidden，60s gap 是后台 timer 节流，不是主线程卡死。
    const throttled =
      visibility === "hidden" || prevVisibility === "hidden" ? 1 : 0;
    console.log(
      `[renderer heartbeat] visibility=${visibility} prevVisibility=${prevVisibility} gapMs=${gapMs.toFixed(0)} throttled=${throttled}`,
    );
  }, 5000);
}

export async function bootstrap(): Promise<void> {
  startRendererObservability();
  const app = document.getElementById("app");
  if (!app) return;

  const hub = resolveHub();
  const store = new Store(emptyState());
  const ctx: UiCtx = { hub, store };

  app.dataset.view = "competition";
  const competitionRoot = el("section", { class: "competition-view" });
  const workspaceRoot = el("section", { class: "workspace-view" });
  const workspaceGrid = el("div", { class: "workspace-grid" });
  const left = el("aside", { class: "col col-left" });
  const center = el("main", { class: "col col-center" });
  const right = el("aside", { class: "col col-right" });
  workspaceGrid.append(left, center, right);
  const workspaceBack = el("button", { class: "workspace-back", type: "button" }, "← 返回赛题面板");
  const workspaceTitle = el("div", { class: "workspace-title" }, "Agent 控制台 · 审批 / 黑板 / 实时会话");
  const workspaceBar = el("header", { class: "workspace-bar" }, [
    workspaceBack,
    workspaceTitle,
    el("span", { class: "workspace-shortcut" }, "每次提示仍在各会话窗格底部发送"),
  ]);
  workspaceRoot.append(workspaceBar, workspaceGrid);
  app.append(competitionRoot, workspaceRoot);

  let firstGuideShown = false;
  let panesApi: PanesApi | null = null;
  const showView = (view: "competition" | "workspace"): void => {
    app.dataset.view = view;
    void ctx.hub.dispatch({ type: "ui.setView", view }).catch(() => undefined);
    if (view === "workspace" && !firstGuideShown) {
      firstGuideShown = true;
      showFirstRunGuide(ctx);
    }
    panesApi?.setVisible(view === "workspace");
    // Hidden views skip store notifications; switching must paint the newly
    // visible view from the current snapshot immediately.
    store.notify();
  };
  const _competition = createCompetitionUi(competitionRoot, ctx, {
    onOpenWorkspace: () => showView("workspace"),
  });
  void _competition;
  workspaceBack.addEventListener("click", () => showView("competition"));

  // 右栏：记分板 + 审批 + 工件 + Flag + 台账
  const scoreboardBody = el("div", { class: "panel-body" });
  right.appendChild(
    el("section", { class: "panel scoreboard-panel" }, [el("h2", { class: "panel-title" }, "记分板"), scoreboardBody]),
  );
  const approvalBody = el("div", { class: "panel-body" });
  right.appendChild(
    el("section", { class: "panel approval-panel" }, [el("h2", { class: "panel-title" }, "审批队列"), approvalBody]),
  );
  // V2-P0-3：作战建议（只读计划 + 勾选后一键应用；默认不自动执行）。
  // P3-C：附件 + 产物 + 只读预览。刷新走 artifact.refresh，后台事件只更新焦点。
  const artifactBody = el("div", { class: "panel-body" });
  right.appendChild(
    el("section", { class: "panel artifact-panel" }, [el("h2", { class: "panel-title" }, "工件"), artifactBody]),
  );
  // P5-C：焦点任务的 flag 候选（确认/误报/导出；不自动提交、不写文件）。
  const flagBody = el("div", { class: "panel-body" });
  right.appendChild(
    el("section", { class: "panel flag-panel" }, [el("h2", { class: "panel-title" }, "Flag 候选"), flagBody]),
  );
  const boardBody = el("div", { class: "panel-body" });
  right.appendChild(
    el("section", { class: "panel board-panel" }, [el("h2", { class: "panel-title" }, "黑板台账"), boardBody]),
  );

  const panes = createPanes(center, ctx);
  panesApi = panes;
  createScoreboardPanel(scoreboardBody, ctx);
  createApprovals(approvalBody, ctx);
  createStrategyPanel(right, ctx);
  createArtifactsPanel(artifactBody, ctx);
  createFlagsPanel(flagBody, ctx);
  createBoard(boardBody, ctx);
  // WP9-B1：category=awd 时显示只读 AWD 面板；其他任务隐藏。
  createAwdPanel(right, ctx);
  // WP9-B2：category=ir 时显示只读 IR 面板（证据板/时间线/问题）。
  createIrPanel(right, ctx);

  renderLeft(left, ctx);
  // P6-C 2.2 / D4：renderLeft 整栏重建按帧合并；store 批量更新后再画一次。
  let leftRenderScheduled = false;
  ctx.store.subscribeWorkspace(() => {
    if (leftRenderScheduled) return;
    leftRenderScheduled = true;
    const run = (): void => {
      leftRenderScheduled = false;
      const t0 = performance.now();
      renderLeft(left, ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.warn(`[ui renderLeft] ${ms.toFixed(1)}ms`);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  });

  // 左栏会话卡里的「已运行 X」要跟着时钟走：store 只在状态变化时触发重绘，静默运行时
  // 时长不会自己涨。用一个低频计时器原地刷新每个卡片的计分卡文字（不整栏重绘，不动弹窗）。
  const leftScorecardTimer = setInterval(() => {
    if (app.dataset.view !== "workspace") return;
    const st = ctx.store.get();
    for (const s of st.sessions) {
      const node = Array.from(left.querySelectorAll<HTMLElement>(".session-scorecard")).find(
        (n) => n.dataset.session === s.id,
      );
      if (!node) continue;
      const sc = buildScorecard({
        session: s,
        health: st.health[s.id],
        approvals: st.approvals,
        facts: st.facts,
        deadEnds: st.deadEnds,
        now: Date.now(),
      });
      node.textContent = scorecardTextCompact(sc);
    }
  }, 5000);

  // 首屏快照
  const snap = await hub.snapshot();
  store.set(applySnapshot(snap, store.get()));

  // 台账的增量刷新走「重新拉快照」：board.appended 只带原始事件（BoardEventView，
  // body 是 unknown），四类视图（事实/死路/意图/租约）必须从快照重算（ARCHITECTURE §8）。
  // 连续多条 board.appended 合并成一次拉取（避免刷屏），但拉取期间又到的不能丢——
  // 记一个「再来一次」，当前这轮结束后补拉，保证最终一致。
  let refetching = false;
  let refetchAgain = false;
  let boardRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  const refetchBoard = (): void => {
    if (refetching) {
      refetchAgain = true;
      return;
    }
    refetching = true;
    void hub
      .snapshot()
      .then((next) => {
        refetching = false;
        // 保留后台 sessionMeta，避免焦点切换后后台计数增量丢失依据。
        store.set(applySnapshot(next, store.get()));
        if (refetchAgain) {
          refetchAgain = false;
          refetchBoard();
        }
      })
      .catch(() => {
        refetching = false;
        refetchAgain = false;
      });
  };
  const scheduleBoardRefetch = (): void => {
    if (boardRefetchTimer) clearTimeout(boardRefetchTimer);
    boardRefetchTimer = setTimeout(() => {
      boardRefetchTimer = null;
      refetchBoard();
    }, 300);
  };

  // P6-C 2.2 / D4：session.upsert/health 批量进 store（100ms 或 200 条），
  // 把 8 个 store 订阅者（renderLeft/panels/panes.sync）的重复整栏重绘压成一批。
  // 审批/权限/flag/artifact/task.upsert 仍立即处理，保证交互反馈不延迟。
  let pendingStoreEvents: HubEvent[] = [];
  let storeFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushStoreEvents = (): void => {
    if (storeFlushTimer) {
      clearTimeout(storeFlushTimer);
      storeFlushTimer = null;
    }
    if (pendingStoreEvents.length === 0) return;
    const batch = pendingStoreEvents;
    pendingStoreEvents = [];
    store.update((s) => {
      let next = s;
      for (const ev of batch) next = applyEvent(next, ev);
      return next;
    });
  };
  const queueStoreEvent = (e: HubEvent): void => {
    pendingStoreEvents.push(e);
    if (pendingStoreEvents.length >= 200) {
      flushStoreEvents();
      return;
    }
    if (!storeFlushTimer) storeFlushTimer = setTimeout(flushStoreEvents, 100);
  };

  // 增量事件：stream 走窗格节流器，台账走重新拉快照，其余进 store。
  // P1-E 的硬规则：任何带 taskId 的后台事件都不能进焦点 UI；stream 连 pane 都不碰。
  hub.onEvent((e: HubEvent) => {
    const focusId = ctx.store.get().task?.id ?? null;
    if (e.type === "session.stream") {
      if (!focusId || (e.taskId && e.taskId !== focusId)) return;
      // R16：历史拉取期间先缓冲，避免「实时块」跑到「历史块」前面。
      panes.pushToSession(e.sessionId, e.update);
      return;
    }
    if (e.type === "board.appended") {
      if (!focusId || (e.taskId && e.taskId !== focusId)) return;
      scheduleBoardRefetch();
      return;
    }
    if (e.type === "session.upsert") {
      // D4：store 更新批量；后台 waiting_approval 的 refetch 仍立即触发。
      queueStoreEvent(e);
      // 主进程的 approval.upsert 仍只推焦点；后台会话进入等审批时拉一次快照，
      // 让全局审批视图（approvalsAll）能及时看到后台任务的审批。
      if (focusId && e.session.taskId !== focusId && e.session.status === "waiting_approval") {
        refetchBoard();
      }
      return;
    }
    if (e.type === "task.upsert") {
      const before = focusId;
      store.update((s) => applyEvent(s, e));
      const after = ctx.store.get().task?.id ?? null;
      // 焦点变化（含切题、归档焦点、全部归档变 null）必须整份重拉，
      // 否则新任务的 sessions/approvals/board 不会替换旧缓存。
      if (before !== after || e.task.archived) refetchBoard();
      return;
    }
    if (e.type === "health") {
      // D4：health 也批量；审批/权限/flag/artifact 仍走下面的立即 store.update。
      queueStoreEvent(e);
      return;
    }
    store.update((s) => applyEvent(s, e));
  });

  if (isMock(hub)) hub.start();
}

if (typeof document !== "undefined") {
  void bootstrap();
}
