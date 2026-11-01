# R-1 策略包进契约 + §9.6 拒绝退避与 blocked

> 完成时间：2026-10-13 01:35

## 做了什么

两件事，都由 Lane B 的反馈驱动：

**1. 落实 Lane B 的请求 R-1**：`HubSnapshot` 增加可选字段 `policy?: { packId, name, fellBackToMinimal }`。渲染进程在 `contextIsolation` 下拿不到主进程 stdout，也读不到 `BUMIMANG_RULES` 环境变量，所以"当前生效的是哪个规则包"只能靠快照带过去。Lane B 已经留好 UI 槽位（缺席显示「—」），填上之后徽标自动变真实包名。

**2. 补 §9.6 的拒绝退避与 `blocked` 终态**。之前拒了只回 `cancelled` 就完事——如果 agent 原样重试同一条命令，人工会被反复打断，那个会话也永远在原地打转。现在：

- `DenialTracker` 按「会话 + 规则」计数，同一条规则被拒 2 次就触发终止
- `SessionManager.markBlocked()` 把会话转 `blocked` 终态、写一条 `scope=blocked` 的死路、cancel + close + kill 进程
- **`blocked` 与"崩溃"和"人工停止"三者严格区分**：`blocked` 不写崩溃记录（那是误导后续简报的），而是留一条"这条线被规则掐了"的死路

另外踩到一个值得记的约束：**Node 的类型剥离不支持构造函数参数属性**。我在 `DenialTracker` 里写了 `constructor(private readonly threshold: number, ...)`，直接报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`——那种语法需要**代码生成**，而"无 bundler"方案只会**擦除**类型。已改成显式字段赋值，并把教训写进代码注释。

## 改了哪些文件

```
packages/shared-protocol/events.ts           HubSnapshot 加可选 policy 字段（应 R-1）
apps/desktop/src/main/policy/engine.ts       暴露 packId
apps/desktop/src/main/hub/hub.ts             snapshot() 填 policy
apps/desktop/src/main/approval/queue.ts      新增 DenialTracker（§9.6）+ 参数属性教训注释
apps/desktop/src/main/session/manager.ts     SessionRecord.blocked + markBlocked()，onAgentExit 区分 blocked
apps/desktop/src/main/electron/main.ts       接线 DenialTracker，拒绝时计数
apps/desktop/src/cli/verify-gate.ts          补 8 条退避断言
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:gate           # 纯逻辑 + 退避
npm run verify:gate-live      # 真实 AcpClient 路径
node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
```

真实输出：

```
================ §9.6 拒绝退避与 blocked ================
PASS  第 1 次拒绝只计数、不终止  — actual=1 expected=1
PASS  第 2 次同类拒绝触发终止回调  — actual=2 expected=2
PASS  终止回调收到正确的会话与次数  — [{"sid":"s1","rule":"credential-actions-need-human","n":2}]
PASS  触发后计数归零（重新开始数）
PASS  不同规则各自独立计数  /  PASS 另一个会话不受影响
PASS  reset 清空该会话的全部计数
================ 38/38 通过 ================

npm run verify:gate-live   →  16/16 通过

electron ... --verify：
PASS  快照带上了当前策略规则包（应 Lane B 请求 R-1）  — pack="policy-engine(比赛合规包)" 回落到最小安全集=false
[verify] 10/10 通过
```

## 没做什么 / 已知问题

1. **`blocked` 的端到端没测。** 退避计数与回调有 8 条断言，但"真会话被 markBlocked 之后进程是否干净退出、死路是否留在台账里"没有实测——需要一个会重复被拒的真实 agent 才能验，人工构造不出来（假 agent 只请求一次）。
2. **拒绝的阈值写死在接线处**（`new DenialTracker(2, ...)`），没进配置。规则包里应该能配。
3. **`policy` 是可选字段，但如果哪天忘了填，UI 只会显示「—」而不报错**——这种"静默降级"是隐患。理想做法是 `policy` 设为必填，让类型检查在编译期抓；但当前无 bundler 方案不做类型检查，所以只能靠断言（已加）。
4. **规则包仍不可在运行时切换**，只能改 `BUMIMANG_RULES` 环境变量重启。
5. **Node 类型剥离的语法限制现在有两条已知**：不能有构造函数参数属性（这次踩到）、不能用 `enum`/`namespace`。建议在 `docs/` 里单独记一页，避免两条 lane 反复踩。

## 下一手需要什么

- **HANDOVER.md**（07:00 前必须写）。
- 最大的功能不确定性仍未解决：**真实 agent 会不会触发权限请求**。已记在 `T12-gate-live-and-two-real-bugs.md` 的已知问题 1 里，需要在交接文档里明确告诉用户这是未验证项。
- 无待用户决策事项（R-1 已闭环）。
