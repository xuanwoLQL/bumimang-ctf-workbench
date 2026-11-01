# P1-D · 启动恢复全部非归档任务 + 真实归档 + 按任务 stale 清理

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP1；`docs/plans/COMPETITION-READINESS.md` §4.5/§4.9；`docs/done/P1-C.md`
> 日期：2026-10-23
> 状态：**P1-D 完成，等确认后进入 P1-E**。本轮没有跑真实 agent、没有烧 token、没有改 `docs/ARCHITECTURE.md`、没有删测试。

## 做了什么

启动流程从“只恢复最近任务”改为“恢复全部非归档任务”：先 `listActiveTasks()` 选焦点（当前取 createdAt 最新的非归档任务），全局 `recoverStaleSessions()` 只跑一次，再逐任务 `restoreSessions(taskId, {recover:false})`、按 `task_id` 清理 stale lease/intent、逐任务重扫 flag 候选。`task.archive` 从占位变成真实落库：有活跃会话且没有 `force` 时拒绝；`force` 时先停该任务全部非终态会话、等状态落库后归档；归档只写 `archived=1`，不删历史；焦点被归档时立即回退到最新非归档任务（没有则 `null`）。

**关键取舍**

- 启动恢复编排放在 `electron/main.ts`，按计划第 1–6 步显式执行；`SessionManager.restoreSessions` 只加了一个可选 `{recover:false}`，避免逐任务重复扫全表。默认参数保持旧调用方行为不变。
- `board.archiveTask()` 只做数据库层：即使 `force=true`，只要还有非终态会话就返回 `requiresStop`，不杀进程、不制造“已归档但会话在跑”的脏状态。停会话由 Hub 负责，然后重试归档。
- `releaseStaleLeases(taskId, now)` / `abandonStaleIntents(taskId)` 都按 `task_id` 过滤；stale 的定义是“已过期，或持有者/领取者不是本进程的活跃会话”。运行中会话持有的未过期租约不会被误放。
- 归档广播 `task.upsert(archived=true)`。因为 P1-B 的渲染层 store 对 `task.upsert` 没有 taskId 过滤，归档焦点任务后必须再推新焦点；归档非焦点任务后必须重推当前焦点，避免 store 的 `task` 被归档任务覆盖。
- `TaskView.tasks` / 快照本来就包含 archived 任务（P1-B 已有 `archived` 字段），本轮只保证数据和事件正确；看板如何折叠/隐藏由 P1-E 决定。

## 行为变更（第三个，单独记录）

1. **启动恢复从“只恢复最近任务”改为“恢复全部非归档任务与非终态会话”。**
   - 全局 `recoverStaleSessions()` 只执行一次；之后逐任务 `restoreSessions`（幂等，按会话 id 去重）。
   - 逐任务 `releaseStaleLeases` / `abandonStaleIntents` 按 `task_id` 清理，A 的租约/意图不会在 B 的恢复里被清掉。
   - 焦点选择：当前未持久化“上次焦点”，取 createdAt 最新的非归档任务；没有则 `null`。
2. **归档语义从占位变为真实。**
   - 有非终态会话且 `force!==true` → 返回可读错误（含任务标题与会话数），任务保持未归档、会话继续跑。
   - `force===true` → 先停该任务非终态会话，等状态落库后归档；`archiveTask` 本身只写 `archived=1`，不删 facts/sessions。force 停止会话时，租约按正常 session stop 流程释放（这是停止语义，不是归档删除）。
   - 归档任务仍出现在 `listTasks()` / 快照 `tasks` 中（`archived:true`），但不能再起会话、不能成为焦点。
   - 归档焦点任务后焦点立即回退到最新非归档任务；没有则 `null`，不崩。
3. 与 P1-B（切题不停会话）、P1-C（任意非归档任务起会话）并列：P1-B 解决“切走不停”，P1-C 解决“后台可操作”，P1-D 解决“重启后全部回来 + 归档可收口”。

