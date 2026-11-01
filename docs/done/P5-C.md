# P5-C · flag 确认 / 误报 / 导出（批次 1 后端 + 批次 2 renderer）

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP5；`docs/plans/COMPETITION-READINESS.md` §8.4/§8.5/§8.6；`docs/done/P5-A.md`、`P5-B.md`；`docs/decisions/D-multitask-focus.md`
> 日期：2026-10-24
> 状态：**批次 1 + 批次 2 完成**。批次 1 做后端 action 与 C 组验收；批次 2 做 renderer flag 面板、store `flag.updated`、任务卡 flagCount 徽标、mock 世界与 smoke 断言。**没有做提交适配器/记分板（P5-D）**。批次 2 完成后停下来等确认。

---

## 做了什么

把 P5-A/P5-B 已经持久化的 flag 候选接上三个**人工**动作：

- **契约（只加可选/新变体）**：
  - `HubAction.flag.confirm { taskId, candidateId }`；
  - `HubAction.flag.reject { taskId, candidateId }`；
  - `HubAction.flag.export { taskId?, format: "md" | "csv" | "json" }`；
  - 可选 `HubEvent.flag.updated { taskId, flags }`（确认/误报后广播完整候选列表）；
  - `ActionResult.content?: string`（导出内容；其他动作不填）。
  - 没有改现有字段语义，没有加必填字段。
- **board.ts（不改表/不改 v1-v3 迁移）**：
  - `getFlagCandidateById(candidateId)`；
  - `updateFlagCandidateStatus(candidateId, "confirmed" | "false_positive", actor?)`：只改候选状态，状态变化时写 `lifecycle` 事件（`what=flag.confirm/flag.reject`）+ `audit` 索引；事件/审计只记 candidateId/status，不写 flag 明文；状态未变时幂等，不重复写。
  - `recordFlagExport({ taskId, format, count })`：只写 `lifecycle` 事件 + audit，记 format/数量，不记导出内容/flag 明文。
  - **没有新列、没有新表、`PRAGMA user_version` 仍 3**；v1/v2/v3 迁移代码未改。
- **hub.ts**：
  - `flag.confirm`：校验任务存在且未归档、候选属于该 taskId；候选 `status=confirmed`；任务 `answer=候选值`、`status=solved`（走现有 `board.setTaskStatus`，`solved_by=human`）；**不删除候选**；广播焦点 `task.upsert` + `flag.updated`；写 events/audit `flag.confirm`。
  - `flag.reject`：同样的归属/归档校验；候选 `status=false_positive`；**不写 task.answer、不改任务状态、不删除候选**；广播 `flag.updated`；写 events/audit `flag.reject`。
  - `flag.export`：指定 taskId 只导出该任务（存在且未归档）；缺省导出全部**有候选**的任务（含归档）；按 md/csv/json 生成字符串，**只通过 `ActionResult.content` 返回，不写文件**；事件/审计只记 format 与候选数，不记内容。
  - **没有改 `task.setStatus` 的实现**；confirm 复用 `board.setTaskStatus`，不会走 `clearFlagCandidates` 分支。
- **validate-action.ts**：
  - `flag.confirm/reject` 结构校验 `taskId`/`candidateId`，可选 `ctx.task`/`ctx.candidate` 做存在/归档/归属校验；
  - `flag.export` 只允许 `md/csv/json`，`taskId` 可选；指定时校验存在且未归档。
- **verify-flags.ts**：A 组 44 + B 组 23 **原样保留**；新增 C 组 **81 条**（确认/拒绝/导出/校验/跨任务），总数 **67 → 148**。

**关键取舍**

- **confirm 与 P5-A `task.setStatus` 的关系**：如果任务已经 `solved` 且 `answer` 与候选值相同（典型：P5-A `task.setStatus solved` 先建了 human 候选），confirm **只翻候选状态，不再写一次 answer/answer 事件**；这样既不触发 `clearFlagCandidates`，也不重复写。正常路径（任务未 solved）才调用一次 `board.setTaskStatus(... "human")`。
- **reject 不撤销已 solved 的答案**：reject 严格只改候选状态；如果对一个已经被 confirm/solved 的候选点误报，任务仍保持 solved/answer（UI 批次 2 应只对 `new` 候选提供“误报”按钮）。这是“不写 task.answer”的直接结果。
- **导出不落文件**：Hub 只生成字符串；保存/复制由渲染层决定（批次 2）。导出全部时包含归档任务，因为导出是只读报告；指定 taskId 时归档任务被拒绝（与 validate-action 一致）。
- **事件/审计不含新 flag 明文**：P5-A 的 `flag.candidate` 事件本来就带 value（历史行为）；P5-C 新增的 confirm/reject/export 事件和 audit 不写 value。导出内容本身含 flag，只走 IPC 返回值。
- **validate-action 的 ctx 目前不由 main.ts 注入**：与既有 target 动作一致（main.ts 调 `validateHubAction(raw)` 不传 ctx）；IPC 路径的结构校验由 validate-action 做，归属/归档由 Hub 兜底。C5 直接验证了 ctx 路径。

