# D-scope-enforcement · 范围判定的强制边界、默认值与误报降级

- 日期：2026-10-24
- 状态：P4-C + P4-D 批次 1/2 已实施；审批卡目标 UI、目标面板、本地代理均已落地
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP4；`docs/plans/COMPETITION-READINESS.md` §7.2/§7.4/§7.5；`docs/done/P4-B.md`、`P4-C.md`、`P4-D.md`
- 实现：`apps/desktop/src/main/policy/engine.ts`、`acp/client.ts`、`session/manager.ts`、`electron/main.ts`、`approval/queue.ts`、`hub/hub.ts`、`scope/proxy.ts`、`reliability/process-registry.ts`、`config/loader.ts`、`config/app.json`、`rules/competition.json`

## 背景

WP4 要让“授权目标/网段是显式任务数据，越界动作至少能被策略判定并留痕”。P4-B 只做了 `parse/cidrContains/matchTargets/extractTargets` 纯函数，P4-C 才把它们接到策略引擎和 ACP 闸门。

策略引擎是放行/阻断的唯一闸口，任何默认值都可能直接影响正常解题。本决策固化：哪些动作能判定、哪些不能强制、默认 verdict 是什么、误报时怎么降级、审计会产生什么副作用。避免后续（P4-D/WP6/WP7）重新讨论或误以为“已经 OS 级拦截”。

## 决策

### 1. 能强制 / 不能强制

**能判定并留痕**：

- 我们看得到的 `session/request_permission`（claude/opencode/codex/dsh 的权限请求）；
- 我们自己在执行的 `terminal/exec`（ACP `terminal/create`）；
- `fs/read` / `fs/write` 这类经过 ACP 客户端的动作。

这些路径在 `AcpClient.evaluate()` 里先提取目标、算 `inScope`，再交给 `PolicyEngine`。命中 `no-out-of-scope` 时按 `scope.outOfScopeAction` 返回 `block` 或 `approve`；`block` 不可被 allow 覆盖，`approve` 进人工审批。

**不能强制**：

- agent 自己执行、不请求审批的命令（opencode/codex 的已知行为差异）；
- raw socket、DNS、直连、隧道、本地代理不遵守 `HTTP_PROXY` 的工具；
- 任何绕过 ACP 客户端的网络/文件动作。

因此 UI 和文档只能写“尽力强制，不承诺 OS 级防火墙/沙箱”。本决策不引入操作系统防火墙、不注入系统代理、不改全局配置。

### 2. 默认 verdict

`config/app.json` 的默认值固定为：

```json
{
  "scope": {
    "enabled": false,
    "outOfScopeAction": "approve",
    "proxy": { "enabled": false }
  }
}
```

理由：

1. **`enabled=false`**：P4-B 的提取仍是保守启发式，误报率没有在真实 agent 环境验证。默认开启会让误报直接变成审批/拦截，可能卡死正常命令。
2. **`outOfScopeAction="approve"`**：即使显式开启，也先转人工，不直接 `block`。这与计划 §7.4 的示例默认 `block` 不同，是有意的安全取舍：比赛资格优先不等于“默认误伤”。
3. WP6 用真实题验证提取准确率后，再评估是否把默认推到 `block`。在验证前，不把默认改成 block。

`scope.enabled=false` 时，引擎完全忽略 `scope` 上下文：不匹配 `out_of_scope`/`target_regex`，`target=null`，判定结果与 P4-B 之前逐字一致。

### 3. 判定顺序与 unknown

- 规则包第七条 `no-out-of-scope` 只在 `scope.enabled=true` 时参与匹配。
- `inScope="out"` 或 `"unknown"` 时，规则匹配；verdict 由 `scope.outOfScopeAction` 决定，而不是写死在 JSON 里。
- `inScope="in"` 时，rule 不匹配，回到旧规则（C2 硬阻断、凭据/网络审批、档位兜底）。
- block 优先级不变：`no-out-of-scope` 配成 `block` 时，任何 allow（含会话级追加）都不能覆盖。
- `target_regex` 只在 `scope.enabled=true` 且存在 target 时匹配；关闭时不参与，避免旧规则行为漂移。
- `unknown` 按 `outOfScopeAction` 兜底：不把“不知道怎么判”当成“在范围内”直接放行。
- 多目标取最严格：`out > unknown > in`。
- 没有提取到任何候选时不触发 scope 规则（只有候选存在但无法判定才是 `unknown`）。

