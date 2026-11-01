# P4-D · 范围 UI + 本地代理

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP4；`docs/plans/COMPETITION-READINESS.md` §7.2/§7.4/§7.5/§7.6；`docs/done/P4-C.md`；`docs/decisions/D-scope-enforcement.md`
> 日期：2026-10-24
> 状态：**批次 1（UI + 最小 Lane A 扩展）与批次 2（本地代理）均完成。**
> 说明：代理默认关闭；开启后只对遵守 HTTP_PROXY 的工具生效，nmap/raw socket/DNS 可绕过。审批卡目标 UI 已显示，代理开关 UI 仍未做（默认值走 config + 重启）。

---

## 批次 1 · 范围 UI + 目标面板 + 审批卡目标 + 最小 Lane A 快照字段

### 做了什么

- **最小 Lane A 扩展（已获用户授权）**：
  - `HubSnapshot` 加可选 `scope?: { enabled; outOfScopeAction; proxy?: { enabled; port } }`；
  - `HubService` 构造参数加可选 `scope`，快照透传 `enabled/outOfScopeAction/proxy.enabled/proxy.port`；
  - `electron/main.ts` 把 `loadAppConfig()` 的 `scope` 传给 Hub；
  - 批次 1 `proxy.port` 恒为 `null`，批次 2 才填真实代理端口。
- **范围提示（renderer）**：
  - `scope.enabled=false` → “范围强制未启用，仅展示与审计”；
  - `scope.enabled=true` → “范围强制已启用（outOfScopeAction=…）”；
  - 旧快照没有 `scope` 字段 → “范围状态未知（旧快照未带 scope 字段）”，不误报为未启用。
- **目标面板（renderer/targets.ts）**：
  - 焦点任务卡加“目标 N”徽标；点击展开/收起目标面板；
  - 列表展示 `value/kind/status/notes`；展示 `denyTargets`（deny 优先）与 `scopeNotes`；
  - 增删改入口：`target.add` / `target.update` / `target.remove`；
  - renderer 只做非空检查，IP/CIDR/URL/kind/notes 校验仍走 `validate-action` + board；
  - 旧快照没有 targets 时显示“旧快照未带目标数据（未知，不是没有目标）”。
- **审批卡目标（renderer/approval/approval.ts）**：
  - 显示 `ApprovalView.scopeTarget`（kind + value）；
  - 显示 `ApprovalView.ruleId` 的可读规则名 + id；
  - 旧审批没有这些字段时原样退化，不炸。
- **mock 世界**：
  - `enabled=false + 有目标`、`enabled=true + 有目标`、`有数据但 0 目标`、旧快照无 scope/targets；
  - mock `target.add/update/remove` 真派发并回写快照；
  - mock 审批带 `scopeTarget/ruleId`。
- **smoke**：216 → **237**（+21），旧 216 条零删除、零改语义。

### 授权记录（Lane A 扩展）

- 时间/渠道：2026-10-24 P4-D 状态确认阶段，通过 `AskUserQuestion` 选择“加可选 `HubSnapshot.scope`”，随后明确授权只改：
  1. `packages/shared-protocol/events.ts`
  2. `apps/desktop/src/main/hub/hub.ts`
  3. `apps/desktop/src/main/electron/main.ts`
- 约束：events.ts 只加 `scope?` 一个字段；hub.ts 只改快照构造/构造参数；main.ts 只加 scope 透传。没有改焦点/归档/配额/收敛/flag/审批守卫/preload/启动恢复。
- 目标数徽标：用户选择“仅焦点任务显示”，不新增 `TaskView.targetCount`。理由：P4-A 设计只为焦点任务带 `targets`，为一个徽标给所有任务填 `targetCount` 属于契约膨胀；非焦点任务切焦点后自然获得数据；没有数据就什么都不显示，不撒谎。

### 改了哪些文件

Lane A（授权最小扩展）：

- `packages/shared-protocol/events.ts`
  - `HubSnapshot.scope?`：`enabled / outOfScopeAction / proxy? { enabled; port }`；无其他字段、无 HubAction。
- `apps/desktop/src/main/hub/hub.ts`
  - `HubDeps.scope?`、`private scopeConfig`、`snapshot().scope`；只读展示，不参与判定。
