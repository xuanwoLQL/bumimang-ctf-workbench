/**
 * T7 多窗格实时事件流（DOM 层）→ R14 改为「浏览器式标签页」。
 *
 * 每个会话一个窗格，消费 `session.stream`。渲染频率由 SessionStreamSink 的
 * 节流器控制（默认 80ms 一刷）。
 *
 * R13 改造（2026-10-13）：从「平铺行日志」升级成「对话流」（Codex 工作流那种读法）——
 *   - 每个会话窗格是一段**对话**：agent 消息、思考、工具步（带状态）、计划、其它；
 *   - 一个流式 chunk **累加进当前块**，而不是 append 一行；tool_call + tool_call_update
 *     合成一个「工具步」，tool_call_update 原地更新它的状态；
 *   - 自动滚到底只发生在「用户本来就在底部」时（用户往上翻时不被强行拽回）。
 *
 * R14 改造（2026-10-13）：中栏从「多窗格并排」改成「浏览器标签页」——
 *   - 顶部一条标签栏：每会话一个标签（agent · 角色 + 状态点 + 关闭 ×），末尾一个「+」；
 *   - 下方只有一个可见窗格，占满中栏剩余高度（不再并排把每窗格挤到 ~300px）；
 *   - **所有窗格都留在 DOM 里**（`.pane-hidden` 只隐藏不销毁），所以切换标签
 *     不会丢任何会话已渲染的对话流 / 滚动位置 —— 这正是「切换回来还是同一段」的保证；
 *   - 标签状态点复用 `sessionStatusLabel` + 现有 `.status-*` 语义色（blocked 仍读
 *     「被策略切断」且红点，不与 failed「崩溃」混同）。
 */
import type { SessionView, SessionHealth, StreamUpdate } from "../contract.ts";
import type { UiCtx } from "../ctx.ts";
import {
  SessionStreamSink,
  MAX_WINDOW_TEXT,
  fitWindowStart,
  sessionQuietHint,
  selectPaneSessions,
} from "./model.ts";
import type { ConvBlock, ConvBlockKind, ConvLog } from "./model.ts";
import { sessionStatusLabel, isTerminalStatus } from "../session-status.ts";
import { buildScorecard, scorecardText, scorecardTitle } from "../scorecard.ts";
import { openFanoutModal } from "../fanout/fanout.ts";
import { notify } from "../notice.ts";
import { el, clear } from "../dom.ts";

const KIND_LABEL: Record<ConvBlockKind, string> = {
  message: "消息",
  thought: "思考",
  user: "你",
  tool: "工具",
  plan: "计划",
  other: "其他",
};

/** tool 步状态 → 中文标签 + 颜色档。未知状态按原文展示，不吞信息。 */
const TOOL_STATUS_LABEL: Record<string, string> = {
  in_progress: "进行中",
  completed: "完成",
  done: "完成",
  failed: "失败",
  error: "失败",
  cancelled: "已取消",
};

function toolStatusCls(status: string | undefined): string {
  if (!status) return "";
  const s = status.toLowerCase();
  if (s === "in_progress") return "st-in-progress";
  if (s === "completed" || s === "done") return "st-done";
  if (s === "failed" || s === "error") return "st-failed";
  if (s === "cancelled") return "st-cancelled";
  return "";
}

const TIER_LABEL: Record<string, string> = { guarded: "受控", autonomous: "自主" };

/**
 * 每个会话最多同时渲染多少个对话块。
 *
 * 为什么不是「全部」：原实现把 sink 里最多 500 个块一次性 append 进 DOM，
 * 且每次状态更新还会把窗格根节点从 stage 上摘下再挂回（滚动位置因此归零、
 * 首次显示一个隐藏标签页时要同步布局整棵 500 块 DOM，表现为切换卡顿）。
 * 这里改成窗口化渲染：DOM 里只保留最近 N 块，用户向上阅读时再按需加载更早的块。
 */
const CONV_WINDOW = 120;

