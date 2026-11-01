# P6-A · benchmark manifest + dry-run + 聚合单元测试

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP6；`docs/plans/COMPETITION-READINESS.md` §9（§9.2 文件清单 / §9.3 数据模型 / §9.4 测试与门禁 / §9.5 风险）；`docs/done/WP5-flags.md`（WP6 交接）；`docs/decisions/D-flag-submit.md`
> 日期：2026-10-24
> 状态：**P6-A 完成**。只做 manifest + bench/soak dry-run + 聚合纯函数 + verify:bench；**0 token、不启动真实/fake agent、不启动子进程、不碰生产代码**。真实跑在 P6-C、fake soak 在 P6-B。

---

## 做了什么

把 WP6 的「先有可校验的题目清单和可重复的计划/聚合」补起来：

- **benchmarks 清单**：
  - `benchmarks/challenges.example.json`：3 道公开**占位题**（web easy / misc medium / crypto hard），不含真 flag；
  - `benchmarks/expected/example-*.txt`：占位 flag（`flag{PLACEHOLDER_..._do_not_submit}`）；
  - `benchmarks/challenges.local.json.example`：本地真题模板（指向 `benchmarks/expected/example-local-1.txt`）；`benchmarks/challenges.local.json` 已加入 `.gitignore`。
- **`apps/desktop/src/cli/bench.ts`**：
  - `--dry`（默认）：读 manifest、校验 schema（id/category/difficulty/brief/timeoutMs/maxSessions/expectedFlagFile 存在）、打印计划；
  - `--no-dry`：返回可读错误 `真实跑在 P6-C 实现；本步只做 dry-run`，不读 manifest、不启动任何东西；
  - 参数：`--manifest=path`、`--challenge=id`、`--repeats=3`、`--sessions=1|2|3`；
  - **零 `child_process`/`spawn`/`exec`**；不 import agent/session/acp/detect/verify-ab。
- **`apps/desktop/src/cli/bench-soak.ts`**：
  - `--dry`（默认）：校验 `tasks=3`/`sessions=3`/`minutes=60` 等参数并打印计划；
  - `--no-dry`：返回可读错误 `soak 在 P6-B 实现；本步只做 dry-run`；
  - 不启动 fake/真实 agent、不写文件、不启动子进程。
- **`apps/desktop/src/cli/bench-aggregate.ts`（纯函数）**：
  - `aggregate(runs)`：`medianWallMs`、`medianFirstFlagMs`（忽略 null）、`p95WallMs`（最近秩）、`failureRate`（errors>0 占比，4 位小数）、`sampleCount`、`repeatsPerChallenge`（每题最小 run 数）；
  - `canConclude(a)`：`sampleCount>=3 && repeatsPerChallenge>=3`；
  - 不读文件、不写文件、不启动进程。
- **`apps/desktop/src/cli/verify-bench.ts`**：A/B/C/D 组 **73 条**单元测试；A 红测因模块缺失失败，绿测全过。
- **`package.json`**：加 `bench`、`bench:soak`、`verify:bench`；**不并入 `verify:all` 链**。
- **`.gitignore`**：加 `benchmarks/challenges.local.json`。
- **`docs/BENCHMARKS.md`**：骨架（方法/环境/结论/数据/注意事项/待办）；结论 P6-D 填。

**关键取舍**

- **P6-A 只做“可校验的计划”**：不跑真实 agent、不跑 fake agent、不跑 soak；`--no-dry` 明确拒绝，不静默降级。
- **manifest 只放占位题**：公开占位；本地真题走 `challenges.local.json`（gitignore）；不要把真 flag 写进仓库。
- **聚合是纯函数**：P6-C 把真实 runs 交给它；P6-A 只用合成数据验证中位数/p95/失败率/样本量。
- **p95 用最近秩**：`ceil(0.95n)-1`，小样本 p95=max；文档写清，避免不同库口径混淆。
- **repeatsPerChallenge 取每题最小 run 数**：保守口径；任意一题不足 3 次就不能下结论。
- **不碰 verify-ab.ts**：P6-C 若要抽共享 runner，先停下问；P6-A 只做独立 bench。

---

## 改了哪些文件

