# P1-C · 任意非归档任务起会话 + 配额执行 + 按任务收敛

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP1；`docs/plans/COMPETITION-READINESS.md` §4.3/§4.5/§4.9；`docs/decisions/D-multitask-focus.md`
> 日期：2026-10-23
> 状态：**P1-C 完成，等确认后进入 P1-D**。本轮没有跑真实 agent、没有烧 token、没有改 `docs/ARCHITECTURE.md`、没有删测试。

## 做了什么

`session.start` 从“只允许 UI 焦点任务”放宽为“任意存在且未归档的任务”；启动前执行配额（每任务非终态 < 3、全局非归档任务非终态 < 8，超限返回可读错误且不 spawn）；`session.prompt` 同步放宽到任意非归档任务的会话（这是本轮第二个行为变更）；R24 收敛改为按任务独立，只停该任务除首答者外的队友，并把收敛 note 写到该任务黑板；flag 候选内存结构改为 `Map<taskId, Map<flag, {by, at}>>`，快照仍只暴露焦点任务的候选。

**关键取舍**

- 配额检查放在 Hub 的 `session.start` 路径（启动进程之前），而不是 `SessionManager.startSession`：焦点限制与配额都是应用层策略，Hub 同时持有配置、任务表和全局会话；`manager.ts` 本身已经是 task-agnostic 的，未修改，避免影响现有 CLI 直连 `startSession` 的测试。
- `session.prompt` 放宽、`session.stop` / `interrupt` / `remove` / `setTier` 仍只允许焦点会话：后台会话的批量停止走 `task.stopAll` 或收敛，避免一条陈旧 UI 消息误停后台任务。
- 收敛 note 用新增的 `Blackboard.note()` 写 `kind="note"` 事件（`subject=taskId`），不改 schema、不改 `archiveTask`。
- 后台任务起会话/失败回滚只落库，不推 `task.upsert`：P1-B 的渲染层 store 对该事件没有 taskId 过滤，推后台任务会把焦点 `task` 覆盖掉；任务看板的实时后台状态由 P1-E 用新事件/过滤补。

## 行为变更（第二个，单独记录）

**`session.start` / `session.prompt` 从“只允许焦点任务”改为“允许任意非归档任务”。**

- 这是有意的语义放宽：P1-B 已经让切题不停会话，如果后台会话不能起新会话、不能发提示，后台任务就只能“活着但不可操作”。
- `verify-r18.ts` A 组两条断言按新语义改写：
  - 旧任务 `session.start`：从“被拒绝”改为“允许（非归档任务）”；
  - 旧任务 `session.prompt`：从“被拒绝”改为“允许（非归档任务）”。
- **没有删除任何测试**；`session.stop` / `session.interrupt` 仍保留“旧任务被拒绝”的断言（后台停止走 `task.stopAll`）。
- R18 A 组的延迟 prompt 计数从 2 改为 4：新允许的“后台起会话 + 后台补提示”各产生一次简报/提示应答；断言数量不变（R18 仍 148/148）。
- 与 P1-B 的“切题不再停会话”并列：P1-B 解决“切走不停”，P1-C 解决“后台可操作 + 有配额 + 收敛不串台”。

## 改了哪些文件

源码：

- `apps/desktop/src/main/hub/hub.ts`
  - `session.start`：接受任意任务；校验存在/未归档；启动前配额检查；成功把**目标任务**置 `solving`；失败回滚目标任务状态；后台任务只落库，不推 `task.upsert`（避免 P1-B 的渲染层 store 把焦点任务覆盖成后台任务）；
  - `session.prompt`：新增 `promptableSession()`，允许任意非归档任务的会话；stop/interrupt/remove/setTier 仍走焦点校验；
  - 配额：`globalActiveCount()` 只统计非归档任务；`quotaError()` 返回计划约定的可读错误；快照 `quota.runningSessions` 同步改为“非归档任务非终态会话数”；
  - flag 候选：`Map<taskId, Map<flag, {by, at}>>`；`flagCandidateOf()` 取最近候选；`listTaskViews()` 只给焦点任务填 `flagCandidate`；
  - 收敛：`noteFlagCandidate()` 不再因“候选已存在”提前返回（E0 后补 E1 也能触发）；后台任务同样触发；`maybeStartConvergence(taskId, ...)` 只查该任务会话、只停该任务队友、写该任务 note。
