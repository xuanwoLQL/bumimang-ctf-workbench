/**
 * 策略引擎 —— 架构文档 §9.3。
 *
 * 两条设计原则（照文档）：
 *  - **机制写死在引擎里**：`block` 一律不可放行，没有"放行"按钮这条路。
 *  - **内容是数据**：哪些规则进 block，由 `rules/*.json` 决定。
 *
 * 相对文档的一处有意偏离：规则包用 **JSON** 而不是文档示例里的 YAML。
 * 理由：YAML 需要引依赖（js-yaml），而规则包是纯数据、格式可换；不引依赖更符合 C8
 * （队友机器开箱可用）。要换回 YAML 只需加一个解析层，引擎逻辑不动。
 *
 * 实测约束（来自 probe:delegate）：三家 agent 都不发 `terminal/*` 与 `fs/*`，
 * 所以规则里对这两类 action 的匹配在当下基本是死路径；**真正的战场是
 * `session/request_permission`**。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ScopeConfig } from "../config/loader.ts";
import type {
  Policy,
  PolicyDecision,
  PolicyDecisionRecord,
  PolicyRequest,
  ScopeMatch,
  ScopeTargetRef,
  Verdict,
} from "./policy.ts";

export interface RuleMatch {
  /** 精确匹配，或 `terminal/*` 这样的前缀通配 */
  action?: string;
  command_regex?: string;
  /** 对 request_permission 的 toolCall 标题/参数做正则匹配 */
  text_regex?: string;
  /**
   * 只匹配结构化的工具名（`detail.toolName` / `name`，最后回落到 title）。
   *
   * 为什么需要单独的字段：`text_regex` 匹配的是 title + rawInput 等 agent 完全可控的
   * 自由文本。allow 规则如果用它，agent 只要把 `blackboard_read_since` 塞进命令参数，
   * 就能让任意动作命中「黑板工具免审批」而被放行（审查发现的规则绕过）。
   */
  tool_regex?: string;
  /**
   * P4-C：只在 scope.enabled=true 且 inScope 为 `out`/`unknown` 时匹配。
   * 规则生效时 verdict 由 config 的 `scope.outOfScopeAction` 决定（默认 approve）。
   */
  out_of_scope?: boolean;
  /**
   * P4-C：对提取出的目标值做正则匹配。只在 scope.enabled=true 且存在 target 时匹配；
   * scope 关闭时该字段不参与判定，避免改变旧规则行为。
   */
  target_regex?: string;
}

export interface Rule {
  id: string;
  match: RuleMatch;
  verdict: Verdict;
  reason: string;
}

export interface RulePack {
  id: string;
  name: string;
  description?: string;
  rules: Rule[];
}

/** 该会话生效的规则：会话级追加在前，然后任务级，最后包内规则 */
export interface PolicyBindings {
  pack: RulePack;
  /** 会话级追加规则（不整包替换，只在前插） */
  sessionRules?: Rule[];
}

function actionMatches(pattern: string | undefined, action: string): boolean {
  if (!pattern) return true;
  if (pattern.endsWith("/*")) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}

function regexMatches(pattern: string | undefined, haystack: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, "i").test(haystack);
  } catch {
    return false; // 规则写坏了就当不匹配，不要因此放行
  }
}

/** 规则包目录（项目根的 rules/） */
export function rulesDir(repoRoot: string): string {
  return join(repoRoot, "rules");
}