---

## 改了哪些文件

- `packages/shared-protocol/events.ts`
  - `FlagCandidateView`/`FlagSourceView` 未改；
  - 新增 3 个 `HubAction` 变体、可选 `HubEvent.flag.updated`、`ActionResult.content?`。
- `apps/desktop/src/main/blackboard/board.ts`
  - `getFlagCandidateById`、`updateFlagCandidateStatus`、`recordFlagExport`；
  - 未改 schema/迁移/现有 flag API。
- `apps/desktop/src/main/hub/hub.ts`
  - flag 导出纯函数（md/csv/json）、`flagExportTasks`、`emitFlags`；
  - `flag.confirm` / `flag.reject` / `flag.export` 三个 dispatch 分支。
- `apps/desktop/src/main/electron/validate-action.ts`
  - `FLAG_EXPORT_FORMATS`、`ValidateActionContext.candidate?`、`requireCandidateExists`、三个 case。
- `apps/desktop/src/cli/verify-flags.ts`
  - A/B 组零改动（diff 仅 2 行 import 替换）；新增 C 组 81 条。
- `docs/done/P5-C.md`（本文件）、`docs/PROGRESS.md`（追加）。

**明确未改**：

- `apps/desktop/src/main/electron/main.ts`、`preload.cjs`
- `apps/desktop/src/main/mcp-host/**`、`bridge.ts`（hash 仍 `aec9307f…ba8ce45c`）
- `session/manager.ts`、`policy/**`、`acp/**`、`scope/**`、`briefing/**`、`skill/**`、`artifacts/**`、`evidence/**`、`approval/queue.ts`、`config/**`、`rules/**`
- `renderer/**`（批次 2）、`verify-gate/hardening/r18/multitask/skills/artifacts/scope/migration`、`smoke.ts`、`mock/**`
- `verify:all` 链、`D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置
- `.probe/backup-wp1/board.db`（sha256 仍 `6d491f0b…ab5cf469`）

---

## 怎么验证的

### 红测

先写 C 组，未实现时：

```text
evidence/p5c-b1-flags-red.txt → 102/148，46 FAIL
FAIL  C1 flag.confirm 返回 ok  — {"ok":false,"error":"未知动作：flag.confirm"}
FAIL  C1 候选 status=confirmed  — actual="new" expected="confirmed"
FAIL  C3 flag.reject 返回 ok  — {"ok":false,"error":"未知动作：flag.reject"}
FAIL  C4 md 导出返回 ok  — {"ok":false,"error":"未知动作：flag.export"}
FAIL  C5 validate confirm  — 未知动作类型：flag.confirm
...
```

A44 + B23 在红测中全绿（102 = 67 + C 组红测中本来就能过的 35 条）；46 条红全部属于新增 C 组。

### 绿测

```text
npm run verify:flags     → 148/148（A44 + B23 + C81），exit=0
npm run verify:all       → 628 PASS / 0 FAIL（确定性 391 + smoke 237），exit=0
npm run verify:gate      → 52/52，exit=0
npm run verify:scope     → 308/308，exit=0
npm run verify:migration → 127/127，exit=0
npm run verify:artifacts → 324/324，exit=0
npm run verify:skills    → 149/149，exit=0
npm run verify:multitask → 174/174（D 组 10/10），exit=0
Electron --verify        → 26/26，exit=0
```

C 组覆盖：

- confirm：候选 confirmed、task.answer=候选值、task.status=solved、solvedBy=human、候选不删除、events/audit `flag.confirm`、`flag.updated`/`task.upsert` 广播；
- confirm 拒绝路径：跨任务 candidateId、不存在 candidateId、已归档任务；
- confirm 与 P5-A 重叠：`task.setStatus solved` 先建 human 候选（status=new）→ confirm 只翻状态，不重复写 answer 事件、不触发 clear；
- reject：候选 false_positive、不写 answer、不改任务状态、候选仍在、events/audit `flag.reject`、`flag.updated`；
- export：md/csv/json 内容/字段/转义、指定任务不包含其他任务、无 taskId 导出全部有候选任务、不写文件（work 目录前后一致）、事件/审计只记 format/count 不含 flag 明文；
- validate-action：合法动作、非法 format、缺字段、ctx 归属/归档校验；
- 跨任务隔离：A 的 confirm/reject 不影响 B 的候选/任务。

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p5c-b1-flags-red.txt` | 102/148（46 FAIL，C 组红） | `25d439c6845137e23b4a8e6f6a37bec52925be39f0b9ffcab4241d1bf5ceabe2` |
| `evidence/p5c-b1-flags.txt` | 148/148 | `056083894592d09e9c645f311b56fe6ec89a9e6e9c06aa5c34465ecd1cd8a440` |
| `evidence/p5c-b1-verify-all.txt` | 628/0 | `7278d713d7ffcd6b5d0aff7a13eae631c80cc8a19190deafdb86547a4ce919e3` |
| `evidence/p5c-b1-gate.txt` | 52/52 | `33145b3fff0baff18586a0240dab341c5bfd1765560972a5905f24923ca321a5` |
| `evidence/p5c-b1-scope.txt` | 308/308 | `1de47e1b3adf1625b7a2fecb91b566602c749ae252977a7a7e51162b435934d1` |
| `evidence/p5c-b1-migration.txt` | 127/127 | `09a8955f1696ab5b35c74a34ac155254477bbc5ec3f3cb52ab1a74185270ebf8` |
| `evidence/p5c-b1-artifacts.txt` | 324/324 | `9efef751fd26f0d26f0e0ea96cf3a2dfdde11cd1582f82b7b8ce1febb5ea5a2b` |
| `evidence/p5c-b1-skills.txt` | 149/149 | `5981e4f2ed766c234ae4b0ed2aec76b6d5f4904711b308eb83015b66824bfbe1` |
| `evidence/p5c-b1-multitask.txt` | 174/174 | `76a22b5cd32e10624c3efcb3e5f745af72227fbb5098c83fffa9f40927a97d24` |
| `evidence/p5c-b1-electron-verify.txt` | 26/26 | `a15bf9b3bba0ff2102a8448c13253fe7a80d938c3f2244bd4a78bdd4d7bf0060` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `packages/shared-protocol/events.ts` | `f577a9d153b22a24cee9ecf9d933f858192b93235af13711806e2c6898a493df` |
| `apps/desktop/src/main/hub/hub.ts` | `4d1dee9e082ff8ecfd6b9dee172484cd0158d801ba9fd2e7d3e59eb03de8fbb2` |
| `apps/desktop/src/main/blackboard/board.ts` | `880ff0aad065868d035d3f02a1e161eadd47a46e08d73efedf363b1bb935f894` |
| `apps/desktop/src/main/electron/validate-action.ts` | `91e6d589f53d57d5472d3caf157aa29cb944700dbe04adedd3ae79fcd42eca21` |
| `apps/desktop/src/cli/verify-flags.ts` | `2d6c9697a771c0be97b4b3fb84dce3247b0ef98c7ed5ecc2d357e6ca141940b3` |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，348160 B；`bridge.ts` 仍 `aec9307f…ba8ce45c`；board `user_version=3`，本轮未改 v1/v2/v3 迁移。

