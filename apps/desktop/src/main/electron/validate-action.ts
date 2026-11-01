/**
 * HubAction 的运行时校验。
 *
 * 为什么需要：IPC 的 `dispatch` 之前直接把渲染进程传来的任意对象 `as never` 交给 Hub。
 * contextIsolation 只能防渲染进程直接拿 Node，不能防被注入的页面伪造动作；而
 * `session.start.tier` 这类字段一旦写错（例如 `"guarded "`），策略引擎会把它当成
 * 非 guarded，静默落到 autonomous 放行。这里做最小但完整的结构校验。
 *
 * 不引第三方依赖（C8）：手写 switch，字段/枚举/长度逐项检查。
 */
import type { HubAction, TargetKind, TargetStatus, TaskCategory } from "../../../../../packages/shared-protocol/events.ts";
import { validateAnswerSpec } from "../answer/spec.ts";

const TIERS = new Set(["autonomous", "guarded"]);
const ROLES = new Set(["lead", "verify", "recon", "scribe"]);
const TASK_STATUSES = new Set(["open", "solving", "solved", "abandoned"]);
const DECISIONS = new Set(["approve", "deny"]);
const STRATEGY_MODES = new Set(["suggest", "competition-auto"]);
const GRANT_SCOPES = new Set(["session", "agent", "all", "global"]);
const TARGET_KINDS = new Set(["host", "cidr", "url"]);
const TARGET_STATUSES = new Set(["unknown", "alive", "owned"]);
const FLAG_EXPORT_FORMATS = new Set(["md", "csv", "json"]);
const TASK_CATEGORIES = new Set([
  "web",
  "misc",
  "crypto",
  "reverse",
  "pwn",
  "pentest",
  "ir",
  "awd",
  "unknown",
]);

/**
 * 目标动作的语义校验上下文（P4-A，可选）。
 *
 * 结构校验只能看字段；「taskId 存在且未归档」「targetId 属于该任务」必须查库。
 * 传上下文时在结构校验阶段一并拒绝；不传时只做结构校验，语义检查由
 * Hub/board 在 dispatch 时兜底（两条路径都会给出可读错误）。
 * 本包不在 P4-A 的允许改动面内，因此不强制 Electron 主进程注入上下文。
 */
