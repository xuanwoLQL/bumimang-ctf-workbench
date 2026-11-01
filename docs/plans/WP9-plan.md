# WP9 计划 · AWD / 应急（IR）实施

> 状态：**计划草案（未实施）**。日期：2026-10-25。
> 依据：`docs/design/AWD-IR.md`、`docs/decisions/D-awd-ir-design.md`、`docs/done/WP8-design.md`、`docs/done/WP7-reliability.md`。
> 本轮只写计划，不写代码；等你评审后再开 WP9-A。
> 基线（WP7/FINAL）：verify:all 712/0、scope 354/354、flags 214/214、migration 127/127、artifacts 324/324、skills 149/149、multitask 174/174（F flaky 历史 173）、reliability 45/45、bench 73/73、electron 26/26、dir 包 26/26。

## 0. 一页结论

- **分四批**：WP9-A 只读模型层 → WP9-B UI（B1 AWD、B2 IR）→ WP9-C 导出/批量提交人工编排 → WP9-D 可选强类型表（默认不做）。
- **一个 AWD 比赛/一次应急 = 1 个 task**（category=`awd`/`ir`）。
- **MVP 不新增表**：`AwdView`/`IrView` 由现有 facts/targets/flags/attachments/artifacts 派生；结构化 fact 约定 `schema`。
- **不接平台写 API、不自动提交/利用/开环境、不自动解析日志/内存/PCAP**。
- 每批独立可停；WP9-A 不碰 renderer，WP9-B 才碰 UI；WP9-D 需单独批准。

## 1. 范围与非目标

### 范围

- AWD：轮次计时、服务清单、flag 轮换、批量提交（人工确认）、补丁台账、防守检查表、攻击日志。
- IR：证据板、时间线、日志/内存/PCAP 导入（复用附件导入）、问题清单/答题卡、结论导出。
- 复用现有 tasks/facts/dead_ends/leases/approvals/targets/attachments/artifacts/flags/scoreboard/events/audit。
- 只读视图 + 人工动作；不新增平台适配器。

### 非目标（WP9 全程）

- 不接平台写 API/凭据；不自动提交/批量提交到平台。
- 不自动利用/横向/开环境；不自动服务扫描/重启。
- 不自动解析 PCAP/内存/日志（解析器另立 WP，需单独设计）。
- 不在 WP9-A/B/C 新增表；WP9-D 才考虑强类型表（需批准）。
- 不把 AWD/IR 塞进现有 flag/审批/黑板语义之外另起一套。

## 2. 分批与出口

| 批次 | 内容 | 是否碰 UI | 出口门禁 |
|---|---|---|---|
| WP9-A | 契约 + 只读模型派生 + verify:awdir | 否 | verify:awdir 绿；全量现有套件绿；零新表 |
| WP9-B1 | AWD 只读 UI（轮次/服务/flag 轮换/补丁/检查/攻击） | 是 | smoke + 全量；无平台/无自动动作 |
| WP9-B2 | IR 只读 UI（证据板/时间线/问题答题卡） | 是 | smoke + 全量；附件复用 |
| WP9-C | 导出 content（md/csv/json）+ AWD 批量 manual 提交编排 | 是（按钮） | 导出不写文件/不接平台；manual 仍逐条 |
| WP9-D | 可选强类型表 v4（默认不做） | 后端 | 需用户单独批准；migration/回滚/全量 |

**每批结束都停下等确认；不自动进下一批。**

## 3. WP9-A · 只读模型层

### 3.1 目标

把 AWD/IR 的领域视图从现有数据派生出来，供 UI/导出使用；不新增表、不改现有行为。

### 3.2 文件清单

**新增**

- `apps/desktop/src/main/awdir/model.ts`：纯函数解析/聚合（无 DB/无 Electron）。
  - `parseAwdFacts(facts, targets, flags, sessions)` → `AwdView`
  - `parseIrFacts(facts, attachments, artifacts)` → `IrView`
  - structured fact 解析失败返回 warning + 原文，不抛错。
