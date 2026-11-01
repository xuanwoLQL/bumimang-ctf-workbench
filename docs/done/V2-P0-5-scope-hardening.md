# V2-P0-5 · 渗透范围控制与资格风险防护

> 日期：2026-10-25 · 范围：`main/blackboard/board.ts`、`main/policy/**`、`main/acp/client.ts`、`main/session/manager.ts`、`renderer/targets.ts`、`renderer/store.ts`、`shared-protocol`。
> 证据：`evidence/v2-baseline/p5-*.log`、`npm run verify:scope`、`npm run verify:migration`。

## 1. 做了什么

### 任务级范围数据

- `task.scope.update`：写 `denyTargets`、`scopeNotes`、`allowedActions`；只写数据 + audit，不自动启用 scope、不改 targets。
- v6 迁移：`tasks.allowed_actions TEXT NOT NULL DEFAULT '[]'`。
- `TaskView.allowedActions?`；目标面板新增范围编辑器（deny/notes/allowedActions）。
- `getTaskScope` 返回 `allowedActions`；SessionManager 把它传给 AcpClient。

### 策略前置校验

- `PolicyScopeContext.allowedActions`；`scope.enabled=true` 且 allowedActions 非空时：
  - 未列出的动作 → `approve`（rule `action-not-allowed`），不静默放行；
  - 硬阻断 `block` 仍优先，不能被 allowedActions 绕过；
  - scope 关闭时忽略 allowedActions（旧行为）。
- 现有 `fs/read|write`、`terminal/create`、`session/request_permission` 的事前闸门保持不变；`terminal/kill`/`release` 是已创建终端上的清理动作，不新增审批（文档明确）。
- 审批审计增加 `risk`、`scopeTarget`、`decidedBy`、`status`；策略审计增加 `allowedActions`。
- UI 文案改为“范围策略已启用（仅平台可中介的 ACP 动作）”；明确：
  - 本地代理只对遵守 HTTP_PROXY 的工具生效；
  - nmap/raw socket/DNS/直连可绕过；
  - agent 自己执行、不经过平台的命令仅可事后审计，不能声称已强制隔离。
- scope 默认仍为 `enabled=false`、`outOfScopeAction=approve`、proxy 默认关闭。

## 2. 测试（真实输出）

| 套件 | 结果 |
|---|---|
| `npm run verify:scope` | **370/370**（原 354 + G 组 16 条） |
| `npm run verify:migration` | **236/236**（v6 + 范围数据持久化） |
| `npm run smoke` | ALL PASS |

G 组覆盖：

- `task.scope.update` 成功落库、TaskView 回显、audit 记录；非数组/空项/超长/归档拒绝。
- allowedActions 未包含动作 → approve；包含 → 旧规则；硬阻断优先；scope 关闭忽略。
- 审批审计含目标/规则/决定。

原有 354 条继续覆盖：相邻网段、CIDR 边界、URL userinfo、多 IP、域名 vs CIDR、未知目标、deny 优先、代理绕过、审批卡目标。

## 3. 明确不能强制的地方

- **agent 自己执行命令**：opencode/codex/claude 实测不走 `terminal/*`/`fs/*`，平台只能靠 `session/request_permission` 事前拦、`session/update` 事后看。
- **网络出口**：本地 HTTP CONNECT 代理只对遵守代理的工具生效；nmap、raw socket、DNS、直连可绕过。
- **不是 OS 级沙箱/防火墙**：没有 Job Object/系统代理/驱动级隔离；不能写“平台已强制隔离所有 agent 网络动作”。
- `scope.enabled=false` 时，目标数据只用于展示/审计，不参与判定。

## 4. 下一步

真实企业网/授权靶场中验证 extract 误报率、deny 优先级和审批卡目标；再决定是否默认开启 scope。测试窗口内不把 scope 默认打开。
