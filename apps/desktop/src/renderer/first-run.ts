/**
 * R10 · 首次启动引导（first-run guide）。
 *
 * HANDOVER §5 第 7 条：agent 检测有「灰显 + 安装提示」，但新手没有一个地方
 * 一次性回答「开始之前该知道什么」。这里补一个**克制的**首启面板（不是 wizard，
 * 只是一块 dismissible 浮层，四段话）：
 *
 *   1. 哪些 agent 可用、哪些真的会产生审批 —— 数据源 `snapshot.agents[].permissionBehavior`
 *      （T14 后四家都是 requests_by_default；名单为空时写「无」，不硬编码哪家会问）。
 *   2. 什么会打断你 —— 只讲**实测**过的事实（写文件 3/3 会问、无害 echo 3/3 不问、
 *      读源码 / 枚举命名管道 / grep 会问），并明确这是小样本、边界未完全摸清。
 *   3. 数据在哪 —— 打包态 `%APPDATA%\bumimang\`（workspace + evidence）；开发态 `<repo>\.ui-run\`。
 *   4. 一行「怎么开始」—— 点「＋ 新任务」填简报 → 选 agent + guarded → 开始。
 *
 * dismissal 的持久化只借渲染进程自己的 `localStorage`（origin=bumimang://.），
 * **不加契约字段、不碰主进程**。localStorage 在 Electron 渲染进程里按 profile 持久
 * （dev 在 .ui-run/electron-profile，打包态在 %APPDATA%\<name>\），与其它 UI 状态同源。
 */
import type { AgentDescriptor } from "./contract.ts";
import type { UiCtx } from "./ctx.ts";
import { el } from "./dom.ts";

/** localStorage 键：渲染进程本地 UI 状态，与契约 / 主进程无关。 */
export const FIRST_RUN_KEY = "bumimang.firstRunDismissed.v1";

/** 访问 localStorage 必须包 try/catch：非标准源 / 隐私模式下可能抛 SecurityError。 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function firstRunDismissed(): boolean {
  return storage()?.getItem(FIRST_RUN_KEY) === "1";
}

export function markFirstRunDismissed(): void {
  try {
    storage()?.setItem(FIRST_RUN_KEY, "1");
  } catch {
    /* 记不住就只能下次重显，但绝不能让引导把应用搞崩。 */
  }
}

export interface GuideLine {
  text: string;
  /** 附加语义类（producing / nonproducing / hedge），供 DOM 探针与样式精确命中。 */
  kind?: "producing" | "nonproducing" | "hedge";
}

export interface GuideSection {
  heading: string;
  lines: GuideLine[];
}

export interface FirstRunGuide {
  title: string;
  sections: GuideSection[];
}

/** 会产生审批输入的 agent：已安装，且本应用运行它时会请求授权（requests_by_default）。 */
export function producingAgents(agents: AgentDescriptor[]): AgentDescriptor[] {
  return agents.filter((a) => a.installed && a.permissionBehavior === "requests_by_default");
}

/** 不会产生审批的 agent：未安装，或已安装但行为未知 / 需配置。 */
export function nonProducingAgents(agents: AgentDescriptor[]): AgentDescriptor[] {
  return agents.filter((a) => !a.installed || a.permissionBehavior !== "requests_by_default");
}

/** 首启引导内容：由快照里的 agents 现算（纯函数，可在 smoke 里确定性断言）。 */
export function buildFirstRunGuide(agents: AgentDescriptor[]): FirstRunGuide {
  const produce = producingAgents(agents);
  const nonProduce = nonProducingAgents(agents);
  const produceText = produce.length > 0 ? produce.map((a) => a.title).join("、") : "无";
  const nonProduceText =
    nonProduce.length > 0
      ? nonProduce
          .map((a) => (a.installed ? `${a.title}（不保证会问）` : `${a.title}（未安装）`))
          .join("、")
      : "无";

  return {
    title: "开始之前",
    sections: [
      {
        heading: "哪些引擎可用、哪些会产生审批",
        lines: [
          {
            text: `会产生审批：${produceText} —— 已安装，应用运行它们时会请求授权，审批队列会有输入。`,
            kind: "producing",
          },
          {
            text: `不会产生审批：${nonProduceText}。`,
            kind: "nonproducing",
          },
        ],
      },
      {
        heading: "什么会打断你（实测，样本小）",
        lines: [
          {
            text:
              "claude 实测：写文件会请求放行（3/3）；无害命令（如 echo）不请求（3/3）；" +
              "读源码、枚举命名管道、grep 会请求。",
          },
          {
            text: "规律是按「命令分量」分档，不是「是不是命令」——但样本量小（各 3 次），边界尚未完全摸清，别当铁律。",
            kind: "hedge",
          },
        ],
      },
      {
        heading: "数据存在哪",
        lines: [
          { text: "agent 产物：config/app.json 的 workDir（本仓库默认 D:\\agent\\xuanwo\\work）。" },
          { text: "运行态数据：打包后 %APPDATA%\\bumimang\\；开发态 <仓库>\\.ui-run\\。" },
        ],
      },
      {
        heading: "怎么开始（一行）",
        lines: [
          { text: "点「＋ 新任务」填简报（会注入每个会话）→ 选 agent + guarded → 开始。" },
        ],
      },
    ],
  };
}

/**
 * 首次启动时在右上角挂一块引导浮层；dismiss 之后记进 localStorage，下次启动不再出现。
 * 只在 `document` 可用时调用（Node 的 smoke 只 import 纯函数，不走到这里）。
 */
export function showFirstRunGuide(ctx: UiCtx): void {
  if (typeof document === "undefined") return;
  if (firstRunDismissed()) return;

  const guide = buildFirstRunGuide(ctx.store.get().agents);

  const dismiss = (): void => {
    markFirstRunDismissed();
    panel.remove();
  };

  const closeBtn = el("button", { class: "first-run-close", title: "关闭（不再显示）" }, "×");
  closeBtn.addEventListener("click", dismiss);
  const head = el("div", { class: "first-run-head" }, [
    el("h2", { class: "first-run-title" }, guide.title),
    closeBtn,
  ]);

  const sections = guide.sections.map((s) =>
    el("section", { class: "first-run-section" }, [
      el("div", { class: "first-run-section-head" }, s.heading),
      ...s.lines.map((l) =>
        el("div", { class: `first-run-line${l.kind ? ` first-run-${l.kind}` : ""}` }, l.text),
      ),
    ]),
  );

  const dismissBtn = el("button", { class: "btn first-run-dismiss" }, "知道了");
  dismissBtn.addEventListener("click", dismiss);
  const actions = el("div", { class: "first-run-actions" }, [dismissBtn]);

  // 把持久化键挂在面板上（data-storage-key），验收脚本可以读它，而不是硬编码键名。
  const panel = el(
    "div",
    { class: "first-run-panel", "data-storage-key": FIRST_RUN_KEY },
    [head, ...sections, actions],
  );

  document.body.appendChild(panel);
}
