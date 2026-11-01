# R10 多会话真并行「钱截图」：3 个真实 claude（lead/verify/recon，混合档位）并排跑同一道题，端到端

> 完成时间：2026-10-13 04:14 · Lane B（renderer + electron）
> 结论：**34/34 ALL_PASS。经冻结契约起 3 个真实 claude 会话（lead=guarded / verify=autonomous / recon=guarded）跑同一道题，中栏三窗格并排各自实时流，截图 `docs/logs/real-parallel.png`（1903×942）。后起会话的简报包（dead_ends / do_not）确实带上了 lead 刚写的死路。**

## 一句话

接 [VERIFY-briefing-fanout](./VERIFY-briefing-fanout.md)（Lane A 用确定性测试把「机制」验到 17/17），本轮把缺的「**画面**」补上：**一次真的三会话并行运行**——起 3 个 claude 跑同一道题，证明三窗格能同时、并排、各跑各的实时流，且健康度（toolCalls/boardReads/syncLag）与 `session.stream` 都是**每会话独立**、不是共享。

## 完整链路（全程经冻结契约 `window.bumimang`，未用任何新 API）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | `dispatch {type:"session.start", taskId, agent:"claude", role:"lead", tier:"guarded"}` | `{ok:true}`，spawn claude-agent-acp 0.89.1，s1 |
| 2 | 等 lead 简报轮 idle（claude 自动读黑板 + 自发 open_intent） | 33s idle，**0 条审批** |
| 3 | `dispatch {type:"session.prompt", s1, "用 blackboard_declare_dead_end 写死路…（标记 BM-PARALLEL-10）"}` | 2.9s 后黑板出现死路，by=s1 |
| 4 | `dispatch session.start` verify(autonomous) → recon(guarded) **快速相继** | `{ok:true}` ×2，s2 / s3 |
| 5 | 断言 verify/recon 的简报包带上了 lead 的死路 | **dead_ends + do_not + wire.jsonl 的 session/prompt 三处都含标记** |
| 6 | 等三会话全部 idle + toolCalls/boardReads 非零 | idle，各自 toolCalls>0 |
| 7 | 第二轮：给三个会话各发一条**不同** prompt（快速相继 → 真并发） | 三会话同时 running |
| 8 | 三窗格各有内容后截图 + DOM 断言 | `docs/logs/real-parallel.png` |
| 9 | `dispatch session.stop` ×3，确认不留下 3 个 agent | s1/s2/s3 → stopped，无残留进程 |

## 四个硬断言全部命中（对应任务第 4 条）

1. **3 个不同会话 + 角色各异 + 混合档位**：`s1:lead(guarded), s2:verify(autonomous), s3:recon(guarded)`，id 互不相同。
2. **每会话收到自己的 `session.stream`**（总线逐条按 sessionId 计数）：`lead=3680, verify=10937, recon=12771`，三条流各自独立推进、条数不同。
3. **健康度每会话独立、非共享**：`health` 映射 3 个 key 正好等于 3 个会话 id；`s1{toolCalls:10,boardReads:3,syncLag:0} / s2{13,6,0} / s3{12,7,0}`，且 `health[sid].toolCalls === SessionManager.getSession(sid).toolCalls`（boardReads 同理），toolCalls 三值并不全等（各自独立推进）。
4. **三窗格并排（side by side）**：DOM 探针 `tops=[8,8,8] lefts=[256,542,828]`（同一排、left 递增）、每窗格 278×320、每窗格 500 行实时流、头部各带自己的角色徽标与「同步 X · tool Y」健康指标。

## 简报包继承（任务第 5 条）：后起会话确实拿到了 lead 刚写的死路

