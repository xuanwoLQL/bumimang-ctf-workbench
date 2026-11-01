# BENCHMARK-INTAKE-V3 · 真实 benchmark 数据入口

> 日期：2026-10-25
> 目的：先用**最小校准包**验证环境/答案提取/审批/导出全链路，再谈 S1/S2/S3 × 3 的收益。
> 纪律：旧 4 个 Web E2 只作描述性历史数据，**不与 V3 新数据混算**；不接平台写接口、不读 token、不自动提交。

## 1. 第一优先级：最小校准包

只向用户要三样：

1. **1 道可重置 Web CTF**
2. **1 套最小 IR 数据**
3. **1 台干净 Windows VM 或授权安装环境**

拿到这三样后，只跑 **1 道题 × S1 × 1 次**校准，不直接跑 12 次。

## 2. CTF 校准题字段

| 字段 | 要求 |
|---|---|
| 题面 brief | 目标、入口、限制、flag/答案格式 |
| 附件 | 路径/哈希；不把真实 flag 写进仓库 |
| 目标 | URL / host:port / CIDR；是否允许扫描/利用 |
| 时限 | 单题预算（分钟） |
| AnswerSpec | `mode/pattern/answerType/requiredEvidence`；如 `flag{...}`、DASCTF{}、UUID |
| 标准答案文件 | 本地 ground-truth 路径（不入源码/测试/截图） |
| 重置方式 | 人工或用户提供的本地脚本；**不接受平台 API** |
| 禁止动作 | 如不自动提交、不批量提交、不开环境、不读 token、不破坏性操作 |
| 健康检查 | 赛前/每轮如何确认靶场存活、flag 是否随实例变化 |

## 3. IR 校准数据字段

| 字段 | 要求 |
|---|---|
| 日志 | 文件/大小/哈希；是否含敏感数据 |
| PCAP | 文件/大小/哈希；是否脱敏 |
| 内存镜像 | 文件/大小/哈希；是否 Windows；是否允许落盘分析 |
| 问题清单 | 问题文本/字段/答题卡格式 |
| 标准答案 | 本地 ground-truth 路径；或答案格式说明 |
| 工具 | tshark/EvtxECmd/Volatility 路径与版本；是否允许执行只读插件 |
| 禁止动作 | 不执行 payload、不外传、不读平台 token |

## 4. 企业网（后续，不在第一优先）

- 授权 CIDR、目标清单、跳板、flag 分布、重置方式、允许/禁止动作。
- **不要在文档/截图/日志中保存明文跳板密码或平台 token。**
- 没有授权范围与重置方式时不跑。

## 5. 校准 run 协议（拿到数据后）

1. 用真实 agent + 真实 token 前，先确认用户给出的额度/模型/agent/时间窗口。
2. 建 1 个 task，category 按题目；AnswerSpec 与 ground-truth 按用户提供。
3. 只开 **S1（单路）1 次**；记录：
   - 环境/模型/agent/日期/token；
   - firstAnswerMs / makespan / toolCalls / boardReads / approvals / token；
   - 答案候选是否能被人工确认；导出是否可用；
   - 有无自动提交/平台写接口（必须为 0）。
4. 校准通过标准：环境可重复、答案提取正确、审批可控、导出可用、无平台写操作。
5. 校准通过并得到用户明确授权后，才进入：
   - 同一题 S1/S2/S3 各 3 次；
   - 中位数/p90、失败率、重复劳动、审批等待、scope 违规、token/成本；
   - 结论标注样本量/环境/模型/日期；样本不足写“结论不足”。

## 6. 数据存放

- 真题/附件/标准答案：用户本地或 `.gitignore` 的 `benchmarks/challenges.local.json` 指向的本地文件；**不提交真实 flag/敏感日志**。
- 原始 benchmark JSON：`evidence/v3-bench-<date>/`；只保留统计/哈希/命令，不保留完整敏感内容。
- 旧数据：`docs/BENCHMARKS.md` / `evidence/p6c-b2-*`，单独标注“旧 4 个 Web E2，不和 V3 混算”。

## 7. 现在需要用户提供的最小项

1. 1 道可重置 Web CTF（题面/附件/目标/时限/AnswerSpec/标准答案路径/重置方式/禁止动作/健康检查）。
2. 1 套最小 IR 数据（日志/PCAP/内存/问题清单/标准答案或格式/工具版本/允许落盘）。
3. 1 台干净 Windows VM 或授权安装环境（用于 `CLEAN-WINDOWS-CHECKLIST-V3.md`）。
4. 若要做真实 agent 校准：模型、agent、token 额度、时间窗口。
