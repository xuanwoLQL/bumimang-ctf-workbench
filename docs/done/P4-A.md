# P4-A · targets 数据模型 + 契约 + 快照 + validate-action

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP4；`docs/plans/COMPETITION-READINESS.md` §7.3（数据模型）/§7.5（测试计划）/§12（阶段门禁）；`docs/done/WP3-artifacts.md`（WP4 交接章节）；`docs/decisions/D-multitask-focus.md`、`D-attachments.md`、`D-evidence-replay.md`、`D-artifact-ipc.md`
> 日期：2026-10-23
> 状态：**P4-A 完成**。这是 WP4 的第一个子步骤；**没有改策略引擎、没有做目标解析/CIDR 匹配、没有做代理、没有做目标面板 UI**。

---

## 做了什么

把「授权目标是显式任务数据」这一层落地，严格只做数据与契约：

- **SQLite v1 → v2**：新增 `targets` 表（`id/task_id/value/kind/status/notes/created_at`，`UNIQUE(task_id,value)`），`tasks` 补 `deny_targets`（默认 `'[]'`）/`scope_notes`；旧库在同一次 `open()` 里先走 v1 再走 v2，重复打开幂等。
- **契约加法**：新增 `TargetView` / `TargetKind` / `TargetStatus`；`TaskView.targets?` / `denyTargets?` / `scopeNotes?`；`HubAction.target.add/update/remove`。没有新增必填字段，没有改现有 action 语义。
- **Board API**：`addTarget/removeTarget/updateTarget/listTargets/getTarget/getTaskScope`；目标写入走黑板的三写一事务（targets 行 + `events` 生命周期事件 + `audit` 索引）。
- **Hub**：`target.*` 动作做数据 CRUD，成功后焦点任务推 `task.upsert`（带 `targets`）；焦点快照填 `targets/denyTargets/scopeNotes`，`tasks` 列表不重复搬完整目标列表。
- **validate-action**：`target.add` 校验 taskId/value/kind/notes，`target.update/remove` 校验 targetId；支持可选的只读查询上下文做「任务存在且未归档 / targetId 属于该任务」的语义校验。生产路径未改 `electron/main.ts`（不在 P4-A 允许文件清单内），语义检查由 Hub/board 兜底。
- **验收**：`verify:migration` 44 → **73/73**；新增 `verify:scope` **80/80**（A 组，只测目标 CRUD）；`verify:all` 仍 **607/0**；artifacts **324**、skills **149**、multitask **174**、Electron **26**。
- **红测**：`verify:migration` 实现前 **46/73**（旧 44 条 + 2 条新断言通过，27 条 v2 断言失败）；`verify:scope` 实现前 **8/27**（缺 API，后续断言未跑到）。

**关键取舍**

- 目标本体进 SQLite（与附件放磁盘不同）：目标需要按任务过滤、唯一约束、跨重启保留，且后续策略判定要按 taskId 查。
- `denyTargets/scopeNotes` 本轮**只读**：没有 `target.deny.*` 动作、没有 UI；P4-A 不允许改 `config/**`/`renderer/**`，写入接口留到 P4-C/P4-D 前评估。
- 目标值只 trim、只做长度/kind 校验；**不做 IP/CIDR/URL 解析、不做 CIDR 包含、不做 IP 校验**（P4-B）。
- `target.*` 不经过策略引擎：它是人工维护范围数据的 CRUD，不是 agent 动作；P4-C 才让策略消费这些数据。
- 非焦点任务的 target 变更只落库、不推 `task.upsert`：与 P1-C 的后台事件规则一致，切焦点后由快照呈现。

---

## 改了哪些文件

源码：

