# WP4 · 目标、范围与网络边界（P0/P1）总收口

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP4；`docs/plans/COMPETITION-READINESS.md` §7（§7.2 文件清单 / §7.3 数据模型 / §7.4 策略与强制 / §7.5 测试 / §7.6 风险 / §12 阶段门禁）；`docs/done/P4-A.md`、`P4-B.md`、`P4-C.md`、`P4-D.md`；`docs/decisions/D-scope-enforcement.md`
> 日期：2026-10-24
> 状态：**WP4 完成（P4-A → P4-D）**。P4-E 只写文档 + 跑全量，没有改任何 `.ts` / `.css` / `.json` / `.cjs` 代码文件。
> 验收基线：**`verify:all` 628 PASS / 0 FAIL（确定性 391 + smoke 237）；`verify:gate` 52/52；`verify:scope` 308/308（A80+B96+C63+D32+E37）；`verify:migration` 73/73；`verify:artifacts` 324/324；`verify:skills` 149/149；`verify:multitask` 174/174（单跑）；Electron `--verify` 26/26。**
> 验收差距：计划 §7.5 第 4 条的“直连绕过”只有 UI 文案与边界说明，没有真实 nmap/raw socket 绕过实验；§7.4 的本地代理已实现但默认关，真实 agent 工具链覆盖率留 WP6；两个 UI 撒谎点（限制 A/B）仍未修。

---

## 做了什么

WP4 把「授权目标是显式任务数据、越界动作可判定留痕、能强制的尽量强制」从计划落成一条可用链路：

- **P4-A 数据模型**：SQLite `user_version` v1 → v2，新增 `targets` 表与 `tasks.deny_targets/scope_notes`；契约新增 `TargetView`、`TaskView.targets?/denyTargets?/scopeNotes?`、`HubAction.target.add/update/remove`；Hub 做目标 CRUD，焦点快照带完整目标，后台只落库。
- **P4-B 纯函数层**：`scope/parse.ts` / `match.ts` / `extract.ts`；严格 IPv4/CIDR、URL/host:port、deny 优先、IPv6 明确 unknown、文件路径/版本号误报过滤；`verify-scope` B 组 96 条。
- **P4-C 策略判定**：`policy/engine.ts` 加 `out_of_scope/target_regex`，默认 `scope.enabled=false` 走旧逻辑；ACP 路径提取目标；规则包加 `no-out-of-scope`；每次判定写黑板 note 审计；批次 2 给审批卡加 `scopeTarget?/ruleId?` 与误报降级；`verify-scope` C/D 组。
- **P4-D UI + 代理**：目标面板、审批卡目标显示、范围三态提示、`HubSnapshot.scope?`；本地 HTTP/CONNECT 代理（默认关、127.0.0.1 随机端口、每会话 token 绑定任务、代理内部 403、env 只注入会话、优雅降级、审计不写 body、process-registry 最小登记）；`verify-scope` E 组 37 条。

**关键取舍**

- 默认**不强制**：`scope.enabled=false`、`outOfScopeAction=approve`。P4-B 提取仍是启发式，未在真实 agent 环境验证误报率；默认 block 会让误报直接卡死正常命令。WP6 用真实题验证后再评估。
- 代理默认关：只对遵守 `HTTP_PROXY/HTTPS_PROXY` 的工具生效；不修改系统代理/防火墙；不承诺 OS 级隔离。
- 代理 URL 带每会话随机 token：父进程按 token 绑定 task，避免同一代理端口跨任务放行。
- 审批卡目标字段只加可选字段，不新增 HubAction；`ruleId` 与现有 `rule` 并行，旧渲染层不炸。
- 目标数徽标只给焦点任务：P4-A 快照只为焦点任务带完整 targets；为所有任务加 `targetCount` 属于契约膨胀，非焦点任务切焦点后自然显示。

---

## WP4 目标与验收对照

### 1. 计划 §7.5 测试计划 5 条

