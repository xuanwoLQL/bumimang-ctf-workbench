# 新窗口提示词：把 DeepSeek Harness 接成第四家 agent

> 时间：2026-10-13 12:55 · 用途：开新窗口时整段复制粘贴。依据是 `docs/DSH-INTEGRATION-RECON.md`（全部实测）。

````text
# 任务：把 DeepSeek Harness 接成「不迷茫」的第四家 agent

## 0. 你在哪、先读什么

项目在 `D:\agent\xuanwo`：一个 Windows 原生 Electron 工作台，把本机已装的编码 agent 变成
「同一道题的多路并行解题队」，共用黑板，人工只处理边界。

按顺序读这五份，再动手：

1. `docs\HANDOVER.md` §0（接手须知：怎么跑起来、踩过的坑、两条 lane 怎么分）
2. `docs\DSH-INTEGRATION-RECON.md` —— **本次任务的依据，里面的结论全是实测的，不用重做**
3. `docs\PROGRESS.md` 最后 10 行（做到哪了）
4. `docs\BLOCKED.md` 末尾（勘误 D-1、B-4 待决）
5. `docs\EXECUTION-PLAN.md` 的 §0 硬规矩 / §2 文件所有权 / §5 完成文档格式 / §6 已知坑

## 1. 目标

让 DeepSeek Harness 出现在左栏引擎列表里、能起会话干活，并且**在受控档下真的会问权限**，
让右栏审批队列有输入。做完这一条，"四家 agent 都能被本应用武装" 就齐了。

## 2. 已经实测过的事实（别重复验证，直接用）

- 本机那份 `D:\agent\DeepSeek Harness` 是**完整可用的**，不用下载任何东西。
- 入口是它自带的 CLI：`<安装目录>\resources\runtime\cli\bin\dsh.cmd`。
  它内部就是 `ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals <app.asar 里的 cli.js> %*`。
- `dsh --profile acp` 起出来的是**标准 ACP v1 stdio server**（`acp` 是随包发行的 shipped profile，
  不要去 `--from-default-profile` 生成）。
  `initialize` 返回：protocolVersion 1、agentInfo `deepseek-harness-acp` 0.0.1、
  sessionCapabilities = close / list / resume；`session/new` 成功并暴露 `model` 与 `reasoning_effort`
  两个配置项（**是 codex 那种 `set_config_option` 模型，不是 claude 的 `set_model`**）。
- **闸门（核心）**：默认 `workspace-write` 下，让它写工作区内的文件 **request_permission = 0，文件真被写了**；
  起服务时给 `DSH_PERMISSION_MODE=read-only`，同一个动作 **request_permission = 1**，
  选项是 `allow-once` / `reject-once`（kind = `allow_once` / `reject_once`）。
  → 武装方式与 codex 完全同构：**按档位在 spawn 时注入环境变量**，不碰它任何配置文件。
- 我们的审批链路**不用改**：`apps/desktop/src/main/acp/client.ts` 挑「允许」选项是按
  `kind.startsWith("allow")` 选的，`allow_once` 天然命中。
- **别再走这条路**：`detect.ts` 现在找的 `dsh-acp` 命令永远不存在 —— npm 上的
  `@deepseek-ai/dsh-acp` 是个 cordis 插件，**没有 bin 字段**，`npm i -g` 不会产生可执行文件。

## 3. 施工清单

### Lane A（主进程，你自己改）

1. `apps/desktop/src/main/discovery/detect.ts` —— dsh 的 launch 解析改成多级：
   用户 override（`agents.json` 里的 `dsh`）→ PATH 上的 `dsh` / `dsh.cmd` →
   桌面版常见安装位置（`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` 之类）。
   解析出来必须包成 `cmd.exe /c <dsh.cmd> --profile acp`（`.cmd` 垫片不能直接 spawn，detect.ts 里已有这个坑的注释）。
   同时把 `installHint` 改掉：现在那句 `npm i -g @deepseek-ai/dsh-acp` 是错的，
   正确说法是「装 DeepSeek Harness 桌面版，或用 agents.json 指到它的 dsh.cmd」。
2. `apps/desktop/src/main/session/manager.ts` —— 按档位给 dsh 注入 `DSH_PERMISSION_MODE`：
   受控/只读档 = `read-only`（这样才会问），自主档可给 `workspace-write`（默认值，沙箱仍封在工作区）。
   照抄 codex 那段（切 mode）的写法，opencode 是注入 `OPENCODE_CONFIG_CONTENT`，dsh 是 env。
3. 新增 `apps/desktop/src/cli/verify-dsh-live.ts`（可在 `package.json` 加 `"verify:dsh-live"`），
   断言至少包含：握手 protocolVersion=1 / `session/new` 返回 model+reasoning_effort /
   默认档 0 次 request_permission / `read-only` 档 1 次且选项里含 `allow-once`。
   参考现成的 `docs\logs\dsh-probe\dsh-session.mjs`（我这次用的裸探针，可直接改写成项目里的版本）。

