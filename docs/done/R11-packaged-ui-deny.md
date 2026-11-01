# 第 21 轮 · 打包产物上的「UI 拒绝 → blocked」端到端（证明 L-4 / L-4b 真的进了 dist）

> 完成时间：2026-10-13 09:52 · Lane B（renderer + electron）
> 结论：**`dist\win-unpacked\不迷茫.exe`（09:40 重打包产物）上的完整「UI 拒绝 → blocked」链 43/43 断言 ALL_PASS**。
> L-4（prompt() 不把 blocked 覆盖回 idle）与 L-4b（退避计数改用「请求内容签名」）**都已进入打包产物**，
> 静态（app.asar 源码字面量）+ 动态（真实 claude + 真实 DOM 拒绝两次）双重证据齐全。

## 一句话

此前 ui-deny-blocked.ts 只对 **DEV electron**（`node_modules\electron\dist\electron.exe` + 现场剥 TS 的 src/main）跑过
L-4 修复 —— 那验的是**源码**，不是打包产物。而 08:24 那版 dist 里**没有** L-4 / L-4b 两处修复（Lane A 已重打到 09:40）。
本轮把同一条链在**真实 app.asar 打包产物**上重跑一遍，并加上一层 app.asar 静态核验：两处修复都确认在包里。

## 完整链路（零 mock、零 import src/main、两次拒绝都是真实 DOM 按钮）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 0 | 启动 `dist\win-unpacked\不迷茫.exe`（`--no-sandbox --remote-debugging-port=9334`），CDP 连上**真实 app.asar 渲染进程** | 首屏 `window.bumimang` 真实 IPC + 三栏 |
| 1 | 静态核验 app.asar（18MB） | **5/5**：含「本轮结束时已是终态」「不覆盖回 idle」（L-4）、「同一动作被连续拒绝」「approvalSignature」（L-4b）、「被策略切断」（渲染层） |
| 2 | 点「知道了」关掉首启引导浮层（真实 DOM）→ 派发 `task.create` 中性简报 | 新任务「打包态 UI 拒绝验收」变当前（task.create 真实 IPC） |
| 3 | 派发 `session.start`（claude + lead + **guarded**） | 会话 s2 出现在快照，档位 guarded |
| 4 | 等 idle（简报轮 67s） | 期间放行 0 条（简报轮的黑板读写被 `blackboard-tools-are-internal` 规则直接放行，不进入人工队列） |
| 5 | 派发 `session.prompt`：创建 demo.txt | 14s 后 claude 发来 `session/request_permission`「Write demo.txt」（rule=`tier-guarded-default`） |
| 6 | **点 UI「拒绝」按钮**（第 1 次，`.ap-card [data-act="deny"]` 的 `.click()`） | 审批项 → denied、decidedBy=human；claude 以 `end_turn` 收尾 |
| 7 | 会话 idle 后发重试 prompt（**同一个 demo.txt**） | 8s 后第二次 `request_permission`「Write demo.txt」（同一内容签名） |
| 8 | **点 UI「拒绝」按钮**（第 2 次） | 审批项 → denied、decidedBy=human；`markBlocked` 执行 → `client.cancel` → 本轮 `stopReason="cancelled"` |
| 9 | 等 blocked 终态 | **347ms 后会话终态 = blocked**（不是 idle/failed/stopped） |

## 双重证据

### 静态：修复代码确实进了 app.asar

`dist\win-unpacked\resources\app.asar`（18MB，mtime 09:40:11）按字节搜到（无 bundler，asar 里就是原样 .ts 源码）：

```
FOUND  L-4 ：「本轮结束时已是终态」（manager.ts prompt() 终态集合兜底）
FOUND  L-4 ：「不覆盖回 idle」
FOUND  L-4b：「同一动作被连续拒绝」（main.ts markBlocked 文案）
FOUND  L-4b：「approvalSignature」（queue.ts 内容签名函数）
FOUND  渲染层：「被策略切断」
```

### 动态：真实 claude + 真实 DOM 拒绝两次 → blocked

43 条断言 ALL_PASS，关键几条：

```
PASS  会话终态是 blocked（不是 failed/stopped）  └─ status=blocked        ← L-4 修复点
PASS  终态不是崩溃 failed                        └─ status=blocked
PASS  台账多了一条 scope=blocked 的死路          └─ desc=会话（s2）被策略拦截并终止：同一动作被连续拒绝 2 次（Write demo.txt | edit）
PASS  死路文案是 L-4b 的「同一动作」（不是旧的「同一规则」）
PASS  死路文案含「被策略拦截并终止」且指向本会话   └─ …（Write demo.txt | edit）
PASS  没有 scope=incident 的崩溃死路（blocked ≠ 崩溃）
PASS  会话卡带 session-blocked 类（红边框视觉）   └─ hasBlockedClass=true
PASS  会话卡不带 session-failed 类（不是崩溃视觉）└─ hasFailedClass=false
PASS  会话卡徽标文字是「被策略切断」（不是「崩溃」）└─ blockedText="被策略切断"
PASS  两次拒绝命中同一规则（tier-guarded-default，且是同一动作的两次）
```

wire.jsonl（`%APPDATA%\bumimang\workspace\sessions\s2\wire.jsonl`）的硬证据序列 —— 与 L-4 修复文档里
「deny #1 → end_turn、deny #2 → cancelled」的预期完全一致：