| # | 计划要求 | 覆盖位置 | 结果 | 说明 / 证据 |
|---|---|---|---|---|
| 1 | CIDR：10.0.0.0/8 内/外、边界 10.255.255.255、非法输入、IPv6 明确不支持 | `verify-scope` B1/B2/B3；P4-B 纯函数 | **PASS** | 边界/掩码/非法输入/IPv6 unknown；`evidence/p4b-scope.txt` |
| 2 | `curl http://10.1.2.3/x` 在授权段 → allow/approve；`curl http://8.8.8.8` → block（或配置 approve）；多目标取最严格 | `verify-scope` C3–C7；engine + deriveScopeContext | **PASS** | enabled=false 走旧规则；enabled=true out/unknown 按 `outOfScopeAction`；多目标 out > unknown > in；`evidence/p4c-c-green.txt` |
| 3 | denyTargets 优先于 targets；目标加入后放行；移除后恢复 block | P4-B matchTargets；P4-A target CRUD；verify-scope C/D | **PASS（数据/判定层）** | deny 优先、目标增删走 Hub；没有真实 agent 动态改目标 E2E；`evidence/p4b-scope.txt`、`p4c-c-green.txt`、`p4d-ui-verify-all.txt` |
| 4 | 代理 allow/deny 各一条真实 curl；日志有 host:port/verdict；直连绕过时 UI 文案正确 | `verify-scope` E2/E3；UI 文案 E3 | **PASS（带边界）** | 真实本地 HTTP 服务器 + curl：allow 200 / deny 403；CONNECT allow/deny；审计无 body；UI 明示 nmap/raw socket/DNS 可绕过；**没有真实 nmap/raw socket 绕过实验**；`evidence/p4d-proxy-scope.txt` |
| 5 | 审批卡显示目标/规则；审计可检索；每次判定有 event；旧任务无 targets 时不误 block | P4-C C10/D1–D4；P4-D 批次 1 smoke | **PASS** | 审批卡 `scopeTarget/ruleId` 后端字段 + UI 显示；每次判定 note；旧快照范围未知/不误 block；`evidence/p4c-c-green.txt`、`p4d-ui-smoke.txt` |

**小计：5 条完整覆盖；第 4 条的“直连绕过”只做文案/边界，不做真实绕过实验；第 3 条没有真实 agent 动态改目标 E2E。**

### 2. 计划 §7.4 策略与强制

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| 从命令/权限请求解析 IP、URL、host:port | **PASS** | `scope/extract.ts` + `acp/client.ts` `deriveScopeContext`；文件路径/版本号/五段数字过滤 |
| CIDR 匹配 IPv4 优先，IPv6 后置/明确不支持 | **PASS** | `cidrContains`/`matchTargets`；IPv6 一律 unknown + `ipv6-not-supported` |
| 命中 denyTargets 或不在 targets 内 → block（可配置 approve） | **PASS** | `no-out-of-scope` 规则；verdict 由 `scope.outOfScopeAction` 决定；默认 approve |
| 命中授权目标但高风险动作 → approve | **PASS** | 旧 rule（凭据/网络/破坏性）在 in-scope 时仍生效；C6 |
| 每条判定写 events，含目标、规则、verdict | **PASS** | `PolicyEngine.onDecision` → `board.note`；`enabled=false` 也写，target=null；C10 |
| 尽力强制边界：只看得到的权限请求/终端/fs | **PASS（文档/实现）** | `D-scope-enforcement.md` §1；不宣称 OS 级 |
| 本地 HTTP CONNECT 代理，只允许 targets host:port | **PASS（默认关）** | `scope/proxy.ts`；E2/E3 allow/deny；每会话 token 绑定任务 |
| 代理给 agent 注入 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY | **PASS（默认关）** | `session/manager.ts` 只注入会话 spawn env；E3 |
| 目标面板：列表/状态/备注/增删改 | **PASS** | `renderer/targets.ts`；smoke 237；旧快照未知 |
| 规则包加 `no-out-of-scope` | **PASS** | `rules/competition.json` 第七条；六条旧规则未改 |
| 审批卡显示目标与命中规则 | **PASS** | `ApprovalView.scopeTarget?/ruleId?` + renderer 显示；D1/D2/D3 |
| 审计可检索 | **PASS** | `proxy.request`/`policy.decision` events；C10/E3 |

### 3. 计划 §7.3 数据模型

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| `targets` 表 id/task_id/value/kind/status/notes/created_at，UNIQUE(task_id,value) | **PASS** | `board.ts` v2；`verify:migration` 73/73 |
| `tasks.deny_targets` 默认 `'[]'`、`scope_notes` NULL | **PASS** | P4-A；旧库迁移 |
| `PRAGMA user_version = 2` | **PASS** | board.ts 仍 v2；备份库仍 v0（测试夹具） |
| `TargetView` / `TaskView.targets?/denyTargets?/scopeNotes?` | **PASS** | `events.ts` 可选字段；旧快照兼容 |
| `HubAction.target.add/update/remove` | **PASS** | Hub/validate-action；跨任务隔离 |
| 快照只给焦点任务完整 targets | **PASS** | Hub `fillTaskView(..., withTargetScope)`；非焦点不搬 |
| 目标租约 `target:<value>` | **PASS（复用）** | 复用现有 leases，不新增表；P4-A 未新增目标租约动作 |

