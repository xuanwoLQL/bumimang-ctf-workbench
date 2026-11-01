/**
 * 审批队列 —— 架构文档 §9.2 / §9.5 / §9.6。
 *
 * 为什么它是 T4 的核心：实测证明三家 agent 都**不**把命令执行委托给客户端
 * （`terminal/create`、`fs/*` 各 0 次），所以 `session/request_permission`
 * 是**唯一的事前闸门**。这个队列就是那道闸门。
 *
 * 约定：
 *  - 异步：一个会话等审批不影响其他会话（等审批是 await 在该会话的调用链上）
 *  - 队列按会话分组展示，排序为「风险高到低 + 同风险 FIFO」（§9.5）
 *  - 超时默认拒绝（安全侧）
 *  - `block` 类判定**不经过这里**，它在策略引擎就抛出去了，没有放行按钮（§9.2）
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalStatus,
  ApprovalView,
  RiskLevel,
  TargetView,
} from "../../../../../packages/shared-protocol/events.ts";
import type { OperationProfile } from "../permission/profile.ts";
import { deriveScopeContext } from "../acp/client.ts";

export type Decision = "approved" | "denied";

/**
 * P4-C 批次 2：从策略判定上下文补出审批卡的结构化范围目标。
 *
 * 只对 `no-out-of-scope` 命中做，旧规则一律 null；调用方（main）只传入同一
 * request 的 detail 与当前任务 targets，不重跑 policy.evaluate、不缓存全局状态。
 * 这里使用与 AcpClient 同一个 `deriveScopeContext`，保证目标/最严格判定一致。
 */
export function scopeTargetForApproval(input: {
  rule: string | null;
  action: string;
  detail: Record<string, unknown>;
  targets: TargetView[];
  denyTargets: string[];
}): { kind: string; value: string } | null {
  if (input.rule !== "no-out-of-scope") return null;
  const ctx = deriveScopeContext({
    action: input.action,
    detail: input.detail,
    enabled: true,
    targets: input.targets,
    denyTargets: input.denyTargets,
  });
  return ctx?.target ?? null;
}

/**
 * A4（Codex 评审）：请求的最终结果必须区分「谁决定的」。
 * 之前超时（policy 兜底拒绝）与人工拒绝都返回裸 `Decision`，消费方把两次超时
 * 也累计成重复违规，甚至会触发 markBlocked——超时不是 agent 的错，不该计数。
 */
export interface ApprovalOutcome {
  decision: Decision;
  decidedBy: "human" | "policy";
}

export interface ApprovalRequest {
  taskId: string;
  sessionId: string;
  action: string;
  detail: Record<string, unknown>;
  rule: string | null;
  reason: string;
  /** P4-C 批次 2：命中规则 id（旧调用方不传时回落到 rule）。 */
  ruleId?: string | null;
  /** P4-C 批次 2：策略判定时的结构化范围目标（旧调用方不传时为 null）。 */
  scopeTarget?: { kind: string; value: string } | null;
}

/** 客户端只认这个接口，不关心队列怎么实现 */
export interface ApprovalService {
  request(input: ApprovalRequest): Promise<ApprovalOutcome>;
}

interface Pending {
  view: ApprovalView;
  resolve: (o: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalQueueOptions {
  onUpsert: (view: ApprovalView) => void;
  /** 中栏「agent 自述意图」的数据源（§9.5 三栏卡片） */
  intentSummary?: (sessionId: string) => string | null;
  timeoutMs?: number;
  /** 超时后怎么处理。默认拒绝——安全侧（§9.5） */
  onTimeout?: Decision;
  /**
   * A4：审批落库回调（INSERT OR REPLACE 语义由调用方决定）。
   * 请求创建、人工裁决、超时、清场四类变化都会带完整视图回调一次。
   *
   * 注意：回调抛错**不能**阻止审批 Promise 结算。队列内部会捕获并通过 onError
   * 上报；审批本身仍按内存里的裁决结果继续（落库失败只影响重启后的审计）。
   */
  onPersist?: (view: ApprovalView) => void;
  /**
   * 持久化 / 界面回调失败的可观测出口。默认写 stderr；生产由 main.ts 注入。
   *
   * 早先 onPersist 抛错发生在 resolve 之前：decide() 会留下一个
   * pendingCount=0 但永不结算的 Promise，超时路径还会把异常从 setTimeout
   * 逸出、掀掉主进程（审查 P1）。
   */
  onError?: (err: Error, view: ApprovalView, phase: "create" | "decide" | "timeout" | "deny_all") => void;
  /**
   * 权限增强：把 detail 归类成「读/写/删除/执行…」，供 UI 判断能否一键放行。
   * 不传时保持旧行为（视图不带 category/highRisk 字段）。
   */
  classify?: (
    detail: Record<string, unknown>,
    ctx: { taskId: string; sessionId: string },
  ) => OperationProfile;
}

export class ApprovalQueue implements ApprovalService {
  private pending = new Map<string, Pending>();
  private history: ApprovalView[] = [];
  private sameKind = new Map<string, number>();
  private opts: Required<Pick<ApprovalQueueOptions, "onUpsert" | "timeoutMs" | "onTimeout">> &
    Pick<ApprovalQueueOptions, "intentSummary" | "onPersist" | "onError" | "classify">;

  constructor(opts: ApprovalQueueOptions) {
    this.opts = {
      onUpsert: opts.onUpsert,
      intentSummary: opts.intentSummary,
      timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000,
      onTimeout: opts.onTimeout ?? "denied",
      onPersist: opts.onPersist,
      onError:
        opts.onError ??
        ((err, view, phase) => {
          process.stderr.write(
            `[approval] ${phase} 回调失败（${view.id}）：${err.message}\n`,
          );
        }),
      classify: opts.classify,
    };
  }

  /** 通知 UI / 落库；任何一步失败都不能打断审批结算。 */
  private notify(
    view: ApprovalView,
    phase: "create" | "decide" | "timeout" | "deny_all",
  ): void {
    try {
      this.opts.onUpsert(view);
    } catch (err) {
      this.reportError(err, view, phase);
    }
    try {
      this.opts.onPersist?.(view);
    } catch (err) {
      this.reportError(err, view, phase);
    }
  }

  private reportError(
    err: unknown,
    view: ApprovalView,
    phase: "create" | "decide" | "timeout" | "deny_all",
  ): void {
    try {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), view, phase);
    } catch {
      /* 错误出口本身失败不能反过来影响审批 */
    }
  }

