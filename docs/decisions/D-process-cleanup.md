# D-process-cleanup · 进程树清理方案（P7-B）

> 决策日期：2026-10-25。状态：已实施（P7-B）；记录替代方案与限制。

## 背景

Windows 上 `child.kill()` 只杀直接子进程；agent 会再拉起 MCP / shell / PTY。P4-D 只按 ChildProcess 句柄清理代理；P7-B 需要：

- 主进程崩溃/被杀后，下次启动清理仍属于本 app 的残留；
- PID 复用不能误杀；
- 不引原生模块/Job Object 依赖。

## 选择

**taskkill /T /F + PID + OS 启动时间校验 + 持久化登记表。**

- 登记：`%APPDATA%\bumimang\workspace\process-registry.json`（开发态 `.ui-run/process-registry.json`），字段 `pid/startedAt/startTime/kind/taskId/sessionId`。
- 启动：`cleanupStale()` 读表；PID 存活、`Get-Process.StartTime` 与登记值差 ≤2s 才 `taskkill /T /F`；否则跳过。
- 退出：`terminateAll()` 按 ChildProcess 句柄/任务树清理；登记表写空。
- killTree：`AcpClient.kill()` 前用 registry `isPidCurrent()` 校验；不匹配跳过树 kill，保留 `child.kill()` 兜底。
- MCP：server hello 上报 `process.pid`，桥登记 `kind=mcp`；socket 正常关闭/崩溃注销；MCP 树仍由 agent 的 `/T` 覆盖。

## 为什么不 Job Object

- 需要原生模块/ffi 或额外依赖；项目当前只用 Node 内置模块。
- Job Object 的“进程加入即绑定”需要在每次 spawn 时拿句柄；对 agent 拉起的 MCP 子进程（不是主进程直接 spawn）无法简单纳入。
- `taskkill /T` 对当前 agent 树已够用；PID+启动时间解决残留误杀。Job Object 留作未来增强（若引入依赖需先问用户）。

## 限制

- 非 Windows：`killTree` 只杀直接子进程；`Get-Process.StartTime` 不可用 → stale 清理保守跳过。
- PowerShell 逐 PID 查询有启动开销；失败只跳过，不阻塞应用。
- registry 无跨进程锁；依赖单实例；写 tmp+rename。
- 启动时间容差 ±2s；极端时钟/精度可能误判，失败方向是“不杀”。
- MCP 未 hello/未上报 pid 时没有独立登记；由 agent `/T` 覆盖。
- 未做 WSL 原生包/Job Object；WSL 检测与文档后置。

## 证据

- `docs/done/P7-B.md`、`docs/done/WP7-reliability.md`
- `evidence/p7b-final-*`；verify-reliability B1/B2/B3。
