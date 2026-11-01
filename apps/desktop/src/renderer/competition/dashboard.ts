import type {
  HubAction,
  PlatformChallengeView,
  PlatformSceneProbeView,
  PlatformStateView,
  TaskView,
} from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import { applySnapshot } from "../store.ts";
import { clear, el } from "../dom.ts";
import { notify } from "../notice.ts";
import { openConfirmModal } from "../task.ts";
import { sessionStatusLabel } from "../session-status.ts";
import {
  FILTER_LABEL,
  FILTER_ORDER,
  buildChallengeCards,
  buildCompetitionStats,
  categoryCounts,
  countdownText,
  formatRelative,
  platformStatusLabel,
  roleForAgent,
  type ChallengeCardView,
  type ChallengeFilter,
  type ChallengeSort,
} from "./model.ts";

export interface CompetitionUiCallbacks {
  onOpenWorkspace: () => void;
}

export interface CompetitionUi {
  dispose(): void;
  refresh(): void;
  openLogin(): void;
}

const SELECTED_KEY = "xuanwo.competition.selectedChallenge.v1";
const AGENTS_KEY = "xuanwo.competition.agents.v1";
const SPEED_KEY = "xuanwo.competition.speedMode.v1";
const SORT_KEY = "xuanwo.competition.sortMode.v1";
const AUTOPILOT_KEY = "xuanwo.competition.autopilot.v1";
const SWARM_SIZE = 4;
const MAX_AUTO_ACTIVE_TASKS = 3;
const SCENE_PROBE_INTERVAL_MS = 30_000;
const TARGET_DOWN_ROTATE_MS = 4 * 60_000;
const SESSION_STALL_MS = 6 * 60_000;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // UI 偏好存不住不影响功能。
  }
}

function copyText(value: string, label = "已复制"): void {
  const done = (): void => notify(label, "info");
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    void clipboard.writeText(value).then(done).catch(() => notify("复制失败", "error"));
    return;
  }
  notify("当前环境不支持剪贴板", "error");
}

function statusTone(status: PlatformStateView["status"]): string {
  if (status === "connected") return "ok";
  if (status === "syncing" || status === "connecting") return "busy";
  if (status === "error") return "error";
  return "idle";
}

function totalRunning(tasks: TaskView[]): number {
  return tasks.reduce((sum, task) => sum + (task.runningSessions ?? 0), 0);
}

function raceHasEnded(platform: PlatformStateView | null): boolean {
  const endAt = platform?.race?.endAt;
  if (!endAt) return false;
  const end = Date.parse(endAt.replace(" ", "T"));
  return Number.isFinite(end) && Date.now() >= end;
}

function targetProbeLabel(probe: PlatformSceneProbeView | undefined): {
  label: string;
  cls: string;
  title: string;
} {
  if (!probe) {
    return { label: "靶机待检", cls: "is-unknown", title: "下一轮自动探测" };
  }
  if (!probe.reachable) {
    return {
      label: "靶机断连",
      cls: "is-down",
      title: `${probe.error ?? "TCP/TLS 不可达"} · ${probe.latencyMs}ms`,
    };
  }
  if (!probe.ok) {
    return {
      label: probe.statusCode ? `靶机 ${probe.statusCode}` : "靶机异常",
      cls: "is-down",
      title: `服务返回异常状态 · ${probe.latencyMs}ms`,
    };
  }
  return {
    label: probe.statusCode ? `靶机 ${probe.statusCode}` : "靶机在线",
    cls: "is-up",
    title: `服务可用 · ${probe.latencyMs}ms`,
  };
}

function shortDirection(category: string): string {
  const value = category.toLowerCase();
  if (value === "reverse") return "Rev";
  if (value === "unknown") return "其他";
  return category;
}

function challengeNumber(index: number): string {
  return String(index).padStart(2, "0");
}

function isPlaceholderFlag(value: string): boolean {
  const upper = value.toUpperCase();
  return (
    upper.includes("...") ||
    upper.includes("…") ||
    /(SANDBOX_FAKE_FLAG|MOCK_HANDOFF|MOCK_FLAG|EXAMPLE_FLAG|PLACEHOLDER|FAKE_FLAG|LOCAL_TEST)/.test(
      upper,
    )
  );
}

