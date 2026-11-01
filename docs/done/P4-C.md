# P4-C · 策略判定 / 范围上下文 / 审批卡目标 / 误报降级

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP4；`docs/plans/COMPETITION-READINESS.md` §7.4/§7.5；`docs/done/P4-A.md`、`P4-B.md`、`WP3-artifacts.md`；`docs/decisions/D-scope-enforcement.md`
> 日期：2026-10-24
> 状态：**P4-C 批次 1 + 批次 2 完成**。没有做代理（P4-D）、没有做审批卡目标 UI（P4-D）、没有改 board schema、没有新增 HubAction。
> 说明：批次 1 当时按“两批次合计再写文档”的约定没有单独落盘；本文件的批次 1 内容按 `evidence/p4c-c-red.txt`、`p4c-c-green.txt` 与批次 1 收口哈希重建，批次 2 在其后追加。

---

## 批次 1 · 策略判定 + 目标上下文 + 审计（默认关闭）

### 做了什么

把 P4-B 的纯函数接进唯一的事前闸门，同时保证默认不改变旧行为：

- `policy/engine.ts` 的 `RuleMatch` 加可选 `out_of_scope` / `target_regex`；`PolicyRequest` 加可选 `taskId` / `scope`。
- `scope.enabled=false` 时完全忽略 target/inScope，逐字走旧规则（`action/command_regex/text_regex/tool_regex`、block 优先、会话级规则、档位兜底）。
- `scope.enabled=true` 且 `inScope=out/unknown` 时，规则包第七条 `no-out-of-scope` 生效；verdict 由 `scope.outOfScopeAction` 决定（默认 approve）。
- `acp/client.ts` 的 ACP 判定路径（permission/terminal/fs）在 `enabled=true` 时提取目标、算 `inScope`；`enabled=false` 时连提取都不做、不触碰 board。
- `config/loader.ts` + `config/app.json` 加 `scope: { enabled:false, outOfScopeAction:"approve", proxy:{enabled:false} }`；非法 `outOfScopeAction` 回落 approve。
- `rules/competition.json` 只加第七条 `no-out-of-scope`；六条旧规则原文未改。
- 每次策略判定写黑板 `events`（`kind=note`，同时进 audit 索引），含 `action/rule/verdict/reason/target/inScope/scopeEnabled`；`enabled=false` 也写，`target=null`。
- 最小接线（**越权，已追认**）：`session/manager.ts` 把当前任务 `targets/denyTargets` 传给 `AcpClient`；`electron/main.ts` 把 `scope` 配置传给 `PolicyEngine`/`SessionManager`，并注入 `onDecision` 审计回调。
- `verify-scope` 扩 C 组 63 条；A 组 80 + B 组 96 原样保留。

### 改了哪些文件 / 越权记录

- `apps/desktop/src/main/policy/engine.ts`
- `apps/desktop/src/main/policy/policy.ts`
- `apps/desktop/src/main/acp/client.ts`
- `apps/desktop/src/main/config/loader.ts`
- `config/app.json`
- `rules/competition.json`
- `apps/desktop/src/cli/verify-scope.ts`
- **越权（批次 1 原清单外，用户已追认）**：
  - `apps/desktop/src/main/session/manager.ts`
  - `apps/desktop/src/main/electron/main.ts`

没有改 `board.ts`、`hub.ts`、`packages/shared-protocol/events.ts`、`renderer/**`、`scope/**`、`verify-gate.ts`、`verify:all` 链。

### 怎么验证的

```text
npm run verify:all       → 607 PASS / 0 FAIL（确定性 391 + smoke 216）
npm run verify:gate      → 52/52
npm run verify:scope     → 239/239（A80 + B96 + C63）
npm run verify:migration → 73/73
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（单跑；F 组 flaky 复跑后绿）
Electron --verify        → 26/26
```

红/绿：

