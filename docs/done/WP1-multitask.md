# WP1 · 多题并发工作区（P0）总收口

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP1；`docs/plans/COMPETITION-READINESS.md` §4；`docs/decisions/D-multitask-focus.md`
> 日期：2026-10-23
> 状态：**WP1 完成（P1-A → P1-F）**。P1-F 只写文档 + 跑全量，没有改任何 `.ts` / `.css` / `.json` 代码文件。
> 验收基线：**`verify:all` 553 PASS / 0 FAIL；`verify:multitask` 174/174；`verify:migration` 44/44；Electron `--verify` 26/26。**

---

## 做了什么

把单活动任务 Hub 升级为「焦点任务 + 全部活跃任务并存」：切题只切 UI 焦点，后台会话继续跑、继续写 `stream.jsonl`、继续计数；任意非归档任务可起会话/发提示（每任务 3、全局 8 配额）；A 任务首答只收敛 A 的队友；重启恢复全部非归档任务与非终态会话；归档只隐藏、不删除；旧 `board.db` 用 `PRAGMA user_version = 1` 向后兼容迁移。渲染层新增任务看板、全局审批、后台计数与配额显示；后台会话不建 DOM。

**关键取舍**

- 焦点/配额/审批过滤是 Hub 的应用层策略，`SessionManager` 保持 task-agnostic（`startSession` 不塞配额；CLI 直连路径不受影响）。
- 快照保持 `task` / `sessions` / `approvals` / `board` / `health` 的**焦点语义**；新增 `tasks`（全量，含 archived）、`approvalsAll`、`quota` 等**可选加法字段**，旧渲染层不炸。
- 后台事件带 `taskId` 推给渲染层，由 store 丢弃流/健康/黑板事件、只维护任务计数；`approval.upsert` 仍只推焦点（见已知限制）。
- 归档默认折叠、可展开；归档不删 facts/sessions；有活会话时必须显式 `force`。

---

## WP1 目标与 8 条验收对照

总控 §4 WP1 的 8 条验收逐条对照。A–G 在 `apps/desktop/src/cli/verify-multitask.ts`；H 由 `apps/desktop/src/cli/verify-migration.ts` 覆盖（不在 174 条里）。

| # | 验收 | 覆盖位置 | 断言数 | 结果 | 关键证据（真实输出节选） |
|---|---|---|---|---|---|
| 1 | 3 个任务 × 每任务 2 个 fake 会话 = 6 个都在跑 | `verify:multitask` A 组 | A+B 共 40 | PASS | `快照 tasks 有 3 条`、`任务 A/B/C runningSessions=2`、`全局 quota.runningSessions=6` |
| 2 | 焦点 A→B，A 的 2 个会话仍 running；切回 A 仍能看流 | `verify:multitask` B 组 | 同上 | PASS | `task.create(B) 后 A 的 2 个会话仍活跃 — actual=2`、`切焦点后 A 的 2 个会话仍活跃`、`task.switch 与 task.focus 等价` |
| 3 | A、B 各触发一次审批：队列两条、taskId 正确、只处理 A 不影响 B | `verify:multitask` C 组 | 17 | PASS | `两个任务各一条待审批 — actual=2`、`approvalsAll 的 A 任务标题正确 — actual="审批 A"`、`处理 A 的审批成功`、`B 的审批仍 pending` |
| 4 | A 任务首答触发收敛：只停 A 的队友，B 不动 | `verify:multitask` D 组 | 14 | PASS | `A 的队友被收敛停止 — actual="stopped"`、`A 的首答者没有被停 — idle`、`B 的 2 个会话仍活跃 — actual=2`、`B 黑板没有收敛 note — actual=0` |
| 5 | 每任务第 4 个被拒（3/3）；全局第 9 个被拒（8/8）；错误可读 | `verify:multitask` E 组 | 31 | PASS | `任务会话配额已满（3/3）：请先停一个会话，或调大 config/app.json 的 maxSessionsPerTask`；`全局会话配额已满（8/8）：…maxSessionsTotal` |
| 6 | 杀主进程重启：3 个任务、6 个会话恢复；租约/意图按任务正确 | `verify:multitask` F 组 | 38 | PASS | `恢复后内存里有 6 个会话 — actual=6`、`任务 A/B/C 各恢复 2 个会话`、`releaseStaleLeases(A) 不动 B 的孤儿租约`、`A 的租约释放事件不出现在 B 的视图` |
| 7 | 归档 A：A 不在活跃看板，历史仍可查 | `verify:multitask` G 组 | 34 | PASS | `有活会话时 archive 被拒（文案含会话数与 force）`、`force 归档成功`、`A 的历史会话仍可查 — actual=2`、`A 的历史事实仍可查 — actual=1`、`全部归档后焦点为 null` |
| 8 | 旧 `board.db`（复制一份）能迁移打开，旧任务/事实/会话不丢 | `verify:migration` | 44 | PASS | `真实备份迁移后任务数不变 — actual=15`、`事实数不变 — actual=23`、`会话数不变 — actual=30`、`事件数不变 — actual=472`、`user_version 为 1` |

