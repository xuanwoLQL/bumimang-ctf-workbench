# 空状态诚实化：不再用「暂无待审批」假装一切正常

> 完成时间：2026-10-13 02:11 · Lane B（第 7 轮）· renderer + electron

## 背景

[GATE-INPUT-STARVED](./GATE-INPUT-STARVED.md) 测出：真实 opencode 在默认配置下**从不请求授权**（写文件、跑 shell 各 `request_permission` 0 次）。所以「审批面板是空的」有两种截然不同的读法：

1. 还没出现需要审批的关键动作（一切正常）；
2. 该 agent 默认不请求授权，闸门「已武装但上游没水」（空 ≠ 安全）。

旧的空状态只写「暂无待审批 + 会话开始后关键动作会出现在这里」，把「没有可审批的」和「没有审批能力的」混成一句，读起来像「all good」。本轮把这两种可能**分开讲清楚**，并亮出当前规则包，让用户能一眼判断闸门到底装没装。

## 做了什么

### 1. 审批面板空状态（`approval/approval.ts`）

空状态现在包含三块：

- 标题仍是「暂无待审批」（保持既有断言语义不变）；
- **规则包行**：`规则包 · {snapshot.policy.name}`（缺席显「—」，`fellBackToMinimal` 时附「已回落最小安全集」）——让用户看到闸门确实已加载；
- **两种可能**：
  - ① 还没出现需要审批的关键动作（命令执行 / 文件写入等）。
  - ② 该 agent 默认不请求授权（如 opencode 的 `permission.edit/bash` 未开启）——有会话在跑而这里一直空，多半是这一条。

### 2. 会话窗格安静提示（`panes/model.ts` + `panes/panes.ts`）

新增纯函数 `sessionQuietHint()`：当会话 `running` 且**跑了 ≥ 30s**、**0 审批**（问过就算，含已决）、**0 读黑板**（`health.boardReads`）时，窗格底部给一句平静提示：

> 已运行 1 分钟，尚无审批请求、未读黑板 —— 可能还没到关键动作，也可能是该 agent 默认不请求授权。

- 提示在窗格**底部**（`pane-quiet`），虚线顶边 + 灰色小字，**不是告警样式**；
- 「跑了有一阵」随时间推进：事件驱动只在状态变化时刷新，静默运行的会话靠一个 5s 低频计时器**只刷提示条、不重排窗格**（不打断日志滚动位置）。

## 改了哪些文件

```
apps/desktop/src/renderer/panes/model.ts        sessionQuietHint() + QUIET_HINT_AFTER_MS + 时长格式化（纯逻辑）
apps/desktop/src/renderer/panes/panes.ts        窗格底部安静提示 + 5s 提示刷新计时器（dispose 时清理）
apps/desktop/src/renderer/approval/approval.ts  空状态：规则包行 + 两种可能
apps/desktop/src/renderer/styles.css            .ap-empty-gate / .ap-empty-reasons / .pane-quiet（平静灰色，无告警）
apps/desktop/src/renderer/smoke.ts              新增「会话安静提示」纯逻辑断言 8 条
apps/desktop/electron/gate-empty-verify.ts      新：受控快照 + 真实桥验收空状态与安静提示（17/17）
```

## 验收

- `node apps/desktop/src/renderer/smoke.ts`：ALL PASS（含新增 8 条安静提示纯逻辑断言）。
- `gate-empty-verify.ts`（真实 preload/ipcRenderer 通道 + 受控合成快照）：**17/17 ALL_PASS**，覆盖：空状态亮出规则包、两种可能都出现、未把「空」说成「一切正常」、4 个会话的提示边界（应示/未达阈值/读过黑板/问过授权各不误报）、无崩溃、无 undefined 泄漏。
- 回归：`render-verify`（mock 路径）ALL_PASS、`blocked-hostile-verify`（空快照 + 敌意输入）ALL_PASS、`push-verify`（事件驱动）ALL_PASS —— 新空状态没弄坏既有文案断言与敌意输入鲁棒性。
- 截图证据：`docs/logs/gate-empty.png`（空状态 + 安静提示真实窗口）。

## 没做什么 / 边界

1. **没动契约。** `snapshot.policy` 上一轮已存在，本轮只消费；`sessionQuietHint` 是渲染进程本地纯逻辑，不需要新字段。故 BLOCKED.md 无需追加。
2. **阈值 `30s` 是雏形默认值**，没有做成配置。要不要更久（如 60s/120s）、要不要在提示里直接给「去配置 opencode permission」的按钮，都留给下一轮或用户拍板。
3. **只提示、不代改。** 与 GATE-INPUT-STARVED 的结论一致：提示「可能不请求授权」可以，替用户改 `~/.config/opencode/opencode.jsonc` 不行（见 BLOCKED B-3）。
4. 安静提示的「0 读黑板」依赖 `health[sessionId].boardReads`；健康度缺失时按 0 计（会偏「提示」，但不告警，可接受）。
