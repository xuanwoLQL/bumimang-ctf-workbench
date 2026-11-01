# WP5 · flag / 答案 / 提交 / 记分闭环（P0/P1）总收口

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP5；`docs/plans/COMPETITION-READINESS.md` §8（§8.2 文件清单 / §8.3 数据模型 / §8.4 行为 / §8.5 契约 / §8.6 测试 / §12 门禁）；`docs/done/P5-A.md`、`P5-B.md`、`P5-C.md`（批次 1/2）、`P5-D.md`（批次 1/2）；`docs/decisions/D-flag-submit.md`
> 日期：2026-10-24
> 状态：**WP5 完成（P5-A → P5-E 收口）**。P5-E 只写文档 + 跑全量，没有改任何 `.ts` / `.css` / `.json` / `.cjs` 代码文件。
> 验收基线：**`verify:all` 688 PASS / 0 FAIL（确定性 391 + smoke 297）；`verify:flags` 214/214（A44+B23+C81+D66）；`verify:gate` 52/52；`verify:scope` 308/308；`verify:migration` 127/127；`verify:artifacts` 324/324；`verify:skills` 149/149；`verify:multitask` 174/174；Electron `--verify` 26/26。**
> 验收差距：计划 §8.4/§8.6 的 **command 提交模式未实现**（用户决策：WP6 评估前不做）；manual/dry-run 已落地并验收。见“验收差距 / 计划偏差”。

---

## 做了什么

WP5 把「flag 候选只在内存、没有去重表、不能确认/误报/导出、没有提交/记分」补成一条完整闭环：

- **P5-A 持久化**：SQLite v2 → v3，新增 `flag_candidates` / `flag_sources` 两表与 `tasks.points/submit_mode/submit_command/submit_timeout_ms` 四列；Board 六个 flag API；契约新增 `FlagSourceView`/`FlagCandidateView`/`TaskView.flagCount?`/`HubSnapshot.flags?`；`noteFlagCandidate` 从内存 Map 改为 store；收敛读 store 但 R24 fact E1+ 门禁不变。
- **P5-B fact 来源**：确认 `submit_fact → board.submitFact → onBoardWrite → Hub.publishBoardSince → noteFlagCandidate` 链路（P5-A 已接）；**没有生产代码变更**，用 B 组 23 条锁住 witness/evidence 来源。
- **P5-C 确认/误报/导出**：契约加 `flag.confirm`/`flag.reject`/`flag.export` + 可选 `flag.updated` + `ActionResult.content?`；Hub 三 action；Board `getFlagCandidateById`/`updateFlagCandidateStatus`/`recordFlagExport`；confirm 写 answer/status=solved 且**不触发 clearFlagCandidates**；reject 只标 `false_positive`；export 返回 content、不写文件、日志只记 format/count；渲染层 flag 面板 + 确认/误报/导出 + `Flag N` 徽标。
- **P5-D 提交/记分**：契约加 `flag.submit`、`ScoreboardView`、`TaskView.points?/submitMode?`、`HubSnapshot.scoreboard?`、`ActionResult.mode/value/instructions/argv?`；`submitStatus` 追加 `"manual"`；Hub manual 只记录 `submitted_at/submit_status="manual"` 并返回 value+instructions，dry-run 只返回 argv，**command 明确拒绝**；Board `updateFlagSubmitStatus`/`getScoreboard`；渲染层 manual 提交弹窗（复制 + 「我已提交」）+ dry-run argv 预览 tab（**无执行按钮**）+ 记分板 UI。
- **P5-E 收口**：本文件 + `D-flag-submit.md` + PROGRESS + 九份 `wp5-final-*` 证据；不改代码。

**关键取舍**

- **提交默认 manual、不做 command**：用户明确决策；manual 不调平台 API、不 spawn/exec/fetch；用户复制到平台，应用只记录时间。
- **确认/误报/提交是三条独立动作**：confirm 才写任务 solved/answer；reject 只改候选；submit manual 只记录提交时间，不改任务状态/answer。
- **候选三态 + 提交状态分离**：`new/confirmed/false_positive` 是候选状态；`submitted_at/submit_status` 是人工提交记录；manual 提交不改变候选状态。
- **记分板含归档**：历史积分仍算；UI 灰显归档任务；`flagCount` 是三态候选总数。
- **导出/提交都不写仓库、不写文件**：content 走 IPC 返回值，渲染层弹窗复制。
- **契约只加可选/新 action**：没有删除/改现有字段语义；旧快照/旧 mock 不炸。

---

## WP5 目标与验收对照

### 1. 计划 §8.6 测试计划 6 条

