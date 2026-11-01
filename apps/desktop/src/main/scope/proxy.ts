/**
 * P4-D 批次 2：本地范围代理（默认关闭）。
 *
 * 设计：
 *  - 父进程（Electron main）持有 token → session/task 映射，按请求实时向 board
 *    取 targets/denyTargets，决定 allow/deny；
 *  - 子进程只做网络转发（HTTP + CONNECT），监听 127.0.0.1 随机端口；
 *  - 会话 env 里的 proxy URL 带随机 token（`http://bumimang:<token>@127.0.0.1:<port>`），
 *    避免同一端口上的 A 任务会话访问 B 任务 targets；
 *  - 子进程不写请求 body；每个请求把 host:port/verdict/timestamp 回给父进程审计；
 *  - 代理崩溃/启动失败只影响网络出口，不阻塞会话启动；策略闸门仍在 ACP 路径上。
 *
 * 边界：只对遵守 HTTP_PROXY/HTTPS_PROXY 的工具生效；nmap/raw socket/DNS/直连
 * 可绕过。不修改系统代理/防火墙，不承诺 OS 级拦截。
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { TargetView } from "../../../../../packages/shared-protocol/events.ts";
import { matchTargets } from "./match.ts";
import type { ProcessRegistry } from "../reliability/process-registry.ts";

export interface ProxyScopeData {
  targets: TargetView[];
  denyTargets: string[];
}

export interface ProxyAuditEntry {
  sessionId: string | null;
  taskId: string | null;
  host: string;
  port: number;
  verdict: string;
  timestamp: number;
  reason?: string;
}

export interface ScopeProxyOptions {
  /** 0 = 随机端口（默认）；也可显式指定。 */
  port?: number;
  /** 父进程按 taskId 实时解析目标；返回 null = 任务不存在。 */
  resolveScope: (taskId: string) => ProxyScopeData | null;
  /** 每个请求一条；不包含请求 body。 */
  audit: (entry: ProxyAuditEntry) => void;
  /** WP7 预告：只登记/清理代理子进程句柄。 */
  registry?: ProcessRegistry;
  startupTimeoutMs?: number;
  /**
   * P6-B 批次 2a：真实状态变化回调（观测/展示用）。
   *
   * 回调只读：不能在这里重新启动/关闭代理，也不能改变启停行为。
   * 回调抛错只写 stderr，不影响代理本身。
   */
  onStateChange?: (state: ScopeProxyStateSnapshot) => void;
}

export interface ScopeProxyInfo {
  port: number;
  address: string;
}

/**
 * P6-B 批次 2a：代理真实状态。
 *
 * `enabled` 是 config 意图，`state` 才是真实状态；这里的状态机**不改变**
 * 代理的启停行为（启动失败/崩溃仍然只降级网络出口，不挂起会话）。
 */
export type ScopeProxyState = "starting" | "running" | "failed" | "stopped";

export interface ScopeProxyStateSnapshot {
  state: ScopeProxyState;
  /** 只有 running 时是真实端口；starting/failed/stopped 一律 null。 */
  port: number | null;
  /** state=failed 时的可读原因。 */
  error?: string;
}

interface SessionBinding {
  sessionId: string;
  taskId: string;
}

interface ResolveDecision {
  allowed: boolean;
  verdict: string;
  reason?: string;
}

