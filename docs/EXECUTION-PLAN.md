# 不迷茫 · 夜间执行计划

**窗口：2026-10-12 23:26 → 2026-10-13 07:00（约 7.5 小时）**
**目标：做出一个能跑起来的雏形，不是完成品。**

执行者：两条 lane 并行 —— **A = Codex**，**B = Claude Code**。

---

## 0. 三条硬规则（先读这个，比读任务列表重要）

1. **只改自己 lane 的目录。** 跨目录需求写成 `docs/requests/A-to-B-<主题>.md`，不要直接动手。
2. **`docs/ARCHITECTURE.md` 是设计基线，谁都不许改。** 发现的偏差写进 `docs/requests/` 或自己的完成文档。
3. **遇到需要用户拍板的事，停手并写进 `docs/BLOCKED.md`。** 包括：装新的 agent、改全局配置（`~/.config/`、`~/.codex/`、`~/.claude/`）、引入新的重量级依赖、任何删除性操作。

---

## 1. 时间盒

| 时段 | 目标 | 出口条件 |
| --- | --- | --- |
| 23:30–01:00 | 契约冻结 + 各自骨架 | `events.ts` 冻结；两边各有能跑起来的最小载体 |
| 01:00–03:00 | 各自功能填充 | A：策略引擎 + 审批队列可用；B：多窗格 + 审批 UI 可看 |
| 03:00–05:00 | 对接 | B 的 UI 消费 A 的真实事件，不再用 mock |
| 05:00–06:30 | 端到端演示 | 一次真实的双会话扇出，全程在 UI 上可见 |
| 06:30–07:00 | 收尾 | 完成文档写齐，`docs/HANDOVER.md` 留状态说明 |

时间到了就停手写文档，**不要为了"再跑一次"拖到 7 点之后**。

---

## 2. 分工与文件所有权

| Lane | 负责什么 | 独占目录（别人不许碰） |
| --- | --- | --- |
| **A · Codex** | 核心后端：策略引擎、审批队列、事件总线、Electron 主进程入口 | `apps/desktop/src/main/**`、`packages/**`、`rules/**`、`apps/desktop/src/cli/**` |
| **B · Claude** | 桌面壳与渲染进程：窗口布局、多窗格、审批界面、黑板台账 | `apps/desktop/src/renderer/**`、`apps/desktop/electron/**`、`apps/desktop/*.html` |

共享但只读的东西：`docs/ARCHITECTURE.md`、`docs/EXECUTION-PLAN.md`、`package.json`（要加依赖 → 写请求文档）。

---

## 3. 契约（先冻结，两边照它写）

**契约文件：`packages/shared-protocol/events.ts`** —— 由 A 在 T1 冻结，冻结后 B 只读。

它定义两件事，别的都不要塞进去：

```ts
// 1) 状态快照：UI 首屏拉一次
export interface HubSnapshot {
  task: TaskView | null;
  sessions: SessionView[];
  approvals: ApprovalView[];
  board: { facts: FactView[]; deadEnds: DeadEndView[]; leases: LeaseView[]; intents: IntentView[] };
  health: { [sessionId: string]: { toolCalls: number; boardReads: number; syncLag: number } };
}

// 2) 增量事件：主进程推给渲染进程
export type HubEvent =
  | { type: "session.upsert"; session: SessionView }
  | { type: "session.stream"; sessionId: string; update: StreamUpdate }
  | { type: "approval.upsert"; approval: ApprovalView }
  | { type: "board.appended"; events: BoardEventView[] }
  | { type: "health"; sessionId: string; toolCalls: number; boardReads: number; syncLag: number }
  | { type: "task.upsert"; task: TaskView };
```

**渲染进程与主进程之间只走这两条通道**（Electron IPC：`hub:snapshot` 请求 / `hub:event` 推送；渲染进程发出的动作走 `hub:action`）。

B 在对接前用 mock 实现这个契约；A 提供真实实现。**契约定死之后谁都不许单方面改**，要改走请求文档。

