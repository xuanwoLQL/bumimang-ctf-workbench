# 第 19 轮 · R9 回归扫 —— Lane A 三处改动后，Lane B 全部快校验套件重跑

> 完成时间：2026-10-13 09:07 · Lane B（renderer + electron）
> 结论：**10 个快确定性校验套件全部 ALL_PASS，零失败**（smoke 91、render-verify 14、push-verify 16、
> r1-verify 26、gate-empty-verify 17、blocked-hostile-verify 27、cold-start-verify 29、
> scorecard-verify 15、tier-asymmetry-verify 20、approval-verify 17）。**BLOCKED.md 无需追加。**

## 背景

Lane A 在 R8（打包态真实用户流程 27/27）之后改了三处（都在 `src/main`，Lane B 不碰）：

1. `session/manager.ts` `prompt()` 不再无条件落 idle —— 会话本轮**中途**已到终态
   （blocked/stopped/failed/done）就保留该终态、不覆盖回 idle（L-4 修复）。
2. 拒绝退避计数改按**请求内容签名**（`approvalSignature`）而不是策略规则 id，阈值可配
   `BUMIMANG_DENIAL_THRESHOLD`（L-4 续修）。
3. 加了应用图标、重打了 `dist/`。

这轮不是加功能，是把 Lane B 自己的全部**快确定性**校验套件重跑一遍，确认 A 的改动没有弄坏渲染层断言。

## 结果表

| 套件 | 命令（Windows） | 断言 | 结果 |
| --- | --- | --- | --- |
| smoke | `node apps/desktop/src/renderer/smoke.ts` | 91 | ALL_PASS |
| render-verify | `electron apps/desktop/electron/render-verify.ts` | 14 | ALL_PASS |
| push-verify | `electron apps/desktop/electron/push-verify.ts` | 16 | ALL_PASS |
| r1-verify | `electron apps/desktop/electron/r1-verify.ts` | 26 | ALL_PASS（+4 新断言） |
| gate-empty-verify | `electron apps/desktop/electron/gate-empty-verify.ts` | 17 | ALL_PASS |
| blocked-hostile-verify | `electron apps/desktop/electron/blocked-hostile-verify.ts` | 27 | ALL_PASS |
| cold-start-verify | `electron apps/desktop/electron/cold-start-verify.ts` | 29 | ALL_PASS |
| scorecard-verify | `electron apps/desktop/electron/scorecard-verify.ts` | 15 | ALL_PASS |
| tier-asymmetry-verify | `electron apps/desktop/electron/tier-asymmetry-verify.ts` | 20 | ALL_PASS |
| approval-verify | `electron apps/desktop/electron/approval-verify.ts` | 17 | ALL_PASS |

> 断言数取自各套件写进 `docs/logs/*.json` 的 `assertions` 数组（权威），smoke 取运行输出的 PASS 行数。
> 每个 electron 套件独立 userData（`.ui-run/electron-profile-*`），**逐个串行跑**，不并行。

## 专项核对：blocked 中途到达（对应 Lane A 改动 #1）

任务要求核对：会话卡「blocked」渲染路径在改动 #1 之后仍正确 —— 即**中途到达 blocked 的会话必须显示
「被策略切断」，且永远不会闪「空闲」**。

- 既有覆盖：`blocked-hostile-verify`（受控快照里的 blocked 卡片文案/红边框）、`r1-verify`（真实
  EventBus → `hub:event` 注入 blocked，左栏卡片 + 中栏窗格文案）。
- 缺口：此前没有一条断言覆盖「**同一会话先 running 后 blocked 的事件序列**」—— 那正是 L-4 的真实事件
  形态（`prompt()` 先落 running，`markBlocked` 中途落 blocked，旧的 buggy 代码再补一条 idle）。
- 本轮补：在 `r1-verify.ts` 加 4 条断言，对 `s-midturn-1` 先注入 `running`、再注入 `blocked`，并用
  ~12ms 一拍的高频采样记录该会话状态文案序列（共 49 拍）：
  1. 同会话先以 running 画出来；
  2. blocked 后卡片最终停在「被策略切断」（`session-item session-blocked`）；
  3. 中栏窗格转成 `pane-blocked` 且状态文案正确（running→blocked **转换**路径，非「直接建 blocked 窗格」）；
  4. **达到「被策略切断」之后从未再闪「空闲/运行中」** —— 采样序列 firstBlocked@4，其后 45 拍全是
     「被策略切断」，零回退。

结论：渲染层按 last-wins 处理事件序列，blocked 中途到达时卡片与窗格都停在「被策略切断」、不回退、不闪
「空闲」；渲染层无需为改动 #1 做任何修补（改动 #1 是主进程行为修复，Lane B 未触碰、只验证下游呈现）。

## 改动 #2 / #3 对渲染层的影响

- **改动 #2（退避改内容签名）**：`DenialTracker` / `approvalSignature` 都在 `src/main`；渲染层只消费
  `ApprovalView.sameKindCount`（由队列内部另算，与退避计数无关），不读退避计数 → **无影响**。本 lane 的
  `cold-start-verify` 仍 `new DenialTracker(2, ...)` 接线（构造签名未变），运行无碍。
- **改动 #3（图标 + 重打 dist）**：不涉及渲染层源码；本轮未重跑打包态（见下「没做什么」）。

## 没做什么 / 边界

1. **跳过的真实 agent 套件**（需要真 claude/opencode，非「快确定性」）：real-approval / real-board /
   real-parallel / real-bridge / ui-deny-blocked / packaged-flow。其中 **ui-deny-blocked** 与
   **packaged-flow** 是改动 #1/#2 之后最想重跑的端到端证据，留待有真 agent 时跑。
2. 没跑打包态（R6/R8 的 CDP 探针需启动 `dist\win-unpacked\不迷茫.exe`，属打包态范畴，不在本轮清单）。
3. 没跑 Lane A 的 `src/cli` 套件（verify:gate 49/49、verify:concurrency 15/15 等）—— 那是 Lane A 的 lane。
4. **零失败**，因此 BLOCKED.md 本轮无需追加。

## 改了哪些文件

```
apps/desktop/electron/r1-verify.ts   增 4 条「blocked 中途到达」断言（含高频采样探针）
docs/logs/r1-verify.json             重跑后 26/26（含 midturnProbe / midturnSamples 证据）
docs/logs/*.json                     其余 9 个套件证据按本轮重跑刷新
```

没动 `apps/desktop/src/renderer`、没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约
`packages/shared-protocol/events.ts`。（`r1-verify.ts` 位于 `apps/desktop/electron`，属 Lane B。）

## 怎么复跑

```powershell
cd D:\agent\xuanwo
Get-Process electron,'不迷茫' -ErrorAction SilentlyContinue | Stop-Process -Force
node apps/desktop/src/renderer/smoke.ts
node_modules\electron\dist\electron.exe apps/desktop/electron/render-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|ALL_PASS"
# ……其余套件同理，逐个串行跑（不要并行，避免多实例抢默认 userData / 文件锁）
```
