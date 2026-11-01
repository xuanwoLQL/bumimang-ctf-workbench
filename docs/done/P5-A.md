# P5-A · flag 候选持久化（SQLite v3 + 契约视图 + store）

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP5；`docs/plans/COMPETITION-READINESS.md` §8.3/§8.5/§8.6/§12；`docs/done/WP4-scope.md`（WP5 交接）；`docs/decisions/D-scope-enforcement.md`
> 日期：2026-10-24
> 状态：**P5-A 完成**。只做持久化/契约/快照/store；**没有做确认/误报/导出/提交、没有 renderer、没有记分板、没有改 bridge.ts 提取逻辑、没有 backfill。**

---

## 做了什么

把 flag 候选从 Hub 进程内的 `Map<taskId, Map<flag>>` 改成 SQLite 持久化，并保留 P1-C 的展示/收敛语义：

- **SQLite v2 → v3**：新增 `flag_candidates` / `flag_sources` 两张表；`tasks` 补 `points`、`submit_mode`、`submit_command`、`submit_timeout_ms` 四列；`PRAGMA user_version = 3`。
- **迁移顺序**：v0/v1/v2 旧库都在同一次 `open()` 内按 v1 → v2 → v3 走完；v1/v2 迁移代码原文未改；v3 按表/列存在性判断，重复打开幂等。
- **Board API**：`addFlagCandidate`、`listFlagCandidates`、`getFlagCandidate`、`addFlagSource`、`listFlagSources`、`clearFlagCandidates`。
  - 同任务同 value 一条候选；来源表记录多会话/多证据；候选证据取最高（E2 > E1 > E0）。
  - 完全相同的 source（candidate + session + witness + evidence）只保留第一条。
  - 候选/来源写入同时追加 `kind=lifecycle` 黑板事件（`flag.candidate` / `flag.source`），不新增 EventKind/HubEvent。
- **契约（只加可选/新视图）**：`FlagSourceView`、`FlagCandidateView`；`TaskView.flagCount?`；`HubSnapshot.flags?`。保留现有 `TaskView.flagCandidate?: string | null`。
- **Hub**：
  - `noteFlagCandidate` 写 store（候选 + 来源），不再用内存 Map；可选 `source{witness,evidence}` 让 fact 路径带 E1/E2，stream 路径默认 E0。
  - `maybeStartConvergence` 仍以 board facts 的 E1+ 为门禁（R24 不变），额外从 store 读/补候选并把 fact 证据补进来源；只停该任务除首答者外的队友、只写该任务 note。
  - 快照 `flags` 只填焦点任务；`TaskView.flagCount` 所有任务可填；`flagCandidate` 保持焦点任务第一个候选、非焦点 null。
  - `task.setStatus` solved+answer 写 human 候选/来源；改回非 solved 调 `clearFlagCandidates` 清空该任务候选/来源（保留旧语义）。
- **bridge.ts 未改**：`submit_fact` 仍只写 fact；Hub 的 `publishBoardSince` 扫 fact 调 `noteFlagCandidate`，自然走 store。
- **测试**：`verify-migration` 73 → **127/127**（新增 v3 断言）；新建 `verify-flags` **44/44**（A 组）；`verify:flags` 独立脚本，不并入 `verify:all`。

**关键取舍**

- 面板/确认/提交留 P5-C/D；本步候选 `status` 固定 `new`，`submitted_at/submit_status/submit_detail` 为 null，不提前造状态机。
- `flag_candidates` 的 `source_session/witness/evidence` 取“第一个来源 + 最高证据”；完整来源看 `flag_sources`。
- `flag_sources` 对完全相同的 source 去重，避免流式重复扫描把来源表刷爆；不同会话/不同证据仍新增。
- 收敛仍然由 fact 证据触发（P1-C），store 只做持久化/补证；不改“只停本任务队友/写本任务 note”。
- `task.setStatus` 的旧内存语义（answer 生成候选、改回清空）保留，但改为 store + `clearFlagCandidates`。
- 没有 backfill：历史未确认候选本来就没持久化，迁移不丢历史任务/事实/会话/事件；是否从 events regex 回填留 WP6。

---

## 改了哪些文件

- `apps/desktop/src/main/blackboard/board.ts`
  - v3 迁移（两张表 + tasks 四列 + user_version=3）；v1/v2 未改。
  - `FlagCandidate`/`FlagSource`/`FlagEvidence` 类型；六个 API；候选/来源 lifecycle 事件。
- `packages/shared-protocol/events.ts`
  - `FlagSourceView` / `FlagCandidateView`；`TaskView.flagCount?`；`HubSnapshot.flags?`。
  - 没有新增 HubAction/HubEvent；没有改现有字段。
