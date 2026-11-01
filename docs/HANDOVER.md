# 不迷茫 · 夜间作业交接

**窗口：2026-10-12 23:26 → 2026-10-13 07:00，白班续至 11:45** · 两条 lane 并行（A=Codex，B=Claude Code）

---

## 〇、接手须知（新窗口从这一节开始读）

**这是什么**：一个 Windows 原生桌面工作台，把本机已装的多个编码 agent 变成"同一道题的多路并行解题队"，用一份共享黑板协调，人工只处理边界。项目在 `D:\agent\xuanwo`。

**2026-10-25 V3 真实样本追加**：M57 内存 external pslist 41 条 PASS；netscan/netstat Windows 5.1 BLOCKED；平台 memory detect/pslist parse FAIL，**MEMORY_OVERALL=PARTIAL**。干净 Windows VM `clean-base` 已做一次交付验收：正常安装版/便携版启动、技能 107 文件、IR 合成文本 E2E（候选/导出）PASS；交互 NSIS、BIOS/no vTPM、干净机 IR 工具、`--verify` stdout-pipe 未完成，**CLEAN_WINDOWS_ACCEPTANCE=PARTIAL**。新 Web CTF `18420` **BLOCKED_WAITING_INTAKE**；未访问靶场、未跑真实 agent/token。详见 `docs/done/V3-P0-IR-REALITY.md`、`docs/done/V3-clean-windows-acceptance.md`、`docs/CTF-INTAKE-V3-STATUS.md`。

**2026-10-25 V2.1b 追加**：IR 工具已真实发现/版本探测：tshark/capinfos 4.6.6、EvtxECmd 2026.5.0、Volatility 3 2.28.2；真实 `System.evtx` + EvtxECmd **REAL_PASS**（全量 39,177 行 / 时间线 2,000 / map 453/459），6000 包合成 PCAP + tshark/capinfos **REAL_PASS**（全量 6000 行 / 第6000包 sentinel / Hub 候选+导出），内存 **REAL_SKIP/BLOCKED**（无真实 Windows 镜像），YARA 未接入。Doctor：`npm run verify:ir-tools`；普通 `verify:ir-real` overall=PARTIAL；`--require-real` 因 memory required 缺失 **exit 1（正确门禁）**。最终 `verify:all` **987/0**、打包态 26/26；NSIS/绿色包 2026-10-25 14:51 重打；release 无本机 D:/ 工具路径。证据 `evidence/v3-ir-reality/`。**真实 IR 赛题得分、企业网、干净 VM 仍未验证。**

**2026-10-25 V2 追加（接手先读）**：V2 已落地 AnswerSpec（自定义前缀/typed/UUID/hash/Base64/IR 候选）、战略建议（EV/模板/无进展/收敛门槛）、IR 分析骨架（文本/Webshell/文件系统/ZIP + 可选 tshark/EvtxECmd/Volatility）、范围 allowedActions/审计、内置技能库打包。最终门禁 `verify:all` **975/0**（flags 214、artifacts 329、scope 370、awdir 44、migration 236、multitask 174、reliability 47、bench 103、skills 160、打包态 26/26）；NSIS/绿色包 2026-10-25 14:11 重打。**真实扇出收益、企业网、真实 IR 赛题、干净 VM 仍未验证**；不能宣称能拿一等奖。详见 `docs/COMPETITION-READINESS-V2.md`、`docs/BENCHMARKS-V2.md`、`docs/plans/COMPETITION-V2.md`。

**2026-10-20 17:41（R23–R27，Codex 评审 5 条全部落地，见 [`docs/done/R27-task-workdir.md`](done/R27-task-workdir.md) 及各轮文档）**：用户拍板「按建议全部做完」，五轮连续交付：

- **R23 A2**：`releaseLease` 加 holder 校验（非 holder 放不掉，null 系统旁路保留）。
- **R24 P2 收敛机制**：首个**带证据**（evidence≠E0）的 flag 候选出现 → 其余在跑会话收提示、宽限期满被停；赢家与任务状态不动、每任务一次。`BUMIMANG_CONVERGE=off` / `BUMIMANG_CONVERGE_GRACE_MS`（默认 30s）。
- **R25 A7 安全边界**：按会话签发令牌、连接绑定身份（冒用 sessionId 拒绝）、wire/stream 日志令牌脱敏。
- **R26 A3+A4+A6**：启动失败回滚（握手超时可配）+ 审批落库（超时不再计人工退避、approvals 表 + kind=approval 事件）+ witness 入哈希链 + 回滚恢复链尾。
- **R27 A1 任务级工作目录**：`<workRoot>/<taskId>` 每任务专属（cwd/越界检查/简报/MCP env/E2 证据回放全按任务），TaskView.workDir 新增，任务卡显示任务目录。

