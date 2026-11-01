# COMPETITION-READINESS-V2 · 分赛道就绪判定

> 2026-10-25 · 基于 V2/V2.1b 代码与最终门禁。V2.1b 已补真实 IR 工具 Doctor、EVTX/PCAP 全量扫描、第 6000 条 sentinel、require-real 失败门禁；真实赛题得分仍未验证。
> 原则：测试全绿 ≠ 能拿一等奖；没有真实靶场/标准答案/重复实验的地方一律写“未验证”。

## 0. 一句话结论

**机制显著补齐，但得分能力尚未证明。当前不能宣称“能拿一等奖”。**
能说的是：单会话 CTF 工作台、人工审批、统一答案模型、战略建议、IR 分析骨架/真实工具烟测、范围数据/审计、内置技能库都已落地并有确定性测试；干净 Windows VM 的正常启动/便携版/合成 IR E2E 已通过；真实扇出收益、企业网、真实 IR 赛题、交互安装/硬件合规仍未验证。

## 1. 最终门禁（2026-10-25）

| 门禁 | 结果 |
|---|---|
| `npm run verify:all` | **987 PASS / 0 FAIL**（10 套件 + smoke 331；套件明细 52+16+17+19+90+148+49+108+61+96） |
| `npm run verify:flags` | **214/214** |
| `npm run verify:artifacts` | **329/329** |
| `npm run verify:scope` | **370/370** |
| `npm run verify:awdir` | **44/44** |
| `npm run verify:migration` | **236/236** |
| `npm run verify:multitask` | **174/174** |
| `npm run verify:reliability` | **47/47** |
| `npm run verify:bench` | **103/103** |
| `npm run verify:skills` | **160/160** |
| `npm run verify:ir-tools` | **requiredAllOk=true / priorityOk=true / configPriorityOk=true**（tshark/capinfos/EvtxECmd/Volatility 全 OK） |
| `npm run verify:ir-real` | **REAL_PASS 2（EVTX/PCAP）/ REAL_SKIP 2（内存/YARA）/ REAL_FAIL 0；overall=PARTIAL**；普通 exit 0 |
| `npm run verify:ir-real --require-real` | **exit 1；overall=FAIL**（required=evtx/pcap/memory；memory=REAL_SKIP） |
| `npm run verify:ir`（fixture） | **96/96 FIXTURE_PASS（FIXTURE/MOCK，不计入真实 IR）** |
| Electron `--verify` | **26/26** |

原始日志：`evidence/v3-final2/`；真实 IR 工具/样本证据：`evidence/v3-ir-reality/`。确定性门禁全部 exit=0；`--require-real` 预期 exit 1（memory required），见第 4 节。

## 2. CTF 赛道

### 当前能力

- 任务级 AnswerSpec：flag 正则、自定义前缀、typed（IP/时间/hash/路径/进程/账号/命令/text）、freeform；UUID/Base64/hex；附件分块扫描/ZIP；候选去重/多来源/证据等级；不自动确认/提交。
- 战略层：EV 评分、四种模板（单路/lead+verify/recon+lead+verify/收敛验证）、无进展止损、E0/E1/E2 门槛、冲突不停止、配额/时间/审批预算、建议 + 勾选应用。
- 人工审批、范围数据/deny/allowedActions、审计、多任务、附件/工件、技能库内置/外置。
- R24 收敛：E0 不触发；E1 只建议；E2 无冲突才停止非 verify；确定性测试全绿。

### 真实得分数据

- 仍只有 **4 个 Web E2** 样本：first flag median **552.1s**；b2b 子集 n=2 median **496.5s**。
- 唯一真实 A/B（R24 前，n=1）：首 flag 58.8s vs 69.5s，但收尾 157.9s vs 79.0s，flag 写两遍。
- **没有** Crypto / Misc / Reverse / Pwn 真实基准；没有 R24 后的真实 A/B；没有强人基线。

### 失败模式

- target 不稳定/宕机（旧样本多个 target down）。
- 审批覆盖率低（b2b 101 次工具调用仅 3 条审批）。
- 长会话/无进展检测依赖 Hub 进展标记；agent 纯思考可能被误判。
- AnswerSpec/typed 误报；freeform 只给 E0 线索。
- 真实 flag 可能不在前 4MB/文本/ZIP 内。

### 新 Web CTF intake

- 新入口 `http://hbc2.haobachang.com:18420/`；旧 `35190`、旧 intake、旧 ground-truth 仅历史参考。
- **未访问/未 launch/未 reset/未 submit/未读 token**。
- 状态：`WEB_CTF_SELECTED_CHALLENGE=BLOCKED_WAITING_INTAKE`、`WEB_CTF_RESET_METHOD=UNKNOWN`、`REAL_AGENT_RUN=BLOCKED_NOT_AUTHORIZED`。
- 缺失字段见 `docs/CTF-INTAKE-V3-STATUS.md`；intake 完整前不做真实 benchmark。

