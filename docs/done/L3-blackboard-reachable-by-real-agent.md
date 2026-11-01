# L-3 修复：黑板对真实 agent 可达（并验证）

> 完成时间：2026-10-13 03:05

## 做了什么

Lane B 在第 8 轮跑真实 claude 端到端时发现：起会话后 claude 为了找黑板，连续发来 **11 条真实权限请求**（`ls`、读 `server.ts`、枚举命名管道、读 `manager.ts`/`bridge.ts`……）——它在**连不上黑板 MCP 之后自己逆向排障**。「共享黑板」这个卖点对真实 agent 是断的。

根因就在我这边的三行代码：

```ts
const mcpEntry = {
  name: "blackboard",
  command: process.execPath,   // ← 在 Electron 主进程里这是 electron.exe，不是 node
  args: [join(import.meta.dirname, "..", "mcp-host", "server.ts")],
  ...
};
```

MCP 子进程是**由 agent 去 spawn** 的（agent 才是 MCP 客户端），而我给的命令是 `electron.exe`。拿它去跑一个 `.ts` 脚本，它不会以 Node 形态执行，于是 MCP 服务器起不来，agent 侧连不上。

修法：给这个条目加环境变量 **`ELECTRON_RUN_AS_NODE=1`**，让同一个二进制以纯 Node 形态运行。这个选择比"去找系统 node"更好——**打包后不依赖队友机器上装没装 node**，符合 C8。

## 改了哪些文件

```
apps/desktop/src/main/session/manager.ts   mcpEntry.env 加 ELECTRON_RUN_AS_NODE=1（核心修复）
apps/desktop/src/main/mcp-host/bridge.ts   连接校验通过时打一条日志（便于观测）
apps/desktop/src/main/mcp-host/server.ts   hello 里带上 sessionId（日志可读性）
apps/desktop/src/cli/verify-mcp-live.ts    黑板可达性验收（真实 agent）（新）
package.json                               新增 npm run verify:mcp-live
```

## 怎么验证的

先单独确认 `ELECTRON_RUN_AS_NODE` 能让 electron 当 node 用：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
node_modules\electron\dist\electron.exe docs\logs\run-as-node-test.ts
# run-as-node OK, node version = 24.21.0 electron = 44.7.0
```

再用**真实 claude** 验黑板可达性：

```powershell
cd D:\agent\xuanwo
npm run verify:mcp-live
```

真实输出（**2/2 通过**）：

```
========== 黑板可达性（真实 claude）==========
管道：\\.\pipe\bumimang-board-6a62efcf
会话已起：s1 acpSession=4f0a2c19-db68-4deb-a0db-9c83882a18fa
注入简报包（内含黑板纪律）…
  [bridge] bridge: MCP 子进程已连上并校验通过（session=s1）
  [read] s1 读了黑板 after=3 返回 1 条
  [read] s1 读了黑板 after=4 返回 0 条
  [read] s1 读了黑板 after=4 返回 1 条
PASS  MCP 子进程真的起来了并连上命名管道（L-3 的核心）
PASS  agent 调用过黑板工具（工具面对它是可见可用的）  — onBoardRead 触发 3 次
========== 2/2 通过 ==========
```

**关键点**：这不是"我们模拟 agent 调工具"，而是真实 claude 在真实简报纪律下**主动调了 3 次** `blackboard_read_since`。§7.4 那套"把纪律写进工具 description + 简报包"的设计第一次在真实 agent 上被验证有效。

## 没做什么 / 已知问题

1. **只验了"读"**（`blackboard_read_since`）。写类工具（`submit_fact` / `declare_dead_end` / `acquire_lease`）在真实 agent 上还没验过——M1 时 opencode 主动调过 `submit_fact` 两次，claude 上未知。
2. **只测了 claude。** `verify:mcp-live -- --opencode` 可以对 opencode 跑同一套，但没跑。
3. **`ELECTRON_RUN_AS_NODE` 的作用域是子进程级**（通过 mcpServers 的 env 传），不会污染主进程，这点是对的；但它意味着**每个会话的 MCP 子进程都是一个新的 Node 实例**，进程数会随会话数线性增长（符合 §4.2 的设计，但资源占用要留意）。
4. **`verify:mcp-live` 会真的起 agent 并消耗 token**（一次约 20 秒）。不适合放进每次回归。
5. **Lane B 的 11 条排障请求暴露了另一件事**：当 agent 连不上依赖时，它会自己想办法——**而且每一条 shell 都要过审批**。也就是说"依赖不可达"会被放大成"一堆额外审批 + 一整轮时间浪费"。这类故障值得在主进程侧主动探测并提前告知 agent（例如简报里直接说明黑板不可用），而不是让它自己去撞。

## 下一手需要什么

- 补验写类黑板工具在真实 agent 上是否可用（尤其 `blackboard_submit_fact`，它带 witness 语义）。
- **`docs/HANDOVER.md`**：这条修复 + GATE-INPUT-STARVED 的三家对比，是交接里最重要的两段。
- 无待用户决策事项。
