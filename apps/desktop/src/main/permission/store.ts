/**
 * 按 agent 维度持久化的「一键放行」授权。
 *
 * - **本会话始终允许**：只存在内存（scope=session），进程退出即失效；
 * - **对该 agent 永久允许**：写入 `<workspace>/permissions.json`，重启后仍生效；
 * - 只接受 `OperationProfile.rememberable === true` 的操作类别；执行命令、删除文件、
 *   凭据访问、网络访问、未知操作默认都不可记住（见 permission/profile.ts）。
 *
 * 读取/解析失败时按「没有任何授权」处理（fail closed），不会因为坏文件而误放行。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PermissionGrantView, RiskLevel } from "../../../../../packages/shared-protocol/events.ts";
import type { OperationCategory, OperationProfile, PermissionConfig } from "./profile.ts";
import { DEFAULT_PERMISSION_CONFIG, agentGrantId, sessionGrantId } from "./profile.ts";

/**
 * 授权类别：普通操作类别，或 `all`（显式「全部放行」通配）。
 *
 * `all` 只绕过「人工审批」这一步，不绕过：
 *  - 规则引擎里的 block（硬阻断永远不可放行）；
 *  - 工作目录边界（fs/write 与 terminal cwd 的包含性检查）。
 */
export type GrantCategory = OperationCategory | "all";
export const ALL_GRANT_CATEGORY: GrantCategory = "all";

interface AgentGrant {
  id: string;
  agentId: string;
  category: GrantCategory;
  label: string;
  risk: RiskLevel;
  createdAt: number;
}

interface SessionGrant {
  id: string;
  agentId: string;
  sessionId: string;
  category: GrantCategory;
  label: string;
  risk: RiskLevel;
  createdAt: number;
}

interface PersistedFile {
  version: 1;
  grants: AgentGrant[];
  /** 全局全部放行（所有 agent / 所有会话）。显式开启，跨重启保留。 */
  globalAll?: { enabled: boolean; updatedAt: number };
}

const GLOBAL_ALL_ID = "global:all";
const GLOBAL_ALL_LABEL = "全局全部放行（所有 agent / 所有会话）";

export interface GrantInput {
  agentId: string;
  sessionId: string;
  scope: "session" | "agent";
  profile: OperationProfile;
  now?: number;
}

export interface GrantResult {
  ok: boolean;
  error?: string;
  grant?: PermissionGrantView;
}

export class PermissionStore {
  private readonly filePath: string;
  private readonly config: PermissionConfig;
  private readonly agentGrants = new Map<string, AgentGrant>();
  private readonly sessionGrants = new Map<string, SessionGrant>();
  /** 全局全部放行：优先级最高，跨会话/跨重启生效。 */
  private globalAll: { enabled: boolean; updatedAt: number } | null = null;
  private lastPersistError: string | null = null;

