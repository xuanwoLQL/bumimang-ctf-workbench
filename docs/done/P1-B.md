# P1-B · Hub 拆焦点 + 切题不停会话 + 快照兼容 + 最小渲染层防串台

## 做了什么

把 `HubService` 的单 `taskId` 拆成 `focusedTaskId`：`task.create` / `task.switch` / 新 `task.focus` 只切焦点，不再 `settleCurrentTask()`；新增 `task.stopAll` 显式停某任务的全部非终态会话；快照保持 `task/sessions/approvals/board/health` 的焦点语义，新增 `approvalsAll`、`quota`、任务 counts/archived 等字段；后台会话事件带 `taskId` 继续推，渲染层 store 丢弃非焦点事件。

**没有做**：配额执行、任意任务 `session.start`、按任务收敛、真正归档、启动恢复全部任务、任务看板/全局审批/配额展示（这些分别留 P1-C/P1-D/P1-E）。

## 行为变更

- **切题不再停会话**：`task.create` / `task.switch` / `task.focus` 只改 UI 焦点，旧任务会话继续 running。
- **显式停用 `task.stopAll`**：只停目标任务非终态会话，不影响其他任务；不归档、不改任务状态。
- `task.switch` 类型不变、语义改为只切焦点；`task.focus` 与其等价。
- **`session.start` / `session.prompt` / `session.stop` / `session.interrupt` 仍只允许焦点任务**；P1-C 才放开 `session.start` 任意任务。
- 旧 `verify-r18.ts` A 组、`verify-hardening.ts` §6 的断言按新语义改写，**没有删除测试**；R18 A 仍保留“旧 taskId 的 start/prompt/stop/interrupt 被拒绝”断言。

## 改了哪些文件

源码/契约：

- `packages/shared-protocol/events.ts`
  - `HubAction` 新增 `task.focus` / `task.stopAll` / `task.archive`（占位类型）；
  - `task.create` 加可选 `category?/priority?`；
  - `task.switch` 类型不变、注释改为只切焦点；
  - `permission.grantAll` 加可选 `taskId?`（P1-B 只透传，未做跨任务批量）。
- `apps/desktop/src/main/hub/hub.ts`
  - `focusedTaskId` + 配额上限字段（默认 3/8，仅展示）；
  - `task.create` / `task.switch` / `task.focus` 不停会话；
  - `task.stopAll`；`task.archive` 占位校验；
  - 快照 `tasks` 带 counts/archived/category/priority/updatedAt，`approvalsAll` 带 taskTitle，`quota` 填真实 running；
  - `session.upsert/stream/health` 后台事件带 `taskId` 推送；`approval.upsert` 仍只推焦点；`board.appended` 仍只推焦点；
  - `noteFlagCandidate(taskId, ...)` 按会话归属任务；后台候选不触发收敛、不推焦点 `task.upsert`。
- `apps/desktop/src/main/electron/validate-action.ts`
  - `task.create` 的 category 白名单 + priority 0–100 整数校验；
  - `task.focus` / `task.stopAll` / `task.archive`（`force?`）校验；
  - `permission.grantAll.taskId?` 校验。
- `apps/desktop/src/renderer/store.ts`
  - `session.removed` / `session.stream` / `health` / `board.appended` 带非焦点 `taskId` 时丢弃；`session.upsert` 保留原有焦点过滤。
  - 未改 `task.ts` / `panes.ts` / `approval.ts` / `main.ts`。

测试/脚本：

- `apps/desktop/src/cli/verify-multitask.ts`（新建）：A/B 两组 40 断言。
- `apps/desktop/src/cli/verify-r18.ts`：只改 A 组，改为“切焦点后旧会话仍 running；旧事件带 taskId；store 丢弃”；其它组未改。
- `apps/desktop/src/cli/verify-hardening.ts`：§6 改为“切焦点不停会话/不清授权；`task.stopAll` 才停并清授权”。
- `package.json`：`verify:multitask`。

文档/证据：

- `docs/decisions/D-multitask-focus.md`
- `docs/done/P1-B.md`（本文件）
- `docs/PROGRESS.md` 追加
- `evidence/p1b-multitask.txt`、`evidence/p1b-verify-all.txt`、`evidence/p1b-electron-verify.txt`
- `docs/logs/ui-verify.json`（Electron 复验）

