# WP2 · 技能与知识接入（P0）总收口

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP2；`docs/plans/COMPETITION-READINESS.md` §5（§5.2 文件清单 / §5.3 数据模型 / §5.4 简报增量 / §5.5 MCP 工具 / §5.6 测试计划 / §5.7 风险 / §12 门禁）；`docs/decisions/D-skill-tools.md`；`docs/done/P2-A.md`、`P2-B.md`、`P2-C.md`
> 日期：2026-10-23
> 状态：**WP2 完成（P2-A → P2-D）**。P2-D 只写文档 + 跑全量，没有改任何 `.ts` / `.css` / `.json` 代码文件。
> 验收基线：**`verify:all` 578 PASS / 0 FAIL（确定性 391 + smoke 187）；`verify:skills` 149/149；`verify:multitask` 174/174；`verify:migration` 44/44；Electron `--verify` 26/26；真实 agent 冒烟 PASS（1 次，未重跑）。**
> 验收差距：§5.6 第 2 条的 `CVE-2021-44228` **精确查询在真实库 0 命中**（`log4j`/`JNDI`/`Log4Shell` 有命中）；已如实记录，未在 P2-D 改代码，留给 WP6 评估（见“验收差距”）。

---

## 做了什么

WP2 把「技能已挂到四个 harness，但 app 的简报不注入」补成「每个 app 会话按题型/角色拿到 playbook，并能只读检索技能库」：

- **索引与路径**（P2-A）：`skill/index.ts` 懒构建内存索引（SKILL/知识库/idx/cheatsheet/AI 索引/wp-index/script-index），只读元数据 + 头几行；`skill/paths.ts` 做 realpath 根校验与逃逸拒绝；`HubSnapshot.skill?` 可选字段；`config` 增加 `skillDir` / `allowRunWeapon` / `mcpMode`。
- **简报与工具**（P2-B）：简报注入 `playbook`（8 题型 × 4 角色，16–18 条 + 常见坑）、`skill_routing`、`knowledge_tools`、`evidence_convention`，序列化 ≤8KB；MCP 新增 `skill_search` / `skill_read` / `skill_list`，与黑板工具同进程、同令牌、同审计；首次会话启动触发 `ensureIndex()` 并注入 `BUMIMANG_SKILL_DIR` / `BUMIMANG_SKILL_MCP`。
- **渲染层状态**（P2-C）：左栏顶部显示技能库已配置/未配置/错误/未检测；未配置时创建任务弹窗与任务卡明确提示但不阻塞；验证 P1-E 的 category 下拉并收敛派发；任务卡加可选简报预览槽位。
- **收口**（P2-D）：本文件 + `D-skill-tools.md` + `PROGRESS` + 五份 `wp2-final-*` 证据；不改代码。

**关键取舍**

- 技能索引不写 DB/磁盘缓存，懒构建、进程内复用；启动不扫 47.5MB。
- 只读工具复用黑板 MCP 的管道与每会话令牌，不新开旁路；`run_weapon` 默认关、本轮不实现。
- 简报只给 checklist + 路由 + 工具示例 + 证据约定，不给全文；全文走 `skill_read`。
- 未配置技能库是**提示**，不是门禁；用户可以先靠 playbook 打（P2-C 的明确行为）。

---

## WP2 目标与验收对照

### 1. 计划 §5.6 测试计划 7 条