### 是否达到一等奖门槛

**未证明。** 需要至少：Web/Misc/Crypto/Reverse 各 1 道可重置题 × 3 次 × S1/S2/S3，标准答案、强人基线、中位数/p90。当前数据不足以回答“比单会话强多少”。

### 能否给队友直接用

**可以用于“单 session + 人工审批 + 手动提交”的 CTF**；内置技能库已随 dir 包验证。不能承诺扇出收益或自动答题。

## 3. 企业渗透赛道

### 当前能力

- targets/CIDR/URL/host 数据、denyTargets、scopeNotes、allowedActions；deny 优先；未知目标 approve/block；审批卡目标；策略/审批审计；本地 HTTP CONNECT 代理（可选）。
- 战略层可给出 recon/lead/verify 建议，但默认不自动执行。

### 真实得分数据

**没有。** 没有企业网靶场、授权范围、跳板、flag 分布、重置方式或真实 A/B。

### 失败模式 / 限制

- agent 自己执行命令，平台只能靠 `session/request_permission` 事前拦、`session/update` 事后看；**不能声称已强制隔离**。
- 代理只对遵守 HTTP_PROXY 的工具生效；nmap/raw socket/DNS/直连可绕过。
- scope 默认关闭；真实 extract 误报率无数据。
- 没有 OS 级沙箱/防火墙；没有自动横向/利用。

### 是否达到一等奖门槛

**未验证，不应声称。** 需要真实企业网、授权目标、跳板、重置方式、S3 重复实验和强人基线。

## 4. IR 赛道

### 当前能力

- 文本日志/Webshell/文件系统/ZIP 内置分析器；PCAP/EVTX/内存接入 tshark/capinfos/EvtxECmd/Volatility。
- 统一时间线/IOC/事实；问题清单导入；问题→候选映射（IP/时间/路径/进程/账号/命令/hash/URL/text）；候选值进 flag_candidates，answer_candidate 事实只存 candidateId/来源/缺口；导出 md/csv/json。
- 工具缺失/超时/输出过大/解析失败都有可读 warning；所有外部命令参数数组 + shell:false + 审计。
- V2.1b 工具配置：`BUMIMANG_IR_TOOLS_CONFIG` > 用户级 `%APPDATA%\bumimang\ir-tools.json` > 开发态 config > `BUMIMANG_*` > PATH；release 只带 `ir-tools.example.json`，不带本机 D:/ 路径；Doctor `npm run verify:ir-tools` 真实解析。

### 工具与真实烟测（2026-10-25）

| 工具 | 真实路径 | 版本 | Doctor | 真实烟测 |
|---|---|---|---|---|
| tshark | `D:\Misc tools\Wireshark\tshark.exe` | 4.6.6 | OK | **REAL_PASS**（6000 包全量 + 第6000包 sentinel） |
| capinfos | `D:\Misc tools\Wireshark\capinfos.exe` | 4.6.6 | OK | **REAL_PASS**（识别 pcap/6000 包） |
| EvtxECmd | `D:\IR tools\EZTools\EvtxECmd\EvtxeCmd\EvtxECmd.exe` | 2026.5.0 | OK | **REAL_PASS**（System.evtx 全量 39,177 行；overall 见下） |
| Volatility 3 | `D:\Misc tools\volatility3\venv\Scripts\vol.exe` | 2.28.2 | OK | **MEMORY_OVERALL=PARTIAL**：M57 external pslist 41 PASS；netscan/netstat Windows 5.1 BLOCKED；平台 detect/pslist parse FAIL |
| YARA | `D:\IR tools\YARA\...` | - | AVAILABLE_NOT_INTEGRATED | 未接入 IR 流程，不计入真实通过 |

- 真实证据：`evidence/v3-ir-reality/ir-tools-doctor.json`、`ir-real.json`（PARTIAL）、`ir-real-require.json`（FAIL）、`real-console.log`、`real-require.log`。
- 真实 Hub 端到端（PCAP）：问题“攻击者 IP” → 候选 10.1.2.3/10.9.8.7 → 导出含候选。
- EVTX 全量扫描 39,177 行；PCAP 全量 6,000 包（第 6000 包 sentinel 命中）；展示上限 2,000，`truncatedForDisplay=true`，`coverage=full`。
- EvtxECmd map：459 文件 / 453 加载 / 3 个重复键失败（文件见证据）；属已知局部告警。关键事件 4624/4625/4688/7045 已映射验证；4697/1102 本机样本无事件，未验证。
- `verify:ir-real --require-real` 当前 **exit 1**（memory required 缺失），这是正确门禁，不是全绿。

### 真实数据边界

