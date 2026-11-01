# T6/M6 打包分发：出安装包与绿色包，并在打包态验证跑通

> 完成时间：2026-10-13 08:03

## 做了什么

这是交接文档里最大的未完项。现在两个 Windows 产物都出来了，而且**都在打包态实跑验证过**。

| 产物 | 大小 | 形态 |
| --- | --- | --- |
| `dist\不迷茫 Setup 0.1.0.exe` | 108.4 MB | NSIS 安装包（可选安装目录、非 perMachine） |
| `dist\不迷茫 0.1.0.exe` | 108.2 MB | 绿色包（portable，双击即跑） |

### 三个必须解决的拦路问题

**1. 打包后不能把数据写在源码树里。** 原先工作区与证据目录都用 `import.meta.url` 推导到仓库内，而打包后那会指向 `app.asar` 内——**只读，一写就崩**。改成按 `app.isPackaged` 分流：打包态写入 `%APPDATA%\<name>\workspace`（Electron 的 userData），这也正好兑现架构文档里"配置写用户目录、不硬编码盘符"的 C8 约定。

**2. 镜像必须固化进仓库。** GitHub Releases 直连不通（实测 `fetch failed`）。写了 `.npmrc`，两条镜像键随仓库走：

```
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

实测生效：构建日志里 `downloaded label=electron progress=100%`、`nsis-3.0.4.1.7z`、`nsis-resources-3.4.1.7z` 全部下载成功。**这是"队友克隆即有"的关键一条**——不写进仓库，每个人都要重新踩一遍。

**3. 无 bundler 的代价要自己接住。** 我们的主进程入口是 `.ts`，靠 Node 的类型剥离直接跑。打包时这有个风险：**asar 里的 `.ts` 还能不能被剥离？** 实测结论是**能**——两个产物都跑到了 11/11。这条值得记住，它是"不引 bundler"这个选择能成立的前提。

### 一处有意偏离文档

架构文档写的是 `%APPDATA%\不迷茫\`，实际落在 **`%APPDATA%\bumimang\`**——因为 Electron 的 `app.getName()` 读的是 package.json 的顶层 `name`（`bumimang`），而 `build.productName` 只影响安装包/可执行文件名。

**我选择保留 ASCII 路径**（不改 `name`）。理由：这个路径会被我们自己的 MCP 子进程、以及将来可能的脚本穿过，ASCII 更少意外。偏离已记在这里与 HANDOVER。

## 改了哪些文件

```
.npmrc                                       新增：两条镜像键（随仓库走）
package.json                                 加 main（指向 .ts 入口）、author、build 配置、pack/pack:dir 脚本
electron-builder 26.15.3                     装进 devDependencies
apps/desktop/src/main/electron/main.ts       WORKSPACE / RULES_ROOT / EVIDENCE_DIR 按 app.isPackaged 分流；
                                             修掉 --verify 里那句写死路径的提示
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run pack:dir          # 只出 win-unpacked，快速验证配置
npm run pack              # 出 NSIS 安装包 + 绿色包

# 打包态实跑（两个产物分别验）
Get-Process electron | Stop-Process -Force
& "dist\win-unpacked\不迷茫.exe" --no-sandbox --verify 2>&1 | Out-File docs\logs\packed-run.log -Encoding utf8
& "dist\不迷茫 0.1.0.exe"        --no-sandbox --verify 2>&1 | Out-File docs\logs\packed-portable.log -Encoding utf8
```

`win-unpacked` 的真实输出（**11/11**）：

```
[main] 策略引擎已加载：policy-engine(比赛合规包)
[main] 窗口已加载
PASS  preload 暴露了 window.bumimang（真实 IPC 路径，不是 mock）
PASS  hub:snapshot 通道可用并返回快照
PASS  快照里有任务  — task="示例任务：本地 HTML 目标"
PASS  快照里有 agent 检测结果（4 家）  — agents=4
PASS  快照带上了当前策略规则包  — pack="policy-engine(比赛合规包)" 回落到最小安全集=false
PASS  快照标出三家的审批输入能力  — 会有审批输入=["opencode","codex","claude"] 需配置=[]
PASS  渲染进程画出了三栏  — 命中：["col col-left","col col-center","col col-right"]
PASS  面板标题都在（会话 / 审批队列 / 黑板台账）
PASS  页面有实际文本内容（没白屏）
PASS  hub:action 通道可派发动作
PASS  动作真的改到了核心状态
[verify] 11/11 通过
```

绿色包（portable）**stdout 接不回控制台**（自解压后 relaunch 子进程），所以改用证据文件判定：

```
C:\Users\Administrator\AppData\Roaming\bumimang\evidence\ui-verify.json
{ "passed": 11, "total": 11, ... }   改于 08:03:04
```

**这是本任务最有价值的一条方法论**：GUI 自解压类产物不要靠 stdout 判断成败，看它落盘的证据。

## 没做什么 / 已知问题

1. **没有应用图标**（构建日志：`default Electron icon is used`）。产物现在用的是 Electron 默认图标，不像一个正经产品。需要一个 `.ico`（256×256 起），属低成本可补。
2. **没有代码签名证书。** 日志里有 `signing with signtool.exe`，但没有证书，所以**队友首次运行会看到 Windows SmartScreen 警告**。这是"要不要买证书"的商业决定，不是技术缺陷。
3. **`perMachine: false`** → 默认装到用户目录，不需要管理员权限。如果要给全机器安装得改这个开关。
4. **安装包 108 MB**（Electron 的固有体积）。没有做精简（比如排除 `@agentclientprotocol/sdk` 的 schema.json——那个 255 KB 的文件其实只有研究时用过）。
5. **只打了 Windows x64。** 没有 mac/linux（本项目定位就是 Windows）。
6. **`--verify` 在打包态写证据到 `%APPDATA%\bumimang\evidence\`**，而不是仓库里的 `docs/logs/`。这是对的（asar 只读），但意味着**打包态的验收证据不在仓库里**，容易被忽略。已记在这里。
7. **`.npmrc` 的小写键在 npm 11 下会打 `Unknown project config` 警告**，但仍被 npm 透传成 `npm_config_*` 环境变量、对 `@electron/get` 与 electron-builder 有效（实测下载成功）。将来 npm 移除这个行为时需要改成显式环境变量或构建脚本注入。
8. **没在"干净机器"上试过。** 本机有 `~/.npmrc`、有 electron 缓存、有全局装的适配器。真正的"队友机器首次体验"仍未被验证——这是打包这件事的最后一块，需要一个干净环境或虚拟机。

## 下一手需要什么

- 加应用图标（一个 `.ico` 文件 + `build.win.icon`）。
- 决定是否买代码签名证书（否则队友会看到 SmartScreen 警告）。
- 在干净环境（或虚拟机）里跑一次安装 → 启动 → 起会话的完整流程，才能宣布"开箱可用"。
- 无待用户决策事项（签名证书那个是商业决定，可以缓）。
