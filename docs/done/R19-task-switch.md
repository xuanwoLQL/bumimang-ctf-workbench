# R19 · 任务切换（task.switch）

**日期**：2026-10-20 · **范围**：`packages/shared-protocol/events.ts`、`src/main/blackboard/board.ts`、`src/main/hub/hub.ts`、`src/renderer/{store,task,main}.ts`、`src/renderer/mock/*`、`src/cli/verify-history.ts`

## 做了什么

R17 把任务数据都落库、也把会话/审批/黑板全部按任务隔离了，但**没有入口把界面切回旧任务**——R17 自己写的边界是「当前 UI 没有『切换回旧任务』的入口；这是下一步（task.select）的活」。本轮把这个「下一步」做掉：

1. **契约加两样**：`HubSnapshot.tasks`（全部任务，创建时间倒序）+ `HubAction.task.switch`。`task` 字段仍保留为「当前任务」，向后兼容。
2. **主进程**：`board.listTasks()` 列出全部任务；`Hub.snapshot()` 带上 `tasks`；新增 `task.switch`，切换前先收尾当前任务的活会话（这段逻辑从 `task.create` 里抽出成 `settleCurrentTask()`，两处共用），切过去后重扫该任务的历史 flag 候选（候选只存内存，不重扫就会一直是 null）。
3. **切换后会话列表不空**：启动时只恢复了当前任务的会话进内存，其它任务的会话在库里但不在内存里。若切换后直接列会话会是空列表——把 `SessionManager.restoreSessions` 拆出 `loadTaskSessions(taskId)`（只载入、不跑全局 stale 恢复），`task.switch` 调用它。不能复用 `restoreSessions`：它会再跑一遍 `recoverStaleSessions`，把刚被 `settleCurrentTask` 停掉、退出回调还没落库的会话误判成「上一进程遗留」，写出虚假的 incident 死路。
4. **渲染层**：`store` 增加 `tasks`（快照/事件都折叠进去）；任务卡头部有多个任务时出现「切换」按钮 → 弹列表，点一个派发 `task.switch`。切换后 `task.upsert` 的 id 变化触发整份重拉快照（R17 已就位），列表与任务卡都自动更新。
5. **mock 同步**：mock 快照带第二个任务、mock 引擎实现 `task.switch`，无真实主进程时 UI 也能演示切换。

## 改了哪些文件

- `packages/shared-protocol/events.ts`：`HubSnapshot.tasks` + `task.switch`
- `src/main/blackboard/board.ts`：`listTasks()`
- `src/main/hub/hub.ts`：`listTaskViews()`、`settleCurrentTask()`、`task.switch` 分支、快照带 `tasks`
- `src/main/session/manager.ts`：`restoreSessions` 拆出 `loadTaskSessions()`
- `src/renderer/store.ts`：`AppState.tasks` + `applySnapshot`/`applyEvent` 折叠
- `src/renderer/task.ts`：`openTaskSwitchModal()` + `openTaskStatusModal` 补「标记已放弃」按钮
- `src/renderer/main.ts`：「切换」按钮 + blocked 会话卡 title「同一规则」→「同一动作」（对齐 L-4b 内容签名）
- `src/renderer/mock/data.ts`、`mock/engine.ts`：mock 快照与 `task.switch`
- `src/renderer/styles.css`：切换列表样式
- `src/cli/verify-history.ts`：+6 条断言

## 怎么验证的

```powershell
node apps/desktop/src/cli/verify-history.ts   # 54/54（新增 6 条：listTasks / 快照 tasks / 切换成功 / 切换后任务变了 / 切不存在任务被拒 / 切换后旧任务会话载入内存）
node apps/desktop/src/renderer/smoke.ts       # ALL PASS（含 mock task.switch 3 条）
npm run verify:all                            # 49+16+17+19+54+94 = 249 条 + smoke，exit=0，0 FAIL
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
                                              # 19/19（真实 IPC 通道 + 三栏 + 任务卡，快照新增 tasks 字段不破坏既有断言）
```

## 没做什么 / 已知问题

- **flag 候选只对「当前 + 扫描过的」任务有值**：候选存内存、`recoverTaskSignals` 只在启动时扫当前任务、`task.switch` 切过去时补扫一次；没切换过的旧任务在 `tasks` 列表里 flagCandidate 是 null。要全量恢复需在启动时扫所有任务，本轮没做（切换时补扫已够用）。
- **`tasks` 列表不做分页/搜索**：任务量级远达不到需要，倒序全量返回即可。
- **删除/归档任务仍没有**（沿用既有边界）：`task.switch` 只做「切」，不提供「删任务」。

## 下一手需要什么

无阻塞项。若要「删任务」「任务改名/改简报」再单开一轮。
