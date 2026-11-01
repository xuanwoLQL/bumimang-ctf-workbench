# 总控提示词：不迷茫 · 从「单题驾驶舱」升级为「CTF/渗透比赛作战系统」

> 把本文件整段交给执行 agent。它默认在 `D:\agent\xuanwo` 工作，`D:\agent\skill` 只读。
> 目标不是重写，而是在现有架构上补齐比赛必需能力，并用可重跑的证据证明每一块真的能用。

---

## 0. 你的身份与目标

你是接手 `D:\agent\xuanwo`（产品名「不迷茫」）的资深工程师。技术栈：Electron + TypeScript + Node 24 + ACP + MCP + `node:sqlite`，Windows 桌面应用，已有绿色包/安装包。

你的任务：在**不破坏现有架构与验证基线**的前提下，把它从「同一道题多开几个 agent 的驾驶舱」升级为「能真正投入 CTF / 渗透测试比赛并争取名次的作战系统」。

成功不是“代码写完”，而是下面每一条都有可重跑的命令和真实输出：

1. 3 道题 × 每道 2 个会话可以**同时跑**，切题只切视图、不停会话，重启后能恢复。
2. 每个会话按题型/角色拿到正确的 playbook，并能检索 `D:\agent\skill` 的知识库与脚本。
3. 题目附件能导入、预览、扫描 flag；命令回显类证据能落盘并升级为 E2。
4. 授权目标/网段是显式数据，越界动作至少能被策略判定并留痕，不假装“已强制”。
5. flag 候选能去重、人工确认、导出；可选提交适配器默认关闭、必须人工点。
6. 用 5-10 道真题、每道 3 次重复跑出 benchmark，用数据决定“什么时候值得扇出”。
7. `verify:all`、Electron `--verify`、渲染层 smoke、打包态验证全部保持绿色。

**不要用“我觉得”“应该没问题”作为验收。** 每个工作包必须有 `docs/done/` 文档，包含一条能重跑的命令和它的真实输出。

---

## 1. 先读这些（按顺序，不许跳）

### 1.1 项目文档

- `docs/ARCHITECTURE.md`：设计基线。**不许改**；发现偏差写到 `docs/decisions/`。
- `docs/HANDOVER.md`：最新交接、已修项、遗留项。
- `docs/PROGRESS.md`：只追加的进度日志，读最后 100 行。
- `docs/done/R17-task-isolation-and-review-fixes.md`、`R19-task-switch.md`、`R22-codex-review-triage.md`、`R24-convergence.md`、`R26-startup-approval-hashchain.md`、`R27-task-workdir.md`。
- `docs/done/AB-first-real-run.md` 与 `docs/logs/ab-result.json`：唯一一次真实 A/B 的数据。
- `使用方法.txt`、`package.json`。

### 1.2 代码入口

- `apps/desktop/src/main/hub/hub.ts`：单活动任务、`settleCurrentTask()`、`task.create/switch`、快照与审批过滤。
- `apps/desktop/src/main/session/manager.ts`：会话启动、简报注入、工作目录、收敛停止。
- `apps/desktop/src/main/blackboard/board.ts`：SQLite、三写一事务、哈希链、租约/意图/事实。
- `apps/desktop/src/main/briefing/build.ts`：当前简报只有黑板状态，没有技能/题型内容。
- `apps/desktop/src/main/mcp-host/server.ts` 与 `bridge.ts`：黑板 MCP 工具、令牌、E0/E1/E2 判定。
- `apps/desktop/src/main/policy/engine.ts`、`policy/policy.ts`、`permission/profile.ts`：规则匹配与操作画像。
- `apps/desktop/src/renderer/**`：任务卡、窗格、审批、台账、首次引导。
- `packages/shared-protocol/events.ts`：契约，**冻结**，只允许向后兼容的增量。
- `apps/desktop/src/cli/verify-*.ts`：现有 333 条确定性验收的写法，新测试照这个风格写。