**验收（全绿）**：verify:all = 52+16+17+19+90+139 = **333** exit=0；electron --verify **20/20**；渲染层 11 套件 + smoke 全 ALL_PASS；**17:41 重打包**——打包态 20/20、绿色包证据 20/20、asar 10/10（含 R21/R22 内容）。**遗留**：A2 租约跨任务互斥语义未定（复合键）、OS 级沙箱（Job Object）、真实 A/B 复测（烧 token，等用户点头）、NSIS 安装流程（B-4，需干净机器）、`.probe/packaged-flow.mjs` 的产物路径断言需跟任务目录走。

**2026-10-20 17:08（R22，见 [`docs/done/R22-codex-review-triage.md`](done/R22-codex-review-triage.md)）**：**Codex 外部评审已分诊**——A1–A11/P1–P5/T1–T6 逐条验真（命中率极高，验证过程与逐条结论在 R22 文档里）。**已修 3 个真 bug**：A11 黑板积压 >200 条事件永久跳页（游标分页排空，+2 断言）；T2 A/B 工具的 boardReads 没接回调（假指标）；ab 工具错误时仍 exit 0 + 新增首答时间指标。**勘误**：上一轮 AB-1 文档「boardReads=0 ⇒ 简报没被消费」是错的（wire 实测 5/9/9/21 次读板），「3 会话没省时间」口径修正为「首答快 15%、收尾慢一倍、缺收敛机制」——**「首个有效结果 → 收敛其他会话」是下一个产品核心轮次**。验收：verify:all **279** exit=0、verify-history **68/68**、electron --verify 19/19、打包态 19/19 + asar 10/10，dist 已重打包（17:07）。

**2026-10-20 16:34（AB-1 + R21，见 [`docs/done/AB-first-real-run.md`](done/AB-first-real-run.md)、[`docs/done/R21-session-remove.md`](done/R21-session-remove.md)）**：

- **A/B 首次真跑完成，拿到 flag 已报告**：`flag{11519b171bc24ec99afe0c017a2aabfa}`（hbc2.haobachang.com:16516 `/tmp/flag.txt`，手法与台账见 `docs/CTF-台账-hbc2.md`）。对照（样本 1，含 17:05 勘误后的口径）：**首答时间三路快 15%**（58.8s vs 69.5s），但全队收尾慢一倍（157.9s vs 79.0s）、工具调用多 4.5 倍、flag 被写两遍——真问题是**缺「首个有效结果 → 收敛其他会话」机制**。「boardReads=0」是我当时的误读（A/B 工具没接 onBoardRead 回调），wire 实测各家读板 5/9/9/21 次，已修工具并新增首答指标。要下结论需再跑 2 次取中位数。
- **session.remove 落地（用户拍板：保留历史、只隐藏）**：点 × 关标签真移除，库里 hidden 标记、历史不删，恢复=翻 hidden 回 0（UI 恢复入口留给下一轮）。验收：verify-history 66/66、verify-r18 **110/110**（含活进程移除全链）、verify:all **277** exit=0、electron --verify 19/19、打包态 19/19 + asar 7/7，dist 已重打包（16:33）含 R21。
- **连带修 3 个存量 stale 渲染套件**（10-13 全量扫过后 R16/R17/T14 引入、一直没人重跑）：cold-start（R16 徽标改名）、r1-verify（R17 任务过滤丢写死 taskId）、approval-verify（T14 引擎摘要）。**12 个渲染 electron 套件全量重扫全绿。**

**2026-10-20 16:08（R20，见 [`docs/done/R20-repack-and-packaged-verify.md`](done/R20-repack-and-packaged-verify.md)）**：**R19 已进 dist。** 重打包（16:06）+ 打包态复验全过：win-unpacked `--verify` 19/19；安装包+绿色包重出；app.asar 静态核查 6/6（task-switch 样式、loadTaskSessions 等）；绿色包实跑证据文件 19/19（16:08:32）。零源码改动，新探针 `.probe/asar-r19-check.cjs`。**待用户拍板**：session.remove 语义（关标签要不要保留历史回看，建议保留只隐藏）、A/B 量化需要一道有确定解法的真题。task.update/task.delete 自包含可直接做。

**2026-10-20 新增（R16，见 [`docs/done/R16-history-workdir-hints-task-status.md`](done/R16-history-workdir-hints-task-status.md)）**：

