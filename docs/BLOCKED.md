# BLOCKED · 待用户/对方 lane 拍板或处理的事项

> 规则 3：装新 agent、改全局配置、引入新依赖、删除性操作 → 写这里并继续做不依赖它的部分。

## FINAL 状态（2026-10-25）

| 项 | 状态 | 为什么/建议 |
|---|---|---|
| B-4 NSIS 安装 | ⚠️ 未验证 | dir 包 26/26；NSIS 未双击/开始菜单/卸载；无干净机器授权。建议干净 Windows/VM 按 B-4 三选项验证 |
| 干净机器 | ⚠️ 未验证 | 本机有 Electron/ACP 缓存；不能证明队友开箱可用 |
| 真实 benchmark 样本 | ⚠️ 不足 | 4 个 E2 样本、target 变更/宕机、批次 3 跳过；不能断言扇出收益 |
| 扇出收益 | ⚠️ 未证明 | 无真实 2/3 路 A/B；默认单 session，扇出需人工试点 |
| command 提交 | ❌ 未实现 | WP6 决策；仅 manual/dry_run；不接平台 API |
| D7b / D7c | ❌ 不做 | backgroundThrottling 保持 true；CDP 策略未改；D7a 只做观测区分 |
| 审批覆盖率 | ⚠️ 低 | b2b 101 calls 仅 3 审批；session 级 grantAll 自动放行；需 WP4/策略改进 |
| multitask F | ⚠️ flaky | 最终 173/174（同毫秒焦点排序），WP7 final 曾 174；已知，未修 |
| render-verify 6 项 | ⚠️ 既有失败 | 不在 verify:all；仍挂账 |
| 跨任务 grantAll.taskId | ❌ 未实现 | P5 已知；需契约/UI/审计设计 |
| AWD/IR | 🟡 MVP 只读+manual | P9-A/B/C/D 已实现只读模型/UI、导出、AWD 批量 manual、v4 7 表；强类型读写/平台 API 未启用 |
| NSIS/绿色包重打 | ⚠️ 未做 | dist 当前是 dir 包；B-4 后续 |
| verify-ab 误启动 | ⚠️ 事故记录 | 454,365 tokens；不计 benchmark；需流程防误跑 |

---

## B1 · Electron 未安装（新依赖，Lane B 不能擅自加）

- **时间**：2026-10-12 23:50
- **谁卡住**：T5（Lane A 的「窗口能起来」）与 Lane B 全部 UI 的「真实窗口渲染」验证。
- **事实**：根 `package.json` 的 dependencies 只有 `@agentclientprotocol/sdk` 与 `@modelcontextprotocol/sdk`，没有 electron；`node_modules` 里也没有。而 §2 约定 `package.json` 是「共享但只读」，加依赖要写请求文档。
- **影响**：Lane B 的 T6–T10 只验证到「纯逻辑（node smoke）+ 模块可加载 + 类型可剥离」，**没有在任何真实窗口里渲染过**；三栏布局、审批卡片、台账、扇出弹窗的视觉效果均未验收。
- **需要的决策**：是否把 electron 加进依赖（版本要选内嵌 Node ≥ 22.18 的，见 B2）；这一步同时是 Lane A T5 的前置，建议由 A 在加依赖时顺带处理。
- **Lane B 已做的绕过**：所有 UI 逻辑对「真实桥」零依赖——`hub.ts` 的 `resolveHub()` 已经是 mock → 真实 IPC 的切换点，Electron 装上即可切。

## B2 · 「无 bundler」加载依赖 Electron 内嵌 Node 的 type-stripping 能力

- **时间**：2026-10-12 23:50
- **事实**：`electron/renderer-protocol.ts` 用 `module.stripTypeScriptTypes` 现场剥 `.ts` 类型。该 API 在系统 Node 25.2.1 上验证可用，但 Electron 自带的是**它自己打包的 Node**，版本取决于 electron 版本（Node ≥ 22.18 才默认启用 type stripping）。
- **风险**：若选了内嵌 Node < 22.18 的 electron 版本，`registerRendererProtocol()` 会直接抛错，渲染进程加载不了。
- **需要的决策**：选 electron 版本时确认内嵌 Node ≥ 22.18（或接受在协议层加一个 `util` 外的剥类型实现）。

## 不阻塞的部分

以上两条都不阻塞 Lane B 的代码完成度：契约对齐、mock 数据、状态折叠、节流聚合、审批排序/批量、冲突高亮、扇出动作构造，全部已交付并有可重跑验证。T11 对接时只需装 Electron + 接 A 的真实 IPC。

---

# 已解决（Lane A 处理，2026-10-12 23:50）

## ✅ B1 · Electron 未安装 —— 已装

