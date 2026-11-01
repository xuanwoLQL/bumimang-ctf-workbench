# WP8 · AWD / 应急模式（只设计）总收口

> 状态：**WP8 设计完成；零代码改动**。日期：2026-10-25。
> 依据：`docs/plans/COMPETITION-READINESS.md` §11；`docs/design/AWD-IR.md`；`docs/decisions/D-awd-ir-design.md`。
> 门禁说明：WP1–WP6 已收口，但 WP6 benchmark **样本不足，未证明扇出正收益**；因此 WP8 只设计，不实施。

## 做了什么

- 写 `docs/design/AWD-IR.md`：
  - AWD 7 项：轮次计时、服务清单、flag 轮换、批量提交（人工确认）、补丁台账、防守检查表、攻击日志；
  - IR 5 项：证据板、时间线、日志/内存/PCAP 导入、问题清单/答题卡、结论导出；
  - 复用 tasks/facts/dead_ends/leases/approvals/targets/attachments/artifacts/flags/scoreboard；
  - MVP 不新增表；只读派生视图 + 结构化 fact 约定；WP9 候选强类型 schema；
  - 安全/审计/证据约定；明确不做平台 API/自动提交/自动利用/自动开环境。
- 写 `docs/decisions/D-awd-ir-design.md`：一个 AWD 比赛/一次应急 = 1 个 task；只读视图；不新增表；WP9 条件；不改 ARCHITECTURE。
- 本文件 + `docs/PROGRESS.md`。

## 设计摘要

### AWD

- 一个比赛一个 task（category=awd）；轮次/服务/补丁/检查/攻击为结构化 fact + 现有视图。
- 轮次人工开始/结束；服务 targets + lease；flag 现有候选/确认；批量提交逐条 manual + 一次人工确认；补丁/检查/攻击日志人工、走审批。
- 不自动扫描/利用/开环境；不接平台。

### IR

- 一次应急一个 task（category=ir）；证据板复用附件/工件；时间线/问题事实；答题卡多问题不占用 task.answer；导出内容返回、人工提交。
- 日志/内存/PCAP 只复用附件导入；不自动解析/外传。

### 数据模型

- MVP 不新增表；只读 `AwdView`/`IrView` 派生；结构化 fact `schema` 约定。
- WP9 如需强类型，按候选 schema 迁移 v4 + 旧库兼容 + verify-migration。
- 不接平台写 API；不引入凭据。

## 复用与边界

- 复用：tasks/facts/dead_ends/leases/approvals/targets/attachments/artifacts/flags/scoreboard/events/audit。
- 不另起任务/黑板/审批/flag/证据体系。
- 不改 ARCHITECTURE；差异写 decisions。
- 不写代码、不新增表、不接平台 API。

## 风险

- 结构化 fact 弱类型，解析失败/字段漂移；WP9 强类型表退路。
- 轮次/服务依赖人工；本机时钟。
- 批量提交仍是逐条 manual；平台限速/轮次关闭无法感知。
- 多问题答题卡不能用单 task.answer。
- IR 大文件导入/解析内存/磁盘风险；解析器不在 WP8。
- 无真实 AWD/IR 数据，设计未验证。
- 平台 API/自动利用是明确禁区。

## 明确不做

- 不写代码、不新增表、不改 ARCHITECTURE。
- 不接平台写 API/凭据；不自动提交/批量提交/利用/开环境。
- 不自动轮次/服务扫描/补丁/检查/日志解析。
- 不把 AWD/IR 塞进现有 WP 代码路径；WP9 单独实施。
- 不基于 WP6 样本声称扇出/题型收益（样本不足）。

## 验收对照（§11.3）

| 要求 | 结果 |
|---|---|
| 设计文档评审通过 | 设计已写；待用户评审 |
| 不产生代码变更 | **PASS**（本轮只新增文档） |
| 不引入平台凭据/写接口 | **PASS**（明确不做） |
| 与 ARCHITECTURE 差异写 decisions | **PASS**（D-awd-ir-design.md） |

## 证据

- `docs/design/AWD-IR.md`
- `docs/decisions/D-awd-ir-design.md`
- `docs/done/WP8-design.md`
- `docs/PROGRESS.md`

## 下一手需要什么

- FINAL 最终收口：写 `docs/RELEASE-READINESS.md`、更新 `docs/BLOCKED.md`、PROGRESS、最终全量。
- WP9 实施前置：真实 AWD/IR 需求/数据、UI 评审、数据量评估、平台边界授权；先停问用户。
- 不自动开始 WP9。
