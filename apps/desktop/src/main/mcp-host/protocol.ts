/**
 * 主进程 ↔ MCP 子进程之间的私有 RPC 协议（架构文档 §4.2）。
 *
 * 通道：Windows 命名管道（不占端口）。子进程连接时必须先送一次性令牌。
 * 语义：MCP 子进程只读 + 提交，落库一律由主进程完成（§5.1 约定 1）。
 */

export const BRIDGE_RPC = {
  readSince: "board.read_since",
  queryView: "board.query_view",
  submitFact: "board.submit_fact",
  declareDeadEnd: "board.declare_dead_end",
  openIntent: "board.open_intent",
  claimIntent: "board.claim_intent",
  acquireLease: "board.acquire_lease",
  releaseLease: "board.release_lease",
  renewLease: "board.renew_lease",
  hello: "board.hello",
  // P2-B：技能库只读工具。与黑板工具走同一条管道、同一会话令牌、同一审计路径。
  skillSearch: "skill.search",
  skillRead: "skill.read",
  skillList: "skill.list",
} as const;

export type BridgeMethod = (typeof BRIDGE_RPC)[keyof typeof BRIDGE_RPC];

export interface BridgeHello {
  token: string;
  sessionId: string;
  pid: number;
}

export const PIPE_PREFIX = "bumimang-board";

/** 一次性令牌：主进程生成 → 写入 agent 的 mcpServers env → 子进程回连时校验。 */
export function makePipeName(runId: string): string {
  // Windows 命名管道路径
  return `\\\\.\\pipe\\${PIPE_PREFIX}-${runId}`;
}