### Lane B（渲染层，派给 Claude —— 那不是你的 lane）

4. `apps/desktop/src/renderer/gate.ts` 与扇出弹窗的档位说明：dsh 不再是 `unknown`，
   要按「默认不问、由本应用按档位武装」讲（与 opencode / codex 同类）。
5. 审批卡可读性：dsh 的 `session/request_permission` **只带 toolCallId，没有 title/kind**
   —— 现在会渲染成「未命名工具调用」。它前面那条 `tool_call` update 是带工具名的，
   应按 `toolCallId` 关联取名，否则 dsh 的审批卡全是「未命名」。

## 4. 这三条本轮没验过，得你验

1. **桌面版 GUI 开着的时候**，我们再 spawn 一个 dsh ACP 进程会不会打架（本机 `where dsh` 查不到，
   桌面版自带一个把 dsh 写进用户 PATH 的管理器，但没启用）。
2. 我们停会话时 dsh 走不走 `session/close`（它有持久化，会话落在 `~/.dsh/sessions/<cwd-slug>/`）。
3. 装到别的目录（不是 `D:\agent`）时的路径发现是否成立 —— 所以 detect 不能硬编码本机路径。

## 5. 纪律（违反过的地方都写在 §6 已知坑里）

- 只改 `apps\desktop\src\main\**`、`packages\**`、`rules\**`、`apps\desktop\src\cli\**` 与构建配置；
  **永不改 `docs\ARCHITECTURE.md`**；`packages\shared-protocol\events.ts` 是冻结契约，要改走 `docs\requests\`。
- 每完成一个任务写 `docs\done\<ID>-<短名>.md`（五节：做了什么 / 改了哪些文件 / 怎么验证的 /
  没做什么·已知问题 / 下一手需要什么），**验证必须是可重跑命令 + 真实输出**，并追加一行 `docs\PROGRESS.md`。
- **写任何时间戳前先 `Get-Date`**（这条犯过三次）。
- **跑 verify 之前先** `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`
  （残留进程占着 `.ui-run\<name>` 会让脚本以 EPERM 死在 bootstrap，看起来像套件坏了）。
- Electron 套件输出必须 `... 2>&1 | Out-File -Encoding UTF8 <log>`；
  `$out = & electron.exe ...` 拿不到输出（GUI 子系统进程，PowerShell 不等它）。
- 要装依赖或改全局配置，先写 `docs\BLOCKED.md` 再跳过，别擅自装。
- 派 Lane B 的办法：prompt 写成**纯 ASCII** 文件（中文经 cmd/PowerShell 管道会乱码）+ 一个 ASCII 的 `.cmd`：
  `cd /d D:\agent\xuanwo` + `type "<prompt文件>" | claude -p --dangerously-skip-permissions >> docs\logs\claude-lane-b.log 2>> docs\logs\claude-lane-b.err.log`，
  再 `Start-Process <那个.cmd> -WindowStyle Hidden`。
  **绝不要把多行 prompt 当参数传给 .cmd**（进程 6 秒退出、退出码为空）。

## 6. 验收标准

- `npm run verify:all` 仍然全绿（现在是 100/100：49 + 16 + 17 + 18）。
- 新增的 dsh 实跑脚本通过（见 §3.3 的四条断言），真实输出贴进完成文档。
- 界面上：左栏出现 DeepSeek Harness 一行（装了就是可用、没装灰显并给正确安装提示）；
  起一个 dsh 会话后，中栏标签页里能看到它的对话流。
- Lane B 那批渲染层套件（smoke / render-verify / r1-verify / cold-start-verify /
  blocked-hostile-verify / gate-empty-verify / scorecard-verify / tabs-verify）全绿。

## 7. 现成命令

```powershell
cd D:\agent\xuanwo
$dsh = "D:\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 只握手，不烧 token
node docs\logs\dsh-probe\dsh-handshake.mjs $dsh "$env:TEMP\dsh-probe\ws"

# 2) 建会话（仍不烧 token）
node docs\logs\dsh-probe\dsh-session.mjs $dsh "$env:TEMP\dsh-probe\ws"

# 3) 验闸门（会调一次 flash，烧极少 token）
node docs\logs\dsh-probe\dsh-session.mjs $dsh "$env:TEMP\dsh-probe\ws2" `
  "在当前工作目录创建 mode-probe.txt，内容写 hello。只做这一件事。" `
  '{\"DSH_PERMISSION_MODE\":\"read-only\"}'

# 4) 看它的 profile 组成
& $dsh --profile acp --dump-config | Out-File -Encoding UTF8 docs\logs\dsh-probe\acp-profile.yml

# 5) 回归
npm run verify:all
```

## 8. 交付

做完写 `docs\done\T14-dsh-fourth-engine.md`（五节格式）+ 追加 PROGRESS，
并在 `docs\BLOCKED.md` 末尾把勘误 D-1 那条标成「已落地」。
如果中途卡在需要用户授权的事（装东西、改全局配置），写进 BLOCKED 再跳过，不要擅自做。
````