| # | 计划要求 | 覆盖位置 | 结果 | 说明 / 证据 |
|---|---|---|---|---|
| 1 | 两个会话提交同一 flag → 一条候选、两条来源；不同任务同 flag 各自一条 | `verify:flags` A1/B4/B6 | **PASS** | `A1 同任务同 flag 只有 1 条候选 — actual=1`、`A1 来源数量 2`、`A1 不同任务同 flag 各自一条`、`B4 两个 session → 两条来源 — actual=2`；`evidence/p5a-flags.txt`、`p5b-flags.txt` |
| 2 | 标误报后不在待确认列表；确认后任务 solved、answer 正确、points 不变 | `verify:flags` A5/C1/C3/C6 | **PASS** | `C1 任务 status=solved`、`C1 任务 answer=候选值`、`C1 solved_by=human`、`C3 候选 status=false_positive`、`C3 不写 task.answer`、`C6 A 候选最终 confirmed`；`evidence/p5c-b1-flags.txt` |
| 3 | 重启后候选/状态还在；旧库迁移不丢任务/事实/会话；backfill 可选 | `verify:flags` A2、`verify:migration` 127/127 | **PASS（backfill 未做）** | `A2 重启后 A 候选数 1`、`A2 重启后 A 来源数 2`、`A2 重启后 A 证据仍 E2`；迁移真实备份 15 任务/23 事实/30 会话/472 事件不变；backfill 留 WP6 |
| 4 | 导出 Markdown/CSV/JSON 内容正确；不写仓库 | `verify:flags` C4/D5 | **PASS** | `C4 md 含任务 A 标题`、`C4 csv 首行表头`、`C4 json candidateCount=2`、`C4 导出不写文件（work 目录不变）`、`D5 csv 含 submit_status=manual`、`D5 JSON submitStatus=manual`；`evidence/p5c-b1-flags.txt`、`p5d-b1-flags.txt` |
| 5 | command 提交默认不执行；dry-run 只打印；人工确认后才执行；失败/超时确定；日志无 token；manual 无执行路径 | `verify:flags` D2/D3/D4/D7/D8 | **部分 PASS / command DEFERRED** | manual：`D2 候选 submit_status=manual`、`D2 manual 不改 task.answer`；dry-run：`D3 dry-run mode=dry_run`、`D3 dry-run argv 是数组`、`D3 dry-run 不改 submitted_at`；command：`D4 command 被拒`、错误含 `command 模式未实现`；硬查：`evidence/p5d-b1-hard-check.txt` 四块零 `child_process/spawn/exec/fetch/http/axios`。**command 模式按用户决策未实现** |
| 6 | 候选不自动 solved；MCP 没有 confirm 工具；审批/审计有记录 | `verify:flags` A/C、`bridge.ts` 未改 | **PASS** | `A3 焦点 A status=new`、`A5 solved 后候选出现`、`C1 flag.confirm 事件不含 flag 明文`、`C1 审计有 flag.confirm`；`bridge.ts` 仍 `aec9307f…ba8ce45c`，无 confirm 工具；`task.setStatus` 仍是唯一 solved 写入口之一 |

**小计：4 条完整 PASS、1 条部分 PASS（command DEFERRED）、1 条完整 PASS（含 backfill 未做的边界）。**

### 2. 计划 §8.3 数据模型

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| `flag_candidates`（id/task_id/value/source_session/witness/evidence/first_seen/status/submitted_at/submit_status/submit_detail，UNIQUE(task_id,value)） | **PASS** | `board.ts` v3，字段完整；同任务同 value 去重 |
| `flag_sources`（id/candidate_id/session_id/witness/evidence/seen_at） | **PASS** | 多来源；完全相同 source 去重 |
| `tasks.points/submit_mode/submit_command/submit_timeout_ms` | **PASS** | P5-A 加列；P5-D 读 points/submit_command，submit_timeout_ms 只读备用 |
| `PRAGMA user_version = 3` | **PASS** | v0/v1/v2 同一次 open 走 v1→v2→v3；重复打开幂等；migration 127/127 |
| 旧数据/迁移 | **PASS（无 backfill）** | 历史未确认候选本来没持久化；迁移不丢任务/事实/会话/事件；backfill 留 WP6 |
| `flag_sources` 证据取最高 / 来源去重 | **PASS** | `addFlagCandidate`/`addFlagSource`；A1/B5/B6 |