export function loadPack(repoRoot: string, id: string): RulePack | null {
  const p = join(rulesDir(repoRoot), `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RulePack;
  } catch {
    return null;
  }
}

export function listPacks(repoRoot: string): string[] {
  const dir = rulesDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** 规则包缺失或加载失败时的内置最小安全集（§9.3：回落到它并显式提示） */
export const MINIMAL_SAFETY_PACK: RulePack = {
  id: "builtin-minimal",
  name: "内置最小安全集",
  description: "规则包缺失或加载失败时兜底：只拦工作目录外的破坏性操作与凭据类动作。",
  rules: [
    {
      id: "builtin-credential",
      match: { action: "session/request_permission", text_regex: "(mimikatz|sekurlsa|logonpasswords|lsass)" },
      verdict: "approve",
      reason: "兜底规则：凭据类动作需要人工放行",
    },
    {
      id: "builtin-destructive",
      match: { action: "session/request_permission", text_regex: "(rm -rf|format |diskpart)" },
      verdict: "approve",
      reason: "兜底规则：破坏性操作需要人工放行",
    },
  ],
};

export interface EngineOptions {
  repoRoot: string;
  packId: string;
  /**
   * P4-C：范围策略配置。缺席时按 `enabled:false` 处理，保证旧调用方行为不变。
   * 生产路径由 electron/main.ts 传入 config/app.json 的 scope 段。
   */
  scope?: ScopeConfig;
  /**
   * P4-C：每次判定的审计回调。生产路径由 main 注入，写黑板的 `events`；
   * 回调抛错不能影响策略判定本身。
   */
  onDecision?: (record: PolicyDecisionRecord) => void;
}

export class PolicyEngine implements Policy {
  readonly name: string;
  readonly packId: string;
  private baseRules: Rule[];
  private packName: string;
  private sessionRules = new Map<string, Rule[]>();
  /** 规则学习：命中过的白名单签名（§9.5） */
  private learned = new Map<string, Rule[]>();
  /** P4-C：范围策略配置（缺席=关闭）。 */
  private scope: ScopeConfig;
  /** P4-C：判定审计出口（缺席=不写）。 */
  private onDecision?: (record: PolicyDecisionRecord) => void;
  /** 本次启动是否存在规则包回落，UI 需要显式提示（§9.3） */
  readonly fellBackToMinimal: boolean;

  constructor(opts: EngineOptions) {
    this.packId = opts.packId;
    this.scope = opts.scope ?? { enabled: false, outOfScopeAction: "approve", proxy: { enabled: false } };
    this.onDecision = opts.onDecision;
    const pack = loadPack(opts.repoRoot, opts.packId);
    if (pack) {
      this.baseRules = pack.rules;
      this.packName = pack.name;
      this.fellBackToMinimal = false;
    } else {
      this.baseRules = MINIMAL_SAFETY_PACK.rules;
      this.packName = MINIMAL_SAFETY_PACK.name;
      this.fellBackToMinimal = true;
    }
    this.name = `policy-engine(${this.packName})`;
  }

  /** 会话级追加规则（§9.3 第 2 条：追加，不整包替换） */
  addSessionRule(sessionId: string, rule: Rule): void {
    const list = this.sessionRules.get(sessionId) ?? [];
    list.unshift(rule);
    this.sessionRules.set(sessionId, list);
  }

  /** 规则学习：把"这次放行，以后同类自动放行"落成一条 session 级 allow 规则 */
  rememberAllow(sessionId: string, action: string, text: string): void {
    const sig = signatureOf(action, text);
    const list = this.learned.get(sessionId) ?? [];
    list.unshift({
      id: `learned-${sig.slice(0, 12)}`,
      match: { action, text_regex: escapeRegex(text) },
      verdict: "allow",
      reason: "规则学习：人工已放行同类动作",
    });
    this.learned.set(sessionId, list);
  }

  private effectiveRules(sessionId: string): Rule[] {
    return [
      ...(this.learned.get(sessionId) ?? []),
      ...(this.sessionRules.get(sessionId) ?? []),
      ...this.baseRules,
    ];
  }

  evaluate(req: PolicyRequest): PolicyDecision {
    const text = collectText(req.detail);
    const identity = toolIdentity(req.detail);
    const rules = this.effectiveRules(req.sessionId);

    // P4-C：scope.enabled=false 时完全忽略 scope 上下文，逐字走旧逻辑。
    const scopeEnabled = this.scope.enabled === true;
    const scopeCtx = scopeEnabled ? req.scope : undefined;
    const target: ScopeTargetRef | null = scopeCtx?.target ?? null;
    const inScope: ScopeMatch | null = scopeCtx?.inScope ?? null;

    /**
     * out_of_scope 规则的 verdict 不写死在 JSON 里，而是由 config 的
     * `scope.outOfScopeAction` 决定；这样同一个规则包可以在“资格优先（block）”
     * 与“误报优先（approve）”之间切换，而不用改规则文件。
     */
    const verdictOf = (rule: Rule): Verdict => {
      if (rule.match.out_of_scope && scopeEnabled) return this.scope.outOfScopeAction;
      return rule.verdict;
    };

    const matches = (rule: Rule): boolean => {
      if (!actionMatches(rule.match.action, req.action)) return false;
      if (!regexMatches(rule.match.command_regex, text)) return false;
      if (!regexMatches(rule.match.text_regex, text)) return false;
      if (!regexMatches(rule.match.tool_regex, identity)) return false;
      // P4-C：scope 关闭时 out_of_scope/target_regex 一律不参与，旧规则不受影响。
      if (rule.match.out_of_scope) {
        if (!scopeEnabled) return false;
        // unknown 也按范围外处理：无法判定时交给 outOfScopeAction（默认 approve），
        // 不把“不知道”当成“在范围内”直接放行。
        if (inScope !== "out" && inScope !== "unknown") return false;
      }
      if (rule.match.target_regex !== undefined) {
        if (!scopeEnabled || !target) return false;
        if (!regexMatches(rule.match.target_regex, target.value)) return false;
      }
      return true;
    };

    const finish = (decision: PolicyDecision): PolicyDecision => {
      try {
        this.onDecision?.({
          action: req.action,
          sessionId: req.sessionId,
          taskId: req.taskId,
          rule: decision.rule,
          verdict: decision.verdict,
          reason: decision.reason,
          scopeEnabled,
          target,
          inScope,
          allowedActions: req.scope?.allowedActions ?? [],
        });
      } catch {
        // 审计失败不能反过来影响放行/阻断；生产路径由 main 的 callback 自行记 stderr。
      }
      return decision;
    };

    // 机制写死：block 永远优先于 allow。规则包里的 allow（包括会话级追加）不能
    // 把一条 block 规则盖掉 —— 否则「会话级放行」就成了绕过合规硬阻断的后门。
    for (const rule of rules) {
      const verdict = verdictOf(rule);
      if (verdict === "block" && matches(rule)) {
        return finish({ verdict, rule: rule.id, reason: rule.reason });
      }
    }
    // V2-P0-5：任务级 allowedActions 非空时，未列出的动作转人工。
    // 放在 block 之后、allow 之前：不能绕过硬阻断，也不能被普通 allow 规则静默放行。
    if (
      scopeEnabled &&
      req.scope?.allowedActions &&
      req.scope.allowedActions.length > 0 &&
      !req.scope.allowedActions.includes(req.action)
    ) {
      return finish({
        verdict: "approve",
        rule: "action-not-allowed",
        reason: `任务 allowedActions 未包含 ${req.action} → 转人工（scope.enabled=true）`,
      });
    }
    // 非 block 规则保持原有顺序（会话级追加在前），这样「本会话放行」仍能覆盖
    // 基础包里的 approve；但已经不可能覆盖 block。
    for (const rule of rules) {
      const verdict = verdictOf(rule);
      if (verdict !== "block" && matches(rule)) {
        return finish({ verdict, rule: rule.id, reason: rule.reason });
      }
    }
    // §9.2 第 4 步的档位兜底：受控档一律转人工，自主档放行但留痕
    if (req.tier === "guarded") {
      return finish({
        verdict: "approve",
        rule: "tier-guarded-default",
        reason: `${this.packName}：无规则命中，但该会话是受控档 → 转人工`,
      });
    }
    return finish({
      verdict: "allow",
      rule: "tier-autonomous-default",
      reason: `${this.packName}：无规则命中，自主档放行`,
    });
  }
}

/**
 * 结构化工具名：优先 `toolName`（主进程从 ACP toolCall.name/_meta 补全），
 * 其次 `name`，最后才回落到 title（dsh 这类只给 toolCallId 的 agent 由
 * SessionManager 从 tool_call update 补 title）。
 *
 * 注意：这里**不**包含 rawInput / command / options。allow 规则只能认工具身份，
 * 不能因为命令参数里出现了某个工具名就放行。
 */
function toolIdentity(detail: Record<string, unknown>): string {
  const name = detail.toolName ?? detail.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const title = detail.title;
  return typeof title === "string" ? title.trim() : "";
}

/** 把 request_permission 的 toolCall 里的可读文本拼起来给正则匹配 */
function collectText(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (v && typeof v === "object") parts.push(JSON.stringify(v));
  };
  push(detail.title);
  push(detail.name);
  push(detail.kind);
  push(detail.command);
  push(detail.path);
  push(detail.rawInput);
  push(detail.options);
  return parts.join(" \n ");
}

function signatureOf(action: string, text: string): string {
  return `${action}|${text}`.replace(/\s+/g, " ").slice(0, 80);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 120);
}
