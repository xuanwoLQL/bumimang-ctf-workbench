# P1-E · 渲染层多任务看板 + 全局审批 + 后台计数

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP1；`docs/plans/COMPETITION-READINESS.md` §4.5/§4.6/§4.9；`docs/done/P1-D.md`
> 日期：2026-10-23
> 状态：**P1-E 完成，等确认后进入 WP2**。本轮只改 `apps/desktop/src/renderer/**`；没有改 Hub/黑板/SessionManager/Electron 主进程启动逻辑，没有改冻结契约、R18/hardening、`verify:multitask` A–G、skill、ARCHITECTURE、全局配置或 `verify:all` 链。没有跑真实 agent、没有烧 token、没有删测试、没有自动提交 flag。

## 做了什么

启动后左栏新增「任务看板」：显示全部任务（含 archived），焦点高亮，每题带 category、状态、`running/total`、flag 候选、后台在跑数；点非焦点任务切焦点，归档任务默认折叠、可展开看历史。顶部同时显示全局配额（`running/maxTotal`）与焦点任务每任务配额（`running/maxPerTask`，hover 有完整说明）。焦点切换时 store 用新快照替换焦点 `sessions/approvals/board/health`，panes 卸载旧窗格并按新焦点懒加载历史；后台事件只更新 `tasks` 计数，不进焦点列表、不建 DOM。右栏审批队列改为读 `approvalsAll`，默认「只看当前任务」，可切「查看全部任务」；每条显示 taskId + taskTitle；批量放行只对当前过滤结果的 id 发 `approval.bulk`。全部归档时焦点为 `null`，中栏 0 个 pane，左栏显示「无活跃任务」，不崩。

**关键取舍**

- 任务看板/配额/归档/停止全部是 **renderer 数据与 UI**；`task.archive`/`task.stopAll` 仍走 P1-D 的 Hub 语义，没有复制后端逻辑。
- 归档展示选择 **默认折叠、可展开**（不是全隐藏）：`tasks` 仍包含 `archived:true`，看板只控制是否渲染归档区；审批队列把归档任务过滤出可操作列表，避免误放历史审批。
- 焦点 `sessions` 仍是快照的焦点语义；后台会话只保留 `sessionMeta` 轻量状态（taskId/status）用于计数增量，不保留对话块/DOM。
- 焦点 pane 上限 3 个：优先活跃会话，余量用最近结束的终态会话补足；更多历史仍在快照/左栏会话列表里，只是不建 pane（守住 P1-E 的内存约束）。
- 审批批量：默认过滤焦点，只有用户显式切「查看全部」才会把多个任务放进过滤结果；`全放行/全拒绝` 仍然只发送当前过滤结果的 id，不会因为打开全局视图就自动跨任务放行。
- `permission.grantAll scope=all` 的「本任务全部允许」显式带焦点 `taskId`；Hub 当前实现（P1-B 注释）仍只取焦点任务，**跨任务 grantAll 尚不可用**，本轮不擅自改后端。`global` 仍是单独的「全局全部允许」按钮。
- `task.upsert` 的渲染层处理改为：非归档事件切焦点；归档事件只更新看板，若归档的是当前焦点则立即清空焦点缓存；真正的 sessions/approvals/board 由随后重拉的快照权威替换，避免旧任务会话短暂串到新焦点。
- `approval.upsert` 仍只由主进程推焦点，但后台会话进入 `waiting_approval` 时 renderer 会重拉快照；用户裁决/批量后也重拉快照，让 `approvalsAll`/计数保持权威（见已知问题）。

## 行为变更（第四个，单独记录）

1. **渲染层从「单任务视图」变为「多任务看板 + 焦点视图」**：任务不再只在切换弹窗里可见，全部任务（含 archived）常驻左栏看板；焦点高亮，后台在跑数与配额直接可见。
2. **后台会话不再进 DOM**：`session.upsert/removed/stream/health/board.appended` 带非焦点 taskId 时，store 只更新对应 `tasks` 的 `running/total`（stream/health/board 丢弃），panes 不为后台会话建窗格；焦点最多 3 个 pane。
3. **全局审批视图上线**：审批队列从 `approvalsAll` 读，默认只看焦点任务；批量放行只作用于当前过滤结果；`permission.grantAll scope=all` 默认只焦点任务，`global` 仍是显式全局操作。
4. **全部归档时焦点为 `null`**：store 清空焦点会话/审批/黑板/健康，panes 卸载，左栏显示「无活跃任务」，不崩；已归档任务仍折叠在看板里可展开查看历史。
5. 与 P1-B/C/D 并列：P1-B 解决“切走不停”，P1-C 解决“后台可操作”，P1-D 解决“重启全回来 + 归档可收口”，P1-E 解决“后台能力在 UI 上看得见、管得住”。