## 改了哪些文件

源码：

- `apps/desktop/src/main/electron/main.ts`（**只改启动流程，不动 P1-C 的配额注入与审批守卫**）
  - `board.listTasks()` / `listActiveTasks()` 取全部非归档任务；
  - 焦点取最新非归档任务（无则 `null`）；
  - 首次运行（库中一个任务都没有）才种示例任务；只剩归档任务时不擅自新建；
  - 为每个非归档任务确保任务工作目录；
  - 构造 Bridge 时用 `focusTaskId ?? ""` 作为 fallback（会话仍由 `envForSession(sessionId, taskId)` 传自己的 taskId）；
  - `mgr.recoverStaleSessions()` 全局一次 → 逐任务 `mgr.restoreSessions(task.id, {recover:false})` → `b.releaseStaleLeases(task.id)` → `b.abandonStaleIntents(task.id)` → `hub.recoverTaskSignals(task.id)`；
  - `hub.setTask(focusTaskId)` 支持 `null`。
- `apps/desktop/src/main/blackboard/board.ts`
  - 新增 `listActiveTasks()`：`listTasks()` 仍含 archived，另给“只看非归档”的明确语义；
  - 新增 `archiveTask(taskId, {force})`：检查任务存在、统计非终态会话；有活会话返回 `requiresStop`；成功写 `archived=1/updated_at` + `lifecycle` 事件 + audit；不删任何历史；不动 schema；
  - 新增 `releaseStaleLeases(taskId, now?, reason?)`：按 `task_id` 释放过期或持有者非活跃的租约；
  - 新增 `abandonStaleIntents(taskId)`：按 `task_id` 放弃领取者非活跃的 claimed 意图。
- `apps/desktop/src/main/hub/hub.ts`
  - `setTask(taskId: string | null)`；
  - `task.archive` 真正实现：非 force 的有活会话拒绝（文案含标题/会话数/force）；force 先 `stopTaskSessions` 再 `waitForTaskIdle`（最多 2s）再归档；归档后广播 `task.upsert`，焦点被归档则切到 `listActiveTasks()[0]` 或 `null`；
  - 新增 `emitTaskView()`（归档广播用，不检查焦点）与 `waitForTaskIdle()`；`emitTaskById()` 仍只推焦点，P1-C 的后台任务语义不变。
- `apps/desktop/src/main/session/manager.ts`（**仅最小改**）
  - `restoreSessions(taskId, {recover?: boolean})`：默认仍先全局 recover（旧调用方不变）；启动路径传 `{recover:false}`，避免每个任务重复扫全表；
  - `loadTaskSessions` 的按会话 id 去重保持幂等（F 组验证重复恢复不会重复创建会话）。

测试：

- `apps/desktop/src/cli/verify-multitask.ts`
  - 保留 A–E 组全部已绿断言，不改；
  - 新增 F（重启恢复全部任务）：子进程创建 3 任务/6 会话 + A/B 的租约与意图 + 两个孤儿租约/意图，非优雅退出；父进程重开 DB 后验证按任务恢复、按任务 stale 清理、incident 归任务、重复恢复幂等；
  - 新增 G（归档）：有活会话拒绝、force 停止并归档、焦点回退、历史保留、`task.upsert(archived=true)`、归档任务不能再起会话/成为焦点、`task.stopAll` 不归档、全部归档后焦点 `null` 且可新建任务恢复。
- 未改 `verify-r18.ts` / `verify-hardening.ts`（P1-C 语义未变，无冲突）。

文档/证据：

- `docs/done/P1-D.md`（本文件）
- `docs/PROGRESS.md` 追加
- `evidence/p1d-verify-all.txt`、`evidence/p1d-multitask.txt`、`evidence/p1d-electron-verify.txt`、`evidence/p1d-migration.txt`
- `evidence/p1d-multitask-red.txt`（改实现前的红测原始输出）
- `docs/logs/ui-verify.json`（Electron 复验）

