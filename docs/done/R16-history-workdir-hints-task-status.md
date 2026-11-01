# R16 · 对话历史 / 工作目录 / 人工提示 / 任务状态（含 codex 报错修复）

**日期**：2026-10-20 · **范围**：`apps/desktop/src/main`、`apps/desktop/src/renderer`、`packages/shared-protocol/events.ts`

## 一、这轮解决的四个问题

### 1. 对话记录保存（重启不再「像没用过」）

- 每个会话新增 `sessions/<id>/stream.jsonl`：归一化后的 UI 事件（包含人工提示）逐条追加。
  `wire.jsonl` 继续保留原始协议日志，用于排障。
- 重启时 `SessionManager.restoreSessions(taskId)` 恢复当前任务最近 20 个会话：
  - 有 `stream.jsonl` 就读它；升级前的老会话从 `wire.jsonl` 反推（跳过系统简报）。
  - 旧进程已不在，非终态统一标成 `stopped`（不是 `failed`：不是崩溃）。
- 新增 IPC `hub:history`（`HubApi.history(sessionId)`）；渲染层建标签页时先拉历史，
  实时事件在历史就绪前先缓冲，用 `seq` 去重，避免同一句话画两遍。
- 人工提示单独渲染成「你」块（`.conv-user`），和 agent 的消息/思考分开。

**已知边界**：恢复的会话是只读历史（进程已结束），要接着跑需新建会话。这样不会
假装一个已死进程还能接收 prompt。

### 2. 限定工作目录 `D:\agent\xuanwo\work`

- 开发态工作目录 = `<仓库>/work`；打包态依次尝试 `<exe>/work`、`<exe>/../work`、
  `%APPDATA%\bumimang\workspace\work`。可用 `BUMIMANG_WORKDIR` 覆盖。
- 所有会话的 `session/new.cwd` 改为工作目录（不再是 `workspace/sessions/<id>`）；
  codex / dsh 的 workspace-write 沙箱根因此也落在工作目录。
- 简报包新增「工作目录（所有生成文件放这里）」段落，明确禁止写桌面、用户目录、源码目录。
- `fs/write` 拒绝工作目录外的路径；`terminal/create` 默认 cwd = 工作目录，并拒绝显式越界 cwd。
- 首次启动写 `work/README.md`，并种一个 `work/target/index.html` 示例目标。
- **例外**：codex 若检测到 `~/.agents/skills`，会把它作为 `additionalDirectories`
  传入（codex-acp 会把它加入可写根）。这是为了让 codex 能读自己的技能包；真正的
  解题产物仍被要求写 `work/`。如果不需要，可删掉 manager.ts 里那三行。

### 3. 给 agent 发提示（人工纠偏）

- 每个会话窗格底部新增输入区：Enter 发送、Shift+Enter 换行；旁边「打断」按钮发
  `session/interrupt`（ACP `session/cancel`）。
- 主进程按会话串行排队 prompt：agent 正在跑时消息立即进历史并显示「已排队」，
  当前轮结束（或人工打断）后送达，不会并发打断协议。
- 新增 `session.interrupt`、`session.prompt` 的终态拒绝与队列提示。

### 4. 任务栏「待解 / 已解出」

- 任务卡新增状态徽标：`待解 / 解题中 / 已解出 / 已放弃`，以及人工确认的答案。
- 新增 `task.setStatus` 动作 + 「标记已解出 / 修改答案 / 改回待解」弹窗；答案落库，
  重启后仍在。改回待解会清掉旧答案与解题人，不把旧 flag 当当前答案。
- 自动识别 `flag{...}`：只作为「候选」展示（agent 消息或黑板事实里出现过），
  **不自动**判 solved —— 模型会幻觉，最终由人点确认。
- 「解题中」在第一个会话启动时自动切换；已解出/已放弃不被覆盖。

## 二、codex 报错修复（本轮优先项）

### 根因 1：策略判定前没有工具名

codex 的 `session/request_permission` 只带 `toolCallId / kind`，工具名在前一条
`tool_call` update 里。原先 manager 只在审批卡上补名字，策略引擎看到的是
「未命名工具调用」，于是每次 `blackboard_*` 都命中「受控档无规则 → 转人工」。

