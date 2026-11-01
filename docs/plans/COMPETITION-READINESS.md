# 不迷茫 · 比赛就绪改造计划（Phase 0）

> 依据：`docs/PROMPT-COMPETITION-READINESS.md`
> 日期：2026-10-23
> 状态：**Phase 0 完成，等待确认**。本轮只读文档、跑基线、写本计划；**没有改任何代码、配置、测试或 `docs/ARCHITECTURE.md`**。
> 基线结论：**全绿**（379 条确定性断言 + 121 条 renderer smoke + Electron 26/26，0 FAIL）。

---

## 0. 一页结论

**现在能做什么**

- 一台机器、一个活动任务；任务内最多同时跑多个会话（fake agent 验证过 3 路扇出）。
- 黑板（facts / dead ends / intents / leases）、审批队列、E0/E1/E2 证据、策略规则包、会话历史、任务专属工作目录、重启恢复（只恢复最近任务）都已可用。
- 四家 agent 能检测、能起会话、能注入简报；opencode/codex/claude/dsh 的授权输入能力不同，已在快照里标注。

**现在不能做什么（比赛会直接卡住的点）**

1. 不能同时打多道题：`Hub` 只有一个 `taskId`，`task.create` / `task.switch` 会停掉旧任务的全部会话。
2. 简报不带题型 playbook、不带技能检索路由；agent 只能靠自己的 harness 是否挂载了技能。
3. 没有附件导入/预览/工件面板；E2 只认“任务目录内某个文件含 flag”，命令回显证据到不了 E2。
4. 授权范围不是任务数据；策略只匹配文本，没有 CIDR、没有目标解析、没有可选的本地代理。
5. flag 候选只在内存；没有去重表、确认/误报、导出、提交、记分板。
6. 只有一次单题、样本量 1 的 A/B；没有重复 benchmark、没有 soak。
7. 进程树只靠 `taskkill /T`；没有 Job Object/等价兜底；打包态的 `skillDir`、干净机器安装未验证。

**建议的施工顺序**

`WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7 → WP8（只设计）`。WP2 与 WP3 可并行（Lane A/B），WP4 与 WP5 可并行；WP6 必须等 WP1–WP5 全绿；WP8 禁止提前开工。

**WP1 先做的子步骤（本轮不动手，等你确认）**

1. **P1-A 契约与迁移，不改行为**：`events.ts` 只加可选字段/动作；`board.ts` 用 `PRAGMA user_version` 加 `category/priority/archived/updated_at`；旧库副本能打开。此时 `verify:all` 必须仍全绿。
2. **P1-B Hub 拆焦点**：`focusedTaskId` + 活跃任务集合；`task.create` / `task.switch` 不再 `settleCurrentTask()`；`task.focus` 只切 UI 焦点；快照保留 `task`/`sessions` 向后兼容。同步改写 `verify-r18`、`verify-hardening` 里“切任务停会话/清授权”的断言（改语义，不删测试）。
3. **P1-C 任意任务起会话 + 配额 + 按任务收敛**：`session.start` 接受任意非归档任务；每任务 3 / 全局 8；A 任务首答只停 A 的会话。
4. **P1-D 重启/归档/迁移**：启动恢复全部非归档任务与非终态会话；按任务释放 stale lease / abandon intent；`task.archive` 只归档不删；旧 `board.db` 迁移。
5. **P1-E 渲染层与回归**：任务看板（焦点/后台在跑数/配额）、全局审批（taskId+标题、只看当前任务）、后台事件不进 DOM；`verify-multitask` + smoke + Electron 全绿。
6. **P1-F 文档与门禁**：`docs/done/WP1-multitask.md`、`docs/decisions/D-multitask-focus.md`、`docs/PROGRESS.md` 追加一行。

**需要你拍板的事**见 §13；**与总控文档的冲突/勘误**见 §14。

---

## 1. 基线（真实执行）

### 1.1 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-10-23 |
| OS | Windows 11 Home 10.0.26200 |
| Node | v25.2.1 |
| npm | 11.6.2 |
| Electron | 44.7.0 |
| 仓库 | `D:\agent\xuanwo`（不是 git 仓库） |
| 打包产物 | `dist/不迷茫 0.1.0.exe`，文件时间 2026-10-21 19:28（晚于最后源码 19:27） |
| 真实 agent token | **本轮 0 消耗**；所有测试使用 fake agent |

### 1.2 `npm run verify:all`

命令与真实输出（节选；完整日志见 §1.6）：

```text
--- verify:all start 10:51:20 ---
> bumimang@0.1.0 verify:all
> node apps/desktop/src/cli/verify-gate.ts && node apps/desktop/src/cli/verify-gate-live.ts && node apps/desktop/src/cli/verify-briefing.ts && node apps/desktop/src/cli/verify-concurrency-and-blocked.ts && node apps/desktop/src/cli/verify-history.ts && node apps/desktop/src/cli/verify-r18.ts && node apps/desktop/src/cli/verify-hardening.ts && node apps/desktop/src/renderer/smoke.ts

================ T3 策略引擎 ================
PASS  competition.json 能被解析  — 规则条数=6
PASS  C2 工具命令 → block（没有放行按钮这条路）  — actual="block" expected="block"
PASS  受控档 + 无规则命中 → approve（档位兜底）  — actual="approve" expected="approve"
================ 52/52 通过 ================

========== 闸门活体验收（真实 AcpClient 路径 + 假 agent）==========
PASS  被 block 时不进审批队列（没有放行按钮这条路）  — actual=0 expected=0
PASS  硬阻断后 agent 拿到的 outcome 是 cancelled（且从未进队列）  — actual="cancelled" expected="cancelled"
========== 16/16 通过 ==========

========== 简报包扇出验收（三会话）==========
PASS  s2 的简报带上了 s1 的死路  — ["/admin 弱口令不可用，已试 20 个常见口令"]
PASS  简报的 after_id 等于写入时刻的黑板末尾（拉模式从正确位置开始）  — actual=10 expected=10
========== 17/17 通过 ==========

========== 补两个验证缺口 ==========
================ A 并发抢租约 ================
================ B blocked 终态端到端 ===============
========== 19/19 通过 ==========

========== 对话历史 / 任务状态 / 工作目录验收 ==========
PASS  全部事件链条一致（无悬空 prev_hash）  — events=234
================ 90/90 通过 ================

========== R18 回归：事件隔离 / 关闭超时 / 正常退出 ===========
================ A 切任务后旧事件不得泄漏 ================
PASS  旧 taskId 的 session.start 被拒绝  — actual=false expected=false
PASS  旧任务的 session.prompt 被拒绝  — actual=false expected=false
PASS  BUMIMANG_WORKDIR 是任务 B 专属目录  — actual="D:\\agent\\xuanwo\\.ui-run\\r18\\i\\work\\task-87e5fcdc" ...
========== 139/139 通过 ==========

================ 1. 策略规则：allow 不可伪造，block 优先 ================
PASS  block 规则优先于 allow（硬阻断不可被盖掉）  — actual="block" expected="block"
================ 7. MCP 令牌随会话撤销 ================
PASS  撤销后旧 token 不能再认证 MCP 管道
================ 46/46 通过 ================

== T6 渲染进程骨架 · mock 快照与状态折叠 ==
PASS  mock 快照带 tasks 列表（含旧任务）  — ["task-1","task-0"]
ALL PASS
--- exit=0 10:51:46 ---
```

统计：`52 + 16 + 17 + 19 + 90 + 139 + 46 = 379` 条确定性断言，renderer smoke 121 条 PASS，合计 **500 PASS / 0 FAIL**。退出码 0，耗时约 26 秒。输出里的 `Unknown project config "electron_mirror"` 与 `SQLite is an experimental feature` 是环境提示，不影响退出码。

### 1.3 Renderer smoke

```text
$ node apps/desktop/src/renderer/smoke.ts
...
== T6 渲染进程骨架 · mock 快照与状态折叠 ==
PASS  快照有任务  └─ task=不迷茫 · 夜间靶场：拿下 10.0.0.9
PASS  快照有 ≥2 会话  └─ sessions=3
PASS  快照有 pending 审批  └─ approvals=5
PASS  快照有四类黑板视图  └─ facts=4 deadEnds=2 intents=3 leases=2
PASS  九个 SessionStatus 都有文案  └─ starting,idle,running,waiting_approval,waiting_lease,blocked,done,failed,stopped
PASS  mock task.switch 切到旧任务  └─ {"ok":true}
PASS  重复移除被拒  └─ {"ok":false,"error":"session not found"}
ALL PASS
```

`verify:all` 已经把 `smoke.ts` 放在链尾，所以总链退出码同时覆盖了 121 条 smoke 断言。

### 1.4 Electron `--verify`

```text
$ node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
...
PASS  preload 暴露了 window.bumimang（真实 IPC 路径，不是 mock）
PASS  hub:snapshot 通道可用并返回快照
PASS  快照里有 agent 检测结果（4 家）  — agents=4
PASS  快照带上了当前策略规则包（应 Lane B 请求 R-1）  — pack="policy-engine(比赛合规包)" 回落到最小安全集=false
PASS  快照标出三家的审批输入能力  — 会有审批输入=["opencode","codex","claude","dsh"] 需配置=[]
PASS  快照任务带任务专属工作目录（<根>/<taskId>）  — taskWorkDir="D:\agent\xuanwo\work\task-b5b99762" ...
PASS  渲染进程画出了三栏（真实选择器：.col-left / .col-mid / .col-right）
PASS  页面有实际文本内容（没白屏）  — 300 字符
PASS  任务状态已落库（重启仍在）  — status=solved
---
26/26 通过
```

退出码 0；证据写入 `docs/logs/ui-verify.json`（`passed: 26, total: 26`）。

### 1.5 基线判定

- 基线**绿**，可以开工；没有“带红基线开工”。
- 本轮没有启动真实 agent，没有烧 token。
- 现有测试全部用 fake agent / 进程内 Hub / 临时 SQLite，符合“单元/集成测试不烧真实 token”的约束。

### 1.6 证据位置

- 完整 `verify:all` 日志：`evidence/phase0-verify-all.txt`（500 PASS / 0 FAIL；从 `--- verify:all start 10:51:20 ---` 到 `--- exit=0 10:51:46 ---`）
- 原始 harness 临时日志：`C:\Users\Administrator\.claude\projects\D--agent-xuanwo\6b3d8972-1f1e-4c10-9924-8dae72f1d0dd\tool-results\bnjlib6be.txt`
- Electron 断言：`docs/logs/ui-verify.json`
- 唯一一次真实 A/B：`docs/logs/ab-result.json`、`docs/done/AB-first-real-run.md`

