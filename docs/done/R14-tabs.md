# R14 中栏浏览器式标签页

> 完成时间：2026-10-13 12:21 · Lane B（renderer + electron）
> 结论：中栏从「多窗格并排」改成「浏览器标签页」——顶部标签栏（每会话一个标签 + 末尾「+」），
> 下方只有一个可见窗格占满剩余高度；切换标签不丢任何会话已渲染的对话流。验收 **28/28 ALL_PASS**，
> 截图 `docs/logs/tabs.png`，八个既有套件全绿。

## 做了什么

用户圈住中栏（原来两个会话窗格并排、每个只分到 ~300px、文本折行难看）要求改成浏览器标签页。
落地方案：

- **中栏结构**：`createPanes` 内部拆成「标签栏 `.pane-tabs`（顶部）+ 窗格舞台 `.pane-stage`（下方）」，
  `.col-center` 从 grid 改成纵向 flex；激活窗格 `flex:1` 占满标签栏以下的全部高度（实测 698px，
  旧的并排上限是 320px）。
- **标签内容**：每会话一个标签 = `agent · role`（如 `opencode · lead`）+ 一个小状态点
  （`sessionStatusLabel` + 现有 `.status-*` 语义色，dot 用 `currentColor` 上色）+ 关闭「×」。
  blocked 仍读「被策略切断」且红点 `rgb(218,54,51)`，与 failed「崩溃」不混同。
- **切换与保历史**：**所有窗格都留在 DOM 里**（`.pane-hidden` 只 `display:none` 不销毁），
  点标签只切换可见性，不重建窗格、不动 `SessionStreamSink` 的累计块与滚动位置——所以切走再切回
  还是同一段对话。新会话出现时像浏览器开新标签页一样自动切过去（首屏首次加载除外，默认选第一个）。
- **末尾「+」**：复用现有扇出入口 `openFanoutModal`（agent + 角色 + 档位选择器与左栏一致）。
- **关闭「×」**：派发契约 `session.stop`。契约里没有 `session.remove`，所以停止后标签仍在、
  状态点变「已停止」（见「没做什么」）。
- 会话窗格本体（对话流 / 计分卡 / 安静提示 / 健康指标）与右栏审批 / 台账**一行没动**，
  只是中栏的排列方式变了。

## 改了哪些文件

```
apps/desktop/src/renderer/panes/panes.ts     中栏改标签页：标签栏 + 舞台 + 选择/可见性/「+」/「×」
apps/desktop/src/renderer/styles.css         .col-center 改纵向 flex；.pane 去 max-height、flex:1；
                                             新增 .pane-tabs/.pane-tab/.pane-tab-status/.pane-tab-close/
                                             .pane-tab-add/.pane-stage/.pane-hidden 样式
apps/desktop/electron/tabs-verify.ts         新增：28 条标签页断言 + 截图 tabs.png
apps/desktop/electron/real-parallel-verify.ts 诚实改写一条断言：原「三窗格并排（left 递增）」→
                                             「3 标签 + 1 可见窗格占满舞台」（该套件需 3 个真 claude，
                                             本轮未跑，见「没做什么」）
docs/logs/tabs.png + tabs.jpg                证据截图（1783×942，3 个会话，标签栏可见）
docs/logs/tabs-verify.json                   证据 JSON
```

没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约 `packages/shared-protocol/events.ts`。

## 怎么验证的

