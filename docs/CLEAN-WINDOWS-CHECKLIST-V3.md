# CLEAN-WINDOWS-CHECKLIST-V3 · 干净 Windows 验证清单

> 日期：2026-10-25
> **当前状态：CLEAN_WINDOWS_ACCEPTANCE = PARTIAL**
> 用户已提供现有 VM：`D:/VMs/xuanwo-clean-win11/xuanwo-clean-win11.vmx`，快照 `clean-base`。已执行一次交付验收：安装包文件、正常启动、便携版启动、技能 107 文件、IR 合成文本端到端通过；**交互 NSIS、硬件合规（BIOS/no vTPM）、干净机 IR 工具、打包态 `--verify` 仍未完成**。
> 详细结果：`docs/done/V3-clean-windows-acceptance.md`、`evidence/v3-ir-reality/clean-vm-acceptance.json`。
> 测试后 VM 已回滚 `clean-base` 并关机；凭据未打印/未复制进项目。

## 0. 执行前置

| 项 | 要求 | 本次状态 |
|---|---|---|
| 干净 Windows VM / 物理机 | 无本仓库源码、无 Electron 缓存、无全局 agent 适配器、无 `BUMIMANG_*` | **PRESENT**（`clean-base`；BIOS/no vTPM） |
| 安装包 | `dist/不迷茫 Setup 0.1.0.exe`（2026-10-25 14:51:06） | 已有，已安装 |
| 绿色包 | `dist/不迷茫 0.1.0.exe`（2026-10-25 14:51:10） | 已有，已启动 |
| 测试样本 | 6000 包 sentinel PCAP、真实 EVTX 副本 | 已导入 guest；PCAP/EVTX 工具缺失 |
| 记录 | 截图/命令输出/文件哈希；不写真实 flag/token/凭据 | 已记录到 `evidence/v3-ir-reality/` |
| 禁止 | 不配置平台 token、不自动开环境、不自动提交、不跑真实 agent | 全程遵守 |

## 1. 安装前快照

1. 记录 Windows 版本、构建号、用户、时间、安装包 SHA-256。
2. 确认 `%APPDATA%\bumimang` 不存在；确认没有 `BUMIMANG_*` 环境变量。
3. 记录默认浏览器/系统代理未被修改；`scope.enabled` 仍为 false。

## 2. NSIS 交互安装

| # | 步骤 | 期望 |
|---|---|---|
| 2.1 | 双击 `不迷茫 Setup 0.1.0.exe`，选择安装目录 | 安装完成，桌面/开始菜单快捷方式存在 |
| 2.2 | 启动应用 | 窗口出现，三栏布局，无白屏 |
| 2.3 | 查看左栏“技能库”状态 | “已配置 · 内置（安装包） · 2 个包” |
| 2.4 | 确认 `resources/app-source/skill` | 107 个文件；`manifest.json` 存在 |
| 2.5 | 在应用内触发 skill 检索/简报（或 MCP skill_list） | 返回 ctf-0day/ctf-solver；docs≈97、scripts≈5、wps=0 |

## 3. NSIS 静默安装（可选）

```powershell
"不迷茫 Setup 0.1.0.exe" /S
```

- 检查安装目录、快捷方式、卸载项；启动后重复 2.2–2.5。
- 记录安装退出码；无自动提交/网络写接口。

## 4. 便携版启动

1. 将 `dist\不迷茫 0.1.0.exe` 放到空目录运行。
2. 确认数据写 `%APPDATA%\bumimang`（不是源码树/安装目录）。
3. 确认没有读取开发机的 `.ui-run`/`work`/`config`。
4. 退出后确认无残留 Electron/agent/MCP 进程。

## 5. 首次启动无残留配置

| 检查 | 期望 |
|---|---|
| `%APPDATA%\bumimang` | 首次启动后创建；此前不存在 |
| `board.db` / workspace | 位于应用 userData 下，可写 |
| `config/app.json` | scope.enabled=false、proxy.enabled=false |
| 全局 `~/.codex` / `~/.claude` / `~/.agents` / `~/.config` | **未被修改**（时间戳/哈希对比） |
| 浏览器/系统代理 | 未被修改 |

## 6. IR 工具 Doctor（干净机）