```
request_permission  Write demo.txt   kind=edit     （第一次写）
sys deny           tier-guarded-default             （第 1 次 UI 拒绝）
stopReason         end_turn                         （claude 自然收尾）
request_permission  Write demo.txt   kind=edit     （重试 prompt → 第二次写，同一签名）
sys deny           tier-guarded-default             （第 2 次 UI 拒绝）
stopReason         cancelled                        （markBlocked 的 cancel 生效）
```

关键是：`stopReason="cancelled"` 之后，会话**没有**被 prompt() 覆盖回 idle，快照终态仍是 `blocked` ——
这正是 L-4 修的东西。

## 与 dev ui-deny-blocked.ts 的一个关键差异（本轮按打包态真实语义走）

- dev 入口自己 bootstrap 队列时用 `denials.note(sessionId, decision.rule)` —— **按策略规则 id 计数**；
- 打包态 main.ts 用 `denials.note(sessionId, approvalSignature(detail) || decision.rule)` —— **按请求内容签名计数**（L-4b）。

所以 dev 里拒「demo.txt + demo2.txt」两件**不同**的事也能 blocked（都命中 `tier-guarded-default` 同一 rule id）；
打包态里**必须同一动作**（同一 title+kind）才到阈值 2。本轮因此让两次 prompt 都写**同一个 demo.txt**，
死路里的签名 `Write demo.txt | edit` 就是证据 —— 两次拒绝命中的是同一个内容签名。

（附带确认：`approvalSignature` 实际取到的是 `title` + `kind` 两个字段；`command/path/target` 在 claude 的
`session/request_permission` detail 里不存在，签名退化成 `"Write demo.txt | edit"`。）

## 证据

| 文件 | 是什么 |
| --- | --- |
| `docs/logs/packaged-ui-deny.json` | 43 条断言 + 时间线 + 两次 deny 留痕 + 终态 + wire 证据（request_permission / stopReason / deny 序列） |
| `docs/logs/packaged-ui-deny.png` | 终态截图（1783×942，blocked 红边框 + 「被策略切断」+ 台账死路同屏） |
| `docs/logs/packaged-ui-deny-0-initial.png` | 打包态首屏（真实后端空态 + 规则包徽标） |
| `docs/logs/packaged-ui-deny-1-pending.png` | 第一个 pending + 拒绝按钮可见 |
| `docs/logs/packaged-ui-deny-run.log` | 打包 exe 的 stdout/stderr（管道捕获，非 `>` 重定向） |

三张截图均为 1783×942 合法 PNG，采样 distinct 颜色 4871–5345、max 亮度 255（非空白）。
流程结束后无残留进程（`Get-Process 不迷茫` 为空）。

## 怎么复跑

```powershell
cd D:\agent\xuanwo
# 先清残留（脚本自己也会清，但保险起见）：
Get-Process electron,'不迷茫' -ErrorAction SilentlyContinue | Stop-Process -Force
# 一条命令跑完整流程（脚本自己拉起打包 exe、自己按 PID 清理）：
node apps/desktop/electron/packaged-ui-deny.mjs 9334
```

脚本可重跑（不是手工点鼠标）：CDP 驱动真实 DOM，每一步有断言 + 截图，最后写 `packaged-ui-deny.json`
并 `process.exit(pass?0:1)`，硬超时 600s 兜底。可执行文件路径可用 env `BUMIMANG_EXE` 覆盖
（默认自动找 `dist\win-unpacked\*.exe`）。

## 改了哪些文件

```
apps/desktop/electron/packaged-ui-deny.mjs   新：打包态「UI 拒绝 → blocked」CDP 驱动 + 断言（零 mock）
docs/logs/packaged-ui-deny{,-0-initial,-1-pending}.png   新：三张截图
docs/logs/packaged-ui-deny.json             新：43 条断言证据
docs/logs/packaged-ui-deny-run.log          新：打包 exe 运行日志
```

没动 `apps/desktop/src/renderer`、没动 `apps/desktop/src/main`（Lane A 的 lane）、没动冻结契约 `events.ts`。
没有种审批、没有 fake agent —— 两次 `request_permission` 都是 claude 对「Write demo.txt」真实发来的
（wire.jsonl 可查）。

## 没做什么 / 边界

1. **只验了打包态这半条链**（拒绝 → 退避 → blocked）。放行路径已由 R8（packaged-flow.mjs 27/27）验过，
   本轮不重复。
2. **数据落在共享的 `%APPDATA%\bumimang\`**，没单独开 userData：跑之前该目录里只有 R8 留下的 s1 会话
   （我的会话因此是 s2，不是 s1）与 Lane A 的 `--verify` 证据，没有遗留的 blocked 死路 —— 本轮的新死路
   `会话（s2）…同一动作…` 明确指向本会话，无歧义。所有断言都按 s2 作用域收敛。
3. **一个顺带发现的措辞漂移（非行为差异，不在本轮范围）**：渲染层会话卡的 title 仍是
   「该会话因**同一规则**被策略连续拒绝…」（`apps/desktop/src/renderer/main.ts`），而 L-4b 之后退避实际按
   「**同一动作**」（内容签名）计数，主进程死路文案已经是「同一动作被连续拒绝」。两者语义现在不一致，
   是 Lane B 自己的 renderer 措辞没跟上 L-4b；本轮只记录不改（改了源码会和刚验证的 dist 产生新差异，
   需另起一轮改 + 重打）。留给下一手：renderer 会话卡 title 把「同一规则」改成「同一动作」。
4. 打包 exe 用 `--no-sandbox --remote-debugging-port` 启动是为了可观测（CDP），与真实双击启动唯一差别是
   多了调试端口；数据路径、渲染、IPC 与双击一致。