- `benchmarks/challenges.example.json`（新增）
- `benchmarks/challenges.local.json.example`（新增）
- `benchmarks/expected/example-web-1.txt`、`example-misc-1.txt`、`example-crypto-1.txt`、`example-local-1.txt`（新增，占位 flag）
- `apps/desktop/src/cli/bench.ts`（新增）
- `apps/desktop/src/cli/bench-soak.ts`（新增）
- `apps/desktop/src/cli/bench-aggregate.ts`（新增）
- `apps/desktop/src/cli/verify-bench.ts`（新增）
- `package.json`（加 `bench` / `bench:soak` / `verify:bench`；**未改 verify:all 链**）
- `.gitignore`（加 `benchmarks/challenges.local.json`）
- `docs/BENCHMARKS.md`（新增骨架）
- `docs/done/P6-A.md`（本文件）、`docs/PROGRESS.md`

**明确未改**：

- `apps/desktop/src/main/**`（全部）
- `apps/desktop/src/cli/verify-ab.ts`（hash 仍 `286e6aa9…4e01058`）
- `packages/shared-protocol/events.ts`
- `renderer/**`、`mock/**`
- 其他 verify 套件（gate/hardening/r18/multitask/skills/artifacts/scope/migration/flags）
- `config/**`、`rules/**`
- `D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置
- `.probe/backup-wp1/board.db`

---

## 怎么验证的

### 红测

先写 `verify-bench.ts`，在 `bench.ts` / `bench-soak.ts` / `bench-aggregate.ts` 尚未创建时：

```text
evidence/p6a-bench-red.txt → ERR_MODULE_NOT_FOUND: bench-aggregate.ts
```

（新套件没有旧断言；模块缺失即红。）

### 绿测

```text
npm run verify:bench → 73/73 通过，exit=0
A 组 manifest 校验：合法 example/fixture、缺 id/category/difficulty/brief、重复 id、expectedFlagFile 不存在、timeoutMs=0、maxSessions=4、version=2、attachments 非数组、challenge 过滤不存在
B 组 dry-run：题数=3 × repeats=3 × sessions=2 → runCount=9/sessionCount=18/预计最坏墙钟=18×maxTimeout；--challenge 过滤；agent 启动计数=0
C 组聚合：中位数/p95/失败率/medianFirstFlagMs 忽略 null/空 runs/重复不足 canConclude=false
D 组：bench 非 dry-run 拒绝（P6-C）、soak 非 dry-run 拒绝（P6-B）、agent 启动=0、bench/soak/aggregate 源码无 child_process/spawn/exec、bench/soak 不 import agent/session/verify-ab
```

### dry-run 真实执行

```text
npm run bench -- --dry
不迷茫 · benchmark dry-run
manifest=benchmarks/challenges.example.json
题数=3 repeats=3 sessions=1
runs=9 sessions=9 预计最坏墙钟=270.0 分钟
- example-web-1  category=web difficulty=easy timeout=15.0m maxSessions=3
- example-misc-1 category=misc difficulty=medium timeout=20.0m maxSessions=3
- example-crypto-1 category=crypto difficulty=hard timeout=30.0m maxSessions=3
dry-run：不启动 agent、0 token、不写结果文件。
exit=0

