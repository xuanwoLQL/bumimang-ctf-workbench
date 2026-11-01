# V3-P0-IR-REALITY · 真实 IR 工具与样本验证

> 日期：2026-10-25
> 结论：**PARTIAL**。真实 EVTX 与真实合成 PCAP 已 REAL_PASS；M57 真实内存 external pslist 41 条 PASS，但 netscan/netstat 因 Windows 5.1 BLOCKED、平台 memory detect/pslist parse FAIL，**MEMORY_OVERALL=PARTIAL**；YARA 未接入；真实 IR 赛题得分、企业网仍未验证；干净 Windows VM **CLEAN_WINDOWS_ACCEPTANCE=PARTIAL**（正常启动/便携/合成 IR E2E PASS，交互安装/硬件/工具/verify 未完成）；新 Web CTF **BLOCKED_WAITING_INTAKE**。
> 证据：`evidence/v3-ir-reality/`；Doctor：`npm run verify:ir-tools`；真实烟测：`npm run verify:ir-real`。

## 1. 事实更正

上一轮写“外部工具未安装”是**错误**。本机实际存在并已真实解析：

| 工具 | 真实路径 | 版本 |
|---|---|---|
| tshark | `D:\Misc tools\Wireshark\tshark.exe` | 4.6.6 |
| capinfos | `D:\Misc tools\Wireshark\capinfos.exe` | 4.6.6 |
| text2pcap | `D:\Misc tools\Wireshark\text2pcap.exe` | 4.6.6 |
| EvtxECmd | `D:\IR tools\EZTools\EvtxECmd\EvtxeCmd\EvtxECmd.exe` | 2026.5.0 |
| Volatility 3 | `D:\Misc tools\volatility3\venv\Scripts\vol.exe` | 2.28.2 |
| YARA Python | `D:\IR tools\YARA\venv\Scripts\python.exe` | 独立工具 |
| YARA wrapper | `D:\IR tools\YARA\yara-scan.py` | 未接入平台 |

正确表述：**工具已安装、Doctor 已真实解析；EVTX/PCAP 真实解析已验证；内存真实解析仍缺 Windows 镜像。**

## 2. 工具 Doctor

`npm run verify:ir-tools` → exit 0；`requiredAllOk=true`、`priorityOk=true`。

- 解析优先级：`config/ir-tools.json` 显式路径 > `BUMIMANG_*` 环境变量 > PATH。
- 四个必需工具 status=OK，版本如上。
- 三类错误分类已实测：
  - `PATH_ERROR`：显式配置指向不存在路径；
  - `VERSION_FAIL`：真实进程 exit≠0 且无版本号；
  - `CLI_FAIL`：真实进程输出 usage/unrecognized arguments。
- YARA 状态：`AVAILABLE_NOT_INTEGRATED`（工具存在，但平台 IR 流程未接入；不计入真实通过）。
- 证据：`evidence/v3-ir-reality/ir-tools-doctor.json`、`ir-tools-doctor.txt`、`doctor-console.log`。
- 配置查找层级：`BUMIMANG_IR_TOOLS_CONFIG` > 用户级 `%APPDATA%\bumimang\ir-tools.json` > 开发态 `config/ir-tools.json` > `BUMIMANG_*` > PATH；打包态**不读取** resources 里的旧 `ir-tools.json`，只带 `ir-tools.example.json`。

## 3. 真实 EVTX：REAL_PASS（全量扫描）

- 样本：本机 `C:\Windows\System32\winevt\Logs\System.evtx`，临时复制；`sha256=5d5dbf2b9941d82e35c95223fdbfb6e19b820f59c15baeabf3f3d542bfd49809`，20,975,616 字节（系统日志会轮转，哈希只对本次样本有效）。
- 工具：EvtxECmd 2026.5.0，真实进程 `-f System.evtx --csv <tmp> --csvf events.csv`，exit=0，约 6.1s。
- 生成 `events.csv`：39,178 行（含表头），全量扫描 **39,177 行**；不再只解析前 5,000 行。
- `TimeCreated/EventId/Channel/Computer/Payload` 全部 39,177 行 >0；`UserName` 空时回退 `UserId`，账号字段 30,762 行；MapDescription 2,482 行。
- 平台 `evtxAnalyzer`：totalScanned=39,177、totalMatched=39,177、displayedTimeline=2,000、displayedIocs=414、truncatedForDisplay=true、coverage=full。
- 关键 EventID 映射：4624=773、4625=127、4688=104、7045=359 全部 MapDescription/Payload 一致（verified=4）；4697/1102 本机样本无事件（no-sample=2），**不能声称 6/6 全验证**。
- map：目录 459 文件、Maps loaded 453、3 个重复键 map 加载失败（文件名见证据）；属已知局部告警，不是“map 完全加载失败”。
- 证据：`evidence/v3-ir-reality/ir-real.json`（含命令、exit、耗时、哈希、计数；不含完整 CSV/敏感行）。

