# BENCHMARKS-V2 · 真实得分效率基准

> 更新：2026-10-25 · V2 代码后重跑。
> 纪律：没有真实靶场、标准答案、重复实验，不得声称“扇出有收益”或“接近一等奖”。
> **本轮没有新增真实 benchmark 数据**；以下旧数据仅作描述性基线。

## 1. 结论先行

- 真实样本仍只有 **4 个 Web E2 flag**（旧 P6 批次），没有 Crypto / Misc / Reverse / IR / 企业网真实基准。
- 唯一一次真实 A/B 是 **n=1**，且发生在 R24 收敛之前；不能证明收敛收益。
- V2 新增的 AnswerSpec、战略层、IR 流水线目前只有 **fake/fixture 测试**，没有真实得分数据。
- V2.1b 已用真实 EvtxECmd + 本机 `System.evtx` 全量 39,177 行、真实 capinfos/tshark + 6000 包确定性 PCAP（第6000包 sentinel）完成工具级烟测（REAL_PASS）；M57 真实内存样本 external pslist 41 条 PASS，但 netscan/netstat 因 Windows 5.1 不支持而 BLOCKED，平台 memory detect/pslist parse FAIL，**MEMORY_OVERALL=PARTIAL**。这仍不是 IR 赛题得分数据。
- 因此：**不能回答“比单会话强多少”“什么题型值得扇出”“是否达到一等奖”**；只能回答“机制已实现并测试”。

## 2. 旧真实样本（描述性，不是受控对照）

| 样本 | target | first flag | wall | tool calls | approvals | tokens | 备注 |
|---|---|---|---|---|---|---|---|
| 批次 2 run1 | 11137 | 592.6s | 905.5s | 53 | 0 | 781,585 | 预 D3/D4；E2 |
| 批次 2 retry | 11137 | 533.7s | ~15min 边界 | 37 | 0 | 244,337 | D3/D5.2 后；E2 |
| b2b run1 | 44892 | 570.5s | 902.8s | 36 | 0 | 260,654 | E2 |
| b2b run3 | 53865 | 422.6s | 903.9s | 32 | 2/2 人工 | 224,441 | target 更新后；E2 |

- first flag：median **552.1s**（4 样本，range 422.6–592.6s）。
- b2b 子集：median **496.5s**（n=2）。
- wall 多为 15min timeout 边界，不是 makespan。
- target 不同、flag 不同、代码版本不同，不能当同一实例 3 次重复。

## 3. V2 manifest schema

`benchmarks/challenges.example.json` 展示新字段；`benchmarks/challenges.local.json` 仍是用户本地真题（gitignore）。

```json
{
  "id": "local-web-1",
  "category": "web",
  "difficulty": "medium",
  "brief": "...",
  "attachments": [],
  "targets": ["host:port"],
  "expectedAnswerFile": "benchmarks/expected/local-web-1.txt",
  "answerSpec": {
    "mode": "flag_regex",
    "pattern": "flag\\{[^}\\s]{3,256}\\}",
    "answerType": "flag",
    "requiredEvidence": "E1"
  },
  "resetMode": "manual",
  "allowedTargets": ["10.0.0.0/24"],
  "forbiddenActions": ["submit", "open_challenge", "read_token"],
  "agent": "claude",
  "role": "lead",
  "tier": "guarded",
  "budget": { "tokens": null, "wallMs": 900000 },
  "timeoutMs": 900000,
  "maxSessions": 1
}
```

- `expectedFlagFile` 保留兼容；与 `expectedAnswerFile` 至少一个存在。
- `resetMode` 只允许 `manual` / `local-script`；**不接受平台 API/自动开环境**。
- `forbiddenActions` 明确禁止提交/开环境/读 token 等。

## 4. 指标定义

`apps/desktop/src/cli/bench-metrics.ts`：

| 指标 | 定义 |
|---|---|
| solveRate | 解出次数 / 样本数 |
| firstAnswerMs | 首个答案候选出现时间（不是提交时间） |
| makespanMs | 会话/任务收尾时间 |
| toolCalls / boardReads | 会话工具调用/读板次数 |
| duplicateFacts | 跨会话重复事实 |
| wrongCandidates | 错误候选数 |
| approvalCount / approvalWaitMs | 人工审批次数/等待 |
| scopeViolations | 越界判定/阻断次数 |
| tokens / cost | 记录值；缺失保持 null，不估算 |
| crashes / recoveries | 崩溃/恢复次数 |
| manualInterventions | 人工介入次数 |

- 报告中位数 + p90（最近秩）；样本 <3 时 `canConclude=false`，必须写“结论不足”。
- token 不完整时写“成本不可比”，不拿 0 当真实消耗。
- 不把 fake agent 结果当真实解题结果。

## 5. 真实跑协议（等用户提供数据）

1. 用户提供：可重置靶场/本地环境、题面、附件、目标、时限、AnswerSpec、标准答案文件、禁止动作。
2. 配置 S1（单路）、S2（lead+verify）、S3（recon+lead+verify）；guarded/autonomous 可选。
3. 每个配置重复 **3 次**；记录模型、agent、日期、环境、token 额度。
4. run 前检查靶场存活与可解性；target down 记 `target_down`，不硬跑。
5. 原始 JSON + 命令写入 `evidence/v2-bench-*`；报告写 `docs/BENCHMARKS-V2.md`。
6. 强人基线：至少记录人工单会话或往届高手完成时间/得分；没有就写“未验证”。

## 6. 当前可以/不可以说什么

| 可以 | 不可以 |
|---|---|
| AnswerSpec/战略/IR 机制已实现并有 fake/fixture 测试 | “真实比赛里能提高得分” |
| 旧 4 个 Web E2 样本 first flag median 552.1s | “扇出有正收益” |
| R24 收敛有确定性测试 | “R24 已用真实 A/B 证明” |
| IR 分析器在 fixture 上可用 | “真实 IR 题可用/准确率 X%” |
| 真实 EvtxECmd + System.evtx、真实 tshark + 合成 PCAP 工具烟测通过 | “真实 IR 赛题已验证” |
| 干净 Windows VM 正常启动/便携/合成文本 IR E2E 通过 | “干净机器完整验收通过” |

## 7. 证据

- 旧样本：`docs/BENCHMARKS.md`、`evidence/p6c-b2-*`、`docs/logs/ab-result.json`。
- V2 测试：`npm run verify:bench`（103/103）、`verify:answers`（108/108）、`verify:strategy`（61/61）、`verify:ir`（96/96 FIXTURE_PASS）。
- 最终门禁：`evidence/v2-final3/`。
