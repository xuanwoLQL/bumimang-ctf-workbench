# R20 · 重打包 + 打包态复验（R19 进 dist）

**日期**：2026-10-20 · **范围**：dist 产物、`.probe/asar-r19-check.cjs`（新增探针）· **零源码改动**

## 做了什么

R19（任务切换 task.switch）是纯源码改动，13:15 的旧 dist 只含到 T14。本轮把 R19 送进分发产物并逐层复验：

1. `npm run pack:dir` 重出 `dist\win-unpacked`（exit=0，electron 44.7.0）；
2. 打包态无头自检 `dist\win-unpacked\不迷茫.exe --no-sandbox --verify` → **19/19**；
3. `npm run pack` 出正式安装包 + 绿色包（16:06:50/16:06:53，exit=0）；
4. 静态核查 app.asar 含 R19 代码：**6/6 PASS**（task-switch 样式、loadTaskSessions、settleCurrentTask、task.switch、HubSnapshot.tasks、listTasks）；
5. 绿色包实跑 `--verify`，按 T6 方法论用落盘证据判定 → `ui-verify.json` **passed=19 total=19**（16:08:32 重写）。

## 改了哪些文件

- 无源码改动。
- 新增 `.probe/asar-r19-check.cjs`：asar 内容核查探针（可重跑）。
- `dist\` 三个产物重打包（win-unpacked / 不迷茫 Setup 0.1.0.exe / 不迷茫 0.1.0.exe + blockmap）。

## 怎么验证的

```powershell
# 1. 打包态自检（真输出节选）
node_modules\electron\dist\electron.exe … # 不适用；命令如下：
dist\win-unpacked\不迷茫.exe --no-sandbox --verify
# → 19 条断言全 PASS，最后一行：
#   [verify] 19/19 通过，证据写入 C:\Users\Administrator\AppData\Roaming\bumimang\evidence\ui-verify.json

# 2. asar 内容核查（可重跑）
node .probe/asar-r19-check.cjs
# → PASS styles.css: task-switch 样式
#   PASS hub.ts: loadTaskSessions 字符串
#   PASS hub.ts: settleCurrentTask 字符串
#   PASS events.ts: task.switch 动作
#   PASS events.ts: HubSnapshot.tasks 字段
#   PASS board.ts: listTasks

# 3. 绿色包实跑（stdout 接不回控制台，看证据文件）
dist\不迷茫 0.1.0.exe --no-sandbox --verify
# → %APPDATA%\bumimang\evidence\ui-verify.json（16:08:32）：{ "passed": 19, "total": 19 }
```

跑打包态自检前先按铁律清了残留 electron 进程（`Get-Process electron | Stop-Process -Force`，实测 0 残留）。

## 没做什么 / 已知问题

- **asar 路径探针踩到一个库行为坑**（已绕开，记下来）：`@electron/asar` 的 `listFiles()` 返回带前导 `\` 的 Windows 反斜杠路径，而 `extractFile`/`getFile` 用 `path.sep` 切目录——前导反斜杠会产生空目录段，且正斜杠路径在 Windows 上切不出目录。正确姿势：取 listFiles 条目、剥掉前导 `\` 再传给 extractFile。探针里已带注释。
- **绿色包 stdout 仍然接不回控制台**（T6 已知：自解压后 relaunch 子进程），继续用证据文件判定。
- NSIS 安装包仍未执行过（B-4 老问题，装系统类操作待用户授权），只验了载荷完整性与打包 exit=0。
- 代码签名仍未做（商业决定），队友首跑会看到 SmartScreen 警告。

## 下一手需要什么

无阻塞项。按优先级下一手是 session.remove（关标签真删除，语义需用户拍板）、A/B 量化（需用户给一道有确定解法的真题）、task.update/task.delete（自包含，无需决策）。