| # | 计划要求 | 覆盖位置 | 结果 | 证据 / 说明 |
|---|---|---|---|---|
| 1 | `category=web` 简报含 Web checklist + `skill_routing`；`category=ir` 含应急 checklist；未知 category 有通用 checklist | `verify:skills` D 组 27 条 | **PASS** | `PASS D：web checklist 10–20 条 — steps=18`、`D：ir playbook 是应急检查表 — 应急响应检查表`、`D：unknown 走通用 checklist — 通用解题检查表`、`D：角色会改变检查表（lead ≠ recon）` |
| 2 | `skill_search("SSTI")` 命中 `SSTI.md`/`SSTI.idx.md`；`skill_search("CVE-2021-44228")` 命中相关知识库；`source=wp` 只返回 WP 索引命中 | `verify:skills` E 组 38 条 + 真实库只读查询 | **部分 PASS** | SSTI 与 source 过滤 PASS：`E：skill_search("SSTI") 命中 SSTI 路径`、`E：source=wp 只返回 wp-index 命中`、`E：source=scripts 只返回 script-index 命中`。**CVE-2021-44228 精确查询真实库 0 命中**；`log4j` 8 条、`JNDI` 12 条、`Log4Shell` 2 条（`evidence/wp2-final-cve-query.txt`）。原因见“验收差距” |
| 3 | `skill_read` 正常读；`../../`、绝对路径、symlink 越界全部拒绝；超过 256KB 截断并标记 | `verify:skills` B 组 18 + E 组 38 | **PASS** | `B：拒绝 ../ 逃逸`、`B：拒绝盘符路径`、`B：拒绝 junction 逃逸`、`E：skill_read 拒绝绝对路径`、`E：超过 256KB 截断并标记 — truncated=true bytes=262144` |
| 4 | `run_weapon` 对非白名单脚本拒绝；白名单 dry-run 成功；Python 缺失错误可读；默认关闭时调用被拒 | — | **DEFERRED（未实现）** | 计划 §5.5 把 `run_weapon` 标为可选；本轮 `weapon.ts` **未创建**，MCP 不注册，UI 不暴露；`allowRunWeapon=false` 只加载不消费。C 组验证了默认 false/非法值回落 false。实现前需先更新 `D-skill-tools.md` |
| 5 | 打包态 `skillDir` 指向外部目录可用；未配置时 `skill.configured=false`、UI/简报有说明 | `verify:skills` C 组 31 + P2-C 渲染层 + DOM 检查 | **PASS（解析/UI 层）** | `C：解析顺序 env 优先`、`C：无 env 时 config 优先`、`C：config 缺失时开发态探测`、`C：打包态 resources 兜底`、`C：未配置 configured=false`、`C：未配置 error 可读`；P2-C 三世界 DOM 检查 PASS。**打包 exe 端到端**留 WP7 |
| 6 | 简报 ≤8KB；`skill_list` 返回两个包与数量；MCP 令牌错误时所有 skill 工具拒绝 | `verify:skills` D 27 + E 38 | **PASS** | `D：简报序列化 ≤ 8KB — bytes=4462`、`D：超大黑板序列化仍 ≤ 8KB — bytes=7199`、`E：skill_list 返回两个包 — ctf-0day,ctf-solver`、`E：令牌错误时所有 skill 工具拒绝（连接直接断开） — closed=true result=null` |
| 7 | 真实 agent 冒烟（需同意，最多 1 次）：claude 会话在 Web 题调用 `skill_search` 并引用返回路径 | 真实冒烟（P2-B） | **PASS** | 1 个 claude 会话（lead/guarded/web），`skill_search` 2 次、`skill_read` 4 次，回复引用 `skills/ctf-0day/知识库/web/injection-test.md`，审批 0、无卡死；证据 `evidence/p2b-smoke.txt` |

**小计：5 条 PASS、1 条部分 PASS（CVE 精确查询）、1 条明确 DEFERRED（run_weapon 可选、未实现）。**

### 2. 计划 §5.4 简报字段

