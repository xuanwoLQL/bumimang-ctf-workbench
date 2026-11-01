# COMPETITION-V2 · 从“多开工作台”到 human-in-the-loop 作战系统

> 状态：P0-0 技术方案 · 2026-10-25
> 基线证据：`evidence/v2-baseline/`（原始日志）、`.probe/backup-v2/hashes.sha256`
> 纪律：没有真实靶场、标准答案和重复实验，不得声称“能拿一等奖”；测试全绿只证明机制可靠，不证明得分效率。

## 0. 基线判定（带代码与实测证据）

**结论：当前不是一等奖系统。** 它是一个机制可靠、可人工审批、可多任务并行的“多 agent 工作台”，但“答案模型、战略调度、IR 自动化、打包知识库、真实收益证明”五个得分关键环节仍缺失或未验证。

| 判定 | 代码/实测证据 |
|---|---|
| 基础门禁可靠 | 2026-10-25 13:34–13:35 全量重跑：`verify:all` 720 PASS / 0 FAIL；flags 214/214；artifacts 324/324；scope 354/354；awdir 44/44；migration 220/220；multitask 174/174；reliability 45/45；Electron `--verify` 26/26。原始日志 `evidence/v2-baseline/*.log`，全部 exit=0。 |
| 答案识别只认 `flag{...}` | `apps/desktop/src/main/stream/normalize.ts:12`、`apps/desktop/src/main/artifacts/scan.ts:22` 各自硬编码 `flag{...}`；没有统一 AnswerSpec/注册表。 |
| 附件只扫文本前 4MB | `artifacts/scan.ts:25` `DEFAULT_MAX_BYTES=4MB`；`:57` 非文本直接返回空；ZIP 不枚举、PDF/PCAP/内存不解析。 |
| 没有通用答案模型 | `packages/shared-protocol/events.ts` 只有 `TaskView.flagCandidate` / `FlagCandidateView`，没有 `AnswerSpec`；`task.create` 只收 title/brief/category/priority（`events.ts:695-704`）。 |
| priority 基本只展示 | `hub.ts:149` 把 priority 映射进 TaskView；`board.ts:647` 落库；`validate-action.ts:176` 校验；**没有任何调度器读取 priority 做资源分配**（全仓无 strategy 模块）。 |
| 一键扇出是固定三路 | `apps/desktop/src/renderer/fanout/model.ts:48-52` `PRESET_THREE_ENGINES` 固定 codex lead + claude verify + opencode recon；没有按分值/时间/概率/成本决策。 |
| R24 收敛只有确定性测试 | `hub.ts:857-930` 收敛逻辑；`verify-r18.ts:986+`、`verify-flags.ts:367+`、`verify-multitask.ts:393+` 为 fake agent 断言；**R24 后的真实 A/B 尚未跑**。 |
| 唯一真实 A/B 样本 n=1 | `docs/logs/ab-result.json`：单会话 79.0s、3 会话 157.9s；首 flag 69.5s vs 58.8s；工具调用 11 vs 50；flag 被写两遍。结论只能是“单次观察”，不能当规律。 |
| 真实基准只有 4 个 Web E2 | `docs/BENCHMARKS.md`：4 个 E2 flag，first flag median 552.1s；b2b 子集 n=2 median 496.5s；没有 Crypto/Misc/Reverse/IR/企业网真实基准。 |
| IR 是只读证据板 | `apps/desktop/src/main/awdir/model.ts` + `renderer/ir/panel.ts` 只从 facts 派生视图；全仓无 `main/ir/*`、无 analyzer/registry、无 tshark/EvtxECmd/Volatility/YARA 调用。 |
| 打包不含技能库 | `package.json` `extraResources` 只有 rules/config；`dist/win-unpacked/resources/app-source/` 实测只有 config/rules，无 skill；`verify-reliability.ts` 旧断言甚至明确要求“skill 外置（不打包）”。 |
| 打包产物过期 | `dist/win-unpacked/resources/app.asar` 时间 2026-10-25 12:30，而 `hub.ts`/`events.ts`/`board.ts` 等源文件 12:59–13:07 更新；两个 exe 仍是 2026-10-21 19:28。 |
| scope 默认关闭 | `config/app.json:11-18` `scope.enabled=false`、`outOfScopeAction=approve`；`proxy.enabled=false`。 |
| 部分 agent 自执行命令，平台拦不住 | `docs/ARCHITECTURE.md:190-205` 实测 opencode `terminal/*`/`fs/*` 各 0 次，命令由 agent 自己执行；`docs/HANDOVER.md` §4 同结论。平台只能靠 `session/request_permission` 事前拦、`session/update` 事后看。 |