## 改了哪些文件

源码（全部在 `apps/desktop/src/renderer/**`）：

- `store.ts`
  - `AppState` 新增 `approvalsAll`、`quota`、`sessionMeta`（轻量会话归属/状态索引，不参与渲染）；
  - `applySnapshot(snap, prev?)` 保留全量 `tasks`（含 archived），旧快照缺 `approvalsAll` 时回退 `approvals`，缺 `quota` 时为 `null`；
  - `applyEvent`：后台 `session.upsert/removed` 按 delta 维护任务计数；后台 stream/health/board 丢弃；`task.upsert` 归档/切焦点时立即清空旧焦点缓存；`approval.upsert` 同时维护 `approvalsAll`（焦点才进 `approvals`）。
- `main.ts`
  - 左栏任务看板（焦点/后台在跑数/配额/归档折叠/切焦点/停止全部/归档）；
  - 焦点任务卡新增 category/priority/会话数与归档、停止全部入口；
  - 无活跃任务空状态；无任务时扇出按钮禁用；
  - 事件入口按 taskId 硬过滤；任务焦点变化/归档/后台进入等审批时重拉快照；首屏与重拉都保留 `sessionMeta`。
- `task.ts`
  - 纯视图模型 `buildTaskBoardView`（看板/配额，smoke 可直接验证）；
  - 新建任务弹窗加 category（契约 `TaskCategory` 下拉）和 priority（0–100 可选）；
  - 归档/停止全部的确认浮层（有活会话时 force 文案明确）；
  - 切换弹窗只列非归档任务，旧注释改为“切焦点不停会话”。
- `panes/panes.ts`、`panes/model.ts`
  - 新增 `selectPaneSessions(sessions, 3)`：活跃优先、终态补足、最多 3 个；
  - 焦点切换时卸载旧 pane，按新焦点懒加载历史；历史返回时 pane 已卸载则丢弃；后台不建 DOM。
- `approval/approval.ts`、`approval/model.ts`
  - 全局队列读 `approvalsAll`，默认只看焦点；过滤开关；卡片显示 taskTitle + taskId；
  - `filterApprovals` / `buildTaskGrantAllAction`（纯逻辑，smoke 验证）；
  - 批量只发过滤结果 id；归档任务的审批会从可操作队列过滤；
  - 后台审批进入/裁决后重拉快照。
- `mock/data.ts`、`mock/engine.ts`、`hub.ts`
  - 旧 mock 快照补可选新字段（旧断言仍只读原字段）；新增 3 任务（1 archived）/每任务 2 会话/跨任务审批/4-of-8 配额的多任务世界；
  - mock engine 用 `allSessions/allApprovals` 保存全任务数据，`snapshot()` 只吐焦点 sessions/approvals；`resolveHub()` 在 mock 模式使用多任务世界（旧 smoke 仍显式用默认 2 任务）。
- `contract.ts`：只补本地类型再导出 `TaskCategory`（不触碰冻结的 `packages/shared-protocol/events.ts`）。
- `smoke.ts`：新增 41 条 P1-E 断言（见下）；旧 121 条断言原样保留。
- `styles.css`：任务看板/配额/归档折叠/任务操作/全局审批的样式。

文档/证据：

- `docs/done/P1-E.md`（本文件）
- `docs/PROGRESS.md` 追加
- `evidence/p1e-verify-all.txt`、`p1e-multitask.txt`、`p1e-migration.txt`、`p1e-electron-verify.txt`
- `evidence/p1e-smoke-red.txt`（改实现前的红测原始输出，25 条新断言失败）
- `evidence/p1e-ui-dom-check.txt`（额外 Electron mock 多任务 DOM 验收）
- `docs/logs/ui-verify.json`（Electron 复验）

## 怎么验证的

先写 smoke 新断言，在 P1-E 实现前跑出红（`evidence/p1e-smoke-red.txt`）：

