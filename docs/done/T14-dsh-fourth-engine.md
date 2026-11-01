# T14 把 DeepSeek Harness 接成第四家 agent（Lane A）

> 2026-10-13 13:03 · Lane A（Codex）。依据：`docs/DSH-INTEGRATION-RECON.md`（侦察结论全部按实测采用，未重复验证）。
> Lane B 的两项渲染层改动（`gate.ts` 文案 + 审批卡可读性）与相关套件断言由 Claude 在本轮并行完成，见 `docs/done/R15-dsh-fourth-engine-ui.md`。

## 做了什么

1. **发现（`discovery/detect.ts`）**：dsh 改成三级解析，全部命中后一律包成
   `cmd.exe /c <安装目录>\resources\runtime\cli\bin\dsh.cmd --profile acp`：

   1. 用户 override（`%APPDATA%\不迷茫\agents.json` 的 `dsh`；接受 **CLI 路径 / 安装目录 / 裸命令名** 三种写法）；
   2. PATH 上的 `dsh` / `dsh.cmd`（桌面版那个 PATH 管理器启用后会有；本机没启用）；
   3. 常见安装位置 —— **env 推导的已知根目录**（`%LOCALAPPDATA%\Programs`、`%LOCALAPPDATA%`、
      `%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramData%`、系统盘根）+ **Windows 卸载注册表项的
      `InstallLocation`**（`reg query ... /s /f "DeepSeek Harness" /d`，取不到再退回 `DisplayIcon` / `UninstallString`）。

   一个本机路径都没写死：本机装在自定义目录 `D:\agent\DeepSeek Harness`，是被**注册表**找到的
   （实测 `source=registry`）；`where dsh` 至今查不到。**旧的 `resolveLaunch("dsh-acp")` 整条删掉** ——
   npm 上 `@deepseek-ai/dsh-acp` 是 cordis 插件、没有 bin 字段，那条路设计上永远查不到东西（BLOCKED 勘误 D-1）。
   `installHint` 改成「装 DeepSeek Harness 桌面版（它自带 dsh CLI）；装到非常规位置时把 agents.json 的 dsh 指到
   `<安装目录>\resources\runtime\cli\bin\dsh.cmd`」；`permissionBehavior` 从 `unknown` 改成
   `requests_by_default`（语义是「本应用这样跑它，guarded 档会不会有审批输入」）。

2. **按档武装（`session/manager.ts`）**：与 codex 同构，**只在 spawn 时注入环境变量**，不碰它任何配置文件：

   | 档位 | 注入 | 实测 request_permission |
   | --- | --- | --- |
   | guarded | `DSH_PERMISSION_MODE=read-only` | 1（问） |
   | autonomous | `DSH_PERMISSION_MODE=workspace-write` | 0（不问，沙箱仍封在工作区） |

   开关：`BUMIMANG_ARM_DSH=off` 可整体关掉（与 `BUMIMANG_ARM_OPENCODE` / `BUMIMANG_ARM_CODEX` 一致）。

3. **审批卡可读性（也在 `manager.ts`，不碰冻结契约）**：dsh 的 `session/request_permission` **只带
   `toolCallId`，没有 title / kind**，所以卡片本来会画成「未命名工具调用」。现在 manager 从流里把
   `toolCallId → 动作名` 记下来（前面那条 `tool_call` update 是带名字的），审批时补进 `detail.title`。
   实测：`{"toolCallId":"call_00_xSn2…","title":"write","options":[…],"titleFrom":"tool_call"}`。
   契约零改动 —— `ApprovalView.command` 本来就吃 `detail.title`。

4. **新增实跑验收** `apps/desktop/src/cli/verify-dsh-live.ts`（`npm run verify:dsh-live`，31 条断言）。
   它走**应用自己的 `SessionManager`**（不是裸探针），所以证明的是接线而不是 agent 行为。