## 怎么验证的

先写 F/G 组，在 P1-D 实现前跑出红：

```text
$ npm run verify:multitask
FAIL  F：releaseStaleLeases 已实现  — missing
FAIL  F：abandonStaleIntents 已实现  — missing
FAIL  F：所有租约已清空  — actual=2 expected=0
FAIL  G：force 归档成功  — {"ok":false,"error":"归档动作已定义，但 P1-D 才实现落库与看板过滤"}
FAIL  G：A 已归档  — actual=0 expected=1
FAIL  G：焦点回退到最新非归档任务 B  — ...
FAIL  G：归档广播 task.upsert(archived=true)  — count=0
FAIL  G：全部归档后焦点为 null  — ...
================ 150/171 通过 ================
```

改完后：

```text
$ npm run verify:multitask
================ F 重启恢复全部非归档任务 ================
================ G 归档（活动会话需 force；不删历史）================
================ 174/174 通过 ================
--- exit=0 14:09:35 ---
```

F 组关键断言（节选）：

```text
PASS  F：子进程创建 3 任务/6 会话后非优雅退出
PASS  F：releaseStaleLeases(A) 释放 A 的孤儿租约
PASS  F：releaseStaleLeases(A) 不动 B 的孤儿租约
PASS  F：releaseStaleLeases(A) 不动本任务运行会话的租约
PASS  F：abandonStaleIntents(A) 放弃 A 的孤儿意图
PASS  F：abandonStaleIntents(A) 不动 B 的孤儿意图
PASS  F：恢复后内存里有 6 个会话  — actual=6 expected=6
PASS  F：任务 A/B/C 各恢复 2 个会话
PASS  F：所有租约已清空  — actual=0 expected=0
PASS  F：A 的 stale 资源 incident 按任务归 A
PASS  F：B 的 stale 资源 incident 按任务归 B
PASS  F：A 的租约释放事件不出现在 B 的视图
PASS  F：重复 restoreSessions 不重复创建会话  — actual=6 expected=6
PASS  F：快照焦点是最新非归档任务
```

G 组关键断言（节选）：

```text
PASS  G：有活会话时 archive 被拒（文案含会话数与 force）
PASS  G：force 归档成功
PASS  G：A 已归档  — actual=1 expected=1
PASS  G：焦点回退到最新非归档任务 B
PASS  G：快照 tasks 仍含 A 且 archived=true
PASS  G：A 的历史会话仍可查  — actual=2 expected=2
PASS  G：A 的历史事实仍可查  — actual=1 expected=1
PASS  G：B 的会话不受影响
PASS  G：归档广播 task.upsert(archived=true)
PASS  G：归档焦点后最后一条 task.upsert 是新焦点 B
PASS  G：归档任务不能再起会话
PASS  G：归档任务不能再成为焦点
PASS  G：task.stopAll 不归档
PASS  G：全部归档后焦点为 null
PASS  G：全部归档后快照 task=null
PASS  G：全归档后可新建任务恢复焦点
```

全量回归：

```text
$ npm run verify:all
================ 52/52 通过 ================
========== 16/16 通过 ==========
========== 17/17 通过 ==========
========== 19/19 通过 ==========
================ 90/90 通过 ================
========== 148/148 通过 ==========
================ 49/49 通过 ================
ALL PASS
--- exit=0 14:09:25 ---
```

统计：确定性断言 **391**（52+16+17+19+90+148+49）+ renderer smoke **121** = **512 PASS / 0 FAIL**。R18/hardening 未被改动，数量仍 148/49。

迁移与 Electron：

```text
$ npm run verify:migration
================ 44/44 通过 ================
--- exit=0 14:09:37 ---

$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
[verify] 26/26 通过，证据写入 D:\agent\xuanwo\docs\logs\ui-verify.json
--- exit=0 14:09:40 ---
```