export class ScopeProxyService {
  private opts: ScopeProxyOptions;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private address: string | null = null;
  private closing = false;
  private tokens = new Map<string, SessionBinding>();
  private startResolve: ((info: ScopeProxyInfo) => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** P6-B 批次 2a：真实状态；初始为 stopped，start() 后进入 starting。 */
  private state: ScopeProxyState = "stopped";
  private stateError: string | undefined;

  constructor(opts: ScopeProxyOptions) {
    this.opts = opts;
  }

  /** P6-B 批次 2a：只读真实状态；port 只有 running 时非 null。 */
  getState(): ScopeProxyStateSnapshot {
    return {
      state: this.state,
      port: this.state === "running" ? this.port : null,
      ...(this.state === "failed" && this.stateError ? { error: this.stateError } : {}),
    };
  }

  private setState(state: ScopeProxyState, error?: string): void {
    const nextError = state === "failed" ? error : undefined;
    const changed = this.state !== state || this.stateError !== nextError;
    this.state = state;
    this.stateError = nextError;
    if (!changed) return;
    try {
      this.opts.onStateChange?.(this.getState());
    } catch (err) {
      process.stderr.write(`[proxy] 状态回调失败：${(err as Error).message}\n`);
    }
  }

  isRunning(): boolean {
    return this.child !== null && this.port !== null;
  }

  getPort(): number | null {
    return this.port;
  }

  async start(): Promise<ScopeProxyInfo> {
    if (this.closing) throw new Error("代理已关闭，不能重新启动");
    if (this.child) throw new Error("代理已经启动");
    this.setState("starting");
    const ready = new Promise<ScopeProxyInfo>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    const script = fileURLToPath(new URL("./proxy.ts", import.meta.url));
    let child: ChildProcess;
    try {
      child = fork(script, ["--serve"], {
        execPath: process.execPath,
        // 不继承父进程的 --input-type/--eval 等 execArgv（CLI 测试会带这些参数）。
        execArgv: [],
        env: {
          ...process.env,
          // Electron 主进程里 process.execPath 是 electron.exe；用纯 Node 形态跑子进程。
          ELECTRON_RUN_AS_NODE: "1",
          BUMIMANG_PROXY_PORT: String(this.opts.port ?? 0),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch (err) {
      this.failStart(err instanceof Error ? err : new Error(String(err)));
      return ready;
    }
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => {
      process.stderr.write(`[proxy] ${d.toString("utf8").trimEnd()}\n`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[proxy] ${d.toString("utf8").trimEnd()}\n`);
    });
    child.on("message", (msg: unknown) => this.onChildMessage(child, msg));
    child.on("error", (err: Error) => this.failStart(err));
    child.on("exit", (code, signal) => this.onChildExit(child, code, signal));
    this.startTimer = setTimeout(() => {
      this.failStart(new Error("代理启动超时"));
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, this.opts.startupTimeoutMs ?? 5000);
    return ready;
  }

  /**
   * 为会话签发代理 URL。URL 里带随机 token；父进程按 token 找 task，
   * 因此同一代理端口不会跨任务放行。
   */
  urlForSession(sessionId: string, taskId: string): string | null {
    if (!this.isRunning() || this.port === null) return null;
    for (const [token, binding] of [...this.tokens]) {
      if (binding.sessionId === sessionId) this.tokens.delete(token);
    }
    const token = randomBytes(18).toString("hex");
    this.tokens.set(token, { sessionId, taskId });
    return `http://bumimang:${token}@127.0.0.1:${this.port}`;
  }

  releaseSession(sessionId: string): void {
    for (const [token, binding] of [...this.tokens]) {
      if (binding.sessionId === sessionId) this.tokens.delete(token);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    const pid = child?.pid ?? null;
    this.child = null;
    this.port = null;
    this.address = null;
    this.tokens.clear();
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    if (reject) reject(new Error("代理已关闭"));
    if (!child) {
      this.opts.registry?.unregister(pid);
      this.setState("stopped");
      return;
    }
    try {
      child.send({ type: "shutdown" });
    } catch {
      /* 管道已断 */
    }
    const exited = await waitForExit(child, 2000);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
    this.opts.registry?.unregister(pid);
    this.setState("stopped");
  }

  private clearStart(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.startResolve = null;
    this.startReject = null;
  }

  private failStart(err: Error): void {
    const pid = this.child?.pid ?? null;
    this.child = null;
    this.port = null;
    this.address = null;
    const reject = this.startReject;
    this.clearStart();
    this.opts.registry?.unregister(pid);
    this.setState("failed", err.message);
    if (reject) reject(err);
    else process.stderr.write(`[proxy] 代理不可用：${err.message}\n`);
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const wasCurrent = this.child === child;
    if (wasCurrent) {
      this.child = null;
      this.port = null;
      this.address = null;
    }
    this.opts.registry?.unregister(child.pid);
    if (this.closing) return;
    const message = `代理进程退出（code=${String(code)} signal=${String(signal)}）`;
    if (this.startReject) {
      this.failStart(new Error(message));
      return;
    }
    // 已启动后崩溃：会话继续，代理不可用；不要在这里 kill 会话。
    // P6-B 批次 2a：只把真实状态标成 failed，并清空端口；不改变降级行为。
    if (wasCurrent) {
      this.setState("failed", message);
      process.stderr.write(`[proxy] ${message}；会话继续，代理网络出口不可用\n`);
    }
  }

  private onChildMessage(child: ChildProcess, raw: unknown): void {
    if (this.closing || this.child !== child) return;
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg.type === "ready") {
      const port = Number(msg.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        this.failStart(new Error(`代理返回非法端口：${String(msg.port)}`));
        return;
      }
      this.port = port;
      this.address = typeof msg.address === "string" ? msg.address : null;
      this.opts.registry?.register(
        child,
        "scope-proxy",
        typeof msg.startedAt === "number" ? msg.startedAt : Date.now(),
      );
      const resolve = this.startResolve;
      this.clearStart();
      this.setState("running");
      resolve?.({ port, address: this.address ?? "" });
      return;
    }
    if (msg.type === "resolve") {
      this.answerResolve(child, msg);
      return;
    }
    if (msg.type === "audit") {
      this.handleAudit(msg);
      return;
    }
    if (msg.type === "error") {
      process.stderr.write(`[proxy] 子进程错误：${String(msg.message ?? "unknown")}\n`);
      if (this.startReject) {
        this.failStart(new Error(String(msg.message ?? "代理子进程错误")));
      }
    }
  }

  private answerResolve(child: ChildProcess, msg: Record<string, unknown>): void {
    const id = Number(msg.id);
    const token = typeof msg.token === "string" ? msg.token : "";
    const host = typeof msg.host === "string" ? msg.host : "";
    const port = Number(msg.port);
    const binding = token ? this.tokens.get(token) : undefined;
    let decision: ResolveDecision = {
      allowed: false,
      verdict: "unauthorized",
      reason: "unknown-proxy-token",
    };
    if (binding) {
      try {
        const scope = this.opts.resolveScope(binding.taskId);
        if (!scope) {
          decision = { allowed: false, verdict: "out", reason: "no-task-scope" };
        } else {
          const value =
            host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
          const res = matchTargets(scope.targets, { kind: "host", value }, scope.denyTargets);
          decision = { allowed: res.verdict === "in", verdict: res.verdict, reason: res.reason };
        }
      } catch (err) {
        decision = {
          allowed: false,
          verdict: "error",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    try {
      child.send({ type: "decision", id, ...decision });
    } catch {
      /* 子进程已退出；请求会超时/失败，不影响主进程 */
    }
  }

  private handleAudit(msg: Record<string, unknown>): void {
    const token = typeof msg.token === "string" ? msg.token : "";
    const binding = token ? this.tokens.get(token) : undefined;
    const entry: ProxyAuditEntry = {
      sessionId: binding?.sessionId ?? null,
      taskId: binding?.taskId ?? null,
      host: typeof msg.host === "string" ? msg.host : "",
      port: Number(msg.port) || 0,
      verdict: typeof msg.verdict === "string" ? msg.verdict : "unknown",
      timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
      ...(typeof msg.reason === "string" && msg.reason ? { reason: msg.reason } : {}),
    };
    try {
      this.opts.audit(entry);
    } catch (err) {
      process.stderr.write(`[proxy] 审计回调失败：${(err as Error).message}\n`);
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------- 子进程侧

const CHILD_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIVE = 64;
const RESOLVE_TIMEOUT_MS = 5000;

interface PendingResolve {
  resolve: (d: ResolveDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

function runProxyChild(): void {
  const port = Number(process.env.BUMIMANG_PROXY_PORT ?? "0");
  const server = createHttpServer();
  const activeSockets = new Set<Socket>();
  let active = 0;
  let seq = 0;
  let shuttingDown = false;
  const pending = new Map<number, PendingResolve>();

  const sendParent = (msg: unknown): void => {
    try {
      process.send?.(msg);
    } catch {
      /* 父进程已断开 */
    }
  };

  const audit = (
    token: string | null,
    host: string,
    remotePort: number,
    verdict: string,
    reason?: string,
  ): void => {
    sendParent({
      type: "audit",
      token,
      host,
      port: remotePort,
      verdict,
      timestamp: Date.now(),
      ...(reason ? { reason } : {}),
    });
  };

  const authToken = (req: IncomingMessage): string | null => {
    const raw = req.headers["proxy-authorization"];
    if (typeof raw !== "string") return null;
    const m = /^Basic\s+(.+)$/i.exec(raw.trim());
    if (!m) return null;
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) return null;
      const token = decoded.slice(i + 1).trim();
      return token || null;
    } catch {
      return null;
    }
  };

  const askParent = (token: string, host: string, remotePort: number): Promise<ResolveDecision> => {
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ allowed: false, verdict: "error", reason: "parent-timeout" });
      }, RESOLVE_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      sendParent({ type: "resolve", id, token, host, port: remotePort });
    });
  };

  const release = (): void => {
    if (active > 0) active--;
  };

  const deny = (
    res: ServerResponse,
    code: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...extraHeaders });
    res.end(message);
  };

  const tooBusy = (): boolean => active >= MAX_ACTIVE;

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  });

  server.on("request", (req, res) => {
    if (tooBusy()) {
      deny(res, 503, "scope proxy busy");
      audit(authToken(req), "?", 0, "busy", "max-active");
      return;
    }
    active++;
    res.on("close", release);
    void handleHttp(req, res).catch((err: unknown) => {
      if (!res.headersSent) deny(res, 502, `proxy error: ${(err as Error).message}`);
      else res.destroy();
      audit(authToken(req), "?", 0, "error", (err as Error).message);
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = authToken(req);
    let target: URL;
    try {
      target = new URL(String(req.url ?? ""));
    } catch {
      deny(res, 400, "absolute URL required");
      audit(token, "?", 0, "error", "bad-request-url");
      return;
    }
    if (target.protocol !== "http:") {
      deny(res, 400, "HTTPS must use CONNECT");
      audit(token, target.hostname, Number(target.port || 80), "error", "https-requires-connect");
      return;
    }
    const host = target.hostname;
    const remotePort = Number(target.port || 80);
    if (!token) {
      deny(res, 407, "proxy authentication required", {
        "proxy-authenticate": 'Basic realm="bumimang"',
      });
      audit(null, host, remotePort, "unauthorized", "missing-token");
      return;
    }
    const decision = await askParent(token, host, remotePort);
    if (!decision.allowed) {
      deny(res, 403, `blocked by scope proxy: ${decision.reason ?? decision.verdict}`);
      audit(token, host, remotePort, decision.verdict, decision.reason);
      return;
    }
    audit(token, host, remotePort, "allow", decision.reason);

    const headers: Record<string, string | string[]> = { ...req.headers };
    delete (headers as Record<string, unknown>)["proxy-authorization"];
    delete (headers as Record<string, unknown>)["proxy-connection"];
    delete (headers as Record<string, unknown>)["connection"];
    headers.host = remotePort === 80 ? host : `${host}:${remotePort}`;

    let bodyBytes = 0;
    let failed = false;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      deny(res, 413, "request body too large");
      audit(token, host, remotePort, "error", "body-too-large");
      req.resume();
      return;
    }
    const proxyReq = httpRequest(
      {
        host,
        port: remotePort,
        method: req.method,
        path: `${target.pathname || "/"}${target.search}`,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (failed) return;
      failed = true;
      proxyReq.destroy(new Error("timeout"));
      if (!res.headersSent) deny(res, 504, "scope proxy timeout");
      else res.destroy();
      audit(token, host, remotePort, "error", "timeout");
    });
    proxyReq.on("error", (err) => {
      if (failed) return;
      failed = true;
      if (!res.headersSent) deny(res, 502, `upstream error: ${err.message}`);
      else res.destroy();
      audit(token, host, remotePort, "error", err.message);
    });
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES && !failed) {
        failed = true;
        req.destroy();
        proxyReq.destroy();
        if (!res.headersSent) deny(res, 413, "request body too large");
        audit(token, host, remotePort, "error", "body-too-large");
      }
    });
    res.on("close", () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });
    req.pipe(proxyReq);
  }

  server.on("connect", (req, clientSocket, head) => {
    if (tooBusy()) {
      clientSocket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      audit(authToken(req), "?", 0, "busy", "max-active");
      return;
    }
    active++;
    clientSocket.on("close", release);
    void handleConnect(req, clientSocket, head).catch((err: unknown) => {
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      }
      audit(authToken(req), "?", 0, "error", (err as Error).message);
    });
  });

  async function handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): Promise<void> {
    const token = authToken(req);
    const parsed = parseHostPort(String(req.url ?? ""), 443);
    if (!parsed) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      audit(token, "?", 0, "error", "bad-connect-target");
      return;
    }
    const { host, port: remotePort } = parsed;
    if (!token) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="bumimang"\r\nContent-Length: 0\r\n\r\n',
      );
      audit(null, host, remotePort, "unauthorized", "missing-token");
      return;
    }
    const decision = await askParent(token, host, remotePort);
    if (!decision.allowed) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      audit(token, host, remotePort, decision.verdict, decision.reason);
      return;
    }
    audit(token, host, remotePort, "allow", decision.reason);
    const upstream = netConnect(remotePort, host);
    let failed = false;
    upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (failed) return;
      failed = true;
      upstream.destroy();
      clientSocket.destroy();
      audit(token, host, remotePort, "error", "timeout");
    });
    upstream.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", (err) => {
      if (failed) return;
      failed = true;
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      }
      audit(token, host, remotePort, "error", err.message);
    });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  }

  process.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg.type === "decision") {
      const id = Number(msg.id);
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({
        allowed: msg.allowed === true,
        verdict: typeof msg.verdict === "string" ? msg.verdict : "error",
        ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}),
      });
      return;
    }
    if (msg.type === "shutdown") shutdown();
  });

  server.on("error", (err) => {
    sendParent({ type: "error", message: err.message });
    process.exit(1);
  });

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch {
        /* 已关闭 */
      }
    }
    activeSockets.clear();
    try {
      server.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1000).unref();
  }

  process.on("disconnect", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, CHILD_HOST, () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      sendParent({ type: "error", message: "代理监听地址不可用" });
      process.exit(1);
      return;
    }
    sendParent({
      type: "ready",
      port: addr.port,
      address: addr.address,
      pid: process.pid,
      startedAt: Date.now() - Math.round(process.uptime() * 1000),
    });
  });
}

function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } | null {
  const text = raw.trim();
  if (!text || text.includes("\0")) return null;
  let host = text;
  let port = defaultPort;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest.startsWith(":")) port = Number(rest.slice(1));
  } else {
    const i = text.lastIndexOf(":");
    if (i > 0) {
      host = text.slice(0, i);
      port = Number(text.slice(i + 1));
    }
  }
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

if (process.argv.includes("--serve")) {
  runProxyChild();
}