## 改了哪些文件

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop/src/main/discovery/detect.ts` | dsh 三级发现（新增 `resolveDshLaunch` / `findDshUnderRoots` / `dshFromRegistry`，可选注入 `roots`/`skipRegistry` 供验收）；删除 `dsh-acp` 路径；installHint / maturity / permissionBehavior 全部改正 |
| `apps/desktop/src/main/session/manager.ts` | 档位 → `DSH_PERMISSION_MODE` 注入（合并进统一的 `sessionEnv`）；`toolTitles` 关联表 + `withToolTitle()` 补审批动作名；会话退出清理该会话条目 |
| `apps/desktop/src/cli/verify-dsh-live.ts` | 新增：发现 / 握手 / 两档闸门 / 拒绝路径 / `session/close` 共 31 条断言 |
| `package.json` | 新增 `"verify:dsh-live"` 脚本（只加脚本，没加依赖） |
| `docs/logs/dsh-live.log`、`dsh-live-with-gui.log`、`verify-all-t14.log`、`lane-b-round25*.{txt,cmd}`、`claude-r25.*` | 本轮证据与派单/日志 |
| `docs/BLOCKED.md` | 勘误 D-1 标为「已落地」（只追加状态，不改历史结论） |

## 怎么验证的

前置（`EXECUTION-PLAN` §6 的坑）：跑之前先 `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`。

**1) 新增的 dsh 实跑 —— 31/31 ALL_PASS**（`docs/logs/dsh-live.log`）：

```powershell
cd D:\agent\xuanwo
npm run verify:dsh-live
```

```
  来源=registry 安装目录=D:\agent\DeepSeek Harness
PASS  临时根目录下扫一级子目录能命中（source=known）  — actual="known" expected="known"
  config: model = ["deepseek-official","deepseek-v4-flash"]
  config: reasoning_effort = high
  request_permission=0  tool_call 更新=4  文件=…\autonomous\sessions\s1\mode-probe.txt  stopReason=end_turn  close(4) 有响应=true
  request_permission=1  tool_call 更新=6  文件=…\guarded\sessions\s1\mode-probe.txt  stopReason=end_turn  close(4) 有响应=true
  request_permission=1  tool_call 更新=6  文件=无  stopReason=end_turn  close(4) 有响应=true
  审批 detail: {"toolCallId":"call_00_xSn2bhkGzJIpWOixFGRX2714","title":"write","options":[{"optionId":"allow-once",…,"kind":"allow_once"},{"optionId":"reject-once",…,"kind":"reject_once"}],"titleFrom":"tool_call"}
================ dsh 实跑验收：31/31 ALL_PASS ================
```

四条核心断言（施工清单 §3.3）逐条对上是：握手 `protocolVersion=1` + `agentInfo.name=deepseek-harness-acp`；
`session/new` 返回 `model` 与 `reasoning_effort`；**autonomous 档 0 次 request_permission 且文件真被写**；
**guarded 档 1 次、选项含 `allow-once`（kind=`allow_once`）**。另外三条是自己加的：放行后文件真被写、
同一档位**拒绝**时文件不被写（闸门真的挡住）、三次 `session/close` 都被回应。

**2) 既有主套件回归 —— 100/100（49+16+17+18，与改动前一致）**（`docs/logs/verify-all-t14.log`）：

```
cd D:\agent\xuanwo; npm run verify:all
================ 49/49 通过 ================
========== 16/16 通过 ==========
========== 17/17 通过 ==========
========== 18/18 通过 ==========
```

**3) `docs/DSH-INTEGRATION-RECON.md` §4 那三条「本轮没验过」的，逐条验了**：

1. **桌面版 GUI 开着的时候会不会打架** —— 开着 GUI（5 个进程）重跑整套：
   `================ dsh 实跑验收：31/31 ALL_PASS ================`（`docs/logs/dsh-live-with-gui.log`），
   而且跑完 GUI 进程 PID 一个没变（8400/24104/26416/26928/30076，启动时间仍是 12:59:25）——
   两套进程共用 `~/.dsh` 没有互相干扰，我们的会话也没有把 GUI 带崩。验完已把 GUI 收干净（先请求关窗、
   再结束遗留 PID，收尾后 0 个 DeepSeek 进程）。
2. **停会话时 dsh 走不走 `session/close`** —— 走。三次会话的 wire 日志里都能找到
   `{"jsonrpc":"2.0","id":4,"method":"session/close","params":{"sessionId":"64d1ed89-…"}}` 与
   `{"jsonrpc":"2.0","id":4,"result":{}}`（成功、空 result）。它的持久化落在
   `~/.dsh/sessions/<cwd-slug>/<acp-session-uuid>/session.v4.jsonl.zstd`，每会话一个 uuid 目录。
   三次会话全部退出后**没有残留 DeepSeek 进程**（`.cmd` 垫片会多一层 cmd.exe，所以专门查了孤儿）。
3. **装到别的目录时的路径发现** —— 验收脚本现造一棵临时安装树
   `%TEMP%\dsh-alt-install-*\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，用
   `resolveDshLaunch({roots:[临时目录], skipRegistry:true})` 断言命中、`installDir` 反推正确，
   并且「把安装目录本身当根」也能命中 → **解析只依赖「目录名 + 固定相对路径」，不依赖任何本机路径**。