  private rememberHistory(view: ApprovalView): void {
    this.history.push(view);
    if (this.history.length > 500) this.history = this.history.slice(-200);
  }

  /** 待批 + 最近已决（UI 的审批面板要看到刚发生过什么） */
  list(limit = 50): ApprovalView[] {
    const pending = [...this.pending.values()].map((p) => p.view);
    const decided = this.history.slice(-limit).reverse();
    return [...sortByRisk(pending), ...decided];
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** 阻塞式请求：agent 卡在这一步等人工（其他会话不受影响） */
  request(input: ApprovalRequest): Promise<ApprovalOutcome> {
    const id = `ap-${randomUUID().slice(0, 8)}`;
    const signature = `${input.sessionId}|${input.action}|${describe(input.detail).slice(0, 60)}`;
    const seen = (this.sameKind.get(signature) ?? 0) + 1;
    this.sameKind.set(signature, seen);
    const profile = this.opts.classify?.(input.detail, {
      taskId: input.taskId,
      sessionId: input.sessionId,
    });

    const view: ApprovalView = {
      id,
      taskId: input.taskId,
      sessionId: input.sessionId,
      action: input.action,
      command: commandOf(input.detail),
      target: targetOf(input.detail),
      intentSummary: this.opts.intentSummary?.(input.sessionId) ?? null,
      rule: input.rule,
      ruleId: input.ruleId ?? input.rule ?? null,
      scopeTarget: input.scopeTarget ?? null,
      risk: profile?.risk ?? riskOf(input.rule, input.detail),
      category: profile?.category,
      categoryLabel: profile?.label,
      highRisk: profile?.highRisk,
      rememberable: profile?.rememberable,
      status: "pending",
      decidedBy: null,
      sameKindCount: seen,
      createdAt: Date.now(),
      decidedAt: null,
    };

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        view.status = "timeout";
        view.decidedBy = "policy";
        view.decidedAt = Date.now();
        this.rememberHistory(view);
        // resolve 放在 finally：onUpsert/onPersist 失败也必须结算，绝不能把 agent
        // 永远挂在等待里；异常从 setTimeout 逸出还会掀掉主进程。
        try {
          this.notify(view, "timeout");
        } finally {
          resolve({ decision: this.opts.onTimeout, decidedBy: "policy" });
        }
      }, this.opts.timeoutMs);