### A/B 组未改证明

`diff -u .probe/backup-p5c/verify-flags.ts apps/desktop/src/cli/verify-flags.ts` 的删除行只有 2 行 import（`node:fs` 增加 `readdirSync`、类型 import 增加 `HubEvent`）；A44 + B23 的断言零删除、零改名、零语义改动。

---

## 行为变更

1. **契约加法**：新增 `flag.confirm` / `flag.reject` / `flag.export` 三个 HubAction；可选 `HubEvent.flag.updated`；`ActionResult.content?`。旧渲染层/旧 mock/旧测试不读新字段仍工作。
2. **flag.confirm**：候选 `status=confirmed`；任务 `answer=候选值`、`status=solved`、`solved_by=human`（正常路径）；不删除候选、不触发 `clearFlagCandidates`、不自动提交。
3. **flag.reject**：候选 `status=false_positive`；不写 answer、不改任务状态、不删除候选（保留审计）。
4. **flag.export**：md/csv/json 字符串只通过 `ActionResult.content` 返回；不写文件；指定 taskId 时只导出该任务（未归档），缺省导出全部有候选任务（含归档）；事件/审计只记 format/count。
5. **verify-flags**：A44+B23 不变；C 组 +81；总数 67 → 148；仍独立于 `verify:all`。
6. **SQLite 未变**：仍 v3，无新列/新表；迁移测试 127/127。

与 P5-A（持久化 + store + 来源）和 P5-B（submit_fact 来源锁定）并列记录。

---

## 没做什么 / 已知问题