```text
evidence/p4c-c-red.txt   → 194/217，exit=1
  A/B 176 条全绿；C0/C3/C6 旧行为绿；C1/C2/C4/C5/C7/C8/C9/C10 新能力红
evidence/p4c-c-green.txt → 239/239，exit=0
```

关键证据：

- `C0` 用子进程直接跑 `verify-gate.ts`，`52/52`；`verify-gate.ts` 一个字节未改（sha256 `d9f5eef2b3dc028e…82b704366`）。
- `C3`：`enabled=false` 时范围外 `curl` 仍按旧 `external-network-needs-human` 判 approve，不 block。
- `C10`：每次判定写一条 events；`enabled=false` 时 `target=null`、`inScope=null`、verdict/rule 走旧逻辑。

### 批次 1 行为变更（逐条）

1. **策略引擎加范围匹配能力**：`RuleMatch.out_of_scope` / `target_regex`；默认 `scope.enabled=false`，所以运行时判定不变。
2. **ACP 目标提取**：只在 `scope.enabled=true` 时提取；关闭时丢弃，不传策略，不读 board。
3. **规则包加第七条**：`no-out-of-scope`；六条旧规则不动。
4. **config 加 scope 段**：默认 `enabled=false`、`outOfScopeAction=approve`、`proxy.enabled=false`；不写死 block。
5. **审计新增**：每次判定一条 `kind=note` 事件，含 target/rule/verdict；`enabled=false` 也写。
6. **最小接线**：manager 透传 targets/denyTargets；main 注入 scope 配置与审计回调。
7. **测试面**：`verify-scope` 176 → 239（C 组 +63）；A/B 176 未改；`verify-gate` 52 未改。

一句话：**`scope.enabled=false` 时策略判定/放行/阻断结果与 P4-B 之前完全一致；唯一新增副作用是每次判定一条审计 events（target=null）。**

### 批次 1 已知中间状态

- 审批卡还没有 `scopeTarget/ruleId`（批次 2）。
- 本地代理未实现；`proxy.enabled` 只是占位。
- `outOfScopeAction` 默认 approve，不是计划 §7.4 示例的 block；理由：P4-B 提取未在真实 agent 验证，默认 block 会让误报直接卡死正常命令。
- CIDR 候选仍 `unknown`；裸 IPv6 不进 candidates；IPv6 URL 进 unknowns。
- `evidence/replay` 不做 scope 提取（只被审计，target=null）。
- 审计每个判定一条 note，事件量会增长；哈希链尾部会变化。

---

## 批次 2 · 审批卡后端字段 + 误报降级 + 决策文档

### 做了什么

- `ApprovalView` 加两个**可选**字段：
  - `ruleId?: string | null`
  - `scopeTarget?: { kind: string; value: string } | null`
  - 不改现有字段、不加必填、不新增 HubAction。
- `approval/queue.ts` 的 `ApprovalRequest` 加可选 `ruleId` / `scopeTarget`；构造 `ApprovalView` 时填入，`ruleId` 缺省回落到 `rule`。
- `approval/queue.ts` 导出 `scopeTargetForApproval()`：只对 `no-out-of-scope` 命中返回结构化目标，旧规则返回 null；复用 `AcpClient.deriveScopeContext`，保证多目标最严格判定一致。
- `electron/main.ts` 的 `onApprovalRequired`：
  - `ruleId = decision.rule`；
  - 仅当 `decision.rule === "no-out-of-scope"` 且 `scope.enabled=true` 时，用**同一 request detail + 当前任务 targets**调用 `scopeTargetForApproval`；
  - 不重跑 `policy.evaluate`、不缓存全局状态、不改 verdict；旧规则 `scopeTarget=null`。
- `hub.ts` 的 `publishApproval` 对旧视图兜底填充 `ruleId = view.ruleId ?? view.rule ?? null`、`scopeTarget = view.scopeTarget ?? null`；队列视图本身已带字段，所以 `approval.upsert`、`snapshot().approvals`、`approvalsAll` 一致。
- 误报降级测试：真实写临时 `config/app.json` → `loadAppConfig` 重读 → 新 `PolicyEngine`；`block → approve → block` 三次切换，`unknown` 同样按配置走。
- 新建 `docs/decisions/D-scope-enforcement.md`，覆盖强制边界、默认值、代理占位、误报降级、审计副作用、最小接线。
- `verify-scope` 扩 D 组 32 条；A/B/C 239 条未改。

