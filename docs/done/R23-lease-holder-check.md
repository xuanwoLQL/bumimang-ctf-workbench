# R23 · A2 租约 holder 校验（Codex 评审第 1 条）

**日期**：2026-10-20 17:13 · **范围**：`src/main/blackboard/board.ts`、`src/cli/verify-history.ts`

## 做了什么

Codex 评审 A2：`releaseLease()` 只按 resource 删除、不校验 holder——**任何知道资源名的会话都能放掉别人的租约**（验真属实）。修法：

- `releaseLease(resource, sessionId, reason)`：`sessionId !== null && cur.holder !== sessionId` 时返回 false，不动租约。
- `sessionId = null` 保留旁路（系统清理路径：重启收尾 `releaseAllLeasesOf` 走的是内部 DELETE，不走这个入口；null 旁路留给系统级调用）。

## 改了哪些文件

- `board.ts`：releaseLease 加 holder 校验（1 个条件）
- `verify-history.ts`：+4 条断言（非 holder 拒绝 / 租约仍握在原 holder / 本人可放 / null 系统旁路）

## 怎么验证的

```powershell
node apps/desktop/src/cli/verify-history.ts     # 72/72（+4：A2 四场景）
npm run verify:all                              # 49+16+17+19+72+110 = 283 + smoke，exit=0
```

真实输出（新增断言）：
```
PASS  非 holder 不能放掉别人的租约  — actual=false expected=false
PASS  租约仍握在原 holder 手里  — actual="s1" expected="s1"
PASS  holder 本人可以放  — actual=true expected=true
PASS  系统路径（sessionId=null）保留旁路  — actual=true expected=true
```

## 没做什么 / 已知问题

- **A2 的另一半（租约全局主键跨任务互斥）没动**：`leases.resource` 仍是全局 PRIMARY KEY，两个任务抢同一个 `target:host` 仍会互斥。这是语义选择（全局互斥 vs 任务内互斥），Codex 建议改 (task_id, resource) 复合键——那要动 SQLite 迁移、MCP 参数与 LeaseView 契约，且会改变「资源唯一」的语义。留到 A1（任务隔离）那轮一起定，本轮只修了无争议的 holder 校验。
- MCP 侧的释放请求仍依赖请求体里的 sessionId（A7 连接绑定未做前，伪造 sessionId 可绕过校验）——这正是 R25 的活，按计划随后做。

## 下一手需要什么

无阻塞项。下一轮 R24：P2 收敛机制（首答 → 宽限 → 收尾其余会话）。