- **批次 2 renderer 未做**：当前没有 flag 面板、确认/误报/导出按钮；`HubSnapshot.flags?`/`TaskView.flagCount?` 已在快照里，但 `renderer/store.ts` 还没有 `flags` 字段。
- **`flag.updated` 事件暂未被渲染层消费**：`store.applyEvent` 的 `default` 会忽略它；批次 2 要加 store 字段/分支，并处理 `const _exhaustive: never = e` 的类型收口（运行时不炸，类型层面需要在批次 2 补齐）。
- **P5-D 未做**：提交适配器、`submit_mode/command/timeout` 消费、记分板、points 统计都未开始。
- **confirm 在 P5-A 已 solved 同答案路径不重写 answer**：为满足“不重复写”，此路径只翻候选状态；`solved_by` 保持 P5-A 的值（可能为 null）。正常 confirm 路径会写 `solved_by=human`。这是批次 1 的明确取舍。
- **reject 不撤销 solved**：对已确认/已 solved 的候选点误报，候选变 false_positive，但任务仍是 solved/answer；批次 2 的 UI 应只对 `new` 候选提供“误报”。
- **导出不写文件、没有保存对话框**：批次 2 决定走复制还是 IPC 保存；如果 IPC 没有 dialog 能力，就显示 content 让用户复制（按用户批次 2 要求）。
- **validate-action 的 ctx 未由 main.ts 注入**：与 target 动作一致；IPC 结构校验在 validate-action，归属/归档在 Hub 兜底；C5 已验证 ctx 路径。
- **导出全部包含归档任务**：只读报告；指定 taskId 时归档任务被拒绝。若后续要排除归档，先改行为并写 done。
- **事件量继续增长**：confirm/reject/export 各写 lifecycle/audit；哈希链尾部变化。导出事件不含 flag 明文，但 P5-A 的 `flag.candidate` 事件仍含 value（历史行为）。
- **`task.setStatus` 改回非 solved 仍 DELETE 候选/来源**（P5-A 语义）；flag.confirm 不触发 DELETE。候选 status 仍是 `new/confirmed/false_positive` 三态。
- **bridge.ts 其他工具路径未改**；`submit_fact` 来源仍走 P5-A/B 的 fact → Hub 扫描路径。
- **没有 backfill**（WP6）；board v3 不再动版本号。
- multitask F 组 flaky、render-verify 6 项失败、两个 UI 撒谎点仍挂账（WP6）。
- `verify:flags` 仍独立于 `verify:all`，门禁需单独跑。

---

## 下一手需要什么

- **批次 2（renderer flag 面板）**：
  - `store.ts` 读 `HubSnapshot.flags?` / `TaskView.flagCount?`，旧快照不带 flags 不炸；处理 `flag.updated`（只接受焦点任务，P1-E 规则）；
  - 焦点任务展开 flag 面板：值/来源/证据/时间/状态、确认/误报/导出按钮；
  - 导出调 `flag.export` 拿 content → IPC 保存对话框或复制；不默认写仓库；
  - mock 世界：有候选/无候选/多任务候选；mock confirm/reject/export 真回写；
  - smoke 只加断言，旧 237 条零删除；先写红测再实现。
- **P5-D（提交/记分板）**：默认 manual；command 必须人工确认 + dry-run；token 不入库/日志；points/scoreboard 导出。不要在批次 2 顺手做。
- 门禁：`verify:all` 628、`verify:flags` 148、`verify:migration` 127、`verify:scope` 308、artifacts 324、skills 149、multitask 174、Electron 26。
- 不要重开批次 1 决策：confirm 复用 `board.setTaskStatus` 且同答案不重复写；reject 只改候选；export 只返回 content、不写文件、日志只记 format/count；board 仍 v3。如要改先停下问。

---

# 批次 2 · renderer flag 面板

> 日期：2026-10-24
> 状态：**批次 2 完成**。严格只改 renderer + mock（外加 `renderer/main.ts` 的最小面板/徽标接线、`renderer/contract.ts` 的类型再导出），没有改 `apps/desktop/src/main/**`、`packages/shared-protocol/events.ts`、`styles.css`、verify 套件或 `verify:all` 链。没有做提交/记分板（P5-D）。

## 做了什么

- **store.ts**：
  - 新增 `flags: FlagCandidateView[]`（焦点任务候选）与 `flagsStatus: "known" | "unknown"`；
  - `applySnapshot` 读 `HubSnapshot.flags?`：字段存在（含 `[]`）= known，缺席 = unknown（旧快照，不能显示成“无候选”）；
  - 接上 `HubEvent.flag.updated`：只接受焦点任务（P1-E 规则），同步 `flags`、`task.flagCount`、`tasks[].flagCount`；非焦点事件丢弃；
  - `clearFocus`/`emptyState` 同步清空 flags 并置 unknown；旧快照不带 flags 不炸。
