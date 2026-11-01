# WP6 · 真实 benchmark 与演练（P0）总收口

> 状态：**WP6 收口完成（样本不足，不能下扇出结论）**。P6-A/P6-B/P6-C 全部步骤已执行；P6-C 批次 3 按用户决定跳过。
> 日期：2026-10-25。零代码改动（P6-D 只写文档 + 全量门禁）。
> 基线：verify:all **711/0**、scope **354/354**、flags **214/214**、migration **127/127**、artifacts **324/324**、skills **149/149**、multitask **174/174**、bench **73/73**、electron `--verify` **26/26**。

## 做了什么

- **P6-A**：`benchmarks/challenges.example.json`（3 道公开占位题）、`challenges.local.json` 模板/gitignore、`bench.ts` / `bench-soak.ts` dry-run、`bench-aggregate.ts` 纯函数、`verify:bench` 73 条。
- **P6-B**：fake agent 3 任务 × 3 会话 soak（5min 完整、60min 部分完成/外部终止）、DB 增长回归、阈值重定义；代理状态机/快照/事件（2a）+ renderer 五态显示（2b）。
- **P6-C**：真实跑（批次 1、批次 2 第一次/第二次）、D1 monitor、D5/D5.2/D7a 观测、D3 pane 硬化、D4 store/UI 批处理、D2 主进程 stream 合并、mock/IPC/真实数据压测、C 审计、flag confirm 闭环、靶场探测。
- **P6-D**：本文件 + `docs/BENCHMARKS.md` + `docs/PROGRESS.md` + 全量门禁。

## WP6 目标与验收对照（计划 §9）

| 计划要求 | 结果 | 证据/说明 |
|---|---|---|
| §9.4 `bench --dry`：manifest 校验、计划打印、0 token/0 agent | **PASS** | `evidence/p6a-bench.txt`、`p6a-hard-check.txt` |
| §9.4 聚合单元测试（median/p95/失败率；重复不足 3 次拒绝结论） | **PASS** | `verify:bench` 73/73 |
| §9.4 soak：fake agent 60–120min，记录 RSS/句柄/DB/stream，无持续增长/卡死 | **PARTIAL / interim PASS** | 实际 ~32min 被外部内存压力回收器终止；RSS 64MB 稳定、handles 3–4、DB warm-up 后低斜率；无完整 60min JSON |
| §9.4 真实跑：至少 1 道公开题 × 3 次，用户同意 token | **PARTIAL** | b2b 1 题 × 3 次完成；2/3 E2；run2 target down；target 44892→53865 变更；非同一实例 3 次重复 |
| §9.1 5–10 道真题 × 3 次；测并行/档位/题型收益 | **NOT MET** | 只有 4 个 E2 样本、1 个 web 题、单 session；批次 3 跳过 |
| §9.4 报告写样本量/环境/模型/时间；不能把 1 次当规律 | **PASS** | `docs/BENCHMARKS.md` |
| §9.5 真题/flag 不泄漏；local gitignore | **PASS** | example 占位；local 不入库；flag 未提交 |
| §9.5 token 成本：默认 dry-run，真实跑先问 | **PASS（流程）** | 用户逐批确认；run2 token 0 记录不可比 |
| §9.5 结果不可比：固定环境/manifest、记录模型/版本、中位数 | **PARTIAL** | 环境记录；target 变更/模型 ID 未落库；中位数只作描述 |

**结论：WP6 的“机械与观测链路”完成；“真实收益结论”样本不足，不能声称扇出收益。**

## P6-A / P6-B / P6-C 每步摘要与证据

### P6-A（benchmark 骨架）

- 占位 manifest + 本地模板 + expected 占位 flag；`.gitignore` 排除 local。
- `bench.ts` / `bench-soak.ts` 只 dry-run，`--no-dry` 明确拒绝；`bench-aggregate.ts` 纯函数；`verify:bench` 73 条。
- 0 token、0 agent、0 子进程；`verify:all` 不受影响。
- 证据：`docs/done/P6-A.md`、`evidence/p6a-*`。

### P6-B（fake soak + 代理状态）

- 5min soak 完整；60min soak 实际 ~32min 被外部终止；RSS 64MB / handles 3–4 / errors 0 / sessions 9/9 stopped；DB 527KB→4,376KB，warm-up 后低斜率，非超线性。
- 代理状态机/快照/事件（2a）+ renderer 五态/未知/未启用（2b）；旧快照兼容。
- 证据：`docs/done/P6-B.md`、`evidence/p6b-*`、`p6c-b2-*`（2b 回归）。

### P6-C（真实跑与修复）