### 4. 计划 §7.6 风险

| 风险 | 缓解 | 状态 |
|---|---|---|
| 目标提取误报导致误拦 | 默认只明确 IP/CIDR/URL/host:port；解析失败 unknown；默认 approve；可加目标 | **PASS** |
| agent 不请求审批/自己执行 | 明确“尽力强制”；代理 + 审计；不宣称全拦截 | **PASS（文档）** |
| 代理被绕过（nmap/DNS/raw） | UI/文档明示；不承诺 OS 级 | **PASS（文案）**；真实绕过实验留 WP6 |
| CIDR 边界/端口错误 | 单元测试边界；IPv6 先拒绝 | **PASS** |
| 代理影响正常 agent | 默认关；失败/崩溃降级；日志 | **PASS（默认关）** |

---

## P4-A / P4-B / P4-C / P4-D 每步摘要与证据

| 步骤 | 一行摘要 | 关键数字 | Evidence |
|---|---|---|---|
| **P4-A** | targets 数据模型 + 契约 + 快照 + validate-action；SQLite v1→v2 | `verify:all` 607；migration 44→**73/73**；scope 80/80；artifacts 324；skills 149；multitask 174；Electron 26 | `evidence/p4a-*` |
| **P4-B** | `scope/parse|match|extract` 纯函数层；CIDR/URL/host:port/误报过滤 | `verify-scope` 80→**176/176**（A80+B96）；verify:all 607 | `evidence/p4b-*` |
| **P4-C** | 批次 1 策略判定/目标上下文/审计；批次 2 审批卡 `scopeTarget?/ruleId?` + 误报降级 + D-scope-enforcement | scope 176→**239/239**（C63）→**271/271**（D32）；verify:all 607；gate 52 | `evidence/p4c-c-*`、`p4c-d-*`、`p4c-final-*` |
| **P4-D** | 批次 1 目标面板/审批卡目标/范围三态/`HubSnapshot.scope?`；批次 2 本地代理 + env + process-registry + E 组 | smoke 216→**237**；scope 271→**308/308**（E37）；verify:all **628/0**；gate 52；migration 73；artifacts 324；skills 149；multitask 174；Electron 26 | `evidence/p4d-ui-*`、`p4d-proxy-*` |

---

## 行为变更汇总

> 每条写“改了哪条 / 为什么 / 影响 / 旧测试怎么处理”。

### P4-A · targets 数据模型 + 契约 + 快照

- **改了哪条**：SQLite v1→v2；新增 `targets` 表、`tasks.deny_targets/scope_notes`；`TargetView`/`TaskView.targets?/denyTargets?/scopeNotes?`；`target.add/update/remove`；焦点快照带 targets。
- **为什么**：授权范围必须是显式任务数据，后续策略/代理/UI 才有数据源。
- **影响**：旧库自动迁移；旧快照不读新字段仍工作；非焦点任务只落库/切焦点后呈现。
- **旧测试**：verify-migration 44 条保留，user_version 期望 1→2；其余 323 条不变；新增 scope A 组 80。

### P4-B · 目标解析/匹配/提取纯函数

- **改了哪条**：新增 `scope/parse.ts`、`match.ts`、`extract.ts`；verify-scope B 组 96。
- **为什么**：把 CIDR/URL/host:port/误报过滤变成可测试纯函数，避免策略层直接做半成品解析。
- **影响**：生产无调用方（P4-C 才接）；纯函数不读 DB/config、不调网络。
- **旧测试**：A 组 80 原样；verify:all 607 不变；总 scope 176。

### P4-C 批次 1 · 策略判定 + 目标上下文 + 审计（默认关闭）