### 3. 计划 §8.4 行为

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| 来源：流式 FLAG_RE / MCP submit_fact / WP3 附件/证据扫描统一 store | **PASS（附件扫描未产候选）** | 流式 + fact 路径进 store；附件扫描仍只写 `attachment.scan` 审计（P3-B 语义），不自动产候选 |
| UI 候选列表（值/来源/证据/witness/首次时间/状态） | **PASS** | 右栏 Flag 面板；P5-C b2 |
| 确认只能人工点；写 answer/solved/solvedBy=human；不自动提交 | **PASS** | `flag.confirm`；C1；P5-A 重叠路径不重复写 |
| 导出 Markdown/CSV/JSON；保存对话框；不默认写仓库 | **PASS（无保存对话框 IPC）** | content 返回 + 渲染层弹窗复制；不写文件；C4/D5 |
| 记分板：points/status/已解未解/团队汇总/导出 | **PASS（导出未单独做）** | `ScoreboardView` + 右栏记分板；任务列表/摘要；导出由现有 flag.export/后续 WP6 扩展 |
| 提交 manual：只显示复制/人工提交，不执行 | **PASS** | P5-D manual；D2；渲染层提交弹窗 |
| 提交 command：人工确认 + 弹窗 argv/flag + env + 无 shell + 超时 + 审计 + 重试 | **DEFERRED（用户决策）** | 未实现；无 `child_process`/`spawn`/`exec`；D4/D8 |
| 提交 dryRun 只打印 argv | **PASS** | P5-D dry-run；D3；渲染层预览 tab（无执行按钮） |

### 4. 计划 §8.5 契约

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| `FlagSourceView` | **PASS** | P5-A |
| `FlagCandidateView`（含 status/evidence/firstSeen/sources/submittedAt/submitStatus） | **PASS** | P5-A + P5-D 追加 `"manual"` |
| `ScoreboardView`（tasks/solved/total/points） | **PASS** | P5-D |
| `TaskView.flagCount?` / `points?` / `submitMode?` | **PASS** | P5-A / P5-D |
| `HubSnapshot.flags?` / `scoreboard?` | **PASS** | P5-A / P5-D |
| `HubAction.flag.confirm/reject/export/submit` | **PASS** | P5-C / P5-D |
| `HubEvent.flag.updated` | **PASS** | P5-C（可选） |
| `ActionResult.content?` / `mode?/value?/instructions?/argv?` | **PASS** | P5-C / P5-D |
| 只加可选/新变体、不改现有字段语义 | **PASS（一处字面量追加）** | `FlagCandidateView.submitStatus` 追加 `"manual"`；向后兼容 |

### 5. 计划 §8.2 文件清单偏差

计划 §8.2 预期新增 `main/flags/store.ts`、`export.ts`、`submit.ts`、`scoreboard.ts`。实际实现**没有拆这四个文件**：store 落在 `board.ts` 的 flag API，export 落在 `hub.ts` 的纯函数，submit 落在 `hub.ts` 的 `flag.submit` + `board.updateFlagSubmitStatus`，scoreboard 落在 `board.getScoreboard` + `hub.snapshot().scoreboard` + `renderer/store.ts`/`main.ts`。原因：现有架构已经由 Board/Hub/渲染层分担这些职责，拆新文件会增加跨层接线；功能与验收不受影响。**这是计划偏差，不是漏做**；若 WP6 要把 flag 逻辑独立成模块，再单独评估。

---

## P5-A / P5-B / P5-C / P5-D 每步摘要与证据

| 步骤 | 一行摘要 | 关键数字 | Evidence |
|---|---|---|---|
| **P5-A** | flag 候选持久化：SQLite v2→v3、两表 + tasks 四列、契约视图、store 化、收敛读 store | migration 73→**127/127**；flags **44/44**；verify:all 628/0；multitask 174；Electron 26 | `evidence/p5a-*` |
| **P5-B** | submit_fact 来源接 store 验证 + B 组锁链路；**无生产代码变更** | flags 44→**67/67**（B+23）；verify:all 628；artifacts 324 | `evidence/p5b-*` |
| **P5-C 批次 1** | 契约 + Hub + Board 三 action（confirm/reject/export）；confirm 不触发 clear；export 不写文件 | flags 67→**148/148**（C+81）；verify:all 628；硬查无明文 | `evidence/p5c-b1-*` |
| **P5-C 批次 2** | 渲染层 flag 面板 + 确认/误报/导出 + flagCount 徽标；store 接 flag.updated；旧快照不炸 | smoke 237→**274（+37）**；verify:all 665/0；DOM 18/18 | `evidence/p5c-b2-*` |
| **P5-D 批次 1** | flag.submit manual/dry-run + 拒 command；ScoreboardView/points；导出补提交字段；无 spawn/exec/fetch | flags 148→**214/214**（D+66）；verify:all 665/0；硬查零命中 | `evidence/p5d-b1-*` |
| **P5-D 批次 2** | 渲染层 manual 提交弹窗 + dry-run argv 预览 + 记分板 UI；无 command/平台 API | smoke 274→**297（+23）**；verify:all 688/0；DOM 20/20 | `evidence/p5d-b2-*` |
| **P5-E** | WP5 总收口：本文件 + D-flag-submit + PROGRESS + 九份最终证据；不改代码 | **688 / 214 / 52 / 308 / 127 / 324 / 149 / 174 / 26** | `evidence/wp5-final-*` |