- `apps/desktop/src/main/blackboard/board.ts`
  - 新增 `Target` 接口与目标常量；`open()` 在 P1-A v1 迁移之后**追加** v2：按 `PRAGMA table_info(tasks)` 补 `deny_targets/scope_notes`，`CREATE TABLE IF NOT EXISTS targets` + `idx_targets_task`，`PRAGMA user_version = 2`。
  - P1-A 的 v1 迁移逻辑原文未改；v2 只在 `user_version < 2` 时执行。
  - 新增 `listTargets/getTarget/getTaskScope/addTarget/updateTarget/removeTarget`；**没有改** `createTask/archiveTask/listTasks/getTask` 的签名/返回语义。
  - 目标写入在 `tx()` 内同时写 targets 行、`events`（`kind=lifecycle`，body `target.added/updated/removed`）与 `audit`（`target.add/update/remove`）；没有新增 `EventKind`，避免动 `BoardEventView` 的冻结联合类型。
- `packages/shared-protocol/events.ts`
  - 新增 `TargetKind` / `TargetStatus` / `TargetView`。
  - `TaskView` 追加可选 `targets? / denyTargets? / scopeNotes?`。
  - `HubAction` 追加 `target.add`（taskId/value/kind?/notes?）、`target.update`（taskId/targetId/status?/notes?）、`target.remove`（taskId/targetId）。**没有新增 HubEvent**，复用 `task.upsert`。
- `apps/desktop/src/main/electron/validate-action.ts`
  - `target.add`：taskId ≤128、value 非空/≤256/不含 NUL/两端 trim、kind ∈ host/cidr/url、notes ≤4096；可选 ctx 校验任务存在且未归档。
  - `target.update`：taskId/targetId、status ∈ unknown/alive/owned、notes ≤4096；可选 ctx 校验 targetId 属于该任务。
  - `target.remove`：taskId/targetId；可选 ctx 校验归属。
  - 现有 action 分支与错误文案未改；`validateHubAction` 第二参可选，旧调用方不受影响。
- `apps/desktop/src/main/hub/hub.ts`
  - `fillTaskView` 增加 `withTargetScope`（默认 false）：焦点任务填 `targets/denyTargets/scopeNotes`，其他任务不填；附件既有行为不变。
  - `snapshot().task`、`currentTaskView()`、焦点 `task.upsert` 带目标；`tasks` 列表不带完整列表。
  - `dispatch` 新增 `target.add/update/remove`：调 board → 出错返回可读 error → 成功 `emitTaskById`（焦点才推）。
  - **未改**焦点/归档/配额/收敛/flag 候选/审批过滤逻辑。
- `apps/desktop/src/cli/verify-migration.ts`
  - 原有 44 条断言保留；`user_version` 期望从 1 改为 2（这是 v2 迁移的必然行为变更，见“行为变更”）。
  - 新增 v0 → v2、v1 → v2、targets 表/空表、`deny_targets` 默认 `'[]'`、`scope_notes` 默认 NULL、重复打开幂等、新任务默认值、真实备份副本迁移后 targets 为空且旧数据不丢。
- `apps/desktop/src/cli/verify-scope.ts`（新增）
  - A 组：`target.add/update/remove` 走 Hub；焦点快照字段；非法 taskId/targetId/value/kind/notes；归档任务不能加目标；跨任务隔离；同值不同任务可共存；`denyTargets/scopeNotes` 读取；审计/事件；旧 `TaskView` 无 `targets` 兼容。
- `package.json`：新增 `"verify:scope": "node apps/desktop/src/cli/verify-scope.ts"`；**没有**并入 `verify:all` 链。

文档/证据：

- `docs/done/P4-A.md`（本文件）、`docs/PROGRESS.md`（追加一行）。
- `evidence/p4a-verify-all.txt`、`p4a-artifacts.txt`、`p4a-skills.txt`、`p4a-multitask.txt`、`p4a-migration.txt`、`p4a-scope.txt`、`p4a-migration-red.txt`、`p4a-scope-red.txt`、`p4a-electron-verify.txt`。
- 备份：`.probe/backup-wp1/board.db` 未动（sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，348160 B）。

---

## 怎么验证的

### 1. 迁移（v0 → v1 → v2 / v1 → v2 / 真实备份）

