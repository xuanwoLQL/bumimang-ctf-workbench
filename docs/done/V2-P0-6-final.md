# V2-P0-6 · 真实 benchmark、打包与最终验收

> 日期：2026-10-25 · 范围：`apps/desktop/src/cli/bench.ts`、`bench-metrics.ts`、`verify-bench.ts`、`benchmarks/challenges.example.json`、最终打包。
> 证据：`evidence/v2-final3/`、`docs/BENCHMARKS-V2.md`、`docs/COMPETITION-READINESS-V2.md`。

## 1. 做了什么

### Benchmark manifest V2

- `BenchChallenge` 新增：`expectedAnswerFile`、`answerSpec`、`resetMode`、`allowedTargets`、`forbiddenActions`、`agent`、`role`、`tier`、`budget`。
- `expectedFlagFile` 保留兼容；与 `expectedAnswerFile` 至少一个存在。
- `resetMode` 只允许 `manual|local-script`；平台 API/自动开环境被拒绝。
- `answerSpec` 走统一 `validateAnswerSpec`；非法格式直接拒绝。
- `formatBenchPlan` 显示答案格式/标准答案/reset/agent/role/tier/budget。

### 指标

- 新增 `bench-metrics.ts`：solveRate、firstAnswerMs、makespanMs、toolCalls、boardReads、duplicateFacts、wrongCandidates、approvalCount/approvalWaitMs、scopeViolations、tokens/cost、crashes/recoveries、manualInterventions。
- 中位数 + 最近秩 p90；样本 <3 → `canConclude=false`；token 不完整 → “成本不可比”。
- `verify-bench` 新增 E 组：manifest 新字段/非法 reset/非法 answerSpec/非法 budget；指标中位数/p90/样本不足/token 不完整/文本输出。

### 打包

- `npm run pack`（NSIS + portable）最终重打：
  - `dist/不迷茫 Setup 0.1.0.exe`：2026-10-25 **14:11:17**
  - `dist/不迷茫 0.1.0.exe`：2026-10-25 **14:11:21**
  - `dist/win-unpacked/resources/app.asar`：2026-10-25 **14:10:56**
  - 源文件检查：**0 个**源文件晚于 asar。
- 打包态 `resources/app-source/skill`：**107 个文件**；index `{packages:[ctf-0day,ctf-solver], docs:97, wps:0, scripts:5, files:107, source:packaged}`。
- asar 列表包含 `main/answer/*`、`main/strategy/*`、`main/ir/analyzers/*`、`renderer/strategy/panel.ts`。

## 2. 最终门禁（2026-10-25）

| 门禁 | 结果 |
|---|---|
| `verify:all` | **975 PASS / 0 FAIL**（10 套件 + smoke 331） |
| `verify:flags` | 214/214 |
| `verify:artifacts` | 329/329 |
| `verify:scope` | 370/370 |
| `verify:awdir` | 44/44 |
| `verify:migration` | 236/236 |
| `verify:multitask` | 174/174 |
| `verify:reliability` | 47/47 |
| `verify:bench` | 103/103 |
| 打包态 `--verify` | **26/26** |

全部 exit=0；原始日志 `evidence/v2-final3/`。

## 3. 真实 benchmark：没有新数据

- 仍只有旧 **4 个 Web E2** 样本；没有 Crypto/Misc/Reverse/IR/企业网。
- 唯一真实 A/B 是 R24 前 n=1；不能证明收敛/扇出收益。
- 因此 `BENCHMARKS-V2.md` 只能写“样本不足、结论不足”。
- 没有把 fake agent/fixture 结果当真实解题结果。

## 4. 干净机器 / NSIS 安装

- **BLOCKED**：当前机器不是干净环境，没有 Windows VM；未执行“双击安装→启动→技能索引→建任务→起 fake session→导出”。
- 已完成的只是：NSIS/portable 构建成功、载荷含 app.asar + 技能库、dir 包与打包态 `--verify` 通过。
- 不能声称“队友机器首次安装已验证”。

## 5. 结论

- 机制/打包达到“可交付给队友试用”的工程状态；真实得分能力仍未证明。
- 最终判定见 `docs/COMPETITION-READINESS-V2.md`：**不能宣称能拿一等奖**。
- 下一步必须由用户提供真实靶场/标准答案/token 额度，才能做 S1/S2/S3 重复实验和干净 VM 验证。
