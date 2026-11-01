/**
 * 假 ACP agent —— 只用于验证 `fs/*` 与 `terminal/*` 的客户端反向调用闸门。
 *
 * 三家真实 agent 实测都不走这两类调用，但 ACP 允许它们走；这条路径上的
 * `approve` 必须和 `session/request_permission` 一样转人工。这个假 agent
 * 在 session/new 后主动发：
 *   1. fs/read_text_file（路径由 FAKE_READ_PATH 指定）
 *   2. terminal/create（cwd=FAKE_WORKROOT，命令 `cmd.exe /c type <FAKE_TERM_TARGET>`）
 * 把客户端的应答写到 FAKE_OUT，然后退出。
 *
 * 环境变量：
 *  - FAKE_OUT：结果 JSON 路径
 *  - FAKE_READ_PATH：读取路径（默认 FAKE_TARGET）
 *  - FAKE_TARGET：默认读取/命令目标
 *  - FAKE_WORKROOT：terminal cwd
 *  - FAKE_SKIP_TERMINAL=1：只测读取
 */
import { writeFileSync } from "node:fs";

const OUT = process.env.FAKE_OUT ?? "";
const TARGET = process.env.FAKE_TARGET ?? process.cwd();
const READ_PATH = process.env.FAKE_READ_PATH ?? TARGET;
const WORKROOT = process.env.FAKE_WORKROOT ?? process.cwd();
const SKIP_TERMINAL = process.env.FAKE_SKIP_TERMINAL === "1";

const results: Record<string, unknown> = { readPath: READ_PATH };
let sentTerminal = false;
let terminalId: string | null = null;

function send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function finish(): void {
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
  setTimeout(() => process.exit(0), 30);
}

function next(): void {
  if (SKIP_TERMINAL) {
    finish();
    return;
  }
  if (sentTerminal) return;
  sentTerminal = true;
  send({
    jsonrpc: "2.0",
    id: 501,
    method: "terminal/create",
    params: {
      sessionId: "sess-fake-fs",
      command: "cmd.exe",
      args: ["/c", "type", TARGET],
      cwd: WORKROOT,
      outputByteLimit: 4096,
    },
  });
}

function handle(msg: Record<string, unknown>): void {
  const method = msg.method as string | undefined;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-fs-agent", title: "Fake FS Agent", version: "0.0.1" },
        authMethods: [],
      },
    });
    return;
  }
  if (method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fake-fs" } });
    send({
      jsonrpc: "2.0",
      id: 500,
      method: "fs/read_text_file",
      params: { sessionId: "sess-fake-fs", path: READ_PATH, line: 1, limit: 2 },
    });
    return;
  }
  if (method === "session/close") {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (typeof msg.id === "number" && msg.id >= 500 && msg.id < 600) {
    if (msg.id === 500) {
      results.fsRead = msg.error ?? {
        contentHead: String((msg.result as { content?: unknown })?.content ?? "").slice(0, 120),
      };
      next();
      return;
    }
    if (msg.id === 501) {
      results.terminalCreate = msg.error ?? msg.result;
      terminalId = String((msg.result as { terminalId?: unknown })?.terminalId ?? "") || null;
      if (terminalId) {
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            id: 502,
            method: "terminal/output",
            params: { sessionId: "sess-fake-fs", terminalId },
          });
        }, 400);
      } else {
        finish();
      }
      return;
    }
    if (msg.id === 502) {
      results.terminalOutput = msg.error ?? {
        outputHead: String((msg.result as { output?: unknown })?.output ?? "").slice(0, 160),
      };
      send({
        jsonrpc: "2.0",
        id: 503,
        method: "terminal/release",
        params: { sessionId: "sess-fake-fs", terminalId },
      });
      setTimeout(finish, 80);
      return;
    }
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* 忽略坏行 */
    }
  }
});
