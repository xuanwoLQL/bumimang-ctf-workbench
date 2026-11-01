# R25 · A7 黑板安全边界（按会话令牌 + 连接绑定 + 日志脱敏）

**日期**：2026-10-20 17:23 · **范围**：`src/main/mcp-host/bridge.ts`、`src/main/stream/normalize.ts`、`src/main/session/manager.ts`、`src/cli/verify-history.ts`

## 做了什么

Codex 评审 A7（验真属实：A/B 的 4 个 wire.jsonl 全部含 BUMIMANG_TOKEN）的三个缺口一次收口：

1. **按会话签发令牌**：`BoardBridge` 从「全局一个 token」改为 `sessionTokens`/`tokensByIdentity` 两张表——`envForSession()` 首次调用时给该会话签发随机令牌，同一会话复用。不再存在「拿到一个令牌就能以任意身份连黑板」。
2. **连接绑定身份**：管道 hello 认证时按令牌查出绑定身份（sessionId + taskId），hello 里自称的 sessionId 与令牌不一致也断开；认证后**每次请求的 `params.sessionId` 必须与绑定一致**，否则报「会话身份不匹配」并拒绝——此前认证后信任请求体，拿到令牌的进程可冒充其它会话写黑板。taskId 仍以库里会话归属为准（R17 语义不变，绑定 taskId 只是兜底）。`route()` 的 bound 参数可选：管道请求必传；主进程内部直调（verify-history 的 R17 回归）沿用旧解析路径。
3. **日志脱敏**：`redactSecrets()`（normalize.ts 导出）把 `BUMIMANG_TOKEN=<hex>` 与 JSON 的 `"name":"BUMIMANG_TOKEN","value":"<hex>"` 两种形态统一打成 `BUMIMANG_TOKEN=***`（判据：≥16 位连续 hex；幂等）。应用到 **wire.jsonl 写入**（简报的 mcpServers env 就在 out 消息里）与 **appendStream**（stream.jsonl + 内存历史的 text/title）。旧日志文件不追溯处理。

## 改了哪些文件

- `bridge.ts`：令牌双表 + hello/请求双重绑定校验
- `normalize.ts`：`redactSecrets` 导出
- `manager.ts`：wire 写入与 appendStream 过脱敏
- `verify-history.ts`：+8 条 A7 断言（72→80）

## 怎么验证的

```powershell
node apps/desktop/src/cli/verify-history.ts     # 80/80（+8：双令牌不同 / 错令牌断连 / 冒用 sessionId 被拒 /
                                                #         越权事实未落库 / 绑定身份提交成功 / 三种脱敏形态）
npm run verify:r18                              # 121/121（假 agent 走真实 stdio 的路径不受影响）
npm run verify:all                              # 49+16+17+19+80+121 = 302 + smoke，exit=0
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify   # 19/19
```

真实输出（第 11 节节选）：
```
PASS  按会话签发不同令牌（不再是全局一个）  — 5eb01b… vs 0c17bd…
PASS  错误令牌连接被断开（无 ok 应答）  — []
PASS  请求体冒用其它 sessionId 被拒绝（连接已绑定 s1）  — …"error":"会话身份不匹配（连接绑定 s1，请求声称 s2）"
PASS  冒用被拒后库里没有越权事实
PASS  绑定身份提交自己的事实成功
```

## 没做什么 / 已知问题

- **旧 wire/stream 文件不追溯脱敏**：本轮起新写的才干净；`.ui-run/ab/` 里上一轮 A/B 的四个 wire 日志仍含令牌（本地开发态文件，不随包分发）。
- **BUMIMANG_PIPE/BUMIMANG_SESSION 未脱敏**：管道名与会话 id 不算凭据（令牌才是），保留可读性。
- **真实 agent 回归没跑**：`verify:mcp-live`（claude 真连黑板）会烧 token，本轮未跑——桥协议的兼容性由 verify-history 的管道测试覆盖（hello/读写/身份校验同一条协议路径）。打包态与真实 agent 回归留到收尾统一验。
- MCP 子进程（mcp-host/server.ts）不用改：它从 env 拿令牌与会话 id，协议形状没变。

## 下一手需要什么

无阻塞项。下一轮 R26：A3+A4+A6 合并（启动回滚 + 审批落库 + 哈希链修正）。