1. **对话记录会保存**：每个会话写 `stream.jsonl`，重启后历史会话和对话内容都还在（只读回看；要接着跑需新建会话）。新增 IPC `hub:history`。
2. **工作目录固定**：agent 的 cwd、简报指令、`fs/write` 与 `terminal/create` 的越界检查全部指向 `D:\agent\xuanwo\work`（可用 `BUMIMANG_WORKDIR` 覆盖）。运行时数据库/日志仍在应用 workspace，不混在一起。
3. **可以给 agent 发提示了**：每个会话窗格底部有输入框（Enter 发送 / Shift+Enter 换行）和「打断」；agent 在跑时提示排队，当前轮结束后送达。
4. **任务栏有状态**：待解 / 解题中 / 已解出 / 已放弃；可人工填答案「标记已解出」，flag{...} 只做候选提示，不自动判题。
5. **codex 报错已修**：策略判定前补工具名（不再每次黑板调用都弹审批）、guarded 从 read-only 改 workspace-write、MCP 工具补 annotations（修 `approval policy is never`）。真实回归：`npm run verify:codex-mcp` 5/5。
6. **验收**：`npm run verify:all` = 140 条确定性 + 115 条渲染层 smoke，全过；electron `--verify` 19/19（打包态同样 19/19）。

**2026-10-20 评审回归（R17，见 [`docs/done/R17-task-isolation-and-review-fixes.md`](done/R17-task-isolation-and-review-fixes.md)）**：

- **任务隔离**：黑板写入按会话查库定位任务（不再用桥启动时固定的 taskId）；快照/审批/事件流都按当前任务过滤；切换任务时收尾旧会话。
- **codex 联网**：Windows 上 workspace-write 不保证拦联网（实测 curl 200、0 审批），UI 文案已改口，不再承诺「联网会问」；真正闸门需 OS 级方案，待排期。
- **flag**：按会话累计文本识别（跨 chunk 可拼），重启后重扫历史/事实恢复候选。
- **重启**：旧会话租约释放、claimed 意图 abandon，不再污染新会话简报；审批期会话状态为 `waiting_approval`，打断会清 pending 审批。
- **工作目录**：`isInsideDir` 加 realpath，junction/symlink 逃逸会被拦住；仍不是 OS 级 jail，文案已降级。

**2026-10-20 下午（R18 补记 + R19，见 [`docs/done/R18-shutdown-cross-task-leak.md`](done/R18-shutdown-cross-task-leak.md)、[`docs/done/R19-task-switch.md`](done/R19-task-switch.md)）**：

- **R18**：会话事件跨任务泄漏（Hub 异步回调 fail-closed 过滤）、`session.stop` 关闭超时（close 3s 上限 + finally kill）、正常退出竞态（shutdown 等真退出后才关库）、故障注入 kill 无效时 timedOut 先关门再收尾。新增 `npm run verify:r18`（94/94）。上一窗口只留了代码没留文档，本窗口已补记。
- **R19 任务切换**：R17 留的「切回旧任务」缺口补上——`HubSnapshot.tasks` + `task.switch`；任务卡有多个任务时出现「切换」按钮，弹列表点一个即可切回（先收尾旧任务活会话，切后载入该任务会话进内存 + 重扫 flag 候选）。顺带补「标记已放弃」入口、修正 blocked 会话卡 title 的「同一规则」→「同一动作」。
- **验收**：`npm run verify:all` = 49+16+17+19+54+94 = 249 条确定性 + smoke，全绿；electron `--verify` 19/19。**未重打包**（R19 是纯源码改动，dist 不含）。

**三十秒上手**：

```powershell
cd D:\agent\xuanwo
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox
# 无头自检（11 条断言，证明 IPC/三栏/契约都通）：
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
```

起来后点左栏「＋ 新任务」填你的题，选 `claude` + `guarded` 起会话——这是唯一一条从零到有产出的完整路径。

**四件已经用真实 agent 验过的事**（不是模拟）：窗口跑在真实后端上、审批真能拦住 agent、黑板真能被读写、三会话真并行。各有截图，见 §10 证据索引。

**一条最重要的发现**：三家 agent 默认都不/很少请求授权，但本应用会把三家都武装起来（机制各不相同：claude 原生 / opencode 注入配置 / codex 切 mode）。详见 §4。

**2026-10-13 12:47 新增（两件事，都与"加第四家"有关）**：

1. **DeepSeek Harness（dsh）接入侦察已完成，结论是本地那份就能用、不用下载**——
   `<安装目录>\resources\runtime\cli\bin\dsh.cmd --profile acp` 就是标准 ACP v1 stdio server，
   `DSH_PERMISSION_MODE=read-only` 能让它像 codex 那样问权限（均实测）。施工清单见
   [`docs/DSH-INTEGRATION-RECON.md`](DSH-INTEGRATION-RECON.md)；`BLOCKED.md` 末尾有对旧判断的勘误 D-1。
   **注意**：`detect.ts` 现在找的 `dsh-acp` 命令永远不会存在（npm 包没有 bin），别沿着那条路走。
2. **发给队友的说明**：[`docs/FOR-TEAMMATES.md`](FOR-TEAMMATES.md)——发哪个文件、校验和、
   队友必须先装什么（应用不含 agent）、第一次打开会遇到什么、以及"还没验过什么"。

