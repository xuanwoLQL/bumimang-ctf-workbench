# P7-B · 进程清理 + MCP 崩溃 UI

> 状态：**P7-B 完成**。范围：主进程崩溃/被杀后的残留 agent/MCP 清理（PID + OS 启动时间）、MCP 异常断开的会话标记/事件/UI 提示。**不改** restoreSessions、配额、收敛、MCP 自动重启。
> 日期：2026-10-25。不启动真实 agent。

## 做了什么

### 1. 进程登记 / 启动清理

- 扩展 `apps/desktop/src/main/reliability/process-registry.ts`：
  - 持久化 `process-registry.json`：pid / startedAt / **OS startTime** / kind / taskId / sessionId；
  - `cleanupStale()`：启动时读表，PID 存活且 OS 启动时间匹配（±2s）才 `taskkill /T /F`；PID 复用（时间不符）跳过；
  - `isPidCurrent(pid)`：killTree 前的 PID+启动时间守卫；
  - `terminateAll()`：退出时按 ChildProcess 句柄/任务树清理，持久化清空；
  - Windows 用 `taskkill`，其他平台 SIGKILL；不引原生模块。
- `main.ts`：启动时创建持久化 registry 并 `cleanupStale()`；把同一 registry 传给 SessionManager；MCP hello 上报 PID 后登记 `kind="mcp"`，断开时注销。
- `session/manager.ts`：agent spawn 后 `registerPid(pid,"agent",{taskId,sessionId})`；onAgentExit 注销；`killGuard` 传给 AcpClient。
- `acp/client.ts`：`killTree(pid, guard)` 保留 taskkill /T /F 基线；`kill()` 前用 registry 校验 PID+启动时间，不匹配则跳过树 kill。

### 2. MCP 崩溃标记 / 事件 / UI

- `mcp-host/server.ts`：`uncaughtException` / `unhandledRejection` 写 stderr 并退出；hello 带 `pid: process.pid`。
- `mcp-host/bridge.ts`：
  - hello 上报 MCP PID → `onMcpConnected`；socket 关闭 → `onMcpClosed`；
  - 非 revoke/stop 的 socket 关闭且会话仍 running → `onMcpUnavailable`；revoked/stop 不误报。
- `session/manager.ts`：`markMcpUnavailable(sessionId)` 设独立字段 `mcpUnavailable=true`，**不改 status**；`onSessionChange` + `onMcpUnavailable`；幂等；终态会话忽略。
- `main.ts`：`onMcpUnavailable` 广播 `mcp.unavailable`；manager 的 session.upsert 带字段。
- `events.ts`：`SessionView.mcpUnavailable?`、`HubEvent.mcp.unavailable`（可选）。
- `hub.ts`：`toSessionView` 透传 mcpUnavailable（只加字段）。
- renderer：
  - `store.ts` 处理 `mcp.unavailable`，只标记会话，不改 status；旧快照无字段。
  - `panes.ts` 运行中会话显示 `MCP 不可用：本会话无法再读写黑板。请新建会话继续。` + 「新建会话」按钮（打开现有 fanout 弹窗）。
  - `smoke.ts` 新增 1 条断言（712）。

### 3. verify-reliability B 组

- B1 残留清理 + PID 复用：匹配 PID+startTime 清理；复用不杀；`isPidCurrent` 真/假。
- B2 MCP socket 断开触发 `onMcpUnavailable`；`revokeSession` 不误报。
- B3 SessionManager 标记 `mcpUnavailable=true`、status 不变、事件回调一次、幂等。
- B4 renderer store 接受 `mcp.unavailable`。
- A 组 15 条未改；A+B **30/30**。

## 改了哪些文件

| 文件 | 变更 |
|---|---|
| `reliability/process-registry.ts` | 持久化、startTime、cleanupStale、isPidCurrent、MCP kind |
| `acp/client.ts` | killTree guard（PID+启动时间） |
| `session/manager.ts` | agent/mcp 登记、注销、markMcpUnavailable、killGuard |
| `mcp-host/bridge.ts` | MCP PID/断开侦测、revoked 抑制、onMcpUnavailable |
| `mcp-host/server.ts` | 崩溃日志/退出、hello pid |
| `main.ts` | registry 启动清理、MCP PID 登记、mcp.unavailable 广播 |
| `hub.ts` | toSessionView 透传 mcpUnavailable |
| `events.ts` | SessionView.mcpUnavailable、HubEvent.mcp.unavailable |
| `renderer/store.ts` | mcp.unavailable 标记 |
| `renderer/panes.ts` | MCP 不可用提示 + 新建会话 |
| `renderer/smoke.ts` | 1 条 store 断言 |
| `cli/verify-reliability.ts` | B 组 15 条 |
| `docs/done/P7-B.md`、`docs/PROGRESS.md` | 文档 |

**未改**：board.ts、config/loader.ts、backup.ts、electron-builder、rules/benchmarks、renderer 其他逻辑。

## 怎么验证的

```text
npm run verify:reliability → 30/30 PASS
  A1-A4 15 条（未改）
  B1 残留清理/PID 复用/isPidCurrent
  B2 MCP 断开/revoke 不误报
  B3 manager 标记/status 不变/事件/幂等
  B4 store 标记
npm run verify:all → 712/0（P7-B 新增 1 条 smoke）
```