### 1.3 技能工作流（只读）

- `D:\agent\skill\README.md`、`AGENTS.md`、`adapters\README.md`。
- `D:\agent\skill\skills\ctf-0day\SKILL.md` 与 `知识库\`、`scripts\`。
- `D:\agent\skill\skills\ctf-solver\SKILL.md`、`AI-SEARCH-INDEX.md`、`PAYLOAD-CHEATSHEET.md`、`CTF大赛WP集合\`、`CTF常用脚本及工具\`。
- `D:\agent\skill\mcp\servers\awd_mcp\server.py`：`kb_search` / `run_weapon`，零三方依赖。
- 用户已把技能挂到 codex / claude / opencode / deepseek harness。**不要改这些 harness 的全局配置**；app 要做的是“在 app 起的会话里也能稳定拿到”，而不是依赖用户手工挂载。

### 1.4 基线

先跑一遍并记录真实输出：

```powershell
npm run verify:all
node apps/desktop/src/renderer/smoke.ts
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
```

如果基线不绿，先停下写清楚哪条不绿、为什么，不要带着红基线开工。

---

## 2. 你必须知道的现状结论（不要重复发现）

- 当前是**单活动任务**：`hub.ts` 只有一个 `taskId`；`task.create` / `task.switch` 会 `settleCurrentTask()`，把当前任务所有 starting/idle/running 会话停掉；`session.start` 拒绝在非当前任务起会话。
- 真实 A/B（唯一一次）：3 会话首答 58.8s vs 单人 69.5s（快 15%），但全队收尾 157.9s vs 79.0s（慢一倍），工具调用 50 vs 11（4.5 倍），flag 被两个会话重复写。R24 已加首答收敛，但**没有复测**。
- 角色只是四个字符串（lead/verify/recon/scribe），简报没有按题型/角色下发 playbook。
- E2 证据只支持“任务工作目录内真实存在的文件包含 flag”；命令回显类证据只能到 E1，所以 R24 的收敛门槛被迫放宽到 E1。
- 没有 PTY/终端、没有附件导入/预览、没有题型工具链检测、没有 WSL/Kali 集成。
- 策略引擎只匹配 `request_permission` 的文本；opencode 自己执行命令；codex 的 `curl` 实测可能不请求审批；没有 CIDR/本地代理强制。
- 单机单人；跨机协作是明确 non-goal；AWD/应急模块为零。
- 唯一一次真实测量是简单命令执行题、样本量 1；不能拿它当“并行提效”的结论。

---

## 3. 不可违反的约束

1. **架构基线不改。** `docs/ARCHITECTURE.md` 只读；设计变更写 `docs/decisions/D-<topic>.md`，说明动机、替代方案、影响。
2. **契约冻结、只做加法。** `packages/shared-protocol/events.ts` 现有字段不改语义；新增字段必须可选，旧渲染层/旧测试不炸。
3. **持久化只用 `node:sqlite`。** 不引 `better-sqlite3` 或任何原生模块；不要求队友装构建工具链。
4. **不引重量级依赖。** 新依赖先写决策文档；能用 Node 标准库就不加包。
5. **Windows 优先、绿色包可用。** 不写死 `D:\`；路径从配置/环境变量解析；打包后仍能跑。
6. **所有对外动作经过策略引擎并留痕。** 不允许为赶进度加旁路；新增事件必须进 `events` 哈希链。
7. **不写用户全局配置。** 不碰 `~/.claude`、`~/.codex`、`~/.agents`、`~/.config`；只读。
8. **工作目录边界。** 每个任务 `<workRoot>/<taskId>`；文件读写、命令 cwd、witness 解析都必须过路径检查；拒绝 junction/symlink 逃逸。
9. **不自动提交 flag、不自动打目标、不自动开环境。** 提交/利用必须人工确认；默认 manual。
10. **不烧真实 token 做无授权的实验。** 单元/集成测试用 fake agent；真实 agent 冒烟每个工作包最多 1 次，A/B 先问用户。
11. **不删测试来变绿。** 旧行为改变时，更新测试并写清“行为变更”，不是删断言。
12. **不宣称做不到的强制。** 只能做“策略判定/尽力而为”的，UI 和文档必须写“未强制/可绕过”。
13. **不复制 AGPL 代码。** 技能库是用户自有资产，保留 LICENSE/来源声明；不要把 1027 篇 WP 全文塞进提示词。
14. **不把 secrets 写进仓库/日志。** flag、token、平台凭据一律脱敏；平台提交模板只引用环境变量。
15. **当前不是 git 仓库。** 大改前把将触碰的文件备份到 `.probe/backup-<topic>/`，沿用现有习惯；不要擅自 `git init`。

---

## 4. 工作包（按优先级，P0 不做完不要碰 P2）

### WP1 · 多题并发工作区（P0，最高优先级）

**问题**：现在一次只能打一道题，切题会停掉所有会话。CTF 是广度优先，产品却是单题深度优先。

**目标**：N 个任务同时活跃；切题只切 UI 焦点，不停任何会话；重启能恢复全部活跃任务。

**实现要求**：

- `Hub` 拆成 `focusedTaskId` + 活跃任务集合；`task.create` 不再停其他任务；`task.switch` 只改焦点（保留 `task.switch` 名字做兼容）。
- 新增 `task.focus`（可选）与 `task.archive`（归档不删除）；`task.stopAll` 才是显式停某任务全部会话。
- `session.start` 接受任意已存在任务；新增配额：
  - 每任务默认最多 3 个活跃会话；
  - 全局默认最多 8 个；
  - 配置写在 `config/app.json`（如 `maxSessionsPerTask`、`maxSessionsTotal`），UI 显示剩余配额，超限返回可读错误。
- 快照：保留 `task`（当前焦点）和 `sessions`（焦点任务）向后兼容；`tasks` 数组补 `category`、`priority`、`runningSessions`、`totalSessions`、`flagCandidate`、`updatedAt`、`archived`。
- 后台会话继续跑、继续写 `stream.jsonl`、继续计数；UI 在任务看板显示“其他任务 N 个会话在跑”，点进去再加载完整流；内存里只保留有限窗口，避免 8 个会话把渲染进程打爆。
- 审批队列变成全局：每条带 `taskId`/任务标题，支持“只看当前任务”；全局放行仍按会话/全局授权，不跨会话误放。
- 收敛按任务独立：A 任务首答只停 A 任务的会话，不能影响 B 任务。
- 重启恢复：启动时恢复所有非归档任务及其非终态会话；按任务释放 stale lease / abandon intent，不能把 A 任务的租约泄漏到 B。
- 数据库迁移：用 `PRAGMA user_version` 或 `ALTER TABLE ... ADD COLUMN` 做向后兼容迁移；旧 `board.db` 打开不能炸。

**验收（新增 `verify-multitask.ts`，建议 20+ 断言）**：

1. 创建 3 个任务，每个起 2 个 fake 会话；断言 6 个都在跑。
2. 焦点从 A 切到 B，断言 A 的 2 个会话仍 running；切回 A 仍能看流。
3. 在 A、B 各触发一次审批，断言队列两条、taskId 正确、只处理 A 的不影响 B。
4. A 任务首答触发收敛，断言只停 A 的队友，B 的会话不动。
5. 每任务第 4 个会话被拒；全局第 9 个被拒；错误信息可读。
6. 杀掉主进程重启，断言 3 个任务和 6 个会话恢复，租约/意图按任务正确。
7. 归档 A 后，A 不再出现在活跃看板，历史仍可查。
8. 旧 `board.db`（复制一份）能迁移打开，旧任务/事实/会话不丢。

**关键回归风险**：

- 现有 `verify-history` 里“切任务后旧会话被停”的断言会失败。这是有意的行为变更：更新测试并在 `docs/done/WP1` 写“行为变更：切题不再停会话，显式停用 `task.stopAll`”。
- `Hub.snapshot()` 现在按 `taskId` 过滤 sessions/approvals；改成全局时注意旧渲染层只消费 `task`/`sessions` 的兼容性。
- `settleCurrentTask()` 仍被 `task.create` 使用；拆掉时要确认没有其他调用方依赖“建新任务先清场”。

---

### WP2 · 技能与知识接入（P0）

**问题**：技能已挂到四个 harness，但 app 的简报不注入；角色只是字符串；打包到队友机器后不可假设技能已挂载。

**目标**：每个 app 会话都能按题型/角色拿到 playbook，并能检索 `D:\agent\skill` 的知识库和脚本；打包后可通过配置或内置快照工作。

**实现要求**：

- 配置 `skillDir`：
  - 开发态默认 `D:\agent\skill`；
  - 打包态优先 `BUMIMANG_SKILL_DIR`，其次 `resources/app-source/skill`（若构建时打入），否则 UI 明确提示“技能库未配置”，不要静默降级。
  - 只读；路径必须 realpath 校验，拒绝 junction/symlink 逃逸。
- 任务字段 `category`：`web | misc | crypto | reverse | pwn | pentest | ir | awd | unknown`；创建任务时选择，也可从 brief 关键词自动推断，允许人工覆盖。
- 角色模板：lead / verify / recon / scribe，叠加 category 的 checklist；简报控制在 8KB 内，不要把整篇 SKILL.md 塞进去。
- 简报新增：
  - `skill_routing`：当前题型/角色应该读哪个 `SKILL.md`、哪些 `.idx.md`、什么时候读；
  - `playbook`：10-20 条该题型的检查表（例如 Web：指纹→目录→参数→注入→上传→包含→SSRF→SSTI→JWT→反序列化→审计）；
  - `knowledge_tools`：可用工具名与调用示例；
  - `evidence_convention`：命令输出落盘到 `evidence/<name>.txt`，witness 用相对路径；
  - `do_not` 仍保留。
- MCP 工具（优先 Node 原生，避免队友装 Python）：
  - `skill_search(query, source=all|core|ctf|wp|scripts, limit=10)`：检索 `SKILL.md`、`知识库/*.md`、`*.idx.md`、`PAYLOAD-CHEATSHEET.md`、`AI-SEARCH-INDEX.md`、`wp-index.jsonl`、`script-index.jsonl`；返回 path/line/snippet。
  - `skill_read(path, offset?, limit?)`：skillsRoot 内文件，最大 256KB，路径越界拒绝。
  - `skill_list(category?)`：列出技能包与目录。
  - `run_weapon(script, args, timeoutMs?)`（可选）：只允许 `skills/ctf-0day/scripts/*.py` 与 `skills/ctf-solver/CTF常用脚本及工具/**/*.py`；参数数组、无 shell、cwd 在任务工作目录、60s 超时、输出上限 1MB、全量审计；Python 缺失时返回可操作提示。
  - 以上工具与现有黑板工具同进程暴露，不绕过会话令牌；如果用户 harness 已暴露同名 `kb_search`/`run_weapon`，用 `BUMIMANG_SKILL_MCP=auto|on|off` 避免重复注册，并在简报里告诉 agent 优先使用已有工具。
- 打包：不要把 `D:\agent\skill` 写死；提供 `skillDir` 配置和首次启动检测。若要把技能快照打进包，先评估 51MB 体积与 WP 版权，只打包 `SKILL.md` + 索引 + 脚本，全文 WP 走外置目录。
- 验收（新增 `verify-skills.ts`）：
  1. 任务 category=web 的简报包含 Web checklist 与 skill_routing；category=ir 包含应急 checklist。
  2. `skill_search("SSTI")` 返回 `SSTI.md`/`SSTI.idx.md` 路径；`skill_search("CVE-2021-44228")` 能命中相关知识库。
  3. `skill_read` 正常读；`../../`、绝对路径、symlink 越界全部拒绝。
  4. `run_weapon` 对非白名单脚本拒绝；对白名单脚本 dry-run 成功；Python 缺失时错误可读。
  5. 打包态 `skillDir` 指向外部目录可用；未配置时 UI 提示且简报有说明。
  6. 真实 agent 冒烟（需用户同意）：一个 claude 会话在 Web 题上调用 `skill_search` 并引用返回路径。

---

### WP3 · 题目接入、工件与证据链（P0）

**问题**：没有附件导入/预览，没有 artifact 面板；E2 只认文件，命令回显类证据到不了 E2。

**目标**：题面/附件能进任务；人能看到工件；agent 能把命令输出落盘并形成可回溯证据。

**实现要求**：

- 任务创建 UI：标题、brief（多行）、category、priority、flag 格式、附件（文件/文件夹/zip）、目标列表。
- 存储：`<workRoot>/<taskId>/attachments/`；安全解压：
  - 拒绝 zip-slip（`../`、绝对路径、盘符）；
  - 拒绝 symlink/hardlink；
  - 默认上限 200MB、1000 个文件；
  - 生成 `attachments.json`（name、size、sha256、type、来源）。
- 简报注入附件清单；agent 知道有哪些文件、在哪。
- 渲染层 artifact 面板：列表、文本预览、图片预览、二进制 hex 预览、系统打开、复制路径；**不执行**。
- flag 扫描：对文本类附件/证据文件扫 `flag{...}`（大小写不敏感），候选带 source=artifact path；不要自动 solved。
- 证据约定：
  - 简报明确要求命令回显写入 `evidence/<name>.txt`；
  - `inferEvidence` 支持相对路径，E2 判定为“文件存在且内容包含提交的 flag/事实”；
  - 可选 `cmd:` 回放由 `BUMIMANG_EVIDENCE_REPLAY=1` 开启，默认关闭；开启时 timeout 30s、cwd=任务目录、输出上限 1MB、全量审计；解析失败只降级 E1，不崩。
- 验收（新增 `verify-artifacts.ts`）：
  1. 上传含 `flag.txt` 的 zip，解压、manifest、预览、flag 候选均正确。
  2. 恶意 zip（`../evil`、绝对路径、symlink）被拒且无文件写出。
  3. 文本/图片/二进制预览正常；超大文件被截断并提示。
  4. `evidence/out.txt` 含 flag，submit_fact 带相对 witness → E2；不带 witness → E0；witness 指向目录外 → E1/拒绝。
  5. 命令回放默认关闭；开启后命中/超时/非零退出都有确定行为与审计。
  6. 附件目录在任务切换/重启后仍可访问，不跨任务泄漏。

---

### WP4 · 目标、范围与网络边界（P0/P1）

**问题**：规则只匹配文本；没有授权网段数据；opencode/codex 可能不请求审批；误打范围外目标是资格风险。

**目标**：授权范围成为任务数据；策略能判定并留痕；能强制的部分尽量强制，不能强制的明确标注。

**实现要求**：

- 任务字段：`targets: [{ value, kind: host|cidr|url, status, notes }]`、`denyTargets`、`scopeNotes`。
- 策略：
  - 从命令/权限请求中解析 IP、URL、host:port；
  - CIDR 匹配（IPv4 优先，IPv6 可后置）；
  - 命中 `denyTargets` 或不在 `targets` 内 → `block`（可配置为 `approve`）；
  - 命中授权目标但高风险动作 → `approve`；
  - 每条判定写 `events`，含目标、规则、verdict。
- 尽力强制（可选，但要做就做完整）：
  - 启动本地 HTTP CONNECT 代理，只允许 `targets` 内的 host:port，记录请求；
  - 给 agent 进程注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`；
  - UI 标注“仅对遵守代理的工具有效；nmap/raw socket/DNS 可绕过”；
  - 不承诺 OS 级防火墙。
