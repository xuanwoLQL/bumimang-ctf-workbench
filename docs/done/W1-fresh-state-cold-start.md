# 全新状态冷启动验收 + 一个 repo 卫生问题的更正

> 完成时间：2026-10-13 05:34

## 做了什么

交接文档该保证的最基本一件事：**别人在干净状态能不能跑起来**。所以把运行期目录整个删掉，从零起一次。

顺带抓到一个**我自己写错的文档**：`T2-T5-T11-real-ipc-wired.md` 第 8 条写着"`.ui-run/` 整体已忽略，OK"——**这是错的**。`.gitignore` 里当时只有 `node_modules/ .m1/ .probe/ .probe2/ *.log`，没有 `.ui-run/`。运行期状态（board.db、十几个 Electron profile、agent 工作目录）会被 git 收进去。已修。

这条值得记一笔的原因不是它多严重，而是它**说明了完成文档里"已知问题"那一节也会出错**——写的时候凭印象，没有验证。教训与"时间戳凭感觉写"是同一类。

## 改了哪些文件

```
.gitignore                                  补 .ui-run/（并更正上文提到的错误声明）
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
# 删掉整个运行期目录（先确认路径在项目内）
Remove-Item -LiteralPath "D:\agent\xuanwo\.ui-run" -Recurse -Force

# 从零起界面
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
```

真实输出（**11/11 通过，全新状态**）：

```
[main] 策略引擎已加载：policy-engine(比赛合规包)
[main] 窗口已加载
PASS  preload 暴露了 window.bumimang（真实 IPC 路径，不是 mock）
PASS  hub:snapshot 通道可用并返回快照
PASS  快照里有任务  — task="示例任务：本地 HTML 目标"
PASS  快照里有 agent 检测结果（4 家）  — agents=4
PASS  快照带上了当前策略规则包（应 Lane B 请求 R-1）  — pack="policy-engine(比赛合规包)"
PASS  快照标出了哪家 agent 开箱会请求授权（应 Lane B 请求 R-2）  — 会问=["claude"] 需配置=["opencode","codex"]
PASS  渲染进程画出了三栏  — 命中：["col col-left","col col-center","col col-right"]
PASS  面板标题都在（会话 / 审批队列 / 黑板台账）
PASS  页面有实际文本内容（没白屏）
PASS  hub:action 通道可派发动作
PASS  动作真的改到了核心状态  — 核心里的任务标题 = "验收任务"
[verify] 11/11 通过
```

## 没做什么 / 已知问题

1. **"干净状态"只到"没有运行期数据"这一层。** 没有模拟真正的陌生机器：那里还没有 `node_modules`、没有 Electron 二进制、没有装 ACP 适配器。真正的首次体验验证要等打包（M6/T6）之后，而现在**打包完全没做**。
2. **冷启动会自动种一个示例任务**（"示例任务：本地 HTML 目标"）。Lane B 第 12 轮已加上「＋ 新任务」入口让用户替换它，但"该不该自动种"这个问题**没有定论**——见下面的判断。
3. **我的判断：应该保留自动种。** 理由是空界面比假任务更让人困惑（Lane B 第 11 轮的 QA 也支持这点：中栏一片空白是它记下的第一处困惑）。有了替换入口之后，"有东西可看"+"能换成自己的"两个需求都满足了。
4. **`.gitignore` 只修了这一处。** 没有系统检查还有没有别的运行期产物会被误收——比如 `docs/logs/` 里的截图与日志（那些**应该**被收，它们是交接证据），以及 `node_modules` 之外有没有别的目录。没有做全量审计。

## 下一手需要什么

- 打包（M6/T6）：`ELECTRON_MIRROR` 必须固化进构建脚本，否则队友机器一定卡在 Electron 二进制下载。
- 首次启动引导：现在能从零跑，但用户看不到"哪些 agent 可用、闸门武装了没有"的汇总（这些信息在快照里已有，UI 上分散在各处）。
- 无待用户决策事项。
