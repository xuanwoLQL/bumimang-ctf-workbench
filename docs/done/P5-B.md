# P5-B · submit_fact 来源接 store + 收敛来源补全 + verify-flags B 组

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP5；`docs/plans/COMPETITION-READINESS.md` §8.4/§8.6；`docs/done/P5-A.md`（v3/store/noteFlagCandidate/收敛来源）；`docs/done/WP4-scope.md`（WP5 交接）
> 日期：2026-10-24
> 状态：**P5-B 完成**。**没有修改 bridge.ts / hub.ts**：P5-A 的 fact → Hub 扫描路径已经能把 fact 的 witness/evidence 传给 `noteFlagCandidate`，本轮只加 B 组验证并锁住该链路。没有确认/误报/导出/提交/记分板/renderer。

---

## 做了什么

- **确认 submit_fact 真实路径**：
  - `BoardBridge.submit_fact` 调 `inferEvidence(content, witness, taskId, sessionId)`，把结果写进 `board.submitFact(content, witness, evidence)`。
  - bridge 没有 `noteFlagCandidate` 调用；写完后 `onBoardWrite → main.flushBoard → Hub.publishBoardSince` 扫 fact，`publishBoardSince` 从 `row.witness` / `body.evidence` 传 source 给 `noteFlagCandidate`。
  - P5-A 已经实现了这条 source 透传；P5-B 评估后**不需要改 bridge.ts**，也不需要改 hub.ts。
- **锁定 fact → Hub → store 链路**：
  - `verify-flags` 新增 B 组 23 条，使用真实 `BoardBridge.route(BRIDGE_RPC.submitFact)` + `Hub.publishBoardSince`：
    * witness+E2 → 候选 E2、来源 witness；
    * witness+E1 → 候选 E1；
    * 无 witness → E0；
    * 同 fact 两个 session → 一条候选、两条来源；
    * 同 session 同 witness 重复提交 → 来源去重；
    * E0+E2 多来源 → 候选 E2；
    * 跨任务隔离；
    * `maybeStartConvergence` 触发后 fact 的 witness/evidence 进入 `flag_sources`。
- **maybeStartConvergence**：P5-A 已实现“fact E1+ 门禁 + 从 store 读/补候选；只停本任务队友/只写本任务 note”；P5-B 用 B8 锁住 fact 来源进入 `flag_sources`，没有改门禁/停谁/写哪条 note。
- **没有改 `inferEvidence` 计算**（P3-B 原样）；没有改 `noteFlagCandidate` 签名（P5-A 已加可选 source）；没有改 `task.setStatus`。
- **A 组 44 条未改**；`verify:flags` 44 → **67/67**（B 组 +23）。

**关键取舍**

- 选择“保持 fact → Hub 扫描”而不是“bridge 直接回调 Hub”：后者需要改 `electron/main.ts` 接线，超出 P5-B 允许面；现有 fact 行已经带 witness/evidence，链路没有缺口。
- bridge 不直接写候选，避免与 Hub 扫描重复；`flag_sources` 按 source 去重，即使重复扫描也不会刷爆。
- B 组红测不是历史代码红（P5-A 已接 source），而是在临时镜像里把 `publishBoardSince` 的 source 参数去掉，验证 B 组确实能抓住“source 丢失”；结果 61/67，B1/B2/B6 红。

---

## 改了哪些文件

- `apps/desktop/src/cli/verify-flags.ts`
  - A 组 44 条原样保留；
  - 新增 B 组 23 条：真实 `BoardBridge.route(submit_fact)` + `Hub.publishBoardSince`，覆盖 E2/E1/E0、多 session、来源去重、证据最高、跨任务、收敛来源。
- `docs/done/P5-B.md`（本文件）、`docs/PROGRESS.md`。

**没有改**：

- `apps/desktop/src/main/mcp-host/bridge.ts`（hash 仍 `aec9307f…ba8ce45c`）
- `apps/desktop/src/main/hub/hub.ts`（hash 仍 `0d36edef…81a3088`）
- `mcp-host/server.ts`、`session/manager.ts`、`policy/**`、`acp/**`、`scope/**`、`briefing/**`、`skill/**`、`artifacts/**`、`evidence/**`、`approval/queue.ts`、`electron/main.ts`、`config/**`、`rules/**`
- `blackboard/board.ts`（P5-A 已定）
- `packages/shared-protocol/events.ts`（P5-A 已定；P5-B 不改契约）
- `renderer/**`、`verify-gate/hardening/r18/multitask/skills/artifacts/scope/migration`、`smoke.ts`、`mock/**`
- `verify:all` 链、`D:\agent\skill`、`ARCHITECTURE.md`、全局配置

---

## 怎么验证的

### 红测

`evidence/p5b-flags-red.txt`：临时镜像中把 `publishBoardSince` 的 source 参数去掉（模拟 P5-A 未透传 source）：

```text
================ 61/67 通过 ================
FAIL  B1 候选 evidence=E2  — actual="E0" expected="E2"
FAIL  B1 来源 witness 正确  — actual=null expected="witness-e2.txt"
FAIL  B1 来源 evidence=E2  — actual="E0" expected="E2"
FAIL  B2 候选 evidence=E1  — actual="E0" expected="E1"
FAIL  B2 来源 evidence=E1  — actual="E0" expected="E1"
FAIL  B6 多来源证据取最高 E2  — actual="E0" expected="E2"
```

B8 仍绿：说明 `maybeStartConvergence` 的 fact 来源补全独立于 fact 扫描 source。

### 绿测

```text
npm run verify:flags     → 67/67（A44 + B23）
npm run verify:all       → 628 PASS / 0 FAIL（确定性 391 + smoke 237）
npm run verify:gate      → 52/52
npm run verify:scope     → 308/308
npm run verify:migration → 127/127
npm run verify:artifacts → 324/324（改前 baseline 也 324/324）
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（D 组 10/10）
Electron --verify        → 26/26
```