- 目标面板：目标列表、状态（unknown/alive/owned）、端口、备注；每目标租约；凭据字段先做占位/脱敏，不在本轮做完整 vault。
- 规则包：在 `rules/competition.json` 增加 `no-out-of-scope` 示例；保持“机制写死、内容数据化”。
- 验收（新增 `verify-scope.ts`）：
  1. CIDR 解析：10.0.0.0/8 内/外、边界地址、非法输入。
  2. 命令 `curl http://10.1.2.3/x` 在授权段 → allow/approve；`curl http://8.8.8.8` → block。
  3. denyTargets 优先于 targets。
  4. 代理 allow/deny 各一条真实 curl；日志有记录；直连绕过时 UI 文案正确。
  5. 审批卡片显示目标与命中规则；审计可检索。

---

### WP5 · flag/答案/提交/记分闭环（P0/P1）

**问题**：flag 候选只在内存；没有去重表；只能人工点 solved；没有提交/记分板；台账是手写 markdown。

**目标**：候选持久化、跨会话去重、人工确认、导出；可选提交适配器默认关闭。

**实现要求**：

- 新表 `flag_candidates`：id、task_id、value、source_session、witness、evidence、first_seen、status（new/confirmed/false_positive）、UNIQUE(task_id, value)。
- 现有内存 `flagCandidates` 改为“表 + 内存缓存”，重启可恢复；旧数据可迁移。
- UI：候选列表（来源会话/证据/时间）、确认、标误报、复制、批量导出；确认后写 `task.answer` 并把状态置 solved（仍由人点）。
- 导出：Markdown/CSV/JSON，字段含任务、flag、来源、证据、时间、是否已提交。
- 提交适配器（可选）：
  - 任务配置 `submit: { mode: "manual" | "command", commandTemplate, timeoutMs }`；
  - 默认 `manual`；
  - `command` 模式必须人工点“确认提交”，弹窗展示将执行的命令与 flag；环境变量 `FLAG`、`TASK_ID`；不把 token 写进仓库；stdout/stderr 落审计；失败可重试；
  - 不做平台写 API 的默认集成，遵循技能库“不含平台写接口”的纪律。