**因此，V2 的目标不是把 720 个断言变成 1200 个，而是补齐上述五条得分链，并用真实实验证明收益。**

## 1. 目标与非目标

### 1.1 目标

1. 队友拿到安装包/绿色包，不设环境变量也能使用最小技能库，并明确看到技能来源。
2. 答案识别从 `flag{}` 升级为统一 AnswerSpec，覆盖 CTF 自定义前缀、UUID/hash/Base64、IR typed/freeform。
3. 战略层按“预计得分 × 成功概率 × 边际证据 ÷ 时间与成本”给建议，priority/points 真正参与调度，无进展能止损。
4. IR 能把日志/PCAP/内存/Webshell/文件系统转成时间线、IOC、证据和问题答案候选，且证据可回溯。
5. 渗透范围前置校验覆盖平台可中介的动作，deny 优先，未知目标不静默放行；明确标注不可强制路径。
6. 用真实靶场、标准答案、重复实验和高手基线回答“比单会话强多少、什么题型值得扇出、是否接近一等奖”。

### 1.2 非目标

- 不做“一键自动打全场”；默认保留人工确认。
- 不调用比赛平台开环境/提交/批量提交/token 接口。
- 不自动执行利用链、不自动横向、不做破坏性动作。
- 不重写 Electron + TypeScript + node:sqlite 架构。
- 不引入原生编译依赖；新依赖必须先写决策文档。
- 不把规则匹配说成强制隔离；可绕过路径必须明说。

## 2. 基线门禁与快照

| 项目 | 结果 |
|---|---|
| `npm run verify:all` | 720 PASS / 0 FAIL（52+16+17+19+90+148+49 + 其余断言，原始日志计数） |
| `npm run verify:flags` | 214/214 |
| `npm run verify:artifacts` | 324/324 |
| `npm run verify:scope` | 354/354 |
| `npm run verify:awdir` | 44/44 |
| `npm run verify:migration` | 220/220 |
| `npm run verify:multitask` | 174/174（本次无 F 组 flaky） |
| `npm run verify:reliability` | 45/45 |
| Electron `--verify` | 26/26 |
| 备份 | `.probe/backup-v2/`：package.json、config、rules、`apps/desktop/src`、`packages/shared-protocol` |
| 哈希快照 | `.probe/backup-v2/hashes.sha256`（112 条源文件 + package.json） |

## 3. P0 总览与依赖顺序

```text
P0-0 基线/备份/方案
  ↓
P0-1 可部署打包与技能库
  ↓
P0-2 通用答案模型（AnswerSpec）
  ↓
P0-3 战略决策器（依赖 P0-2 的候选/证据）
  ↓
P0-4 IR 自动分析（依赖 P0-2 的答案候选与证据模型）
  ↓
P0-5 范围控制加固（与 P0-3/P0-4 联动）
  ↓
P0-6 真实 benchmark / 打包 / 最终验收
```

每个 P0 完成时都必须：新增 `docs/done/V2-<P0>.md`；跑本节第 8 条的全部门禁；不降低任何既有断言；新增测试必须确定性、可重跑。

## 4. P0-1：可部署打包与技能库分发

### 4.1 问题

`resolveSkillRoot` 已支持打包态 `resources/app-source/skill`（`skill/index.ts:171-174`），但 `package.json` 的 `extraResources` 从未把技能库放进去；`verify-reliability.ts` 反而断言“skill 外置（不打包）”。结果是队友机器不设 `BUMIMANG_SKILL_DIR` 时退化为无知识库。