| 字段 | 状态 | 覆盖与关键值 |
|---|---|---|
| `playbook` | **PASS** | 8 题型 + `unknown`；4 角色叠加；每个组合 16–18 条 checklist + 常见坑；`D：web checklist 10–20 条 — steps=18` |
| `skill_routing` | **PASS** | 给出 `skills/...` 路径 + `when`；未配置时明确写“无技能库，使用 playbook 与已有工具”；`D：web routing 给出 SSTI 路径提示`、`D：未配置技能库时 skill_routing 明确写“无技能库”` |
| `knowledge_tools` | **PASS** | `skill_search` / `skill_read` / `skill_list` 的 args + example；未配置时 `available=false`；`D：knowledge_tools 可用并带调用示例` |
| `evidence_convention` | **PASS** | E0/E1/E2 + witness 规则；超长时**不截断**；`D：超长时 do_not 条目不丢 — actual=40 expected=40` |
| 8KB 上限 | **PASS** | 序列化 JSON 硬上限；正常 4462B、超大黑板 7199B；先截 suggestions/board 展示文本，不截 evidence/不丢 do_not |
| category / role | **PASS** | web/ir/unknown 各自 checklist；lead ≠ recon；`D：角色会改变检查表` |

### 3. 计划 §5.5 MCP 工具

| 工具 | 状态 | 覆盖与边界 |
|---|---|---|
| `skill_search(query, source, limit)` | **PASS** | 检索 SKILL/知识库/idx/cheatsheet/AI 索引/wp-index/script-index；返回 path/line/snippet/title/kind/score；`source=all|core|ctf|wp|scripts`；limit 生效 |
| `skill_read(path, offset?, limit?)` | **PASS** | 只读技能根内文件；256KB 截断标记；`../`、绝对路径、盘符、NUL、junction 全部拒绝 |
| `skill_list(category?)` | **PASS** | 返回两个包与 docs/knowledge/wps/scripts 统计 |
| `run_weapon` | **NOT IMPLEMENTED** | 默认关；MCP 不注册；UI 不暴露；实现前需更新决策 |
| 同进程/同令牌/同审计 | **PASS** | 复用 `mcp-host/bridge.ts` 与每会话 `BUMIMANG_TOKEN`；令牌错误直接断开；bridge 记录 `skill_search/skill_read/skill_list` 审计日志 |
| `BUMIMANG_SKILL_MCP=auto|on|off` | **PASS** | `on` 注册、`off` 不注册且黑板工具仍在、`auto` 默认注册；未配置技能库时 manager 强制 `off` |

### 4. 计划 §5.3 `skillDir` 解析顺序

| 顺序 | 候选 | 覆盖 |
|---|---|---|
| 1 | `BUMIMANG_SKILL_DIR` | `C：解析顺序 env 优先`；不存在时 `configured=false` 且 error 含变量名 |
| 2 | `config/app.json` 的 `skillDir` | `C：无 env 时 config 优先`；相对路径按配置目录解析 |
| 3 | 开发态 `<repo>/../skill` | `C：config 缺失时开发态探测` |
| 4 | 打包态 `resources/app-source/skill` | `C：打包态 resources 兜底` |
| 5 | 都没有 | `C：全部候选缺失 root=null`、`C：未配置 configured=false`、`C：未配置 error 可读`、`C：未配置时 ensureIndex 抛可读错误` |

**不写死 `D:\agent\skill`**：`config/app.json` 的本机值只是配置数据；代码按上述顺序解析，打包产物不依赖它。完整打包态端到端留 WP7。

---

## P2-A / P2-B / P2-C / P2-D 每步摘要与证据

