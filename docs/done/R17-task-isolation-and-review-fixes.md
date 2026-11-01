# R17 · 任务隔离与 codex 评审回归修复

**日期**：2026-10-20 · **背景**：R16 落地后的独立评审发现 3 个 P1 + 4 个 P2。

## P1（已修）

### 1. 新建任务后黑板仍写回旧任务

**根因**：`BoardBridge` 在启动时固定 `taskId`，`envForSession()` 把 `BUMIMANG_TASK`
写死成当时的任务；`task.create` 只改了 `HubService.taskId`。

**修复**：
- `SessionManager` 调 `envForSession(sessionId, input.taskId)`，按会话传任务。
- `BoardBridge.route()` 以 **库里的 `sessions.task_id` 为准**（`board.getSession(sessionId)`），
  env 里的 taskId 只做兜底 —— 即使 env 陈旧，也不可能写错任务。
- 新增 `Blackboard.readSinceForTask(afterId, taskId)`；MCP 的 `blackboard_read_since` 只读本任务事件。
- `Hub.publishBoardSince()` 只扫当前任务的事件，旧事实里的 flag 不会挂到新任务上。

**回归**：`verify-history` 里在桥固定旧任务的情况下，既直接调用 `route()`，也走**真实命名管道**
（hello → submitFact，params 里故意带旧 taskId）提交事实；断言新任务有、旧任务无；
`readSinceForTask` 只返回本任务事件。

### 2. 会话列表不按任务隔离

**修复**：
- `Hub.snapshot()` 的 `sessions` / `health` / `approvals` 全部按当前 `taskId` 过滤。
- `publishSessionRec` / `publishStream` / `publishStreamUpdate` / `publishHealth` 过滤旧任务会话；
  否则切换任务后旧会话的退出回调会把它重新塞回列表。
- `task.create` 切换前先 `denyAllOf` + `stopSession` 收尾旧任务的活会话，避免旧进程继续跑、
  审批却无人处理。
- 渲染层在 `task.upsert` 的任务 id 变化时整份重拉快照（契约没有 session.removed，
  快照才是权威列表）。

**边界**：旧任务数据仍保留在库里，但当前 UI 没有「切换回旧任务」的入口；这是下一步
（task.select）的活，不在本轮范围。

### 3. codex guarded 联网闸门没有兑现

**事实**：Windows 上 codex-acp 的 `workspace-write` 对工作区外写会请求审批，但
`curl https://example.com` 实测 HTTP 200 且 `request_permission=0`；`networkAccess:false`
没有被 Windows 沙箱执行。`rules/competition.json` 的 `external-network-needs-human` 只挂
`session/request_permission`，codex 不请求就不会命中。

**本轮处理**（按评审给出的第二选项：明确能力边界，不假装已拦住）：
- `gateBadge` / `tierNoteFor` / `detect.ts` / `manager.ts` 的文案改为：
  「工作区内可写，越界写会转人工；**Windows 上联网不保证被拦**（curl 可能直接放行）」。
- 不再出现「联网才问」的承诺。
- 真正的联网闸门需要 OS 级沙箱 / 本地代理或防火墙策略，列为后续工作，不在本轮硬做半成品。

## P2

### 4. 历史只读 vs 真正续聊

本轮明确选择**历史只读**：恢复的会话状态 stopped、输入框禁用，文案改为
「会话已结束，历史只读；点左上「+ 扇出」新建会话继续」。ACP `session/load/resume`
（codex/claude 适配器支持）作为后续功能，不在本轮冒险接。

### 5. flag 候选跨 chunk / 重启丢失

- `Hub.ingestUpdate()` 按会话累计最近 16KB 的 `agent_message` 文本后再 `extractFlag`，
  `flag{sp` + `lit_ok}` 也能识别。
- 新增 `Hub.recoverTaskSignals()`：启动恢复会话后重扫历史消息与黑板事实，候选不会因重启消失。
- 回归：`verify-history` 用两个 split chunk 写入 `stream.jsonl`，重启后断言候选 `flag{split_ok}`。

### 6. 重启后旧租约/意图泄漏到新会话简报

- 新增 `SessionManager.recoverStaleSessions()`：启动时对所有非终态旧会话
  释放租约、abandon claimed 意图、标 stopped；只有真的释放过资源才留一条
  `scope=incident` 死路。
- 这样新会话简报不会再出现「s1 正在做 XXX」。
- 回归：`verify-history` 在 restore 前造租约 + 意图，断言释放/abandon/incident 死路。

### 7. 工作目录不是硬隔离

- `isInsideDir()` 改用 `realpath`（目标不存在时解析最近存在的祖先），防 junction / symlink
  逃逸；`fs/write` 与 `terminal/create` 都走它。
- 回归：`verify-history` 建 `work/escape -> outside` junction，断言判越界。
- 仍**不是 OS 级 jail**：shell 命令里的绝对路径可以绕开 cwd 检查。文案已从「唯一可写」
  降级为「工作目录 + 应用会拒绝 ACP 文件写入和命令 cwd 越界」，避免过度承诺。

### 8. waiting_approval / 审批中打断

- `SessionManager.beginApproval/endApproval`：审批期间状态 `waiting_approval`，
  并发审批按深度计数，结束后回 `running`，终态优先。
- `Hub.session.interrupt` 先 `approvals.denyAllOf(sessionId)` 再 `session/cancel`，
  卡在审批里的打断会立即生效。
- 回归：`verify-concurrency` 断言审批期状态为 `waiting_approval`。

### 9. Job Object

本轮仍用 `taskkill /T /F`（正常退出路径）。主进程崩溃后的孤儿进程需要 Windows Job
Object 或带进程启动时间校验的启动清理；单独排期，避免按可能复用的 PID 误杀。

## 验收

```text
npm run verify:all
→ 49/49 + 16/16 + 17/17 + 19/19 + 39/39 + 渲染层 smoke ALL PASS
   （确定性 140 条 + smoke 115 条）

electron ... --verify → 19/19
```

新增/加强的断言集中在 `apps/desktop/src/cli/verify-history.ts`、
`verify-concurrency-and-blocked.ts`、`apps/desktop/electron/tier-asymmetry-verify.ts`。