---

## 行为变更汇总

> 每条写“改了哪条 / 为什么 / 影响 / 旧测试怎么处理”。

### P5-A · SQLite v3 + flag store（持久化行为变更）

- **改了哪条**：SQLite v2→v3；新增 `flag_candidates`/`flag_sources` 两表与 `tasks.points/submit_mode/submit_command/submit_timeout_ms`；契约新增 `FlagSourceView`/`FlagCandidateView`/`TaskView.flagCount?`/`HubSnapshot.flags?`；`noteFlagCandidate` 内存 Map → store；`maybeStartConvergence` 读 store 但 R24 fact E1+ 门禁不变；`task.setStatus` 改回非 solved 仍 `clearFlagCandidates`（DELETE）。
- **为什么**：候选必须跨会话去重、重启恢复、可确认/误报/导出；内存 Map 重启即丢。
- **影响**：候选/来源落库；同任务同 flag 一条候选、多来源；证据取最高；快照只暴露焦点候选；改回非 solved 会删除候选/来源（破坏性）。
- **旧测试**：migration 73 条保留，5 条 `user_version` 期望 2→3；新增 v3 断言到 127；verify:all 仍 628；新增独立 `verify:flags`。

### P5-B · submit_fact 来源锁定（无生产代码变更）

- **改了哪条**：没有改 bridge.ts/hub.ts；`submit_fact` 仍只写 fact；source 由 `BoardBridge → board.submitFact → onBoardWrite → Hub.publishBoardSince` 从 fact 的 witness/evidence 传给 `noteFlagCandidate`。
- **为什么**：P5-A 已实现 source 透传；再加 bridge 直接回调会造成两套真相。
- **影响**：fact 来源（E0/E1/E2、witness、session）自然进 `flag_sources`；收敛门禁不变。
- **旧测试**：A44 不变；新增 B23；flags 44→67；verify:all 仍 628。

### P5-C 批次 1 · 确认/误报/导出 action（契约加法 + 行为）

- **改了哪条**：新增 `HubAction.flag.confirm/reject/export`、可选 `HubEvent.flag.updated`、`ActionResult.content?`；Hub 三 action；Board `getFlagCandidateById`/`updateFlagCandidateStatus`/`recordFlagExport`；confirm 写 answer/status=solved/solvedBy=human，**不触发 clearFlagCandidates**；reject 只标 false_positive、不写 answer、不删候选；export 只返回 content、不写文件、事件/审计只记 format/count、不记 flag 明文。
- **为什么**：人工确认/误报/导出是 WP5 的 P0 闭环；必须避免 confirm 触发 P5-A 的 DELETE。
- **影响**：候选可操作；`flag.updated` 让 UI 增量更新；导出内容含 flag 但只走 IPC 返回值。
- **旧测试**：A44+B23 原样；新增 C81；flags 67→148；verify:all 仍 628。

### P5-C 批次 2 · 渲染层 flag 面板（渲染层行为变更）

- **改了哪条**：store 新增 `flags/flagsStatus` 并接 `flag.updated`；新增 `renderer/flags.ts` 右栏面板（候选值/来源/证据/时间/状态、确认/误报、md/csv/json 导出）；`task.ts` 加 flagCount 视图、导出 `openConfirmModal`；`main.ts` 最小接线（右栏面板 + `Flag N` 徽标）。
- **为什么**：候选必须在 UI 可见/可操作；旧快照不能炸。
- **影响**：确认/误报/导出走人工按钮；旧快照显示“未知”而非“无候选”；导出弹窗复制、不写文件；不做提交入口。
- **旧测试**：旧 smoke 237 零删除；新增 37 → 274；verify:all 628→665；DOM 18/18。

### P5-D 批次 1 · flag.submit + 记分板（契约加法 + 行为）

- **改了哪条**：新增 `flag.submit`、`ScoreboardView`、`TaskView.points?/submitMode?`、`HubSnapshot.scoreboard?`、`ActionResult.mode/value/instructions/argv?`；`FlagCandidateView.submitStatus` 追加 `"manual"`；Hub manual 记录 submitted_at/submit_status 并返回 value+instructions，dry-run 只返回 argv，command 明确拒绝；Board `updateFlagSubmitStatus`/`getScoreboard`；getTask/listTasks SELECT 扩展 points/submit_mode/submit_command/submit_timeout_ms；导出 md/csv 补提交状态（CSV 表头不变）。
- **为什么**：manual 自动提交是硬约束；command 模式用户决策不做；记分板需要 points/flagCount。
- **影响**：manual 不改 task 状态/answer；dry-run 不落库；scoreboard 含归档；无 spawn/exec/fetch/平台 API。
- **旧测试**：A/B/C 148 原样；新增 D66 → 214；verify:all 仍 665；hard-check 零命中。