---

## 2. 当前能力与缺口对照

| 能力 | 当前实现（代码证据） | 比赛缺口 | WP |
|---|---|---|---|
| 多题并发 | `hub/hub.ts` 只有一个 `taskId`；`task.create` / `task.switch` 调 `settleCurrentTask()` 停掉非终态会话；`session.start` 拒绝非当前任务；快照按当前任务过滤 sessions/approvals/health；启动只 `restoreSessions(latestTask)` | 不能同时打多题；后台任务不能继续跑；重启只恢复最近任务 | WP1 |
| 技能/知识注入 | `briefing/build.ts` 只有黑板状态 + work_dir + sync_protocol + incidents；角色只是 `lead/verify/recon/scribe` 字符串；MCP 只有黑板 7 个工具 | 没有题型 playbook、skill_routing、knowledge_tools、evidence_convention；打包后无法假设 `D:\agent\skill` 存在 | WP2 |
| 附件/工件/证据 | 没有附件导入/预览；`bridge.ts` 的 `inferEvidence` 只支持“任务工作目录内真实文件包含 flag”；相对路径已支持 | 题面/附件进不来；工件不可见；命令回显只能 E1；没有 `cmd:` 回放 | WP3 |
| 目标/范围/网络 | `policy/engine.ts` 只做 `command_regex/text_regex/tool_regex`；没有 target 数据；没有 CIDR；没有代理；`rules/competition.json` 6 条规则里没有 `no-out-of-scope` | 误打范围外目标是资格风险；审批卡没有目标维度 | WP4 |
| flag 闭环 | `hub.ts` 的 `flagCandidates` 是内存 `Map`；只有 `task.upsert.flagCandidate`；确认靠人工 `task.setStatus` | 重启丢候选；无去重/来源/误报/导出/提交/记分板 | WP5 |
| 评测 | `cli/verify-ab.ts` 支持单次 1 vs N、`--dry`；真实数据只有 `ab-result.json` 一次样本 | 没有 3 次重复/中位数/失败率/soak；不能回答“什么题型值得扇出” | WP6 |
| 可靠性/打包 | `acp/client.ts` 用 `taskkill /T /F`；没有 Job Object/等价兜底；MCP 崩溃只能新建会话；打包配置里 `workDir` 固定 `D:/agent/xuanwo/work`；`skillDir` 不存在 | 主进程被杀可能残留 agent/MCP/PTY；迁移失败无自动回滚；干净机器未验证 | WP7 |
| AWD/应急 | 零 | 没有轮次/服务/flag 轮换/补丁台账/时间线/答题卡 | WP8（只设计） |

补充：E0/E1/E2 的语义、审批三栏、哈希链三写一事务、MCP 每会话令牌、任务专属工作目录这些基础是好的，后续 WP 只做增量，不重写。

---

## 3. 执行约束与工作方式

1. `docs/ARCHITECTURE.md` 只读；设计变更写 `docs/decisions/D-<topic>.md`。
2. `packages/shared-protocol/events.ts` 只做加法：现有字段不改语义，新增字段必须可选，旧渲染层/旧测试不炸。
3. 持久化只用 `node:sqlite`；不引 `better-sqlite3` 或原生模块。
4. 不引重量级依赖；能用 Node 标准库就不加包；新依赖先写决策。
5. Windows 优先；不写死 `D:\`；路径从配置/环境变量解析。
6. 所有对外动作过策略引擎并留痕；新增事件进 `events` 哈希链。
7. 不写 `~/.claude`、`~/.codex`、`~/.agents`、`~/.config`；`D:\agent\skill` 只读。
8. 每个任务 `<workRoot>/<taskId>`；文件读写、命令 cwd、witness 解析都过路径检查，拒绝 junction/symlink 逃逸。
9. 不自动提交 flag、不自动打目标、不自动开环境；提交/利用必须人工确认，默认 manual。
10. 不烧真实 token 做无授权实验；每个 WP 的真实 agent 冒烟最多 1 次，A/B/benchmark 先问用户。
11. 不删测试、不放宽策略、不关审计；行为变更改断言并单独写进 done 文档。
12. 不是 git 仓库；大改前用 `.probe/backup-<topic>/` 备份；不自动 `git init`。
13. 每个 WP 的出口：`npm run verify:all` + renderer smoke + Electron `--verify` + 新套件全绿；写 `docs/done/WPx-*.md`；`docs/PROGRESS.md` 追加一行。

---

## 4. WP1 · 多题并发工作区（P0，最高优先级）

### 4.1 目标与验收映射

目标：N 个任务同时活跃；切题只切 UI 焦点，不停任何会话；重启恢复全部活跃任务。

对应总控 WP1 的 8 条验收：

1. 3 个任务 × 每任务 2 个 fake 会话 = 6 个都在跑。
2. 焦点 A→B，A 的 2 个会话仍 running；切回 A 仍能看流。
3. A、B 各触发一次审批：队列两条、taskId 正确、只处理 A 不影响 B。
4. A 首答触发收敛：只停 A 的队友，B 不动。
5. 每任务第 4 个会话被拒；全局第 9 个被拒；错误可读。
6. 杀主进程重启：3 个任务、6 个会话恢复；租约/意图按任务正确。
7. 归档 A：A 不在活跃看板，历史仍可查。
8. 旧 `board.db` 副本能迁移打开，旧任务/事实/会话不丢。

### 4.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/cli/verify-multitask.ts` | 8 组、20+ 断言；fake agent + 临时 SQLite |
| `docs/decisions/D-multitask-focus.md` | 记录“切题不再停会话”的行为变更、替代方案、影响 |
| `docs/done/WP1-multitask.md` | 完成文档（含真实输出、行为变更、已知问题） |
| `.probe/backup-wp1/`（临时，不入库） | 迁移前复制 `board.db` + `-wal`/`-shm` |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | `TaskView` 可选字段；`HubSnapshot` 可选 `approvalsAll`/`quota`；`HubEvent` 可选 `taskId`；`HubAction` 新增 `task.focus`/`task.archive`/`task.stopAll`；`task.create` 加可选 `category`/`priority`；`permission.grantAll` 加可选 `taskId` |
| `apps/desktop/src/main/blackboard/board.ts` | 迁移 v1；`createTask` 收 category/priority；`listTasks` 含 archived；`archiveTask`；`updated_at`；按任务释放 lease/abandon intent；旧库兼容 |
| `apps/desktop/src/main/hub/hub.ts` | 单 `taskId` → `focusedTaskId` + 活跃任务；去掉 `task.create/switch` 的 settle；快照/审批/收敛/flag 候选按任务；配额 |
| `apps/desktop/src/main/session/manager.ts` | `startSession` 接受任意非归档任务；`restoreSessions` 支持全部任务；`stopTaskSessions`；按任务收敛停止；配额错误透传 |
| `apps/desktop/src/main/electron/main.ts` | 启动加载全部任务；选焦点；逐任务 `restoreSessions`；全局 `recoverStaleSessions`；逐任务恢复信号 |
| `apps/desktop/src/main/electron/validate-action.ts` | 新动作运行时校验；非法 taskId/priority/archive 状态拒绝 |
| `apps/desktop/src/main/config/loader.ts` + `config/app.json` | `maxSessionsPerTask` / `maxSessionsTotal`（默认 3 / 8）；`workDir` 暂不动（WP7 做可移植） |
| `apps/desktop/src/renderer/main.ts` | 左栏任务列表；焦点切换；后台在跑提示；配额显示 |
| `apps/desktop/src/renderer/store.ts` | 只存焦点任务 sessions；`tasks` 全量；非焦点事件只更新计数 |
| `apps/desktop/src/renderer/task.ts` | 任务卡/创建弹窗加 category/priority；归档/停止全部入口 |
| `apps/desktop/src/renderer/panes/panes.ts` | 焦点切换时卸载旧 pane、按焦点重建；后台会话不建 DOM |
| `apps/desktop/src/renderer/approval/approval.ts` | 全局队列；`taskId`/任务标题；“只看当前任务”过滤；批量按过滤结果 |
| `apps/desktop/src/renderer/mock/data.ts`、`mock/engine.ts` | 多任务 mock：3 任务、每任务 2 会话、审批跨任务 |
| `apps/desktop/src/renderer/smoke.ts` | 多任务看板、后台计数、全局审批、配额提示断言 |
| `apps/desktop/src/cli/verify-r18.ts` | A 组语义改写：旧任务 `session.start`/`prompt` 现在允许；事件带 taskId、焦点 UI 不渲染；不再要求“切任务即停” |
| `apps/desktop/src/cli/verify-hardening.ts` | §6 “切任务时旧会话授权被清掉”改为“切焦点不清授权；`task.stopAll`/`session.stop` 才清” |
| `package.json` | `verify:multitask` 脚本 |
| `docs/PROGRESS.md` | 阶段结束追加一行 |

**回归影响面（不主动改，跑全量确认）**：`verify-history.ts`、`verify-briefing.ts`、`verify-concurrency-and-blocked.ts`、`renderer/tabs`、`renderer/cold-start`、`electron/*-verify.ts`。任何依赖“当前任务只有一套 sessions”的断言都要按新语义核对。

### 4.3 数据模型

**SQLite 迁移（v1，向后兼容）**

```sql
-- 打开旧库时先 PRAGMA table_info(tasks) 检查，逐列 ALTER，幂等
ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE tasks SET updated_at = created_at WHERE updated_at = 0;
PRAGMA user_version = 1;
```

`category` 取值：`web | misc | crypto | reverse | pwn | pentest | ir | awd | unknown`（WP2 复用）。`priority` 0–100，默认 0。`archived` 0/1。旧库没有这些列时默认 `unknown/0/0/created_at`，不炸。

**配置**

```json
{
  "version": 1,
  "workDir": "D:/agent/xuanwo/work",
  "maxSessionsPerTask": 3,
  "maxSessionsTotal": 8
}
```

`workDir` 的 `D:` 是当前本地配置的已知可移植性问题，WP7 处理；WP1 只加配额字段，不改工作目录语义。

**计数口径**

- 活跃会话：状态不是 `done/failed/stopped/blocked`（沿用现有 terminal 判定）。
- `runningSessions`：该任务非终态会话数。
- `totalSessions`：该任务未隐藏会话数（含终态，供看板显示历史）。
- 全局配额：所有非归档任务的非终态会话总和；归档任务不计入新启动配额。

