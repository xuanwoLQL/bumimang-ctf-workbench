# V3 · 干净 Windows VM 交付验收记录

> 日期：2026-10-25
> VM：`D:/VMs/xuanwo-clean-win11/xuanwo-clean-win11.vmx`，快照 `clean-base`
> 系统：Windows 11 Enterprise LTSC Evaluation 10.0.26100 64-bit
> 结论：**CLEAN_WINDOWS_ACCEPTANCE=PARTIAL**。VM/安装包/正常启动/技能文件/IR 合成数据端到端通过；硬件合规、交互安装、真实 IR 工具与打包态 `--verify` 仍未完成。

## 1. VM 与硬件

| 项 | 值 |
|---|---|
| VM 快照 | `clean-base`（测试后已回滚并关机） |
| 固件 | BIOS（非 UEFI） |
| vTPM | 无 |
| 硬件合规 | **BLOCKED_NON_COMPLIANT**（不满足 UEFI/TPM/Secure Boot） |
| RDP/WinRM/VMware Tools | 复用既有验证，本轮未重复基础验收 |
| 凭据 | 仅由 `.probe/vm-accept.mjs` 读取 `D:/benchmarks-local/clean-win11/credentials.json` 供 vmrun 使用；未打印、未复制进项目/evidence |

## 2. 安装与启动

| 项 | 结果 |
|---|---|
| NSIS 静默安装 | **PARTIAL_SILENT_SYSTEM**：`/S` 在 vmrun guest 会话中卡住；最终用 SYSTEM 计划任务执行 `install.bat`（`/S /D=C:\Users\Public\bumimang-install`）成功 |
| NSIS 交互安装 | **NOT_TESTED**（未重装系统，未做 GUI 点击） |
| 安装目录 | `C:/Users/Public/bumimang-install`；app.asar 15,982,698 字节；`不迷茫.exe`/`Uninstall` 存在 |
| 内置技能 | **107 文件**；`manifest.json` 存在；`resources/app-source/skill` |
| 发布配置 | `app.json`、`permissions.json`、`ir-tools.example.json`；**无** `ir-tools.json`、无本机 D:/ 路径 |
| 正常启动（安装版） | **PASS**：窗口 `不迷茫 · 多 agent 并行解题工作台`，responding=true |
| 便携版正常启动 | **PASS**：窗口 `不迷茫 · 多 agent 并行解题工作台`，responding=true |
| 用户数据 | `%APPDATA%\bumimang\workspace\board.db` 创建；未污染安装目录 |
| 退出清理 | 停止后 app 进程 = 0 |

> `--verify` 通过 vmrun/PowerShell stdout-pipe 启动时出现 `EPIPE: broken pipe`（main.ts:506）或多实例共用 `%TEMP%\bumimang-verify-main` 的 `EPERM`；正常启动不触发。**未把该 `--verify` 结果计为 PASS**，仅记录为验收工具链限制；干净机上的常规启动与 CDP 端到端已通过。

## 3. 技能运行时（CDP 快照）

```json
{"configured":true,"root":"C:\\Users\\Public\\bumimang-install\\resources\\app-source\\skill","packages":["ctf-0day","ctf-solver"],"builtAt":null,"source":"packaged"}
```

- `source=packaged`；包名正确。
- 107 个文件已在 guest 实测；`docs=97/scripts=5` 的索引未在 guest 直接调用（host 打包态已验证）。
- 状态记为 **PARTIAL_FILE_COUNT_ONLY**，不写成完整技能检索已验证。

## 4. IR 工具状态

- 干净 VM 没有 tshark / EvtxECmd / Volatility；Doctor 未在 guest 运行（不是 NOT_FOUND 冒充通过）。
- IR 分析对导入的 PCAP/EVTX 给出可读 warning：
  - `attachments/vm-real.pcap [pcap] 未安装 tshark；PCAP 未分析`
  - `attachments/System.evtx [evtx] 未安装 EvtxECmd；EVTX 未分析`
- 状态：**BLOCKED_TOOLS_ABSENT**。

## 5. IR 端到端（合成文本日志）

通过 CDP 调用真实渲染层 `window.bumimang.dispatch`，无真实 agent、无 token：

| 步骤 | 结果 |
|---|---|
| 建任务 | `category=ir`，任务 `VM IR acceptance` |
| 导入附件 | 3 个文件（access.log + 6000 包 PCAP + System.evtx），21,515,932 字节 |
| 导入问题 | 1 个（`attacker IP?`） |
| `ir.analyze` | inputs=5、results=5、facts=8、timeline=6、iocs=6、candidates=2；missing-tool warnings 2 条 |
| 候选 | `10.1.2.3` E1 0.65；`10.9.8.7` E1 0.4 |
| `ir.export` md | ok=true；len=1694；包含候选 `10.1.2.3` |
| 人工确认/提交 | 未自动确认、未自动提交 |

- 这是**合成文本日志**的端到端，不是真实 IR 赛题；PCAP/EVTX 因工具缺失未解析。
- 证据：`evidence/v3-ir-reality/vm-cdp-ir-e2e2.txt`、`clean-vm-acceptance.json`。

## 6. 状态

```text
CLEAN_WINDOWS_VM_ARTIFACT=PRESENT
CLEAN_WINDOWS_HARDWARE_COMPLIANCE=BLOCKED_NON_COMPLIANT
CLEAN_WINDOWS_INSTALL=PARTIAL_SILENT_SYSTEM
CLEAN_WINDOWS_PORTABLE=PASS_NORMAL_LAUNCH
CLEAN_WINDOWS_APP_LAUNCH=PASS
CLEAN_WINDOWS_SKILL=PARTIAL_FILE_COUNT_ONLY
CLEAN_WINDOWS_IR_TOOLS=BLOCKED_TOOLS_ABSENT
CLEAN_WINDOWS_IR_E2E=PASS_SYNTHETIC_TEXT
CLEAN_WINDOWS_VERIFY=BLOCKED_STDOUT_PIPE
CLEAN_WINDOWS_PROCESS_CLEANUP=PASS
CLEAN_WINDOWS_USER_DATA=PASS
CLEAN_WINDOWS_ACCEPTANCE=PARTIAL
```

## 7. 未完成 / BLOCKED

- 交互 NSIS 安装未做（未重装系统，未 GUI 点击）。
- 硬件合规不满足（BIOS/no vTPM/Secure Boot）。
- 干净机 IR 工具未安装，Doctor/真实 PCAP/EVTX 未在 guest 验证。
- 打包态 `--verify` 未能在 vmrun 下稳定通过；正常启动与 CDP 端到端通过，但 `--verify` 结果不计 PASS。
- 未跑真实 agent、未消耗 token、未调用平台写接口。
