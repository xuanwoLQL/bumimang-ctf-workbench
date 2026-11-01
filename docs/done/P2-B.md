# P2-B · 简报注入 + MCP 技能工具

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP2；`docs/plans/COMPETITION-READINESS.md` §5.4/§5.5/§5.6；`docs/done/P2-A.md`；`docs/done/WP1-multitask.md`
> 日期：2026-10-23
> 状态：**P2-B 代码、确定性验收与真实 agent 冒烟均完成（冒烟 PASS，带观察）**。没有进入 P2-C。
> 验收：`verify:all` **553 PASS / 0 FAIL**；`verify:skills` **149/149**（A31/B18/C31/D27/E38/F4）；`verify:multitask` **174/174**；`verify:migration` **44/44**；Electron `--verify` **26/26**；真实冒烟 **PASS**（`evidence/p2b-smoke.txt`）。

---

## 做了什么

补齐 WP2 的第二半：**简报按题型/角色注入** + **技能库只读 MCP 工具** + **会话启动接线**。

- **简报**：新增可选字段 `playbook`（8 题型 × 4 角色的 16–18 条 checklist + 常见坑）、`skill_routing`（题型/角色的路径提示 + when）、`knowledge_tools`（skill_search/read/list 示例）、`evidence_convention`（E0/E1/E2 + witness 规则）；序列化 ≤ 8KB，超长先截 suggestions，再截 board 展示文本，`evidence_convention` 永不截断、`do_not` 条目不丢。
- **MCP 工具**：`skill_search` / `skill_read` / `skill_list` 与黑板工具同进程、同管道、同会话令牌；主进程 bridge 路由 + 审计日志；`skill_read` 全部过 `resolveWithinRoot`，256KB 截断标记；`run_weapon` **未实现、默认关**。
- **接线**：`SessionManager.startSession` 首次触发 `ensureIndex()`（懒构建）、注入 `BUMIMANG_SKILL_DIR` / `BUMIMANG_SKILL_MCP`；`sendBriefing` 把 task.category + role 传给简报；Electron 主进程把 `SKILL` 同时交给 bridge 与 manager。
- **注册模式**：`BUMIMANG_SKILL_MCP=auto`（默认注册）/`on`（强制注册）/`off`（不注册）；未配置技能库时 manager 强制 `off`，简报明确写“无技能库”。

**关键取舍**

- `playbook` 用「题型基础表 + 角色叠加」拼装，而不是抄 32 份完整表：每个组合 16–18 条，角色差异明确，数据可维护。
- 技能工具不读索引白名单：`skill_read` 只做路径边界；`ctf-solver/SSTI.md` 这类根目录全文可以被 routing 提示并按路径读取，但 `skill_search` 不会返回它（docs 索引范围未改）。
- 8KB 是**序列化 JSON** 的硬上限；渲染后的 prompt 会因编号/缩进略长，这是有意的（限制的是注入包体积，不是最终文本）。
- 自动探测宿主同名工具在 stdio MCP server 里做不到：`auto` 只记 warning，冲突时用户显式设 `off`。

---

## 行为变更

> 语义上都是**加法**（旧字段/旧路径不变），但按总控要求单独列出，与 WP1 的四个行为变更并列记录。

1. **简报新增 4 个可选字段**：`playbook`、`skill_routing`、`knowledge_tools`、`evidence_convention`。`playbook` 总是存在（纯数据）；`skill_routing` 未配置技能库时带 `note:"无技能库，使用 playbook 与已有工具"`；`knowledge_tools.available=false`。
2. **MCP 新增 3 个只读工具**：`skill_search` / `skill_read` / `skill_list`，与黑板工具同令牌、同审计；`BUMIMANG_SKILL_MCP=off` 时不注册；`run_weapon` 不注册（未实现）。
3. **会话启动注入技能环境变量**：`BUMIMANG_SKILL_DIR`（配置了才有）与 `BUMIMANG_SKILL_MCP`；首次 `startSession` 触发 `ensureIndex()`，之后快照 `skill.builtAt` 有值。
4. **旧渲染层/旧 mock 不读新字段也能工作**：新增字段全部可选；`HubSnapshot.skill?` 仍是 P2-A 的可选字段；`verify:all` 的 162 条 smoke 未改、全绿。