- `apps/desktop/src/cli/verify-awdir.ts`：A 组（模型/契约）测试；不并入 verify:all。
- `docs/done/P9-A.md`（实施后）。

**修改**

- `packages/shared-protocol/events.ts`：只加可选 `HubSnapshot.awd?: AwdView`、`HubSnapshot.ir?: IrView`（以及视图子类型）；不加必填。
- `apps/desktop/src/main/hub/hub.ts`：快照按焦点 task.category 填 `awd`/`ir`（只读；失败不影响快照）。
- `package.json`：`verify:awdir`（不并入 verify:all）。
- `docs/PROGRESS.md`、`docs/done/P9-A.md`。

**不碰**：board.ts schema、renderer、acp/session/mcp-host、config/rules、verify:all 链。

### 3.3 契约（草案）

```ts
interface AwdRoundView { number: number; startedAt: number; endsAt: number; state: "idle"|"running"|"ended" }
interface AwdServiceView { id: string; name: string; target: string; status: "unknown"|"up"|"down"|"owned"; ownerSessionId?: string|null; patchStatus?: string|null }
interface AwdFlagRoundView { round: number; candidates: FlagCandidateView[]; confirmed: number; submitted: number }
interface AwdPatchView { id: string; service: string; vuln: string; status: "proposed"|"applied"|"verified"|"failed"; evidence: string; witness?: string|null }
interface AwdCheckView { round: number; item: string; status: "todo"|"ok"|"fail"; evidence?: string|null }
interface AwdAttackView { id: string; attacker: string; target: string; action: string; result: string; evidence?: string|null; at: number }
interface AwdView { taskId: string; round: AwdRoundView|null; services: AwdServiceView[]; flags: AwdFlagRoundView[]; patches: AwdPatchView[]; checks: AwdCheckView[]; attacks: AwdAttackView[]; scoreboard?: ScoreboardView }

interface IrEvidenceView { id: string; kind: string; path: string; sha256?: string; evidence: string; witness?: string|null; source: string; addedAt: number }
interface IrTimelineView { id: string; at: number; source: string; event: string; impact?: string; evidence?: string|null }
interface IrQuestionView { id: string; question: string; status: "open"|"answered"|"verified"; answer?: string|null; evidence?: string|null }
interface IrView { taskId: string; evidence: IrEvidenceView[]; timeline: IrTimelineView[]; questions: IrQuestionView[]; attachments: AttachmentView[]; artifacts: ArtifactView[] }
```

- 子类型放 `events.ts`；旧快照/旧 mock 没有 `awd`/`ir` 不炸。
- 不新增 `HubAction`（WP9-A 只读）。结构化 fact 由现有 `blackboard_submit_fact`/人工写入。

### 3.4 结构化 fact 约定

`facts.content` 是 JSON 字符串；顶层 `schema` + `v`：

```json
{"schema":"awd.round","v":1,"round":1,"startedAt":0,"endsAt":0,"state":"running"}
{"schema":"awd.service","v":1,"name":"web","target":"host:port","status":"up","ownerSessionId":"s1"}
{"schema":"awd.patch","v":1,"service":"web","vuln":"...","status":"verified","evidence":"E2","witness":"..."}
{"schema":"awd.check","v":1,"round":1,"item":"...","status":"ok","evidence":"..."}
{"schema":"awd.attack","v":1,"attacker":"...","target":"...","action":"...","result":"...","at":0}
{"schema":"ir.timeline","v":1,"at":0,"source":"log","event":"...","impact":"...","evidence":"..."}
{"schema":"ir.question","v":1,"question":"...","status":"answered","answer":"...","evidence":"..."}
```