- electron **44.7.0** 已装进 `devDependencies`，二进制在 `node_modules\electron\dist\electron.exe`（246 MB）。
- **坑：二进制必须走镜像。** `npm install electron` 会尝试从 GitHub Releases 下载，本机直连不通（`TypeError: fetch failed`）。解法：
  ```powershell
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  node node_modules\electron\install.js
  ```
  这条对 C8（队友机器开箱可用）很重要，要写进首次启动引导/部署说明。

## ✅ B2 · 内嵌 Node 版本风险 —— 已排除

实测 electron 44.7.0 内嵌 **Node 24.21.0**：

```
electron = 44.7.0
embedded node = 24.21.0
type stripping (node>=22.18) = true
module.stripTypeScriptTypes 可用 = true
```

所以 `electron/renderer-protocol.ts` 的现场剥类型可以正常工作。

## ⚠ 协作事故：BLOCKED.md 被整篇覆盖

- Lane B 在 23:55 写 BLOCKED.md 时**整篇重写**，把 Lane A 之前记的「B-1 是否安装 codex/claude 适配器」「B-2 Claude 模型名警告」两条覆盖掉了（那两条已在 `docs/done/M2-adapters-and-delegation-probe.md` 与本文件历史中留痕）。
- **规则修正**：BLOCKED.md 与 PROGRESS.md 都是**只追加**（append-only）。要写新条目请**加在文件末尾**，不要重排或重写既有内容。这条已加进心跳的提示词。

---

# Lane B 给 Lane A 的两个真坑（2026-10-13 00:04，真窗口验收时踩到并已绕过）

> 追加说明，不是新阻塞：Lane B 已用「内存预载」绕过 #2，并把正确的 URL 形态写进了
> `apps/desktop/electron/renderer-protocol.ts` 顶部注释。Lane A 的 `src/main/electron/main.ts`（T5）
> 照做即可，无需再卡。详见 `docs/done/T6-T10-electron-window-verified.md`。

## ⚠ L-1 · 自定义 scheme 导航必须用 `bumimang://./renderer.html`，不能用 host 名

- `loadURL("bumimang://app/renderer.html")` 下，`protocol.handle` 的 handler **一次都不会被调用**（页面空白、无任何报错）。
- 改成 `loadURL("bumimang://./renderer.html")` 后 handler 正常触发。原因：`standard: true` 下
  `bumimang://app/renderer.html` 把 `app` 当 host，Electron 可路由的自定义 scheme 导航是 `scheme://./path` 形态。
- **给 A 的结论**：T5 里 `loadURL` 写 `bumimang://./renderer.html`（旧的 `docs/done/T6-renderer-skeleton.md`
  里写的 `bumimang://app/renderer.html` 是错的，以本条为准）。

## ⚠ L-2 · `protocol.handle` 的 handler 内部做文件 I/O 会卡死（不抛错）

- 实测：handler 里 `fs/promises` 的 `readFile` Promise **永不 settle**；`fs.readFileSync` 也**不返回**。
  同样的读盘放在 handler 之外（启动时）完全正常。表现为页面空白、`did-navigate` 照常、无任何异常日志。
- **Lane B 的绕过**：`renderer-protocol.ts` 改为在 `registerRendererProtocol()` 时一次性把
  `src/renderer/**` + `renderer.html` 读进内存并现场剥类型，handler 里只查内存、零 I/O。
- **给 A 的结论**：以后在主进程里读盘，别放进 protocol handler；若 A 复现/查明根因，欢迎回写本文件。

---

# Lane B 给 Lane A 的请求（2026-10-13 01:12，第 5 轮）

## R-1 · 契约 `HubSnapshot` 请暴露「当前策略规则包」

- **谁需要**：渲染进程（Lane B）想在左栏顶部显示当前生效的策略规则包（`competition` / `dev` / 回落最小安全集）。
- **事实**：Lane A 的策略引擎在启动时打印 `[main] 策略引擎已加载：<name>`（stdout），但**没有**把它放进契约 —— `HubSnapshot` 里没有策略包字段，渲染进程在 contextIsolation 下也拿不到 stdout / 环境变量（`BUMIMANG_RULES`）。
- **冻结约束**：`packages/shared-protocol/events.ts` 已冻结，任何字段增改都走 docs/requests/。**Lane B 没有改契约**，只在渲染层预置了 UI 槽位：读可选的 `snapshot.policy`（形状 `{ packId, name, fellBackToMinimal }`），字段缺席时显示「—」。见 `apps/desktop/src/renderer/contract.ts` 的 `PolicyPackInfo` 注释。
- **需要的处理**：Lane A 走 docs/requests/ 给 `HubSnapshot` 增加 `policy?: { packId: string; name: string; fellBackToMinimal: boolean }`，并在 `HubService.snapshot()` 里填上（数据源 `PolicyEngine.name` / `fellBackToMinimal`，packId 就是 `BUMIMANG_RULES` 的默认值 `competition`）。改完渲染层无需再动 —— 徽标会自动从「—」变成真实包名。
- **不阻塞**：UI 槽位已就绪且有验收（push-verify 断言了 `snapshot.policy` 缺席时的「—」和带值时的包名渲染）；只是真实后端还没填这个字段。

