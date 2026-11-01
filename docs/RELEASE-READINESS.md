# RELEASE READINESS · 不迷茫（WP1~WP8 最终收口）

> **V2 追加（2026-10-25）**：V2 已完成 AnswerSpec、战略建议、IR 分析骨架、范围 allowedActions/审计、内置技能库打包；最终门禁 `verify:all` **975 PASS / 0 FAIL**，flags 214、artifacts 329、scope 370、awdir 44、migration 236、multitask 174、reliability 47、bench 103、skills 160、打包态 `--verify` 26/26。
> **V3 真实样本追加（2026-10-25）**：M57 真实 Windows XP 内存样本已到：external `windows.pslist` 41 条 PASS；`windows.netscan`/`netstat` 因 Windows 5.1 `NotImplementedError` **BLOCKED**；平台 memory analyzer `detect=false` 且 pslist 解析 0 进程（`.mddramimage` 扩展名/进度行/固定 netscan 兼容缺口），**MEMORY_OVERALL=PARTIAL**。干净 Windows VM 已用现有 `clean-base` 做一次交付验收：正常安装版/便携版启动 PASS、技能 107 文件、IR 合成文本 E2E（候选/导出）PASS；交互 NSIS、BIOS/no vTPM 硬件合规、干净机 IR 工具、`--verify` stdout-pipe 未完成，**CLEAN_WINDOWS_ACCEPTANCE=PARTIAL**。新 Web CTF `18420` intake 未完整，**BLOCKED_WAITING_INTAKE**；未访问靶场、未跑真实 agent/token。详见 `docs/done/V3-P0-IR-REALITY.md`、`docs/done/V3-clean-windows-acceptance.md`、`docs/CTF-INTAKE-V3-STATUS.md`。

> FINAL · 2026-10-25。只写文档 + 最终全量，零代码改动。
> **Post-P9 更新（2026-10-25）**：P9-A/B/C1/C2/D 已完成（AWD/IR 只读模型/UI、md/csv/json 导出、AWD 批量 manual、v4 7 张强类型表）；AWD/IR 从“只设计”变为 **MVP 只读 + manual 可用**，但强类型表尚未启用读写、仍不接平台 API、不自动提交/利用/开环境。以下 P8/FINAL 判定保留为当时快照，AWD/IR 以本段为准。
> 结论：**单 session / 多任务工作台、技能、工件/证据、目标范围、flag 人工闭环、可靠性 dir 包已就绪；真实扇出收益、NSIS 安装/干净机器、AWD/IR 全功能未就绪。** 不能声称“完全比赛就绪”。

## 0. 最终数字