## 没做什么 / 已知问题

1. **没跑需要真 claude 的 `real-*` 套件**（`real-approval-verify` / `real-parallel-verify` / `real-board-verify` /
   `real-bridge-verify`）—— 它们要真实 claude 会话与多轮 token，本轮没动它们依赖的任何代码路径。
2. **已知目录扫描的边界**：`findDshUnderRoots` 只扫「已知根目录 + 它们的一级子目录」。已知根全部由 env 推导
   （`%LOCALAPPDATA%` / `%ProgramFiles%` / `%ProgramData%` / `SystemDrive%`），**没有遍历所有盘符**（避免
   掉线网络盘把启动卡住）。所以「有人把绿色版解到 `E:\某临时目录\DeepSeek Harness`」这种情形要靠
   注册表项（安装器会写）或 `agents.json` override —— 已在 installHint 里说清。
3. **注册表探测有成本**：没装 dsh 的机器上多付一次 `reg query`（实测冷启 ~350ms、热 ~40ms），
   detect 每次 snapshot 都会重跑（沿用旧行为，没有加缓存）。装了 dsh 的机器反而更快命中。
4. **`toolTitles` 只保留最近 5000 条**（超了删最早 1000 条），会话退出时清该会话全部条目；跨会话不会串名。
5. **autonomous 档 ≠ 无人管**：它只是「不问」，dsh 的沙箱仍封在工作区（`workspace-write`）。
   「写工作区外会发生什么」本轮没测（recon §3.3 也没测）。
6. **仍未验 `session/list` / `resume` 与我们「blocked = 新会话」模型的交互**（recon §3.3 第 3 条，本轮仍未验）。
7. **`docs/ARCHITECTURE.md` 的 §6.3 仍是错的**（写着 dsh 适配器未装、Automation-only）—— 那是只读基线，
   本轮只在 `BLOCKED.md` 勘误、没走请求流程改它。
8. **Lane B 的渲染层断言会因本轮事实变化而红**（`smoke` / `cold-start-verify` / `tier-asymmetry-verify` /
   `first-run-verify` 里写着 dsh=unknown、未安装、下拉只有 3 家可用）—— 已随本轮一起派给 Claude（R15），
   不是本 lane 该改的文件。

## 下一手需要什么

- **Lane B（R15）**：`gate.ts` 把 dsh 从 unknown 改成「按档武装」（guarded 会问 / autonomous 不问），
  并修掉上面第 8 条那些断言；证据要求已写在 `docs/logs/lane-b-round25-prompt.txt`。