已知 unknown：候选本身是 CIDR（P4-B 返回 `unknown`）、域名 vs CIDR（不查 DNS）、非法/IPv6 URL 进 `unknowns`。裸 IPv6 不进 candidates（P4-B 已知）。

### 4. 审批卡字段

`ApprovalView` 增加两个**可选**字段：

```ts
ruleId?: string | null;
scopeTarget?: { kind: string; value: string } | null;
```

- `ruleId` 与现有 `rule` 同值，保留 `rule` 兼容旧渲染层；旧视图缺省时由 Hub 用 `rule` 兜底。
- `scopeTarget` 只在 `no-out-of-scope` 命中时非空；旧规则一律 `null`。
- 旧快照/旧 mock 没有这两个字段时不炸（可选）。
- P4-C 批次 2 的填充来源：
  - `main.ts` 的 `onApprovalRequired` 用**同一 request detail + 当前任务 targets**重算 `scopeTarget`（`scopeTargetForApproval`），不重跑 `policy.evaluate`、不缓存全局状态；
  - `ruleId` 直接来自 `decision.rule`；
  - `ApprovalQueue` 把字段放进 `ApprovalView`，所以 `approval.upsert` 事件和 `snapshot().approvals/approvalsAll` 都能带；
  - `Hub.publishApproval` 对旧视图做兜底：`ruleId = view.ruleId ?? view.rule ?? null`，`scopeTarget = view.scopeTarget ?? null`。
- 这些字段没有写进 `approvals` 表（board schema 仍 v2，本步不加列）；重启后的历史审批从库里读不到这两个字段，这是已知中间状态。

### 5. 代理

- `scope.proxy.enabled` 默认 `false`；`scope.proxy.port` 默认 `0`（随机端口）。
- P4-D 批次 2 已实现本地 HTTP + CONNECT 代理：
  - 子进程监听 **127.0.0.1**，不暴露到 0.0.0.0；
  - 只允许会话所属任务的 `targets` 内 host:port；deny/out/unknown 返回 403；
  - 代理内部强制拒绝，不依赖客户端；
  - 每个请求审计 host:port/verdict/timestamp，不写 body；
  - 会话启动时只把 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 注入该会话进程，不污染主进程；
  - 代理未启用/启动失败/崩溃时不注入 env，会话照常启动（网络出口降级，不挂起会话）；
  - app 退出时关闭代理子进程并释放端口，进程登记记录 PID + 启动时间、按 ChildProcess 句柄清理。
- 代理 URL 带每会话随机 token（`http://bumimang:<token>@127.0.0.1:<port>`）；父进程按 token 绑定任务，避免同一代理端口跨任务放行。
- 仍然只对遵守 `HTTP_PROXY` 的工具生效；nmap / raw socket / DNS / 直连可绕过。不修改系统代理/防火墙，不承诺 OS 级拦截。

### 5.1 代理实现与 8 条硬边界（P4-D 批次 2）

| # | 边界 | 实现 |
|---|---|---|
| 1 | 监听 127.0.0.1，不是 0.0.0.0 | 子进程 `server.listen(port, "127.0.0.1")`；E2 断言 address |
| 2 | 端口随机分配 | 默认 `port:0`；E2 两次启动端口不同 |
| 3 | app 关闭时清理代理进程 | 子进程 + `ProcessRegistry`（PID/startedAt，按 ChildProcess 句柄终止）；E2/E3 关闭后登记清空 |
| 4 | env 只注入会话进程 | `SessionManager` 只写 `spec.env`；E3 断言主进程 `HTTP_PROXY` 等未变 |
| 5 | 起不来时优雅降级 | 启动失败/崩溃不抛穿会话；`proxyUrlForSession` 返回 null → 不注入 env；E4 覆盖 |
| 6 | 拒绝在代理进程内部强制 | HTTP/CONNECT 在子进程内按 token→任务 targets 判定；非 in 一律 403 |
| 7 | 每个请求审计，不写 body | 父进程写 `kind=note` 的 `proxy.request {host,port,verdict,timestamp}`；E3 断言无 body |
| 8 | 不改系统代理/防火墙/全局配置 | 只注入 app 会话 env；文档/UI 明示可绕过 |