- **没有**真实 IR 赛题/完整问题清单/标准答案；有 M57 真实 Windows XP 内存样本：external pslist 41 条 PASS，netscan/netstat 5.1 BLOCKED，平台 memory analyzer detect/parse FAIL，**MEMORY_OVERALL=PARTIAL**。
- **fixture verified**（`verify:ir`，96/96，明确标注 FIXTURE_PASS）；**真实工具 + 真实 EVTX/6000 包 PCAP 全量扫描已验证**；**真实 IR 赛题得分能力未验证**。
- 不能用 EVTX/PCAP 工具烟测冒充“真实 IR 赛题已验证”。

### 失败模式 / 限制

- 真实 PCAP/EVTX/内存格式/插件版本差异可能失败；本次 System.evtx 有 map warning。
- 大文件/内存镜像耗时；默认 8MB 文本、20s 工具超时、4MB 输出上限。
- 问题映射是启发式；自然语言问题只给可疑行线索。
- IR 证据事实（IP/路径）会进 facts；答案候选事件/审计不含明文，但证据本身不是“已确认答案”。

### 是否达到一等奖门槛

**未验证。** 需要真实 IR 题（日志+PCAP+内存+问题清单+标准答案）和真实赛题得分数据；当前只有工具/样本级真实烟测。

## 5. 打包与干净机器

- `skill-builtin` 已随 `extraResources` 打包；`pack:dir` 产物含 **107 个技能文件**；打包态 `--verify` **26/26**；打包态 `skill_list` 索引 **97 docs / 5 scripts / wps=0**。
- V2.1b 最终重打：`dist/不迷茫 Setup 0.1.0.exe` 2026-10-25 **14:51:06**、`dist/不迷茫 0.1.0.exe` **14:51:10**、asar **14:50:46**；0 个源文件晚于 asar。
- release `resources/app-source/config` 只有 `app.json`/`permissions.json`/`ir-tools.example.json`；递归扫描 **0 个** `D:/Misc tools` 或 `D:/IR tools` 命中。
- 打包态无用户配置时不读 resources 旧配置；用户级 `%APPDATA%\bumimang\ir-tools.json` 存在时 source=userData。
- 打包态**不读取** `resources/app-source/config/ir-tools.json`（release 无此文件）；用户级配置/环境变量/PATH 生效。
- **干净 Windows VM：PRESENT，CLEAN_WINDOWS_ACCEPTANCE=PARTIAL**。正常安装版/便携版启动 PASS；技能 107 文件 packaged；IR 合成文本 E2E PASS（候选 10.1.2.3/10.9.8.7、导出含候选）；干净机无 IR 工具；交互 NSIS 未测；BIOS/no vTPM 硬件合规 BLOCKED；`--verify` 经 vmrun stdout-pipe EPIPE/EPERM 未计 PASS。详见 `docs/done/V3-clean-windows-acceptance.md`。

## 6. 现在可以/不可以声称

| 可以 | 不可以 |
|---|---|
| 全部确定性门禁 987/0、分套件全绿 | “真实比赛能拿一等奖” |
| 单 session + 人工审批 + 手动提交可用于 CTF | “三路扇出有正收益” |
| AnswerSpec/战略/IR 机制已实现并有 fixture 测试 | “真实 IR/企业网可用” |
| 范围数据/deny/allowedActions/审计已落地 | “平台已强制隔离所有 agent 网络动作” |
| 内置技能库随包分发；干净 VM 正常启动/便携/合成 IR E2E 通过 | “干净机器完整验收通过”（交互安装/硬件合规/IR 工具未完成） |

## 7. 仍需补的 P0

1. 真实 benchmark：4 类 CTF × 3 次 × S1/S2/S3；标准答案、强人基线、原始 JSON。
2. R24 后真实 A/B（至少 3 次中位数/p90）。
3. 企业网：授权范围、目标清单、跳板、flag 分布、重置方式。
4. IR：真实 IR 赛题/日志/PCAP/问题清单/标准答案；M57 已有真实镜像但平台 memory detect/parse 兼容性未修。
5. 干净 Windows VM：交互 NSIS、硬件合规（UEFI/TPM）、干净机 IR 工具、`--verify` harness。
6. PDF/图片/复杂内存插件；真实 AnswerSpec 前缀/UUID/hash 样本。

## 8. 给用户索要的靶场与数据

- 1 道可重置 Web CTF（完整 intake）或 1 套最小真实 IR 数据（日志/PCAP/内存/问题清单/标准答案）。
- 若要平台内存分析器跑 M57：明确授权换 Win7/Win10 镜像，或授权按 OS 版本选择插件/回退。
- 若要完成干净 Windows 完整验收：交互安装环境/硬件合规条件/干净机 IR 工具。
- 真实 agent 校准仍需模型、agent、token 额度与时间窗口的明确授权。