### 4.2 方案

- 在仓库新增 `skill-builtin/`，由 electron-builder 复制到 `resources/app-source/skill`。
- 内容边界：
  - `skills/ctf-0day/SKILL.md`、`知识库/*.md`、`scripts/`（排除平台接口脚本 `hbc.py`/`des_ctf_sync.py`）；
  - `skills/ctf-solver/SKILL.md`、`AI-SEARCH-INDEX.md`、`PAYLOAD-CHEATSHEET.md`、`*.idx.md`、`CTF常用脚本及工具/SCRIPTS-INDEX.md`；
  - 自有 `manifest.json`、`README-BUILTIN.md`、`script-index.jsonl`；
  - **不打包** `CTF大赛WP集合/` 全文、`外部参考/` 全文、任何平台 token/接口脚本。
- `SkillStatus` 增加可选 `source: "env"|"config"|"dev"|"packaged"`；快照/UI 显示“内置/外置/未配置/索引失败”。
- 简报在未配置时已写“技能库不可用”（`briefing/build.ts:buildKnowledgeTools`），保留并加测试。
- 保留 `BUMIMANG_SKILL_DIR` / `config.skillDir` 覆盖；显式 env 指向不存在目录仍直接报错，不静默回退。
- 更新 `verify-reliability` C4：从“skill 不打包”改为“内置 skill 必须打包且可解析”，这是需求变更而非放宽。

### 4.3 改动文件

- `package.json`（extraResources）
- `apps/desktop/src/main/skill/index.ts`（SkillStatus.source）
- `packages/shared-protocol/events.ts`（HubSnapshot.skill.source 可选）
- 渲染层技能状态显示（若已有面板则补来源；否则加到任务/设置状态区）
- `skill-builtin/**`（新增）
- `apps/desktop/src/cli/verify-reliability.ts`、`verify-skills.ts`（新增打包态断言）
- `docs/done/V2-P0-1-packaging.md`

### 4.4 验收条件

1. 不设环境变量，打包态 `skill_list` 能看到至少 2 个包、>0 文档、>0 脚本。
2. 设置外置 `BUMIMANG_SKILL_DIR` 时 source=env，能切到完整技能库。
3. `npm run pack:dir` 产物包含 `resources/app-source/skill`；打包态 `--verify` 通过。
4. 干净 Windows VM 走通安装→启动→索引→建任务→起 fake session→检索 skill；没有 VM 则写 BLOCKED，不得声称通过。
5. 安装包/绿色包时间晚于最终源码。

### 4.5 风险与回滚

- 风险：内置包过大（目标 < 15MB）、第三方内容授权、路径大小写。
- 回滚：删除 `extraResources` 条目与 `skill-builtin/`，恢复 `SkillStatus` 可选字段（新增字段本身向后兼容）。

## 5. P0-2：通用答案模型与答案格式适配器

### 5.1 契约增量（向后兼容，全部可选）

```ts
export type AnswerMode = "flag_regex" | "typed" | "freeform";
export type AnswerType =
  | "flag" | "ip" | "timestamp" | "hash" | "path"
  | "process" | "command" | "account" | "text";

export interface AnswerSpec {
  mode: AnswerMode;
  /** flag_regex / typed / freeform 的可选正则；缺省按 mode 用内置规则 */
  pattern?: string;
  answerType?: AnswerType;
  normalizers?: Array<
    "trim" | "lower" | "upper" | "strip_quotes" | "collapse_ws" |
    "normalize_path" | "base64_decode" | "hex_decode"
  >;
  caseSensitive?: boolean;
  requiredEvidence?: EvidenceLevel; // 默认 E1；只影响“是否够确认”，不自动确认
  exportTemplate?: string;          // 支持 ${value} ${answerType} ${taskTitle}
  aliases?: string[];               // 同一答案的等价写法
  /** typed 模式的问题/字段名，用于 IR 答题卡 */
  field?: string;
}
```