实现细节：

- `scope/proxy.ts`：父进程 `ScopeProxyService` fork 子进程；子进程实现 HTTP/CONNECT、30s 超时、64 并发上限、HTTP 请求体 1MB、无 body 日志。
- `session/manager.ts`：`proxyEnvForSession()` 只返回会话 env；`startSession` 把代理 env 合并进 `sessionEnv`，不改 `process.env`、不改 `restoreSessions`/配额/收敛。
- `electron/main.ts`：app ready 后按 config 启动代理；启动成功把真实 `server.address().port` 填进 Hub 快照 `scope.proxy.port`；退出时先 `scopeProxy.close()` 再关 board。
- `reliability/process-registry.ts`：只登记代理 PID + 启动时间，按句柄清理；不做 WP7 全量进程回收/跨进程 stale 清理。

### 6. 误报降级

当 `scope.enabled=true`、`outOfScopeAction="block"` 且提取误报导致正常命令被拦：

1. 把 `config/app.json` 的 `scope.outOfScopeAction` 改成 `"approve"`；
2. 重启应用（配置在启动时由 `loadAppConfig` 读盘；不热更新）；
3. 同类动作改为进人工审批，不再直接 block；
4. 若只是单个目标误报，更精确的做法是把该目标加入任务 `targets`，或从 `denyTargets` 移除。

本步**不新增 `approval.overrideOnce` / 任何 HubAction**。降级路径是“改配置 + 重启 + 必要时加目标”，D 组用真实临时 config 文件重读验证，不是 mock。

### 7. 审计副作用

- `PolicyEngine` 每次判定（allow/approve/block）都调用 `onDecision`。
- 生产路径 `main.ts` 把它接到 `writePolicyAudit`，使用现有 `board.note` 写一条 `kind="note"` 的 `events` 行（同时进 audit 索引）。
- 事件文本形如 `policy.decision {json}`，JSON 含 `action/rule/verdict/reason/target/inScope/scopeEnabled`；**不写命令全文**，避免 flag/token 进事件链。
- `scope.enabled=false` 也写，此时 `target=null`、`inScope=null`、`verdict` 走旧逻辑。
- 副作用：每次策略判定多一条 events（以及一条 `board.note` audit），长时间会话/大量工具调用会让黑板事件数量明显增加；新增事件也会改变之后事件的哈希链尾部。历史链不重算。
- `evidence/replay` 直接调用 `policy.evaluate`，因此它的判定也会被 `onDecision` 审计（`target=null`，因为 P4-C 没有给 replay 接 scope 提取）。

### 8. 最小接线

- `session/manager.ts`：启动会话时把当前任务 `targets/denyTargets` 作为闭包传给 `AcpClient`；P4-D 另把代理 URL 注入该会话 spawn env（见 §5.1），不改 `process.env`、不做策略判定。
- `electron/main.ts`：把 `config/app.json` 的 `scope` 传给 `PolicyEngine`/`SessionManager`；注入审计回调；P4-C 批次 2 在审批路径用同一 detail + 任务 targets 补 `scopeTarget`；P4-D 启停本地代理、把真实端口透传给 Hub 快照。
- `acp/client.ts`：只在 `scope.enabled=true` 时提取目标；关闭时连 `getScopeTargets` 都不调用。
- `policy/engine.ts`：只做规则匹配与 verdict；不读 board、不读 config（scope 配置由 main 传入）。
- 没有新增全局状态、没有旁路、没有读 DB 二次策略判定；批次 2 的 `scopeTarget` 重算只补充审批卡目标，不改变 verdict。

## 备选方案与取舍

