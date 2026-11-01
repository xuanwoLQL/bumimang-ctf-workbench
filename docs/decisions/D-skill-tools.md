# D-skill-tools · 技能索引、只读工具与 run_weapon 默认关

- 日期：2026-10-23
- 状态：P2-A/P2-B 已实施；P2-C 只消费状态字段，P2-D 补写本决策文档（未改代码）
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP2；`docs/plans/COMPETITION-READINESS.md` §5.2/§5.3/§5.5/§5.7；`docs/done/P2-A.md`、`P2-B.md`、`P2-C.md`、`WP2-skills.md`

## 背景

WP2 要让每个 app 会话按题型/角色拿到 playbook，并能检索 `D:\agent\skill` 的知识库、WP 索引与脚本索引；打包到队友机器后不能假设技能已挂到 agent harness。技能库约 47.5MB / 1027 篇 WP / 110 个脚本，既不能塞进简报，也不能在启动时全量扫描；同时 `run_weapon` 会执行攻击脚本，风险显著高于只读检索。

本决策记录 P2-A/P2-B 已落地的索引、工具、路径、令牌与配置边界，避免后续（WP3/WP6/WP7）重新讨论或绕开。

## 决策

### 1. 索引：懒构建、内存、只读元数据

1. **懒构建**：`SkillRuntime.ensureIndex()` 在首次 `startSession` 或首次 `skill_*` 调用时构建一次；构建结果放内存，进程退出即丢，**不写 SQLite、不写磁盘缓存**。重启后重建（真实库实测 81–134ms），避免缓存损坏/陈旧与额外迁移。
2. **不读全文**：文档只读开头 20 行 / 8KB 作为摘要（`HEAD_LINES=20`、`HEAD_BYTES=8KB`，摘要上限 4000 字符）；`wp-index.jsonl` / `script-index.jsonl` 逐行解析元数据；不把 1027 篇 WP 全文读进内存或简报。
3. **扫描范围**：`SKILL.md`、`知识库/*.md`、`*.idx.md`、`PAYLOAD-CHEATSHEET.md`、`AI-SEARCH-INDEX.md`、`wp-index.jsonl`、`script-index.jsonl`；跳过 `node_modules/.git/__pycache__/.venv` 与 symlink/junction 目录，最大深度 12。
4. **可重建**：索引只是性能结构，不是真相源；源文件变化后重建即可。已知边界：`ctf-solver` 根目录主题 `.md`（如 `SSTI.md`）**不进 docs 索引**，`skill_search` 不返回它；routing 会给路径提示，`skill_read` 仍可按路径读取。是否纳入留给 WP6 评估。

### 2. 工具：同进程、同令牌、同审计

1. 只读工具为 `skill_search(query, source=all|core|ctf|wp|scripts, limit=10)`、`skill_read(path, offset?, limit?)`、`skill_list(category?)`。
2. 三个工具与黑板工具**同进程、同 stdio 管道、同每会话令牌**；请求经 `mcp-host/bridge.ts` 路由（`skill.search` / `skill.read` / `skill.list`），**不新开旁路、不绕过 bridge**。
3. 每次调用写审计日志（`bridge: skill_search session=... query=...` 等），与黑板工具同一套日志出口。
4. `skill_read` 最大 256KB，超出截断并标记 `truncated=true`；`offset/limit` 按行切片；所有读取过 `resolveWithinRoot`。
5. `BUMIMANG_SKILL_MCP=auto|on|off`：`auto` 默认注册；`off` 不注册（用户 harness 已有同名工具时用）；未配置技能库时 manager 强制 `off`，简报明确写“无技能库”。

### 3. run_weapon：默认关、本轮未实现

1. `config/app.json` 的 `skill.allowRunWeapon` 默认 `false`；P2-A/B 只加载配置，**不消费**，没有 `weapon.ts`，MCP 不注册 `run_weapon`，UI 不暴露入口。
2. 不默认开的原因：`run_weapon` 会执行技能库里的 Python 脚本（攻击/利用类），风险面远大于只读检索——需要额外做白名单、无 shell 参数数组、cwd 限定任务目录、60s 超时、1MB 输出上限、全量审计、Python 缺失提示，并过策略引擎。这些在比赛期不是 P0，且默认开启会扩大误用/越界风险。
3. 未来若要实现：先更新本决策（白名单路径、超时、输出、审计、策略 verdict），再写代码；不能因为配置里有 `allowRunWeapon` 就假装可用。

### 4. 路径安全：realpath + 根包含 + 拒绝逃逸