---

## 4. 任务清单

### Lane A（Codex）

| ID | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| **T1** | 冻结契约 | `packages/shared-protocol/events.ts` | 能 `node -e "import(...)"` 加载；类型覆盖快照与事件 |
| **T2** | 事件总线 | `apps/desktop/src/main/hub/bus.ts` | 订阅者能收到 M1 已有的会话/黑板/审批事件 |
| **T3** | 策略引擎 v1 + 规则包 | `apps/desktop/src/main/policy/engine.ts`、`rules/competition.yaml`、`rules/dev.yaml` | 三级覆盖（全局→任务→会话）生效；硬阻断无放行按钮；换规则包行为随之改变 |
| **T4** | 审批队列 | `apps/desktop/src/main/approval/queue.ts` | `session/request_permission` 变成真审批：挂起 → UI 决策 → 回传；拒绝回结构化原因；同类重试计数 |
| **T5** | Electron 主进程入口 + IPC | `apps/desktop/src/main/electron/main.ts` | 窗口能起来；`hub:snapshot`/`hub:event`/`hub:action` 三条通道通 |

### Lane B（Claude）

| ID | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| **T6** | 渲染进程骨架 | `apps/desktop/src/renderer/**`、`apps/desktop/renderer.html` | 用契约的 mock 数据渲染出三栏布局：左任务树+会话列表+加号、中多窗格、右审批+台账 |
| **T7** | 多窗格实时事件流 | `renderer/panes/**` | 每个会话一个窗格，消费 `session.stream`；**必须节流**（见 §6 已知坑） |
| **T8** | 审批队列 UI | `renderer/approval/**` | 三栏卡片（命令+目标 / agent 自述意图 / 命中规则），支持放行、拒绝、批量 |
| **T9** | 黑板台账视图 | `renderer/board/**` | 事实/死路/意图/租约四类可视化，冲突事实并列高亮 |
| **T10** | 加号扇出交互 | `renderer/fanout/**` | 点加号能选 agent + 角色 + 档位，并发出 `hub:action` |

### 联合

| ID | 任务 | 负责 |
| --- | --- | --- |
| **T11** | 对接：mock → 真实 IPC | A 提供实现，B 切换，两边同时在场 |
| **T12** | 端到端演示脚本 + 录屏证据 | A 写脚本，B 负责界面截图 |

---

## 5. 完成文档约定（这是用户明确要求的）

**每完成一个任务，立刻在 `docs/done/` 写一个文件：`<TASK-ID>-<短名>.md`。**

固定五节，不要写别的：

```markdown
# T4 审批队列

## 做了什么
（一句话 + 关键设计取舍）

## 改了哪些文件
（路径列表）

## 怎么验证的
（**必须是一条能重跑的命令 + 它的真实输出**，不是"应该没问题"）

## 没做什么 / 已知问题
（诚实列出，这是最有价值的一节）

## 下一手需要什么
（依赖谁、需要什么决策）
```

另外维护 `docs/PROGRESS.md`，只追加，一行一条：
```
HH:MM  lane  TASK-ID  状态  一句话
```

---

## 6. 已知坑（踩过的，别再踩）

### 5.1 写时间戳的纪律（同一条错犯过三次，所以写进协议）

**写任何时间戳之前先 `Get-Date -Format 'HH:mm:ss'`，不许凭感觉。** 本夜三次把时间戳写超前（写完才发现"完成时间"在未来），根因都是"以为过了多久"而不是"看时钟"。校验办法：写完文档后用文件真实 mtime 对一遍。

**同类纪律：完成文档里"没做什么 / 已知问题"那一节也会凭印象写错。** 本夜有一次断言"`.ui-run` 已在 .gitignore 里"，实际没有。凡是在文档里对**系统状态**下断言（某文件被忽略、某 bug 已修、某路径存在），要么当场验证，要么注明"未验证"。