- 记分板：任务 `points`、状态、已解/未解统计；团队汇总；导出。
- 验收（新增 `verify-flags.ts`）：
  1. 两个会话提交同一 flag → 一条候选，source 两条。
  2. 标误报后不再出现在待确认列表；确认后任务 solved、answer 正确。
  3. 重启后候选/状态还在；旧库迁移不丢。
  4. 导出 Markdown/CSV/JSON 内容正确。
  5. command 提交默认不执行；人工确认后才执行；dry-run/失败/超时行为确定；日志脱敏。

---

### WP6 · 真实 benchmark 与演练（P0，WP1-WP5 绿了再做）

**问题**：唯一一次 A/B 是简单题、样本量 1；收敛机制没复测；不知道“什么时候值得扇出”。

**目标**：用 5-10 道真题、每道 3 次重复，测出并行/档位/题型的真实收益，形成可执行策略。

**实现要求**：

- 新增 `benchmarks/challenges.example.json`（只放占位/公开题，不提交私有题与真 flag）；本地 `benchmarks/challenges.local.json` 走 `.gitignore`。
- 题目字段：id、category、difficulty、brief、attachments、targets、expectedFlag（本地文件）、timeout、maxSessions。
- 扩展或新增 `bench.ts`：
  - 1 vs 2/3 会话；
  - autonomous vs guarded；
  - 3 次重复，取中位数；
  - 指标：首答时间、makespan、tool calls、board reads、重复事实、审批次数/等待、错误、token/成本（能拿到的才记）；
  - 输出 `docs/BENCHMARKS.md` + `docs/logs/bench-*.json`。
