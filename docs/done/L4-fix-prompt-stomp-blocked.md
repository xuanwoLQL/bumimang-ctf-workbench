# L-4 修复：`prompt()` 把 blocked 覆盖回 idle

> 完成时间：2026-10-13 08:42

## 做了什么

Lane B 第 17 轮补"UI 上点拒绝"这条链时抓到一个**只在这条真实路径上才出现的竞态**，根因在我的代码里。

### 现象

真实 claude 会话里，人在 UI 上连点两次「拒绝」（同规则 `tier-guarded-default`）：

- `DenialTracker` 到阈值 → `markBlocked` **确实执行了**（日志有 `[s1] 转 blocked`，库里也写了 `scope=blocked` 死路）
- **但会话终态是 `idle`**（内存与 `sessions` 表都是），左栏会话卡因此画「空闲」而不是「被策略切断」

### 根因

权限请求发生在 **prompt 轮内部**。第二次拒绝触发 `markBlocked` 时，`prompt()` 里那个 `await client.prompt(...)` 还挂着；`markBlocked` 的 `client.cancel()` 让本轮以 `stopReason="cancelled"` 结束，挂着的 promise 随即 resolve，然后 `prompt()` 的续体**无条件**执行 `rec.status = "idle"` —— 把 `blocked` 覆盖掉，连库里的状态一起写坏。

### 为什么合成测试抓不到

`verify:concurrency` 里的假 agent 不在 `prompt()` 调用中（它没有"prompt 轮 → 中途发权限请求"这个结构），所以没有这个覆盖竞态。**真实 claude 必现**（Lane B 复跑两次结果一致，确定性 bug）。

这是本夜第二个"只有真实路径才暴露"的 bug（第一个是 L-3 黑板不可达）。共同点：**合成 fixture 缺了真实场景里的时序结构**。

### 修法

用**终态集合**兜住，而不是特判 `blocked`：

```ts
const TERMINAL = ["blocked", "stopped", "failed", "done"];
if (TERMINAL.includes(rec.status)) {
  this.log(`[${sessionId}] 本轮结束时已是终态 ${rec.status}，不覆盖回 idle`);
  this.onSessionChange?.(rec);
  return res.stopReason;
}
```

为什么用集合而不是 `if (rec.blocked)`：**同一类覆盖对 `stopped` 与 `failed` 一样成立**（任何在 prompt 轮中途把会话置为终态的路径都会踩），特判一个只是把地雷留在别处。

## 改了哪些文件

```
apps/desktop/src/main/session/manager.ts   prompt() 落 idle 前先检查是否已是终态
docs/BLOCKED.md                            L-4 标记为已闭合（附证据与关闭时间）
```

## 怎么验证的

Lane B 留的验收脚本（**断言已就位，修完无需改脚本**）：

```powershell
cd D:\agent\xuanwo
Get-Process electron | Stop-Process -Force
node_modules\electron\dist\electron.exe apps\desktop\electron\ui-deny-blocked.ts --no-sandbox 2>&1 |
  Out-File docs\logs\ui-deny-rerun.log -Encoding utf8
```

真实输出（**全 PASS**，修复前那一条 FAIL）：

```
PASS  本机有可用的 claude 适配器
PASS  快照里出现 claude 会话  — id=s1 status=running
PASS  快照里有一条 pending 审批  — id=ap-472e8476
PASS  这条 pending 是本轮 prompt 触发的（createdAt 在 prompt 派发之后）
PASS  第 1 次拒绝：UI「拒绝」按钮被真实点击（DOM .click()）  — label="拒绝"
PASS  第 1 次拒绝：审批项变成已拒绝且由 human 决定  — decidedBy=human
PASS  第 2 次拒绝：UI「拒绝」按钮被真实点击（DOM .click()）
PASS  会话终态是 blocked（不是 failed/stopped）  — status=blocked        ← 修复点
PASS  台账多了一条 scope=blocked 的死路  — desc=会话（s1）被策略拦截并终止：同一规则被连续拒绝 2 次（tier-guarded-default）
PASS  没有 scope=incident 的崩溃死路（blocked ≠ 崩溃）
PASS  会话卡带 session-blocked 类（红边框视觉）  — hasBlockedClass=true
PASS  会话卡不带 session-failed 类（不是崩溃视觉）  — hasFailedClass=false
PASS  会话卡徽标文字是「被策略切断」（不是「崩溃」）  — blockedText="被策略切断"
PASS  台账面板渲染出该死路（含「被策略拦截」）
```

回归：`npm run verify:concurrency` 仍 15/15（同一类链路的合成版没被改坏）。

## 没做什么 / 已知问题

1. **只修了 `prompt()` 这一处。** 同类"后到的续体覆盖先前终态"的风险在其他异步续体里没系统排查（例如 `sendBriefing` 走的就是 `prompt()`，所以覆盖到了；但 `HubService.dispatch` 里那几个 `.then()` 回调没有同样保护）。**这是治标**——真正的解法是给状态转移加一层"终态不可逆转"的守卫。
2. **测试覆盖的不对称仍在**：这条路只有 Lane B 那个脚本能验（需要真实 claude + 真实窗口 + 真人点按钮），没法进 `verify:concurrency` 那样的秒级回归。所以它容易在后续改动里悄悄退化。
3. **`blocked` 之后 agent 的进程是否真的退出**依然没验（之前也记过）。
4. **没查"同一规则"的判定是否过宽。** 两次拒绝命中的都是 `tier-guarded-default`（档位兜底，不是具体规则）。也就是说：一个受控档会话里，**任何两个不命中具体规则的权限请求**都会被算作"同一规则"，累计到 2 次就终结会话。这可能是过于激进的——真实使用中一个受控档会话很容易连问两次不同的事，然后被终止。**这是我引入的设计缺陷，值得单独讨论。**

## 下一手需要什么

- 第 4 条值得优先看：`tier-guarded-default` 作为"规则 id"参与退避计数，会把"两次不同的无害询问"也当成重复违规。可能需要给档位兜底一个不计入退避的标识。
- 第 1 条：把"终态不可逆转"做成一个统一的守卫，而不是每个续体各自记得检查。