### 4.4 契约增量（只加可选字段）

```ts
export type TaskCategory =
  | "web" | "misc" | "crypto" | "reverse"
  | "pwn" | "pentest" | "ir" | "awd" | "unknown";

export interface TaskView {
  // ...现有字段不动...
  category?: TaskCategory;
  priority?: number;
  runningSessions?: number;
  totalSessions?: number;
  updatedAt?: number;
  archived?: boolean;
  attachmentCount?: number;   // WP3 用；WP1 可先留空
}

export interface ApprovalView {
  // ...现有字段不动...
  taskTitle?: string | null;  // 全局审批队列显示“哪道题”
}

export interface HubSnapshot {
  // ...现有字段不动...
  /** 全部待批/已决（跨任务）；approvals 仍是焦点任务，保持旧渲染层兼容 */
  approvalsAll?: ApprovalView[];
  /** 配额展示；旧快照没有时 UI 不显示 */
  quota?: { maxSessionsPerTask: number; maxSessionsTotal: number; runningSessions: number };
}

export type HubEvent =
  | { type: "task.upsert"; task: TaskView }
  | { type: "session.upsert"; session: SessionView }
  | { type: "session.removed"; sessionId: string; taskId?: string }
  | { type: "session.stream"; sessionId: string; taskId?: string; update: StreamUpdate }
  | { type: "approval.upsert"; approval: ApprovalView }
  | { type: "permission.updated"; grants: PermissionGrantView[] }
  | { type: "board.appended"; taskId?: string; events: BoardEventView[] }
  | { type: "health"; sessionId: string; taskId?: string; health: SessionHealth };

export type HubAction =
  | { type: "task.create"; title: string; brief: string; category?: TaskCategory; priority?: number }
  | { type: "task.switch"; taskId: string }   // 保留名字，语义改为只切焦点
  | { type: "task.focus"; taskId: string }
  | { type: "task.archive"; taskId: string; force?: boolean }
  | { type: "task.stopAll"; taskId: string }
  // ...现有 session.* / approval.* 不动...
  | { type: "permission.grantAll"; scope: "session" | "agent" | "all" | "global"; sessionId?: string; agentId?: string; taskId?: string };
```

兼容性：`task.switch` 类型不变，只改语义；`approvals`/`sessions`/`board`/`health` 仍按焦点任务；旧渲染层不读新字段也能工作。`session.upsert` 通过 `SessionView.taskId` 已能判断归属，`session.stream`/`health`/`board.appended` 加 `taskId?` 是为了让渲染层不必维护反查表。

### 4.5 实现要点

**Hub 状态**

- 字段：`focusedTaskId: string | null`；任务列表仍从 `board.listTasks()` 取，不在内存复制整表。
- `currentTaskId` 保留为 getter（返回焦点），减少现有调用点改动；所有“当前任务”语义逐个改为“焦点任务”。
- `task.create`：`board.createTask({title,brief,category,priority})` → 设焦点 → 不停任何会话；沿用现有 `ActionResult`，不新增必填返回字段；渲染层动作后重新拉快照拿到新任务。
- `task.focus` / `task.switch`：校验任务存在且未归档 → 设焦点 → 确保该任务会话已加载（`mgr.loadTaskSessions`）→ 恢复该任务信号（flag 候选/黑板游标）→ 不发停止指令。
- `task.archive`：有活跃会话且 `force !== true` → 返回可读错误；`force` → `mgr.stopTaskSessions` 后归档；归档后若当前焦点是它，焦点切到最新非归档任务（没有则 null）；任务仍留在 `tasks` 数组并带 `archived: true`，渲染层过滤。
- `task.stopAll`：只停该任务非终态会话；不改任务状态、不归档。
- `session.start`：校验目标任务存在且未归档；配额检查；启动成功把该任务状态置 `solving`（现有逻辑改为目标任务），不强制切焦点；失败回滚目标任务状态。
- 配额错误文案示例：`任务会话配额已满（3/3）：请先停一个会话，或调大 config/app.json 的 maxSessionsPerTask`；全局：`全局会话配额已满（8/8）：请先停一个会话，或调大 maxSessionsTotal`。

**快照**

- `task`：焦点任务（没有焦点则 `null`）。
- `tasks`：全部任务（含归档，带 `archived`），按 `createdAt` 倒序；补 category/priority/running/total/updatedAt/flagCandidate。
- `sessions`：焦点任务未隐藏会话（兼容旧渲染层）。
- `approvals`：焦点任务；`approvalsAll`：全部任务，按 pending/风险/时间排序；每条 `taskTitle` 由 Hub 从任务表补。
- `board`/`health`：焦点任务；后台任务不推大对象。
- `quota`：全局运行数 + 上限。

**审批队列**

- `ApprovalQueue` 继续是全局单队列；`publishApproval` 不再按 taskId 过滤。
- 快照 `approvals` 过滤焦点，`approvalsAll` 全量；UI 默认“只看当前任务”，可一键看全部。
- 批量放行只对当前过滤结果里的 id 发 `approval.bulk`；`permission.grantAll scope=all` 默认只作用于焦点任务；带 `taskId` 时作用于指定任务；`global` 仍是显式全局授权。这样不会因为“全局视图点全放行”跨任务误放。
- 审批卡加任务标题；`ApprovalView.taskId` 已存在，不新增必填字段。

**收敛**

- `noteFlagCandidate(taskId, flag, sessionId)`：内存结构改为 `Map<taskId, Map<flag, {by, at}>>`；快照只暴露焦点任务的 `flagCandidate`（WP5 换成表）。
- `maybeStartConvergence(taskId, flag, bySessionId)`：只查该任务会话；只停该任务除首答者外的队友；写该任务黑板 note；绝不触碰其他任务。
- 收敛门槛仍按 R24（E1 及以上）；WP3 扩展 E2 后再评估是否收紧。

**重启恢复**

- `main.ts`：`board.listTasks()` → 非归档任务按 `createdAt` 选焦点（可优先上次焦点，若未来持久化）→ `mgr.recoverStaleSessions()` 全局一次 → 对每个非归档任务 `mgr.restoreSessions(taskId)` → `board.releaseStaleLeases(now)` / `abandonStaleIntents(taskId)` 按任务 → `hub.recoverTaskSignals(taskId)`。
- 恢复会话按 `sessions.task_id` 归属；`stream.jsonl` 路径已带任务目录，不跨任务。
- stale lease/intent 只能按 `task_id` 释放；不能出现“A 的租约被 B 的恢复清掉”。

**渲染层**

- 左栏新增任务看板：每题一行/卡片，显示标题、category、状态、`running/total`、flag 候选标记、后台在跑会话数；焦点高亮；归档折叠。
- 切焦点：`store` 用新快照替换焦点 `sessions/approvals/board/health`；`panes` 卸载旧 pane 并懒加载焦点会话历史；后台会话不建 DOM、不进 `SessionStreamSink`。
- `session.upsert`/`session.removed`：若 `session.taskId !== focus`，只更新 `tasks` 里对应计数，不进会话列表；焦点任务照旧。
- `session.stream`/`health`/`board.appended`：带 `taskId` 且不等于焦点 → 丢弃；焦点 → 现有处理。
- 全局审批视图：显示任务标题；过滤开关；批量只作用于过滤结果。
- 内存：焦点最多 3 个 pane；`CONV_WINDOW=120`、`MAX_BLOCKS=500` 不变；后台不保留渲染对象。主进程 `streamHistories` 仍按会话 2000 条上限，8 会话可接受；如实测吃紧，WP6 soak 再调。

**迁移**

- `Blackboard.open` 里读 `PRAGMA user_version`；低于 1 时在事务里逐列检查 + `ALTER TABLE` + `UPDATE tasks SET updated_at`；成功后 `PRAGMA user_version=1`；失败回滚并保留旧库（WP7 再加自动备份，本轮测试前手工 `.probe/backup-wp1/`）。
- 旧库副本测试：复制 `board.db`（含 `-wal`/`-shm`）到临时目录，打开后断言 tasks/facts/sessions 数量与迁移前一致，新列有默认值。

### 4.6 测试计划：`verify-multitask.ts`（20+ 断言）

| 组 | 断言 |
|---|---|
| A 建 3 任务 × 2 会话 | 3 个 task 落库；6 个 session 非终态；每任务 `runningSessions=2`；全局配额显示 6/8 |
| B 焦点切换 | A→B 后 A 两个会话仍 running；B 快照 sessions 是 B 的 2 个；切回 A 能拿到 A 的历史 seq；`task.switch` 与 `task.focus` 等价 |
| C 审批隔离 | A、B 各一条 pending；`approvalsAll` 两条且 taskId/taskTitle 正确；处理 A 后 B 仍 pending；只处理 A 不改变 B 会话状态 |
| D 收敛按任务 | A 首答触发；A 队友 stopped；B 两个会话仍 running；B 的 board 无 A 的收敛 note |
| E 配额 | 每任务第 4 个被拒（错误含 3/3）；全局第 9 个被拒（错误含 8/8）；停一个后可再启动 |
| F 重启 | 子进程创建 3 任务/6 会话后非优雅退出；父进程重开 DB + 恢复；3 任务 6 会话都在；A 的 lease 不出现在 B；stale intent 按任务 abandoned |
| G 归档 | 归档 A 需 `force`（有活会话时）；归档后 `tasks` 仍有 A 且 `archived=true`；焦点回退到 B；A 历史 facts/sessions 仍可查；`task.stopAll` 不归档 |
| H 旧库迁移 | 旧 schema 副本打开成功；旧 tasks/facts/sessions 数量不变；新列默认值正确；重复打开幂等 |
| I 渲染/契约 | `snapshot.tasks` 含 counts；旧字段 `task/sessions/approvals` 仍是焦点；旧 mock 快照不炸；`validate-action` 拒绝非法 taskId/priority |

测试实现建议：A–E、G、H 在进程内用 `Hub`+`SessionManager`+fake agent；F 用 `child_process.spawn` 一个小 harness（创建状态后 `process.exit`，不 close DB），父进程再打开；临时目录放 `.ui-run/multitask/<case>`，结束清理。所有断言中文描述 + actual/expected，沿用现有风格。

### 4.7 现有测试的行为变更（改语义，不删测试）