| 门禁 | 结果 |
|---|---|
| `verify:all` | **712 PASS / 0 FAIL** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:artifacts` | **324/324** |
| `verify:skills` | **149/149** |
| `verify:multitask` | **173/174**（F 组同毫秒焦点 flaky；rerun 仍 173；WP7 final 曾 174） |
| `verify:reliability` A+B+C | **45/45** |
| `verify:bench` | **73/73** |
| electron `--verify`（dev） | **26/26** |
| 打包态 `--verify`（dir 包） | **26/26** |
| `.probe/backup-wp1/board.db` | `6d491f0b…ab5cf469`（未变） |
| board `user_version` | 3 |
| 无 Electron 残留 | ✅（当前会话 claude.exe / Codex node 不计 app） |

证据：`evidence/final-*.txt`；打包 `evidence/p7c-pack-dir-final.txt`、`p7c-packaged-verify-final.txt`、`p7c-asar-list-final.txt`。

## 1. 七条成功标准对照（总控 §0）

| # | 标准 | 结果 | 说明 |
|---|---|---|---|
| 1 | 3 题 × 每道 2 会话同时跑，切题只切视图、重启恢复 | **PASS（系统）/ 未做真实 3×2** | WP1 verify:multitask 174/174 历史；F 组同毫秒 flaky（final 173/174）；真实 agent 3×2 未跑 |
| 2 | 每题/角色 playbook + 检索 `D:\agent\skill` | **PASS（有差距）** | WP2 skills 149/149；真实 smoke 1 次；CVE 精确检索 0 命中（log4j/JNDI 有） |
| 3 | 附件导入/预览/扫描 flag；cmd 证据 E2 | **PASS（部分）** | WP3 artifacts 324/324；E2/witness/预览；对象 witness/重启附件未自动化 |
| 4 | 目标/网段显式数据，越界判定留痕 | **PASS（默认关）** | WP4 scope 354/354；默认 false；真实 extract 误报率无数据 |
| 5 | flag 去重/人工确认/导出；提交适配器默认关且人工 | **PASS（manual）** | WP5 flags 214/214；2.7 两 flag confirm/manual；command 未实现 |
| 6 | 5–10 真题 × 3 次 benchmark，用数据决定扇出 | **NOT MET** | 只有 4 个 E2 样本；target 变更/宕机；批次 3 跳过；不能断言扇出收益 |
| 7 | verify:all / Electron / smoke / 打包态全绿 | **PASS（dir 包）** | all 712、electron 26、smoke 含在 712、dir 包 26/26；NSIS 未验证（B-4） |

## 2. WP1~WP8 状态

| WP | 状态 | 关键数字/说明 |
|---|---|---|
| WP1 多任务并发 | **完成** | multitask 174/174（F flaky）；切题不停会话、配额、恢复、归档 |
| WP2 技能/知识 | **完成** | skills 149/149；真实 smoke 1；CVE 精确检索差距 |
| WP3 工件/证据 | **完成** | artifacts 324/324；附件/ZIP/预览/E2/cmd 回放（默认关） |
| WP4 目标/范围/代理 | **完成** | scope 354/354；默认 off；代理默认 off；真实误报率无数据 |
| WP5 flag/提交/记分 | **完成（manual）** | flags 214/214；command 未实现；跨任务 grantAll 未实现 |
| WP6 benchmark | **文档完成；样本不足** | BENCHMARKS/WP6 收口；4 E2；60min soak interim；不能结论扇出 |
| WP7 可靠性/打包 | **完成（B-4 未验证）** | backup/rollback/hash、process cleanup、MCP UI、portable paths、dir 包 26/26；NSIS/干净机器未验证 |
| WP8 AWD/IR | **设计完成** | AWD-IR.md/决策；WP8 时零代码/零新表/零平台 API |
| WP9 AWD/IR MVP | **只读+manual 完成** | P9-A 模型、P9-B1/B2 UI、P9-C1 导出、P9-C2 批量 manual、P9-D v4 7 表；强类型读写未启用；不接平台 |

## 3. 关键能力

- 多任务看板、焦点切换不停会话、配额、重启恢复、归档。
- 技能库五级路径、懒索引、skill_search/read/list、简报 playbook/路由。
- 附件/ZIP 安全导入、只读预览、工件面板、E1/E2 证据、cmd 回放默认关。
- targets/CIDR/URL/host 提取、scope 三态、审批卡目标、默认关的本地代理。
- flag 候选持久化/去重/来源、confirm/reject/export、manual/dry-run submit、记分板。
- D1 monitor、D2 stream 合并、D3 pane 硬化、D4 store/UI 批处理、D5/D5.2/D7a 观测。
- P7-A 启动备份/迁移回滚/哈希链；P7-B 进程清理/MCP 崩溃 UI；P7-C 可移植路径/asar/dir 包。

## 4. 行为变更总清单（按 WP）

- **WP1**：切题只切焦点不停会话；session.start/prompt 任意非归档任务 + 每任务 3/全局 8；重启恢复；归档；多任务看板/全局审批。
- **WP2**：技能索引/路径边界；简报 playbook/路由/知识工具；skill_* MCP；技能状态 UI。
- **WP3**：附件导入/ZIP/预览/工件面板；E2 扩事实文本；cmd 回放默认关；artifact IPC。
- **WP4**：targets 表/契约；scope 提取/判定/审计；代理默认关；审批卡 scopeTarget。
- **WP5**：SQLite v3 flag 表/来源；confirm/reject/export；manual/dry-run submit；记分板；command 拒绝。
- **WP6**：P6-B 代理五态 UI（两个 UI 撒谎点）；D3/D4/D2/D7a；BENCHMARKS/WP6 文档。
- **WP7**：启动备份/迁移回滚/哈希链；进程登记/清理、MCP 崩溃 UI；可移植 workDir/skillDir；asar/dir 包验证。
- **WP8**：只设计，无代码。

## 5. 已知限制总清单（30+）

1. 真实 benchmark 样本 4 个 E2，远低于 5–10 题 × 3。
2. 批次 3 跳过（无 2 道新题）。
3. target 不稳定：44892 跑后 down；run1/2 与 run3 target 不同。
4. 不同 target 的 flag 值不同，不能当同一实例 3 次重复。
5. 真实扇出收益未证明（无真实 2/3 路 A/B）。
6. wall 是 15min timeout 边界，不是 makespan。
7. token 不完整：run2 0 零记录；模型 ID 未落库；无法精确成本。
8. 审批覆盖率低：b2b 101 calls 仅 3 审批；session 级 grantAll 自动放行。
9. command 提交模式未实现；只 manual/dry_run。
10. 跨任务 grantAll.taskId 未实现。
11. D7b（backgroundThrottling:false）不做；后台 timer 节流只做观测区分。
12. D7c（CDP 策略）不做。
13. 60min soak 未完成（32min 外部终止，interim PASS）。
14. scope.enabled 默认关；真实 extract 误报率无数据。
15. proxy 默认关；无真实代理收益数据；nmap/raw/DNS 可绕过。
16. CVE 精确检索差距（只索引元数据+头几行）。
17. ctf-solver 根目录 .md 不进索引。
18. 简报预览仅 mock 可见（P2-C 已知）。
19. 后台 fact 只焦点/flush 扫描；无 backfill。
20. 对象 witness / 重启附件未自动化（WP3 已知）。
21. AWD/IR **MVP 只读 + manual 可用**；强类型表（v4）尚未启用读写/CRUD。
22. AWD/IR 读取仍以 facts 为源；v4 7 表已建但未背填，结构化 fact 约定弱类型。
23. 不接平台写 API/不自动提交/不自动利用/不自动开环境（设计底线）。
24. 真实 Electron 崩溃→重启孤儿清理未做端到端。
25. MCP 崩溃 UI 未做 DOM banner 自动断言；mcpUnavailable 仅内存。
26. 未用 Job Object；taskkill /T /F + PID/startTime；非 Windows 仅直接子进程。
27. 备份用文件复制，非 SQLite Online Backup API；大库 <1s 未基准。
28. 哈希链只校验 prev_hash，不重算 hash/不检测链尾截断；无 UI 降级视图。
29. skill 外置，打包态默认 configured=false（需 env/config）。
30. 打包态 --verify 用临时 workDir，未实际验证 `<documents>/bumimang/work`。
31. 旧 workDir 只 stderr 提示，不自动迁移。
32. **B-4：NSIS 安装流程未执行；干净机器未验证**。
33. NSIS/绿色包未重打；dist 当前是 dir 包。
34. verify-ab 误启动事故（454,365 tokens）是独立发现，不计 benchmark 数据。
35. 批次 1/旧批次 2 partial 页面卡住（pre-D3）不是完整 benchmark 样本。
36. 干净机器 agent/skill/Python 检测未验证。
37. multitask F 组同毫秒焦点排序 flaky（final 173/174）。
38. render-verify 6 项既有失败仍挂账（不在 verify:all）。

## 6. 挂账项与建议

| 项 | 状态 | 建议 |
|---|---|---|
| B-4 NSIS/干净机器 | 未验证 | 干净 Windows/VM 双击安装→启动→检测 agent/skill/Python→起会话→卸载；不要在本机缓存环境假装 |
| 真实 benchmark | 样本不足 | 稳定靶场 + 2 道以上新题 + token 授权；按批次 3 提示词补；占位题不能下结论 |
| 扇出收益 | 未证明 | 默认单 session；需要时先人工 2 路试点，比较 firstFlag/tool calls/审批等待 |
| command 提交 | 未实现 | 保持 manual；若要实现，先做平台适配器/凭据/审计决策 |
| 审批覆盖率 | 低 | 评估 claude 触发条件/策略；不要依赖“全自动放行”作为安全边界 |
| multitask F | flaky | 后续修 board.listTasks 同毫秒 tiebreaker/测试注入固定时间；不影响主功能 |
| render-verify 6 | 既有失败 | 单独修/记录，不进 verify:all 前不要阻塞主链 |
| AWD/IR | MVP 只读+manual | 已可用：只读 UI/导出/批量 manual；强类型读写/平台 API 未做 |
| D7b/D7c | 不做 | 后台节流观察已够；不做 backgroundThrottling:false/CDP 策略 |

## 7. 就绪判定

- **核心单 session 工作台：就绪**（多任务/技能/工件/证据/范围/flag manual/可靠性 dir 包）。
- **真实扇出决策：不就绪**（样本不足、target 不稳定、无真实 A/B）。
- **NSIS/干净机器：不就绪**（B-4）。
- **AWD/IR：MVP 只读+manual 可用**（P9-A/B/C/D）；非全功能：强类型读写/平台 API/自动提交未做。
- **总体：可用于“单 session / 人工审批 / scope+proxy 默认关”的 CTF/渗透比赛；不能声称“完全比赛就绪”或“扇出有正收益”。**

## 8. 使用建议

- 比赛先保持 `scope.enabled=false`、`proxy.enabled=false`、单 session、人工审批；观察 extract/审批后再决定。
- 需要扇出时先人工 2 路试点；不要用 batch 2 的 4 个样本宣称收益。
- 提交 flag 用 manual/dry-run；不要接平台 API/自动提交。
- 目标不稳定时记录 target_down，不硬跑；每次 run 独立 task/session。
- 赛前在干净机器走 B-4；否则明确“未验证”。
- AWD/IR 只读+manual 可用；不要依赖平台 API/自动提交/强类型读写（未启用）。
- 保留备份/进程清理/哈希链告警；不要手工重置 board.db。

## 9. 证据与重跑

```text
npm run verify:all
npm run verify:scope
npm run verify:flags
npm run verify:migration
npm run verify:artifacts
npm run verify:skills
npm run verify:multitask
npm run verify:reliability
npm run verify:bench
npm run verify:ir
npm run verify:ir-tools
npm run verify:ir-real
node apps/desktop/src/cli/verify-ir-real.ts --require-real
node_modules/electron/dist/electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
npm run pack:dir
"dist/win-unpacked/不迷茫.exe" --no-sandbox --verify
```

- `evidence/final-*.txt`
- `evidence/v2-final3/`（V2 确定性门禁）
- `evidence/v3-final2/`（V2.1b 最终门禁 + 打包态 + Doctor/真实 IR）
- `evidence/v3-ir-reality/`（工具 Doctor、真实 EVTX/PCAP、内存/YARA 状态、负向探针）
- `docs/done/V3-P0-IR-REALITY.md`、`docs/CLEAN-WINDOWS-CHECKLIST-V3.md`、`docs/BENCHMARK-INTAKE-V3.md`
- 收口：`docs/done/WP1-multitask.md` … `WP8-design.md`、`docs/BENCHMARKS.md`、`docs/done/P6-C.md`、`docs/done/P7-A/B/C.md`
- 决策：`docs/decisions/*`
- 挂账：`docs/BLOCKED.md`（FINAL 状态表）
