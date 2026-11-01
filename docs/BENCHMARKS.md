# BENCHMARKS · 不迷茫真实 benchmark

> 状态：**P6-D 完成**（2026-10-25）。本文件把 P6-A 骨架填成完整报告。
> 纪律：样本量、环境、模型、时间写清；1 次样本不写成规律；占位题数据不能下真实结论。
> 数据来源：`evidence/p6c-b1-*`、`p6c-b2-*`、`p6c-b2-summary.json`、`p6b-*`、`p6a-*`；完整门禁见 `evidence/wp6-final-*`。

## 1. 方法与样本量

- 题目来源：`benchmarks/challenges.local.json`（本地真题，gitignore；当前最终 target 53865，不含真 flag 提交）。
- 真实跑形态：1 题 × 3 次 × 1 agent（claude），每次独立 task、单 session、tier=guarded、`scope.enabled=false`、`proxy.enabled=false`、15min/run、人工 Electron 审批。
- 真实样本：
  - 批次 1：1 题 × 1 次（无 flag，靶场宕机）。
  - 批次 2（第一次）：计划 1 题 × 3 次；1 次完成出 flag（592.6s），1 次页面卡住 partial，1 次未跑；后补 retry（533.7s）与 run3 两次 abort（target down）。
  - 批次 2（第二次，b2b）：1 题 × 3 次全部完成；run1/2 target 44892，run2 后 target down；用户更新 53865 后 run3 完成。2/3 E2 flag。
  - 批次 3：**跳过**（用户未提供 2 道新题；按提示词不能自编题）。
- 因此真实 E2 flag 样本共 **4 个**（592.6/533.7/570.5/422.6s），无 flag/失败样本 5+ 个；**不是计划的 5–10 题 × 3 次**。
- soak：60 分钟计划，实际运行约 32 分钟后被 Claude Code 后台 shell 内存压力回收器外部终止；**interim PASS，不是完整 60min 结论**。
- 控制变量：单 session、guarded；未做真实 2/3 路扇出 A/B（唯一一次 verify-ab 误启动是事故，不作为数据）。

## 2. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-10-25 |
| OS | Windows 11 Home 10.0.26300 |
| Node | v25.2.1 |
| Electron | 44.7.0 |
| agent | `@agentclientprotocol/claude-agent-acp` 0.89.1（claude） |
| model | claude（由 ACP 配置决定；具体模型 ID 未写入 DB，无法逐 run 区分） |
| 工作区 | `D:\agent\xuanwo`；agent 工作目录 `work/<taskId>` |
| 靶场 | `hbc2.haobachang.com:11137`（第一次批次 2）、`:44892`（b2b run1/2）、`:53865`（b2b run3） |
| scope / proxy | 均关闭（默认） |
| token 授权 | 用户逐批确认；本报告只记 ACP 返回的 usage，不估费 |

## 3. 数据

### 3.1 有 E2 flag 的真实 run（描述性样本，非受控对照）

| 样本 | target | first flag | wall | tool calls | approvals | tokens | 备注 |
|---|---|---|---|---|---|---|---|
| 批次 2 run1（旧） | 11137 | **592.6s** | 905.5s | 53 | 0 | 781,585 | 预 D3/D4；E2 `work/task-f266bfb5/evidence/FLAG_FOUND.md` |
| 批次 2 retry（旧） | 11137 | **533.7s** | ~15min 边界 | 37 | 0 | 244,337 | D3/D5.2 后、D2 前；E2 |
| b2b run1 | 44892 | **570.5s** | 902.8s | 36 | 0 | 260,654 | D2/D3/D4/D7a；E2 `evidence/FLAG.txt` |
| b2b run3 | 53865 | **422.6s** | 903.9s | 32 | 2/2 人工 | 224,441 | target 更新后；E2 `evidence/flag-read.txt` |

- first flag（4 样本）：median **552.1s**（约 9.2min），range 422.6–592.6s，std 65.4s，p95（最近秩）592.6s。
- b2b 子集（n=2）：median **496.5s**（约 8.3min），range 147.9s，std 74.0s。
- tool calls（4 样本）：median **36.5**（32–53），std 8.0。
- tokens（4 样本）：median **252,495.5**（224,441–781,585）；模型/代码版本/题目实例不同，不能当成本基线。
- **wall 不是解题时间**：b2b 三次均约 903–905s，是 15min monitor timeout 边界；旧样本 wall 也多为 timeout/停止边界。first flag 才是可比指标。