1. 默认 `config/ir-tools.json` 在干净机大概率路径不存在；先记录 Doctor 的 `NOT_FOUND`/PATH_ERROR。
2. 将安装目录 `resources\app-source\config\ir-tools.example.json` 复制到用户级配置 `%APPDATA%\bumimang\ir-tools.json`，填入干净机工具路径；或设置 `BUMIMANG_IR_TOOLS_CONFIG` 指向用户可写 JSON。**不要**把用户配置写进安装目录。
3. 运行（开发态或等价打包态 Doctor）：
   ```powershell
   npm run verify:ir-tools
   ```
   期望：Doctor 显示实际读取的配置文件路径与 source（explicit/userData/dev）；tshark/capinfos/EvtxECmd/Volatility 全部 `status=OK` 并显示真实版本；PATH_ERROR/VERSION_FAIL/CLI_FAIL 分类可用。
4. 若干净机没有工具：记录 `NOT_FOUND`，不得标记通过。

## 7. 建任务 + 导入真实样本

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | 新建任务，category=ir，填写 answerSpec（默认 flag 或 typed） | 任务出现，焦点切换，无自动 agent |
| 7.2 | 导入小 PCAP（确定性 evil.example） | 附件清单/哈希出现 |
| 7.3 | 导入真实 EVTX 副本 | 附件清单/哈希出现；不把完整 EVTX/CSV 提交仓库 |
| 7.4 | IR 面板点“分析附件/工件” | 真实 tshark/EvtxECmd 执行；时间线/IOC/分析摘要出现 |
| 7.5 | 导入问题清单（如“攻击者 IP 是什么？”） | 候选出现，证据 E1，缺口可见 |
| 7.6 | 导出答题卡 md/csv/json | 内容含候选/缺口；仍需人工确认/提交 |
| 7.7 | 不点确认/提交 | 任务不被自动标 solved，不自动提交 |

## 8. 退出与清理

1. 退出应用；等待 5 秒；确认无 Electron/agent/MCP/tshark/EvtxECmd/vol 残留。
2. 检查 `%APPDATA%\bumimang` 数据位置与大小；确认没有写源码目录/安装目录。
3. 确认没有生成含真实 flag/token/凭据的日志；EVTX CSV 临时目录已清理。
4. 记录卸载测试（可选）：NSIS 卸载后残留数据目录说明。

## 9. 验收表

| 项 | PASS 条件 | 本次 |
|---|---|---|
| NSIS 交互安装 | 安装→启动→技能索引→建任务→退出 | **NOT_TESTED**（未做 GUI 点击/未重装） |
| NSIS 静默安装 | `/S` 退出码 0 + 启动 | **PARTIAL_SILENT_SYSTEM**（SYSTEM 计划任务 `/S` 成功安装；vmrun 会话直跑卡住） |
| 便携版 | 空目录启动 + 数据落 userData | **PASS_NORMAL_LAUNCH**（窗口/responding；未跑 packaged --verify） |
| 首次无残留 | 全局配置未改、无旧数据 | **PARTIAL**（userData/board.db 正常；未做全局配置哈希对比） |
| 技能库 | packaged 107 文件 / 97 docs / wps=0 | **PARTIAL_FILE_COUNT_ONLY**（107 文件/包名 packaged；docs 索引未在 guest 调用） |
| Doctor | 四工具 OK + 版本 | **BLOCKED_TOOLS_ABSENT**（干净机无 IR 工具） |
| 真实 PCAP/EVTX | 分析→候选→导出 | **BLOCKED_TOOLS_ABSENT**（导入成功但缺 tshark/EvtxECmd） |
| IR 合成文本 E2E | 建任务→导入→问题→候选→导出 | **PASS_SYNTHETIC_TEXT**（候选 10.1.2.3/10.9.8.7；导出 len=1694） |
| 进程/数据清理 | 无残留 | **PASS**（remaining app procs=0；userData/board.db 正常） |

## 10. 需要用户提供/授权

- 交互 NSIS 安装环境（允许 GUI 点击）或明确接受“SYSTEM 静默安装”不等同交互安装；
- 硬件合规条件（UEFI/TPM/Secure Boot）或接受 BLOCKED_NON_COMPLIANT；
- 干净机 IR 工具安装包/路径，或允许只验证 `NOT_FOUND`；
- 若要修 `--verify` stdout-pipe/多实例临时目录问题，需要代码修改+重打包授权。

> 本清单已执行一次“部分交付验收”；不得把合成文本 IR E2E 写成“真实 IR 赛题已验证”，也不得把 SYSTEM 静默安装写成“交互安装已验证”。