- `HubAction.task.create` 增加 `answerSpec?: AnswerSpec`。
- `TaskView` 增加 `answerSpec?: AnswerSpec | null`。
- `FlagCandidateView` 增加可选 `answerType?: AnswerType`、`normalizedValue?: string`、`specId?: string`。
- 旧任务无 `answer_spec` 时使用默认 `flag_regex`，行为与现在一致。

### 5.2 数据库迁移（v5）

- `tasks` 增加 `answer_spec TEXT`（JSON；损坏时按默认 spec，不抛错）。
- `flag_candidates` 增加 `answer_type TEXT`、`normalized_value TEXT`、`spec_id TEXT`。
- `flag_sources` 增加 `line INTEGER`、`offset INTEGER`、`source_kind TEXT`、`source_path TEXT`。
- 迁移幂等：逐列检查 + `PRAGMA user_version`；旧库可打开、可回滚（启动备份已有）。
- 保持 `flag_candidates` 表名，避免大规模改 Hub/UI；语义上它成为“答案候选”存储。

### 5.3 新模块

```text
apps/desktop/src/main/answer/
  spec.ts        # 解析/校验/默认值/编译正则
  normalize.ts   # normalizer 链
  detectors.ts   # flag/custom prefix/uuid/hash/typed/freeform/base64
  registry.ts    # 统一 detectAnswers(text, spec, ctx)
  file-scan.ts   # 分块文本/二进制安全读取、行号/偏移
  archive.ts     # zip 枚举（slip/bomb 限制）
  plugin.ts      # 分析器接口（PDF/图片/PCAP/内存后续接入）
  index.ts
```

- `stream/normalize.ts` 的 `extractFlag` 改为调用统一注册表的兼容包装；删除第二套正则。
- `artifacts/scan.ts` 改为调用 `file-scan` + 任务 AnswerSpec；返回 `{value, normalized, path, line, offset, evidence}`。
- Hub 的流识别、事实识别、附件扫描、恢复、收敛、导出全部走同一注册表。
- 自动检测只产生 E0/E1/E2 候选；**不自动把任务标 solved、不自动提交**。
- 同一任务内按 `normalizedValue + answerType` 去重；跨会话保留多条 source。
- 自然语言/freeform 只产生候选，证据默认 E0；不进入自动确认路径。

### 5.4 附件扫描能力

- 文本/二进制安全读取：先嗅探前 4KB，NUL/控制字符过多则跳过文本检测；仍可交给二进制插件。
- 可配置 `maxBytes`、`chunkBytes`、`overlapBytes`；默认 4MB/64KB/300。
- zip：只读枚举，限制条目数、解压总大小、单条大小、压缩比；拒绝 `..`/绝对路径/盘符/NUL。
- 插件接口：`detect(input) -> boolean`、`analyze(input, ctx) -> AnswerHit[]`；PDF/图片/PCAP/内存分析器在 P0-4 接入或返回“未安装”。
- 每个候选带：来源文件（任务内相对路径）、行号或字节偏移、检测器 id、证据等级。

### 5.5 测试（新增 `npm run verify:answers`）

1. 旧 `flag{...}` 在流/附件/事实/恢复路径完全兼容。
2. 自定义前缀（`DASCTF{}`、`ctfshow{}`、`flag_xxx`）、UUID、MD5/SHA1/SHA256、Base64 包裹。
3. IR typed：IP/时间/路径/进程/账号/命令；freeform 只产生候选。
4. 超长文件、二进制、跨块命中、重复候选、大小写、空答案、格式不匹配。
5. ZIP slip、压缩炸弹、条目上限。
6. 同一答案跨会话一个 candidate、多条 source；错误答案不自动确认。
7. 导出模板与答题卡字段。
8. 注册到 `package.json`；旧门禁全部继续通过。

### 5.6 风险与回滚

- 风险：typed/freeform 误报、附件扫描性能、迁移损坏。
- 回滚：默认 spec 路径可独立回退；迁移只加列；关闭 `answer` 插件不影响旧 flag。

## 6. P0-3：比赛战略决策器与真实收敛验证

