# P1-A · 契约数据字段 + SQLite v1 迁移 + 配额配置

## 做了什么

只做数据层准备，不改任何运行时行为：给 `TaskView`/`ApprovalView`/`HubSnapshot`/`HubEvent` 补可选字段；给 `tasks` 表补 `category/priority/archived/updated_at` 四列并写 `PRAGMA user_version = 1`；给 `config/app.json` 加 `maxSessionsPerTask=3` / `maxSessionsTotal=8`（只加载、不执行）；新增 `verify:migration`，用合成旧库 + 真实备份副本验证迁移。

**行为变更：无（P1-A 不改行为）。** 切任务仍停会话、仍单焦点、仍不执行配额、仍不能归档；旧 UI/旧测试消费的字段语义全部不变。

## 改了哪些文件

源码/配置：

- `packages/shared-protocol/events.ts`：新增 `TaskCategory`；`TaskView` 加 `category/priority/runningSessions/totalSessions/updatedAt/archived/attachmentCount`（全部可选）；`ApprovalView.taskTitle?`；`HubSnapshot.approvalsAll?/quota?`；`HubEvent` 的 `session.removed/session.stream/board.appended/health` 加 `taskId?`。**没有新增任何 `HubAction` 成员。**
- `apps/desktop/src/main/blackboard/board.ts`：`tasks` 表 schema 补四列；`open()` 用 `PRAGMA user_version` + 逐列 `ALTER TABLE` + 事务 + 幂等；`createTask` 收可选 `category/priority`（默认 `unknown/0`）；`getTask/latestTask/listTasks` 返回 `category/priority/archived/updated_at`。未实现 `archiveTask`、未改任何停止会话逻辑。
- `apps/desktop/src/main/config/loader.ts`：`AppConfig` 加 `maxSessionsPerTask?/maxSessionsTotal?`，只解析正整数，非法值忽略。
- `config/app.json`：加 `maxSessionsPerTask: 3`、`maxSessionsTotal: 8`。

测试/脚本：

- `apps/desktop/src/cli/verify-migration.ts`（新增）：合成旧 schema 迁移、重复打开幂等、`createTask` 默认/显式字段、真实备份副本迁移、配额配置加载。
- `package.json`：新增 `"verify:migration": "node apps/desktop/src/cli/verify-migration.ts"`。
- `docs/plans/COMPETITION-READINESS.md`：§1.6 补 `evidence/phase0-verify-all.txt` 路径。

证据/备份（不是源码）：

- `.probe/backup-wp1/board.db`：真实运行库 `%APPDATA%\bumimang\workspace\board.db` 的备份，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，348160 字节；备份前后真实库 hash/大小/mtime 未变（无 `-wal`/`-shm`）。
- `evidence/phase0-verify-all.txt`：Phase 0 完整 `verify:all` 输出，500 PASS / 0 FAIL。
- `evidence/p1a-verify-all.txt`：P1-A 后完整 `verify:all` 输出，500 PASS / 0 FAIL。
- `evidence/p1a-migration.txt`：`verify:migration` 44/44 输出。
- `evidence/p1a-electron-verify.txt`：Electron `--verify` 26/26 输出。
- `docs/logs/ui-verify.json`：Electron 验收证据（26/26）。
- `docs/done/P1-A.md`：本文件；`docs/PROGRESS.md`：追加一行。

## 怎么验证的

```text
$ npm run verify:migration
...
PASS  迁移前旧库 user_version 为 0  — actual=0 expected=0
PASS  tasks 表补出 category 列
PASS  旧任务 category 默认 unknown  — actual="unknown" expected="unknown"
PASS  重复打开 user_version 仍为 1  — actual=1 expected=1
PASS  重复打开旧任务 updated_at 未被改写  — actual=1000 expected=1000
PASS  createTask 显式 category 生效  — actual="web" expected="web"
PASS  createTask 省略 priority 时默认 0  — actual=0 expected=0
PASS  真实备份迁移后任务数不变  — actual=15 expected=15
PASS  真实备份迁移后事实数不变  — actual=23 expected=23
PASS  真实备份迁移后会话数不变  — actual=30 expected=30
PASS  真实备份迁移后事件数不变  — actual=472 expected=472
PASS  真实备份迁移后 user_version 为 1  — actual=1 expected=1
PASS  config/app.json maxSessionsPerTask 加载为 3  — actual=3 expected=3
PASS  config/app.json maxSessionsTotal 加载为 8  — actual=8 expected=8

================ 44/44 通过 ================
exit=0
```

