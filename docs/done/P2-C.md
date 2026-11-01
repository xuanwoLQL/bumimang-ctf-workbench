# P2-C · 渲染层技能库状态 + 未配置提示 + category 验证 + 简报预览

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` WP2；`docs/plans/COMPETITION-READINESS.md` §5.2（renderer）/§5.6 第 5、6 条；`docs/done/P2-A.md`；`docs/done/P2-B.md`；`docs/done/WP1-multitask.md`
> 日期：2026-10-23
> 状态：**P2-C 完成，停在 P2-D / WP3 之前等确认**。本轮只改 `apps/desktop/src/renderer/**` 与 mock，未改后端、契约、配置、验证套件与 `D:\agent\skill`。
> 验收：`verify:all` **578 PASS / 0 FAIL**（确定性 391 + smoke 187）；`verify:skills` **149/149**；`verify:multitask` **174/174**；`verify:migration` **44/44**；Electron `--verify` **26/26**；真实 DOM 检查 **PASS**（三种技能库世界）。

---

## 做了什么

把 P2-A/P2-B 已经具备但渲染层完全没消费的数据接到界面上，并给「未配置」一个明确、非阻塞的出口：

- **技能库状态指示**（左栏顶部）：读 `HubSnapshot.skill?`，显示已配置（root + 包数 + 索引时间）/ 未配置（“技能库未配置：agent 仅能靠 playbook 与已有工具”）/ 错误（error 文案）/ 未检测（旧快照没有 `skill` 字段）。点击展开 root 与 packages。
- **未配置提示**：创建任务弹窗顶部、任务卡都显示“技能库未配置：agent 将拿不到技能检索，仅能用 playbook 与已有工具”；**只是提示，不禁用创建任务/启动会话**。
- **category 下拉验证**：P1-E 的 `task.ts` 已有 9 值下拉与 priority 输入，本步**不重做组件**，只把选项/归一化/优先级校验抽成纯函数并加 smoke 断言；顺带把派发时的 `category` 从裸 cast 改成 `normalizeTaskCategory`（非法值→`unknown`），仍在 renderer 内。
- **简报预览（可选）**：任务卡显示 playbook 标题 + `skill_routing` 路径条数 + `knowledge_tools` 可用性 + `evidence_convention` 摘要（截断 80 字符），不展示 steps/简报全文。
- **mock 三个世界**：已配置（默认多任务世界）、未配置（`buildUnconfiguredSkillMockSnapshot()` / `skillMode:"unconfigured"`）、旧快照无 `skill`（`buildMockSnapshot()` 保持 P2-C 之前形状）。旧断言逐条可读。

**关键取舍**

- 没有改 `events.ts`。`briefingPreview` 是渲染层预置的**可选前向兼容字段**（与既有 `policy` 槽位同一做法）：真实主进程目前不发送它，真实 Electron 下整块隐藏；mock 用它验证视图。要让真实应用显示简报预览，需要 Lane A 后续在快照里加一个可选字段（本轮不申请、不阻塞）。
- 技能库状态是**提示层**，不是门禁：`showWarning` 只控制文案，任何按钮都不因它禁用。
- 未配置与未检测严格区分：`configured=false` 才是未配置；`skill` 字段缺席是「未知/未检测」，不误报。
- 样式复用现有 `policy-pack` / `task-form-current` / `task-workdir` / `task-status-hint`，**没有改 `styles.css`**。

---

## 行为变更

> 与 WP1 的四个行为变更、P2-B 的简报/MCP 加法并列记录。语义上都是渲染层加法。

1. **左栏顶部新增技能库状态条**：已配置显示 root + 包数 + 索引时间；未配置/错误显示明确文案；旧快照显示「未知/未检测」。点击可展开 root 与 packages。
2. **未配置/错误提示进入创建任务弹窗与任务卡**：文案明确“agent 将拿不到技能检索，仅能用 playbook 与已有工具”；**不阻塞**创建任务、启动会话或任何其他 UI。
3. **旧快照不带 `skill` 时不再静默**：`skillStatus=null` → “技能库状态未知（旧快照未带 skill 字段，未检测）”，不崩、不误报为未配置。
4. **category/priority 派发更稳**：下拉仍是 P1-E 的 9 个值；派发前 `normalizeTaskCategory`（非法→`unknown`），priority 走 `parseTaskPriority`（空=默认，0–100 整数）。这是渲染层内部收敛，UI 行为不变。
5. **简报预览（可选槽位）**：快照带 `briefingPreview` 时任务卡显示标题/条数/可用性/证据摘要；不带时整块不显示（真实 Electron 当前属于后者）。

WP1 的「切题不停会话 / 任意任务起会话+配额 / 重启恢复+归档 / 多任务看板」与 P2-B 的简报注入/MCP 工具语义**均未改**。

---

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/renderer/store.ts` | `AppState` 新增 `skillStatus` / `briefingPreview`；`applySnapshot` 折叠 `HubSnapshot.skill?` 与可选 `briefingPreview`；新增 `buildSkillStatusView` / `buildBriefingPreview` / `formatSkillBuiltAt` / `SKILL_UNCONFIGURED_WARNING` |
| `apps/desktop/src/renderer/main.ts` | 左栏顶部技能库状态条（点击展开）；任务卡未配置/错误提示；任务卡简报预览 |
| `apps/desktop/src/renderer/task.ts` | 导出 `TASK_CATEGORY_OPTIONS` / `buildTaskCategoryOptions` / `normalizeTaskCategory` / `parseTaskPriority` / `buildTaskSkillWarning`；创建任务弹窗顶部提示；派发改用归一化/校验函数（组件结构未重做） |
| `apps/desktop/src/renderer/mock/data.ts` | `MOCK_SKILL_CONFIGURED` / `MOCK_SKILL_UNCONFIGURED`；`buildMultiTaskMockSnapshot(...,{skill})`；`buildUnconfiguredSkillMockSnapshot()`；可选 `briefingPreview`；`buildMockSnapshot()` 保持不带 skill |
| `apps/desktop/src/renderer/mock/engine.ts` | `MockOptions.skillMode`；`toSnapshot` 往返 `skill` / `briefingPreview` |
| `apps/desktop/src/renderer/smoke.ts` | 新增 25 条 P2-C 断言（旧 162 条零删除、零改名） |
| `docs/done/P2-C.md` | 本文件 |
| `docs/PROGRESS.md` | 追加一行 |

**没有碰**：`hub.ts`、`blackboard/board.ts`、`session/manager.ts`、`electron/main.ts`、`briefing/**`、`mcp-host/**`、`skill/**`、`packages/shared-protocol/events.ts`、`config/**`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify-skills.ts`、`package.json`、`verify:all` 链、`styles.css`、`panes/panes.ts`（简报预览放在任务卡，未改窗格）、`D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置。

**备份**：`.probe/backup-p2c/renderer/`（store/main/task/smoke + mock/data + mock/engine + panes/panes，共 7 个文件）。

---

## 怎么验证的（真实输出）

### 0. 开工前状态确认（只读）

- `.probe/backup-wp1/board.db`：348160 字节，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录一致。
- 基线：`verify:all` 553 / 0；`verify:skills` 149/149；`verify:multitask` 174/174；`verify:migration` 44/44；Electron 26/26。
- 渲染层 `grep -rn "skill" apps/desktop/src/renderer/` **零命中**，确认 P2-C 未提前开工。
- `renderer/task.ts` 已有 category 下拉（9 值）与 priority 输入（P1-E），本步只验证/抽函数。
- `HubSnapshot.skill?` 在 `packages/shared-protocol/events.ts:264`；渲染层此前未读取。

### 1. 先红后绿

先写 25 条 smoke 断言，此时新导出尚不存在：

```text
file:///D:/agent/xuanwo/apps/desktop/src/renderer/smoke.ts:30
  SKILL_UNCONFIGURED_WARNING,
  ^^^^^^^^^^^^^^^^^^^^^^^^^^
SyntaxError: The requested module './store.ts' does not provide an export named 'SKILL_UNCONFIGURED_WARNING'
```

证据：`evidence/p2c-smoke-red.txt`（sha256 `6062fc98…bb8c31`）。

### 2. smoke：162 → 187（+25）

```text
$ node apps/desktop/src/renderer/smoke.ts
...
ALL PASS
187 PASS / 0 FAIL
```

旧断言名对比（对 `.probe/backup-p2c/renderer/smoke.ts` 做正则比对）：**旧 162 个字面 `ok()` 名称全部保留，missing=0；新增 25 个**。新增清单：

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

关键实际值：

```text
PASS  P2-C 顶部：已配置显示 root + 包数 + 索引时间
  └─ 技能库已配置 · D:\agent\skill · 2 个包 · 索引时间 2025/10/13 04:13:32
PASS  P2-C 顶部：未配置显示「技能库未配置」
  └─ 技能库未配置：agent 仅能靠 playbook 与已有工具
PASS  P2-C 创建任务弹窗：未配置时给出明确提示
  └─ 技能库未配置：agent 将拿不到技能检索，仅能用 playbook 与已有工具
PASS  P2-C 顶部：旧快照显示「未知/未检测」
  └─ 技能库未检测 | 技能库状态未知（旧快照未带 skill 字段，未检测）
PASS  P2-C category 下拉：包含 web / ir / unknown（P1-E 已有，本步只验证）
  └─ web,misc,crypto,reverse,pwn,pentest,ir,awd,unknown
PASS  P2-C 简报预览：显示 playbook 标题 + routing 条数 + tools 可用
  └─ {"title":"简报预览","playbookTitle":"Web 单题检查表","routingText":"3 条路径","knowledgeToolsText":"可用",...}
```

证据：`evidence/p2c-smoke.txt`（sha256 `457e56e2…a5bd27`）。

### 3. 真实 Electron DOM 检查（临时 harness，已删除）

用真实 Electron 窗口加载 renderer，分别注入 `skillMode=configured / unconfigured / none` 的 mock hub，读取真实 DOM 文本：

```text
DOM_CHECK_MODE configured
  skillKind=configured
  skillHeadline="技能库已配置 · D:\agent\skill · 2 个包 · 索引时间 2025/10/13 04:13:32"
  skillDetail="根目录：D:\agent\skill；包：ctf-0day, ctf-solver；索引：2025/10/13 04:13:32"
  taskWarning=null
  briefingPreview="简报预览：Web 单题检查表 · skill_routing 3 条路径 · knowledge_tools 可用…"
  categoryOptions=[web,misc,crypto,reverse,pwn,pentest,ir,awd,unknown] priorityInput=true
DOM_CHECK_MODE unconfigured
  skillKind=unconfigured
  skillHeadline="技能库未配置：agent 仅能靠 playbook 与已有工具"
  taskWarning="技能库未配置：agent 将拿不到技能检索，仅能用 playbook 与已有工具"
  modalWarning="技能库未配置：agent 将拿不到技能检索，仅能用 playbook 与已有工具"
  briefingPreview="简报预览：通用解题检查表 · skill_routing 0 条路径 · knowledge_tools 不可用…"
DOM_CHECK_MODE none（旧快照）
  skillKind=unknown
  skillHeadline="技能库状态未知（旧快照未带 skill 字段，未检测）"
  taskWarning=null
  briefingPreview=null
DOM_CHECK_RESULT PASS
```

证据：`evidence/p2c-ui-dom-check.txt`（sha256 `3456689a…36bc6`）。临时文件 `apps/desktop/src/renderer/dom-check-p2c.html` 与 `.probe/p2c-dom-check.mjs` 已删除（`ls` 确认不存在）。

### 4. 全量回归

```text
$ npm run verify:all
578 PASS / 0 FAIL，exit=0（确定性 391 + smoke 187）

$ npm run verify:skills
149/149，exit=0

$ npm run verify:multitask
174/174，exit=0

$ npm run verify:migration
44/44，exit=0

$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
[verify] 26/26 通过
```

证据：`evidence/p2c-verify-all.txt`、`p2c-skills.txt`、`p2c-multitask.txt`、`p2c-migration.txt`、`p2c-electron-verify.txt`。

### 5. 证据文件（sha256）

| 文件 | sha256 |
|---|---|
| `evidence/p2c-verify-all.txt` | `dfbd42fca74c1e23b71b15389c51b7bf39b7d7a34ff65889a59f7ffa8e498d77` |
| `evidence/p2c-skills.txt` | `ae4a4dc63c05528e262668206975dbf08d56432052d7b457bb1362e3d0a71fad` |
| `evidence/p2c-multitask.txt` | `8d895eb8d61d3f5e83912cbbe4c2a9f5a1bf395ca9c6dd2d751f6f2cd510d61d` |
| `evidence/p2c-migration.txt` | `f6ac7c4647bdb4d50571fb8b0c1f9f9fcf4697a3521b6c54a7f7a2e65f574c13` |
| `evidence/p2c-electron-verify.txt` | `f88de39e85cd147941019a7f71a2440187e9335f2115c7ae8062e4166f720eb4` |
| `evidence/p2c-smoke-red.txt` | `6062fc9819e17f1d732dd79d3b58467d80d7635730e52c2f40d0177541bb8c31` |
| `evidence/p2c-smoke.txt` | `457e56e2dea203289c06a9fed32b6029c7f6c1bcfee3f89b7dee5819f4a5bd27` |
| `evidence/p2c-ui-dom-check.txt` | `3456689aac6c8735866dcdceb4a7683903022bbc3c7e7d09180e6966e6536bc6` |

改动文件 sha256：

| 文件 | sha256 |
|---|---|
| `renderer/store.ts` | `076519c580be7b9d3f68b28ef5a9cc96f8fee35290d2d640e9279015d1a9594d` |
| `renderer/main.ts` | `fe4dcabd65d940724a89734e58fdc51c4d844ab64076d4b671c0c087db40657c` |
| `renderer/task.ts` | `322ef76a2bb0a11f7e7defc4d4ba582b74995582ebd8ecb22f5460361fa5c715` |
| `renderer/smoke.ts` | `5da257e334879f676e5e03c2b24a56ad793f4316a146808a3f623045d18e5a6b` |
| `renderer/mock/data.ts` | `1fa8c03437af058cd6e8c4170ac39f7a944f0fe1adc2bc0cc23ec4d6a766360d` |
| `renderer/mock/engine.ts` | `93a9ecef1c24ad1bccd02e04ceaf7d8492323100d7044a399ebe039958cc1b45` |

`.probe/backup-wp1/board.db` 在 P2-C 结束后仍为 348160 字节、sha256 `6d491f0b…ab5cf469`；后端/契约/配置/验证套件 mtime 均停在 P2-B 收口时刻。

---

## 没做什么 / 已知问题

### 简报预览的真实性边界（最重要）

- **真实主进程当前不会在快照里发送 `briefingPreview`**。P2-B 的简报只注入 agent（`SessionManager.briefings`），没有 IPC 出口。因此：
  - mock（浏览器直开 / DOM 检查）能看到预览；
  - **真实 Electron 应用里预览整块隐藏**（字段缺席，UI 不显示空壳）；
  - 本轮**没有**改 `events.ts`、没有写 `docs/requests/`、没有申请契约加法。
- 若要让真实应用显示简报预览，需要 Lane A 在 `HubSnapshot` 增加一个可选字段（例如 `briefingPreview?: { playbookTitle, skillRoutingPaths, knowledgeToolsAvailable, evidenceRule }`），渲染层已按这个形状预留。**等你确认后再决定是否发起 B-to-A 请求。**
- 预览只保留标题/条数/可用性/≤80 字摘要；不存 steps、不存简报全文、不展示黑板全文。

### 已知中间状态（按约定留给后续）

- **`run_weapon` 未实现，UI 不暴露**：`skill.allowRunWeapon=false`；没有执行入口。
- **ctf-solver 根目录主题 `.md` 仍不进 docs 索引**（P2-B 已知，P2-C 不改）：`skill_search` 不返回它们，routing 给路径提示、`skill_read` 可读。
- **简报轮即开工**（P2-B 冒烟观察）：真实会话收到简报后会直接开始解题；WP6 benchmark 要分开统计「简报轮」与「显式 prompt 轮」，否则首答时间会被简报轮污染。
- **跨任务批量授权仍未实现**：`permission.grantAll` 的批量语义仍只覆盖焦点/指定任务（WP1 已知限制）。
- **技能库未配置只是提示，不阻塞**：创建任务、启动会话、审批、台账全部可用；用户可先靠 playbook 打。
- **`skill.builtAt` 是懒构建语义**：已配置但尚未首次 `ensureIndex()` 时，索引时间显示“未构建（懒构建）”，这是正确状态，不是错误。
- **DOM 检查是临时 harness**：跑完已删除，没有截图；真实 Electron 的 `--verify` 26/26 不覆盖新 UI 文本（已在 DOM 检查里单独覆盖）。
- **没有跑真实 agent、没有烧 token**：本轮全部 fake/mock；不改 `D:\agent\skill`。

### 其它边界

- **没有删/改旧 smoke 断言**：旧 162 个字面名称 missing=0；新增 25 条。
- **没有改 `styles.css`**：新 UI 复用现有 `policy-pack` / `task-form-current` / `task-workdir` / `task-status-hint` 类。
- **没有改 `panes/panes.ts`**：简报预览放在任务卡（同样属于焦点视图），窗格行为零改动。
- **没有改 `verify:all` 链**：578 = 391 确定性 + 187 smoke，链条本身未动。

---

## 下一手需要什么

- **等你确认后再进入 P2-D / WP3**；本轮不自动开工。
- 若你希望真实应用显示简报预览：确认后我写 `docs/requests/B-to-A-briefing-preview.md`（可选字段 + 形状 + 兼容要求），由 Lane A 决定是否加到快照；不改现有字段语义。
- 若后续做 `run_weapon`：先补 `docs/decisions/`，再实现白名单/无 shell/任务目录 cwd/60s/1MB/审计；本轮未动。
- 保持门禁：`verify:all` **578**、`verify:skills` **149**、`verify:multitask` **174**、`verify:migration` **44**、Electron **26**、smoke **187**。