### 3.2 无 flag / 失败 / target down 样本

| 样本 | target | 结果 | tool calls | approvals | tokens | 说明 |
|---|---|---|---|---|---|---|
| 批次 1 | 37900→23992 | 无 flag；session failed | 45 | 1/1 | null | 15min timeout；renderer 无响应；target 跑后 refused |
| 批次 2 run2（旧） | 11137 | 页面卡住，手动停止 | 34 | 0 | null | 未修复 pane；非完整样本 |
| 批次 2 run3 23928 | 23928 | 无 flag；target down | 44 | 0 | null | 90,290 stream；abort |
| 批次 2 run3 34766 | 34766 | 无 flag；target unreachable | 36 | 1/1 人工 | null | 45,811 stream；abort |
| b2b run2 | 44892 | 无 flag；target_down=true | 33 | 1/1 人工 | 0（1 条零用量记录） | 跑后 44892 refused；token 不可比 |

### 3.3 b2b 聚合（3 次完整 run）

| 指标 | median | mean | variance / std | 说明 |
|---|---|---|---|---|
| wall | 903.9s | 903.9s | 0.79e6 / 0.9s | timeout-bound，无信息量 |
| first flag | 496.5s | 496.5s | 5.47e9 / 74.0s | n=2；run2 无 flag |
| tool calls | 33 | 33.7 | 2.89 / 1.7 | 32–36 |
| approvals | 1 | 1 | 0.67 / 0.82 | 0/1/2；总 created 3 / approved 3 / denied 0 |
| tokens | 224,441 | 161,698 | 1.33e10 / 115,290 | run2=0 零记录，严重偏斜 |

- flag：**2/3 E2**；target_down 1/3；target 在 run2→run3 间由 44892 变为 53865，flag 值不同（`flag{e54b…}` vs `flag{6d46…}`），**不能视为同一实例的 3 次重复**。

### 3.4 60 分钟 soak（fake agent，interim）

- 计划 60min；实际约 32min 后被外部内存压力回收器终止；无最终完整 soak JSON，只有 console 采样与 25min DB 回归分析。
- RSS 64MB 稳定（range 63–65MB，slope ~0.0MB/min）；handles 3–4；errors 0；9/9 sessions stopped。
- DB 527KB → 4,376KB（32min，Δ3,849KB；平均 120.28KB/min）；events 12→516；25min 前 10min warm-up slope 401.23KB/min，后 15min 7.41KB/min；**非超线性增长、无 RSS/句柄泄漏证据**。
- 结论：**interim PASS**；DB 增长主要是建表/首批事件 warm-up + 低斜率持续写入；**不能外推为完整 60min 结论**。

### 3.5 bench 基础设施

- `verify:bench` **73/73**；`bench --dry` / `bench:soak --dry` exit=0；聚合纯函数（median/p95/failureRate/canConclude）有单元测试。
- P6-A 明确 `--no-dry` 拒绝，真实跑在 P6-C 由手动 Electron/CDP 执行；没有一键可复现真实 runner。

## 4. 结论

### 4.1 单 session 基准

- 4 个 E2 样本 first flag **median 552.1s（约 9.2min）**；b2b 子集 **496.5s（约 8.3min，n=2）**。
- 这是**描述性基线**：target、代码版本（D3/D4 前后）、题目实例均不同；不能当严格 SLA。
- wall 多为 15min timeout 边界，不能当 makespan；tool calls median 36.5（4 样本）。

### 4.2 哪些题型值得扇出

- **样本不足，不能下结论**。真实跑只有 web；没有 easy/medium/hard 分层，也没有真实 2/3 路 A/B。
- fake agent 3 会话测试只证明“机械上能扇出”；不能证明真实收益。
- 唯一 verify-ab 误启动是事故，不作为数据。需要稳定靶场 + 5–10 题 × 3 次（或多题 × 单/多 session 对照）后才能回答。

