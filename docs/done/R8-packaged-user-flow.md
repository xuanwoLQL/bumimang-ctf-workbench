# 第 18 轮 · 第一次有人开着打包产物走完整用户流程（不是 --verify 自检）

> 完成时间：2026-10-13 08:50 · Lane B（renderer + electron）
> 结论：**打包产物 `dist\win-unpacked\不迷茫.exe` 上的完整真实用户流程 27/27 断言 ALL_PASS** ——
> 「＋ 新任务」→ 填真实标题/简报 → 新任务变当前 → 「＋ 扇出会话」起 claude guarded →
> 简报轮真实流 + 健康度走动 → 审批经 UI 放行 → UI 反映决定 → 产物落盘。全部证据在
> `docs/logs/packaged-flow.{json,png,run.log}`。

## 一句话

此前打包态只验过两件事：Lane A 的 `--verify`（主进程自己 `executeJavaScript` 出来的 11 条自检，没有
真实点击、没有人眼）和 R6 的 CDP 静态探针（只截首屏、只查样式表有没有加载）。**从来没有一个人把
「点『＋ 新任务』→ 填题 → 点『＋ 扇出会话』起 claude → 等简报轮 → 处理审批」这条真实用户路径在
打包产物上走完**。而且打包态的数据落在 `%APPDATA%\bumimang\`（不是仓库，`app.asar` 只读）——
任何路径假设错了，都只有真人驱动打包产物才会现形。本轮把这两件事一次验掉。

## 完整链路（零 mock、零 import src/main、零直发 dispatch）

脚本把打包 exe 拉起来（`--remote-debugging-port`），用 CDP 连上**真实 app.asar 渲染进程**，做真实
DOM 点击（`.click()` 走按钮自己的监听器 → `ctx.hub.dispatch` → 真实 IPC）。**不是** `window.bumimang.dispatch`
直发。每一步截图 + 断言。

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 启动 `dist\win-unpacked\不迷茫.exe`（`--no-sandbox --remote-debugging-port=9333`） | CDP 连上渲染进程；首屏 `window.bumimang` 真实 IPC + 三栏 |
| 2 | 点「＋ 新任务」（`.btn-task-new`）→ 填标题 + 简报 → 点「创建并切换」 | `task.title` 从「示例任务」→「打包态真实用户流程 · 端到端冒烟」，左栏任务卡 DOM 同步 |
| 3 | 点「＋ 扇出会话」（`.btn-plus`）→ 选 claude + lead + guarded → 点「扇出」 | 会话 `s1`（agent=claude role=lead tier=guarded）出现在快照 |
| 4 | 等简报轮 | **312 行真实流**（思考/消息/工具）、toolCalls 0→3、窗格健康指示「同步 N/A」→「同步 2 · tool 2」 |
| 5 | 审批出现 → **点 UI「放行」按钮**（`.ap-card [data-act="approve"]` 的 `.click()`） | `Write packaged-flow.txt`（rule=`tier-guarded-default`）→ `approved`、`decidedBy=human`，审批队列 DOM 渲染「已放行」 |
| 6 | 会话 idle → 终态 | claude 真的产出了 `packaged-flow.txt`，内容 `packaged flow ok` |

简报（会注入每个会话的简报包）用的是真实指令：
`请在当前目录创建一个名为 packaged-flow.txt 的文本文件，内容写一行 packaged flow ok。这是唯一任务，完成后就结束。`
——它让简报轮里 claude 就动手（不是空转等 prompt），从而自然引出「写文件 → 请求授权 → 审批」这一整条链。

## 本轮「为什么重要」的两点，都验到了

1. **打包态路径假设是对的**。三个落盘证据都在 `%APPDATA%\bumimang\` 下（**不是**仓库，`app.asar` 只读）：
   - `C:\Users\Administrator\AppData\Roaming\bumimang\workspace\board.db`（主库）
   - `…\workspace\sessions\s1\wire.jsonl`（真实 claude 线日志：`session/update`、token 计数、`session_info_update` 标题「packaged-flow.txt 冒烟测试」）
   - `…\workspace\sessions\s1\packaged-flow.txt`（简报轮真实产出，内容 `packaged flow ok`）
2. **「＋ 新任务」流在 dev 之外第一次被确认能跑**。此前 R-3 只在 dev 态（`.ui-run`）验过；打包态 `task.create`
   走真实 IPC → 主进程 `setTask` → `task.upsert` 回流 → 左栏重绘，与 dev 行为一致。

附带确认：claude 适配器在打包态正常拉起（wire.jsonl 显示会话真实跑在 `deepseek-v4-pro[1m]` 上，说明
`claude-agent-acp` 经打包 exe 也能 spawn + initialize + newSession + prompt）。

## 证据

| 文件 | 是什么 |
| --- | --- |
| `docs/logs/packaged-flow.json` | 27 条断言 + 时间线 + 审批留痕 + 健康度起点/终点 + 路径断言 |
| `docs/logs/packaged-flow-1-initial.png` | 打包态首屏（真实后端空态） |
| `docs/logs/packaged-flow-2-task-created.png` | 新任务已变当前 |
| `docs/logs/packaged-flow-3-fanout.png` | 扇出弹窗已选 claude/lead/guarded |
| `docs/logs/packaged-flow-4-session-started.png` | claude 会话窗格已出现 |
| `docs/logs/packaged-flow-5-approval-decided.png` | 审批已 UI 决定（「已放行」） |
| `docs/logs/packaged-flow-6-final.png` | 终态（idle + 流 + 已决审批同屏） |
| `docs/logs/packaged-flow-run.log` | 打包 exe 的 stdout/stderr（管道捕获，非 `>` 重定向） |

六张截图全部为 1783×942 合法 PNG（已逐张解码校验非空白：distinct 颜色 273–497、max 亮度 255）。
流程结束后无残留进程（`Get-Process 不迷茫` 为空）。

## 怎么复跑

```powershell
cd D:\agent\xuanwo
# 先清残留（脚本自己也会清，但保险起见）：
Get-Process electron,'不迷茫' -ErrorAction SilentlyContinue | Stop-Process -Force
# 一条命令跑完整流程（脚本自己拉起打包 exe、自己按 PID 清理）：
node apps/desktop/electron/packaged-flow.mjs 9333
```

脚本是**可重跑**的（不是手工点鼠标）：`apps/desktop/electron/packaged-flow.mjs` 用 CDP 驱动真实 DOM
点击，每一步都有断言 + 截图，最后写 `docs/logs/packaged-flow.json` 并 `process.exit(pass?0:1)`。硬超时
480s 兜底，任何情况下不挂死。

## 改了哪些文件

```
apps/desktop/electron/packaged-flow.mjs   新：打包态真实用户流程驱动 + 断言（CDP，零 mock）
docs/logs/packaged-flow-{1..6}-*.png      新：六步截图
docs/logs/packaged-flow.json              新：27 条断言证据
docs/logs/packaged-flow-run.log           新：打包 exe 运行日志
```

没动 `apps/desktop/src/renderer`、没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约 `events.ts`。
没有种审批、没有 fake agent——那条 `request_permission` 是 claude 对 `Write packaged-flow.txt` 真实发来的。

## 没做什么 / 边界

1. **只走了「放行」路径**。拒绝 → 退避 → blocked 的 UI 链已在上轮（R7）验过并修好（L-4），本轮不重复；
   脚本里审批处理是「有 pending 就 UI 放行」的通用循环，改成 `[data-act="deny"]` 即可复用于拒绝路径。
2. **只跑了一个会话**（claude guarded）。多会话真并行（R10）与三引擎扇出不在本轮范围。
3. **没在干净机器/虚拟机上验**（本机有 electron 缓存 + 全局装的适配器）。「安装→启动→起会话」的首次体验
   缺口仍在（HANDOVER §5 第 3 条），但「打包产物上走真实流程」这一环已闭合。
4. 打包 exe 用 `--no-sandbox --remote-debugging-port` 启动是为了可观测（CDP），与真实双击启动唯一差别是
   多了调试端口；数据路径、渲染、IPC 与双击一致。
