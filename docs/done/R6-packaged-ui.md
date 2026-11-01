# R6 打包态 UI 验收：样式表真的加载、三栏真的画出来

> 完成时间：2026-10-13 08:08 · Lane B

## 一句话结论

**打包产物（`dist\win-unpacked\不迷茫.exe`）的 UI 没有坏。** 三栏、面板标题、文本内容与**样式表（styles.css）**在打包态全部正常——`bumimang://` 协议在 app.asar 里做 `readdirSync(withFileTypes)` 枚举 + `readFileSync` + `stripTypeScriptTypes` 没有出现任何 asar 相关的退化。Lane A 的 `--verify` 11/11 没验到的"CSS 是否被应用"这一条，本任务补上了，**通过**。

## 为什么还有这个任务

Lane A 的 `--verify` 在打包态跑通 11/11，但那 11 条断言里**没有一条验证样式表被应用**：三栏 DOM 在、文字在，即使 styles.css 没加载也一样会过（只是视觉上烂掉）。而且 11/11 是主进程 `executeJavaScript` 出来的结论，没有一张人眼能看的截图。渲染进程读资产走的自定义 `bumimang://` 协议（`apps/desktop/electron/renderer-protocol.ts`），启动时用 `readdirSync(dir, { withFileTypes: true })` 递归枚举 + `readFileSync` 一次性读进内存——在 dev 是读源码树，在打包态是读 `app.asar` 内部。若 asar 目录枚举行为不同，产物 UI 会**悄悄坏掉而 dev 看起来没事**。这正是本任务要排除的。

## 怎么做

不改打包产物、也不改 Lane A 的 `src/main`。用 Chromium 远程调试协议（CDP）连上已经启动的打包 exe，在**真实的 app.asar 渲染进程**里跑 DOM + 计算样式探针，再 `Page.captureScreenshot` 截真图：

```powershell
# 1) 先杀残留（多实例会抢 %APPDATA%\bumimang\workspace\electron-profile 的文件锁）
Get-Process electron | Stop-Process -Force
# 2) 启动打包 exe（--verify 会秒退，所以不带它；只开调试端口）
& "dist\win-unpacked\不迷茫.exe" --no-sandbox --remote-debugging-port=9333 '--remote-allow-origins=*'
# 3) 跑探针（Node 25 全局 fetch + WebSocket，零依赖）
node apps/desktop/electron/packaged-ui-probe.mjs 9333
```

启动日志（`docs/logs/packaged-ui-run.log`）干净，关键一行证明类型剥离在 asar 内照常跑：

```
[main] 策略引擎已加载：policy-engine(比赛合规包)
(node:5956) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time
[main] 窗口已加载
```

（`stripTypeScriptTypes` 的 ExperimentalWarning 只是 Node 24 的提示，不是错误。）

## 断言结果：13/13 ALL_PASS

| 断言 | 结果 |
| --- | --- |
| 三栏容器数量 = 3 | `col col-left / col col-center / col col-right` |
| 三栏水平排布（左<中<右） | rects x=8 / 256 / 1018，宽 240 / 754 / 400 |
| 三栏均有非零尺寸 | 240×738 / 754×738 / 400×738 |
| 面板标题都在 | 任务 / 会话 / 审批队列 / 黑板台账 |
| 页面有实际文本（没白屏） | 551 字符 |
| **styles.css 以 \<link\> 加载且解析出规则** | `href=bumimang://./src/renderer/styles.css`，`cssRules=175`，sheets=1 |
| **#app 计算样式是 grid 三列** | `display=grid`，两端 240px/400px、中间弹性（`1fr` 已被 Chromium 换算成 used value 754.4px） |
| **body 应用暗色主题变量** | `background rgb(13,17,23)`（#0d1117）、`color rgb(230,237,243)`（#e6edf3） |
| **body 字体是 13px Segoe UI** | 非浏览器默认字体 |
| 左栏 `overflow-y:auto`（样式细节规则） | 生效 |
| 规则包徽标有名字（真实 IPC 快照） | `policy-engine(比赛合规包)` |
| 任务卡渲染（示例任务） | `示例任务：本地 HTML 目标` |
| 截图写入 | `docs/logs/packaged-ui.png`（1783×942，88.6 KB） |