合计：`verify:multitask` = 40 + 17 + 14 + 31 + 38 + 34 = **174/174**；`verify:migration` = **44/44**。

> 说明：验收 1/2 共用 A+B 组的 40 条断言；A 组覆盖“3×2 起得来 + 计数”，B 组覆盖“切焦点不停、`task.switch` 与 `task.focus` 等价、`task.stopAll` 只停目标任务”。

---

## P1-A → P1-F 每步摘要与证据

| 步骤 | 一行摘要 | 关键数字 | Evidence |
|---|---|---|---|
| **P1-A** | 契约可选字段 + `tasks` v1 迁移（`category/priority/archived/updated_at`）+ 配额配置（只加载、不执行），不改行为 | `verify:all` 500；migration 44/44；Electron 26/26 | `evidence/p1a-verify-all.txt`、`p1a-migration.txt`、`p1a-electron-verify.txt` |
| **P1-B** | Hub 拆 `focusedTaskId`；`task.create/switch/focus` 只切焦点、不停会话；新增 `task.stopAll`；快照 `tasks/approvalsAll/quota`；后台事件带 `taskId`、store 丢弃非焦点事件 | multitask **40/40**；`verify:all` 512；Electron 26/26 | `evidence/p1b-verify-all.txt`、`p1b-multitask.txt`、`p1b-electron-verify.txt` |
| **P1-C** | `session.start`/`prompt` 放宽到任意非归档任务；启动前配额（任务 3 / 全局 8）；收敛按任务独立；flag 候选按任务分桶 | multitask **102/102**；`verify:all` 512；migration 44/44；Electron 26/26 | `evidence/p1c-verify-all.txt`、`p1c-multitask.txt`、`p1c-migration.txt`、`p1c-electron-verify.txt`、`p1c-multitask-red.txt` |
| **P1-D** | 启动恢复全部非归档任务（全局 recover 一次 → 逐任务 restore/stale/signals）；`archiveTask` 真实落库（活会话需 `force`、不删历史、焦点回退/可 null）；stale lease/intent 按 `task_id` | multitask **174/174**；`verify:all` 512；migration 44/44；Electron 26/26 | `evidence/p1d-verify-all.txt`、`p1d-multitask.txt`、`p1d-migration.txt`、`p1d-electron-verify.txt`、`p1d-multitask-red.txt` |
| **P1-E** | 渲染层任务看板（含 archived 折叠）、焦点高亮/后台在跑数/配额、全局审批（默认只看焦点、批量只发过滤结果）、后台不建 DOM、焦点 pane 上限 3 | smoke **121 → 162（+41）**；`verify:all` **553**；multitask 174；migration 44；Electron 26 | `evidence/p1e-verify-all.txt`、`p1e-multitask.txt`、`p1e-migration.txt`、`p1e-electron-verify.txt`、`p1e-smoke-red.txt`、`p1e-ui-dom-check.txt` |
| **P1-F** | WP1 总收口：本文件 + 决策追加 + PROGRESS + 最终全量四份 evidence；不改代码 | 553 / 174 / 44 / 26 | `evidence/wp1-final-verify-all.txt`、`wp1-final-multitask.txt`、`wp1-final-migration.txt`、`wp1-final-electron-verify.txt` |

