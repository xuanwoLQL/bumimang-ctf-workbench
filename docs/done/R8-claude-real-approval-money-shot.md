# 第 8 轮 ·「钱截图」：真实 claude 在真实窗口里触发一次真实审批，端到端

> 完成时间：2026-10-13 02:56 · Lane B（renderer + electron）
> 结论：**端到端跑通，23/23 ALL_PASS。claude 真的问了，审批面板真的出现，人工放行后 demo.txt 真的落地。**

## 一句话

接 [GATE-INPUT-STARVED](./GATE-INPUT-STARVED.md) 末节的发现（三家 agent 只有 claude 写文件时会发
`session/request_permission`），本轮把「起 claude 会话 → 让它写文件 → 它问 → 面板出现 → 人工放行 → 文件落地」
这条链**在真实窗口里、经冻结契约、零种审批**完整跑了一遍。截图就是那张钱截图：
`docs/logs/real-approval.png`。

## 完整链路（全部经冻结契约 `window.bumimang`，没有用任何新 API）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | `dispatch {type:"session.start", taskId, agent:"claude", role:"lead", tier:"guarded"}` | `{ok:true}`，spawn 真实 `claude-agent-acp` v0.89.1，握手 protocolVersion=1 |
| 2 | 等会话 idle（含自动注入的简报轮） | idle。**简报轮里 claude 就发来 11 条真实审批**（见下「额外发现」），像真人一样逐条放行后才 idle |
| 3 | `dispatch {type:"session.prompt", sessionId, text:"请在当前目录创建 demo.txt…"}` | `{ok:true}` |
| 4 | 轮询 `snapshot.approvals` 等 pending | **2.9s 后出现**：`Write demo.txt`（claude 写文件前真问） |
| 5 | 截图 + 断言卡片三栏 | `docs/logs/real-approval.png`（294820 bytes，1783×942） |
| 6 | `dispatch {type:"approval.decide", decision:"approve"}` | pending 消失 → 会话回 idle → `demo.txt` 落地，内容 `"hello\n"` |

## 钱截图里到底有什么（逐字段背书）

审批卡片（`.ap-card.ap-pending`）在真实窗口里画出来的内容：

- **action**：`session/request_permission`（唯一事前闸门动作）
- **左栏 command**：`Write demo.txt`（claude 的真实工具标题）
- **左栏 target**：`目标：—`（见下「已知问题」第 1 条——claude 其实给了路径，但队列没取到）
- **中栏 intentSummary**：`absolute path .`（claude 工具调用前的真实自述分片，非空）
- **右栏 rule**：`命中规则：tier-guarded-default`（guarded 档兜底转人工，正是「受控档」语义）
- **右栏 risk**：`风险：中`
- 待批按钮：放行 / 放行并记住 / 拒绝 都在

## 硬证据（不是我说，是线日志和产物说）

1. **wire.jsonl 里 12 条真实 `session/request_permission`**（claude → 主进程，非种入）。最后一条是钱截图那条：

   ```json
   {"toolCall":{"name":"Write","title":"Write demo.txt","kind":"edit",
     "rawInput":{"file_path":"D:\\agent\\xuanwo\\.ui-run\\verify-real-approval\\sessions\\s1\\demo.txt",
                 "content":"hello\n"}}}
   ```

2. **demo.txt 真的落地**：`.ui-run/verify-real-approval/sessions/s1/demo.txt`，内容正是 `hello\n`。
3. **放行闭环**：`approval.decide approve` → 队列返回 `approved` → 快照 pending 消失 → 审批面板「最近已决」显示「已放行」→ 会话回 idle。
4. 完整断言 + 时间线 + 线证据在 `docs/logs/real-approval.json`。

## 怎么复跑

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/real-approval-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|step|ALL_PASS"
```

## 改了哪些文件

```
apps/desktop/electron/real-approval-verify.ts   新：真实 claude 审批端到端验收入口（只 import src/main，不改）
```

没动 `apps/desktop/src/renderer`、没动 `apps/desktop/src/main`、没动冻结契约 `events.ts`。没有种任何审批、没有 fake agent。

## 额外发现（这轮比「钱截图」本身更值钱）

### 1. claude 不止写文件会问 —— 跑 shell 也会问（推翻单次测量的旧结论）

[GATE-INPUT-STARVED](./GATE-INPUT-STARVED.md) 末节说「claude 跑命令时 request_permission=0」。**本轮实测否掉了这条**：简报轮里 claude 为了找黑板，连续发来 11 条真实审批，全部是 shell / 读文件类：

`ls -la`、`Read server.ts`、`powershell 枚举命名管道`、`cmd dir \\.\pipe\`、`grep`、`Read manager.ts/bridge.ts`、`ls //./pipe/` ……

所以旧结论「claude 只在写文件时问」是**样本量 1 的误判**（那次测的是无害的 `echo gate-test`，claude 不问；一旦它要做实质动作——探索/读敏感文件/调试——就一条不落地问）。闸门从 claude 拿到的真实输入比我们以为的多得多。

### 2. 黑板 MCP 对真实 agent 不可达（claude 花了一整轮简报去 debug 它）—— 已追加 BLOCKED L-3

简报轮的 11 条审批，全是 claude 在**试图连接黑板 MCP 失败后自己逆向排障**：找 `bumimang`/`board` 命名管道、读 `mcp-host/server.ts`、读 `session/manager.ts (120-189)`（正是拼 mcpEntry 的那段）、手动拼 env 变量试探着 spawn 服务器。

嫌疑点：`apps/desktop/src/main/session/manager.ts` 里 mcpEntry 的 `command: process.execPath` —— 在 Electron 主进程里它等于 **electron.exe**，用它去当 stdio MCP 服务器启动 `mcp-host/server.ts`，很可能起不来（或起在错误形态）。**这是 Lane A 的 lane，我没动。** 细节已追加到 `docs/BLOCKED.md`（L-3），指向本文。

> 对钱截图的影响：无。demo.txt 由 claude 自己的 Write 工具直接写，不依赖黑板 MCP。但「共享黑板」这个卖点对真实 agent 目前是断的。

### 3. 审批卡片的 target 取不到 claude 给的路径（小改进机会）

claude 的权限请求把目标路径放在 `rawInput.file_path` 里（见上面 wire 证据），但 Lane A 的
`approval/queue.ts` 的 `targetOf()` 只看顶层 `detail.path / detail.target / detail.cwd`，所以卡片显示
「目标：—」。**接线没错，只是没挖 `rawInput.file_path`**。给 Lane A 的一个可选改进（不改也不阻塞）。

### 4. intentSummary 是「真实但碎片」

中栏显示 `absolute path .`——机制正确（取该会话最近 3 段流式自述文本拼起来），但 claude 的
agent_message 流是按小分片来的，最后 3 片拼出来可读性一般。这也是 Lane A 的 `hub.intentSummary`
行为，我如实记录，不美化。

## 没做什么 / 边界

1. 没修黑板 MCP（Lane A 的 lane，见 BLOCKED L-3）。
2. 没动审批卡片的 target 提取、没动 intentSummary 聚合——都记在上面留给 Lane A 决定。
3. 简报轮用了一个**中性任务简报**（"暂无具体目标"），目的只是让简报轮别再去探索文件系统、把
   写入动作留给 `session.prompt`；这不是种审批——简报轮的 11 条审批依然全部是 claude 真实发来的。
4. 每次运行独立工作区 `.ui-run/verify-real-approval` + 独立 userData，不污染 Lane A 的 `.ui-run/board.db`。