- **改了哪条**：`RuleMatch.out_of_scope/target_regex`；`PolicyRequest.scope`；ACP 提取目标；`rules` 第七条 `no-out-of-scope`；config `scope.enabled=false/outOfScopeAction=approve/proxy.enabled=false`；每次判定写 `kind=note` 审计。
- **为什么**：把范围数据接进唯一闸口，同时默认不改变旧行为。
- **影响**：`enabled=false` 判定/放行/阻断与 P4-B 之前一致；唯一新副作用是每次判定一条 note（target=null）；enabled=true 时 out/unknown 按 action。
- **旧测试**：verify-gate 52 未改；A/B 176 未改；新增 C 63；总 scope 239；verify:all 607。

### P4-C 批次 2 · 审批卡字段 + 误报降级

- **改了哪条**：`ApprovalView.scopeTarget?/ruleId?`；queue 填充；Hub `publishApproval` 兜底；main 在 `no-out-of-scope` 命中时用同一 detail+targets 重算；D 组真实 config 读盘；`D-scope-enforcement.md`。
- **为什么**：审批卡要能回答“命中什么范围目标/规则”；误报要能降级。
- **影响**：旧审批无字段不炸；旧规则 scopeTarget=null；误报降级=改 config+重启，没有 overrideOnce。
- **旧测试**：A/B/C 239 未改；新增 D 32；总 scope 271；verify:all 607；gate 52。

### P4-D 批次 1 · 范围 UI + 目标面板 + 快照 scope

- **改了哪条**：`HubSnapshot.scope?`（含 `proxy?{enabled,port}`）；renderer 范围三态、焦点任务目标徽标/目标面板、审批卡 scopeTarget/ruleId 显示；mock 世界；smoke +21。
- **为什么**：范围状态/目标/审批规则必须在 UI 可见，否则“判定/审计”不可操作。
- **影响**：旧快照无 scope 显示“范围状态未知”；非焦点任务不显示目标数（不撒谎为 0）；denyTargets/scopeNotes 只读。
- **旧测试**：smoke 216 零删除、零改语义；verify:all 607→628；scope 271 不变；其他套件不变。

### P4-D 批次 2 · 本地代理

- **改了哪条**：新增 `scope/proxy.ts`、`reliability/process-registry.ts`；manager 注入会话代理 env；main 启停代理/透传真实端口；config 加 `proxy.port=0`；verify-scope E 组 37。
- **为什么**：把“能强制的部分”从 ACP 判定扩展到遵守代理的工具网络出口。
- **影响**：代理默认关；开启后 127.0.0.1 随机端口、每会话 token 绑定任务、非 targets 403、env 只进会话、失败/崩溃降级、审计不写 body；**不承诺 OS 级**。
- **旧测试**：A/B/C/D 271 未改；总 scope 308；verify:all 628；gate 52；migration/artifacts/skills/multitask/Electron 不变。

---

## 已知限制清单

> 每条写“为什么不修 / 留到哪一步”。

1. **`board.ts` 仍 `user_version` v2，targets 表已加但无代理表/flag 表**：代理不需要新表；flag 表属于 WP5。WP5 使用 v3，不抢/不回退版本。
2. **`scope.enabled` 默认关**：P4-B 提取误报率未在真实 agent 环境验证；WP6 用真实题评估后再决定是否默认开启。
3. **`outOfScopeAction` 默认 approve（不是计划 §7.4 的 block）**：P4-B extract 误报率未验证，默认 block 会让误报直接拦正常命令、卡死 agent；WP6 再评估 block。
4. **本地代理默认关**：只对遵守 `HTTP_PROXY/HTTPS_PROXY` 的工具生效；nmap/raw socket/DNS/直连可绕过；不修改系统代理/防火墙，不承诺 OS 级隔离。
5. **代理 URL 带 Basic token**：不支持 proxy userinfo/`Proxy-Authorization` 的工具会 407，属于未覆盖工具；真实 agent 工具链覆盖率留 WP6。
6. **限制 A（UI 撒谎点）**：代理启动失败时 `scope.proxy.enabled` 仍按 config 显示 true、`proxy.port=null`；UI 会显示“代理已启用”但没有端口。留 WP6 或后续修；本轮只记录。
7. **限制 B（UI 撒谎点）**：代理运行中崩溃后会话继续，但 Hub 快照仍显示启动时的端口；没有实时失效事件。留 WP6 或后续修。
8. **没有代理开关 UI**：只能改 `config/app.json` + 重启；P4-D 批次 2 明确不碰 renderer，避免扩大范围。
9. **`scopeTarget/ruleId` 不写 `approvals` 表**：board schema v2 冻结；重启后历史审批没有这两个字段，只影响历史回看。
10. **误报降级路径是改 config + 重启**：没有 `approval.overrideOnce` 或任何新 HubAction；避免契约/UI 扩大。
11. **CIDR 候选在 `matchTargets` 返回 unknown**；`inScope='unknown'` 时按 `outOfScopeAction` 兜底：CIDR 与 CIDR/域名 vs CIDR 的包含语义不在 P4-B 猜。
12. **裸 IPv6 不进 candidates；IPv6 URL 进 unknowns → unknown**：P4-B 明确 IPv6 不支持，宁可 unknown 不误判。
13. **`evidence/replay` 不做 scope 提取**：它直接调用 policy.evaluate，审计 target=null；P4-C 只接 ACP 权限/terminal/fs 路径；回放范围留 WP6。
14. **审计每次策略判定一条 note；代理每请求也写一条 note（task-bound）**：事件量会增长、哈希链尾部变化；WP5 的 flag 去重写 events 时要把事件量/链纳入考虑。
15. **`scopeTarget` 由 main 用同一 detail + 当前任务 targets 重算**：不重跑 policy.evaluate；targets 在判定与审批回调极短时间内变化时，审批卡目标可能与判定瞬间略有差异。
16. **multitask F 组 flaky（同毫秒排序无 tie-break）、render-verify 6 项既有失败（P1-E mock 遗留）**：均不在 verify:all 链；WP6 修。
17. **`verify:scope` 仍独立于 `verify:all`**：避免把 308 条范围/代理断言混进 628 全量链；门禁需单独跑。
18. **没有在真实 agent 会话里做“读取 HTTP_PROXY 并发起请求”的端到端断言**：E3 验证 `proxyEnvForSession` 返回值与主进程 env 不变，main 负责 provider 传给 manager；真实 agent 工具链覆盖留 WP6。