---

## 四个行为变更（汇总，细节见 P1-B/C/D/E）

1. **切题不再停会话（P1-B）**：`task.create` / `task.switch` / `task.focus` 只改 UI 焦点；旧任务会话继续 running。显式停止用 `task.stopAll`（只停目标任务非终态会话，不归档、不改任务状态）。
2. **任意非归档任务可起会话/发提示 + 配额（P1-C）**：`session.start` / `session.prompt` 从“只允许焦点任务”放宽为“任意存在且未归档的任务”；每任务默认最多 3 个、全局默认最多 8 个非终态会话，超限返回可读错误且不 spawn；A 任务首答收敛只停 A 的队友。
3. **重启恢复全部非归档任务 + 真实归档（P1-D）**：启动时全局 `recoverStaleSessions()` 一次，再逐任务 `restoreSessions`/释放 stale lease/放弃 stale intent；`task.archive` 从占位变为真实落库——有活会话且未 `force` 时拒绝，`force` 先停会话再归档，归档不删历史，焦点被归档时回退到最新非归档任务（没有则 `null`）。
4. **渲染层多任务看板 + 全局审批 + 后台不建 DOM（P1-E）**：左栏常驻全部任务（归档默认折叠可展开），焦点高亮、后台在跑数与配额可见；审批队列读 `approvalsAll`、默认只看焦点、批量只作用于当前过滤结果；后台会话只更新计数、不建 pane；全部归档时显示“无活跃任务”、不崩。

> 前三条是主进程语义变更，第四条是渲染层行为变更。旧测试按新语义改写、未删除：`verify-r18.ts` A 组、`verify-hardening.ts` §6；R18 从 139 → 148、hardening 从 46 → 49。

---

## 怎么验证的（真实输出）

### 1. `npm run verify:all`

```text
================ 52/52 通过 ================
========== 16/16 通过 ==========
========== 17/17 通过 ==========
========== 19/19 通过 ================
================ 90/90 通过 ===============
========== 148/148 通过 ==========
================ 49/49 通过 ================
...
ALL PASS
--- exit=0 15:11:07 ---
```

统计：确定性 **391**（52 + 16 + 17 + 19 + 90 + 148 + 49）+ renderer smoke **162** = **553 PASS / 0 FAIL**，退出码 0。完整输出见 `evidence/p1e-verify-all.txt` 与 `evidence/wp1-final-verify-all.txt`。

### 2. `npm run verify:multitask`

```text
================ P1-B/P1-C A 三任务 × 两会话 ================
---------- B 切焦点 / stopAll ----------
================ C 审批隔离（跨任务）================
================ D 收敛按任务（首答只停本任务队友）================
================ E 配额（每任务 3 / 全局 8）================
================ F 重启恢复全部非归档任务 ================
================ G 归档（活动会话需 force；不删历史）================

================ 174/174 通过 ================
--- exit=0 15:11:17 ---
```

分组：A+B 40、C 17、D 14、E 31、F 38、G 34 = **174/174**。证据见 `evidence/p1e-multitask.txt` 与 `evidence/wp1-final-multitask.txt`。

### 3. `npm run verify:migration`

