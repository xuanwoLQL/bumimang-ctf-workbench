# D-V2-0：基线审计中的文档/代码/测试冲突

> 2026-10-25 · 处理原则：代码与实测优先；冲突不偷偷改语义，记录后再决定。
> 相关方案：`docs/plans/COMPETITION-V2.md`；基线日志：`evidence/v2-baseline/`。

## 1. 门禁数字与文档不一致

| 文档 | 文档值 | 2026-10-25 实测 | 处理 |
|---|---|---|---|
| `docs/RELEASE-READINESS.md` | `verify:all` 712 | **720 PASS / 0 FAIL** | 以实测为准；不修改旧文档的历史快照，V2 文档引用新日志 |
| `docs/RELEASE-READINESS.md` | `verify:multitask` 173/174（F 组 flaky） | **174/174**，本次未复现 flaky | 记录“偶发”仍成立但本次全绿；P0 不据此改功能 |
| `docs/RELEASE-READINESS.md` | `verify:reliability` 45/45 | 45/45 | 一致 |
| `docs/RELEASE-READINESS.md` | `verify:awdir` 44/44 | 44/44 | 一致 |

## 2. “技能库外置”是旧需求，和 P0-1 冲突

- 代码：`apps/desktop/src/main/skill/index.ts:171-174` 已支持打包态 `resources/app-source/skill`。
- 测试：`apps/desktop/src/cli/verify-reliability.ts` C4 断言 **“skill 外置（不打包 resources/app-source/skill）”**，期望值为 `null`。
- 打包：`package.json` 的 `extraResources` 只有 rules/config；`dist/win-unpacked/resources/app-source/` 实测无 skill。
- 结果：旧测试把“缺技能库”当成正确状态，掩盖了 P0-1 的真实缺口。
- 决策：P0-1 将 C4 改为“内置 skill 必须存在且可解析，同时保留外置覆盖”。这是**需求变更**，不是放宽断言；修改记录写入 `docs/done/V2-P0-1-packaging.md`。

## 3. 打包产物落后于源码

| 对象 | 时间 |
|---|---|
| `dist/win-unpacked/resources/app.asar` | 2026-10-25 12:30 |
| `apps/desktop/src/main/hub/hub.ts` | 2026-10-25 12:59 |
| `packages/shared-protocol/events.ts` | 2026-10-25 12:59 |
| `apps/desktop/src/main/blackboard/board.ts` | 2026-10-25 13:06 |
| `dist/不迷茫 Setup 0.1.0.exe` / 绿色包 | 2026-10-21 19:28 |

- 结论：当前安装包/绿色包**不是当前源码**；任何“打包态已验证”的旧结论只对应旧源码。
- 处理：P0-1 与 P0-6 分别重打包并以产物时间 + 打包态 `--verify` 重新取证。

## 4. 架构文档的 SQLite 选型与代码不一致

- `docs/ARCHITECTURE.md:140` 写 `better-sqlite3`。
- 代码 `apps/desktop/src/main/blackboard/board.ts:12` 使用 `node:sqlite` 的 `DatabaseSync`。
- 处理：以代码为准。V2 保持 `node:sqlite`，不引入原生编译依赖；不修改旧架构文档的历史描述，在 V2 方案中明确。

## 5. 答案格式的“已支持”口径过宽

- 旧文档/审计可能把“flag 候选”描述为通用答案能力。
- 代码只有 `flag{...}`：`stream/normalize.ts:12`、`artifacts/scan.ts:22`。
- 处理：V2 明确区分“flag 候选”与“通用 AnswerSpec”；在 P0-2 完成前，所有报告只能写“仅 flag{}”。

## 6. benchmark 字段名

- 现有 `apps/desktop/src/cli/bench.ts` 使用 `expectedFlagFile`。
- V2 方案计划新增 `answerSpec` 与 `expectedAnswerFile`。
- 处理：`expectedFlagFile` 保留兼容；`expectedAnswerFile` 作为可选字段新增，两者同时存在时以 `expectedAnswerFile` 为准并告警。P0-6 实现时补迁移测试。

## 7. `verify:all` 的组成与用户门禁清单不同

- `package.json` 的 `verify:all` 只串联 8 个套件；flags/artifacts/scope/awdir/migration/multitask/reliability 是单独脚本。
- 用户要求每个阶段单独跑全部门禁；V2 按用户清单执行，不把“verify:all 绿”等同于“全部门禁绿”。
- 新增 `verify:answers/strategy/ir` 后，是否并入 `verify:all` 由实现时决定；无论是否并入，都必须单独可重跑。

## 8. 范围控制的文案冲突

- 旧文档/UI 可能存在“受控档/闸门”这类容易读成强制隔离的措辞。
- 代码事实：只对 `session/request_permission` 事前可控；`terminal/*`/`fs/*` 取决于 agent 是否委托；agent 自执行命令只能事后观测（`ARCHITECTURE.md:190-205`）。
- 处理：P0-5 统一文案为“仅可审计/未强制”，并在 UI、日志、文档三处一致；不得出现“平台已强制隔离所有 agent 网络动作”。

## 9. R24 收敛的验证口径

- 代码 `hub.ts:857-930` 已实现；确定性 fake 测试在 `verify-r18.ts:986+`、`verify-flags.ts:367+`、`verify-multitask.ts:393+`。
- 唯一真实 A/B（`docs/logs/ab-result.json`）发生在 R24 之前，**不能证明 R24 的真实收益**。
- 处理：P0-3 只声称“机制已测”；真实收益必须等用户提供靶场后做 S1/S2/S3 重复实验。

## 10. 结论

以上冲突不改变 V2 的实施顺序；但要求：

1. 所有“已验证”结论必须绑定到具体源码时间/产物时间/日志。
2. 过时测试可以改，但必须写明需求变更与新旧断言。
3. 没有真实数据的赛道一律写“未验证”。
