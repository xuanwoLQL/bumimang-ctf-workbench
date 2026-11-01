# P9-A · AWD/IR 只读模型层

> 状态：**P9-A 完成**。日期：2026-10-25。
> 范围：可选契约 + 只读派生模型 + `verify:awdir`；**不碰 renderer、不新增表、不接平台 API/不自动提交/利用/开环境**。
> 依据：`docs/plans/WP9-plan.md`、`docs/design/AWD-IR.md`、`docs/decisions/D-awd-ir-design.md`。

## 做了什么

### 1. 契约（只加可选）

`packages/shared-protocol/events.ts`：

- `AwdView` + `AwdRoundView`/`AwdServiceView`/`AwdFlagRoundView`/`AwdPatchView`/`AwdCheckView`/`AwdAttackView`。
- `IrView` + `IrEvidenceView`/`IrTimelineView`/`IrQuestionView`。
- `HubSnapshot.awd?` / `HubSnapshot.ir?`（可选；旧快照/旧 mock 不炸）。
- 视图含可选 `warnings?: string[]`（结构化 fact 解析问题）。
- 不新增必填字段/不新增 `HubAction`。

### 2. 派生模型

新增 `apps/desktop/src/main/awdir/model.ts`（纯函数，无 DB/fs/net/Electron）：

- `parseAwdFacts({taskId,facts,targets,flags,sessions?,scoreboard?})`：
  - round：取 `round` 号最大的 `awd.round` fact；`startedAt/endsAt/state`。
  - services：targets 为主；`awd.service` fact 按 `target`/`name` enrich（ownerSessionId/patchStatus）；无 target 的 fact 也列出。状态复用 `TargetStatus`（unknown/alive/owned）；fact `up→alive`、`down→unknown`。
  - flags：`awd.flag` fact 映射 candidateId→round；未映射候选归 **round=0**；confirmed/submitted 计数。
  - patches/checks/attacks：逐条结构化 fact；坏 JSON/坏版本/缺字段 → warning + 跳过。
  - scoreboard 透传。
- `parseIrFacts({taskId,facts,attachments?,artifacts?})`：
  - evidence：附件/工件 + `ir.evidence` fact；附件/工件默认 E0，fact 可 E2/witness。
  - timeline：`ir.timeline` 按 `at` 升序。
  - questions：`ir.question` 多问题/状态/答案/证据；非法状态回落 open。
  - 附件/工件透传；坏 fact warning 不抛错。
- 结构化约定：`content` JSON 字符串，顶层 `schema`（`awd.*`/`ir.*`）+ `v:1`；解析失败保留原 fact（视图跳过）+ warning，不猜。

### 3. Hub 快照集成

`apps/desktop/src/main/hub/hub.ts`：

- 快照按焦点 `task.category` 精确匹配 `awd`/`ir` 填 `awd`/`ir`；其他 category 不填。
- 解析 warning 写 stderr（前 3 条），不影响快照。
- attachments/artifacts/scoreboard 改为局部变量复用（行为不变）。
- 旧快照/旧 mock 无字段；不新增 UI。

### 4. 验证

新增 `apps/desktop/src/cli/verify-awdir.ts`（不并入 verify:all）：

- A1 AWD：round/service/flag 分组/未映射 round0/patch/check/attack/warnings/空 facts。
- I1 IR：附件/工件/fact 证据板；timeline 排序；question 状态；坏 fact；空 IR。
- H1 Hub 集成：category=awd 带 awd 不带 ir；category=ir 反之；无焦点不填。
- C1 契约/源码边界：可选字段、模型无 fs/net/child_process/eval/DB 写、verify:awdir 不在 verify:all。
- **30/30 PASS**。

## 改了哪些文件

| 文件 | 变更 |
|---|---|
| `packages/shared-protocol/events.ts` | 可选 AWD/IR 视图 + `HubSnapshot.awd?/ir?` |
| `apps/desktop/src/main/awdir/model.ts` | 新增纯函数派生 |
| `apps/desktop/src/main/hub/hub.ts` | 快照按 category 填 awd/ir |
| `apps/desktop/src/cli/verify-awdir.ts` | 新增 30 条 |
| `package.json` | `verify:awdir`（不并入 verify:all） |
| `docs/done/P9-A.md`、`docs/PROGRESS.md` | 文档 |

