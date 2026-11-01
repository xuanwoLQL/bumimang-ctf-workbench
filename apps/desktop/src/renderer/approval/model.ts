/**
 * 审批队列的纯逻辑（无 DOM）：排序、分组、动作构造。
 *
 * 排序策略（ARCHITECTURE §9.5）：风险高到低，同风险内 FIFO。
 * 批量与规则学习走契约里的 `approval.bulk` / `approval.decide(remember)`。
 */
import type { ApprovalView, ApprovalStatus, HubAction, RiskLevel } from "../contract.ts";

const RISK_ORDER: Record<RiskLevel, number> = {
  blocked: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function riskRank(risk: RiskLevel): number {
  return RISK_ORDER[risk];
}

/** 风险高到低 + 同风险 FIFO。 */
export function sortApprovals(list: ApprovalView[]): ApprovalView[] {
  return list.slice().sort((a, b) => {
    const r = riskRank(a.risk) - riskRank(b.risk);
    if (r !== 0) return r;
    return a.createdAt - b.createdAt;
  });
}

/** 待审批的（pending）按风险排序，用于队列主体渲染。 */
export function pendingApprovals(list: ApprovalView[]): ApprovalView[] {
  return sortApprovals(list.filter((a) => a.status === "pending"));
}

/** 同会话同动作的批次聚合 key（§9.5：同类动作聚合成批）。 */
export function batchKey(a: ApprovalView): string {
  return `${a.sessionId}::${a.action}`;
}

export interface Batch {
  key: string;
  sessionId: string;
  action: string;
  ids: string[];
  count: number;
}

export function groupBatches(list: ApprovalView[]): Batch[] {
  const map = new Map<string, Batch>();
  for (const a of list) {
    const k = batchKey(a);
    let b = map.get(k);
    if (!b) {
      b = { key: k, sessionId: a.sessionId, action: a.action, ids: [], count: 0 };
      map.set(k, b);
    }
    b.ids.push(a.id);
    b.count++;
  }
  return [...map.values()];
}

/**
 * 构造裁决动作。
 *
 * `remember` 兼容旧的 boolean 调用（true = 本会话记住）；新 UI 传
 * "session" / "agent" 明确范围。
 */
export function buildDecideAction(
  approvalId: string,
  decision: "approve" | "deny",
  remember?: boolean | "session" | "agent",
): HubAction {
  const scope = typeof remember === "string" ? remember : remember ? "session" : undefined;
  return {
    type: "approval.decide",
    approvalId,
    decision,
    remember: scope != null,
    rememberScope: scope,
  };
}

export function buildBulkAction(ids: string[], decision: "approve" | "deny"): HubAction {
  return { type: "approval.bulk", ids, decision };
}

export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "待审批",
  approved: "已放行",
  denied: "已拒绝",
  timeout: "已超时",
  auto: "已自动放行",
};

export function statusLabel(status: ApprovalStatus): string {
  return APPROVAL_STATUS_LABEL[status] ?? status;
}

/** §9.6 退避计数文案：同类动作首次出现 vs 重复出现。 */
export function sameKindLabel(count: number): string {
  if (count <= 1) return "本会话同类首次出现";
  return `本会话同类已出现 ${count} 次（重复）`;
}

/** 已决（非 pending）项，按决断时间倒序（§9.5：面板要看到刚发生过什么）。 */
export function decidedApprovals(list: ApprovalView[]): ApprovalView[] {
  return list
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
}

/**
 * 全局审批视图的过滤（P1-E）。
 *
 * 默认 `onlyCurrent=true`：只看焦点任务，和 P1-B 的 `approvals` 语义一致。
 * 关掉开关才展示 `approvalsAll`。批量放行必须只对这里过滤出的 id 发
 * `approval.bulk`，否则「看全部」时会误放其他任务。
 */
export function filterApprovals(
  list: ApprovalView[],
  opts: { onlyCurrent: boolean; taskId: string | null },
): ApprovalView[] {
  if (!opts.onlyCurrent) return list.slice();
  if (!opts.taskId) return [];
  return list.filter((a) => a.taskId === opts.taskId);
}

/**
 * `scope=all` 必须显式带焦点 taskId。
 *
 * 主进程 P1-B 的实现仍只取焦点任务；这里把 taskId 带上，既表达“只作用于本任务”，
 * 也避免未来主进程支持 taskId 时被误当成跨任务授权。
 */
export function buildTaskGrantAllAction(taskId: string | null): HubAction | null {
  if (!taskId) return null;
  return { type: "permission.grantAll", scope: "all", taskId };
}