- **flags.ts（新增）**：
  - `buildFlagPanelView(state)` 纯视图模型：`kind = no-task | unknown | empty | ready`，候选行含 value/status/statusLabel/evidence/firstSeen/sources，`canConfirm`/`canReject` **只对 `status=new` 为 true**，`exportFormats = ["md","csv","json"]`；
  - `createFlagsPanel(container, ctx)` 右栏面板：候选列表（值/状态/证据/首次时间/来源会话/witness）、确认/误报按钮、md/csv/json 导出按钮；
  - 确认/误报前用 `openConfirmModal` 二次确认；确认调 `flag.confirm`、误报调 `flag.reject`；动作后 `refreshSnapshot()` 兜底（即使旧后端没有 `flag.updated`，也能用快照刷新）；
  - 导出调 `flag.export` 拿 `ActionResult.content`，弹窗展示只读 textarea + 复制按钮；**不写文件**（当前 IPC 没有保存对话框能力）；
  - 没有提交按钮/动作；不自动提交。
- **task.ts**：
  - `TaskBoardRow` 增加 `flagCount`；`buildTaskBoardView` 优先用 `TaskView.flagCount`，旧快照焦点任务回退到 `state.flags.length`，其他任务退化为 0；
  - 导出 `openConfirmModal` 供 flag 面板复用（原为文件内私有函数）。
- **renderer/main.ts（最小接线，renderer 内）**：
  - 右栏新增「Flag 候选」面板并调用 `createFlagsPanel`；
  - 任务看板行/焦点任务卡显示 `Flag N` 徽标（复用 `task-flag-tag` 样式）；
  - 旧 `flagCandidate` 标签保留：没有 `flagCount` 时仍显示旧「flag 候选」；
  - **没有改 `apps/desktop/src/main/**`**。
- **mock/data.ts**：
  - `MOCK_FLAGS_BY_TASK`：焦点 B 3 条（2 new + 1 confirmed），非焦点 A 1 条，归档 0 条；候选带 session/witness/evidence/firstSeen；
  - `buildMultiTaskMockSnapshot` 支持 `flags: "present" | "none"`，焦点任务 `flags` + 所有任务 `flagCount`；新增 `buildNoFlagsMockSnapshot()`（已知无候选，`flags: []`）；
  - 旧 `buildMockSnapshot()` 仍不带 flags（旧 mock 兼容）。
- **mock/engine.ts**：
  - 新增 per-task `allFlags` 表；`toSnapshot` 只给焦点任务 `flags`，所有任务按表算 `flagCount`；旧快照 `flagsKnown=false` 时不带 flags；
  - `flag.confirm`：候选 confirmed、任务 answer/status=solved/solvedBy=human、广播 `flag.updated` + `task.upsert`；
  - `flag.reject`：候选 false_positive、不写 answer、不删候选、广播 `flag.updated`；
  - `flag.export`：md/csv/json 字符串只返回 `content`，不写文件；
  - `task.focus/switch` 切焦点后推新焦点的 `flag.updated`；
  - `task.setStatus` 镜像 P5-A：solved 补 human 候选（status=new）、改回非 solved 清空候选；
  - 未知候选/非焦点 flag 操作返回可读错误。
- **contract.ts**：只把 `FlagSourceView` / `FlagCandidateView` 加到类型再导出（运行时零变化）。
- **smoke.ts**：旧 237 条零删除、零改语义；新增 37 条（237 → **274**）。

**关键取舍**

- **面板位置**：放在右栏常驻（不折叠），显示焦点任务候选；任务看板行/焦点任务卡显示 `Flag N` 徽标。比在 240px 左栏塞列表更可读。
- **按钮可见性**：确认/误报只对 `status=new` 显示；confirmed / false_positive 显示「已确认 / 已标记误报」静态提示，避免误操作。
- **二次确认**：确认弹窗写清「answer=候选值、不会自动提交」；误报弹窗写清「不改任务答案/状态、候选保留审计」。
- **导出兜底**：当前 `HubApi` 没有保存对话框方法，所以不伪造 IPC；弹窗展示内容 + 复制按钮，明确写「未写文件」。
- **旧快照语义**：`flagsStatus="unknown"` 与 `flags=[]`（known）分开；面板显示「候选状态未知」而不是「无候选」。
- **不做提交**：面板只有确认/误报/导出；没有“提交 flag”按钮或 action。

## 改了哪些文件

- `apps/desktop/src/renderer/store.ts`
- `apps/desktop/src/renderer/flags.ts`（新增）
- `apps/desktop/src/renderer/task.ts`
- `apps/desktop/src/renderer/main.ts`（仅右栏面板/徽标接线）
- `apps/desktop/src/renderer/contract.ts`（仅类型再导出）
- `apps/desktop/src/renderer/mock/data.ts`
- `apps/desktop/src/renderer/mock/engine.ts`
- `apps/desktop/src/renderer/smoke.ts`
- `.probe/p5c-b2-dom.mjs`（临时 DOM 探针，未提交到生产源码）
- `docs/done/P5-C.md`（本文件）、`docs/PROGRESS.md`