- `verify` 的简报 `dead_ends = ["lead 已探明：验收目标 A 的路径 X 走不通（BM-PARALLEL-10）"]` ✅
- `recon` 的简报同样带上 ✅
- 简报 `do_not` 里不只是陈列，还明确禁止：`"不要重复尝试：lead 已探明…（BM-PARALLEL-10）"`，以及 lead 简报轮自发 open 的 intent 也进了 `do_not`（`不要重复做：lead 角色已接入共享黑板…（s1 正在做）`）——**迟到加入者靠蒸馏状态、不重做队友已做的事**，机制在真实三会话上成立。
- 简报文本确实发到了 agent：verify / recon 的 `wire.jsonl` 里 `session/prompt` 各 1 行含标记（不是只存在内存里）。

## 诚实声明（两处）

1. **简报包从渲染进程不可见。** 冻结契约暴露给渲染进程的只有 `snapshot`（无简报字段）与 `HubEvent`（无简报事件）。所以第 5 条是在 **main 侧**断的：`SessionManager.getBriefing()` + `wire.jsonl`（与 R8/R9 同一 import 面，我的验收脚本本就 import 核心但不改核心）。渲染进程能看到的间接证据是：`snapshot.board.deadEnds` 里有那条死路，以及第二轮里 verify/recon 各自复述了它（窗格流里）。
2. **自动审批器 0 次触发。** 任务提示「claude 会请求 shell/read 审批，自动放行即可」。本轮把自动放行器挂上了（`approval.decide approve`，如触发会逐条记录进 `autoApproved`），但实际 0 条——因为任务 brief 把 agent 限定为「只用黑板工具、不跑 shell、不读写文件」，而黑板工具在 guarded 档下也被 Lane A 的 `blackboard-tools-are-internal` 规则放行。这是干净结果，不是漏报。

## 改了哪些文件

```
apps/desktop/src/renderer/styles.css             改：.col-center 从纵向 flex 改成横向并排 grid
                                                 （repeat(auto-fit,minmax(220px,1fr))，窄了自动换行；
                                                  1 个会话时自然占满整行，兼容 R8/R9 的单窗格截图）
apps/desktop/electron/real-parallel-verify.ts    新：3 claude 真并行端到端验收入口（只 import src/main，不改）
```

没动 `apps/desktop/src/main`（Lane A）、没动冻结契约 `events.ts`、没动 `ARCHITECTURE.md`。黑板数据全是 agent 真写的（死路 by=s1），没有种任何条目、没有 fake agent。

验收脚本里两处**增强**（都在 electron/ 内，不碰核心）：① 给 `BoardBridge` 接 `onBoardRead → mgr.noteBoardRead`（生产 main.ts 还没接，这里接上让 boardReads/syncLag 有真实值，才测得「每会话独立健康度」）；② 在总线上挂订阅逐条计数每会话 `session.stream`。

## 怎么复跑

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node_modules\electron\dist\electron.exe apps/desktop/electron/real-parallel-verify.ts --no-sandbox 2>&1 |
  Select-String -Pattern "PASS|FAIL|step|real-parallel|ALL_PASS"
```

（electron 的 stdout 必须用管道不能 `>` 重定向；PowerShell 会把 Node 的 `stripTypeScriptTypes` 实验警告当 NativeCommandError，那是外壳行为，`real-parallel.json` 的 `pass=true` 才是结果。）

## 没做什么 / 边界

1. 只测了 claude（任务指定，闸门对另两家开箱不成立）。
2. 三个会话是「分两段错开」：lead 先写死路（为测简报继承），verify/recon 快速相继起、三者随后并发跑。不是三个进程同一毫秒 spawn——因为第 5 条（简报继承）要求 lead 先有产出。
3. 三窗格并排是新改的 CSS（原先是纵向堆叠）。这是任务「side by side」的硬要求；回归 smoke ALL PASS、真实窗口 3 窗格渲染正确。
4. 截图本环境无法直接预览，但 DOM 探针（跑在真实渲染进程里）已程序化确认三窗格并排、各有 500 行、PNG 466KB@1903×942 与 R8/R9 同量级，非空白窗口。
5. `syncLag` 本轮收尾时三会话都是 0（每会话都在最近一次工具调用里读过黑板），但过程中 lead 中段是 1（`toolCalls:9,boardReads:2,syncLag:1`）——证明这个值在真实推进，不是恒 0。