**"stylesheet 真的加载"这条用三重独立证据钉死**：① `document.styleSheets` 里那张 `styles.css` 的 `cssRules.length = 175`（若 404 或 MIME 错，这张表会是 0 条或根本不存在）；② `#app` 的 `getComputedStyle` 是 `display:grid` 且三轨两端 240/400px（CSS 没加载时是 `display:block`，三栏会竖着叠、宽度撑满）；③ body 的计算背景/前景/字体精确命中样式表里的 `:root` 变量与字体栈。

## 截图证据

- `docs/logs/packaged-ui.png` —— 主证据（1783×942，窗口 1440×900 在 125% DPI 下的物理像素）
- `docs/logs/packaged-ui.jpg` —— 同图 JPEG 版（方便快速预览，与其他验收截图一致）
- `docs/logs/packaged-ui.json` —— 完整证据（13 条断言 + DOM 探针 + 目标 URL）

因为本模型在本次会话里读不了图片，我在截图上做了**像素抽样自检**（等价于人眼扫一眼有没有内容）：29 种不同颜色（空白图只会 1–2 种），主色精确命中主题色板 `#0D1117`(背景) / `#161B22`(面板) / `#1C2330`(抬升) / `#58A6FF`(强调蓝) / `#8B949E`(次要文字)，且指定色 `#0d1117`、`#161b22`、`#58a6ff`、`#e6edf3` 全部在图中找到。**人眼比对请直接看 `packaged-ui.png` 与 dev 的 `cold-start.png`**（两者同为 1783×942、同为暗色三栏空状态）。

## 有没有真发现

**没有功能缺陷。** 这是"负结果"——asar 目录枚举在 Electron 44.7.0 里对 `readdirSync(withFileTypes: true)` 行为与 dev 一致：整个 `src/renderer/**` 模块图（main.ts 及其 16 个 import）都被枚举并加载，`styles.css` 也进了资产表并生效。Lane A 担心的"打包态 UI 悄悄坏掉"没有发生。

两个**非缺陷**的注意点，供后来人：

1. **`getComputedStyle` 返回的是 used value，不是你在样式表里写的值。** 探针第一版断言 `gridTemplateColumns === "240px 1fr 400px"` 失败了，实际返回 `240px 754.4px 400px`——`1fr` 已被换算成像素。这是浏览器标准行为，不是 bug。教训写进探针脚本注释里了。
2. **打包态 `--verify` 的证据落在 `%APPDATA%\bumimang\evidence\`，不在仓库里**（asar 只读）。本任务用 CDP 把截图与 JSON 直接写回仓库 `docs/logs/`，所以这次有仓库内证据。

## 新增/改动文件

```
apps/desktop/electron/packaged-ui-probe.mjs   新增：CDP 探针（对打包 exe 做 DOM+计算样式断言+截图）
docs/logs/packaged-ui.png                     截图证据（本任务要求的落盘位置）
docs/logs/packaged-ui.jpg                     同图 JPEG 预览
docs/logs/packaged-ui.json                    13 条断言 + DOM 探针证据
docs/logs/packaged-ui-run.log                 打包 exe 启动日志
```

未动 `apps/desktop/src/main`（Lane A）、`docs/ARCHITECTURE.md`、`packages/shared-protocol/events.ts`。

## 边界 / 没做

- 只验了 `win-unpacked` 目录包（unpacked）。NSIS 安装包与绿色包内部就是同一份 app.asar，且 Lane A 已验过两个产物 11/11，不重复跑。
- 截图是空状态首屏（无会话）。这是打包态首启的真实样子，与 dev 的 `cold-start.png` 同构，正好用于对比。
- "干净机器上首次安装"仍未被验证（Lane A 在 T6-packaging 里已列为已知缺口），本任务不覆盖。
