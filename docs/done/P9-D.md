# P9-D · 可选 AWD/IR 强类型表 v4

> 状态：**P9-D 完成**。日期：2026-10-25。
> 范围：board `user_version 3→4`，只建 7 张 AWD/IR 强类型表；**不背填/不迁移现有 facts、不改模型读取路径、不做 CRUD/UI/平台**。
> 用户已批准 P9-D（默认不做，明确要求）。

## 做了什么

`apps/desktop/src/main/blackboard/board.ts` 增加 v4 迁移（同一次 open 内 v3→v4；v0/v1/v2/v3 都顺序迁移，不跳版本）：

| 表 | 关键列 |
|---|---|
| `awd_rounds` | id/task_id/round_no/started_at/ended_at/duration_ms/state；UNIQUE(task_id,round_no) |
| `awd_services` | id/task_id/name/host/port/status/owner_session_id/patch_status；UNIQUE(task_id,name) |
| `awd_patches` | id/task_id/service_id/vuln/status/evidence/witness/updated_at |
| `awd_checks` | id/task_id/round_no/item/status/evidence/checked_at |
| `awd_attacks` | id/task_id/attacker/target/action/result/evidence/at |
| `ir_timeline` | id/task_id/at/source/event/impact/evidence |
| `ir_questions` | id/task_id/question/status/answer/evidence/updated_at |

- 每表按 `task_id`（及 round/at/updated_at）建索引。
- 只 `CREATE TABLE/INDEX IF NOT EXISTS`；**不 backfill、不读 facts、不写数据**。
- 模型/导出/UI 仍走 facts（P9-A/B/C）；这些表是预留强类型存储，尚未启用读写。
- P7-A 的备份/迁移失败恢复包装继续生效；v4 失败会回滚并恢复备份。

## 验证

### verify:migration（220/220）

- v0/v1/v2/v3 四类夹具：同一 open 迁到 v4；7 表存在且为空；任务/事实/会话数不变；重复打开仍 v4。
- 真实 `.probe/backup-wp1/board.db` 副本：迁到 v4；7 表存在且为空；tasks/facts/sessions/events 数不变；原备份 hash 不变。
- v3 专项：v3 夹具（有 flag 表/points，无 AWD/IR 表）→ v4；7 表存在且为空；不背填。
- 共 220 条（原 127 + v4 检查）。

### verify:awdir（44/44）

- 新增 “v4 七张表存在” + “v4 表不背填 facts” 两条（原 42）。
- AWD/IR 模型/导出/Hub 集成仍 42 条不变。

### 全量

| 门禁 | 结果 |
|---|---|
| `verify:all` | **720/0** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **220/220** |
| `verify:artifacts` | **324/324** |
| `verify:skills` | **149/149** |
| `verify:reliability` | **45/45** |
| `verify:awdir` | **44/44** |
| `verify:multitask` | **173/174**（已知 F 组 flaky） |
| electron `--verify` | **26/26** |
| `.probe/backup-wp1/board.db` | `6d491f0b…ab5cf469`（未变） |

> 注：本轮未打开 live `.ui-run/board.db`，它仍是 user_version 3；下次真实 app/board.open 时自动迁到 v4（先备份）。

## 改了哪些文件

| 文件 | 变更 |
|---|---|
| `main/blackboard/board.ts` | v4 迁移 7 表 + 索引 |
| `cli/verify-migration.ts` | 版本 3→4、v4 表/空表/不背填/夹具/真实备份检查 |
| `cli/verify-awdir.ts` | +2 条 v4 表检查 |
| `docs/done/P9-D.md`、`docs/PROGRESS.md` | 文档 |

**未改**：awdir/model.ts、awdir/export.ts、hub.ts、renderer/**、acp/session/mcp-host、config/rules、ui、平台。

## 行为变更

- 新库/旧库 open 后 `user_version=4`；新增 7 张空表。
- 不 backfill 现有 facts；AWD/IR 视图仍由 facts 派生。
- v4 迁移失败：P7-A 备份恢复 + 可读错误（不静默重置）。
- 旧 v0/v1/v2/v3 库兼容；重复 open 幂等。

## 已知限制

1. **表尚未被模型/UI 使用**：仍走 facts；强类型读写/CRUD 未实现。
2. **不背填**：已有 facts 不会导入这些表；需要未来显式迁移工具。
3. 无外键（沿用现有 schema 风格）；任务归档/删除不级联。
4. 无 id 生成/写 API/查询 API；只有 schema。
5. live `.ui-run/board.db` 本轮仍是 v3；下次 app 打开才迁移（有 P7-A 备份）。
6. 只验证 v0→v4、v1→v4、v2→v4、v3→v4；无 v4→v5。
7. 迁移检查 220 条包含大量表/空检查；不是逐列强约束测试（无 CHECK/NOT NULL 完整性断言）。
8. 无真实 AWD/IR 数据；表规模/索引效果未验证。
9. P9-D 默认不做，本次按用户要求执行；后续若启用强类型读写需另开批次/决策。
10. 无平台 API/自动提交/利用/开环境。

## 代码 hash

| 文件 | sha256 |
|---|---|
| `board.ts` | `f35c3b71…f0def6c4` |
| `verify-migration.ts` | `f69df644…687f5113` |
| `verify-awdir.ts` | `b52a1437…258b50f9` |
| `model.ts`（未改） | `664b9e6c…ad3a4e10` |
| `export.ts`（未改） | `516735dc…c9dbc5682` |

## 证据

- `evidence/p9d-verify-migration.txt` `16a40d37…502d334`
- `evidence/p9d-verify-awdir.txt` `a87235ee…c0d51032`
- `evidence/p9d-verify-all.txt` `1da6b4d8…61e10ccd`
- `evidence/p9d-verify-scope.txt` `95819e78…849ae835`
- `evidence/p9d-verify-flags.txt` `cf089c44…f89bce`
- `evidence/p9d-verify-artifacts.txt` `5322319b…d7f3095`
- `evidence/p9d-verify-skills.txt` `0833114e…588d1237`
- `evidence/p9d-verify-reliability.txt` `ecc37ece…25fc2434`
- `evidence/p9d-verify-multitask.txt` `c434f290…1732953c6`
- `evidence/p9d-electron-verify.txt` `2cefda2c…814f5e11`

## 下一手需要什么

- P9-D 已按用户要求完成；**P9 计划 A/B/C/D 全部收口**。
- 若启用强类型表读写：需新批次/决策（CRUD、背填工具、模型切换、UI），当前不做。
- 基线：all 720/0、awdir 44、scope 354、flags 214、migration 220、artifacts 324、skills 149、reliability 45、electron 26；multitask 173/174 已知。
- 停下等确认。