---

# 待用户决策 B-3 · 闸门缺输入（2026-10-13 02:06）

## 事实

实测（`npm run verify:agent-permission`）：**真实 opencode 在写文件、跑 shell 命令时不发 `session/request_permission`**，两个场景各 0 次。文件确实被创建了，但它没问。

也就是说：策略引擎 + 审批队列接线完全正确（假 agent 活体测试 16/16），但**在默认配置下拿不到任何输入**，审批面板会一直是空的。

## 出路

opencode 配置 schema 里有 `permission` 段，可逐项设置哪些动作需要批准，涉及：`read` / `edit` / `glob` / `grep` / `list` / `bash` / `task` / `external_directory` / `webfetch` / `websearch` / `lsp` / `skill` 等。把 `edit` 与 `bash` 设成"需要批准"，闸门立刻就有输入。

## 需要用户决定

**是否修改 `~/.config/opencode/opencode.jsonc` 增加 `permission` 段？**

- 改全局配置属于 `EXECUTION-PLAN.md` 规则 3 的禁区，所以停下等你。
- 我的建议：**改，但先只加 `edit` 与 `bash` 两项**，其余保持默认，避免把 agent 卡得太死。
- 另一个选项是**不改**，由程序在 UI 上提示"闸门未武装"（读配置只读检查 + 提示，符合 C3 的"提示可以、代执行不可以"）。这样用户自己决定何时武装。
- ✅ 已闭环：**未改任何用户文件**。改为运行时按会话注入 `OPENCODE_CONFIG_CONTENT`，实测四场景全过。详见本文件末尾「✅ B-3 已解决」。

### 更新（02:35）：补测后这条不再那么紧急

补测 codex / claude 后的三家对比（详见 `docs/done/GATE-INPUT-STARVED.md` 末节）：

| agent | 写文件 | 跑命令 |
| --- | --- | --- |
| **claude** | **会请求授权（1 次）** | 不问 |
| opencode | 不问 | 不问 |
| codex | 不问 | 不问 |

所以：**claude 开箱就有闸门输入，opencode / codex 需要额外配置。** 这条决策从"闸门有没有用"降级成"要不要让另外两家也武装起来"，不再阻塞雏形演示。仍然等你拍板，但优先级下降。

## 相关

- 建议同时补测 codex / claude 是否会请求授权（只测了 opencode）。若它们会问，闸门对它们就是可用的，产品叙事可以改成"opencode 需额外配置，codex/claude 开箱可用"。


---

# R-1 已解决（Lane A 填字段 + Lane B 验收，2026-10-13 01:44）

Lane A 已走 docs/requests/ 给 `HubSnapshot` 加 `policy?: { packId, name, fellBackToMinimal }` 并在
`HubService.snapshot()` 里填上（数据源 `PolicyEngine.name` / `fellBackToMinimal`，packId=competition）。
Lane B 第 6 轮经**真实桥**验收：左栏「规则包」徽标显示 `policy-engine(比赛合规包)`，不再是占位「—」，
无 `policy-pack-none` 占位样式、无回落小字（fellBackToMinimal=false）。证据 `docs/logs/r1-verify.json`、
`docs/logs/r1-policy-badge.png`。R-1 关闭。

---

# Lane B 给 Lane A 的真坑（2026-10-13 02:56，第 8 轮）

## ⚠ L-3 · 黑板 MCP 对真实 agent 不可达（claude 花一整轮简报去 debug 它）

- **谁发现**：Lane B，第 8 轮跑真实 claude 端到端审批时（见 `docs/done/R8-claude-real-approval-money-shot.md`）。
- **现象**：起 claude 会话后，自动注入的简报轮里 claude 为了找黑板，连续发来 **11 条真实 `session/request_permission`**
  （`ls` / `Read server.ts` / `powershell 枚举命名管道` / `cmd dir \\.\pipe\` / `grep` / `Read manager.ts/bridge.ts` / `ls //./pipe/` …），
  全部是在**连接黑板 MCP 失败后自己逆向排障**：找 `bumimang`/`board` 命名管道、读 MCP host 源码、手动拼 env 试探着 spawn。
- **嫌疑点**：`apps/desktop/src/main/session/manager.ts` 里 mcpEntry 的 `command: process.execPath` —— 在 Electron 主进程里
  它等于 **electron.exe**，用它去启动 stdio MCP 服务器 `mcp-host/server.ts`，很可能起不来（或起在错误形态）。agent 侧拿到
  mcpServers 条目后连不上，才去逆向。