**明确未改**：

- `apps/desktop/src/main/**`（含 `hub.ts` / `board.ts` / `bridge.ts` / `validate-action.ts` / `electron/main.ts`）
- `packages/shared-protocol/events.ts`
- `apps/desktop/src/renderer/styles.css`
- `verify-gate/hardening/r18/multitask/skills/artifacts/scope/migration`、`verify:all` 链、`package.json`
- `D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置
- `.probe/backup-wp1/board.db`（sha256 仍 `6d491f0b…ab5cf469`）

## 怎么验证的

### 红测

先放 `flags.ts` 纯视图模型桩 + 写 37 条 smoke 断言，未实现 store/mock 时：

```text
evidence/p5c-b2-smoke-red.txt → 244 PASS / 30 FAIL
FAIL  P5-C b2：多任务 mock 焦点任务 3 个候选  └─ {}
FAIL  P5-C b2：store 读 flags  └─ flags=0
FAIL  P5-C b2：store flagsStatus=known  └─ undefined
FAIL  P5-C b2：flag 面板 ready  └─ {"kind":"unknown","count":0,"rows":0}
FAIL  P5-C b2：任务卡徽标 flagCount（焦点 3）  └─ undefined
FAIL  P5-C b2：mock reject 回写 false_positive  └─ {"res":{"ok":false,"error":"no new candidate"}}
FAIL  P5-C b2：mock 导出 md 返回内容  └─ {"ok":false}
...
30 FAILED
```

旧 237 条在红测中全绿（244 = 237 + 7 条本来就能过的常量/空数组断言）；旧 smoke 断言 diff 删除行 **0**。

### 绿测

```text
npm run smoke            → 274 PASS / 0 FAIL，exit=0（237 → 274，新增 37）
npm run verify:all       → 665 PASS / 0 FAIL（确定性 391 + smoke 274），exit=0
npm run verify:flags     → 148/148，exit=0（renderer 改动不影响）
npm run verify:gate      → 52/52
npm run verify:scope     → 308/308
npm run verify:migration → 127/127
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（D 组 10/10）
Electron --verify        → 26/26
临时 DOM 探针             → 18/18（mock 多任务世界真实渲染 + 点击确认/误报/导出）
```

DOM 探针（`.probe/p5c-b2-dom.mjs`，不挂 preload → renderer 回落 mock 多任务世界）：

- 右栏「Flag 候选」面板存在，3 条候选（2 new + 1 confirmed）；
- 焦点任务卡显示 `Flag 3` 徽标，看板非焦点任务显示 `Flag 1` 徽标；
- new 候选显示确认/误报按钮（各 2 个），confirmed 不显示；
- 真实点击「确认」→ 二次确认弹窗 → 候选变 confirmed、任务卡显示 answer、确认按钮少一个；
- 真实点击「误报」→ 二次确认弹窗 → 候选变 false_positive、误报按钮消失；
- 点击「导出 md」→ 内容弹窗包含 `flag{multi_b}`，明确写「没有写文件」；
- 没有提交入口。

### 新增 smoke 断言清单（37 条）

1. P5-C b2：多任务 mock 焦点任务 3 个候选
2. P5-C b2：非焦点任务 flagCount=1
3. P5-C b2：快照 flags 只属于焦点任务
4. P5-C b2：mock 候选覆盖 new/confirmed
5. P5-C b2：store 读 flags
6. P5-C b2：store flagsStatus=known
7. P5-C b2：flag 面板 ready
8. P5-C b2：new 候选显示确认/误报按钮
9. P5-C b2：confirmed 候选不显示确认/误报按钮
10. P5-C b2：面板带来源/证据/时间
11. P5-C b2：导出格式只有 md/csv/json
12. P5-C b2：任务卡徽标 flagCount（焦点 3）
13. P5-C b2：任务卡徽标 flagCount（非焦点 1）
14. P5-C b2：归档任务 flagCount=0
15. P5-C b2：旧快照不带 flags 不炸（unknown）
16. P5-C b2：旧快照面板显示未知而非无候选
17. P5-C b2：已知无候选 flagsStatus=known
18. P5-C b2：无候选面板空态
19. P5-C b2：store 接 flag.updated
20. P5-C b2：flag.updated 同步 task.flagCount
21. P5-C b2：非焦点 flag.updated 丢弃（P1-E）
22. P5-C b2：mock hub 快照带 3 个候选
23. P5-C b2：mock reject 回写 false_positive
24. P5-C b2：mock reject 后候选仍在
25. P5-C b2：mock reject 不改任务状态/答案
26. P5-C b2：误报后不再显示确认/误报按钮
27. P5-C b2：mock confirm 回写 confirmed
28. P5-C b2：mock confirm 写 task.answer/status
29. P5-C b2：mock confirm 后 flagCount 仍 3
30. P5-C b2：mock confirm 后确认态不再显示按钮
31. P5-C b2：mock confirm 不存在候选被拒
32. P5-C b2：mock 导出 md 返回内容
33. P5-C b2：mock 导出 csv 有表头
34. P5-C b2：mock 导出 json 可解析且含 3 候选
35. P5-C b2：导出不含非焦点任务候选
36. P5-C b2：mock 无候选世界
37. P5-C b2：旧 mock 世界仍不带 flags

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p5c-b2-smoke-red.txt` | 244 PASS / 30 FAIL | `053ed09c8dc2cb91d8dcc3baf5e46b48c5811db1d0d9a5498ff4774f4d9ed46e` |
| `evidence/p5c-b2-smoke.txt` | 274 PASS / 0 FAIL | `d1b235ea4e804945d48a32d9715ffdf8c0dc8442c7989dff6530f92fe6d195a4` |
| `evidence/p5c-b2-verify-all.txt` | 665 PASS / 0 FAIL | `8bef74fd91108cd83e659df3a535e3e9ae9be35652b10886036aedccd90cf514` |
| `evidence/p5c-b2-flags.txt` | 148/148 | `44ed53e5bbf147a1185501ad17118a178ebb1cb1b98ab07f175baec7b313bcb6` |
| `evidence/p5c-b2-gate.txt` | 52/52 | `33145b3fff0baff18586a0240dab341c5bfd1765560972a5905f24923ca321a5` |
| `evidence/p5c-b2-scope.txt` | 308/308 | `aa038a9ebe1bf18302ba52c0caa7b2f58ba95a91ba8ba01a082ba5cc1319a79f` |
| `evidence/p5c-b2-migration.txt` | 127/127 | `ac9e88a4c8967d49302db76b1f3120808cc8fd2262721c4fe7e99d4dcc06c25f` |
| `evidence/p5c-b2-artifacts.txt` | 324/324 | `39dd11a27a109704e4c8b716d8ef6b6d6a40d219827299d02073c89b85efc245` |
| `evidence/p5c-b2-skills.txt` | 149/149 | `b2267faaaa8990586447688c6bc9da2cc2b70235d8538bcfb637baef8457f8f3` |
| `evidence/p5c-b2-multitask.txt` | 174/174 | `958037291fbc34281c682b4279fa9b420bbc518d09dd4754462718498c3eaf9e` |
| `evidence/p5c-b2-electron-verify.txt` | 26/26 | `8eafce09a9b6d25c29fdf326e0ddee69c46b0b4b8b4b745084fa25719e826152` |
| `evidence/p5c-b2-dom.txt` | 18/18（临时 DOM 探针） | `f8968ccae17c841f40c03d9cd66c884511b3548fd61ca3653ec7abb888183b2c` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `renderer/store.ts` | `306954f39b5735f7b61636662804aea627daeab4cabb547c922c169bf5c01104` |
| `renderer/task.ts` | `f4744f4cc3522ed90ce8d73f42daf243095545295c5342cbbc02639b397f169b` |
| `renderer/flags.ts` | `47afc6bcb73c3e7556e32b3ee7a56836138d6a83782c84420e15ca50a0e666e3` |
| `renderer/main.ts` | `9ff331b4f92d37c780fa1931b3634e38cbbec64312f1e862565a524114e06a41` |
| `renderer/contract.ts` | `4812a43d1a0fc65b7b1c76ed9eada95629f51edc1d8c60c56be534da4c5148b1` |
| `renderer/mock/data.ts` | `7dfdb8f6fddfef4d4dac9e5014b4f899845719f5406743df10a9304ce6fb7e1e` |
| `renderer/mock/engine.ts` | `e2daad92ad8492b28d5b417c4ce9cd926cb0872dde19ae4438438c6177022381` |
| `renderer/smoke.ts` | `2883028c05ff8b5ff0f10255c0219096aee18847853fa998436fcdea4aa7dffb` |
| `packages/shared-protocol/events.ts` | `f577a9d153b22a24cee9ecf9d933f858192b93235af13711806e2c6898a493df`（未改） |
| `main/hub/hub.ts` | `4d1dee9e082ff8ecfd6b9dee172484cd0158d801ba9fd2e7d3e59eb03de8fbb2`（未改） |
| `main/blackboard/board.ts` | `880ff0aad065868d035d3f02a1e161eadd47a46e08d73efedf363b1bb935f894`（未改） |
| `main/mcp-host/bridge.ts` | `aec9307f171a3ed86d2fa1c99fa724a014773ed5319902cdaf9c7dacba8ce45c`（未改） |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，348160 B；board 仍 v3；`verify:all` 链未改。

