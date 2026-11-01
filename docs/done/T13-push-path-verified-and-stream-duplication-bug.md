# T13 事件驱动 PUSH 路径验收 —— 抓到并修掉「陈旧 UI」真 bug

> 完成时间：2026-10-13 01:12 · Lane B · 第 5 轮

## 一句话结论

此前所有验收只覆盖「首屏快照」（first paint）。这一轮补上**事件驱动 PUSH 路径**：通过真实的
`hub:event` IPC 通道注入合成事件，断言 DOM 更新。结果 **16/16 通过**，并且**抓到两个会让界面
带病上线的真 bug**——其中一个正是「陈旧 UI」：`board.appended` 事件到达后，台账面板**从不更新**。

## 做了什么

### 1. 验证 PUSH 路径（六类事件全验）

写了 `apps/desktop/electron/push-verify.ts`：复用 preload（`window.bumimang`）+ 真实
`ipcRenderer` 通道，snapshot 处理器返回一份**受控合成快照**（形状对齐冻结契约 `HubSnapshot`），
增量事件用 `win.webContents.send("hub:event", ...)` 注入——**与真实主进程是同一条通道**。
这样每个事件类型都能确定性构造，不依赖活 agent。

首屏（first paint）之后，逐类注入并断言 DOM：

| 事件类型 | 注入后断言 |
| --- | --- |
| `task.upsert` | 左栏任务标题更新 |
| `session.upsert` | 左栏会话卡 + 中栏窗格出现 |
| `session.stream` | 窗格画出事件行（tool_call / agent_message） |
| `approval.upsert` | 审批卡片出现（动作 + 风险） |
| `health` | 窗格头部健康指标更新（同步 9 · tool 7，黄档） |
| `board.appended` | 重拉快照后事实/死路/意图/租约四类都画出来，且会话/审批不丢 |

### 2. 验证 session.stream 突发节流

真实后端单轮 prompt 约 150 条 `tool_call_update`。push-verify 里突发注入 **150 条**，断言：
- 窗格行数**不涨**（仍是 3 行重要事件，150 条全被折叠）；
- 窗格头部聚合计数变成「折叠 150 · 工具 2」。

顺带把聚合计数**做成了可见的**：窗格头部新增 `.pane-stream-meta`（「折叠 N · 工具 M」），
此前这个计数只存在 sink 内存里，UI 上看不见。

### 3. 策略规则包可见指示（含 BLOCKED 请求）

左栏顶部新增「规则包」徽标，读可选的 `snapshot.policy`（形状 `{ packId, name, fellBackToMinimal }`）。
契约 `HubSnapshot` 还没有这个字段（Lane A 的引擎只在启动时打印包名），所以：
- UI 槽位已就绪：字段缺席时显示「—」，带值则显示包名 + 「已回落最小安全集」；
- 请求已按规则 APPEND 到 `docs/BLOCKED.md`（R-1），请 Lane A 走 docs/requests/ 正式加字段。

## 抓到并修掉的两个真 bug

### Bug 1：`board.appended` 到达后，台账面板从不更新（陈旧 UI）

`store.ts` 的 `applyEvent` 对 `board.appended` 直接 `return state`，注释写着「MVP 阶段走重新拉快照」，
但**没有任何代码去重拉快照**。主进程每次 dispatch 后都会 `publishBoardSince(0)` 推 `board.appended`，
渲染进程却当它不存在——黑板上的新事实/死路/意图/租约在界面上永远看不到，只能靠重启窗口。

修法：`main.ts` 的 `hub.onEvent` 里给 `board.appended` 接一个「重新拉快照」分支（连续多条合并成一次，
避免刷屏）。这是注释原意的落地，不动 store 的纯逻辑。

### Bug 2：`session.stream` 每刷一次，整段日志重复追加一遍

`SessionStreamSink.onFlush` 回调拿到的是 `snapshot()`——里面 `lines` 是**累计**的全部行（最多 500），
不是本批增量。DOM 层 `appendBatch(body, log.lines)` 却把全部行原样追加。于是每 80ms 一刷，旧行就被
**再画一遍**：3 个重要事件刷两次变 4 行、刷三次变 6 行……事件一多行数按刷新次数翻倍，既丑又涨 DOM。

修法：`panes.ts` 里用 `renderedLines` 记住已画行数，每次 flush 只 `slice` 出新增行追加。修完
150 条突发后行数纹丝不动（3 行）。

两个 bug 都藏在「首屏之后」的路径里——首屏测试（快照 + 首屏渲染）永远看不到它们，正是这轮任务的靶子。

## 改了哪些文件

