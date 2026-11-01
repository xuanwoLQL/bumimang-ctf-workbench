# P5-D · flag 提交（manual/dry-run）+ 记分板

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP5；`docs/plans/COMPETITION-READINESS.md` §8.4/§8.5/§8.6；`docs/done/P5-A.md`、`P5-B.md`、`P5-C.md`；`docs/decisions/D-multitask-focus.md`
> 日期：2026-10-24
> 状态：**批次 1 + 批次 2 完成**。批次 1 做后端 `flag.submit`（manual/dry-run/拒 command）+ 记分板 + 导出补提交字段 + D 组验收；批次 2 做 renderer 提交弹窗（manual + dry-run 预览 tab）+ 记分板 UI + mock 世界 + smoke。**没有实现 command 模式、没有调平台 API**。批次 2 完成后停下来等确认，不进 P5-E。

---

## 做了什么

- **契约（只加可选/新变体）**：
  - `HubAction.flag.submit { taskId, candidateId, mode?: "manual" | "dry_run" }`；
  - 新增 `ScoreboardView { tasks[{taskId,title,status,points,flagCount}], solved, total, points }`；
  - `TaskView.points?: number`、`TaskView.submitMode?: "manual"`；
  - `HubSnapshot.scoreboard?: ScoreboardView`；
  - `ActionResult` 追加可选 `mode?: "manual" | "dry_run"`、`value?`、`instructions?`、`argv?: string[]`（复用 P5-C 的 `content?`）；
  - `FlagCandidateView.submittedAt?` / `submitStatus?` 原本已有；**`submitStatus` 的可选 union 追加了 `"manual"`**（见“契约偏差”）。
  - 没有新增 HubEvent；`flag.updated` 复用 P5-C。
- **board.ts（不改表/不改 v1-v3 迁移）**：
  - `updateFlagSubmitStatus(candidateId, "manual" | "dry_run", submittedAt?)`：只更新 `flag_candidates.submitted_at/submit_status`；写一条 `lifecycle` 事件（`what=flag.submit`）+ audit；事件/审计只记 candidateId/status，不写 flag 明文。
  - `getScoreboard()`：只读聚合全部任务（含归档）的 `points`、`flagCount`（候选总数）、`solved/total/points`；不写表。
  - `getTask`/`listTasks` 的 SELECT 增加 `points, submit_mode, submit_command, submit_timeout_ms`（P5-A 已加的列，P5-D 只读）。
  - **没有新列/新表；`PRAGMA user_version` 仍 3；v1/v2/v3 迁移未改。**
- **hub.ts**：
  - `flag.submit`：
    * `manual`（缺省）：校验任务未归档、候选属于 taskId、候选不是 `false_positive`；更新候选 `submitted_at/submit_status="manual"`；返回 `{ ok, mode:"manual", value, instructions }`；**不执行命令、不调用平台 API、不改 task.status/answer**；广播 `flag.updated`。
    * `dry_run`：只返回 `{ ok, mode:"dry_run", argv }`；argv 由 `tasks.submit_command`（JSON argv 数组或空白分隔，支持 `{flag}/{value}/{taskId}` 占位）构造；**不启动进程、不写文件、不改候选状态、不写 flag.submit 事件**。未配置 `submit_command` 时 argv=`[flag 值]`。
    * `command`：运行时明确拒绝，错误 `command 模式未实现（用户决策：WP6 评估前不做）`；候选不变。
  - 快照增加 `scoreboard: this.board.getScoreboard()`；`TaskView` 填 `points`/`submitMode`。
  - `flag.export` 的 md/csv 输出补 `submit_status`：CSV 表头保持不变（不破坏 P5-C C4 断言），在 `submittedAt` 单元里追加 status；MD 在“已提交”单元追加 status；JSON 原本已有 `submitStatus/submittedAt`。
  - **没有改 `flag.confirm/reject/export` 的既有语义、`task.setStatus`、焦点/归档/配额/收敛。**
- **validate-action.ts**：
  - `flag.submit` 结构校验 `taskId/candidateId`，可选 `ctx.task`/`ctx.candidate` 做存在/归档/归属校验；
  - `mode` 只允许 `manual/dry_run`；`command` 在 IPC 入口直接抛可读错误 `command 模式未实现（用户决策：WP6 评估前不做）`；其他非法值给出可读错误。
- **verify-flags.ts**：A44+B23+C81 **原样保留**；新增 D 组 **66 条**，总数 **148 → 214**。

**关键取舍**