export function createCompetitionUi(
  root: HTMLElement,
  ctx: UiCtx,
  callbacks: CompetitionUiCallbacks,
): CompetitionUi {
  let selectedId = readStorage(SELECTED_KEY);
  let activeFilter: ChallengeFilter = "all";
  let query = "";
  let busy = false;
  let disposed = false;
  let lastSnapshotError = "";
  let speedMode = readStorage(SPEED_KEY) !== "0";
  const storedSort = readStorage(SORT_KEY);
  let sortMode: ChallengeSort =
    storedSort === "points" || storedSort === "order" ? storedSort : "speed";
  let autopilot = readStorage(AUTOPILOT_KEY) === "1";
  let renderScheduled = false;
  let renderTimer: number | null = null;
  let autopilotTimer: number | null = null;
  let probeTimer: number | null = null;
  let fillingSwarms = false;
  const autoPromptedAt = new Map<string, number>();
  const noTargetSince = new Map<string, number>();
  const challengeCooldownUntil = new Map<string, number>();
  const sceneProbes = new Map<string, PlatformSceneProbeView>();
  const targetDownSince = new Map<string, number>();
  const probePromptedAt = new Map<string, number>();
  const sessionProgress = new Map<string, { toolCalls: number; at: number; warnedAt: number }>();
  const renderSignatures = {
    appBar: "",
    sidebar: "",
    center: "",
    inspector: "",
    status: "",
  };
  let selectedAgents = new Set<string>();
  try {
    const parsed = JSON.parse(readStorage(AGENTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      selectedAgents = new Set(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    selectedAgents = new Set();
  }

  const appBar = el("header", { class: "ops-bar" });
  const sidebar = el("aside", { class: "ops-sidebar" });
  const center = el("main", { class: "ops-center" });
  const inspector = el("aside", { class: "ops-inspector" });
  const shell = el("div", { class: "ops-shell" }, [sidebar, center, inspector]);
  const statusStrip = el("footer", { class: "ops-statusstrip" });
  root.append(appBar, shell, statusStrip);

  const boardTitle = el("h1", { class: "ops-title" }, "比赛与题目");
  const boardSub = el("div", { class: "ops-subtitle" });
  const searchInput = el("input", {
    class: "ops-search-input",
    type: "search",
    placeholder: "搜索题号 / 标题 / 关键词…",
    autocomplete: "off",
  }) as HTMLInputElement;
  const syncState = el("span", { class: "ops-sync-state" }, "缓存加载中…");
  const grid = el("div", { class: "challenge-grid" });
  const boardNotice = el("div", { class: "ops-board-notice" });
  const empty = el("div", { class: "ops-empty-board" });
  const sortGroup = el("div", { class: "ops-sort-group", role: "group", "aria-label": "题目排序" });
  const sortOptions: Array<{ id: ChallengeSort; label: string; title: string }> = [
    { id: "speed", label: "抢旗", title: "优先高解出数，通常更容易先拿分" },
    { id: "points", label: "高分", title: "优先当前分值更高的题目" },
    { id: "order", label: "题序", title: "保持平台返回顺序" },
  ];
  for (const option of sortOptions) {
    const button = el("button", {
      class: "ops-sort-btn",
      type: "button",
      title: option.title,
      "data-sort": option.id,
    }, option.label);
    button.addEventListener("click", () => {
      sortMode = option.id;
      writeStorage(SORT_KEY, sortMode);
      render();
    });
    sortGroup.appendChild(button);
  }
  const quickStart = el("button", {
    class: "ops-quick-start",
    type: "button",
    title: "自动选择当前最可能先出 flag 的未解题目，准备附件、开靶并启动 Agent",
  }, "一键抢旗");
  quickStart.addEventListener("click", () => {
    autopilot = true;
    writeStorage(AUTOPILOT_KEY, "1");
    render();
    void startBestChallenge();
  });
  const centerHead = el("section", { class: "ops-center-head" }, [
    el("div", { class: "ops-kicker" }, "LIVE BOARD / COMPETITION OPS"),
    el("div", { class: "ops-title-row" }, [
      el("div", {}, [boardTitle, boardSub]),
      el("div", { class: "ops-board-sync" }, [syncState]),
    ]),
    el("div", { class: "ops-toolbar" }, [
      el("label", { class: "ops-search" }, [
        el("span", { class: "ops-search-icon" }, "⌕"),
        searchInput,
      ]),
      sortGroup,
      quickStart,
      el("button", {
        class: "ops-ghost-btn",
        type: "button",
        title: "同步平台题目与分值",
        "data-act": "sync",
      }, "↻ 同步题目"),
    ]),
  ]);
  center.append(centerHead, boardNotice, grid, empty);
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderCenter(ctx.store.get().platform, ctx.store.get().tasks);
  });
  centerHead.querySelector('[data-act="sync"]')?.addEventListener("click", () => {
    void syncPlatform(true);
  });

  const countdownValue = el("strong", { class: "countdown-value" }, "--:--:--");
  const loginBtn = el("button", {
    class: "ops-primary-btn",
    type: "button",
    "data-act": "login",
  }, "连接平台");
  loginBtn.addEventListener("click", () => openLogin());

  function getSelectedChallenge(platform: PlatformStateView | null): PlatformChallengeView | null {
    const challenges = platform?.challenges ?? [];
    if (challenges.length === 0) return null;
    const found = selectedId ? challenges.find((challenge) => challenge.id === selectedId) : null;
    if (found) return found;
    const first = challenges.find((challenge) => !challenge.isSolved) ?? challenges[0];
    selectedId = first.id;
    writeStorage(SELECTED_KEY, selectedId);
    return first;
  }

  function ensureAgentSelection(platform: PlatformStateView | null): string[] {
    const installed = ctx.store.get().agents.filter((agent) => agent.installed);
    const installedIds = new Set(installed.map((agent) => agent.id));
    if (selectedAgents.size === 0) {
      for (const agent of installed) selectedAgents.add(agent.id);
    }
    for (const id of [...selectedAgents]) {
      if (!installedIds.has(id)) selectedAgents.delete(id);
    }
    return installed.map((agent) => agent.id).filter((id) => selectedAgents.has(id));
  }

  function renderAppBar(platform: PlatformStateView | null): void {
    clear(appBar);
    const race = platform?.race;
    const status = platform?.status ?? "unconfigured";
    const brand = el("div", { class: "ops-brand ops-brand-wordmark" }, [
      el("div", {}, [
        el("div", { class: "ops-brand-name" }, "不迷茫"),
        el("div", { class: "ops-brand-sub" }, "CTF 多 Agent 工作台"),
      ]),
    ]);
    const nav = el("nav", { class: "ops-nav" }, [
      el("button", { class: "ops-nav-btn is-active", type: "button" }, "赛题面板"),
      el("button", { class: "ops-nav-btn", type: "button", "data-act": "workspace" }, "Agent 控制台"),
    ]);
    nav.querySelector('[data-act="workspace"]')?.addEventListener("click", () => {
      callbacks.onOpenWorkspace();
    });
    const raceBlock = el("div", { class: "ops-race-inline" }, [
      el("span", { class: "ops-race-label" }, race?.name ?? "尚未载入比赛"),
      el("span", { class: "ops-race-meta" }, race
        ? `平台标注 ${race.checkpointNum ?? "?"} · 当前可见 ${platform?.challenges.length ?? 0} · ${race.startAt ?? "--"}`
        : "连接平台后自动同步"),
    ]);
    const platformChip = el("button", {
      class: `ops-conn-chip tone-${statusTone(status)}`,
      type: "button",
      title: platform?.error ?? platform?.baseUrl ?? "未配置平台",
      "data-status": status,
    }, [
      el("span", { class: "ops-conn-dot" }),
      el("span", {}, platformStatusLabel(status)),
    ]);
    platformChip.addEventListener("click", () => openLogin());
    const syncBtn = el("button", {
      class: "ops-icon-btn",
      type: "button",
      title: "立即同步平台",
      "data-act": "sync",
    }, "↻");
    syncBtn.addEventListener("click", () => void syncPlatform(true));
    const settingsBtn = el("button", {
      class: "ops-icon-btn",
      type: "button",
      title: "刷新本地快照",
      "data-act": "refresh",
    }, "⋯");
    settingsBtn.addEventListener("click", () => void refreshSnapshot());
    appBar.append(
      brand,
      nav,
      raceBlock,
      el("div", { class: "ops-bar-spacer" }),
      platformChip,
      syncBtn,
      settingsBtn,
    );
  }

  function renderSidebar(platform: PlatformStateView | null, tasks: TaskView[]): void {
    clear(sidebar);
    const counts = categoryCounts(platform);
    const stats = buildCompetitionStats(platform, tasks);
    const userLine = platform?.team || platform?.displayName || platform?.username || "未登录";
    const race = platform?.race;
    sidebar.append(
      el("section", { class: "side-card identity-card" }, [
        el("div", { class: "side-eyebrow" }, "PLATFORM"),
        el("div", { class: "identity-name" }, userLine),
        el("div", { class: "identity-org" }, platform?.organization.join(" · ") || "连接比赛平台后显示队伍信息"),
        el("div", { class: "identity-actions" }, [
          el("span", {
            class: `side-status-pill tone-${statusTone(platform?.status ?? "unconfigured")}`,
          }, platformStatusLabel(platform?.status ?? "unconfigured")),
          platform?.lastSyncAt
            ? el("span", { class: "subtle-text" }, `同步 ${formatRelative(platform.lastSyncAt)}`)
            : null,
        ]),
      ]),
      el("section", { class: "side-card race-card" }, [
        el("div", { class: "side-eyebrow" }, "TIME LEFT"),
        countdownValue,
        el("div", { class: "countdown-caption" }, race?.endAt ? `截止 ${race.endAt}` : "等待比赛信息"),
        el("div", { class: "race-progress" }, [
          el("span", { style: `width:${stats.accessible ? Math.round((stats.solved / stats.accessible) * 100) : 0}%` }),
        ]),
        el("div", { class: "race-progress-meta" }, [
          el("span", {}, `解题 ${stats.solved}/${stats.accessible}`),
          el("span", {}, `运行 ${stats.running}`),
        ]),
      ]),
      el("section", { class: "side-card stats-card" }, [
        el("div", { class: "mini-stat" }, [
          el("strong", {}, String(stats.unsolved)),
          el("span", {}, "待攻克"),
        ]),
        el("div", { class: "mini-stat" }, [
          el("strong", {}, String(stats.solved)),
          el("span", {}, "已完成"),
        ]),
        el("div", { class: "mini-stat" }, [
          el("strong", {}, stats.points.toFixed(0)),
          el("span", {}, "已得分"),
        ]),
      ]),
      el("section", { class: "side-filter" }, [
        el("div", { class: "side-section-title" }, "方向"),
        ...FILTER_ORDER.map((filter) => {
          const button = el("button", {
            class: `filter-btn${activeFilter === filter ? " is-active" : ""}`,
            type: "button",
            "data-filter": filter,
          }, [
            el("span", {}, FILTER_LABEL[filter]),
            el("span", { class: "filter-count" }, String(counts[filter])),
          ]);
          button.addEventListener("click", () => {
            activeFilter = filter;
            render();
          });
          return button;
        }),
      ]),
      el("section", { class: "side-card engine-card" }, [
        el("div", { class: "side-section-title" }, "本机引擎"),
        el("div", { class: "engine-mini-list" }, ctx.store.get().agents.map((agent) =>
          el("div", { class: `engine-mini${agent.installed ? " is-on" : " is-off"}` }, [
            el("span", { class: "engine-dot" }),
            el("span", { class: "engine-mini-name" }, agent.title),
            el("span", { class: "subtle-text" }, agent.installed ? "就绪" : "未安装"),
          ]),
        )),
      ]),
      el("section", { class: "side-card wp-card" }, [
        el("div", { class: "side-eyebrow" }, "WP KNOWLEDGE"),
        el("div", { class: "wp-count" }, platform?.wpIndexed ? `${platform.wpCount} 篇已索引` : "按需建索引"),
        el("div", { class: "wp-path" }, platform?.wpRoot ?? "未配置 WP 目录"),
      ]),
    );
  }

  function renderCard(card: ChallengeCardView, selected: boolean): HTMLElement {
    const probe = sceneProbes.get(card.id);
    const probeText = targetProbeLabel(probe);
    const node = el("article", {
      class:
        `challenge-card cat-${card.category} ${card.statusClass}` +
        `${selected ? " is-selected" : ""}`,
      "data-challenge-id": card.id,
      "data-category": card.category,
      "data-task-id": card.taskId ?? "",
      "data-target-state": probeText.cls.replace("is-", ""),
    }, [
      el("div", { class: "challenge-card-top" }, [
        el("span", { class: "challenge-index" }, challengeNumber(card.index)),
        el("span", { class: `challenge-state ${card.statusClass}` }, card.statusLabel),
      ]),
      el("h2", { class: "challenge-title", title: card.title }, card.title),
      el("div", { class: "challenge-badges" }, [
        el("span", { class: "challenge-badge direction" }, shortDirection(card.category)),
        el("span", { class: "challenge-badge points" }, `${Math.round(card.points)} 分`),
        card.solvedCount > 0
          ? el("span", { class: "challenge-badge solved" }, `${card.solvedCount} 解`)
          : null,
        card.runningSessions > 0
          ? el("span", { class: "challenge-badge running" }, `${card.runningSessions} Agent`)
          : null,
        card.targets.length > 0
          ? el("span", {
              class: `challenge-badge target ${probeText.cls}`,
              title: probeText.title,
            }, probeText.label)
          : null,
      ]),
      el("div", { class: "challenge-foot" }, [
        el("div", { class: "challenge-signals" }, [
          card.attachmentName ? el("span", { title: card.attachmentName }, "附件") : null,
          card.targets.length > 0 ? el("span", {}, "靶机") : card.withScene ? el("span", {}, "可开靶") : null,
          card.wpMatchCount ? el("span", {}, `WP ${card.wpMatchCount}`) : null,
        ]),
        el("button", {
          class: "challenge-start",
          type: "button",
          title: card.taskId ? "打开题目与 Agent" : "物化题目并准备 WP/附件",
        }, card.taskId ? "打开 ↗" : "开始 →"),
      ]),
    ]);
    node.addEventListener("click", () => {
      if (selectedId !== card.id) {
        selectedId = card.id;
        writeStorage(SELECTED_KEY, selectedId);
        if (card.taskId) void ctx.hub.dispatch({ type: "task.focus", taskId: card.taskId }).catch(() => undefined);
        render();
      }
    });
    node.querySelector(".challenge-start")?.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedId = card.id;
      writeStorage(SELECTED_KEY, selectedId);
      render();
      void startSwarm(card);
    });
    return node;
  }

  function renderCenter(platform: PlatformStateView | null, tasks: TaskView[]): void {
    const cards = buildChallengeCards(platform, tasks, activeFilter, query, selectedId, sortMode);
    const total = platform?.challenges.length ?? 0;
    const solved = platform?.challenges.filter((challenge) => challenge.isSolved).length ?? 0;
    const running = tasks.reduce((sum, task) => sum + (task.runningSessions ?? 0), 0);
    boardSub.textContent = platform?.race
      ? `${platform.race.name} · 当前可见 ${total} 题 · 已完成 ${solved} · 运行 ${running} · ${platform.cached ? "当前离线缓存" : "实时同步"}`
      : "连接平台后，题目、分值与靶机状态会自动汇入";
    syncState.textContent = platform?.lastSyncAt ? `SYNC ${formatRelative(platform.lastSyncAt)}` : "NO SYNC";
    for (const button of sortGroup.querySelectorAll<HTMLButtonElement>("[data-sort]")) {
      button.classList.toggle("is-active", button.dataset.sort === sortMode);
    }
    clear(grid);
    clear(boardNotice);
    clear(empty);
    if (!platform || platform.challenges.length === 0) {
      empty.append(
        el("div", { class: "ops-empty-card" }, [
          el("div", { class: "empty-mark" }, "01"),
          el("h2", {}, platform?.status === "needs_login" ? "登录比赛平台，拉取全部题目" : "等待平台数据"),
          el("p", {}, "账号登录后会自动同步题目、分值、附件与靶机地址；密码只在主进程中使用。"),
          el("div", { class: "empty-actions" }, [
            (() => {
              const button = el("button", { class: "ops-primary-btn", type: "button" }, "连接平台");
              button.addEventListener("click", () => openLogin());
              return button;
            })(),
            (() => {
              const button = el("button", { class: "ops-ghost-btn", type: "button" }, "只刷新缓存");
              button.addEventListener("click", () => void refreshSnapshot());
              return button;
            })(),
          ]),
        ]),
      );
      return;
    }
    const platformMarked = platform?.race?.checkpointNum ?? total;
    const hiddenByPlatform = Math.max(0, platformMarked - total);
    if (hiddenByPlatform > 0) {
      boardNotice.append(
        el("strong", {}, `平台标注 ${platformMarked} 题，当前接口返回 ${total} 题`),
        el("span", {}, `其余 ${hiddenByPlatform} 题通常受队伍身份、赛段或解锁进度控制；已展示本账号当前可访问的全部题目。`),
      );
    }
    if (cards.length === 0) {
      empty.append(
        el("div", { class: "ops-empty-card compact" }, [
          el("h2", {}, "没有匹配的题目"),
          el("p", {}, "换一个方向筛选，或清空搜索关键词。"),
        ]),
      );
    }
    cards.forEach((card, index) => {
      const node = renderCard(card, card.id === selectedId);
      node.style.setProperty("--card-i", String(index));
      grid.appendChild(node);
    });
  }

  function activeTaskFor(challenge: PlatformChallengeView | null): TaskView | null {
    if (!challenge?.taskId) return null;
    return ctx.store.get().tasks.find((task) => task.id === challenge.taskId) ?? null;
  }

  function runningSessionsFor(challenge: PlatformChallengeView | null) {
    const task = activeTaskFor(challenge);
    const state = ctx.store.get();
    return task && state.task?.id === task.id ? state.sessions : [];
  }

  function renderAgentLauncher(challenge: PlatformChallengeView): HTMLElement {
    const installed = ctx.store.get().agents.filter((agent) => agent.installed);
    const selected = ensureAgentSelection(ctx.store.get().platform);
    const task = activeTaskFor(challenge);
    const sessions = runningSessionsFor(challenge);
    const active = sessions.filter((session) =>
      ["starting", "idle", "running", "waiting_approval", "waiting_lease"].includes(session.status),
    );
    const slots = Math.max(0, 4 - active.length);
    const canStart = installed.length > 0 && slots > 0 && !busy;
    const section = el("section", { class: "inspector-section agent-launch-section" }, [
      el("div", { class: "inspector-section-head" }, [
        el("span", { class: "inspector-section-title" }, "并发解题"),
        el("span", { class: "subtle-text" }, `${selected.length}/${installed.length} 已选`),
      ]),
      el("div", { class: "agent-pick-list" }, installed.map((agent) => {
        const on = selectedAgents.has(agent.id);
        const button = el("button", {
          class: `agent-pick${on ? " is-on" : ""}`,
          type: "button",
          "data-agent": agent.id,
          title: agent.maturity,
        }, [
          el("span", { class: "agent-avatar" }, agent.title.slice(0, 1)),
          el("span", { class: "agent-pick-name" }, agent.title),
          el("span", { class: "agent-pick-role" }, roleForAgent(agent.id)),
        ]);
        button.addEventListener("click", () => {
          if (selectedAgents.has(agent.id)) selectedAgents.delete(agent.id);
          else selectedAgents.add(agent.id);
          writeStorage(AGENTS_KEY, JSON.stringify([...selectedAgents]));
          renderInspector(ctx.store.get().platform);
        });
        return button;
      })),
      el("div", { class: "launch-row" }, [
        (() => {
          const button = el("button", {
            class: `ops-primary-btn launch-btn${busy ? " is-busy" : ""}`,
            type: "button",
            disabled: canStart ? null : "",
            "data-act": "start-swarm",
          }, busy
            ? "正在准备…"
            : active.length >= 4
              ? "打开实时会话"
              : `启动 ${Math.min(selected.length, slots)} 个 Agent`);
          button.addEventListener("click", () => {
            if (active.length >= 4) {
              callbacks.onOpenWorkspace();
              return;
            }
            void startSwarm(challenge);
          });
          return button;
        })(),
        (() => {
          const toggle = el("button", {
            class: `speed-toggle${speedMode ? " is-on" : ""}`,
            type: "button",
            title: "极速模式：autonomous + 全放行，减少人工审批停顿",
          }, speedMode ? "极速" : "受控");
          toggle.addEventListener("click", () => {
            speedMode = !speedMode;
            writeStorage(SPEED_KEY, speedMode ? "1" : "0");
            renderInspector(ctx.store.get().platform);
          });
          return toggle;
        })(),
        (() => {
          const toggle = el("button", {
            class: `autopilot-toggle${autopilot ? " is-on" : ""}`,
            type: "button",
            title: "自动接替空闲 Agent，持续把可验证进展推回黑板；不会重复刷屏同一会话",
          }, autopilot ? "接力 ON" : "接力 OFF");
          toggle.addEventListener("click", () => {
            autopilot = !autopilot;
            writeStorage(AUTOPILOT_KEY, autopilot ? "1" : "0");
            renderInspector(ctx.store.get().platform);
            if (autopilot) void kickAutopilot();
          });
          return toggle;
        })(),
      ]),
      el("div", { class: "launch-hint" }, task
        ? `任务 ${task.id} · ${active.length} 个活跃会话 · 工作区 ${task.workDir ?? "—"}${autopilot ? " · 自动接力已开启" : ""}`
        : "首次点击会自动建任务、下载附件、复制 WP；极速模式下会继续自动开靶并启动 Agent。"),
    ]);
    return section;
  }

  function renderTargetList(challenge: PlatformChallengeView): HTMLElement {
    const list = el("div", { class: "target-list" });
    const probe = sceneProbes.get(challenge.id);
    const probeText = targetProbeLabel(probe);
    if (challenge.targets.length > 0) {
      list.appendChild(
        el("div", { class: `scene-health ${probeText.cls}`, title: probeText.title }, [
          el("span", { class: "scene-health-dot" }),
          el("strong", {}, probeText.label),
          el("span", {}, probe ? `${probe.latencyMs}ms` : "等待自动探测"),
        ]),
      );
    }
    if (challenge.targets.length === 0) {
      list.appendChild(el("div", { class: "inspector-empty" }, "当前没有可用靶机地址"));
    } else {
      for (const target of challenge.targets) {
        const row = el("div", { class: "target-row" }, [
          el("div", { class: "target-main" }, [
            el("span", { class: "target-proto" }, target.protocol.toUpperCase()),
            el("code", { class: "target-url" }, target.url),
          ]),
          (() => {
            const button = el("button", { class: "mini-action", type: "button" }, "复制");
            button.addEventListener("click", () => copyText(target.url, "靶机地址已复制"));
            return button;
          })(),
        ]);
        list.appendChild(row);
      }
    }
    if (challenge.withScene) {
      const action = el("div", { class: "scene-actions" }, [
        (() => {
          const button = el("button", { class: "ops-ghost-btn", type: "button" }, "⌁ 检查靶机");
          button.addEventListener("click", () => void probeScenes([challenge.id], true));
          return button;
        })(),
        (() => {
          const button = el("button", {
            class: "ops-ghost-btn",
            type: "button",
            disabled: busy ? "" : null,
          }, challenge.sceneReady ? "↻ 刷新实例" : "▷ 开靶机");
          button.addEventListener("click", () => {
            openConfirmModal({
              title: challenge.sceneReady ? "刷新靶机状态" : "开启靶机",
              lines: [
                challenge.sceneReady
                  ? "平台会重新读取当前场景实例地址。"
                  : "平台按队伍限制并发场景；开靶可能需要几十秒，并会占用场景槽位。",
                "仅对当前授权比赛题目执行，不会自动开其他题。",
              ],
              confirmText: challenge.sceneReady ? "刷新" : "确认开靶",
              onConfirm: () => void openScene(challenge),
            });
          });
          return button;
        })(),
        challenge.sceneReady
          ? (() => {
              const button = el("button", { class: "mini-action danger", type: "button" }, "关闭实例");
              button.addEventListener("click", () => {
                openConfirmModal({
                  title: "关闭靶机",
                  lines: ["关闭后地址会失效；下次需要重新创建并可能更换地址。"],
                  confirmText: "关闭",
                  danger: true,
                  onConfirm: () => void closeScene(challenge),
                });
              });
              return button;
            })()
          : null,
      ]);
      list.appendChild(action);
    }
    return list;
  }

  function renderWpSection(challenge: PlatformChallengeView): HTMLElement {
    const section = el("section", { class: "inspector-section" }, [
      el("div", { class: "inspector-section-head" }, [
        el("span", { class: "inspector-section-title" }, "WP 情报"),
        el("span", { class: "subtle-text" }, challenge.wpMatchCount ? `${challenge.wpMatchCount} 篇命中` : "未检索"),
      ]),
      el("div", { class: "wp-hint" }, "按题名与方向检索本地 WP，开题时自动复制到 reference/wp/。"),
      (() => {
        const button = el("button", { class: "ops-ghost-btn full", type: "button" }, "检索同类 WP");
        button.addEventListener("click", () => void searchWp(challenge));
        return button;
      })(),
    ]);
    return section;
  }

  function renderFlags(challenge: PlatformChallengeView): HTMLElement {
    const state = ctx.store.get();
    const task = activeTaskFor(challenge);
    const flags = task && state.task?.id === task.id ? state.flags : [];
    const section = el("section", { class: "inspector-section flag-box" });
    section.append(
      el("div", { class: "inspector-section-head" }, [
        el("span", { class: "inspector-section-title" }, "Flag 候选"),
        el("span", { class: "subtle-text" }, `${flags.length} 条`),
      ]),
    );
    if (flags.length === 0) {
      section.appendChild(el("div", { class: "inspector-empty" }, "Agent 命中 flag{...} 后会出现在这里"));
    } else {
      const evidenceRank = { E2: 2, E1: 1, E0: 0 } as const;
      const statusRank = { new: 0, confirmed: 1, false_positive: 2 } as const;
      const ordered = [...flags].sort(
        (a, b) =>
          statusRank[a.status] - statusRank[b.status] ||
          evidenceRank[b.evidence] - evidenceRank[a.evidence] ||
          b.firstSeen - a.firstSeen,
      );
      for (const flag of ordered.slice(0, 3)) {
        const rejected = flag.status === "false_positive";
        const confirmed = flag.status === "confirmed";
        const row = el("div", { class: `flag-row flag-${flag.status}` }, [
          el("code", { class: "flag-value", title: flag.value }, flag.value),
          el("span", { class: `flag-evidence ev-${flag.evidence}` }, flag.evidence),
          rejected
            ? el("span", { class: "flag-verdict is-rejected" }, "平台拒绝")
            : confirmed || flag.submitStatus === "ok"
              ? el("span", { class: "flag-verdict is-accepted" }, "平台接受")
              : flag.submitStatus === "timeout" || flag.submitStatus === "failed"
                ? el("span", { class: "flag-verdict is-retry" }, "等待重试")
                : null,
          el("div", { class: "flag-actions" }, [
            (() => {
              const button = el("button", { class: "mini-action", type: "button" }, "复制");
              button.addEventListener("click", () => copyText(flag.value, "Flag 已复制"));
              return button;
            })(),
            (() => {
              const placeholder = isPlaceholderFlag(flag.value);
              const verified =
                flag.evidence !== "E0" && !placeholder && !rejected && !confirmed;
              const button = el("button", {
                class: "mini-action primary",
                type: "button",
                disabled: busy || !verified ? "" : null,
                title: verified
                  ? "证据已达 E1/E2，可提交平台"
                  : rejected
                    ? "平台已明确拒绝该候选，不再重复提交"
                    : confirmed
                      ? "平台已接受该候选"
                      : placeholder
                        ? "这是本地模拟/占位 flag，禁止提交平台"
                        : "E0 只是 Agent 自述；先落盘 witness 或命令回显再提交",
              }, verified
                ? "提交平台"
                : rejected
                  ? "已拒绝"
                  : confirmed
                    ? "已接受"
                    : placeholder
                      ? "占位勿提交"
                      : "先验证");
              button.addEventListener("click", () => {
                if (!verified) {
                  if (rejected || confirmed) return;
                  notify(
                    placeholder
                      ? "占位/模拟 flag 不能提交到比赛平台"
                      : "E0 候选缺少可回放证据，先让 Agent 写入 evidence/ 再提交",
                    "error",
                  );
                  return;
                }
                openConfirmModal({
                  title: "提交 Flag 到平台",
                  lines: [
                    `题目：${challenge.title}`,
                    "点击确认后会把该候选直接提交到比赛平台；平台接受后任务标记为已解出。",
                    "网络请求仅发往当前比赛平台。",
                  ],
                  confirmText: "确认提交",
                  onConfirm: () => void submitFlag(challenge, flag.value, flag.id),
                });
              });
              return button;
            })(),
          ]),
        ]);
        section.appendChild(row);
      }
    }
    const input = el("input", {
      class: "manual-flag-input",
      type: "text",
      placeholder: "手动粘贴 flag 后提交",
      autocomplete: "off",
    }) as HTMLInputElement;
    const submit = el("button", {
      class: "ops-primary-btn full",
      type: "button",
      disabled: busy ? "" : null,
    }, "提交手动 Flag");
    submit.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) {
        notify("先填写 flag", "error");
        return;
      }
      openConfirmModal({
        title: "提交 Flag 到平台",
        lines: [`题目：${challenge.title}`, `Flag：${value}`],
        confirmText: "确认提交",
        onConfirm: () => void submitFlag(challenge, value),
      });
    });
    section.append(el("div", { class: "manual-flag-row" }, [input, submit]));
    return section;
  }

  function renderRuns(challenge: PlatformChallengeView): HTMLElement {
    const sessions = runningSessionsFor(challenge);
    const section = el("section", { class: "inspector-section" }, [
      el("div", { class: "inspector-section-head" }, [
        el("span", { class: "inspector-section-title" }, "Agent 运行"),
        el("span", { class: "subtle-text" }, `${sessions.length} 个会话`),
      ]),
    ]);
    if (sessions.length === 0) {
      section.appendChild(el("div", { class: "inspector-empty" }, "尚未启动会话"));
      return section;
    }
    const list = el("div", { class: "run-list" });
    for (const session of sessions) {
      const row = el("button", {
        class: `run-row status-${session.status}`,
        type: "button",
        title: "打开 Agent 控制台",
      }, [
        el("span", { class: "run-agent" }, session.agent),
        el("span", { class: "run-role" }, session.role),
        el("span", { class: "run-status" }, sessionStatusLabel(session.status)),
        el("span", { class: "run-arrow" }, "↗"),
      ]);
      row.addEventListener("click", () => callbacks.onOpenWorkspace());
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  function renderActivity(): HTMLElement {
    const state = ctx.store.get();
    const facts = state.facts.slice(-4).reverse();
    const section = el("section", { class: "inspector-section" }, [
      el("div", { class: "inspector-section-head" }, [
        el("span", { class: "inspector-section-title" }, "最新黑板"),
        el("span", { class: "subtle-text" }, `${state.facts.length} facts`),
      ]),
    ]);
    if (facts.length === 0) {
      section.appendChild(el("div", { class: "inspector-empty" }, "Agent 写入事实后会在这里出现"));
      return section;
    }
    for (const fact of facts) {
      section.appendChild(
        el("div", { class: "activity-row" }, [
          el("span", { class: `activity-ev ev-${fact.evidence}` }, fact.evidence),
          el("span", { class: "activity-text" }, fact.content.slice(0, 160)),
        ]),
      );
    }
    return section;
  }

  function renderInspector(platform: PlatformStateView | null): void {
    clear(inspector);
    const challenge = getSelectedChallenge(platform);
    if (!challenge) {
      inspector.append(
        el("div", { class: "inspector-empty-state" }, [
          el("div", { class: "side-eyebrow" }, "RUN DETAIL"),
          el("h2", {}, "选择一道题"),
          el("p", {}, "题目详情、Agent 并发、靶机、WP 与 Flag 会集中在这里。"),
        ]),
      );
      return;
    }
    const task = activeTaskFor(challenge);
    const taskRunning = task?.runningSessions ?? 0;
    const liveProbe = sceneProbes.get(challenge.id);
    const liveProbeText = targetProbeLabel(liveProbe);
    const head = el("section", { class: "inspector-head" }, [
      el("div", { class: "inspector-kicker" }, `CHALLENGE ${challenge.id.slice(0, 8).toUpperCase()}`),
      el("div", { class: "inspector-title-row" }, [
        el("h1", { class: "inspector-title" }, challenge.title),
        el("span", { class: `inspector-status ${challenge.isSolved ? "is-solved" : taskRunning > 0 ? "is-running" : task?.status === "solving" ? "is-paused" : ""}` },
          challenge.isSolved ? "已完成" : taskRunning > 0 ? "解题中" : task?.status === "solving" ? "已暂停" : "待开始"),
      ]),
      el("div", { class: "inspector-meta" }, [
        el("span", {}, challenge.direction),
        el("span", {}, `${Math.round(challenge.points)} 分`),
        el("span", {}, `${challenge.solvedCount} 队解出`),
        challenge.sceneReady
          ? el("span", { class: `live-dot ${liveProbeText.cls}`, title: liveProbeText.title }, liveProbeText.label)
          : null,
      ]),
    ]);
    const description = el("section", { class: "inspector-section brief-section" }, [
      el("div", { class: "inspector-section-head" }, [
        el("span", { class: "inspector-section-title" }, "题面"),
        (() => {
          const button = el("button", { class: "mini-action", type: "button" }, "复制");
          button.addEventListener("click", () => copyText(challenge.description, "题面已复制"));
          return button;
        })(),
      ]),
      el("div", { class: "brief-text" }, challenge.description || "平台未返回题面。"),
    ]);
    inspector.append(
      head,
      renderAgentLauncher(challenge),
      renderFlags(challenge),
      description,
      el("section", { class: "inspector-section" }, [
        el("div", { class: "inspector-section-head" }, [
          el("span", { class: "inspector-section-title" }, "靶机与附件"),
          el("span", { class: "subtle-text" }, challenge.attachmentName ?? "无附件"),
        ]),
        renderTargetList(challenge),
      ]),
      renderWpSection(challenge),
      renderRuns(challenge),
      renderActivity(),
    );
  }

  function renderStatusStrip(platform: PlatformStateView | null): void {
    clear(statusStrip);
    const state = ctx.store.get();
    const approvalsPending = state.approvalsAll.filter((approval) => approval.status === "pending").length;
    const running = totalRunning(state.tasks);
    const activeTasks = state.platform
      ? activeUnsolvedChallenges(state.platform, state.tasks).length
      : 0;
    const probes = [...sceneProbes.values()];
    const healthyTargets = probes.filter((probe) => probe.ok).length;
    const downTargets = probes.filter((probe) => !probe.ok).length;
    statusStrip.append(
      el("span", {}, `EVENT CHANNEL · ${platform?.status === "connected" ? "LIVE" : "CACHE"}`),
      el("span", {}, `AGENTS ${running}/${state.quota?.maxSessionsTotal ?? "—"}`),
      el("span", {}, `ACTIVE ${activeTasks}/${desiredActiveTasks()}`),
      el("span", { class: downTargets > 0 ? "strip-alert" : "" }, `TARGETS ${healthyTargets} UP · ${downTargets} DOWN`),
      el("span", {}, `APPROVALS ${approvalsPending}`),
      el("span", {}, `AUTOPILOT ${autopilot ? "ON" : "OFF"}`),
      el("span", {}, `AUTO-SUBMIT ${platform?.autoSubmit ? "ON" : "OFF"}`),
      el("span", { class: "status-strip-spacer" }),
      el("span", {}, platform?.error ? `ERR ${platform.error.slice(0, 80)}` : "S 一键抢旗 · N 下一题 · / 搜索 · Ctrl+Enter 发送提示"),
    );
  }

  function render(): void {
    if (disposed) return;
    if (document.getElementById("app")?.dataset.view !== "competition") return;
    const state = ctx.store.get();
    const platform = state.platform;
    const selected = getSelectedChallenge(platform);
    const selectedTask = activeTaskFor(selected);
    const appBarSignature = JSON.stringify({
      status: platform?.status,
      error: platform?.error,
      baseUrl: platform?.baseUrl,
      race: platform?.race,
      count: platform?.challenges.length,
    });
    const sidebarSignature = JSON.stringify({
      team: platform?.team,
      displayName: platform?.displayName,
      username: platform?.username,
      organization: platform?.organization,
      status: platform?.status,
      lastSyncAt: platform?.lastSyncAt,
      wpIndexed: platform?.wpIndexed,
      wpCount: platform?.wpCount,
      wpRoot: platform?.wpRoot,
      challenges: platform?.challenges.map((challenge) => [
        challenge.id,
        challenge.category,
        challenge.isSolved,
      ]),
      tasks: state.tasks.map((task) => [task.id, task.status, task.runningSessions ?? 0]),
      agents: state.agents.map((agent) => [agent.id, agent.installed]),
    });
    const centerSignature = JSON.stringify({
      filter: activeFilter,
      query,
      sortMode,
      selectedId: selected?.id,
      challenges: platform?.challenges.map((challenge) => [
        challenge.id,
        challenge.title,
        challenge.category,
        challenge.points,
        challenge.solvedCount,
        challenge.isSolved,
        challenge.taskId,
        challenge.attachmentName,
        challenge.withScene,
        challenge.sceneReady,
        challenge.targets.length,
        challenge.wpMatchCount ?? 0,
      ]),
      tasks: state.tasks.map((task) => [
        task.id,
        task.title,
        task.status,
        task.runningSessions ?? 0,
      ]),
      probes: [...sceneProbes.values()].map((probe) => [
        probe.challengeId,
        probe.ok,
        probe.statusCode,
      ]),
      cached: platform?.cached,
    });
    const inspectorSignature = JSON.stringify({
      selected,
      task: selectedTask,
      sessions: state.sessions.map((session) => [
        session.id,
        session.status,
        session.agent,
        session.role,
      ]),
      flags: state.flags,
      factCount: state.facts.length,
      facts: state.facts.slice(-4).map((fact) => [fact.id, fact.evidence, fact.content]),
      agents: state.agents,
      probe: selected ? sceneProbes.get(selected.id) : null,
      autopilot,
      speedMode,
    });
    const statusSignature = JSON.stringify({
      status: platform?.status,
      error: platform?.error,
      autoSubmit: platform?.autoSubmit,
      autopilot,
      running: totalRunning(state.tasks),
      active: platform ? activeUnsolvedChallenges(platform, state.tasks).length : 0,
      desired: desiredActiveTasks(),
      probes: [...sceneProbes.values()].map((probe) => [probe.challengeId, probe.ok, probe.statusCode]),
      approvals: state.approvalsAll.filter((approval) => approval.status === "pending").length,
    });
    const t0 = performance.now();
    if (appBarSignature !== renderSignatures.appBar) {
      renderSignatures.appBar = appBarSignature;
      renderAppBar(platform);
    }
    if (sidebarSignature !== renderSignatures.sidebar) {
      renderSignatures.sidebar = sidebarSignature;
      renderSidebar(platform, state.tasks);
    }
    if (centerSignature !== renderSignatures.center) {
      renderSignatures.center = centerSignature;
      renderCenter(platform, state.tasks);
    }
    if (inspectorSignature !== renderSignatures.inspector) {
      renderSignatures.inspector = inspectorSignature;
      renderInspector(platform);
    }
    if (statusSignature !== renderSignatures.status) {
      renderSignatures.status = statusSignature;
      renderStatusStrip(platform);
    }
    const duration = performance.now() - t0;
    if (duration > 32) {
      console.warn(`[ui competition] ${duration.toFixed(1)}ms nodes=${inspector.childElementCount + grid.childElementCount}`);
    }
  }

  function scheduleRender(delay = 120): void {
    if (disposed || renderScheduled) return;
    renderScheduled = true;
    renderTimer = window.setTimeout(() => {
      renderScheduled = false;
      renderTimer = null;
      render();
    }, delay);
  }

  async function refreshSnapshot(): Promise<void> {
    try {
      const snapshot = await ctx.hub.snapshot();
      ctx.store.set(applySnapshot(snapshot, ctx.store.get()));
      lastSnapshotError = "";
    } catch (err) {
      const message = (err as Error).message;
      if (message !== lastSnapshotError) {
        lastSnapshotError = message;
        notify(`刷新失败：${message}`, "error");
      }
    }
  }

  async function syncPlatform(showToast: boolean): Promise<void> {
    if (busy) return;
    const platform = ctx.store.get().platform;
    if (!platform || !["connected", "offline"].includes(platform.status)) {
      openLogin();
      return;
    }
    busy = true;
    render();
    try {
      const result = await ctx.hub.dispatch({ type: "platform.sync" });
      if (!result.ok) notify(result.error ?? "同步失败", "error");
      else if (showToast) notify(result.message ?? "同步完成", "info");
      await refreshSnapshot();
    } finally {
      busy = false;
      render();
    }
  }

  async function startSwarm(challenge: PlatformChallengeView): Promise<void> {
    if (busy) return;
    const platform = ctx.store.get().platform;
    if (!platform || !["connected", "offline"].includes(platform.status)) {
      openLogin();
      return;
    }
    const selected = ensureAgentSelection(platform).slice(0, 4);
    if (selected.length === 0) {
      notify("至少选择一个已安装 Agent", "error");
      return;
    }
    busy = true;
    render();
    try {
      const materialized = await ctx.hub.dispatch({
        type: "platform.materialize",
        challengeId: challenge.id,
        downloadAttachment: true,
        includeWp: true,
      });
      const taskId = materialized.taskId ?? challenge.taskId;
      if (!materialized.ok && !taskId) {
        notify(materialized.error ?? "开题失败", "error");
        return;
      }
      if (!taskId) {
        notify("题目物化失败：平台未返回任务 ID", "error");
        return;
      }
      await ctx.hub.dispatch({ type: "task.focus", taskId });
      await refreshSnapshot();

      let current =
        ctx.store.get().platform?.challenges.find((item) => item.id === challenge.id) ?? challenge;
      if (current.withScene && !current.sceneReady) {
        notify("资料已就绪，正在申请靶机；20 秒内没地址也会先启动 Agent…", "info");
        const opened = await ctx.hub.dispatch({ type: "platform.openScene", challengeId: current.id });
        if (!opened.ok) notify(opened.error ?? "自动开靶失败，可稍后手动重试", "error");
        await refreshSnapshot();
        current =
          ctx.store.get().platform?.challenges.find((item) => item.id === challenge.id) ?? current;
        if (current.withScene && !current.sceneReady) {
          notify("靶机仍在后台创建；Agent 先启动做离线分析，地址就绪后会自动注入", "info");
        }
      }
      if (current.withScene && current.sceneReady && current.targets.length === 0) {
        await ctx.hub.dispatch({ type: "platform.sync" }).catch(() => undefined);
        await refreshSnapshot();
        current =
          ctx.store.get().platform?.challenges.find((item) => item.id === challenge.id) ?? current;
      }
      if (current.isSolved) {
        notify("这道题平台已判定完成，自动切换到下一道未解题", "info");
        const next = nextUnsolvedChallenge();
        if (next) {
          selectedId = next.id;
          writeStorage(SELECTED_KEY, selectedId);
        }
        return;
      }

      const stateAfterFocus = ctx.store.get();
      const existingSessions = stateAfterFocus.sessions;
      const activeAgents = new Set(
        existingSessions
          .filter((session) =>
            ["starting", "idle", "running", "waiting_approval", "waiting_lease"].includes(session.status),
          )
          .map((session) => session.agent),
      );
      const taskRunning =
        stateAfterFocus.tasks.find((candidate) => candidate.id === taskId)?.runningSessions ?? 0;
      const perTaskMax = stateAfterFocus.quota?.maxSessionsPerTask ?? SWARM_SIZE;
      const totalMax = stateAfterFocus.quota?.maxSessionsTotal ?? 12;
      const available = Math.max(
        0,
        Math.min(
          Math.max(0, perTaskMax - taskRunning),
          Math.max(0, totalMax - totalRunning(stateAfterFocus.tasks)),
        ),
      );
      const launch = selected
        .filter((agent) => !activeAgents.has(agent))
        .slice(0, available);
      if (launch.length === 0) {
        notify(
          totalRunning(stateAfterFocus.tasks) >= totalMax
            ? `全局 ${totalMax} 个 Agent 配额已满，先让现有题目收敛`
            : "该题已有足够 Agent；自动编队会继续填下一道未解题",
          "info",
        );
        return;
      }

      const actions: HubAction[] = launch.map((agent) => ({
        type: "session.start",
        taskId: taskId!,
        agent,
        role: roleForAgent(agent),
        tier: speedMode ? "autonomous" : "guarded",
        allowAll: speedMode,
      }));
      const results = await Promise.all(actions.map((action) => ctx.hub.dispatch(action)));
      const ok = results.filter((result) => result.ok).length;
      const failed = results.filter((result) => !result.ok);
      if (ok > 0) {
        notify(
          `${ok} 个 Agent 已开始解题${current.sceneReady ? "，靶机地址已注入" : ""}` +
            `${failed.length ? `，${failed.length} 个失败` : ""}`,
          "info",
        );
      } else {
        notify(failed[0]?.error ?? "Agent 启动失败", "error");
      }
      await refreshSnapshot();
    } catch (err) {
      notify(`开题失败：${(err as Error).message}`, "error");
    } finally {
      busy = false;
      render();
    }
  }

  function nextUnsolvedChallenge(
    respectCooldown = false,
    onlyIdle = false,
  ): PlatformChallengeView | null {
    const state = ctx.store.get();
    const now = Date.now();
    const cards = buildChallengeCards(
      state.platform,
      state.tasks,
      "all",
      "",
      selectedId,
      sortMode,
    );
    return (
      cards.find((card) => {
        if (card.isSolved || card.taskStatus === "solved") return false;
        if (onlyIdle && card.runningSessions > 0) return false;
        if (!respectCooldown) return true;
        return (challengeCooldownUntil.get(card.id) ?? 0) <= now;
      }) ?? null
    );
  }

  function desiredActiveTasks(): number {
    const totalMax = ctx.store.get().quota?.maxSessionsTotal ?? 12;
    return Math.max(1, Math.min(MAX_AUTO_ACTIVE_TASKS, Math.floor(totalMax / SWARM_SIZE)));
  }

  function activeUnsolvedChallenges(
    platform: PlatformStateView,
    tasks: TaskView[],
  ): PlatformChallengeView[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return platform.challenges.filter((challenge) => {
      if (challenge.isSolved || !challenge.taskId) return false;
      return (byId.get(challenge.taskId)?.runningSessions ?? 0) > 0;
    });
  }

  async function fillSwarmCapacity(): Promise<void> {
    if (fillingSwarms || busy || disposed) return;
    fillingSwarms = true;
    let startedTasks = 0;
    try {
      for (let round = 0; round < MAX_AUTO_ACTIVE_TASKS; round += 1) {
        const state = ctx.store.get();
        const platform = state.platform;
        if (!platform || platform.status !== "connected") break;
        if (raceHasEnded(platform)) break;
        const active = activeUnsolvedChallenges(platform, state.tasks);
        if (active.length >= desiredActiveTasks()) break;
        const totalMax = state.quota?.maxSessionsTotal ?? 12;
        if (totalRunning(state.tasks) >= totalMax) break;

        const next = nextUnsolvedChallenge(true, true);
        if (!next) break;
        selectedId = next.id;
        writeStorage(SELECTED_KEY, selectedId);
        const before = totalRunning(state.tasks);
        await startSwarm(next);
        await refreshSnapshot();
        const after = totalRunning(ctx.store.get().tasks);
        if (after <= before) break;
        startedTasks += 1;
      }
      if (startedTasks > 0) {
        notify(
          `自动编队已启动 ${startedTasks} 道新题；目标同时推进 ${desiredActiveTasks()} 道`,
          "info",
        );
      }
    } finally {
      fillingSwarms = false;
      render();
    }
  }

  async function startBestChallenge(): Promise<void> {
    if (raceHasEnded(ctx.store.get().platform)) {
      notify("比赛已结束，已停止自动启动新会话", "info");
      return;
    }
    const best = nextUnsolvedChallenge(false);
    if (!best) {
      notify("当前平台没有可启动的未解题目", "info");
      return;
    }
    selectedId = best.id;
    writeStorage(SELECTED_KEY, selectedId);
    render();
    await fillSwarmCapacity();
  }

  const AUTO_PROMPT =
    "【自动接力】不要停在等待状态。先调用 blackboard_read_since 读取队友增量，再检查当前工作目录的 challenge.json、README.md、attachments/ 和 reference/wp/。" +
    "直接执行一个可验证动作，优先现成 WP、本地静态分析和已经注入的靶机地址；不要要求用户重复开靶。" +
    "30 秒内形成假设，最多 10 分钟必须向黑板写 fact、dead_end 或 flag 候选；若被环境阻塞，明确写出缺失条件和仍可离线推进的下一步。" +
    "一旦有可复现证据，把完整候选单独输出为一行 PLATFORM_FLAG=<值>，同时写入 evidence/ 和黑板；不要重复已被平台拒绝的值。";
  const STALL_PROMPT =
    "【停滞纠偏】你的工具调用已连续 6 分钟没有增长。立即停止空想，读一次黑板增量，" +
    "然后执行一条能产生新证据的最小命令或文件检查（没有 shell 的 Agent 改用可用 MCP 工具）。" +
    "若当前路径已失败，写 dead_end 并换路线；" +
    "若已有 flag 证据，单独输出 PLATFORM_FLAG=<值>。";

  async function probeScenes(challengeIds: string[], announce = false): Promise<void> {
    if (challengeIds.length === 0 || disposed) return;
    const result = await ctx.hub.dispatch({
      type: "platform.probeScenes",
      challengeIds: [...new Set(challengeIds)].slice(0, 24),
    });
    if (!result.ok) {
      if (announce) notify(result.error ?? "靶机探测失败", "error");
      return;
    }
    const probes = result.sceneProbes ?? [];
    const state = ctx.store.get();
    const focusId = state.task?.id ?? null;
    const now = Date.now();
    const liveIds = new Set(
      state.platform ? activeUnsolvedChallenges(state.platform, state.tasks).map((item) => item.id) : [],
    );
    for (const key of [...sceneProbes.keys()]) {
      if (!liveIds.has(key)) {
        sceneProbes.delete(key);
        targetDownSince.delete(key);
      }
    }
    for (const probe of probes) {
      const previous = sceneProbes.get(probe.challengeId);
      sceneProbes.set(probe.challengeId, probe);
      if (probe.ok) {
        targetDownSince.delete(probe.challengeId);
        probePromptedAt.delete(probe.challengeId);
        continue;
      }
      if (!previous || previous.ok) {
        const challenge = state.platform?.challenges.find((item) => item.id === probe.challengeId);
        notify(
          `${challenge?.title ?? probe.challengeId} 靶机异常：${probe.error ?? `HTTP ${probe.statusCode ?? "?"}`}`,
          "error",
        );
      }
      const challenge = state.platform?.challenges.find((item) => item.id === probe.challengeId);
      if (!challenge?.taskId || focusId !== challenge.taskId) continue;
      const lastPrompt = probePromptedAt.get(probe.challengeId) ?? 0;
      if (now - lastPrompt < 180_000) continue;
      probePromptedAt.set(probe.challengeId, now);
      const message =
        `【靶机健康】${challenge.title} 当前探测异常：` +
        `${probe.error ?? `HTTP ${probe.statusCode ?? "?"}`}（${probe.latencyMs}ms）。` +
        "先复现本地环境/静态分析，不要无脑重发 exploit；保留可回放证据。自动调度 4 分钟后会冷却该题并切换。";
      for (const session of state.sessions) {
        if (!["starting", "idle", "running", "waiting_approval", "waiting_lease"].includes(session.status)) {
          continue;
        }
        void ctx.hub.dispatch({ type: "session.prompt", sessionId: session.id, text: message })
          .catch(() => undefined);
      }
    }
    if (announce) notify(result.message ?? "靶机探测完成", "info");
    scheduleRender(0);
  }

  async function probeActiveScenes(): Promise<void> {
    const state = ctx.store.get();
    if (!state.platform || state.platform.status !== "connected") return;
    const active = activeUnsolvedChallenges(state.platform, state.tasks);
    const ids = active
      .filter((challenge) => challenge.targets.length > 0)
      .map((challenge) => challenge.id);
    if (ids.length > 0) await probeScenes(ids, false);
  }

  async function kickAutopilot(): Promise<void> {
    if (!autopilot || busy || disposed) return;
    let state = ctx.store.get();
    const platform = state.platform;
    if (!platform || platform.status !== "connected") return;
    if (raceHasEnded(platform)) {
      autopilot = false;
      writeStorage(AUTOPILOT_KEY, "0");
      notify("比赛已结束，自动接力已停止", "info");
      render();
      return;
    }

    const now = Date.now();
    const taskById = new Map(state.tasks.map((item) => [item.id, item]));
    let stoppedAny = false;
    for (const activeChallenge of activeUnsolvedChallenges(platform, state.tasks)) {
      const linkedTask = activeChallenge.taskId
        ? taskById.get(activeChallenge.taskId)
        : undefined;
      if (!linkedTask) continue;
      const probe = sceneProbes.get(activeChallenge.id);
      const noTarget =
        activeChallenge.withScene &&
        (!activeChallenge.sceneReady || activeChallenge.targets.length === 0);
      const targetDown = Boolean(probe && !probe.ok);
      const stopLimitMs = targetDown ? TARGET_DOWN_ROTATE_MS : 5 * 60_000;
      const tracker = targetDown ? targetDownSince : noTargetSince;
      if (!noTarget && !targetDown) {
        noTargetSince.delete(activeChallenge.id);
        targetDownSince.delete(activeChallenge.id);
        continue;
      }
      const since = tracker.get(activeChallenge.id) ?? now;
      tracker.set(activeChallenge.id, since);
      if (now - since < stopLimitMs) continue;
      tracker.delete(activeChallenge.id);
      challengeCooldownUntil.set(
        activeChallenge.id,
        now + (targetDown ? 10 * 60_000 : 30 * 60_000),
      );
      await ctx.hub.dispatch({ type: "task.stopAll", taskId: linkedTask.id }).catch(() => undefined);
      stoppedAny = true;
      notify(
        targetDown
          ? `${activeChallenge.title} 靶机持续异常 ${Math.round(TARGET_DOWN_ROTATE_MS / 60_000)} 分钟，已冷却 10 分钟并切换`
          : `${activeChallenge.title} 等待靶机超过 5 分钟，已冷却 30 分钟并切换`,
        "info",
      );
    }
    if (stoppedAny) {
      await refreshSnapshot();
      state = ctx.store.get();
    }

    const activeNow = activeUnsolvedChallenges(state.platform ?? platform, state.tasks);
    const totalMax = state.quota?.maxSessionsTotal ?? 12;
    if (
      activeNow.length < desiredActiveTasks() &&
      totalRunning(state.tasks) < totalMax
    ) {
      await fillSwarmCapacity();
      return;
    }
    if (activeNow.length === 0) return;

    const challenge =
      activeNow.find((item) => item.id === selectedId) ?? activeNow[0];
    selectedId = challenge.id;
    writeStorage(SELECTED_KEY, selectedId);
    const task = activeTaskFor(challenge);
    if (!task) return;
    if (state.task?.id !== task.id) {
      await ctx.hub.dispatch({ type: "task.focus", taskId: task.id }).catch(() => undefined);
      await refreshSnapshot();
    }

    const liveStatuses = new Set(["starting", "idle", "running", "waiting_approval", "waiting_lease"]);
    const active = ctx.store
      .get()
      .sessions.filter((session) => session.status === "idle" || liveStatuses.has(session.status));
    if (active.length === 0) return;

    const prompts: Array<Promise<unknown>> = [];
    let idleWakes = 0;
    let stallPrompts = 0;
    const liveIds = new Set(active.map((session) => session.id));
    for (const sessionId of [...sessionProgress.keys()]) {
      if (!liveIds.has(sessionId)) sessionProgress.delete(sessionId);
    }
    for (const session of active) {
      if (session.status === "idle") {
        const last = autoPromptedAt.get(session.id) ?? 0;
        if (now - last < 120_000) continue;
        autoPromptedAt.set(session.id, now);
        idleWakes += 1;
        prompts.push(ctx.hub.dispatch({
          type: "session.prompt",
          sessionId: session.id,
          text: AUTO_PROMPT,
        }));
        continue;
      }
      if (!["starting", "running", "waiting_approval", "waiting_lease"].includes(session.status)) {
        continue;
      }
      const toolCalls = state.health[session.id]?.toolCalls ?? 0;
      const previous = sessionProgress.get(session.id);
      if (!previous || previous.toolCalls !== toolCalls) {
        sessionProgress.set(session.id, {
          toolCalls,
          at: now,
          warnedAt: previous?.warnedAt ?? 0,
        });
        continue;
      }
      if (now - previous.at < SESSION_STALL_MS || now - previous.warnedAt < SESSION_STALL_MS) {
        continue;
      }
      previous.warnedAt = now;
      stallPrompts += 1;
      prompts.push(ctx.hub.dispatch({
        type: "session.prompt",
        sessionId: session.id,
        text: STALL_PROMPT,
      }));
    }
    if (prompts.length > 0) {
      await Promise.allSettled(prompts);
      notify(
        `自动接力：唤醒 ${idleWakes} 个空闲 Agent，纠偏 ${stallPrompts} 个停滞会话`,
        "info",
      );
    }
  }

  async function openScene(challenge: PlatformChallengeView): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    notify("正在开靶，冷启动通常需要十几秒到三分钟…", "info");
    try {
      const result = await ctx.hub.dispatch({ type: "platform.openScene", challengeId: challenge.id });
      if (!result.ok) notify(result.error ?? "开靶失败", "error");
      else notify(result.message ?? "靶机已开启", "info");
      await refreshSnapshot();
    } finally {
      busy = false;
      render();
    }
  }

  async function closeScene(challenge: PlatformChallengeView): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await ctx.hub.dispatch({ type: "platform.closeScene", challengeId: challenge.id });
      if (!result.ok) notify(result.error ?? "关闭失败", "error");
      else notify(result.message ?? "靶机已关闭", "info");
      await refreshSnapshot();
    } finally {
      busy = false;
      render();
    }
  }

  async function submitFlag(
    challenge: PlatformChallengeView,
    flag: string,
    candidateId?: string,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await ctx.hub.dispatch({
        type: "platform.submitFlag",
        challengeId: challenge.id,
        taskId: challenge.taskId ?? undefined,
        candidateId,
        flag,
      });
      if (!result.ok) {
        notify(result.error ?? "提交失败", "error");
        if (result.submission?.rejected && candidateId && challenge.taskId) {
          await ctx.hub.dispatch({
            type: "flag.reject",
            taskId: challenge.taskId,
            candidateId,
          }).catch(() => undefined);
        }
      } else notify(result.message ?? "平台已接收 flag", "info");
      await refreshSnapshot();
    } finally {
      busy = false;
      render();
    }
  }

  async function searchWp(challenge: PlatformChallengeView): Promise<void> {
    const result = await ctx.hub.dispatch({
      type: "platform.searchWp",
      challengeId: challenge.id,
      limit: 10,
    });
    if (!result.ok) {
      notify(result.error ?? "WP 检索失败", "error");
      return;
    }
    const matches = result.wpMatches ?? [];
    const overlay = el("div", { class: "ops-modal-overlay" });
    const modal = el("div", { class: "ops-modal wp-modal" }, [
      el("div", { class: "modal-head" }, [
        el("div", {}, [
          el("div", { class: "modal-kicker" }, "LOCAL WRITEUPS"),
          el("h2", {}, `WP 命中 · ${matches.length}`),
        ]),
        el("button", { class: "modal-close", type: "button" }, "×"),
      ]),
    ]);
    if (matches.length === 0) {
      modal.appendChild(el("div", { class: "inspector-empty" }, "没有找到同类 WP；可按题型继续检索技能库。"));
    } else {
      const list = el("div", { class: "wp-result-list" });
      for (const match of matches) {
        const copy = el("button", { class: "mini-action", type: "button" }, "复制路径");
        copy.addEventListener("click", () => copyText(match.path, "WP 路径已复制"));
        list.appendChild(
          el("div", { class: "wp-result" }, [
            el("div", { class: "wp-result-main" }, [
              el("div", { class: "wp-result-title" }, match.title),
              el("code", { class: "wp-result-path" }, match.path),
              el("div", { class: "wp-result-reason" }, match.reason),
            ]),
            copy,
          ]),
        );
      }
      modal.appendChild(list);
    }
    const close = (): void => overlay.remove();
    modal.querySelector(".modal-close")?.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function openLogin(): void {
    const platform = ctx.store.get().platform;
    const overlay = el("div", { class: "ops-modal-overlay" });
    const baseUrl = el("input", {
      class: "login-input",
      type: "url",
      value: platform?.baseUrl ?? "https://your-ctf-platform.example",
      placeholder: "https://platform.example.com",
    }) as HTMLInputElement;
    const provider = el("select", { class: "login-input" }, [
      el("option", { value: "auto" }, "自动识别"),
      el("option", { value: "nest-cyberpeace" }, "强网拟态 / 赛宁 CT"),
      el("option", { value: "ctfd" }, "CTFd"),
      el("option", { value: "ctfy" }, "CTFy MCP"),
    ]) as HTMLSelectElement;
    provider.value =
      platform?.provider === "ctfd" || platform?.provider === "ctfy" || platform?.provider === "nest-cyberpeace"
        ? platform.provider
        : "auto";
    const username = el("input", {
      class: "login-input",
      type: "text",
      value: platform?.username ?? "",
      placeholder: "平台账号 / 用户名（CTFd Token 模式可留空）",
      autocomplete: "username",
    }) as HTMLInputElement;
    const password = el("input", {
      class: "login-input",
      type: "password",
      placeholder: "密码 / CTFd Token / CTFy MCP Token",
      autocomplete: "current-password",
    }) as HTMLInputElement;
    const remember = el("input", {
      type: "checkbox",
      checked: "",
    }) as HTMLInputElement;
    const error = el("div", { class: "login-error" });
    const submit = el("button", { class: "ops-primary-btn full", type: "submit" }, "登录并同步题目");
    const form = el("form", { class: "login-form" }, [
      el("label", { class: "login-label" }, ["平台地址", baseUrl]),
      el("label", { class: "login-label" }, ["平台类型", provider]),
      el("label", { class: "login-label" }, ["账号", username]),
      el("label", { class: "login-label" }, ["密码", password]),
      el("label", { class: "login-check" }, [remember, " 使用系统安全存储记住密码"]),
      error,
      submit,
    ]);
    const close = (): void => overlay.remove();
    const modal = el("div", { class: "ops-modal login-modal" }, [
      el("div", { class: "modal-head" }, [
        el("div", {}, [
          el("div", { class: "modal-kicker" }, "CONNECT COMPETITION"),
          el("h2", {}, "登录比赛平台"),
        ]),
        el("button", { class: "modal-close", type: "button" }, "×"),
      ]),
      el("p", { class: "login-copy" }, "登录后立即拉取全部题目。账号密码只经主进程发往平台；密码可用 Electron safeStorage 加密保存。"),
      form,
    ]);
    modal.querySelector(".modal-close")?.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selectedProvider = provider.value;
      if (
        !password.value ||
        (!username.value.trim() &&
          selectedProvider !== "ctfd" &&
          selectedProvider !== "ctfy" &&
          !password.value.startsWith("ctfd_") &&
          !password.value.startsWith("pf_"))
      ) {
        error.textContent = "请填写账号和密码/Token";
        return;
      }
      submit.disabled = true;
      submit.textContent = "正在登录并同步…";
      error.textContent = "";
      void ctx.hub.dispatch({
        type: "platform.login",
        username: username.value.trim(),
        password: password.value,
        baseUrl: baseUrl.value.trim() || undefined,
        provider: selectedProvider,
        raceId: platform?.race?.id,
        remember: remember.checked,
      }).then(async (result) => {
        if (!result.ok) {
          error.textContent = result.error ?? "登录失败";
          submit.disabled = false;
          submit.textContent = "登录并同步题目";
          return;
        }
        close();
        notify(result.message ?? "平台已连接", "info");
        await refreshSnapshot();
      }).catch((err: unknown) => {
        error.textContent = (err as Error).message;
        submit.disabled = false;
        submit.textContent = "登录并同步题目";
      });
    });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    window.setTimeout(() => (platform?.username ? password : username).focus(), 30);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.matches("input, textarea, select") ||
      target?.isContentEditable
    ) {
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.key.toLowerCase() === "n") {
      const next = nextUnsolvedChallenge();
      if (!next) return;
      event.preventDefault();
      selectedId = next.id;
      writeStorage(SELECTED_KEY, selectedId);
      render();
      grid.querySelector<HTMLElement>(`[data-challenge-id="${next.id}"]`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      return;
    }
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      autopilot = true;
      writeStorage(AUTOPILOT_KEY, "1");
      void startBestChallenge();
    }
  };
  document.addEventListener("keydown", onKeyDown);

  const unsubscribe = ctx.store.subscribeCompetition(() => scheduleRender());
  const timer = window.setInterval(() => {
    countdownValue.textContent = countdownText(ctx.store.get().platform?.race?.endAt ?? null);
  }, 1000);
  autopilotTimer = window.setInterval(() => {
    void kickAutopilot();
  }, 20_000);
  probeTimer = window.setInterval(() => {
    void probeActiveScenes();
  }, SCENE_PROBE_INTERVAL_MS);
  window.setTimeout(() => {
    void probeActiveScenes();
  }, 5_000);
  window.setTimeout(() => {
    if (autopilot) void kickAutopilot();
  }, 4_000);
  countdownValue.textContent = countdownText(ctx.store.get().platform?.race?.endAt ?? null);
  render();

  return {
    dispose: () => {
      disposed = true;
      document.removeEventListener("keydown", onKeyDown);
      unsubscribe();
      window.clearInterval(timer);
      if (autopilotTimer !== null) window.clearInterval(autopilotTimer);
      if (probeTimer !== null) window.clearInterval(probeTimer);
      if (renderTimer !== null) window.clearTimeout(renderTimer);
    },
    refresh: render,
    openLogin,
  };
}