| 门禁 | 结果 |
|---|---|
| `verify:all` | **712/0** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:multitask` | **174/174** |
| `verify:reliability` A+B | **30/30** |
| electron `--verify` | **26/26** |
| `.probe/backup-wp1/board.db` | `6d491f0b…ab5cf469`（未变） |

## 行为变更

- 启动时清理本 app 登记的残留 agent/MCP/代理：PID + OS 启动时间都匹配才杀；PID 复用不误杀。
- 退出/会话结束时注销登记；`terminateAll` 清空持久化表。
- MCP 子进程异常断开：会话标记 `mcpUnavailable`（不改 status）、广播 `mcp.unavailable`、pane 顶部提示 + 新建会话按钮；**不自动重启**。
- 正常 revoke/stop 关闭 MCP 不误报。
- 旧快照无 `mcpUnavailable` 不炸。

## 已知限制

1. 残留清理用 `Get-Process.StartTime`（PowerShell）逐 PID 校验；非 Windows 返回 null → 保守跳过 stale 清理。
2. B1 用注入的 `getStartTime/isAlive/killPid` 做确定性测试；没有真的杀一个残留进程（避免误杀/依赖桌面环境）。
3. MCP PID 依赖 hello 上报；MCP 未连上/未上报时没有独立记录，但 agent 的 `taskkill /T` 会覆盖 MCP 树。
4. `mcpUnavailable` 只在内存，不落库；应用重启后丢失（会话通常已终态）。
5. UI 提示只做了 store 断言 + Electron 加载；没有自动 DOM 断言 banner 可见性。
6. MCP socket 关闭与正常 agent 退出存在竞态；revoke/stop 抑制，UI 仅非终态显示，仍有短暂误提示可能。
7. 不自动重启 MCP（避免循环崩溃）；用户需新建会话。
8. `mcp-host/server.ts` 的 unhandledRejection 直接退出，可能把可恢复的异步错误当崩溃；当前按“崩溃可见优先”。
9. registry 文件无跨进程锁；依赖单实例；写入用 tmp+rename 原子替换。
10. PID 时间容差 ±2s；系统时间/进程启动时间精度极端情况下可能误判，匹配失败只会跳过（不误杀）。
11. 未用 Job Object（P7-B 仍用 taskkill 基线）；Windows 之外 `killTree` 只杀直接子进程。
12. PowerShell 不可用时 startTime=null，stale 清理跳过；不阻塞应用启动。
13. registry 只登记 agent/MCP/proxy；shell/PTY 子进程由 `/T` 覆盖，不单独登记。
14. B 组测试与实现同批落地，**未单独保留 B 红测输出**（A 组红测 `p7a-red.txt` 已保留）。
15. `mcp.unavailable` 事件不落库/不回放；旧快照无字段。
16. 未做 P7-C（workDir/skillDir 可移植、打包态）与 P7-D（收口）。

## 代码 hash

| 文件 | sha256 |
|---|---|
| `acp/client.ts` | `62e5c2bc…9876771b` |
| `session/manager.ts` | `a4a3825d…25e14663` |
| `mcp-host/bridge.ts` | `a0799629…18bd2cba` |
| `mcp-host/server.ts` | `9603ec2f…8d5ad9db` |
| `process-registry.ts` | `c45b3902…392b3ea3` |
| `main.ts` | `80a94b3c…a4bfd798` |
| `hub.ts` | `5db92a64…85805f5a` |
| `events.ts` | `0027cf17…a2dbbe28` |
| `renderer/store.ts` | `4c079515…2fd268d` |
| `renderer/panes.ts` | `f06856de…c11d62a2` |
| `renderer/smoke.ts` | `062f0094…ed02e6c4` |
| `verify-reliability.ts` | `c7c7e887…85252f` |
| `board.ts`（未改） | `88363dcd…b4561583` |
| `config/loader.ts`（未改） | `fe318019…d31209` |
| `backup.ts`（未改） | `857031a8…7555a95f` |

## 证据

- `evidence/p7b-final-all.txt` `59873686…12c7ac84`
- `evidence/p7b-final-scope.txt` `ebb5789f…9954561`
- `evidence/p7b-final-flags.txt` `c889261a…ae7a95`
- `evidence/p7b-final-migration.txt` `223189da…136967e5`
- `evidence/p7b-final-multitask.txt` `296fee6a…c9de69`
- `evidence/p7b-final-reliability.txt` `da27e02a…ef764be`
- `evidence/p7b-final-electron.txt` `b9b51b9b…dfe6f2`
- 早期 B 组：`evidence/p7b-verify-reliability.txt`（30/30）

## 下一手需要什么

- P7-C：workDir/skillDir 可移植 + 打包态 --verify；不改 P7-A/P7-B 的 A/B 断言。
- P7-C 若改 AcpClient/manager 路径相关 cwd，需保持 P7-B 的 registry/killGuard 行为。
- 基线：verify:all 712/0、scope 354/354、flags 214/214、migration 127/127、multitask 174/174、reliability 30/30、electron 26/26。
