/**
 * 会话状态文案 + 终态判定（纯逻辑，无 DOM）。
 *
 * 契约 SessionStatus 有九个值。§9.6 的「拒绝退避」把会话终止进 blocked ——
 * 这是**策略切断**造成的终态，跟 failed（崩溃退出）与 stopped（人工停止）不是一回事。
 * UI 必须把三者的文案与样式分清楚（ARCHITECTURE §7.7 / §9.6），不能把 blocked
 * 画得像一个崩溃：blocked 要能看出「被规则掐了」，failed 才是「它自己挂了」。
 */
import type { SessionStatus, TaskStatus } from "./contract.ts";

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "启动中",
  idle: "空闲",
  running: "运行中",
  waiting_approval: "等审批",
  waiting_lease: "等租约",
  blocked: "被策略切断",
  done: "已完成",
  failed: "崩溃",
  stopped: "已停止",
};

export function sessionStatusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABEL[status] ?? status;
}

/** 终态：不再有任何流转（blocked / done / failed / stopped）。 */
export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "blocked" || status === "done" || status === "failed" || status === "stopped";
}

/** 任务状态文案（契约 TaskStatus 是英文枚举，UI 不该把 "open" 原样漏给用户看）。 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "待解",
  solving: "解题中",
  solved: "已解出",
  abandoned: "已放弃",
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABEL[status] ?? status;
}
