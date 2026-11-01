# WP7 · 可靠性与打包（P1）总收口

> 状态：**WP7 收口完成（B-4 安装/干净机器仍未验证）**。P7-A/B/C 已实施；P7-D 只写文档 + 全量，零代码改动。
> 日期：2026-10-25。
> 基线：verify:all **712/0**、scope **354/354**、flags **214/214**、migration **127/127**、artifacts **324/324**、skills **149/149**、multitask **174/174**、reliability **45/45**、bench **73/73**、electron **26/26**；`.probe/backup-wp1/board.db` sha256 `6d491f0b…ab5cf469`，user_version 3。

## 做了什么

- **P7-A**：启动备份 board.db + WAL/SHM、滚动 5 份、迁移失败恢复、events 哈希链断裂告警（不截断）、快照可选 `healthChain`、启动失败弹窗/退出。
- **P7-B**：持久化进程登记（PID + OS 启动时间）、启动残留清理、PID 复用保护、killTree guard；MCP PID 登记/断开侦测、session `mcpUnavailable` 独立字段、`mcp.unavailable` 事件、pane 提示 + 新建会话入口；不自动重启。
- **P7-C**：workDir 五级可移植（env/config/dev/documents）、skillDir 五级（env/config/dev/packaged/未配置）、config 去盘符、asar 排除测试/文档/证据、dir 包 `--verify` 26/26。
- **P7-D**：本文件 + `docs/decisions/D-process-cleanup.md` + `docs/BLOCKED.md` B-4 更新 + `docs/PROGRESS.md` + 最终全量。

## WP7 目标与验收对照（计划 §10）

| 计划要求 | 结果 | 证据/说明 |
|---|---|---|
| §10.4 备份存在/可恢复 | **PASS** | reliability A1/A2 15/15；备份 db+wal+shm、sha256 一致 |
| §10.4 迁移失败回滚 | **PASS** | A2 破坏 v3 → 自动恢复，tasks/events 不丢，可读错误 |
| §10.4 哈希链断裂降级不清空 | **PASS** | A4 brokenAt + 快照字段；不自动截断 |
| §10.4 kill 主进程后重启，孤儿 agent/MCP 不残留 | **PARTIAL** | 登记表 + cleanupStale + killGuard 已实现；B1 用注入验证 PID/复用；**未做真实 Electron 崩溃→重启端到端** |
| §10.4 PID 复用不误杀 | **PASS** | B1 startTime 不匹配跳过；isPidCurrent |
| §10.4 MCP 崩溃 UI/新建入口 | **PARTIAL** | B2 bridge 断开、B3 manager 标记、B4 store、pane 代码 + Electron 加载；**未做 DOM banner 自动断言** |
| §10.4 打包态 --verify 26/26 | **PASS（dir 包）** | `evidence/wp7-final-electron.txt`（dev 26/26）、`p7c-packaged-verify-final.txt`（打包 26/26） |
| §10.4 asar 不含测试/私货 | **PASS** | 3,029 entries；项目 cli/smoke/bench/evidence/docs 0 |
| §10.4 config 无 `D:\agent\xuanwo` 硬编码 | **PASS** | C3；打包 resources config 也无盘符 |
| §10.4 干净机器有则记录，无则 B-4 明确未验证 | **PASS（诚实未验证）** | B-4 更新：dir 包通过；NSIS/干净机器未验证 |
| §10.2 `mcp-health.ts` 独立文件 | **偏差** | 未单独建文件；逻辑落在 `mcp-host/bridge.ts` + `session/manager.ts` + renderer panes；等同职责 |
| §10.2 `D-process-cleanup.md` | **PASS** | 已新增，说明 taskkill/Job Object 取舍与限制 |
| §10.5 Job Object 不引原生模块 | **PASS** | taskkill /T /F + PID/startTime；D-process-cleanup 记录 |
| §10.5 打包配置改坏风险 | **PARTIAL** | dir 包 --verify + asar 检查；未重打 NSIS |
| §10.5 干净机器不可得 | **PASS（未验证）** | B-4 诚实标注 |

