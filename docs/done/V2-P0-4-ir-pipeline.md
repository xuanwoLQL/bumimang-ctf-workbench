# V2-P0-4 · IR 自动分析流水线

> **V2.1 事实更正（2026-10-25）**：本文下方“外部工具未安装/没有真实数据”是错误或不完整表述。实际 tshark/capinfos 4.6.6、EvtxECmd 2026.5.0、Volatility 3 2.28.2、YARA 独立工具均存在；V2.1 已用真实 `System.evtx` 与确定性合成 PCAP 完成 REAL_PASS（内存仍 BLOCKED）。以 `docs/done/V3-P0-IR-REALITY.md` 与 `evidence/v3-ir-reality/` 为准；本文保留 V2 阶段历史快照。

> 日期：2026-10-25 · 范围：`main/ir/**`、`hub/hub.ts`、`awdir/model.ts`、`awdir/export.ts`、`renderer/ir/panel.ts`、`shared-protocol`。
> 证据：`evidence/v2-baseline/p4-ir*.log`、`npm run verify:ir`（FIXTURE/MOCK）。

## 1. 做了什么

### 注册表 / 编排 / 安全执行

```text
main/ir/registry.ts   # 分析器接口、统一结果模型、限额
main/ir/analyzer.ts   # 输入枚举、并发、逐分析器隔离、截断、sha256
main/ir/spawn.ts      # spawn(args[], shell:false)、PATH/env 工具解析、超时/输出上限
main/ir/questions.ts  # 问题清单解析 + 候选映射（E1，不确认）
main/ir/index.ts      # 默认注册表
```

### 内置分析器

| 分析器 | 能力 | 外部工具 |
|---|---|---|
| `text-log` | 时间线、IP/URL/账号/命令/IOC、可疑行 | 无 |
| `webshell` | PHP/JSP/ASPX 特征、eval/base64/命令执行、冰蝎/哥斯拉关键词 | 无 |
| `filesystem` | 近期文件、Web 根/启动项/计划任务/可执行扩展名 | 无 |
| `zip` | 安全枚举内层日志/脚本并递归分析 | 无 |
| `pcap` | 时间线、会话/DNS/HTTP IOC | tshark（可选） |
| `evtx` | 登录/进程/服务/日志清除事件、账号/IP/hash/进程 | EvtxECmd（可选） |
| `memory` | 进程/网络 IOC | Volatility 3（可选） |

- 工具路径：`BUMIMANG_TSHARK` / `BUMIMANG_EVTXECMD` / `BUMIMANG_VOLATILITY` 或 PATH；缺失返回可操作 warning，不伪造结果。
- 所有命令参数数组 + `shell:false`；cwd 限定任务目录；超时/输出上限；每次分析写 audit。
- ZIP 复用 `artifacts/zip` 的 slip/加密/限额校验；临时目录清理。
- 问题驱动：`ir.questions.import` 写 `ir.question`；`ir.analyze` 把 IOC/时间线/事实映射成候选（IP/时间/路径/进程/账号/命令/hash/URL/text），候选值进 `flag_candidates`，`ir.answer_candidate` 事实只存 candidateId/来源/缺口，不存明文。
- 多源时间线：日志、文件 mtime、PCAP、EVTX、内存事件都进入统一 timeline。
- UI：IR 面板新增“分析附件/工件”“导入问题清单”、分析运行摘要、候选/缺口展示；导出 md/csv/json 含候选与缺口；仍需人工确认/提交。

## 2. 测试（真实输出）

`npm run verify:ir` = **84/84**，覆盖：

- 文本日志：时间线/IP/URL/账号/命令/可疑行/witness 行号/排序。
- Webshell：高份量信号识别、普通文本不误报。
- 文件系统：汇总/可疑路径/时间线。
- ZIP：内层日志/Webshell 递归、来源路径、无 slip/炸弹误报。
- PCAP/EVTX/内存：mock 工具输出解析；tshark/EvtxECmd/Volatility 缺失时 warning 且不伪造事实。
- 问题解析：编号行/JSON；IP/时间/路径候选；无证据给 gap。
- 编排器：分析器异常隔离、facts/timeline/iocs 截断；`runCommandSafe` 超时/输出上限/不存在工具。
- Hub 端到端：导入 3 个问题 → 分析附件 → IR 视图候选/来源/缺口/分析摘要 → 导出含候选与分析；候选未确认；`ir.answer_candidate` 事实/审计不含候选明文。

## 3. 已知限制 / 未验证

- **V2 阶段状态（历史）**：当时只有 fixture/mock；V2.1 已纠正——工具实际存在并已真实解析，EVTX/合成 PCAP 已 REAL_PASS，内存仍 BLOCKED；见 `docs/done/V3-P0-IR-REALITY.md`。
- `fixture verified`；真实 EVTX/PCAP 工具烟测已验证；**真实 IR 赛题得分能力仍未验证**。
- PCAP/EVTX/内存解析是基础字段级，不是完整取证；复杂格式/插件版本差异可能失败并给 warning。
- 大内存镜像的 sha256/分析可能较慢；默认 8MB 文本上限、20s 工具超时、4MB 输出上限。
- `ir.ioc` 等证据事实会包含 IP/路径等证据值；这是证据而非“已确认答案”；候选事件/审计不含明文。
- 问题映射是启发式，必须人工确认；自然语言问题只给可疑行线索。

## 4. 下一步

用用户提供的真实 IR 数据（日志/PCAP/内存/问题清单/标准答案）跑一遍；记录工具版本、原始证据、标准答案对比与误报分析；再决定是否接入 YARA/更多 Volatility 插件。