### 改了哪些文件 / 授权记录

- `packages/shared-protocol/events.ts`
- `apps/desktop/src/main/approval/queue.ts`
- `apps/desktop/src/main/hub/hub.ts`
- `apps/desktop/src/main/electron/main.ts`
- `apps/desktop/src/cli/verify-scope.ts`
- `docs/decisions/D-scope-enforcement.md`（新建）
- `docs/done/P4-C.md`（本文件）
- `docs/PROGRESS.md`

**越权记录（批次 2 原清单外，用户已通过 AskUserQuestion 授权）**：

- `apps/desktop/src/main/electron/main.ts`：仅补审批路径的 `ruleId/scopeTarget` 与 `scopeTargetForApproval` 调用；不改策略/焦点/归档/配额/收敛/flag。
- `apps/desktop/src/main/approval/queue.ts`：仅加两个可选字段与 `scopeTargetForApproval`；不改审批裁决/超时/批量/退避语义。

**没有改**：`session/manager.ts`、`policy/engine.ts`、`policy/policy.ts`、`acp/client.ts`、`config/loader.ts`、`config/app.json`、`rules/competition.json`、`scope/**`、`board.ts`、`renderer/**`、`evidence/**`、`verify-gate.ts`、`verify-hardening.ts`、`verify-r18.ts`、`verify-multitask.ts`、`verify-skills.ts`、`verify-artifacts.ts`、`verify-migration.ts`、`smoke.ts`、`mock/**`、`verify:all` 链。

### 怎么验证的

红/绿：

```text
evidence/p4c-d-red.txt   → 255/265，exit=1
  A/B/C 239 条全绿；D1/D2/D3 字段与 helper 红；D4 误报降级（批次 1 已有能力）绿
evidence/p4c-d-green.txt → 271/271，exit=0
  A80 + B96 + C63 + D32
```

D 组覆盖：

- D1：`ApprovalQueue` 视图带 `scopeTarget.value/kind`、`ruleId`；旧规则 `scopeTarget=null`、`ruleId=旧规则 id`；`ruleId` 缺省回落到 `rule`。
- D2：`Hub.publishApproval` 给旧视图补 `ruleId`/`scopeTarget=null`；带字段的视图原样保留。
- D3：`scopeTargetForApproval` 范围外目标、旧规则 null、unknown kind、denyTargets 命中。
- D4：真实 config 文件 `block → approve → block` 重读；`unknown` 跟随配置；`enabled=false` 时旧规则 approve 且审批 `scopeTarget=null`。
- 没有测代理（P4-D）。

最终全量：

```text
npm run verify:all       → 607 PASS / 0 FAIL
npm run verify:gate      → 52/52
npm run verify:scope     → 271/271（A80 + B96 + C63 + D32）
npm run verify:migration → 73/73
npm run verify:artifacts → 324/324
npm run verify:skills    → 149/149
npm run verify:multitask → 174/174（首跑 173/174 命中已知 F 组 flaky，复跑绿）
Electron --verify        → 26/26
```