- `apps/desktop/src/main/blackboard/board.ts`
  - 新增 `note({ taskId, sessionId, text })`：写 `kind="note"` 的哈希链事件 + audit；不改 schema、不改 `archiveTask`、不改现有 API 语义。
- `apps/desktop/src/main/electron/main.ts`（**只改两处非启动恢复代码**）
  - Hub 构造时把 `config/app.json` 的 `maxSessionsPerTask` / `maxSessionsTotal` 传入（未配置时 Hub 仍默认 3/8）；
  - 审批 fail-closed 守卫移除“必须是焦点任务”的条件，改为“会话存在、taskId 匹配、非终态、任务存在且未归档”——否则后台任务的审批会被主进程直接拒绝，C 组验收在真实路径上不成立。
  - **没有改** `restoreSessions(t.id)` 的启动恢复范围（仍只恢复最近任务，P1-D）。

测试：

- `apps/desktop/src/cli/verify-multitask.ts`
  - 保留 A/B 两组原断言；
  - 新增 C（审批隔离）、D（收敛按任务）、E（配额）；
  - 未写 F（重启）/ G（归档真正落库），按约定留 P1-D。
- `apps/desktop/src/cli/verify-r18.ts`
  - A 组两条断言语义改写 + 延迟 prompt 计数 2→4；注释同步；其它组未改。
- `apps/desktop/src/cli/verify-hardening.ts`
  - 未改：§6 的“切焦点不停会话/不清授权；task.stopAll 才停并清授权”与新语义不冲突。

文档/证据：

- `docs/done/P1-C.md`（本文件）
- `docs/PROGRESS.md` 追加
- `evidence/p1c-verify-all.txt`、`evidence/p1c-multitask.txt`、`evidence/p1c-electron-verify.txt`
- `evidence/p1c-migration.txt`（回归：迁移/配额配置未受影响，44/44）
- `evidence/p1c-multitask-red.txt`（改实现前的红测原始输出）
- `docs/logs/ui-verify.json`（Electron 复验）

## 怎么验证的

先写测试再改实现。P1-C 的 C/D/E 组在旧代码上是红的：

```text
$ npm run verify:multitask
FAIL  C：非焦点任务 A 能起会话  — 任务已切换，不能在旧任务里起会话
FAIL  D：两个任务各起 2 个会话（含非焦点任务 A）  — 全部“任务已切换，不能在旧任务里起会话”
FAIL  E：每任务第 4 个会话被拒（3/3）  — 任务已切换，不能在旧任务里起会话
FAIL  E：全局第 9 个会话被拒（8/8）  — ok
================ 61/83 通过 ================
```

改完后：

```text
$ npm run verify:multitask
================ P1-B/P1-C A 三任务 × 两会话 ================
================ C 审批隔离（跨任务）================
================ D 收敛按任务（首答只停本任务队友）================
================ E 配额（每任务 3 / 全局 8）================
================ 102/102 通过 ================
--- exit=0 13:42:47 ---
```

关键断言（节选）：

```text
PASS  C：非焦点任务 A 能起会话
PASS  C：两个任务各一条待审批  — actual=2 expected=2
PASS  C：approvalsAll 的 A 任务标题正确  — actual="审批 A"
PASS  C：处理 A 的审批成功
PASS  C：A 的审批已 approved
PASS  C：B 的审批仍 pending
PASS  D：A 的队友被收敛停止  — actual="stopped"
PASS  D：A 的首答者没有被停  — actual="idle"
PASS  D：B 的 2 个会话仍活跃  — actual=2 expected=2
PASS  D：A 黑板写入 1 条收敛 note  — actual=1 expected=1
PASS  D：B 黑板没有收敛 note  — actual=0 expected=0
PASS  D：非焦点 A 的 flagCandidate 不暴露  — actual=null expected=null
PASS  E：每任务第 4 个会话被拒（3/3）  — 任务会话配额已满（3/3）...
PASS  E：全局第 9 个会话被拒（8/8）  — 全局会话配额已满（8/8）...
PASS  E：停一个后 C 能再启动第 3 个
PASS  E：C 的第 4 个会话被拒（3/3）
PASS  E：归档后全局配额排除 A（8-2=6）  — actual=6 expected=6
PASS  E：归档任务不能再起会话  — 任务已归档：...
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
--- exit=0 13:42:38 ---
```

统计：确定性断言 **391**（52+16+17+19+90+148+49）+ renderer smoke **121** = **512 PASS / 0 FAIL**。R18 仍 148、hardening 仍 49，数量未变。

Electron：