```text
$ npm run verify:migration
...
PASS  v2 迁移创建 targets 表
PASS  v2 迁移后 targets 为空  — actual=0 expected=0
PASS  旧任务 deny_targets 默认 '[]'  — actual="[]" expected="[]"
PASS  旧任务 scope_notes 默认 NULL  — actual=null expected=null
PASS  迁移后 user_version 为 2  — actual=2 expected=2
PASS  重复打开 user_version 仍为 2  — actual=2 expected=2
PASS  v1 库迁移后 user_version 为 2  — actual=2 expected=2
PASS  v1 库迁移后任务数不变  — actual=2 expected=2
PASS  v1 库迁移后事实数不变  — actual=3 expected=3
PASS  v1 库迁移后会话数不变  — actual=2 expected=2
PASS  真实备份迁移后任务数不变  — actual=15 expected=15
PASS  真实备份迁移后事实数不变  — actual=23 expected=23
PASS  真实备份迁移后会话数不变  — actual=30 expected=30
PASS  真实备份迁移后事件数不变  — actual=472 expected=472
PASS  真实备份迁移后 user_version 为 2  — actual=2 expected=2
PASS  真实备份迁移后 targets 为空  — actual=0 expected=0

================ 73/73 通过 ================
exit=0
```

红测（实现前，同一套件）：`46/73 通过`，27 条 v2 断言失败；证据 `evidence/p4a-migration-red.txt`。

### 2. 目标 CRUD（A 组）

```text
$ npm run verify:scope
...
PASS  A（后台任务）可以加目标
PASS  后台任务加目标不推 task.upsert
PASS  焦点任务加目标推 task.upsert
PASS  焦点快照带 2 个 targets
PASS  target 默认 status=unknown
PASS  切到 A 后焦点 targets 是 A 的 1 个
PASS  B 的目标没有混进 A
PASS  不同任务可以使用相同的目标值
PASS  更新目标状态/备注成功
PASS  跨任务更新 target 被拒
PASS  移除目标成功
PASS  重复移除被拒
PASS  跨任务移除 target 被拒
PASS  validate：target.add 空 value 被拒
PASS  validate：target.add 超长 value 被拒
PASS  validate：target.add 非法 kind 被拒
PASS  validate：target.add 超长 notes 被拒
PASS  validate：target.add 不存在的任务被拒
PASS  validate：归档任务不能加目标
PASS  Hub：归档任务不能加目标
PASS  新任务 denyTargets 默认空数组
PASS  denyTargets 从库里读出 2 条
PASS  scopeNotes 从库里读出
PASS  损坏的 denyTargets JSON 不炸，按空数组
PASS  target.add/update/remove 写审计与 events

================ 80/80 通过 ================
exit=0
```

红测（实现前）：`8/27 通过`；缺 `target.*` action 与 `listTargets`，后续断言因 API 缺失提前中断。证据 `evidence/p4a-scope-red.txt`。

### 3. 全量回归

```text
$ npm run verify:all
================ 52/52 通过 ================
========== 16/16 通过 ==========
========== 17/17 通过 ==========
========== 19/19 通过 ================
================ 90/90 通过 ===============
========== 148/148 通过 ==========
================ 49/49 通过 ================
...
ALL PASS
（607 PASS / 0 FAIL = 确定性 391 + smoke 216）
```

```text
$ npm run verify:artifacts   → 324/324
$ npm run verify:skills      → 149/149
$ npm run verify:multitask   → 174/174（单跑；F 组同毫秒排序 flaky，见已知问题）
$ npm run verify:migration   → 73/73
$ npm run verify:scope       → 80/80
Electron --verify            → 26/26
```

完整输出见 `evidence/p4a-*.txt`。证据 sha256：

