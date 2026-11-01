# R12 · 打包产物上的首次启动引导 —— 补 R10 的「干净机真装真验」

> 完成时间：2026-10-13 10:09 · Lane B（renderer + electron）
> 结论：**首次启动引导在真实打包产物上确认首屏可见、内容与真实快照一致、dismiss 后
> reload 与跨进程重启都不再出现；33/33 ALL_PASS**。R10 的 loose end 收掉。

## 背景

R10 新增了 first-run guide（`renderer/first-run.ts` 的 dismissible 浮层），但当时只对
DEV electron（`node_modules\electron\dist\electron.exe` + 现场剥 TS 的 src/main）+ **受控合成快照**
跑过 `first-run-verify.ts`，R10 doc 也白纸黑字写着「没在干净机器上真装真验」。本轮在
**真实 app.asar 打包产物**（`dist\win-unpacked\不迷茫.exe`）上，用 FRESH userData 把这条链补验掉。

## 隔离怎么做（本轮的关键结论，可复用的坑）

打包态 userData 默认是 `%APPDATA%\bumimang`，而 `apps/desktop/src/main/electron/main.ts`
里还会 `app.setPath("userData", path.join(WORKSPACE, "electron-profile"))`，其中 `WORKSPACE`
派生自 `app.getPath("userData")`。R11 的 `packaged-ui-deny.mjs` 已经用真实 userData 点过
「知道了」，所以真实 `%APPDATA%\bumimang\workspace\electron-profile\Local Storage` 里
**已经有** `bumimang.firstRunDismissed.v1=1`（本脚本启动前先 grep leveldb 确认过）——
不隔离就看不到「首屏引导」。

实测两种隔离手段：

| 手段 | 结果 | 证据 |
| --- | --- | --- |
| 改 `APPDATA` 环境变量 | **无效** | redirect 后 fresh 目录 7s 全空；真实目录的 `DevToolsActivePort` 反而被更新。原因：Electron/Chromium 走 `SHGetFolderPath(CSIDL_APPDATA)` 读注册表，不读环境变量。 |
| `--user-data-dir=<dir>` | **有效** | Electron 的 `GetUserDataPath()` 优先读这个 switch → `WORKSPACE=dir\workspace`、final userData=`dir\workspace\electron-profile`（probe 确认 `Local Storage` 落在那里）。 |

所以本脚本用 `--user-data-dir` 指向仓库内 `.ui-run\packaged-first-run-userdata\`，
全程不碰真实 `%APPDATA%\bumimang`（那是 R11 等轮次的证据）。localStorage 的 leveldb
最终落在 `.ui-run\packaged-first-run-userdata\workspace\electron-profile\Local Storage\leveldb\`。

## 做了什么 / 验收

新增 `apps/desktop/electron/packaged-first-run.mjs`（零 mock、零 import src/main），
CDP 连打包 exe（`--no-sandbox --remote-debugging-port`），**33/33 ALL_PASS**：

1. **静态核验 app.asar 6 条**：标题「开始之前」、dismissal 键 `bumimang.firstRunDismissed.v1`、
   「会产生审批」段、「写文件会请求放行（3/3）」、`%APPDATA%\bumimang`、「＋ 新任务」全部入包。
2. **首屏可见**：fresh userData 下浮层出现、只一块、标题「开始之前」、`data-storage-key`
   就是 localStorage 键、首启时该键为空（fresh 生效）。
3. **内容与真实快照一致**（不硬编码哪家会问）：
   - 产生审批一行 = 快照里 `installed && requests_by_default` 的每家 agent
     （真实 detect 结果：OpenCode、Codex、Claude Code），且不含非 producing agent；
   - 不会产生审批一行点名 DeepSeek Harness 并标「未安装」；
   - 实测打断事实：写文件 3/3 会问 / echo 3/3 不问 / 读源码·命名管道·grep 会问，
     且 hedge 明确「样本量小 / 边界尚未完全摸清」；
   - 数据路径：`%APPDATA%\bumimang\（workspace + evidence）` + 开发态 `.ui-run\`；
   - 一行怎么开始：＋ 新任务 → 简报 → agent + guarded。
4. **dismiss**：真实 DOM 点「知道了」→ 浮层消失、`localStorage=1`。
5. **记住 dismissal（两层）**：
   - reload（同进程）后不 nag；
   - **跨进程**：优雅关闭（`window.close()` → exit 0，localStorage 落盘）→ 重新拉起同一
     userData → 首屏 snapshot 落地后浮层**不再出现**、localStorage 仍为 `1`。
6. **磁盘级证据**：优雅退出后 fresh userData 的 `Local Storage\leveldb\000003.log` 里
   确含 `_bumimang://.` + `bumimang.firstRunDismissed.v1` + 值 `1`（证明 localStorage 确实
   落在 userData 下）。
7. 渲染进程无 console error / 无崩溃痕迹。

截图三张（1783×942，有效 PNG 签名）：
`docs/logs/packaged-first-run-visible.png`（浮层可见）、
`docs/logs/packaged-first-run-dismissed.png`（dismiss 后）、
`docs/logs/packaged-first-run-reopened.png`（跨进程重启后）。
证据 `docs/logs/packaged-first-run.json`、打包进程 stdout/stderr `docs/logs/packaged-first-run-run.log`。

## 改了哪些文件

```
apps/desktop/electron/packaged-first-run.mjs  新增：33/33 验收 + 三张截图
docs/logs/packaged-first-run.{json,run.log}   证据
docs/logs/packaged-first-run-{visible,dismissed,reopened}.{png,jpg}  截图
```

没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约 `packages/shared-protocol/events.ts`、
没碰真实 `%APPDATA%\bumimang`。

## 怎么复跑

```powershell
cd D:\agent\xuanwo
Get-Process electron,'不迷茫' -ErrorAction SilentlyContinue | Stop-Process -Force
node apps/desktop/electron/packaged-first-run.mjs 9440 2>&1 | Tee-Object .ui-run/packaged-first-run.stdout.log
```

## 边界 / 没做什么

- 没在「另一台真正没装过的干净机器」上跑（本机 + 隔离 userData 等价，但不等于全新 OS）；
- 没改任何源码——R10 的浮层本体一行没动，本轮只补「打包态确实随包出现」的证据；
- 没碰规则包运行时切换、成本统计等 HANDOVER §5 其余缺口（非本轮范围）。