| 位置 | 旧断言 | 新语义 |
|---|---|---|
| `verify-r18.ts` A | 旧 taskId 的 `session.start` 被拒绝；旧任务 `prompt` 被拒绝；切任务后旧事件不得泄漏 | 旧任务仍活跃；`start`/`prompt` 允许；事件带 taskId；焦点 UI 不渲染非焦点事件（断言从“没有事件”改为“事件有正确 taskId 且 store 丢弃”） |
| `verify-r18.ts` A 前置 | “切到任务 B（收尾 A 的活会话）” | “切到任务 B（A 的活会话继续 running）” |
| `verify-hardening.ts` §6 | “切任务时旧会话的授权被一并清掉” | “切焦点不清授权；`task.stopAll`/`session.stop` 才清” |
| `verify-history.ts` | 可能假设单任务快照 | 跑全量确认；如断言“切任务后旧会话消失”则按新语义改写 |
| `smoke.ts` | 旧 mock 只有 task-1/task-0 | 增加多任务 counts/审批隔离/配额；旧断言保留 |

`docs/done/WP1-multitask.md` 必须单独写“行为变更：切题不再停会话，显式停用 `task.stopAll`”。

### 4.8 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 快照过滤改错，旧渲染层白屏 | 高 | 保留 `task/sessions/approvals` 焦点语义；先加字段后改 Hub；smoke + Electron 每步跑 |
| 审批跨任务误放 | 高 | `approvalsAll` 只读展示；批量按过滤 id；`grantAll scope=all` 默认焦点，带 taskId 才跨任务；测试 C |
| 收敛误停其他任务 | 高 | `maybeStartConvergence(taskId)` 全链路带 taskId；测试 D |
| 配额计数把终态算进去 | 中 | 用现有 terminal 判定；测试 E 停一个后可再启动 |
| 重启恢复顺序/重复加载 | 中 | `restoreSessions` 幂等；先全局 recover 再逐任务；测试 F |
| 迁移把旧库弄坏 | 高 | 先备份；事务 + 列检查；旧库副本测试 H；失败回滚 |
| 8 会话内存/事件量 | 中 | 渲染层只焦点；主进程 2000 条/会话上限；WP6 soak 观测 |
| `verify-r18` 改动被误认为“删测试” | 中 | 只改断言语义；新旧断言都写中文；done 文档标行为变更 |

### 4.9 先做的子步骤（确认后按此顺序）

1. **P1-A 契约 + 迁移 + 配额配置**（不改行为）：旧套件全绿；旧库副本能打开。
2. **P1-B Hub 焦点 + `task.create`/`switch` 不停会话 + 快照兼容**：3 任务 6 会话起得来；切焦点不停；旧渲染层不炸。
3. **P1-C `session.start` 任意任务 + 配额 + 按任务收敛**：验收 1/3/4/5。
4. **P1-D 重启/归档/旧库迁移**：验收 6/7/8。
5. **P1-E 渲染层任务看板 + 全局审批 + 后台计数**：3 题 UI 可切；smoke/Electron。
6. **P1-F 全量回归 + done/decision/PROGRESS**：出口门禁。

---

## 5. WP2 · 技能与知识接入（P0）

### 5.1 目标

每个 app 会话按题型/角色拿到 playbook；能检索 `D:\agent\skill` 的知识、WP 索引、脚本索引；打包后可通过配置或内置快照工作；未配置时 UI 明确提示，不静默降级。

### 5.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/skill/index.ts` | 扫描/解析 `SKILL.md`、`知识库/*.md`、`*.idx.md`、`PAYLOAD-CHEATSHEET.md`、`AI-SEARCH-INDEX.md`、`wp-index.jsonl`、`script-index.jsonl`；内存索引 + 检索 |
| `apps/desktop/src/main/skill/paths.ts` | `realpath` 根校验、拒绝 `..`/绝对路径/symlink 逃逸、扩展名/大小限制 |
| `apps/desktop/src/main/skill/tools.ts` | `skill_search` / `skill_read` / `skill_list` / `run_weapon` 的桥接处理 |
| `apps/desktop/src/main/skill/weapon.ts` | 白名单脚本执行：参数数组、无 shell、cwd=任务目录、60s、1MB、审计 |
| `apps/desktop/src/main/briefing/playbooks.ts` | 8 类题型 × 4 角色的 10–20 条 checklist + 常见坑 |
| `apps/desktop/src/main/briefing/routing.ts` | 题型/角色 → `SKILL.md`/`.idx.md`/知识库路径的路由 |
| `apps/desktop/src/cli/verify-skills.ts` | 6 组验收 |
| `docs/decisions/D-skill-tools.md` | 索引/工具/`run_weapon` 默认关闭的决策 |
| `docs/done/WP2-skills.md` | 完成文档 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | 复用 WP1 `TaskCategory`；`HubSnapshot.skill?: { configured, root, packages, builtAt, error? }`（可选）；不新增 HubAction |
| `apps/desktop/src/main/config/loader.ts` + `config/app.json` | `skillDir`、`skill.allowRunWeapon`、`skill.mcpMode` |
| `apps/desktop/src/main/briefing/build.ts` | 注入 `playbook`/`skill_routing`/`knowledge_tools`/`evidence_convention`；8KB 上限 |
| `apps/desktop/src/main/session/manager.ts` | 启动时传 category/role 给简报；MCP env `BUMIMANG_SKILL_DIR`/`BUMIMANG_SKILL_MCP`；不把 skill 根加入 codex `additionalDirectories`（避免绕过工具审计） |
| `apps/desktop/src/main/mcp-host/server.ts` | 注册 skill 工具；与黑板工具同进程、同会话令牌 |
| `apps/desktop/src/main/mcp-host/bridge.ts` | 新路由 + 令牌校验 + 输出上限 + 审计 |
| `apps/desktop/src/main/electron/main.ts` | 初始化 skill 状态；快照带 `skill` |
| `apps/desktop/src/renderer/task.ts` / `main.ts` | 创建任务选 category；未配置技能时明确提示 |
| `package.json` | `verify:skills` |
| `docs/PROGRESS.md` | 追加一行 |

### 5.3 数据模型

不新增 SQLite 表。技能索引是启动后懒构建的内存结构；可选写 `%APPDATA%\bumimang\cache\skill-index.json`，但必须可从源重建，缓存损坏不影响启动。

```ts
interface SkillIndex {
  root: string;                 // realpath
  packages: Array<"ctf-0day" | "ctf-solver">;
  docs: Array<{ path: string; title: string; kind: "skill" | "knowledge" | "idx" | "cheatsheet" | "search-index"; text: string }>;
  wps: Array<{ id: string; title: string; contest?: string; year?: string; category?: string; tags: string[]; path: string; oneLiner?: string }>;
  scripts: Array<{ name: string; relativePath: string; package?: string; size?: number; lines?: number; description?: string }>;
  builtAt: number;
}
```

`skillDir` 解析顺序：

1. `BUMIMANG_SKILL_DIR`（显式环境变量）；
2. `config/app.json` 的 `skillDir`；
3. 开发态默认 `D:\agent\skill`（仅当目录存在）；
4. 打包态 `resources/app-source/skill`（若构建打入）；
5. 都没有 → `skill.configured=false`，快照带 `error`，UI 提示“技能库未配置”，简报写明“无技能库”。

**不**把 `D:\agent\skill` 写进打包代码；`config/app.json` 的本地值可以保留，但打包产物不能依赖它。

### 5.4 简报增量

`briefing/build.ts` 输出（保持现有字段，新增可选字段）：

```json
{
  "schema_version": 1,
  "task": { "id": "...", "title": "...", "category": "web", "brief": "...", "work_dir": "..." },
  "playbook": {
    "category": "web",
    "title": "Web 单题检查表",
    "steps": ["指纹/框架", "目录与备份", "参数与隐藏字段", "注入", "上传", "包含", "SSRF", "SSTI", "JWT", "反序列化", "代码审计"],
    "pitfalls": ["先确认 flag 格式", "不要重复队友已试的 payload"]
  },
  "skill_routing": {
    "root": "D:\\agent\\skill",
    "packages": [{ "name": "ctf-solver", "path": "...", "why": "经典 CTF 单题" }],
    "suggestions": [{ "path": "skills/ctf-solver/知识库/SSTI.md", "title": "SSTI", "when": "怀疑模板注入时" }]
  },
  "knowledge_tools": {
    "skill_search": { "args": "query, source=all|core|ctf|wp|scripts, limit=10", "example": "skill_search(\"SSTI\")" },
    "skill_read": { "args": "path, offset?, limit?", "example": "skill_read(\"skills/ctf-solver/知识库/SSTI.idx.md\")" },
    "skill_list": { "args": "category?", "example": "skill_list(\"web\")" }
  },
  "evidence_convention": {
    "E0": "只有 agent 自述",
    "E1": "独立会话/文件见证，但未验证内容",
    "E2": "任务目录内证据文件包含提交的 flag/事实，或可回放命令命中",
    "rule": "命令回显写入 evidence/<name>.txt，submit_fact 的 witness 用任务目录相对路径"
  },
  "board": { "...现有..." },
  "sync_protocol": { "...现有..." },
  "incidents": ["...现有..."],
  "do_not": ["...现有..."]
}
```

序列化后总长 ≤ 8KB；超出时先截断 board 的展示文本和 suggestions，不截断 evidence 约定与 do_not。

### 5.5 MCP 工具

与黑板工具同进程、同会话令牌，不绕过 `bridge`：

| 工具 | 参数 | 行为 |
|---|---|---|
| `skill_search` | `query, source=all|core|ctf|wp|scripts, limit=10` | 检索 SKILL/知识库/idx/cheatsheet/AI 索引/wp-index/script-index；返回 `{path,line,snippet,title,kind,score}`；无结果返回空数组 + 提示 |
| `skill_read` | `path, offset?, limit?` | 只读 skillRoot 内文件；最大 256KB；越界/绝对路径/symlink 拒绝；返回 `{path,content,truncated,totalLines}` |
| `skill_list` | `category?` | 列出技能包、知识库目录、脚本包；返回路径与数量 |
| `run_weapon`（可选） | `script, args[], timeoutMs?` | 默认关闭；只允许 `skills/ctf-0day/scripts/*.py` 与 `skills/ctf-solver/CTF常用脚本及工具/**/*.py`；`spawn` 无 shell；cwd=任务工作目录；60s；输出 1MB；全量审计；执行前过策略 `skill/run_weapon`（block/approve 生效）；Python 缺失返回可操作提示 |