### P5-D 批次 2 · 渲染层提交弹窗 + 记分板（渲染层行为变更）

- **改了哪条**：store 新增 `scoreboard` + `buildScoreboardView`；`task.upsert`/`flag.updated` 同步 scoreboard；flags.ts 提交入口仅 new/confirmed + manual 弹窗（复制 + 我已提交）+ dry-run argv 预览 tab；main.ts 右栏记分板（摘要/展开/归档灰显）；mock 加 points/提交历史/无提交世界 + `flag.submit` 回写。
- **为什么**：manual 提交需要人工复制/记录；记分板需要可见。
- **影响**：提交入口不显示在 false_positive；无 command tab/执行按钮/平台 API；旧快照无 scoreboard 显示未知；任务 solved 仍由 confirm/task.setStatus 决定。
- **旧测试**：旧 smoke 274 零删除；新增 23 → 297；verify:all 665→688；DOM 20/20。

---

## 已知限制清单

1. **command 提交模式未实现（用户决策：WP6 评估前不做）**：dry-run 只预览 argv 不执行；manual 只记录 `submitted_at`，用户手动复制到平台。**为什么不修**：用户明确决策；command 会扩大执行面，需单独安全设计。**留到**：WP6 评估后再定。
2. **manual 不改 task 状态/answer**：提交与“解出”分开；任务 solved 仍由 confirm/task.setStatus 决定。**为什么**：提交不等于解出，避免误把“已复制到平台”当“已解出”。**留到**：若产品要“提交即 solved”，需用户拍板。
3. **dry-run 不落库**：候选 `submitted_at/submit_status` 不变，不写 flag.submit 事件、不写文件。**为什么**：预览必须零副作用。**留到**：无需修；若要记录预览审计，另开决策。
4. **记分板含归档任务（批次 1 语义）**：UI 灰显但计入 total/points/solved；**为什么**：历史积分仍算；**留到**：WP6 评估是否排除归档。
5. **points 尚无生产写入入口**：本步只显示 `tasks.points`（mock 夹具）；**为什么**：P5-D 只消费列，不新增 CRUD/UI；**留到**：WP6 或后续评估任务积分录入。
6. **CSV 表头为兼容 P5-C C4 保持不变**，submit_status 追加在 submittedAt 单元（hack）；**为什么**：C81 不允许改；**留到**：后续如需独立列，同步更新 C4 断言并写行为变更。
7. **submitStatus 追加 `"manual"` 字面量**（P5-C 已有 `"dry_run"|"ok"|"failed"|"timeout"|null`）；向后兼容，不加新字段；**为什么**：manual 状态必须进快照/导出 UI；**留到**：若未来要更细提交状态，另加可选字段。
8. **task.setStatus 改回非 solved 仍 DELETE 候选/来源**（P5-A 语义，破坏性）；**为什么**：保留 P1-C 旧语义；**留到**：P5-C/WP6 若要历史审计，重新评估（当前 flag 面板不提供改回入口）。
9. **flag.confirm 与 P5-A setStatus 的重叠路径**：任务已 solved 且 answer 相同，只翻候选状态、不重写 answer、不触发 clearFlagCandidates；**为什么**：满足“不重复写”；**留到**：正常 confirm 路径写 solvedBy=human，重叠路径 solvedBy 保持 P5-A 值（可能 null）。
10. **reject 对已 confirmed/solved 的候选只改状态，不回滚任务**；UI 只对 `new` 显示误报；**为什么**：reject 不写 task.answer；**留到**：UI 已限制，无需修。
11. **flag.export 的保存路径**：无保存对话框 IPC，用弹窗 + 复制，不写文件；**为什么**：不改 main/preload/契约；**留到**：WP6/WP7 若加 save dialog，走可选 IPC。
12. **validate-action 的 ctx 未由 main.ts 注入**（与 target 动作一致），IPC 归属由 Hub 兜底；**为什么**：main.ts 不在改动面；**留到**：后续统一注入 ctx。
13. **后台任务 submit_fact 的 fact 只在焦点/flush 时进候选**；无 bridge 直接回调 Hub；**为什么**：P5-B 选择保持 fact→Hub 扫描；**留到**：WP6 评估是否需要后台即时路径。
14. **没有 backfill**：历史未确认候选本来就没持久化，迁移不丢任务/事实/会话；**为什么**：events regex 回填有误报风险；**留到**：WP6 评估。
15. **board user_version=3**；WP6 不再动版本号（除非新 WP 需要）；**为什么**：避免无谓迁移；**留到**：新 schema 需求先停下问。
16. **事件量增长**：策略审计 + 代理审计 + flag 候选/来源/确认/误报/导出/提交 lifecycle events；哈希链尾部变化；**为什么**：审计完整性优先；**留到**：WP6 观测性能/链影响。
17. **跨任务批量授权 `permission.grantAll.taskId` 仍未实现**（WP1 遗留）；**为什么**：不在 WP5 范围；**留到**：WP6 评估。
18. **multitask F 组 flaky（同毫秒排序无 tie-break）、render-verify 6 项既有失败（P1-E mock 遗留）、两个 UI 撒谎点（代理失败/崩溃时状态不实）仍挂账**；**为什么**：不在 WP5 范围；**留到**：WP6 修。
19. **verify:flags 仍独立于 verify:all**，门禁需单独跑；**为什么**：避免把 214 条 flag 断言混进 688 全量链；**留到**：保持不变，文档明确。
20. **代理默认关；scope.enabled 默认关；outOfScopeAction 默认 approve（不是计划 §7.4 的 block）；误报降级改 config + 重启**；**为什么**：P4-B 提取误报率未在真实 agent 环境验证；**留到**：WP6 用真实题评估后再决定默认值。

