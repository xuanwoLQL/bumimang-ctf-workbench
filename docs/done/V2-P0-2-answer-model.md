# V2-P0-2 · 通用答案模型与答案格式适配器

> 日期：2026-10-25 · 范围：`packages/shared-protocol/events.ts`、`apps/desktop/src/main/answer/**`、`stream/normalize.ts`、`artifacts/scan.ts`、`hub/hub.ts`、`blackboard/board.ts`、任务 UI。
> 证据：`evidence/v2-baseline/p2-*.log`、`npm run verify:answers`。

## 1. 做了什么

### 契约（全部可选，向后兼容）

- 新增 `AnswerSpec`：`mode`（flag_regex/typed/freeform）、`pattern`、`answerType`（flag/ip/timestamp/hash/path/process/command/account/text）、`normalizers`、`caseSensitive`、`requiredEvidence`、`exportTemplate`、`aliases`、`field`。
- `task.create.answerSpec?`、`TaskView.answerSpec?`。
- `FlagCandidateView` 增加 `answerType/normalizedValue/specId?`；`FlagSourceView` 增加 `line/offset/sourceKind/sourcePath?`。

### 新模块

```text
main/answer/spec.ts        # 校验/默认值/模板/specId
main/answer/normalize.ts   # trim/lower/upper/strip_quotes/collapse_ws/normalize_path/base64/hex
main/answer/detectors.ts   # 统一检测器（flag/自定义前缀/UUID/hash/IP/时间/路径/进程/账号/命令/Base64/hex/freeform）
main/answer/file-scan.ts   # 分块文本、行号/偏移、二进制嗅探、ZIP 枚举（slip/限额）
main/answer/index.ts       # 唯一入口
```

- `stream/normalize.ts` 的 `FLAG_RE/extractFlag` 改为统一注册表兼容包装；附件扫描 `artifacts/scan.ts` 改为调用 `file-scan`。
- Hub 的流识别、事实扫描、附件扫描、重启恢复、收敛、导出全部走 `detectAnswers`。
- 任务级 AnswerSpec 持久化到 `tasks.answer_spec`（v5 迁移）；候选/来源新增列（v5）。
- 任务创建 UI 增加：答案模式、答案类型、证据要求、自定义正则、导出模板、分值 points。
- 附件导入现在会**生成候选**（E1，带路径/行号/偏移），不再只写审计。
- 事件/审计不再写答案明文：
  - `flag.candidate` / `flag.source` 只写 `candidateId/valueHash/answerType/sourcePath/line`；
  - `task.setStatus` 的 `answer` 事件只写 `answerHash`；
  - 附件扫描审计只写 `hitCount/sourcePaths/answerTypes/warnings`。
- 自然语言/freeform 只产生 E0 候选，不自动确认；所有候选仍需人工确认。

### 数据库迁移 v5

- `tasks.answer_spec TEXT`
- `flag_candidates.answer_type/normalized_value/spec_id`
- `flag_sources.line/byte_offset/source_kind/source_path`
- 只加列、不背填；旧库可打开；`verify:migration` 从 220 提升到 **231**。

## 2. 测试（真实输出）

| 套件 | 结果 |
|---|---|
| `npm run verify:answers` | **108/108** |
| `npm run verify:artifacts` | **329/329**（D 组从“只审计不产生候选”改为“生成候选 + 审计不含明文”） |
| `npm run verify:flags` | **214/214** |
| `npm run verify:migration` | **231/231** |
| `npm run smoke` | ALL PASS |

覆盖：旧 `flag{}` 兼容；DASCTF/ctfshow/flag_xxx；UUID/MD5/SHA1/SHA256；Base64/hex；typed IP/时间/路径/进程/账号/命令；freeform E0；跨块；二进制跳过；超长上限；ZIP 正常/slip/炸弹/损坏/清理；同答案跨会话一个候选多来源；错误答案不自动确认；事件/审计无明文。

## 3. 已知限制

- typed/freeform 是启发式，可能误报；只产生候选，不确认。
- 附件文本扫描默认前 4MB；ZIP 上限 200 文件 / 64MB；压缩比只受总大小约束。
- UTF-16 等含 NUL 的文本会被当作二进制跳过；PDF/图片/PCAP/内存检测留给 P0-4 插件。
- `flag_candidates` 表名保留（历史兼容），语义上现在是“答案候选”存储。
- 真实比赛答案格式（UUID/hash/自然语言）尚未用真实题目验证；当前只有 fixture/单元测试。

## 4. 下一步

在真实 Crypto/Misc/IR 题上验证 AnswerSpec；把导出模板接入 IR 答题卡；补充 PDF/图片插件。