### 4.3 60 分钟 soak

- interim PASS：RSS/句柄稳定、无错误、sessions 清理；DB 增长为 warm-up + 低斜率，非超线性；完整 60min 未完成（外部终止），不能写成“60min 全通过”。

### 4.4 command 模式

- 未实现。`flag.submit` 只有 manual（记录 submitted_at/instructions）和 dry_run（返回 argv，不执行/不落库）。
- 预期收益无法量化；在实现前保持人工复制到平台，不接平台 API、不自动提交。

### 4.5 代理（scope.proxy）

- 默认关；真实跑未开；无真实代理收益/误报数据。
- 建议继续默认关；只在需要“网络出口可审计”时按任务开启，并接受 nmap/raw socket/DNS 可绕过的限制。

### 4.6 scope.enabled

- 默认 false；真实跑未开；无真实 extract 误报率数据。
- 建议比赛先用 false，观察误报后再考虑开启；`outOfScopeAction` 保持 approve。

## 5. 注意事项

- 占位题（`challenges.example.json`）不是真实题；本报告没有用占位题下结论。
- token 不可得/零记录时用 wall/first flag/tool calls 代理；不要把 run2 的 0 当真实消耗。
- wall 是 timeout 边界，不是 agent 完成时间；first flag 才是主要指标。
- target 变更/宕机是外部变量：44892 在 run2 后 refused，53865 是用户更新后的新实例。
- 审批覆盖率低：b2b 101 次工具调用只有 3 条审批；旧 run 多为 0。人工延迟会影响 first flag。
- 真实样本量小（4 个 E2），不能把中位数写成稳定规律；需要更多稳定靶场数据。

## 6. 已知限制

1. 样本量：4 个 E2 flag，远低于计划 5–10 题 × 3。
2. 批次 3 跳过（用户未提供 2 道新题）。
3. target 不稳定：44892 跑后 down；run1/2 与 run3 target 不同。
4. 旧批次 2 run2 页面卡住是 pre-D3 的真实缺陷，不是完整 benchmark 样本。
5. 批次 1 无 flag + target down，不能作为失败率分母的稳定样本。
6. token 不完整：run2 0 零记录；模型 ID 未落库；无法算成本。
7. wall 是 15min timeout 边界，不是 makespan。
8. 审批覆盖率低（3/101 b2b；旧 run 0），审批等待未系统记录。
9. 单 session only；没有真实扇出收益数据。
10. skill_search 使用不一致（12/18/0），无法归因题型。
11. D7b（backgroundThrottling:false）未做；后台节流只做了观测区分。
12. D7c（CDP 策略）未做；D1 monitor 仍有 CDP snapshot 超时历史。
13. command 提交模式未实现。
14. scope.enabled 默认关；无真实 extract 误报率。
15. proxy 默认关；无真实代理数据。
16. 60min soak 未完成（32min 外部终止，interim）。
17. multitask F 组 flaky；render-verify 6 项既有失败仍挂账。
18. bench 真实 runner 不是一键可复现；真实跑用手动 Electron/CDP + monitor。
19. 未验证干净机器/NSIS 安装（B-4，WP7）。
20. target 宕机/审批覆盖率/verify-ab 误启动是 WP6 独立发现，需 WP7/WP8/最终报告处理。

## 7. 数据与证据

- 批次 1：`evidence/p6c-b1-run-20261025-005019.json`、`p6c-b1-console.txt`
- 旧批次 2：`evidence/p6c-b2-run-1-console.txt`、`p6c-b2-run-2-console.txt`、`p6c-b22-run-2-console.txt`、`p6c-b23-run-3-console.txt`、`p6c-b24-run-3-console.txt`
- b2b（第二次）：`evidence/p6c-b2-run1-2026-10-25T03-16-54-901Z.json`、`...run2-...03-33-08-035Z.json`、`...run3-...03-49-30-252Z.json`、`p6c-b2-summary.json`
- soak：`evidence/p6b-b1-*`（25min DB regression、console、阈值重定义）
- bench：`evidence/p6a-verify-bench.txt`、`p6a-bench.txt`、`p6a-bench-soak.txt`
- 最终门禁：`evidence/wp6-final-*.txt`
