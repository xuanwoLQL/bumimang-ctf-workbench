# R9 黑板台账「钱截图」：真实 claude 经冻结契约把一条死路写进共享黑板，端到端

> 完成时间：2026-10-13 03:20 · Lane B（renderer + electron）
> 结论：**24/24 ALL_PASS。真实 claude（guarded 档）经冻结契约起会话，用 `blackboard_declare_dead_end` 写了一条真实死路到共享黑板，台账面板第一次显示出由真实 agent 生产的内容。截图 `docs/logs/real-board.png`。**

## 一句话

接 [L3-blackboard-reachable-by-real-agent](./L3-blackboard-reachable-by-real-agent.md)（Lane A 修好 MCP 子进程用 `ELECTRON_RUN_AS_NODE=1` 起得来，但只验了**读**），本轮把**写**路径在真实窗口里、经冻结契约、零种数据完整跑通，产出黑板核心差异点的第一张真实视觉证据。

## 完整链路（全部经冻结契约 `window.bumimang`，未用任何新 API）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | `dispatch {type:"session.start", taskId, agent:"claude", role:"lead", tier:"guarded"}` | `{ok:true}`，spawn `claude-agent-acp` v0.89.1，protocolVersion=1 |
| 2 | 等会话 idle（简报轮里 claude 主动读/写黑板，逐条放行其真实审批） | idle。**claude 主动调了 `declare_dead_end` + `submit_fact`（见下「更大发现」）** |
| 3 | `dispatch {type:"session.prompt", sessionId, text:"用 blackboard_declare_dead_end 写 /admin…（含标记 BM-VERIFY-9）"}` | `{ok:true}` |
| 4 | 轮询 `snapshot.board.deadEnds` 等本轮新条目 | **31.9s 后出现**：`/admin 后台弱口令爆破不可用（已试 top20 常见口令，均被拒绝；BM-VERIFY-9）` |
| 5 | 触发一次与 dispatch 路径相同的 `publishBoardSince(0)`，等台账 DOM 重拉快照 | 310ms 后画出来 |
| 6 | 截图 + 断言内容/来源 | `docs/logs/real-board.png`（275295 bytes，1783×942），台账非空 |

## 五层证据，全部指向「真实 agent 写入」

不靠我嘴说，靠线日志和落库行说：

1. **快照层**：`snapshot.board.deadEnds` 新增 1 条，`description` 含唯一标记 `BM-VERIFY-9` + `/admin`，`scope="http"`，`by="s1"`（= agent 会话 id），`createdAt` 在本轮 prompt 之后。
2. **台账 DOM 层**：真实窗口里 `.board-list.deadends` 画出 2 条死路，`死路 · 2`；空状态横幅消失；`.deadend-desc` 含标记、`.deadend-by` = `by s1`。
3. **wire 层**：`wire.jsonl` 里 12 行匹配 `blackboard_declare_dead_end` 的 tool_call（agent → 主进程的原始 ACP 流），标记串出现 5 行（参数原样到达主进程）。
4. **audit 层**：`audit` 表 `deadend.declare` 行 `actor="s1"`（落库者非人类/非夹具）。
5. **events 层**：`events` 表追加 `kind="deadend"` 事件（哈希链随之增长）。

## 更大发现：简报纪律让 claude **没等我提示就主动写**

两次运行里，claude 在**简报轮**（读完 `renderBriefingPrompt` 的「确认某条路走不通 → 调 blackboard_declare_dead_end」「确认一条事实 → 调 blackboard_submit_fact」）就主动动手了。第二次运行的简报轮它做了 5 件事：

```
mcp__blackboard__blackboard_read_since        读黑板
mcp__blackboard__blackboard_declare_dead_end  写死路「【验收演示-写路径验证】lead 经 MCP 写入的演示死路…无真实结论」（scope=demo）
mcp__blackboard__blackboard_submit_fact       写事实「【验收演示】lead 已成功通过 blackboard_declare_dead_end 写入死路条目 de-2df11556；MCP 写路径可用」（witness=该死路 id）
mcp__blackboard__blackboard_query_view        查视图（回读自己刚写的死路）
mcp__blackboard__blackboard_read_since        再读黑板
```

这正是 §7.4 / §5.1 那套「把纪律写进工具 description + 简报包」的设计第一次在**写类工具**上被验证有效——agent 不仅会读，还会**主动写、主动自证（带 witness）**。比 Lane A 在 L-3 只验到的「读」更强一档。

## 诚实声明：本轮自动放行了 6 条真实审批

guarded 档下 claude 的每一个 `mcp__blackboard__*` 工具调用都发了 `session/request_permission`（命中规则 `tier-guarded-default` → 转人工）。本验收脚本像真人一样 `approval.decide approve` 放行，**全部如实记录**（见 `docs/logs/real-board.json` 的 `autoApproved`）：

```
[briefing]      read_since / declare_dead_end / submit_fact / query_view / read_since（5 条）
[dead-end-turn] declare_dead_end（1 条）
```

这 6 条是 claude 真实发来的，放行 ≠ 种数据；不放行会话会永远卡在等审批上。

## 给 Lane A 的两个观测（不阻塞、不改）

1. **guarded 档会 gate 每一个黑板工具调用。** `mcp__blackboard__*` 无规则命中 → 受控档兜底转人工，于是「每 3 个工具调用读一次黑板」这条纪律在 guarded 档下会变成**每读一次黑板就打断一次人工**。黑板同步本应是低摩擦的，这里可能需要在规则包 `rules/competition.json` 里给 `mcp__blackboard__*` 加一条 allow（或把黑板工具视为一等公民）。这是策略数据问题，我不动（不在我的 lane）。
2. **MCP 写不推 `board.appended`。** 生产 `main.ts` 里只有 `dispatch` 路径会调 `publishBoardSince(0)`；agent 经 MCP 写黑板时没有任何事件推给渲染进程，台账要等下一次 dispatch 才会刷新。本验收里我用的是与 dispatch 完全相同的 `hub.publishBoardSince(0)` 触发刷新（数据是 agent 真写的，我只是推了一版事件），不是种数据。建议 Lane A 在桥接层给「写」也挂一个 publish 钩子（`BoardBridge` 目前只有 `log`/`onBoardRead` 两个观测口，没有 onWrite）。

## 改了哪些文件

```
apps/desktop/electron/real-board-verify.ts   新：真实 claude 写黑板端到端验收入口（只 import src/main，不改）
```

没动 `apps/desktop/src/renderer`、没动 `apps/desktop/src/main`、没动冻结契约 `events.ts`。没有种任何黑板条目、没有 fake agent。

## 怎么复跑

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/real-board-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|step|real-board|ALL_PASS"
```

## 没做什么 / 边界

1. 只验了 `declare_dead_end`（本轮我要求的）+ 简报轮 claude 自发的 `submit_fact`。`acquire_lease` / `open_intent` 在真实 claude 上仍未验。
2. 只测了 claude（同 L-3 的边界）。
3. 唯一标记 `BM-VERIFY-9` 是固定串（工作区每次清空，无碰撞问题）；若要多轮并跑，换成随机串即可。
4. 截图文件本环境无法直接预览，但 DOM 探针（跑在真实渲染进程里）已程序化确认台账内容与五层证据一致；PNG 275KB@1783×942 与 R8 的钱截图同量级，非空白窗口。
