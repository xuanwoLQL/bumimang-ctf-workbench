# V2-P0-3 · 比赛战略决策器与真实收敛验证

> 日期：2026-10-25 · 范围：`main/strategy/**`、`hub/hub.ts`、`shared-protocol`、`renderer/strategy/panel.ts`、任务 points/priority 入口。
> 证据：`evidence/v2-baseline/p3-strategy*.log`、`npm run verify:strategy`。

## 1. 做了什么

### 纯函数战略层

```text
main/strategy/model.ts   # 输入/输出/预算/权重/四种模板
main/strategy/score.ts   # EV = 分数 × 成功率 × 证据增益 ÷ (时间 + 成本)
main/strategy/plan.ts    # 建议/止损/收敛/冲突/再分配
main/strategy/index.ts
```

- 评分：`expectedPoints`（points 优先，否则 priority）× `successProbability`（题型先验 × 难度 × 时间/审批/scop/无进展）× `marginalEvidence`（无/E0/E1/E2/已确认）÷ `(timeCost + costWeight)`。
- 权重集中可配置（`DEFAULT_WEIGHTS`），不写 Web 专用规则。
- 模板：`single`、`lead_verify`、`recon_lead_verify`、`converge_verify`；固定 `PRESET_THREE_ENGINES` 不再是唯一策略。
- 无进展：连续 12 次工具调用或 10 分钟无新事实/死路/候选/证据 → `switch_role`/`stop_session`，不只按绝对耗时。
- 证据门槛：E0 不触发停止；E1 只建议 verify；E2 且无冲突才建议停止非 verify；冲突候选只建议人工对比。
- 已拿分：停止 lead/recon 重复劳动，保留 verify 复核不同证据。
- 预算：`maxSessions`、`maxSessionsPerTask`、`maxNewSessions`、`remainingMs`、`humanApprovalsRemaining`；`BUMIMANG_REMAINING_MS` / `BUMIMANG_CONTEST_DEADLINE` 可注入剩余时间。
- `strategy.plan` 只读；`strategy.apply` 重算计划、只执行 start/stop/switch、限制新开数/总量、跨任务动作需先切任务、写 audit。
- 任务新增 `points` 写入入口：`task.create.points` 与 `task.update`（priority/points）。
- UI：右栏“作战建议”面板，显示 EV/置信度/理由/风险/doNot，可勾选后一键应用；默认不自动执行。

## 2. 测试（真实输出）

`npm run verify:strategy` = **61/61**，覆盖：

- 分值/优先级影响 EV 与排序；时间不足降成功率并给出止损/noAction；scope 风险降权。
- 单路/lead+verify/recon+lead+verify/converge_verify 模板。
- 配额满不超开、maxNewSessions 截断、重复角色停一个。
- E0 不停止；E1 只建议 verify；E2 无冲突停止 lead；E2 冲突不停止；已确认保留 verify。
- 无进展建议换线；计划是纯函数不改输入。
- Hub 集成：fake SessionManager 下 `strategy.plan` / `strategy.apply` 真正启动 fake 会话；过期建议/建议类不可应用；任务不被自动 solved；audit 不含答案明文。

## 3. 真实 A/B：未做

- 唯一真实 A/B 发生在 R24 之前（`docs/logs/ab-result.json`，n=1）：首 flag 58.8s vs 69.5s，但收尾 157.9s vs 79.0s，flag 写两遍。
- 本轮**没有**真实靶场、没有新的 S1/S2/S3 重复实验；因此：
  - 不能声称“收敛有效”；
  - 不能声称“三路优于单路”；
  - 不能声称“战略层提高得分”。
- fake agent 测试只证明机制可运行，不证明收益。

## 4. 已知限制

- `competition-auto` 只是显式模式；本轮没有后台自动循环，也不会绕过 maxSessions/scope/审批/预算。
- 跨任务 apply 受现有 `session.stop` 焦点语义限制；需要先切到目标任务。
- 无进展检测依赖 Hub 的进展标记（事实/死路/候选）；agent 纯思考/无产出会被计入无进展。
- 真实收益必须等用户提供可重置靶场后做重复实验。
