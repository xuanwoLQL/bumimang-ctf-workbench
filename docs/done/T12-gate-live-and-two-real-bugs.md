# T12 闸门活体验收 —— 抓到两个会带病上线的真 bug

> 完成时间：2026-10-13 01:05

## 做了什么

上一轮的 T3/T4 验收是**纯逻辑测试**（30/30 全过），但它证明不了"客户端真的会把 agent 的权限请求接进闸门"。这一轮补上了这个缺口：用一个**假 ACP agent**（走真实 stdio 通道）发一条 `session/request_permission`，让真实的 `AcpClient` 代码路径处理它。

**结果抓出两个真 bug，两个都足以让"比赛合规"这件事失效：**

### Bug 1：C2 硬阻断规则根本没生效

`rules/competition.json` 里那条 `no-c2-tools` 匹配的是 `action: "terminal/exec"`。但 `probe:delegate` 已经实测过：**三家 agent 都不发 `terminal/exec`**，C2 命令是以 `session/request_permission` 进来的。所以这条规则是死的——一条 `cobaltstrike-client.exe --connect ...` 不会被 block，只会落到档位兜底进审批队列。

换句话说：**那条为比赛合规准备的硬阻断，写了个永远匹配不上的 action。** 测试跑出 `被 block 时不进审批队列 — actual=1 expected=0` 才暴露出来。

修法：补一条 `no-c2-tools-via-permission`，匹配 `session/request_permission` + `text_regex`。原来的 `terminal/exec` 版本保留（对有委托能力的 agent 仍然有效）。`dev.json` 同样修了。

### Bug 2：硬阻断回给 agent 的是 JSON-RPC error，不是 ACP 的 `cancelled`

`decide()` 在判定为 block 时抛异常，异常穿透 `requestPermission` → `handleClientRequest` → 被 `dispatch` 的 catch 兜住，回给 agent 一个 **JSON-RPC error**。但 ACP 规定：客户端不放行时应当返回 `{outcome:{outcome:"cancelled"}}`，这是**合法的协议响应**；回协议错误会让 agent 以为会话坏了。

修法：拆成两个方法——`evaluate()` 只判定不抛错，`decide()` 在其上加抛错。`terminal/*`、`fs/*` 用 `decide()`（我们自己执行，拦下就该报错），`session/request_permission` 用 `evaluate()`（不放行也必须是正常响应）。

### 其他取舍

- **假 agent 走真实 stdio，不是 mock 客户端。** 这样测的是 `AcpClient` 真实的 NDJSON 解析、`dispatch` 的请求/通知分流、`handleClientRequest` 的分发——而不是复述一遍逻辑。
- **三个场景覆盖三种结局**：人工放行 → `selected` + 挑到 `allow` 语义的 option；人工拒绝 → `cancelled`；硬阻断 → `cancelled` 且**从未进队列**。

## 改了哪些文件

```
apps/desktop/src/cli/fake-agent.ts        假 ACP agent（握手 + 主动发权限请求 + 写回结果）（新）
apps/desktop/src/cli/verify-gate-live.ts  闸门活体验收：三场景 16 条断言（新）
apps/desktop/src/main/acp/client.ts       evaluate()/decide() 拆分，修 Bug 2
rules/competition.json                    补 no-c2-tools-via-permission，修 Bug 1
rules/dev.json                            同上
package.json                              新增 npm run verify:gate-live
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:gate-live
npm run verify:gate         # 回归，确认拆分没弄坏纯逻辑
```

真实输出（**16/16**）：

```
========== 闸门活体验收（真实 AcpClient 路径 + 假 agent）==========

---------- 场景：凭据类动作，人工放行 ----------
PASS  假 agent 完成握手并建立会话  — acpSession=sess-fake-1
PASS  权限请求真的到达了审批队列（挂起等人工）  — upsert=1
PASS  待批项状态为 pending
PASS  命中策略规则可追溯
PASS  中栏拿到了自述意图  — 假 agent 说：我要执行一条命令
PASS  放行后 agent 拿到的 outcome 是 selected
PASS  并且挑的是 allow 语义的 option  — actual="allow-once"

---------- 场景：凭据类动作，人工拒绝 ----------
PASS  权限请求真的到达了审批队列（挂起等人工）  — upsert=1
PASS  拒绝后 agent 拿到的 outcome 是 cancelled

---------- 场景：C2 工具命令（硬阻断） ----------
PASS  被 block 时不进审批队列（没有放行按钮这条路）  — actual=0 expected=0
PASS  硬阻断后 agent 拿到的 outcome 是 cancelled（且从未进队列）

========== 16/16 通过 ==========
```

回归：`npm run verify:gate` → **30/30 通过**（拆分没弄坏纯逻辑）。

## 没做什么 / 已知问题

1. **仍然没有用真实 agent 触发过权限请求。** 这一轮的假 agent 只证明了**接线正确**；"真实模型会不会/A会不会请求权限"依旧未知，且大概率取决于 opencode 自己的 `mode` 配置（它 `build` 模式下"based on configured permissions"，配置在 `opencode.json` 里，我们看不到也改不动）。**这是雏形最大的功能不确定性。**
2. **Bug 1 的教训没有系统性防护。** 同类的死路径规则以后还会写错（比如给 `fs/write` 写规则）。建议加一条断言：**规则包里的每条规则的 `action`，必须在某个实测存在的 action 集合里**，否则告警。
3. **§9.6 的 `blocked` 状态与退避计数仍未实现。** 现在拒绝只回 `cancelled`，agent 如果原样重试，我们不会升级处置。
4. **审批的 `target` 字段对真实 agent 基本是 null**（opencode 的 `rawInput` 结构不固定）。假 agent 里我填了 `rawInput.command` 才拿到。真实场景下左栏会缺目标。
5. **`_comment` 字段塞进了规则对象里**（`competition.json`），能跑但是脏数据；正统做法是规则包顶层放 `notes`。

## 下一手需要什么

- 若还要继续验真实链路：起真实会话 + **把规则包换成"任何 request_permission 都 approve"**，提示 agent 去跑明显需要授权的事，看它到底会不会请求。若它始终不问，那结论是**在这台机器的 opencode 配置下，闸门形同虚设**——这个结论必须写进交接文档，因为它直接决定产品的可用性叙事。
- 真实窗口的端到端截图（Lane B 已拍三张：`real-bridge-{empty,started,approvals}.png`）。
- 写 `docs/HANDOVER.md`（07:00 前必须完成）。
