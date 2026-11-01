# M1 会话管理器 + 简报包 + 黑板

## 做了什么

把"多个 agent 并行解同一道题、共用一块黑板"的最小闭环打通了：起会话 → 注入简报包 → agent 通过 MCP 工具读写黑板 → 崩溃时清理租约与意图。

几个关键取舍：

- **手写 ACP JSON-RPC，没套 SDK 封装。** SDK 的 `ClientSideConnection` 已标记 deprecated，而 client 侧要实现的正是 `fs/*`、`terminal/*`、`session/request_permission` 这三类反向调用——那正是架构里的 L2 咽喉本身，必须完全可控，也需要每条消息可留痕。
- **用 Node 内置 `node:sqlite` 而不是 `better-sqlite3`。** 省掉原生编译，队友机器不需要构建工具链，这比原计划更符合 C8"开箱可用"。
- **黑板写入串行化到主进程的一条队列上。** MCP 子进程只读 + 提交，落库全由主进程做，避免多个 agent 各开一个连接撞 SQLite 写锁。
- **MCP 子进程是"薄转发器"**：不含数据库、不含业务逻辑，只有管道转发，所以崩溃面接近零——这是"崩了就换会话"这个代价能成立的前提。

## 改了哪些文件

```
package.json
.gitignore
apps/desktop/src/main/blackboard/board.ts     黑板：SQLite WAL、三写一事务、哈希链
apps/desktop/src/main/acp/client.ts           ACP v1 客户端（L2 咽喉）
apps/desktop/src/main/mcp-host/protocol.ts    主进程↔MCP 子进程的私有 RPC
apps/desktop/src/main/mcp-host/bridge.ts      命名管道服务 + 一次性令牌校验
apps/desktop/src/main/mcp-host/server.ts      MCP stdio 子进程（工具面，名字冻结）
apps/desktop/src/main/policy/policy.ts        策略引擎（M1 为 passthrough 占位）
apps/desktop/src/main/discovery/detect.ts     agent 检测（C3：只检测不安装）
apps/desktop/src/main/briefing/build.ts       简报包构造与渲染
apps/desktop/src/main/session/manager.ts      会话管理、扇出、崩溃清理
apps/desktop/src/cli/m1.ts                    M1 验收驱动
apps/desktop/src/cli/probe.ts                 ACP 适配器探针（填 ARCHITECTURE §16.2）
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run m1
```

结果：**7/7 通过**

```
PASS  断言 1  dead_ends 表新增 1 行，description 包含 "/admin"
      └─ id=de-72d1e0ef desc="/admin 弱口令不可用，已试 20 个常见口令（admin/admin、root/123456 等）"
PASS  断言 2  会话2 的首条 prompt 文本里包含该 dead_end 的 description 字符串
PASS  断言 3  会话2 的简报包 JSON 中 do_not 数组包含该字符串
      └─ do_not = ["不要重复尝试：/admin 弱口令不可用，已试 20 个常见口令（admin/admin、root/123456 等）"]
PASS  断言 4  leases 表出现该行，holder = 会话2
      └─ resource=target:127.0.0.1 holder=s2
PASS  断言 5  会话2 在收到简报包后，至少主动调用过一次 blackboard_read_since
      └─ boardReads=3 toolCalls=150 syncLag=2
PASS  断言 6  该会话持有的 lease 立即释放；intent 转为 abandoned
      └─ 释放前 1 个 → 释放后 0 个
PASS  断言 7  会话3 的 do_not 清单包含"上一会话崩溃"记录
      └─ 命中：不要重复尝试：上一会话（s2）崩溃退出（code=null signal=SIGTERM）...
```

落盘工件校验（`.m1/board.db`）：

```
counts: {"events":23,"deadEnds":2,"leases":0,"facts":2,"intents":0}
audit rows: [{"c":26}]
events: 23   hash chain: OK
audit by action: session.status 12 / session.acp_bound 3 / session.create 3 /
                 deadend.declare 2 / fact.submit 2 / lease.acquire 2 / lease.release 1
```

`npm run probe`（适配器探针）实测 opencode：

```
protocolVersion = 1        loadSession = true
sessionCapabilities = { close, fork, list, resume }
[smoke] 默认模型 = deepseek/deepseek-flash，stopReason = end_turn
```

## 没做什么 / 已知问题

1. **策略引擎是 passthrough 占位**，全部放行，只留痕。真正的规则引擎是 M3。
2. **审批队列不存在。** agent 发来的 `session/request_permission` 被自动挑一个"允许"项放行，人工完全没参与。这是 M3/T4。
3. **只有 opencode 一家参与了验证。** codex / claude / dsh 的 ACP 适配器本机未安装，C3 规定程序不得代装，所以只验证了检测路径（灰显 + 安装提示）。
4. **拒绝路径完全没测。** passthrough 不会拒绝，所以 §9.6 的退避计数、`blocked` 状态都没跑过。
5. **多会话并行没测。** 按最保守的"一进程一会话"实现，四家的实际并行能力待 §16.2 实测。
6. **M1 的 prompt 是指令式的**，明确指定 agent 调哪个工具。这验证的是通路，不是"agent 有多自觉"。执行纪律（每 3 个 tool call 读一次黑板）留到 M4。
7. `toolCalls=150` 是修 bug 前的数字：当时把 `tool_call_update` 也数进去了，已改为只数 `tool_call`。**修完之后的真实数字还没有重新测过。**
8. 策略判定只进了内存日志，**没有写进审计表**。§10 要求"审计记发生了什么（含放行/拒绝决策）"，这条还没落地。

## 下一手需要什么

- **T2 事件总线**：把已有的会话/黑板/审批事件推给渲染进程，按 `packages/shared-protocol/events.ts` 的契约。
- **T3/T4 是雏形的关键路径**：没有真审批，UI 上的审批队列就是空壳。
- 需要用户决策的事项（若发生）记在 `docs/BLOCKED.md`：是否安装 codex/claude 的 ACP 适配器。
