# DeepSeek Harness（dsh）接入侦察 —— 本地那份就能用，不需要下载

> 时间：2026-10-13 12:47 · Lane A 的侦察记录。**本轮没改任何源码**，只有只读探测 + 两次极小提示词实测。
> 结论面向「新开一个窗口继续把 dsh 加进去」这件事，第 2 节是文件级施工清单。

## 0. 一句话结论

- `D:\agent\DeepSeek Harness` 是**桌面版的完整安装**（Electron，desktopVersion `0.2.0-rc.2`），
  它**自带整套 dsh 运行时 + ACP 服务端**（`app.asar` 里就有 `@deepseek-ai/dsh-acp` 与 `dsh-acp-app`）。
- `dsh --profile acp` 起出来的就是**标准 ACP v1 stdio server**，握手我实测通过了。
- **所以不用下载任何东西。** 用户机器上已经有的那份，就是我们要的那份。
- 现有代码找不到它，是因为 `discovery/detect.ts` 在 PATH 里找一个叫 `dsh-acp` 的**命令**；而 npm 上的
  `@deepseek-ai/dsh-acp` **没有 `bin` 字段**（它是 cordis 插件，不是 CLI），`npm i -g` 永远不会产生同名命令。

## 1. 证据（都可重跑）

两个探针脚本已随文档存进仓库，直接可跑（`--profile acp` 的完整 profile 导出也一并留着）：

```powershell
cd D:\agent\xuanwo
$dsh = "D:\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
node docs\logs\dsh-probe\dsh-handshake.mjs $dsh "$env:TEMP\dsh-probe\ws"      # 只握手，不烧 token
node docs\logs\dsh-probe\dsh-session.mjs   $dsh "$env:TEMP\dsh-probe\ws"      # 再开一个会话，不烧 token
# 下面这条会调一次 flash（烧极少 token），用来验闸门：
node docs\logs\dsh-probe\dsh-session.mjs   $dsh "$env:TEMP\dsh-probe\ws2" "在当前工作目录创建 mode-probe.txt" '{\"DSH_PERMISSION_MODE\":\"read-only\"}'
```

`docs\logs\dsh-probe\acp-profile.yml` = `dsh --profile acp --dump-config` 的原始导出（379 行）。

### 1.1 它自带 CLI

`D:\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`：

```bat
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

```powershell
& "D:\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --help
# → Usage: dsh [--profile] <name> [options] [app-args...]
#   --profile <name>   the profile under $DSH_HOME/profiles to boot
```

`$DSH_HOME` = `C:\Users\Administrator\.dsh`（本机已有 `sessions/`、`storages/`、`.credentials.yaml` 等，说明用户本来就在用）。

### 1.2 `acp` profile 是随包发行的，不用自己建

```powershell
& $dsh --profile acp --dump-config      # 成功，379 行
```

组合结果 = `@deepseek-ai/dsh-base` + 被 `@deepseek-ai/dsh-acp-app` 打的补丁；补丁里写死了
`provider: deepseek-official` / `model: deepseek-v4-flash`。
（`~/.dsh/profiles/` 下只有 `desktop`、`web` 两个目录 —— `acp` 是 shipped profile，不需要 `--from-default-profile` 先生成。）

### 1.3 握手（不烧 token）

`dsh.cmd --profile acp` 当 stdio server 起，发 `initialize`：

```json
{"protocolVersion":1,
 "agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
 "agentCapabilities":{"mcpCapabilities":{"http":true},
   "promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},
   "sessionCapabilities":{"close":{},"list":{},"resume":{}}},
 "authMethods":[]}