- **不做 command 模式**：不引入 `child_process`/`spawn`/`exec`；dry-run 只构造字符串数组；manual 只返回数据 + 记录时间。没有平台 API 调用。
- **manual 不改任务状态**：提交只影响候选的 `submitted_at/submit_status`；任务 solved/answer 仍由 confirm/task.setStatus 决定。
- **dry-run 不落库**：虽然 board API 支持 `"dry_run"` 状态，但 Hub 的 dry-run 分支不调用它；D 组明确断言候选状态不变、无事件、无文件。
- **记分板包含归档任务**：历史积分仍算；`flagCount` 是三态候选总数；points 优先读 `tasks.points`，默认 0。
- **CSV 表头不变**：为保持 P5-C C4 的精确表头断言，submit_status 追加在 `submittedAt` 单元里；MD/JSON 也带提交字段。
- **契约偏差（需确认）**：`FlagCandidateView.submitStatus` 原本已有，但 union 没有 `"manual"`。P5-D 必须把新状态值追加到可选 union，否则 manual 状态无法进入快照/导出 UI。这是向后兼容的字面量追加；如果你要求 submitStatus 字面完全不改，请在批次 2 前说。

---

## 改了哪些文件

- `packages/shared-protocol/events.ts`
  - `flag.submit` action、`ScoreboardView`、`TaskView.points/submitMode`、`HubSnapshot.scoreboard`、`ActionResult` 可选提交字段、`FlagCandidateView.submitStatus` 追加 `"manual"`。
- `apps/desktop/src/main/blackboard/board.ts`
  - `updateFlagSubmitStatus`、`getScoreboard`；`getTask/listTasks` SELECT 扩展（无 schema 变更）。
- `apps/desktop/src/main/hub/hub.ts`
  - `flag.submit`、`buildSubmitArgv`、快照 `scoreboard`、`toTaskView` points/submitMode、导出补提交字段。
- `apps/desktop/src/main/electron/validate-action.ts`
  - `flag.submit` 结构/语义校验 + command 可读拒绝。
- `apps/desktop/src/cli/verify-flags.ts`
  - A/B/C 原样；新增 D 组 66 条（readFileSync import）。
- `docs/done/P5-D.md`（本文件）、`docs/PROGRESS.md`。

**明确未改**：

