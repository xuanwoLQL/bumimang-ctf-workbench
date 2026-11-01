# 交接文档论断核验 + 安装包载荷只读检查

> 完成时间：2026-10-13 09:01

## 做了什么

两件事，都是"把文档里的断言拿去对证据"。

### 1. §4 三家表格 —— 取了一份新鲜证据

那张表是本项目的头部论断（"三家闸门都能开"），而我在它之后又改过 `session/manager.ts`、做过打包。重跑 `verify:agent-permission`：

```
codex    写文件时 request_permission=0   跑命令时 request_permission=0
claude   写文件时 request_permission=1   跑命令时 request_permission=0
```

与 §4 表格一致（这台探针测的是**原生**行为：claude 原生会问、codex 原生不问）。两家的"武装后"行为另由 `verify:arm-opencode` / `verify:arm-codex` 覆盖，也在 08:21 复核过。

### 2. §5 的每条"已闭合" —— 机械核对文档与命令

```
多会话真并行        文档=有  命令=有  verify:briefing
并发抢租约          文档=有  命令=有  verify:concurrency
blocked 终态        文档=有  命令=有  verify:concurrency
blocked UI 路径     文档=有  命令=有  (Lane B ui-deny-blocked.ts)
打包分发            文档=有  命令=有  pack
L-3 黑板可达        文档=有  命令=有  verify:mcp-live
B-3 opencode        文档=有  命令=有  verify:arm-opencode
B-3 codex           文档=有  命令=有  verify:arm-codex
```

**8 条全部同时有完成文档与可重跑命令**（`docs/done/` 共 40 份）。没有"声称闭合但找不到证据"的条目。

### 3. 顺带补上一个真实缺口：安装包本身的载荷从没人看过

Lane B 在 R8 的报告里点出：我们验过 `win-unpacked` 与绿色包，**但 NSIS 安装包从没被执行过**——而它才是给队友的主产物。

安装会写系统（开始菜单、卸载注册表项、`%LOCALAPPDATA%\Programs`），**在没有用户授权的情况下我不动它**。所以改用只读方式：NSIS 安装包实际上是「小外壳 + 7z 载荷」，用 7z 直接列内容即可确认载荷是否完整。

```powershell
$sz = "$env:LOCALAPPDATA\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-1nrf7\bin\7za.exe"
& $sz l "dist\不迷茫 Setup 0.1.0.exe"
```

关键条目全部在载荷里：

```
....A     17799705      2271408  resources\app.asar
....A         2699         1097  resources\app-source\rules\competition.json
....A         1642          692  resources\app-source\rules\dev.json
....A          421          300  resources\app-source\rules\redteam.json
（另有 elevate.exe 等）
```

**这证明的是"载荷完整"，不是"安装流程可用"。** 后者仍未验，见下。

## 改了哪些文件

无代码改动。本次只做核验，结论写在本文件与 `docs/PROGRESS.md`。

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:agent-permission        # §4 表格的新鲜证据
$sz = "$env:LOCALAPPDATA\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-1nrf7\bin\7za.exe"
& $sz l "dist\不迷茫 Setup 0.1.0.exe"  # 安装包载荷（只读）
```

输出见上。

## 没做什么 / 已知问题

1. **NSIS 安装流程仍未验。** 只验了载荷完整。真正要验的是：双击安装 → 装到 `%LOCALAPPDATA%\Programs` → 开始菜单有项 → 启动能跑 → 卸载干净。**这需要用户授权或一台干净机器**，我不在没有授权的情况下往系统里装东西。
2. **"干净机器首次体验"这个缺口依旧**（HANDOVER §5 第 3 条）。本机有 electron 缓存、有全局装的 ACP 适配器，所以"新机器上第一次打开会缺什么"仍然只能推测。
3. **§4 的"claude 跑命令不问"一行仍是单次测量。** 昨晚这条被 Lane B 推翻过一次（简报轮它发了 11 条 shell 审批），我在文档里已标注，但**没有做多次测量把它变成规律**。当前措辞是"原生会问（写文件/跑命令都发过）"——保守，但精度不够。
4. **`verify:agent-permission` 每次跑都烧真 token**（两个 agent × 两个场景），不适合进每次回归。这次跑是为了给头部论断取新鲜证据，值。

## 下一手需要什么

- 要验安装流程：需用户授权（或一台可随意折腾的 Windows）。
- 要把 §4 那行测成规律：同一探针连跑 3 次看是否稳定。
