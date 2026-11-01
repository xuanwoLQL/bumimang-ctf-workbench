# P2-A · 技能索引 + 路径安全 + 配置 + 快照字段

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP2；`docs/plans/COMPETITION-READINESS.md` §5 WP2/§5.3；`docs/done/WP1-multitask.md`
> 日期：2026-10-23
> 状态：**P2-A 完成，等确认后进入 P2-B**。本轮没有改 Hub/黑板/SessionManager/简报/MCP/渲染层，没有注册 `skill_*` 工具，没有实现 `run_weapon`，没有跑真实 agent / 烧 token。

---

## 做了什么

为技能库建立**懒构建的内存索引**、**路径安全边界**、**配置开关**与**可选快照字段**：

- `skill/paths.ts`：`resolveWithinRoot` / `isSafePath`；realpath 根校验，拒绝 `..`、绝对路径、盘符、UNC、NUL、symlink/junction 逃逸、非白名单扩展名、超过 256KB 的文件。
- `skill/index.ts`：递归扫描 `SKILL.md`、`知识库/*.md`、`*.idx.md`、`PAYLOAD-CHEATSHEET.md`、`AI-SEARCH-INDEX.md`、`wp-index.jsonl`、`script-index.jsonl`；文档只读开头 20 行/8KB 摘要，jsonl 逐行解析元数据；`SkillRuntime` 首次 `ensureIndex()` 才构建，记录文件数/总字节数/耗时；所有文件读取过 `resolveWithinRoot`。
- `config/loader.ts` + `config/app.json`：新增 `skillDir`、`skill.allowRunWeapon`（默认 false）、`skill.mcpMode`（默认 auto）；`skillDir` 相对路径按配置文件目录解析。
- `packages/shared-protocol/events.ts`：只给 `HubSnapshot` 加可选 `skill?: { configured, root, packages, builtAt, error? }`；**没有新增 HubAction/HubEvent，没有改现有字段**。
- `electron/main.ts`：启动时只解析技能根 + 展示状态（一次 `discoverPackages` 一级目录读取），**不扫描技能库**；IPC 快照用 `withSkillStatus()` 挂上可选字段。
- `cli/verify-skills.ts`：A（索引构建，31 条）/ B（路径越界，18 条）/ C（未配置 + 配置解析，31 条），共 **80/80**。

**关键取舍**

- 索引放在 `skill/index.ts` 的纯函数 + `SkillRuntime` 里，不碰 Hub；P2-B 可以直接复用 `ensureIndex()`。
- 启动只解析根目录和一级包名；`builtAt` 在真实应用里保持 `null`，直到 P2-B 第一次检索/注入触发构建。这保证“启动不扫 51MB”。
- 索引只存元数据 + 头 20 行摘要；wp/script 的 jsonl 本身是元数据，允许整行解析，但不读取 WP 全文。
- 快照字段可选：旧渲染层/旧 mock 不读 `skill` 也能工作；`verify:all` 的 162 条 smoke 未改。
- 路径安全先做语法拒绝，再 realpath 目标做根包含复核；索引扫描主动跳过 symlink/junction（避免循环），读取时再拒绝逃逸。

## 行为变更

**无。** P2-A 只建立索引/配置/快照字段：

- 不注入简报、不注册 MCP 工具、不实现 `run_weapon`、不改渲染层。
- `skill` 字段是可选加法字段；没有任何现有消费者读取它，旧快照/旧 mock 不炸。
- `config/app.json` 新增字段只被 `loadAppConfig` 解析；`allowRunWeapon` / `mcpMode` 本轮**只加载不消费**。
- Electron 启动日志多一行技能库状态；不影响 `--verify` 的 26 条断言。

## 改了哪些文件

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/skill/paths.ts` | 路径安全：`resolveWithinRoot` / `isSafePath` / `SkillPathError` / `MAX_SKILL_FILE_BYTES` / `DEFAULT_ALLOWED_EXTENSIONS` |
| `apps/desktop/src/main/skill/index.ts` | 懒索引：`buildSkillIndex` / `resolveSkillRoot` / `discoverPackages` / `SkillRuntime` / `createSkillRuntime` / `withSkillStatus` |
| `apps/desktop/src/cli/verify-skills.ts` | A/B/C 三组 80 条断言；自建 `.ui-run/skills-fixture/`，不读真实技能库 |
| `docs/done/P2-A.md` | 本文件 |

**修改**

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/main/config/loader.ts` | `AppConfig.skillDir?`、`AppConfig.skill`（allowRunWeapon/mcpMode 默认 false/auto）；相对 `skillDir` 按配置目录解析 |
| `config/app.json` | `skillDir: "D:/agent/skill"`（仅本机开发态，`_comment` 已注明）、`skill.allowRunWeapon=false`、`skill.mcpMode="auto"` |
| `packages/shared-protocol/events.ts` | `HubSnapshot.skill?` 一个可选字段；无 action/event 增量 |
| `apps/desktop/src/main/electron/main.ts` | 创建 `SKILL` 运行期状态；启动日志；IPC `hub:snapshot` 用 `withSkillStatus`；`createWindow`/`registerIpc` 透传。**未改启动恢复、配额注入、审批守卫** |
| `package.json` | 新增 `verify:skills`（不并入 `verify:all`） |
| `docs/PROGRESS.md` | 追加一行 |