- `apps/desktop/src/main/electron/main.ts`
  - `new HubService({ ..., scope: APP_CONFIG.config.scope })` 一行 + 注释。

Renderer / mock：

- `apps/desktop/src/renderer/store.ts`
  - `ScopeStatusState`、`buildScopeStatusView()`；`AppState.scopeStatus`；`applySnapshot` 读 `HubSnapshot.scope?`；旧快照为 null。
- `apps/desktop/src/renderer/targets.ts`（新增）
  - `buildTargetBadge()`、`buildTargetPanelView()`、`renderTargetsPanel()`、`TARGET_PANEL_ACTIONS`。
- `apps/desktop/src/renderer/main.ts`
  - 左栏范围提示；焦点任务卡“目标 N”徽标；目标面板展开/收起；不碰 P1-E 后台事件丢弃逻辑。
- `apps/desktop/src/renderer/approval/approval.ts`
  - `approvalRuleLabel()`、`approvalScopeTargetText()`；审批卡显示 scopeTarget/ruleId。
- `apps/desktop/src/renderer/mock/data.ts`
  - `MockScopeMode`/`MockTargetMode`、`buildScopeMockSnapshot()`、scope 审批、目标数据。
- `apps/desktop/src/renderer/mock/engine.ts`
  - 快照带 scope；焦点任务带 targets，非焦点不带；`target.add/update/remove`；新任务默认空 targets。
- `apps/desktop/src/renderer/smoke.ts`
  - 只加 P4-D 断言 21 条；旧 216 条未删/未改语义。

文档：

- `docs/done/P4-D.md`（本文件）
- `docs/PROGRESS.md`（批次 1 追加）

**未改**：`session/manager.ts`、`policy/**`、`acp/client.ts`、`config/loader.ts`、`config/app.json`、`rules/**`、`scope/parse|match|extract.ts`、`board.ts`、`approval/queue.ts`、`renderer/task.ts`（不需要）、`renderer/styles.css`（复用现有 class）、`verify-gate/hardening/r18/multitask/skills/artifacts/migration/scope`、`mock/**` 除 data/engine、`D:\agent\skill`、`ARCHITECTURE.md`、全局配置。

### 怎么验证的

```text
node apps/desktop/src/renderer/smoke.ts → 237 PASS / 0 FAIL
npm run verify:all                       → 628 PASS / 0 FAIL（确定性 391 + smoke 237）
npm run verify:gate                      → 52/52
npm run verify:scope                     → 271/271（A80+B96+C63+D32，未受影响）
npm run verify:migration                 → 73/73
npm run verify:artifacts                 → 324/324
npm run verify:skills                    → 149/149
npm run verify:multitask                 → 174/174（首跑 173/174 命中已知 F 组 flaky，复跑绿）
Electron --verify                        → 26/26
```

新增 smoke 覆盖：

- 范围提示三态：enabled=false / enabled=true / 旧快照未知；
- 焦点任务目标徽标 3 个目标；旧快照 `目标 —`（不撒谎为 0）；
- 目标面板 value/kind/status/notes、denyTargets、scopeNotes；
- 增删改动作 add/update/remove 存在；
- 有数据但 0 目标的空态；
- 非焦点任务不带完整 targets（只给焦点）；
- 审批卡 scopeTarget（`范围目标：url 8.8.8.8`）与 ruleId 可读化；
- 旧审批无 scopeTarget 不炸；
- mock hub 快照带 scope/targets/denyTargets；
- mock `target.add/update/remove` 真回写；
- mock 重复目标被拒。

旧断言锁：

- 用脚本对比 `.probe/backup-p4d-b1/.../smoke.ts` 与当前 smoke：
  - 旧 `ok("...")` 字面量 **216** 个；
  - 当前 **237** 个；
  - 旧 216 个名称 **missing=[]**（零删除、零改语义）。
- `verify:all` 从 607 → 628，增量正好是 smoke 237 - 216 = 21。

红测：

```text
evidence/p4d-ui-smoke-red.txt
P4-D batch 1 smoke red baseline: new smoke.ts vs pre-P4-D renderer modules
SyntaxError: The requested module './approval/approval.ts' does not provide an export named 'approvalRuleLabel'
```

说明：这是“新 smoke vs 旧 renderer”的模块导出缺失红（与 P4-B 的 `ERR_MODULE_NOT_FOUND` 同类），**不是断言级红**。旧 216 条在批次 1 前的基线是全绿（P4-C final `verify:all` 607/0）。实现后绿测 237/237。