- soak：3 任务 × 3 会话，fake agent 跑 60-120 分钟；记录内存/CPU/DB 大小/流日志；无泄漏、无卡死。
- 结论必须写成“在什么题型/难度下，扇出 N 路是正收益；否则默认单路”。不要用一次样本下结论。
- 验收：
  1. bench dry-run 通过（不烧 token）。
  2. 至少 1 道公开题真实跑 3 次（需用户同意 token）。
  3. 报告能回答：简单题/难题分别该开几路；guarded 是否值得；收敛把 makespan 拉回多少。
  4. 把默认策略写进 `config/app.json` 或文档，并在 UI 提示。

---

### WP7 · 可靠性与打包（P1，P0 之后）

- Windows Job Object 或等价的进程树回收：主进程崩溃/被杀后 agent、MCP、PTY 子进程不残留；用带启动时间校验的清理，避免 PID 复用误杀。
- MCP 崩溃处理：当前“崩了只能新建会话”是已知代价；至少 UI 明确、自动标记不可用、给出“新建会话”入口。
- 数据库迁移与备份：启动时备份 `board.db`（滚动 N 份）；迁移失败可回滚。
- 打包：`skillDir` 外置/内置两种模式；首次启动检测 agent + skill + Python；打包态 `--verify` 全绿；`asar` 内容检查。
- 干净机器：NSIS 安装 → 启动 → 检测 → 起会话；没有干净机器就写清“未验证”。
- Linux/WSL：至少检测 WSL 并给出文档；Linux 原生包可后置。
- 验收：kill 主进程后无孤儿；重启恢复；迁移/回滚；打包态 20/20；干净机器记录（或明确未验证）。

