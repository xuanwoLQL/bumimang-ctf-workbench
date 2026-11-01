# 补两个验证缺口：并发抢租约、blocked 终态端到端

> 完成时间：2026-10-13 08:06

## 做了什么

交接文档 §5 排第一的未验证项写着两条：`waiting_lease` 并发抢租约、`blocked` 终态端到端。都补掉了，**15/15 通过**。

**A. 并发抢租约。** M1 验过"租约能拿能放、崩溃会释放"，但没验过并发。20 个会话同时抢同一个资源 → **恰好 1 个 WON、19 个 LOST**，库里只留一条租约。原因是结构性的：`acquireLease` 走主进程的串行写队列，SQLite 事务做 CAS，资源是主键——竞态在设计上就不存在。现在这条有了断言。

**B. `blocked` 终态端到端。** 这条之前验不了的原因是**没有 agent 会重复发同一个权限请求**，造不出"同规则被拒两次"的场景。给假 agent 加了 `FAKE_REPEAT` 之后就能造了。验到的东西：

- 两次拒绝 → `DenialTracker` 触发 → `markBlocked()`
- 会话终态是 **`blocked`**（不是被覆盖成 `failed` 或 `stopped`）
- 库里也持久化为 `blocked`
- 留了一条 **`scope=blocked`** 的死路，让队友知道这条线是被规则掐的（而不是踩了坑）
- **没有**写"崩溃"记录 —— 这是 §7.7 明确要求的区分，否则会误导后续会话的简报
- 审批队列被清空，没有永久挂起的 pending
- agent 收到了应答（拒绝要回给 agent，否则它会一直等）

## 改了哪些文件

```
apps/desktop/src/cli/fake-agent.ts                          加 FAKE_REPEAT：同一个权限请求发 N 次
apps/desktop/src/cli/verify-concurrency-and-blocked.ts       两段验收（新）
package.json                                                 新增 npm run verify:concurrency
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:concurrency
```

真实输出（**15/15**）：

```
================ A 并发抢租约 ================
PASS  20 个并发抢占里只有 1 个 WON  — actual=1 expected=1
PASS  其余 19 个都是 LOST  — actual=19
PASS  库里只留一条租约，持有者就是那个 WON 的会话  — holder=s1
PASS  LOST 的返回里带了当前持有者（拿不到要知道被谁占着）
PASS  租约表里不会有多条（资源是主键，天然互斥）

================ B blocked 终态端到端 ================
PASS  两次拒绝触发了终止  — s1|credential-actions-need-human
PASS  会话终态是 blocked（不是 failed、不是 stopped）  — actual="blocked"
PASS  库里也记成 blocked
PASS  留了一条 scope=blocked 的死路  — ["会话（s1）被策略拦截并终止：同一规则被连续拒绝（credential-actions-need-human）"]
PASS  没有写崩溃记录（blocked 不是崩溃，不该误导后续简报）  — ["blocked"]
PASS  两次请求各进过一次审批队列（按 id 去重）  — actual=2
PASS  队列里没有待批项（不会永久挂起）  — actual=0
PASS  队列视图里也没有 pending  — ["denied","denied"]
PASS  两次请求的事件里各出现过一次 denied（人工确实拒了）
PASS  假 agent 收到了应答（拒绝要回给 agent）
========== 15/15 通过 ==========
```

## 没做什么 / 已知问题

1. **B 场景里"人工拒绝"是我在回调里立刻点的**，不是通过 UI 的 `approval.decide`。也就是说：**队列 → 拒绝 → 退避 → blocked 这条链验了；UI 上点拒绝按钮 → 同样结果这条没验**（Lane B 的审批 UI 有它自己的断言，但两条没接在一起测过）。
2. **第一次跑这个测试时我写出两个错的断言**，都值得记：
   - 我在审批回调里 `await queue.request(...)`，却**没有人去点拒绝**，所以每次都等 8 秒超时；而阈值是 2，只超时一次不够 → 看起来像产品没生效。**教训：测"人工拒绝"必须真的调用拒绝，不能指望超时替代。**
   - 我用 `upserts` 数组断言"没有 pending"，但它其实是**事件日志**（同一条会记 pending 与 denied 两次）。**教训：事件日志不是状态视图；断言状态要看队列自己（`pendingCount()` / `list()`）。** 这两条与昨晚"测有没有发生要挂在最早的观测点"是同一类错误——**搞错了自己在断言什么**。
3. **并发只测了 20 个同进程的调用**，不是 20 个真实 agent 会话。跨进程（容器 worker 模式）的并发没测——不过当前架构里黑板写入本来就串行在主进程，跨进程不适用。
4. **租约续期（renew）与过期回收在并发下没测。** 只测了首次抢占。
5. **`markBlocked` 之后的进程退出只验了"终态正确"，没验"进程真的没了"。** 测试里没检查 PID 是否存活。

## 下一手需要什么

- 把"UI 上点拒绝"与这条链接起来测（第 1 条）——需要 Lane B 的配合。
- 若要更彻底：验 `markBlocked` 后进程确实退出（第 5 条）。
- 无待用户决策事项。