`BUMIMANG_SKILL_MCP=auto|on|off`：`auto` 默认注册 `skill_*`；`run_weapon` 仅 `skill.allowRunWeapon=true` 时注册；如果用户 harness 已有同名工具，`off` 可关闭我们的注册，简报会写“优先使用已有工具”。

### 5.6 测试计划：`verify-skills.ts`

1. `category=web` 简报含 Web checklist + `skill_routing`；`category=ir` 含应急 checklist；未知 category 有通用 checklist。
2. `skill_search("SSTI")` 命中 `SSTI.md`/`SSTI.idx.md`；`skill_search("CVE-2021-44228")` 命中相关知识库；`source=wp` 只返回 WP 索引命中。
3. `skill_read` 正常读；`../../`、绝对路径、symlink 越界全部拒绝；超过 256KB 截断并标记。
4. `run_weapon` 对非白名单脚本拒绝；白名单脚本 dry-run 成功（用 `--help` 或临时脚本）；Python 缺失错误可读；默认关闭时调用被拒。
5. 打包态 `skillDir` 指向外部目录可用；未配置时 `skill.configured=false`、UI/简报有说明。
6. 简报 ≤8KB；`skill_list` 返回两个包与数量；MCP 令牌错误时所有 skill 工具拒绝。
7. 真实 agent 冒烟（**需你同意，最多 1 次**）：一个 claude 会话在 Web 题上调用 `skill_search` 并引用返回路径。

### 5.7 风险

| 风险 | 缓解 |
|---|---|
| 47.5MB / 1027 WP 扫描慢 | 懒构建；jsonl 逐行解析；只索引元数据，不读全文；缓存 mtime/size |
| 路径逃逸 | 全程 `realpath` + 根包含检查；拒绝 symlink/junction；测试越界 |
| 简报塞爆上下文 | 8KB 硬上限；只给路由和 10–20 条 checklist；全文走 `skill_read` |
| 工具重名/重复注册 | `BUMIMANG_SKILL_MCP` 开关；`run_weapon` 默认关；简报声明可用工具 |
| WP 版权/AGPL | 不把 WP 全文/脚本复制进仓库；只读外置目录；打包只考虑 SKILL+索引+脚本并先评估 |
| 真实 agent 不调用工具 | 简报给明确示例；冒烟只验证一次，不追求所有 agent |

---

## 6. WP3 · 题目接入、工件与证据链（P0）

### 6.1 目标

题面/附件能进任务；人能看到工件；agent 能把命令输出落盘并形成可回溯证据；E2 从“仅文件含 flag”扩展到“文件含提交的 flag/事实”和可选 `cmd:` 回放。

### 6.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/artifacts/import.ts` | 文件/文件夹/zip 导入、sha256、复制到任务目录、`attachments.json` |
| `apps/desktop/src/main/artifacts/zip.ts` | 最小 ZIP 解析（store/deflate），拒绝 zip-slip/绝对路径/盘符/symlink/hardlink/ZIP64/加密；上限 200MB/1000 文件 |
| `apps/desktop/src/main/artifacts/preview.ts` | 文本/图片/二进制 hex 预览；截断；不执行 |
| `apps/desktop/src/main/artifacts/scan.ts` | 对文本附件/证据扫 `flag{...}`（大小写不敏感），带来源路径 |
| `apps/desktop/src/main/evidence/replay.ts` | `cmd:` 回放：默认关；`BUMIMANG_EVIDENCE_REPLAY=1` 开；30s、cwd=任务目录、1MB、审计；失败降级 E1 |
| `apps/desktop/src/cli/verify-artifacts.ts` | 6 组验收 |
| `docs/decisions/D-attachments.md` | ZIP 支持范围/预览安全/不执行决策 |
| `docs/done/WP3-artifacts.md` | 完成文档 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | `AttachmentView`/`ArtifactView`/`ArtifactPreview`；`TaskView.attachments?`/`attachmentCount?`；`HubSnapshot.artifacts?`；`HubAction.attachment.import`/`artifact.refresh`/`artifact.reveal`；`HubEvent.artifact.updated` |
| `apps/desktop/src/main/hub/hub.ts` | 附件导入/快照/工件刷新/预览路由；任务 upsert |
| `apps/desktop/src/main/blackboard/board.ts` | 无新表；任务 workdir 仍 `<workRoot>/<taskId>` |
| `apps/desktop/src/main/briefing/build.ts` | 附件清单 + evidence 约定；`evidence/<name>.txt` |
| `apps/desktop/src/main/mcp-host/bridge.ts` | `inferEvidence` 扩展：相对路径、事实内容、`cmd:` 回放结果；E2/E1 降级 |
| `apps/desktop/src/main/session/manager.ts` | 简报传附件；`BUMIMANG_EVIDENCE_REPLAY`；证据目录约定 |
| `apps/desktop/src/main/electron/main.ts` + preload | `dialog.showOpenDialog`；`hub:attachment.preview`/`hub:artifact.preview`；`shell.showItemInFolder`；不执行 |
| `apps/desktop/src/renderer/task.ts` | 创建任务加附件选择（文件/文件夹/zip）、flag 格式、目标占位（WP4 接） |
| `apps/desktop/src/renderer/panes/panes.ts` / 新 `artifacts/` 面板 | 工件列表、文本/图片/hex 预览、复制路径、系统打开（安全扩展名） |
| `apps/desktop/src/renderer/store.ts` / `contract.ts` | 新类型/状态 |
| `apps/desktop/src/renderer/mock/data.ts`、`mock/engine.ts`、`smoke.ts` | 附件/工件 mock 与断言 |
| `package.json` | `verify:artifacts` |
| `docs/PROGRESS.md` | 追加 |

### 6.3 数据模型

**目录**

```text
<workRoot>/<taskId>/
  attachments/
    attachments.json
    <name> / <dir>...
  artifacts/
  evidence/
    out.txt
```

**`attachments.json`**

```json
{
  "version": 1,
  "taskId": "task-...",
  "files": [
    {
      "name": "flag.txt",
      "relativePath": "flag.txt",
      "size": 123,
      "sha256": "....",
      "type": "text/plain",
      "source": "upload",
      "importedAt": 1792723905606
    }
  ]
}
```

字段按总控要求：name、size、sha256、type、来源；额外 `relativePath`/`importedAt` 是加法。`relativePath` 一律 POSIX 分隔符，禁止 `..`/盘符/绝对路径。

**限制**

- 单任务总大小 200MB、文件数 1000；超限返回可读错误，不部分写入。
- ZIP：只支持 store/deflate；拒绝加密、ZIP64、symlink/hardlink、`../`、绝对路径、盘符、NUL；解压先到临时目录再原子 rename；失败清理。
- 不自动执行任何附件/工件/脚本；预览只在渲染层以文本/图片/hex 呈现。

**契约**

```ts
export interface AttachmentView {
  name: string;
  relativePath: string;
  size: number;
  sha256: string;
  type: string;
  source: string;
  importedAt: number;
}

export interface ArtifactView {
  path: string;              // 任务目录相对路径
  name: string;
  size: number;
  mtime: number;
  kind: "text" | "image" | "binary" | "dir";
  previewable: boolean;
}

export interface ArtifactPreview {
  kind: "text" | "image" | "hex" | "unsupported";
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
  totalBytes?: number;
}

export interface TaskView {
  // ...现有...
  attachments?: AttachmentView[];
  attachmentCount?: number;
}

export interface HubSnapshot {
  // ...现有...
  artifacts?: ArtifactView[];   // 焦点任务
}

export type HubAction =
  // ...现有...
  | { type: "attachment.import"; taskId?: string; paths: string[]; note?: string }
  | { type: "artifact.refresh"; taskId?: string }
  | { type: "artifact.reveal"; taskId?: string; path: string };

export type HubEvent =
  // ...现有...
  | { type: "artifact.updated"; taskId: string; artifacts: ArtifactView[] };
```

`HubApi` 加 `previewArtifact(taskId, path): Promise<ArtifactPreview>`；路径必须 realpath 在任务 workdir 内，扩展名/大小限制；二进制 hex 最多 4KB，文本最多 256KB，图片最多 2MB。

### 6.4 证据链

- `inferEvidence(content, witness, taskId)` 扩展：
  - `witness` 支持 `{ path?, sessionId?, artifactId?, cmd? }`；字符串仍按相对路径处理（兼容旧调用）。
  - E2：witness 文件 realpath 在任务 workdir 内，且内容包含提交的 flag（flag 候选）或提交的事实文本（`submit_fact`）；或 `cmd:` 回放 stdout 包含提交内容且命令在白名单/策略允许。
  - E1：witness 是任务目录内真实文件但内容不匹配；或独立会话见证；或 `cmd:` 回放失败/超时但命令可追溯。
  - E0：只有自述。
- `cmd:` 回放：`BUMIMANG_EVIDENCE_REPLAY=1` 才开；命令来自 witness，`spawn` 无 shell；timeout 30s；cwd=任务目录；stdout/stderr 各 1MB；执行前过策略 `evidence/replay`；结果写审计；解析失败只降级 E1，不崩。
- 简报明确要求命令回显写入 `evidence/<name>.txt`，witness 用相对路径；附件清单写明路径。

### 6.5 测试计划：`verify-artifacts.ts`

1. 上传含 `flag.txt` 的 zip：解压、`attachments.json`、预览、flag 候选（source=artifact path）正确。
2. 恶意 zip：`../evil`、绝对路径、盘符、symlink、加密/ZIP64 被拒且无文件写出；清理临时目录。
3. 文本/图片/二进制预览正常；超大文件截断并提示；不执行。
4. `evidence/out.txt` 含 flag，`submit_fact` 带相对 witness → E2；不带 witness → E0；witness 指向目录外 → E1/拒绝；事实文本匹配 → E2。
5. 回放默认关闭；开启后命中/超时/非零退出行为确定且审计；失败降级 E1；非白名单/策略 block 拒绝。
6. 附件目录在任务切换/重启后仍可访问；A 任务附件不出现在 B；归档后仍可查。
7. 预览路径越界/symlink 逃逸拒绝；可执行文件不提供“系统打开”。

### 6.6 风险

| 风险 | 缓解 |
|---|---|
| 自写 ZIP 解析漏边界 | 只支持 store/deflate；拒绝加密/ZIP64/symlink；先临时目录；恶意样本测试；失败清理 |
| 200MB 导入卡主进程 | 流式 hash/复制；分块；UI 进度；上限；失败回滚 |
| 预览 XSS/执行 | 文本节点渲染；图片 data URL；不渲染 HTML；不 `openPath` 可执行；系统打开只允许安全扩展名 |
| 证据回放被滥用 | 默认关；白名单/策略；无 shell；超时/输出上限；全量审计 |
| 附件跨任务泄漏 | 一律 `<workRoot>/<taskId>/attachments`；realpath 校验；测试 6 |