---

### WP8 · AWD / 应急模式（P1/P2，禁止提前开工）

只有在 WP1-WP6 全绿、benchmark 证明并行有正收益后才做。先写设计文档，不写代码：

- AWD：轮次计时、服务清单、flag 轮换、批量提交（人工确认）、补丁台账、防守检查表、攻击日志。
- 应急：证据板、时间线、日志/内存/PCAP 导入、问题清单/答题卡、结论导出。
- 复用现有黑板/任务/审批，不另起一套。

---

## 5. 执行顺序与 lane 分工

### 5.1 阶段

| 阶段 | 内容 | 出口 |
|---|---|---|
| Phase 0 | 读文档、跑基线、写 `docs/plans/COMPETITION-READINESS.md` | 计划里每个 WP 有文件清单、数据模型、风险、验收 |
| Phase 1 | WP1 多题并发 | `verify-multitask` 绿 + 旧套件绿 + UI 可切 3 题 |
| Phase 2 | WP2 技能 + WP3 工件/证据（可并行） | `verify-skills` / `verify-artifacts` 绿 + 真实冒烟 |
| Phase 3 | WP4 范围 + WP5 flag 闭环 | `verify-scope` / `verify-flags` 绿 |
| Phase 4 | WP6 benchmark + soak | `docs/BENCHMARKS.md` 有结论 |
| Phase 5 | WP7 可靠性/打包 | 打包态绿 + 干净机器记录 |
| Phase 6 | WP8 设计（不实现） | 设计文档 |