| 文件 | sha256 |
|---|---|
| `evidence/p4a-verify-all.txt` | `338013654e621688c58cd7f39737704b5664098f32d5405f34ff9bcbec8d8e04` |
| `evidence/p4a-artifacts.txt` | `ce7e3205eaca7708cfe814525f1879382383cc207723d473981529dac1f8480b` |
| `evidence/p4a-skills.txt` | `4d6ae738a7c67bc0f22f1e4d5d8497acfb1930dd69454873d1858dcbee7b35a9` |
| `evidence/p4a-multitask.txt` | `2efb2c790562f4a83805ee890835192ee97bf3faa4a4a24d7f2c621b5ee6ef25` |
| `evidence/p4a-migration.txt` | `d5b0ab712ede76655a6948ed018e52c5eb136ac96824825e96c9dd759913dcb5` |
| `evidence/p4a-scope.txt` | `bb54f934c97883b6ca7d2100a97d4795c70e9478e8ab4ab371620d0e0b38b60f` |
| `evidence/p4a-migration-red.txt` | `5e068967869d2781166605c017096405d4ca239e6f34f048d99bddc9e64c0113` |
| `evidence/p4a-scope-red.txt` | `763872610c60b9532426b44b25745e82055dc7ed3cf7922d1f13dbd23ce30a32` |
| `evidence/p4a-electron-verify.txt` | `4c9df181d227838f0767f6a927dddb26896ff05d44634fe9ff353035c43f0fcb` |

### 4. 文件收口