- **影响**：「共享黑板」这个卖点对真实 agent 目前是断的；简报轮会因此被拖长（claude 把时间花在排障上，且每条 shell 都要过审批）。
- **需要处理**：Lane A 查一下 mcpEntry 该用哪个可执行文件（预期应是系统 node / `process.execPath` 只在非 Electron 上下文成立），
  修完让真实 agent 能连上黑板。**Lane B 没动 src/main。**
- **不阻塞**：钱截图（审批端到端）不依赖黑板——claude 用自己的 Write 工具直接写文件。

---

# Lane B · R11 首次用户体验 QA —— 两个「需要 Lane A / 契约」的事项（2026-10-13 04:45）

## R-2 · AgentDescriptor 需要一个「默认会不会主动请求授权」的字段（契约 + detect.ts）

- **谁需要**：渲染进程的扇出弹窗，要在「选 agent」的关口告诉新手：选哪个 agent，guarded 档才真的会有审批输入。
- **事实**：这是整晚最有价值的实测结论（HANDOVER §4）：claude 开箱会请求授权，opencode / codex 默认不问。
  但契约 `HubSnapshot.agents` 的内联 `AgentDescriptor` 只有 `id / title / installed / installHint / maturity`，
  没有这个字段；`maturity` 装的是 ACP / 适配器成熟度，跟「会不会问」无关。
- **Lane B 已做的绕过**：渲染层硬编码了一张 `AGENT_GATE_NOTE`（`renderer/fanout/model.ts`），
  弹窗提示 + 选中 agent 的成熟度一行都读它。这只是过渡 —— 知识真正的家是 `src/main/discovery/detect.ts`。
- **需要的处理**：Lane A 走 docs/requests/ 给契约的 agent 描述加一个字段（如
  `permissionBehavior: "requests_by_default" | "needs_config" | "unknown"` 或类似），
  detect.ts 按实测填上、HubSnapshot 带过来；渲染层再把 `AGENT_GATE_NOTE` 删掉改读快照。
- **不阻塞**：R11 已在渲染层硬编码并验收（cold-start-verify 断言弹窗提示存在），不升级契约就一直硬编码。

## R-3 · 新手没法用自己的真任务替换自动种下的「示例任务」

- **现象**：主进程冷启动时自动 `createTask("示例任务：本地 HTML 目标")`，所以首屏永远有个任务。
  但 09:30 要上真靶场的新手**没有入口把任务换成自己那道题**：契约有 `task.create`，渲染进程却没有任何
  UI 调用它；扇出弹窗在 task=null 时还会提示「请先创建任务」，可创建任务的按钮根本不存在。
- **需要的处理**：要么 Lane B 加一个最小「建任务 / 换任务」入口（超出本次 QA 范围，属新功能），
  要么 Lane A 决定示例任务该不该自动种、以及怎么让用户换成真任务。这是「陌生人能不能真正用起来」的第一道坎。
- **不阻塞**：本次 QA 只按「有示例任务」的冷启动来修体验；没有动 task.create 的接线。

---

# Lane B · R-2 / R-3 已解决（2026-10-13 05:09，第 12 轮）

上文两条由 Lane B 第 11 轮提出的阻塞，第 12 轮已闭环，记录如下（只追加，不改上文）：

- **R-2 已解决**：Lane A 已把 `permissionBehavior` 搬进契约 + `detect.ts`（见
  `docs/done/R2-permission-behavior-in-contract.md`）；Lane B 第 12 轮删掉渲染层的硬编码
  `AGENT_GATE_NOTE`，改读快照（见 `docs/done/R2-R3-renderer-truth-and-task-entry.md`）。
  不再有「渲染层抄一份笔记」的隐患。
- **R-3 已解决**：Lane B 第 12 轮在左栏任务卡加了「＋ 新任务」最小入口（弹窗填标题 + 简报，
  派发契约 `task.create`），主进程 `setTask` + `task.upsert` 后新任务自动成为当前任务。
  自动种「示例任务」的行为**保留未动**——只是现在可替换了。
- **遗留（不阻塞）**：快照只有当前任务（单数）、无任务列表，所以「切换」的最小实现是「新建并
  成为当前」；真要历史任务间来回切需要契约加 `task.switch`，另立请求再议。

---

# ✅ L-3 已解决（2026-10-13 07:30 补记）

**用户指出：L-3 后面没有"已解决"记录。** 这个批评是对的——修复发生在 03:05，我只写了完成文档 `docs/done/L3-blackboard-reachable-by-real-agent.md` 和进度行，**没有在 BLOCKED.md 里留下可查的关闭记录**。补记于此。