interface Pane {
  sessionId: string;
  disposed: boolean;
  root: HTMLElement;
  header: HTMLElement;
  /** 头部下方的每会话计分卡条：墙钟 / 工具 / 读板 / 滞后 / 审批 / 写板。 */
  scorecard: HTMLElement;
  /** P7-B：MCP 异常断开时显示提示 + 新建会话入口。 */
  mcpBanner: HTMLElement;
  body: HTMLElement;
  /** 会话还没产生任何输出时，窗格 body 里的占位提示（有输出后移除）。 */
  bodyEmpty: HTMLElement;
  hint: HTMLElement;
  sink: SessionStreamSink;
  /** 已渲染块的 id → 元素（按块原地更新用）。 */
  rendered: Map<number, HTMLElement>;
  /** 当前渲染窗口内的块 id（与 log.blocks 的一段连续区间一致）。 */
  renderedOrder: number[];
  /** 当前窗口第一个块的 id；用来在 sink 截断最老块后重新锚定窗口。 */
  windowAnchorId: number | null;
  /** 当前窗口起始下标（仅 history 模式使用；follow 模式每次刷到尾部）。 */
  windowStart: number;
  /** 是否跟随最新消息。用户主动上滚后置 false，「回到最新」后恢复。 */
  following: boolean;
  /** history 模式下窗口尾部之后还有多少块没渲染。 */
  unseen: number;
  /** 最近一次 flush 的 log（加载更早 / 回到最新时重算窗口）。 */
  lastLog: ConvLog | null;
  /** D3：follow 模式下已调度一次 rAF 滚动，避免每 flush 同步读 scrollHeight。 */
  scrollScheduled: boolean;
  /** 底部「回到最新」浮层按钮。 */
  jumpBtn: HTMLElement;
  /** 顶部「加载更早」按钮；没有更早块时隐藏。 */
  loadEarlierBtn: HTMLElement;
  /** 历史是否已拉回；没拉回前实时事件先缓冲，避免顺序错乱。 */
  historyReady: boolean;
  inbox: StreamUpdate[];
  /** 底部人工提示输入区（R16）。 */
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  interruptBtn: HTMLButtonElement;
}