- **默认 block（计划 §7.4 示例）**：比赛资格优先，但 P4-B 误报率未验证；误报会直接拦正常命令。否决为默认，保留 `block` 作为显式配置。
- **默认开启 scope**：会在真实 agent 环境引入未验证的审批/拦截；否决，默认关。
- **unknown 直接 block**：CIDR/域名等无法判定场景会大量误拦；否决，按 `outOfScopeAction` 兜底。
- **unknown 直接放行**：会把“不知道”当成“在范围内”，绕过范围；否决。
- **新 `approval.overrideOnce`**：能一键临时放行，但新增 HubAction/契约与 UI 面；本步用配置降级，先不加。
- **把 scopeTarget 写进 board approvals 表**：需要 v3/加列，超出 P4-C；本步只做内存视图与事件。
- **Hub 从 command 重新提取 scopeTarget**：只改 hub.ts 更省事，但不是策略判定上下文，terminal args 可能漏提；否决，改为 main 用同一 detail + targets 重算。
- **OS 级防火墙/全局代理**：超出本应用边界，且需要管理员权限/全局配置；否决。

## 影响

- `scope.enabled=false` 时策略判定结果不变；唯一新增副作用是每次判定一条 `kind=note` 审计事件（`target=null`）。
- `scope.enabled=true` 时新增 `no-out-of-scope` 规则；默认 approve，误报可人工放行；配成 block 时误报会拦截，按 §6 降级。
- `ApprovalView` 只加两个可选字段，旧快照/旧渲染层不炸；`approval.upsert`、`approvalsAll` 可带目标/规则 id。
- 没有新增 HubAction、没有改现有审批批量/scope=all/global 语义。
- P4-D 已实现目标面板/审批卡目标显示/本地代理；代理默认关，仍不承诺 OS 级隔离。

## 已知限制

1. 目标面板 / 审批卡 `scopeTarget/ruleId` 已实现（P4-D 批次 1）；旧快照仍按“未知/空”处理。
2. `scopeTarget/ruleId` 不落 `approvals` 表；重启后历史审批没有这两个字段。
3. 代理默认关；开启后只对遵守 `HTTP_PROXY/HTTPS_PROXY` 的工具生效，nmap/raw socket/DNS/直连可绕过；代理 URL 带 Basic token，不支持 proxy userinfo/`Proxy-Authorization` 的工具会 407。
4. `scope.enabled` 默认关；WP6 用真实题验证提取准确率后再评估。
5. `outOfScopeAction` 默认 approve，不是计划 §7.4 示例的 block。
6. CIDR 候选仍 unknown；裸 IPv6 不进 candidates；IPv6 URL 进 unknowns。
7. `evidence/replay` 不做 scope 提取（只被审计，target=null）。
8. 策略只在看得见的 ACP/权限/terminal/fs 动作上判定；agent 自执行、raw socket、DNS、直连可绕过；不承诺 OS 级防火墙。
9. 审计每个判定一条 note，事件量会增长；哈希链尾部会变化。
10. `scopeTarget` 由 main 在 no-out-of-scope 命中时用同一 detail + 当前任务 targets 重算；不重跑 policy.evaluate，但如果 targets 在极短时间内变化，审批卡目标可能与判定瞬间略有差异。
11. 代理崩溃后会话继续，但网络出口不可用；Hub 快照仍显示启动时的端口（没有实时失效事件）。
12. 代理启动失败时 `scope.proxy.enabled` 仍按 config 显示 true、`proxy.port=null`；UI 标题会显示“代理已启用”但没有端口，需结合日志判断。
13. `process-registry` 只做代理进程登记与按句柄清理；不做 WP7 的跨进程 stale 清理/OS 级启动时间核验。
14. `verify:scope` 仍独立于 `verify:all`，门禁需单独跑。
15. multitask F 组 flaky、render-verify 6 项既有失败仍挂账（WP6）。

## 后续

- **P4-D 已完成**：目标面板、审批卡目标显示、本地代理（默认关）、process-registry 最小实现。
- **WP6**：用真实题验证提取准确率/误报率，决定是否默认开启、是否把默认 verdict 推到 block；验证代理对真实 agent 工具链的覆盖率。
- **WP7**：打包态代理/UI 验证；更强进程回收（跨进程 stale 清理/启动时间核验）；若需要更强隔离，另写 OS 级方案，不在本应用内假装已实现。