### 6.1 新模块（纯函数，不塞 Hub/Renderer）

```text
apps/desktop/src/main/strategy/
  model.ts     # 输入/输出/预算/权重类型
  score.ts     # 期望值、边际证据、成本、风险
  progress.ts  # 无进展检测（时间 + tool call + 新事实/证据）
  plan.ts      # 生成建议、模板、止损、收敛
  index.ts
```

### 6.2 输入

- 任务：category、priority、points、difficulty、deadline/remainingMs、status。
- 会话：role、agent、tier、status、toolCalls、boardReads、最近进展时间、事实/死路/候选产出。
- 黑板：facts、dead_ends、candidates、证据等级、冲突、已拿分/待验证。
- 预算：剩余比赛时间、单题预算、验证预算、人工审批预算、maxSessions。
- 风险：scope 越界、denyTargets、审批等待、成本。

### 6.3 输出

```ts
type StrategyAction =
  | "continue" | "start_session" | "stop_session" | "switch_role"
  | "verify" | "abandon" | "reallocate";

interface StrategyRecommendation {
  id: string;
  action: StrategyAction;
  taskId: string;
  sessionId?: string;
  agent?: string;
  role?: Role;
  tier?: Tier;
  expectedValue: number;
  confidence: number;
  reason: string;
  risk: string;
  deadline?: number;
  doNot: string[];
  scoreBreakdown: {
    expectedPoints: number;
    successProbability: number;
    marginalEvidence: number;
    timeCost: number;
    costWeight: number;
    scopeRisk: number;
  };
}
```

- 评分：`EV = expectedPoints × successProbability × marginalEvidence / (timeCost + costWeight)`；权重集中可配置，不写 Web 专用规则。
- 模板：`single`、`lead_verify`、`recon_lead_verify`、`converge_verify`；`PRESET_THREE_ENGINES` 仅作为 `recon_lead_verify` 的候选，不再是唯一策略。
- 无进展：连续 N 次工具调用或 T 分钟没有新 fact/dead_end/candidate/证据 → `switch_role`/`stop_session`，不只按绝对耗时。
- 时间预算：剩余时间不足时优先单路、优先验证已得候选、拒绝新开高成本方向。
- R24：E0 不触发停止；E1 → 建议 verify；E2 且无冲突 → 建议停止其他会话；持有不同证据的 verify 会话不被误杀。
- 默认 `suggest`；`competition-auto` 必须显式开启，且受 maxSessions、scope、审批、预算约束。
- 所有 apply 动作写 audit（建议 id、动作、对象、原因、前后状态）。

### 6.4 契约/UI

- `strategy.plan` action → `ActionResult.strategy`（可选字段）。
- `strategy.apply` action（显式用户点击）→ 只允许受约束的 start/stop；越界/超配额拒绝。
- 渲染层新增“作战建议”面板：建议列表、EV/置信度/理由/风险、勾选、一键应用；默认不自动执行。
- `docs/done/V2-P0-3-strategy.md` 记录模板与权重依据。

### 6.5 测试

- 纯函数：高优先级题、低收益题、时间不足、重复方向、已拿分、验证失败、scope 风险。
- 集成：fake agent 两会话，E0 不收敛、E1 不停止、E2 收敛、冲突证据不误杀。
- 预算/上限：maxSessions、审批预算、auto 模式拒绝越界。
- 真实 A/B：只有用户提供可重置靶场后才跑；否则明确写“未验证”。

### 6.6 验收条件

- 每条建议有可读 reason/risk/EV 分解，不是黑盒分数。
- priority/points 改变会改变建议顺序与资源分配（测试证明）。
- 低收益/无进展方向能被止损。
- 已拿分后不重复劳动；不同证据的 verify 不被误杀。
- 没有真实 A/B 时不得声称“收敛有效”。

## 7. P0-4：IR 自动分析流水线

### 7.1 新模块