---

## 7. WP4 · 目标、范围与网络边界（P0/P1）

### 7.1 目标

授权范围成为任务数据；策略能判定并留痕；能强制的尽量强制，不能强制的明确标注（不宣称 OS 级拦截）。

### 7.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/scope/parse.ts` | IPv4/CIDR/host/URL/host:port 解析、规范化、校验 |
| `apps/desktop/src/main/scope/match.ts` | CIDR 包含、target/deny 匹配、边界地址 |
| `apps/desktop/src/main/scope/extract.ts` | 从命令/权限请求文本提取候选目标，过滤文件路径/版本号误报 |
| `apps/desktop/src/main/scope/proxy.ts` | 可选本地 HTTP CONNECT/HTTP 代理；只允许 targets；记录请求 |
| `apps/desktop/src/cli/verify-scope.ts` | 5 组验收 |
| `docs/decisions/D-scope-enforcement.md` | 能强制/不能强制的边界、默认 verdict、代理默认关 |
| `docs/done/WP4-scope.md` | 完成文档 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | `TargetView`；`TaskView.targets?`/`denyTargets?`/`scopeNotes?`；`HubAction.target.add/remove/update`；`HubEvent.task.upsert` 复用 |
| `apps/desktop/src/main/blackboard/board.ts` | `targets` 表；`tasks.deny_targets`/`scope_notes`；迁移 v2；目标状态/备注 |
| `apps/desktop/src/main/hub/hub.ts` | 目标 CRUD；快照 targets；目标租约（复用 leases `target:<value>`） |
| `apps/desktop/src/main/policy/engine.ts` | `RuleMatch` 加 `out_of_scope?`/`target_regex?`；evaluate 接收 target/inScope |
| `apps/desktop/src/main/policy/policy.ts` / `permission/profile.ts` | 目标上下文传递；审批卡 target 填充 |
| `apps/desktop/src/main/acp/client.ts` | 权限请求/终端执行前提取目标并传给策略；block/approve 留痕 |
| `apps/desktop/src/main/session/manager.ts` | 代理启用时注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（仅遵守代理的工具）；不写 OS 配置 |
| `apps/desktop/src/main/electron/main.ts` | 代理生命周期；快照/状态 |
| `apps/desktop/src/main/config/loader.ts` + `config/app.json` | `scope: { enabled, outOfScopeAction, proxy: { enabled, port } }` |
| `rules/competition.json` | 加 `no-out-of-scope` 示例；保持“机制写死、内容数据化” |
| `apps/desktop/src/renderer/**` | 目标面板（值/kind/状态/端口/备注）、审批卡目标、范围提示 |
| `package.json` | `verify:scope` |
| `docs/PROGRESS.md` | 追加 |

### 7.3 数据模型

```sql
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL,          -- host | cidr | url
  status TEXT NOT NULL DEFAULT 'unknown', -- unknown | alive | owned
  notes TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, value)
);
ALTER TABLE tasks ADD COLUMN deny_targets TEXT NOT NULL DEFAULT '[]'; -- JSON array
ALTER TABLE tasks ADD COLUMN scope_notes TEXT;
PRAGMA user_version = 2;
```

```ts
export interface TargetView {
  id: string;
  taskId: string;
  value: string;
  kind: "host" | "cidr" | "url";
  status: "unknown" | "alive" | "owned";
  notes: string | null;
  createdAt: number;
}

export type HubAction =
  // ...现有...
  | { type: "target.add"; taskId: string; value: string; kind?: "host" | "cidr" | "url"; notes?: string }
  | { type: "target.update"; taskId: string; targetId: string; status?: TargetView["status"]; notes?: string }
  | { type: "target.remove"; taskId: string; targetId: string };
```

`TaskView` 加 `targets?: TargetView[]`、`denyTargets?: string[]`、`scopeNotes?: string | null`（均可选；旧快照不炸）。

### 7.4 策略与强制

**解析**

- IPv4 与 IPv4 CIDR（IPv6 后置，先返回“不支持”而不是误判）。
- URL：提取 host；`host:port`；裸域名；`localhost`。
- 命令文本：提取候选目标；排除文件路径（`./a/b`、`C:\`、`/etc/...`）、版本号（`1.2.3`）、已有 CIDR；解析失败 → `unknown`，不直接 block（避免误拦）。
- `denyTargets` 优先于 `targets`；都不在 → out-of-scope。

**策略**

```json
{
  "id": "no-out-of-scope",
  "match": { "out_of_scope": true },
  "verdict": "block",
  "reason": "目标不在任务授权范围内（denyTargets 或 targets 未包含）"
}
```

- `scope.outOfScopeAction: "block" | "approve"`，默认 `block`（比赛资格优先）；误报可通过把目标加入 `targets` 或改成 `approve` 解决。
- 命中授权目标但动作高风险（凭据/网络/执行）仍走现有 `approve` 规则。
- 每次判定写 `events`：`{target, rule, verdict, command, sessionId}`；审批卡显示目标与规则。
- 明确边界：策略只在“我们看得到的权限请求/终端调用”上判定；agent 自己执行、raw socket、DNS、直连可绕过。UI 和文档必须写“尽力强制，不承诺 OS 级防火墙”。

**代理（可选，默认关）**

- 本地 `127.0.0.1` 随机端口；HTTP + CONNECT；只允许 `targets` 内 host:port；deny 返回 403 并审计。
- 会话启动时注入 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`；`NO_PROXY` 置空；不修改系统代理/防火墙/全局配置。
- UI 标注“仅对遵守代理的工具生效；nmap/raw socket/DNS 可绕过”。
- 启用前需要你确认（§9 第 3 条：OS 级代理/全局配置要停；这里是 app 级本地代理，但仍按高风险变更先问）。

**目标面板**

- 列表/状态（unknown/alive/owned）/端口/备注；每目标租约复用 `leases` 的 `target:<value>`；凭据只做占位/脱敏，不做 vault。

### 7.5 测试计划：`verify-scope.ts`

1. CIDR：`10.0.0.0/8` 内/外、边界 `10.255.255.255`、非法输入、IPv6 明确不支持。
2. `curl http://10.1.2.3/x` 在授权段 → allow/approve；`curl http://8.8.8.8` → block（或配置的 approve）；命令里多个目标取最严格。
3. `denyTargets` 优先于 `targets`；目标加入后放行；移除后恢复 block。
4. 代理 allow/deny 各一条真实本地 curl；日志有 host:port/verdict；直连绕过时 UI 文案正确（不宣称拦截）。
5. 审批卡显示目标/规则；审计可检索；每次判定都有 event；旧任务无 targets 时不误 block。

### 7.6 风险

| 风险 | 缓解 |
|---|---|
| 目标提取误报导致误拦 | 默认只对“明确 IP/CIDR/URL/host:port”判定；解析失败不 block；可在 UI 加目标 |
| agent 不请求审批/自己执行 | 明确“尽力强制”；代理 + 审计；不宣称全拦截 |
| 代理被绕过（nmap/DNS/raw） | UI 明示；不承诺 OS 级；需要更强隔离时 WP7/后续再做 |
| CIDR 边界/端口错误 | 单元测试边界；IPv6 先拒绝 |
| 代理影响正常 agent | 默认关；按任务启用；随时可关；日志 |

---

## 8. WP5 · flag/答案/提交/记分闭环（P0/P1）

### 8.1 目标

候选持久化、跨会话去重、人工确认/误报、导出；可选提交适配器默认关闭；记分板可导出。

### 8.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/flags/store.ts` | `flag_candidates` + `flag_sources`；去重、状态、重启恢复 |
| `apps/desktop/src/main/flags/export.ts` | Markdown/CSV/JSON 导出（保存对话框） |
| `apps/desktop/src/main/flags/submit.ts` | manual/command；人工确认；dry-run；环境变量；超时；审计；脱敏 |
| `apps/desktop/src/main/flags/scoreboard.ts` | 任务 points/状态/已解统计/团队汇总 |
| `apps/desktop/src/cli/verify-flags.ts` | 5 组验收 |
| `docs/decisions/D-flag-submit.md` | 默认 manual、命令注入防护、token 不入库 |
| `docs/done/WP5-flags.md` | 完成文档 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | `FlagCandidateView`/`FlagSourceView`/`ScoreboardView`；`TaskView.flagCount?`/`points?`；`HubSnapshot.flags?`/`scoreboard?`；`HubAction.flag.confirm/reject/export/submit`；`HubEvent.flag.updated` |
| `apps/desktop/src/main/blackboard/board.ts` | 新表；迁移 v3；任务 `points`、`submit_mode`/`submit_command`/`submit_timeout_ms` |
| `apps/desktop/src/main/hub/hub.ts` | 内存 map → store + 缓存；确认写 `task.answer`/solved；导出/提交路由 |
| `apps/desktop/src/main/mcp-host/bridge.ts` | `submit_fact`/flag 候选仍只写候选；无 confirm 工具；来源记录 |
| `apps/desktop/src/main/briefing/build.ts` | flag 格式、证据约定、候选不自动 solved 的说明 |
| `apps/desktop/src/main/config/loader.ts` + `config/app.json` | 默认 submit manual；不存 token |
| `apps/desktop/src/renderer/**` | flag 面板（来源/证据/时间/状态）、确认/误报/复制/导出；提交确认弹窗；记分板 |
| `package.json` | `verify:flags` |
| `docs/PROGRESS.md` | 追加 |

### 8.3 数据模型

```sql
CREATE TABLE flag_candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  value TEXT NOT NULL,
  source_session TEXT,
  witness TEXT,
  evidence TEXT NOT NULL DEFAULT 'E0',
  first_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', -- new | confirmed | false_positive
  submitted_at INTEGER,
  submit_status TEXT,                 -- null | dry_run | ok | failed | timeout
  submit_detail TEXT,
  UNIQUE(task_id, value)
);

CREATE TABLE flag_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  session_id TEXT,
  witness TEXT,
  evidence TEXT NOT NULL DEFAULT 'E0',
  seen_at INTEGER NOT NULL
);

ALTER TABLE tasks ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN submit_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN submit_command TEXT;
ALTER TABLE tasks ADD COLUMN submit_timeout_ms INTEGER NOT NULL DEFAULT 30000;
PRAGMA user_version = 3;
```