export interface PanesApi {
  getSink(sessionId: string): SessionStreamSink | undefined;
  /** 实时事件入口：历史未就绪时先缓冲，就绪后按序补放（R16）。 */
  pushToSession(sessionId: string, update: StreamUpdate): void;
  /** 切换视图：隐藏时不消费流、不重绘；再显示时重新拉历史。 */
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** 用户是否已在滚动容器底部（容差内视为在底部）。 */
function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function createPanes(container: HTMLElement, ctx: UiCtx): PanesApi {
  const panes = new Map<string, Pane>();
  let attached =
    typeof document !== "undefined" &&
    document.getElementById("app")?.dataset.view === "workspace";
  let needsReload = attached;
  /** 当前激活（可见）的会话 id；null 表示尚无会话。 */
  let activeSessionId: string | null = null;

  // 中栏内部结构：标签栏（顶部）+ 窗格舞台（下方，占满剩余高度）。
  const tabsBar = el("div", { class: "pane-tabs", role: "tablist" });
  const stage = el("div", { class: "pane-stage" });
  // 标签节点按 sessionId 复用：store 每变一次就 clear + 重建会让点击目标在
  // 重绘瞬间失效，也是切换卡顿的一部分。
  const tabNodes = new Map<string, HTMLElement>();
  const addTabBtn = el("button", { class: "pane-tab-add", title: "新会话（agent + 角色 + 档位）" }, "+");
  addTabBtn.addEventListener("click", () => openFanoutModal(ctx));
  container.append(tabsBar, stage);

  function makePane(s: SessionView): Pane {
    const body = el("div", { class: "pane-body" });
    // R11：会话还没有输出时，body 里给一句占位说明 —— 别让新手对着一个空窗格
    // 以为「卡住了 / 坏了」。一旦有事件流进来就移除。
    const bodyEmpty = el("div", { class: "pane-body-empty" }, "会话启动后，对话会实时滚到这里；目前还没有输出。");
    body.appendChild(bodyEmpty);
    // 「加载更早」放在 body 顶部；窗口化渲染时只保留最近 CONV_WINDOW 块。
    const loadEarlierBtn = el("button", { class: "conv-load-earlier", type: "button" }, "加载更早的消息");
    loadEarlierBtn.style.display = "none";
    body.appendChild(loadEarlierBtn);
    // 「回到最新」浮层固定在 body 右下角；用户上滚阅读时出现。
    const jumpBtn = el(
      "button",
      { class: "pane-jump-latest", type: "button", title: "回到最新消息并恢复自动跟随" },
      "回到最新",
    );
    const bodyWrap = el("div", { class: "pane-body-wrap" }, [body, jumpBtn]);
    const streamMeta = el("span", { class: "pane-stream-meta", "data-session": s.id }, "");
    const header = el("header", { class: "pane-header" }, [
      el("span", { class: "pane-agent" }, s.agent),
      el("span", { class: `badge role-${s.role}` }, s.role),
      el("span", { class: `badge tier-${s.tier}` }, TIER_LABEL[s.tier] ?? s.tier),
      el("span", { class: `badge status-${s.status} pane-status` }, sessionStatusLabel(s.status)),
      el("span", { class: "pane-health", "data-session": s.id, title: "健康度：同步滞后（距上次读黑板的 tool call 数）· 工具调用数" }, ""),
      streamMeta,
    ]);
    // 安静提示（GATE-INPUT-STARVED）：默认隐藏，满足条件时显示在窗格底部。
    const hint = el("div", { class: "pane-quiet", "data-session": s.id }, []);
    // 每会话计分卡：头部下方一条平静的小字条，把「哪个会话干了更多 / 谁卡住了 /
    // 跑了多久」压缩成一行可扫读的数字。初始为空，sync() 里统一填充。
    const scorecard = el("div", { class: "pane-scorecard", "data-session": s.id }, "");
    // P7-B：MCP 不可用提示 + 新建会话入口；默认隐藏，sync() 按 session.mcpUnavailable 切换。
    const mcpNewSessionBtn = el(
      "button",
      { class: "btn pane-mcp-new-session", type: "button", style: "margin-left:auto;white-space:nowrap" },
      "新建会话",
    );
    mcpNewSessionBtn.addEventListener("click", () => openFanoutModal(ctx));
    const mcpBanner = el(
      "div",
      {
        class: "pane-mcp-unavailable",
        "data-session": s.id,
        style:
          "display:none;align-items:center;gap:8px;margin:6px 0;padding:6px 8px;" +
          "border:1px solid #d9a441;border-radius:6px;background:#2a2113;color:#f0c36d;font-size:12px",
      },
      [
        el("span", {}, "MCP 不可用：本会话无法再读写黑板。请新建会话继续。"),
        mcpNewSessionBtn,
      ],
    );

    // R16：人工提示输入区。每个会话独立，直接 dispatch session.prompt。
    // agent 正在跑时消息会排队（主进程按会话串行），不会打断当前推理；
    // 想立刻纠正方向就先点「打断」，排队消息会在取消后送达。
    const input = el("textarea", {
      class: "pane-input",
      rows: "2",
      placeholder: "给这个 agent 发提示…（Enter 发送，Shift+Enter 换行）",
      title: "人工提示：agent 正在跑时会排队，当前轮结束后送达",
    }) as HTMLTextAreaElement;
    const sendBtn = el(
      "button",
      { class: "btn pane-send", title: "发送提示" },
      "发送",
    ) as HTMLButtonElement;
    const interruptBtn = el(
      "button",
      { class: "btn pane-interrupt", title: "打断当前这一轮；已排队的提示随后送达" },
      "打断",
    ) as HTMLButtonElement;
    const footer = el("div", { class: "pane-compose" }, [
      input,
      el("div", { class: "pane-compose-actions" }, [interruptBtn, sendBtn]),
    ]);
    // 窗格根节点带上状态类（pane-blocked 等），让策略切断的会话在中栏也一眼可辨。
    const root = el("section", { class: `pane pane-${s.status}`, "data-session": s.id }, [
      header,
      scorecard,
      mcpBanner,
      bodyWrap,
      hint,
      footer,
    ]);

    // `log.blocks` 是 sink 里**累计**的全部块（最多 MAX_BLOCKS），不是本批增量。
    // DOM 里只保留一个窗口（CONV_WINDOW 块）：
    //   - follow 模式：窗口永远贴住最新块，用户看到的就是最新进度；
    //   - 用户上滚后进入 history 模式：窗口冻结，新消息只累计 unseen 计数；
    //   - 「加载更早」把窗口向前扩一屏；「回到最新」重新贴回尾部。
    const rendered = new Map<number, HTMLElement>();
    const renderedOrder: number[] = [];
    const pane: Pane = {
      sessionId: s.id,
      disposed: false,
      root,
      header,
      scorecard,
      mcpBanner,
      body,
      bodyEmpty,
      hint,
      sink: null as unknown as SessionStreamSink,
      rendered,
      renderedOrder,
      windowAnchorId: null,
      windowStart: 0,
      following: true,
      unseen: 0,
      lastLog: null,
      scrollScheduled: false,
      jumpBtn,
      loadEarlierBtn,
      historyReady: false,
      inbox: [],
      input,
      sendBtn,
      interruptBtn,
    };

    const sink = new SessionStreamSink(s.id, {
      onFlush: (log) => {
        if (pane.disposed) return;
        const t0 = performance.now();
        if (log.blocks.length > 0 && bodyEmpty.parentNode) bodyEmpty.remove();
        renderBlockWindow(pane, log, { scroll: true });
        updateStreamMeta(streamMeta, log);
        const ms = performance.now() - t0;
        if (ms > 50) {
          console.warn(`[ui pane.flush] ${ms.toFixed(1)}ms blocks=${log.blocks.length}`);
        }
      },
    });
    pane.sink = sink;

    // 用户滚动意图：离开底部 = 进入「阅读历史」；回到底部且没有更新未读 = 恢复跟随。
    body.addEventListener("scroll", () => {
      const nearBottom = atBottom(body);
      if (!nearBottom) {
        if (pane.following) pane.following = false;
        updateJumpButton(pane);
        return;
      }
      if (!pane.following && pane.unseen === 0) {
        pane.following = true;
        updateJumpButton(pane);
      }
    });

    loadEarlierBtn.addEventListener("click", () => {
      const log = pane.lastLog;
      if (!log) return;
      const beforeHeight = body.scrollHeight;
      const beforeTop = body.scrollTop;
      pane.following = false;
      pane.windowStart = Math.max(0, pane.windowStart - CONV_WINDOW);
      renderBlockWindow(pane, log, { scroll: false });
      // 保持视口内容不动：顶部插入内容后把滚动位置补偿回去。
      body.scrollTop = beforeTop + (body.scrollHeight - beforeHeight);
      updateJumpButton(pane);
    });

    jumpBtn.addEventListener("click", () => {
      const log = pane.lastLog;
      pane.following = true;
      pane.unseen = 0;
      if (log) renderBlockWindow(pane, log, { scroll: false });
      scrollToBottom(body);
      updateJumpButton(pane);
    });

    const currentSession = (): SessionView | undefined =>
      ctx.store.get().sessions.find((x) => x.id === s.id);

    const send = (): void => {
      const text = input.value.trim();
      if (!text) return;
      const cur = currentSession();
      if (!cur) return;
      if (isTerminalStatus(cur.status)) {
        notify("会话已结束，历史只读；请新建会话后再发提示", "error");
        return;
      }
      input.value = "";
      void ctx.hub.dispatch({ type: "session.prompt", sessionId: s.id, text }).then((res) => {
        if (!res?.ok) notify(`提示发送失败：${res?.error ?? "未知错误"}`, "error");
        else if (res.message) notify(res.message, "info");
      });
    };
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    interruptBtn.addEventListener("click", () => {
      void ctx.hub.dispatch({ type: "session.interrupt", sessionId: s.id }).then((res) => {
        if (!res?.ok) notify(`打断失败：${res?.error ?? "未知错误"}`, "error");
        else if (res.message) notify(res.message, "info");
      });
    });

    // R16：先拉历史再放实时事件。历史拉取失败也要放行缓冲，不能让会话永久空白。
    const historyPromise =
      typeof ctx.hub.history === "function" ? ctx.hub.history(s.id) : Promise.resolve([]);
    void historyPromise
      .then((updates) => {
        // 焦点已切走、pane 已被 sync() 卸载：历史回来时直接丢弃，不往脱离的 DOM 里灌。
        if (pane.disposed || !panes.has(s.id)) return;
        for (const u of updates) pane.sink.push(u);
        pane.sink.flush();
      })
      .catch(() => undefined)
      .finally(() => {
        if (pane.disposed || !panes.has(s.id)) return;
        pane.historyReady = true;
        for (const u of pane.inbox.splice(0)) pane.sink.push(u);
        pane.sink.flush();
      });

    return pane;
  }

  /** 把「折叠 N · 工具 M」的聚合计数写进窗格头部 —— 让节流聚合在 UI 上可见。 */
  function updateStreamMeta(el: HTMLElement, log: ConvLog): void {
    if (log.collapsed === 0 && log.toolCalls === 0) {
      el.textContent = "";
      return;
    }
    el.textContent = `折叠 ${log.collapsed} · 工具 ${log.toolCalls}`;
  }

  function scrollToBottom(body: HTMLElement): void {
    body.scrollTop = body.scrollHeight;
  }

  /**
   * D3：follow 模式滚动改为 rAF 合并。
   *
   * 旧实现每次 flush 都同步读 `scrollHeight`，强制布局；thought 块大时（run 2：
   * 69.6KB 末块 / 221KB 窗口）单次 181ms。这里每帧最多滚一次，配合块文本上限 +
   * 窗口文本预算，避免 flush 与布局互相追赶。
   */
  function scheduleScroll(p: Pane): void {
    if (p.scrollScheduled) return;
    p.scrollScheduled = true;
    const run = (): void => {
      p.scrollScheduled = false;
      if (p.following) p.body.scrollTop = p.body.scrollHeight;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** 「回到最新」按钮的可见性与未读计数。 */
  function updateJumpButton(p: Pane): void {
    const visible = !p.following;
    p.jumpBtn.classList.toggle("on", visible);
    p.jumpBtn.textContent = p.unseen > 0 ? `回到最新 · ${p.unseen} 条新消息` : "回到最新";
    p.root.classList.toggle("pane-reading-history", visible);
  }

  /**
   * 窗口化渲染对话块（替代旧的全量 reconcile）。
   *
   * 不变量：
   *  - follow 模式：窗口 = log.blocks 的最后 CONV_WINDOW 块，刷完滚到底部；
   *  - history 模式：窗口起点由 `windowAnchorId` 锚定，新消息只增加 `unseen`，
   *    DOM 与滚动位置都不动（用户正在阅读）；
   *  - sink 因 MAX_BLOCKS 截断最老块时，锚点丢失就退到当前最早的可读块；
   *  - 只有最后一个块会跨 flush 增长，其余块只创建、不重绘。
   */
  function renderBlockWindow(p: Pane, log: ConvLog, opts: { scroll: boolean }): void {
    p.lastLog = log;
    const total = log.blocks.length;

    if (p.following) {
      // D3：块数上限之外再加文本预算；thought 多时窗口向前收，避免每次 flush 布局过大。
      p.windowStart = fitWindowStart(log.blocks, CONV_WINDOW, MAX_WINDOW_TEXT);
      p.unseen = 0;
    } else if (p.windowAnchorId != null) {
      // 用块 id 重新定位窗口起点：sink 从头部截断后，下标会整体前移，id 不会。
      const idx = log.blocks.findIndex((b) => b.id === p.windowAnchorId);
      p.windowStart = idx >= 0 ? idx : 0;
    }
    if (p.windowStart > total) p.windowStart = Math.max(0, total - CONV_WINDOW);

    const start = Math.max(0, Math.min(p.windowStart, total));
    const end = Math.min(total, start + CONV_WINDOW);
    const windowBlocks = log.blocks.slice(start, end);
    const targetIds = windowBlocks.map((b) => b.id);
    const targetSet = new Set(targetIds);
    p.windowStart = start;
    p.windowAnchorId = windowBlocks[0]?.id ?? null;

    // 1. 摘掉窗口外的节点（截断或窗口前移时）。
    for (const [id, node] of [...p.rendered]) {
      if (targetSet.has(id)) continue;
      node.remove();
      p.rendered.delete(id);
    }

    // 2. 创建缺失节点；已存在的节点只在它是窗口末块时原地更新。
    //    `loadEarlierBtn` 永远是 body 的第一个子节点，cursor 从它后面开始。
    let cursor: Node | null = p.loadEarlierBtn.nextSibling;
    for (let i = 0; i < windowBlocks.length; i++) {
      const b = windowBlocks[i];
      let node = p.rendered.get(b.id);
      if (!node) {
        node = renderBlock(b);
        p.rendered.set(b.id, node);
      } else if (i === windowBlocks.length - 1) {
        patchBlock(node, b);
      }
      if (node === cursor) {
        cursor = node.nextSibling;
      } else {
        p.body.insertBefore(node, cursor);
      }
    }
    p.renderedOrder = targetIds;

    // 3. 「加载更早」按钮：只有窗口前面还有块时才出现，并始终贴在顶部。
    const hasEarlier = start > 0;
    p.loadEarlierBtn.style.display = hasEarlier ? "" : "none";
    if (hasEarlier) {
      p.loadEarlierBtn.textContent = `加载更早的消息（还有 ${start} 条）`;
      if (p.body.firstChild !== p.loadEarlierBtn) {
        p.body.insertBefore(p.loadEarlierBtn, p.body.firstChild);
      }
    }

    // 4. 未读计数 + 自动滚动：只有 follow 模式才把视口拉到底。
    p.unseen = p.following ? 0 : Math.max(0, total - end);
    if (opts.scroll && p.following) scheduleScroll(p);
    updateJumpButton(p);
  }

  function renderBlock(b: ConvBlock): HTMLElement {
    const node = el("div", { class: `conv-block conv-${b.kind}`, "data-block-id": String(b.id) });
    patchBlock(node, b);
    return node;
  }

  /**
   * 把块内容写进节点；身份不变即「原地更新」。
   *
   * D3：不再每次 flush 重建 head/文本节点。head 只建一次；文本块优先在现有
   * Text 节点上 appendData（增量），只有截断/回放等非前缀更新才整体赋值。
   * 这样每次 flush 的 DOM 创建量从「head + 完整 text div」降到「一个 delta」。
   */
  function patchBlock(node: HTMLElement, b: ConvBlock): void {
    let head = node.querySelector<HTMLElement>(":scope > .conv-head");
    if (!head) {
      head = el("div", { class: "conv-head" }, [
        el("span", { class: "conv-time" }, fmtTime(b.ts)),
        el("span", { class: `conv-label conv-label-${b.kind}` }, KIND_LABEL[b.kind]),
      ]);
      node.appendChild(head);
    }

    if (b.kind === "tool") {
      let toolKind = head.querySelector<HTMLElement>(".conv-tool-kind");
      if (b.toolKind) {
        if (!toolKind) {
          toolKind = el("span", { class: "conv-tool-kind" });
          head.appendChild(toolKind);
        }
        if (toolKind.textContent !== b.toolKind) toolKind.textContent = b.toolKind;
      } else {
        toolKind?.remove();
      }
      let status = head.querySelector<HTMLElement>(".conv-tool-status");
      if (b.status) {
        const cls = `conv-tool-status ${toolStatusCls(b.status)}`;
        const label = TOOL_STATUS_LABEL[b.status] ?? b.status;
        if (!status) {
          status = el("span", { class: cls });
          head.appendChild(status);
        } else if (status.className !== cls) {
          status.className = cls;
        }
        if (status.textContent !== label) status.textContent = label;
      } else {
        status?.remove();
      }
      let title = node.querySelector<HTMLElement>(":scope > .conv-title");
      if (b.title) {
        if (!title) {
          title = el("div", { class: "conv-title" });
          node.appendChild(title);
        }
        if (title.textContent !== b.title) title.textContent = b.title;
      } else {
        title?.remove();
      }
      return;
    }

    let textEl = node.querySelector<HTMLElement>(":scope > .conv-text");
    if (!textEl) {
      textEl = el("div", { class: "conv-text" });
      node.appendChild(textEl);
    }
    const next = b.text ?? "";
    const prev = textEl.textContent ?? "";
    if (next === prev) return;
    if (prev && next.startsWith(prev) && textEl.firstChild?.nodeType === 3) {
      (textEl.firstChild as Text).appendData(next.slice(prev.length));
    } else {
      textEl.textContent = next;
    }
  }

  function updateHeader(p: Pane, s: SessionView, health?: SessionHealth): void {
    // 更新状态徽标（简单做法：重画 header 里的 status/health 两个节点）
    const status = p.header.querySelector(".pane-status");
    const healthEl = p.header.querySelector(".pane-health");
    const statusEl = el("span", { class: `badge status-${s.status} pane-status` }, sessionStatusLabel(s.status));
    if (status) status.replaceWith(statusEl);
    else p.header.appendChild(statusEl);
    // 状态可能随事件流转（running → blocked/failed/stopped），窗格根节点的状态类也要跟着换；
    // 同时保留 pane-active / pane-hidden（标签页可见性），别把切换状态抹掉。
    const wasActive = p.root.classList.contains("pane-active");
    p.root.className = `pane pane-${s.status}${wasActive ? " pane-active" : " pane-hidden"}`;

    if (healthEl) {
      clear(healthEl);
      if (health) {
        const lag = health.syncLag;
        const cls = lag > 12 ? "sync-red" : lag > 8 ? "sync-yellow" : "sync-ok";
        healthEl.className = `pane-health ${cls}`;
        healthEl.textContent = `同步 ${lag} · tool ${health.toolCalls}`;
      } else {
        healthEl.className = "pane-health";
        healthEl.textContent = "同步 N/A";
      }
    }
  }

  /** 安静提示（GATE-INPUT-STARVED）：0 审批 + 0 读黑板跑了有一阵，才显示一句平静提示。 */
  function updateHint(p: Pane, s: SessionView): void {
    const state = ctx.store.get();
    const text = sessionQuietHint({
      status: s.status,
      startedAt: s.startedAt,
      approvalsForSession: state.approvals.filter((a) => a.sessionId === s.id).length,
      boardReads: state.health[s.id]?.boardReads ?? 0,
      now: Date.now(),
    });
    clear(p.hint);
    if (text) {
      p.hint.classList.add("pane-quiet-on");
      p.hint.appendChild(el("span", { class: "pane-quiet-text" }, text));
    } else {
      p.hint.classList.remove("pane-quiet-on");
    }
  }

  /** 每会话计分卡：从 store 快照里现有的字段（startedAt/endedAt、health、approvals、
   *  board.facts/deadEnds）算出一行数字，写进窗格头部下方的小字条。 */
  function updateScorecard(p: Pane, s: SessionView): void {
    const state = ctx.store.get();
    const sc = buildScorecard({
      session: s,
      health: state.health[s.id],
      approvals: state.approvals,
      facts: state.facts,
      deadEnds: state.deadEnds,
      now: Date.now(),
    });
    p.scorecard.textContent = scorecardText(sc);
    p.scorecard.title = scorecardTitle(sc);
  }

  /** P7-B：MCP 不可用只影响运行中的会话；终态会话不显示“新建会话”提示。 */
  function updateMcpBanner(p: Pane, s: SessionView): void {
    const show = s.mcpUnavailable === true && !isTerminalStatus(s.status);
    p.mcpBanner.style.display = show ? "flex" : "none";
  }

  /** R11：会话没有产生输出时的 body 占位文案 —— 起会话中 vs 已终态（永远不会有输出）要分开。 */
  function updateBodyEmpty(p: Pane, s: SessionView): void {
    if (p.sink.snapshot().blocks.length > 0) {
      if (p.bodyEmpty.parentNode) p.bodyEmpty.remove();
      return;
    }
    p.bodyEmpty.textContent = isTerminalStatus(s.status)
      ? "该会话没有产生任何输出。"
      : "会话启动后，对话会实时滚到这里；目前还没有输出。";
  }

  /** R16：终态会话禁用输入；只有正在跑的会话可以「打断」。 */
  function updateCompose(p: Pane, s: SessionView): void {
    const terminal = isTerminalStatus(s.status);
    const running = s.status === "running" || s.status === "waiting_approval";
    p.input.disabled = terminal;
    p.sendBtn.disabled = terminal;
    p.interruptBtn.disabled = !running;
    p.input.placeholder = terminal
      ? "会话已结束，历史只读；点左上「+ 扇出」新建会话继续"
      : running
        ? "发提示（会排队，当前轮结束后送达）……"
        : "给这个 agent 发提示…（Enter 发送，Shift+Enter 换行）";
  }

  // —— 标签页选择 / 可见性 ——

  function selectTab(id: string): void {
    activeSessionId = id;
    // 先同步切换标签高亮（点击的即时视觉反馈），再切换窗格可见性。
    // 窗格 DOM 不重建；窗口化后每个窗格最多 CONV_WINDOW 块，显示代价有上界。
    applyTabSelection();
    applyPaneVisibility();
  }

  function applyTabSelection(): void {
    for (const [id, tab] of tabNodes) {
      const active = id === activeSessionId;
      tab.classList.toggle("pane-tab-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  /** 只切换可见性，不重建任何窗格 DOM —— 这是「切走再切回仍是同一段对话」的关键。 */
  function applyPaneVisibility(): void {
    for (const [id, p] of panes) {
      const active = id === activeSessionId;
      p.root.classList.toggle("pane-active", active);
      p.root.classList.toggle("pane-hidden", !active);
      // 隐藏期间 scrollHeight 为 0；切回来时按当前模式恢复视口。
      if (active && p.following) scrollToBottom(p.body);
    }
  }

  function applyVisibility(): void {
    applyTabSelection();
    applyPaneVisibility();
  }

  function removeSession(id: string): void {
    // R20：关标签 = session.remove（先停、再从列表隐藏，历史保留可回看）。
    void ctx.hub.dispatch({ type: "session.remove", sessionId: id }).then((res) => {
      if (!res?.ok) notify(`关闭失败：${res?.error ?? "未知错误"}`, "error");
    });
  }

  function makeTab(s: SessionView): HTMLElement {
    const label = el("span", { class: "pane-tab-label" }, [
      el("span", { class: "pane-tab-agent" }, s.agent),
      el("span", { class: "pane-tab-role" }, s.role),
    ]);
    // 状态点：复用 sessionStatusLabel + 现有 status-* 语义色（blocked → 红「被策略切断」）。
    const status = el(
      "span",
      { class: `pane-tab-status status-${s.status}`, title: sessionStatusLabel(s.status) },
      sessionStatusLabel(s.status),
    );
    const close = el("button", { class: "pane-tab-close", title: "关闭标签：会话会停止并从列表隐藏，历史保留可回看" }, "×");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSession(s.id);
    });
    const tab = el(
      "div",
      {
        class: "pane-tab",
        role: "tab",
        "data-session": s.id,
        tabindex: "0",
        title: `${s.agent} · ${s.role} · ${sessionStatusLabel(s.status)}`,
      },
      [label, status, close],
    );
    tab.addEventListener("click", () => selectTab(s.id));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTab(s.id);
      }
    });
    return tab;
  }

  /** 原地更新标签的状态点/标题，不重建节点（保持点击目标与焦点稳定）。 */
  function updateTab(tab: HTMLElement, s: SessionView): void {
    tab.title = `${s.agent} · ${s.role} · ${sessionStatusLabel(s.status)}`;
    const status = tab.querySelector<HTMLElement>(".pane-tab-status");
    if (status) {
      status.className = `pane-tab-status status-${s.status}`;
      status.title = sessionStatusLabel(s.status);
      status.textContent = sessionStatusLabel(s.status);
    }
    const agent = tab.querySelector<HTMLElement>(".pane-tab-agent");
    if (agent) agent.textContent = s.agent;
    const role = tab.querySelector<HTMLElement>(".pane-tab-role");
    if (role) role.textContent = s.role;
  }

  function renderTabs(sessions: SessionView[]): void {
    const seen = new Set(sessions.map((s) => s.id));
    for (const [id, tab] of [...tabNodes]) {
      if (seen.has(id)) continue;
      tab.remove();
      tabNodes.delete(id);
    }
    const desired: HTMLElement[] = [];
    for (const s of sessions) {
      let tab = tabNodes.get(s.id);
      if (!tab) {
        tab = makeTab(s);
        tabNodes.set(s.id, tab);
      }
      updateTab(tab, s);
      desired.push(tab);
    }
    // 按 sessions 顺序就位；已经在正确位置的节点不移动。
    for (let i = 0; i < desired.length; i++) {
      const current = tabsBar.children[i] ?? null;
      if (current !== desired[i]) tabsBar.insertBefore(desired[i], current);
    }
    // 末尾「+」：复用扇出入口（agent + 角色 + 档位选择器保持与左栏一致）。
    if (tabsBar.lastChild !== addTabBtn) tabsBar.appendChild(addTabBtn);
  }

  /** 重新进入工作台时丢弃旧 DOM/流缓存，再从磁盘历史重建，避免隐藏期间漏消息。 */
  function resetPanes(): void {
    for (const pane of panes.values()) {
      pane.disposed = true;
      pane.root.remove();
    }
    panes.clear();
    tabNodes.clear();
    clear(tabsBar);
    tabsBar.appendChild(addTabBtn);
    clear(stage);
    activeSessionId = null;
  }

  function sync(): void {
    if (!attached) return;
    const state = ctx.store.get();
    // P1-E：store.sessions 已经是焦点任务；这里再限制焦点最多 3 个 pane。
    // 后台任务根本不在 sessions 里，所以不会创建 DOM / SessionStreamSink。
    const visibleSessions = selectPaneSessions(state.sessions, 3);
    const prevIds = new Set(panes.keys());
    const seen = new Set<string>();
    const ordered: HTMLElement[] = [];
    let newSessionId: string | null = null;

    for (const s of visibleSessions) {
      seen.add(s.id);
      let p = panes.get(s.id);
      if (!p) {
        p = makePane(s);
        panes.set(s.id, p);
        // 新会话：像浏览器开新标签页一样自动切过去。首屏首次加载不算（prevIds 为空时
        // 默认选第一个会话），避免「最后一次扇出」抢走焦点。
        if (prevIds.size > 0) newSessionId = s.id;
      }
      updateHeader(p, s, state.health[s.id]);
      updateScorecard(p, s);
      updateMcpBanner(p, s);
      updateHint(p, s);
      updateBodyEmpty(p, s);
      updateCompose(p, s);
      ordered.push(p.root);
    }

    // 移除已消失的会话窗格
    for (const [id, p] of panes) {
      if (!seen.has(id)) {
        panes.delete(id);
        p.root.remove();
        if (activeSessionId === id) activeSessionId = null;
      }
    }

    if (newSessionId != null) {
      activeSessionId = newSessionId;
    } else if (activeSessionId == null || !seen.has(activeSessionId)) {
      // 焦点切换后旧 active 已不在新 pane 集合里；回到第一个可见会话（没有则空）。
      activeSessionId = visibleSessions[0]?.id ?? null;
    }

    // 只做「必要的 DOM 移动」：绝不再 clear(stage) 整棵重挂。
    // 旧实现每次 store 更新都会把每个窗格根节点摘下再挂回，导致：
    //   ① 隐藏窗格里的 .pane-body 滚动位置被重置（表现为消息区跳回顶部）；
    //   ② 每个会话的整段对话 DOM 重新参与布局（切换标签时约 500ms 的卡顿来源）。
    if (ordered.length === 0) {
      const empty = stage.querySelector<HTMLElement>(".pane-empty");
      if (!empty) {
        clear(stage);
        stage.appendChild(
          el("div", { class: "pane-empty" }, [
            el("div", { class: "pane-empty-title" }, "还没有会话标签页"),
            el(
              "div",
              { class: "pane-empty-desc" },
              "点左栏某个引擎旁的「＋」、或「+ 扇出会话」起一个会话；每个会话会在这里占一个标签页，点标签切换，实时滚动它的对话（消息 / 思考 / 工具调用）。",
            ),
          ]),
        );
      }
      tabsBar.classList.add("pane-tabs-hidden");
    } else {
      stage.querySelector(".pane-empty")?.remove();
      // 窗格顺序与 sessions 保持一致；已经在正确位置的不动。
      for (let i = 0; i < ordered.length; i++) {
        const current = stage.children[i] ?? null;
        if (current !== ordered[i]) stage.insertBefore(ordered[i], current);
      }
      tabsBar.classList.remove("pane-tabs-hidden");
    }
    renderTabs(visibleSessions);
    applyVisibility();
  }

  const unsub = ctx.store.subscribeWorkspace(() => {
    if (!attached) return;
    if (needsReload) {
      needsReload = false;
      resetPanes();
    }
    const t0 = performance.now();
    sync();
    const ms = performance.now() - t0;
    if (ms > 50) console.warn(`[ui panes.sync] ${ms.toFixed(1)}ms`);
  });
  if (attached) {
    const t0 = performance.now();
    needsReload = false;
    sync();
    const ms = performance.now() - t0;
    if (ms > 50) console.warn(`[ui panes.sync initial] ${ms.toFixed(1)}ms`);
  }

  // 「跑了有一阵」随时间推进：事件驱动只会在状态变化时刷新，会话若静默运行，
  // 安静提示要等时钟跨过阈值才出现，计分卡里的墙钟时长也要跟着走。所以用一个
  // 低频计时器只刷新提示条 + 计分卡（不重排窗格，不动对话流）。
  const hintTimer = setInterval(() => {
    if (!attached) return;
    const state = ctx.store.get();
    for (const s of state.sessions) {
      const p = panes.get(s.id);
      if (p) {
        updateScorecard(p, s);
        updateHint(p, s);
      }
    }
  }, 5000);

  return {
    getSink(sessionId) {
      return panes.get(sessionId)?.sink;
    },
    pushToSession(sessionId, update) {
      if (!attached) return;
      const p = panes.get(sessionId);
      if (!p) return;
      if (!p.historyReady) {
        p.inbox.push(update);
        return;
      }
      p.sink.push(update);
    },
    setVisible(visible) {
      if (visible === attached) return;
      attached = visible;
      if (visible) needsReload = true;
    },
    dispose() {
      unsub();
      clearInterval(hintTimer);
    },
  };
}
