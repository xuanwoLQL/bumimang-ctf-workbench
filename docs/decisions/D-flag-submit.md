# D-flag-submit · flag 提交默认 manual，contract 只做记录

- 日期：2026-10-24
- 状态：P5-D 批次 1/2 已实施；P5-E 补写本决策（未改代码）
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP5；`docs/plans/COMPETITION-READINESS.md` §8.4/§8.5/§8.6；`docs/done/P5-D.md`、`WP5-flags.md`
- 实现：`packages/shared-protocol/events.ts`、`apps/desktop/src/main/hub/hub.ts`、`apps/desktop/src/main/blackboard/board.ts`、`apps/desktop/src/main/electron/validate-action.ts`、`apps/desktop/src/renderer/flags.ts`

## 背景

WP5 要把 flag 候选从“能看”补到“能人工确认/误报/导出/提交/记分”。其中“提交”是最容易越过安全边界的一步：

- 平台提交可能涉及 token/凭据、外部 API、命令执行；
- 用户明确要求 **不做 command 提交模式**（WP6 评估前）；
- 比赛纪律要求“不自动提交 flag、不把 token 写进仓库/日志”。

因此 P5-D 只做 **manual 记录 + dry-run argv 预览**：应用不执行命令、不调平台 API；用户自己复制 flag 到平台，应用只记录 `submitted_at`。

## 决策

### 1. 默认 manual；不做 command 模式

1. `flag.submit` 的 `mode` 缺省/`manual`：只更新候选 `submitted_at`、`submit_status="manual"`，返回 `{ mode:"manual", value, instructions }`；不执行任何命令。
2. `mode=dry_run`：只返回 `argv` 预览；不执行、不写文件、不改候选状态、不写 flag.submit 事件。
3. `mode=command`：**明确拒绝**，错误 `command 模式未实现（用户决策：WP6 评估前不做）`；validate-action 在 IPC 入口也直接抛同一可读错误。
4. 契约的 `HubAction.flag.submit.mode` 只声明 `"manual" | "dry_run"`；command 不是合法契约值，运行时伪造会被拒绝。
5. dry-run 的 argv 由 `tasks.submit_command`（JSON argv 数组或空白分隔，支持 `{flag}/{value}/{taskId}` 占位）构造；未配置时 `[flag 值]`。**只构造字符串数组，不启动进程。**

### 2. manual 不调平台 API、不 spawn/exec/fetch

1. Hub 的 `flag.submit` 分支不 import `child_process`、不调用 `spawn`/`exec`/`execFile`/`execSync`/`spawnSync`，不调用 `fetch`/`http(s).request`/`axios`。
2. 渲染层 `flags.ts` 只 dispatch `flag.submit`，不直接调平台 API；无 `fetch/http/axios`、无 `child_process/spawn/exec`。
3. 硬查证据：`evidence/p5d-b1-hard-check.txt`（hub flag.submit / buildSubmitArgv / board updateFlagSubmitStatus / validate flag.submit 四块零命中；三文件 `child_process` 0）与 `evidence/p5d-b2-hard-check.txt`（renderer flags/main 零命中）。
4. manual 的 `instructions` 明确写：“复制 flag 到比赛平台手动提交；本应用不会自动提交、不会调用平台 API。”

### 3. token/凭据不入库、不入日志；审计脱敏

1. `flag.submit` 不接收 token/凭据字段；`tasks.submit_command` 只作为 argv 模板，不存 token；`config/app.json` 不提供提交凭据。
2. `board.updateFlagSubmitStatus` 只写 `submitted_at/submit_status`；lifecycle 事件/audit 只记 `candidateId/status`，**不写 flag 明文**。
3. 导出内容本身含 flag（用户显式导出），但 `flag.export` 事件/审计只记 format/count，不记内容；提交弹窗不把 flag 写入 events/audit。
4. 已知历史：P5-A 的 `flag.candidate` 事件带 value（既有行为）；P5-D 不新增明文日志。

### 4. 记分板含归档；points 无生产写入入口

1. `board.getScoreboard()` 聚合**全部任务**（含归档）：`solved` 是 `status=solved` 数，`total` 是任务数，`points` 是 `tasks.points` 之和，`flagCount` 是该任务三态候选总数。
2. 渲染层记分板灰显归档任务，但计入 total/points/solved（与批次 1 语义一致）。
3. `tasks.points` 列 P5-A 已加；P5-D 只读展示，**没有生产写入入口**（测试用 raw UPDATE / mock 夹具）；录入 UI/命令留 WP6/后续。
4. 若 WP6 要排除归档，需同时改 board.getScoreboard、renderer 视图与测试，并写行为变更。

### 5. submitStatus 追加 `"manual"` 字面量（向后兼容）

1. `FlagCandidateView.submitStatus` 原本是 `"dry_run" | "ok" | "failed" | "timeout" | null`；P5-D 追加 `"manual"`。
2. 理由：manual 必须把新状态值写进库并让快照/导出/UI 可见；否则 manual 状态无法表达。
3. 这是**可选字段的字面量追加**，不新增必填字段、不改字段语义；旧渲染层/旧测试不读该值仍工作。
4. 没有新增 `submitMode` 字段；`TaskView.submitMode?: "manual"` 是任务级提交模式，不是候选状态。

### 6. task.setStatus 改回非 solved 的 DELETE 语义保留（破坏性，已知）