```powershell
cd D:\agent\xuanwo

# 1) 纯逻辑冒烟
node apps/desktop/src/renderer/smoke.ts          # → ALL PASS

# 2) 新增：标签页专项验收（28/28）
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/tabs-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|ALL_PASS|shot"

# 3) 八个既有套件回归（全 ALL_PASS）
node_modules\electron\dist\electron.exe apps/desktop/electron/render-verify.ts          --no-sandbox   # ALL_PASS
node_modules\electron\dist\electron.exe apps/desktop/electron/push-verify.ts            --no-sandbox   # ALL_PASS
node_modules\electron\dist\electron.exe apps/desktop/electron/r1-verify.ts              --no-sandbox   # ALL_PASS
node_modules\electron\dist\electron.exe apps/desktop/electron/gate-empty-verify.ts      --no-sandbox   # ALL_PASS
node_modules\electron\dist\electron.exe apps/desktop/electron/blocked-hostile-verify.ts --no-sandbox   # ALL_PASS
node_modules\electron\dist\electron.exe apps/desktop/electron/cold-start-verify.ts      --no-sandbox   # ALL_PASS
node_modules\electron\dist\electron.exe apps/desktop/electron/scorecard-verify.ts       --no-sandbox   # ALL_PASS
```

真实输出（tabs-verify 关键几条，完整 28 条见 `docs/logs/tabs-verify.json`）：

```
PASS  3 个会话恰好 3 个标签  — tabs=3 sessions=["s1","s2","s3"]
PASS  同一时刻只有一个可见窗格  — active=1 hidden=2
PASS  激活窗格占满标签栏下方的舞台高度  — paneH=698 stageH=698（旧版并排上限 320px）
PASS  blocked 标签状态点读「被策略切断」  — {"text":"被策略切断","cls":"pane-tab-status status-blocked","color":"rgb(218, 54, 51)"}
PASS  点击后可见窗格切到 s2  — pane=s2 tab=s2
PASS  切回 s1 后仍是同一段对话（标记还在）  — pane=s1 text="TABS-MARKER-42 端口已探明"
PASS  切回后 s1 块数没变（未重建、未丢历史）  — blocks before=2 after=2
PASS  点标签栏「+」打开扇出弹窗（复用 agent + 角色 + 档位）
PASS  渲染进程无未捕获异常（console error 为空）
ALL_PASS
```

截图 `docs/logs/tabs.png`（1783×942，PNG 签名有效、非空白），3 个会话下标签栏 + 激活窗格的
对话流都可见。

## 没做什么 / 已知问题

1. **关闭「×」是 `session.stop`，不是移除标签**。冻结契约只有 `session.stop`、没有
   `session.remove`，所以点「×」后会话停止、标签仍在（状态点变「已停止」），不会像浏览器
   那样把标签从列表里删掉。这是契约约束下的诚实行为，要真正「关掉就消失」得给契约加
   `session.remove`（走 `docs/requests/`，本轮按约束未加）。
2. **`real-parallel-verify.ts` 本轮没跑**。它要起 3 个真实 claude 会话（烧 token、数分钟），
   不在本轮要求的套件清单里。但它里面有一条我（Lane B）自己写的「三窗格并排 left 递增」断言
   已经被这次布局变更作废——我已把它**诚实改写**成「3 标签 + 1 可见窗格占满舞台」，并把文件
   头注释同步成新布局。下次真跑它时直接就是对的；本轮未实跑，只能说「改对了、没实跑」。
3. **旧截图 `docs/logs/real-parallel.png` 仍是并排布局**，与现在的中栏不符，但没有再重拍
   （重拍需要 3 个真 claude）。它作为 R10 的历史证据保留，不代表当前画面。
4. R13 遗留的「`other` 类事件被连渲」（`available_commands_updateavailable_commands_update…`）
   本轮没碰——那是对话流内部的小瑕疵，与本轮的布局改造无关。

## 下一手需要什么

- 若要让「×」真的从列表移除会话：需要 Lane A 在契约加 `session.remove` 动作（冻结契约要改，
  得走 `docs/requests/` + 你点头）。
- `real-parallel-verify.ts` 的标签页版断言已就位，等下次要出「多会话真并行」新截图时直接跑即可。
- 打包产物 `dist/` 仍是 09:40 的，不含本轮改动；要发货得 `npm run pack` 重打（是否现在打看你）。