npm run bench:soak -- --dry
不迷茫 · soak dry-run
tasks=3 sessions=3 minutes=60
sessionCount=9 sessionMinutes=540
计划观测：RSS / 句柄 / DB 大小 / stream 文件大小 / 是否卡死；fake agent 在 P6-B 实现。
dry-run：不启动 fake/真实 agent、0 token、不写文件。
exit=0
```

### 全量回归（P6-A 不改生产代码）

```text
npm run verify:all       → 688 PASS / 0 FAIL（确定性 391 + smoke 297）
npm run verify:gate      → 52/52
npm run verify:scope     → 308/308
npm run verify:migration → 127/127
npm run verify:flags     → 214/214
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（首次 173/174 是既有 F 组同毫秒排序 flaky，复跑绿）
Electron --verify        → 26/26
```

### 0 token / 无进程证明

- `bench.ts` / `bench-soak.ts` / `bench-aggregate.ts` 源码扫描无 `child_process`/`spawn`/`exec`（D 组逐条断言）。
- `bench.ts` / `bench-soak.ts` 不 import `session/manager`、`acp/`、`discovery/detect`、`verify-ab`。
- `bench-aggregate.ts` 不 import `node:fs`。
- dry-run 的 `onAgentStart` mock 计数 = 0；非 dry-run 也不启动（直接返回错误）。
- 本轮没有运行真实/fake agent；没有 token 消耗。

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p6a-bench-red.txt` | ERR_MODULE_NOT_FOUND（红） | `7e556de838653ad65c4956a19f948e070091009cf9710ee8c72c28310fa05901` |
| `evidence/p6a-verify-bench.txt` | 73/73 | `a941b922ba651ba2fab27e37bbdb1453f2aceea34211d831340254be79a88faf` |
| `evidence/p6a-bench.txt` | bench --dry exit=0 | `9b70150111361f677173e051438a5cb1d8cfecb3d58d903ffb4c604ab7115550` |
| `evidence/p6a-bench-soak.txt` | bench:soak --dry exit=0 | `09440d4204867345589864b552558456a86902cad5320cd3c1287d4d3dbc2a23` |
| `evidence/p6a-verify-all.txt` | 688/0 | `ce60b01713311d3287ee9f0a2d08dbc7c4717f31a9bde7577b161dce9f90e7ff` |
| `evidence/p6a-gate.txt` | 52/52 | `33145b3fff0baff18586a0240dab341c5bfd1765560972a5905f24923ca321a5` |
| `evidence/p6a-scope.txt` | 308/308 | `e9cd5d35d4fa3875d2f2a066d9a3f0f120d598d9cfaba2c41279f5bedf3782d0` |
| `evidence/p6a-migration.txt` | 127/127 | `4e887b055370ae485f851e957b01a1f911cce16febd4ed2a3a8484dced1e1126` |
| `evidence/p6a-flags.txt` | 214/214 | `e156f9aac7fb324cd7ae2697046588adf63e084f1365310d8dd3e1faf29f4584` |
| `evidence/p6a-artifacts.txt` | 324/324 | `1c16f8a25a4f94f01fc76c6a6ef466f82fb951f80f8367f67b9f99c2d4f1af2a` |
| `evidence/p6a-skills.txt` | 149/149 | `5820fe6a1b4e212941bc2fdee976678615570a59b5f32854e88487749d555fbd` |
| `evidence/p6a-multitask.txt` | 174/174（复跑） | `ae3128bc2dcde76c8d2a970f205b26eafc79f88c8edae65c5b5e36ffaa250ab7` |
| `evidence/p6a-electron-verify.txt` | 26/26 | `808a693fe7f8c30994d2f92322f51a677371f491d62bab8c44c931e975383a42` |
| `evidence/p6a-hard-check.txt` | 零进程/agent import；verify:bench 不在 verify:all | `bf2b2a996a39a6c0c6d955e8176127063b73959b283a875dc8d81fc3ca1c0fe2` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `bench.ts` | `e042b5516bfb8f6320619d8425cc030d1a4913c2dc3ce11ca8f8466bc62659e8` |
| `bench-soak.ts` | `7cb4e8de11a5c304d5f43d90935c3474fc703056fecb3b4f1913ed672d30435b` |
| `bench-aggregate.ts` | `c410b8f5296391c300a4f45a22d5d4b24047571a370be8b32916ff050bd4ed56` |
| `verify-bench.ts` | `27c4abba0a43cb8043a1e194aa4a1af4bf171e834ec5156b8e6f75feed75d832` |
| `package.json` | `219c136b347cbba866875710b6a8c5763b0e2e03e3cd7ed5ec1a2a0648279772` |
| `.gitignore` | `cf828031ed0543d29eb1a21e6b9b85bad7fdb8a5e11ea182a79b3b8aa48d863f` |
| `challenges.example.json` | `1cd7fa9d3fc4fd00d3884fdd15635c7f844ca34dce109691c38f272a1eb1a736` |
| `challenges.local.json.example` | `6b4febf9d297aa30851bf8b85c66e8ed02540f25c2069a39052243879a0ae57e` |
| `docs/BENCHMARKS.md` | `91f606402a6baa1c94bbb8d7c622e15903827e4a9e186bb94a915f796e78a8e9` |
| `verify-ab.ts` | `286e6aa9a8d2924c29b5e5685452320c80847e2c61bc917c1a64b552a4e01058`（未改） |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`；board 仍 v3；`verify:all` 链未改。

---

## 行为变更

1. **新增 `benchmarks/` 目录**：`challenges.example.json`（3 道公开占位题）、占位 expected flag、`challenges.local.json.example`；`.gitignore` 排除 `benchmarks/challenges.local.json`。
2. **新增 `bench.ts`（dry-run only）**：manifest 校验 + 计划打印；`--no-dry` 明确拒绝（P6-C）。
3. **新增 `bench-soak.ts`（dry-run only）**：参数校验 + 计划打印；`--no-dry` 明确拒绝（P6-B）。
4. **新增 `bench-aggregate.ts` 纯函数**：aggregate/canConclude；无 I/O/无进程。
5. **新增 `verify:bench`**：A/B/C/D 73 条；不并入 `verify:all` 链。
6. **新增 `docs/BENCHMARKS.md` 骨架**：结论 P6-D 填。
7. **无生产代码行为变更**：没有启动 agent、没有启动 fake agent、没有启动子进程、0 token；旧 688/0 全量不变。
8. **与 WP1~WP5 行为变更并列记录**：这是新增的 benchmark 工具面，不改变现有任务/flag/审批/范围语义。

---

## 没做什么 / 已知中间状态

- **bench.ts 非 dry-run 拒绝执行（P6-C）**：`--no-dry` 返回 `真实跑在 P6-C 实现；本步只做 dry-run`；没有 runner、没有 agent 客户端。
- **bench-soak.ts 非 dry-run 拒绝执行（P6-B）**：返回 `soak 在 P6-B 实现；本步只做 dry-run`；没有 fake agent。
- **manifest 只有公开题占位**：`challenges.local.json` 由用户本地提供，不提交；真 flag 不进仓库。
- **聚合是纯函数，没有真实 runs 数据**：P6-B/C 才有；`canConclude` 只是样本量下限。
- **docs/BENCHMARKS.md 只是骨架**：结论 P6-D 填；没有样本/环境/模型/时间数据。
- **不启动 agent、0 token、不 spawn**：P6-A 0 token；P6-C 真实跑单独申请 token。
- **verify-ab.ts 未改**：P6-C 若要抽共享 runner，先停下问；P6-A 只做独立 bench。
- **两个 UI 撒谎点（代理失败/崩溃状态不实）、multitask F flaky、render-verify 6 项仍挂账**：P6 或后续修。
- **command 提交模式未实现（WP5 决策）**；WP6 只评估 dry-run argv 的预期收益，不默认做 command。
- **points 无生产写入入口、记分板含归档、CSV 表头 hack、submitStatus `"manual"`**：WP5 已知，P6-A 不碰。
- **没有真实 benchmark 结论**：P6-A 只给工具与骨架；样本不足时禁止下结论。
- **verify:bench 独立于 verify:all**：门禁需单独跑。

---

## 下一手需要什么

- **P6-B（fake agent soak）**：实现 `bench-soak.ts` 非 dry-run：3 任务 × 3 会话 fake agent 60–120 分钟，记录 RSS/句柄/DB/stream/卡死；仍 0 真实 token。
- **P6-C（真实 benchmark）**：实现 `bench.ts` 非 dry-run；先 dry-run，再至少 1 道公开题 × 3 次；**真实 token 需用户单独批准**；复用/抽 verify-ab runner 前先停下问。
- **P6-D**：填 `docs/BENCHMARKS.md` 结论；样本量/环境/模型/时间必须写清；不能把 1 次样本写成规律。
- **WP6 评估**：command 模式是否值得做；代理/scope 默认值；CVE 精确检索；ctf-solver 根目录 `.md` 索引；permission.grantAll.taskId；后台 fact 即时性；backfill；事件量/哈希链性能。
- **WP6 修**：multitask F flaky、render-verify 6 项、两个 UI 撒谎点。
- 门禁：`verify:all` 688、`verify:bench` 73、`verify:flags` 214、gate 52、scope 308、migration 127、artifacts 324、skills 149、multitask 174、Electron 26。
- 不要重开 P6-A 决策：dry-run only、非 dry-run 明确拒绝、manifest 只放占位、聚合纯函数、verify:bench 独立、不碰 verify-ab.ts。如要改先停下问。