```text
PASS  真实备份迁移后任务数不变  — actual=15 expected=15
PASS  真实备份迁移后事实数不变  — actual=23 expected=23
PASS  真实备份迁移后会话数不变  — actual=30 expected=30
PASS  真实备份迁移后事件数不变  — actual=472 expected=472
PASS  真实备份迁移后 user_version 为 1  — actual=1 expected=1

================ 44/44 通过 ================
--- exit=0 15:11:18 ---
```

证据见 `evidence/p1e-migration.txt` 与 `evidence/wp1-final-migration.txt`。

### 4. Electron `--verify`

```text
$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
[verify] 26/26 通过，证据写入 D:\agent\xuanwo\docs\logs\ui-verify.json
--- exit=0 15:11:21 ---
```

证据见 `evidence/p1e-electron-verify.txt` 与 `evidence/wp1-final-electron-verify.txt`。

### 5. 额外 DOM 验收（P1-E）

`evidence/p1e-ui-dom-check.txt`（mtime 15:06:51，sha256 `989f9a961d92fd3cb07101370f5e037d231e999f1e2ad26a0996d14747a01b95`）是 Electron 加载 mock 多任务世界的真实运行输出：2 个活跃任务 + 1 个归档折叠、焦点 B、后台 2 个在跑、配额 4/8·每任务 2/3；切“查看全部”后 2 条审批（A+B）；切焦点 A 后 pane/tab 为 `mt-a1`/`mt-a2`；全部归档后 0 活跃行、3 归档行、0 pane、0 待批、扇出禁用、配额 0/8；`DOM_CHECK_RESULT PASS`。该临时 harness 按 P1-E 约定已删除，文件本身没有显式 `exit=` 行，退出状态以 `DOM_CHECK_RESULT PASS` 与 mtime 为准。

### 6. 备份库未被测试改动

`.probe/backup-wp1/board.db`：348160 字节，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录值一致。同目录的 `-wal`（0 字节）/`-shm` 是后续打开时的 SQLite 附属文件，`board.db` 本体哈希未变。

---

## smoke 121 → 162 的说明

- **+41 条 P1-E 新增断言**，分三块：
  - **多任务数据/看板/配额/审批（约 18 条）**：`tasks` 保留全量、`approvalsAll`、`quota`、焦点 sessions 只含焦点、看板活跃/归档/折叠/展开、后台在跑数、焦点行、category/running/total、全局+每任务配额、全局审批默认过滤/看全部/taskTitle、批量只发过滤结果、`scope=all` 带焦点 `taskId`。
  - **后台事件与焦点缓存隔离（约 11 条）**：后台 `session.upsert` 只加计数、终态只减 running、`session.removed` 只减 total、后台 health/board.appended 不进焦点、后台归档不抢焦点、归档焦点后 `task=null` 且会话/审批/黑板/健康全清、切焦点立即清空旧缓存、快照 `task=null` 时全空、旧快照缺字段回退、缺 `quota` 为 null。
  - **pane 与 mock hub（约 12 条）**：焦点最多 3 个 pane、优先活跃、无会话时为空；多任务 mock 3 任务（1 archived）、跨任务审批、配额 4/8；mock hub 首屏 B、切 A、切回 B、后台 A 仍在跑。
- **其中 25 条在旧代码上红**：`evidence/p1e-smoke-red.txt` 记录 **130 PASS / 25 FAIL**（当时共 155 条 = 旧 121 + 已写的 34 条新断言）。25 条失败覆盖 `approvalsAll=undefined`、看板 `active/archived/showArchived=undefined`、批量 `ids=[]`、`task=multi-a` 未清空、`picked=0` 等；随后补齐剩余 7 条新断言，最终 41 条。
- **旧 121 条语义未改**：对 `.probe/backup-p1e/renderer/smoke.ts` 与当前 `smoke.ts` 做断言名对比，**旧断言零删除、零改名**（106 个字面 `ok()` 名称全部保留，新增 38 个 P1-E 字面名称；其余新增来自循环/参数化断言）。mock 侧只做加法：旧 `buildMockSnapshot()` 的 `task-1`/`task-0` 补可选新字段、快照补 `approvalsAll/quota`；旧断言只读原有字段，默认 2 任务世界不变；3 任务世界是独立的 `buildMultiTaskMockSnapshot()`，由 `createMockHub({ multiTask: true })` 使用。**旧 121 条没有逐条语义调整。**
- 一处仅涉及**新断言**的命名归一：红测时 `P1-E：批量放行只对过滤结果发 id（不误放 A）`，实现后统一为 `P1-E：批量放行默认只对焦点过滤结果发 id（不误放 A）`；不影响旧断言。