1. P5-A 的 `task.setStatus` 在 `status !== "solved"` 时调用 `clearFlagCandidates(taskId)`，删除该任务全部候选/来源。
2. P5-D **不修改**该语义；flag 面板不提供“改回非 solved”入口（现有任务状态弹窗仍保留 R16 的“改回待解”，这是既有功能）。
3. 影响：如果用户把已 solved 任务改回 open，候选/来源会被删除；这是 P1-C 旧语义，不是 P5-D 引入。
4. 若 WP6 需要保留历史审计，需重新评估（例如软删除/审计表），并写新的决策/迁移。

### 7. CSV 表头 hack（兼容 P5-C C4）

1. P5-C 的 C4 断言精确匹配 CSV 首行：
   `taskId,taskTitle,taskStatus,flag,status,evidence,sources,firstSeen,submittedAt`。
2. P5-D 要补 `submit_status`，但 C81 不允许改。因此 **CSV 表头保持不变**，submit_status 追加在 `submittedAt` 单元里（例如 `2026-...Z manual`）。
3. MD 的“已提交”单元同样追加 status；JSON 原本已有 `submitStatus/submittedAt`。
4. 若后续要独立列，必须同步更新 P5-C C4 断言、写行为变更，并确认旧导出消费者。

### 8. 未来若做 command 模式的前置条件

必须同时满足，缺一不做：

1. **用户明确批准**（单独决策/授权，不是默认开启）。
2. **无 shell**：`spawn(argv[0], argv.slice(1), { shell:false })`；不支持 `cmd /c`/PowerShell 字符串。
3. **argv 数组**：优先 JSON argv；字符串模板只做简单空白分隔，拒绝未闭合引号/NUL。
4. **超时**：默认 30s（`tasks.submit_timeout_ms`），超时杀进程树。
5. **审计脱敏**：stdout/stderr 只记字节数/退出码/命中布尔值，不写 flag/token 明文；审批卡/落库脱敏。
6. **dry-run 必绿**：先跑 dry-run 预览 argv，再人工点“确认提交”；失败/超时可重试。
7. **环境变量**：`FLAG`/`TASK_ID` 只注入子进程，不写仓库/日志；不内置平台凭据。
8. **策略可拦**：命令走策略引擎，block 不可放行；cwd 限定任务目录；输出上限 1MB。
9. **默认仍 manual**：command 只在任务显式配置 `submit_mode="command"` 且用户人工确认时使用；不能静默升级。

## 备选方案与取舍

- **默认 command**：能自动提交，但执行面/凭据/平台差异风险大；用户明确决策不做。否决。
- **manual 直接写 task solved**：会让“复制到平台”被误当“已解出”；否决。manual 只记录提交时间。
- **dry-run 也落库**：预览必须零副作用；否决。
- **把 flag 明文写进 events/audit**：违反安全纪律；否决。只记 candidateId/status。
- **记分板排除归档**：历史积分会丢；批次 1 选择包含归档；WP6 再评估。
- **CSV 新增独立列**：会破坏 P5-C C4 精确断言；本轮用追加单元 hack，后续统一迁移。
- **submitStatus 新增字段**：会多一个与 submitStatus 语义重叠的字段；改为追加 `"manual"` 字面量。
- **command 只做 dry-run 不做执行**：已是当前状态；未来做执行必须满足 §8 前置条件。

## 影响

- **manual 提交**：只改候选 `submitted_at/submit_status`；不改 task 状态/answer；不影响 scoreboard points/solved。
- **dry-run**：零副作用；不写文件/事件/候选状态。
- **command**：明确拒绝；不静默降级。
- **渲染层**：提交入口仅 `new/confirmed`；false_positive 不显示；无 command tab/执行按钮；无平台 API。
- **记分板**：含归档；points 默认 0；无生产写入入口。
- **契约**：只加可选/新 action；`submitStatus` 追加字面量；旧快照/旧 mock 不炸。
- **审计**：manual 写 lifecycle/audit（无 flag 明文）；dry-run 不写；事件量增长需 WP6 观测。

## 已知限制

1. command 模式未实现（用户决策）；dry-run 只预览 argv；manual 只记录 submitted_at。
2. manual 不改 task 状态/answer；提交与“解出”分开。
3. dry-run 不落库。
4. 记分板含归档；UI 灰显但计入。
5. points 无生产写入入口。
6. CSV 表头 hack（兼容 P5-C C4）。
7. submitStatus 追加 `"manual"`。
8. task.setStatus 改回非 solved 仍 DELETE 候选/来源。
9. validate-action 的 ctx 未由 main.ts 注入；归属由 Hub 兜底。
10. 无保存对话框 IPC；提交/导出用弹窗复制。
11. 后台 submit_fact 的 fact 只在焦点/flush 时进候选。
12. 无 backfill。
13. board user_version=3。
14. 事件量增长。
15. permission.grantAll.taskId 跨任务批量授权未实现（WP1 遗留）。
16. multitask F flaky、render-verify 6 项、两个 UI 撒谎点挂账（WP6）。
17. verify:flags 独立于 verify:all。
18. 代理默认关；scope.enabled 默认关；outOfScopeAction 默认 approve。
19. 没有真实 agent 的提交流程验证（0 token）。
20. 打包态提交/记分板未验证（WP7）。

## 后续

- **WP6**：评估 command 模式是否值得做（必须先满足 §8 前置条件）；真实题验证 manual 流程；points 生产写入；记分板导出；后台 fact 即时性；backfill；事件量/哈希链性能。
- **WP7**：打包态提交弹窗/记分板/导出走查；若需要保存对话框，走可选 IPC 并写决策。
- **不要重开本决策**：默认 manual、command 不做、dry-run 只预览、manual 不改 task、记分板含归档、CSV 表头 hack、submitStatus `"manual"`、task.setStatus DELETE 语义。如要改先停下问。