| 步骤 | 一行摘要 | 关键数字 | Evidence |
|---|---|---|---|
| **P2-A** | 技能索引 + 路径安全 + 配置 + 可选快照字段（无行为变更） | `verify:skills` **80/80**（A31/B18/C31）；`verify:all` 553；multitask 174；migration 44；Electron 26；真实库 1560 files / 108 docs / 1027 wps / 110 scripts / 134ms | `evidence/p2a-verify-all.txt`、`p2a-skills.txt`、`p2a-multitask.txt`、`p2a-migration.txt`、`p2a-electron-verify.txt`、`p2a-skills-red.txt` |
| **P2-B** | 简报按题型/角色注入 + MCP 技能工具 + 会话启动接线（加法行为变更） | `verify:skills` 80→**149/149**（A31/B18/C31/D27/E38/F4）；`verify:all` 553；multitask 174；migration 44；Electron 26；真实库 81ms | `evidence/p2b-verify-all.txt`、`p2b-skills.txt`、`p2b-multitask.txt`、`p2b-migration.txt`、`p2b-electron-verify.txt`、`p2b-skills-red.txt`、`p2b-skills-real-lib.txt`、`p2b-smoke.txt` |
| **P2-C** | 渲染层技能库状态 + 未配置提示 + category 验证 + 简报预览槽位（渲染层加法） | smoke 162→**187（+25）**；`verify:all` **578**（391+187）；skills 149；multitask 174；migration 44；Electron 26；DOM 三世界 PASS | `evidence/p2c-verify-all.txt`、`p2c-skills.txt`、`p2c-multitask.txt`、`p2c-migration.txt`、`p2c-electron-verify.txt`、`p2c-smoke-red.txt`、`p2c-smoke.txt`、`p2c-ui-dom-check.txt` |
| **P2-D** | WP2 总收口：本文件 + `D-skill-tools.md` + PROGRESS + 五份最终证据；不改代码 | **578 / 149 / 174 / 44 / 26** | `evidence/wp2-final-verify-all.txt`、`wp2-final-skills.txt`、`wp2-final-multitask.txt`、`wp2-final-migration.txt`、`wp2-final-electron-verify.txt`、`wp2-final-cve-query.txt` |

> 计划 §5.2 文件清单里的 `skill/weapon.ts` **未创建**：`run_weapon` 是可选工具，本轮明确不实现；其余计划文件均已落地，`docs/decisions/D-skill-tools.md` 由 P2-D 补写。

---

## 行为变更汇总

**都是加法，不是改语义。** 现有字段/动作没有被删除或改变含义；旧渲染层、旧 mock、旧测试仍可工作。

| 变更 | 步骤 | 类型 | 说明 |
|---|---|---|---|
| `HubSnapshot.skill?` 可选字段 | P2-A | 加法 | 旧快照不带它时渲染层显示“未知/未检测”，不炸 |
| 简报新增 `playbook` / `skill_routing` / `knowledge_tools` / `evidence_convention` | P2-B | 加法 | 只发给 agent；现有简报字段语义不变 |
| MCP 新增 `skill_search` / `skill_read` / `skill_list` | P2-B | 加法 | 与黑板工具同进程/同令牌/同审计；`off` 时不注册 |
| 会话启动注入 `BUMIMANG_SKILL_DIR` / `BUMIMANG_SKILL_MCP` | P2-B | 加法 | 未配置时强制 `off`，简报写“无技能库” |
| 渲染层技能库状态条 + 未配置/错误提示 | P2-C | 加法 | 只是提示，不阻塞创建/启动 |
| category 归一化 + priority 校验 | P2-C | 渲染层内部收敛 | 下拉仍是 P1-E 的 9 值；非法值→`unknown` |
| 简报预览可选槽位 | P2-C | 加法/前向兼容 | 快照带字段才显示；真实主进程当前不带，隐藏 |

与 WP1 的四个行为变更（切题不停会话、任意任务起会话+配额、重启恢复+归档、渲染层多任务看板）并列记录；WP2 没有改这些语义。

---

## 真实 agent 冒烟结果

- **时间**：2026-10-23 08:25:13Z → 08:27:38Z（UTC）；**只跑 1 次，未重跑**。
- **参数**：claude；1 个会话；role=`lead`；tier=`guarded`；`task.category=web`；sessionId=`s1`（ACP session `6ea114b6-9c6b-47cf-9895-4edb37057977`）。
- **结果**：**PASS**。
  - bridge `skill_search` **2 次**、`skill_read` **4 次**、`skill_list` 0 次；
  - 回复引用的 path：`skills/ctf-0day/知识库/web/injection-test.md`；
  - 审批请求 **0**，无审批卡死；冒烟 prompt 轮 `stopReason=end_turn`，约 **22s**；
  - token 用量不可得（ACP `session/prompt` 只返回 `stopReason`）。
