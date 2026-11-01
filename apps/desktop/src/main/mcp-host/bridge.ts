/**
 * 主进程侧的命名管道服务 —— 黑板对外的唯一入口。
 *
 * 架构文档 §4.2 规则 1/2/3：MCP 子进程不是写入者；管道要带一次性令牌；不占端口。
 * §8.1：所有写操作最终落在主进程的串行队列上。
 */

import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Blackboard } from "../blackboard/board.ts";
import { isInsideDir } from "../acp/client.ts";
import { extractFlag } from "../stream/normalize.ts";
import type { SkillRuntime } from "../skill/index.ts";
import { skillList, skillRead, skillSearch } from "../skill/tools.ts";
import { redactFlagText, type EvidenceReplayer, type ReplayResult } from "../evidence/replay.ts";
import { BRIDGE_RPC, makePipeName } from "./protocol.ts";

interface RpcReq {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeOptions {
  board: Blackboard;
  taskId: string;
  runId: string;
  log?: (msg: string, detail?: unknown) => void;
  /** 观测用：某会话读了黑板（§7.4 同步健康度要数这个） */
  onBoardRead?: (sessionId: string, afterId: number, returned: number) => void;
  /** 观测用：某会话写了黑板（R16；UI 台账要实时刷新，而不是等下一次动作） */
  onBoardWrite?: (sessionId: string, method: string) => void;
  /** P7-B：MCP 子进程异常断开（非 revoke/stop）时通知；不自动重启。 */
  onMcpUnavailable?: (sessionId: string) => void;
  /** P7-B：MCP 子进程连上/断开时登记/清理 PID（供 process-registry 校验）。 */
  onMcpConnected?: (sessionId: string, pid: number | null, taskId: string) => void;
  onMcpClosed?: (sessionId: string, pid: number | null) => void;
  /** agent 唯一可写根目录：用于把 flag 事实的 witness 重放成 E2 */
  workRoot?: string;
  /**
   * P2-B：技能库运行期状态。传入后桥会路由 skill.search / skill.read / skill.list，
   * 首次调用时懒构建索引（不读真实库的路径不会触发扫描）。
   * 未传时三个 skill 方法返回可读错误，不影响黑板工具。
   */
  skill?: SkillRuntime;
  /**
   * P3-B 批次 2：`cmd:` 证据回放。未传/关闭时 cmd: 只当 E1（与旧行为一致）；
   * 开启后由 replay.ts 执行、过策略、写审计。
   */
  replay?: EvidenceReplayer;
}

const WRITE_METHODS = new Set<string>([
  BRIDGE_RPC.submitFact,
  BRIDGE_RPC.declareDeadEnd,
  BRIDGE_RPC.openIntent,
  BRIDGE_RPC.acquireLease,
  BRIDGE_RPC.releaseLease,
  BRIDGE_RPC.renewLease,
]);

export class BoardBridge {
  private server: Server;
  /**
   * R25（A7 修复）：按会话签发令牌，连接认证后**绑定**到该会话身份。
   * 之前所有会话共用一个令牌，且认证后信任请求体里的 sessionId——
   * 拿到令牌的进程可以冒充其它会话写黑板（验真：A/B 的 4 个 wire 日志里全有令牌）。
   */
  private sessionTokens = new Map<string, string>();
  private tokensByIdentity = new Map<string, { sessionId: string; taskId: string }>();
  /** 已认证连接按会话归档：会话停止时可精确断开，不必等全局 stop。 */
  private sessionSockets = new Map<string, Set<Socket>>();
  /** P7-B：会话正常 revoke/stop 时关闭的 socket 不算 MCP 崩溃。 */
  private revokedSessions = new Set<string>();
  /** P7-B：每个会话当前 MCP 子进程 PID（hello 上报）。 */
  private sessionMcpPids = new Map<string, number>();
  private sockets = new Set<Socket>();
  private opts: BridgeOptions;
  readonly pipeName: string;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
    this.pipeName = makePipeName(opts.runId);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.onConnection(socket));
      this.server.once("error", reject);
      this.server.listen(this.pipeName, () => resolve());
    });
  }

  /**
   * 交给 agent 的 mcpServers 条目里要用的环境变量。
   *
   * R17：taskId 必须由**会话**传入，不能用桥启动时固定的那个 —— 否则新建第二个
   * 任务后，新会话的 MCP 仍把事实写进旧任务。桥侧还会用 sessionId 再查库兜底。
   */
  envForSession(sessionId: string, taskId: string = this.opts.taskId): Array<{ name: string; value: string }> {
    let token = this.sessionTokens.get(sessionId);
    if (!token) {
      token = randomBytes(24).toString("hex");
      this.sessionTokens.set(sessionId, token);
    }
    this.tokensByIdentity.set(token, { sessionId, taskId });
    return [
      { name: "BUMIMANG_PIPE", value: this.pipeName },
      { name: "BUMIMANG_TOKEN", value: token },
      { name: "BUMIMANG_SESSION", value: sessionId },
      { name: "BUMIMANG_TASK", value: taskId },
    ];
  }

  private onConnection(socket: Socket): void {
    let bound: { sessionId: string; taskId: string } | null = null;
    let buf = "";
    socket.setEncoding("utf8");
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: RpcReq & { token?: string; sessionId?: string; pid?: number };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!bound) {
          const identity = typeof msg.token === "string" ? this.tokensByIdentity.get(msg.token) : undefined;
          // R25：令牌必须存在，且 hello 里自称的 sessionId 必须与令牌绑定的一致。
          if (!identity || (msg.sessionId !== undefined && msg.sessionId !== identity.sessionId)) {
            this.opts.log?.("bridge: 令牌校验失败，断开连接");
            socket.destroy();
            return;
          }
          bound = identity;
          const set = this.sessionSockets.get(identity.sessionId) ?? new Set<Socket>();
          set.add(socket);
          this.sessionSockets.set(identity.sessionId, set);
          const forget = (): void => {
            const hadSession = this.sessionSockets.get(identity.sessionId) === set;
            set.delete(socket);
            if (set.size > 0) return;
            this.sessionSockets.delete(identity.sessionId);
            const mcpPid = this.sessionMcpPids.get(identity.sessionId) ?? null;
            if (mcpPid !== null) {
              this.sessionMcpPids.delete(identity.sessionId);
              this.opts.onMcpClosed?.(identity.sessionId, mcpPid);
            }
            if (!hadSession || this.revokedSessions.has(identity.sessionId)) return;
            const rec = this.opts.board.getSession(identity.sessionId);
            if (!rec || ["stopped", "failed", "blocked", "done"].includes(rec.status)) return;
            this.opts.log?.(
              `bridge: MCP 子进程异常断开（session=${identity.sessionId}）；不自动重启`,
            );
            this.opts.onMcpUnavailable?.(identity.sessionId);
          };
          socket.on("close", forget);
          socket.on("error", forget);
          this.opts.log?.(`bridge: MCP 子进程已连上并校验通过（session=${identity.sessionId}，令牌绑定）`);
          const mcpPid = typeof msg.pid === "number" && msg.pid > 0 ? msg.pid : null;
          if (mcpPid !== null) this.sessionMcpPids.set(identity.sessionId, mcpPid);
          this.opts.onMcpConnected?.(identity.sessionId, mcpPid, identity.taskId);
          socket.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
          continue;
        }
        void this.handle(socket, msg, bound);
      }
    });
  }

  private async handle(
    socket: Socket,
    req: RpcReq,
    bound: { sessionId: string; taskId: string },
  ): Promise<void> {
    try {
      const result = await this.route(req.method, req.params ?? {}, bound);
      if (WRITE_METHODS.has(req.method)) {
        this.opts.onBoardWrite?.(bound.sessionId, req.method);
      }
      socket.write(JSON.stringify({ id: req.id, result }) + "\n");
    } catch (err) {
      socket.write(
        JSON.stringify({ id: req.id, error: (err as Error).message ?? String(err) }) + "\n",
      );
    }
  }

  /**
   * 事实证据分级（R16 的可做版本 + P3-B 扩展）：
   *  - 没 witness → E0（只有自述）
   *  - 有 witness → E1
   *  - witness 是工作目录内**真实存在**的文件，且文件内容里能找到提交的 flag 或事实文本 → E2
   *  - witness 以 `cmd:` 开头且回放开启、命令成功、stdout 命中提交内容 → E2
   *
   * P3-B 批次 1：E2 从「仅文件含 flag」扩展到「文件含 flag 或提交的事实文本」。
   * 事实文本按**包含**匹配（文件可以有前后缀），空/纯空白事实不算命中，退回 E1。
   * 仍然只读任务工作目录内的文件；目录外/不存在/junction 逃逸一律 E1，不抛错。
   *
   * P3-B 批次 2：只新增 `cmd:` 分支；文件/flag/事实文本路径原样保留。
   * 回放默认关（未配置/关闭时 cmd: 仍走旧的路径解析 → 不存在 → E1）。
   */
  private async inferEvidence(
    content: string,
    witness: string | null,
    taskId?: string,
    sessionId?: string,
  ): Promise<"E0" | "E1" | "E2"> {
    if (!witness || !witness.trim()) return "E0";
    // R27（A1）：证据回放根 = 任务专属目录（agent 的 cwd 就是它，相对 witness 才能解析对）。
    const root = this.opts.workRoot
      ? taskId
        ? resolve(this.opts.workRoot, taskId)
        : this.opts.workRoot
      : undefined;
    if (!root) return "E1";
    const trimmedWitness = witness.trim();
    // cmd: 里可能自带成对引号（例如 node -e "..."），不能按“整条 witness 带引号”剥掉尾部。
    const isCmd = /^cmd:/i.test(trimmedWitness);
    // 非 cmd 路径保持批次 1/旧行为：先按原串剥引号，再 trim。
    const raw = isCmd ? trimmedWitness : witness.replace(/^"|"$/g, "").trim();

    // P3-B 批次 2：cmd: 回放。默认关时 replay 仍会返回 disabled 并写审计（证明没 spawn）。
    if (isCmd) {
      const commandLine = raw.slice(4).trim();
      if (!this.opts.replay) return "E1";
      const result = await this.opts.replay.run({
        commandLine,
        cwd: resolve(root),
        sessionId: sessionId ?? "unknown",
        taskId: taskId ?? "",
        tier: this.sessionTier(sessionId),
        match: (stdout) => evidenceMatches(content, stdout),
      });
      this.auditReplay({ sessionId: sessionId ?? null, taskId: taskId ?? null, commandLine, result });
      return result.matched ? "E2" : "E1";
    }

    // 相对路径按工作目录解析 —— 主进程的 cwd 不等于 agent 的 cwd。
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
    if (!isInsideDir(root, candidate) || !existsSync(candidate)) return "E1";
    try {
      const text = readFileSync(candidate, "utf8").slice(0, 4 * 1024 * 1024);
      return evidenceMatches(content, text) ? "E2" : "E1";
    } catch {
      return "E1";
    }
  }

  /** 回放策略的档位兜底：会话不存在/未知时按受控档（approve 进审批）。 */
  private sessionTier(sessionId?: string): "autonomous" | "guarded" {
    if (!sessionId) return "guarded";
    return this.opts.board.getSession(sessionId)?.tier === "autonomous" ? "autonomous" : "guarded";
  }

  /**
   * 回放审计：只记判定/退出码/字节数/是否命中，不记 stdout/stderr，不记 flag 明文。
   * `redactFlagText` 同时覆盖 command 与 error（agent 可能把 flag 写进命令）。
   */
  private auditReplay(input: {
    sessionId: string | null;
    taskId: string | null;
    commandLine: string;
    result: ReplayResult;
  }): void {
    try {
      this.opts.board.audit({
        sessionId: input.sessionId,
        actor: input.sessionId ?? "system",
        action: "evidence.replay",
        detail: {
          taskId: input.taskId,
          command: redactFlagText(input.commandLine),
          status: input.result.status,
          ran: input.result.ran,
          matched: input.result.matched,
          policyVerdict: input.result.policyVerdict,
          rule: input.result.rule,
          approvalDecision: input.result.approvalDecision,
          exitCode: input.result.exitCode,
          durationMs: input.result.durationMs,
          stdoutBytes: input.result.stdoutBytes,
          stderrBytes: input.result.stderrBytes,
          stdoutTruncated: input.result.stdoutTruncated,
          stderrTruncated: input.result.stderrTruncated,
          error: input.result.error ? redactFlagText(input.result.error) : null,
        },
      });
    } catch {
      /* 审计失败不能影响事实提交 */
    }
  }

  private async route(
    method: string,
    p: Record<string, unknown>,
    bound?: { sessionId: string; taskId: string },
  ): Promise<unknown> {
    const board = this.opts.board;
    // R25：走管道的请求身份由令牌绑定，请求体里的 sessionId 必须与绑定一致，否则拒绝。
    // bound 缺席 = 主进程内部直调（如 verify-history 的 R17 回归），沿用旧解析路径。
    const claimed = p.sessionId === undefined ? undefined : String(p.sessionId);
    if (bound && claimed !== undefined && claimed !== bound.sessionId) {
      throw new Error(`会话身份不匹配（连接绑定 ${bound.sessionId}，请求声称 ${claimed}）`);
    }
    const sessionId = bound ? bound.sessionId : String(p.sessionId ?? "unknown");
    // 以库里的会话归属为准；绑定的 taskId 只在会话查不到时兜底。
    const taskId = board.getSession(sessionId)?.task_id ?? bound?.taskId ?? String(p.taskId ?? this.opts.taskId);

    switch (method) {
      case BRIDGE_RPC.readSince: {
        const after = Number(p.afterId ?? 0);
        const rows = board.readSinceForTask(after, taskId);
        this.opts.onBoardRead?.(sessionId, after, rows.length);
        return {
          events: rows.map((r) => ({
            id: r.id,
            ts: r.ts,
            by: r.session_id,
            kind: r.kind,
            body: safeParse(r.body),
          })),
          lastId: rows.length ? rows[rows.length - 1].id : board.lastEventId(),
        };
      }
      case BRIDGE_RPC.queryView: {
        const view = String(p.view ?? "");
        switch (view) {
          case "dead_ends":
            return board.listDeadEnds(taskId);
          case "facts":
            return board.listFacts(taskId);
          case "intents":
            return board.listIntents(taskId);
          case "leases":
            // R18：MCP 视图同样按任务隔离（taskId 已由 sessionId 查库得出）。
            return board.listLeases(taskId);
          default:
            throw new Error(`未知视图：${view}`);
        }
      }
      case BRIDGE_RPC.submitFact: {
        const content = String(p.content ?? "");
        const witness = (p.witness as string | undefined) ?? null;
        const r = board.submitFact({
          taskId,
          sessionId,
          content,
          witness,
          evidence: await this.inferEvidence(content, witness, taskId, sessionId),
        });
        return { id: r.id, evidence: r.evidence };
      }
      case BRIDGE_RPC.declareDeadEnd:
        return board.declareDeadEnd({
          taskId,
          sessionId,
          description: String(p.description ?? ""),
          scope: (p.scope as string | undefined) ?? null,
          reopenWhen: (p.reopenWhen as string | undefined) ?? null,
        });
      case BRIDGE_RPC.openIntent:
        return board.openIntent({ taskId, sessionId, description: String(p.description ?? "") });
      case BRIDGE_RPC.acquireLease:
        return board.acquireLease({
          resource: String(p.resource ?? ""),
          sessionId,
          taskId,
        });
      case BRIDGE_RPC.releaseLease:
        return {
          released: board.releaseLease(String(p.resource ?? ""), sessionId, String(p.reason ?? "agent")),
        };
      case BRIDGE_RPC.renewLease:
        return board.acquireLease({
          resource: String(p.resource ?? ""),
          sessionId,
          taskId,
        });
      // ---- P2-B：技能库只读工具（同一令牌/连接；每次调用留审计日志） ----
      case BRIDGE_RPC.skillSearch: {
        const index = this.ensureSkillIndex();
        const query = String(p.query ?? "");
        const source = p.source === undefined ? "all" : String(p.source);
        const limit = p.limit === undefined ? 10 : Number(p.limit);
        const hits = skillSearch(index, query, source, limit);
        this.opts.log?.(
          `bridge: skill_search session=${sessionId} query=${JSON.stringify(query)} source=${source} hits=${hits.length}`,
        );
        return { query, source, hits, indexBuiltAt: index.builtAt };
      }
      case BRIDGE_RPC.skillRead: {
        const index = this.ensureSkillIndex();
        const relPath = String(p.path ?? "");
        const result = skillRead(index.root, relPath, p.offset ?? 0, p.limit);
        this.opts.log?.(
          `bridge: skill_read session=${sessionId} path=${JSON.stringify(result.path)} bytes=${Buffer.byteLength(result.content, "utf8")} truncated=${result.truncated}`,
        );
        return result;
      }
      case BRIDGE_RPC.skillList: {
        const index = this.ensureSkillIndex();
        const category = typeof p.category === "string" ? p.category : undefined;
        const result = skillList(index, category);
        this.opts.log?.(
          `bridge: skill_list session=${sessionId} category=${category ?? "(all)"} packages=${result.packages.length}`,
        );
        return result;
      }
      default:
        throw new Error(`未知桥方法：${method}`);
    }
  }

  /**
   * P2-B：懒构建技能索引。首次 skill_* 调用才读技能库；之后复用内存索引。
   * 未配置时抛可读错误（由 handle() 转成 JSON error 返回给 MCP 子进程）。
   */
  private ensureSkillIndex() {
    if (!this.opts.skill) throw new Error("技能库不可用：主进程未配置技能库（skill.configured=false）");
    return this.opts.skill.ensureIndex();
  }

  /**
   * 撤销某会话的 MCP 访问权：断开已认证连接并删除令牌。
   *
   * 为什么不能只靠进程树 kill：Windows 的 taskkill /T 通常能收掉 MCP 子进程，
   * 但非 Windows 的 killTree 只杀直接子进程，agent 也可能把 MCP 起在别的进程树里。
   * 会话停止后残留的旧令牌不应还能写黑板（审查 P2）。
   */
  revokeSession(sessionId: string): void {
    // P7-B：主动撤销/会话结束关闭的 MCP 连接不算崩溃。
    this.revokedSessions.add(sessionId);
    const mcpPid = this.sessionMcpPids.get(sessionId) ?? null;
    if (mcpPid !== null) {
      this.sessionMcpPids.delete(sessionId);
      this.opts.onMcpClosed?.(sessionId, mcpPid);
    }
    const set = this.sessionSockets.get(sessionId);
    if (set) {
      for (const s of set) s.destroy();
      this.sessionSockets.delete(sessionId);
    }
    const token = this.sessionTokens.get(sessionId);
    if (token) this.tokensByIdentity.delete(token);
    this.sessionTokens.delete(sessionId);
    // 兜底：清掉任何仍指向该会话的令牌，避免 map 不一致时漏网。
    for (const [t, id] of [...this.tokensByIdentity]) {
      if (id.sessionId === sessionId) this.tokensByIdentity.delete(t);
    }
  }

  stop(): void {
    // P7-B：应用退出/桥关闭不是 MCP 崩溃。
    for (const [sid, pid] of this.sessionMcpPids) this.opts.onMcpClosed?.(sid, pid);
    this.sessionMcpPids.clear();
    for (const id of this.sessionSockets.keys()) this.revokedSessions.add(id);
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.sessionSockets.clear();
    this.sessionTokens.clear();
    this.tokensByIdentity.clear();
    this.server?.close();
  }
}

/**
 * 证据命中判定（P3-B 批次 1）：提交内容里的 flag，或提交的事实文本本身。
 * 事实文本按**包含**匹配（文件可以有前后缀），空/纯空白事实不算命中。
 */
function evidenceMatches(content: string, text: string): boolean {
  const flag = extractFlag(content);
  if (flag && text.includes(flag)) return true;
  const fact = content.trim();
  return fact.length > 0 && text.includes(fact);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