**2026-10-13 13:12 新增（第四家 agent 已落地）**：**dsh 不再是"未安装/未知"**——Lane A 把上面那条
侦察结论做完了（`docs/done/T14-dsh-fourth-engine.md`）：`detect.ts` 三级发现（override / PATH /
env 根目录 + Windows 卸载注册表项 `InstallLocation`，本机就是靠注册表命中自定义安装目录），
spawn 一律包成 `cmd.exe /c <安装目录>\resources\runtime\cli\bin\dsh.cmd --profile acp`；
`manager.ts` 按档注入 `DSH_PERMISSION_MODE`（**guarded=read-only 会问 / autonomous=workspace-write 不问**，
`BUMIMANG_ARM_DSH=off` 可关），并在主进程按 `toolCallId` 把动作名补进审批 `detail.title`
（dsh 的权限请求只带 id，原本卡片会写「未命名工具调用」，现在实测是 `write`）。
实跑证据：`npm run verify:dsh-live` **32/32 ALL_PASS**；界面端到端探针 `.probe\dsh-ui-flow.mjs`
**dev 与打包态各 18/18**（左栏可用 → 中栏标签页 20 块流 → 右栏审批 `write` → 点放行 → 文件真写出）；
渲染层 stale 断言由 Lane A 接管修完（Claude 派了但零产出，见 `docs/done/R15-dsh-ui-lane-b-taken-over.md`）；
`npm run verify:all` **100/100**；13:11 `npm run pack` exit=0，**dist 这一版含 T14**。

**现在没有待你决策的事项**（B-3 已闭环，全程未碰任何用户配置文件）。

**队友要装就用打包产物**（08:03 起可用）：

```powershell
cd D:\agent\xuanwo
npm run pack      # 出 dist\不迷茫 Setup 0.1.0.exe（安装包）与 dist\不迷茫 0.1.0.exe（绿色包）
```

两个都在打包态实跑验证过（11/11）。**注意**：数据落在 `%APPDATA%\bumimang\`（不是文档里写的"不迷茫"——Electron 的 `app.getName()` 读 package.json 的顶层 `name`；我保留 ASCII 路径以免工具链踩编码问题）。**应用图标已做**（`assets/icon.ico`，7 个尺寸）；**代码签名还没做**，队友首次运行会看到 SmartScreen 警告。

**未完项按优先级**：① **NSIS 安装流程没验过**（`BLOCKED.md` 的 B-4，需你授权或一台干净机器）——安装包只做了只读载荷检查，没真装过；② "省时间"的 A/B 量化（工具 `npm run ab` 已就绪，但需要一道有确定解法的真题才能跑出数字）；③ 代码签名（证书是商业决定，不签则队友首次运行看到 SmartScreen 警告）；④ 干净机器上的"新机器第一次打开会缺什么"；⑤ ~~dsh 适配器未装（RC，需授权）~~ **已闭合（13:12，T14）**：dsh 是四家之一、装了就是可用、guarded 档真的会问；剩 `dsh` 的 `session/list`/`resume` 与我们「blocked = 新会话」模型的交互未验。

> 已闭合：多会话真并行、并发抢租约、`blocked` 终态（含真实 UI 拒绝路径）、打包分发、L-3 黑板可达、B-3 两家武装、UI 拒绝链。每条都能在 `docs/done/` 里找到完成文档与可重跑命令——08:59 机械核过一遍，8 条全部对得上。

**两条 lane 怎么协作**（若你也要开个 agent 一起干）：协议在 `docs\EXECUTION-PLAN.md` 第 0 与第 2 节——目录独占、契约冻结、`PROGRESS.md` 与 `BLOCKED.md` 只追加、每任务写 `docs\done\<ID>-<短名>.md`。

**新增一个重要提醒**：`BUMIMANG_ARM_OPENCODE=off` / `BUMIMANG_ARM_CODEX=off` 可关掉两者的闸门武装。

---

## 一、三十秒版本

雏形**能跑**，而且四条关键链路都用真实 agent 验过了：

1. **一个 Electron 窗口，三栏布局，跑在真实后端上** —— 左：任务 / 会话列表 / 加号扇出 / 规则包徽标；中：多窗格实时事件流；右：审批队列 + 黑板台账。
2. **人工审批边界真的能拦住 agent** —— 真实 claude 发权限请求 → 审批卡片出现 → 人工放行 → agent 才继续。截图 `docs/logs/real-approval.png`。
3. **共享黑板真的能被 agent 读写** —— 真实 claude 主动调了 3 次 `blackboard_read_since`，并**主动**写了一条死路。截图 `docs/logs/real-board.png`。
4. **多会话真并行真的能跑** —— 三个真实 claude 会话并排跑同一道题（lead=guarded / verify=autonomous / recon=guarded），三窗格各有独立实时流，健康度每会话独立；而且**后起会话的简报真的带上了先起会话刚写的死路**。截图 `docs/logs/real-parallel.png`。

**最大的坑不在代码里**：三家 agent 对"要不要问人"的态度完全不同，而且**默认都不或很少问**。B-3 解决后，本应用会把三家都武装起来（三家机制各不相同），详见第四节。

---

## 二、怎么跑起来

```powershell
cd D:\agent\xuanwo