---

## 已知限制清单

以下按“会影响谁 / 什么时候需要回来处理”汇总。P1-A–E 的完整边界见各自 done 文档。

### 主进程 / 契约

1. **`permission.grantAll.taskId` 契约字段已加，Hub 未实现跨任务授权**：`scope=session/agent/all` 仍只取焦点任务的会话；`taskId` 只是契约透传，Hub 当前忽略它。P1-E 的「本任务全部允许」显式带焦点 `taskId`（默认安全），但**跨任务批量授权不可用**；需要 Lane A 后续改 Hub。
2. **后台 `approval.upsert` 仍只推焦点**：渲染层在后台会话进入 `waiting_approval`、用户裁决/批量/本任务放行后重拉快照来补 `approvalsAll`；若某个后台审批没有伴随新的 `session.upsert`，最迟要等下一次快照/切焦点才出现在全局视图。**没有加轮询。**
3. **`session.stop` / `interrupt` / `remove` / `setTier` 仍只允许焦点任务**：后台会话的停止走 `task.stopAll` 或收敛；P1-E 全局审批卡对后台项隐藏“本会话全部允许”，避免走后端会拒绝的路径。
4. **“上次焦点”未持久化**：重启按 `createdAt` 最新的非归档任务选焦点；接口已支持 `hub.setTask(null)`，后续要持久化时再加设置项。
5. **配额检查是“先查后启动”，不是原子预留**：单主进程串行 dispatch 下成立；极端并发 dispatch 仍可能同时通过检查。若 WP2+ 引入批量并发启动，需要加 reservation。
6. **`task.archive force` 等待会话空闲上限 2s**：超时返回可读错误且不归档，不会留下“已归档但会话在跑”；真实 agent 若杀不掉需人工处理。G 组只验证正常路径，没有注入“杀不掉”的故障。
7. **启动恢复每任务最多 `MAX_RESTORE=20` 个历史会话**：归档任务的历史不载入内存；P1-C 的 3/8 配额远低于此上限。
8. **后台收敛触发主要靠 `agent_message`**：后台流仍会进 Hub；若后台只通过 MCP `submit_fact` 写黑板、且最终回复里没提 flag，`publishBoardSince` 仍只读焦点任务，候选/收敛要等切到该任务才被扫描到（P1-C 遗留边界）。
9. **`main.ts` 审批守卫放宽未被 Electron `--verify` 直接覆盖**：C 组在 Hub 夹具里验证真实路径的守卫逻辑；Electron `--verify` 只走单任务路径。

### 渲染层 / 内存