P5-B 没有生产代码变更，`verify:all` 仍 628，`verify:artifacts` D/E 仍 324/324（E0/E1/E2 判级未受影响）。

### 证据

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p5b-artifacts-baseline.txt` | 324/324（改前） | `275c120c08f0d89d…169aea3` |
| `evidence/p5b-flags-red.txt` | 61/67（故意去掉 source 的红） | `1f3d292809bce732…4ab9a608` |
| `evidence/p5b-verify-all.txt` | 628/0 | `b25e19ad310f1d49…082d680e` |
| `evidence/p5b-gate.txt` | 52/52 | `33145b3fff0baff1…3ca321a5` |
| `evidence/p5b-scope.txt` | 308/308 | `8a3c1a5b1a35d721…78f0d26215` |
| `evidence/p5b-migration.txt` | 127/127 | `c8a8823ffbde6079…d7556df9f` |
| `evidence/p5b-artifacts.txt` | 324/324（改后） | `cb9da084288b891b…29b1192` |
| `evidence/p5b-flags.txt` | 67/67 | `0a72fb2f0ac03c4b…acd322dc5` |
| `evidence/p5b-multitask.txt` | 174/174 | `b6c10945d7e9bcc8…8203f00c` |
| `evidence/p5b-skills.txt` | 149/149 | `8b9b7483375cf168…83fe6d13` |
| `evidence/p5b-electron-verify.txt` | 26/26 | `4b1cc7b7dbfa3427…f81161078` |

### 最终 code hash

| 文件 | sha256 |
|---|---|
| `verify-flags.ts` | `c3761e7a5e99ee83…42983804` |
| `bridge.ts` | `aec9307f171a3ed8…ba8ce45c`（未改） |
| `hub.ts` | `0d36edefd9bcbf79…81a3088`（未改） |
| `board.ts` | `9d062fc88a7bb40b…907ab252`（P5-A 已定） |
| `events.ts` | `ee22f9ae9c2f2f39…62ca1c9`（P5-A 已定） |
| `verify-artifacts.ts` | `4c4bf4bc32b6287e…107b68`（未改） |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b…ab5cf469`；board `user_version=3`；config 默认未变。

---

## 行为变更

1. **P5-B 没有改 bridge.ts/hub.ts 代码**：`submit_fact` 仍只写 fact；source 由 `BoardBridge → board.submitFact → onBoardWrite → Hub.publishBoardSince` 从 fact 的 witness/evidence 传给 `noteFlagCandidate`。这是 P5-A 已实现的链路，P5-B 只锁定。
2. **verify-flags B 组 +23**：真实 `BoardBridge.route(submit_fact)` + Hub 扫描，覆盖 E2/E1/E0、多 session、来源去重、证据最高、跨任务、收敛来源。A 组 44 条未改；总数 44 → 67。
3. **maybeStartConvergence 来源**：P5-A 的 fact E1+ 门禁不变；B8 证明 fact 的 witness/evidence 会进 `flag_sources`，不改停谁/写哪条 note。
4. **inferEvidence 计算未改**（P3-B 原样）；`noteFlagCandidate` 签名未改（P5-A 已加可选 source）；`task.setStatus` 未改。
5. **契约/SQLite 未改**：events.ts、board.ts、user_version 3 保持 P5-A 状态。
6. **与 P5-A 行为变更并列**：P5-A 是“持久化 + source 参数 + store 化”；P5-B 是“锁 submit_fact/fact 扫描/收敛来源的测试”，没有新增生产行为。

---

## 已知中间状态

- 确认/误报/导出/提交仍未做（P5-C/D）。
- flag 面板 UI 未接（P5-C）。
- 记分板未做（P5-D）。
- `submit_fact` 来源已接 store，但 `task.setStatus` 改回非 solved 仍会 DELETE 全部候选/来源（P5-A 语义）；P5-C 若需要历史审计要重新评估。
- 候选 status 仍固定 `new`，提交字段 null。
- bridge.ts 其他工具路径未改（黑板 7 工具、skill_* 三工具、attachment 路径）。
- 没有 backfill（WP6 评估）。
- board `user_version=3`，P5-C/D 不再动版本号。
- 事件量：策略/代理/flag 候选/来源 lifecycle events，哈希链尾部变化。
- 后台任务的 submit_fact fact 只在 Hub 扫描到该任务时（焦点/flush）进入候选；没有 bridge 直接回调 Hub。若 P5-C/D 需要后台即时可见，先评估是否加 BridgeOptions 回调（需 main 接线）。
- multitask F 组 flaky、render-verify 6 项失败、两个 UI 撒谎点仍挂账（WP6）。
- `verify:flags` 仍独立于 `verify:all`。

---

## 下一手需要什么

- **P5-C**：flag 面板 UI、确认/误报/复制/导出；确认只人工点；不自动 solved；契约若需新 HubAction/HubEvent 先写 `docs/requests/` 并停下问。
- **P5-D**：记分板/points/submit_mode/command 提交；默认 manual；command 必须人工确认 + dry-run；token 不入库/日志。
- **WP6**：backfill、后台 fact 即时性、multitask F 排序 flaky、render-verify 6 项、代理 A/B UI 撒谎点。
- 门禁：`verify:all` 628、`verify:flags` 67、`verify:migration` 127、`verify:scope` 308、artifacts 324、skills 149、multitask 174、Electron 26；`verify:flags` 独立。
- 不要重开 P5-B 决策：source 走 fact→Hub 扫描，不改 bridge/main；如要改成 bridge 直接回调，先停下问。