1. `skill/paths.ts` 的 `resolveWithinRoot` 先做语法拒绝（空路径、`..`、POSIX/Windows 绝对路径、盘符、UNC、NUL、非白名单扩展名、超过 256KB），再对目标 `realpath` 做根包含复核。
2. **拒绝 symlink/junction 逃逸**：索引扫描主动跳过 symlink/junction；读取时对 `realpath` 复核，逃逸返回 `SkillPathError`（如 `escape`）。
3. 白名单扩展名以 `.md` 为主，允许 `.json` 等索引数据；执行类文件（`.exe` 等）不通过只读路径。
4. 技能根只读：app 不写 `D:\agent\skill`；用户 harness 的全局配置也不改。

### 5. 令牌：复用每会话 MCP 令牌

1. 每个会话启动时由 `BoardBridge.envForSession()` 注入 `BUMIMANG_TOKEN`；MCP 子进程 `board.hello` 用令牌 + sessionId 绑定。
2. 令牌错误时桥直接断开连接，**所有 skill 工具与黑板工具一样拒绝**；没有“技能工具免令牌”的特例。
3. 审计日志带 sessionId；输出上限由 tools 层保证，bridge 不做二次拼接。

### 6. 配置：skillDir 解析顺序与开关

`skillDir` 解析顺序（`skill/index.ts`）：

1. `BUMIMANG_SKILL_DIR`（显式环境变量；指向不存在目录时 `configured=false` 且 error 可读）；
2. `config/app.json` 的 `skillDir`（相对路径按配置文件目录解析）；
3. 开发态默认 `<repo>/../skill`（仅当目录存在）；
4. 打包态 `resources/app-source/skill`（若构建时打入）；
5. 都没有 → `configured=false`，快照带 `error`，渲染层明确提示“技能库未配置”，**不静默降级**。

开关：

- `BUMIMANG_SKILL_DIR`：技能根覆盖；
- `BUMIMANG_SKILL_MCP=auto|on|off`：MCP 注册模式；
- `skill.allowRunWeapon`：默认 `false`，本轮只加载不消费；
- `skill.mcpMode`：默认 `auto`。

**不写死 `D:\agent\skill`**：`config/app.json` 的本机开发态值只作为配置数据，代码按上述顺序解析；打包产物不依赖该值。完整打包态外置/内置验证留 WP7。

## 备选方案与取舍

- **启动时全量扫描**：会让每次启动都读 1560 个文件/47.5MB；否决，改懒构建。
- **把索引写 SQLite / 磁盘缓存**：多一套 schema、迁移与损坏处理；索引可从源重建，内存足够；本轮不写缓存。
- **把 WP 全文放进索引或简报**：上下文与版权风险；只存元数据 + 头几行，全文按需 `skill_read`。
- **skill 工具单独开 MCP server / 不走 bridge**：会绕过每会话令牌与审计；否决，复用黑板桥。
- **允许绝对路径/跟随 symlink**：路径逃逸风险；否决，realpath + 根包含。
- **默认开启 run_weapon**：攻击脚本执行风险与策略缺口；否决，默认关、未实现。
- **auto 模式探测宿主同名工具**：stdio MCP server 看不到聚合后的其他 server 工具名；只能记 warning，冲突时用户显式 `off`。

## 影响

- **加法而非改语义**：`HubSnapshot.skill?` 是可选字段；简报新增 `playbook` / `skill_routing` / `knowledge_tools` / `evidence_convention` 四个可选字段；MCP 新增三个只读工具。旧渲染层/旧 mock/旧测试不炸。
- **未配置有明确出口**：`configured=false` + error + 渲染层提示；创建任务/启动会话不被阻塞（用户可先靠 playbook 打）。
- **性能**：真实库首次索引 81–134ms；启动不扫描，首次会话/首次工具调用才构建；之后进程内复用。
- **上下文**：简报序列化 ≤8KB；超长先截 `suggestions` 与 board 展示文本，`evidence_convention` 不截断、`do_not` 条目不丢。
- **已知边界**：根目录主题 `.md` 不进 docs 索引；`run_weapon` 未实现；`auto` 无法探测同名工具；`skill_read.totalLines` 对 >256KB 文件按已读部分计行；WP/脚本索引路径可能不可直接读（`skill_read` 会拒绝根外/不存在路径）。

## 后续

- **WP3**：artifact/evidence 类 MCP 工具可参照 `skill_*` 的注册/令牌/审计/输出上限方式；若需要新 `HubAction`/`HubEvent`/快照字段，先写 `docs/requests/` 并停下问用户（契约冻结）。
- **WP6**：评估是否把 `ctf-solver` 根目录主题 `.md` 纳入索引；benchmark 的简报轮/显式 prompt 轮统计见 `WP2-skills.md` 冒烟轮观察。
- **WP7**：打包态外置/内置 `skillDir` 的端到端验证；本轮只验证了解析顺序。
- 若实现 `run_weapon`：先更新本文件的白名单/超时/输出/审计/策略决策，再写代码；默认仍保持关闭，需显式配置。
