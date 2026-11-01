# D-multitask-focus · 切题只切焦点，不停会话（P1-B）

- 日期：2026-10-23
- 状态：P1-B 已实施；P1-C/P1-D/P1-E 继续沿用
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP1；`docs/done/P1-B.md`

## 背景

P1-A 之后仍是单活动任务：`hub.ts` 只有一个 `taskId`，`task.create` / `task.switch` 会调用 `settleCurrentTask()` 停掉旧任务所有非终态会话；`session.start` 拒绝非当前任务。CTF 是广度优先，这个模型会把“切去看另一题”变成“放弃当前题的所有 agent”。

P1-B 的目标是 **N 个任务同时活跃**：切题只切 UI 焦点，后台会话继续跑、继续写 `stream.jsonl`、继续计数；重启恢复全部活跃任务留 P1-D。

## 决策

1. `HubService` 的单 `taskId` 改为 `focusedTaskId`；`currentTaskId` getter 仍返回焦点，兼容旧调用方。
2. `task.create` / `task.switch` / 新 `task.focus` 不再停会话；`task.switch` 与 `task.focus` 等价，保留旧名字做兼容。
3. 只有显式 `task.stopAll` 才停止某任务的**非终态**会话；不归档、不改任务状态。`task.archive` P1-B 只做占位校验（有活会话且 `force!==true` 拒绝），真正归档留 P1-D。
4. 快照保持向后兼容：
   - `task` = 焦点任务；
   - `tasks` = 全部任务（含 `archived: boolean`、category/priority/counts/updatedAt）；
   - `sessions` / `approvals` / `board` / `health` = 焦点任务；
   - 新增 `approvalsAll` = 全部审批（每条带 `taskTitle`）；
   - 新增 `quota` = 上限 + 当前全局非终态会话数（P1-B 只展示，不执行）。
5. 主进程不再替渲染层过滤后台会话事件：`session.upsert` / `session.stream` / `health` 带 `taskId` 继续推；渲染层 store 丢弃非焦点事件。`approval.upsert` P1-B 仍只推焦点（全局审批视图留 P1-E）。
6. `session.start` / `session.prompt` / `session.stop` / `session.interrupt` P1-B **仍只允许焦点任务**；P1-C 才放开任意任务起会话。
7. 按任务收敛不新增：P1-B 只保留焦点任务原有的 R24 行为；后台候选不触发收敛（P1-C 再做）。

## 备选方案与取舍

- **保留 `settleCurrentTask`**：实现最小，但直接违反 WP1 目标；否决。
- **把 `sessions` 直接改成全量**：渲染层一次要接 8 个会话的流，P1-B 没任务看板，容易把界面打爆；否决。保留焦点快照 + 后台事件丢弃，P1-E 再做懒加载看板。
- **Hub 继续过滤后台事件**：无法验证“事件带 taskId、UI 丢非焦点事件”，也不利于 P1-E 的懒加载；改为带 taskId 推送 + store 丢弃。
- **P1-B 就做配额执行**：用户明确留到 P1-C；本次只填 `quota` 真实值，不拦截第 4 个会话。

## 影响

- **行为变更**：切题不再停会话；显式停止用 `task.stopAll`。旧 `verify-r18.ts` A 组、`verify-hardening.ts` §6 的断言语义已改写（未删测试）。
- 旧渲染层只读 `task/sessions/approvals` 时仍是焦点语义，不会白屏；新增字段全部可选。
- 后台会话在 P1-B 的 UI 中不可见（没有任务看板），其流/健康/状态事件被 store 丢弃；这是已知中间状态，P1-E 补看板。
- `session.start` 仍不能在后台任务起会话；想给后台加会话要等 P1-C。
- 主进程内存仍保留所有会话的最近历史（每会话上限 2000 条）；P1-B 只保证渲染层不建后台 DOM，真实长跑内存由 P1-D/WP6 soak 观测。

## 后续

