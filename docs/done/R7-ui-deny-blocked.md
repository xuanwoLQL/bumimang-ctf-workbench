# 第 17 轮 ·「UI 上点拒绝」补上审批链最后一环 —— 并抓到一个主进程真 bug

> 完成时间：2026-10-13 08:35 · Lane B（renderer + electron）
> 结论：**UI 拒绝按钮这条链通到 markBlocked（两次都拒了、死路也写了），但会话终态没进 blocked ——
> 发现一个主进程真 bug：`SessionManager.prompt()` 把 blocked 覆盖回 idle。** 21/22 断言通过，1 条失败且是确定性复现。

## 一句话

Lane A 的 [VERIFY-concurrency-and-blocked](./VERIFY-concurrency-and-blocked.md) 验过「拒绝 → 退避 → blocked」，
但那是**从队列直接 `queue.decide()`** 的，没人走过真实用户的那条路：

> UI 拒绝按钮 → `decide()` → `ctx.hub.dispatch({type:"approval.decide", decision:"deny"})` → 真实 IPC → 主进程
> `hub.dispatch` → `ApprovalQueue.decide("denied")` → `DenialTracker`（同规则 2 次）→ `markBlocked` → 会话卡画成
> 「被策略切断」。

本轮把这条路在**真实后端、真实 claude、真实窗口、零 mock、零种审批**下完整跑了一遍。结果分两半：

1. **上半段（UI 按钮 → 队列 → DenialTracker → markBlocked）全通，两次拒绝都经真实 DOM 按钮点掉**；
2. **下半段（会话终态 blocked + 会话卡「被策略切断」视觉）没到**——不是渲染层的错，是主进程 `prompt()`
   在 markBlocked 之后把状态又覆盖回了 `idle`。

## 完整链路（两次拒绝都是 UI 真实按钮，不是直接 dispatch）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | `dispatch {type:"session.start", agent:"claude", tier:"guarded"}` | `{ok:true}`，spawn 真实 `claude-agent-acp` v0.89.1 |
| 2 | 等 idle（简报轮） | idle，期间放行 0 条（简报轮只读黑板，规则 `blackboard-tools-are-internal` 直接放行） |
| 3 | `dispatch {type:"session.prompt", text:"创建 demo.txt"}` | `{ok:true}` |
| 4 | 等第一个 pending | **3.0s 后出现**：`Write demo.txt`，rule=`tier-guarded-default` |
| 5 | **点 UI「拒绝」按钮**（第 1 次） | 审批项 → `denied`、`decidedBy=human` |
| 6 | 诱发第二次（claude 转 idle 后发重试 prompt「创建 demo2.txt」） | `Write demo2.txt`，rule=`tier-guarded-default` |
| 7 | **点 UI「拒绝」按钮**（第 2 次） | 审批项 → `denied`、`decidedBy=human`；`[s1] 转 blocked`（markBlocked 执行） |
| 8 | 等会话终态 blocked | **失败**：`sessionStatus=idle`（见下「抓到什么 bug」） |

两次拒绝的 `rule` 都是 `tier-guarded-default`（同规则被连续拒 2 次，正是 §9.6 阈值 2 的语义）。

## 「点拒绝」是怎么点的（不是直接调队列）

脚本里没有 `window.bumimang.dispatch({type:"approval.decide", decision:"deny"})`。它找到渲染出来的审批卡片里的
`[data-act="deny"]` 按钮，对它 `.click()`，走按钮自己的 click 监听器：

```
button[data-act="deny"].click()
  → approval.ts: decide(id, "deny")
  → buildDecideAction → ctx.hub.dispatch({type:"approval.decide", approvalId, decision:"deny"})
  → preload window.bumimang.dispatch → ipcRenderer.invoke("hub:action")
  → 主进程 ipcMain.handle → hub.dispatch → ApprovalQueue.decide(id, "denied")
```

`decidedBy="human"`（两次都是）就是「这条路真的走的是人工拒绝，不是超时拒绝」的硬证据。

## 抓到什么 bug（主进程，Lane A 的 lane）

**现象**：`markBlocked` 执行了（`[s1] 转 blocked`、死路 `scope=blocked` 也写库了），但**会话终态是 `idle`**
（内存 + 库里都是 `idle`），所以左栏会话卡画的是「空闲」，不是「被策略切断」。

**根因**（`apps/desktop/src/main/session/manager.ts`，不是渲染层）：

- `prompt()`（319–332 行）在 `await client.prompt(...)` 之后**无条件**执行 `rec.status = "idle"`；
- 第 2 次拒绝时，`markBlocked()`（381–407 行）在 `prompt()` 还挂着的时候运行：先把状态切成 `blocked`、
  写死路，然后 `client.cancel()`；