## 4. 真实 PCAP：REAL_PASS（6000 包全量 + sentinel）

- 样本：确定性离线合成 PCAP（`evil.example` DNS + HTTP + 第 6000 包 `sentinel.example`），`sha256=91f332d6fddad6cd6cd44ac7ad3004e1127243a4477ff2ad6db13462a6e0e8bf`，540,191 字节；未抓取真实网络流量。
- 生成器：`tools/v3/make-v3-pcap.py`（`sha256=3ed26394c580f2a51eb7d914ca11cf9fb13f67a501a61d44694970998899d7c7`），纯 Python 标准库，固定内容；支持包数参数。
- capinfos 4.6.6：识别 `pcap` / `ether` / **6000 packets**，exit=0。
- tshark 4.6.6：使用与生产 `pcapAnalyzer` **完全相同的** `buildTsharkArgs`（无 `-c 5000`；`-T fields -E separator=, -E quote=d ...`），exit=0，输出 **6000 行**。
- `parseTsharkCsv`：6000 行；10.1.2.3、10.9.8.7、`evil.example`、`GET`、`/shell.jsp?x=1,2` 全部命中；第 6000 包 `203.0.113.66`、`sentinel.example`、`/sentinel?x=9` 命中。
- `pcapAnalyzer`：totalScanned=6000、totalMatched=6000、displayedTimeline=2,000、displayedIocs=9、truncatedForDisplay=true、coverage=full。
- 平台 Hub 端到端：导入问题“攻击者 IP”，真实 `ir.analyze` → inputs=2、facts=4、timeline=500、候选=3，`ir.export` 含候选；不自动确认/提交。
- 证据：`evidence/v3-ir-reality/ir-real.json`、`real-console.log`。

### 覆盖率 sentinel

- fixture `verify:ir` G2：6,500 行 EVTX CSV 第 6,000 行 EventID 1102 + 独特 IP；平台全量扫描并检出。
- fixture `verify:ir` G2：6,000 行 tshark CSV 第 6,000 行 sentinel IP/域名；平台全量扫描并检出。
- 真实 6,000 包 PCAP：第 6,000 包 sentinel `203.0.113.66`/`sentinel.example`/`/sentinel?x=9` 真实 tshark 解析并检出。
- 结论：EVTX/PCAP 均为 **COVERAGE=FULL**，展示上限 2,000 只影响展示，不影响扫描；不把 HEAD_ONLY 冒充 REAL_PASS。

## 5. 真实内存：M57 MEMORY_OVERALL=PARTIAL

- Volatility 3 2.28.2 版本/`-h` 探测成功（真实进程，exit=0）。
- 用户提供 M57 真实 Windows XP 内存镜像（`pat-2009-11-24.mddramimage`，534,761,472 字节）；external `windows.pslist` exit=0，41 条进程（38 无退出时间、3 有退出时间）。
- `windows.netscan` / `windows.netstat` exit=1：`NotImplementedError: This version of Windows is not supported: 5.1 15.2600!` → **BLOCKED_VERSION**。
- 平台 memory analyzer：`.mddramimage` 未被 detect；平台 pslist 解析 0 进程；`memory.ts:112` 固定 netscan 无版本回退 → 平台兼容性缺口。
- 因此：**MEMORY_OVERALL=PARTIAL**，不是 REAL_PASS；未复制 534MB 镜像进项目；未修改 memory.ts。
- 详见 6.1 与 `evidence/v3-ir-reality/memory-m57.json`。

## 6. YARA

- `yara-python`/wrapper 存在，但平台**没有** YARA 分析器/流程。
- 状态：`AVAILABLE_NOT_INTEGRATED`；不执行文件扫描，不计入 tshark/EVTX/内存的真实通过结论。

## 6.1 M57 真实内存镜像（只记录，不改代码）