| 坑 | 事实 | 规避 |
| --- | --- | --- |
| opencode 默认模型 | 全局配置里原本写的是不存在的 `deepseek/deepseek-v4-flash`，已修为 `deepseek/deepseek-flash` | 已修，别再改回去 |
| opencode 不委托命令执行 | 实测 `terminal/create` 与 `fs/*` 各 0 次，`session/request_permission` 12 次 | 设计上不要假设"所有动作流经我们"，见 ARCHITECTURE §4.1 |
| 事件量极大 | 单轮 prompt 约 150 条 `tool_call_update`，线日志 3 MB | **UI 必须节流聚合**；tool call 计数只数 `tool_call`，不数 `tool_call_update` |
| 模型怎么设 | ACP 没有 `session/set_model`，走 `session/set_config_option`（`configId="model"`, `type="select"`） | 需要指模型时用这个 |
| SQLite | 用 Node 内置 `node:sqlite`，不是 `better-sqlite3` | 别引原生模块，队友机器不用装构建工具链 |
| 长跑进程输出 | `Select-Object -First N` 会截断长跑进程的输出并让 PowerShell 报错 | 重定向到文件，再 `Get-Content -Tail` |
| 跑 verify 前不杀 electron | 上一轮 verify 残留的 electron 进程占着 `.ui-run\<name>` 目录，下一轮脚本开头的 `rmSync` 删不掉 → 以 `EPERM, Permission denied` 死在 bootstrap，**看起来像套件坏了，其实是残留进程**（2026-10-13 12:29 实测，`r1-verify`/`cold-start-verify` 中招） | 每轮跑 verify **之前**先 `Get-Process electron -ErrorAction SilentlyContinue \| Stop-Process -Force` |
| Electron 套件输出被变量吃掉 | `$out = & electron.exe script.ts 2>&1` 在 PowerShell 里**不等待、也拿不到输出**（GUI 子系统进程），套件看起来"0 条断言" | 一律 `electron.exe ... 2>&1 \| Out-File -Encoding UTF8 <log>`，再读文件 |
| 会话工作目录 | 每会话独立的 `/.m1/sessions/<id>`；`D:\` 是巨型 git 仓库 | 不要在 `D:\` 根目录起会话 |

---

## 7. 当前基线（已经完成的部分）

**M1 已通过 7/7**（详见 `docs/done/` 里 M1 的完成文档）：

| 已有 | 位置 |
| --- | --- |
| 黑板（SQLite WAL、三写一事务、哈希链） | `apps/desktop/src/main/blackboard/board.ts` |
| ACP 客户端（手写 JSON-RPC，L2 咽喉） | `apps/desktop/src/main/acp/client.ts` |
| MCP 主机（命名管道 + 一次性令牌 + stdio 子进程） | `apps/desktop/src/main/mcp-host/` |
| 会话管理器（扇出、简报包、崩溃清理） | `apps/desktop/src/main/session/manager.ts` |
| agent 检测（C3：只检测不安装） | `apps/desktop/src/main/discovery/detect.ts` |
| 简报包 | `apps/desktop/src/main/briefing/build.ts` |
| M1 验收脚本 | `apps/desktop/src/cli/m1.ts`（`npm run m1`） |
| 适配器探针 | `apps/desktop/src/cli/probe.ts`（`npm run probe`） |

**M1 验收结果**：7 条断言全过；23 条事件、26 条审计、哈希链完整。

**还没有的**：策略引擎（现在是 passthrough 占位）、审批队列（现在自动放行）、任何 UI。

---

## 8. 停机条件

- **07:00 硬停**，写 `docs/HANDOVER.md`：现在能跑什么、不能跑什么、下一步三步。
- 中途遇到 §0 规则 3 的四类事 → 写 `docs/BLOCKED.md` 并继续做不依赖它的部分，**不要停在那里等**。
- 如果某任务卡住超过 45 分钟 → 降级交付（写清做到哪一步），转下一个任务。