## 怎么验证的

先写测试再改 Hub：`npm run verify:multitask` 在 P1-A 代码上是 **20/40**（`task.create` 仍停旧会话、`task.focus`/`task.stopAll` 未知动作）；改完 Hub 后 **40/40**。

```text
$ npm run verify:multitask
...
PASS  task.create(B) 后 A 的 2 个会话仍活跃  — actual=2 expected=2
PASS  任务 A runningSessions=2  — actual=2 expected=2
PASS  全局 quota.runningSessions=6  — actual=6 expected=6
PASS  切焦点后 A 的 2 个会话仍活跃  — actual=2 expected=2
PASS  task.switch 与 task.focus 等价
PASS  task.stopAll(A) 后 A 无活跃会话  — actual=0 expected=0
PASS  task.stopAll(A) 后 B 仍有 2 个活跃会话  — actual=2 expected=2
PASS  task.stopAll(A) 后 C 仍有 2 个活跃会话  — actual=2 expected=2

================ 40/40 通过 ================
exit=0
```

```text
$ npm run verify:all
52/52 + 16/16 + 17/17 + 19/19 + 90/90 + 148/148 + 49/49
+ renderer smoke ALL PASS
= 512 PASS / 0 FAIL，exit=0
```

其中 R18 从 139→**148/148**（只改 A 组语义，新增 taskId/store 断言），hardening 从 46→**49/49**（§6 三条新语义断言）。

```text
$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
[verify] 26/26 通过
exit=0
```

证据：`evidence/p1b-verify-all.txt`、`evidence/p1b-multitask.txt`、`evidence/p1b-electron-verify.txt`。

## 没做什么 / 已知问题

- **P1-B 不改行为之外的东西**：`session/manager.ts`、`electron/main.ts` 启动恢复、`board.ts` 的 `archiveTask`、renderer 的 `task.ts/panes.ts/approval.ts/main.ts` 都没动。

### 已知中间状态

- **后台会话在 UI 看不到**：P1-B 没有任务看板；后台流/健康/状态事件被 store 丢弃。P1-E 再做任务看板/懒加载。
- **`session.start` / `prompt` 仍只允许焦点任务**：想给后台任务加会话或发提示，要等 P1-C；P1-B 的 3 任务测试是“逐个切焦点后各自起会话”。
- **配额只展示不执行**：`quota` 已填真实值（3/8、running=6），但第 4 个会话不会被拒；P1-C 执行。
- **启动恢复仍只恢复最近任务**：`electron/main.ts` 未改；重启后切到其它任务时，`loadTaskSessions` 可能把库里的非终态会话按 stopped 载入（P1-D 统一恢复全部任务）。
- **审批事件仍只推焦点**：`approvalsAll` 只在快照里；全局审批视图/P1-E。

### 其它已知问题

- **`task.archive` 是占位**：有活会话且 `force!==true` 返回可读错误；即使 `force=true` 也返回“P1-D 才实现”，不会真正归档。
- **按任务收敛未做**：后台候选不触发 R24；焦点任务保留原行为。
- `task.stopAll` 的进程退出/状态落库是异步的；测试用 `waitFor` 等 A 的活跃数归零，不把“stopSession 返回”当“进程已退出”。
- `publishSessionRec` P1-B 会推后台会话事件，主进程侧不再过滤；这是有意的，靠 store 丢弃。若未来有其它订阅者（非 renderer），需要自己按 `taskId` 过滤。
- 没有跑真实 agent、没有烧 token、没有改 `D:\agent\skill`、没有改 `docs/ARCHITECTURE.md`、没有删测试。

## 下一手需要什么

- 等你确认 P1-B 后进入 **P1-C**：`session.start` 任意任务、配额执行（每任务 3/全局 8）、按任务收敛；需要改 `session/manager.ts`（本轮按约定没碰）。
- P1-D：启动恢复全部非归档任务、真正 `archiveTask`/看板过滤、按任务 stale lease/intent。
- P1-E：任务看板、后台在跑提示、全局审批视图、配额显示；届时 `store` 的丢弃逻辑要配合 pane 懒加载。
- P1-C/P1-D 改完后需要重新跑 `verify:multitask`（扩 C–H 组）和全量；P1-B 的 A/B 应保持绿。
