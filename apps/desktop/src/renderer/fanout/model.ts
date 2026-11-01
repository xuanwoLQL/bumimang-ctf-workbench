/**
 * 加号扇出的纯逻辑（无 DOM）：把「agent + 角色 + 档位」拼成契约动作。
 *
 * 对应 ARCHITECTURE §7.2：点加号问三件事（agent + 角色 + 档位），
 * 再给一个「一键扇出」预设。产出的动作是 `session.start`（契约 `HubAction`）。
 */
import type { HubAction, Role, Tier } from "../contract.ts";
import type { AgentDescriptor } from "../contract.ts";

export interface FanoutChoice {
  agent: string;
  role: Role;
  tier: Tier;
  model?: string;
  /** 用户显式勾选「全部放行」：本会话所有需审批动作自动放行（硬阻断仍生效） */
  allowAll?: boolean;
}

export function buildStartAction(taskId: string, c: FanoutChoice): HubAction {
  const action: HubAction = {
    type: "session.start",
    taskId,
    agent: c.agent,
    role: c.role,
    tier: c.tier,
  };
  if (c.model) (action as { model?: string }).model = c.model;
  if (c.allowAll) action.allowAll = true;
  return action;
}

export const ROLES: Role[] = ["lead", "verify", "recon", "scribe"];
export const TIERS: Tier[] = ["guarded", "autonomous"];

export const ROLE_LABEL: Record<Role, string> = {
  lead: "lead · 主攻",
  verify: "verify · 复现验证",
  recon: "recon · 资料查证",
  scribe: "scribe · 成稿",
};

export const TIER_LABEL: Record<Tier, string> = {
  guarded: "guarded · 受控（逐条审批）",
  autonomous: "autonomous · 自主（只拦硬阻断）",
};

/** 一键扇出预设：三个引擎同时上这道题（§7.2 的例子）。 */
export const PRESET_THREE_ENGINES: FanoutChoice[] = [
  { agent: "codex", role: "lead", tier: "guarded" },
  { agent: "claude", role: "verify", tier: "autonomous" },
  { agent: "opencode", role: "recon", tier: "autonomous" },
];

export function buildPresetActions(taskId: string, allowAll = false): HubAction[] {
  return PRESET_THREE_ENGINES.map((c) =>
    buildStartAction(taskId, allowAll ? { ...c, allowAll: true } : c),
  );
}

export interface AgentUsability {
  usable: number;
  notInstalled: number;
}

/** 把 `snapshot.agents` 拆成「可用 / 未安装」两个计数（§6：检测只报告，不安装）。 */
export function agentUsability(agents: AgentDescriptor[]): AgentUsability {
  const usable = agents.filter((a) => a.installed).length;
  return { usable, notInstalled: agents.length - usable };
}

/** agent 下拉选项标签：可用 / 未安装 一目了然。 */
export function agentOptionLabel(a: AgentDescriptor): string {
  return `${a.title}（${a.installed ? "可用" : "未安装"}）`;
}

/**
 * 把快照里的 `permissionBehavior` 翻成「选哪个 agent」的闸门行为提示。
 *
 * 这份知识真正的家是主进程的 agent 检测（契约 R-2 把 `HubSnapshot.agents[].permissionBehavior`
 * 带过来），渲染层不硬编码哪家会问，只负责把字段说成人话。字段语义见 detect.ts：它说的是
 * 「本应用这样运行它会不会有审批输入」，不是「它原生默认会不会问」——claude 原生会问；
 * 四家都会问：claude/opencode 原生或注入配置，codex/dsh 由本应用按档位武装（T14）。
 *
 * 对「选它，guarded 档有没有东西可拦」这个新手问题，两种状态就够：
 *  - requests_by_default：会主动请求授权 → 审批队列会有输入；
 *  - needs_config / unknown：不保证会问 → 审批队列可能一直为空。
 * （B-3 之前的「开箱即进审批队列」措辞已不对：opencode 是本应用武装的，不是开箱。）
 */
export function gateNoteFor(behavior: AgentDescriptor["permissionBehavior"]): string | null {
  switch (behavior) {
    case "requests_by_default":
      return "本应用运行它时会主动请求授权（guarded 档会有审批输入）";
    case "needs_config":
    case "unknown":
      return "本应用运行它时不一定有审批输入（审批队列可能一直为空）";
    default:
      return null;
  }
}

/**
 * 弹窗顶部的「选哪个 agent」提示：从快照里的 `permissionBehavior` 现算，而不是硬编码哪家会问
 * （B-3 之后 opencode 由本应用自动武装，旧的「只有 Claude Code 开箱会问」已不成立）。
 * 「会主动请求授权」与「不保证会问」两组名单都跟着字段走，字段变了文案自动对。
 */
export function fanoutGateNote(agents: AgentDescriptor[]): string {
  const askTitles = agents
    .filter((a) => a.permissionBehavior === "requests_by_default")
    .map((a) => a.title);
  const unsureTitles = agents
    .filter((a) => a.permissionBehavior === "needs_config" || a.permissionBehavior === "unknown")
    .map((a) => a.title);
  const ask = askTitles.length > 0 ? askTitles.join("、") : "无";
  const unsure = unsureTitles.length > 0 ? unsureTitles.join("、") : "无";
  return `提示：guarded 档的审批输入取决于 agent 会不会主动请求授权 —— 会主动请求授权的：${ask}；不保证会问的：${unsure}（审批队列可能一直为空）。`;
}