**每个阶段结束必须**：`npm run verify:all` + Electron `--verify` + renderer smoke + 新套件全绿；写 `docs/done/WPx-*.md`；`docs/PROGRESS.md` 追加一行。

### 5.2 Lane 分工（如果多个 agent 并行）

- **Lane A · 核心**：`src/main/**`、`packages/**`、`rules/**`、`src/cli/**`。
- **Lane B · 界面**：`src/renderer/**`、`apps/desktop/electron/**`、`renderer.html`、`styles.css`。
- **契约**：`packages/shared-protocol/events.ts` 由 Lane A 先提交增量（可选字段），Lane B 按 mock 先行；契约变更写 `docs/decisions/`。
- 跨 lane 需求写 `docs/requests/A-to-B-*.md`，不要直接改对方目录。
- 共享文件（`package.json`、`config/app.json`、`rules/*.json`）由 Lane A 统一改，Lane B 提需求。

---

## 6. 验证命令与门槛

必须注册到 `package.json` 并写进文档：

```powershell
npm run verify:all
node apps/desktop/src/renderer/smoke.ts
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
npm run verify:multitask
npm run verify:skills
npm run verify:artifacts
npm run verify:scope
npm run verify:flags
npm run bench -- --dry
npm run bench -- --manifest benchmarks/challenges.local.json --repeats 3
npm run pack:dir
```