- `policy/engine.ts` 未改：sha256 `a7377d31992585b377fafefcdded6bb38a0a09e1873a1e8d081fb3e12696ed52`。
- `session/manager.ts`、`mcp-host/bridge.ts`、`briefing/**`、`skill/**`、`renderer/**`、`config/**`、`rules/competition.json`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify-skills.ts`、`verify-artifacts.ts`、`smoke.ts`、`mock/**` 均未改。
- `electron/main.ts` 曾在实现 validate-action 语义校验时临时改过 2 行，发现超出 P4-A 允许文件清单后已**逐字回退**；最终内容与改动前一致（sha256 `e8a91c82907c774e108ad5d51f6077cdf351117b729e8e4ee506ed34249ef6f9`），仅 mtime 变化。最终生产路径不依赖 main.ts 注入校验上下文。

---

## 行为变更

> 与 WP1 的四个行为变更、WP2 的加法、WP3 的契约/E2/回放/refresh 并列。P4-A 是“加法 + 一次 SQLite 版本升级”。

1. **契约新增（全部可选/加法）**：`TargetView` / `TargetKind` / `TargetStatus`；`TaskView.targets?` / `denyTargets?` / `scopeNotes?`；`HubAction.target.add/update/remove`。没有新增必填字段、没有新增 `HubEvent`、没有改现有 action 语义。旧渲染层/旧 mock/旧快照不读新字段仍工作。
2. **SQLite `user_version` v1 → v2**：新增 `targets` 表与 `tasks.deny_targets/scope_notes` 两列。旧库 v0 → v1 → v2 在同一次 `open()` 内走完；v1 库直接 v1 → v2；重复打开不重复 ALTER/CREATE。WP5 的 flag 表仍应使用 v3，不被本步占用。
3. **快照按焦点任务带 targets**：`HubSnapshot.task.targets` 与 `denyTargets/scopeNotes` 只给焦点任务；`tasks` 数组不重复搬完整目标列表，避免一次快照 N 份。后台任务的目标变更只落库，切焦点后的快照呈现。
4. **目标 CRUD 不经过策略判定**：`target.*` 是人工维护范围数据的动作；策略引擎、`rules/competition.json`、`acp/client.ts`、`session/manager.ts` 均未改。**不在 targets 里的动作仍按原策略走，不会自动 block**（P4-C）。
5. **迁移测试的版本期望更新**：`verify-migration` 原有 44 条断言全部保留，其中 `user_version` 的期望值从 1 改为 2；数据不丢的断言（任务/事实/会话/事件数量）未改。总断言 44 → 73（+29 条 v2/幂等/v1 夹具/真实备份断言）。

---

## 已知中间状态 / 已知问题

1. **策略不判定（P4-C）**：目标数据已能 CRUD，但不在 `targets` 里的目标仍按原策略走，不会自动 `block`；`denyTargets` 目前只是数据，不参与任何判定。
2. **不做目标解析（P4-B）**：命令/审批文本里的 IP/CIDR/URL 不会被提取；`value` 原样保存（仅 trim），没有 URL/host:port 规范化。
3. **不做 CIDR 匹配（P4-B）**：`targets` 只存值，不做包含判断、边界地址、IPv6 拒绝等；`kind=cidr` 只是标签。
4. **不做代理（P4-D）**：不注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`，不改系统代理/防火墙。
5. **validate-action 是两层校验**：结构层在 `validate-action.ts`（value/kind/notes/targetId 等）；语义层（taskId 存在且未归档、targetId 属于该任务）在 Hub/board 的 `target.*` dispatch 路径。`validateHubAction` 支持可选的只读 ctx，单测/嵌入式调用可提前查库；生产 IPC 未注入 ctx（`electron/main.ts` 不在 P4-A 允许改动面内），因此语义拒绝发生在 Hub/board，错误仍可读、不会崩。**不是“校验器已经查库”的单一实现**，后续若要把语义校验前移到 IPC，只需在 main.ts 注入 ctx。
6. **denyTargets/scopeNotes 只读**：P4-A 没有 `target.deny.add/remove` 或 `task.scope.update` 动作，也没有 UI；本轮只能通过数据库/后续动作写入。测试用 `UPDATE tasks` 验证读取与损坏 JSON 回退。
7. **非焦点任务目标变更无实时事件**：与 P1-C 的后台事件规则一致，只落库；切焦点后的快照才带 targets。没有新增 `target.updated` HubEvent。
8. **目标值不做语义去重**：`UNIQUE(task_id,value)` 是字符串级；`10.0.0.1` 与 `10.0.0.1:80`、大小写不同的 URL 会被视为不同值。规范化留 P4-B。
9. **multitask F 组 flaky（既有）**：`listTasks()` 同毫秒创建无 tie-break，F 组期望 `cId` 最新；本轮多次复跑出现 173/174，重跑后 174/174。P4-A 未改 `verify-multitask.ts`/排序逻辑；按 WP3 交接留 WP6 修（`created_at DESC, id DESC` 或显式 seq）。
10. **`electron/main.ts` mtime**：临时改动已逐字回退，内容 hash 与改动前一致；如果只看 mtime 会看到本轮时间，这是回退留下的痕迹，不是行为变更。
11. **没有迁移回滚/备份轮转**：v2 迁移失败会整体回滚事务；但没有自动备份旧库（WP7 规划）。真实备份副本测试始终用临时复制，未改 `.probe/backup-wp1/board.db`。
12. **没有 UI/目标面板**：目标只能通过快照/CLI/Hub 查看；创建任务弹窗没有目标输入（P4-D）。旧渲染层不读 targets 也能工作。

---

## 下一手需要什么

- **P4-B（目标解析/CIDR 匹配）**：新建 `main/scope/**`，消费 `TargetView.value/kind` 与 `getTaskScope()`；不要改 board 的 v2 schema（除非需要新列，先写迁移 v3 协调 WP5）。建议先锁 `verify-scope` A 组 80 条绿，再加 B 组解析/边界测试。
- **P4-C（策略判定）**：先读 `policy/engine.ts` 现有 `RuleMatch/evaluate`（本文件基线：`action/command_regex/text_regex/tool_regex`，block 优先）；加 `out_of_scope/target_regex` 时保持 block 机制写死、规则包内容数据化；`rules/competition.json` 的 `no-out-of-scope` 在 P4-C 加。
- **P4-D（代理/UI/config）**：代理默认关、只注入环境变量；目标面板/创建任务目标输入；`config/**` 的 scope/proxy 段。不要把 P4-A 的 `validateHubAction` 可选 ctx 当成“已强制拦截”。
- 保持门禁：`verify:all` **607**、artifacts **324**、skills **149**、multitask **174**（单跑）、migration **73**、scope **80**、Electron **26**；`verify:scope` 保持独立，不并入 `verify:all`。
- 若 WP5 需要 `flag_candidates` 表：`user_version` 用 **v3**，不要回退/跳版本；迁移仍在 `open()` 内按版本顺序追加。
