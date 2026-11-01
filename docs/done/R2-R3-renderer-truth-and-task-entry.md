# R-2 收尾 + R-3：渲染层改读快照真相、补上「新建 / 切换任务」入口

> 完成时间：2026-10-13 05:09（Lane B，第 12 轮）

## 做了什么

两件事，都在 Lane B 的地盘（`apps/desktop/src/renderer` + `apps/desktop/electron`），没碰
Lane A 的 `src/main`，也没碰冻结契约。

### 1. R-2 收尾：删掉渲染层的硬编码 `AGENT_GATE_NOTE`，改读快照

上一轮 R-2 的契约部分 Lane A 已经落地（`HubSnapshot.agents[].permissionBehavior`，
`detect.ts` 按实测填四家），但渲染层还在用那张过渡的硬编码表。这一轮把它删了：

- `renderer/contract.ts`：本地的 `AgentDescriptor` 镜像补上可选字段 `permissionBehavior?`。
- `renderer/fanout/model.ts`：删掉 `AGENT_GATE_NOTE` 常量，换成纯函数
  `gateNoteFor(behavior)`，把三个枚举值翻成同一套 UI 文案（文案没重写，只换了数据源）：
  - `requests_by_default` → 「写文件 / 跑命令前会主动请求授权（开箱即进审批队列）」
  - `needs_config` → 「默认不请求授权（需配权限策略才有闸门输入）」（opencode / codex 两家合并成这条，因为检测层只报到这个粒度）
  - `unknown` → 「默认会不会请求授权未知（适配器未检测 / 降级模式）」
  - 缺席 / 其它 → `null`（UI 只少一条提示，不报错）
- `renderer/fanout/fanout.ts`：选中 agent 的成熟度一行改读 `a.permissionBehavior`。

「选哪个 agent」的静态行为提示（弹窗里那段「当前只有 Claude Code 开箱会问…」）保留原样。

### 2. R-3：新手终于能把自己的真任务换掉自动种下的示例任务

主进程冷启动自动 `createTask("示例任务：本地 HTML 目标")` 这个事实**没动**——只是让它变得可替换。

- `renderer/task.ts`（新文件）：`openTaskModal(ctx)` 弹一个最小表单，标题 + 简报
  （brief 是重点，因为会注入每个会话的简报包），派发契约里早就有、却一直没有 UI 调用的
  `{ type: "task.create", title, brief }`。派发后只管「发出去 + 反馈」，**不改 store**——
  新任务成为当前任务这件事由 Lane A 的 hub 完成（`setTask` + 推 `task.upsert`），渲染层只
  消费那条事件，避免两份真相。
- `renderer/main.ts`：左栏任务卡面板标题旁加一个「＋ 新任务」小按钮（有任务 / 无任务两个
  分支都有），点开上面的表单。
- `renderer/styles.css`：任务卡头部布局 + 表单弹窗样式（沿用全局 `--bg-*` / `--border` 变量）。

## 改了哪些文件

```
apps/desktop/src/renderer/contract.ts                 AgentDescriptor 补 permissionBehavior?（镜像契约）
apps/desktop/src/renderer/fanout/model.ts             删 AGENT_GATE_NOTE → gateNoteFor(behavior)
apps/desktop/src/renderer/fanout/fanout.ts            选中 agent 的闸门行为提示改读快照
apps/desktop/src/renderer/task.ts                     （新）新建 / 切换任务弹窗
apps/desktop/src/renderer/main.ts                     左栏任务卡加「＋ 新任务」入口
apps/desktop/src/renderer/styles.css                  任务卡头部 + 表单弹窗样式
apps/desktop/electron/cold-start-verify.ts            断言升级到新数据源 + 新增 R-3 断言
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/cold-start-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|ALL_PASS|FAILED|shot"
```

**cold-start-verify 28/28 ALL_PASS**（上一轮 20 条，本轮 +8：1 条快照 permissionBehavior、
2 条扇出行为提示来自快照、5 条 R-3 建任务）。关键输出：

```
PASS  R-2：快照带 permissionBehavior（claude=会问 / opencode+codex=需配置 / dsh=unknown）
      └─ behavior={"opencode":"needs_config","codex":"needs_config","claude":"requests_by_default","dsh":"unknown"}
PASS  R-2：默认选中的 opencode 带「默认不请求授权」（needs_config，来自快照）
PASS  R-2：选中 claude 带「主动请求授权」（requests_by_default，来自快照）
PASS  R-3：新建任务后 snapshot.task 换成新任务（id 变化，标题/简报正确）  └─ id task-77795339 → task-eed73f23
PASS  R-3：左栏任务卡同步重绘出新标题与新简报  └─ title="真任务：10.0.0.13 门户打点"
PASS  R-3：新任务状态中文化（open → 待解）  └─ status="状态：待解"
```

证据：`docs/logs/cold-start.json`（`"pass": true`）+ 截图 `docs/logs/cold-start.png` /
`docs/logs/cold-start-task-created.png`。

回归：`render-verify`（mock 路径）14/14 ALL_PASS、`smoke` ALL PASS——改动没弄坏 mock 回落的
UI 链路（mock 快照里 agents 没有 permissionBehavior，`gateNoteFor` 返回 null，扇出详情少一条
提示，属预期静默降级）。

## 没做什么 / 已知问题

1. **`needs_config` 是两家 agent 共用一个文案。** 旧硬编码表里 opencode 写「需配
   permission.edit / permission.bash」、codex 写「需配沙箱 / 审批策略」，检测层只报
   `needs_config` 这个粒度，渲染层就只说「需配权限策略」。要恢复更细的指引得让检测层再报
   一个字段（属 Lane A / 契约）。
2. **`unknown`（dsh）的文案从旧表的「默认不请求授权」改成了「未知」。** 这是对的：契约
   明说没测过，旧表那句「默认不请求授权」其实没依据。且 dsh 未安装时 UI 显示的是安装提示，
   这条文案只在它被装上后才可见。
3. **「切换」≈「新建」。** 快照里只有当前任务（`HubSnapshot.task` 单数，没有任务列表），
   契约也没有 `task.switch`，所以「换题」的最小实现就是新建一个任务、让它成为当前任务。
   真要「在多个历史任务间来回切」需要契约加任务列表 + `task.switch` 动作，超出本轮范围。
4. **自动种示例任务这一行为没动。** 按指令保留；如果认为该行为本身不对，会在 BLOCKED 里说，
   而不是自己改。

## 下一手需要什么

- 无待用户决策事项。
- 若要恢复 opencode / codex 各自的配置指引，走 docs/requests/ 给 `permissionBehavior` 补粒度。