- **重打包**：`apps/desktop/src/main/**` 变了，所以**旧的 `dist\` 不含 dsh 支持** —— 要给队友就要
  `npm run pack`（本轮验收若已重打包，见文末「验收补充」）。
- **决策项（用户）**：要不要走 `docs/requests/` 改 `ARCHITECTURE.md` §6.3 的 dsh 判断与
  `HANDOVER` §4 的表述（本轮已就地把 HANDOVER 的 dsh 行改对，架构文档没动）。

---

## 验收补充（13:12 · Lane A 复跑 + 接管 Lane B 的渲染层）

派出去的 Lane B（Claude，`docs/logs/lane-b-round25-prompt.txt` → `lane-b-round25.cmd`）跑了 15 分钟
**一个文件都没写**（`claude-r25.log` 始终 0 字节），我按截止时间把它收掉、自己接管了渲染层（见
`docs/done/R15-dsh-ui-lane-b-taken-over.md`）。下面是这一轮的完整验收结果。

### 1. 渲染层改动（8 个文件，都是「dsh 不再是 unknown」这条事实的连锁修正）

| 文件 | 改了什么 |
| --- | --- |
| `src/renderer/gate.ts` | `sessionGateArmed` / `gateBadge` / `tierNoteFor`：dsh 与 codex 同款 —— guarded 会问（armed）、autonomous 不问（not_armed）；`unknown` 只留给未来新增的引擎 |
| `src/renderer/mock/data.ts` | mock 的 dsh 从「未安装 + npm 提示 + unknown」改成「已装 + 正确安装提示 + requests_by_default」（与 detect.ts 一致） |
| `src/renderer/smoke.ts` | 7 条 stale 断言对齐新事实（扇出名单「无」、dsh armed/not_armed、unknown 改拿 future-x 试、guide 名单 4/0、agentUsability 4/0） |
| `apps/desktop/electron/cold-start-verify.ts` | 3 条：快照 dsh=`requests_by_default`、引擎摘要「可用 4 · 未安装 0」、agent 下拉 4 家全可用 |
| `apps/desktop/electron/tier-asymmetry-verify.ts` | dsh 会话卡期望改成「闸门已武装 / gate-armed」+ fixture 对齐 |
| `src/renderer/first-run.ts`、`src/renderer/fanout/model.ts`、`apps/desktop/electron/first-run-verify.ts` | 注释与 fixture 说明对齐（`first-run-verify` 的 dsh 未安装 fixture **故意保留**：它现在兼职验「没装 → 灰显 + 提示」那条分支，真机复现不出来） |

### 2. 渲染层套件：10/10 全绿（`docs/logs/*-t14.log`）

```
node apps/desktop/src/renderer/smoke.ts                      → ALL PASS（exit=0）
electron.exe apps/desktop/electron/cold-start-verify.ts       → ALL_PASS
electron.exe apps/desktop/electron/tier-asymmetry-verify.ts   → ALL_PASS
electron.exe apps/desktop/electron/render-verify.ts           → ALL_PASS
electron.exe apps/desktop/electron/r1-verify.ts               → ALL_PASS
electron.exe apps/desktop/electron/gate-empty-verify.ts       → ALL_PASS
electron.exe apps/desktop/electron/blocked-hostile-verify.ts  → ALL_PASS
electron.exe apps/desktop/electron/scorecard-verify.ts        → ALL_PASS
electron.exe apps/desktop/electron/tabs-verify.ts             → ALL_PASS
electron.exe apps/desktop/electron/push-verify.ts             → ALL_PASS
```

### 3. 界面端到端（任务书 §6 第二条：**中栏标签页里能看到 dsh 的对话流**）

新写了独立探针 `.probe\dsh-ui-flow.mjs`（CDP 驱动真实窗口、真实 DOM 点击，**不改任何 Lane B 源码**）：

```powershell
node .probe\dsh-ui-flow.mjs 9344 dev     # 开发态入口
node .probe\dsh-ui-flow.mjs 9345         # 打包产物 dist\win-unpacked\不迷茫.exe
```

两次都 **18/18 ALL_PASS**（`docs/logs/dsh-ui-flow-t14.log` / `dsh-ui-flow-packaged-t14.log`），关键几行：

```
PASS  快照里 4 家 agent  — opencode,codex,claude,dsh
PASS  左栏有 DeepSeek Harness 一行且为可用态  — {"cls":"agent-item agent-installed","title":"DeepSeek Harness","hint":null,"startBtn":true}
PASS  dsh 会话已创建（快照出现 agent=dsh）   PASS  中栏出现 dsh 会话的标签页（agent 读作 dsh）
PASS  中栏 dsh 标签页里能看到对话流（.conv-block > 0）  — 20 blocks
PASS  审批卡的动作名可读（不是「未命名工具调用」占位）  — command="write"
PASS  经 UI 真实点击「放行」生效  — 1 条    PASS  审批决定由 human 落库  — status=approved decidedBy=human
PASS  放行后文件真的被写出来  — D:\agent\xuanwo\.ui-run\sessions\s6\ui-flow-probe.txt
```

截图：`docs/logs/dsh-ui-1-left-column.png`（左栏 4 家全可用）、`dsh-ui-2-dsh-tab-stream.png`（中栏 dsh 标签页 20 块流）、
`dsh-ui-3-approval-pending.png` / `dsh-ui-4-approval-approved.png`（审批卡待决/已放行，动作名 `write`）。

### 4. 主套件与实跑回归

- `npm run verify:all` → **100/100（49+16+17+18）**（`docs/logs/verify-all-t14.log`）；
- `npm run verify:dsh-live` → **32/32 ALL_PASS，exit=0**（新加第 32 条：什么都找不到时 `launch=null`，即「没装 → 灰显 + 安装提示」的数据侧）。

### 5. 重打包（让 dist 不再是旧的）

`npm run pack` → **exit=0**（13:11，`docs/logs/pack-t14.log`）；打包态再跑一次 UI 探针 **18/18**
（上面第 3 节第二条命令），所以 `dist\不迷茫 0.1.0.exe` / `dist\不迷茫 Setup 0.1.0.exe` 这一版**含 T14**。
