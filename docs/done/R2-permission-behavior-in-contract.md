# R-2：把"哪家 agent 会请求授权"从渲染层硬编码搬进契约

> 完成时间：2026-10-13 05:05

## 做了什么

Lane B 第 11 轮做首次用户 QA 时发现一个信息错位：**整晚最有价值的实测结论**（claude 开箱会请求授权，opencode / codex 默认不问）被硬编码在渲染层的 `AGENT_GATE_NOTE` 表里。它在扇出弹窗里是对的，但**这个知识真正的家是主进程的检测层**——检测层才知道装了哪些 agent、适配器什么状态。

契约 `HubSnapshot.agents[]` 增加 `permissionBehavior?: "requests_by_default" | "needs_config" | "unknown"`，`detect.ts` 按实测填，Hub 带过来。

**这条为什么重要**：它把"选哪个 agent"这个动作与"guarded 档会不会有审批输入"直接连起来了。新手在扇出弹窗里看到的应该是**事实**，而不是渲染层抄的一份笔记——两份知识迟早会不一致。

## 改了哪些文件

```
packages/shared-protocol/events.ts        HubSnapshot.agents[] 加 permissionBehavior（应 R-2）
apps/desktop/src/main/discovery/detect.ts AgentDescriptor 加该字段，按实测填四家
apps/desktop/src/main/hub/hub.ts          snapshot 带过去
apps/desktop/src/main/electron/main.ts    验收断言加一条
```

填的值与依据：

| agent | permissionBehavior | 依据 |
| --- | --- | --- |
| claude | `requests_by_default` | 写文件与跑命令都实测发过 `session/request_permission` |
| opencode | `needs_config` | 写文件、跑命令实测均 0 次；schema 有 `permission` 段可配 |
| codex | `needs_config` | 同上 |
| dsh | `unknown` | 适配器未安装，未测 |

## 怎么验证的

```powershell
cd D:\agent\xuanwo
Get-Process electron | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
```

真实输出（**11/11 通过**，新增的这条在第 6 行）：

```
PASS  快照带上了当前策略规则包（应 Lane B 请求 R-1）  — pack="policy-engine(比赛合规包)" 回落到最小安全集=false
PASS  快照标出了哪家 agent 开箱会请求授权（应 Lane B 请求 R-2）  — 会问=["claude"] 需配置=["opencode","codex"]
PASS  渲染进程画出了三栏  — 命中：["col col-left","col col-center","col col-right"]
[verify] 11/11 通过
```

## 没做什么 / 已知问题

1. **`permissionBehavior` 是可选字段。** 和 R-1 的 `policy` 一样，忘了填不会报错，UI 只会少一个提示——同一类"静默降级"隐患（当前无 bundler 方案不做类型检查，只能靠断言兜）。
2. **值是"默认行为"，不是当前行为。** 如果用户在 opencode 里配了 `permission.bash`，它就从 `needs_config` 变成会问；但检测层**不去读 agent 的配置文件**，所以仍会显示 `needs_config`。要准确就得加只读配置检查（属 BLOCKED B-3 之后的事）。
3. **dsh 是 `unknown`。** 适配器没装，测不了。
4. **这次只改了描述，没改行为。** 真正的"武装"仍要改 agent 自己的配置（B-3）。

## 下一手需要什么

- Lane B 第 12 轮：删掉渲染层的硬编码表，改读快照；同时修 R-3（新手没法换掉示例任务）。
- `docs/HANDOVER.md` 里"规则包不能运行时切换"那条与本条相关：将来若能读配置，闸门状态就能动态显示。
- 无待用户决策事项。