| 步骤 | 摘要 | 证据 |
|---|---|---|
| 批次 1 | 1 题×1 次；无 flag；45 calls；1 审批；target down；renderer 无响应 | `p6c-b1-*` |
| 1.5 诊断 | H1 monitor CDP 队列最可能；D1/D6 方向 | `p6c-b1-diagnosis`、`p6c-c-audit` 邻近 |
| 1.6 D1/D5 | 低干扰 DB/stream monitor、one-shot CDP、main 可观测性、mock 压测 | `p6c-b16-*`、`evidence/p6c-b25-*` |
| 批次 2 第一次 | run1 flag 592.6s；run2 页面卡住（pre-D3）；run3 未跑；retry 533.7s；run3 aborts | `p6c-b2-*`、`p6c-b22-*`、`p6c-b23-*`、`p6c-b24-*` |
| 2.1 D3/D5.2 | thought 32K cap、窗口文本预算、appendData/rAF；heartbeat/longtask/Tab RSS | `p6c-b21-*` |
| 2.2 D4/D2 | store/UI 100ms/200 批、renderLeft rAF；main 80ms stream 合并（90,290→2,899） | `p6c-b22-*`、`p6c-b2-verify-*` |
| 2.3 mock full-UI | 真实 s11 90,290 updates；missing 0、blocks 90、maxText 32,779 | `p6c-b25-mock-stress` |
| 2.4 IPC stress | fake Hub + 真 preload/IPC/D2；missing 0 | `p6c-b25-ipc-stress` |
| 2.5 真实数据 mock | 17 tasks/28 artifacts/2 flags/1 approval；missing 0 | `p6c-b25-real-*` |
| 2.6 C 审计 | missing=后台 timer 节流，不是主线程 stall；300s/55s 证据 | `p6c-c-audit.txt` |
| 2.7 D7a + flag 闭环 + 靶场探测 | throttled-hidden/stall 分类；两 flag confirmed；44892 200（当时） | `p6c-b27-*` |
| 批次 2 第二次 | b2b 3 次：run1 44892 E2 570.5s；run2 44892 无 flag/target down；run3 53865 E2 422.6s | `p6c-b2-*`（b2b）、`p6c-b2-summary.json` |
| 批次 3 | **跳过**（用户未提供 2 道新题；不自编题） | — |

## 行为变更汇总

### 产品行为

- **P6-B 2a**：代理状态机 + `HubSnapshot.scope.proxy` + `proxy.state.changed`；failed/stopped 时 port 置空；旧快照兼容。
- **P6-B 2b**：renderer 代理五态（running/failed/stopped/starting/unknown/disabled）+ 错误色，不再把“启动失败”显示成“已启用”。
- **P6-C D3**：thought 单块 32K 截断（保留末 32K + 标记）；窗口文本预算 131K；`patchBlock` head 稳定 + `Text.appendData`；scroll 改 rAF；真实页面卡住修复（DOM 181.1→14–17ms）。
- **P6-C D5.2**：renderer 5s heartbeat + longtask；main 记录 RSS/Tab/Renderer 指标、unresponsive/gone。
- **P6-C D4**：`session.upsert/health` 100ms/200 条批处理；`renderLeft` rAF 合并；审批/flag/artifact 等仍立即。
- **P6-C D2**：main 在 IPC 层 80ms 合并相邻 `agent_thought`；缓冲上限 2000；before-quit flush；Hub bus/verify 不变。
- **P6-C D7a**：renderer 心跳带 visibility/prevVisibility/gapMs/throttled；main 区分 `throttled-hidden` 与 `stall`，记录 visibility 切换；不改 `backgroundThrottling`。

### 测试/基础设施（非产品）

- `bench-monitor.ts`（D1）、`bench-stress.ts`（1.6c）、mock stress/preload/real-data harness、C 审计 harness、b2b run evidence writer。
- 这些只在 `apps/desktop/src/cli/` 或 `%TEMP%`；不改变产品行为。

## 验收数字

