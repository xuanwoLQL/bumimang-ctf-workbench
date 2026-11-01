# R18 · 会话事件跨任务泄漏 / 关闭超时 / 正常退出竞态

**日期**：2026-10-20 · **范围**：`src/main/hub/hub.ts`、`src/main/session/manager.ts`、`src/renderer/store.ts`、`src/cli/verify-r18.ts`（新增）

> 说明：这一轮在上一窗口做完代码与验收，但退出时**没留完成文档**（与 PROGRESS 里记录过的「干完活没留证据」同类）。本窗口按 `verify-r18.ts` 头注与代码注释补记，验收命令已在本窗口复跑通过。

## 做了什么

评审发现三个已复现问题 + 三个连带缺陷，全部收口：

- **A. 会话事件跨任务泄漏**：切任务后，旧任务的延迟 prompt / 延迟简报回调仍会产出 `session.upsert` / `session.stream` / `health` / `approval.upsert`。`Hub` 的异步回调统一走 `publish*` 并由 `isCurrentTaskSession()` fail-closed 过滤（未知 session 一律丢弃）；`dispatch` 也拒绝旧任务的 start/prompt/stop/interrupt。渲染层 `store.ts` 再兜一道：任务不匹配的 `session.upsert` 整条丢弃。
- **B. 关闭没有超时**：agent 卡在待批、无视 `session/close` 时，`stopSession` 会被永久挂住。现在 close 自身有 3s 上限，`finally` 落到 kill；停止即收尾 wire/stream 句柄，不留到全局 shutdown。
- **C. 正常退出竞态**：`shutdown()` 必须等进程真退出、状态落成 stopped 之后，调用方才关库——否则 Electron `before-quit` 先 `board.close()`，迟到的 exit 再写库就是 `database is not open` 并误记 failed/incident。`doShutdown()` 统一 deadline：先标 expectedExit → cancel/close/kill → `waitForExit`，全退出后才返回。
- **C2. 故障注入 kill 无效**：`shutdown()` 在统一总预算内返回 `timedOut`，超时路径**先关门再收尾**（状态/租约/intent/句柄），进入 `disposed`，关库后的迟到 exit 走 disposed 分支、不再碰 board。
- **D. wire.jsonl 句柄泄漏**：停多个会话后句柄不随历史增长（`closeSessionLogs` 每会话即时关闭）。
- **E. spawn ENOENT**：agent 可执行文件缺失时不掀主进程；已关闭后的请求快速 reject、不挂 pending。

## 改了哪些文件

- `src/main/hub/hub.ts`：`isCurrentTaskSession` / `currentSession` 收口，异步回调统一走 `publish*` 过滤
- `src/main/session/manager.ts`：`stopSession` 关闭超时 + 句柄收尾；`shutdown()`/`doShutdown()` 生命周期闸门（`disposed`/`finalizing`）、`finalizeTimedOutSession`、close+wait 共用 deadline、ENOENT 兜底
- `src/renderer/store.ts`：`session.upsert` 任务不匹配时丢弃（UI 侧最后一道防线）
- `src/cli/verify-r18.ts`（新增）：确定性验收覆盖 A/B/C/C2/D/E

## 怎么验证的

```powershell
npm run verify:r18     # 94/94（覆盖事件隔离 / 关闭超时 / 正常退出 / kill 无效故障注入 / 句柄不增长 / ENOENT）
npm run verify:all     # 49+16+17+19+53+94 = 248 条 + smoke，exit=0（本窗口复跑）
```

## 没做什么 / 已知问题

- **孤儿进程仍靠 `taskkill /T /F`**：主进程崩溃后的孤儿进程需 Windows Job Object 或带进程启动时间校验的启动清理（R17 已列，仍未做）。
- **`session/load/resume`（续聊）**仍只读不回接：R17 明确选择历史只读，`resume` 作为后续功能。

## 下一手需要什么

无阻塞项。