```text
== P1-E 多任务看板 · 焦点缓存 / 后台计数 / 全局审批 ==
FAIL  P1-E：快照 approvalsAll 保留跨任务审批  └─ approvalsAll=undefined
FAIL  P1-E：任务看板渲染 2 个活跃任务  └─ active=undefined
FAIL  P1-E：后台在跑数只统计非焦点任务  └─ background=undefined
FAIL  P1-E：全局审批默认只看当前任务  └─ []
FAIL  P1-E：后台 session.upsert 只加计数、不进焦点列表  └─ sessions=2 A=2/2
FAIL  P1-E：归档焦点后 task=null  └─ multi-b
FAIL  P1-E：切焦点立即清空旧焦点缓存  └─ task=multi-a sessions=2
FAIL  P1-E：旧快照缺 quota 时明确为 null  └─ undefined
FAIL  P1-E：焦点最多 3 个 pane  └─ picked=0
...
25 FAILED
```

改完后（完整输出见 `evidence/p1e-verify-all.txt`）：

```text
$ npm run verify:all
52/52 + 16/16 + 17/17 + 19/19 + 90/90 + 148/148 + 49/49
+ renderer smoke 162/162
ALL PASS
--- exit=0 15:11:07 ---
```

统计：确定性 **391**（52+16+17+19+90+148+49）+ renderer smoke **162** = **553 PASS / 0 FAIL**。P1-E 前是 391 + 121 = 512；smoke **121 → 162（+41）**，R18/hardening 仍 148/49、未改。

新增 smoke 断言清单（41 条）：

```text
P1-E：快照 tasks 保留全量（含 archived）
P1-E：快照 approvalsAll 保留跨任务审批
P1-E：快照 quota 被 store 保存
P1-E：焦点 sessions 只含焦点任务
P1-E：任务看板渲染 2 个活跃任务
P1-E：任务看板有 1 个归档任务
P1-E：归档默认折叠
P1-E：归档展开后可见
P1-E：后台在跑数只统计非焦点任务
P1-E：焦点行被标出
P1-E：任务行带 category / running / total
P1-E：配额显示全局与每任务上限
P1-E：全局审批默认只看当前任务
P1-E：审批可一键看全部
P1-E：跨任务审批带任务标题
P1-E：批量放行默认只对焦点过滤结果发 id（不误放 A）
P1-E：批量动作只包含当前过滤结果
P1-E：scope=all 显式带焦点 taskId（不会跨任务）
P1-E：后台 session.upsert 只加计数、不进焦点列表
P1-E：后台会话转终态只减 running、不减 total
P1-E：后台 session.removed 只减 total
P1-E：后台 health 不进焦点 store
P1-E：后台 board.appended 不改焦点黑板
P1-E：后台归档不抢焦点
P1-E：后台归档仍更新 tasks 里的 archived
P1-E：归档焦点后 task=null
P1-E：归档焦点后会话/审批/黑板/健康全清
P1-E：切焦点立即清空旧焦点缓存
P1-E：快照 task=null 时焦点视图全空
P1-E：旧快照缺新字段不崩（approvalsAll 回退 approvals）
P1-E：旧快照缺 quota 时明确为 null
P1-E：焦点最多 3 个 pane
P1-E：pane 优先保留活跃会话
P1-E：焦点为 null / 无会话时 pane 选择为空（卸载不崩）
P1-E mock：3 个任务（含 1 个 archived）
P1-E mock：焦点任务 2 个会话、审批队列跨任务
P1-E mock：配额显示 4/8（归档不计入）
P1-E mock hub：首屏焦点 B、B 的 2 个会话
P1-E mock hub：切到 A 后快照换成 A 的 2 个会话
P1-E mock hub：切回 B 会话仍在（切题不停、懒加载重建）
P1-E mock hub：后台 A 的会话仍在跑
```

多任务后端回归（A–G 未改，未新增 H）：

```text
$ npm run verify:multitask
================ 174/174 通过 ================
--- exit=0 15:11:17 ---

$ npm run verify:migration
================ 44/44 通过 ================
--- exit=0 15:11:18 ---
```

Electron 真实主进程验收（保留原 26 条，未新增 Electron 断言）：

```text
$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
[verify] 26/26 通过，证据写入 D:\agent\xuanwo\docs\logs\ui-verify.json
--- exit=0 15:11:21 ---
```

额外 DOM 验收（`evidence/p1e-ui-dom-check.txt`）：用 Electron 加载 mock 多任务世界，真实 DOM 检查通过：

```text
初始：2 个活跃任务 + 1 个归档折叠；焦点 B；后台 2 个在跑；配额 4/8 · 每任务 2/3
审批：默认 1 条（B）；切“查看全部”后 2 条（A+B），taskTitle 正确
切焦点 A：焦点 A；后台仍 2；pane/tab 都是 mt-a1/mt-a2（旧 B pane 已卸载）
全部归档：0 个活跃行、3 个归档行、0 个 pane、0 条待批、焦点卡“无活跃任务”、扇出禁用、配额 0/8
DOM_CHECK_RESULT PASS
```