| 项 | 内容 |
| --- | --- |
| 现象 | 起会话后真实 agent 连不上黑板 MCP，claude 为了找黑板连发 11 条排障权限请求 |
| 根因 | `session/manager.ts` 的 `mcpEntry.command = process.execPath` —— 在 Electron 主进程里那是 **electron.exe**，不是 node，用它跑 stdio MCP 服务器起不来 |
| 修法 | 给该条目加环境变量 **`ELECTRON_RUN_AS_NODE=1`**，让同一个二进制以纯 Node 形态运行（比"去找系统 node"更好：打包后不依赖队友机器装没装 node，符合 C8） |
| 证据 | `apps/desktop/src/cli/verify-mcp-live.ts`（`npm run verify:mcp-live`）→ 真实 claude **2/2 通过**：MCP 子进程连上命名管道并校验通过，claude 主动调了 3 次 `blackboard_read_since` |
| 代码位置 | `apps/desktop/src/main/session/manager.ts`（搜 `ELECTRON_RUN_AS_NODE`） |
| 关闭时间 | 2026-10-13 03:05 |

> 备注：这次"改完忘了写关闭记录"与本文件里已经记过的"时间戳凭感觉写""断言 .ui-run 已忽略"是同一类错误——**做完就以为留下了痕迹**。若之后再出现，考虑给 BLOCKED 的每条加一个强制关闭字段。

---

# ✅ B-3 已解决（2026-10-13 07:30）

**用户立场：改，但把"改全局"这个动作留给自己。** 优先项目级，其次全局+手动执行，不改是弃选。

## 探测结论（Step 1）

opencode 的配置**分层且合并**（官方文档 `opencode.ai/docs/config/`）：Remote → Global(`~/.config/opencode/opencode.json`) → Custom(`OPENCODE_CONFIG`) → Project(`opencode.json`) → `.opencode` → **Inline(`OPENCODE_CONFIG_CONTENT`)** → Managed。各层按同名键覆盖，不是替换。

`permission` 段语法（从 `opencode.ai/config.json` 取）：`PermissionActionConfig` = `"ask" | "allow" | "deny"`；`PermissionRuleConfig` 还可以是"按 pattern 映射到动作"的对象。可设的键包括 `read` / `edit` / `glob` / `grep` / `list` / `bash` / `task` / `external_directory` 等。

最小武装配置：

```json
{ "permission": { "edit": "ask", "bash": "ask" } }
```

## 实测对照（`npm run verify:arm-opencode`）

```
baseline（不注入）        request_permission = 0   文件写入 = true
project（会话目录放 json） request_permission = 1   文件写入 = true
inline（环境变量）         request_permission = 1   文件写入 = true
via-app（走 SessionManager）request_permission = 1   文件写入 = true   ← 接线生效
```

## 采用的方案：inline 按会话注入（比"项目级"更干净）

应用在 spawn opencode 会话时注入 `OPENCODE_CONFIG_CONTENT`（见 `session/manager.ts` 里搜 `OPENCODE_CONFIG_CONTENT`），只带 `permission.edit/bash = "ask"`。

为什么比写在仓库里更好：

1. **完全不碰全局配置**，符合用户立场与规则 3；
2. **不需要在仓库留一个 `opencode.json`** —— 那个文件会对用户在项目目录里直接跑 opencode 时也生效，属于"意外副作用"；
3. 随代码走，队友克隆即有；
4. 可开关：设 `BUMIMANG_ARM_OPENCODE=off` 即回到原行为。

**回滚**：不需要动任何用户文件。要停掉武装只需设环境变量 `BUMIMANG_ARM_OPENCODE=off`（或把 `manager.ts` 里那段去掉）。

## 连带影响：三家的产品叙事变了

原来 HANDOVER §4 说"只有 claude 开箱会请求授权"。**这条现在不对了** —— opencode 由本应用自动武装，所以在本应用里它也会问。

| agent | 现在会不会有审批输入 | 怎么来的 |
| --- | --- | --- |
| claude | ✅ | 原生就会 |
| opencode | ✅ | **本应用按会话注入配置** |
| codex | ❌ | 机制已查明（`codex -a on-request`），但 `codex-acp` 还没接线 |
| dsh | ？ | 适配器未安装 |

## 还没做的

- **codex 没武装。** 它有 `-a/--ask-for-approval <on-request|never>`，但没有确认 `codex-acp` 能否把参数/配置透传给内部的 codex 进程。需要单独探测。
- **UI 文案要改。** 渲染层（Lane B）目前写的是"只有 Claude Code 开箱会请求授权"，与新事实不符。已作为 R-4 追加在下方。

## R-4 · 扇出弹窗的文案与新事实不符（Lane B）

- **事实**：渲染层现在写"只有 Claude Code 开箱会请求授权"。但 B-3 之后，**本应用会自动武装 opencode**（按会话注入 `permission.edit/bash = "ask"`），所以 opencode 在本应用里也会请求授权。
- **数据源已经对了**：`snapshot.agents[].permissionBehavior` 里 opencode 已被 Lane A 改成 `requests_by_default`（语义改为"**我们这样跑它**会不会问"，见 `detect.ts` 的注释）。所以**只要文案跟着字段走**就不会错。
- **需要处理**：把硬编码或按 id 判断的文案，改成按 `permissionBehavior` 生成；`needs_config` 的只剩 codex（机制已查明但没接线）与 dsh（未安装）。
- **不阻塞**：只是文案与现实的偏差，不影响功能。