```text
$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
[verify] 26/26 通过，证据写入 D:\agent\xuanwo\docs\logs\ui-verify.json
--- exit=0 13:42:51 ---
```

迁移回归（`board.note` 未改 schema，再跑一遍确认旧库/配额配置不回归）：

```text
$ npm run verify:migration
================ 44/44 通过 ================
exit=0
```

本轮没有启动真实 agent，全部使用 fake agent / 进程内 Hub / 临时 SQLite；token 消耗 0。

## 没做什么 / 已知问题

### 已知中间状态

- **后台任务能起会话了，但 UI 仍看不到**：P1-C 只做主进程能力；任务看板、后台在跑数、懒加载完整流是 **P1-E**。
- **启动恢复仍只恢复最近任务**：`electron/main.ts` 的 `restoreSessions(t.id)` 未改；重启后其它任务要切过去才 `loadTaskSessions`（非终态会被标 stopped）。**P1-D** 恢复全部非归档任务。
- **归档未真正实现**：`task.archive` 仍是占位；E 组的“归档任务不计入配额/不能再起会话”是用 `board.raw("UPDATE tasks SET archived=1 ...")` 模拟的，不是真实 `archiveTask` 路径。**P1-D**。
- **审批事件仍只推焦点**：`approval.upsert` 仍按焦点过滤，`approvalsAll` 只在快照里；全局审批视图和“只看当前任务”过滤是 **P1-E**。主进程现在允许后台审批进入队列，但 UI 还看不到实时事件。

### 其它已知问题 / 边界

- `session.stop` / `session.interrupt` / `session.remove` / `session.setTier` **仍只允许焦点任务**（按本轮范围只放宽 start/prompt）；后台会话的停止走 `task.stopAll` 或收敛。
- 后台任务的收敛触发目前主要靠 **agent_message**（后台流仍会进 Hub）；如果后台只通过 MCP `submit_fact` 写黑板、且最终回复里没提 flag，`publishBoardSince` 仍只读焦点任务，候选/收敛要等切到该任务才被扫描到。这是 P1-B 就有的“黑板事件按焦点”边界，P1-D/P1-E 可再统一。
- 配额检查是“先查后启动”，不是原子预留；单主进程串行 dispatch 下没问题，但极端并发 dispatch 仍可能同时通过检查。若 P1-E/后续出现批量并发启动，再加 reservation。
- `main.ts` 的审批守卫放宽没有被 Electron `--verify` 直接覆盖（它只验证单任务路径）；C 组是在 Hub 夹具里验证的。真实路径改动很小（只去掉焦点条件、加 archived 检查），但严格说属于“逻辑已改、端到端未单独跑真实 agent”。
- `manager.ts` 本轮**未改**：焦点限制与配额都不在它里面；`stopTaskSessions` 仍是 Hub 私有方法（`task.stopAll` 与收敛共用），行为已满足“只停该任务非终态会话”。现有 CLI 直连 `manager.startSession` 的测试因此不受配额影响。
- 快照 `flagCandidate` 现在**只给焦点任务**填；后台任务的候选仍在内存（按任务分桶），切过去后通过快照/重扫展示。这与用户要求的“只暴露焦点任务”一致，但意味着 P1-E 的任务看板若要显示后台候选，需要另行请求（不要直接读 `tasks[].flagCandidate`）。
- 没有跑真实 agent、没有烧 token、没有改 `D:\agent\skill`、没有改 `docs/ARCHITECTURE.md`、没有删测试、没有自动提交 flag。
- 没有改 `package.json` 的 `verify:all` 链；`verify:multitask` 仍单独跑（102 条不塞进 `verify:all`）。

## 下一手需要什么

- 等你确认 P1-C 后进入 **P1-D**：
  - `electron/main.ts` 启动时恢复全部非归档任务及非终态会话；
  - `task.archive` 真正落库（有活会话时 `force` 语义）、看板过滤、历史可查；
  - 按任务释放 stale lease / abandon intent，避免 A 的租约泄漏到 B；
  - 旧 `board.db` 迁移（P1-A 已做 v1，P1-D 验证完整恢复路径）。
- **P1-E**：任务看板（焦点/后台在跑数/配额）、全局审批视图（taskId+标题、只看当前任务）、后台事件不进 DOM、P1-C 的 `approvalsAll`/`quota` 真正显示。
- P1-D 需要保持本轮 `verify-multitask` A–E 全绿，并新增 F（重启）/ G（归档）组；不要回退 `session.start/prompt` 的任意非归档任务语义。