证据：

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p4c-c-red.txt` | 194/217（批次 1 红） | `684dc71eb9e99255…d33e84c6` |
| `evidence/p4c-c-green.txt` | 239/239（批次 1 绿） | `2c904636576c0067…bc69545e` |
| `evidence/p4c-d-red.txt` | 255/265（批次 2 红） | `74da0a8f5cd46799…4a021957` |
| `evidence/p4c-d-green.txt` | 271/271（批次 2 绿） | `4dc4acfb29357552…bf27f26` |
| `evidence/p4c-final-verify-all.txt` | 607/0 | `e32ea8d0f48e9237…852d045` |
| `evidence/p4c-final-scope.txt` | 271/271 | `db9da749be46e310…9d09a3fc` |
| `evidence/p4c-final-gate.txt` | 52/52 | `33145b3fff0baff1…3ca321a5` |
| `evidence/p4c-final-migration.txt` | 73/73 | `7e5208045570debf…51d9d2b` |
| `evidence/p4c-final-artifacts.txt` | 324/324 | `572036d1e4e3bf62…13a7eca` |
| `evidence/p4c-final-skills.txt` | 149/149 | `fc33c6ab6ab1acd2…0da0bbce` |
| `evidence/p4c-final-multitask.txt` | 174/174 | `be1fa460b0870ed1…cdab7d4c` |
| `evidence/p4c-final-electron-verify.txt` | 26/26 | `6f1a9bdb02db5e4a…6c6bce` |

### 批次 2 行为变更（逐条）

1. **`ApprovalView` 只加两个可选字段**：`ruleId?`、`scopeTarget?`；旧快照/旧 mock/旧渲染层不读不炸，没有必填字段、没有 HubAction。
2. **审批卡后端字段填充**：`ruleId = decision.rule`；`scopeTarget` 只在 `no-out-of-scope` 命中时非空，旧规则 null；事件与快照一致。
3. **误报降级路径确定**：改 `config/app.json` 的 `outOfScopeAction='approve'` 后重启生效；不新增 `overrideOnce`；D4 用真实 config 文件重读验证。
4. **D-scope-enforcement.md 补齐**：强制/不可强制边界、默认 verdict、代理占位、误报降级、审计副作用、最小接线全部落盘。
5. **与批次 1 并列**：批次 1 是“判定能力 + 审计 + 默认关闭”；批次 2 是“审批卡可读字段 + 降级路径 + 决策文档”。批次 1 的判定语义未改。
6. **测试面**：`verify-scope` 239 → 271（D 组 +32）；A/B/C 239 未改；`verify-gate` 52 未改；全量 607 未变。

### 批次 2 已知中间状态

- 审批卡 `scopeTarget/ruleId` 字段已加，renderer 未显示（P4-D）。
- `scopeTarget/ruleId` 不写 `approvals` 表；重启后历史审批没有这两个字段（board schema 仍 v2）。
- 本地代理未实现；`proxy.enabled` 只是占位。
- `scope.enabled` 默认关；WP6 用真实题验证提取准确率后再评估开启。
- `outOfScopeAction` 默认 approve（不是计划 §7.4 的 block）；理由见 `D-scope-enforcement.md`。
- CIDR 候选仍 unknown；裸 IPv6 不进 candidates；IPv6 URL 进 unknowns。
- `evidence/replay` 不做 scope 提取（只被审计，target=null）。
- 审计每个判定一条 `kind=note` 事件；事件量增长、哈希链尾部变化。
- `scopeTarget` 由 main 在 `no-out-of-scope` 命中时用同一 detail + 当前任务 targets 重算；不重跑 policy.evaluate；若 targets 在判定与审批回调之间变化，审批卡目标可能与判定瞬间略有差异。
- multitask F 组 flaky、render-verify 6 项既有失败仍挂账（WP6）。
- `verify:scope` 仍独立于 `verify:all`，门禁需单独跑。

---

## 最终文件收口

| 文件 | sha256 |
|---|---|
| `policy/engine.ts` | `0f0ee39d15813a1be12580919ab1a778c16d8ee7d88e7726eeea4f6b382d8af3` |
| `policy/policy.ts` | `8b7aac9bd86abc12ce7ccca2a0f6b4e05212bc6127dac3aa29ff34b0be8dd093` |
| `acp/client.ts` | `9f61931a3ca1c26d5b0c365755cb545ff5df5ab38b5e11565c57abbe4ae3f0bd` |
| `session/manager.ts` | `1f8469b2b7ac8c88b7a47cdd2d737af13a8f2710360bf546b36710310bcbb125` |
| `electron/main.ts` | `ed306d3e16afe7a93e6482862efe5248c19f75a0242963b183990e79802e892b` |
| `config/loader.ts` | `125612099a79c451c540f326b0e0b75cbf47390db32f6c854729bd1574b7354a` |
| `approval/queue.ts` | `b2c90a645592ee07fe66b2a78297fc05b401104654e0f913816563e65376b5a6` |
| `hub/hub.ts` | `85948dcde2b947c02f0c1ebcaa8e35cb9da05c05c73e709a6111e07a1bae2570` |
| `packages/shared-protocol/events.ts` | `093db46964c000e5c76ababc259e3ba845d7925ab122d241d4bceffc0abaa20b` |
| `config/app.json` | `fa080baad642b429135c39b286dc2bc919afde2d3d2d5597a06519f9b4542177` |
| `rules/competition.json` | `dcb7b130793cef792cb5a28ca6cf0035b1bc6c8c4ba2df7cf2b6c15c5ef44213` |
| `verify-scope.ts` | `2990554a5a4ae1c8602828bde93814b5b8a6d6396104f020e0c6061f630de291` |

保护面未改：

- `verify-gate.ts` `d9f5eef2b3dc028e…82b704366`
- `blackboard/board.ts` `4d217201c032ab03…7838aabe`（`user_version` 仍 v2）
- `.probe/backup-wp1/board.db` `6d491f0b1c0b8899…ab5cf469`（348160 B）
- `config/app.json` 默认值未在批次 2 重写；`rules/competition.json` 六条旧规则 + 第七条未再改。

---

## 没做什么 / 已知问题

- **没有做代理**：`scope.proxy.enabled` 只是占位；没有 HTTP/CONNECT 代理、没有注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`、没有改系统代理/防火墙。
- **没有做审批卡目标 UI**：只加后端字段；renderer 仍显示旧的字符串 `target`，不显示 `scopeTarget/ruleId`（P4-D）。
- **没有把新字段落 `approvals` 表**：board schema 仍 v2；重启后历史审批没有 `scopeTarget/ruleId`。
- **没有 `overrideOnce` 或任何新 HubAction**：误报降级是改 config + 重启 + 必要时加目标。
- **没有强 OS 级隔离**：策略只在看得见的 ACP/权限/terminal/fs 动作上判定；agent 自执行、raw socket、DNS、直连可绕过。
- **没有给 `evidence/replay` 接 scope 提取**：只被审计（target=null）。
- **没有改 renderer/hub 的焦点/归档/配额/收敛/flag 逻辑**；没有改审批批量 `scope=all/global` 语义。
- **没有烧真实 token、没有删测试、没有自动提交 flag、没有改 `D:\agent\skill`、没有改全局配置、没有改 `docs/ARCHITECTURE.md`。**
- **未验证**：真实 agent 在 `scope.enabled=true` 下的误报率；真实审批卡 UI 的目标显示；代理；打包态端到端。这些留 P4-D/WP6/WP7。
- **已知 flaky**：multitask F 组同毫秒排序；render-verify 6 项 P1-E mock 遗留失败。均不在 `verify:all` 链，留 WP6。

---

## 下一手需要什么

- **P4-D**：本地代理（默认关、只注入 app 会话 env）、审批卡显示 `scopeTarget/ruleId`、目标面板、创建任务目标输入。
- **WP6**：真实题验证目标提取准确率/误报率；决定是否默认开启 scope、是否把默认 `outOfScopeAction` 推到 `block`；同时修 multitask F 排序 flaky 与 render-verify 6 项。
- **WP5**：若需要 flag 表，继续用 `user_version` v3；不要回退 P4-A/P4-B 的 v2。
- 保持门禁：`verify:all` 607、`verify:scope` 271（A80+B96+C63+D32）、migration 73、artifacts 324、skills 149、multitask 174（单跑）、Electron 26；`verify:scope` 仍独立。