# 1. 起界面（真实后端 + 真实 IPC）
node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox

# 2. 无头自检（9~10 条断言，证明 IPC 与三栏都通）
node_modules\electron\dist\electron.exe apps/desktop/src/main/electron/main.ts --no-sandbox --verify
```

**首次在一台新机器上要做的两件事**（都写进了 BLOCKED 与完成文档）：

```powershell
# Electron 二进制必须走镜像，GitHub 直连不通
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node node_modules\electron\install.js

# 若要 codex / claude 也能被驱动（本机已装，队友机器需要）
npm i -g @agentclientprotocol/codex-acp @agentclientprotocol/claude-agent-acp
```

界面里没有"演示数据"。起来之后面板大多是空的——**这是老实话，不是 bug**：审批队列空是因为还没有 agent 请求授权（见第四节），黑板空是因为还没有会话往里写。

**想立刻看到东西**：点左栏的加号（primary 按钮"起第一个会话"），选 `claude` + `guarded`，然后让它改一个文件。审批卡片会出现。

---

## 三、一个晚上做出来的东西

| 层 | 内容 | 规模 |
| --- | --- | --- |
| Lane A（Codex） | 黑板（SQLite WAL / 三写一事务 / 哈希链）、ACP 客户端（手写 JSON-RPC）、MCP 主机（命名管道 + 一次性令牌 + stdio 子进程）、会话管理器、简报包、策略引擎、审批队列、Electron 主进程 + IPC、7 个验收/探针脚本 | 177 KB |
| Lane B（Claude Code） | 渲染进程（三栏 / 多窗格 / 审批 / 台账 / 扇出）、时间线旁路、自定义 `bumimang://` 协议（免 bundler 跑 TS）、blocked 与崩溃的视觉区分、空状态诚实化、多套验收脚本 | 279 KB |

**验收脚本**（全部可重跑）：

```powershell
npm run m1                       # M1 基础闭环（会话 + 简报 + 黑板）
npm run probe                    # 三家 agent 握手与能力
npm run probe:delegate           # 三家是否把命令执行委托给客户端
npm run verify:gate              # 策略引擎 + 审批队列 + 拒绝退避（49/49）
npm run verify:gate-live         # 闸门活体：假 agent 走真实 stdio（16/16）
npm run verify:briefing          # 简报包三会话扇出（17/17）
npm run verify:agent-permission  # 真实 agent 会不会请求授权
npm run verify:mcp-live          # 黑板对真实 agent 可达性（2/2）
npm run verify:arm-opencode      # 武装 opencode 闸门（四场景：baseline/project/inline/via-app）
npm run verify:arm-codex          # 武装 codex 闸门（三种 mode + via-app）
npm run verify:concurrency       # 并发抢租约 + blocked 终态端到端 + 进程回收（18/18）
npm run ab -- --dry              # A/B 量化工具自检（不带 --dry 才会真跑，烧 token）
npm run pack                     # 打包：NSIS 安装包 + 绿色包
```

**一条命令跑完四个确定性套件**（共 100 条断言，任一条失败即停）：

```powershell
npm run verify:all
```

注意它**不含**需要真实 agent 的套件（`verify:mcp-live`、`verify:arm-opencode`、`verify:arm-codex`、`verify:agent-permission`——它们会 spawn 真 agent 并烧 token），也不含 Lane B 在 `apps/desktop/electron/` 下的十个套件。别把它们当"已经跑过"。

**回归结果**（2026-10-13 09:42 实测；夜末 04:34 那版是它的子集）：

```
verify:gate         49/49 通过
verify:gate-live    16/16 通过
verify:briefing     17/17 通过
verify:concurrency  18/18 通过
verify:mcp-live      2/2  通过（真实 claude）
打包态 --verify      11/11 通过（win-unpacked 与 portable 各一次）
Lane B 侧：smoke / render-verify / push-verify / r1-verify / gate-empty-verify /
           blocked-hostile-verify / real-bridge-verify / real-approval(23/23) /
           real-board(24/24) / real-parallel(34/34)  全 PASS
```

**文档自检（08:07）**：把本文档里提到的每个仓库内路径、`npm run` 脚本名、证据文件都对文件系统核了一遍——**全部存在，无失效引用**。（第一次跑这个检查时是我的正则写错了，报了几个假缺失；修正后为零。）

---

## 四、最重要的一条：三家 agent 对"问人"的态度完全不同

这是整晚最有价值的发现，也是唯一会改变产品定位的东西。