- 样本：`D:/Download/IR-samples/M57/pat-2009-11-24.mddramimage`，534,761,472 字节，SHA-256 `35153279a91f45650e791e7452d224cb926c83d924b5c16fd0271b05fb4ccb6e`；ZIP SHA-256 `b1a6a2bb9d7fda62ebf21e714a2bd432a6f9d67fdbe7fcef38cbc6f88aefc568`。**未复制进项目**。
- Volatility 3 2.28.2 外部真实结果：`windows.pslist` exit=0，41 条进程（38 无退出时间、3 有退出时间）；`windows.netscan` / `windows.netstat` exit=1，`NotImplementedError: This version of Windows is not supported: 5.1 15.2600!`。
- 平台探针（不改代码）：
  - `memoryAnalyzer.detect=false`：`.mddramimage` 不在扩展名白名单；
  - 平台 pslist 解析 **0 进程**（vol 的 Progress/表头格式兼容问题）；
  - `memory.ts:112` 固定调用 `windows.netscan`，没有按 OS 版本回退；
  - 结果 facts=1、timeline=0、iocs=0，warning 含 netscan 版本不支持。
- 状态：
  ```text
  MEMORY_SAMPLE_PRESENT=PASS
  MEMORY_PSLIST_REAL_PASS=PASS（外部真实 Volatility，不是平台解析）
  MEMORY_PLATFORM_PSLIST_PARSE=FAIL
  MEMORY_NETSCAN_BLOCKED_VERSION=BLOCKED
  MEMORY_NETSTAT_BLOCKED_VERSION=BLOCKED
  MEMORY_OVERALL=PARTIAL
  PLATFORM_MEMORY_ANALYZER=BLOCKED_COMPATIBILITY
  ```
- 证据：`evidence/v3-ir-reality/memory-m57.json`、`memory-m57.txt`、`memory-m57-platform-probe.json`。
- 未修改 `memory.ts`；换 Win7/Win10 镜像或按 OS 版本选择插件需用户明确授权。

## 6.2 干净 Windows VM

- VM `xuanwo-clean-win11` / `clean-base` 已启动并完成一次交付验收，测试后已回滚并关机。
- 正常安装版启动、便携版启动均 PASS；技能库 `source=packaged`、107 文件；配置只有 `app.json`/`permissions.json`/`ir-tools.example.json`；用户数据落在 `%APPDATA%\bumimang\workspace`。
- IR 合成文本端到端通过：建任务→导入 3 附件→问题→分析→候选 10.1.2.3/10.9.8.7→导出；PCAP/EVTX 因干净机无工具给 warning。
- `--verify` 经 vmrun stdout-pipe 出现 EPIPE/EPERM，未计 PASS；正常启动不计该问题。
- 详细状态与限制：`docs/done/V3-clean-windows-acceptance.md`、`evidence/v3-ir-reality/clean-vm-acceptance.json`。
- 硬件合规仍 BLOCKED：BIOS、无 vTPM、非 UEFI；交互 NSIS 未测；干净机 IR 工具缺失。

## 6.3 Web CTF 新靶场

- 新入口 `http://hbc2.haobachang.com:18420/`，旧 `35190` 与旧 intake/ground-truth 仅历史参考。
- **未访问新靶场**；未 launch/reset/submit/查询 token。
- 状态：
  ```text
  WEB_CTF_SELECTED_CHALLENGE=BLOCKED_WAITING_INTAKE
  WEB_CTF_RESET_METHOD=UNKNOWN
  REAL_AGENT_RUN=BLOCKED_NOT_AUTHORIZED
  ```
- 缺失字段与安全边界：`docs/CTF-INTAKE-V3-STATUS.md`。

## 7. 状态与门禁

| 项 | 状态 |
|---|---|
| verify:ir (fixture/mock) | **96/96 FIXTURE_PASS（FIXTURE/MOCK）**（输出明确标注，不计入真实 IR；含 EVTX/PCAP 第 6000 条 sentinel） |
| verify:ir-tools | exit 0；requiredAllOk=true；priorityOk=true；configPriorityOk=true |
| verify:ir-real（普通） | **REAL_PASS 2（EVTX/PCAP）/ REAL_SKIP 2（内存/YARA）/ REAL_FAIL 0；overall=PARTIAL**；exit 0 |
| verify:ir-real --require-real | **exit 1；overall=FAIL**（required=evtx/pcap/memory，memory=REAL_SKIP） |
| 负向配置探针 | 显式错误路径 → REAL_FAIL 3、exit 1（`real-negative.log`；只证明 REAL_FAIL 会非 0） |
| verify:all | **987 PASS / 0 FAIL** |
| 打包态 --verify | **26/26** |
| Electron --verify | **26/26** |
| release 本机路径扫描 | **0 命中**（`evidence/v3-final2/release-path-scan.txt` 为空；grep exit 1 = 无匹配） |
| M57 memory | **MEMORY_OVERALL=PARTIAL**（external pslist PASS；platform detect/parse FAIL；netscan/netstat BLOCKED） |
| Clean Windows | **CLEAN_WINDOWS_ACCEPTANCE=PARTIAL**（正常启动/便携/IR 合成 E2E PASS；交互安装/硬件合规/工具/verify harness 未完成） |
| Web CTF | **BLOCKED_WAITING_INTAKE**（未访问、未跑真实 agent） |