### 验收差距 / 计划偏差（补充）

1. **command 模式未实现**：计划 §8.4/§8.6 要求 command + dry-run；用户决策只做 manual/dry-run，command 明确拒绝。见限制 1。
2. **计划 §8.2 的 `main/flags/store.ts`/`export.ts`/`submit.ts`/`scoreboard.ts` 未拆**：功能落在 board/hub/renderer；见“§8.2 文件清单偏差”。
3. **附件扫描不产生 flag 候选**：仍只写 `attachment.scan` 审计（P3-B 语义）；WP5 未接候选，避免抢职责。
4. **记分板导出未单独做**：当前用 `flag.export` 导出候选；任务级 scoreboard 导出留 WP6/后续。
5. **没有真实 agent 的提交端到端**：P5-D 全部 fake/mock/纯逻辑；真实 agent benchmark 留 WP6（0 token）。

---

## 验收数字

| 项 | 数字 | 证据 |
|---|---|---|
| `npm run verify:all` | **688 PASS / 0 FAIL**（确定性 391 + smoke 297） | `evidence/wp5-final-verify-all.txt` |
| `npm run verify:flags` | **214/214**（A44+B23+C81+D66） | `evidence/wp5-final-flags.txt` |
| `npm run verify:gate` | **52/52** | `evidence/wp5-final-gate.txt` |
| `npm run verify:scope` | **308/308**（A80+B96+C63+D32+E37） | `evidence/wp5-final-scope.txt` |
| `npm run verify:migration` | **127/127** | `evidence/wp5-final-migration.txt` |
| `npm run verify:artifacts` | **324/324**（A110+B51+C58+D33+E72） | `evidence/wp5-final-artifacts.txt` |
| `npm run verify:skills` | **149/149** | `evidence/wp5-final-skills.txt` |
| `npm run verify:multitask` | **174/174**（D 组 10/10；F 组 flaky 复跑） | `evidence/wp5-final-multitask.txt` |
| Electron `--verify` | **26/26** | `evidence/wp5-final-electron-verify.txt` |
| Renderer smoke | **297 PASS / 0 FAIL** | `evidence/p5d-b2-smoke.txt` |
| P5-D 批次 1 硬查 | flag.submit 代码块 0 进程/网络 API | `evidence/p5d-b1-hard-check.txt` |
| P5-D 批次 2 硬查 | renderer flags/main 0 外部/进程 API | `evidence/p5d-b2-hard-check.txt` |

### smoke 121 → 162 → 187 → 216 → 237 → 274 → 297

- **P1-E：121 → 162（+41）**：多任务看板/配额/全局审批/后台计数/焦点 pane 上限。
- **P2-C：162 → 187（+25）**：技能库状态/未配置提示/category 验证/简报预览。
- **P3-C：187 → 216（+29）**：附件/工件/预览/最小 Lane A IPC。
- **P4-D 批次 1：216 → 237（+21）**：范围三态、目标面板/徽标、审批卡 scopeTarget/ruleId、mock 目标 CRUD、旧快照兼容。
- **P5-C 批次 2：237 → 274（+37）**：flag 面板/候选状态/按钮可见性/导出/旧快照 unknown/flag.updated/mock 世界。
- **P5-D 批次 2：274 → 297（+23）**：scoreboard/提交入口/提交历史/manual 回写/dry-run 预览/command 拒绝/无提交世界。
- **P5-A / P5-B / P5-D 批次 1 不改 smoke**：flag/board/契约测试在独立 `verify:flags`。
- **旧断言零删除**：每次扩展都只追加；P5-C b2、P5-D b2 的 smoke diff 删除行均为 0。