```text
apps/desktop/src/main/ir/
  registry.ts   # 分析器注册、detect/analyze 接口
  analyzer.ts   # 编排：输入枚举、并发/超时/输出上限、审计
  spawn.ts      # 参数数组 spawn、工具路径解析、超时、输出截断
  analyzers/
    text-log.ts
    evtx.ts
    pcap.ts
    memory.ts
    webshell.ts
    filesystem.ts
    zip.ts
  correlate.ts  # 多源时间线/IOC/问题候选关联
  questions.ts  # 问题清单导入、候选答案、缺口
  export.ts     # 答题卡模板（复用 ir.export）
  index.ts
```

### 7.2 分析器接口

```ts
interface IrAnalyzer {
  id: string;
  title: string;
  detect(input: IrInput): Promise<boolean> | boolean;
  analyze(input: IrInput, ctx: IrContext): Promise<IrAnalysisResult>;
}

interface IrAnalysisResult {
  facts: IrFactCandidate[];
  timeline: IrTimelineEvent[];
  iocs: IrIoc[];
  answerCandidates: IrAnswerCandidate[];
  warnings: string[];
  toolLogs: IrToolLog[];
}
```

- 每个结果带：原始文件 sha256、工具版本/命令、时间/IP/路径/进程/账号、证据等级、witness/相对路径、是否人工确认。
- 工具路径：`BUMIMANG_TSHARK`/`BUMIMANG_CAPINFOS`/`BUMIMANG_EVTXECMD`/`BUMIMANG_VOLATILITY`/`BUMIMANG_YARA` 或 PATH；不硬编码 `D:\`。
- 执行：`spawn(command, args[])`，`shell:false`；cwd 限任务 workDir；超时、stdout/stderr 上限、并发上限；每次命令写 audit；缺失工具返回可操作提示。
- 问题驱动：导入问题清单后，每个问题维护候选答案、置信度、关联证据、缺口；候选写入 `ir.question`/`ir.answer_candidate` 结构化 fact，**不自动确认**。
- 多源关联：日志时间、文件 mtime、PCAP 时间、EVTX 时间、进程启动时间合并时间线；冲突保留并标注。
- 答题卡导出：字段/模板；仍然人工确认后自行提交。

### 7.3 UI

- IR 面板增加：“分析附件/工件”“导入问题清单”“分析进度/结果”“候选答案与缺口”“导出答题卡”。
- 明确显示：工具缺失/超时/输出过大/解析失败；候选≠已确认。
- 不新增“一键自动答题/提交”。

### 7.4 测试

- fixture：文本日志、伪 EVTX（mock 命令输出）、伪 PCAP（mock tshark）、Webshell 样本、文件系统 fixture、ZIP。
- mock analyzer/registry：detect、并发、超时、输出上限、缺失工具、审计。
- 真实工具：检测本机是否有 tshark/EvtxECmd/Volatility；没有则 skip 并写“未安装”，不得伪造通过。
- 关联：时间线排序、IP/账号/进程聚合、问题候选映射。
- 导出：答案表字段、模板、人工确认状态。
- 没有真实 IR 数据时写“fixture verified, real IR not verified”。

### 7.5 验收条件

- 导入一个 IR 题后能给出时间线、IOC、可疑文件/进程/网络、问题答案草稿。
- 每个结论可回到原始文件和工具命令。
- 工具缺失/超时/输出过大/解析失败有可读状态。
- 没有把候选写成已确认；导出后仍需人工点确认/提交。

## 8. P0-5：渗透范围控制与资格风险防护

### 8.1 数据

- `task` 增加/完善：`targets`、`denyTargets`、`scopeNotes`、`allowedActions`（可选）。
- 新增 action：`task.scope.update`（denyTargets/scopeNotes/allowedActions），校验并审计。
- 解析 URL/host:port/CIDR/IP；区分授权、禁止、未知；deny 优先；未知默认 approve/block，绝不静默放行。

### 8.2 前置校验

- 平台可中介的 `terminal/create|wait|kill`、`fs/read|write`、artifact import/preview、scope/proxy 动作全部 preflight。
- 审批卡显示原始请求、解析目标、命中规则、verdict；决定后写最终动作。
- 策略审计记录：原始请求摘要（脱敏）、解析目标、规则、verdict、人工决定、最终动作。
- 本地 HTTP CONNECT 代理保留为可选加固层；UI 明说 nmap/raw socket/DNS/直连可绕过。
- 对 agent 自己执行命令、不经过平台的路径，UI/日志/文档统一写“仅可审计/未强制”，不得写“已隔离”。
- 战略规划器不得建议明确越界目标或攻击链；`strategy.apply` 对越界 start 拒绝。

### 8.3 测试

- 相邻网段、CIDR 边界、URL userinfo、多 IP、域名 vs CIDR、未知目标、deny 优先、代理绕过、审批卡目标。
- 新增 `task.scope.update` 的校验/审计/快照。
- 明确列出无法强制的动作类型（文档 + UI 文案断言）。

### 8.4 验收条件

- 授权目标放行，禁止目标阻断/审批；所有 verdict 在 audit/UI 可查。
- 不出现“平台已强制隔离所有网络动作”的错误文案。
- 越界风险有测试与文档证据；scope 默认仍关闭。

## 9. P0-6：真实 benchmark、打包与最终验收

### 9.1 Benchmark manifest 扩展

```json
{
  "id": "...",
  "category": "web|misc|crypto|reverse|pwn|pentest|ir|awd",
  "difficulty": "easy|medium|hard",
  "brief": "...",
  "attachments": [],
  "targets": [],
  "timeoutMs": 900000,
  "answerSpec": { "mode": "flag_regex", "pattern": "flag\\{...\\}" },
  "expectedAnswerFile": "benchmarks/expected/<id>.txt",
  "resetMode": "manual|local-script",
  "allowedTargets": [],
  "forbiddenActions": [],
  "agent": "claude",
  "role": "lead",
  "tier": "guarded",
  "maxSessions": 1,
  "budget": { "tokens": null, "wallMs": null }
}
```

- 不接受平台 token；不自动开比赛环境；reset 只用用户提供的本地/授权环境。
- 指标：solveRate、firstAnswerMs、makespan、toolCalls、boardReads、duplicateFacts、wrongCandidates、approvalCount/approvalWait、scopeViolations、token/cost、crashes/recoveries、manualInterventions。
- 配置：S1 单路、S2 lead+verify、S3 recon+lead+verify；guarded/autonomous 可选。
- 每个真实配置重复 3 次，报告中位数与 p90；样本不足写“结论不足”。
- 强人基线：人工单会话或往届高手完成时间/得分。

### 9.2 最终报告

- `docs/BENCHMARKS-V2.md` + 原始 JSON。
- `docs/COMPETITION-READINESS-V2.md`：按 CTF / 企业渗透 / IR 分赛道写能力、真实得分、失败模式、是否达到一等奖门槛、仍需补的 P0、能否给队友直接用。
- 没有证据的地方写“未验证”。
- 重新 `pack:dir`、打包态 `--verify`、干净 VM 安装/启动/技能检索/建任务/起会话/导出。

### 9.3 当前状态

- 真实 benchmark：**没有新数据**（只有 4 个 Web E2 旧样本；无 Crypto/Misc/Reverse/IR/企业网）。
- 干净 VM：**BLOCKED**（当前机器不是干净环境，且无 VM）。
- 因此最终报告必须回答“现在不能拿一等奖，差在哪里”，不得用 fake agent 或单次样本替代。

## 10. 测试与门禁计划

每个 P0 结束必须重跑：

```powershell
npm run verify:all
npm run verify:flags
npm run verify:artifacts
npm run verify:scope
npm run verify:awdir
npm run verify:migration
npm run verify:multitask
npm run verify:reliability
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
```

新增：

```powershell
npm run verify:answers       # P0-2
npm run verify:strategy      # P0-3
npm run verify:ir            # P0-4
```

原则：

- 不删测试、不放宽策略、不关闭审计换绿。
- 测试失败先查真实原因；允许修测试中的过时断言，但必须记录“为什么是需求变更而不是放水”。
- fake agent 测试与真实 agent 测试分开报告；真实 agent 消耗 token 必须先得到用户确认。
- 所有真实样本记录模型、agent、日期、靶场、额度、原始日志。

## 11. 改动文件总览（预估）

| 阶段 | 主进程 | 契约 | 渲染层 | 测试/文档 |
|---|---|---|---|---|
| P0-1 | `skill/index.ts`、`electron/main.ts` | `events.ts`（skill.source） | 技能状态面板 | `verify-skills/reliability`、`skill-builtin/**` |
| P0-2 | `answer/*`、`stream/normalize.ts`、`artifacts/scan.ts`、`hub/hub.ts`、`blackboard/board.ts` | `AnswerSpec`、`TaskView`、`FlagCandidateView`、action | 答案格式/证据要求 | `verify-answers.ts` |
| P0-3 | `strategy/*`、`hub/hub.ts`、`electron/main.ts` | `strategy.plan/apply`、`StrategyPlanView` | `renderer/strategy/*` | `verify-strategy.ts` |
| P0-4 | `ir/*`、`hub/hub.ts`、`awdir/model.ts` | `ir.analyze`、`ir.questions.import`、`IrView` 扩展 | `renderer/ir/panel.ts` | `verify-ir.ts` |
| P0-5 | `scope/*`、`policy/*`、`acp/client.ts`、`approval/queue.ts` | `task.scope.update`、`allowedActions` | 目标/审批卡文案 | `verify-scope.ts` |
| P0-6 | `cli/bench*` | 可选字段 | — | `BENCHMARKS-V2.md`、`COMPETITION-READINESS-V2.md` |

## 12. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| typed/freeform 误报 | 错误候选干扰人工 | 只产生候选、E0 默认、requiredEvidence、人工确认 |
| 附件扫描性能/内存 | 卡住主进程 | 分块、上限、白名单插件、异步/超时 |
| ZIP 炸弹/slip | 磁盘/越界 | 条目/大小/压缩比限制、realpath 校验 |
| IR 工具缺失 | 流水线不可用 | 可操作提示、纯 JS 降级分析器、显式“未安装” |
| 战略自动动作越权 | 打错目标/超配额 | 默认 suggest、apply 白名单、scope/maxSessions/预算/审计 |
| R24 误杀 | 丢失不同证据 | E0 不触发、E1 只建议、冲突证据保留、宽限期 |
| 打包技能库授权 | 分发风险 | 只打包自有/授权内容，排除第三方 WP 全文与平台脚本 |
| 迁移损坏 | 旧库打不开 | 启动备份、逐列迁移、migration 测试、幂等 |
| 真实样本不足 | 无法证明收益 | 明确“结论不足”，不把单次当规律 |

## 13. 回滚

1. 源码：从 `.probe/backup-v2/` 恢复对应文件（按 `hashes.sha256` 核对）。
2. 数据库：迁移只加列；回滚代码后旧列被忽略。启动备份在 `reliability/backup.ts`，恢复路径已在 P7-A 验证。
3. 打包：删除新增 `extraResources` 条目与 `skill-builtin/`，重新 `pack:dir`。
4. 契约：新增字段全部可选；删除可选字段不破坏旧快照。
5. 测试：新增测试独立脚本；不删除旧测试。过时断言修改需在 `docs/decisions/` 说明。

## 14. 完成定义（Definition of Done）

- 每个 P0 有 `docs/done/V2-<P0>.md`：做了什么、改了哪些文件、如何验证、真实输出、已知限制、下一步。
- 每个 P0 的全部门禁原始日志在 `evidence/v2-<P0>/`。
- 任何“能拿一等奖/扇出有收益/IR 可用”的结论，必须有真实靶场、标准答案、重复实验或高手基线；否则写“未验证”。
- 打包态与干净机器证据分开记录；没有 VM 写 BLOCKED。
- 不修改用户全局 `~/.codex`、`~/.claude`、`~/.agents`、`~/.config`。
- 不调用比赛平台写接口，不读取/记录 token/flag 明文到源码、测试、截图或长期日志。