| agent | 要改文件时 | 要跑命令时 | 结论 |
| --- | --- | --- | --- |
| **claude** | **会问** ✅（3/3 次实测） | **看命令分量**：无害 `echo` 不问（3/3 次），但读源码/枚举命名管道/grep 会问（简报轮发了 11 条） | **原生可用** |
| opencode | 原生不问 → **本应用武装后问** ✅ | 同左 | **本应用可用**（自动注入 `permission.edit/bash="ask"`，见 B-3） |
| codex | 原生不问 → **本应用武装后问** ✅ | 同左 | **本应用可用**（guarded 档切原生 mode `read-only`） |

另外一条同样重要：**三家 agent 都不把命令执行委托给客户端**（`terminal/create` 与 `fs/*` 实测各 0 次）。它们自己跑命令，只在 `session/update` 里报告。

把这两条合起来看，架构文档 §4.1 的说法要再补一层：**"L2 咽喉"的两个入口（委托 + 请求授权），在默认配置下几乎都是关着的。** 唯一真正能拦住 agent 的通道是 `session/request_permission`，而它只在 claude 上开箱有效。

**给你的建议**：三家现在都能出审批输入，**全部由本应用自动武装，不需要你改任何文件**。`dsh` 已于 13:12 接入（T14，见上），四家都能按档出审批输入。

**但有一条不对称要知道**：对 claude / opencode，档位只决定"问了之后要不要人工放行"；**对 codex，档位决定它问不问**（`guarded` → 切 `read-only` 所以会问；`autonomous` → 保持默认所以不问）。同名的"档位"在三家之间语义不同，UI 上还没说清这一点。

---

## 五、不能跑什么 / 没有验证的

按"有多要紧"排。**原来排第一的"多会话真并行"已在本夜闭合**（§1 第 4 点：真实三会话 34/34 通过，机制侧另有确定性验收 17/17），因此从下面移除。

1. **"省时间"本身没被量化。** 画面与机制都验了，但**没有做过 A/B**：同一道题用 1 个会话 vs 3 个会话，到底快多少、多烧多少 token。这是产品主张的最后一块空白。
2. **写类黑板工具只验了一个。** `blackboard_declare_dead_end` 在真实 claude 上验过（主动写的）；`submit_fact` / `acquire_lease` 在真实 agent 上没单独验。
3. ~~`waiting_lease` 与并发抢租约没验过。~~ **已闭合（08:06）**：20 个会话同抢一个资源 → 恰好 1 WON / 19 LOST（`npm run verify:concurrency`）。竞态在设计上不存在——串行写队列 + CAS + 资源主键。
4. ~~`blocked` 终态的端到端没验。~~ **已闭合（08:06，08:42 补全 UI 路径）**：先给假 agent 加了 `FAKE_REPEAT` 从队列侧验（终态 blocked、`scope=blocked` 死路、**没有**写崩溃记录）；随后 Lane B 补上**真实 UI 路径**——真实 claude + 真实窗口 + 真实点 DOM「拒绝」按钮两次 → 会话转 `blocked` → 会话卡画「被策略切断」（不是「崩溃」）→ 台账出现该死路，全 PASS。路上还抓出并修掉了 `prompt()` 覆盖终态的竞态（BLOCKED L-4）。
5. ~~没有打包。~~ **已闭合（08:03）**：安装包与绿色包都出了，且都在打包态跑通 11/11。剩下的缺口是"没在干净机器上试过"——本机有 electron 缓存与全局装的适配器，真正的首次体验仍未被验证。
6. **没有多机共享黑板。** 这是当初明确排除的（C2），现在仍是本机单进程。
7. ~~首次启动引导没做。~~ **已闭合（09:31）**：可关闭的「开始之前」浮层四段——哪些引擎会产生审批（读 `permissionBehavior`，不硬编码）、什么动作会打断（只讲实测数字并明说样本小）、数据在哪、怎么开始；dismiss 用渲染进程自己的 localStorage，不加契约字段。**19/19**。
8. **规则包不能运行时切换**，只能改 `BUMIMANG_RULES` 环境变量重启。
9. **成本统计没做**（§8.7 决定不显示不准的数字，所以只有运行时长与 tool call 数）。

---

## 六、下一步三步

**第一步：把"省时间"量化（原第一步已闭合，这是它的下一步）。**
画面与机制都验完了（§1 第 4 点），但**没有人测过到底快多少**。做法：选一道有确定解法的题，分别用 1 个会话与 3 个会话各跑一次，记录墙钟时间、token 消耗、是否出现重复劳动。有了这组数字，"1 加到 3 省时间"才从"看起来对"变成"量过"。

**第二步：让 opencode / codex 也武装起来（需要你先拍板 B-3）。**
opencode 配 `permission.edit` + `permission.bash`；codex 配沙箱审批策略。两家都武装之后，"四家 agent 一个闸门"才成立。这一步的前提是改它们的全局配置，按规矩得你点头。