最终打包（V2.1b 源码冻结后）：

- `dist/不迷茫 Setup 0.1.0.exe`：2026-10-25 **14:51:06**
- `dist/不迷茫 0.1.0.exe`：2026-10-25 **14:51:10**
- `dist/win-unpacked/resources/app.asar`：2026-10-25 **14:50:46**
- 源文件检查：0 个源文件晚于 asar。
- release `resources/app-source/config` 只有 `app.json`、`permissions.json`、`ir-tools.example.json`；**没有** `ir-tools.json`、没有 `D:/Misc tools`/`D:/IR tools`。
- 打包态无用户配置时 `loadIrToolConfig` 返回 path=null/source=null/tools={}；用户级配置存在时 source=userData 且工具路径可解析。
- 证据：`evidence/v3-final2/`、`evidence/v3-ir-reality/`。

## 8. 修改文件

- `config/ir-tools.json`（开发机本地路径数据；**不进入 release**）
- `config/ir-tools.example.json`（新增；release 占位模板，无 D:/ 路径）
- `apps/desktop/src/main/ir/tool-config.ts`（config 查找：explicit > userData > dev；Resolver：config > env > PATH）
- `apps/desktop/src/main/ir/index.ts`（导出工具配置/PCAP 参数）
- `apps/desktop/src/main/ir/analyzers/pcap.ts`（`buildTsharkArgs` 默认全量、`quote=d`、引号/逗号/空值、totalScanned/coverage）
- `apps/desktop/src/main/ir/analyzers/evtx.ts`（UserName→UserId、全量扫描、展示上限分离、关键事件优先级、map/EventID 统计）
- `apps/desktop/src/main/hub/hub.ts`（HubDeps.irToolResolver；IR 分析使用 config-aware resolver）
- `apps/desktop/src/main/electron/main.ts`（userData 配置 + IR 工具配置注入 Hub）
- `apps/desktop/src/cli/verify-ir-tools.ts`（Doctor + 配置层级自检）
- `apps/desktop/src/cli/verify-ir-real.ts`（required=evtx/pcap/memory；PARTIAL/FAIL；全量覆盖 + sentinel + map/EventID）
- `apps/desktop/src/cli/verify-ir.ts`（FIXTURE_PASS；新增第 6000 条 sentinel）
- `package.json`（`verify:ir-tools`、`verify:ir-real`）
- 文档：`docs/COMPETITION-READINESS-V2.md`、`docs/BENCHMARKS-V2.md`、`docs/RELEASE-READINESS.md`、`docs/HANDOVER.md`、`docs/done/V2-P0-4-ir-pipeline.md`、`docs/CLEAN-WINDOWS-CHECKLIST-V3.md`、`docs/done/V3-clean-windows-acceptance.md`、`docs/CTF-INTAKE-V3-STATUS.md`、`docs/BENCHMARK-INTAKE-V3.md`、`docs/decisions/D-v3-ir-tool-resolution.md`
- 新增证据：`evidence/v3-ir-reality/memory-m57.*`、`memory-m57-platform-probe.json`、`clean-vm-acceptance.*`、`vm-*`、`evidence/ctf-intake-18420/STATUS.json`
- 备份：`.probe/backup-v3-20261025-141925/`（V2.1）与 `.probe/backup-v3b-20261025-143755/`（V2.1b，含 before/after SHA-256；11 个代码/配置文件变化）

## 9. 仍然不能声称

- 不能声称“真实 IR 赛题已验证”——只有 EVTX/PCAP 工具级烟测。
- 不能声称“内存解析已通过”——REAL_SKIP/BLOCKED。
- 不能声称“YARA 可用”——未接入。
- 不能声称“企业网/干净 Windows/一等奖”——未验证。
- 不能把 `verify:ir` 的 fixture/mock 96/96 计入真实结果。
