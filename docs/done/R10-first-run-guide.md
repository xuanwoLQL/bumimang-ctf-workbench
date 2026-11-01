# R10 · 首次启动引导（first-run guide）—— 补上 HANDOVER §5 第 7 条

> 完成时间：2026-10-13 09:29 · Lane B（renderer + electron）
> 结论：**首次启动引导完成，19/19 ALL_PASS**；回归 render-verify 14/14、cold-start-verify 29/29、
> gate-empty-verify 17/17、r1-verify 26/26 全绿，smoke ALL PASS。

## 背景

HANDOVER §5 第 7 条从开局就列着「首次启动引导没做」：agent 检测有「灰显 + 安装提示」，但一个
新用户没有一个地方一次性回答「开始之前该知道什么」。本轮补一块**克制的** dismissible 浮层
（不是 wizard，只是四段话），并在 dismissal 后记住，不 nag。

## 做了什么

新增 `apps/desktop/src/renderer/first-run.ts`（纯内容 + DOM 浮层），浮层在右上角（`position:fixed`，
不挡三栏交互），标题「开始之前」，四段：

1. **哪些引擎可用、哪些会产生审批** —— 数据源 `snapshot.agents[].permissionBehavior`，
   不硬编码哪家会问（与 R-4 同源）。实测真实 detect 结果渲染为：
   `会产生审批：OpenCode、Codex、Claude Code —— 已安装，应用运行它们时会请求授权，审批队列会有输入。`
   和 `不会产生审批：DeepSeek Harness（未安装）。`
2. **什么会打断你（实测，样本小）** —— 只讲**实测**过的事实：
   `写文件会请求放行（3/3）；无害命令（如 echo）不请求（3/3）；读源码、枚举命名管道、grep 会请求。`
   并明确 `样本量小（各 3 次），边界尚未完全摸清，别当铁律`（不过度断言）。
3. **数据存在哪** —— `打包后：%APPDATA%\bumimang\（workspace + evidence）。` / `开发态：<仓库>\.ui-run\。`
4. **怎么开始（一行）** —— `点「＋ 新任务」填简报（会注入每个会话）→ 选 agent + guarded → 开始。`

dismiss 走「×」或「知道了」，**记住 dismissal 只借渲染进程自己的 `localStorage`**（键
`bumimang.firstRunDismissed.v1`），**不加契约字段、不碰主进程**。访问 localStorage 全程 try/catch
兜底（非标准源 / 隐私模式抛 SecurityError 时只是下次重显，绝不让引导把应用搞崩）。

接线：`main.ts` 在首屏快照 `store.set(applySnapshot(snap))` 之后调 `showFirstRunGuide(ctx)`；
styles.css 补 `.first-run-*` 一套样式（producing 绿 / nonproducing 灰 / hedge 黄）。

## 验收

新增 `apps/desktop/electron/first-run-verify.ts`（受控合成快照走真实 preload/ipcRenderer 通道，
同 gate-empty-verify 的做法），**19/19 ALL_PASS**：

- 首启（未 dismiss）浮层出现、只出现一块、标题「开始之前」；
- 产生审批一行点名三家、不含 DeepSeek Harness；不会产生审批一行点名 DeepSeek Harness 且标注未安装；
- 打断段四样实测事实齐全 + hedge 明确「样本 / 边界」；
- 数据段 `%APPDATA%\bumimang\` + `.ui-run`；开始段「新任务 / 简报 / guarded」；
- 持久化键是渲染层本地 localStorage 键（非契约字段）、首次未 dismiss 时该键为空；
- 点「知道了」→ 浮层从 DOM 消失 + `localStorage=1`；
- **重新加载后 dismissal 仍在、浮层不再出现（不 nag）**；
- 无 render-process-gone、无 console error。

截图 `docs/logs/first-run-guide.png`（1783×942）、证据 `docs/logs/first-run-guide.json`。

## 改了哪些文件

```
apps/desktop/src/renderer/first-run.ts   新增：纯内容 + dismissible 浮层 + localStorage 持久化
apps/desktop/src/renderer/main.ts        首屏快照后调 showFirstRunGuide(ctx)
apps/desktop/src/renderer/styles.css     补 .first-run-* 样式
apps/desktop/src/renderer/smoke.ts       新增 R10 引导纯逻辑断言段（ALL PASS）
apps/desktop/electron/first-run-verify.ts 新增：19/19 验收 + 截图
docs/logs/first-run-guide.{png,jpg,json,run.log} 证据
```

没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约 `packages/shared-protocol/events.ts`。
持久化没有走契约 / 主进程，纯渲染层 localStorage。

## 怎么复跑

```powershell
cd D:\agent\xuanwo
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node apps/desktop/src/renderer/smoke.ts
node_modules\electron\dist\electron.exe apps/desktop/electron/first-run-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|ALL_PASS|shot"
```

## 边界 / 没做什么

- 没做 wizard / 多步引导（任务要求「克制，不要 wizard」）；
- 没在干净机器上真装真验（仍是本机 dev 态 + 受控快照）；
- 没碰规则包运行时切换、成本统计等 HANDOVER §5 其余缺口（非本轮范围）。
