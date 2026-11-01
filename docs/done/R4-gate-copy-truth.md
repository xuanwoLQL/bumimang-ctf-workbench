# R-4：扇出弹窗文案改为跟着 `permissionBehavior` 走（不再硬编码哪家会问）

> 完成时间：2026-10-13 07:36（Lane B，第 14 轮）

## 背景

Lane A 在 B-3 里把 opencode 武装起来了：应用 spawn opencode 会话时按会话注入
`permission.edit/bash="ask"`，所以 opencode 在本应用里**也会请求授权**。这推翻了此前
「只有 Claude Code 开箱会请求授权」的产品叙事，而渲染层的扇出弹窗还写着这句旧话。

同时 Lane A 把 `HubSnapshot.agents[].permissionBehavior` 的语义改成了「**我们这样跑它
会不会有审批输入**」（见 `detect.ts` 注释），并且 opencode 已经改成 `requests_by_default`。
所以数据源已经是对的，只剩渲染层的文案没跟上。

## 做了什么

只改 Lane B 的地盘（`apps/desktop/src/renderer` + `apps/desktop/electron`），没碰
`src/main`、没碰冻结契约、没碰 `docs/ARCHITECTURE.md`。

1. **删掉弹窗顶部那段硬编码的「只有 Claude Code 开箱会问…」。** 换成纯函数
   `fanoutGateNote(agents)`，从快照里的 `permissionBehavior` **现算**两组名单：
   - `requests_by_default` → 「会主动请求授权的：…」
   - `needs_config` / `unknown` → 「不保证会问的：…」
   名单跟着字段走，字段变了文案自动对，不再有任何「哪家会问」的硬编码。

2. **`gateNoteFor(behavior)` 改成两种状态、且措辞不再说「开箱」。**
   - `requests_by_default` → 「本应用运行它时会主动请求授权（guarded 档会有审批输入）」
   - `needs_config` / `unknown` → 「本应用运行它时不一定有审批输入（审批队列可能一直为空）」
   旧的「开箱即进审批队列」对 opencode 不成立（它是本应用武装的，不是开箱）；旧的
   `needs_config` 与 `unknown` 各写一句，也并成同一条——对「选它，guarded 档有没有
   东西可拦」这个问题，两种状态就够了。

3. **不把内部实现细节写进用户可见文案。** 全文没有出现 `OPENCODE_CONFIG_CONTENT`、
   「按会话注入配置」这类词；需要解释时只说「本应用运行它时…」。

## 改了哪些文件

```
apps/desktop/src/renderer/fanout/model.ts   gateNoteFor 改两种状态 + 新增 fanoutGateNote(agents)
apps/desktop/src/renderer/fanout/fanout.ts   弹窗顶部提示改调 fanoutGateNote(agents)，删硬编码文案
apps/desktop/src/renderer/mock/data.ts       mock 的 4 家 agent 补 permissionBehavior（与 detect.ts 一致）
apps/desktop/src/renderer/smoke.ts           新增 R-4 文案纯逻辑断言（9 条）
apps/desktop/electron/cold-start-verify.ts   断言升级：opencode=会问；弹窗提示/详情/选中 codex 都按新文案验
apps/desktop/electron/scorecard-verify.ts    受控快照里 opencode 的 permissionBehavior 改为 requests_by_default
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node apps/desktop/src/renderer/smoke.ts
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/cold-start-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|ALL_PASS|FAILED|shot"
```

- **smoke**：ALL PASS（新增 R-4 一节 9 条：mock 带字段、两状态文案、缺省→null、弹窗提示现算、
  空 agents 不崩）。
- **cold-start-verify**：**29/29 ALL_PASS**（真实桥 + 真实 `detect.ts`）。关键输出：

  ```
  PASS  R-2/R-4：快照带 permissionBehavior（claude+opencode=会问 / codex=需配置 / dsh=unknown）
        └─ behavior={"opencode":"requests_by_default","codex":"needs_config","claude":"requests_by_default","dsh":"unknown"}
  PASS  R-4：弹窗「选哪个 agent」提示由 permissionBehavior 现算（opencode 并入会问、不再写「只有」）
        └─ note="…会主动请求授权的：OpenCode、Claude Code；不保证会问的：Codex、DeepSeek Harness（审批队列可能一直为空）。"
  PASS  R-4：默认选中的 opencode 带「会主动请求授权」（requests_by_default，来自快照）
  PASS  R-4：选中 claude 带「会主动请求授权」（requests_by_default，来自快照）
  PASS  R-4：选中 codex 带「不一定有审批输入」（needs_config，来自快照）
  ```

- **回归全绿**：`render-verify` 14/14、`blocked-hostile-verify` 28/28（含「空 agents 下扇出弹窗
  能打开、不崩」——验证 `fanoutGateNote([])` 两组都是「无」）、`push-verify` 16/16、
  `gate-empty-verify` 17/17、`r1-verify` 24/24、`scorecard-verify` ALL_PASS。
- 证据：`docs/logs/cold-start.json`（`"pass": true`）+ 截图 `docs/logs/cold-start.png`（本轮重拍）。

## 没做什么 / 已知问题（不扩范围）

1. **审批面板空状态的例子也过期了，但不在 R-4 范围。** `approval/approval.ts` 里
   「② 该 agent 默认不请求授权（如 opencode 的 permission.edit/bash 未开启）」——B-3 之后
   opencode 的 edit/bash 在本应用里已经开启，这个「如 opencode」的例子不再成立（剩下的
   `needs_config` 只剩 codex）。本轮按指令只改扇出弹窗/选 agent 的文案，没动审批面板；
   若要一并改，把它改成「如 codex」或去掉点名即可，属另一次小修。
2. **弹窗顶部提示会列出 agent 名。** 名单是从快照现算的（不是硬编码），字段改了它会跟着改；
   代价是弹窗文字比原来长一点。这是「把真相直接给新手」的取舍。
3. **`unknown` 与 `needs_config` 并成同一条文案**（按任务要求），措辞「不一定有审批输入」
   对两者都成立（codex 是「不会问」，dsh 是「未测/未装」）。

## 下一手需要什么

- 无待用户决策事项，无待 Lane A 处理事项。R-4 关闭。
- 若要继续：Lane A 探测 `codex-acp` 能否透传 `-a on-request`，把第三家也武装起来（BLOCKED B-3 已记）。