- **证据**：`evidence/p2b-smoke.txt`（sha256 `f545925917ceaee2bdddd60b32fc21d6dec60de08bb2d8fceb262b99fabd6e6e`）；未贴 agent 回复全文。

---

## 冒烟轮观察（必须单列，交接 WP6）

> 这不是 bug，是简报“现在开始”的设计意图；但会影响 benchmark 的计时/计量口径。

1. **简报本身是“开始解题”型 prompt**：claude 在收到简报后就开始调用 `skill_search` / `skill_read` 并尝试工作；在 harness 的 **120s 保护阈值**内没有结束。产品没有超时/失败；120s 是本次 harness 的保护阈值。
2. **harness 中断简报轮后才发冒烟 prompt**：harness 用 120s 上限中断了简报轮，然后发送冒烟 prompt 原文；冒烟 prompt 轮 **22s** 完成，`stopReason=end_turn`。
3. **简报轮内写了验证文件**：agent 在任务工作目录（`.probe/p2b-smoke/work/.../evidence/`）写了一个验证文件；这是简报“现在开始”引导出的正常行为，不在冒烟 prompt 的“不要写文件”约束内（该约束在简报轮之后才发送）。临时目录已随 harness 删除。
4. **对 WP6 的影响**：
   - benchmark 的**首答时间 / makespan / 工具调用数**必须把“简报轮”和“显式 prompt 轮”**分开统计**；否则首答会被简报轮污染。
   - soak 也要把简报轮的活跃度算进去（它不是空转）。
   - bridge 的 skill 工具计数包含简报轮 + 冒烟 prompt 轮；冒烟 prompt 轮的时间戳（08:27:15 之后）可单独确认。
   - 不建议为了 benchmark 改简报措辞；如果比赛节奏要求“先确认工具可用再开工”，再单独评估。

---

## 已知限制清单

> 每条写清“现状 / 为什么不修 / 留到哪一步”。P2-D 不改代码。

1. **简报预览仅 mock 可见，真实 Electron 隐藏**：P2-B 的简报只注入 agent（`SessionManager.briefings`），主进程快照没有暴露；P2-C 做成渲染层可选前向兼容槽位（`briefingPreview`），字段缺席时整块不显示。**不发 B-to-A 请求**（契约冻结）；若 WP6 需要真实预览再评估。
2. **`run_weapon` 未实现**：`allowRunWeapon=false` 只加载不消费；没有 `weapon.ts`；MCP 不注册；UI 不暴露。原因：执行攻击脚本风险高，比赛期不默认开；实现前先更新 `D-skill-tools.md`（白名单/无 shell/cwd/60s/1MB/审计/策略）。
3. **`ctf-solver` 根目录主题 `.md`（如 `SSTI.md`）不进 docs 索引**：`skill_search` 不返回它们；routing 会给路径提示，`skill_read` 可读（`resolveWithinRoot` 允许）。是否纳入索引留给 **WP6** 评估；P2-C 未改 `skill/index.ts`。
4. **`skill.builtAt` 是懒构建语义**：首次会话/首次 `skill_*` 调用前为 `null`；P2-C 显示“未构建（懒构建）”是**正确状态**，不是缺陷。启动不扫 47.5MB 是刻意设计。
5. **跨任务批量授权 `permission.grantAll.taskId` 仍未实现**：WP1 遗留，WP2 未处理；`scope=session/agent/all` 仍只取焦点任务会话。留给 **WP6** 评估。
6. **token 用量不可得**：ACP `session/prompt` 只返回 `stopReason`，不含 usage；WP6 用外部代理指标（进程 CPU / 时长 / 工具调用次数）。
7. **`BUMIMANG_SKILL_MCP=auto` 无法探测宿主同名工具**：stdio MCP server 看不到聚合后的其他 server 工具名；`auto` 只记 stderr warning，冲突时用户显式设 `off` 兜底。
8. **技能库未配置只是提示，不阻塞**：创建任务、启动会话、审批、台账全部可用；用户可先靠 playbook 打。渲染层文案明确“agent 将拿不到技能检索，仅能用 playbook 与已有工具”，但不禁用按钮。

