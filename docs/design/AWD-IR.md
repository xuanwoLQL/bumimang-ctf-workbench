# AWD / 应急（IR）设计

> WP8 · 只设计，不写代码。日期：2026-10-25。
> 门禁：WP1–WP6 已收口；WP6 benchmark **样本不足，未证明扇出正收益**，因此本文件只做设计，不实施。
> 原则：复用现有 tasks/facts/dead_ends/leases/approvals/targets/attachments/artifacts/flags；**不接平台写 API、不自动提交、不自动利用、不自动开环境**。

## 0. 一页结论

- **一个 AWD 比赛 = 1 个 task**（`category=awd`）；**一次应急 = 1 个 task**（`category=ir`）。轮次/服务/补丁/检查/攻击/问题都是该 task 下的结构化事实与现有视图，不另起一套任务体系。
- MVP **不新增表**：AWD/IR 视图是只读派生视图；用现有 `facts` 的结构化约定 + `targets`/`flag_candidates`/`approvals`/`attachments`/`artifacts`/`events` 组合。若 WP9 需要强类型查询，再按本文候选 schema 新增表。
- 所有外部动作（提交 flag、批量提交、补丁、防守检查、导入/解析、结论导出）**人工确认**；不接平台 API、不自动执行利用、不自动开环境。
- 与 ARCHITECTURE 的差异只涉及 category 取值与只读视图约定，写入 `docs/decisions/D-awd-ir-design.md`；不改 ARCHITECTURE。

## 1. AWD

### 1.1 实体映射（复用现有模型）

| AWD 概念 | 现有模型 | 说明 |
|---|---|---|
| 比赛 | `tasks` 一行（`category=awd`） | 一个比赛一个 task；workDir/证据/审批/flag 都在 task 下 |
| 轮次 | `facts`（结构化约定 `schema:"awd.round"`）+ lifecycle event | 轮次号/开始/结束/时长；不新增表 |
| 服务 | `targets`（host:port）+ `facts`（`awd.service`）+ `leases` | 服务清单/状态/负责人；targets 已有 kind/status/notes |
| flag 轮换 | `flag_candidates` + `flag_sources` | 每轮 flag 候选/来源/E2；确认走现有 flag.confirm |
| 批量提交 | 现有 `flag.submit`（manual/dry_run）逐条 | 人工确认后逐条记录；不接平台 |
| 补丁台账 | `facts`（`awd.patch`）+ `artifacts` + `approvals` | 漏洞/补丁/验证状态/证据；写操作走审批 |
| 防守检查表 | `facts`（`awd.check`） | 每轮必查项/状态/证据；人工执行 |
| 攻击日志 | `facts`（`awd.attack`）+ `dead_ends` + `approvals` + `audit` | 谁打谁/结果/证据；不自动利用 |

**为什么一个比赛一个 task**：task 级 workDir、证据、flag、记分板、审批、恢复都现成；每轮一个 task 会让跨轮 flag/服务/补丁/上下文割裂，并频繁触发 task 切换。轮次用 facts 表达即可。

### 1.2 AWD 七项功能

#### 1) 轮次计时

- 数据：`awd.round` fact：`round`、`startedAt`、`durationMs`、`endedAt`、`note`。
- 视图：`AwdRoundView { round, startedAt, endsAt, remainingMs, state }`；UI 顶部计时条；人工“开始本轮/结束本轮”（写入 fact）。
- 不自动从平台拉轮次；不自动开/关环境；时钟以本机为准，UI 显示“手动同步”。

#### 2) 服务清单

- 数据：`targets`（value=`host:port`，kind=`service`，status=`unknown|up|down|owned`，notes）+ `awd.service` fact（服务名、语言/框架、负责会话、补丁状态）。
- 视图：`AwdServiceView { id, name, target, status, ownerSessionId, patchStatus, lastCheckAt }`。
- 负责人可用 `leases` 资源（`service:<host:port>`）表达；lease 由现有 Hub 管理。
- 状态更新为人工/受审批命令；不自动扫描/不自动重启服务。