10. **焦点 pane 上限 3**：焦点任务超过 3 个历史会话时只给 3 个建 pane（活跃优先、终态最近优先）；更多历史在快照/左栏会话列表里，不建 DOM。`CONV_WINDOW=120`、`MAX_BLOCKS=500` **未改**。
11. **后台不建 DOM**：`session.upsert/removed/stream/health/board.appended` 带非焦点 `taskId` 时，store 只维护 `tasks` 的 `running/total`（stream/health/board 直接丢弃）；后台完整流要切焦点后懒加载。
12. **`approvalsAll` 可能保留归档任务的历史审批**：store 保留原始数据供审计，审批 UI 按 `tasks.archived` 过滤出可操作队列，不会误放；但不是“归档即从内存删除”。
13. **全部归档时依赖快照/事件清空焦点**：P1-E 在 `task.upsert` 归档当前焦点时立即清空焦点缓存，并由重拉快照权威替换；若只有增量事件、没有快照，理论上可能短暂保留最后归档任务。Electron `--verify` 覆盖的是“有任务”路径，DOM 验收覆盖了“全部归档”路径。
14. **mock 配额是 4/8、每任务 2/3**：两个活跃任务各 2 会话，归档任务不计入全局；不是全局 8 的近满状态。真实配额显示由 Hub 的 `quota` 提供。
15. **任务看板每行操作在 240px 左栏**：按钮用小号样式；窗口极窄时可能换行，但不会溢出隐藏。

### 数据 / 测试夹具

16. **`board.listTasks()` 返回 `archived: 0|1`（数字），`TaskView` 映射为 `boolean`**：这是 P1-B 行为。直接消费 board API 的代码不能把 `0/1` 当 boolean 用；Hub 的 `toTaskView()` 已转换。
17. **E 组归档配额测试用 `UPDATE tasks SET archived=1` 模拟**：P1-C 时真实 `archiveTask` 尚未实现，E 组用 `h.board.raw("UPDATE tasks SET archived = 1 WHERE id = ?", aId)` 造“归档任务不计入全局配额/不能再起会话”；P1-D 已补真实 `archiveTask`，但 **E 组没有回改为走 Hub 路径**（保留为配额夹具）。可记“待 WP6 benchmark 时统一”，届时 E 组可改成真实 `task.archive`。
18. **`verify:multitask` 没有 H 组**：H（旧库迁移）由 `verify:migration` 覆盖；`verify:multitask` 保持 A–G 174 条，不把迁移断言重复塞进去。

---

## 没做什么 / 已知问题

- **P1-F 不改代码**：没有改 `.ts` / `.css` / `.json`；没有改 `hub.ts`、`board.ts`、`session/manager.ts`、`electron/main.ts`、`events.ts`、`renderer/**`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`smoke.ts`；没有改 `verify:all` 链。
- **没有跑真实 agent、没有烧 token**：全部使用 fake agent / 进程内 Hub / 临时 SQLite；真实 A/B 仍只有 `docs/logs/ab-result.json` 那一次（样本 1，不能当规律）。
- **没有做 WP2–WP8**：技能注入、附件/工件、目标范围、flag 闭环、benchmark、进程树/打包、AWD/应急设计都还没开始。
- **没有重打包**：`dist/` 不是本轮产物；P1-F 不碰打包。WP7 再处理可移植 `workDir` 与打包态 `skillDir`。
- **没有自动提交 flag、没有改全局配置、没有改 `D:\agent\skill`、没有改 `docs/ARCHITECTURE.md`、没有删测试。**
- **未验证项**：真实 8 会话长跑的内存/事件量（留给 WP6 soak）；后台审批无 `session.upsert` 时的最迟出现时间（只做了重拉快照兜底，没有轮询）；`force` 归档遇到“杀不掉的真实 agent”的故障路径；全部归档的增量事件极端时序。

---

## WP2 之前必须知道的事（交接）

### 基线门禁

- 当前门禁是 **`verify:all` 553 PASS / 0 FAIL（确定性 391 + smoke 162）+ `verify:multitask` 174/174 + `verify:migration` 44/44 + Electron `--verify` 26/26**。WP2 不允许回退这些数字，也不允许把 `verify:multitask` 塞进 `verify:all` 链（保持独立运行）。
- `verify:all` 链尾已包含 `renderer/smoke.ts`；统计口径是“确定性 + smoke”，不要把 smoke 重复算两套。

### 可直接复用的 WP1 资产