### 验收差距（§5.6 第 2 条）

- **`CVE-2021-44228` 精确查询真实库 0 命中**；`log4j` 8 条、`JNDI` 12 条、`Log4Shell` 2 条，`CVE` 20 条（limit）。
- 原因：`skill_search` 按设计只检索**元数据 + 头几行摘要**，不读 WP 全文；真实库的标题/标签/摘要里没有这个完整 CVE 串。这是“不把 1027 篇全文塞进上下文”的取舍，不是工具坏了。
- 处理：P2-D **不改代码**；建议 WP6 评估是否从 WP 标题/标签中抽取 CVE ID 做轻量索引，或让 `skill_search` 对长 token 做分段回退。当前检索 `log4j`/`JNDI`/`Log4Shell` 仍可到达相关知识。
- 证据：`evidence/wp2-final-cve-query.txt`（sha256 `089e5acbc43135a44580e3524d1700d03385191e95be770aa91b73cb8c00207d`）。

### 其它边界

- **8KB 是序列化 JSON 硬上限**：渲染后的 prompt 会因编号/缩进略长；极端情况下压缩单条文本但保留全部 `do_not` 条目，`evidence_convention` 永不截断。
- **`skill_read.totalLines`**：文件 >256KB 时按已读取部分计行；正常文件是全文行数。
- **WP/脚本索引路径可能不可直接读**：`wps[].path` 可能来自 `local_path`/`upstream_path`/`wp_url`，`scripts[].relativePath` 不一定相对技能根；`skill_search` 会返回它们，`skill_read` 对根外/不存在路径会拒绝。工具描述已提示“读不到时改用路径目录做 search”。
- **真实库 F 组只读探测**：`verify:skills` 的 F 组读真实库（81–90ms，只读摘要）；不在 `verify:all` 链里；目录不存在时 `SKIP`。
- **打包态 `skillDir` 端到端未验证**：本轮只验证解析顺序与未配置状态；完整打包/干净机器留 WP7。
- **没有真实 8 会话长跑**：内存/事件量留给 WP6 soak。

---

## 验收数字

| 项 | 数字 | 证据 |
|---|---|---|
| `npm run verify:all` | **578 PASS / 0 FAIL**（确定性 391 = 52+16+17+19+90+148+49；smoke 187） | `evidence/wp2-final-verify-all.txt` |
| `npm run verify:skills` | **149/149**（A31+B18+C31+D27+E38+F4） | `evidence/wp2-final-skills.txt` |
| `npm run verify:multitask` | **174/174** | `evidence/wp2-final-multitask.txt` |
| `npm run verify:migration` | **44/44** | `evidence/wp2-final-migration.txt` |
| Electron `--verify` | **26/26** | `evidence/wp2-final-electron-verify.txt` |
| Renderer smoke | **187 PASS / 0 FAIL** | `evidence/p2c-smoke.txt` |
| 真实 agent 冒烟 | **PASS**（1 次，未重跑） | `evidence/p2b-smoke.txt` |
| P2-C DOM 检查 | **PASS**（configured/unconfigured/none） | `evidence/p2c-ui-dom-check.txt` |

证据 sha256：

