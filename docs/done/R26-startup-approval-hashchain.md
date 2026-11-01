# R26 · A3+A4+A6（启动回滚 / 审批落库与语义 / 哈希链修正）

**日期**：2026-10-20 17:34 · **范围**：`src/main/session/manager.ts`、`src/main/hub/hub.ts`、`src/main/approval/queue.ts`、`src/main/blackboard/board.ts`、`src/main/electron/main.ts`、`src/cli/{fake-agent,verify-history,verify-r18,verify-gate,verify-gate-live,verify-concurrency-and-blocked}.ts`、6 个 electron 套件的审批消费点

## 做了什么

Codex 评审三条一次收口：

**A3 启动失败回滚**：`startSession` 从 spawn 到握手（initialize / session/new / set_config_option）全程包 try/catch + 每步握手带超时（`withStartupDeadline`，`BUMIMANG_START_TIMEOUT_MS` 默认 30s，按调用时读环境变量）。失败（含超时）→ `rollbackStart`：库里标 failed、内存撤记录、杀进程、关 wire/stream 句柄，重新抛出。`hub.dispatch(session.start)` 捕获后：若该任务已无活跃会话且状态是「解题中」，退回「待解」——不再有「任务解题中但一个会话都没有」的悬空状态。fake-agent 新增 `FAKE_HANG_INIT`（永不应答 initialize）与 `FAKE_PID_FILE`（写自身 pid 供断言进程真死）。

**A4 审批落库与语义**：
- `ApprovalQueue.request()` 返回值从裸 `Decision` 改为 `ApprovalOutcome { decision, decidedBy: "human" | "policy" }`——**超时（policy 兜底）不再被消费方当人工拒绝累计退避**，之前两次超时就能把会话误 markBlocked。main.ts 只对 `decidedBy === "human" && decision === "denied"` 计数。
- 新增 `onPersist` 回调，main.ts 接 `board.upsertApproval()`：请求创建/人工裁决/超时/清场四类变化都 `INSERT OR REPLACE` 进 approvals 表，并写一条 `kind=approval` 的黑板事件（有哈希链 + 审计索引）——重启后能回答「谁批准了什么」。
- 修了一个刚引入又被测试抓到的真 bug：构造函数 opts 合并的 Pick 漏了 onPersist，回调被静默丢弃（verify-history 断言当场抓到，改 Pick 类型 + 赋值）。

**A6 哈希链**：
- witness 纳入哈希输入（`ts|session|kind|subject|witness|body`）——改 witness 不再能不断链。历史库旧链按新算法不可校验（当前没有链校验器，接受）。
- `tx()` 快照 lastHash，ROLLBACK 时恢复——事务失败不再留下指向不存在事件的链尾。

## 改了哪些文件

- 主进程：`manager.ts`（withStartupDeadline/rollbackStart/try 包裹）、`hub.ts`（session.start 失败退回任务状态）、`queue.ts`（ApprovalOutcome + onPersist）、`board.ts`（upsertApproval + tx 恢复 + witness 入哈希）、`main.ts`（onPersist 接线 + 只计人工拒绝）
- 测试：`fake-agent.ts`（+2 开关）、`verify-history.ts` 80→**90**（A4 落库四态 + A6 回滚接链/全链一致）、`verify-r18.ts` 121→**129**（partStartFail：超时失败/回滚/任务退回/进程真死）、`verify-gate.ts` 49→**52**（outcome 三态）、`verify-gate-live.ts`、`verify-concurrency-and-blocked.ts`、6 个 electron 套件审批消费点适配（cold-start/r13/real-approval/real-board/real-parallel/ui-deny-blocked）

## 怎么验证的

```powershell
node apps/desktop/src/cli/verify-history.ts     # 90/90（+10）
npm run verify:r18                              # 129/129（+8：H 节启动回滚全链）
npm run verify:gate                             # 52/52（+3：outcome 三态）
npm run verify:gate-live                        # 16/16
npm run verify:all                              # 52+16+17+19+90+129 = 323 + smoke，exit=0
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify   # 19/19
node_modules\electron\dist\electron.exe apps\desktop\electron\cold-start-verify.ts --no-sandbox        # ALL_PASS
```

真实输出（H 节节选）：
```
PASS  握手超时 → dispatch 返回失败
PASS  错误信息含超时字样  — 启动超时：initialize 超过 500ms（s1）
PASS  内存里没有幽灵会话  — actual=0 expected=0
PASS  库里状态标 failed  — actual="failed" expected="failed"
PASS  任务状态退回待解（不是解题中）  — actual="open" expected="open"
PASS  挂起的 agent 进程已被杀  — pid=22036
```

## 没做什么 / 已知问题

- **A6 的「appendEvent 之后失败」分支只能靠防御代码保证**：当前所有公共 API 都是「先 INSERT 后 appendEvent」，没有 appendEvent 之后再失败的可达路径（测试用重复主键制造了真回滚，验证的是 tx 级恢复机制本身）。已如实写在断言注释里。
- **审批历史不恢复到 UI**：落库了（approvals 表 + 事件），但重启后 ApprovalQueue 不重放历史——UI 审批面板重启后是空的。要恢复需要队列初始化时读库，留待需要「审批历史回看」时做。
- **启动超时的默认 30s 未在真实 agent 上校准**：claude/opencode/codex/dsh 冷启动耗时各异，30s 是拍的。若真实使用中误杀慢启动的 agent，调 `BUMIMANG_START_TIMEOUT_MS`。
- 真实 agent 回归（verify:mcp-live 等）仍按约定未跑（烧 token），协议形状变化已由假 agent 套件覆盖。

## 下一手需要什么

无阻塞项。下一轮 R27（最后一轮）：A1 任务级工作目录。