- `apps/desktop/src/main/hub/hub.ts`
  - `noteFlagCandidate` 写 store；`maybeStartConvergence` 读/补 store；`recoverTaskSignals`/`publishBoardSince` 带 fact 证据；`flagCandidateOf` 读 store；快照 flags/flagCount；`task.setStatus` store/clear；删除 `flagCandidates` Map。
- `apps/desktop/src/cli/verify-migration.ts`
  - 12 条 v3 断言组（v0/v1/v2/真实备份），5 条旧 user_version 期望 2→3。
- `apps/desktop/src/cli/verify-flags.ts`（新增）
  - A 组 44 条：持久化/来源/证据最高/重启/快照/旧快照/fact 路径/task.setStatus/跨任务。
- `package.json`
  - `verify:flags` 脚本；不并入 `verify:all`。
- `docs/done/P5-A.md`（本文件）、`docs/PROGRESS.md`。

**未改**：`mcp-host/bridge.ts`、`server.ts`、`session/manager.ts`、`policy/**`、`acp/**`、`scope/**`、`briefing/**`、`skill/**`、`artifacts/**`、`evidence/**`、`approval/queue.ts`、`electron/main.ts`、`config/**`、`rules/**`、`renderer/**`、`verify-gate/hardening/r18/multitask/skills/artifacts/scope`、`smoke.ts`、`mock/**`、`verify:all` 链、`D:\agent\skill`、`ARCHITECTURE.md`、全局配置。

---

## 怎么验证的

### 红测

```text
evidence/p5a-migration-red.txt → 75/127（v3 表/列/版本断言红；旧 73 中已有断言除 5 条版本期望外全绿）
evidence/p5a-flags-red.txt     → TypeError: board.addFlagCandidate is not a function（A 组模块/API 未实现红）
```

### 绿测

```text
npm run verify:migration → 127/127
npm run verify:flags     → 44/44
npm run verify:all       → 628 PASS / 0 FAIL（确定性 391 + smoke 237）
npm run verify:gate      → 52/52
npm run verify:scope     → 308/308
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（D 组 10/10，首答只停本任务队友；F 组 flaky 复跑）
Electron --verify        → 26/26
```

`verify:all` 仍为 628，没有把 `verify:flags` 并入链。

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p5a-migration-red.txt` | 75/127（v3 红） | `0b7399579482a2c0…4f4a8190` |
| `evidence/p5a-flags-red.txt` | `addFlagCandidate is not a function`（A 红） | `1fde2aa9ca5665b9…48c7e50` |
| `evidence/p5a-verify-all.txt` | 628/0 | `e92ac446ec60ae0d…1f853f28` |
| `evidence/p5a-gate.txt` | 52/52 | `33145b3fff0baff1…3ca321a5` |
| `evidence/p5a-scope.txt` | 308/308 | `9a87d15f07464ce1…ebfec358` |
| `evidence/p5a-migration.txt` | 127/127 | `6658602c3ae05bfb…a24cc86a` |
| `evidence/p5a-flags.txt` | 44/44 | `ff0dc720bc2d2e54…2e265ab4` |
| `evidence/p5a-multitask.txt` | 174/174 | `2066557205c9115c…3ae7d5a1` |
| `evidence/p5a-artifacts.txt` | 324/324 | `618b7777933490a5…546ab7c75` |
| `evidence/p5a-skills.txt` | 149/149 | `a961c503df41258d…f8097766` |
| `evidence/p5a-electron-verify.txt` | 26/26 | `cdd36e3f97e910e2…9600a68d` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `blackboard/board.ts` | `9d062fc88a7bb40b…907ab252` |
| `hub/hub.ts` | `0d36edefd9bcbf79…81a3088` |
| `packages/shared-protocol/events.ts` | `ee22f9ae9c2f2f39…62ca1c9` |
| `verify-migration.ts` | `d3c72581684e755b…299181cb` |
| `verify-flags.ts` | `cfa523b1b6696c00…b18d34bd` |
| `package.json` | `2e4227b75a515f78…98ef46a1` |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b…ab5cf469`，348160 B；config 默认 `enabled=false/outOfScopeAction=approve/proxy=false/port=0`；board 迁移后 `user_version=3`。

---

## 行为变更