**结论：P7-A/B 的代码与单元/集成测试完成；P7-C 的 dir 包链路完成；B-4（NSIS/干净机器）仍是唯一明确未验证项。**

## P7-A / P7-B / P7-C 每步摘要与证据

### P7-A（启动备份/迁移回滚/哈希链）

- `reliability/backup.ts`：db+wal+shm 备份、滚动 5、restore、list。
- `board.open` 包装：备份→openRaw→失败关闭+恢复+可读错误；不静默重置。
- `checkEventChain` + `getHealthChain`：prev_hash 断裂告警；快照可选 healthChain；不截断。
- main 启动失败弹窗/退出。
- 证据：`docs/done/P7-A.md`、`evidence/p7a-*`；reliability A 15/15。

### P7-B（进程清理 + MCP 崩溃）

- registry 持久化 pid/startTime/kind/task/session；startup cleanup、terminateAll、isPidCurrent。
- agent/MCP 登记；MCP hello pid；socket 断开 → manager 标记；revoke/stop 不误报。
- `mcpUnavailable` 独立字段、`mcp.unavailable` 事件、pane 提示 + 新建会话；不自动重启。
- AcpClient killTree guard；taskkill /T /F 基线保留。
- 证据：`docs/done/P7-B.md`、`evidence/p7b-final-*`；reliability A+B 30/30（最终 A+B+C 45/45）。

### P7-C（可移植路径 + 打包态）

- `resolveWorkDir` 五级；config 删除 workDir/skillDir 硬编码；旧 workDir 提示不迁移。
- skill 五级验证；skill 外置不打包。
- asar 排除 cli/smoke/bench/evidence/docs/test/tests；dir 包 --verify 26/26。
- 证据：`docs/done/P7-C.md`、`evidence/p7c-*`。

## 行为变更汇总

- 启动前备份 board.db + WAL/SHM（保留 5 份）；迁移失败自动恢复，不静默重置。
- events 哈希链断裂只告警 + 快照 healthChain；不截断。
- 启动清理残留 agent/MCP/代理（PID+OS 启动时间匹配）；PID 复用不误杀。
- MCP 异常断开：会话 `mcpUnavailable`（不改 status）+ 事件 + UI 提示 + 新建会话；不自动重启。
- workDir 开发态 `<repo>/work`、打包态 `<documents>/bumimang/work`；env/config 可覆盖；旧目录只提示。
- skillDir 五级；打包态不依赖 D:\；未配置 configured=false；skill 外置。
- config/app.json 无盘符/user 目录；asar 排除测试/文档/证据。

## 验收数字