---

## WP6 之前必须知道的事（交接）

### WP6 会用真实题验证

- **并行收益**：5-10 道真题、每道 3 次重复，测 1 vs 2/3 会话的首答时间、makespan、工具调用、审批等待、重复事实、token/成本（能拿到的）。
- **扇出建议**：简单题/难题分别该开几路；guarded vs autonomous 哪个值得。
- **简报轮 vs 显式 prompt 轮分开统计**（WP2 冒烟观察）：简报本身是“开始解题”型 prompt，不能把简报轮算进显式 prompt 的首答。
- **真实 agent 下 flag 面板/提交/记分板长跑**：当前 P5-D 0 token，全部 fake/mock/纯逻辑。

### WP6 会评估

- **command 提交模式是否值得做**（当前未实现，用户决策 WP6 评估前不做）；
- **代理是否值得开**（当前默认关；只对遵守 HTTP_PROXY 的工具生效）；
- **scope.enabled 是否开**（当前默认 false；outOfScopeAction=approve）；
- **CVE 精确检索**（WP2 已知差距：`CVE-2021-44228` 真实库 0 命中，`log4j`/`JNDI`/`Log4Shell` 有）；
- **ctf-solver 根目录 `.md` 是否进索引**（WP2 已知）；
- **permission.grantAll.taskId 跨任务批量授权**（WP1 遗留）；
- **后台 submit_fact 即时性**（P5-B 边界）；
- **backfill**（events regex 回填，当前未做）；
- **points 生产写入入口**（当前只显示 tasks.points）。

### WP6 会修

- **multitask F 组 flaky**（同毫秒排序无 tie-break；加 `created_at DESC, id DESC` 或显式 seq）；
- **render-verify 6 项既有失败**（P1-E mock 遗留）；
- **两个 UI 撒谎点**（代理启动失败/崩溃时状态不实）。

### WP6 会观测

- **事件量增长对哈希链和性能的影响**（策略审计 + 代理审计 + flag lifecycle events）；
- **8 会话内存/事件量**（soak 60-120 分钟）；
- **简报轮活跃度**（不能当空转）；
- **导出/提交弹窗在真实长会话下的体验**。

### 纪律

- **WP6 先 dry-run**；真实题 3 次跑单独申请 token。
- **契约冻结**：WP6 若需新 `HubAction`/`HubEvent`/快照字段，先写 `docs/requests/` 并停下问用户；不要直接改 `events.ts`。
- **真实 token 预算**：P5-D 未跑真实 agent（0 token）；WP6 真实 benchmark 单独申请。
- **不自动提交 flag、不自动打目标、不自动开环境**（沿用总控 §3）。
- **不删测试、不放宽策略、不关审计**。

---

## 怎么验证的 / 保护面

- **P5-E 状态检查**：`verify:all` 688 / flags 214 / gate 52 / scope 308 / migration 127 / artifacts 324 / skills 149 / multitask 174（F flaky 复跑）/ Electron 26。
- **最终九份 evidence**：`evidence/wp5-final-*.txt`，见上表。
- **备份库**：`.probe/backup-wp1/board.db` 348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录一致；WP5 期间未改。
- **board schema**：`board.ts` sha256 `815402af32bf0dd2…391da95e`，`PRAGMA user_version = 3`。
- **config 默认**：`scope.enabled=false`、`outOfScopeAction=approve`、`proxy.enabled=false`、`proxy.port=0`。
- **保护面**：`session/manager.ts`、`policy/**`、`acp/**`、`scope/**`、`briefing/**`、`skill/**`、`artifacts/**`、`evidence/**`、`approval/queue.ts`、`config/**`、`rules/**`、`electron/main.ts`、`mcp-host/**`（除 P5-A 未改）、`verify-gate/hardening/r18/multitask/skills/artifacts/scope/migration`、`verify:all` 链在 P5-E 均未改。
- **没有跑真实 agent、没有烧 token**：P5-E 0 token；P5-D 也 0 token。
- **没有重打包**：`dist/` 不是 WP5 产物；打包态 flag/提交/记分板走查留 WP7。
- **没有改 `D:\agent\skill`、没有改全局配置、没有改 `docs/ARCHITECTURE.md`、没有删测试、没有自动提交 flag。**

---

## 没做什么 / 已知问题