- P1-C：`session.start` 任意任务、配额执行、按任务收敛。
- P1-D：启动恢复全部任务、归档真正落库/看板过滤、按任务 stale lease/intent。
- P1-E：任务看板、后台指标、全局审批视图、配额显示。

---

## P1-C/D/E 行为变更追加（2026-10-23）

> 本节只追加，不重写上文。上文记录的是 P1-B 的决策；P1-C/D/E 在此沿用并扩展，三处行为变更单独留痕。

### P1-C · 任意非归档任务起会话 + 配额 + 按任务收敛

**决策**

1. `session.start` / `session.prompt` 从“只允许焦点任务”放宽为“任意存在且未归档的任务”。后台任务不再只是“活着但不可操作”。
2. 配额在 Hub 的 `session.start` 路径执行（启动进程之前），默认每任务 3、全局 8 个非终态会话；全局配额只统计非归档任务。超限返回可读错误且不 spawn。
3. 配额逻辑不放进 `SessionManager.startSession`：焦点/配额是应用层策略，Hub 同时持有配置、任务表和全局会话；`manager.ts` 保持 task-agnostic，CLI 直连路径不受影响。
4. R24 收敛改为按任务：`maybeStartConvergence(taskId, ...)` 只查该任务会话、只停该任务除首答者外的队友、只写该任务黑板 note；flag 候选内存结构改为 `Map<taskId, Map<flag, {by, at}>>`，快照只暴露焦点任务候选。
5. `session.stop` / `interrupt` / `remove` / `setTier` **仍只允许焦点任务**；后台停止走 `task.stopAll` 或收敛，避免一条陈旧 UI 消息误停后台任务。

**影响**

- **行为变更**：`session.start` / `session.prompt` 允许任意非归档任务；`verify-r18.ts` A 组两条断言按新语义改写（未删测试），延迟 prompt 计数 2 → 4；stop/interrupt 仍保留“旧任务被拒绝”的断言。
- 后台任务成功起会话/失败回滚只落库，不推 `task.upsert`（P1-B 的渲染层 store 对 `task.upsert` 没有 taskId 过滤，推后台任务会覆盖焦点）；后台实时看板由 P1-E 补。
- 配额检查是“先查后启动”，不是原子预留；单主进程串行 dispatch 下成立，极端并发 dispatch 仍可能同时通过检查。

### P1-D · 启动恢复全部非归档任务 + 真实归档 + 按任务 stale 清理

**决策**

1. 启动流程从“只恢复最近任务”改为“恢复全部非归档任务”：先 `listActiveTasks()` 选焦点（当前取 `createdAt` 最新的非归档任务），全局 `recoverStaleSessions()` 只跑一次，再逐任务 `restoreSessions(taskId, {recover:false})`、按 `task_id` 释放 stale lease / 放弃 stale intent、逐任务重扫 flag 候选。
2. `board.archiveTask()` 只做数据库层：即使 `force=true`，只要还有非终态会话就返回 `requiresStop`，不杀进程、不制造“已归档但会话在跑”的脏状态；停会话由 Hub 负责，然后重试归档。
3. `task.archive` 真实落库：有活跃会话且没有 `force` 时拒绝（文案含标题/会话数/force）；`force` 先停该任务非终态会话、等状态落库（上限 2s）再归档；归档只写 `archived=1`，不删 facts/sessions；归档后不能再起会话、不能成为焦点；焦点被归档时回退到最新非归档任务（没有则 `null`）。
4. 归档广播 `task.upsert(archived=true)`；因为渲染层 `task.upsert` 没有 taskId 过滤，归档焦点任务后必须再推新焦点，归档非焦点任务后重推当前焦点，避免 store 的 `task` 被归档任务覆盖。
5. 启动恢复编排放在 `electron/main.ts`，按 1–6 步显式执行；`SessionManager.restoreSessions` 只加可选 `{recover:false}`，默认参数保持旧调用方行为不变。

**影响**