  constructor(opts: { filePath: string; config?: PermissionConfig }) {
    this.filePath = opts.filePath;
    this.config = opts.config ?? DEFAULT_PERMISSION_CONFIG;
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  get persistError(): string | null {
    return this.lastPersistError;
  }

  /** 列出授权；传入 validSessionIds 时过滤掉已结束会话的 session 授权。 */
  list(validSessionIds?: Set<string>): PermissionGrantView[] {
    const out: PermissionGrantView[] = [];
    if (this.globalAll?.enabled) {
      out.push({
        id: GLOBAL_ALL_ID,
        agentId: "*",
        scope: "agent",
        sessionId: null,
        category: "all",
        label: GLOBAL_ALL_LABEL,
        risk: "high",
        createdAt: this.globalAll.updatedAt,
      });
    }
    for (const g of this.agentGrants.values()) {
      out.push({
        id: g.id,
        agentId: g.agentId,
        scope: "agent",
        sessionId: null,
        category: g.category,
        label: g.label,
        risk: g.risk,
        createdAt: g.createdAt,
      });
    }
    for (const g of this.sessionGrants.values()) {
      if (validSessionIds && !validSessionIds.has(g.sessionId)) continue;
      out.push({
        id: g.id,
        agentId: g.agentId,
        scope: "session",
        sessionId: g.sessionId,
        category: g.category,
        label: g.label,
        risk: g.risk,
        createdAt: g.createdAt,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 命中已授权规则则返回该授权；否则 null。 */
  match(input: {
    agentId: string;
    sessionId: string;
    profile: OperationProfile;
  }): PermissionGrantView | null {
    const { agentId, sessionId, profile } = input;
    // 全局全部放行优先级最高：所有 agent、所有会话、所有操作类别。
    // block 判定根本不会走到这里（AcpClient 在更早的层就拒绝），所以它不会
    // 把硬阻断或工作目录边界变成放行。
    if (this.globalAll?.enabled) {
      return {
        id: GLOBAL_ALL_ID,
        agentId,
        scope: "agent",
        sessionId: null,
        category: "all",
        label: GLOBAL_ALL_LABEL,
        risk: "high",
        createdAt: this.globalAll.updatedAt,
      };
    }
    // 显式「全部放行」优先于按类别的授权，也优先于 rememberable 的高风险限制。
    const sessAll = this.sessionGrants.get(sessionGrantId(sessionId, ALL_GRANT_CATEGORY));
    if (sessAll && sessAll.agentId === agentId) return this.toView(sessAll);
    const agentAll = this.agentGrants.get(agentGrantId(agentId, ALL_GRANT_CATEGORY));
    if (agentAll) return this.toView(agentAll);
    if (!profile.rememberable) return null;
    const sess = this.sessionGrants.get(sessionGrantId(sessionId, profile.category));
    if (sess && sess.agentId === agentId) return this.toView(sess);
    const agent = this.agentGrants.get(agentGrantId(agentId, profile.category));
    if (agent) return this.toView(agent);
    return null;
  }

  /**
   * 一键授予「所有需要人工审批的动作」。scope=session 只在本会话有效；
   * scope=agent 写入本地配置，重启后仍生效。
   *
   * 这是用户显式要求的逃生阀：不要求 profile.rememberable，也不区分操作类别。
   * 仍需经过策略引擎的 block 判定与工作目录包含性检查。
   */
  grantAll(input: {
    agentId?: string;
    sessionId?: string;
    scope: "session" | "agent" | "global";
    now?: number;
  }): GrantResult {
    const { agentId, scope } = input;
    const now = input.now ?? Date.now();
    if (scope === "global") {
      this.globalAll = { enabled: true, updatedAt: now };
      const persisted = this.persist();
      const view: PermissionGrantView = {
        id: GLOBAL_ALL_ID,
        agentId: "*",
        scope: "agent",
        sessionId: null,
        category: "all",
        label: GLOBAL_ALL_LABEL,
        risk: "high",
        createdAt: now,
      };
      if (!persisted.ok) return { ok: false, error: persisted.error, grant: view };
      return { ok: true, grant: view };
    }
    if (!agentId) return { ok: false, error: "缺少 agentId" };
    const label = "全部操作（含高风险，显式全部放行）";
    if (scope === "session") {
      const sessionId = input.sessionId ?? "";
      if (!sessionId) return { ok: false, error: "本会话全部放行需要 sessionId" };
      const grant: SessionGrant = {
        id: sessionGrantId(sessionId, ALL_GRANT_CATEGORY),
        agentId,
        sessionId,
        category: ALL_GRANT_CATEGORY,
        label,
        risk: "high",
        createdAt: now,
      };
      this.sessionGrants.set(grant.id, grant);
      return { ok: true, grant: this.toView(grant) };
    }
    const id = agentGrantId(agentId, ALL_GRANT_CATEGORY);
    const grant: AgentGrant = {
      id,
      agentId,
      category: ALL_GRANT_CATEGORY,
      label,
      risk: "high",
      createdAt: now,
    };
    this.agentGrants.set(id, grant);
    const persisted = this.persist();
    if (!persisted.ok) {
      return { ok: false, error: persisted.error, grant: this.toView(grant) };
    }
    return { ok: true, grant: this.toView(grant) };
  }

  /** 是否已有「全部放行」授权（全局 / 本会话 / 该 agent）。 */
  hasGrantAll(agentId: string, sessionId: string): boolean {
    if (this.globalAll?.enabled) return true;
    const sess = this.sessionGrants.get(sessionGrantId(sessionId, ALL_GRANT_CATEGORY));
    if (sess && sess.agentId === agentId) return true;
    return this.agentGrants.has(agentGrantId(agentId, ALL_GRANT_CATEGORY));
  }

  /** 关闭全局全部放行（撤销入口也会走这里）。 */
  disableGlobalAll(now = Date.now()): boolean {
    if (!this.globalAll?.enabled) return false;
    this.globalAll = { enabled: false, updatedAt: now };
    this.persist();
    return true;
  }

  grant(input: GrantInput): GrantResult {
    const { agentId, sessionId, scope, profile } = input;
    if (!agentId) return { ok: false, error: "缺少 agentId" };
    if (!profile.rememberable) {
      return {
        ok: false,
        error: `「${profile.label}」属于高风险操作，默认不支持一键放行；如需放行请在 config/permissions.json 的 highRiskAllowlist 中显式配置`,
      };
    }
    const now = input.now ?? Date.now();
    if (scope === "session") {
      const id = sessionGrantId(sessionId, profile.category);
      const grant: SessionGrant = {
        id,
        agentId,
        sessionId,
        category: profile.category,
        label: profile.label,
        risk: profile.risk,
        createdAt: now,
      };
      this.sessionGrants.set(id, grant);
      return { ok: true, grant: this.toView(grant) };
    }
    const id = agentGrantId(agentId, profile.category);
    const grant: AgentGrant = {
      id,
      agentId,
      category: profile.category,
      label: profile.label,
      risk: profile.risk,
      createdAt: now,
    };
    this.agentGrants.set(id, grant);
    const persisted = this.persist();
    if (!persisted.ok) {
      // 内存里仍然生效，但必须让调用方知道「重启后不会生效」。
      return { ok: false, error: persisted.error, grant: this.toView(grant) };
    }
    return { ok: true, grant: this.toView(grant) };
  }

  /**
   * 撤销授权。
   * - 传 grantId：只撤销那一条（session / agent 均可）；
   * - 不传 grantId：撤销该 agent 的全部授权（含会话级）。
   * 返回撤销条数。
   */
  revoke(agentId: string, grantId?: string): number {
    let n = 0;
    // 全局授权不是 Map 里的一条：用固定 id / agentId="*" 表示撤销它。
    if (grantId === GLOBAL_ALL_ID || agentId === "*") {
      if (this.disableGlobalAll()) n += 1;
      if (grantId === GLOBAL_ALL_ID || !grantId) return n;
    }
    if (grantId) {
      const s = this.sessionGrants.get(grantId);
      if (s && s.agentId === agentId) {
        this.sessionGrants.delete(grantId);
        n++;
      }
      const a = this.agentGrants.get(grantId);
      if (a && a.agentId === agentId) {
        this.agentGrants.delete(grantId);
        n++;
      }
    } else {
      for (const [id, g] of [...this.sessionGrants]) {
        if (g.agentId !== agentId) continue;
        this.sessionGrants.delete(id);
        n++;
      }
      for (const [id, g] of [...this.agentGrants]) {
        if (g.agentId !== agentId) continue;
        this.agentGrants.delete(id);
        n++;
      }
    }
    if (n > 0) this.persist();
    return n;
  }

  /** 会话结束时清掉它的临时授权（agent 级授权不受影响）。 */
  clearSession(sessionId: string): number {
    let n = 0;
    for (const [id, g] of [...this.sessionGrants]) {
      if (g.sessionId !== sessionId) continue;
      this.sessionGrants.delete(id);
      n++;
    }
    return n;
  }

  private toView(g: AgentGrant | SessionGrant): PermissionGrantView {
    return {
      id: g.id,
      agentId: g.agentId,
      scope: "sessionId" in g ? "session" : "agent",
      sessionId: "sessionId" in g ? g.sessionId : null,
      category: g.category,
      label: g.label,
      risk: g.risk,
      createdAt: g.createdAt,
    };
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedFile>;
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.globalAll && parsed.globalAll.enabled === true) {
        this.globalAll = {
          enabled: true,
          updatedAt:
            typeof parsed.globalAll.updatedAt === "number" ? parsed.globalAll.updatedAt : Date.now(),
        };
      }
      if (!Array.isArray(parsed.grants)) return;
      for (const raw of parsed.grants) {
        if (!raw || typeof raw !== "object") continue;
        const g = raw as Partial<AgentGrant>;
        if (typeof g.agentId !== "string" || typeof g.category !== "string") continue;
        // `all` 是显式全部放行，不受 eligibleCategories 限制；普通类别仍按配置过滤。
        if (g.category !== ALL_GRANT_CATEGORY) {
          if (!(this.config.eligibleCategories as string[]).includes(g.category)) continue;
        }
        const id = agentGrantId(g.agentId, g.category);
        this.agentGrants.set(id, {
          id,
          agentId: g.agentId,
          category: g.category as GrantCategory,
          label: typeof g.label === "string" ? g.label : g.category,
          risk: g.risk === "low" || g.risk === "medium" || g.risk === "high" ? g.risk : "medium",
          createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
        });
      }
    } catch {
      // 坏文件按「没有授权」处理，不阻断启动。
      this.agentGrants.clear();
    }
  }

  private persist(): { ok: boolean; error?: string } {
    const data: PersistedFile = {
      version: 1,
      grants: [...this.agentGrants.values()],
      globalAll: this.globalAll ?? undefined,
    };
    const tmp = `${this.filePath}.tmp`;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      try {
        renameSync(tmp, this.filePath);
      } catch {
        // Windows 上目标文件被占用时 rename 可能失败；退化为覆盖写。
        if (existsSync(tmp)) {
          writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
          try {
            unlinkSync(tmp);
          } catch {
            /* 临时文件清不掉不影响授权生效 */
          }
        }
      }
      this.lastPersistError = null;
      return { ok: true };
    } catch (err) {
      this.lastPersistError = (err as Error).message;
      return { ok: false, error: `授权已在本进程生效，但写入 ${this.filePath} 失败：${this.lastPersistError}` };
    }
  }
}