- 解析失败/字段缺失：跳过该条 + `warnings[]`（不猜测、不抛错）。
- 事实明文/flag 不进 events/audit 的约束沿用现有。
- 不新增 MCP 工具；agent/人用现有 submit_fact。

### 3.5 测试（A 组）

- AWD：round/service/flag/patch/check/attack 各 1 组；多轮 flag 按 round 聚合；空/坏 JSON 不炸；target 服务映射；旧快照无 awd。
- IR：evidence/timeline/question；附件/工件透传；空/坏 JSON；旧快照无 ir。
- 契约：`awd?`/`ir?` 可选；无 category 不填。
- 安全：模型层无 fs/网络/child_process/eval；verify-awdir 源码扫描。
- 预计 25–40 条。

### 3.6 出口

- `verify:awdir` 全绿；`verify:all` ≥712；scope/flags/migration/artifacts/skills/multitask/reliability 基线不降；electron 26。
- 不新增表（user_version 仍 3）；不碰 renderer；不接平台。
- 文档 `docs/done/P9-A.md` + PROGRESS。

## 4. WP9-B1 · AWD 只读 UI

### 4.1 目标

在 renderer 显示 `AwdView`：轮次计时、服务清单、flag 轮换、补丁、检查、攻击日志；只读/人工编辑 fact；无自动动作。

### 4.2 文件

- 新增 `apps/desktop/src/renderer/awd/panel.ts`（或 `panels/awd.ts`）。
- 修改 `renderer/main.ts`（挂面板）、`styles.css`（样式）、`mock/engine.ts`（mock awd 视图）、`smoke.ts`（断言）。
- 契约/模型沿用 WP9-A；不碰 board/acp/session。

### 4.3 行为

- task.category=awd 时显示 AWD 面板；其他 category 不显示。
- 轮次：只读计时 + 「开始本轮/结束本轮」按钮 → 写 fact（现有 dispatch `board.note`/submit_fact 路径；不新增 action 除非必须）。
- 服务：只读 targets + fact；状态人工编辑（fact）。
- flag 轮换：只读候选/确认/提交数；确认走现有 flag.confirm。
- 补丁/检查/攻击：只读列表 + 人工新增/编辑 fact（现有 blackboard 写入路径）。
- **不做**自动扫描/利用/开环境/平台提交；批量提交留 WP9-C。

### 4.4 测试

- smoke：category=awd 显示/隐藏；空视图；坏 fact；旧快照；按钮只写 fact/不自动动作。
- Electron 加载；旧 renderer 不读 awd 不炸。
- 全量基线。

## 5. WP9-B2 · IR 只读 UI

### 5.1 目标

显示 `IrView`：证据板/时间线/问题答题卡；复用附件导入；导出留 WP9-C。

### 5.2 文件/行为

- 新增 `renderer/ir/panel.ts`；挂载/样式/mock/smoke。
- 证据板：附件/工件 + 证据/哈希；导入走现有 attachment.import。
- 时间线：只读按 at 排序；人工新增 fact。
- 问题答题卡：多问题列表/状态/答案/证据；人工写 fact；不占用 task.answer。
- 不自动解析日志/内存/PCAP；不自动提交。

### 5.3 测试

- smoke：category=ir 显示/隐藏；多问题；空/坏 fact；旧快照；附件透传；无自动动作。
- 全量基线。

## 6. WP9-C · 导出 + 批量提交人工编排

### 6.1 目标

- AWD/IR 只读导出 md/csv/json；内容返回，不写文件。
- AWD 批量提交：勾选已确认候选 → 一次人工确认 → 逐条 `flag.submit manual` 记录；不接平台。
- IR 答题卡导出：问题/答案/证据/时间线。

### 6.2 契约/文件

- 可选 `HubAction.awd.export`/`ir.export`（只读 content）；或复用 `flag.export` 模式，先问契约冻结。
- renderer 导出按钮 + 批量勾选/确认对话框。
- 不新增平台适配器/凭据。