- `apps/desktop/src/main/mcp-host/**`、`session/manager.ts`、`policy/**`、`acp/**`、`scope/**`、`briefing/**`、`skill/**`、`artifacts/**`、`evidence/**`、`approval/queue.ts`、`config/**`、`rules/**`、`electron/main.ts`
- `renderer/**`（批次 2）、`smoke.ts`、`mock/**`
- `verify-gate/hardening/r18/multitask/skills/artifacts/scope/migration`、`verify:all` 链、`package.json`
- `D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置
- `.probe/backup-wp1/board.db`（sha256 仍 `6d491f0b…ab5cf469`）

---

## 怎么验证的

### 红测

先写 D 组，未实现时：

```text
evidence/p5d-b1-flags-red.txt → 167/214，47 FAIL
FAIL  D1 scoreboard.total=3  — actual=undefined expected=3
FAIL  D1 TaskView A submitMode  — actual=undefined expected="manual"
FAIL  D2 manual 返回 ok  — {"ok":false,"error":"未知动作：flag.submit"}
FAIL  D2 候选 submit_status=manual  — actual=null expected="manual"
FAIL  D3 dry-run argv 是数组
FAIL  D4 command 错误可读  — 未知动作：flag.submit
FAIL  D5 csv 含 submit_status=manual
FAIL  D7 validate command 被拒且可读  — 未知动作类型：flag.submit
FAIL  D8 hub flag.submit 代码块存在  — start=-1
...
```

A44+B23+C81 在红测中全绿（167 = 148 + D 组本来就能过的 19 条）；47 条红全部属于 D 组。

### 绿测

```text
npm run verify:flags     → 214/214（A44 + B23 + C81 + D66），exit=0
npm run verify:all       → 665 PASS / 0 FAIL（确定性 391 + smoke 274），exit=0
npm run verify:gate      → 52/52
npm run verify:scope     → 308/308
npm run verify:migration → 127/127
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（首次 173/174 是既有 F 组同毫秒排序 flaky；复跑绿）
Electron --verify        → 26/26
```

D 组覆盖：

- 记分板：total/solved/points、各任务 points/flagCount/status、TaskView.points/submitMode、board.getScoreboard 直连；
- manual：mode/value/instructions、候选 submitted_at>0/submit_status=manual、task.answer/status 不变、events/audit `flag.submit` 不含 flag 明文、`flag.updated` 带 submittedAt/submitStatus；
- dry-run：mode=dry_run、argv 数组、候选状态不变、无 flag.submit 事件、无文件写出；
- command：ok=false、错误含 `command 模式未实现`、候选不变；
- 导出：CSV/MD 含 `manual` 与 submittedAt，JSON submitStatus/submittedAt；
- 跨任务隔离：A 提交不影响 B；记分板 points/solved 不被提交改变；
- validate-action：manual/dry_run 通过、command 可读拒绝、缺 candidateId 拒绝、ctx 归属校验；
- 源码硬查：`hub flag.submit` / `buildSubmitArgv` / `board updateFlagSubmitStatus` / `validate flag.submit` 四个代码块对 `child_process|spawn|exec|fetch|http.request|axios` 零命中；三个文件 `child_process` 零命中。

### 硬查证据

`evidence/p5d-b1-hard-check.txt`（真实输出）：

```text
hub flag.submit block bytes: 1875
buildSubmitArgv bytes: 613
board updateFlagSubmitStatus slice bytes: 3000
validate flag.submit block bytes: 773
hub flag.submit forbidden hits: []
buildSubmitArgv forbidden hits: []
board submit API forbidden hits: []
validate submit forbidden hits: []
child_process in hub/board/validate: 0,0,0
```

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p5d-b1-flags-red.txt` | 167/214（47 FAIL，D 组红） | `8fa886a5402684dce198ce98b28e315ffd09792fc0a08ab653470f269ca4cd6b` |
| `evidence/p5d-b1-flags.txt` | 214/214 | `001255351e15b334d0764ede4e0d5e8dd209dfdc8095fe71a0311fa13bfdeba2` |
| `evidence/p5d-b1-verify-all.txt` | 665/0 | `c65bf41aea5511b79b20f0ee3d78458f556bdc451cf608139201b8f5d958329c` |
| `evidence/p5d-b1-gate.txt` | 52/52 | `33145b3fff0baff18586a0240dab341c5bfd1765560972a5905f24923ca321a5` |
| `evidence/p5d-b1-scope.txt` | 308/308 | `c205941c33fe5ac6739c5c90e7bab79aac0f48217ec41b3249cb149a56cdfaf7` |
| `evidence/p5d-b1-migration.txt` | 127/127 | `891df76a147dd974d3d639fd4a8f24e43a96b1dbcafa5ff5ab471c01cb1cf3cb` |
| `evidence/p5d-b1-artifacts.txt` | 324/324 | `157dc7831368cb7fbb93d7fc21c860a82f04840c65904cbbc26e349efda0c69d` |
| `evidence/p5d-b1-skills.txt` | 149/149 | `d0399b67187bf16e8aa9821d78c7832c291fc954aebf73b3e01dbe8d6037577a` |
| `evidence/p5d-b1-multitask.txt` | 174/174（复跑） | `1f8d5baec2e7b795752645286d96158b6b54def5fe4735909e5514d4e170c985` |
| `evidence/p5d-b1-electron-verify.txt` | 26/26 | `5ea41a39a5ac06314dd6c4f883bcb8c1a9b8df7b1d7b3cd6fed6bdc35d3e1865` |
| `evidence/p5d-b1-hard-check.txt` | 进程/网络 API 零命中 | `5ae222e300ae54910b2f51b5a789929931302e48c993e68df8bb165410810d6a` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `packages/shared-protocol/events.ts` | `71c11080132ed8d6542b9db0b145a72721370d532a95f472026f893534631a0a` |
| `main/hub/hub.ts` | `d33828f32a8d93d9fa6cf98e57f1898c86de29ff4e7c056da178aad4bd911af6` |
| `main/blackboard/board.ts` | `815402af32bf0dd2202010ad5c126138af0cd36387ac9530ff6086fb391da95e` |
| `main/electron/validate-action.ts` | `ed87a66d0461d5deb531fb6c806be27aeb9a539762cc10fdfb3939771ba20d9b` |
| `verify-flags.ts` | `8fac4df78e9fbf2768f1a98e84aed27d7e3fafaef766708adcc197cb066db7b3` |
| `main/mcp-host/bridge.ts` | `aec9307f171a3ed86d2fa1c99fa724a014773ed5319902cdaf9c7dacba8ce45c`（未改） |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`；board `user_version=3`；`verify:all` 链未改。

### A/B/C 组未改证明

`diff -u .probe/backup-p5d/verify-flags.ts apps/desktop/src/cli/verify-flags.ts` 的删除行只有 1 行 import（`node:fs` 增加 `readFileSync`）；A44+B23+C81 的断言零删除、零改名、零语义改动。

---

## 行为变更

1. **契约加法**：`flag.submit` action；`ScoreboardView`；`TaskView.points?/submitMode?`；`HubSnapshot.scoreboard?`；`ActionResult.mode/value/instructions/argv?`。
2. **FlagCandidateView.submitStatus**：可选 union 追加 `"manual"`（既有字段，字面量追加；见“契约偏差”）。
3. **flag.submit manual**：候选 `submitted_at/submit_status="manual"`；返回 value+instructions；不改 task.answer/status、不执行命令、不调平台 API；广播 `flag.updated`。
4. **flag.submit dry-run**：只返回 argv 预览；不执行、不写文件、不改候选、不写 flag.submit 事件。
5. **flag.submit command**：明确拒绝（可读错误）；不静默降级。
6. **记分板**：Hub 快照带 `scoreboard`（全部任务含归档；solved/total/points；各任务 points/flagCount）；`TaskView.points/submitMode` 填充。
7. **导出补提交字段**：md/csv 显示 submit_status + submittedAt；CSV 表头保持不变。
8. **verify-flags**：148 → 214（D66）；A/B/C 未改；仍独立于 `verify:all`。
9. **SQLite 不变**：仍 v3，无新列/新表；migration 127/127。

与 P5-A（持久化）、P5-B（fact 来源）、P5-C（确认/误报/导出）行为变更并列记录。

---

## 没做什么 / 已知问题

- **command 模式未实现**（用户决策）：没有 `child_process`/`spawn`/`exec` 路径；dry-run 只预览 argv；manual 不调平台 API。P5-E/WP6 评估前不做。
- **批次 2 renderer 未做**：没有提交弹窗、没有记分板 UI；`HubSnapshot.scoreboard?`/`TaskView.points?/submitMode?` 已可供 UI 消费，但 `renderer/store.ts` 还没读。
- **契约偏差**：`FlagCandidateView.submitStatus` 追加 `"manual"`；如果不接受，需在批次 2 前决定替代表示（如新增 `submitMode?` 字段）。
- **dry-run 不落库**：board API 支持 `"dry_run"`，但 Hub 的 dry-run 分支不调用；候选 `submit_status` 只可能是 `"manual"`（当前 manual 路径）。
- **manual 不修改 task 状态/answer**：提交与“解出”是两件事；任务 solved 仍由 confirm/task.setStatus 决定。
- **记分板包含归档任务**：历史积分仍算；`flagCount` 是三态候选总数。若后续要只算活跃任务，先改行为并写 done。
- **points 没有 UI/命令设置入口**：本批次只读 `tasks.points`（测试用 raw UPDATE）；points 的生产写入留 P5-E/WP6。
- **CSV 表头为兼容 P5-C C4 保持不变**：submit_status 追加在 submittedAt 单元里；如果后续要独立列，需要同时更新 C4 断言（本批次不允许）。
- **validate-action 的 ctx 仍不由 main.ts 注入**：与既有动作一致；IPC 结构校验在 validate-action，归属由 Hub 兜底；D7 已验证 ctx 路径。
- **task.setStatus 改回非 solved 仍 DELETE 候选/来源**（P5-A 语义）；flag 面板/提交不回滚任务。
- **事件量增长**：manual 提交写 lifecycle/audit；dry-run 不写。
- **multitask F 组 flaky**、render-verify 6 项失败、两个 UI 撒谎点仍挂账（WP6）。
- **verify:flags 仍独立于 verify:all**；board v3 不再动版本号；无 backfill（WP6）。
- **没有真实 agent、没有烧 token、没有自动提交 flag、没有调用平台 API。**

---

## 下一手需要什么

- **先确认批次 1 三个硬条件**：① `flag.submit` 相关代码 spawn/exec/child_process 零命中（见 hard-check 证据）；② command 明确拒绝且错误可读；③ manual 不调外部 API。
- **批次 2（renderer）**：提交弹窗（manual：flag 值 + 复制 + “我已提交”）、记分板 UI（solved/total/points + 展开任务列表）、mock 提交历史/无提交/记分板世界、smoke 只加断言（旧 274 零删除）。不做 command 执行入口。
- **P5-E / WP6**：points 写入入口、command 模式评估、导出保存对话框、打包态走查、真实 agent 长跑。
- 门禁：`verify:all` **665**、`verify:flags` **214**、`verify:gate` 52、`verify:scope` 308、`verify:migration` 127、`verify:artifacts` 324、`verify:skills` 149、`verify:multitask` 174、Electron 26、smoke 274。
- 不要重开批次 1 决策：manual 只记录时间、dry-run 只预览 argv、command 拒绝、无 spawn/exec、导出 CSV 表头不变、board v3。如要改先停下问。

---

# 批次 2 · renderer 提交弹窗 + 记分板 UI

> 日期：2026-10-24
> 状态：**批次 2 完成**。只改 renderer + mock；**没有改 `apps/desktop/src/main/**`、`packages/shared-protocol/events.ts`、styles.css、verify 套件或 `verify:all` 链**；没有 command 执行入口、没有平台 API 调用。

## 做了什么

- **store.ts**：
  - 新增 `scoreboard: ScoreboardView | null`，`applySnapshot` 读 `HubSnapshot.scoreboard?`（克隆 tasks；旧快照缺席 = null）；
  - 新增 `buildScoreboardView(state)` 纯视图模型：`kind=unknown|ready`、`summaryText="已解 N/M · X 分"`、任务行含 points/flagCount/archived/isFocus；归档任务保留并标记，不臆造 0；
  - `task.upsert` 更新 scoreboard 的 status/points/flagCount 并重算 solved/total/points；`flag.updated` 更新对应任务 flagCount；`clearFocus` 保留 scoreboard（全局视图）。
- **flags.ts**：
  - `FlagPanelCandidateView` 增加 `canSubmit`（仅 `new/confirmed`）、`isSubmitted`、`submittedAt/submittedAtText/submitStatus`；
  - 候选行显示提交状态（“未提交”/“已提交：时间（manual）”）；`new/confirmed` 显示「提交（manual）」/「重新记录提交」，`false_positive` 不显示；
  - 新增提交弹窗：显示 flag 值 + 复制按钮 + 「我已提交」；manual 只有在点「我已提交」后才调 `flag.submit`（mode 缺省 manual），成功后显示“已记录（manual，请到平台提交）”；不改 task 状态/answer；
  - 弹窗内「预览 argv」tab：调 `flag.submit(mode=dry_run)`，只显示 argv 预览，明确“不执行”；**没有执行按钮**；
  - 复制用 `navigator.clipboard`/`execCommand` 兜底；**没有 fetch/http/axios、没有 spawn/exec/child_process**。
- **main.ts**：
  - 右栏顶部新增「记分板」面板：折叠显示摘要，点击展开任务列表（title/status/points/flagCount）；归档任务用 `task-board-archived` 灰显，焦点任务有焦点标记；
  - 调用 `createScoreboardPanel(scoreboardBody, ctx)`；Flag 面板原有接法不变。
- **mock/data.ts**：
  - `MOCK_FLAGS_BY_TASK` 的 confirmed 候选带提交历史（`submittedAt`/`submitStatus="manual"`）；
  - `MULTI_TASKS` 加 points（A 50 / B 100 / 归档 25）；
  - 新增 `mockFlagsForTask(taskId, submits)`、`buildMockScoreboard(tasks, flagCounts)`；
  - `buildMultiTaskMockSnapshot` 支持 `submits: "present" | "none"`，返回 `scoreboard`；新增 `buildNoSubmitMockSnapshot()`；
  - 旧 `buildMockSnapshot()` 仍不带 flags/scoreboard。
- **mock/engine.ts**：
  - `MockOptions.submits`；per-task flags 使用 `mockFlagsForTask`；`toSnapshot` 返回 `scoreboard`（含归档、points/flagCount）；
  - `flag.submit`：manual 回写 `submittedAt/submitStatus="manual"` 并广播 `flag.updated`；dry-run 只返回 `argv=[flag 值]`；command 明确拒绝；false_positive 拒绝；不改 task 状态/answer。
- **smoke.ts**：旧 274 条零删除、零改语义；新增 23 条（274 → **297**）。

**关键取舍**

- **提交入口可见性**：`new/confirmed` 可提交；`false_positive` 不显示。manual 提交不改变候选 status（仍是 new/confirmed），只记录 `submitted_at`；所以“按钮可见性”与“是否已提交”是两个维度。
- **manual 与“解出”分开**：提交只记录时间，不写 task.answer/status；任务 solved 仍由 confirm/task.setStatus 决定。
- **dry-run 只预览**：弹窗里只显示 argv，没有执行按钮；mock/主进程都不执行命令。
- **记分板含归档**：与批次 1 语义一致；UI 灰显归档任务，不参与“活跃”但计入 total/points/solved（批次 1 口径）。
- **无保存对话框 IPC**：提交/导出都用弹窗 + 复制；未伪造 IPC。
- **旧快照兼容**：`scoreboard=null` 显示“记分板未知”，旧 mock 不带 scoreboard 不炸。

## 改了哪些文件

- `apps/desktop/src/renderer/store.ts`
- `apps/desktop/src/renderer/flags.ts`
- `apps/desktop/src/renderer/main.ts`
- `apps/desktop/src/renderer/contract.ts`（仅类型再导出 `ScoreboardView`）
- `apps/desktop/src/renderer/mock/data.ts`
- `apps/desktop/src/renderer/mock/engine.ts`
- `apps/desktop/src/renderer/smoke.ts`
- `.probe/p5d-b2-dom.mjs`（临时 DOM 探针，未提交到生产源码）
- `docs/done/P5-D.md`（本文件）、`docs/PROGRESS.md`

**明确未改**：

- `apps/desktop/src/main/**`（含 hub/board/bridge/validate-action/electron main）
- `packages/shared-protocol/events.ts`
- `apps/desktop/src/renderer/styles.css`
- `verify-gate/hardening/r18/multitask/skills/artifacts/scope/migration`、`verify:all` 链、`package.json`
- `D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置
- `.probe/backup-wp1/board.db`（sha256 仍 `6d491f0b…ab5cf469`）

## 怎么验证的

### 红测

先写 23 条 smoke 断言，未实现时：

```text
evidence/p5d-b2-smoke-red.txt → 279 PASS / 18 FAIL
FAIL  P5-D b2：mock 世界带 scoreboard
FAIL  P5-D b2：store 读 scoreboard
FAIL  P5-D b2：new 候选可提交  └─ [["flag-mt-b-1",null],["flag-mt-b-2",null]]
FAIL  P5-D b2：mock manual 提交返回 ok  └─ {"ok":false,"error":"unknown action"}
FAIL  P5-D b2：mock dry-run 返回 argv  └─ {"ok":false,"error":"unknown action"}
FAIL  P5-D b2：false_positive 候选不能提交
...
18 FAILED
```

旧 274 条在红测中全绿（279 = 274 + 5 条本来就能过的隔离/无提交断言）；旧 smoke 断言 diff 删除行 **0**。

### 绿测

```text
npm run smoke            → 297 PASS / 0 FAIL，exit=0（274 → 297，新增 23）
npm run verify:all       → 688 PASS / 0 FAIL（确定性 391 + smoke 297），exit=0
npm run verify:flags     → 214/214，exit=0（renderer 改动不影响）
npm run verify:gate      → 52/52
npm run verify:scope     → 308/308
npm run verify:migration → 127/127
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（基线阶段曾遇既有 F 组同毫秒排序 flaky，复跑绿）
Electron --verify        → 26/26
临时 DOM 探针             → 20/20
```

### DOM 探针

`.probe/p5d-b2-dom.mjs`（不挂 preload → mock 多任务世界）：

- 记分板面板存在，摘要 `已解 1/3 · 175 分`；展开 3 个任务，归档 1 个灰显、焦点 1 个；
- 记分板行显示 points/flagCount（A 50/Flag 1、B 100/Flag 3、归档 25/Flag 0）；
- flag 面板初始 3 个提交入口（2 new + 1 confirmed），confirmed 显示历史“已提交”和「重新记录提交」；
- 提交弹窗显示 flag 值、复制、manual/预览 argv tab；无执行按钮；
- 预览显示 `argv（预览，不执行）：["flag{multi_b}"]`；
- 点「我已提交」→ 状态“已记录（manual，请到平台提交）”，面板回写已提交；task 状态/answer 不变；
- 误报后该候选提交入口消失；全流程无执行按钮。

### 硬查证据

`evidence/p5d-b2-hard-check.txt`：

```text
== renderer/flags.ts external/process refs ==
(zero hits)
== renderer/main.ts external/process refs ==
(zero hits)
== flags.ts submit entry visibility ==
134:      canSubmit: status === "new" || status === "confirmed",
== flags.ts no execute action ==
(zero hits)
```

### 新增 smoke 断言清单（23 条）

1. P5-D b2：mock 世界带 scoreboard
2. P5-D b2：scoreboard 各任务 points/flagCount
3. P5-D b2：store 读 scoreboard
4. P5-D b2：旧快照不带 scoreboard 不炸
5. P5-D b2：new 候选可提交
6. P5-D b2：confirmed 候选可提交
7. P5-D b2：mock 有提交历史（confirmed 已 submitted）
8. P5-D b2：未提交候选 isSubmitted=false
9. P5-D b2：task.upsert 更新 scoreboard.solved
10. P5-D b2：flag.updated 更新 scoreboard.flagCount
11. P5-D b2：mock hub 快照带 scoreboard
12. P5-D b2：mock hub 有提交历史
13. P5-D b2：mock manual 提交返回 ok
14. P5-D b2：mock manual 返回 value/instructions
15. P5-D b2：mock manual 回写 submitted_at/manual
16. P5-D b2：manual 不改 task 状态/答案
17. P5-D b2：manual 不改 scoreboard points/solved
18. P5-D b2：mock dry-run 返回 argv
19. P5-D b2：mock dry-run 不改候选状态
20. P5-D b2：mock command 被拒且可读
21. P5-D b2：false_positive 候选不能提交
22. P5-D b2：mock 无提交世界
23. P5-D b2：跨任务提交隔离

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p5d-b2-smoke-red.txt` | 279 PASS / 18 FAIL | `005aa1ad22f768a8a42ce6ca11119b00233e49e0ea1cc42d698461ad0249db3e` |
| `evidence/p5d-b2-smoke.txt` | 297 PASS / 0 FAIL | `53dbf52c432c88048e113491147249a7576e3d28cc95c83b7a48f78eae5926f5` |
| `evidence/p5d-b2-verify-all.txt` | 688 PASS / 0 FAIL | `72d6100b06c0955c1014034ca07053349db3d407e513a3189fe08c2d7ee06226` |
| `evidence/p5d-b2-flags.txt` | 214/214 | `6f85822aa153e3ed9c83efaac491edb5cb2006d404c3df4d6abdd6a04439108a` |
| `evidence/p5d-b2-gate.txt` | 52/52 | `33145b3fff0baff18586a0240dab341c5bfd1765560972a5905f24923ca321a5` |
| `evidence/p5d-b2-scope.txt` | 308/308 | `a991ebf7466838f058ef7145e3f508302829bbf50f2fb439d64efe3ec9d11f65` |
| `evidence/p5d-b2-migration.txt` | 127/127 | `4211c14650e97ad5460f6d0dd5e34180143d2dedf4b3efed7e1847bdf3519fc6` |
| `evidence/p5d-b2-artifacts.txt` | 324/324 | `061eefdfd2a663f5bf2c3ff1b329a17b4c4c3d228c1ea9105e76987ce6764e97` |
| `evidence/p5d-b2-skills.txt` | 149/149 | `5275248b3d4f515130b3918a2afefceb0896b97c5cffc349bc4a0634a1d5c815` |
| `evidence/p5d-b2-multitask.txt` | 174/174 | `1973dedfc56248ccff2c8f00df5f055d6c8fd1f9d2448beee375876fb8002e12` |
| `evidence/p5d-b2-electron-verify.txt` | 26/26 | `465b0b76a7b0dae8a5d70557c02c8446ce8fdefa1d6b169f2fe4192a27b2bae8` |
| `evidence/p5d-b2-dom.txt` | 20/20（临时 DOM 探针） | `f3eb5446f6ffd162c6fd3528328fa38c7e0c27c9c03bf5887f5008338a9f75d1` |
| `evidence/p5d-b2-hard-check.txt` | renderer 零外部/进程 API | `9888e063f6498a6fa320b8ae724f05dbd6f2266e1f02ab9ddaf53601efb3a77c` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `renderer/store.ts` | `ec2ed92f8d3a89b4fb1914b97c279000a03c1934c031e21c7f78789aaf08fe3f` |
| `renderer/flags.ts` | `aac3d768335be6dbdbbf02a5b9de851a72fc02fd112b1d584792b6dec1cdaca6` |
| `renderer/main.ts` | `a6ff8cde5797a9ba026266febc05487a502500802d1cbe95aa869b9e568814ea` |
| `renderer/contract.ts` | `4e4546ff25dbab82783fdc870c510c671d1ee5162f395837d246ea9180eebc51` |
| `renderer/mock/data.ts` | `b582ca65b8c8794da39dec535a6ec882bd316dac374b3f6aa5472e4296e23145` |
| `renderer/mock/engine.ts` | `c3828852d4cb0092b14a9de2613589052c3b074885cc3d1eee52e3dfa3df7f29` |
| `renderer/smoke.ts` | `73dcce15b99390ee3e513dbab74840c2373954d2b28e2e485085b3d6c2c55914` |
| `packages/shared-protocol/events.ts` | `71c11080132ed8d6542b9db0b145a72721370d532a95f472026f893534631a0a`（未改） |
| `main/hub/hub.ts` | `d33828f32a8d93d9fa6cf98e57f1898c86de29ff4e7c056da178aad4bd911af6`（未改） |
| `main/blackboard/board.ts` | `815402af32bf0dd2202010ad5c126138af0cd36387ac9530ff6086fb391da95e`（未改） |
| `main/mcp-host/bridge.ts` | `aec9307f171a3ed86d2fa1c99fa724a014773ed5319902cdaf9c7dacba8ce45c`（未改） |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`；board 仍 v3；`verify:all` 链未改。

### 旧 smoke 断言未改证明

`diff -u .probe/backup-p5d-b2/smoke.ts apps/desktop/src/renderer/smoke.ts` 的删除行 **0**；新增 219 行（含 23 条断言与夹具）。旧 274 条零删除、零改语义。

## 行为变更

1. **store 新增 scoreboard 状态**：读 `HubSnapshot.scoreboard?`；旧快照缺席 = null，UI 显示「记分板未知」。
2. **scoreboard 随事件更新**：`task.upsert` 更新 status/points/flagCount 并重算 solved/total/points；`flag.updated` 更新对应任务 flagCount。
3. **右栏新增记分板面板**：折叠摘要 `已解 N/M · X 分`，展开任务列表（title/status/points/flagCount）；归档任务灰显但计入（批次 1 口径）。
4. **flag 面板提交入口**：仅 `new/confirmed` 显示；`false_positive` 不显示；显示提交历史/状态。
5. **提交弹窗（manual）**：flag 值 + 复制 + 「我已提交」；点了才调 `flag.submit`，显示“已记录（manual，请到平台提交）”；不改 task 状态/answer。
6. **dry-run 预览 tab**：只显示 argv，明确不执行；无执行按钮。
7. **mock 世界**：默认有提交历史（confirmed 已 submitted）、无提交世界（submits:none）、多任务 scoreboard（A50/B100/归档25，solved 1/3，175 分）；mock `flag.submit` 真回写 manual、dry-run 不落库、command 拒绝。
8. **smoke**：274 → 297（+23）；旧 274 条零删除；`verify:all` 665 → 688。
9. **主进程/契约未改**：events.ts、main/**、styles.css、verify 套件、verify:all 链均未动。

## 没做什么 / 已知问题

- **command 模式未实现**（用户决策）：提交弹窗没有 command tab/执行入口；dry-run 只显示 argv；renderer 无 fetch/http/axios、无 spawn/exec/child_process。
- **manual 不调平台 API**：只记录 submitted_at；用户手动复制到平台。
- **manual 不改 task 状态/answer**：提交与“解出”分开。
- **记分板含归档**：UI 灰显但计入 total/points/solved（与批次 1 一致）。
- **无保存对话框 IPC**：提交/导出都用弹窗 + 复制。
- **`task.setStatus` 改回非 solved 仍 DELETE 候选/来源**（P5-A 语义）；flag 面板不提供改回入口（现有任务状态弹窗仍保留旧功能）。
- **points 没有生产写入入口**：本批次只显示 `tasks.points`（mock 夹具）；生产 points 写入留 P5-E/WP6。
- **旧快照无 scoreboard**：显示“记分板未知”，不臆造 0；旧 mock 仍不带 scoreboard。
- **事件量增长**：manual 提交写 lifecycle/audit；dry-run 不写。
- multitask F 组 flaky、render-verify 6 项失败、两个 UI 撒谎点仍挂账（WP6）。
- `verify:flags` 仍独立于 `verify:all`；board v3；无 backfill（WP6）。
- 没有真实 agent、没有烧 token、没有自动提交 flag、没有调用平台 API。

## 下一手需要什么

- **P5-E / WP6**：points 生产写入入口、command 模式评估（仍默认不做）、导出/提交保存对话框、打包态 DOM 走查、真实 agent 长跑、multitask F 排序 flaky、render-verify 6 项、两个 UI 撒谎点。
- 门禁：`verify:all` **688**、`verify:flags` **214**、`verify:gate` 52、`verify:scope` 308、`verify:migration` 127、`verify:artifacts` 324、`verify:skills` 149、`verify:multitask` 174、Electron 26、smoke 297。
- 不要重开批次 2 决策：提交入口仅 new/confirmed、manual 只记录时间、dry-run 只预览 argv、无执行按钮、记分板含归档灰显、无平台 API、不改 main/**/events.ts。如要改先停下问。