- **行为变更**：重启恢复全部非归档任务与非终态会话；归档从占位变为真实语义。
- 逐任务 `releaseStaleLeases` / `abandonStaleIntents` 按 `task_id` 过滤；A 的租约/意图不会在 B 的恢复里被清掉。stale 定义是“已过期，或持有者/领取者不是本进程的活跃会话”；运行中会话持有的未过期租约不会被误放。
- “上次焦点”尚未持久化；当前按最新非归档任务选焦点，接口已支持 `hub.setTask(null)`。
- `MAX_RESTORE=20` 保持原值；启动恢复会全局扫一遍所有会话（含归档历史）并把非终态标 stopped，但只把非归档任务载入内存。
- `force` 归档等待上限 2s；超时返回可读错误且不归档，不留下脏状态。真实 agent 杀不掉的故障路径未注入验证。

### P1-E · 渲染层多任务看板 + 全局审批 + 后台不建 DOM

**决策**

1. 左栏新增任务看板：全部任务（含 archived）常驻，焦点高亮，每题显示 category、状态、`running/total`、flag 候选、后台在跑数；归档默认折叠、可展开看历史；顶部显示全局配额与焦点任务每任务配额。
2. 焦点切换时 store 用新快照替换焦点 `sessions/approvals/board/health`，panes 卸载旧窗格并按新焦点懒加载历史；后台事件只更新 `tasks` 计数，不进焦点列表、不建 DOM。焦点 pane 上限 3（活跃优先，终态最近补足）。
3. 右栏审批队列改为读 `approvalsAll`，默认「只看当前任务」，可切「查看全部任务」；每条显示 taskId + taskTitle；批量放行只对当前过滤结果的 id 发 `approval.bulk`；`permission.grantAll scope=all` 默认只作用于焦点任务，`global` 仍是显式全局操作。
4. 全部归档时焦点为 `null`：store 清空焦点会话/审批/黑板/健康，panes 卸载，左栏显示「无活跃任务」，不崩；归档任务仍折叠在看板里可展开查看历史。
5. `task.upsert` 的渲染层处理：非归档事件切焦点；归档事件只更新看板，若归档的是当前焦点则立即清空焦点缓存；真正的 sessions/approvals/board 由随后重拉的快照权威替换，避免旧任务会话短暂串到新焦点。

**替代方案与取舍**

- **归档任务全隐藏**：会让“历史仍可查”只能靠切换弹窗；改为默认折叠、可展开，`tasks` 始终含 `archived:true`。
- **把所有会话都建 pane**：8 会话会把渲染进程打爆；改为焦点最多 3 个 pane、后台不建 DOM，完整流切焦点后懒加载。
- **批量放行按全局视图直接放**：存在跨任务误放风险；改为只发当前过滤结果 id，默认过滤焦点任务。
- **后台 `approval.upsert` 改为主进程全量推**：会扩大主进程事件量、影响旧渲染层；P1-E 先用“后台进入 `waiting_approval` 时重拉快照”兜底，把全量推送留给后续。

**影响**

- **行为变更**：渲染层从「单任务视图」变为「多任务看板 + 焦点视图」；后台会话不进 DOM；全局审批视图上线；全部归档焦点为 `null`。
- **已知限制**：`permission.grantAll.taskId` 契约字段已加，Hub 未实现跨任务授权；后台 `approval.upsert` 仍只推焦点，renderer 靠重拉快照绕过，极端情况下最迟等下一次快照/切焦点；`session.stop` / `interrupt` / `remove` / `setTier` 仍只允许焦点；`approvalsAll` 可能保留归档任务的历史审批（UI 按 archived 过滤，不会误放）。
- `CONV_WINDOW=120`、`MAX_BLOCKS=500` 未改；mock 配额是 4/8、每任务 2/3，不是全局近满状态。
- 旧快照兼容：缺 `approvalsAll` 回退 `approvals`，缺 `quota` 显示“配额 —”，缺 counts 时焦点任务用当前 sessions 现算、其他任务退化为 0；不会崩。