#### 3) flag 轮换

- 数据：每轮 `flag_candidates`（value、first_seen、evidence、witness、source_session）+ `flag_sources`；轮次 fact 记录 round。
- 视图：`AwdFlagRoundView { round, candidates[], confirmedCount, submittedCount }`。
- 确认走现有 `flag.confirm`（人工）；不自动 confirm/submit；flag 明文不进 events/audit（现有约束）。

#### 4) 批量提交（人工确认）

- 数据：已确认/待提交候选 + 现有 `flag.submit`（manual/dry_run）。
- 流程：UI 勾选多个候选 → 一次人工确认对话框（列出 value/轮次/服务）→ 逐条 `flag.submit mode=manual` 记录 `submitted_at/submit_status`；可选先 `dry_run` 预览 argv。
- **不接平台写 API、不自动提交**；批量只是 UI 编排，底层仍是现有单条 manual submit。
- command 模式未实现；WP8 不补。

#### 5) 补丁台账

- 数据：`awd.patch` fact：`vuln`、`service`、`file`、`patch`、`status`（proposed/applied/verified/failed）、`evidence`、`witness`、`by`。
- 证据：`artifacts`（任务目录内文件）+ `attachments`（外部补丁/日志）+ 现有 E1/E2。
- 应用补丁是命令/文件写，走现有审批（guarded）；不自动应用、不自动回滚。
- 视图：`AwdPatchView { id, vuln, service, status, evidence, verifiedAt }`。

#### 6) 防守检查表

- 数据：`awd.check` fact：`round`、`item`、`status`（todo/ok/fail）、`evidence`、`checkedAt`、`by`。
- 每轮模板可由 briefing/playbook 静态给出；检查动作人工执行；结果写 fact/证据。
- 视图：`AwdCheckView { round, items[], passCount, failCount }`。
- 不自动执行检查命令（nmap/curl 等需审批）；不自动修复。

#### 7) 攻击日志

- 数据：`awd.attack` fact：`attacker`、`target`、`action`、`result`、`evidence`、`at`；失败线写 `dead_ends`；涉及命令写审批/审计。
- 视图：`AwdAttackView { id, attacker, target, action, result, evidence, at }`。
- 不自动利用、不自动横向、不自动开环境；所有攻击动作经现有策略/审批。

### 1.3 AWD 数据模型建议

**MVP（WP8 设计，WP9 才实施）不新增表**：

- `AwdView` 只读派生：
  ```ts
  interface AwdView {
    taskId: string;
    round: { number: number; startedAt: number; endsAt: number; state: "idle"|"running"|"ended" } | null;
    services: AwdServiceView[];
    flags: AwdFlagRoundView[];
    patches: AwdPatchView[];
    checks: AwdCheckView[];
    attacks: AwdAttackView[];
    scoreboard?: ScoreboardView; // 复用现有
  }
  ```
- 结构化 fact 约定：`content` 为 `{"schema":"awd.round",...}` JSON 字符串；read-only view 解析失败时忽略并显示原始 fact（不猜测）。
- 复用 `task.category="awd"` 触发 AWD 视图；旧 task 无 category 不受影响。

**WP9 可选强类型表**（只有需要 SQL 过滤/大量数据时）：

```sql
awd_rounds(id, task_id, round_no, started_at, ended_at, duration_ms)
awd_services(id, task_id, name, host, port, status, owner_session_id, patch_status)
awd_patches(id, task_id, service_id, vuln, status, evidence, witness, updated_at)
awd_checks(id, task_id, round_no, item, status, evidence, checked_at)
awd_attacks(id, task_id, attacker, target, action, result, evidence, at)
```
前置条件：WP9 明确需要；迁移 v4 + 旧库兼容；不得在 WP8 写。

### 1.4 AWD 流程