与 WP1 四个行为变更（切题不停会话、任意任务起会话+配额、重启恢复+归档、渲染层多任务看板）是并列关系；P2-B 没有改这些语义。

---

## 改了哪些文件

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/briefing/playbooks.ts` | 8 题型 + unknown 的基础 checklist、4 角色叠加、常见坑；纯数据 |
| `apps/desktop/src/main/briefing/routing.ts` | 题型/角色 → `skills/...` 路径提示 + when；未配置时明确“无技能库” |
| `apps/desktop/src/main/skill/tools.ts` | `skillSearch` / `skillRead` / `skillList` 的纯函数实现 |
| `docs/done/P2-B.md` | 本文件 |

**修改**

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/main/briefing/build.ts` | 新增 4 个可选字段；8KB 截断器 `fitBriefingToLimit`；`renderBriefingPrompt` 新增四段（仅在字段存在时输出）；现有字段语义不变 |
| `apps/desktop/src/main/mcp-host/protocol.ts` | 新增 `skill.search` / `skill.read` / `skill.list` 三个桥方法 |
| `apps/desktop/src/main/mcp-host/server.ts` | 按 `BUMIMANG_SKILL_MCP` 注册 3 个只读工具；`auto` 记同名冲突 warning；`off` 不注册 |
| `apps/desktop/src/main/mcp-host/bridge.ts` | 新路由 3 个 skill 方法；复用令牌绑定；每次调用写审计日志；输出上限由 tools 层保证 |
| `apps/desktop/src/main/session/manager.ts` | 首次 startSession `ensureIndex()`；MCP env 注入 `BUMIMANG_SKILL_DIR`/`BUMIMANG_SKILL_MCP`；sendBriefing 传 skill 状态 |
| `apps/desktop/src/main/electron/main.ts` | `SKILL` 传给 `BoardBridge` 与 `SessionManager`；启动恢复/配额/审批守卫未改 |
| `apps/desktop/src/cli/verify-skills.ts` | 扩到 6 组：A/B/C 保留，新增 D（简报注入 27 条）、E（工具+注册+令牌+manager 接线 38 条）、F（真实库探测 4 条） |
| `docs/PROGRESS.md` | 追加一行 |

**没有碰**：`skill/paths.ts`、`skill/index.ts`（扫描范围/校验逻辑未改）、`hub/hub.ts`、`blackboard/board.ts`、`session/manager.ts` 的 `restoreSessions({recover:false})` 与配额/收敛、`renderer/**`、`packages/shared-protocol/events.ts`、`config/app.json` / `config/loader.ts`、`package.json`（`verify:skills` P2-A 已存在）、`run_weapon`/`weapon.ts`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify:all` 链、`D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置。

**备份**：`.probe/backup-p2b/`（build/protocol/server/bridge/manager/electron-main/verify-skills 共 7 个文件）。

---

## 怎么验证的（真实输出）

### 1. 先红后绿

红测 1：只加 D 组、实现前——`verify-skills` **84/107**，D 组 23 条失败（`playbook=undefined`、`skill_routing=undefined`、`knowledge_tools=undefined`、超大黑板 55,422B）：

```text
FAIL  D：web 简报带 playbook  — actual=undefined expected="web"
FAIL  D：web 简报带 skill_routing  — suggestions=undefined
FAIL  D：超大黑板序列化仍 ≤ 8KB  — bytes=55422
...
================ 84/107 通过 ================
```

红测 2：E/F 组实现前——`tools.ts` 不存在，模块加载即失败：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\agent\xuanwo\apps\desktop\src\main\skill\tools.ts'
```

两份红测合并保存在 `evidence/p2b-skills-red.txt`。

### 2. `npm run verify:skills`（6 组）

```text
================ A 索引构建（fixture）================
================ B 路径越界 ================
================ C 未配置 / 配置解析 ================
================ D 简报注入 ================
================ E MCP 技能工具 ================
================ F 真实库只读探测（不进 verify:all）================

F：真实库索引 root=D:\agent\skill docs=108 wps=1027 scripts=110 files=1560 耗时=81ms