**第三步：首次启动引导 + 在干净环境验一遍。**
打包已完成、镜像已固化进 `.npmrc`（这是关键——不写进仓库每个人都要重踩）。现在缺的是：给一个陌生人用的引导（"哪些 agent 可用、闸门武装了没有、下一步该点什么"），以及**在一个干净环境里真的走一遍安装→启动→起会话**。本机不算干净环境。

---

## 十三、白班收尾（10:29）

### 最终验证快照（全部实跑，全绿）

| 套件 | 结果 | 需要真 agent |
| --- | --- | --- |
| `npm run verify:all`（确定性四套件） | **100/100**（49 + 16 + 17 + 18） | 否 |
| `npm run verify:mcp-live` | **2/2** | 是（claude） |
| `npm run verify:arm-opencode` | via-app **=1**（baseline=0 / project=1 / inline=1） | 是（opencode） |
| `npm run verify:arm-codex` | via-app **=1**（read-only=1 / workspace-write=0 / agent=0） | 是（codex） |
| Lane B 侧 14 个套件 | 全 PASS（含打包态 UI 27/27、UI 拒绝 43/43、首次引导 33/33） | 部分是 |

### 交付物

```
安装包    dist\不迷茫 Setup 0.1.0.exe   108.4 MB（09:40 重打，含 L-4 与退避签名修复）
绿色包    dist\不迷茫 0.1.0.exe         108.2 MB（同上）
完成文档  docs\done\                    48 份
截图证据  docs\logs\                    36 张
npm 脚本  15 个（含 verify:all 总入口）
代码规模  Lane A 231 KB / Lane B 570 KB
```

### 白班这一轮（07:00→10:30）补了什么

1. **打包分发**（最大的未完项）：出安装包与绿色包，两个都在打包态实跑 11/11
2. **两个验证缺口**：并发抢租约（20 个同抢恰好 1 WON）、`blocked` 终态端到端（含进程回收）
3. **三家闸门全部武装**：claude 原生、opencode 注入配置、codex 切原生 mode —— 全程未碰任何用户配置文件
4. **两个真 bug**：L-3（黑板对真实 agent 不可达）、L-4（`prompt()` 把 blocked 覆盖回 idle），加一个我引入的设计缺陷（退避计数按规则 id 而非动作内容）
5. **应用图标**、**首次启动引导**、**`verify:all` 总入口**
6. **dist/ 过期问题**：发现 08:24 打的包不含 08:42 的修复，已重打并复验

### 现在停下的原因

**没有可做的活了**：未完项要么需要你（B-4 安装流程授权）、要么需要环境（干净机器）、要么需要你给一道真题（A/B 量化）、要么是商业决定（代码签名）。继续跑只会烧 token 而不产出结论，所以**自动化已停**。

回来时的第一件事建议：按 §2 的命令起界面，点「＋ 新任务」填你的题，选 `claude` + `guarded`。首次打开会看到「开始之前」浮层，它把"哪家会产生审批、什么动作会打断你、数据在哪"一次讲清。

---

## 七、待你决策（只有一条）

**B-3 已解决，无需你决策**（2026-10-13 07:30）。结论：不需要改你的全局配置，也不需要往仓库放配置文件——应用在启动 opencode 会话时按会话注入 `OPENCODE_CONFIG_CONTENT`（只带 `permission.edit/bash = "ask"`），实测四场景全过（见 `docs/done/B3-arm-opencode-gate.md`）。要关掉就设 `BUMIMANG_ARM_OPENCODE=off`，无需回滚任何用户文件。

现在**没有待你决策的事项**。

---

## 八、这一晚踩过的坑（都会在队友机器上重现）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| Electron 二进制下载 | `npm install electron` 只装包不下二进制，首次运行 `fetch failed` | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| Electron stdout | `> file` 重定向会丢输出，看起来像程序没启动 | 用管道：`2>&1 \| Select-String` |
| 多实例抢 profile | 两个 Electron 共用默认 userData 会抢文件锁并直接退出 | `app.setPath("userData", <项目内目录>)` |
| Electron 44 事件签名 | `console-message` 变成 `(event,{level,message})` | 写兼容两代的 handler |
| Node 类型剥离 | 不支持构造函数参数属性、`enum`、`namespace`（要代码生成，剥离只擦类型） | 用显式字段赋值 |
| MCP 子进程起不来 | Electron 主进程里 `process.execPath` 是 electron.exe | `ELECTRON_RUN_AS_NODE=1` |
| 自定义 scheme 导航 | `bumimang://app/...` 不会命中 handler | 必须写 `bumimang://./...` |
| protocol handler 内读盘 | 会卡死且不抛错 | 启动时一次性读进内存，handler 只查表 |
| 会话 id 跨进程撞主键 | `s1` 每进程从 1 起，同一 board.db 第二次进程会撞 | 序号从库里算 |
| 规则写错 action | C2 硬阻断规则匹配 `terminal/exec`，而 agent 从不发这个 | 规则必须对着**实际会发生的** action 写 |