1. 赛前：建 task（`category=awd`）、写入服务 targets、轮次模板、检查表模板。
2. 每轮：人工开始轮次（fact）→ 更新服务状态/负责人（targets/lease）→ 防守检查（检查表）→ 发现 flag（候选）→ 人工 confirm → 批量/单条 manual submit（记录）→ 攻击/补丁/失败线（facts/dead_ends）。
3. 结束：人工结束轮次；保留 facts/events/audit/flag 候选；导出只读报告（复用 flag.export 模式，WP9 再加 AWD 报告）。

### 1.5 AWD 安全/审计约定

- 不接平台写 API、不自动提交、不自动利用、不自动开环境。
- 所有命令/文件写走现有策略/审批；批量提交需一次人工确认。
- events/audit 不写 flag 明文；flag 只经 `flag.export` 内容返回/候选视图。
- 证据走附件/工件/E1/E2；witness 路径必须在 task workDir 内。
- 每轮动作留 lifecycle event/audit；不自动截断。

## 2. 应急（IR）

### 2.1 实体映射

| IR 概念 | 现有模型 | 说明 |
|---|---|---|
| 一次应急 | `tasks` 一行（`category=ir`） | 一个事件一个 task；workDir/证据/附件 |
| 证据板 | `attachments`（P3-A）+ `artifacts`（P3-C）+ `facts` | 文件、哈希、E0/E1/E2 |
| 时间线 | `facts`（`ir.timeline`）+ `events` | 事件时间/来源/影响；人工整理 |
| 日志/内存/PCAP 导入 | `attachment.import` | 现有导入/扫描；不自动解析（解析器 WP9+） |
| 问题清单/答题卡 | `facts`（`ir.question`） | 多问题/状态/答案/证据；不占用 task.answer |
| 结论导出 | 只读导出 action（WP9）或复用 flag.export 模式 | md/csv/json 内容返回，不写文件/不接平台 |

### 2.2 IR 五项功能

#### 1) 证据板

- 视图：`IrEvidenceView { id, kind, path, sha256?, evidence, witness?, source, addedAt }`。
- 文件导入走现有 `attachment.import`（大小/路径校验）；文件只读；不自动执行。
- 证据链 E2 依赖 task workDir 内 witness；哈希/来源显示；不自动判 E2。

#### 2) 时间线

- 数据：`ir.timeline` fact：`at`、`source`（日志/内存/PCAP/人工）、`event`、`impact`、`evidence`。
- 视图按 `at` 排序；人工录入/修正；可关联附件/事实。
- 不自动从日志推断时间线（WP9+ 解析器需单独设计）。

#### 3) 日志/内存/PCAP 导入

- 复用附件导入：文件落 task `attachments/`，保留原始名/大小/哈希；扫描只做已有安全扫描，不自动解析。
- 大文件限制/磁盘/内存风险在 UI 提示；不自动上传外部服务。
- PCAP/内存镜像解析器、工具编排不在 WP8；不自动开环境/不自动外传。

#### 4) 问题清单/答题卡

- 数据：`ir.question` fact：`id`、`question`、`status`（open/answered/verified）、`answer`、`evidence`、`updatedAt`。
- 视图：`IrQuestionView { id, question, status, answer, evidence }`；多问题不占用 `tasks.answer`（单答案字段）。
- 导出答题卡（md/csv/json）只读；人工提交到平台（不自动）。

#### 5) 结论导出

- 复用现有导出内容模式：返回 `content`，不写文件；格式 md/csv/json。
- 内容包含问题/答案/证据/时间线；flag 明文按现有 flag 导出规则处理。
- 不接平台 API、不自动提交。

### 2.3 IR 数据模型建议（MVP 不新增表）

```ts
interface IrView {
  taskId: string;
  evidence: IrEvidenceView[];
  timeline: IrTimelineView[];
  questions: IrQuestionView[];
  attachments: AttachmentView[]; // 复用
  artifacts: ArtifactView[];     // 复用
}
```