备份与范围：`.probe/backup-wp1/board.db` 仍为 348160 字节、sha256 `6d491f0b...ab5cf469`；P1-E 期间主进程 `hub.ts`/`board.ts`/`session/manager.ts`/`electron/main.ts`、冻结契约、R18/hardening、`verify-multitask.ts`、`package.json` 均未改（mtime 仍是 P1-D 之前）。临时 DOM harness 已删除。

## 没做什么 / 已知问题

### 已知中间状态

- **“上次焦点”仍未持久化**：重启按 P1-D 的 createdAt 最新非归档任务选焦点；P1-E 没有加设置项。
- **归档展示决策已定**：默认折叠、可展开；`tasks` 始终含 `archived:true`。展开区显示计数/答案等历史摘要，不加载完整会话流（完整流仍由切焦点后的 pane 懒加载提供；归档任务不可切焦点）。
- **`session.stop` / `interrupt` / `remove` / `setTier` 仍只允许焦点任务**（P1-C 遗留）。后台停止走 `task.stopAll` 或收敛；全局审批卡对后台项只保留逐条放行/拒绝，隐藏“本会话全部允许”，避免走后端会拒绝的路径。
- **后台审批的实时性**：主进程 `approval.upsert` 仍只推焦点。P1-E 在后台会话进入 `waiting_approval` 时重拉快照，并在用户裁决/批量/本任务放行后重拉；若某个后台审批没有伴随新的 `session.upsert`，最迟要等下一次快照/切焦点才出现在全局视图。没有加轮询。
- **跨任务 `permission.grantAll` 尚不可用**：Hub 的 P1-B 实现仍只取焦点任务、忽略 `taskId`。渲染层“本任务全部允许”显式带焦点 `taskId`，默认安全；“带 taskId 跨任务”需要 Lane A 后续改 Hub，本轮未越界。
- **焦点 pane 上限 3**：当焦点任务有超过 3 个历史会话时，只给 3 个建 pane（活跃优先，终态最近优先）；更多历史仍在快照/左栏会话列表，不建 DOM。这是 P1-E 的内存取舍。`CONV_WINDOW=120`、`MAX_BLOCKS=500` 保持原值未改。
- **`approvalsAll` 里仍可能保留归档任务的历史审批**：`store` 保留原始数据供审计/未来历史视图；审批 UI 已按 `tasks.archived` 过滤出可操作队列，不会误放。
- **旧快照兼容**：缺 `approvalsAll` 回退 `approvals`，缺 `quota` 显示“配额 —”，缺 counts 时焦点任务用当前 sessions 现算、其他任务退化为 0；不会崩。

### 其它边界

- **mock 配额是 4/8、每任务 2/3**：两个活跃任务各 2 会话，归档任务不计入全局；单任务 2/3 已接近每任务上限，但不是全局 8 的近满状态。真实配额显示由 P1-C Hub 的 `quota` 提供。
- **批量放行“看全部”时**：会按当前过滤结果放行多个活跃任务的审批；这是用户显式切换视图后的预期行为。默认视图仍只焦点，且测试明确断言不会误放 A。
- **任务看板每行操作在 240px 左栏**：按钮使用小号样式；窗口极窄时可能换行，但不会溢出隐藏。
- 没有改 `packages/shared-protocol/events.ts`；`TaskCategory` 只是 renderer 本地再导出。
- 没有改 `verify:all` 链；`verify:multitask` 仍单独跑，A–G 数量仍 174；没有新增 H 组（P1-E 的契约/渲染断言放在 renderer smoke 和额外 DOM 检查里）。
- 没有跑真实 agent、没有烧 token、没有改 `D:\agent\skill`、没有改 `docs/ARCHITECTURE.md`、没有改全局配置、没有删测试、没有自动提交 flag。

## 下一手需要什么

- 等你确认 P1-E 后进入 **WP2（技能与知识接入）**；本轮不开始 WP2。
- 可选 Lane A 后续（不在 P1-E 范围）：
  - 持久化“上次焦点”（当前 P1-D 按最新非归档任务选）；
  - 后台 `approval.upsert` 也推给渲染层，去掉对快照重拉的依赖；
  - 实现 `permission.grantAll` 的 `taskId` 跨任务语义，或明确只允许焦点。
- WP2 需要保持 `verify:all` ≥553 PASS、`verify:multitask` A–G 174/174、Electron `--verify` 26/26；不要回退 P1-E 的多任务看板/焦点隔离/全局审批默认过滤语义。
