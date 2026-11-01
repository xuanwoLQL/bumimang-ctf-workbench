# R15 dsh 渲染层：Lane B 派了但没产出，Lane A 接管（附完整证据）

> 2026-10-13 13:12 · 原计划由 Lane B（Claude Code）做，按截止时间由 Lane A 接管。
> 背景：`docs/DSH-INTEGRATION-RECON.md` §2 的 Lane B 两条（`gate.ts` 文案 + 审批卡可读性），
> 以及 T14 之后必然变红的渲染层 stale 断言。

## 做了什么

1. **派单（按 `EXECUTION-PLAN` §5 的纪律）**：纯 ASCII 提示词
   `docs/logs/lane-b-round25-prompt.txt`（5779 字节，逐字节校验过无非 ASCII）+ `lane-b-round25.cmd`，
   `type <prompt> | claude -p --dangerously-skip-permissions > claude-r25.log 2> claude-r25.err.log`，
   `Start-Process -WindowStyle Hidden`。
2. **等 15 分钟无产出**：`claude-r25.log` 始终 **0 字节**，`apps/desktop/{src/renderer,electron}` 下
   **零文件被改动**（按 mtime 核过）。用户随后给了 13:40 的硬截止，所以我把 claude 进程收掉
   （`taskkill /F /T /PID`，含它的 python 子进程），自己接管 —— 不接管的话「渲染层套件全绿」这条
   验收不可能达成，而它是 T14 的验收标准之一。
3. **接管后做的事**（全部在 Lane B 的目录里，见下表）：dsh 不再是 `unknown` —— 它和 codex 一样
   **由档位决定问不问**（guarded → 本应用注入只读档，会问；autonomous → 不问）；把 fixure/mock/断言里
   所有「dsh 未安装 / unknown / 下拉只有 3 家可用」的 stale 事实改成新事实。
4. **审批卡可读性不需要渲染层改动**：T14 已在主进程按 `toolCallId → tool_name` 把动作名补进
   `detail.title`（实测卡片上就是 `write`），渲染层拿到的就是可读值。我在探针里把这条**端到端断言**了
   （`command="write"`），没有再加一层渲染层关联表 —— 避免同一件事两处实现。

## 改了哪些文件

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop/src/renderer/gate.ts` | dsh 并入 codex 分支（guarded=armed / autonomous=not_armed）；unknown 只留给未来引擎；注释与徽标/档位说明文案重写 |
| `apps/desktop/src/renderer/mock/data.ts` | mock 的 dsh：已装 + 正确安装提示 + `requests_by_default` |
| `apps/desktop/src/renderer/smoke.ts` | 7 条 stale 断言 + 1 处笔误（`nonproduceLine`）修正 |
| `apps/desktop/electron/cold-start-verify.ts` | 3 条：快照 behavior、引擎摘要「可用 4 · 未安装 0」、下拉 4 家全可用 |
| `apps/desktop/electron/tier-asymmetry-verify.ts` | dsh 会话卡期望 → 闸门已武装；fixture 对齐 |
| `apps/desktop/src/renderer/first-run.ts`、`apps/desktop/src/renderer/fanout/model.ts` | 注释里的旧事实（「dsh 未安装」）改正 |
| `apps/desktop/electron/first-run-verify.ts` | fixture 说明改正（dsh 未安装 fixture **故意保留**：验「没装 → 灰显 + 提示」分支） |
| `.probe/dsh-ui-flow.mjs` | 新增：CDP 驱动真实窗口的界面端到端探针（dev / 打包态两用） |

> 复跑时还抓到并修掉一个**套件自身的卫生问题**：`first-run-verify.ts` 的 userData 固定为
> `.ui-run/electron-profile-first-run`，而「已 dismiss」是记在那个 profile 的 localStorage 里的 ——
> 上一轮跑完留下的状态会让引导不再出现，套件从第一条断言就红（14 FAILED）。这条套件的前提本来就是
> 「首次启动」，所以在其开头加一行 `rmSync(该 profile)` 清干净再跑（**不是**放宽断言）。

## 怎么验证的

```powershell
cd D:\agent\xuanwo
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force

