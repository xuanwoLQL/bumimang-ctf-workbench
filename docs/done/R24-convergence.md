# R24 · P2 收敛机制（首答 → 宽限 → 收尾其余会话）

**日期**：2026-10-20 17:17 · **范围**：`src/main/hub/hub.ts`、`src/main/electron/main.ts`、`src/cli/verify-r18.ts`

## 做了什么

Codex 评审 P2 与 A/B 教训：s2 的 flag 落库后 s3 又写一遍、s1 再复核——makespan 翻倍的直接原因。本轮给「首个有效结果驱动收敛」做成机制：

- **触发条件（三关）**：① 宽限期已配置（`convergeGraceMs > 0`）；② 每个任务只收敛一次（`converging` 集合）；③ 黑板上存在含该 flag 且 **evidence != E0** 的 fact——E0 是无证据裸文本，幻觉风险太高，不触发。
- **行为**：给仍在跑的其它会话发一条收敛提示（流事件立刻可见 + `session.prompt` 带内送达），**宽限期满后停止还在跑的会话**；提交候选的会话不动；任务状态不动（solved 仍由人工确认）。
- **开关**：`BUMIMANG_CONVERGE=off` 关闭；`BUMIMANG_CONVERGE_GRACE_MS` 调宽限（默认 30s，main.ts 注入）。**HubDeps 默认 0 = 关闭**，所有既有测试/嵌入方行为不变，只有显式配置才启用。

为什么 evidence 门槛用「!= E0」而不是 E2：CTF 场景 witness 通常是「命令 + 回显」而非本地文件（A/B 实测即如此），`inferEvidence` 只在 witness 是工作区内存在的文件时才给 E2——E2-only 会让真实使用场景永远不收敛。E1（有 witness 描述）是合适的折中，且收敛只是「停队友」，误触发的代价是人工再扇出，可逆。

## 改了哪些文件

- `hub.ts`：`HubDeps.convergeGraceMs` + `maybeStartConvergence()` + `noteFlagCandidate` 挂钩
- `electron/main.ts`：环境变量注入（默认 30s 开启，`off` 关闭）
- `verify-r18.ts`：新 partConverge +11 条断言（110→121）

## 怎么验证的

```powershell
npm run verify:r18     # 121/121（+11：E0 不触发 / E1 触发 / 流提示 / 宽限期后队友 stopped /
                       #        赢家不动 / 库落 stopped / 无未处理异常）
npm run verify:all     # 49+16+17+19+72+121 = 294 + smoke，exit=0
```

真实输出（G 节）：
```
PASS  E0 裸文本候选不触发收敛（队友没被停）  — running
PASS  E0 候选也没发收敛提示
PASS  带证据候选立即给队友发收敛提示（流）
PASS  宽限期后队友被停止  — actual="stopped" expected="stopped"
PASS  提交候选的会话没有被停  — idle
PASS  库里队友状态落 stopped  — actual="stopped" expected="stopped"
```

## 没做什么 / 已知问题

- **idle 的队友不会被停**：停止循环只处理 starting/running/waiting_approval。idle = 已收完本轮、不再烧 token，留着等人工处置更安全。
- **提示可能送不到**：`session.prompt` 在跑着的会话上会排队，宽限期到被 cancel 时排队提示随之作废——流事件（pane 里立即可见）是可靠通道，prompt 只是尽力而为。
- **收敛提示的 UI 呈现没单独设计**：走现有 `session.stream` kind=other，窗格里一行文字。没有弹 toast、也没有在任务卡加「已收敛」徽标。
- **真实 A/B 复测没跑**：机制有确定性验收（假 agent），但「收敛把 makespan 拉回多少」需要再跑一次真实 A/B 才知道——留给下轮 A/B（要烧 4 个真轮次，建议用户点头再跑）。

## 下一手需要什么

无阻塞项。下一轮 R25：A7 安全边界（按会话签发令牌 + 日志脱敏 + 连接绑定身份）。