- **`TaskCategory` 已在冻结契约 `packages/shared-protocol/events.ts`**（`web|misc|crypto|reverse|pwn|pentest|ir|awd|unknown`），`TaskView.category/priority` 已落库并进快照；`task.create` 已接受可选 `category/priority`，渲染层创建弹窗已有下拉。WP2 不需要再定义一套分类。
- **`buildBriefing(board, { taskId, role, sessionId, workDir })`** 已经能通过 `board.getTask(taskId)` 拿到 `category`；`SessionManager.startSession` 已接收 `role`，且是 task-agnostic 的。WP2 注入 playbook/routing 时优先在 `briefing/build.ts` 内按 `task.category + input.role` 组装，不要把技能逻辑塞进 Hub 的焦点/配额路径。
- **`Hub.snapshot()` 的焦点语义**：`task/sessions/approvals/board/health` 仍是焦点；`tasks/approvalsAll/quota` 是加法字段。WP2 若加 `HubSnapshot.skill?`，保持**可选**，旧快照/旧 mock/旧 smoke 不炸。
- **渲染层 store 的过滤规则**：非焦点 `session.stream/health/board.appended` 丢弃、`session.upsert/removed` 只更计数、`approval.upsert` 只推焦点、`task.upsert` 有归档/切焦点保护。WP2 新增的 skill 状态不要走“非焦点会话事件”通道，否则会被 store 丢掉。

### 不要重开的 WP1 决策

- 切题**不再停会话**；显式停止只走 `task.stopAll`。
- `session.start/prompt` 允许**任意非归档任务**；`stop/interrupt/remove/setTier` 仍只允许焦点。
- 归档有活会话必须 `force`；归档不删历史；全部归档焦点为 `null`。
- 启动恢复**全部非归档任务**；stale lease/intent **按 `task_id`** 清理，不能跨任务。
- 快照兼容：旧渲染层只消费焦点 `task/sessions/approvals` 时仍然工作。

### WP2 施工提醒

- `D:\agent\skill` 只读；`skillDir` 解析顺序按计划 §5.3：`BUMIMANG_SKILL_DIR` → `config/app.json` → 开发态默认 → 打包态内置 → 都没有则 `skill.configured=false` 并明确提示，**不要静默降级**。
- 技能工具与黑板工具同进程、同会话令牌；不要为 skill 工具开旁路，也不要改用户已挂载技能的全局配置。
- 真实 agent 冒烟（WP2 的 `skill_search` 引用路径）**每个 WP 最多 1 次，且需要用户同意 token**；默认用 fake agent / 纯逻辑验收。
- 已知 WP1 遗留可在 WP2 顺手评估、但不要越界改：后台 `approval.upsert` 推送、跨任务 `grantAll`、上次焦点持久化、E 组 raw UPDATE 夹具。这些不属于 WP2 的 P0 范围，改动前先写决策/请求。

### 证据与备份

- `.probe/backup-wp1/board.db`（348160B，sha256 `6d491f0b…ab5cf469`）是 P1-A 的真实库备份；`.probe/backup-p1e/renderer/` 是 P1-E 前的渲染层备份。**不要删、不要覆盖。**
- 证据目录：P1-A–E 的 `evidence/p1-*.txt` + 本轮 `evidence/wp1-final-*.txt`；Electron 证据在 `docs/logs/ui-verify.json`。
- 本仓库不是 git 仓库；大改前继续用 `.probe/backup-<topic>/`，不要擅自 `git init`。

---

## 下一手需要什么

- 等你确认 WP1 收口后，进入 **WP2（技能与知识接入）**；本轮不开始 WP2。
- 如果 WP2 需要新的契约字段（如 `HubSnapshot.skill?`），按“只加可选字段”走；旧渲染层/旧测试必须不炸。
- 如果 WP2 想复用 WP1 的多任务能力做“按题注入不同 playbook”，直接读 `TaskView.category`；不要重新实现任务分类或焦点逻辑。
- 如果全量数字与 P1-E 不一致（有人顺手改了代码），先停下报差异，不要自行修。