---

## 九、夜间协作复盘（给下次两条 lane 并行用的）

**有效的做法**：

- **契约先冻结再并行。** `packages/shared-protocol/events.ts` 冻结之后，Lane B 的 UI 在我接上真实 IPC 时**一行代码都没改**就切过去了。
- **目录独占代替加锁。** 两条 lane 各改自己的目录，一个晚上零冲突。
- **完成文档 + 只追加进度日志。** 醒来先读 `PROGRESS.md` 和 `docs/done/` 就能接上。
- **对方报的 bug 优先修。** Lane B 报了 L-3（黑板不可达）和会话 id 撞主键，两个都是真 bug，修完价值很大。

**翻过车的**：

- **BLOCKED.md 被整篇覆盖过一次**（Lane B 重写而不是追加）。之后定了"只追加"规则。
- **我三次把时间戳写超前**（凭感觉写，不查系统时钟）。这条最丢人，已写进教训。
- **单次测量当结论。** 我用一次 `echo` 就下了"claude 不问命令"的结论，被 Lane B 的 11 条真实审批推翻。样本量 1 不能当规律。
- **依赖不可达会被放大。** agent 连不上黑板时，它会自己逆向排障——11 条额外审批 + 一整轮时间。**故障要主动告知 agent，别让它自己撞。**

---

## 十、证据索引

| 文件 | 是什么 |
| --- | --- |
| `docs/logs/real-approval.png` | **审批端到端**：真实 claude 的权限请求出现在审批面板 |
| `docs/logs/real-board.png` | **黑板台账真实内容**：真实 claude 写的死路 |
| `docs/logs/real-parallel.png` | **多会话真并行**：3 个真实 claude 会话并排，各有独立实时流 |
| `docs/logs/real-bridge-{empty,started,approvals}.png` | 三栏布局 / 扇出后 / 有审批时 |
| `docs/logs/ui-verify.json` | IPC 与三栏自检结果 |
| `docs/done/` | 每个任务的完成文档（14 份） |
| `docs/PROGRESS.md` | 完整进度日志 |
| `docs/BLOCKED.md` | 已解决的坑 + 待决策事项 |
| `docs/ARCHITECTURE.md` | 设计基线（v0.5，含实测修订） |

---

## 十一、夜班收尾（05:34）

计划里的任务全部做完并验证过，最后补了一次**全新状态冷启动**：

```powershell
Remove-Item -LiteralPath "D:\agent\xuanwo\.ui-run" -Recurse -Force
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
# → 11/11 通过（自建 board.db、自建 Electron profile、检测 4 家 agent、三栏渲染）
```

**收尾时发现并修掉的一件事**：`.ui-run/`（运行期状态：board.db、十几个 Electron profile、agent 工作目录）**不在 `.gitignore` 里**，而且我在 `T2-T5-T11-real-ipc-wired.md` 里写过"整体已忽略"——**那是错的**。已补。这条记下来是因为它说明：完成文档里"已知问题"那一节也会凭印象写错，跟"时间戳凭感觉"是同一类错误。

**收尾时明确的一个判断**：冷启动自动种"示例任务"这个行为**保留**。空界面比假任务更让人困惑（Lane B 第 11 轮 QA 把"中栏一片空白"列为第一处困惑），而第 12 轮加的「＋ 新任务」入口已经让用户能换成自己的真题——两个需求都满足了。

**留给你的第一件事建议**：按 §2 起界面，点「＋ 新任务」把你今天的真题目填进去（简报字段最重要，它会被注入到每个会话），然后选 `claude` + `guarded` 起一个会话。这是唯一一条"从零到有产出"的完整路径，也是最该先走一遍的。

---

## 十二、最后一小时（07:18）

窗口到点时补完的最后一件东西：**A/B 测量工具** `npm run ab`（见 `docs/done/AB-measurement-harness.md`）。

```powershell
npm run ab -- --dry                            # 只验工具本身，不烧 token（已通过）
npm run ab -- --brief "你的真题" --sessions 3   # 真跑，出对照表
```

它把 §5 第 1 条那条空白变成了可执行的动作：1 会话 vs 3 会话的墙钟时间、工具调用、黑板产出、审批次数、以及跨会话的疑似重复劳动。**但数字还没跑**——需要一道有确定解法的真题，以及 4 个真实 agent 轮次的时间与 token。这件事留给你。

另外一条完整性说明：Lane B 第 13 轮（会话级成绩显示，`session-scorecard.png` + `scorecard-verify.ts`）**代码与验证都产出了，但它忘了写完成文档与进度行**。我在收尾时核对了文件与时间戳，确认产出真实存在，这里补记。