**未改**：board.ts（user_version 仍 3）、renderer/**、acp/session/mcp-host、config/rules、verify:all 链。

## 门禁

| 门禁 | 结果 |
|---|---|
| `verify:awdir` | **30/30** |
| `verify:all` | **712/0** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:artifacts` | **324/324** |
| `verify:skills` | **149/149** |
| `verify:reliability` | **45/45** |
| `verify:multitask` | **173/174**（已知 F 组 flaky） |
| electron `--verify` | **26/26** |
| `.probe/backup-wp1/board.db` | `6d491f0b…ab5cf469`（未变） |
| board user_version | 3（无新表） |

## 行为变更

- category=awd/ir 的焦点快照新增可选 `awd`/`ir` 只读视图；旧快照/其他 category 不变。
- 结构化 fact 约定 `schema` + `v:1`；解析失败 warning + 跳过。
- 无 UI/无自动动作/无平台 API；无新表。

## 已知限制

1. 结构化 fact 是弱类型约定；字段漂移只 warning，不做强校验。
2. 服务 status 复用 `TargetStatus`（unknown/alive/owned）；fact `down` 映射为 unknown，没有独立 down。
3. 未映射 flag 归 round=0；UI 需明确“未分配轮次”。
4. 附件/工件在 IR 证据板默认 E0；只有 `ir.evidence` fact 可带 E2/witness。
5. `awd.round` 无 `startedAt` 只 warning；state 缺失按 endsAt 推断（不读本机时钟）。
6. 多 round fact 取最大 round 号；同号后者覆盖前者。
7. Hub 只对精确 `awd`/`ir` category 填视图；中文/平台映射未做（用户指定固定 awd/ir）。
8. 无 AWD/IR UI（WP9-B1/B2）；无导出（WP9-C）；无强类型表（WP9-D）。
9. 无真实 AWD/IR 数据；模型用合成测试。
10. Hub warning 只写 stderr，未在 UI 显示（UI 后续可读 `warnings`）。
11. 不接平台 API/不自动提交/利用/开环境（设计底线）。
12. `verify:awdir` 不并入 verify:all；需单独跑。

## 代码 hash

| 文件 | sha256 |
|---|---|
| `events.ts` | `19411d7c…a7467849d` |
| `model.ts` | `664b9e6c…ad3a4e10` |
| `hub.ts` | `d09395b8…da47b1c8` |
| `verify-awdir.ts` | `71ba5a6b…e738f7ed` |
| `package.json` | `36ceac25…dc91c2a8` |
| `board.ts`（未改） | `88363dcd…b4561583` |
| `renderer/main.ts`（未改） | `67ddca91…3fe73f` |

## 证据

- `evidence/p9a-verify-awdir.txt` `6184e861…7d3f458`
- `evidence/p9a-verify-all.txt` `aa5c9666…4a00e97f`
- `evidence/p9a-verify-scope.txt` `d2d3b69c…12ddfe13f`
- `evidence/p9a-verify-flags.txt` `8dbac5db…acf780d9`
- `evidence/p9a-verify-migration.txt` `d2134863…882abe9b`
- `evidence/p9a-verify-artifacts.txt` `2b68b5a3…dd4bd140`
- `evidence/p9a-verify-skills.txt` `9d8df3fc…50523bb`
- `evidence/p9a-verify-reliability.txt` `79e67c56…b39ffa15`
- `evidence/p9a-verify-multitask.txt` `c4d84c5e…6bfaaaa4`
- `evidence/p9a-electron-verify.txt` `ccc7a07a…75fede0`

## 下一手需要什么

- WP9-B1：AWD 只读 UI（轮次/服务/flag 轮换/补丁/检查/攻击）；不改 board/acp/session/平台。
- 或按计划先评审 mock 视图；B2 再做 IR UI。
- 基线：awdir 30/30、all 712/0、scope 354、flags 214、migration 127、artifacts 324、skills 149、reliability 45、electron 26；multitask 173/174 已知。
- 停下等确认；不自动进 WP9-B。
