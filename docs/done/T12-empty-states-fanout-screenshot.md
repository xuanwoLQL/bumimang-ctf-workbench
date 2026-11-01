# T12（截图半）+ 空状态打磨 + 扇出真实桥验证

> 完成时间：2026-10-13 00:25
> 归属：Lane B（renderer + electron），真实 IPC 已由 Lane A 打通（见 `T2-T5-T11-real-ipc-wired.md`）。
> 说明：真实后端里快照是 task=有 / sessions=0 / approvals=0 / board=空，所以三栏里大部分
> 面板是空的。这一轮做三件事：把空状态写明白、把「扇出」标成明显的下一步、并**在真实桥
> （非 mock）上**把扇出与截图验掉。

## 做了什么

### 1. 空状态文案（renderer 层，纯 UI）

真实快照下三栏照常渲染，但大多数面板是空的。给它们补上明确的空状态，而不是一句含糊的
「空」：

- **会话**：`还没有会话` + 提示 `下一步：点下方「+ 扇出」起第一个会话（选 agent + 角色 + 档位）。`
- **审批队列**：`暂无待审批` + 提示 `会话开始后，agent 的关键动作（命令执行 / 文件写入等）会出现在这里，等你放行或拒绝。`
- **黑板台账**：整板为空时先给一条醒目的 `黑板为空` 横幅（`还没有任何台账记录。会话开始后，agent 会把事实 / 死路 / 意图 / 租约写到这里；互相冲突的事实会并列高亮。`），下面仍照常渲染四区结构作预览。

### 2. 扇出按钮 = 明显的下一步

没有会话时，加号按钮从虚线描边升级为 **primary 填充样式**（accent 底、深色字），文案
`+ 扇出会话` + 副标题 `起第一个会话`；有会话时退化为 `+ 扇出会话 / 再加一个` 的次级样式。
这样用户在空面板里一眼看到该点哪。

### 3. 真实桥扇出验证 + 截图（electron 层，新入口 `real-bridge-verify.ts`）

新写了一个验证入口，**复用 Lane A 的核心**（`Blackboard` / `BoardBridge` /
`SessionManager` / `HubService`，只 import 不改），照主进程入口把三条 IPC 通道接上，挂上
`apps/desktop/electron/preload.cjs`（我 lane 里的 .cjs，与 Lane A 的语义相同）。它证明：

- 真实桥 `window.bumimang` 存在，快照确为「task 有 / sessions=0 / approvals=0 / board 空」；
- 三栏空状态文案与 primary 扇出按钮真的画出来；
- 加号能打开扇出弹窗，agent 下拉里 **opencode / codex / claude 可用，dsh 正确灰显**；
- `session.start` 经 `window.bumimang.dispatch` 发出后，**真实后端起了一个 opencode 会话**
  （initialize protocolVersion=1 → session/new → 简报 prompt），dispatch 返回 `{ok:true}`，
  且渲染进程收到 `session.upsert` 把会话画进左栏（状态走到 `running`）；
- 真实窗口（非 mock）两张截图：`real-bridge-empty.png`（空状态）与
  `real-bridge-started.png`（会话起来后，左栏有 opencode 会话卡 + 中栏有窗格）。

## 改了哪些文件

```
apps/desktop/src/renderer/main.ts           会话空状态 + primary 扇出按钮
apps/desktop/src/renderer/approval/approval.ts  审批空状态文案
apps/desktop/src/renderer/board/board.ts    黑板整板为空横幅
apps/desktop/src/renderer/styles.css        空状态 / primary 按钮样式
apps/desktop/electron/preload.cjs           （新）真实桥 preload，与 src/main/electron/preload.cjs 语义相同
apps/desktop/electron/real-bridge-verify.ts （新）真实桥验证 + T12 截图入口
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
Get-Process electron,opencode -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/real-bridge-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|verify\]"
```

真实输出 **20/20 通过**（关键几条）：

```
PASS  空状态：会话「还没有会话」+ 指向扇出的提示
PASS  空状态：审批「暂无待审批」
PASS  空状态：台账「黑板为空」
PASS  加号按钮是明显的下一步（primary 样式 + 「起第一个会话」提示）
PASS  加号能打开扇出弹窗，agent 下拉列出已安装引擎  — enabled=["opencode","codex","claude"]
PASS  session.start 派发后真实后端有反应（新快照出现会话）
PASS  新快照里的会话是刚扇出的那个 agent  — [{"id":"s1","agent":"opencode","status":"starting"}]
PASS  session.start 返回 {ok:true}  — {"ok":true}
PASS  渲染进程收到 session.upsert 并把会话画进左栏  — items=1 agents=["opencode"] panes=1
```

证据落在：

- `docs/logs/real-bridge-verify.json`（20 条断言 + 快照前后对比 + dispatch 结果 + DOM 探针）
- `docs/logs/real-bridge-empty.png` / `.jpg`（空状态截图）
- `docs/logs/real-bridge-started.png` / `.jpg`（会话起来后截图，左栏 opencode 会话卡 + 中栏窗格）
- `docs/logs/real-bridge-run.log`（完整 stdout）

另：renderer 纯逻辑 smoke（`node apps/desktop/src/renderer/smoke.ts`）与 mock 路径
`render-verify.ts`（14/14）均复跑通过，确认空状态改动没破坏 mock 路径。

## 没做什么 / 已知问题

1. **审批队列、黑板台账仍是空**，不是渲染问题：审批队列要等 T4，黑板要等会话真的往里面
   写（这一轮起的 opencode 会话在退出前被清理，没留下台账）。
2. **`session.start` 会 spawn 真 agent 子进程，几十秒**。验证里用「会话先以 `starting` 状态
   同步插进快照」这一事实，在 spawn 完成前就拿到了「后端有反应」的证据，再单独等 dispatch
   返回 `{ok:true}`，不用干等整个 spawn。
3. **持久库里的会话 id 是 `s{n}`（每进程从 1 起）**：同一 board.db 跨两次进程跑 `session.start`
   会撞 `s1` 主键。我的验证入口把工作区指到 `.ui-run/verify-b/` 并每次清空，绕开了它；
   这是核心（Lane A 的 src/main）的潜在坑，等 Lane A 起第二次会话时会撞到，已在此记录。
4. **验证入口的清理顺序**：先 kill agent 子进程 → 等 `onAgentExit` 写完黑板 → 再关库。
   顺序反了会报 `database is not open`（app.exit 不触发 before-quit，所以必须在退出前显式清理）。
5. **截图我这边工具链没法预览**（Read 工具返回 Unsupported Image），但 PNG 已由 `file` 确认
   为合法 PNG、两张字节数不同（139050 vs 165528），且 evidence JSON 里的 DOM 探针记录了截图
   时刻画面内容（空状态 / 会话卡 running）。

## 下一手需要什么

- **T4 审批队列**：这是让「审批队列」面板从空变有内容的关键，也是唯一的事前闸门
  （`session/request_permission`，实测三家 agent 都走它）。
- **T3 策略引擎**：`session.setTier` 目前仍是空实现（只存内存）。
- 无待用户决策事项。