**没有碰**：`briefing/**`、`mcp-host/**`、`session/manager.ts`、`hub/hub.ts`、`renderer/**`、`validate-action.ts`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置。

## 怎么验证的

### 1. 先红后绿（TDD）

实现前先写 `verify-skills.ts`，此时 `skill/paths.ts` / `skill/index.ts` 尚不存在：

```text
--- p2a skills red start 15:35:33 ---
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\agent\xuanwo\apps\desktop\src\main\skill\paths.ts'
--- exit=127 15:35:34 ---
```

证据：`evidence/p2a-skills-red.txt`。实现后：

```text
$ npm run verify:skills
================ A 索引构建（fixture）================
================ B 路径越界 ================
================ C 未配置 / 配置解析 ================

================ 80/80 通过 ================
--- exit=0 ---
```

分组：A 31、B 18、C 31。关键断言：

```text
PASS  A：docs 总数与目录一致  — actual=7 expected=7
PASS  A：知识库文档只带摘要  — len=37
PASS  A：只读前 N 行，深层标记未被索引  — len=249
PASS  A：wps 数量  — actual=2 expected=2
PASS  A：scripts 数量  — actual=1 expected=1
PASS  A：懒构建前 builtAt=null  — actual=null expected=null
PASS  A：懒构建后 builtAt > 0
PASS  A：重复 ensureIndex 复用缓存
PASS  B：拒绝 ../ 逃逸  — SkillPathError/traversal
PASS  B：拒绝盘符路径  — SkillPathError/drive
PASS  B：拒绝 POSIX 绝对路径  — SkillPathError/absolute
PASS  B：拒绝 NUL  — SkillPathError/nul
PASS  B：拒绝 junction 逃逸  — SkillPathError/escape
PASS  B：拒绝文件 symlink 逃逸  — SkillPathError/escape
PASS  B：拒绝超过 256KB 的文件  — SkillPathError/size
PASS  C：解析顺序 env 优先  — actual="env"
PASS  C：无 env 时 config 优先  — actual="config"
PASS  C：config 缺失时开发态探测  — actual="dev"
PASS  C：打包态 resources 兜底  — actual="packaged"
PASS  C：未配置 configured=false / error 可读
PASS  C：快照 skill.configured=false
PASS  C：旧快照不带 skill 也不炸
```

证据：`evidence/p2a-skills.txt`（最终全量跑）、`evidence/p2a-skills-red.txt`（红测）。

### 2. 全量回归

```text
$ npm run verify:all
553 PASS / 0 FAIL，exit=0（确定性 391 + smoke 162）

$ npm run verify:multitask
174/174，exit=0

$ npm run verify:migration
44/44，exit=0
```

`events.ts` 只加可选字段、`config/app.json` 只加字段、`electron/main.ts` 只加快照包装与启动日志，旧断言全部保持。

### 3. Electron `--verify`

```text
[main] 技能库：D:\agent\skill（ctf-0day, ctf-solver；索引懒构建）
...
[verify] 26/26 通过，证据写入 D:\agent\xuanwo\docs\logs\ui-verify.json
--- exit=0 ---
```

启动日志**没有** `[skill] 索引构建完成`，证明启动时没有扫描技能库。证据：`evidence/p2a-electron-verify.txt`。

### 4. 真实技能库只读一次性验证（不进 `verify:all`）

用 `buildSkillIndex("D:/agent/skill")` 跑一次，不写任何文件：

```text
[skill] 索引构建完成：root=D:\agent\skill files=1560 bytes=48389156 docs=108 wps=1027 scripts=110 耗时=134ms
{
  "packages": ["ctf-0day", "ctf-solver"],
  "docs": 108,
  "kinds": { "skill": 2, "knowledge": 83, "idx": 20, "cheatsheet": 2, "search-index": 1 },
  "wps": 1027,
  "scripts": 110,
  "fileCount": 1560,
  "totalBytes": 48389156,
  "durationMs": 134,
  "warnings": 0
}
```

- `fileCount` 1560 = 目录总文件 1567 − `__pycache__` 的 7 个 `.pyc`（扫描时跳过）。
- `wp-index.jsonl`（2,085,484 字节）与 `script-index.jsonl`（27,353 字节）在 `skills/ctf-0day/外部参考/Des-CTF/` 下被递归发现。
- 真实索引 134ms，0 warnings；证明 51MB 目录懒构建可接受。
- 该命令只读，未改 `D:\agent\skill`。

