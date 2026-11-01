# T3 + T4 策略引擎 + 审批队列（唯一的事前闸门成立）

> 完成时间：2026-10-13 00:36
> 同 T2/T5/T11 一样，这两个任务在一次集成里落地，合并成一份文档以避免重复的验证输出。

## 做了什么

**「不迷茫」第一次有了真正能拦住 agent 的闸门。** 之前 `policy.ts` 是 `PassthroughPolicy` 占位（全部放行），`session/request_permission` 被自动挑一个"允许"项放行——人工完全没参与。现在这条链是：

```
agent 发 session/request_permission
  → 策略引擎按规则包判定（block / approve / allow）
  → block：直接抛错返回，不可放行
  → approve：进审批队列，agent 阻塞在这一步等人工
  → 人工在 UI 上放行/拒绝 → 结果回传 agent
```

几个关键取舍：

- **规则包用 JSON，不是文档示例里的 YAML。** YAML 要引 js-yaml，而规则包是纯数据、格式可换；不引依赖更符合 C8（队友机器开箱可用）。这是对 ARCHITECTURE §9.3 的**有意偏离**，引擎逻辑不受影响，将来要换 YAML 只需加一层解析。
- **`block` 不经过审批队列。** 它在引擎里直接抛出，**没有"放行"按钮这条路**——机制写死在引擎里，哪些规则进 block 才是数据。这是 §9.3 的核心区分。
- **档位兜底放在引擎里。** §9.2 第 4 步说"无规则命中时按档位兜底"，所以 `PolicyRequest` 加了 `tier`，受控档一律转人工、自主档放行。这样"受控档"才真的受控，而不是只写在 UI 标签上。
- **会话级覆盖是追加不是替换。** `addSessionRule()` 前插一条，不影响包内其他规则，也不外溢到别的会话（有断言）。
- **超时默认拒绝。** 人工不管的话，安全侧倒向拒绝而不是放行。

## 改了哪些文件

```
rules/competition.json                      比赛合规包（4 条规则，含 C2 硬阻断）
rules/dev.json                              开发包
rules/redteam.json                          常规红队包
apps/desktop/src/main/policy/engine.ts      规则包加载 + 匹配 + 档位兜底 + 规则学习 + 最小安全集回落（新）
apps/desktop/src/main/policy/policy.ts      PolicyRequest 加 tier
apps/desktop/src/main/approval/queue.ts     审批队列：异步 / 风险排序 / 批量 / 超时 / 会话清理（新）
apps/desktop/src/main/acp/client.ts         加 onApprovalRequired（approve 时向人工要放行）+ tier
apps/desktop/src/main/session/manager.ts    透传 onApprovalRequired 与 tier
apps/desktop/src/main/hub/hub.ts            审批进快照、approval.decide/bulk 落库、自述意图环形缓冲
apps/desktop/src/main/electron/main.ts      组装 PolicyEngine + ApprovalQueue 并接线
apps/desktop/src/main/blackboard/board.ts   新增 maxSessionSeq()（修 Lane B 报的跨进程 id 撞主键 bug）
apps/desktop/src/cli/verify-gate.ts         T3+T4 验收（30 条断言，不依赖 agent）（新）
package.json                                新增 npm run verify:gate
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:gate
```

真实输出（**30/30 通过**）：

```
================ T3 策略引擎 ================
规则包目录：D:\agent\xuanwo\rules
可用规则包：["competition","dev","redteam"]
PASS  competition.json 能被解析  — 规则条数=4
PASS  引擎加载了真实规则包（没有回落到最小安全集）  — engine.name=policy-engine(比赛合规包)
PASS  C2 工具命令 → block（没有放行按钮这条路）  — actual="block" expected="block"
PASS  凭据类权限请求 → approve（转人工）
PASS  对外网络动作 → approve
PASS  受控档 + 无规则命中 → approve（档位兜底）
PASS  自主档 + 无规则命中 → allow
PASS  会话级追加规则生效  /  PASS 会话级规则不外溢到其他会话
PASS  规则包缺失时回落到内置最小安全集
PASS  最小安全集仍能拦住凭据类

================ T4 审批队列 ================
PASS  请求会把待批项推给 UI（approval.upsert）
PASS  中栏拿到了 agent 自述意图
PASS  凭据类被判为高危
PASS  人工放行后 agent 拿到的结果是 approved
PASS  人工拒绝后 agent 拿到 denied（会回结构化原因）
PASS  超时后默认拒绝（安全侧）  /  PASS 超时项状态标记为 timeout
PASS  批量放行 3 条
PASS  会话被杀时它的待批被清理
PASS  列表把高危排在前面

================ 30/30 通过 ================
```

UI 链路回归（确认新接线没弄坏已有链路）：

```powershell
node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
# [main] 策略引擎已加载：policy-engine(比赛合规包)
# [verify] 9/9 通过
```

## 没做什么 / 已知问题

1. **没有一次真实的 agent 权限请求走完这条路。** 30 条断言全是确定性逻辑验证——**这正是问题**：真实 agent 是否发 `session/request_permission` 取决于模型心情（M1 里 opencode 3 轮发了 12 次，委托探针里只发 `echo` 那次是 0 次）。所以"闸门接线正确"已被证明，"闸门在真实 agent 上真的会被触发"**没有**被证明。这是最重要的待验项。
2. **没有走通"拒绝之后 agent 怎么反应"这条链。** §9.6 要求拒绝回结构化原因 + 同类重试计数 + 连续 2 次转 `blocked`。目前只做到了"回传 cancelled"，`blocked` 状态和退避计数**没实现**。
3. **规则学习只实现了接口，没做端到端验证。** `policy.rememberAllow()` 写进去了，但"记住"之后同类是否真的自动放行，没有断言。
4. **档位不可改。** `session.setTier` 仍是空实现——档位在会话创建时定死。§9.4 说"随时可切换"，没做到。
5. **审批的 `decided_by` 只区分 human/policy**，没有记录是哪个人（单机场景暂不需要）。
6. **风险等级是启发式**（正则匹配 credential/destructive 关键词），不是规则显式声明的字段。规则里应该能直接写 `risk: high`，目前没这个字段。
7. **`ApprovalView.target` 大多为 null**——opencode 的权限请求里 `rawInput` 结构不固定，我没做适配。中栏有意图、右栏有规则，但"左栏的目标"经常是空的。
8. **规则包还没有 UI 可切换/可编辑**，只能改文件 + 重启。

## 下一手需要什么

- **最紧要**：起一个真实会话，让它触发一次权限请求，把 1 和 2 验掉。建议做法：建 `autonomous` 档会话但把规则包换成"任何 request_permission 都 approve"的调试包，然后提示 agent 去跑 `mimikatz`（它大概率会请求权限），观察审批面板。
- **T12 端到端演示**：把"起会话 → 简报注入 → 黑板写入 → 审批出现 → 人工放行"整条链在一张截图里跑出来。
- **`blocked` 状态与退避计数**（§9.6）需要实现，这是"人工边界"的收尾。
- 无待用户决策事项。