| 门禁 | 结果 |
|---|---|
| `verify:all` | **712/0** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:artifacts` | **324/324** |
| `verify:skills` | **149/149** |
| `verify:multitask` | **174/174**（最终；P7-C 中曾 173 已知 F flaky） |
| `verify:reliability` A+B+C | **45/45** |
| `verify:bench` | **73/73** |
| electron `--verify`（dev） | **26/26** |
| 打包态 `--verify`（dir 包） | **26/26** |
| `.probe/backup-wp1/board.db` | `6d491f0b…ab5cf469` |
| board user_version | 3 |

## 已知限制清单（≥10）

1. **NSIS 安装未验证**（B-4）：只跑 dir 包；未双击安装/开始菜单/卸载。
2. **干净机器未验证**（B-4）：本机有 Electron/ACP 缓存，不能证明队友开箱可用。
3. **真实 Electron 崩溃→重启**未做端到端：registry/cleanup 有单元/注入测试，未真杀主进程再重启验证孤儿清理。
4. **MCP 崩溃 UI 未做 DOM 自动断言**：bridge/manager/store 有测试，pane banner 只靠 Electron 加载 + 代码审查。
5. **未用 Job Object**：taskkill /T /F + PID/startTime；非 Windows 只杀直接子进程；见 D-process-cleanup。
6. **PowerShell 逐 PID 查询**有启动开销；失败跳过，不阻塞。
7. **MCP PID 依赖 hello 上报**；未上报时无独立记录，由 agent `/T` 覆盖。
8. **mcpUnavailable 仅内存**，不落库；重启后丢失（通常终态）。
9. **备份用文件复制**，非 SQLite Online Backup API；大库 <1s 未基准。
10. **哈希链只校验 prev_hash 连续性**，不重算历史 hash；链尾截断/重算不检测。
11. **旧 workDir 只 stderr 提示**，无 UI 弹窗/自动迁移。
12. **skill 外置**：打包态默认 configured=false，需 env/config；未内置 resources/app-source/skill。
13. **打包态 --verify 用临时 workDir**，未实际验证 `<documents>/bumimang/work` 的打包运行。
14. **multitask F 组 flaky**：同毫秒焦点排序；最终 174/174，但历史 173。
15. **render-verify 6 项既有失败**仍挂账（不在 verify:all）。
16. **跨任务 grantAll.taskId 未实现**（P5 已知）。
17. **command 提交模式未实现**（WP6 决策）。
18. **D7b/D7c 不做**：backgroundThrottling 保持 true；CDP 策略未改。
19. **审批覆盖率不足**：真实跑 3/101 b2b；session 级 grantAll 自动放行仍存在。
20. **WSL 原生包/检测文档后置**；未做 Linux 原生包。
21. **NSIS/绿色包**未重打；dist 当前是 dir 包。
22. **verify-ab 误启动事故**是 WP6 独立发现，不在 WP7 修复范围。

## WP7 之前必须知道的事（WP8 交接）

- **WP8 只写 AWD/IR 设计文档，不写代码**；不接平台写 API、不自动提交/利用/开环境。
- 复用现有黑板/任务/审批/flag/证据/附件；不另起一套。
- 数据模型以只读视图为主；如需新表，设计里明确“WP9 才做”，不在 WP8 实施。
- 与 `docs/ARCHITECTURE.md` 的差异写 `docs/decisions/`，不改 ARCHITECTURE。
- WP7 已冻结：P7-A 备份/迁移/哈希链、P7-B 进程清理/MCP 崩溃、P7-C 路径/打包；WP8 不要重开。
- B-4（NSIS/干净机器）仍是唯一未验证项；最终报告必须保留。
- D7b/D7c 不做；command 未实现；multitask F flaky / render-verify 6 项 / 审批覆盖率不足仍挂账。
- 契约冻结：WP8 若需新契约字段，先写 `docs/requests/` 停下问用户。

## 怎么验证的（最终全量）

```text
verify:all 712/0
verify:scope 354/354
verify:flags 214/214
verify:migration 127/127
verify:artifacts 324/324
verify:skills 149/149
verify:multitask 174/174
verify:reliability 45/45
verify:bench 73/73
electron --verify 26/26
pack:dir exit=0；打包态 --verify 26/26
```

证据：`evidence/wp7-final-*.txt`；`p7c-pack-dir-final.txt`、`p7c-packaged-verify-final.txt`、`p7c-asar-list-final.txt`。

## 没做什么 / 已知问题

- 没有 NSIS 安装/干净机器验证（B-4）。
- 没有真实 Electron 崩溃重启端到端。
- 没有 MCP banner DOM 自动断言。
- 没有 Job Object/WSL 原生包。
- 没有 command 提交/D7b/D7c。
- 没有修改 ARCHITECTURE；差异已写 decisions（D-process-cleanup）。

## 下一手需要什么

- WP8：只设计 AWD/IR；读 `docs/BENCHMARKS.md`、本文件、WP1~WP6 收口与 decisions，复用现有模型。
- 最终报告：保留 B-4、D7b/D7c、command、multitask F/render-verify、审批覆盖率的未验证/挂账。
- 若用户提供干净 Windows/VM，再按 B-4 三选项验证 NSIS。