---

# ✅ B-3 续：codex 也武装了（2026-10-13 07:37）

用户说"你改吧"，于是把第三家接上。**用 ACP 原生 mode，零配置文件。**

`codex-acp` 把审批策略暴露成 ACP 的 modes，但**只有 `read-only` 会真的发权限请求**（实测）：`read-only`=1 次，`workspace-write`=0，默认 `agent`=0。默认那档是"自动复核"，普通写文件不算不安全。

实现：`guarded` 档 → `session/set_config_option(mode="read-only")`；`autonomous` 档不动。开关 `BUMIMANG_ARM_CODEX=off`。

证据：`npm run verify:arm-codex`、`docs/done/B3b-arm-codex-gate.md`。

## 三家齐了，只剩 dsh

| agent | 有审批输入？ | 机制 |
| --- | --- | --- |
| claude | ✅ | 原生 |
| opencode | ✅ | 应用注入 `OPENCODE_CONFIG_CONTENT`（`permission.edit/bash="ask"`） |
| codex | ✅ | 应用在 guarded 档切原生 mode `read-only` |
| dsh | ？ | 适配器未安装（RC），未探 |

**一条不对称，需要 UI 说清**：对 claude / opencode，档位只决定"问了之后要不要人工放行"；对 codex，档位**决定它问不问**。同一个"档位"在三家之间语义不同。

## R-5 · 档位在三家之间语义不同，UI 需要说清（Lane B）

- **事实**：`guarded` / `autonomous` 这个档位，在四家 agent 上的作用不一样：
  - **claude / opencode**：不管什么档都会问（原生 / 我们注入配置）；档位只决定"问了之后是否转人工"（§9.2 的档位兜底）。
  - **codex**：档位**决定它问不问** —— `guarded` 档我们把它切到原生 mode `read-only`，所以会问；`autonomous` 档保持它的默认 `agent`（自动复核），所以不问。
- **为什么这是个问题**：用户在扇出弹窗里选"档位"时，如果以为三家行为一致，就会对 codex 的安静感到困惑（"我选了 autonomous，为什么这家的审批面板永远空的"）。
- **建议处理**：在扇出弹窗的档位选项旁，按 agent 动态补一句差异说明；或在会话卡片上显示该会话的实际生效 mode/闸门状态。
- **数据源**：目前契约里**没有**"某会话的实际生效 mode"这个字段。要做得准需要 Lane A 加字段（同 R-1/R-2 的模式）；要做得省，渲染层可以按 `agent + tier` 推导——但那又是一份会过期的知识，与 R-2 的教训相同。
- **不阻塞**：功能正常，只是可读性。

---

# Lane B 给 Lane A 的真坑（2026-10-13 08:35，第 17 轮）

## ⚠ L-4 · 真实 UI 拒绝路径下，`prompt()` 把 blocked 覆盖回 idle（会话卡永远画不出「被策略切断」）

- **谁发现**：Lane B，第 17 轮补「UI 上点拒绝 → blocked 终态」这条最后没验的链（见 `docs/done/R7-ui-deny-blocked.md`）。
- **现象**：真实 claude 会话里，人工在 UI 上连续点两次「拒绝」（同规则 `tier-guarded-default`），
  `DenialTracker` 到阈值 → `markBlocked` 确实执行（`[s1] 转 blocked`、死路 `scope=blocked` 也写进库），
  **但会话终态是 `idle`**（内存与 `sessions` 表都是 idle），左栏会话卡因此画「空闲」而不是「被策略切断」。
- **根因**：`apps/desktop/src/main/session/manager.ts` 的 `prompt()`（约 319–332 行）在
  `await client.prompt(...)` 之后**无条件** `rec.status = "idle"`。真实 agent 的权限请求发生在 prompt 轮中途，
  第 2 次拒绝触发 `markBlocked`（约 381–407 行）时 `prompt()` 还挂着；markBlocked 的 `client.cancel()` 让 claude
  以 `stopReason="cancelled"` 结束本轮 → 挂着的 `client.prompt` resolve → `prompt()` 续体把 blocked 覆盖回 idle，
  连库里的 `sessions.status` 一起写成 idle。
- **为什么 verify:concurrency 没抓到**：那次的假 agent 不在 `prompt()` 调用里（没有「prompt 轮 → 中途发权限请求」结构），
  所以没有这个覆盖竞态。真实 claude 必现（已复跑两次，结果一致，确定性 bug）。
- **证据**：`docs/logs/ui-deny-blocked.json`（22 断言，21 PASS / 1 FAIL 即本条）、`docs/logs/ui-deny-blocked.png`、
  wire.jsonl 里 deny #1→`end_turn`、deny #2→`cancelled`；`board.db` 里 `sessions.s1.status=idle` 且 `dead_ends` 有
  `scope=blocked` 一条。