| 门禁 | 结果 |
|---|---|
| `verify:all` | **711 PASS / 0 FAIL** |
| `verify:scope` | **354/354**（首跑 353 为已知 `target notes` transient，rerun 354） |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:artifacts` | **324/324** |
| `verify:skills` | **149/149** |
| `verify:multitask` | **174/174** |
| `verify:bench` | **73/73** |
| electron `--verify` | **26/26** |
| `.probe/backup-wp1/board.db` sha256 | `6d491f0b…ab5cf469`（未变） |
| board `user_version` | 3 |

> 注：multitask F 组历史上 flaky；本次 `verify:multitask` 174/174 通过，但“F flaky”仍按已知风险挂账。render-verify 6 项既有失败不在 verify:all 链，仍挂账。

## 已知限制清单（≥15）

1. **真实样本不足**：4 个 E2 flag，远低于计划 5–10 题 × 3；不能下扇出/题型结论。
2. **批次 3 跳过**：用户未提供 2 道新题；没有新题型数据。
3. **target 不稳定**：44892 跑后 down；run1/2 与 run3 target 不同；flag 值不同。
4. **非同一实例重复**：b2b run3 用 53865，不是 44892 的 3 次重复。
5. **旧批次 2 run2 页面卡住**：pre-D3 真实缺陷，不是完整 benchmark 样本。
6. **批次 1 无 flag + target down**：失败率分母不稳定。
7. **token 不完整**：run2 0 零记录；模型 ID 未落库；无法精确成本。
8. **wall 是 timeout 边界**：15min 不是 makespan；只有 first flag 可比。
9. **审批覆盖率低**：b2b 101 calls 仅 3 审批；旧 run 多为 0；人工延迟影响 first flag。
10. **单 session only**：没有真实 2/3 路扇出 A/B；“扇出收益”未知。
11. **skill_search 使用不一致**：12/18/0，无法归因题型。
12. **D7b 未做**：不改 `backgroundThrottling`；只做观测区分（throttled-hidden）。
13. **D7c 未做**：CDP 策略未改；D1 monitor 历史有 CDP snapshot 超时。
14. **command 提交未实现**：只有 manual/dry_run；不接平台 API。
15. **scope/proxy 默认关**：无真实 extract 误报率/代理收益数据。
16. **60min soak 未完成**：32min 外部终止，interim PASS。
17. **multitask F flaky / render-verify 6 项**：既有风险未清。
18. **无真实一键 runner**：真实跑靠手动 Electron/CDP + monitor，复现成本高。
19. **干净机器/NSIS 未验证**（B-4，WP7）。
20. **target 宕机/审批覆盖率/verify-ab 误启动**：WP6 独立发现，需 WP7/WP8/最终报告处理。
21. **flag 候选未 confirm/submit**：按纪律保持 new；b2b 两个 E2 flag 未走确认（2.7 的两个历史 flag 已确认，属另一数据）。
22. **基准 harness 是测试代码**：bench-monitor/bench-stress/harness 不是产品路径；P6-A 的 bench runner 仍 dry-run only。

## WP7 之前必须知道的事（交接）

### WP7 会碰的文件

- `apps/desktop/src/main/blackboard/board.ts`：启动备份、迁移失败回滚、哈希链检查（P7-A）。
- `apps/desktop/src/main/session/manager.ts`：子进程登记/清理、MCP 崩溃状态（P7-B）。
- `apps/desktop/src/main/acp/client.ts`：`killTree` + PID 复用校验（P7-B）。
- `apps/desktop/src/main/electron/main.ts`：启动流程/错误提示（P7-A/B）。
- `apps/desktop/src/main/config/loader.ts`：可移植 workDir/skillDir（P7-C）。
- `electron-builder` 配置、`docs/BLOCKED.md`（B-4）、`docs/PROGRESS.md`。

### 不要重开的事

- **renderer 产品修复已在 P6-C D3/D4 完成**；WP7 不再碰 renderer，除非出现可靠性问题。
- **D7b（`backgroundThrottling:false`）不做**；**D7c（CDP 策略）不做**。
- **command 提交模式不实现**（WP6 决策）。
- **verify 套件/ smoke / mock / config / rules / benchmarks.example / skill / ARCHITECTURE** 不碰。
- **契约冻结**：WP7 若需新契约字段，先写 `docs/requests/` 并停下问用户。

### WP7 必须处理的 WP6 遗留

- 靶场宕机是外部风险；WP7 的可靠性（备份/进程清理）不能假设 target 稳定。
- 审批覆盖率不足（session 级 grantAll 自动放行）是 WP4 已知，WP6 真实跑再次暴露；WP7 不要把它当 WP6 回归。
- verify-ab 误启动事故是独立发现，WP7/最终报告处理；不作为 benchmark 数据。
- 干净机器安装/NSIS 未验证（B-4）；WP7-C 只跑 dir 包 `--verify`，不重打 NSIS。

### 基线门禁（WP7 开始前）

```text
verify:all 711/0
verify:scope 354/354（首跑 target notes 353 transient，rerun 354）
verify:flags 214/214
verify:migration 127/127
verify:artifacts 324/324
verify:skills 149/149
verify:multitask 174/174
verify:bench 73/73
electron --verify 26/26
.probe/backup-wp1/board.db sha256 6d491f0b…ab5cf469
```

## 没做什么 / 已知问题

- 没有 5–10 题 × 3 次真实 benchmark；没有真实多 session 扇出 A/B。
- 没有批次 3；没有新题型。
- 没有 command 提交；没有平台 API。
- 没有 D7b/D7c。
- 没有完整 60min soak（32min 外部终止）。
- 没有 NSIS/干净机器验证（WP7）。
- 没有把 b2b 两个 E2 flag confirm（按“不自动 confirm”纪律）。
- 没有修改任何代码（P6-D）。

## 证据

- P6-A：`evidence/p6a-*`、`docs/done/P6-A.md`
- P6-B：`evidence/p6b-*`、`docs/done/P6-B.md`
- P6-C：`evidence/p6c-*`、`docs/done/P6-C.md`（批次 1~2.7、第二次批次 2）
- b2b：`evidence/p6c-b2-summary.json`、`p6c-b2-run{1,2,3}-*.json`、`p6c-b2-target-checks.txt`
- 最终门禁：`evidence/wp6-final-*.txt`
- 报告：`docs/BENCHMARKS.md`

## 下一手需要什么

- **WP7** 按 §10 做可靠性/打包；先跑基线门禁，再读本文件“WP7 交接”。
- 若要补真实 benchmark：需要稳定靶场 + 2 道以上新题 + token 授权；批次 3 提示词可复用，但不要用占位题下结论。
- WP6 数据不足以回答扇出收益；P6-D 不写“扇出建议”，只写限制与基线。