================ 149/149 通过 ================
```

分组：A 31、B 18、C 31、D 27、E 38、F 4。关键断言：

```text
PASS  D：web checklist 10–20 条  — steps=18
PASS  D：ir playbook 是应急检查表  — 应急响应检查表
PASS  D：unknown 走通用 checklist  — 通用解题检查表
PASS  D：角色会改变检查表（lead ≠ recon）  — lead=18 recon=18
PASS  D：简报序列化 ≤ 8KB  — bytes=4462
PASS  D：超大黑板序列化仍 ≤ 8KB  — bytes=7199
PASS  D：超长时 do_not 条目不丢  — actual=40 expected=40
PASS  D：未配置技能库时 skill_routing 明确写“无技能库”  — 无技能库，使用 playbook 与已有工具
PASS  E：skill_search("SSTI") 命中 SSTI 路径  — ["idx:skills/ctf-solver/SSTI.idx.md","knowledge:skills/ctf-0day/知识库/SSTI.md","wp:CTF大赛WP集合/fixture-1.md"]
PASS  E：source=wp 只返回 wp-index 命中  — ["wp"]
PASS  E：source=scripts 只返回 script-index 命中  — ["script"]
PASS  E：skill_read 拒绝 junction 逃逸  — SkillPathError/escape
PASS  E：超过 256KB 截断并标记  — truncated=true bytes=262144
PASS  E：BUMIMANG_SKILL_MCP=off 不注册 skill_*  — ["blackboard_read_since", ...]
PASS  E：令牌错误时所有 skill 工具拒绝（连接直接断开）  — closed=true result=null
PASS  E：首次会话启动触发 ensureIndex  — builtAt=1792742889471
PASS  E：MCP env 注入 BUMIMANG_SKILL_MCP=auto  — found
PASS  E：manager 简报按 category 注入 playbook  — actual="web" expected="web"
PASS  F：真实库 wps ≥ 1000  — wps=1027
PASS  F：真实库 scripts ≥ 100  — scripts=110
```

证据：`evidence/p2b-skills.txt`；F 组单独摘录：`evidence/p2b-skills-real-lib.txt`。

### 3. 全量回归

```text
$ npm run verify:all
553 PASS / 0 FAIL，exit=0（确定性 391 + smoke 162）

$ npm run verify:multitask
174/174，exit=0

$ npm run verify:migration
44/44，exit=0

