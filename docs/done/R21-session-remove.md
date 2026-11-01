# R21 · session.remove（关标签真移除：只隐藏、不删除）

**日期**：2026-10-20 · **范围**：`packages/shared-protocol/events.ts`、`src/main/blackboard/board.ts`、`src/main/session/manager.ts`、`src/main/hub/hub.ts`、`src/renderer/{store,panes/panes,mock/engine}.ts`、`src/cli/{verify-history,verify-r18}.ts`、`apps/desktop/electron/{tabs-verify,cold-start-verify,r1-verify,approval-verify}.ts`、`.probe/asar-r21-check.cjs`

## 做了什么

点「×」从「停止（标签仍在）」升级为「关标签真移除」。**语义由用户拍板：保留历史、只隐藏**——库里记录与 stream.jsonl 原样保留，只是不再显示；恢复 = 把库里 `sessions.hidden` 翻回 0（UI 恢复入口留给下一轮）。

1. **契约加两样**：`HubAction.session.remove`（含语义注释）+ `HubEvent.session.removed`。
2. **库**：sessions 表加 `hidden INTEGER NOT NULL DEFAULT 0`；老库在 `open()` 时显式迁移（`PRAGMA table_info` 查列 + `ALTER TABLE`，`CREATE TABLE IF NOT EXISTS` 不会给旧表加列）；`setSessionHidden()` 写标记并留 audit/事件；`listSessions` 过滤 `hidden=0`。
3. **主进程**：`SessionManager.removeSession()` —— 先 `stopSession`（cancel/close 3s 上限/kill）再落终态 stopped、置 hidden；**记录留在内存 map 里（带 `hidden` 标记）而不删除**：迟到的 exit/流回调要能找到 rec 才能正常收尾落库，`listSessions` 与 Hub 发布路径（`isCurrentTaskSession` / `currentSession` / `publishSessionRec`）统一过滤。`hub.dispatch` 加 `session.remove` 分支（先清审批再移除，与 stop 一致），移除后推 `session.removed`。
4. **渲染层**：`store.ts` 折叠 `session.removed`（撤会话 + 清健康度，标签/窗格由 panes.sync 既有的「移除已消失的会话」自动撤下）；panes.ts 的 × 改派 `session.remove`，title 改「关闭标签：会话会停止并从列表隐藏，历史保留可回看」；mock 引擎同步实现（histories 保留）。
5. **验收**：verify-history +12 条（隐藏过滤 / 事件 / 恢复翻回 / 重复移除拒绝 / 跨任务拒绝 / 重启不载入 / 磁盘历史未删 / 无 incident 死路）；verify-r18 新 partRemove +16 条（**活进程**假 agent 回合进行中移除：进程真死、状态/hidden 落库、迟到流/健康/upsert 全被过滤、无未处理异常）；tabs-verify +5 条（真实 DOM 点 × → 标签 3→2、窗格销毁、不抢焦点）。

**连带修复（存量 stale 断言，不是本轮回归）**：把 10-13 全量扫过后就没人跑过的渲染套件翻出来重跑，抓到三个过期套件并修掉：① `cold-start-verify` 2 FAIL——R16 把任务状态徽标类名 `task-status` 改成 `task-status-badge`，probe 选择器没跟上（读 null）；② `r1-verify` 13 FAIL——注入会话写死 `taskId:"task-r1"`，R17 的「任务不匹配 upsert 丢弃」守卫把注入全丢了，改用 bootstrap 里的真实任务 id；③ `approval-verify` 1 FAIL——还在断言 T14 之前的「引擎可用 3 · 未安装 1」，dsh 接入后应是「4 · 0」。

## 改了哪些文件

- 契约：`packages/shared-protocol/events.ts`
- 主进程：`board.ts`、`manager.ts`、`hub.ts`
- 渲染层：`store.ts`、`panes/panes.ts`、`mock/engine.ts`
- 验收：`verify-history.ts`（54→66）、`verify-r18.ts`（94→110，新 partRemove）、`tabs-verify.ts`（28→33）
- stale 修复：`cold-start-verify.ts`、`r1-verify.ts`、`approval-verify.ts`
- 探针：`.probe/asar-r21-check.cjs`（新增）

## 怎么验证的

```powershell
node apps/desktop/src/cli/verify-history.ts     # 66/66（+12：移除/隐藏/恢复/重启不载入）
npm run verify:r18                              # 110/110（+16：活进程移除全链）
node apps/desktop/src/renderer/smoke.ts         # ALL PASS（+3：mock remove）
npm run verify:all                              # 49+16+17+19+66+110 = 277 + smoke，exit=0
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
                                                # 19/19
# 渲染层 electron 套件全量重扫（12 个全 ALL_PASS）：
#   smoke / tabs-verify 33 / cold-start 58 / render 14 / push / r1 / gate-empty /
#   blocked-hostile / scorecard / tier-asymmetry / first-run / approval
# 打包态（R21 已进 dist，16:33 重打包）：
dist\win-unpacked\不迷茫.exe --no-sandbox --verify   # 19/19
dist\不迷茫 0.1.0.exe --no-sandbox --verify          # 证据 ui-verify.json 19/19（16:34:19 重写）
node .probe/asar-r21-check.cjs                       # 7/7（session.remove 契约与实现都在 asar 里）
```

## 没做什么 / 已知问题

- **UI 恢复入口没做**：隐藏后要回看/恢复只能把库里 `sessions.hidden` 翻回 0（`board.setSessionHidden(id,false)`）。自然的下一手是在左栏加「已隐藏 N 个会话」折叠区 + 恢复按钮，契约侧 `setSessionHidden(false)` 已就位。
- **隐藏会话的历史回看入口**：隐藏后 `hub:history` 在本次运行内仍可读（记录在内存），但重启后不载入内存（盘上 stream.jsonl 保留）。要给「已隐藏」加回看，需要 `loadTaskSessions` 支持载入隐藏会话——留到恢复入口那轮一起做。
- **`session.stop` 保留未删**：契约里 stop 仍是独立动作（测试/工具在用），× 不再走它。
- `removeSession` 对「既无进程也无 client 的恢复会话」路径已验（verify-history）；对「活进程」路径已验（verify-r18 partRemove，假 agent）。

## 下一手需要什么

无阻塞项。候选：隐藏会话恢复 UI、task.update/task.delete（自包含）、Job Object 孤儿回收（较大项，单独开轮）。