- **P5-E 不改代码**：没有改任何 `.ts` / `.css` / `.json` / `.cjs`；没有改 `hub.ts`、`board.ts`、`session/manager.ts`、`policy/**`、`acp/**`、`scope/**`、`briefing/**`、`skill/**`、`artifacts/**`、`evidence/**`、`approval/queue.ts`、`renderer/**`、`events.ts`、`config/**`、`rules/**`、`electron/**`、`mcp-host/**`、各 verify 套件、`smoke.ts`、`mock/**`、`package.json`、`verify:all` 链。
- **没有实现 command 提交模式**：用户决策；dry-run 只预览 argv；manual 不调平台 API。
- **没有做真实 agent 的提交/记分端到端**：P5-D 全部 fake/mock/纯逻辑；WP6 真实 benchmark 单独申请 token。
- **没有做 backfill**：历史未确认候选本来没持久化；WP6 评估。
- **没有做 points 生产写入入口/记分板导出**：只显示 `tasks.points` 与候选导出；WP6/后续。
- **没有做保存对话框 IPC**：导出/提交弹窗复制；WP6/WP7 若需要再走可选 IPC。
- **没有修**：multitask F 排序 flaky、render-verify 6 项、两个 UI 撒谎点、跨任务批量授权、后台 fact 即时性、CVE 精确检索、ctf-solver 根目录 `.md` 索引。
- **未验证**：真实 agent 下 command 模式（未实现）、代理对真实工具链覆盖率、打包态 flag/提交/记分板、干净机器。
- **已知行为**：`task.setStatus` 改回非 solved 仍 DELETE 候选/来源；manual 不改 task 状态/answer；记分板含归档；CSV 表头 hack；submitStatus 追加 `"manual"`；事件量增长。
- **验收差距**：计划 §8.4/§8.6 的 command 模式未做（用户决策）；§8.2 的四个 flags 文件未拆；附件扫描仍不产候选；记分板导出未单独做。

---

## 证据

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/wp5-final-verify-all.txt` | `verify:all` 688 PASS / 0 FAIL | `1df476a6c50f4f3fbbf7fccd718ffe32cd9f3a1746ae29375b5314e35ee3be00` |
| `evidence/wp5-final-flags.txt` | `verify:flags` 214/214 | `0bbf5c929a0900347ff194f3f5082fdc39e5c99750496bed7b97bee370f699b6` |
| `evidence/wp5-final-gate.txt` | `verify:gate` 52/52 | `33145b3fff0baff18586a0240dab341c5bfd1765560972a5905f24923ca321a5` |
| `evidence/wp5-final-scope.txt` | `verify:scope` 308/308 | `f4266c2dd0791d318bb89be2ff29622368d643c4e7371aad42d66ba12a473bf5` |
| `evidence/wp5-final-migration.txt` | `verify:migration` 127/127 | `0dbb58cd07fa96fa249346a13115dfd740c8bab582dc2216a67c1b7bba8724b7` |
| `evidence/wp5-final-artifacts.txt` | `verify:artifacts` 324/324 | `87c0c609fa66b1a0f5ef78a9a621973c3f8dc88fc2acacab2ebc8fc33b5fbfc2` |
| `evidence/wp5-final-skills.txt` | `verify:skills` 149/149 | `4eea0033bb8ccbab054fc7fbc072e8ffcc55e8c1ff66b124eec30e0d855ff92b` |
| `evidence/wp5-final-multitask.txt` | `verify:multitask` 174/174（复跑） | `7a7eecc65b208679221c9d92c84bc586d834a89709fe49601d9bcbb8ffbe41da` |
| `evidence/wp5-final-electron-verify.txt` | Electron 26/26 | `c6a3ee9daec6dc6b62300f891ce26eb90b57cc896160a18c0e9935401c249a98` |

分步证据：`evidence/p5a-*`、`p5b-*`、`p5c-b1-*`、`p5c-b2-*`、`p5d-b1-*`、`p5d-b2-*`；详见各 done 文档。

备份库 `.probe/backup-wp1/board.db`：348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`（未变）。

---

## 下一手需要什么

- **等你确认 WP5 收口后，进入 WP6（真实 benchmark 与演练）**；本轮不开始 WP6。
- 保持门禁：`verify:all` **688**、`verify:flags` **214**、`verify:gate` 52、`verify:scope` 308、`verify:migration` 127、`verify:artifacts` 324、`verify:skills` 149、`verify:multitask` 174、Electron 26、smoke 297。
- WP6 若要改 command 模式/代理/scope 默认/契约字段：先写 `docs/requests/` 或决策文档，停下问用户；不要直接改 `events.ts`/main 路径。
- WP6 先 dry-run，真实题 3 次跑单独申请 token；不把 1 次样本写成规律。
- 若全量数字与 P5-D 不一致（有人顺手改了代码），先停下报差异，不要自行修。
- **不要重开 WP5 决策**：manual 默认、command 不做、dry-run 只预览、manual 不改 task、记分板含归档、CSV 表头 hack、submitStatus `"manual"`、board v3、verify:flags 独立。如要改先停下问。
