/**
 * MCP 子进程 —— 由 agent 以 stdio 方式拉起（ACP `session/new` 的 mcpServers 条目）。
 *
 * 它是"薄转发器"（§4.2 规则 5）：不含数据库、不含业务逻辑、不含依赖之外的判断。
 * 名字一旦发布就进 agent 的上下文，改名成本高（§5.1），所以下面这组名字是冻结的。
 *
 * 启动参数：node server.ts <pipeName>
 * 环境变量：BUMIMANG_TOKEN / BUMIMANG_SESSION / BUMIMANG_TASK
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect } from "node:net";
import { z } from "zod";
import { BRIDGE_RPC } from "./protocol.ts";

const pipeName = process.env.BUMIMANG_PIPE ?? process.argv[2];
const token = process.env.BUMIMANG_TOKEN ?? "";
const sessionId = process.env.BUMIMANG_SESSION ?? "unknown";
const taskId = process.env.BUMIMANG_TASK ?? "unknown";

// P7-B：MCP 子进程崩溃时留下可读日志并退出；主进程桥看到 socket 关闭后
// 标记 session.mcpUnavailable。不在这里自动重启。
process.on("uncaughtException", (err) => {
  process.stderr.write(`[mcp] uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[mcp] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  process.exit(1);
});

if (!pipeName) {
  process.stderr.write("缺少 BUMIMANG_PIPE\n");
  process.exit(2);
}

// ---- 与主进程的管道连接 ----

let sock: ReturnType<typeof connect> | null = null;
let buf = "";
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let ready: Promise<void> | null = null;

function ensureConnected(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    sock = connect(pipeName);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock!.write(
        JSON.stringify({ id: 0, method: BRIDGE_RPC.hello, token, sessionId, pid: process.pid }) + "\n",
      );
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        if (msg.id === 0) {
          if (msg.error) reject(new Error(msg.error));
          else resolve();
          continue;
        }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    });
    const fail = (e: Error): void => {
      for (const [, p] of pending) p.reject(e);
      pending.clear();
      if (!sock || sock.destroyed) reject(e);
    };
    sock.on("error", fail);
    sock.on("close", () => fail(new Error("与主进程的连接已关闭")));
  });
  return ready;
}

/** 写类工具是同步阻塞的：等主进程落库完成再返回（§5.1 约定 2），保证"读己之写"。 */
async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  await ensureConnected();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock!.write(JSON.stringify({ id, method, params: { ...params, sessionId, taskId } }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`桥调用超时：${method}`));
    }, 5000);
  });
}

function text(v: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] };
}

// ---- MCP 工具面（名字冻结，见 §5.1）----

const SYNC_RULE =
  "【纪律】在开始任何一个新的假设之前，以及每完成 3 个工具调用之后，你都必须先调用本工具。这是强制要求：黑板上有队友已经确认的事实与已经踩过的死路，不读就会重复劳动。";

const WORKDIR = process.env.BUMIMANG_WORKDIR ?? "";
const WORKDIR_RULE = WORKDIR
  ? `【工作目录】所有脚本、下载、扫描结果、报告都写到 ${WORKDIR}（或其子目录）；应用会拒绝工作目录外的 ACP 文件写入和命令 cwd。`
  : "";

/**
 * P2-B：技能库工具注册模式。
 *
 * BUMIMANG_SKILL_MCP=auto（默认）/on 注册 skill_*；off 不注册（用户 harness 已有同名工具时用）。
 * 注意：stdio MCP server 看不到宿主聚合后的其他 server 工具名，auto 无法真正探测同名冲突；
 * 所以 auto 只记一条 warning，冲突时由用户显式设 off。
 */
