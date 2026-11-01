# R-1 徽标验收 + blocked 终态 UI + 渲染进程鲁棒性扫（Lane B · 第 6 轮）

- **时间**：2026-10-13 01:43
- **作者**：Lane B
- **范围**：只改 `apps/desktop/src/renderer/**` 与 `apps/desktop/electron/**`；未碰 `docs/ARCHITECTURE.md`、`apps/desktop/src/main`、`packages/shared-protocol/events.ts`。

## 任务 1 · R-1 徽标显示真实包名（真实桥验收）

Lane A 已把 `policy?: { packId, name, fellBackToMinimal }` 填进 `HubSnapshot`。本轮写了一个**不起任何 agent** 的真实桥验收入口 `apps/desktop/electron/r1-verify.ts`：
它复用 Lane A 的核心（Blackboard / BoardBridge / SessionManager / HubService / **PolicyEngine**），照主进程入口接好三条 IPC 通道 + preload，让渲染进程真的连上 `window.bumimang`。

**结论：左栏「规则包」徽标显示 `policy-engine(比赛合规包)`，不再是占位「—」。**

关键断言（全部 PASS，见 `docs/logs/r1-verify.json`）：
- 快照带 `policy` 字段：`{"packId":"competition","name":"policy-engine(比赛合规包)","fellBackToMinimal":false}`
- `policy.name` 与真实引擎/规则包一致（`PolicyEngine.name` === `policy-engine(<rules/competition.json 的 name>)`）
- 徽标文本 === `policy-engine(比赛合规包)` 且 ≠「—」
- 徽标无占位样式 `policy-pack-none`，无「已回落最小安全集」小字（fellBackToMinimal=false）

证据截图：`docs/logs/r1-policy-badge.png`。

## 任务 2 · SessionStatus "blocked" 的 UI 呈现

`blocked` 是 **§9.6 拒绝退避** 造成的终态（策略切断），跟 `failed`（崩溃）、`stopped`（人工停止）不是一回事。改了渲染层：

- 新增纯逻辑 `apps/desktop/src/renderer/session-status.ts`：九个状态的文案表 + `isTerminalStatus()`。
  - `blocked` → 「被策略切断」；`failed` → 「崩溃」；`stopped` → 「已停止」；`done` → 「已完成」…
- `main.ts` 会话卡：状态徽标用文案（不再裸显示 `blocked`/`failed` 英文），blocked 卡片加 `title` 说明「因同一规则被策略连续拒绝，已按 §9.6 拒绝退避终止（策略切断，非崩溃）」。
- `panes.ts` 窗格：状态徽标同样用文案；窗格根节点带 `pane-<status>` 类，状态流转时同步更新。
- `styles.css`：
  - blocked 徽标红字 + **红边框**；failed 只红字、无红边框 → 两者不再共用一种「红」。
  - blocked 会话卡红边框 + 淡红底；blocked 窗格红描边。

验证（`r1-verify.ts` 经真实 EventBus → hub:event 通道注入 blocked/failed/stopped/running 四个会话）：
- blocked 文案「被策略切断」、failed「崩溃」、stopped「已停止」、三终态互不相同
- blocked 卡片 computed `borderTopColor = rgb(218,54,51)`，failed 卡片 = `rgba(0,0,0,0)` → **视觉上不混同、不像崩溃**
- 中栏窗格带 `pane-blocked` 且状态文案正确

证据截图：`docs/logs/r1-blocked.png`。

## 任务 3 · 渲染进程鲁棒性扫（敌意输入）

新入口 `apps/desktop/electron/blocked-hostile-verify.ts`：经真实 IPC 通道喂两批「形状仍是契约 HubSnapshot」的敌意快照：

- 阶段 A：全空数组 + `task=null` + `policy=null` + `agents=[]`
- 阶段 B：可选字段 null/undefined、`syncLag=999`、`sameKindCount=0`、超长字符串（任务标题 1.4 万字符 / agent 名 / 命令全文 / 自述意图 / 事实 / 资源名）、`policy.fellBackToMinimal=true`

**结论：没有发现任何崩溃。** 全部 28 条断言 PASS（`docs/logs/blocked-hostile-verify.json`）：
- `render-process-gone` 为空、console error 为空（无未捕获异常）
- 空数组下各空状态文案正确、扇出弹窗 0 个 agent 选项也能开不崩
- 超长字符串不把栏撑爆（`scrollWidth ≤ clientWidth`）—— 为此在 `styles.css` 加了一条 `overflow-wrap: anywhere; min-width: 0` 兜底（`.session-agent/.task-title/.task-brief/.policy-pack-name/.pane-agent/.lease-resource`）
- `syncLag=999` → 「同步 999 · tool 123」红档；`sameKindCount=0` → 「本会话同类首次出现」不标重复
- 没有把 null/undefined 打成 `undefined` 字面量、没有 NaN 泄漏

证据截图：`docs/logs/hostile-empty.png`、`docs/logs/hostile-filled.png`。

## 回归

- `node apps/desktop/src/renderer/smoke.ts`：ALL PASS（新增会话状态文案/终态断言）
- `render-verify.ts`（mock）：ALL PASS
- `push-verify.ts`（事件驱动 PUSH）：ALL PASS

## 给 Lane A 的备注（不阻塞）

1. `SessionRecord.blocked` 目前没进 `SessionView`（契约里 `SessionView` 没有 `blocked` 字段），渲染层只能靠 `status === "blocked"` 区分 —— 这够用；若以后要更丰富的「策略切断原因」展示，走 docs/requests/ 加字段。
2. 顺手发现并绕过一个环境坑：Electron 44 的 `console-message` 事件签名变了（`(event, {level, message, ...})`），旧 verify 脚本里 `args[2]` 取 message 的写法在 44 上会记录空串。我的两个新脚本里写了兼容两种签名的 handler；Lane A 若要在主进程里收集渲染进程 console，可照抄 `r1-verify.ts` 里那段。