$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
[main] 技能库：D:\agent\skill（ctf-0day, ctf-solver；索引懒构建）
[verify] 26/26 通过
```

Electron 启动日志**没有** `[skill] 索引构建完成`：`--verify` 只派发了一个非法 `session.start`（tier 错），在 spawn 前被拒，所以启动仍不扫描技能库。

证据：`evidence/p2b-verify-all.txt`、`p2b-multitask.txt`、`p2b-migration.txt`、`p2b-electron-verify.txt`。

### 4. 证据文件（sha256）

| 文件 | sha256 |
|---|---|
| `evidence/p2b-verify-all.txt` | `51f65d4db6c550a42e0630baba71ef079d153c469dd84f06881c005ea54d3a38` |
| `evidence/p2b-multitask.txt` | `d958c7b5eb5332636452aa4b4f157baffb1c0032f5e47821bad5da12f2301548` |
| `evidence/p2b-migration.txt` | `d4f1bfc1484e8d02b66eefe52ccf900668b40f33de868a902e7b20816a8cf400` |
| `evidence/p2b-skills.txt` | `66bd501b32a052e11f50213ef41c5f5c22f792f65129d06357a066cf6284675f` |
| `evidence/p2b-skills-red.txt` | `a4949d32d086ec7e8cfc291bb50ab8f14be000155a6ff6f7669c2b9fcd7c971d` |
| `evidence/p2b-electron-verify.txt` | `044480a24e89d4cce73dc1d490c437eba2a40f32f10b08099c8e75cbb35b0aca` |
| `evidence/p2b-skills-real-lib.txt` | `13f5a7d4baa66f3cefc6467acaa44fe1b978e9dcebb0b9408e9fe86f7d7d3218` |

---

## 没做什么 / 已知问题

### 已知中间状态（按约定留给后续）

- **`run_weapon` 未实现**：`skill.allowRunWeapon=false` 只加载不消费；没有 `weapon.ts`；MCP 也不注册 `run_weapon`。
- **ctf-solver 根目录主题 `.md` 不进 docs 索引**：`SSTI.md`、`SQL.md` 等全文不在 `skill_search` 的 docs 里；routing 会给路径提示，`skill_read` 可读（`resolveWithinRoot` 允许），但 `skill_search` 不会返回它。是否纳入索引留给 WP6 评估，本轮未改 `skill/index.ts` 扫描范围。
- **`skill.builtAt` 是懒构建语义**：首次会话启动/首次 `skill_*` 调用前为 `null`；启动后立即读快照仍可能为 `null`，这是正确行为。
- **renderer 未显示 skill 状态、未加 category 下拉、未提示“技能库未配置”**：P2-C。
- **跨任务批量授权（`permission.grantAll.taskId`）仍未实现**：WP1 已知限制，WP2 不处理。
- **`auto` 无法探测宿主同名工具**：stdio MCP server 看不到聚合后的其他 server 工具名；`auto` 只记 stderr warning，冲突时用 `BUMIMANG_SKILL_MCP=off`。
- **WP/脚本索引路径可能不可直接读**：`wps[].path` 可能来自 `local_path`/`upstream_path`/`wp_url`，`scripts[].relativePath` 是 jsonl 里的相对路径（不一定相对技能根）；`skill_search` 会返回它们，`skill_read` 读到根外/不存在会拒绝。工具描述已提示“读不到时改用路径目录做 search”。
- **8KB 是序列化 JSON 上限**：极端情况下（`do_not` 条目非常多）会压缩单条文本但保留全部条目；`evidence_convention` 永不截断。
- **`skill_read` 的 `totalLines`**：文件 >256KB 时按已读取部分计行；正常文件是全文行数。
- **`verify:skills` 的 F 组会读真实库**（81ms，只读摘要）；目录不存在时 `SKIP`，不影响 A–E。F 不在 `verify:all` 链里。
- **`verify:all` 里不会触发真实库扫描**：所有简报/工具测试用 `.ui-run/skills-fixture`；`verify:all` 不构造带 `SkillRuntime` 的 manager/bridge。

### 其它边界

- **没有跑真实 agent、没有烧 token**：全部 fake agent / 进程内桥 / 临时 SQLite。
- **没有改 `D:\agent\skill`**：只读探测 1 次（1560 files / 1027 wps / 110 scripts / 81ms）。
- **没有改契约 `events.ts`**：`HubSnapshot.skill?` 是 P2-A 的字段，本轮未新增 action/event。
- **没有改 `verify:all` 链**、没有删测试、没有自动提交 flag、没有改全局配置。
- **`skill_read` 对根目录主题 `.md` 的读取是允许的**（与 routing 一致）：只有 `skill_search` 不返回未入索引的文件；这是本轮明确的“一致但不对称”状态。

---

## 下一手需要什么

- **真实 agent 冒烟已完成（PASS）**：见“冒烟结果”一节；未重跑。
- 下一步：等你确认后进入 **P2-C**（renderer category 下拉 + 未配置提示 + skill 状态显示）。
- P2-C 需要的数据已具备：`HubSnapshot.skill`（configured/root/packages/builtAt）、`TaskView.category`、简报字段；不需要新契约字段。
- 若后续要评估 `run_weapon`：先补 `docs/decisions/`，再实现白名单/无 shell/任务目录 cwd/60s/1MB/审计；本轮未动。
- 保持门禁：`verify:all` 553、`verify:multitask` 174、`verify:migration` 44、`verify:skills` 149、Electron 26。

---

## 真实 agent 冒烟提案（**等你批 token 后再跑**）

### 目的

验证真实 claude 会话在 Web 题上**会调用 `skill_search` 并引用返回路径**，且工具经过同一桥/令牌，不是只在单测里可用。

### 计划

- **会话数**：1 个（claude，role=lead，tier=guarded）。
- **任务**：category=`web`，title=`P2-B 冒烟：Web SSTI`，brief 明确要求“先检索技能库”。
- **prompt 原文（计划）**：

```text
这是一道 Web 模板注入题。请先调用 MCP 工具 skill_search，query 用 "SSTI"，
从返回结果里挑一条路径，用一句话说明你选它的理由；然后调用 skill_read 读取该路径的前 40 行。
不要执行任何攻击命令，不要写文件。最后只回复：调用了哪些工具、命中的 path、耗时。
```

- **预期 token 量级**：约 **20k–40k** 总 token（简报 ~5KB + claude 自身 system prompt + 2 次工具往返 + 短回复）；不会开多会话、不会跑 benchmark。
- **预计耗时**：1–3 分钟。
- **成功判据**：bridge 日志出现 `skill_search session=...` 与 `skill_read ...`；回复里引用 `skills/...` 路径；无审批卡死。
- **失败回退**：
  1. 若 agent 完全没调用工具：先查 wire.jsonl / bridge 日志确认 MCP 子进程是否连上、`skill_*` 是否出现在 tools/list；**不自行重跑**（每 WP 最多 1 次），把现象写进“冒烟结果”并给出下一步建议。
  2. 若工具可见但调用报错：记录错误文本（令牌/路径/索引），修确定性测试覆盖的同类问题后再申请第二次。
  3. 若审批卡住：说明该 agent 的权限行为，记录并停止会话，不自动放行高风险动作。

### 边界

- 跑前把 **prompt 原文**贴给你确认；
- 跑后只记录“调用了/没调用、命中的路径、耗时”，**不贴全文**；
- 不写仓库文件、不提交 flag、不攻击任何目标；
- 冒烟结果补进本文件“冒烟结果”一节后，才开始 P2-C。

---

## 冒烟结果

> 2026-10-23 16:25–16:27（本地）执行，**只跑 1 次，未重跑**。prompt 与提案原文一致。
> 证据：`evidence/p2b-smoke.txt`（sha256 `f545925917ceaee2bdddd60b32fc21d6dec60de08bb2d8fceb262b99fabd6e6e`）。

- **agent/参数**：claude，1 个会话，role=`lead`，tier=`guarded`，task.category=`web`。
- **sessionId**：`s1`（ACP session `6ea114b6-9c6b-47cf-9895-4edb37057977`）。
- **token**：不可得（ACP `session/prompt` 只返回 `stopReason`，不含 usage）。
- **结果**：**PASS**。
  - bridge 出现 `skill_search`（2 次）与 `skill_read`（4 次）；
  - 其中冒烟 prompt 轮（简报被中断后）自身触发 1 次 search + 1 次 read；
  - 回复引用的 path：`skills/ctf-0day/知识库/web/injection-test.md`；
  - 审批请求 0，无审批卡死；冒烟 prompt `stopReason=end_turn`，耗时约 22s。
- **观察（如实记录）**：
  1. **简报本身是“开始解题”型 prompt**（含黑板纪律与“现在开始”），claude 在简报轮就开始调用 `skill_search`/`skill_read` 并尝试工作，120s 内没有结束；harness 用 120s 上限中断了简报轮，然后发送冒烟 prompt 原文。冒烟 prompt 轮 22s 内完成。**产品没有超时/失败；120s 是本次 harness 的保护阈值。**
  2. 简报轮内 agent 在任务工作目录（`.probe/p2b-smoke/work/.../evidence/`）写了一个验证文件；这是简报“现在开始”引导出的正常行为，不在冒烟 prompt 的“不要写文件”约束内（该约束在简报轮之后才发送）。临时目录已随 harness 删除。
  3. bridge 的 skill_search/read 计数包含简报轮与冒烟 prompt 轮；冒烟 prompt 轮的时间戳（08:27:15 之后）可单独确认。
- **结论**：真实 claude 能看到并调用 `skill_search`/`skill_read`，经过同一桥/令牌，引用 `skills/...` 路径，无审批卡死。冒烟判据全部满足。
- **后续建议（不属本轮）**：真实使用时，简报轮本身就会消耗一轮完整工作；如果比赛节奏要求“先确认工具可用再开工”，可考虑在简报末尾加一句“先用一句话确认收到，等待下一条指令”，但那会改产品行为，留 P2-C/后续评估。