| 文件 | sha256 |
|---|---|
| `evidence/wp2-final-verify-all.txt` | `0417ef5e66e79f357c97b0306080e5e95017111e073767d40e7d24ff2f21a2c3` |
| `evidence/wp2-final-skills.txt` | `865ae1ccc900d48e4f3eb47774f9ada552c748712514499ec807c1bf7d351ce7` |
| `evidence/wp2-final-multitask.txt` | `681f75fcb60a89bb18be0420b2c23e406e42c23df1eeaf3bd25235cabd76f912` |
| `evidence/wp2-final-migration.txt` | `e82070d7759c845f5b2d45e276fca31eb43a28de82c07c50e8f5d78b91fcc0b6` |
| `evidence/wp2-final-electron-verify.txt` | `8d44e3345db62f87f3b31ae70834b9f3497181914f41aa834d36a98993563f4a` |
| `evidence/wp2-final-cve-query.txt` | `089e5acbc43135a44580e3524d1700d03385191e95be770aa91b73cb8c00207d` |
| `evidence/p2b-smoke.txt` | `f545925917ceaee2bdddd60b32fc21d6dec60de08bb2d8fceb262b99fabd6e6e` |
| `evidence/p2b-skills-real-lib.txt` | `13f5a7d4baa66f3cefc6467acaa44fe1b978e9dcebb0b9408e9fe86f7d7d3218` |
| `evidence/p2c-verify-all.txt` | `dfbd42fca74c1e23b71b15389c51b7bf39b7d7a34ff65889a59f7ffa8e498d77` |
| `evidence/p2c-smoke.txt` | `457e56e2dea203289c06a9fed32b6029c7f6c1bcfee3f89b7dee5819f4a5bd27` |
| `evidence/p2c-ui-dom-check.txt` | `3456689aac6c8735866dcdceb4a7683903022bbc3c7e7d09180e6966e6536bc6` |

`.probe/backup-wp1/board.db`：348160 字节，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录一致；WP2 期间未改真实库/技能库。

---

## smoke 121 → 162 → 187 的说明

- **P1-E：121 → 162（+41）**：多任务看板/配额/全局审批/后台计数/焦点 pane 上限等；旧 121 条零删除、零改名（详见 `docs/done/WP1-multitask.md`）。
- **P2-C：162 → 187（+25）**：技能库状态/未配置提示/category 验证/简报预览；旧 162 条零删除、零改名。
- **交叉核对（P2-D 只读）**：
  - 对 `.probe/backup-p1e/renderer/smoke.ts`（P1-E 前，121 条）比对当前：**old=121, missing=0, added=66**；
  - 对 `.probe/backup-p2c/renderer/smoke.ts`（P2-C 前，162 条）比对当前：**old=162, missing=0, added=25**。
- **P2-C 新增 25 条断言清单**：
  1. P2-C mock：已配置世界带 root / 2 个包 / 索引时间
  2. P2-C store：快照 skill 被折叠为 skillStatus（旧快照缺席为 null）
  3. P2-C 顶部：已配置显示 root + 包数 + 索引时间
  4. P2-C 顶部：点击展开能看到 root 与 packages
  5. P2-C 已配置：不出现未配置提示（不误报）
  6. P2-C mock：未配置世界 configured=false 且带 error
  7. P2-C 顶部：未配置显示「技能库未配置」
  8. P2-C 创建任务弹窗：未配置时给出明确提示
  9. P2-C 未配置提示不是禁用：仍说「仅能用 playbook 与已有工具」
  10. P2-C 顶部：错误态显示 error 文案
  11. P2-C 错误态也提示但不禁用
  12. P2-C store：旧快照不带 skill 时 skillStatus=null（不炸）
  13. P2-C 顶部：旧快照显示「未知/未检测」
  14. P2-C 旧快照不产生未配置提示（不把「未检测」当未配置）
  15. P2-C category 下拉：包含 web / ir / unknown（P1-E 已有，本步只验证）
  16. P2-C category 文案：Web / 应急 / 未分类
  17. P2-C category 未知值归一为 unknown（不把非法值发给后端）
  18. P2-C priority 校验：0–100 整数，空为默认
  19. P2-C 简报预览：显示 playbook 标题 + routing 条数 + tools 可用
  20. P2-C 简报预览：不展示全文（只有标题/条数/可用性/摘要）
  21. P2-C 简报预览：未配置世界 routing=0 / tools 不可用（仍显示 playbook）
  22. P2-C 简报预览：无 task / 无简报字段时不显示
  23. P2-C mock hub：快照保留 skill（configured + 2 个包）
  24. P2-C 未配置不阻塞：mock 仍允许起会话（提示不是禁用）
  25. P2-C 旧 mock 世界仍不带 skill（向后兼容）

