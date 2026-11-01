# 第 4 轮 · 审批面板对接真实 ApprovalView + 扇出 UX 反映现实 + T12 交接截图

> 完成时间：2026-10-13 00:47
> 归属：Lane B（renderer + electron）。策略引擎 / 审批队列 / 主进程入口是 Lane A 的（T3+T4），
> 本文件只 import 不改。契约 `packages/shared-protocol/events.ts` 冻结未动。

这一轮做三件事：把审批面板从「mock 形状」校正到「Lane A 队列真的会产出的 ApprovalView 形状」；
让扇出/起会话 UX 反映真实的 `snapshot.agents`（4 家，带 installed/installHint/maturity）；
并重新捕获真实桥窗口截图作为 T12 交接证据。

## 1. 审批面板对齐真实 ApprovalView

**对照契约 `ApprovalView` 逐字段校正**，把渲染路径从 mock 的 `terminal/exec` / `fs/write` 形状
换到真实队列（`apps/desktop/src/main/approval/queue.ts`）会产出的形状：

- **action 是 `session/request_permission`**（不是 mock 里的 `terminal/exec`）；这是 Lane A 实测
  确认的唯一事前闸门动作。
- **command / target 常为 null**（opencode 的权限请求 `rawInput` 结构不固定，Lane A 未做适配）。
  左栏 command=null 时显示占位「（未提供命令全文）」、target=null 显示「目标：—」，不再空着。
- **intentSummary 常为 null**（会话还没有 agent 自述文本时 `hub.intentSummary` 返回 null）。
  中栏退化到「暂无自述意图」。
- **已决项（approved/denied/timeout/auto）不再被丢掉**：面板分「待审批」+「最近已决」折叠区，
  已决项只读（无放行/拒绝按钮）、带状态徽标（已放行 / 已拒绝 / 已超时 / 已自动放行）、按决断
  时间倒序。这对应 `queue.list()` 的「待批 + 最近已决」语义。
- **sameKindCount > 1 显示退避**：`本会话同类已出现 N 次（重复）`，高亮提醒（§9.6）。
- **卡片类带风险而非状态**：修掉一个既存死样式——原卡片类写的是 `ap-${status}`（只会得到
  `ap-pending`），`.ap-card.ap-high` / `.ap-card.ap-blocked` 的边框色从来没生效过。改为
  `ap-${risk}`，高危橙色、硬阻断红色左边框真正画出来，排序断言也因此可测。

**纯逻辑（`approval/model.ts`）新增**：`decidedApprovals`（非 pending 按 decidedAt 倒序）、
`statusLabel`（ApprovalStatus → 中文）、`sameKindLabel`（首次 vs 重复）。`smoke.ts` 扩到
45 断言全过。

**可运行验收**（新入口 `apps/desktop/electron/approval-verify.ts`，真实 Chromium 窗口，mock
传输 + 真实形状数据，不 spawn agent，18/18 过）：待批 4 条按 blocked/high 在前、高危长命令
130 字符完整呈现且 word-break、null 字段占位、已决项只读徽标「已放行」、退避「重复」提示、
渲染进程零 console.error。证据 `docs/logs/approval-verify.{png,json}`。

## 2. 扇出 / 起会话 UX 反映现实

`snapshot.agents` 现在真的返回 4 家 `{installed, installHint, maturity}`。UI 把「可用 vs 未安装」
显式摆出来：

- **左栏加号按钮上方**新增引擎可用性摘要：`引擎可用 3 · 未安装 1`。
- **扇出弹窗顶部**新增摘要：`可用 3 · 未安装 1（未安装的会灰显，选中看安装提示）`。
- **agent 下拉**每个选项标 `（可用）/（未安装）`，未安装的灰显；选中后下方显示该家的
  `成熟度：…`（已安装）或 `安装提示：…`（未安装）。默认选中第一个可用的 agent。
- **起第一个会话按钮 primary**：无会话时 `+ 扇出会话 / 起第一个会话` 为 primary 填充样式
  （上一轮已做，本轮在真实桥上回归确认仍生效，`primary=true`）。

真实桥验证里确认：opencode/codex/claude 可用、dsh 灰显，`summary="可用 3 · 未安装 1"`、
`detail="成熟度：ACP 原生子命令，握手实测通过（protocolVersion=1）"`。

## 3. T12 交接证据（真实桥截图）

升级 `apps/desktop/electron/real-bridge-verify.ts`：**复用 Lane A 的核心**（Blackboard /
BoardBridge / SessionManager / HubService / **PolicyEngine / ApprovalQueue**，只 import 不改），
照主进程入口把真实审批队列接进快照与事件流，再经真实 `window.bumimang` 桥推给渲染进程。

