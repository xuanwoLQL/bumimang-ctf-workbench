/**
 * 策略引擎 —— §9。
 *
 * M1 阶段是 passthrough 占位实现（§12）：一律放行，但**照常留痕**。
 * 这样 M1 的验收脚本在 M3 换上真实规则引擎后应当保持不变。
 */

export type Verdict = "allow" | "approve" | "block";

/** P4-C：从命令/权限文本提取出的目标；`unknown` 表示解析失败或无法判定。 */
export type ScopeTargetKind = "host" | "cidr" | "url" | "unknown";

export interface ScopeTargetRef {
  kind: ScopeTargetKind;
  value: string;
}

/** P4-C：目标是否在任务授权范围内。unknown 表示无法判定（不是放行）。 */
export type ScopeMatch = "in" | "out" | "unknown";

export interface PolicyScopeContext {
  target?: ScopeTargetRef;
  inScope?: ScopeMatch;
  /** V2-P0-5：任务级允许动作；非空时未列出的动作转人工（不静默放行）。 */
  allowedActions?: string[];
}

export interface PolicyRequest {
  /** §9.1 的 action 命名，与 ACP 方法族对齐 */
  action: string;
  sessionId: string;
  /** P4-C：任务 id（审计事件按任务归档；旧调用方可缺席）。 */
  taskId?: string;
  /** §9.2 第 4 步：无规则命中时按档位兜底 —— 受控档转人工、自主档放行 */
  tier?: "autonomous" | "guarded";
  detail: Record<string, unknown>;
  /** P4-C：范围上下文。只在 scope.enabled=true 时由 AcpClient 传入。 */
  scope?: PolicyScopeContext;
}

export interface PolicyDecision {
  verdict: Verdict;
  rule: string;
  reason: string;
}

/** P4-C：每次策略判定的审计记录（不包含命令全文，避免 flag/token 落日志）。 */
export interface PolicyDecisionRecord {
  action: string;
  sessionId: string;
  taskId?: string;
  rule: string;
  verdict: Verdict;
  reason: string;
  scopeEnabled: boolean;
  target: ScopeTargetRef | null;
  inScope: ScopeMatch | null;
  /** V2-P0-5：任务级允许动作（空/缺省 = 不限制）。 */
  allowedActions?: string[];
}

export interface Policy {
  readonly name: string;
  evaluate(req: PolicyRequest): PolicyDecision;
}

/** M1 占位：全部放行（硬阻断机制尚未实现，M3 换成规则包驱动）。 */
export class PassthroughPolicy implements Policy {
  readonly name = "passthrough-placeholder";

  evaluate(req: PolicyRequest): PolicyDecision {
    return {
      verdict: "allow",
      rule: "m1-passthrough",
      reason: `M1 占位实现：${req.action} 直接放行，仅留痕`,
    };
  }
}
