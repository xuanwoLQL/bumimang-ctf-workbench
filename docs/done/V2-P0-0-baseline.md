# V2-P0-0 · 基线、备份与技术方案

> 日期：2026-10-25 13:34–13:40（Asia/Shanghai）
> 范围：只读审计 + 备份 + 文档；**未修改任何业务代码**。
> 原始日志：`evidence/v2-baseline/`；备份：`.probe/backup-v2/`；方案：`docs/plans/COMPETITION-V2.md`。

## 1. 做了什么

1. 阅读架构、交接、发布就绪、benchmark、进度、A/B、AWD/IR 设计、打包配置与关键源码。
2. 按用户清单运行全部既有门禁，原始输出落盘。
3. 备份即将修改的核心源码/配置/规则到 `.probe/backup-v2/`，并生成 SHA-256 快照。
4. 写 `docs/plans/COMPETITION-V2.md`（每个 P0 的改动、契约、迁移、测试、风险、回滚、验收）。
5. 写 `docs/decisions/D-v2-baseline-conflicts.md`（文档/代码/测试冲突）。
6. 给出“当前不是一等奖系统”的带证据基线判定。

## 2. 门禁原始结果（全部 exit=0）

| 命令 | 结果 | 原始日志 |
|---|---|---|
| `npm run verify:all` | **720 PASS / 0 FAIL** | `evidence/v2-baseline/verify-all.log` |
| `npm run verify:flags` | **214/214** | `verify-flags.log` |
| `npm run verify:artifacts` | **324/324** | `verify-artifacts.log` |
| `npm run verify:scope` | **354/354** | `verify-scope.log` |
| `npm run verify:awdir` | **44/44** | `verify-awdir.log` |
| `npm run verify:migration` | **220/220** | `verify-migration.log` |
| `npm run verify:multitask` | **174/174** | `verify-multitask.log` |
| `npm run verify:reliability` | **45/45** | `verify-reliability.log` |
| Electron `--verify` | **26/26** | `electron-verify.log` |

- 时间：2026-10-25T13:34:04+08:00 → 13:35:03+08:00。
- 无 FAIL；本次 multitask 未复现 F 组 flaky。
- 结论：基础机制可靠，但这只是“机制基线”，不是“得分能力基线”。

## 3. 备份与哈希

- 目录：`.probe/backup-v2/`
  - `package.json`
  - `config/`（app.json、permissions.json）
  - `rules/`（competition/dev/redteam）
  - `apps/desktop/src/`（完整主/渲染/CLI 源码）
  - `packages/shared-protocol/`
- 快照：`.probe/backup-v2/hashes.sha256`（112 条源文件 + package.json）。
- 创建时间：`.probe/backup-v2/CREATED.txt` = 2026-10-25T13:34:37+08:00。
- 恢复方式：按 hash 文件核对后，从备份目录复制回原相对路径。

## 4. 基线判定（带证据）

**当前不是一等奖系统。**

| 缺口 | 代码/数据证据 |
|---|---|
| 答案只认 `flag{...}` | `stream/normalize.ts:12`、`artifacts/scan.ts:22`；无 AnswerSpec/注册表 |
| 附件只扫文本前 4MB，不处理 ZIP/PDF/PCAP/内存 | `artifacts/scan.ts:25,57` |
| priority 不参与调度 | 仅 `hub.ts:149`、`board.ts:647`、`validate-action.ts:176`；全仓无 strategy 模块 |
| 一键扇出固定三路 | `renderer/fanout/model.ts:48-52` |
| R24 只有 fake 测试，无真实 A/B | `hub.ts:857-930`；`verify-r18.ts:986+`；唯一 A/B 在 R24 之前 |
| 真实基准仅 4 个 Web E2 | `docs/BENCHMARKS.md`；first flag median 552.1s；无 Crypto/Misc/Reverse/IR/企业网 |
| IR 只读 | `main/awdir/model.ts`、`renderer/ir/panel.ts`；全仓无 analyzer/registry/工具调用 |
| 打包不含技能库 | `package.json extraResources`；`dist/win-unpacked/resources/app-source/` 无 skill |
| 打包产物过期 | asar 12:30，源码 12:59–13:07；exe 2026-10-21 |
| scope 默认关闭 | `config/app.json:11-18` |
| agent 自执行命令不可事前拦 | `ARCHITECTURE.md:190-205`、`HANDOVER.md` §4 |

## 5. 已知限制 / BLOCKED

- **干净 Windows VM 验证：BLOCKED**。当前机器不是干净环境，没有可用 VM；P0-1 的“干净机器证据”不能声称通过。
- **真实 benchmark：BLOCKED on 用户数据**。没有新的可重置靶场、标准答案、Crypto/Misc/Reverse/IR/企业网样本；不得用 fake agent 或单次样本替代。
- **真实 agent 消耗 token**：本轮未起任何真实 agent；后续真实 A/B 需用户确认模型/agent/额度/时间。
- 旧文档中的 712/173/“skill 外置”等历史口径与本次实测冲突，已记录在 `docs/decisions/D-v2-baseline-conflicts.md`。

## 6. 下一步

按 `docs/plans/COMPETITION-V2.md` 的顺序进入 P0-1：

1. 新增 `skill-builtin/` 与 `extraResources`。
2. 修 `SkillStatus.source` 与 UI 来源显示。
3. 更新过时的“skill 不打包”断言为“内置 skill 必须可解析”。
4. `pack:dir` + 打包态 `--verify`；干净 VM 继续标 BLOCKED。