## 行为变更

1. **store 新增 flags 状态**：`flags` + `flagsStatus`；旧快照不带 flags 时显示「未知」，`flags=[]`（known）才显示「无候选」。
2. **store 接 `flag.updated`**：确认/误报后更新焦点 flags、`task.flagCount`、`tasks[].flagCount`；非焦点事件丢弃（P1-E 不变）。
3. **右栏新增 Flag 候选面板**：候选值/状态/证据/首次时间/来源；确认/误报只对 `status=new` 显示；确认/误报有二次确认。
4. **导出**：md/csv/json 通过 `flag.export` 返回 content，弹窗展示 + 复制；不写文件、没有保存对话框 IPC；没有提交入口。
5. **任务卡 flagCount 徽标**：看板行和焦点任务卡显示 `Flag N`；旧 `flagCandidate` 标签保留作为没有 flagCount 时的回退。
6. **mock 世界**：多任务焦点 3 候选（2 new + 1 confirmed）、非焦点 1 候选、无候选世界（`flags: []`）、旧世界无 flags（unknown）；mock confirm/reject/export 真回写快照。
7. **smoke**：237 → 274（+37）；旧 237 条零删除、零改语义；`verify:all` 628 → 665。
8. **`task.setStatus` 的 P5-A 语义未改**：mock 只做镜像（solved 补 human 候选、非 solved 清空）；flag 面板本身没有“改回非 solved”入口。