**修复**：`AcpClient` 新增 `enrichDetail` 钩子，在 `evaluate()` **之前**补 `title`；
manager 传入 `withToolTitle`。事故日志见 `sessions/s5/wire.jsonl`。

### 根因 2：guarded 用了 read-only 沙箱

codex-acp 2.2.2 的 `read-only` 会直接拒绝写文件/联网，导致 `Access is denied`
和 curl 失败，而不是产生审批卡。**修复**：guarded → `workspace-write`
（工作区内可写，越界写才问；**Windows 上联网不保证被沙箱拦**，R17 已改文案）；autonomous 保持默认 `agent`（自动复核）。
`BUMIMANG_ARM_CODEX=off` 仍可关闭。

### 根因 3：MCP 工具没有注解（来自 AIxVuln 交付物）

`AIxVuln-install-notes.md` 记录：codex 全局 `approval_policy = "never"` 时，
未注解的 MCP 工具会直接报 `MCP tool call requires approval, but approval policy is never`。
**修复**：`mcp-host/server.ts` 给 7 个工具都补了 annotations ——
只读工具 `readOnlyHint: true`，写黑板工具 `readOnlyHint: false, destructiveHint: false`。

### 额外

- codex 的 `session/new` 带上 `additionalDirectories`（技能目录，见上）。
- 进程清理从 `child.kill()` 改为 Windows `taskkill /T /F`，避免 MCP / shell 孤儿。

## 三、验收

```powershell
cd D:\agent\xuanwo

# 确定性套件（R17 后 140 条）+ 渲染层纯逻辑（115 条）
npm run verify:all
# → 49/49 + 16/16 + 17/17 + 19/19 + 39/39 + ALL PASS

# Electron 真实 IPC / 三栏 / 新通道 / 任务栏
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
# → 19/19（含任务栏「待解 → 已解出」端到端断言）

# 打包态（npm run pack:dir 之后）
dist\win-unpacked\不迷茫.exe --no-sandbox --verify
# → 19/19（验证工作区在临时目录，不碰用户数据）

# codex 真实 ACP + 真实 MCP 黑板：黑板读取不转人工、无 approval policy 报错
npm run verify:codex-mcp
# → 5/5（onBoardRead 5 次，approvals=0，无 requires approval）

# codex 三种 mode 对照（真实写文件）
npm run verify:arm-codex
# → read-only 问 1 次；workspace-write/agent/via-app 在工作区内直接写成功

# 档位徽标 / 扇出说明（真实 Electron DOM）
node_modules\electron\dist\electron.exe apps\desktop\electron\tier-asymmetry-verify.ts --no-sandbox
# → ALL_PASS
```

新增脚本：`npm run verify:history`（R17 后 39 条，覆盖 stream/wire 两种历史回放、任务状态落库、
工作目录包含性）、`npm run verify:codex-mcp`（真实 codex + MCP 回归）。

## 四、改动文件

主进程：
- `acp/client.ts`：`workRoot`、`enrichDetail`、`fs/write` / `terminal/create` 越界拒绝、`killTree`
- `session/manager.ts`：stream 历史、恢复、prompt 队列、interrupt、codex workspace-write
- `hub/hub.ts`：`history`、`task.setStatus`、`session.interrupt`、flag 候选、workDir
- `blackboard/board.ts`：`latestTask`、`listSessions`、`audit`、`setTaskStatus`、witness 字段
- `mcp-host/server.ts`：工具 annotations
- `mcp-host/bridge.ts`：`onBoardWrite`、E2 推断、workRoot
- `stream/normalize.ts`（新）：ACP update 归一化 + flag 正则
- `briefing/build.ts`：工作目录段落
- `electron/main.ts` / `preload.cjs`：`hub:history`、工作目录解析、恢复、verify 断言

契约与渲染层：
- `packages/shared-protocol/events.ts`：`TaskView.flagCandidate`、`StreamUpdate.seq/user_prompt`、
  `HubSnapshot.workDir`、`HubAction.session.interrupt/task.setStatus`、`HubApi.history`
- `renderer/panes/*`：历史回放 + 去重、人工提示输入区、user 块
- `renderer/main.ts` / `task.ts`：任务状态徽标 + 确认弹窗
- `renderer/gate.ts`：codex 两档都可能问
- `styles.css`：新增 `.task-status-*`、`.pane-compose`、`.conv-user`