```text
$ npm run verify:all
...
================ 52/52 通过 ================
========== 16/16 通过 ==========
========== 17/17 通过 ==========
========== 19/19 通过 ==========
================ 90/90 通过 ================
========== 139/139 通过 ==========
================ 46/46 通过 ================
...
ALL PASS
--- exit=0 11:21:16 ---
```

379 条确定性 + 121 条 renderer smoke = **500 PASS / 0 FAIL**；完整输出见 `evidence/p1a-verify-all.txt`。

```text
$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
[verify] 26/26 通过，证据写入 D:\agent\xuanwo\docs\logs\ui-verify.json
exit=0
```

真实库未被测试改动：`%APPDATA%\bumimang\workspace\board.db` 与 `.probe/backup-wp1/board.db` 的 sha256 一致（`6d491f...cf469`），文件大小/时间一致；迁移只在临时副本上执行。

## 没做什么 / 已知问题

- **没有改 Hub**：`hub.ts` 仍是单 `taskId` + `settleCurrentTask` + 按当前任务过滤；`focusedTaskId`、`task.create/switch` 不停会话、`task.focus/archive/stopAll`、全局审批、按任务收敛、重启恢复全部任务都属于 **P1-B**。
- **没有加任何 `HubAction` 成员**，也没有改 `electron/validate-action.ts`；因此不存在新增 action 的 exhaustive switch 问题。`task.create` 仍只传 `title/brief`，`category/priority` 目前只能通过 `Blackboard.createTask` 直接调用（供 P1-B/测试用）。
- **配额只加载不执行**：`maxSessionsPerTask/maxSessionsTotal` 已在配置和 `AppConfig` 里，但 `session.start` 不检查；UI 也没有剩余配额显示。
- **没有实现归档**：`tasks.archived` 列已存在且默认 0，但没有 `archiveTask`/停止会话/活跃看板过滤逻辑。
- **契约字段是“空壳”**：`HubSnapshot.approvalsAll/quota`、`ApprovalView.taskTitle`、`TaskView.runningSessions/totalSessions/updatedAt/archived/attachmentCount` 已声明，但 Hub/renderer 尚未填充或消费；这是 P1-B/P1-E 的接口预留。
- `board.listTasks()` 返回的是原始 `archived: 0|1` 和 `updated_at`；P1-B 映射到 `TaskView.archived: boolean`/`updatedAt: number` 时要做转换，避免把 0/1 直接当 boolean 用。
- 迁移只覆盖 `tasks` 四列；`sessions.hidden` 的旧迁移保持原样；没有做 WP7 的自动备份/迁移失败回滚（本轮的备份是人工 `.probe/backup-wp1/`）。
- 没有跑真实 agent、没有烧 token、没有改 `D:\agent\skill`、没有改 `docs/ARCHITECTURE.md`、没有删测试、没有动 renderer/`verify-r18`/`verify-hardening`。
- 真实备份当前没有 `-wal`/`-shm`；如果以后有，`verify-migration.ts` 会按后缀一起复制，不会改备份。

## 下一手需要什么

- 等你确认 P1-A 后进入 **P1-B**：Hub 拆 `focusedTaskId`、`task.create/switch` 不再停会话、新增 `task.focus/archive/stopAll`、`session.start` 任意任务 + 配额执行、快照/审批/收敛按任务、重启恢复全部任务。
- P1-B 需要同时改 `packages/shared-protocol/events.ts` 的 `HubAction` 和 `electron/validate-action.ts`（这次 P1-A 故意没动），并改写 `verify-r18.ts` A 组、`verify-hardening.ts` §6 的断言语义；按约定不删测试。
- P1-B 需要把 `blackboard.listTasks()` 的 `archived/updated_at` 映射进 `TaskView`，并在 `task.upsert/session.upsert` 时维护 `runningSessions/totalSessions/updatedAt`。
- 需要你确认：P1-B 的 `task.create` 是否允许 UI 传 `category/priority`（P1-A 未加 action 字段）；如果允许，P1-B 一次加可选字段即可。
