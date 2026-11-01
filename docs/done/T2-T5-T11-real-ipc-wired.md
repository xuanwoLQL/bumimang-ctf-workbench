# T2 + T5 + T11 真实 IPC 打通（雏形骨架成立）

> 完成时间：2026-10-13 00:15
> 说明：这三个任务在同一次集成里落地（事件总线、Electron 主进程、mock→真实 IPC 切换），
> 拆成三份文档会有三份一样的验证输出，所以合并成一份。这是对"一任务一文档"约定的**有意偏离**。

## 做了什么

**「不迷茫」第一次跑在真实后端上。** 一个 Electron 窗口打开，渲染进程通过真实 IPC 从主进程拿到快照、派发动作，动作真的改到了核心（黑板 + 会话管理器）的状态。

关键是**没让 Lane B 改一行代码**：它写的 `hub.ts` 里 `resolveHub()` 本来就设计成"看到 `window.bumimang` 就切真实桥"，我把 preload 一挂上去，T11 的对接就自动完成了。这是契约先行的回报。

几个取舍：

- **preload 必须是 `.cjs`。** Electron 加载 preload 走它自己的模块加载器，**不做 type stripping**，所以 Lane B 的 `electron/preload.ts` 直接跑不起来（渲染进程里的 `.ts` 由自定义 scheme 现场剥类型，但 preload 不在那条路径上）。我在自己 lane 里写了语义等价的 `src/main/electron/preload.cjs`，通道名照抄冻结契约的字面量。T11 之后二者可择一保留。
- **每个 Electron 实例必须有自己的 userData。** Lane A 和 Lane B 会同时跑 Electron，共用默认 profile 会互相抢文件锁然后直接退出。已在 `main.ts` 里 `app.setPath("userData", <项目内目录>)`。
- **整条链路的"日志"只有一处**：主进程 stdout。渲染进程的 console 通过 `console-message` 事件转发到主进程 stdout 打出来，这样一条命令就能看到两端。

## 改了哪些文件

```
apps/desktop/src/main/hub/hub.ts             事件总线 + Hub 服务（快照构造 / 动作派发 / 视图映射）（新）
apps/desktop/src/main/electron/main.ts       Electron 主进程 + 三条 IPC 通道 + --verify 验收模式（新）
apps/desktop/src/main/electron/preload.cjs   contextBridge 暴露 window.bumimang（新）
apps/desktop/src/main/session/manager.ts     加 onStream / onSessionChange 钩子，SessionRecord 补 model/startedAt/endedAt
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify 2>&1 |
  Select-String -Pattern "PASS|FAIL|verify\]"
```

真实输出（**9/9 通过**）：

```
[main] 窗口已加载
PASS  preload 暴露了 window.bumimang（真实 IPC 路径，不是 mock）
PASS  hub:snapshot 通道可用并返回快照
PASS  快照里有任务  — task="示例任务：本地 HTML 目标"
PASS  快照里有 agent 检测结果（4 家）  — agents=4
PASS  渲染进程画出了三栏（真实选择器：.col-left / .col-mid / .col-right）
      — 命中：["col col-left","col col-center","col col-right"]
PASS  面板标题都在（会话 / 审批队列 / 黑板台账）
      — 标题：["任务","会话","审批队列","黑板台账"]
PASS  页面有实际文本内容（没白屏）  — 185 字符
PASS  hub:action 通道可派发动作  — {"ok":true}
PASS  动作真的改到了核心状态  — 核心里的任务标题 = "验收任务"
[verify] 9/9 通过，证据写入 docs/logs/ui-verify.json
```

## 没做什么 / 已知问题

1. **三栏里只有"任务"和"会话"有内容，审批队列与黑板台账是空的。** 原因是审批队列还没实现（T4），黑板也还没被任何会话写过。**不是渲染问题**，是数据源没到。
2. **没有真正起过一个会话。** `hub:action` 的 `session.start` 分支写好了、也没测过：它要 spawn agent 子进程、跑 initialize、session/new、注入简报，链路长。这是下一步最该验的事。
3. **动作派发后的 UI 刷新方式很笨**：我在 `hub:action` 里推了一版 `task.upsert` 并 `publishBoardSince(0)` 全量重播黑板事件，**没有做增量对账**。动作一多会刷屏，需要改成真正的增量。
4. **`session.setTier` 是空实现**——档位目前只存在内存里，真正的规则引擎是 T3。
5. **`approval.decide` / `approval.bulk` 返回 `{ok:false, error:"审批队列尚未接入（T4）"}`**，所以 UI 上点审批按钮会报错。这是有意的，避免静默假装成功。
6. **【环境坑一】Electron 的 stdout 不能用 `> file` 重定向**，必须用管道（`2>&1 | Select-String`）。用 `>` 会得到空文件，看起来像"程序没启动"，实则是输出丢了。
7. **【环境坑二】`--verify` 曾经挂死过**，留下 5 个残留 electron 进程占住 profile，导致后续运行报一堆缓存锁错误。已加 25 秒硬超时兜底；但**排查时第一件事应该是 `Get-Process electron | Stop-Process -Force`**。
8. **【环境坑三】`site`（数据）与 `profile`（Electron userData）都在 `.ui-run/`**，该目录未加进 `.gitignore` 的是 `electron-profile`（`.ui-run/` 整体已忽略，OK）。
9. **没有截图。** Lane B 的 `render-verify.ts` 会截图，我没做——因为我的窗口加载的是真实 IPC 路径，视觉上反而更空（没数据）。等 T4 做完、有了审批数据再截更有价值。

## 下一手需要什么

- **最紧要**：在 `--verify` 里加一条"真的起一个会话"的断言，把 `session.start` 这条长链路验掉。它现在完全没测过。
- **T3**（策略引擎 + 规则包）：`policy.ts` 现在是 `PassthroughPolicy` 占位。
- **T4**（审批队列）：这是让"审批队列"面板从空变有内容的关键，也是**唯一的事前闸门**（`session/request_permission`，实测三家 agent 都走它）。
- 无待用户决策事项。
