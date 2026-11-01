# 今晚最重要的发现：闸门接线正确，但拿不到输入

> 完成时间：2026-10-13 02:06

## 做了什么

把整晚最后一块没验的拼图验了：**真实 agent 到底会不会请求授权？** 结论是**不会**。

做法：让真实 opencode 干两件"按常理该问一下"的事，把每一次客户端反向调用都记下来。

```powershell
cd D:\agent\xuanwo
npm run verify:agent-permission
```

真实输出：

```
---------- 场景：写文件（按常理该问一下） ----------
stopReason=end_turn  error=-
客户端反向调用 0 次：[]
其中 request_permission 0 次；agent 侧报告 tool_call 1 次
文件真的被创建了吗：是          ← 文件确实写了，但它没问

---------- 场景：执行 shell 命令 ----------
客户端反向调用 0 次：[]
其中 request_permission 0 次；agent 侧报告 tool_call 1 次

================ 结论 ================
场景一（写文件）：request_permission 0 次，文件创建=true
场景二（跑命令）：request_permission 0 次，tool_call 1 次
合计 request_permission：0 次
⚠ 结论：在当前 opencode 配置下，真实 agent 不请求授权。
```

## 这意味着什么

**闸门（策略引擎 + 审批队列）接线完全正确，但在默认配置下没有输入。** 它像一道装好的闸门，上游却没有水。

回看整晚的证据链，这个结论其实是必然的：

| 时间 | 事实 | 说明 |
| --- | --- | --- |
| 23:00 | `probe:delegate`：三家 agent 的 `terminal/create`、`fs/*` 各 0 次 | 它们不把执行委托给客户端 |
| 01:04 | 假 agent 活体测试 16/16 | 闸门**接线**正确 |
| 02:06 | 真实 agent 两个场景 `request_permission` 各 0 次 | 闸门**没有真实输入** |

所以 §4.1 那句"L2 是咽喉"要再补一层：对这三家 agent，**咽喉的两个入口（委托 + 请求授权）在默认配置下都是关着的**。

## 出路（已查证）

opencode 的配置 schema 里**有** `permission` 段，可以逐项指定哪些动作要问：

```
PermissionConfig: { read, edit, glob, grep, list, bash, task,
                    external_directory, todowrite, question,
                    webfetch, websearch, lsp, doom_loop, skill }
```

也就是说，把 `edit` 和 `bash` 设成"需要批准"，闸门立刻就有输入了。

**但这要改用户的全局配置**（`~/.config/opencode/opencode.jsonc`），而按 `EXECUTION-PLAN.md` 第 0 节规则 3，改全局配置必须用户拍板。所以：

- 已写进 `docs/BLOCKED.md`（B-3）等用户决定。
- **建议做法：程序不代改，而是像"agent 未安装"那样给提示。** 因为 C3 已经把"提示可以、代执行不可以"定成原则，这里顺着同一条原则最一致：读一下配置（只读），发现 `permission.edit`/`permission.bash` 没要求批准，就在 UI 上提示"闸门未武装：agent 默认不请求授权，审批队列不会收到任何东西"。

## 改了哪些文件

```
apps/desktop/src/cli/verify-agent-permission.ts   真实 agent 权限请求探针（新）
package.json                                       新增 npm run verify:agent-permission
docs/BLOCKED.md                                    B-3：闸门未武装，需要用户决定是否改 opencode 配置
```

## 没做什么 / 已知问题

1. **"闸门未武装"的提示还没实现。** 现在只有这份文档和 BLOCKED 条目。实现它需要在启动时只读解析 `~/.config/opencode/opencode.jsonc` 并放进快照——这又要动契约（得像 R-1 那样加字段），所以先等用户对 B-3 表态，避免白做。
2. **只测了 opencode 一家。** codex / claude 的行为可能不同（`claude-agent-acp` 背后是 Claude Agent SDK，它有自己的权限模式；`codex-acp` 可以传沙箱/审批策略）。**这是一个明显的缺口，而且可能是好消息**——如果 claude 或 codex 会问，闸门对它们就是有用的。值得再花一轮测。
3. **opencode 的 `mode: plan` 值得试。** 它"disallows all edit tools"——被禁的工具会不会转成权限请求？没测。
4. **探针里我把 `onApprovalRequired` 直接返回 true**（一律放行），只为了观察"它有没有问"。所以这份数据只能回答"问不问"，不能回答"问了之后走不走完整链路"。