1. **契约新增（全部可选/新视图）**：`FlagSourceView`、`FlagCandidateView`、`TaskView.flagCount?`、`HubSnapshot.flags?`；保留 `TaskView.flagCandidate?`；没有新增 HubAction/HubEvent、没有改现有字段语义。
2. **SQLite v2 → v3**：新增 `flag_candidates`/`flag_sources` 两表与 `tasks` 四列；v0/v1/v2 旧库一次性 v1→v2→v3；重复打开幂等；真实备份副本迁移后任务/事实/会话/事件数不变。
3. **noteFlagCandidate 写 store**：同任务同 flag 一条候选；多来源写 `flag_sources`；证据取最高；完全相同的 source 去重；候选/来源写 `kind=lifecycle` 事件（`flag.candidate`/`flag.source`）。
4. **maybeStartConvergence 读 store**：R24 门禁仍是 board facts E1+；额外从 store 读候选并补 fact 证据；只停该任务除首答者外的队友、只写该任务黑板 note、不触碰其他任务。
5. **快照**：`HubSnapshot.flags` 只暴露焦点任务；`TaskView.flagCount` 所有任务可填；`TaskView.flagCandidate` 焦点任务第一个候选、非焦点 null；旧快照不带 `flags` 仍可被 renderer store 读取。
6. **task.setStatus**：solved+answer 写 human 候选/来源；改回非 solved 调 `clearFlagCandidates` 清空该任务候选/来源（保留旧语义）。
7. **migration 测试**：旧 73 条保留，其中 5 条 `user_version` 期望 2→3（v2→v3 的必然行为变更）；新增 v3/v2 夹具/幂等/真实备份断言，总数 73 → 127。
8. **测试面**：新增 `verify:flags` A 组 44 条，独立于 `verify:all`；`verify:all` 仍 628，`verify:scope` 仍 308，`verify:multitask` 仍 174（D 组绿）。
9. **没有做**：确认/误报/导出/提交、renderer flag 面板、记分板、bridge 提取逻辑改动、backfill。

---

## 已知中间状态

- **flag 候选已持久化，但没有确认/误报/导出/提交**（P5-C/D）：候选只能看，不能操作；`status` 固定 `new`。
- **flag 面板 UI 未接**（P5-C）：候选只能在快照/CLI 里看；`TaskView.flagCount`/`HubSnapshot.flags` 已可供 UI 消费。
- **记分板未做**（P5-D）：`task.points/submit_mode/submit_command/submit_timeout_ms` 列已加但未消费。
- **bridge.ts 的 submit_fact 提取逻辑未改**（P1-C 行为）；noteFlagCandidate 改 store 后 submit_fact 自然走 store（经 fact → publishBoardSince → noteFlagCandidate）。
- **没有 backfill**：历史未确认候选本来就没持久化，迁移不丢；WP6 评估是否需要从 events 的 answer/note body regex 回填。
- **board.ts user_version v3**；WP5-B/C/D 不再动版本号（WP5 后续若需新表，先停下问）。
- **flag_candidates 的 source_session/witness/evidence 是“第一来源 + 最高证据”**；完整多来源看 `flag_sources`。候选 `status`/提交字段未使用。
- **flag 来源写 lifecycle events**：策略审计（每次判定一条 note）+ 代理审计（每请求一条 note）+ flag 候选/来源写 events，事件量会增长、哈希链尾部变化；P5-B 接 submit_fact 来源记录时要注意。
- **maybeStartConvergence 仍由 fact 触发**：store 只做持久化/补证；如果 fact 被删除但 store 有 E1 候选，不会单独触发收敛（保持 R24 语义）。
- **source 去重**：完全相同的 source（session+witness+evidence）只保留一条；同一会话同一 flag 重复提交不会重复来源（不同证据/不同会话会新增）。
- **task.setStatus 清空**：改回非 solved 会删除该任务全部候选/来源（保留 P1-C 旧语义）；这是破坏性清理，后续确认/误报功能若需要历史审计，P5-C 要重新评估。
- **multitask F 组 flaky**（同毫秒排序无 tie-break）、**render-verify 6 项既有失败**仍挂账，WP6 修。
- **两个 UI 撒谎点（代理失败/崩溃时状态不实）**仍挂账，WP6/后续修；P5-A 不顺手修。
- **verify:flags 仍独立于 verify:all**，门禁需单独跑。
- 没有真实 agent 的 flag 来源端到端（只测 Hub/board/store 与 D 组收敛）；P5-B 接 submit_fact 来源时再补。

---

## 下一手需要什么

- **P5-B**：`submit_fact` 来源记录/证据等级进 store；保留 E0/E1/E2 判级；不自动确认；注意 flag 候选/来源 lifecycle 事件量与哈希链。
- **P5-C**：flag 面板 UI（候选/来源/witness/证据/时间/状态）、确认/误报/复制/导出；契约若要新 HubAction/HubEvent 先写 `docs/requests/` 并停下问。
- **P5-D**：记分板/points/submit_mode/command 提交；默认 manual；command 必须人工确认 + dry-run；token 不入库/日志。
- **WP6**：backfill 评估、multitask F 排序 flaky、render-verify 6 项、代理 A/B UI 撒谎点、真实 agent 工具链覆盖。
- 门禁：`verify:all` 628、`verify:flags` 44、`verify:migration` 127、`verify:scope` 308、artifacts 324、skills 149、multitask 174、Electron 26；`verify:flags` 仍独立。
- 不要重开 P5-A 决策：v3 schema、可选契约、store 化、fact 门禁、无 backfill；如要改先停下问。
