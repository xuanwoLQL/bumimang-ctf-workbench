# D-awd-ir-design · AWD/IR 复用现有任务模型（只读视图，不新增表）

> 决策日期：2026-10-25。状态：**WP8 设计决策**；不写代码、不改 ARCHITECTURE。

## 背景

WP8 只设计 AWD/应急（IR）。现有模型已有 tasks/facts/dead_ends/leases/approvals/targets/attachments/artifacts/flags/scoreboard，且 WP1–WP6 已验证。问题是：AWD 轮次/服务/补丁/检查/攻击、IR 时间线/问题/答题卡是否要新表/新任务体系。

## 决策

1. **一个 AWD 比赛 = 1 个 task（category=awd）；一次应急 = 1 个 task（category=ir）**。
   - 不按轮次/问题拆 task；避免 task 切换割裂 workDir/证据/flag/审批/上下文。
2. **MVP 不新增表**：AWD/IR 视图为只读派生视图；用现有 facts 的结构化约定（`schema:"awd.round"` 等）+ targets/leases/flag_candidates/approvals/attachments/artifacts/events 组合。
3. **不新增平台写接口/凭据**；批量提交仍逐条 `flag.submit` manual，需人工确认；不自动利用/开环境。
4. **WP9 才实施**；若强类型查询/数据量需要，再按 `docs/design/AWD-IR.md` §1.3 候选 schema 做迁移 v4 + 旧库兼容 + verify-migration，不在 WP8 写。
5. 与 ARCHITECTURE 的差异仅 category 语义取值 + 只读视图/结构化事实约定；**不改 ARCHITECTURE**。

## 为什么

- 复用 task 级 workDir/证据/审批/flag/恢复/记分，避免第二套状态源。
- 只读视图可先验证 UI/流程，不锁死 schema；真实 AWD/IR 数据不足，过早建表风险高。
- 不接平台 API 是比赛合规/安全底线；批量只做 UI 编排。
- 结构化 fact 弱类型有解析风险，作为 MVP 折中；WP9 强类型表是退路。

## 影响

- `HubSnapshot` 未来可加只读 `awd?`/`ir?` 视图（WP9），不加强制字段；旧快照不炸。
- 现有 `task.category` 字符串无需迁移；UI 按 category 显示只读视图。
- 不改变 flag/审批/证据/进程/路径行为。

## 限制

- 结构化 fact 约定非强类型；解析失败保留原文。
- 轮次/服务状态依赖人工；时钟本机。
- 多问题答题卡不使用 `task.answer`。
- 无真实 AWD/IR 数据；设计未验证。
- 平台 API/自动利用/自动开环境明确不做；后续若要做需用户单独授权并重开决策。

## 证据/引用

- `docs/design/AWD-IR.md`
- `docs/done/WP8-design.md`
- `docs/plans/COMPETITION-READINESS.md` §11
