# R14 中栏标签页 —— 由 Lane A 独立复跑验收

> 完成时间：2026-10-13 12:32 · **本文档是 Lane A 写的验收记录，不是 Lane B 的完成文档**（那份是 `docs/done/R14-tabs.md`）。

## 做了什么

用户把中栏圈出来，要求「像浏览器的标签页一样点击可以看」。Lane B（第 24 轮）把中栏从
「多窗格并排」改成了标签页。我不替它背书，自己把它的代码**重跑了一遍**，并顺手把
`dist/` 重打包，让打包产物也带上这次改动（09:40 那版不含 R13/R14）。

复跑结论：**改动是真的、断言是真的过了、打包产物里确实有它。**

## 改了哪些文件

本轮（验收）我**没有改任何源码**，只做了四件事：

1. 复跑 Lane B 的 `tabs-verify.ts` 与七个既有回归套件；
2. 复跑我自己的 `npm run verify:all`（100 条）；
3. `npm run pack` 重打包 → `dist\不迷茫 Setup 0.1.0.exe`（12:32）、绿色包、`dist\win-unpacked`；
4. 静态核查 `app.asar` 里确实含标签页样式与亮色主题变量。

> 注意：`npm run pack` 会覆盖 `dist\`。这次覆盖是有意的——旧产物是 09:40 的，不含亮色主题与标签页。

## 怎么验证的

```powershell
cd D:\agent\xuanwo

# 0) 先清掉上一轮 verify 留下的 electron 进程（不清会 EPERM，见「没做什么」第 2 条）
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force

# 1) 纯逻辑冒烟
node apps\desktop\src\renderer\smoke.ts                      # → ALL PASS

# 2) 标签页专项（R14 的核心断言，28 条）
node_modules\electron\dist\electron.exe apps\desktop\electron\tabs-verify.ts --no-sandbox 2>&1 |
  Out-File -Encoding UTF8 docs\logs\_r14-tabs-verify.log     # → 56 行 PASS / 0 FAIL / ALL_PASS

# 3) 七个既有套件回归（改布局最容易弄坏的就是它们）
foreach ($s in 'render-verify','push-verify','r1-verify','gate-empty-verify',
               'blocked-hostile-verify','cold-start-verify','scorecard-verify') {
  node_modules\electron\dist\electron.exe "apps\desktop\electron\$s.ts" --no-sandbox 2>&1 |
    Out-File -Encoding UTF8 "docs\logs\_r14-regress-$s.log"
}

# 4) 我自己的主进程套件
npm run verify:all                                           # → 49/49 + 16/16 + 17/17 + 18/18

# 5) 重打包
npm run pack                                                 # → exit=0
```

真实输出（本轮实跑，日志留在 `docs/logs/_r14-*.log`）：

```
# tabs-verify（28 条断言，输出里每条打两遍——一遍即时、一遍汇总）
PASS  3 个会话恰好 3 个标签                          └─ tabs=3 sessions=["s1","s2","s3"]
PASS  每个标签都有一个关闭「×」                      └─ close=3
PASS  标签栏末尾有「+」
PASS  同一时刻只有一个可见窗格                       └─ active=1 hidden=2
PASS  激活窗格占满标签栏下方的舞台高度                └─ paneH=698 stageH=698（旧版并排上限 320px）
PASS  blocked 标签状态点读「被策略切断」              └─ color=rgb(218, 54, 51)
PASS  点击后可见窗格切到 s2                          └─ pane=s2 tab=s2
PASS  切回 s1 后仍是同一段对话（标记还在）            └─ text="TABS-MARKER-42 端口已探明"
PASS  切回后 s1 块数没变（未重建、未丢历史）          └─ blocks before=2 after=2
PASS  点标签栏「+」打开扇出弹窗
ALL_PASS

# 回归（每个 FILE 的 PASS/FAIL 计数）
render-verify            PASS 14   FAIL 0   ALL_PASS
push-verify              PASS 16   FAIL 0   ALL_PASS
r1-verify                PASS 26   FAIL 0   ALL_PASS
gate-empty-verify        PASS 17   FAIL 0   ALL_PASS
blocked-hostile-verify   PASS 27   FAIL 0   ALL_PASS
cold-start-verify        PASS 29   FAIL 0   ALL_PASS
scorecard-verify         PASS 15   FAIL 0   ALL_PASS

# verify:all
================ 49/49 通过 ================
========== 16/16 通过 ==========
========== 17/17 通过 ==========
========== 18/18 通过 ==========
FAIL count: 0

# 打包产物静态核查（app.asar 文本里找新增类名与主题变量）
FOUND    pane-tabs / pane-tab-status / pane-tab-close / pane-tab-add / pane-stage / pane-hidden
FOUND    --bg: #f6f8fa        （亮色主题变量已进产物）
exit=0                        （npm run pack）
```

截图 `docs/logs/tabs.png`（1783×942，本轮 12:32 重拍）：中栏顶部一条标签栏
`opencode lead ● 运行中 ×` / `codex verify ● 运行中 ×` / `opencode recon ● 被策略切断 ×` / `+`，
下方只有一个窗格占满整个中栏高度。

## 没做什么 / 已知问题

1. **点「×」不是关掉标签，是 `session.stop`**。冻结契约里没有 `session.remove`，所以关掉后
   标签还在、状态点变「已停止」。要真像浏览器那样删标签，得给契约加动作（走 `docs/requests/`，
   需要你点头）。
2. **踩到一个新的坑（值得记进 EXECUTION-PLAN §6）**：`r1-verify` 与 `cold-start-verify`
   第一次跑直接 `EPERM` 死在 bootstrap —— 上一轮 verify 的 electron 进程没退干净，占着
   `.ui-run\verify-r1` / `.ui-run\cold-start` 目录，脚本开头 `rmSync` 删不掉。**跑任何 verify
   之前先 `Get-Process electron | Stop-Process -Force`**，否则报错信息看起来像"套件坏了"，
   其实是残留进程。清掉后两个套件立刻 26/26、29/29。
3. **`real-parallel-verify.ts` 本轮仍未实跑**。它要起 3 个真 claude（烧 token、数分钟）。
   它里面那条「三窗格并排 left 递增」的旧断言已被 Lane B 诚实改写成「3 标签 + 1 可见窗格」，
   但改写后**没人实跑过**——所以「三会话真并行 + 标签页」这个组合目前只有合成会话的证据。
4. **标签页的验收用的是真实桥 + 注入的合成会话**，不是真 agent 跑出来的会话。切换、
   保历史、blocked 配色这些是 DOM 层事实，agent 侧不参与，所以这个边界不影响本轮结论；
   但"真 agent 长跑时标签切换是否顺滑"没测过。
5. **`docs/logs/real-parallel.png`（R10 的历史截图）仍是并排布局**，与现在的界面不符。
   它是历史证据、不代表当前画面，但放在一起容易被误读。

## 下一手需要什么

- 想看到新界面：直接跑 `dist\win-unpacked\不迷茫.exe`（已含本次改动），或 dev 模式重启
  （`dist` 之外**没有** watcher，改完源码必须重启才生效）。
- **待你拍板一件事**：点「×」要不要真的把标签删掉？要的话我需要给冻结契约加
  `session.remove`，这是唯一需要动契约的改动。
- 想验「三会话真并行 + 标签页」的完整画面：跑
  `node_modules\electron\dist\electron.exe apps\desktop\electron\real-parallel-verify.ts --no-sandbox`
  （要 3 个真 claude，数分钟、烧 token，是否跑看你）。
