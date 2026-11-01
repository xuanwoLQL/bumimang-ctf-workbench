# L-4 续：退避计数改用"请求内容签名"，不再按策略规则 id

> 完成时间：2026-10-13 08:44

## 做了什么

修掉一个**我自己引入的设计缺陷**（在 L-4 的完成文档里记过，这里落地）。

### 缺陷是什么

`DenialTracker` 的计数键是 `${sessionId}|${rule}`，而 `rule` 传的是**策略规则 id**。问题在于：受控档下**不命中任何具体规则**的请求，rule id 全都是档位兜底 `tier-guarded-default`。于是

> 一个受控档会话里，只要人拒了两件**互不相干**的事——比如"读这个文件"和"跑那条命令"——就会被算成"同一规则被拒两次"，**会话直接被终结**。

这不只是理论风险：Lane B 第 17 轮的真实运行里两次拒绝命中的都是 `tier-guarded-default`，也就是说**那条测试本身就跑在这个缺陷上**。它当时没暴露是因为脚本刻意让两次拒绝针对同一件事（都是"写文件"）。

### 修法

改按**请求内容签名**计数：

```ts
export function approvalSignature(detail: Record<string, unknown>): string {
  const keys = ["title", "command", "path", "target", "kind"];
  // 取有值的字段拼起来，规范化空白，截断到 120 字符
}
```

调用方 `electron/main.ts` 改成 `denials.note(sessionId, approvalSignature(detail) || decision.rule)`——签名拿不到时退回 rule id，保证不会因为空签名而"永远不触发"。

**为什么这才是对的口径**：§9.6 想拦的是"**同一个动作被拒了还在试**"，判断依据自然是动作本身，而不是它恰好落在哪条规则上。规则是策略视角，签名是行为视角。

顺带把阈值做成可配：`BUMIMANG_DENIAL_THRESHOLD`（默认 2）。

## 改了哪些文件

```
apps/desktop/src/main/approval/queue.ts   新增 approvalSignature()，并给 note() 的参数名补了历史遗留说明
apps/desktop/src/main/electron/main.ts    计数改用签名；阈值可配置；markBlocked 的文案改成"同一动作"
apps/desktop/src/cli/verify-gate.ts       新增 8 条断言（41 → 49）
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:gate
npm run verify:concurrency
```

真实输出（**49/49**，新增的 8 条）：

```
PASS  同一个请求内容 → 同一个签名  — a=read /etc/hosts a2=read /etc/hosts
PASS  不同的请求内容 → 不同签名  — a=read /etc/hosts b=run echo hello
PASS  签名非空（拿不到字段时退化成整体 JSON）  — len=15
PASS  受控档兜底场景：拒第 1 件不同的事 → 计数 1
PASS  再拒第 2 件**不同**的事 → 仍是计数 1（不该被当成重复违规）
PASS  此时没有触发终止（这正是修掉的那个 bug）
PASS  但同一件事再被拒一次 → 计数 2 并触发
PASS  触发回调收到该会话与该签名
================ 49/49 通过 ================
```

回归：`npm run verify:concurrency` 仍 **15/15**。

## 没做什么 / 已知问题

1. **签名的粒度是启发式的。** 取 `title/command/path/target/kind` 五个字段拼串后截断 120 字符——如果 agent 每次请求的 title 里带一个变化的 id（比如临时文件名），同一件事会被算成不同签名，于是**永远不会触发退避**。这是与"误触发"相反的失败模式，同样得留意（偏保守，不会误杀会话，但可能让退避失效）。
2. **没测 `BUMIMANG_DENIAL_THRESHOLD` 的非默认值**，只确认了默认 2 的行为。
3. **Lane B 那个真实 UI 脚本没重跑**（它要真实 claude + 真实窗口，几分钟）。这次改的是"计数键"，`verify:gate` 已覆盖；真实路径的完整性等下次改动一起跑。
4. **`approvalSignature` 只挑五个已知字段**，opencode 的 `rawInput` 结构不固定，未来可能需要把 `rawInput` 也纳入签名（现在没有，是刻意保守：rawInput 往往含易变内容）。

## 下一手需要什么

- 第 1 条值得留意：如果实战发现"同一件事反复被拒却始终不终结会话"，先查签名是否被易变字段打散了。
- 若要更稳：把签名改成"去掉数字与临时路径后再比对"，但这会引入新的误判面，需要数据支撑再改。
