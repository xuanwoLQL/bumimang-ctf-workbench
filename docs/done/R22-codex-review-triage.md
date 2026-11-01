# R22 · Codex 评审分诊：验真 + 修 3 个真 bug + 勘误我自己的文档

**日期**：2026-10-20 17:05 · **范围**：`src/main/hub/hub.ts`、`src/main/electron/main.ts`、`src/cli/verify-ab.ts`、`src/cli/verify-history.ts`、docs 勘误、`.probe/asar-r21-check.cjs`

## 做了什么

用户把 Codex 对项目的评审（A1–A11 / P1–P5 / T1–T6 / Top5）贴了回来。按项目铁律（**文档断言必须当场验证**）先逐条验真，再修三个确认的真 bug，并勘误我上一轮自己写错的两条结论。

**验真结果（Codex 命中率极高，只有口径修正、没有事实性错误）**：

| 条目 | 结论 |
|---|---|
| A1 任务工作目录不隔离 | 属实，但 R16 是明确的既有设计取舍（单一 work 根），属待决策的架构升级 |
| A2 租约无 holder 校验、全局主键 | **属实**（releaseLease 只按 resource 删） |
| A3 启动失败无回滚/无超时 | **属实**（wireLogs/insertSession 先行，无 catch 回滚） |
| A4 审批不落库、timeout 混同 deny | **属实**（approvals 表 0 条 INSERT） |
| A5 rawInput 未进 command/target | **属实**（commandOf 只读 detail.command/title） |
| A6 witness 不入哈希链 + 回滚留错链尾 | **属实**（payload=ts/session/kind/subject/body；lastHash 在 COMMIT 前推进） |
| A7 MCP token 落 wire 日志 + 不绑会话身份 | **属实**（4 个 A/B wire.jsonl 全含 BUMIMANG_TOKEN） |
| A8 规则包字段未实现/未知字段过度匹配 | 属实（待核对规则文件细节，方向正确） |
| A9 契约无版本、pid 恒 null、setTier 空实现、preload 硬编码通道名 | **属实**（全部亲眼复核） |
| A10 生命周期容器只增不减、孤儿进程 | 属实（与既有「Job Object 单独开轮」一致） |
| A11 黑板积压 >200 条跳事件 | **属实，已修**（见下） |
| P1 首答时间 ≠ 墙钟时间 | **属实，数字精确**：首答 69.5s vs **58.8s**（三路快 15%）；157.9s 是全队收尾 |
| P2 首答不驱动收敛 | **属实**（noteFlagCandidate 只更新 UI，不停别的会话） |
| P3 intent 不是锁、claimIntent 无路由 | **属实**（protocol 有词条、server 无 route） |
| P4 没测多引擎/guarded | 属实（工具只有 --agent 单参、autonomous 档） |
| P5 指标不够 | 属实 |
| T1 verify:all 不含渲染层/打包态 | 属实（既有取舍，打包态靠人工跑，可升级统一 gate） |
| T2 boardReads=0 是假指标 | **属实，已修**——而且推翻了我 AB-1 文档里的结论，见勘误 |
| T3 并发测试是同步串行 | **属实**（Promise.all 包同步 acquireLease） |
| T4 一批失败模式无测试 | 属实 |
| T5 硬编码路径/共享 .ui-run | 属实 |
| T6 B-4 安装流程未验 | 属实（BLOCKED 老条目，Codex 遵守了只读约束） |

**修掉的三个真 bug**：

1. **A11（事件跳页）**：`readSinceForTask` 默认 LIMIT 200，而 flushBoard 直接把游标推进到 `lastEventId()`——积压超 200 条时中间的台账/flag 候选被永久跳过。修法：`publishBoardSince` 返回本页最大事件 id，`flushBoard` 用返回值循环分页排空（带防死循环保险丝）。verify-history 新增 2 条断言：222 条事件分 2 页排空、一条不多一条不少。
2. **T2（boardReads 假指标）**：A/B 工具建桥时没接 `onBoardRead` 回调（桥有回调、manager 有计数点，唯独 harness 没接），boardReads 恒 0。修法：桥的 onBoardRead 经先声明后赋值回调 `mgr.noteBoardRead`。另加 P1 指标 `firstFlagMs`（首个 flag 事实相对 run 起点的时间），对照表新增一行。
3. **T2 附带（错误退出码）**：`verify-ab.ts` 无条件 `process.exit(0)`，失败运行也报成功——改为有错误即 exit 1。

**勘误（我上一轮的文档错了两条，都是没当场验证的教训）**：

1. `AB-first-real-run.md` 与 HANDOVER 里「三家 boardReads=0 ⇒ 简报继承没被消费」——**错的**。wire 实测单会话读板 5 次、三会话 9/9/21 次，agent 确实在消费黑板。真因是工具接线缺失。
2. 「3 会话没有省时间」——**口径不完整**。首答时间三路快 15%（58.8s vs 69.5s），慢的是全队收尾；正确结论是「缺收敛机制」。两处文档已改。

## 改了哪些文件

- `src/main/hub/hub.ts`：`publishBoardSince` 返回本页最大 id
- `src/main/electron/main.ts`：`flushBoard` 分页排空循环
- `src/cli/verify-ab.ts`：onBoardRead 接线 + firstFlagMs + 错误退出码
- `src/cli/verify-history.ts`：+2 条 A11 断言（66→68）
- `docs/done/AB-first-real-run.md`、`docs/HANDOVER.md`：勘误
- `.probe/asar-r21-check.cjs`：+3 条 R22 核查

## 怎么验证的

```powershell
node apps/desktop/src/cli/verify-history.ts     # 68/68（+2：222 条事件分 2 页排空、页数≥2）
npm run verify:all                              # 49+16+17+19+68+110 = 279 + smoke，exit=0
npm run ab -- --dry                             # PASS（新指标/接线不破坏 dry 路径）
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
                                                # 19/19
dist\win-unpacked\不迷茫.exe --no-sandbox --verify   # 19/19（17:07 重打包）
node .probe/asar-r21-check.cjs                  # 10/10（含 R22 三处）
```

## 没做什么 / 已知问题

- **A1–A10、P2–P5、T1/T3–T6 全部只验真、未动手**。其中 A2（租约 holder 校验）是下一个最便宜的安全修复（1 行 + 2 断言）；A7（token 落盘+不绑身份）是下一个最该做的安全修复（但涉及日志脱敏与连接生命周期，量级大一些）。
- **首答时间指标只在工具层加了**，UI/scorecard 还没展示（P5 的另一半）。
- **「收敛机制」（P2）没做**——这是让 A/B 主张成立的核心机制，建议单开一轮（涉及「高证据候选 → 宽限 → cancel/收尾 → 关其余会话」状态机，动 hub/manager/契约）。
- Codex 的 Top5 优先级我基本同意，但把它的第 1 条（修 A/B 度量）提前做了；其余四条（收敛机制、任务目录/租约/意图真隔离、审批与黑板安全边界、统一 gate+故障夹具）作为候选轮次。

## 下一手需要什么

无阻塞项。建议顺序：A2（小）→ 收敛机制（中，产品核心）→ A7 安全边界（中）→ A3/A4/A6 合并一轮（审批+启动+哈希链审计）→ A1 任务目录（需和 R16 的既有设计取舍对一次口径，可算用户拍板项）。