旧数据：现有 `flagCandidates` 只在内存，没有持久化表；迁移不会“丢旧候选”，但重启前未确认的候选本来就会丢。若能从 `events` 的 `answer`/`note` body 里 regex 出 flag，做一次性 backfill（可选，失败不影响迁移）；任务/事实/会话不受影响。

### 8.4 行为

- 来源：流式 `FLAG_RE` 命中、MCP `submit_fact` 内容命中、WP3 附件/证据扫描。统一 `flags.store.add(taskId, value, {sessionId, witness, evidence})`；`UNIQUE(task_id,value)` 去重，同 flag 多来源写 `flag_sources`。
- UI 候选列表：值、来源会话、证据等级、witness、首次时间、状态；确认/误报/复制/批量导出。
- 确认：**只能人工点**；写 `task.answer=value`、`status=solved`、`solvedBy=human`（沿用现有字段）；不自动提交。
- 导出：Markdown/CSV/JSON，字段含任务、flag、来源、证据、时间、是否已提交；保存对话框选择路径；不默认写仓库。
- 记分板：任务 points、状态、已解/未解统计；团队汇总；导出。
- 提交：
  - `mode=manual` 默认：只显示“复制/人工提交”，不执行任何命令。
  - `mode=command`：必须人工点“确认提交”，弹窗展示将执行的 argv 与 flag；环境变量 `FLAG`、`TASK_ID`；`spawn` 无 shell；template 支持 JSON argv 数组（推荐）或简单 argv 字符串；超时；stdout/stderr 落审计；失败可重试；token 不入仓库/日志。
  - `dryRun=true` 只打印 argv，不执行；测试用。
  - 不做平台写 API 的默认集成；不内置任何平台凭据。

### 8.5 契约

```ts
export interface FlagSourceView {
  sessionId: string | null;
  witness: string | null;
  evidence: EvidenceLevel;
  seenAt: number;
}

export interface FlagCandidateView {
  id: string;
  taskId: string;
  value: string;
  status: "new" | "confirmed" | "false_positive";
  evidence: EvidenceLevel;
  firstSeen: number;
  sources: FlagSourceView[];
  submittedAt?: number | null;
  submitStatus?: "dry_run" | "ok" | "failed" | "timeout" | null;
}

export interface ScoreboardView {
  tasks: Array<{ taskId: string; title: string; status: TaskStatus; points: number; flagCount: number }>;
  solved: number;
  total: number;
  points: number;
}

export type HubAction =
  // ...现有...
  | { type: "flag.confirm"; taskId: string; candidateId: string }
  | { type: "flag.reject"; taskId: string; candidateId: string }
  | { type: "flag.export"; taskId?: string; format: "md" | "csv" | "json" }
  | { type: "flag.submit"; taskId: string; candidateId: string; dryRun?: boolean };

export type HubEvent =
  // ...现有...
  | { type: "flag.updated"; taskId: string; flags: FlagCandidateView[] };
```

### 8.6 测试计划：`verify-flags.ts`

1. 两个会话提交同一 flag → 一条候选，`flag_sources` 两条；不同任务同 flag 各自一条。
2. 标误报后不在待确认列表；确认后任务 solved、answer 正确、points 不变（或按配置）。
3. 重启后候选/状态还在；旧库迁移不丢任务/事实/会话；backfill 可选。
4. 导出 Markdown/CSV/JSON 内容正确（字段/转义/中文）；不写仓库。
5. `command` 提交默认不执行；`dryRun` 只打印；人工确认后才执行；失败/超时行为确定；日志不含 token；`manual` 模式无执行路径。
6. 候选不自动 solved；MCP 没有 confirm 工具；审批/审计有记录。

### 8.7 风险

| 风险 | 缓解 |
|---|---|
| 误确认/误提交 | 人工确认弹窗展示 flag/argv；默认 manual；dry-run；可重试；审计 |
| 命令注入 | 无 shell；优先 JSON argv；flag 作为环境变量/参数；拒绝 `;`/`|` 等只在 shell 模式才危险（我们不启用 shell） |
| token/凭据泄漏 | 不存仓库；不写日志；提交配置只允许本地；日志脱敏 |
| 重复候选/跨任务污染 | `UNIQUE(task_id,value)`；来源表；测试 1 |
| 旧库迁移 | 备份 + 事务 + v3；测试 3 |
| 导出泄露 | 用户选择路径；默认不写仓库；文档提示 |

---

## 9. WP6 · 真实 benchmark 与演练（P0，WP1–WP5 绿了再做）

### 9.1 目标

用 5–10 道真题、每道 3 次重复，测出并行/档位/题型的真实收益；soak 证明 3 任务 × 3 会话长时间不泄漏；报告回答“简单题/难题分别开几路、guarded 是否值得、收敛把 makespan 拉回多少”。

### 9.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `benchmarks/challenges.example.json` | 占位/公开题；不含私有题/真 flag |
| `benchmarks/challenges.local.json`（gitignore） | 本地真题/flag；不提交 |
| `apps/desktop/src/cli/bench.ts` | 1 vs 2/3、autonomous vs guarded、3 次重复、中位数；复用 `verify-ab` 的 runner |
| `apps/desktop/src/cli/bench-soak.ts` | 3 任务 × 3 会话 fake agent 60–120 分钟；内存/CPU/DB/流日志 |
| `docs/BENCHMARKS.md` | 结论（样本量/环境/模型/时间） |
| `docs/logs/bench-*.json` | 原始结果 |
| `docs/done/WP6-benchmark.md` | 完成文档 |

**修改**：`package.json`（`bench`/`bench:soak`）、`verify-ab.ts`（抽共享 runner，保持旧参数兼容）、`docs/PROGRESS.md`。

### 9.3 数据模型

```json
// benchmarks/challenges.example.json
{
  "version": 1,
  "challenges": [
    {
      "id": "example-web-1",
      "category": "web",
      "difficulty": "easy",
      "brief": "...",
      "attachments": [],
      "targets": [],
      "expectedFlagFile": "benchmarks/expected/example-web-1.txt",
      "timeoutMs": 900000,
      "maxSessions": 3
    }
  ]
}
```

本地 `challenges.local.json` 同 schema；`.gitignore` 排除。结果：

```json
{
  "runId": "...",
  "startedAt": 0,
  "environment": { "os": "...", "node": "...", "electron": "...", "agent": "claude", "model": "..." },
  "runs": [{ "challengeId": "...", "sessions": 1, "tier": "guarded", "repeat": 1, "wallMs": 0, "firstFlagMs": 0, "toolCalls": 0, "boardReads": 0, "duplicateFacts": 0, "approvals": 0, "approvalWaitMs": 0, "errors": 0, "tokens": null, "cost": null }],
  "aggregate": { "medianWallMs": 0, "medianFirstFlagMs": 0, "p95WallMs": 0, "failureRate": 0 }
}
```

### 9.4 测试与门禁

- `npm run bench -- --dry`：manifest 校验、计划打印、0 token、0 真实 agent。
- 聚合单元测试：用合成 runs 验证中位数/p95/失败率；重复不足 3 次拒绝下结论。
- soak：fake agent 60–120 分钟；记录 RSS、句柄、DB 大小、stream 文件大小；断言无持续增长/无卡死。
- 真实跑：至少 1 道公开题 × 3 次，**需你同意 token**；不做无授权 A/B。
- 报告必须写样本量/环境/模型/时间；不能把 1 次样本写成规律。

### 9.5 风险

| 风险 | 缓解 |
|---|---|
| 真题/flag 泄漏 | example 只放公开题；local gitignore；不提交真 flag |
| token 成本 | 默认 dry-run；真实跑先问；限制题数/重复 |
| 结果不可比 | 固定环境/manifest；记录模型/版本；中位数；样本量 |
| fake agent 不代表真实 | soak 只证明机械稳定性；真实结论只来自真实 agent 跑 |

---

## 10. WP7 · 可靠性与打包（P1，P0 之后）

### 10.1 目标

主进程崩溃/被杀后 agent/MCP/PTY 不残留；MCP 崩溃 UI 明确；迁移可备份/回滚；打包态 `skillDir` 外置/内置可用；干净机器记录（没有就写“未验证”）。