## 下一手需要什么

- **优先补测 codex 与 claude**（第 2 点的缺口）。如果它们会请求授权，整个产品的可用性叙事就成立了，只是要注明"opencode 需要额外配置"。
- 用户在 B-3 上的决定。
- `docs/HANDOVER.md`：这个发现必须在最显眼的位置，因为它直接决定"这个雏形能不能真的用起来"。

---

# 补测结果（02:35）：三家行为不一样，claude 会问

按上面的"下一手"，把 codex 与 claude 补测了。命令：

```powershell
npm run verify:agent-permission          # 默认测 codex + claude
npm run verify:agent-permission -- --all # 三家全测
```

真实输出：

```
---------- [codex] 场景一：写文件 ----------
客户端反向调用 0 次：[]
其中 request_permission 0 次
文件真的被创建了吗：是

---------- [codex] 场景二：执行 shell 命令 ----------
客户端反向调用 0 次：[]

---------- [claude] 场景一：写文件 ----------
客户端反向调用 1 次：["session/request_permission"]     ← 它会问！
其中 request_permission 1 次
文件真的被创建了吗：是

---------- [claude] 场景二：执行 shell 命令 ----------
客户端反向调用 0 次：[]

================ 结论 ================
codex    写文件时 request_permission=0（文件创建=true）  跑命令时 request_permission=0
claude   写文件时 request_permission=1（文件创建=true）  跑命令时 request_permission=0
```

加上昨晚 opencode 的基线，三家对比如下：

| agent | 写文件时是否请求授权 | 跑命令时是否请求授权 | 结论 |
| --- | --- | --- | --- |
| **claude**（`claude-agent-acp`） | **1 次 ✅** | 0 次 | **开箱就有闸门输入**（至少对文件编辑） |
| opencode | 0 次 | 0 次 | 需要配 `permission.edit` / `permission.bash` |
| codex（`codex-acp`） | 0 次 | 0 次 | 需要配沙箱 / 审批策略（`codex-acp` 可转发 codex 的审批设置） |

### ⚠ 上表第二列已被推翻（02:56，Lane B 实测）

Lane B 跑真实 claude 端到端时观测到：**简报轮里 claude 连续发来 11 条真实 `session/request_permission`**，全是 shell 与读文件类动作（`ls`、`Read server.ts`、枚举命名管道、`grep`……）。所以"claude 跑命令不问"这个结论**是错的**——它只在跑那条无害的 `echo gate-test` 时没问。

修正后的说法：**claude 的提问策略是按动作风险分的**——只读侦察类可能不问，写文件/枚举系统/读源码就会问。样本量为 1 的那次 `echo` 误导了我。这条修正已由 `docs/done/R8-claude-real-approval-money-shot.md` 佐证。

## 这条改变了什么

「人工审批边界」这个卖点**不是空的**，但只在 claude 上开箱成立。所以产品叙事要按家区分：

- **claude：开箱可用。** 起一个 claude 会话，让它改文件，审批面板就会有真实条目。
- **opencode / codex：需要先武装。** 它们的默认策略是"自己判断着做"，不问客户端。要么改它们的配置（需用户拍板，见 BLOCKED B-3），要么在 UI 上明确标出"这家 agent 当前不会请求授权 → 审批队列对它是空的"。

## 仍未解释的

1. **claude 只在"写文件"时问，跑 `echo` 时没问。** 说明它的提问策略是按工具类型的（编辑类要问、只读/无害命令不问）。这是合理设计，但也意味着**审批面板的条目数取决于任务类型**——跑只读侦察的那类题可能一条审批都不会有。
2. **只各跑了一次**，样本量为 1。模型有随机性，"claude 一定问"这个结论还不够硬；要写进交接文档时应标注"单次实测"。
3. **没有测 opencode 的 `mode: plan`**。它"disallows all edit tools"，被禁的工具会不会转成权限请求，未知。