- 起一个真实 opencode 会话（`session.start` 返回 `{ok:true}`）；
- 用真实 `ApprovalQueue.request()` 种入 5 条真实形状审批（高危 mimikatz 长命令、两条
  command/target/intentSummary 全 null 的、同类第二次 sameKindCount=2、一条 `curl` 外联、
  一条种入后 `decide(approved)` 成已决）——这些 ApprovalView 由 Lane A 的队列自己生成，
  不是 mock；
- 断言渲染进程画出的审批面板与截图，共 **33/33 过**。

三张交接截图（真实窗口、真实桥、非 mock）落在 `docs/logs/`：

- `real-bridge-empty.png` —— 空状态 + primary「起第一个会话」按钮 + 引擎可用性摘要；
- `real-bridge-started.png` —— opencode 会话卡 running + 中栏窗格；
- `real-bridge-approvals.png` —— **审批面板真的有内容**：4 待批（高危 mimikatz 长命令在前，
  含 null 字段占位与退避「重复」）+ 1「最近已决 · 已放行」。

完整证据 `docs/logs/real-bridge-verify.json`（33 断言 + 三张截图路径 + 种入的审批视图 + DOM 探针）。

## 改了哪些文件

```
apps/desktop/src/renderer/approval/model.ts    + decidedApprovals / statusLabel / sameKindLabel
apps/desktop/src/renderer/approval/approval.ts  三栏卡片重写：真实形状 / null 占位 / 已决折叠区 / 退避 / 风险边框
apps/desktop/src/renderer/fanout/model.ts       + agentUsability / agentOptionLabel
apps/desktop/src/renderer/fanout/fanout.ts      可用/未安装摘要 + 成熟度/安装提示 + 默认选可用 agent
apps/desktop/src/renderer/main.ts               左栏引擎可用性摘要
apps/desktop/src/renderer/styles.css            已决/退避/占位/摘要样式
apps/desktop/src/renderer/mock/data.ts          mock 审批换真实形状（4 待批 + 1 已决）
apps/desktop/src/renderer/smoke.ts              45 断言（新增 T8b / 扇出可用性）
apps/desktop/electron/approval-verify.ts        （新）审批面板真实形状渲染验证入口
apps/desktop/electron/real-bridge-verify.ts     （升级）接真实 ApprovalQueue 种入审批 + 三张交接截图
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
# 1) 纯逻辑 smoke（45 断言）
node apps/desktop/src/renderer/smoke.ts
# 2) 审批面板真实形状（mock 传输 + 真实 ApprovalView，18/18）
node_modules\electron\dist\electron.exe apps/desktop/electron/approval-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|ALL_PASS"
# 3) 真实桥 + 种入真实审批 + T12 截图（33/33）
node_modules\electron\dist\electron.exe apps/desktop/electron/real-bridge-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|verify\]|ALL_PASS"
# 4) 回归：mock 路径 render-verify（14/14）与 Lane A 的 gate（30/30）都复跑通过
```

## 没做什么 / 已知问题

1. **真实 agent 端到端触发审批仍没跑通**：种入的审批是直接调 `ApprovalQueue.request()` 产生的
   真实形状，不是某个 opencode 会话在真实运行中发 `session/request_permission` 触发的（那依赖
   模型心情，Lane A 的 T3-T4 doc 里已列为最紧要待验项）。闸门接线正确性由 Lane A 的 30/30
   覆盖，本轮的 UI 端由种入的真实形状覆盖，中间缺的一环是「真实 agent 真的发一次权限请求」。
2. **扇出「一键扇出（三引擎）」仍硬编码 codex/claude/opencode**，不按 installed 过滤——本机这三
   家恰好都装了所以无碍；若换到缺某家的机器，未装的那家 `session.start` 会返回
   `{ok:false, error:"agent 不可用…"}`（无害，只是多一次失败）。要更稳可在预设里按 installed 过滤。
3. **已决区上限**：真实 `queue.list()` 默认回最近 50 条已决，渲染进程照单全收；面板没做
   「折叠到最近 N 条」的二次限制，量大会变长（可滚，不破）。
4. **意图中栏在真实桥里全是「暂无自述意图」**：因为种入时该会话还没有 agent 自述文本
   （`hub.intentSummary` 返回 null）。非 null 意图的渲染由 mock 路径 ap1 覆盖。
5. 交接截图我已由 `file` 确认是合法 PNG（1783×942），但本机 Read 工具无法预览图片，画面内容
   由 evidence JSON 里的 DOM 探针逐字段背书（见 real-bridge-verify.json 的 `approvalsProbe`）。

## 下一手需要什么

- 把「真实 agent 发 `session/request_permission` → 审批面板出现 → 人工放行」这条端到端链跑一遍
  （Lane A 的 T3-T4 doc 给了做法：autonomous 档 + 调试规则包 + 提示 agent 跑 mimikatz）。
- 无待用户决策事项。