```

`session/new` 也成功，并晒出两个配置项：

```
config: model            = ["deepseek-official","deepseek-v4-flash"]
config: reasoning_effort = high   （4 个可选值）
```

→ 和 codex 一样，**是 `set_config_option` 模型**，不是 claude 那种 `set_model`。

### 1.4 闸门（这一节最要紧）：默认不问，改一个环境变量就问

同一道题（「在当前工作目录创建 `xxx.txt`，内容 hello」）跑两次：

| 启动环境 | `session/request_permission` | 文件 | session/update 种类 |
| --- | --- | --- | --- |
| 默认（`workspace-write`） | **0 次** | 真被写了（内容 `hello`） | thought 1 / usage 2 / tool_call 1 / tool_call_update 1 / message 1 |
| `DSH_PERMISSION_MODE=read-only` | **1 次** | 没写 | thought 3 / usage 3 / tool_call 2 / tool_call_update 2 / message 1 |

拦截请求原文（`read-only` 模式下）：

```json
{"sessionId":"c6a77b98-…","toolCall":{"toolCallId":"call_00_nYXw0MonuWAR6FFUQlwm2729"},
 "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
            {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}
```

原因写在 profile 里（`--dump-config` 原文，非推测）：

```yaml
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js >-
      (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'   # read-only / workspace-write / danger-full-access
```

→ **武装方式与 codex 完全同构**：档位在 spawn 时给环境变量。受控/read-only 档 = `DSH_PERMISSION_MODE=read-only`；
自主档可给 `workspace-write`（默认，人在环外但沙箱封在工作区）。

### 1.5 我们这边的审批链路不用改就能接住它

`apps/desktop/src/main/acp/client.ts:407` 挑「允许」选项是按 **`kind.startsWith("allow")`** 选的，
dsh 给的 `kind: "allow_once"` 正好命中；拿不到 allow 语义的选项就回 `cancelled`（安全侧）。
**这一条不需要为 dsh 动代码。**

## 2. 要改的地方（文件级施工清单）

Lane A（主进程）：

1. `apps/desktop/src/main/discovery/detect.ts` —— dsh 的 launch 解析改成三级：
   用户 override（`agents.json` 的 `dsh`）→ PATH 上的 `dsh` / `dsh.cmd` → 桌面版常见的几个安装位置。
   `installHint` 也该改：现在是 `npm i -g @deepseek-ai/dsh-acp`，**这条命令不会产生可执行文件**，
   正确说法是「装 DeepSeek Harness 桌面版，或把它的 `resources\runtime\cli\bin` 指给我们」。
2. `apps/desktop/src/main/session/manager.ts` —— 按档位给 dsh 注入 `DSH_PERMISSION_MODE`
   （照抄 codex 那段的写法；opencode 是注入 `OPENCODE_CONFIG_CONTENT`，dsh 是 env）。
3. `apps/desktop/src/cli/verify-dsh-live.ts` —— 把 §1.3/§1.4 两条断言做成可重跑脚本
   （握手 + `session/new` + 默认不问 + `read-only` 会问）。

Lane B（渲染层）：

4. `renderer/gate.ts` 与扇出弹窗的档位说明 —— dsh 不再是 `unknown`，应表述为
   「默认不问、由本应用武装后按档位问」（与 opencode/codex 同一类）。
5. 会话卡/审批卡的可读性：dsh 的 `session/request_permission` **只带 `toolCallId`，没有 title/kind**，
   现在会渲染成「未命名工具调用」（用户在截图里已经见过这种行）。它前面那条 `tool_call` update 是带
   工具名的 —— 应按 `toolCallId` 关联取名，否则 dsh 的审批卡全是「未命名」。

## 3. 没做什么 / 风险

1. **没验「装到别处」的路径发现**。本机是 `D:\agent\DeepSeek Harness`（自定义安装目录），所以 detect
   不能硬编码这一条，必须走 PATH/override。
2. **没验并发**：桌面版 GUI 与我们的 ACP 进程共用 `~/.dsh`（sessions / storages / 凭据），
   两个进程同时写同一工作区会怎样，没测。
3. **没验 `session/list` / `resume` 与「blocked = 新会话」模型是否冲突**。dsh 的 acp profile 是挂了
   持久化的（`sessionCapabilities.list/resume/close`），会话会落在 `~/.dsh/sessions/<cwd-slug>/`。
4. **我的探针在 `~/.dsh/sessions/` 下留了两条记录**（12:46 / 12:47，cwd 指向 `%TEMP%\dsh-probe\ws*`），
   还有 `%TEMP%\dsh-probe\ws\perm-probe.txt`。都是临时工作区，没动用户既有的会话。
5. **烧了极少量 token**（两次 flash 提示，各一轮）用于验闸门；不实测就只能凭 README 猜「它会不会问」。
6. 本机 `where dsh` 查不到 —— 桌面版里的 `command-manager.js` / `command-path.ps1` 是「把 dsh 命令写进
   用户 PATH」的管理器，**本机没启用**。我们在 detect 里得自己找那个 `.cmd`，不能指望 PATH。