F 组补充了“多个非归档任务同时恢复”的持久化场景：子进程写 3 任务/6 会话后 `process.exit(0)`（不 close、不优雅收尾），父进程重开同一个 `board.db` 并跑启动恢复序列。P1-A 的 schema 迁移仍由 `verify:migration` 覆盖，本轮不重复改 schema。

## 没做什么 / 已知问题

### 已知中间状态

- **后台任务在 UI 仍看不到**：P1-D 只做主进程恢复/归档数据；任务看板、后台在跑数、懒加载完整流、配额展示是 **P1-E**。
- **归档后任务在看板如何展示（折叠/隐藏）由 P1-E 决定**：本步只保证 `listTasks()` / 快照 `tasks` 含 `archived:true`、焦点回退、历史仍可查。
- **审批事件仍只推焦点**：`approval.upsert` 仍按焦点过滤，`approvalsAll` 只在快照里；全局审批视图是 **P1-E**。
- **“上次焦点”尚未持久化**：当前按 createdAt 最新的非归档任务选焦点；接口预留了 `hub.setTask(null)`，后续要持久化时再加设置项。

### 其它已知问题 / 边界

- **全部任务归档后**：主进程 `currentTaskId` / 快照 `task` 都是 `null`，`tasks` 仍含归档任务；但渲染层 store 对 `task.upsert` 没有 taskId 过滤、也没有“清空焦点”的事件，增量状态下可能继续显示最后归档的任务，直到下一次快照。P1-E 做看板/空状态时统一处理。Electron 验收覆盖的是“有任务”路径（fresh workspace 会种示例任务）。
- **`archiveTask` 即使 `force=true` 也不会在板子层归档有活会话的任务**：它返回 `requiresStop`，由 Hub 停会话后重试。这是有意的安全边界；直接调用板子 API 的代码必须自己先停。
- **force 归档等待上限 2s**：`waitForTaskIdle` 超时则返回可读错误且不归档，不会留下“已归档但会话在跑”；真实 agent 若杀不掉，需要人工处理。G 组用 fake agent 验证了正常路径，没有单独注入“杀不掉”的故障。
- **启动恢复会全局扫一遍所有会话**（包括归档任务的历史会话），把非终态标 stopped 并清理其租约/意图；但只把**非归档任务**载入内存。归档任务的历史仍可在库里查，切不过去。
- `MAX_RESTORE=20`（每任务最多载入 20 个历史会话）保持原值；P1-C 的每任务 3 / 全局 8 配额远低于这个上限，不影响活跃会话恢复。
- `board.latestTask()` 仍保留但 `main.ts` 不再使用；焦点选择统一走 `listActiveTasks()`，避免“最新任务是归档任务”时选错。
- `main.ts` 新增一行启动日志（非归档任务数/焦点），不影响验收；P1-C 的配额注入、审批守卫、`verify:all` 链均未改。
- 没有跑真实 agent、没有烧 token、没有改 `D:\agent\skill`、没有改 `docs/ARCHITECTURE.md`、没有删测试、没有自动提交 flag。

## 下一手需要什么

- 等你确认 P1-D 后进入 **P1-E**：
  - 左栏任务看板：焦点/后台在跑数/配额、归档折叠或隐藏；
  - 任务看板懒加载完整流，后台会话不建 DOM；
  - 全局审批视图（taskId + 任务标题、只看当前任务、批量按过滤结果）；
  - 配额展示（P1-C 的 `quota` / `approvalsAll` 真正消费）；
  - 渲染层 `task.upsert` 的焦点保护（后台/归档事件不覆盖当前 `task`；全部归档时显示空状态）。
- P1-E 需要保持 `verify:multitask` A–G 全绿；不要回退 P1-D 的“恢复全部非归档任务/真实归档/按任务 stale 清理”语义。