### 6.3 测试

- 导出 content 含/不含预期字段；不写文件；不记明文；manual 批量逐条记录；dry_run 预览；失败可读错误。
- 全量基线。

## 7. WP9-D · 可选强类型表（默认不做）

仅在真实数据量/查询需求证明需要时：

- migration v4：`awd_rounds/services/patches/checks/attacks`、`ir_questions/timeline`（候选 schema 见 design §1.3）。
- 旧库 v3→v4 兼容、备份/回滚、verify-migration、verify:awdir；用户单独批准。
- 不做背填/不迁移现有 facts（除非明确要求）。

## 8. 验收门禁（每批）

- `verify:all` ≥712；scope 354；flags 214；migration 127；artifacts 324；skills 149；multitask 174（F flaky 允许 rerun）；reliability 45；electron 26。
- `verify:awdir` 新增；不并入 verify:all。
- 零平台 API/凭据；零自动提交/利用/开环境；零新表（A/B/C）。
- 旧快照/旧 mock 不炸；renderer 旧断言零删除。
- 文档 `docs/done/P9-A/B/C.md` + PROGRESS；每批停下等确认。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 结构化 fact 弱类型/字段漂移 | v1 schema、解析失败保留原文+warnings；WP9-D 强类型表退路 |
| UI 只读视图与现有三栏冲突 | 先 mock + smoke；面板可折叠；不改现有注意力分配 |
| 批量提交被误解为自动提交 | 一次人工确认 + 逐条 manual；不接平台；UI 明示 |
| 平台 API/凭据诱惑 | 明确非目标；任何提案单独问用户 |
| 数据量/大文件 | IR 复用附件限制；解析器不做；WP9-D 评估 |
| 轮次/服务人工状态不一致 | UI 显示“手动同步”；审计 fact；不自动猜 |
| 新契约破坏旧快照 | 全部可选字段；mock/旧快照测试 |
| 与 WP5 flag/审批语义冲突 | confirm/submit 复用现有 action；不新增自动路径 |

## 10. 前置条件与开放问题

### 前置条件

- 用户评审通过本计划；明确第一批（建议 WP9-A）。
- 真实 AWD/IR 需求/流程样本（至少 1 个模拟比赛/事件）用于 UI 评审；没有则用 mock，不声称真实可用。
- 平台边界：不接写 API/凭据；如需，单独授权。
- 不新增依赖/原生模块。

### 开放问题（需要你拍板）

1. 先 AWD 还是 IR？（建议先 WP9-A 模型，再 B1 AWD、B2 IR）
2. category 取值固定 `awd`/`ir` 还是需要中文/平台映射？
3. 结构化 fact 是否接受“JSON 字符串 + schema”约定？（替代方案：WP9-D 直接强类型表）
4. AWD 批量提交一次确认的 UI 形式（列表勾选 + 二次确认）？
5. IR 答题卡是否需要固定问题模板/平台导出格式？
6. 是否允许 WP9-C 新增 `awd.export`/`ir.export` 契约（可选字段/action）？
7. 是否需要 WP9-D 强类型表现在就做？（默认不做）

## 11. 明确不做

- 不写平台 API/凭据、不自动提交/批量提交/利用/开环境。
- 不自动解析 PCAP/内存/日志、不自动服务扫描/补丁/检查。
- 不在 A/B/C 新增表；不改 ARCHITECTURE；不删旧测试。
- 不基于 WP6 样本声称扇出收益。
- 不在本计划阶段写代码。

## 12. 建议顺序/粗估

1. WP9-A 只读模型（1–2 人日）
2. WP9-B1 AWD UI（2–3 人日）
3. WP9-B2 IR UI（2–3 人日）
4. WP9-C 导出/批量人工编排（1–2 人日）
5. WP9-D 可选强类型表（2–4 人日，需批准）

每批结束：全量 + smoke/electron + 文档 + 停下等确认。