## 没做什么 / 已知问题

### 已知中间状态（按约定留给后续）

- **索引已建但简报未注入**：`playbook` / `skill_routing` / `knowledge_tools` / `evidence_convention` 是 **P2-B**；本轮没有碰 `briefing/build.ts`。
- **MCP 未注册 `skill_search` / `skill_read` / `skill_list`**：`mcp-host/**` 未改，**P2-B**。
- **`run_weapon` 未实现**：`skill.allowRunWeapon` 默认 false 且只加载不消费；没有 `weapon.ts`，后续评估。
- **renderer 未显示 skill 状态 / 未加 category 下拉**：`renderer/**` 未改，**P2-C**。
- **真实 agent 冒烟未跑**：等 P2-B 工具完成后单独申请 token（每 WP 最多 1 次）。
- **真实应用里 `skill.builtAt` 现在是 `null`**：P2-A 只做“懒索引占位”，没有任何生产代码调用 `ensureIndex()`；快照字段存在但 `builtAt=null`。P2-B 首次检索/简报时才会填充。
- **没有写磁盘缓存**：索引只在内存，进程重启后首次使用会重建（134ms 量级）；计划允许可选 `%APPDATA%\bumimang\cache\skill-index.json`，本轮不做。
- **`config/app.json` 的 `skillDir` 是本机开发态值**：代码不写死盘符；解析顺序为 `BUMIMANG_SKILL_DIR` → config → 开发态 `<repo>/../skill` → 打包态 `resources/app-source/skill`。队友机器/打包态应使用 env 或内置资源；`_comment` 已注明。打包态 `skillDir` 外置/内置的完整验证留 WP7。
- **`skill.allowRunWeapon` / `mcpMode` 只解析不消费**：`BUMIMANG_SKILL_MCP` 环境变量与工具注册是 P2-B。
- **`HubSnapshot.skill` 是可选字段**：旧渲染层不读；`verify:all` 的 smoke 未改，旧 mock 不带该字段。

### 其它边界

- **文档索引范围按计划**：只索引 `SKILL.md`、`知识库/*.md`、`*.idx.md`、`PAYLOAD-CHEATSHEET.md`、`AI-SEARCH-INDEX.md`。`ctf-solver` 根目录的 `SSTI.md`、`SQL.md` 等主题全文**不在 docs 里**（同目录的 `.idx.md` 在）；P2-B 若要做全文 `skill_search`，需要再评估是否把包根 `.md` 纳入，或通过 `skill_read` 按路径读全文。
- **`wps[].path` 可能是 `local_path` / `upstream_path` / `wp_url`**：不保证是技能根内可读文件；P2-B 的 `skill_read` 需要先解析/校验，不能直接当本地路径。
- **`scripts[].relativePath` 是 jsonl 里的相对路径**（相对 `CTF常用脚本及工具`/包根），不是相对 skill root；P2-B 的 `run_weapon` 白名单要按包根解析并过 `resolveWithinRoot`。
- **索引扫描跳过 symlink/junction**：避免循环；读取阶段仍用 realpath 拒绝逃逸。`fileCount` 是“实际遍历的普通文件数”，不是目录项总数。
- **没有新增决策文档**：P2-A 的路径/索引实现细节写在本文件；P2-B 做工具/`run_weapon` 时再补 `docs/decisions/D-skill-tools.md`。
- 没有跑真实 agent、没有烧 token、没有改 `D:\agent\skill`、没有删测试、没有自动提交 flag、没有改 `verify:all` 链。

## 下一手需要什么

- 等你确认 P2-A 后进入 **P2-B**：
  - `briefing/build.ts` 注入 playbook / skill_routing / knowledge_tools / evidence_convention（8KB 上限）；
  - `mcp-host` 注册 `skill_search` / `skill_read` / `skill_list`（同进程、同会话令牌，不绕过 bridge）；
  - 通过 `SkillRuntime.ensureIndex()` 触发懒构建；
  - `skill_search` 至少能命中 `SSTI.idx.md` / `SSTI.md` 相关路径；`skill_read` 走 `resolveWithinRoot` + 256KB 上限；
  - `run_weapon` 仍默认关闭，是否实现按 P2-B/后续评估。
- P2-B 必须保持：`verify:all` 553 PASS、`verify:multitask` 174/174、`verify:migration` 44/44、`verify:skills` 80/80、Electron 26/26；不要改 `verify:all` 链；不要回退 WP1 的焦点/配额/归档语义。
- P2-B 的真实 agent 冒烟（1 个 claude 会话调用 `skill_search` 并引用返回路径）**需要你同意 token**，最多 1 次。