门槛：

- 现有 333 条断言 + 渲染层 smoke + Electron 20/20 **不能退**。
- 新增套件每条断言必须有可读的中文描述和实际值。
- 打包态至少跑一次 `--verify`；asar 内容检查。
- Benchmark 不允许把 1 次样本写成规律；报告里注明样本量、环境、模型、时间。

---

## 7. 文档与汇报格式

每个工作包完成，写 `docs/done/WPx-<短名>.md`，固定五节：

```markdown
# WPx 标题

## 做了什么
（一句话 + 关键取舍）

## 改了哪些文件
（路径列表）

## 怎么验证的
（一条能重跑的命令 + 真实输出，不是“应该没问题”）

## 没做什么 / 已知问题
（诚实列出；这是最有价值的一节）

## 下一手需要什么
（依赖、决策、风险）
```

另外：

- `docs/PROGRESS.md` 只追加：`HH:MM  lane  WPx  状态  一句话`。
- 全部完成后写 `docs/COMPETITION-READINESS.md`：一张表，左边是能力面，中间是改造前/后，右边是证据链接。
- 任何“行为变更”单独标出，例如“切题不再停会话”。

---

## 8. 明确不做

- 不重写成 React/Next/Tauri；不换 Electron。
- 不做云服务、遥测、自动更新、账号体系。
- 不自动提交 flag、不自动开靶场、不自动利用、不自动打范围外目标。
- 不修改用户已挂载技能的全局配置；不把 `D:\agent\skill` 写死。
- 不把 1027 篇 WP 全文塞进提示词/上下文；只做检索 + 按需读取。
- 不为了过测试删断言、放宽策略、关掉审计。
- 不宣称“已强制拦截”而实际只是正则匹配。
- 不在没有干净机器的情况下写“安装已验证”。
- 不把 flag/token/凭据写进仓库、日志、截图。

---

## 9. 需要停下来问用户的情况

只有这几类需要停：

1. 要烧真实 agent token 做 A/B 或 benchmark。
2. 要引入新依赖/原生模块/外部服务。
3. 要改 OS 级防火墙、代理、全局配置。
4. 要接平台提交 API/凭据。
5. 要删除/归档用户数据或改变已有工作流语义。
6. 发现安全/合规风险（例如规则包会误拦合法动作）。

其他情况自己决定，写进 `docs/decisions/`，继续做。

---

## 10. 现在开始

**第一步（不写代码）**：

1. 按 §1 读文档与代码，跑 §1.4 基线。
2. 写 `docs/plans/COMPETITION-READINESS.md`：
   - 当前能力/缺口对照表；
   - 每个 WP 的文件清单、数据模型、契约增量、测试计划、风险；
   - 你打算先做 WP1 的哪几个子步骤。
3. 把基线真实输出贴进计划文档。

**第二步**：按 §5 的顺序开工。每完成一个 WP，先跑全量验证，再写 `docs/done/`，再进下一个。

**第三步**：全部做完后，用 `docs/COMPETITION-READINESS.md` 给用户一份“改造前 vs 改造后”的对照，并明确回答：

- 现在能同时打几道题？
- 每个题型是否自动带 playbook？
- 附件/证据/flag 闭环是否可用？
- 授权范围是否可判定、哪些能强制、哪些不能？
- 真实 benchmark 的结论是什么？简单题/难题分别建议开几路？
- 还剩哪些没做、为什么、下一步是什么？

如果你的判断与本文档冲突，以代码和实测为准；把冲突写进 `docs/decisions/`，不要默默改设计。
