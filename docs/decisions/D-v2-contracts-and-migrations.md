# D-V2-1：V2 契约增量、迁移与语义决定

> 2026-10-25 · 关联：`docs/plans/COMPETITION-V2.md`、`docs/decisions/D-v2-baseline-conflicts.md`。

## 1. 契约增量

| 增量 | 文件 | 兼容性 |
|---|---|---|
| `AnswerSpec` / `AnswerMode` / `AnswerType` / `AnswerNormalizer` | `packages/shared-protocol/events.ts` | 全新可选字段；旧任务无 spec 时回落 `flag{...}` |
| `task.create.answerSpec?`、`task.create.points?` | 同上 | 可选；旧调用方不变 |
| `TaskView.answerSpec?` / `points?` / `allowedActions?` | 同上 | 可选；旧快照/旧 mock 不读不炸 |
| `FlagCandidateView.answerType/normalizedValue/specId?`、`FlagSourceView.line/offset/sourceKind/sourcePath?` | 同上 | 可选 |
| `StrategyPlanView` / `strategy.plan` / `strategy.apply` | 同上 | 新动作；旧主进程不识别时 UI 只显示错误 |
| `task.update` / `task.scope.update` | 同上 | 新动作 |
| `IrAnswerCandidateView` / `IrAnalysisView` / `ir.analyze` / `ir.questions.import` | 同上 | 可选视图字段/新动作 |

原则：**只加可选字段/新动作，不改旧字段语义**；旧渲染层/旧快照兼容由 smoke/verify 测试覆盖。

## 2. 数据库迁移

| 版本 | 内容 | 回滚 |
|---|---|---|
| v5 | `tasks.answer_spec`；`flag_candidates.answer_type/normalized_value/spec_id`；`flag_sources.line/byte_offset/source_kind/source_path` | 只加列；旧代码忽略新列 |
| v6 | `tasks.allowed_actions TEXT NOT NULL DEFAULT '[]'` | 只加列；旧代码忽略 |

- 逐列检查 + `PRAGMA user_version`，幂等；旧库可打开；启动备份仍生效。
- `flag_candidates` 表名保留（历史兼容），语义上成为“答案候选”存储。
- IR 不新增表：问题/证据/时间线/分析摘要继续用 `facts` 结构化 schema；答案候选值复用 `flag_candidates`。

## 3. 答案明文策略

- `flag.candidate` / `flag.source` 事件只写 `candidateId/valueHash/answerType/sourcePath/line`；
- `task.setStatus` 的 `answer` 事件只写 `answerHash`；
- 附件扫描审计只写数量/路径/类型；
- IR `ir.answer_candidate` 事实只写 candidateId/来源/缺口，不写值；
- 候选值只在 `flag_candidates` 表与 `flag.export`/IR 导出内容中返回；
- **事实/证据本身**（IOC、日志行、问题文本）仍会进入 `events`，这是证据链需要；它们不是“已确认答案”。此边界写入文档与 UI 提示。

## 4. 战略层语义

- `strategy.plan` 只读；`strategy.apply` 必须由人工显式调用，按当前状态重算计划，不信任渲染层传入的 EV/agent/role。
- 只执行 `start_session` / `stop_session` / `switch_role`；`continue/verify/abandon/reallocate` 只建议。
- `competition-auto` 只是显式模式，不是后台自动循环；仍受 `maxSessions/maxSessionsPerTask/maxNewSessions/scope/审批/预算` 限制。
- 跨任务 apply 受现有 `session.stop` 焦点语义限制；需先切任务（避免一次点击停掉别的任务）。
- 评分权重集中可配置；不写 Web 专用规则。

## 5. IR 分析语义

- 分析器只产生 facts/timeline/IOC/候选；不确认、不提交、不执行 payload。
- 外部工具：参数数组 + `shell:false` + cwd 任务目录 + 超时/输出上限 + audit；工具缺失返回 warning，不伪造结果。
- 问题映射是启发式，候选默认 E1；无证据时给 gap（E0）。
- 真实 IR 数据未验证前，报告必须写“fixture verified, real IR not verified”。

## 6. allowedActions 语义

- `allowedActions` 非空且 `scope.enabled=true` 时，未列出的动作 → `approve`（人工），不是 `block`。
  理由：数据可能不完整/误配；直接 block 会把正常动作卡死，且与“资格优先可配置”一致。
- 硬阻断 `block` 仍优先；allowedActions 不能绕过。
- `scope.enabled=false` 时完全忽略（旧行为）。
- 这不是 OS 级隔离；agent 自执行命令/代理绕过仍只能审计。

## 7. benchmark 字段

- `expectedFlagFile` 保留兼容；新增 `expectedAnswerFile`，两者至少一个存在。
- `resetMode` 只允许 `manual|local-script`；不接受平台 API/自动开环境。
- 同一 challenge 同时有 `expectedFlagFile`/`expectedAnswerFile` 时校验两者存在；报告优先展示 `expectedAnswerFile`。
- `bench-metrics.ts` 是 V2 完整指标聚合；旧 `bench-aggregate.ts` 保留（P6-A 历史测试用）。

## 8. 依赖

本轮**没有新增第三方依赖**；答案/战略/IR 均用 Node 标准库与现有模块。
