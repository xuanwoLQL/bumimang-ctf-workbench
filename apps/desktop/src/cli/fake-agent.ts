/**
 * 假 ACP agent —— 只为验收"闸门接线"用。
 *
 * 为什么需要它：真实 agent 是否发 `session/request_permission` 取决于模型心情和
 * 它自己的权限配置，不能作为验收依据。而"客户端收到 request_permission 之后会
 * 不会走策略引擎、会不会挂起等人、拒绝时回什么"是纯接线问题，必须确定性验证。
 *
 * 它做四件事：应答 initialize / session/new、主动发一条 request_permission、
 * 把客户端回的 outcome 写到文件、退出。
 *
 * 环境变量：FAKE_TITLE（权限请求的标题）、FAKE_OUT（结果写哪）、FAKE_OPTIONS（可选）
 *
 * R18 增补（只在新用例里开启，默认行为不变）：
 *  - FAKE_NO_PERMISSION=1：session/new 后不主动要权限，进程保持存活；
 *  - FAKE_PROMPT_DELAY_MS=N：session/prompt 隔 N 毫秒才回结果（测"切任务后旧回调迟到"）；
 *  - FAKE_IGNORE_CLOSE=1：故意不回 session/close（测关闭超时）；
 *  - FAKE_HANG_INIT=1：永远不应答 initialize（测启动超时回滚，A3）；
 *  - FAKE_PID_FILE=path：启动时把自己的 pid 写进文件（测进程是否真的被杀）；
 *  - FAKE_ECHO_PROMPT=path：把收到的第一条 prompt 文本与 BUMIMANG_WORKDIR 追加进文件
 *    （R27：验简报里的工作目录是任务专属目录）。
 */

import { appendFileSync, writeFileSync } from "node:fs";

const TITLE = process.env.FAKE_TITLE ?? "run something";
/** 权限请求的 kind（默认 execute；验「一键放行只覆盖写入」时传 edit）。 */
const KIND = process.env.FAKE_KIND ?? "execute";
const OUT = process.env.FAKE_OUT ?? "D:/agent/xuanwo/docs/logs/fake-agent-out.json";
/** 每个 prompt 应答追加一行（R18：确定性判断"迟到的回调已经放出来了"）。 */
const PROMPT_OUT = process.env.FAKE_PROMPT_OUT ?? "";
/** 同一个权限请求发几次。用来验 §9.6 的"同规则被拒两次 → 会话转 blocked"。 */
const REPEAT = Math.max(1, Number(process.env.FAKE_REPEAT ?? "1"));
const NO_PERMISSION = process.env.FAKE_NO_PERMISSION === "1";
const PROMPT_DELAY_MS = Math.max(0, Number(process.env.FAKE_PROMPT_DELAY_MS ?? "0"));
const IGNORE_CLOSE = process.env.FAKE_IGNORE_CLOSE === "1";
/** 权限被应答后也不退出，方便测试"进程还活着时正常关停"。 */
const STAY_ALIVE = process.env.FAKE_STAY_ALIVE === "1";
/** A3：永远不应答 initialize，测启动超时回滚。 */
const HANG_INIT = process.env.FAKE_HANG_INIT === "1";
const PID_FILE = process.env.FAKE_PID_FILE ?? "";
const ECHO_PROMPT = process.env.FAKE_ECHO_PROMPT ?? "";
const REQ_ID = 100;
let sent = 0;
let answered = 0;
let echoed = false;

if (PID_FILE) {
  try {
    writeFileSync(PID_FILE, String(process.pid), "utf8");
  } catch {
    /* 观测辅助，失败不影响测试主体 */
  }
}

function send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg: Record<string, unknown>): void {
  const method = msg.method as string | undefined;

  if (method === "initialize") {
    if (HANG_INIT) return; // A3：永远不应答，逼出客户端的启动超时
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
        authMethods: [],
      },
    });
    return;
  }

  if (method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fake-1" } });
    if (!NO_PERMISSION) askPermission();
    return;
  }

  if (method === "session/prompt") {
    // R27：把第一条 prompt 文本与环境里的工作目录落盘，供验收断言。
    if (ECHO_PROMPT && !echoed) {
      echoed = true;
      try {
        const text = ((msg.params as Record<string, unknown>)?.prompt as Array<{ type?: string; text?: string }>)
          ?.map((b) => b.text ?? "")
          .join("\n") ?? "";
        appendFileSync(
          ECHO_PROMPT,
          JSON.stringify({ workdir: process.env.BUMIMANG_WORKDIR ?? "", text: text.slice(0, 4000) }) + "\n",
          "utf8",
        );
      } catch {
        /* 观测辅助 */
      }
    }
    // 故意慢回：测试「切任务后，旧会话的 prompt.then 才回来」。
    setTimeout(() => {
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        if (PROMPT_OUT) {
          appendFileSync(PROMPT_OUT, JSON.stringify({ ts: Date.now(), id: msg.id }) + "\n", "utf8");
        }
      }
    }, PROMPT_DELAY_MS);
    return;
  }

  if (method === "session/close" && IGNORE_CLOSE) {
    // 模拟坏 agent：不理关闭请求，客户端必须自己有超时，不能永远等。
    return;
  }

  // 客户端对某个权限请求的应答
  if (typeof msg.id === "number" && msg.id >= REQ_ID) {
    answered += 1;
    // 注意：**保留原始应答结构**（顶层就是 jsonrpc/id/result），只额外挂计数器。
    // 早先我把它包成 `{ last: msg, ... }`，结果 verify-gate-live 直接读 `resp.result`
    // 就读不到了 —— 16/16 掉到 12/16。回归跑出来的真回归，记在这里免得再犯。
    writeFileSync(OUT, JSON.stringify({ ...msg, answered, sent, repeat: REPEAT }, null, 2), "utf8");
    // 还有没发完的就继续发（重复请求的场景）
    if (sent < REPEAT) askPermission();
    else if (!STAY_ALIVE) setTimeout(() => process.exit(0), 30);
    return;
  }

  // 其他请求一律给个空结果，避免客户端挂住
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
}

/** 向客户端要授权 —— 唯一的事前闸门。按 REPEAT 可以重复发同一个请求。 */
function askPermission(): void {
  sent += 1;
  send({
    jsonrpc: "2.0",
    id: REQ_ID + sent - 1,
    method: "session/request_permission",
    params: {
      sessionId: "sess-fake-1",
      toolCall: {
        toolCallId: `tc-${sent}`,
        title: TITLE,
        kind: KIND,
        rawInput: KIND === "edit" ? { filepath: TITLE, diff: "+auto-allow-probe" } : { command: TITLE },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
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
