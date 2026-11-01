/**
 * R-5 · 档位不对称（tier asymmetry）的渲染层知识，集中在这一个文件里。
 *
 * 背景（docs/BLOCKED.md R-5）：`guarded` / `autonomous` 这个档位，在四家 agent 上语义
 * 不同 —— 对 claude / opencode，档位只决定「问了之后是否转人工」（§9.2 档位兜底）；
 * 对 codex / dsh，档位决定它的沙箱与「问不问」（guarded → 我们把它切到受控的
 * workspace-write / read-only，越界写会问；autonomous → 保持它们自己的默认
 * （codex `agent` 自动复核 / dsh `workspace-write`），通常不问）。
 * ⚠ codex 在 Windows 上联网不保证被沙箱拦（实测 curl 200 / 0 审批），文案不得承诺「联网会问」。
 *
 * 为什么这些是「推导」而不是读字段：契约（冻结）里既没有「某会话的实际生效 mode」，
 * 也没有「每会话闸门是否武装」——`HubSnapshot.agents[].permissionBehavior` 说的是「我们这样
 * 运行它会不会问」的粗粒度结论（三家都已是 requests_by_default），它分不出 codex 的
 * autonomous 档。所以这里只能从「agent + tier」现算。
 *
 * ⚠ 必须和 apps/desktop/src/main/session/manager.ts 里的**实际武装逻辑**保持同步：
 *   - claude：原生就会问，manager.ts 对它不做任何武装；
 *   - opencode：manager.ts 按会话注入 OPENCODE_CONFIG_CONTENT（permission.edit/bash=ask），
 *     与档位无关（BUMIMANG_ARM_OPENCODE=off 可关，渲染层拿不到这个环境变量）；
 *   - codex：manager.ts 只在 guarded 档调 session/set_config_option(mode="workspace-write")，
 *     autonomous 档不动（保持 codex 默认 agent 自动复核；BUMIMANG_ARM_CODEX=off 可关）。
 *   - dsh（T14）：manager.ts 在 spawn 时注入 DSH_PERMISSION_MODE —— guarded → read-only
 *     （会问，实测 request_permission=1）、autonomous → workspace-write（不问，实测 0）。
 *     与 codex 同构，同样按档位而非按 agent 决定（BUMIMANG_ARM_DSH=off 可关）。
 * 若 manager.ts 的武装逻辑变了（新 agent / 新档位 / 新开关），先改这里，再改文案。
 */
import type { Tier } from "./contract.ts";

export type GateArmed = "armed" | "not_armed" | "unknown";

/**
 * 某会话的闸门是否真的会产生审批输入（armed = 会问）。
 * 纯函数：只依赖 agent id + 档位，方便在 smoke / 验收脚本里确定性断言。
 */
export function sessionGateArmed(agentId: string, tier: Tier): GateArmed {
  switch (agentId) {
    case "claude":
    case "opencode":
      // 两档都会请求授权（原生 / 注入配置）；档位只决定请求是否转人工。
      return "armed";
    case "codex":
      // R16：guarded 切 workspace-write（越界写/联网才问），autonomous 用 codex 默认的
      // agent（自动复核，判定不安全时仍会问）。两档都可能产生审批卡。
      return "armed";
    case "dsh":
      // 只有 guarded 会切 read-only（DSH_PERMISSION_MODE=read-only）→ 才会问；
      // autonomous 保持 workspace-write 默认 → 不问。
      return tier === "guarded" ? "armed" : "not_armed";
    default:
      // 未来新增的 agent 按未知处理。
      return "unknown";
  }
}

export interface GateBadge {
  text: string;
  /** CSS 类：gate-armed / gate-not-armed / gate-unknown */
  cls: string;
  /** 悬停说明，把「armed 与否」翻译成用户能懂的后果。 */
  title: string;
}

/** 会话卡上要画的「闸门是否武装」徽标（文字 + CSS 类 + 悬停说明）。 */
export function gateBadge(agentId: string, tier: Tier): GateBadge {
  switch (sessionGateArmed(agentId, tier)) {
    case "armed":
      // codex 的 workspace-write 在 Windows 上对「越界写」会问，但联网并不保证被沙箱
      // 拦住（实测 curl 直接 200、request_permission=0）。徽标文案不能继续承诺「联网会问」。
      if (agentId === "codex") {
        return {
          text: "闸门已武装",
          cls: "gate-armed",
          title:
            "guarded 用 workspace-write：工作区内可写，越界写会转人工；autonomous 用默认 agent（自动复核）。" +
            "注意：Windows 上 codex 沙箱不保证拦截联网（curl 可能直接放行），联网合规需人工另查。",
        };
      }
      return {
        text: "闸门已武装",
        cls: "gate-armed",
        title: "该会话会产生审批请求（会问）。guarded 档转人工，autonomous 档自动放行。",
      };
    case "not_armed":
      return {
        text: "闸门未武装",
        cls: "gate-not-armed",
        title: "该会话不会请求授权（dsh 的 autonomous 档保持 workspace-write 默认，不主动问），审批面板会一直为空。",
      };
    case "unknown":
      return {
        text: "闸门未知",
        cls: "gate-unknown",
        title: "该 agent 的闸门行为未知（未探测过的新引擎）。",
      };
  }
}

/** 扇出弹窗里、选中某 agent 时的档位差异说明（一句，不是一段）。 */
export function tierNoteFor(agentId: string): string | null {
  switch (agentId) {
    case "claude":
    case "opencode":
      return "它两档都会请求授权；档位只决定请求转人工（guarded）还是自动放行（autonomous）。";
    case "codex":
      return "guarded 用 workspace-write：工作区内可写、越界写会问；Windows 上联网不保证被拦（curl 可能直接放行）。autonomous 用默认 agent（自动复核）。";
    case "dsh":
      return "档位决定它问不问：guarded 会问（本应用按档切 read-only），autonomous 不问（审批面板会一直空）。";
    default:
      return null;
  }
}