      this.pending.set(id, { view, resolve, timer });
      // 创建通知同样不能抛穿 Promise executor：一旦抛错，pending 记录和定时器
      // 会留在队列里（pendingCount>0 / 定时器僵尸），后续路径无法正确清理。
      this.notify(view, "create");
    });
  }

  decide(id: string, decision: Decision, remember = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.view.status = (decision === "approved" ? "approved" : "denied") as ApprovalStatus;
    p.view.decidedBy = "human";
    p.view.decidedAt = Date.now();
    this.rememberHistory(p.view);
    try {
      this.notify(p.view, "decide");
    } finally {
      p.resolve({ decision, decidedBy: "human" });
    }
    void remember; // 规则学习由 Hub 负责（它才拿得到策略引擎）
    return true;
  }

  /** 批量：§9.5「同类动作一键全放 / 全拒」 */
  bulk(ids: string[], decision: Decision): number {
    let n = 0;
    for (const id of ids) if (this.decide(id, decision)) n += 1;
    return n;
  }

  /** 供 Hub 在 decided 之后取该条上下文，用于规则学习 */
  get(id: string): ApprovalView | undefined {
    return this.pending.get(id)?.view ?? this.history.find((h) => h.id === id);
  }

  /** 会话被硬杀时，把它的待批全部拒掉，避免永久挂着 */
  denyAllOf(sessionId: string, status: ApprovalStatus = "denied"): number {
    let n = 0;
    for (const [id, p] of [...this.pending]) {
      if (p.view.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.view.status = status;
      p.view.decidedBy = "policy";
      p.view.decidedAt = Date.now();
      this.rememberHistory(p.view);
      // 每项独立结算：某一项的落库/UI 回调失败不能中断后面的清理。
      try {
        this.notify(p.view, "deny_all");
      } finally {
        p.resolve({ decision: "denied", decidedBy: "policy" });
      }
      n += 1;
    }
    return n;
  }

  /**
   * 会话结束后清掉「同类计数」。审批记录本身保留在 history 里供回看；
   * 这里只释放会随会话数量无界增长的键（审查 P3）。
   */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}|`;
    for (const k of [...this.sameKind.keys()]) {
      if (k.startsWith(prefix)) this.sameKind.delete(k);
    }
  }
}

// ---------------------------------------------------------------- 内部工具

function describe(detail: Record<string, unknown>): string {
  return JSON.stringify(detail).replace(/\s+/g, " ");
}

function commandOf(detail: Record<string, unknown>): string | null {
  const c = detail.command ?? detail.title;
  return typeof c === "string" ? c : null;
}

function targetOf(detail: Record<string, unknown>): string | null {
  const t = detail.path ?? detail.target ?? detail.cwd;
  return typeof t === "string" ? t : null;
}

/** 风险等级：凭据/破坏性类动作判高，其余中 */
function riskOf(rule: string | null, detail: Record<string, unknown>): RiskLevel {
  const s = `${rule ?? ""} ${describe(detail)}`.toLowerCase();
  if (/credential|destructive|mimikatz|sekurlsa|rm -rf|diskpart/.test(s)) return "high";
  return "medium";
}

const RISK_ORDER: Record<RiskLevel, number> = { blocked: 0, high: 1, medium: 2, low: 3 };

/**
 * 拒绝退避计数 —— 架构文档 §9.6。
 *
 * 为什么需要：`block` 的判定会立刻回 `cancelled`，agent 多数会绕路；但**人工拒绝**时
 * agent 可能原样重试同一条命令。连续被拒到阈值就该终结它——否则人工会被同一条命令
 * 反复打断，那个会话也永远在原地打转。
 */
export class DenialTracker {
  private counts = new Map<string, number>();
  private readonly threshold: number;
  private readonly onThreshold: (sessionId: string, rule: string, count: number) => void;

  /**
   * 注意：这里**不能**用构造函数参数属性（`constructor(private readonly x: T)`）。
   * 那种语法需要代码生成，而本项目的"无 bundler"方案走的是 Node 的类型剥离，
   * 只会**擦除**类型、不做生成 —— 实测直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
   */
  constructor(
    threshold: number,
    onThreshold: (sessionId: string, rule: string, count: number) => void,
  ) {
    this.threshold = threshold;
    this.onThreshold = onThreshold;
  }

  private key(sessionId: string, rule: string): string {
    return `${sessionId}|${rule}`;
  }

  /**
   * 记一次拒绝，返回该「会话 + 签名」的累计次数；到阈值时触发回调并归零。
   *
   * `rule` 这个参数名是历史遗留，现在**应当传"请求内容签名"**（见 `approvalSignature`），
   * 不要传策略规则 id。原因：受控档下不命中具体规则的请求，rule id 都是档位兜底
   * `tier-guarded-default`——用它计数会让"问两件不同的事"也被算成重复违规，
   * 两次就把会话终结掉。
   */
  note(sessionId: string, rule: string): number {
    const k = this.key(sessionId, rule);
    const n = (this.counts.get(k) ?? 0) + 1;
    if (n >= this.threshold) {
      this.counts.set(k, 0);
      this.onThreshold(sessionId, rule, n);
    } else {
      this.counts.set(k, n);
    }
    return n;
  }

  countOf(sessionId: string, rule: string): number {
    return this.counts.get(this.key(sessionId, rule)) ?? 0;
  }

  reset(sessionId: string): void {
    for (const k of [...this.counts.keys()]) {
      if (k.startsWith(`${sessionId}|`)) this.counts.delete(k);
    }
  }
}

/**
 * 把一次权限请求压成"它到底想干什么"的签名，供 `DenialTracker` 判"是不是同一件事"。
 *
 * 为什么不用策略规则 id：档位兜底的请求 rule id 全都一样（`tier-guarded-default`），
 * 用它计数会把两件无关的事当成重复违规。内容签名才对应 §9.6 真正想拦的东西——
 * 「同一个动作被拒了还在试」。
 */
export function approvalSignature(detail: Record<string, unknown>): string {
  const keys = ["title", "command", "path", "target", "kind"];
  const parts: string[] = [];
  for (const k of keys) {
    const v = detail[k];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  }
  const basis = parts.length ? parts.join(" | ") : JSON.stringify(detail ?? {});
  return basis.replace(/\s+/g, " ").slice(0, 120);
}

function sortByRisk(list: ApprovalView[]): ApprovalView[] {
  return [...list].sort((a, b) => {
    const r = RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
    return r !== 0 ? r : a.createdAt - b.createdAt; // 同风险 FIFO
  });
}