```
apps/desktop/src/renderer/main.ts         board.appended → 重拉快照；左栏「规则包」徽标（新）
apps/desktop/src/renderer/store.ts        AppState.policy + applySnapshot 读可选 snapshot.policy
apps/desktop/src/renderer/contract.ts     PolicyPackInfo（渲染进程本地类型，不改冻结契约）
apps/desktop/src/renderer/panes/panes.ts  修 Bug 2（增量追加）+ 窗格头部「折叠 N · 工具 M」可见计数
apps/desktop/src/renderer/styles.css      .policy-pack / .pane-stream-meta 样式
apps/desktop/electron/push-verify.ts      事件驱动 PUSH 路径验收脚本（新）
apps/desktop/electron/real-bridge-verify.ts  修时序 flake（见下）
docs/BLOCKED.md                           R-1：请 A 在 HubSnapshot 暴露策略包（APPEND）
```

未碰 `docs/ARCHITECTURE.md`、`apps/desktop/src/main`（Lane A）、`packages/shared-protocol/events.ts`（冻结）。

## 怎么验证的

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/push-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|verify\]"
```

真实输出 **16/16 ALL_PASS**，证据写入 `docs/logs/push-verify.json`，截图
`docs/logs/push-verify-{stream,board}.png`。关键断言摘录：

```
PASS  真实 ipcRenderer 通道 + 三栏 + 首屏在 12s 内就绪
PASS  task.upsert 推送后左栏任务标题更新
PASS  session.upsert 推送后左栏会话卡 + 中栏窗格出现
PASS  session.stream 推送后窗格画出事件行（tool_call / agent_message）  — lines=3
PASS  突发 150 条 tool_call_update 仍被折叠（行数不涨，还是 3 行）  — lines=3
PASS  窗格头部聚合计数更新为「折叠 150 · 工具 2」
PASS  approval.upsert 推送后审批卡片出现（动作 + 风险）
PASS  health 推送后窗格头部健康指标更新（同步 9 · tool 7，黄档）
PASS  board.appended 推送后重拉快照，事实画出来（2 条，含冲突并列）
PASS  board.appended 推送后死路 / 意图 / 租约都画出来
PASS  重拉快照后会话 / 审批 / 规则包仍在（全量一致，非破坏性）
```

回归：`node apps/desktop/src/renderer/smoke.ts` → **ALL PASS**（纯逻辑没被 store/panes 改动弄坏）。

### 顺手修掉 real-bridge-verify 的一个时序 flake

回归跑 `real-bridge-verify.ts` 时，断言 `intentSummary=null 显示「暂无自述意图」` 第一次 FAIL（count=0）、
重跑一次 ALL_PASS。查实：该断言拿**活 agent** 的 sessionId 当种子的 `sessionId`，而 `intentSummary`
的数据源是「该会话已流过的 agent 自述文本」——活 agent 何时产出自述文本不确定，所以这条断言
本身是时序 flake，与 T13 的渲染层改动无关（T13 只动 renderer，`intentSummary` 在主进程 `ApprovalQueue`
种入时算）。

修法：给「intentSummary=null」的两条种子换成一个从未流式输出的固定 sessionId（`s-no-recent-text`），
确定性拿到 null；command/target 为 null 的真实形状保留不变。修后该断言不再依赖 agent 时序。

## 没做什么 / 已知问题

1. **`session.stream` 的 500 行截断只截 sink，不截 DOM。** sink 里 `lines` 超过 500 会丢旧行，但
   已画进 DOM 的旧行不会回收，长会话下窗格 body 会无界增长。本轮没动（不属 PUSH 路径正确性问题），
   属后续性能项。
2. **push-verify 用受控合成快照，不是活 agent。** 「真实后端会产出哪些事件」这条链路由 Lane A 的
   `verify:gate-live`（假 agent 走真实 stdio）和 real-bridge-verify（真起会话）覆盖；本脚本专测
   「渲染进程对增量事件的 DOM 处理」，与它们互补。
3. **策略包徽标要等 A 走 docs/requests/ 加字段后才显示真名**，在此之前显示「—」（有意的诚实占位）。
4. **`board.appended` 重拉是全量快照替换。** 语义正确（快照是权威状态），但对高频黑板写入是 O(全量)；
   真正需要增量时应在契约里给 `board.appended` 带可折叠的四类视图增量（又一个 docs/requests/ 项）。

## 交接提示

- Lane A 若改了 `HubSnapshot`（加 `policy` 字段），渲染层**零改动**自动接上，无需再验 UI。
- `push-verify.ts` 是「渲染进程增量事件处理」的回归抓手：以后任何人在 store/panes/board 里改事件
  折叠逻辑，跑它一条命令就能验全六类事件 + 突发节流。