**其它边界（不单列为验收项）**：

- 代理 HTTP 请求体上限 1MB；CONNECT 是隧道，不做 body 上限。
- 无 taskId/未授权代理请求写 audit 索引而非 events（不能伪造 task subject）。
- `process-registry` 只做代理 PID+startedAt 登记与按句柄清理；不做 WP7 跨进程 stale 清理。
- 没有打包态代理/UI 端到端；留 WP7。
- 没有真实 nmap/raw socket 绕过实验；只有 UI/文档边界说明。

---

## 验收数字

| 项 | 数字 | 证据 |
|---|---|---|
| `npm run verify:all` | **628 PASS / 0 FAIL**（确定性 391 + smoke 237） | `evidence/wp4-final-verify-all.txt` |
| `npm run verify:gate` | **52/52** | `evidence/wp4-final-gate.txt` |
| `npm run verify:scope` | **308/308**（A80+B96+C63+D32+E37） | `evidence/wp4-final-scope.txt` |
| `npm run verify:migration` | **73/73** | `evidence/wp4-final-migration.txt` |
| `npm run verify:artifacts` | **324/324** | `evidence/wp4-final-artifacts.txt` |
| `npm run verify:skills` | **149/149** | `evidence/wp4-final-skills.txt` |
| `npm run verify:multitask` | **174/174**（单跑） | `evidence/wp4-final-multitask.txt` |
| Electron `--verify` | **26/26** | `evidence/wp4-final-electron-verify.txt` |

### smoke 121 → 162 → 187 → 216 → 237

- **P1-E：121 → 162（+41）**：多任务看板/配额/全局审批/后台计数/焦点 pane 上限。
- **P2-C：162 → 187（+25）**：技能库状态/未配置提示/category 验证/简报预览。
- **P3-C：187 → 216（+29）**：附件/工件/预览/最小 Lane A IPC。
- **P4-D 批次 1：216 → 237（+21）**：范围三态、目标面板/徽标、审批卡 scopeTarget/ruleId、mock 目标 CRUD、旧快照兼容。
- 旧 216 条断言 **missing=[]**（零删除、零改语义）；P4-D 批次 1 的红测是“新 smoke vs 旧 renderer 模块缺失”，不是断言级红。

---

## 没做什么 / 已知问题