## 没做什么 / 已知问题

- **P5-D 未做**：提交适配器、`submit_mode/command/timeout` 消费、points/记分板、提交确认弹窗都未开始。
- **没有保存对话框 IPC**：`HubApi` 没有 save dialog 方法；导出弹窗展示内容 + 复制，明确写“未写文件”。若后续要保存对话框，需 Lane A 加可选 IPC，不在本批次。
- **面板不折叠**：右栏「Flag 候选」常驻显示焦点任务；任务卡有 `Flag N` 徽标，但没有点击折叠/展开控制。用户要求的“焦点任务展开”以常驻面板满足；若要做可折叠，需要再加 UI 状态。
- **`renderer/main.ts` 有最小接线**：任务卡/右栏面板在 main.ts 的布局函数里，无法只改 task.ts 完成；本批次只在 renderer 内加了 import、右栏 section、两处徽标。没有改 `apps/desktop/src/main/**`。
- **`renderer/contract.ts` 只加类型再导出**：`FlagSourceView`/`FlagCandidateView`；运行时零变化。
- **旧快照语义**：`flagsStatus="unknown"` 下导出按钮仍可点（后端可导出全部），但面板显示未知；这是有意的“不把未知当空”。
- **候选 status 三态**：new/confirmed/false_positive；确认/误报只对 new 显示；已处理态显示静态提示。
- **`task.setStatus` 改回非 solved 仍 DELETE 候选/来源**（P5-A 语义）；现有“任务状态”弹窗仍保留“改回待解”按钮（R16 旧功能），flag 面板不提供该入口。
- **mock 的 flag 操作只支持焦点任务**：非焦点返回可读错误；真实 Hub 按 taskId 支持后台任务。
- **事件量继续增长**：真实 Hub 的 confirm/reject/export 事件/审计在批次 1 已定；渲染层只消费 `flag.updated`。
- **multitask F 组 flaky、render-verify 6 项失败、两个 UI 撒谎点**仍挂账（WP6）。
- **`verify:flags` 仍独立于 `verify:all`**；本批次 renderer 改动不影响 flags 148/148。
- **没有重打包**：`dist/` 不是本批次产物；打包态 DOM/导出走查留 WP7。
- **没有真实 agent、没有烧 token、没有自动提交 flag**。

## 下一手需要什么

- **P5-D（提交/记分板）**：`submit_mode=manual` 默认；`command` 必须人工点“确认提交” + 展示 argv + dry-run；环境变量 `FLAG`/`TASK_ID`；无 shell；超时/审计/脱敏；points/scoreboard 导出。不要在批次 2 之后顺手做。
- **WP6**：multitask F 排序 flaky、render-verify 6 项、两个 UI 撒谎点、导出保存对话框/打包态走查、真实 agent 下 flag 面板长跑。
- 门禁：`verify:all` **665**、`verify:flags` **148**、`verify:gate` 52、`verify:scope` 308、`verify:migration` 127、`verify:artifacts` 324、`verify:skills` 149、`verify:multitask` 174、Electron 26、smoke 274。
- 不要重开批次 2 决策：右栏常驻面板、按钮只对 new、导出 content + 复制（无保存 IPC）、不做提交、不改 main/**/events.ts。如要改先停下问。