证据：

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p4d-ui-smoke-red.txt` | 旧模块缺导出（红） | `1265fcdb7af0d402…6e184311` |
| `evidence/p4d-ui-smoke.txt` | 237 PASS / 0 FAIL | `92c7a5e6a7d187c5…828d66e6` |
| `evidence/p4d-ui-verify-all.txt` | 628 PASS / 0 FAIL | `432ed3ceb560faf4…b16af912` |
| `evidence/p4d-ui-scope.txt` | 271/271 | `85934b4396c7ceb2…f24fec9fd6` |
| `evidence/p4d-ui-gate.txt` | 52/52 | `33145b3fff0baff1…3ca321a5` |
| `evidence/p4d-ui-migration.txt` | 73/73 | `460cc4740691f191…0c35061d` |
| `evidence/p4d-ui-artifacts.txt` | 324/324 | `0528f526b6419e05…7f36939dc9` |
| `evidence/p4d-ui-skills.txt` | 149/149 | `1764ddff18f63c6c…7c2cc514` |
| `evidence/p4d-ui-multitask.txt` | 174/174 | `41566a01dc61a1ba…515651bfe` |
| `evidence/p4d-ui-electron-verify.txt` | 26/26 | `ab54279151c22344…69cdf5ce` |
| `evidence/p4d-ui-targets-dom.txt` | 目标面板 DOM 构造（add/update/remove 按钮） | `0dca4746502e6b43…59697e71` |

真实 Hub 快照抽查（临时 Node 脚本，非生产代码）：

```json
{"enabled":false,"outOfScopeAction":"approve","proxy":{"enabled":false,"port":null}}
```

补充：用临时 fake `document` 构造 `renderTargetsPanel()`，确认真实 DOM 结构里有 `data-act="target-add"`、`target-update`、`target-remove` 按钮（见 `evidence/p4d-ui-targets-dom.txt`）。这不是完整浏览器 E2E，但能证明面板构造路径没有运行时错误、三个动作按钮都存在。

### 批次 1 行为变更（逐条）

1. **HubSnapshot 加可选 `scope?`**：旧快照/旧 mock 缺席时 UI 显示“范围状态未知”，不误报为未启用；没有 HubAction。
2. **renderer 范围提示**：enabled=false 明确写“仅展示与审计”；enabled=true 写 action；未知写“范围状态未知”。
3. **目标面板**：焦点任务卡显示目标数徽标；面板列出目标/denyTargets/scopeNotes；增删改走 P4-A 的 `target.add/update/remove`。
4. **审批卡目标**：显示 `scopeTarget`（kind+value）与 `ruleId` 可读名；旧审批无字段不炸。
5. **mock 世界**：新增 enabled=false/true + 有目标、0 目标、旧快照未知；mock target 动作真回写。
6. **smoke**：216 → 237（+21）；旧 216 零删除、零改语义。
7. **Lane A 最小扩展**：events.ts 只加 `scope?`；hub.ts 只改快照构造；main.ts 只加 scope 透传。已获用户授权并记录在本节。

### 批次 1 已知中间状态

- 批次 1 时代理未实现；`scope.proxy.enabled=false`、`port=null`。批次 2 已实现本地代理（见下节）。
- 没有代理开关 UI（批次 2 视需要再加；如需加先停下问）。
- 目标数徽标只给焦点任务；非焦点任务不显示、不显示假 0/`?`。这是 P4-A 快照语义的功能取舍，不是缺陷；P4-E/WP6 若证明非焦点目标数关键，再评估 `TaskView.targetCount?`。
- `denyTargets/scopeNotes` 只读展示：P4-A 没有写入动作，本批次不加。
- 目标增删改只做非空检查；kind/status/notes/越界校验在 `validate-action`/board；renderer 不解析 IP/CIDR/URL。
- 目标面板没有独立 CSS；复用现有 panel/agent/task-form class。
- 没有 renderer DOM E2E 断言：smoke 是纯视图模型；Electron `--verify` 只验证应用加载与既有 26 条，不自动点击目标面板。
- 旧快照没有 `scope` 时范围提示未知；真实主进程快照从本批次开始带 scope。
- 审计/策略/代理仍是 P4-C 状态；本批次没有改 `session/manager.ts`、`acp/client.ts`、engine、queue、board。

---

## 批次 2 · 本地代理（默认关闭）

### 做了什么

- **新增 `scope/proxy.ts`**：本地 HTTP + CONNECT 代理，子进程监听 `127.0.0.1`，默认随机端口。
  - HTTP 请求与 CONNECT 都在代理内部按 token → 任务 targets 判定；非 `in` 返回 403（HTTP 还带可读 body）。
  - 30s 超时、64 并发上限、HTTP 请求体 1MB；不记录请求 body。
  - 每个请求审计 `host:port/verdict/timestamp/reason`。
  - 会话代理 URL 带随机 token（`http://bumimang:<token>@127.0.0.1:<port>`），同一端口不会跨任务放行。