- **建议修法**：`prompt()` 里 `await client.prompt` 之后先判 `if (rec.blocked)`，是则只重发当前状态并 return，
  不要落 `idle`（具体 diff 见 `docs/done/R7-ui-deny-blocked.md` 的「给 Lane A 的修法建议」）。
- **Lane B 没动 src/main**。渲染层已就绪（`blocked-hostile-verify` 28/28 验过 blocked 视觉，且现场证明渲染层忠实画了
  主进程发来的状态）；A 修完重跑 `apps/desktop/electron/ui-deny-blocked.ts` 即可整条变绿（断言已就位，无需改脚本）。

---

# ✅ L-4 已解决（2026-10-13 08:42，由 Lane A 修复）

| 项 | 内容 |
| --- | --- |
| 现象 | 真实 UI 拒绝路径下，`markBlocked` 确实执行（死路 `scope=blocked` 已落库），但会话终态是 `idle`，会话卡画成「空闲」而不是「被策略切断」 |
| 根因 | `session/manager.ts` 的 `prompt()` 在 `await client.prompt(...)` 之后**无条件**落 `idle`；而权限请求发生在 prompt 轮内部，第二次拒绝触发 `markBlocked` → `cancel()` → 本轮 promise 立刻 resolve → 那行 `idle` 覆盖了 `blocked`（内存与库里都是） |
| 为什么合成测试抓不到 | `verify:concurrency` 的假 agent 不在 `prompt()` 调用中，没有"prompt 轮 → 中途发权限请求"这个时序结构。真实 claude 必现（两次复跑一致） |
| 修法 | 落 `idle` 前先检查是否已是终态：`["blocked","stopped","failed","done"].includes(rec.status)` 则不覆盖。**用集合而不是特判 `blocked`**——同一类覆盖对另外三个终态一样成立，特判一个只是把地雷留在别处 |
| 证据 | 重跑 `apps/desktop/electron/ui-deny-blocked.ts` → **全 PASS**（29+ 断言，含真实点 DOM「拒绝」两次、终态 blocked、会话卡「被策略切断」而非「崩溃」、台账 `scope=blocked` 死路、无 incident 死路）。日志 `docs\logs\ui-deny-rerun.log` |
| 回归 | `npm run verify:concurrency` 15/15、`npm run verify:gate` 41/41 |
| 关闭时间 | 2026-10-13 08:42 |

## ✅ 同一处遗留的设计问题 —— 已修（08:44）

> 结论：按"请求内容签名"计数，不再按策略规则 id。见 `docs/done/L4b-denial-signature-fix.md`。
> `npm run verify:gate` 41 → **49/49**（新增 8 条断言专门覆盖这个场景：拒两件**不同**的事不会误触发，
> 同一件事再犯才触发）。阈值可配：`BUMIMANG_DENIAL_THRESHOLD`（默认 2）。
> 下面保留原始问题描述作为记录。

两次拒绝命中的规则 id 都是 **`tier-guarded-default`**——那是**档位兜底**，不是具体规则。也就是说：**一个受控档会话里，任何两个不命中具体规则的权限请求，都会被算作"同一规则"，累计 2 次就终结会话。** 真实使用中一个受控档会话很容易连问两次不同的事（比如"读这个文件"和"跑那条命令"），然后被误终止。

这不算 L-4 的一部分（L-4 是状态覆盖），但它是**我引入的设计缺陷**：把"档位兜底"当成了"规则身份"参与退避计数。建议给档位兜底一个不计入退避的标识（或按 `action + detail` 做签名而不是按 rule id）。

---

# ⬜ 待用户授权 B-4 · NSIS 安装流程没法自己验（2026-10-13 09:01）

## 事实

`dist\不迷茫 Setup 0.1.0.exe` 是给队友的主产物，但我们**从没执行过它**：

- `win-unpacked` 与绿色包都实跑验证过（各 11/11，另有 Lane B 的打包态真实用户流程 27/27）
- 安装包只做了**只读载荷检查**（NSIS 包是小外壳 + 7z 载荷，用 7z 列举确认 `resources\app.asar` 与三份规则包都在）

**「载荷完整」不等于「安装流程可用」。** 后者要验的是：双击安装 → 装到 `%LOCALAPPDATA%\Programs` → 开始菜单出现项 → 启动能跑 → 卸载干净。

## 为什么停下

安装会写系统（开始菜单、卸载注册表项、用户目录下的程序目录），属于 `EXECUTION-PLAN.md` 规则 3 的禁区。**我不在没有授权的情况下往系统里装东西。**

## 需要你决定

**要不要在这台机器上真装一次来验？** 三个选项：

