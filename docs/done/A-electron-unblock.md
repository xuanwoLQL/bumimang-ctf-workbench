# A-1 解除 Lane B 的 Electron 阻塞（含两个环境坑）

> 完成时间：2026-10-12 23:50

## 做了什么

Lane B 跑完 T6–T10 后在 `BLOCKED.md` 提了两个阻塞：Electron 没装（依赖属共享只读，它不能自己加）、以及 Electron 内嵌 Node 版本若低于 22.18 会让它的 type-stripping 方案失效。两个都由 Lane A 处理掉了。

三个关键取舍：

- **Electron 二进制必须走镜像。** `npm install electron` 只装包、不下二进制；首次真正运行才去 GitHub Releases 拉，本机直连不通（`TypeError: fetch failed`）。改用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后成功。**这条对 C8 很关键，队友机器同样会踩。**
- **弃用独立看门狗。** 原本写了个 PowerShell 看门狗在 Claude 退出后自动重启，实测重启全部失败（每次只活 6 秒、退出码为空）。根因是把多行 prompt 当参数传给了 `.cmd`。改成让**心跳同时驱动两条 lane**——少一个活动部件，且两条 lane 的存活逻辑统一在一处。
- **不再等 `terminal/create`。** 委托探针证明三家 agent 都不委托命令执行，所以 T3/T4 的设计重心从"拦命令"改成"拦 `session/request_permission`"。

## 改了哪些文件

```
package.json                                  devDependencies 加 electron 44.7.0
docs/logs/lane-b-watchdog.ps1                 改 launch 方式（最终弃用）
docs/logs/lane-b-round2-prompt.txt            Lane B 第 2 轮 prompt（ASCII）
docs/logs/lane-b-round2.cmd                   第 2 轮启动器
docs/logs/electron-node-check.cjs             Electron 内嵌 Node 版本探针
docs/BLOCKED.md                               追加解决记录 + 协作事故说明
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node_modules\electron\dist\electron.exe docs\logs\electron-node-check.cjs
```

真实输出：

```
electron = 44.7.0
embedded node = 24.21.0
type stripping (node>=22.18) = true
module.stripTypeScriptTypes 可用 = true
```

拉二进制（GitHub 直连失败后改用镜像）：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node node_modules\electron\install.js
# → node_modules\electron\dist\electron.exe  246302208 bytes
```

## 没做什么 / 已知问题

1. **没有真正打开过窗口。** 只验证了 electron 能起来、内嵌 Node 能力够。T5（Electron 主进程 + IPC）和"三栏布局在真窗口里画出来"都还没做——这正是交给 Lane B 第 2 轮的任务。
2. **看门狗方案已弃用但文件还在**（`lane-b-watchdog.ps1`）。保留是为了留下"多行 prompt 不能当参数传 .cmd"这个教训的现场；确认新方案稳定后可以删。
3. **心跳驱动有 30 分钟粒度。** Claude 一轮约 13 分钟，所以中间可能有十几分钟的空档。如果发现空档影响进度，可以改成 15 分钟间隔。
4. **BLOCKED.md 的覆盖事故没有技术兜底**，只加了规则约束。如果之后还发生，考虑拆成 `BLOCKED-A.md` / `BLOCKED-B.md` 两个文件按 lane 分离。
5. `ELECTRON_MIRROR` 目前是手工设的环境变量，**没有写进任何自动化脚本**。T6（打包）时必须固化进构建脚本或 `.npmrc`。

## 下一手需要什么

- Lane B：在真窗口里验收 T6–T10，并准备好 mock → 真实 IPC 的切换点。
- Lane A：T2（事件总线），然后 T5（Electron 主进程）给 Lane B 提供真实 `hub:snapshot` / `hub:event` / `hub:action`。
- 无待用户决策事项。