### 10.2 文件清单

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/reliability/backup.ts` | 启动备份 `board.db` + `-wal`/`-shm`；滚动 N 份；迁移失败回滚 |
| `apps/desktop/src/main/reliability/process-registry.ts` | 子进程 PID + 启动时间登记；清理时校验启动时间避免 PID 复用误杀 |
| `apps/desktop/src/main/reliability/mcp-health.ts` | MCP 崩溃标记不可用 + UI 提示 + 新建会话入口 |
| `apps/desktop/src/cli/verify-reliability.ts` | 备份/恢复/孤儿/迁移回滚断言 |
| `docs/decisions/D-process-cleanup.md` | Job Object/等价方案与限制 |
| `docs/done/WP7-reliability.md` | 完成文档 |

**修改**：`blackboard/board.ts`（启动备份、迁移失败回滚、哈希链检查）、`session/manager.ts`（子进程登记/清理、MCP 崩溃状态）、`acp/client.ts`（killTree 保留 + 启动时间校验）、`electron/main.ts`（启动流程）、`config/loader.ts`（可移植 workDir/skillDir）、`package.json`/electron-builder（extraResources/asar 检查）、renderer（MCP 不可用提示）、`docs/BLOCKED.md`（B-4 状态）、`docs/PROGRESS.md`。

### 10.3 方案

- **进程树**：保留 `taskkill /T /F` 作为基线；尝试 Job Object 或等价方案（不引原生模块；若只能用 PowerShell/系统工具，写清限制）。清理前用 PID + 启动时间校验，避免 PID 复用误杀。主进程崩溃后下次启动扫描登记表，清理仍属于本 app 的残留。
- **MCP 崩溃**：会话标记 `mcp_unavailable`（UI 文案），不自动重启；给“新建会话”入口；审计。
- **备份/迁移**：启动时复制 `board.db`/`-wal`/`-shm` 到 `%APPDATA%\bumimang\backups\<ts>\`；保留 5 份；迁移失败自动恢复备份并进入只读/提示；哈希链断裂检测，不自动截断。
- **打包**：`workDir` 不再硬编码 `D:`；默认用 `app.getPath("documents")/bumimang/work` 或用户目录；`skillDir` 支持外置/env/内置；`asar` 内容检查；打包态 `--verify` 全绿。
- **干净机器**：NSIS 安装 → 启动 → 检测 agent/skill/Python → 起会话；没有干净机器就明确写“未验证”（B-4）。
- **WSL**：至少检测 WSL 并给文档；Linux 原生包后置。

### 10.4 测试

- 备份存在/可恢复；迁移失败回滚；哈希链断裂进入降级而非清空。
- kill 主进程后重启，孤儿 agent/MCP 不残留（Windows）；PID 复用不误杀。
- MCP 崩溃 UI 状态/新建入口。
- 打包态 `--verify` 26/26（当前基线；若新增断言则更高）；asar 不含测试/私货；`config/app.json` 不含 `D:\agent\xuanwo` 硬编码。
- 干净机器：有则记录；无则 `docs/BLOCKED.md` 明确未验证。

### 10.5 风险

| 风险 | 缓解 |
|---|---|
| 备份/恢复写坏 | 先复制再迁移；校验；保留多份；失败只读 |
| Job Object 方案引入依赖 | 不引原生模块；等价方案写决策；至少保留 taskkill |
| PID 复用误杀 | 启动时间校验；只清理登记过的进程 |
| 打包配置改坏 | `pack:dir` + `--verify`；asar 检查；保留旧包 |
| 干净机器不可得 | 明确未验证，不写“已验证” |

---

## 11. WP8 · AWD / 应急模式（P1/P2，只设计）

### 11.1 门禁

只有在 **WP1–WP6 全绿、benchmark 证明并行有正收益** 后才做；先写设计文档，不写代码。复用现有黑板/任务/审批，不另起一套。

### 11.2 交付

`docs/design/AWD-IR.md`（+ `docs/done/WP8-design.md`），内容：

- **AWD**：轮次计时、服务清单、flag 轮换、批量提交（人工确认）、补丁台账、防守检查表、攻击日志。
- **应急**：证据板、时间线、日志/内存/PCAP 导入、问题清单/答题卡、结论导出。
- 数据模型建议（复用 tasks/facts/dead_ends/leases/approvals；新增只读视图；不接平台写 API）。
- 策略/审计/证据约定；明确不自动提交、不自动利用、不自动开环境。
- 实施前置条件与风险；不在本轮写代码。

### 11.3 验收

设计文档评审通过；不产生代码变更；不引入平台凭据/写接口；与 `ARCHITECTURE.md` 的差异写成 decisions。

---

## 12. 阶段、门禁与粗估

| 阶段 | 内容 | 出口门禁 | 粗估 |
|---|---|---|---|
| Phase 0 | 本计划 | 基线真实输出 + 每 WP 文件/数据/契约/测试/风险 | 已完成 |
| Phase 1 | WP1 | `verify-multitask` 20+ 绿；`verify:all` ≥379 绿；smoke 121；Electron 26；UI 可切 3 题 | 2–3 人日 |
| Phase 2 | WP2 + WP3 | `verify-skills`/`verify-artifacts` 绿；真实 agent 冒烟（WP2，需同意）；全量绿 | 2–4 人日 |
| Phase 3 | WP4 + WP5 | `verify-scope`/`verify-flags` 绿；全量绿 | 3–5 人日 |
| Phase 4 | WP6 | `bench --dry` 绿；至少 1 道公开题 ×3（需同意）；`docs/BENCHMARKS.md` 有结论；soak 报告 | 2–4 人日（含跑的时间） |
| Phase 5 | WP7 | 备份/回滚/孤儿/打包态 `--verify` 绿；干净机器记录或明确未验证 | 2–3 人日 |
| Phase 6 | WP8 | 设计文档评审；无代码 | 0.5–1 人日 |

每个阶段结束必须：`npm run verify:all` + `node apps/desktop/src/renderer/smoke.ts` + Electron `--verify` + 新套件全绿；写 `docs/done/WPx-*.md`；`docs/PROGRESS.md` 追加一行；行为变更单独标注。

**Lane 分工（如并行）**

- Lane A 核心：`src/main/**`、`packages/**`、`rules/**`、`src/cli/**`。
- Lane B 界面：`src/renderer/**`、`apps/desktop/electron/**`、`renderer.html`、`styles.css`。
- 契约由 Lane A 先提可选增量；Lane B 按 mock 先行；跨 lane 需求写 `docs/requests/A-to-B-*.md`；共享文件（`package.json`、`config/app.json`、`rules/*.json`）由 Lane A 统一改。

---

## 13. 需要你拍板 / 确认的事

| # | 事项 | 推荐默认 | 为什么需要你 |
|---|---|---|---|
| 1 | WP1 行为变更：切题不再停会话；`task.stopAll` 才显式停 | 按总控执行 | 改变已有工作流语义；旧测试断言要改语义（不删） |
| 2 | WP2 真实 agent 冒烟：1 个 claude 会话调用 `skill_search` | WP2 单测绿后做 1 次 | 会烧真实 token（总控允许每 WP 最多 1 次，但需你同意） |
| 3 | 技能库路径：开发态默认 `D:\agent\skill`，打包态用 `BUMIMANG_SKILL_DIR`/外置目录 | 不写死；未配置时 UI 明确提示 | 队友机器路径不同；需确认是否接受“未配置就提示”而不是内置快照 |
| 4 | WP4 本地代理：默认关，按任务启用，仅注入环境变量，不改 OS 代理/防火墙 | 默认关；需要时再开 | 总控 §9 第 3 条要求涉及代理/全局配置先停；这是 app 级代理，但仍先问 |
| 5 | WP5 提交：默认 `manual`；`command` 模式必须人工确认；不接平台写 API/凭据 | 默认 manual | 涉及自动提交风险/平台合规；需要你确认是否要 command 模式 |
| 6 | WP6 benchmark：默认 fake/dry-run；真实公开题 3 次跑需你同意 token | 先 dry-run，再问一次 | 真实 token 成本；总控要求 A/B 先问 |
| 7 | WP7 NSIS/干净机器：本机没有干净机器，安装流程只能标“未验证”（B-4） | 明确记录未验证 | 不能写“安装已验证” |
| 8 | 题型分类：`web/misc/crypto/reverse/pwn/pentest/ir/awd/unknown` | 按总控 | 如果比赛平台有固定分类/中文名，告诉我映射 |

另外，以下情况我会按总控 §9 停下来问：引入新依赖/原生模块/外部服务；改 OS 级配置；接平台 API/凭据；删除/归档用户数据；发现规则包误拦合法动作。

---

## 14. 与总控文档的冲突 / 勘误（以代码和实测为准）

| # | 文档说法 | 实测/代码 | 处理 |
|---|---|---|---|
| 1 | 现有 333 条确定性断言；Electron 20/20 | 379 条确定性（52+16+17+19+90+139+46）+ 121 smoke；Electron 26/26 | 门禁改为“≥379 + smoke 121 + Electron 26”；不把 333/20 当门槛 |
| 2 | “现有 `verify-history` 里切任务后旧会话被停的断言会失败” | 实际断言在 `verify-r18.ts` A 组（`旧 taskId 的 session.start 被拒绝`、`旧任务的 session.prompt 被拒绝`）；`verify-history` 是历史/状态/工作目录套件 | WP1 改 `verify-r18` A 组语义；同时检查 `verify-hardening` §6 的“切任务清授权”断言（总控未提，但同样会破） |
| 3 | `verify:all` 是“确定性套件”，smoke 单列 | `package.json` 的 `verify:all` 链尾已经包含 `renderer/smoke.ts` | 门禁统计写成“确定性 379 + smoke 121”；不要重复跑两次算两套 |
| 4 | 不写死 `D:\` | `config/app.json` 随包分发 `"workDir": "D:/agent/xuanwo/work"`；部分测试也硬编码仓库路径 | WP1 只加配额；WP7 把默认 workDir 改为运行形态/用户目录，测试路径改相对/临时目录；本轮不改 |
| 5 | `docs/ARCHITECTURE.md` §6.3 dsh 的说明 | `docs/BLOCKED.md` D-1 已记录修正；架构文档只读 | 不改 ARCHITECTURE；实现时把偏差写 `docs/decisions/` |
| 6 | “策略引擎只匹配 `request_permission` 文本” | 引擎本身也匹配 terminal/exec/fs action；但实测 opencode/codex 可能不请求审批，所以“实际可拦截面”确实窄 | WP4 文档写“引擎支持 action 匹配，但强制力取决于 agent 是否请求/是否走我们的终端”；不夸大 |
| 7 | 技能库约 51MB | 实测 47.5MB（ctf-solver 39MB + ctf-0day 8.5MB）；`wp-index.jsonl` 2,085,484 字节，`script-index.jsonl` 27,353 字节 | 以实测为准；不把全文打进包/上下文 |
| 8 | 打包态 `--verify` 20/20 | 当前 26/26；`使用方法.txt` 也写 26/26 | WP7 门禁用 26（或新增后更高），不写 20 |
| 9 | `HANDOVER` 说 dist 17:41 重打包 | 实际 `dist/不迷茫 0.1.0.exe` 时间 19:28；`使用方法.txt` 写 19:28 | WP7 重打包时统一记录；本轮不动 dist |

这些冲突不改变总控的设计意图；实现时按“代码和实测为准”，并在 `docs/decisions/` 留记录。

---

## 15. 明确不做（沿用总控 §8）

- 不重写成 React/Next/Tauri；不换 Electron。
- 不做云服务、遥测、自动更新、账号体系。
- 不自动提交 flag、不自动开靶场、不自动利用、不自动打范围外目标。
- 不修改用户已挂载技能的全局配置；不把 `D:\agent\skill` 写死。
- 不把 1027 篇 WP 全文塞进提示词/上下文；只做检索 + 按需读取。
- 不为过测试删断言、放宽策略、关审计。
- 不宣称“已强制拦截”而实际只是正则匹配。
- 不在没有干净机器的情况下写“安装已验证”。
- 不把 flag/token/凭据写进仓库、日志、截图。

---

## 16. 下一步

本轮到此为止：**没有改代码，没有跑真实 agent，没有改 ARCHITECTURE，没有删测试**。等你确认本计划（尤其是 §13 的 1/2/4/5/6/7/8）后，我按 §4.9 的 P1-A 开始 WP1：先做契约增量 + SQLite v1 迁移 + 配额配置，保持旧行为不变，跑全量基线，再进入 P1-B。

如果你希望调整顺序（例如先做 WP2 技能接入，或先做 WP3 附件），告诉我；否则默认按总控的 Phase 1 → Phase 6 执行。