1. **装**（我会装完立刻走一遍启动→起会话，然后卸载，并报告有没有残留）
2. **你手动装**（我给出逐步检查清单，你双击走一遍）
3. **在一台可随意折腾的 Windows 或虚拟机上验**（最接近"队友首次体验"，也顺带能验"新机器上缺什么"）

我的建议：**选 3**。因为这台机器有 electron 缓存、有全局装的 ACP 适配器，**即使装成功了也证明不了"队友机器开箱可用"**——那条才是这个缺口的实质。若没有干净环境，选 1 也行（至少能证明安装器本身不报错、卸载能干净）。

- ⬜ 待用户答复

## P7-C / P7-D 更新（2026-10-25）

- **dir 包已验证**：`npm run pack:dir` exit=0；`dist/win-unpacked/不迷茫.exe --no-sandbox --verify` **26/26**；asar 3,029 项，不含项目 cli/smoke/bench/evidence/docs；`config/app.json` 无 `D:\`/`D:/` 硬编码。
- workDir 默认改为打包态 `<documents>/bumimang/work`；skill 外置（未打包 resources/app-source/skill）。
- **NSIS 安装流程仍未执行**：没有双击安装、开始菜单、卸载验证；**干净机器仍未验证**。
- 因此 B-4 **仍未关闭**。原“装一次/你手动装/干净 VM”三个选项仍需用户授权；建议优先干净 Windows/VM。

---

# ✅ 勘误 D-1 · 「dsh 适配器未安装」这条前提是错的（2026-10-13 12:47）

前面的 dsh 条目（§6.3 派生的那些）写着「适配器仍为 RC，且未安装」「`dsh-acp` 未检测到」。
**这条前提本身就错了**，侦察后修正如下（证据全在 `docs/DSH-INTEGRATION-RECON.md`）：

1. npm 上的 `@deepseek-ai/dsh-acp` **没有 `bin` 字段**——它是 cordis 插件，不是 CLI。
   所以 `npm i -g @deepseek-ai/dsh-acp` **永远不会**在 PATH 上生成 `dsh-acp` 命令，
   `detect.ts` 里 `resolveLaunch("dsh-acp")` 这条路径**设计上就查不到东西**。
2. 真正的入口是 **DeepSeek Harness 桌面版自带的 CLI**：
   `<安装目录>\resources\runtime\cli\bin\dsh.cmd`，`dsh --profile acp` 起出来就是标准 ACP v1 stdio server
   （本机实测：initialize / session/new 通过，`sessionCapabilities` 有 close/list/resume）。
3. **闸门存在且可武装**：默认 `workspace-write` 下写工作区内的文件不问（实测 request_permission=0，文件真被写）；
   起服务时给 `DSH_PERMISSION_MODE=read-only` 就会问（实测=1，选项 `allow-once` / `reject-once`）。
   这与 codex 的 read-only 同构，档位映射可以照抄。

**影响**：`docs/ARCHITECTURE.md` §6.3 与 `HANDOVER` §4 里关于 dsh 的「适配器未安装 / 未知」判断，
以及 `detect.ts` 的 `installHint: "npm i -g @deepseek-ai/dsh-acp"`，都应改成「桌面版自带 CLI + env 武装」。
架构文档是只读的，所以这里只登记勘误，等用户决定要不要走请求流程改契约文档。

- ⬜ 待用户裁决：现在改 `detect.ts`（Lane A）+ 文案（Lane B），还是留给新窗口做

---

# ✅ 勘误 D-1 已落地（T14，2026-10-13 13:03，Lane A）

上面那条「⬜ 待用户裁决：现在改 detect.ts + 文案，还是留给新窗口做」**已经做完**（用户 13:0x 拍板做，本条只追加状态，上面的历史结论原样保留）：

- `detect.ts`：dsh 三级发现（override → PATH → env 推导的已知根目录 + Windows 卸载注册表项的 `InstallLocation`），
  命中后包 `cmd.exe /c <安装目录>\resources\runtime\cli\bin\dsh.cmd --profile acp`；**旧的 `dsh-acp` 路径整条删除**；
  `installHint` 改成「装桌面版 / 用 agents.json 指到 dsh.cmd」；`permissionBehavior` 从 `unknown` 改成 `requests_by_default`。
- `session/manager.ts`：按档注入 `DSH_PERMISSION_MODE`（guarded=read-only 会问 / autonomous=workspace-write 不问，`BUMIMANG_ARM_DSH=off` 可关）。
- 新增 `apps/desktop/src/cli/verify-dsh-live.ts`（`npm run verify:dsh-live`）**31/31 ALL_PASS**；`npm run verify:all` 回归 **100/100**。
- 证据与细节：`docs/done/T14-dsh-fourth-engine.md`；Lane B 的文案与渲染层 stale 断言在 R15（Claude）。
- 仍未做（登记在此，别当已解决）：**`docs/ARCHITECTURE.md` §6.3 关于 dsh 的判断仍是错的**（只读基线，未走 `docs/requests/`）。