export interface ValidateActionContext {
  task?: (taskId: string) => { archived?: boolean } | undefined;
  target?: (taskId: string, targetId: string) => { id: string } | undefined;
  /**
   * P5-C：candidateId 是否属于 taskId（可选）。
   *
   * 不传时只做结构校验，归属由 Hub 在 dispatch 时用
   * `board.getFlagCandidateById` + `task_id` 兜底；传了就在 IPC 入口提前拒绝。
   */
  candidate?: (taskId: string, candidateId: string) => { id: string } | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(v: unknown, field: string, max = 4096): string {
  if (typeof v !== "string") throw new Error(`${field} 必须是字符串`);
  if (v.length > max) throw new Error(`${field} 过长（>${max}）`);
  return v;
}

function optString(v: unknown, field: string, max = 4096): string | undefined {
  return v === undefined ? undefined : reqString(v, field, max);
}

function reqBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${field} 必须是布尔值`);
  return v;
}

/** 优先级：可选，0–100 的整数；NaN/小数/越界都拒绝（P1-B 只做排序预留）。 */
function optPriority(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
    throw new Error("priority 必须是 0–100 的整数");
  }
  return v;
}

function reqEnum(v: unknown, field: string, allowed: Set<string>): string {
  const s = reqString(v, field, 64);
  if (!allowed.has(s)) {
    throw new Error(`${field} 非法：${JSON.stringify(s)}（允许：${[...allowed].join(", ")}）`);
  }
  return s;
}

function reqStringArray(v: unknown, field: string, maxItems = 1000): string[] {
  if (!Array.isArray(v)) throw new Error(`${field} 必须是数组`);
  if (v.length > maxItems) throw new Error(`${field} 元素过多（>${maxItems}）`);
  return v.map((x, i) => reqString(x, `${field}[${i}]`, 128));
}

/** 附件导入路径：绝对路径可以很长，单独放宽上限；空数组直接拒绝。 */
function reqImportPaths(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error("paths 必须是数组");
  if (v.length === 0) throw new Error("paths 不能为空");
  if (v.length > 100) throw new Error(`paths 元素过多（>100）`);
  return v.map((x, i) => {
    if (typeof x !== "string") throw new Error(`paths[${i}] 必须是字符串`);
    if (x.trim().length === 0) throw new Error(`paths[${i}] 不能为空`);
    if (x.length > 4096) throw new Error(`paths[${i}] 过长（>4096）`);
    if (x.includes("\0")) throw new Error(`paths[${i}] 包含 NUL 字符`);
    return x;
  });
}

/** 目标 value：非空、≤256、不含 NUL；只 trim，不做 CIDR/IP 校验（P4-B 才做）。 */
function reqTargetValue(v: unknown): string {
  const s = reqString(v, "value", 256).trim();
  if (!s) throw new Error("目标 value 不能为空");
  if (s.includes("\0")) throw new Error("目标 value 不能包含 NUL 字符");
  return s;
}

/**
 * 语义校验（可选）：调用方传入只读上下文时，在结构校验阶段就拒绝
 * 不存在/已归档的任务、不属于该任务的 targetId。
 *
 * 没有上下文时只做结构校验；Hub/board 在 dispatch 时仍会做同一组检查
 * （board.addTarget/updateTarget/removeTarget），所以 IPC 路径不会漏。
 */
function requireTaskExists(
  ctx: ValidateActionContext | undefined,
  taskId: string,
): void {
  if (!ctx?.task) return;
  const task = ctx.task(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (task.archived) throw new Error(`任务已归档：${taskId}`);
}

function requireTargetExists(
  ctx: ValidateActionContext | undefined,
  taskId: string,
  targetId: string,
): void {
  if (!ctx?.target) return;
  if (!ctx.target(taskId, targetId)) {
    throw new Error(`目标不存在或不属于该任务：${targetId}`);
  }
}

/** P5-C：候选归属校验（可选；不传上下文时由 Hub 兜底）。 */
function requireCandidateExists(
  ctx: ValidateActionContext | undefined,
  taskId: string,
  candidateId: string,
): void {
  if (!ctx?.candidate) return;
  if (!ctx.candidate(taskId, candidateId)) {
    throw new Error(`flag 候选不存在或不属于该任务：${candidateId}`);
  }
}

export function validateHubAction(raw: unknown, ctx?: ValidateActionContext): HubAction {
  if (!isRecord(raw)) throw new Error("动作必须是对象");
  const type = raw.type;
  if (typeof type !== "string") throw new Error("动作缺少 type");

  switch (type) {
    case "ui.setView": {
      const view = reqEnum(raw.view, "view", new Set(["competition", "workspace"]));
      return { type, view: view as "competition" | "workspace" };
    }
    case "task.create": {
      const action: HubAction = {
        type,
        title: reqString(raw.title, "title", 512),
        brief: reqString(raw.brief, "brief", 200_000),
      };
      const category = optString(raw.category, "category", 32);
      if (category !== undefined) {
        if (!TASK_CATEGORIES.has(category)) {
          throw new Error(`category 非法：${JSON.stringify(category)}（允许：${[...TASK_CATEGORIES].join(", ")}）`);
        }
        action.category = category as TaskCategory;
      }
      const priority = optPriority(raw.priority);
      if (priority !== undefined) action.priority = priority;
      if (raw.points !== undefined) {
        if (typeof raw.points !== "number" || !Number.isInteger(raw.points) || raw.points < 0 || raw.points > 1_000_000) {
          throw new Error("points 必须是 0–1000000 的整数");
        }
        action.points = raw.points;
      }
      if (raw.answerSpec !== undefined) {
        const specRes = validateAnswerSpec(raw.answerSpec);
        if (!specRes.ok) throw new Error(`answerSpec 非法：${specRes.errors.join("；")}`);
        action.answerSpec = specRes.spec!;
      }
      return action;
    }
    case "task.switch":
    case "task.focus":
    case "task.stopAll":
      return { type, taskId: reqString(raw.taskId, "taskId", 128) };
    case "task.scope.update": {
      const action: HubAction = { type, taskId: reqString(raw.taskId, "taskId", 128) };
      const list = (value: unknown, label: string): string[] => {
        if (!Array.isArray(value) || value.length > 200) throw new Error(`${label} 必须是最多 200 条的数组`);
        return value.map((v, i) => {
          if (typeof v !== "string" || !v.trim() || v.includes("\0") || v.length > 512) {
            throw new Error(`${label}[${i}] 必须是 1–512 字符的非空字符串`);
          }
          return v.trim();
        });
      };
      if (raw.denyTargets !== undefined) action.denyTargets = list(raw.denyTargets, "denyTargets");
      if (raw.allowedActions !== undefined) action.allowedActions = list(raw.allowedActions, "allowedActions");
      if (raw.scopeNotes !== undefined) {
        if (raw.scopeNotes === null) action.scopeNotes = null;
        else {
          if (typeof raw.scopeNotes !== "string" || raw.scopeNotes.length > 4096) {
            throw new Error("scopeNotes 最多 4096 字符");
          }
          action.scopeNotes = raw.scopeNotes;
        }
      }
      if (
        action.denyTargets === undefined &&
        action.allowedActions === undefined &&
        raw.scopeNotes === undefined
      ) {
        throw new Error("task.scope.update 至少提供 denyTargets/allowedActions/scopeNotes 之一");
      }
      return action;
    }
    case "task.update": {      const action: HubAction = { type, taskId: reqString(raw.taskId, "taskId", 128) };
      const priority = optPriority(raw.priority);
      if (priority !== undefined) action.priority = priority;
      if (raw.points !== undefined) {
        if (typeof raw.points !== "number" || !Number.isInteger(raw.points) || raw.points < 0 || raw.points > 1_000_000) {
          throw new Error("points 必须是 0–1000000 的整数");
        }
        action.points = raw.points;
      }
      if (priority === undefined && raw.points === undefined) {
        throw new Error("task.update 至少提供 priority 或 points");
      }
      return action;
    }
    case "task.archive": {
      const action: HubAction = { type, taskId: reqString(raw.taskId, "taskId", 128) };
      if (raw.force !== undefined) action.force = reqBoolean(raw.force, "force");
      return action;
    }
    case "task.setStatus": {
      const action: HubAction = {
        type,
        status: reqEnum(raw.status, "status", TASK_STATUSES) as "open" | "solving" | "solved" | "abandoned",
      };
      const taskId = optString(raw.taskId, "taskId", 128);
      const answer = optString(raw.answer, "answer", 200_000);
      if (taskId !== undefined) action.taskId = taskId;
      if (answer !== undefined) action.answer = answer;
      return action;
    }
    case "strategy.plan": {
      const action: HubAction = { type };
      const taskId = optString(raw.taskId, "taskId", 128);
      if (taskId !== undefined) action.taskId = taskId;
      if (raw.mode !== undefined) {
        const mode = reqEnum(raw.mode, "mode", STRATEGY_MODES) as "suggest" | "competition-auto";
        action.mode = mode;
      }
      return action;
    }
    case "strategy.apply": {
      const taskId = reqString(raw.taskId, "taskId", 128);
      if (!Array.isArray(raw.recommendationIds) || raw.recommendationIds.length === 0) {
        throw new Error("recommendationIds 必须是非空数组");
      }
      if (raw.recommendationIds.length > 32) throw new Error("recommendationIds 最多 32 条");
      const ids = raw.recommendationIds.map((id, i) => {
        if (typeof id !== "string" || !id.trim() || id.length > 256) {
          throw new Error(`recommendationIds[${i}] 必须是 1–256 字符的字符串`);
        }
        return id;
      });
      const action: HubAction = { type, taskId, recommendationIds: ids };
      if (raw.mode !== undefined) {
        action.mode = reqEnum(raw.mode, "mode", STRATEGY_MODES) as "suggest" | "competition-auto";
      }
      return action;
    }
    case "ir.questions.import": {
      const action: HubAction = { type, text: reqString(raw.text, "text", 200_000) };
      const taskId = optString(raw.taskId, "taskId", 128);
      if (taskId !== undefined) action.taskId = taskId;
      return action;
    }
    case "ir.analyze": {
      const action: HubAction = { type };
      const taskId = optString(raw.taskId, "taskId", 128);
      if (taskId !== undefined) action.taskId = taskId;
      if (raw.paths !== undefined) {
        if (!Array.isArray(raw.paths) || raw.paths.length > 100) {
          throw new Error("paths 必须是最多 100 条的数组");
        }
        action.paths = raw.paths.map((p, i) => {
          if (typeof p !== "string" || !p.trim() || p.length > 512) {
            throw new Error(`paths[${i}] 必须是 1–512 字符的字符串`);
          }
          return p;
        });
      }
      return action;
    }
    case "platform.login": {
      const provider = optString(raw.provider, "provider", 64);
      const action: HubAction = {
        type,
        username: reqString(raw.username, "username", 256).trim(),
        password: reqString(raw.password, "password", 2048),
      };
      if (!action.password) throw new Error("password 不能为空");
      const baseUrl = optString(raw.baseUrl, "baseUrl", 2048);
      const raceId = optString(raw.raceId, "raceId", 128);
      if (baseUrl !== undefined) {
        let parsed: URL;
        try {
          parsed = new URL(baseUrl);
        } catch {
          throw new Error("baseUrl 不是合法 URL");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("baseUrl 只允许 http/https");
        }
        action.baseUrl = parsed.toString().replace(/\/+$/, "");
      }
      if (provider !== undefined) {
        if (!["auto", "nest-cyberpeace", "ctfd", "ctfy"].includes(provider)) {
          throw new Error("provider 必须是 auto / nest-cyberpeace / ctfd / ctfy");
        }
        action.provider = provider;
      }
      if (
        !action.username &&
        provider !== "ctfd" &&
        provider !== "ctfy" &&
        !action.password.startsWith("ctfd_") &&
        !action.password.startsWith("pf_")
      ) {
        throw new Error("username 不能为空");
      }
      if (raceId !== undefined) action.raceId = raceId;
      if (raw.remember !== undefined) action.remember = reqBoolean(raw.remember, "remember");
      return action;
    }
    case "platform.logout":
      return { type };
    case "platform.sync": {
      const action: HubAction = { type };
      const raceId = optString(raw.raceId, "raceId", 128);
      if (raceId !== undefined) action.raceId = raceId;
      return action;
    }
    case "platform.materialize": {
      const action: HubAction = {
        type,
        challengeId: reqString(raw.challengeId, "challengeId", 128),
      };
      if (raw.downloadAttachment !== undefined) {
        action.downloadAttachment = reqBoolean(raw.downloadAttachment, "downloadAttachment");
      }
      if (raw.includeWp !== undefined) action.includeWp = reqBoolean(raw.includeWp, "includeWp");
      return action;
    }
    case "platform.openScene":
    case "platform.closeScene":
      return { type, challengeId: reqString(raw.challengeId, "challengeId", 128) };
    case "platform.probeScenes": {
      const action: HubAction = { type };
      if (raw.challengeIds !== undefined) {
        if (!Array.isArray(raw.challengeIds) || raw.challengeIds.length > 24) {
          throw new Error("challengeIds 必须是最多 24 条的数组");
        }
        action.challengeIds = raw.challengeIds.map((value, index) => {
          if (typeof value !== "string" || !value.trim() || value.length > 128) {
            throw new Error(`challengeIds[${index}] 必须是 1–128 字符的字符串`);
          }
          return value.trim();
        });
      }
      return action;
    }
    case "platform.submitFlag": {
      const action: HubAction = {
        type,
        challengeId: reqString(raw.challengeId, "challengeId", 128),
        flag: reqString(raw.flag, "flag", 8192).trim(),
      };
      if (!action.flag) throw new Error("flag 不能为空");
      const taskId = optString(raw.taskId, "taskId", 128);
      const candidateId = optString(raw.candidateId, "candidateId", 128);
      if (taskId !== undefined) action.taskId = taskId;
      if (candidateId !== undefined) action.candidateId = candidateId;
      if (taskId !== undefined) requireTaskExists(ctx, taskId);
      return action;
    }
    case "platform.searchWp": {
      const action: HubAction = {
        type,
        challengeId: reqString(raw.challengeId, "challengeId", 128),
      };
      if (raw.limit !== undefined) {
        if (
          typeof raw.limit !== "number" ||
          !Number.isInteger(raw.limit) ||
          raw.limit < 1 ||
          raw.limit > 20
        ) {
          throw new Error("limit 必须是 1–20 的整数");
        }
        action.limit = raw.limit;
      }
      return action;
    }
    case "session.start": {
      const action: HubAction = {
        type,
        taskId: reqString(raw.taskId, "taskId", 128),
        agent: reqString(raw.agent, "agent", 64),
        role: reqEnum(raw.role, "role", ROLES) as "lead" | "verify" | "recon" | "scribe",
        tier: reqEnum(raw.tier, "tier", TIERS) as "autonomous" | "guarded",
      };
      const model = optString(raw.model, "model", 256);
      if (model !== undefined) action.model = model;
      if (raw.allowAll !== undefined) action.allowAll = reqBoolean(raw.allowAll, "allowAll");
      return action;
    }
    case "session.stop":
    case "session.remove":
    case "session.interrupt":
      return { type, sessionId: reqString(raw.sessionId, "sessionId", 128) };
    case "session.prompt":
      return {
        type,
        sessionId: reqString(raw.sessionId, "sessionId", 128),
        text: reqString(raw.text, "text", 200_000),
      };
    case "session.setTier":
      return {
        type,
        sessionId: reqString(raw.sessionId, "sessionId", 128),
        tier: reqEnum(raw.tier, "tier", TIERS) as "autonomous" | "guarded",
      };
    case "approval.decide": {
      const action: HubAction = {
        type,
        approvalId: reqString(raw.approvalId, "approvalId", 128),
        decision: reqEnum(raw.decision, "decision", DECISIONS) as "approve" | "deny",
      };
      if (raw.remember !== undefined) action.remember = reqBoolean(raw.remember, "remember");
      if (raw.rememberScope !== undefined) {
        action.rememberScope = reqEnum(raw.rememberScope, "rememberScope", new Set(["session", "agent"])) as
          | "session"
          | "agent";
      }
      return action;
    }
    case "approval.bulk":
      return {
        type,
        ids: reqStringArray(raw.ids, "ids"),
        decision: reqEnum(raw.decision, "decision", DECISIONS) as "approve" | "deny",
      };
    case "attachment.import": {
      const action: HubAction = { type, paths: reqImportPaths(raw.paths) };
      const taskId = optString(raw.taskId, "taskId", 128);
      const note = optString(raw.note, "note", 4096);
      if (taskId !== undefined) action.taskId = taskId;
      if (note !== undefined) action.note = note;
      return action;
    }
    case "artifact.refresh": {
      // P3-C：结构校验只放行 taskId；任务是否存在/是否归档由 Hub 在刷新前检查。
      const action: HubAction = { type };
      const taskId = optString(raw.taskId, "taskId", 128);
      if (taskId !== undefined) action.taskId = taskId;
      return action;
    }
    case "target.add": {
      const taskId = reqString(raw.taskId, "taskId", 128);
      const value = reqTargetValue(raw.value);
      const action: HubAction = { type, taskId, value };
      if (raw.kind !== undefined) {
        action.kind = reqEnum(raw.kind, "kind", TARGET_KINDS) as TargetKind;
      }
      const notes = optString(raw.notes, "notes", 4096);
      if (notes !== undefined) action.notes = notes;
      requireTaskExists(ctx, taskId);
      return action;
    }
    case "target.update": {
      const taskId = reqString(raw.taskId, "taskId", 128);
      const targetId = reqString(raw.targetId, "targetId", 128);
      const action: HubAction = { type, taskId, targetId };
      if (raw.status !== undefined) {
        action.status = reqEnum(raw.status, "status", TARGET_STATUSES) as TargetStatus;
      }
      const notes = optString(raw.notes, "notes", 4096);
      if (notes !== undefined) action.notes = notes;
      requireTargetExists(ctx, taskId, targetId);
      return action;
    }
    case "target.remove": {
      const taskId = reqString(raw.taskId, "taskId", 128);
      const targetId = reqString(raw.targetId, "targetId", 128);
      requireTargetExists(ctx, taskId, targetId);
      return { type, taskId, targetId };
    }
    case "flag.confirm":
    case "flag.reject": {
      const taskId = reqString(raw.taskId, "taskId", 128);
      const candidateId = reqString(raw.candidateId, "candidateId", 128);
      requireTaskExists(ctx, taskId);
      requireCandidateExists(ctx, taskId, candidateId);
      return { type, taskId, candidateId };
    }
    case "flag.export": {
      // taskId 可选：缺省 = 导出全部有候选的任务；指定时必须存在且未归档。
      const action: HubAction = {
        type,
        format: reqEnum(raw.format, "format", FLAG_EXPORT_FORMATS) as "md" | "csv" | "json",
      };
      const taskId = optString(raw.taskId, "taskId", 128);
      if (taskId !== undefined) {
        action.taskId = taskId;
        requireTaskExists(ctx, taskId);
      }
      return action;
    }
    case "awd.export":
    case "ir.export": {
      const action: HubAction = {
        type,
        format: reqEnum(raw.format, "format", FLAG_EXPORT_FORMATS) as "md" | "csv" | "json",
      };
      const taskId = optString(raw.taskId, "taskId", 128);
      if (taskId !== undefined) {
        action.taskId = taskId;
        requireTaskExists(ctx, taskId);
      }
      return action;
    }
    case "flag.submit": {
      const taskId = reqString(raw.taskId, "taskId", 128);
      const candidateId = reqString(raw.candidateId, "candidateId", 128);
      const action: HubAction = { type, taskId, candidateId };
      if (raw.mode !== undefined) {
        const mode = reqString(raw.mode, "mode", 32);
        if (mode === "command") {
          // 用户决策：command 模式在 WP6 评估前不做；IPC 入口也明确拒绝。
          throw new Error("command 模式未实现（用户决策：WP6 评估前不做）");
        }
        if (mode !== "manual" && mode !== "dry_run") {
          throw new Error(`mode 非法：${JSON.stringify(mode)}（允许：manual, dry_run）`);
        }
        action.mode = mode;
      }
      requireTaskExists(ctx, taskId);
      requireCandidateExists(ctx, taskId, candidateId);
      return action;
    }
    case "permission.revoke": {
      const action: HubAction = { type, agentId: reqString(raw.agentId, "agentId", 64) };
      const grantId = optString(raw.grantId, "grantId", 256);
      if (grantId !== undefined) action.grantId = grantId;
      return action;
    }
    case "permission.grantAll": {
      const action: HubAction = {
        type,
        scope: reqEnum(raw.scope, "scope", GRANT_SCOPES) as "session" | "agent" | "all" | "global",
      };
      const sessionId = optString(raw.sessionId, "sessionId", 128);
      const agentId = optString(raw.agentId, "agentId", 64);
      const taskId = optString(raw.taskId, "taskId", 128);
      if (sessionId !== undefined) action.sessionId = sessionId;
      if (agentId !== undefined) action.agentId = agentId;
      if (taskId !== undefined) action.taskId = taskId;
      if (action.scope === "session" && !action.sessionId) {
        throw new Error("scope=session 时必须提供 sessionId");
      }
      if (action.scope === "agent" && !action.agentId) {
        throw new Error("scope=agent 时必须提供 agentId");
      }
      return action;
    }
    default:
      throw new Error(`未知动作类型：${type}`);
  }
}