- `client.cancel()` 让 claude 以 `stopReason="cancelled"` 结束本轮（wire.jsonl 里 deny #1 是 `end_turn`、
  deny #2 是 `cancelled`，直接可见），于是挂着的 `client.prompt` **resolve** 了；
- `prompt()` 的续体接着跑，把 `blocked` 覆盖回 `idle`，连库里的 `sessions.status` 一起写成 `idle`。

**为什么 Lane A 的 verify:concurrency 没抓到**：那里用的是假 agent，`request_permission` 时它**不在**
`prompt()` 调用里（没有真实 agent 的「prompt 轮 → 中途发权限请求」结构），所以没有这个覆盖竞态。真实 claude
一定会「在 prompt 轮里发权限请求」，所以这个 bug 是真实路径必现的。

**给 Lane A 的修法建议**（我按规矩没动 `src/main`）：

```ts
// manager.ts prompt() 里 await client.prompt(...) 之后：
const res = await client.prompt(rec.acpSession!, text);
if (rec.blocked) {              // markBlocked 在等待期间已把会话切成 blocked（§9.6 拒绝退避）
  this.onSessionChange?.(rec);  // 别用 idle 覆盖；重发当前 blocked 状态即可
  return res.stopReason;
}
rec.status = "idle";
this.board.setSessionStatus(sessionId, "idle");
this.onSessionChange?.(rec);
```

## 渲染层这边是对的（不是我的锅，也不是需要我改的地方）

会话卡「blocked 视觉」在 Lane B 第 6 轮就已验过（`blocked-hostile-verify.ts` 28/28，断言
`.session-item.session-blocked` 存在且徽标文字是「被策略切断」、区别于 `failed`「崩溃」只红字无边框）。
本轮现场也印证：渲染层忠实画了主进程发来的状态——主进程发 `idle`，它就画「空闲」（`sessionCardDom.badges`
含「空闲」、无 `session-blocked` 类）。**所以这不是渲染 bug，是主进程发错了状态。**

## 证据

| 文件 | 是什么 |
| --- | --- |
| `docs/logs/ui-deny-blocked.json` | 22 条断言 + 时间线 + 两次 deny 留痕 + 终态 + wire 证据（stopReason 序列） |
| `docs/logs/ui-deny-blocked.png` | 1783×942：会话卡「空闲」+ 台账死路「会话（s1）被策略拦截并终止…」同屏 |
| `.ui-run/verify-ui-deny/board.db` | `sessions.s1.status=idle` + `dead_ends` 一条 `scope=blocked` |
| `.ui-run/verify-ui-deny/sessions/s1/wire.jsonl` | deny #1→`end_turn`、deny #2→`cancelled` 的真实轮次证据 |

wire 证据摘要（脚本已把 1500 行压成关键行）：

```
request_permission  mcp__blackboard__blackboard_read_since   rule=blackboard-tools-are-internal
end_turn                                                     （简报轮）
request_permission  Write demo.txt                            rule=tier-guarded-default
end_turn                                                     （deny #1 后 claude 自然收尾）
request_permission  Write demo2.txt                           rule=tier-guarded-default
cancelled                                                    （deny #2 后 markBlocked 的 cancel 生效）
```

## 怎么复跑

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/ui-deny-blocked.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|step|ALL_PASS|结果"
```

已复跑两次，结果一致（`outcome=two-denies-but-session-not-blocked`），bug 是确定性的，不是 flake。

## 改了哪些文件

```
apps/desktop/electron/ui-deny-blocked.ts   新：真实 claude + 真实 UI 按钮拒绝的端到端验收入口（只 import src/main，不改）
```

没动 `apps/desktop/src/renderer`、没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约 `events.ts`。
没有种任何审批、没有 fake agent。

## 没做什么 / 边界

1. **没修主进程 bug**（`manager.ts` 是 Lane A 的 lane，按规矩不动；已追加 BLOCKED L-4 请 A 修）。
2. **没给「会话卡 blocked 视觉」补任何渲染层 workaround**——那是用渲染层去掩盖主进程发错状态，只会把错误藏得更深。
3. 两次拒绝之间，第 1 次之后 claude 是自然转 idle 的（`end_turn`），然后我用第二个文件（demo2.txt）诱发第 2 次——
   这**不是**种审批，两条 `request_permission` 都是 claude 真实发来的（wire.jsonl 可查）。
4. 每次运行独立工作区 `.ui-run/verify-ui-deny` + 独立 userData，不污染 Lane A 的 `.ui-run/board.db`。
5. 死路 `scope=blocked` 的「台账面板渲染」本轮已顺带验证（`boardDeadEndsDom` 含「被策略拦截」），
   但「会话卡 blocked 视觉端到端」要等 Lane A 修完 bug 后，这个脚本重跑一次就能整条变绿（断言已就位，无需改脚本）。