- **没有 OS 级防火墙/网络隔离**：策略只判定看得见的 ACP/权限/terminal/fs；代理只对遵守 HTTP_PROXY 的工具生效；nmap/raw socket/DNS/直连可绕过。
- **没有代理开关 UI**：只能改 config + 重启；限制 A/B 未修。
- **没有真实 agent 的 HTTP_PROXY 端到端覆盖**：E 组是本地服务器 + curl + 纯 helper；真实 agent 工具链留 WP6。
- **没有真实 nmap/raw socket 绕过实验**：只有 UI/文档文案。
- **没有打包态代理/UI 验证**：留 WP7。
- **没有 WP5**：flag/答案/提交/记分闭环未开始；board 仍 v2。
- **没有重新打开 WP1/WP2/WP3**：多任务焦点、技能、附件/工件/证据链均按既有状态复用。
- **没有跑真实 agent、没有烧 token、没有自动提交 flag、没有改全局配置/技能库/ARCHITECTURE**。
- **未验证**：真实 agent 在 scope.enabled=true 下的误报率；真实代理工具链覆盖率；代理启动失败/崩溃时 UI 文案（限制 A/B）；打包态；干净机器。

---

## WP5 之前必须知道的事（交接）

1. **WP5 是 flag/答案/提交/记分闭环**：第一次把 flag 候选从内存 `Map<taskId, Map<flag>>`（P1-C 定的）改为 SQLite 表；`user_version` **v2 → v3**，不要回退/跳版本。
2. **WP5 会加 `flag_candidates` + `flag_sources` 两张表**：候选去重、来源、witness/evidence、状态（new/confirmed/false_positive）；迁移仍在 `open()` 内按版本顺序追加，旧库可打开。
3. **提交模式默认 `manual`**；`command` 模式必须人工确认 + dry-run；token 不入库/不入日志；审计脱敏。`command` 模式在 WP5 时单独问用户。
4. **WP5 会碰 `hub.ts` 的 flag 候选逻辑**：`noteFlagCandidate` / `maybeStartConvergence` 的输入从内存 Map 改为 store；这是 P1-C 之后第一次动 flag 候选结构，先锁现有 R24/收敛断言。
5. **WP5 会碰 `bridge.ts` 的 `submit_fact` 路径**（flag 候选来源之一）：E0/E1/E2 判级、witness、附件扫描/回放来源都要保留；不要把候选确认变成自动 solved。
6. **契约冻结**：WP5 若需新 `HubAction`/`HubEvent`/快照字段，先写 `docs/requests/` 并停下问用户；不要直接扩 `events.ts`。
7. **事件量**：策略审计（每次判定一条 note）和代理审计（每请求一条 note）会让事件量增长；WP5 的 flag 候选去重也要写 events，注意哈希链和事件量。
8. **两个 UI 撒谎点（限制 A/B）留 WP6 或后续修**；WP5 不要顺手修代理/范围 UI。
9. **multitask F 组 flaky + render-verify 6 项失败仍挂账**：WP6 修；WP5 不要把它们当回归。
10. **门禁**：`verify:all` 628、`verify:scope` 308、migration 73、artifacts 324、skills 149、multitask 174、Electron 26；`verify:scope` 独立跑。
11. **不要重开 WP4 决策**：默认 `scope.enabled=false`、`outOfScopeAction=approve`、代理默认关、不承诺 OS 级；WP6 用真实题验证后再评估。

---

## 证据

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/wp4-final-verify-all.txt` | `verify:all` 628 PASS / 0 FAIL | `ff45dda969b14240…784665e8` |
| `evidence/wp4-final-gate.txt` | `verify:gate` 52/52 | `33145b3fff0baff1…3ca321a5` |
| `evidence/wp4-final-scope.txt` | `verify:scope` 308/308 | `7568f39487235356…f86cd318d` |
| `evidence/wp4-final-migration.txt` | `verify:migration` 73/73 | `54e4f717893a5398…7cb382b5` |
| `evidence/wp4-final-artifacts.txt` | `verify:artifacts` 324/324 | `89b39fae28a46277…640c107a` |
| `evidence/wp4-final-skills.txt` | `verify:skills` 149/149 | `55c3b559dcc5c7eb…047f39f89` |
| `evidence/wp4-final-multitask.txt` | `verify:multitask` 174/174 | `29b418eda542fc3d…54c9d974d3` |
| `evidence/wp4-final-electron-verify.txt` | Electron 26/26 | `4ca24cd3eaca41a1…4a1f209cf8` |

分步证据：`evidence/p4a-*`、`p4b-*`、`p4c-*`、`p4d-*`。备份库 `.probe/backup-wp1/board.db` sha256 `6d491f0b…ab5cf469`，348160 B，未动。

**WP4 完成；不要进入 WP5。**