const SKILL_MCP_MODE_RAW = (process.env.BUMIMANG_SKILL_MCP ?? "auto").trim().toLowerCase();
const SKILL_MCP_MODE = SKILL_MCP_MODE_RAW === "on" || SKILL_MCP_MODE_RAW === "off" ? SKILL_MCP_MODE_RAW : "auto";
const REGISTER_SKILL_TOOLS = SKILL_MCP_MODE !== "off";
if (SKILL_MCP_MODE === "auto") {
  process.stderr.write(
    "[bumimang-mcp] BUMIMANG_SKILL_MCP=auto：已注册 skill_*；无法探测宿主是否已有同名工具，冲突时请设 off\n",
  );
}

const server = new McpServer({ name: "bumimang-blackboard", version: "0.1.0-m1" });

/**
 * 工具注解（R16）。
 *
 * codex 的全局 approval_policy 可能是 `never`（本机就是）。在那种策略下，**未声明
 * readOnlyHint 的 MCP 工具会被要求审批 → 直接失败**。给只读工具声明 readOnlyHint
 * 之后，它们在 never 下也能直接调用（AIxVuln 交付包在同类环境实测过，见其
 * install-notes §6）。
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE_BOARD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const WRITE_BOARD_IDEMPOTENT = { ...WRITE_BOARD, idempotentHint: true } as const;

server.registerTool(
  "blackboard_read_since",
  {
    title: "读取黑板增量",
    description:
      `读取共享黑板自 after_id 之后的新事件（事实 / 死路 / 意图 / 租约 / 答案）。` +
      `返回 lastId，下次调用时把它作为 after_id。${SYNC_RULE}${WORKDIR_RULE}`,
    inputSchema: { after_id: z.number().int().nonnegative().describe("上次拿到的 lastId，首次传 0") },
    annotations: READ_ONLY,
  },
  async ({ after_id }) => text(await rpc(BRIDGE_RPC.readSince, { afterId: after_id })),
);

server.registerTool(
  "blackboard_query_view",
  {
    title: "查询黑板当前视图",
    description:
      "查询黑板的当前状态视图。view 取值：dead_ends（已确认走不通的路径）、facts（已确认的事实）、intents（队友正在做的事）、leases（被占用的资源）。",
    inputSchema: {
      view: z.enum(["dead_ends", "facts", "intents", "leases"]).describe("要查询的视图"),
    },
    annotations: READ_ONLY,
  },
  async ({ view }) => text(await rpc(BRIDGE_RPC.queryView, { view })),
);

server.registerTool(
  "blackboard_declare_dead_end",
  {
    title: "声明死路",
    description:
      "当你确认某条路径走不通时调用。这是最有价值的写入：队友会因此不再重复尝试。description 要写清具体是什么走不通（例如「/admin 弱口令不可用，已试 20 个常见口令」），不要写笼统的结论。",
    inputSchema: {
      description: z.string().describe("具体走不通的路径，含已尝试的范围"),
      scope: z.string().optional().describe("作用域，如 http / 10.0.0.9 / file:config.php"),
      reopen_when: z.string().optional().describe("什么条件下值得重试"),
    },
    annotations: WRITE_BOARD,
  },
  async ({ description, scope, reopen_when }) =>
    text(await rpc(BRIDGE_RPC.declareDeadEnd, { description, scope, reopenWhen: reopen_when })),
);

server.registerTool(
  "blackboard_submit_fact",
  {
    title: "提交事实",
    description:
      "把你确认的事实写入黑板。必须提供 witness（可核验的来源：执行的命令、产物文件路径、artifact id）。没有 witness 的内容会被记为 E0（仅自述），不会被当作可用依据。",
    inputSchema: {
      content: z.string().describe("事实内容，一句话说清"),
      witness: z.string().describe("可核验来源：命令 / 文件路径 / 产物 id"),
    },
    annotations: WRITE_BOARD,
  },
  async ({ content, witness }) => text(await rpc(BRIDGE_RPC.submitFact, { content, witness })),
);

server.registerTool(
  "blackboard_open_intent",
  {
    title: "登记意图",
    description:
      "在开始一件需要较长时间的工作之前登记你的意图，避免与队友撞车。登记前先用 blackboard_query_view 看 intents 里有没有人已经在做同一件事。",
    inputSchema: { description: z.string().describe("你打算做什么") },
    annotations: WRITE_BOARD,
  },
  async ({ description }) => text(await rpc(BRIDGE_RPC.openIntent, { description })),
);

server.registerTool(
  "blackboard_acquire_lease",
  {
    title: "申请资源租约",
    description:
      "申请独占某个共享资源。resource 形如 session:jumphost（跳板机会话，同一时间只能一人使用）、target:10.0.0.9（目标主机，避免并发把它打挂）、port:8080。返回 WON 表示拿到，LOST 表示被别人持有——**拿不到不要傻等，改去做不依赖该资源的其他子问题**。",
    inputSchema: { resource: z.string().describe("资源键，如 target:10.0.0.9") },
    annotations: WRITE_BOARD,
  },
  async ({ resource }) => text(await rpc(BRIDGE_RPC.acquireLease, { resource })),
);

server.registerTool(
  "blackboard_release_lease",
  {
    title: "释放资源租约",
    description: "用完之后立即释放，让队友可以用。不释放会一直占到过期。",
    inputSchema: {
      resource: z.string().describe("资源键"),
      reason: z.string().optional().describe("释放原因"),
    },
    annotations: WRITE_BOARD_IDEMPOTENT,
  },
  async ({ resource, reason }) => text(await rpc(BRIDGE_RPC.releaseLease, { resource, reason })),
);

if (REGISTER_SKILL_TOOLS) {
  const SKILL_RULE =
    "技能库只读：path 相对技能库根；先用 skill_search 检索，确认命中后再用 skill_read 精读。" +
    "检索结果里的 WP/脚本路径可能只是索引元数据，读不到时改用该路径的目录做 search。";

  server.registerTool(
    "skill_search",
    {
      title: "检索技能库",
      description:
        `检索技能库的 SKILL.md、知识库、.idx.md、payload 速查、WP 索引与脚本索引。` +
        `返回 {path,line,snippet,title,kind,score}；无命中返回空数组。${SKILL_RULE}`,
      inputSchema: {
        query: z.string().describe("关键词，如 SSTI / CVE-2021-44228 / 内存马"),
        source: z
          .enum(["all", "core", "ctf", "wp", "scripts"])
          .optional()
          .describe("检索范围：all（默认）/core（文档）/ctf（ctf-solver 文档+脚本）/wp/scripts"),
        limit: z.number().int().positive().max(50).optional().describe("最多返回条数，默认 10"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, source, limit }) =>
      text(await rpc(BRIDGE_RPC.skillSearch, { query, source, limit })),
  );

  server.registerTool(
    "skill_read",
    {
      title: "读取技能文件",
      description:
        `读取技能库内的单个文件（只读，单次最多 256KB，超过会截断并标记 truncated）。` +
        `path 必须相对技能库根，禁止 .. / 绝对路径 / 盘符 / 符号链接逃逸。${SKILL_RULE}`,
      inputSchema: {
        path: z.string().describe("相对技能库根的路径，如 skills/ctf-solver/SSTI.md"),
        offset: z.number().int().nonnegative().optional().describe("起始行（从 0 开始）"),
        limit: z.number().int().positive().optional().describe("最多返回行数，默认 400"),
      },
      annotations: READ_ONLY,
    },
    async ({ path, offset, limit }) =>
      text(await rpc(BRIDGE_RPC.skillRead, { path, offset, limit })),
  );

  server.registerTool(
    "skill_list",
    {
      title: "列出技能包",
      description:
        `列出已配置技能包的文档/知识库数量与 WP/脚本总数。category 可选（web/misc/...）仅作回显提示。${SKILL_RULE}`,
      inputSchema: {
        category: z.string().optional().describe("题型分类，仅作回显提示"),
      },
      annotations: READ_ONLY,
    },
    async ({ category }) => text(await rpc(BRIDGE_RPC.skillList, { category })),
  );
}

await server.connect(new StdioServerTransport());