node apps\desktop\src\renderer\smoke.ts 2>&1 | Out-File -Encoding UTF8 docs\logs\smoke-t14.log
foreach ($s in @('cold-start-verify','tier-asymmetry-verify','render-verify','r1-verify','gate-empty-verify',
                 'blocked-hostile-verify','scorecard-verify','tabs-verify','push-verify')) {
  node_modules\electron\dist\electron.exe "apps/desktop/electron/$s.ts" --no-sandbox 2>&1 |
    Out-File -Encoding UTF8 "docs\logs\$s-t14.log"
}
node .probe\dsh-ui-flow.mjs 9344 dev     # 界面端到端（开发态）
node .probe\dsh-ui-flow.mjs 9345         # 界面端到端（打包产物）
node_modules\electron\dist\electron.exe apps\desktop\electron\first-run-verify.ts --no-sandbox 2>&1 |
  Out-File -Encoding UTF8 docs\logs\first-run-verify-t14.log
```

真实输出（全部贴在日志里）：

```
smoke                         → ALL PASS（exit=0，0 条 FAIL）
cold-start-verify             → ALL_PASS
tier-asymmetry-verify         → ALL_PASS
render-verify / r1-verify     → ALL_PASS
gate-empty / blocked-hostile  → ALL_PASS
scorecard / tabs / push       → ALL_PASS
first-run-verify              → ALL_PASS（清掉自己残留的 profile 之后，0 FAIL）
dsh UI flow（dev）            → 18/18 ALL_PASS
dsh UI flow（packaged）       → 18/18 ALL_PASS
```

界面探针里最关键的四条（任务书 §6 的界面验收）：

```
PASS  左栏有 DeepSeek Harness 一行且为可用态  — {"cls":"agent-item agent-installed","hint":null,"startBtn":true}
PASS  中栏出现 dsh 会话的标签页（agent 读作 dsh）   PASS  中栏 dsh 标签页里能看到对话流  — 20 blocks
PASS  审批卡的动作名可读（不是「未命名工具调用」占位）  — command="write"
PASS  放行后文件真的被写出来  — D:\agent\xuanwo\.ui-run\sessions\s6\ui-flow-probe.txt
```

## 没做什么 / 已知问题

1. **Lane B 本轮零产出**，原因未查明（它的 stderr 只有历次都有的
   `[claude-code:unrecognized_model]` 警告，进程活着且在吃 CPU）。这已经是第二次
   （R23 也是 Lane A 补的），所以**派 Lane B 时要么留足时间窗、要么直接自己上**。
2. `apps/desktop/electron/first-run-verify.ts` 的合成快照仍把 dsh 标成未安装 —— 故意的，
   它现在是「未安装分支」的唯一覆盖点；但那个 fixture 里的 `installHint` 仍是旧文案
   （synthetic，不影响真机）。
3. `apps/desktop/electron/push-verify.ts` / `blocked-hostile-verify.ts` 的 fixture 里 dsh 仍写
   `installed:false`，但它们不断言 dsh 的任何事实（只当一行无关数据用），所以没动。
4. **没有为 dsh 加渲染层的审批卡关联表**（见「做了什么」第 4 条）：主进程已经给对名字了，
   再加一层只会造成两处真相。若将来某个引擎的权限请求既没有 title 也不在流里出现，
   那时才需要在渲染层做兜底文案。
5. 界面探针用的是 **CDP 驱动 + 真实 DOM 点击**，不是人眼；截图已存 `docs/logs/dsh-ui-*.png`。

## 下一手需要什么

- 想让队友拿到含 T14+R15 的产物：`dist\` 已在 13:11 重打包（`npm run pack` exit=0），直接用即可。
- 若还想恢复「Lane B 独立完成」的分工，下轮请给它更长的窗口（≥40 分钟）并把「必须产出证据」
  写在提示词第一行（R24 提示词里那句「evidence is part of the task」这轮也在，但仍零产出）。
- `docs/ARCHITECTURE.md` §6.3 关于 dsh 的判断仍是错的（只读基线）—— 需要用户拍板要不要走 `docs/requests/`。