- 结构化 fact 约定：`{"schema":"ir.timeline"} / {"schema":"ir.question"}`；解析失败保留原文。
- 不强依赖新表；WP9 如需要再建 `ir_timeline/ir_questions`（前置条件同 AWD）。

### 2.4 IR 流程

1. 建 task（`category=ir`）；导入日志/内存/PCAP/截图（附件）。
2. 建问题清单（facts）；按时间线整理事件；证据关联。
3. 逐题回答/验证；证据 E0/E1/E2；导出答题卡（内容返回）。
4. 人工提交平台；保留附件/事实/审计。

### 2.5 IR 安全/审计

- 不自动执行证据文件/不自动外传/不接平台。
- 大文件/敏感数据只在本机 task workDir；导出内容由用户决定。
- 审计保留导入/问题状态/导出格式/数量，不写敏感明文（沿用现有 redaction）。

## 3. 复用与不新增表

- 任务：`tasks`（category=awd/ir；workDir/status/answer 等现有）。
- 事实/失败线/意图/租约：`facts`/`dead_ends`/`intents`/`leases`。
- 目标/服务：`targets` + `leases`。
- flag：`flag_candidates`/`flag_sources` + `flag.confirm/export/submit`。
- 证据：`attachments`/`artifacts` + events/audit + E1/E2。
- 审批：`approvals`；所有命令/文件写仍走现有策略。
- 记分：`scoreboard`；不另建积分表。
- **MVP 不新增表**；AWD/IR 视图只读派生。WP9 若需要强类型，再按 1.3 候选 schema 迁移。

## 4. 与 ARCHITECTURE 的差异

- `task.category` 新增语义取值 `awd`/`ir`（现有字段已支持任意字符串；不加列）。
- 新增只读 `AwdView`/`IrView` 与结构化 fact 约定；不改现有表/契约必填字段。
- 不新增平台写接口/凭据；不自动提交/利用/开环境。
- 决策记录：`docs/decisions/D-awd-ir-design.md`；不改 `docs/ARCHITECTURE.md`。

## 5. 前置条件与风险

### 前置条件

- WP1–WP6 全绿；**真实 benchmark 需证明并行有正收益**——WP6 样本不足，尚未证明，因此 WP8 只设计、不实施。
- WP9 实施前需要：真实 AWD/IR 题目/流程样本、UI 评审、数据量评估、平台接口明确禁止/授权边界。
- 如需新表：先写迁移 v4 + 旧库兼容 + verify-migration 更新；不在 WP8 做。
- 如需平台 API：必须用户明确授权 + 凭据管理 + 审计；当前设计明确不接。

### 风险

- 结构化 fact 约定是弱类型；解析失败/字段漂移会丢视图信息；WP9 强类型表可缓解。
- 轮次计时/服务状态依赖人工输入；本机时钟与平台不同步。
- 批量提交仍是逐条 manual；平台侧批量/限速/轮次关闭无法感知。
- 多问题答题卡不能用单 `task.answer`；必须用 facts/新表，导出需自定义。
- IR 大文件（内存/PCAP）导入/解析可能吃内存/磁盘；解析器不在 WP8。
- 无真实 AWD/IR 数据，设计未验证；不能声称可用。
- 与现有 flag/审批/证据的复用需要 UI 改造；WP8 不写。
- 平台写 API/自动利用是明确禁区；任何后续提议需用户单独授权。

## 6. 明确不做

- 不写代码、不新增表、不改 ARCHITECTURE。
- 不接平台写 API/凭据；不自动提交/批量提交/利用/开环境。
- 不自动轮次计时（只人工开始/结束）、不自动服务扫描/重启、不自动补丁/检查。
- 不自动解析日志/内存/PCAP；只复用附件导入。
- 不把 AWD/IR 塞进现有 WP 代码路径；WP9 单独实施。
- 不基于 WP6 样本声称扇出/题型收益（样本不足）。