---

## WP3 之前必须知道的事（交接）

1. **简报字段已就位但只发 agent**：`playbook` / `skill_routing` / `knowledge_tools` / `evidence_convention` 在 `SessionManager.briefings` 里，主进程快照**不暴露**；渲染层只有 P2-C 的前向兼容 `briefingPreview` 槽位。WP3 若要在 UI 展示简报，先走契约请求。
2. **MCP 工具管线可复用**：`skill_*` 的注册（`mcp-host/server.ts`）、桥路由/令牌（`bridge.ts`）、审计日志、输出上限、路径边界（`skill/paths.ts`）可以作为 WP3 artifact/evidence 工具的参照；不要新开旁路。
3. **未配置世界已有 UI 提示**：P2-C 的技能库状态条/任务卡/创建弹窗已占位“技能库未配置”；WP3 的附件/工件面板不要与之冲突，也不要把它做成禁用条件。
4. **契约冻结**：WP3 若需要新的 `HubAction` / `HubEvent` / 快照字段，先写 `docs/requests/` 并停下问用户；不要直接改 `events.ts`。
5. **WP6 的简报轮统计口径**：见“冒烟轮观察”；benchmark 的计时/计量必须把简报轮与显式 prompt 轮分开，soak 也要算简报轮活跃度。

---

## 没做什么 / 已知问题

- **P2-D 不改代码**：没有改 `.ts` / `.css` / `.json`；没有改 `hub.ts`、`board.ts`、`session/manager.ts`、`briefing/**`、`mcp-host/**`、`skill/**`、`renderer/**`、`events.ts`、`config/**`、四个 verify 套件、`smoke.ts`、`mock/**`、`package.json`、`verify:all` 链。
- **没有跑真实 agent、没有烧 token**：冒烟已在 P2-B 用掉 1 次；P2-D 0 token。
- **`run_weapon` 未实现**：计划 §5.5 的可选工具；`weapon.ts` 未创建；配置只加载不消费。
- **CVE 精确查询未命中**：见“验收差距”；P2-D 未改检索代码。
- **没有发 `docs/requests/B-to-A-*.md`**：简报预览作为已知限制，不破契约。
- **没有做 WP3–WP8**：附件/工件/证据链、目标范围、flag 闭环、benchmark、打包、AWD/应急设计都还没开始。
- **没有重打包**：`dist/` 不是本轮产物；打包态 `skillDir` 端到端留 WP7。
- **没有改 `D:\agent\skill`、没有改全局配置、没有改 `docs/ARCHITECTURE.md`、没有删测试、没有自动提交 flag。**
- **未验证项**：打包态外部 `skillDir` 端到端；真实 8 会话长跑内存/事件量；`auto` 同名工具冲突的真实宿主；`run_weapon` 的任何执行路径。

---

## 下一手需要什么

- 等你确认 WP2 收口后，进入 **WP3（题目接入、工件与证据链）**；本轮不开始 WP3。
- 保持门禁：`verify:all` **578**、`verify:skills` **149**、`verify:multitask` **174**、`verify:migration` **44**、Electron **26**、smoke **187**。
- WP3 若需要新契约字段/动作/事件：先写 `docs/requests/` 并停下问用户；不要直接改 `events.ts`。
- WP6 评估：简报轮/显式 prompt 轮分开统计；`ctf-solver` 根目录主题 `.md` 是否纳入索引；CVE 精确检索的轻量索引/分段回退；跨任务批量授权。
- 若后续实现 `run_weapon`：先更新 `docs/decisions/D-skill-tools.md`，再写代码；默认保持关闭。
- 如果全量数字与 P2-C 不一致（有人顺手改了代码），先停下报差异，不要自行修。