- **`session/manager.ts`**：
  - 新增 `proxyEnvForSession(scope,url)`：只返回 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY=""`；
  - `startSession` 只在 `scope.proxy.enabled=true` 且 provider 返回 URL 时把 env 合并进本次会话的 `sessionEnv`；
  - 不修改 `process.env`；不改 `restoreSessions({recover:false})`、配额、收敛。
- **`electron/main.ts`**：
  - app ready 后按 `config.scope.proxy.enabled` 启动代理；启动失败只写 stderr、`proxy=null`，会话照常启动；
  - 把真实 `server.address().port` 填进 Hub 快照 `scope.proxy.port`；`proxy.enabled` 从 config 读；
  - 会话终态时释放代理 token；退出时 `scopeProxy.close()` + `process-registry.terminateAll()`，再关 board。
- **`config/loader.ts` + `config/app.json`**：
  - `scope.proxy.port`（0=随机，默认 0）；非法值回落 0；
  - `scope.proxy.enabled` 仍默认 false；`scope.enabled`/`outOfScopeAction` 未改。
- **`reliability/process-registry.ts`**（新增）：
  - 记录代理子进程 PID + startedAt；`terminateAll` 按 **ChildProcess 句柄**清理，不按裸 PID kill；
  - 只做代理进程；不做 WP7 全量进程回收/跨进程 stale 清理。
- **`verify-scope` E 组**：真实本地 HTTP 服务器 + TCP echo + 真实 curl + 原生 CONNECT，覆盖 allow/deny、审计、env、启动失败/崩溃、端口释放、随机端口/监听地址、Hub 快照真实端口。
- **`D-scope-enforcement.md`**：追加代理能力边界与 8 条硬边界。

### 8 条硬边界对照

| # | 要求 | 实现 / 证据 |
|---|---|---|
| 1 | 监听 127.0.0.1，不是 0.0.0.0 | 子进程 `server.listen(port, "127.0.0.1")`；E2/E3 断言 address |
| 2 | 端口随机分配 | 默认 `port:0`；E2 两次启动端口不同 |
| 3 | app 关闭时清理代理进程 | 子进程 + `ProcessRegistry`；E2/E3 关闭后登记清空；proxy-enabled Electron 退出后无 electron 残留 |
| 4 | env 只注入会话进程 | `proxyEnvForSession` 只进 `sessionEnv`；E3 断言主进程 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 未变 |
| 5 | 起不来时优雅降级 | 启动失败/崩溃不抛出到会话；provider 返回 null → 不注入 env；E4 覆盖 |
| 6 | 拒绝规则在代理进程内部强制 | HTTP/CONNECT 都按 token→task targets 判定；非 in → 403 |
| 7 | 每个请求审计，不写 body | 父进程写 `proxy.request {host,port,verdict,timestamp}` events；E3 断言无 body |
| 8 | 不改系统代理/防火墙/全局配置 | 只注入 app 会话 env；文档/UI 明示 nmap/raw socket/DNS/直连可绕过 |

### 改了哪些文件 / 哈希

| 文件 | sha256 |
|---|---|
| `apps/desktop/src/main/scope/proxy.ts`（新增） | `2fb92ecccf911ed0…c5e3ffff` |
| `apps/desktop/src/main/reliability/process-registry.ts`（新增） | `0d12a7da752cda52…8dad2568` |
| `apps/desktop/src/main/session/manager.ts` | `fb0fda7caf8e4ab7…eac1e377` |
| `apps/desktop/src/main/electron/main.ts` | `a5ceec792247c043…1a7843c6` |
| `apps/desktop/src/main/config/loader.ts` | `fe318019c2f32be6…d4d31209` |
| `config/app.json` | `4a07840247407120…466bcee4` |
| `apps/desktop/src/cli/verify-scope.ts` | `4267e39aff8707b8…606c77e7` |

**未改**：`packages/shared-protocol/events.ts`（批次 1 已定；批次 2 没有扩契约）、`policy/**`、`acp/client.ts`、`hub/hub.ts`、`approval/queue.ts`、`board.ts`、`rules/**`、`renderer/**`、`verify-gate/hardening/r18/multitask/skills/artifacts/migration`、`smoke`、`mock/**`、`verify:all` 链、全局配置、技能库、ARCHITECTURE。

保护面哈希仍为：`engine 0f0ee39d…`、`acp 9f61931a…`、`board 4d217201…`、`queue b2c90a64…`、`rules dcb7b130…`、`.probe/backup-wp1/board.db 6d491f0b…ab5cf469`；board `user_version=2`。

### 怎么验证的

```text
npm run verify:scope                 → 308/308（A80+B96+C63+D32+E37）
npm run verify:all                   → 628 PASS / 0 FAIL（确定性 391 + smoke 237）
npm run verify:gate                  → 52/52
npm run verify:migration             → 73/73
npm run verify:artifacts             → 324/324
npm run verify:skills                → 149/149
npm run verify:multitask             → 174/174（F 组 flaky 复跑）
Electron --verify                    → 26/26
```

E 组覆盖：

- E1：`config.scope.proxy.port` 默认 0、非法值回落 0、`proxy.enabled` 从 config 读。
- E2：监听 127.0.0.1；两次启动端口不同；process-registry 登记 pid + startedAt；关闭后清空。
- E3：真实本地 HTTP 服务器 + 真实 curl：targets 内 200/allow-ok；targets 外 HTTP 403 且不转发；原生 CONNECT allow 200 / deny 403；审计含 host/port/verdict/timestamp、无 body；每个请求写 events；env 只进会话（主进程 env 不变）；UI 文案写明可绕过；关闭后端口释放；Hub 快照 `proxy.port` 为真实监听端口。
- E4：端口占用时启动失败可降级；代理进程崩溃后 `isRunning=false`、`urlForSession` 不再签发、env 不注入、会话继续。

红测：

```text
evidence/p4d-proxy-scope-red.txt
P4-D batch 2 proxy red baseline: new verify-scope E group vs pre-P4-D-batch2 main code
Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../main/scope/proxy.ts
```

说明：这是“新 E 组 vs 旧 main”的模块缺失红（与 P4-B/P4-D 批次 1 的模块缺失红同类），**不是断言级红**；实现后 E 组 37 条全绿。

Proxy-enabled Electron 额外探针（临时把 config 的 `proxy.enabled` 置 true，跑完已恢复 false）：

```text
[main] 本地范围代理已启动：127.0.0.1:<随机端口>（只对遵守 HTTP_PROXY 的工具生效）
[verify] 26/26 通过
退出后 tasklist 无 electron.exe 残留
```

证据：

| 文件 | 结果 | sha256 |
|---|---|---|
| `evidence/p4d-proxy-scope-red.txt` | 旧代码模块缺失（红） | `5b5b697311c64245…5b9b0dd831` |
| `evidence/p4d-proxy-scope.txt` | 308/308 | `5a1f499d787ea2b5…56d1a5c6` |
| `evidence/p4d-proxy-verify-all.txt` | 628/0 | `d48218f2d9a03d12…3a94ada6` |
| `evidence/p4d-proxy-gate.txt` | 52/52 | `33145b3fff0baff1…3ca321a5` |
| `evidence/p4d-proxy-migration.txt` | 73/73 | `91354c4dec683957…02adadc4` |
| `evidence/p4d-proxy-artifacts.txt` | 324/324 | `8acbae56484c9968…9605120f` |
| `evidence/p4d-proxy-skills.txt` | 149/149 | `7f595165f5c482c2…e579df75` |
| `evidence/p4d-proxy-multitask.txt` | 174/174 | `e76a4be8fe9dc11c…3475cee8` |
| `evidence/p4d-proxy-electron-verify.txt` | 26/26（proxy 默认关） | `27f7e3fe65cfad96…b36c1461` |
| `evidence/p4d-proxy-electron-enabled.txt` | 26/26 + 代理真实启动 | `820b6eecf389c15d…c502d168` |

### 批次 2 行为变更（逐条）

1. **新增本地代理**：默认关；`scope.proxy.enabled=true` 时 app ready 启动，127.0.0.1 + 随机端口（`scope.proxy.port=0`）。
2. **每会话 token 绑定任务**：代理 URL 带随机 token；父进程按 token 找任务 targets，避免同一端口跨任务放行。
3. **代理内部强制**：HTTP/CONNECT 非 targets（out/unknown/deny）返回 403；不依赖客户端自觉。
4. **env 只进会话进程**：`manager.startSession` 把 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY=""` 合并进该会话 spawn env；主进程 `process.env` 不变。
5. **优雅降级**：代理未启用/启动失败/崩溃时 `urlForSession` 返回 null → 不注入 env；会话照常启动，网络代理不可用只影响网络出口。
6. **审计**：每个请求写 `proxy.request {host,port,verdict,timestamp}` 到黑板 events（task-bound）；无 taskId/未授权请求写 audit 索引；不写 body。
7. **生命周期/进程登记**：子进程 + `ProcessRegistry`（PID + startedAt，按句柄清理）；app 退出先关代理再关 board。
8. **config/loader**：`scope.proxy.port` 默认 0；非法值回落 0；`scope.enabled`/`outOfScopeAction` 未改。
9. **测试面**：`verify-scope` 271 → 308（E 组 +37）；A/B/C/D 271 未改；`verify:all` 628 未变；`verify:gate` 52 未变。
10. **文档/UI**：D-scope-enforcement 增加代理能力边界；UI 继续明示“仅对遵守代理的工具生效；nmap/raw socket/DNS 可绕过”。

### 批次 2 已知中间状态

- 代理默认关；开启后只对遵守 `HTTP_PROXY/HTTPS_PROXY` 的工具生效；nmap/raw socket/DNS/直连可绕过。
- 代理 URL 带 Basic token；不支持 proxy userinfo/`Proxy-Authorization` 的工具会收到 407，属于未覆盖工具。
- 不修改系统代理/防火墙/全局配置；不承诺 OS 级隔离。
- 没有代理开关 UI：只能改 `config/app.json` + 重启。
- **限制 A（UI 撒谎点）**：代理启动失败时 `scope.proxy.enabled` 仍按 config 显示 true、`proxy.port=null`；UI 会显示“代理已启用”但没有端口，需结合日志判断。
- **限制 B（UI 撒谎点）**：代理运行中崩溃后会话继续，但 Hub 快照仍显示启动时的端口；没有实时失效事件。
- `scopeTarget/ruleId` 不写 `approvals` 表；重启后历史审批没有这两个字段。
- `board.ts` 仍 `user_version=2`，没有代理表。
- `scope.enabled` 默认关；`outOfScopeAction` 默认 approve；误报降级仍是改 config + 重启。
- 审计每次策略判定一条 note；代理每个请求也写一条 note（task-bound），事件量会增长。
- 没有在真实 agent 会话里做“读取 HTTP_PROXY 并发起请求”的端到端断言：E3 验证 `proxyEnvForSession` 的返回值和主进程 env 不变，main 负责把 provider 传给 manager；真实 agent 工具链覆盖留 WP6。
- `process-registry` 只做代理进程登记/句柄清理；不做 WP7 跨进程 stale 清理或启动时间核验。
- multitask F 组 flaky、render-verify 6 项既有失败仍挂账（WP6）。
- `verify:scope` 仍独立于 `verify:all`，门禁需单独跑。

---

## 两批次合计

- **批次 1**：范围状态快照 + 目标面板 + 审批卡目标显示 + mock/smoke；216 → 237 smoke。
- **批次 2**：本地代理 + 会话 env 注入 + 生命周期/进程登记 + E 组；verify:scope 271 → 308。
- 两批次都没有新增 HubAction；批次 1 只给 HubSnapshot 加可选 `scope?`，批次 2 没再改契约。
- 仍未做：代理开关 UI、真实 agent 代理覆盖验证、打包态端到端、WP7 全量进程回收。

**P4-D 完成；不要进入 P4-E。**

