# P6-C · 真实 benchmark（第 1 批）

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP6；`docs/plans/COMPETITION-READINESS.md` §9（§9.4 真实跑 / §9.5 风险）；`docs/done/P6-A.md`（bench dry-run）/ `P6-B.md`（soak + 代理状态）；`docs/done/WP1~WP5`；`docs/decisions/D-flag-submit.md`
> 日期：2026-10-25
> 状态：**第 1 批完成（单 session 真实跑）**。第 2 批（1 题 × 3 次）/ 第 3 批（3 题 × 3 次）**未开始**，等用户看第 1 批数据后决定。P6-D 完整报告未写。

---

## 第 1 批参数

| 项 | 值 |
|---|---|
| 批次 | 第 1 批：1 题 × 1 次 × 1 agent |
| agent / role / tier | claude / lead / guarded |
| 会话数 | 1（单 session） |
| 靶场 | `hbc2.haobachang.com:23992`（用户中途从 37900 改为 23992） |
| category | **web**（用户确认） |
| difficulty | medium（P6-A schema 只允许 easy/medium/hard；用户未给难度，按 medium 记录） |
| 授权范围 | `scope.enabled=false`；`proxy.enabled=false`（默认，不改 config） |
| timeout | 15 分钟 |
| 执行路径 | **手动 Electron + 真实 agent**（bench runner 不可用，见下） |
| 任务 id / session id | `task-9999666e` / `s7` |
| challenge id | `local-hbc2-20261025-005019` |
| manifest | `benchmarks/challenges.local.json`（gitignored） |

**为什么走手动路径**：`apps/desktop/src/cli/bench.ts` 的非 dry-run 仍返回
`真实跑在 P6-C 实现；本步只做 dry-run`；按用户要求没有自行实现 bench runner。
manifest 的 `expectedFlagFile` 留空——P6-A 的 dry-run 要求非空且文件存在，
因此 dry-run 会报 `expectedFlagFile 必须是非空字符串`；用户选择保持空值、继续手动路径，
不新建占位 flag 文件。manifest 作为本地记录，不作为 bench runner 输入。

---

## 数据（真实测量）

| 指标 | 值 |
|---|---|
| 开始（本地 / UTC） | 2026-10-25 00:52:38 / 2026-10-24T16:52:38Z |
| 超时截止（本地 / UTC） | 2026-10-25 01:07:39 / 2026-10-24T17:07:39Z |
| agent 实际终止（DB ended_at，本地 / UTC） | 2026-10-25 01:12:19 / 2026-10-24T17:12:19Z |
| agent 活跃到超时 | **904,731 ms（约 15.1 分钟）** |
| monitor wall time | **995,805 ms（约 16.6 分钟；含停止/清理等待）** |
| session 生命周期（DB） | 1,181,871 ms（约 19.7 分钟；含超时后手动终止） |
| first flag time | **null（未发现 flag）** |
| tool calls | **45** |
| board reads | **2** |
| skill_search / skill_read | **11 / 2** |
| submit_fact | **1** |
| approvals created | **1** |
| approvals approved / denied / timeout / pending / auto | **1 / 0 / 0 / 0 / 0** |
| 审批等待 | **91,325 ms（约 91.3 秒，人类批准）** |
| errors | timeout_15min；10 次 monitor snapshot 30s 超时；session.stop 60s 超时；renderer 无响应；手动终止 |
| tokens | **null**（ACP 未返回完成态 usage；wire.jsonl 0 条 usage 记录） |
| flagFound | **false** |
| e2EvidenceChain | **false / 未触发**（无 flag 候选） |
| session 最终状态（DB） | **failed**（手动终止 agent 后写入） |
| 目标当前状态 | **不可达**（post-run curl: connection refused） |

### 原始证据

- `evidence/p6c-b1-run-20261025-005019.json`：本表的结构化数据 + `postRun` 事后核实。
- `evidence/p6c-b1-console.txt`：Electron 主进程 console + setup/monitor 日志 + post-run 行。
- `work/task-9999666e/evidence/`：agent 产出的 17 个证据文件（`root_headers.txt`、`cat_app.txt`、`report.md`、`exploit_cat_root.json`、`outage_poll*.txt` 等）。
- `work/task-9999666e/scripts/calc_pin.py`：agent 为 Werkzeug PIN 计算准备的本机脚本。

---

## 观察

### 1. agent 实际做了什么

- **目标指纹**：`Werkzeug/2.2.3 Python/3.7.17`，页面标题「好靶场命令执行 Demo」；`POST /execute` 接收 JSON `command` 并执行，`GET /system-info`；`/console` 是 Werkzeug Debugger 交互控制台。
- **过滤器绕过**：`/execute` 在 Linux 分支用 `re.search(r'[a-zA-Z0-9]', command)` 禁止字母数字；agent 用纯符号 bash 参数展开（`$#`、`${##}`、`${#-}`、`$_` 等）拼出 `cat`，成功读取 `/app` 源码（`app.py` / `Dockerfile` / `entrypoint.sh` / `requirements.txt`）。
- **读取范围**：`cat /*`、`cat /app/*`；根目录与 `/app` 下没有 flag。agent 发现 `/console` 调试器及 SECRET（记录在 `work/task-9999666e/evidence/report.md`，本报告不重复敏感值）。
- **目标宕机**：agent 发送 `/proc` 跨目录通配（`cat /????/????/???????`）后，目标返回 `curl: (52) Empty reply from server`，随后持续 `Could not connect`；report 记录自约 01:00 起 10+ 分钟未恢复。post-run 复核仍未恢复（connection refused）。
- **未出 flag**：stream 中没有 `flag{...}` 命中；没有 flag 候选，因此没有 confirm / submit。

### 2. 技能与黑板（WP2 / WP5）

- `skill_search` 11 次、`skill_read` 2 次、`submit_fact` 1 次、`board_read` 2 次；`board_note` / `board_deadend` 0 次。
- 说明 agent 走了技能检索与黑板读取，没有把过程写成黑板事实/死路（只 submit 了 1 条 fact）。
- 17 个 evidence 文件说明它按证据约定落盘，但**没有 flag 候选**，所以 WP3/WP5 的 E2 证据链、confirm、export 没有被真实触发；`e2EvidenceChain=false` 是“未触发”，不是“链路失败”。

### 3. 审批（WP4 / 安全边界）

- 45 次工具调用只产生 **1 条审批**：一条 high-risk 的 bash 参数展开测试命令；用户在 91.3 秒后批准。
- 该条审批之后，agent 对目标的多次 `curl` / `/execute` 调用**没有再次进入审批队列**。
- 这是本轮的重要观察：**审批覆盖率不是 100%**。claude 的 ACP `session/request_permission` 不是每个终端命令都会发；应用只能对看得见的请求设闸。与 WP4 的“尽力强制、不承诺 OS 级”一致，但真实跑暴露了覆盖率差距，WP6 评估时应重点看。

### 4. 应用可靠性（P0 观察）

- 约 t+12 分钟起，monitor 的 `snapshot()` 开始 30s 超时（共 10 次）；随后 `session.stop` 60s 超时。
- 超时后我们尝试直接终止 agent 的 ACP node/claude 进程；终止后 renderer 仍然无响应（`1+1` 5s 超时、snapshot 30s 超时），最终终止 Electron 应用。
- 主进程仍能处理 agent 退出并写 DB（`s7 status=failed, ended_at=17:12:19Z`），说明**主进程未死，renderer 先挂**。
- console 没有 OOM / `out of memory` / `ENOMEM` 行；本轮**没有采样 Electron/agent RSS**（只有运行前 free=4.01GB），因此**不能断定是内存导致**。
- 这是第 1 批发现的 P0 可靠性问题：真实长回合 + 大流量（stream 5.8MB / wire 24MB）后 renderer 无响应。留 WP7/P6-C 后续定位；本轮不做代码修复。

### 5. token

- 第 1 批 `tokens=null`：ACP 没有返回完成态 usage；会话在长回合中被超时终止，wire.jsonl 中没有 usage 记录（两处 `"usage"` 是工具描述，不是 token 计量）。
- 按用户要求，用 wall time / tool calls 作为代理指标：45 tool calls、15.1 分钟活跃、2 次 board read、11 次 skill_search。

---

## ⚠️ 事故记录：误启动的 verify-ab 真实运行

在查 `verify-ab.ts` 参数时执行了 `node apps/desktop/src/cli/verify-ab.ts --help`；该脚本没有 `--help` 处理，按默认值启动了真实非 dry-run A/B（claude，3 vs 1，240s，默认本机事实 brief）。约 4 分钟后被操作者停止：

- single 阶段完成，multi 阶段启动 3 会话后终止；
- 执行的是本机事实收集（hostname/whoami/uname），**未访问 hbc2 或外部目标**；
- single 会话 ACP usage：`inputTokens=27975, outputTokens=14102, cachedReadTokens=412288, totalTokens=454365`；multi 未返回完整 usage；
- 写入 `.ui-run/ab/`（约 9.3MB，gitignored）；`docs/logs/ab-result.json` 未被覆盖；
- 进程已清理，内存 free 0.95GB → 4.01GB；现场保留未删。

**该事故不计入第 1 批数据**。完整记录见 `evidence/p6c-b1-incident-verify-ab.txt`。

---

## 问题 / 未做

- **目标宕机**：`/proc` 跨目录通配导致目标容器退出/不可达；用户需要重新启动靶场实例后才能进行第 2 批。第 1 批没有拿到 flag，不能把“目标宕机”当成题目结论。
- **renderer 无响应**：真实长回合后 CDP snapshot/1+1 超时，session.stop 超时；已手动终止 agent + Electron；根因未定位，RSS 未采样。P0 可靠性观察，不在本轮修代码。
- **审批覆盖率**：45 次工具调用只有 1 条审批；后续目标 curl 未进审批队列。需要 WP6 评估 claude 的 request_permission 触发条件与策略闸门覆盖面。
- **token 不可得**：ACP 未返回完成态 usage；本轮 `tokens=null`，不伪造。
- **bench runner 未实现**：`bench.ts --no-dry` 仍拒绝；本轮按用户选择走手动 Electron，没有实现 runner。
- **manifest dry-run 不通过**：`expectedFlagFile` 为空；P6-A schema 要求非空且文件存在。用户选择保持空值继续手动路径；manifest 仅作本地记录。
- **scope.enabled=false**：本轮不测范围判定/代理；第 2 批后评估是否开启。
- **单 session**：本轮不测扇出收益（第 2/3 批才测）。
- **没有 confirm / export 真实链路**：无 flag 候选，E2 链/confirm/export 未触发；没有自动 confirm、没有自动提交。
- **没有真实 benchmark 结论**：1 次单 session 不能下“扇出是否有收益”的结论；P6-D 只在第 2/3 批数据后写。

---

## 回归与保护面

```text
npm run verify:all    → 708 PASS / 0 FAIL（未改生产代码）
npm run verify:scope  → 354/354
.probe/backup-wp1/board.db sha256 → 6d491f0b…ab5cf469（未变）
config/app.json sha256 → 4a078402…466bcee4（未变；scope.enabled=false, proxy.enabled=false）
```

本轮只新增/修改：`benchmarks/challenges.local.json`（gitignored）、`evidence/p6c-b1-*`、`docs/done/P6-C.md`、`docs/PROGRESS.md`。**没有改任何生产代码**。

### 证据 sha256

| 文件 | 内容 | sha256 |
|---|---|---|
| `benchmarks/challenges.local.json` | 本地真题 manifest（expectedFlagFile 空） | `f96ef876d37138b7acaeb40c980fb9773441135f08594bb0cc25c49615f8589b` |
| `evidence/p6c-b1-run-20261025-005019.json` | 第 1 批结构化数据 + postRun | `4616ca99b26888e32774b2f0a600a31a3a218e7e206a82c3c5f117124a89dd04` |
| `evidence/p6c-b1-console.txt` | 真实 console + monitor 日志 | `443c2dd84fde6c49f380c346dfaf4161deebe986edc6f0fe23a453d66d071a8a` |
| `evidence/p6c-b1-incident-verify-ab.txt` | 误跑事故记录 | `a8ce8161b2552d0272175e77e4f17b25f5249dec7a82b440bd6336bfaeb06766` |
| `evidence/p6c-b1-verify-all.txt` | 回归 708/0 | `50da1a6c603ca685875decd6f438f26aa4600777a4160691a766e36f85702e54` |
| `evidence/p6c-b1-scope.txt` | 回归 354/354 | `0f905c3923c54be078dd90602245a5d19632026a601b4480b91ef3a2a2524378` |

---

## 已知中间状态

- 第 1 批是**单 session**，不测扇出收益（第 2/3 批才测）。
- `scope.enabled=false`，不测范围判定/代理（第 2 批后评估是否开）。
- 真实 token 消耗**未取得**（ACP 未返回完成态 usage；`tokens=null`）。
- 如果 agent 卡审批，是设计意图（用户要点批准），不是 bug；本轮审批 1 条、等待 91.3s，未触发 5 分钟卡审批停止。
- 第 2 批（1 题 × 3 次）、第 3 批（3 题 × 3 次）等用户看第 1 批数据后决定；**本轮不自动进第 2 批**。
- 60 分钟 soak 仍 interim PASS；multitask F flaky、render-verify 6 项仍挂账；command 模式未实现。
- 目标当前宕机，需用户重启靶场后才能继续。

---

## 批次 1.5 诊断 · renderer 无响应（2026-10-25，只读）

> 约束：**未改任何代码、未启动 Electron/agent、未访问 hbc2:37117**。只读 console/JSON/stream/wire + 静态分析 + 真实 stream 的纯逻辑回放 + 合成 DOM 基准（headless Edge，非 Electron）。
> 完整过程与证据：`evidence/p6c-b15-diagnosis.txt`；原始统计 `p6c-b15-raw-stats.txt`；回放 `p6c-b15-sink-replay.txt`；DOM 基准 `p6c-b15-dom-bench.json`。

### 结论（先说）

- **没有发现单一 renderer 内部根因能解释 30s+ 无响应。**
- **最可能（待批次 1.6 证实）：monitor 的每 1s CDP `snapshot()` + 30s timeout 不取消 → pending eval / observer 队列**。一次短暂慢被放大成持续无响应：10 次 snapshot 超时留下 10 个 pending eval，后面的 `session.stop` 和 `1+1` 排在队列里同样超时。
- **关键反证**：17:01 整分钟 stream 只有 **2 条**事件，monitor 仍有 **105s** 快照空窗（01:00:48→01:02:33）。单纯“stream/DOM 洪泛”解释不了这段。
- 可能的**初始触发**：renderer 完整 UI 同步重绘 + 高频 flush（H2），或主进程 94k 次 `webContents.send` 无背压（H3）；两者都未被 profiler 证实。
- **单纯 pane 文本布局（H5）被削弱**：纯 sink 回放 94,407 updates/5,876 flushes 只用 27.5ms（单 flush max 0.10ms）；合成 DOM 24KB→276KB 可见文本 median 1.1–7.6ms、p95 最高 60.5ms；最大 thought 块 35,682 字符、最长无空格 run 仅 45。
- **主进程 detectAgents/board/artifacts/skill 查询基本排除**：detectAgents 首次 247.6ms、随后 0ms（30s TTL 缓存）；board 查询 median <1ms；listArtifacts median 0.96ms、max 9.70ms；skill index 启动时已建。
- 审批覆盖率、目标宕机、verify-ab 误跑均与 renderer 无关（见下）。

### 时间线（本地 UTC+8）

| 时间 | 事件 |
|---|---|
| 00:51:33 | Electron 启动 |
| 00:52:38 | session s7 启动 |
| 00:52:39–00:56:32 | stream 760→9,305→9,262→8,604→9,225 条/分钟；agent 探测目标、过滤绕过、读 /app 源码 |
| 00:56:32 | monitor 启动，每 1s `window.bumimang.snapshot()`（CDP Runtime.evaluate） |
| 00:57:23 / 00:58:54 | 审批创建 / 人类批准（等待 91.3s）；16:58 仅 702 条 stream |
| 00:59–01:00 | `/proc` 通配 → 目标 Empty reply → connection refused（约 01:00 起） |
| 01:00:48 | 成功 snapshot（距 16:59:24 有 84s 空窗） |
| 01:02:33 | 成功 snapshot（距上次 105s 空窗）；**17:01 仅 2 条 stream** |
| 01:04:27 | 成功 snapshot（距上次 114s 空窗） |
| 01:04:40–01:05:26 | 连续成功 snapshot（15s 节奏） |
| 01:05:26 | 最后一次正常 poll（running, toolCalls=45） |
| 01:07:39 / 01:07:44 | 15min 截止 / monitor terminal=timeout |
| 01:08:44 | `session.stop` 的 CDP evaluate 60s 超时 |
| 01:09:15 | monitor evidence JSON 落盘（sessionStatus 仍 running） |
| 01:12:19 | 手动终止 ACP node/claude 后，DB 写 s7 `failed` |
| 01:12:18 | 最后一条 stream 事件（agent 在 monitor 卡住后仍继续流式输出） |

### 关键证据

- **console**：0 条 `[renderer:*]`；无 uncaught/unhandled、无 OOM/stack/allocation；10 次 snapshot 30s 超时、1 次 session.stop 60s 超时；最后正常 poll 01:05:26。console 由 Electron stdout + driver append 两个 writer 写，**行序不可靠**（`[s7] 异常退出` 位置早于实际 01:12:19）。
- **事件量**：stream 6.58MB / 94,407 行，其中 **agent_thought 92,436（97.9%）**；wire 27.53MB / 94,432 行（in:session/update 94,406）；峰值 ~9,300 条/分钟（~150/s）；最大 stream 行仅 655B，无单条巨消息。
- **纯 sink 回放**：94,407 updates / 5,876 flushes；max blocks=196；max 末块 35,652 字符；可见窗口文本 24KB→270KB；末块文本总和 41.7MB；纯 sink 27.5ms，单 flush max 0.10ms。
- **合成 DOM（headless Edge 151 + 真实 styles.css，120 块）**：24KB→276KB 可见文本，末块 10KB/35KB；total median 1.1–7.6ms，p95 最高 60.5ms；replace median 0ms。
- **renderer 路径**：`session.stream` 不进 store，直接 `panes.pushToSession`；`SessionStreamSink` 80ms throttle；`renderBlockWindow` 每次 flush 用 `patchBlock` 重建末块完整文本并 `scrollToBottom`（读 `scrollHeight`/写 `scrollTop`，强制布局）；`renderLeft` 每次 store 更新整栏 clear+重建；8 个 store 订阅者；CSS `pre-wrap/word-break/overflow-wrap:anywhere`。
- **主进程路径**：`hub.publishStreamUpdate` 每个 update 都 `bus.emit`；`main.ts` 每事件一次 `webContents.send`，**无主进程侧合并/背压**；`streamHistories` 2000 上限只保护 `history()`，实时 stream 不受保护；日志写是异步 WriteStream；`ingestUpdate` 不是 O(n²)。
- **没有** `webContents.on("unresponsive")` / `render-process-gone` 日志，无法从日志区分“renderer 卡住”vs“renderer 崩溃”。
- **主进程仍活着**：01:12:19 写入 s7 failed；detect/board/artifacts 查询实测都很快。

### 根因假设（按可能性排序）

| # | 假设 | 支持 | 反证 | 验证 |
|---|---|---|---|---|
| H1 | monitor/CDP + snapshot 队列 observer 效应（最可能） | 每 1s snapshot；30s timeout 不取消，10 个 pending eval；`session.stop`/`1+1` 排队超时；**17:01 仅 2 条 stream 仍有 105s 空窗**；主进程/agent 仍在写 | 1/s 远低于 150/s；单次 snapshot 不大；首个超时触发点未知 | 批次 1.6 去掉 1s snapshot（主进程/DB/stream 采集或只取一次）+ 可取消 CDP；若不再卡死则 H1 成立 |
| H2 | renderer 完整 UI 同步重绘 + 高频 flush 饱和 | 94k stream/5,876 flushes；132 次 store 更新触发 8 订阅者；`renderLeft` 整栏重建；board.appended 65 条每条全量 refetch；store.emit 同步不吞异常 | 合成 pane DOM 1–8ms；纯 sink 27.5ms；17:01 静默仍空窗；132 次分散 | 真 Electron performance.mark（renderBlockWindow/patchBlock/renderLeft/sync/render）+ mock 高倍率 stream 压测 |
| H3 | 主进程/IPC 背压（94k `webContents.send` 无合并） | 每 update 一次 emit+send；CDP 也走主进程；实时 stream 无上限 | ~78/s 平均、150/s 峰值不算极端；日志异步；主进程 01:12 仍写 DB | 主进程 event-loop lag/队列深度；main-side 50–100ms 合并 prototype |
| H4 | renderer 内存/GC/OOM | 无 RSS 采样；StreamThrottler buffer 无上限；无 unresponsive 日志 | 数据量不大；无 OOM；页面 target 仍在；主进程正常 | 批次 1.6 采 RSS/heap + unresponsive/render-process-gone |
| H5 | pane 文本布局（pre-wrap/anywhere + scrollHeight） | 每 flush 重建末块 + scrollToBottom；可见文本 24KB→270KB | 合成 DOM 1–8ms（p95 60.5ms）；最大块 35KB/无空格 45；17:01 静默空窗 | 真 Electron profiler；对比 rAF/仅跟随底部时滚动 |
| H6 | 主进程 detectAgents/board/artifacts/skill | — | 实测 detect 247.6ms→0ms；board <1ms；artifacts <10ms；skill 已建 | 基本排除 |
| H7 | 审批覆盖率/目标宕机/verify-ab | 独立发现 | 与 renderer 无因果 | 见第 1 批记录；不混为 renderer 根因 |

### 建议修复方向（不改代码，只列方向）

| 方向 | 内容 | 改动面 | 风险 | 可验证性 |
|---|---|---|---|---|
| D1（最高优先，先做） | 修 benchmark harness/观测：不再每 1s CDP snapshot；改主进程/DB/stream 采集或结束时取一次；CDP timeout 后关闭/重建连接；加 unresponsive/render-process-gone、event-loop lag、RSS | 测试 harness + main 日志（不碰 renderer 逻辑） | 低 | 真实 Electron 重跑；可用 mock stream，不烧 token |
| D2（若 H2/H3） | 主进程 stream 合并/背压：50–100ms 合并 agent_thought，队列上限；保留 message/tool_call/审批 | main hub/manager（契约语义不变） | 中 | mock 高频压测 + 真 Electron；无新依赖 |
| D3（若 H2/H5） | renderer pane 硬化：末块文本增量更新、scrollToBottom 改 rAF/仅底部跟随、单块/窗口文本上限、thought 抽稀 | renderer/panes/model.ts + panes.ts | 中（滚动/显示行为） | smoke 纯逻辑 + 真 Electron stream 回放 |
| D4（若 H2） | store/UI 更新合并：session.upsert/health 批量、renderLeft 增量、refetchBoard 节流 | renderer/main.ts + panels | 中 | smoke + Electron |
| D5（总是） | 可观测性：unresponsive/render-process-gone、event-loop lag、RSS、IPC 队列深度 | main + 可选 debug IPC | 低 | 真 Electron |
| D6（不要） | 未区分 H1/H2/H3 前直接大改 renderer（可能修错地方） | — | — | — |

### 需要真实 Electron 才能确认

- H1 vs H2/H3 的归因：需要 main/renderer 双端计时 + event-loop lag；可先用 **mock 高倍率 stream** 在 Electron 里压测，不必启动 agent。
- H4：需要真实 renderer RSS/heap/DevTools Memory。
- H5：需要真实 Chromium/Electron Performance profiler（headless Edge 只是近似）。
- 完整 94k stream + 45 tool calls + 审批的真实重放需要真实 agent；第 2 批前应先用 mock 验证修复，避免再烧 token。
- **批次 1.6 顺序建议**：D1（不改产品、排除 observer）→ 仍卡则用 mock 压测区分 H2/H3 → 再决定 D2–D4。

### 与第 1 批其他发现的关系

- **审批覆盖率**：独立。console 有 `命中已授权规则 ... scope=session`，session 级 execute 授权自动放行；45 calls/1 approval 不是 renderer 卡住导致。
- **目标宕机**：独立。agent 的 `/proc` 跨目录通配导致目标容器退出；与 renderer 无关。
- **verify-ab 误跑**：独立事故；未访问 hbc2；与本次诊断无关。
- **console 行序**：`[s7] 异常退出` 位置不可靠（双 writer）；DB ended_at 01:12:19 才是实际退出时间，不是早期崩溃。

### 零代码改动

本步只新增 `evidence/p6c-b15-*` 与在 `docs/P6-C.md`、`docs/PROGRESS.md` 追加文字；未改任何 `.ts/.css/.json` 代码文件；未启动 Electron/agent；未访问 hbc2:37117。`verify:all` **708/0**、`verify:scope` **354/354** 为本步重跑结果。

---

## 批次 1.6 · D1 monitor + D5 可观测性 + mock 高倍率压测（2026-10-25，08:01）

> 约束：不改 renderer 产品逻辑（store.ts / panes.ts / renderer/main.ts）、不改 hub.ts / board.ts / events.ts；不启动真实 agent/Electron；不访问靶场；不烧 token。
> 目标：按批次 1.5 的 D1/D5 先排除 observer，并用真实第 1 批 stream 做 renderer 侧最坏情况压测，决定第 2 批能否直接跑。

### 1.6a · D1 修 monitor

**文件**：`apps/desktop/src/cli/bench-monitor.ts`（新建；批次 1 的临时 `%TEMP%\p6c-b1-monitor.mjs` 已被系统清理，不在仓库内）。

策略变化：

- **DB + stream.jsonl 为主数据源**：每 5s 只读 `board.db`（sessions / approvals / flag_candidates / flag_sources）+ 按字节偏移增量读 `stream.jsonl`；
- **CDP 只做可选 one-shot**：默认每 30s 一次 `window.bumimang.snapshot()`；每次新建 WebSocket，`finally` 关闭；
- **CDP timeout 30s 后 close + 清 pending**：不再把 pending `Runtime.evaluate` 留到下一轮；下一次 interval 重新 resolve/reconnect；CDP 失败只记日志，DB/stream 主流程继续；
- 不自动批准、不自动 confirm；`session.stop` 只在 timeout/approval_stall 且 CDP 可用时尝试。

验证（无 Electron/agent）：

```text
node apps/desktop/src/cli/bench-monitor.ts --self-test → 20 PASS / 0 FAIL
  - fake CDP timeout 80ms → ok=false / socket closed / pending=0 / bounded 108ms
  - 第二次调用使用新连接并成功
  - 真实 batch-1 DB：s7 failed、1 approval approved by human、flags=0
  - 真实 batch-1 stream：94,407 lines、agent_thought 92,436、max line 655B
  - EOF 增量读 0 lines、offset 不重复
非 CDP 主循环（真实 batch-1 DB/stream）→ endedReason=session_failed，JSON 落盘
```

口径提示：DB `sessions.tool_calls=66`（按 `tool_call` 事件计数）；第 1 批 monitor 的 health `toolCalls=45`（健康度口径）。新 monitor 同时记录 `toolCallsDb` / `toolCallsHealth`（后者仅在 CDP snapshot 成功时有值），不再混用。

### 1.6b · D5 可观测性

**文件**：`apps/desktop/src/main/electron/main.ts`（仅 main；sha256 `c8038fc0…73a945efd`）。

新增 4 类日志（`[obs]` 前缀，走现有 stdout；行数受控）：

1. **renderer 健康事件**：`webContents.on("unresponsive")` / `"responsive"` / `"render-process-gone"`（reason/exitCode）。
2. **event-loop lag**：`setInterval` 5s + `process.hrtime.bigint()`；lag = 实际间隔 - 5000ms，只有 >100ms 才写日志；timer `.unref()`。
3. **RSS/堆**：`setInterval` 30s + `process.memoryUsage()`（rss/heapUsed/external）；timer `.unref()`。
4. **IPC 发送量/队列**：`ipcEventSends`（dispatch 的 task.upsert + bus 每个 hub:event）、`ipcStreamSends`（session.stream）；每 30s 输出 `ipcDelta30s/ipcTotal/streamTotal`；Electron 未公开 `webContents.send` 队列深度，显式记 `queueDepth=不可观测`。

未改启动恢复/配额/审批守卫/preload；未改 renderer 产品代码；未改 hub/board/events。静态检查：

```text
node --experimental-strip-types --check main.ts → exit 0
verify:all 708/0；verify:scope 354/354；verify:bench 73/73
```

按约束**未在 Electron 中运行** D5；日志将在第 2 批真实跑时生效。

### 1.6c · mock 高倍率 stream 压测

**输入**：真实第 1 批 `stream.jsonl`（94,407 条；sha256 见 `evidence/p6c-b16-stress.json`；agent_thought 92,436 / agent_message 1,531 / tool_call 66 / tool_call_update 280 / other 93 / user_prompt 1；max line 655B；max thought 块 35,652 字符）。

**方法**：真实 `SessionStreamSink` 80ms 窗口回放 + `Store`（8 个 no-op 订阅者，132 次 session.upsert/health）+ headless Edge（真实 styles.css）按真实 per-flush 可见窗口文本/末块文本做 `patchBlock + scrollHeight + scrollTop` 合成 DOM 基准。不启动 Electron/agent。

**结果**：

| 指标 | 值 | 阈值 | 结果 |
|---|---|---|---|
| sink flushes | 5,876 | — | — |
| sink flush 总时间 | **14.06 ms** | <1,000 ms | PASS |
| sink 单 flush max | **1.96 ms** | <50 ms | PASS |
| sink max blocks / max 末块 / max 可见文本 | 196 / 35,652 / 270,000 字符 | — | — |
| sink JS 堆增长 | **3.58 MB** | <100 MB | PASS |
| store 132 events 总时间 / max | **0.62 ms / 0.39 ms** | <1,000 ms | PASS |
| store JS 堆增长 | **0.01 MB** | <100 MB | PASS |
| renderLeft（纯视图模型 132 次） | **0.29 ms** | 仅代理指标 | 覆盖缺口 |
| DOM top-12 实际 pairs：max patch/布局/滚动/总 | **0.3 / 4.1 / 0.1 / 4.4 ms** | 单 flush <50 ms | PASS |
| DOM JS 堆（Edge performance.memory） | 10MB → 10MB（粒度粗） | <100 MB | PASS |

判定：**`pass_with_coverage_gap`**（failures=[]）。

- 已覆盖：renderer stream/sink、store/emit、pane patch/scroll 的真实最坏文本特征。
- 未覆盖：真实 `renderLeft`/其他 panel DOM、真实 Chromium 主线程调度/GC、真实 94k IPC 背压——这三项只能在真实 Electron 中由 D5 观测。
- 结论：**按已覆盖指标不卡**；第 2 批可以直接跑，但必须带新 monitor + D5 日志。若真实跑仍卡，D5 的 unresponsive/lag/RSS/IPC 日志会区分 H2/H3/H4；目前不需要 D2/D3/D4。

### 第 2 批参数与待确认项

- 用户给出的第 2 批参数：1 题 × 3 次 × 1 agent（claude）、单 session、`scope.enabled=false`、category=web。
- **靶场地址在用户消息中出现两个值**：约束段 `hbc2.haobachang.com:37117`，已知中间状态段 `hbc2.haobachang.com:11137`。本步**未访问任一**；进第 2 批前必须由用户确认哪个是正确的。
- 第 1 批目标 `23992` 已宕机；第 2 批前需用户重启/确认新靶场可用。
- 第 1 批的 3 个独立发现仍挂账、不阻塞第 2 批：审批覆盖率（45 calls/1 approval，session 级 execute 自动放行）、目标宕机（`/proc` 通配）、verify-ab 误跑（独立事故）。

### 已知中间状态

- D1/D5 是**测试 harness + 观测改动**，不是产品修复；renderer 产品代码零改动。
- mock 压测不能 100% 替代真实 Electron + agent（Chromium 性能特征可能不同），但覆盖了 renderer 侧最坏 stream/pane/store 场景；full-UI DOM/IPC 仍需 D5 在真实跑中观测。
- 若第 2 批仍卡，D5 日志会给出卡点；届时再决定 D2（主进程合并/背压）/D3（pane 硬化）/D4（store/UI 合并）。
- 60 分钟 soak 仍 interim PASS；multitask F flaky、render-verify 6 项仍挂账；command 模式未实现。

### 证据（sha256）

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p6c-b16-d1-monitor.txt` | D1 self-test + 非 CDP 主循环 + 摘要 | `7e2a7b525f569751bb54484686901e50fceaf8ae506ba8df35b6045ddfb4961f` |
| `evidence/p6c-b16-d1-monitor-run.json` | 真实 batch-1 DB/stream 的 monitor 输出 | `66c11b316fccccd81e53dca2e54f8c91dc4e0b7e9b5dc406749b973f9621450a` |
| `evidence/p6c-b16-d5-observability.txt` | D5 4 类日志/静态检查/未改项 | `5807ddb1eee7c08f91a08bbb52d362bc9fbfeb3d59fc2ca9a3a58d316a9f5990` |
| `evidence/p6c-b16-stress.json` | 1.6c 压测结构化结果 | `844d6da1ac4074c7a62c7fce9c4bfbd2daf5990531d6bb9eb1f7638d2120f411` |
| `evidence/p6c-b16-stress-console.txt` | 1.6c 压测 console | `d0bb867aa45224c42687cafc5ecd38d574ec8712bf78f7378493c25757dd9607` |
| `evidence/p6c-b16-verify-all.txt` | 708/0 | `a093a3395100ba3819fe376a3dcd11f17d3eca4d06cbfb546e2e79aca0938398` |
| `evidence/p6c-b16-scope.txt` | 354/354 | `2462aa2da8e7e5ca9b1c38e70389a44213a4c353c9faf7305d1cf983caab07dc` |
| `evidence/p6c-b16-bench.txt` | `verify:bench` 73/73 | `6efdce7411b9df4ca7b0f2663beb35a3c9da9eb7ce61d9155bf297ef238ef9d9` |

代码 hash：

| 文件 | sha256 |
|---|---|
| `cli/bench-monitor.ts`（新增） | `ea4143d8cff14ab54696659495b7d9b651bce061dedebb763da8699e6b7d1d88` |
| `cli/bench-stress.ts`（新增） | `8ef4d2b0de31ed8995ec3ac55dcea1421e9d3b2b88d2f544941e875767683554` |
| `main/electron/main.ts`（D5） | `c8038fc0c8831a3732eba2e2fd252076c7c8ba1695fa630df42b36e73a945efd` |
| `renderer/store.ts` | `498a535c…f2337558`（未改） |
| `renderer/main.ts` | `8992289d…a5ca257b`（未改） |
| `renderer/panes/panes.ts` / `model.ts` | `397bbdf7…9214cb2` / `76928115…682ed75`（未改） |
| `main/hub/hub.ts` / `board.ts` / `events.ts` | `2e13beab…892a22` / `815402af…391da95e` / `cbf17a04…8bf14a84f`（未改） |
| `package.json` / `verify:all` 链 | `219c136b…279772`（未改） |

保护面：`.probe/backup-wp1/board.db` 仍 `6d491f0b…ab5cf469`；board v3；config/rules 未改；renderer 产品代码零改动。

---

## 批次 2 · 真实 benchmark（11137/web；run 1 完成，run 2 页面卡住停止，run 3 未跑）

> 参数：1 题 × 3 次 × 1 agent（claude），每次单 session，`scope.enabled=false`，target `hbc2.haobachang.com:11137`，category=web，tier=guarded，timeout 15min/run；手动 Electron + 人工审批 + D1 monitor + D5。
> 结果：**planned 3 / completed 1 / partial 1 / not run 1**。批次 2 因 run 2 页面卡住提前停止；**未进 run 3，未进批次 3/P6-D**。

### Run 1（完成，已出 flag）

| 指标 | 值 |
|---|---|
| 时间 | 2026-10-25 08:08:05–08:23:11（wall 905.5s） |
| first flag | **592.6s（约 9.9 分钟）** |
| tool calls / board reads | **53 / 3** |
| approvals created / approved / denied | **0 / 0 / 0** |
| tokens（ACP） | **781,585 total**（input 3,939 / output 5,934 / cachedRead 771,712；4 条 usage） |
| flag | `flag{b3f1a60403ab4cf5925f464951463485}`（`/tmp/flag.txt`，39B） |
| evidence | **E2**（`work/task-f266bfb5/evidence/FLAG_FOUND.md` 存在） |
| 候选状态 | **new；未 confirm、未 submit**；task status=solving，answer=null |
| session | DB `stopped`（monitor 在 15min timeout 时停止；flag 已在 592.6s 出现） |
| D1 monitor | 22 CDP snapshots / **14 timeouts**；DB/stream 主路径完整记录；D5 RSS 133–143MB 稳定，无 unresponsive/lag |
| D5 | 无 unresponsive / render-process-gone / event-loop lag >100ms |

### Run 2（部分；页面卡住，用户选择立即停止）

| 指标 | 值 |
|---|---|
| 时间 | 2026-10-25 08:24:11–08:31:35（wall 约 444s） |
| tool calls | **34** |
| stream | **63,242 行**（agent_thought 62,272；agent_message 766；tool_call 34；tool_call_update 130） |
| approvals / flags | **0 / 0** |
| tokens | **null**（会话被手动终止，无完成态 usage） |
| session | DB 仍 `running`（**手动 kill，不是干净停止**；下次 app 启动 recoverStaleSessions 才会收敛） |
| D1 monitor | live monitor 在页面卡住后被用户停止；用 D1 的 DB/stream 路径生成部分 JSON；数据未丢 |
| D5 | RSS 135–140MB 稳定；heapUsed 13.8–17.5MB；IPC ~4,000–5,400/30s；**未记录 unresponsive / render-process-gone / event-loop lag >100ms**；CDP one-shot 超时是唯一实时信号 |

**页面卡住的复现与归因**：把 **run 2 真实 stream** 喂给同一 1.6c 压测：

```text
sink: 3,989 flushes / 5.95ms total / max 0.23ms / maxBlocks=88
      maxLastText=69,623 chars / maxVisibleText=221,366 chars
store: 132 events / 1.08ms / max 0.36ms
dom:   maxTotal=181.1ms（阈值 50） / layout=181ms / replace=8.1ms / scroll=0.2ms
verdict: fail（failures=dom.maxTotalMs=181.1）
```

- Run 1 stream 的 max thought 块是 **35,652**，run 2 是 **69,623**；run 1 stress `pass_with_coverage_gap`，run 2 stress **fail**。**每轮 agent 的 thought 块大小差异很大**，1.6c 只用 run 1 样本不足以覆盖最坏情况。
- 页面卡住的最可能原因是 **renderer pane DOM 布局（H5/H2）**：每 80ms flush 对末块 `replaceChildren` 完整文本 + `scrollToBottom` 读 `scrollHeight`；69.6KB 末块/221KB 可见文本时单次布局 **181ms**，超过 50ms 阈值，渲染主线程饱和；不是 H1 observer 为主因。
- **D1 monitor 有效**：CDP 超时/页面卡住时，DB/stream 仍完整采集；run 1 在有 14 次 CDP 超时的情况下仍拿到 flag。
- **D5 覆盖缺口**：main-process RSS/lag 稳定，`unresponsive` 未触发；当前 D5 看不到 renderer 主线程的 long task / renderer RSS。下一步需要 D5.2（renderer long-task/heartbeat + `app.getAppMetrics()` 的 renderer 进程指标）。

### Run 3

**未跑**。用户在 run 2 页面卡住后选择“立即停止 run 2”，并同意暂不进 run 3。批次 2 只有 1/3 完整 + 1/3 部分，**不能当成 3 次样本下结论**。

### 结论

- **Run 1 成功**：claude 在 9.9 分钟找到 flag（E2 证据链完整，候选 new，未自动 confirm/submit）；D1 monitor 在 CDP 多次超时下仍完整记录，真实 token 781,585。
- **Run 2 失败于 UI**：页面卡住；agent 仍在跑（34 tool calls、无审批、无 flag），用户选择立即停止；DB 留 `running`（手动 kill，不是干净停止）。
- **根因优先级更新**：H5（pane DOM 布局）+ H2（renderer 完整 UI/stream 饱和）为本轮页面卡住的主因；H1 observer 不是主因；H3/H4 未被 D5 主进程指标证实。1.6c 的 `pass_with_coverage_gap` 只对 run 1 样本成立。
- **下一步应先修**：D3（pane 硬化：末块文本增量更新、避免每 flush `replaceChildren`/`scrollHeight`、单块/窗口文本上限）为最直接；D2（主进程 50–100ms 合并）和 D4（store/UI 合并）可并行评估；D5.2（renderer long-task/heartbeat + renderer RSS）用于验证修复。修完后以 **run 2 stream stress（maxLastText 69,623 / DOM 181ms）** 作为回归 gate，再决定补 run 3 / 批次 3。
- **不要**在未修复前再跑真实 agent；页面卡住会重复出现。

### 第 1 批 / 批次 2 的独立发现

- **审批覆盖率**：run 1 0/53、run 2 0/34，第 1 批 1/45；批次 2 完全没有审批。agent 通过 MCP/命令执行找 flag，未触发 `session/request_permission`；WP6 需评估审批覆盖率与 claude 触发条件，不作为本批 UI 卡住的原因。
- **目标状态**：11137 在 run 1/2 后仍 HTTP 200；brief 中“不要 /proc 跨目录通配”生效，本轮未再打宕目标。第 1 批 23992 的宕机是独立事件。
- **verify-ab 误跑**：独立事故（`evidence/p6c-b1-incident-verify-ab.txt`），与批次 2 无关。
- **flag**：run 1 候选为 `new`，未 confirm/submit；用户可在 UI/数据中复核后手动处理。

### 回归与保护面

```text
verify:all    708/0
verify:scope  354/354
```

批次 2 未改任何生产代码；只新增/更新 `benchmarks/challenges.local.json`（11137，gitignored）、`evidence/p6c-b2-*`、`docs/P6-C.md`、`docs/PROGRESS.md`。renderer/store/hub/board/events 哈希不变；backup db 未变。

### 证据（sha256）

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p6c-b2-run-1-monitor.json` | run 1 完整 monitor（flag/E2/token） | `2e9a64effca4cb109eb97ba80a1cc469b91fd7468147cfad0b0aae9d33ee03cc` |
| `evidence/p6c-b2-run-1-console.txt` | run 1 D5 + monitor console | `f41cd3d7021e409be5fd09ada2a36e281f9d0530e5070371ea9500c5a3570411` |
| `evidence/p6c-b2-run-2-monitor.json` | run 2 部分（pageHung/manualKill） | `4958023a74d39b2eb321c8dd4dd3c21800c0c73fb65d99166f026cd77caaba5a` |
| `evidence/p6c-b2-run-2-console.txt` | run 2 D5 + monitor console | `405803420f80eb2bc3e92022e2c612985de9beab0be16657574bcc12feb61687` |
| `evidence/p6c-b2-run-2-stress.json` | **run 2 stream stress：fail / dom 181.1ms** | `90871ad507871d5a07319d922eade3090d67159f41280794d6a616935cd68bb8` |
| `evidence/p6c-b2-run-2-stress-console.txt` | run 2 stress console | `76d5f19f79a41ad73c5184986625b5320faceb0805830490165484eca1db3cfb` |
| `evidence/p6c-b2-runs.json` | run 1/2/3 汇总 + pageHang 归因 | `d2acd034a1d59d21dde1a2f7180430707ff6d483a52d78ab27cb180416c66708` |
| `benchmarks/challenges.local.json` | 11137/web 本地 manifest | `e0639305fef70a09c45c687c1e740268a4d4e07f48beb9fe2c1a73ccc4e75422` |
| `evidence/p6c-b2-verify-all.txt` | 708/0 | `ba15904ea9e0233e4ad23ebeb23289a8e4322a6e80c9cfde71ab163e1a98ee78` |
| `evidence/p6c-b2-scope.txt` | 354/354 | `15507015c1fb08a2401979938475b7238e49da3af17e1f443146393a4fc762f8` |

---

## 批次 2.1 · D3 pane 硬化 + D5.2 renderer 观测（2026-10-25，08:45）

> 依据批次 2 run 2 的 page hang：run 2 stream DOM 181.1ms（阈值 50），max thought 块 69,623。用户选择 **D3 + D5.2**。
> 只改 renderer pane/model + renderer 观测 + main 观测；**store.ts / hub.ts / board.ts / events.ts 未改**。

### D3 · pane 硬化

- `renderer/panes/model.ts`
  - `MAX_THOUGHT_TEXT = 32_768`：只截断 **thought** 块；保留最后 32K 字符 + `…（前文过长已省略）` 标记；message/tool/plan 不截断。
  - `MAX_WINDOW_TEXT = 131_072`：follow 模式下可见窗口的总文本预算。
  - `fitWindowStart(blocks, windowSize, maxText)`：纯函数，按块数 + 文本预算计算窗口起点；panes.ts 与压测 harness 共用。
- `renderer/panes/panes.ts`
  - `patchBlock`：head 只建一次；文本块优先在现有 Text 节点上 `appendData`（增量），不再每次 flush `replaceChildren` head + 完整文本 div；tool 的 kind/status/title 原地更新。
  - `scheduleScroll`：follow 模式滚动改为 `requestAnimationFrame` 合并，避免每次 flush 同步读 `scrollHeight` 强制布局。
  - `renderBlockWindow`：follow 窗口起点用 `fitWindowStart(..., MAX_WINDOW_TEXT)`；超出预算从头部丢老块（`加载更早` 仍可回看）。
- 语义取舍：thought 超过 32K 的旧文本会被截断（保留最近 32K）；message/plan/tool 完整保留；thought-heavy 窗口可能少于 120 块，这是有意的显示预算。

### D5.2 · renderer 观测

- `renderer/main.ts`
  - 5s `[renderer heartbeat]`（console.log，主进程 console-message 转发）。
  - `PerformanceObserver({entryTypes:["longtask"]})`：>100ms 的 long task 写 `[renderer longtask]`（best-effort）。
- `main/electron/main.ts`
  - `console-message` 解析 heartbeat；主进程每 5s 检查，>15s 未更新写 `[obs] renderer heartbeat missing …`。
  - RSS 日志增加 `app.getAppMetrics()`：`processes=[Browser,GPU,Utility,Tab:…MB]`（Tab = renderer）；agent 子进程不在此列表。
- 受控验证（无 agent/靶场）：正常窗口 35s → heartbeat 每 5s、`processes=[...Tab:7492:136MB/122MB]`；CDP busy-loop 20s → **`renderer heartbeat missing 19880ms`**，之后 heartbeat 恢复。longtask observer 在本次受控测试中未产出 entry（best-effort；heartbeat missing 是工作信号）。

### 修复前后 gate（run 2 真实 stream）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| maxLastText | 69,623 | **32,779** |
| maxVisibleText | 221,366 | **131,071** |
| DOM maxTotal | **181.1ms** | **14.3ms** |
| DOM layout max | 181ms | 12.8ms |
| sink total / max flush | 5.95ms / 0.23ms | 79.87ms / 0.96ms |
| verdict | **fail** | **pass_with_coverage_gap** |

run 1 stream 回归：DOM maxTotal 14.2ms、maxLastText 27,892、pass。

### 回归

```text
smoke        320/320（317 + 3 条 D3 断言；旧 317 零删除）
verify:all   711/0（确定性 391 + smoke 320）
verify:scope 354/354
verify:bench 73/73
Electron --verify 26/26（无 agent；加载真实 renderer）
```

### 真实 run 2 retry（D3/D5.2 后）

- 目标 11137/web；task `task-b04592b2` / session `s10`；claude/lead/guarded；scope=false。
- **flag 已出**：`flag{b3f1a60403ab4cf5925f464951463485}`，E2，**first flag 533.7s（约 8.9 分钟）**；tool calls 37；approvals 0；tokens **244,337**（2 条 usage）；候选 **new，未 confirm/submit**；task 仍 solving/answer null。
- **D5.2 真实信号**：`renderer heartbeat missing` **9 次**（17,624 / 47,658 / 17,656 / 23,106 / 53,137 / 23,203 / 53,247 / 23,377 / 53,422 ms）；Tab RSS 137→176→151→162MB；main event-loop lag 124ms。**页面仍会长时间阻塞**，只是这次 agent 在主进程/子进程侧继续跑到 flag。
- **D3 s10 stream 压测仍 pass**：maxLastText 32,779、maxVisible 131,072、DOM maxTotal **17.2ms**；说明 pane 合成 gate 通过，**缺口在 full-UI store/panel 重绘与/或主进程 IPC（D4/D2）**，不是单纯 pane 文本。
- 运行后按用户要求停止；s10 DB 仍 idle（手动 kill，下次启动 recover）；run 3 未跑。
- 结论：**D3 + D5.2 部分是有效的**（pane gate 14–17ms、D5.2 能抓到真实 heartbeat missing），但**真实高倍率 full-UI 仍会阻塞**；下一步应做 **D4（store/UI 批处理/增量 renderLeft）+ D2（主进程 50–100ms stream 合并）**，再重跑 run 3。

### 限制 / 未做

- headless Edge 合成 DOM 镜像了 D3 的 cap/window/incremental patch；**真实 Electron 高倍率 stream 未跑**（不启动真实 agent）；下一次真实跑才是最终验证。
- D5.2 heartbeat missing 已验证；longtask observer 未在受控测试中产出 entry（可能 Electron/Chromium 不暴露 longtask），heartbeat missing 是主信号。
- `console-message` 出现 Electron 弃用参数 warning（仍工作）；后续可按新事件对象迁移。
- D3 截断只针对 thought；message/plan/tool 不截断。旧 thought 文本不可恢复（显示层）。
- **run 3 未跑**；批次 2 仍是 1 完整 + 1 部分；批次 3/P6-D 未开始。

### 代码 hash

| 文件 | sha256 |
|---|---|
| `renderer/panes/model.ts` | `8855f8b5cc6736dc83f0e9e13403a6256e3826f4a33617b8971ffdc6a713a7ef` |
| `renderer/panes/panes.ts` | `69d869d1822e38b8df30fc355061ed3523db10487e6dd3210e8d18b7d4bb3a5f` |
| `renderer/main.ts` | `7d31fbf411c97c2f1a53d513bce96b20876dcbd9dd382ee5b3c89ab229441e5f` |
| `main/electron/main.ts` | `6e178ff5cd1fccbcea88fbd27683b1b8733aa991b20ea30485c0db1af09732bf` |
| `renderer/store.ts` | `498a535c…f2337558`（未改） |
| `hub.ts` / `board.ts` / `events.ts` | `2e13beab…892a22` / `815402af…391da95e` / `cbf17a04…8bf14a84f`（未改） |
| `package.json` / `config/app.json` | `219c136b…279772` / `4a078402…466bcee4`（未改） |

### 证据（sha256）

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p6c-b21-stress-run2.json` | 修复后 run2 stream gate | `5b7837b202d8a01ba72c59dd6c21241a530a528b39a7b07e63c291b423208442` |
| `evidence/p6c-b21-stress-run1.json` | 修复后 run1 stream 回归 | `d948795b02a14ddc42de720ca45b98745cd5c38e74d24e1089cda5ec9a12a2c9` |
| `evidence/p6c-b21-smoke.txt` | smoke 320/320 | `004387251f804dc307b677bc008500d8d21dc720206eb257be40265d89b4cfd2` |
| `evidence/p6c-b21-verify-all.txt` | verify:all 711/0 | `697b7c2521aee93d3172d0d1f2be8029a01da9e09d896e6895a9780e67c9faea` |
| `evidence/p6c-b21-scope.txt` | scope 354/354 | `e3dba9808eaa0eda511adaba96146678b7413fd0fdb103669d176e37bf62c3cb` |
| `evidence/p6c-b21-bench.txt` | bench 73/73 | `8972d2b102163e76b1627af19c35583477685f91001647692a0351c806308ca8` |
| `evidence/p6c-b21-electron-verify.txt` | Electron 26/26 | `1884a584e62b50fa419b840dd557028f1e40d7c32b16c610778621037396739d` |
| `evidence/p6c-b21-d5-live.txt` | D5.2 live + 20s block | `b4bcb8d507c7d609c8a177bf4fee9d34b702aa6030147bceba1fb796861b0035` |

---

## 批次 2.2 · D4 store/UI 批处理 + D2 主进程 stream 合并（2026-10-25，09:05）

> 依据 run 2 retry：D3 pane gate 通过（s10 stream DOM 17.2ms），但 D5.2 仍记录 9 次 heartbeat missing（17–53s）→ full-UI store/panel 重绘/主进程 IPC 缺口。用户选择先做 D4+D2。

### D4 · renderer store/UI 批处理

- `renderer/main.ts`：
  - `session.upsert` / `health` 进入 `queueStoreEvent`：100ms 或 200 条批量 `store.update`，8 个 store 订阅者只重绘一批；
  - `approval.upsert` / `permission.updated` / `flag.updated` / `artifact.updated` / `task.upsert` / `board.appended` 仍立即处理；
  - `renderLeft` 整栏重建改为 **rAF 合并**；store 批量更新后一帧最多画一次。
- 未改 `store.ts` / hub / board / events。

### D2 · 主进程 IPC 层 stream 合并

- `main/electron/main.ts`（renderer IPC 层，不改 Hub bus）：
  - `session.stream` 每 80ms 合并一次；相邻 `agent_thought` 合并文本（保留最后一个 seq/ts）；`agent_message` / `tool_call` / `tool_call_update` / 其他不合并；
  - 队列上限 2000，超过立即 flush；before-quit 先 `flushStreamEvents()` 再关桥/库；
  - Hub 的 bus 事件仍逐条（verify 套件直接订阅 Hub，不受影响）；stream.jsonl/history/flag 扫描仍逐条。
- 未改 `hub.ts` / board / events。

### Gate

```text
smoke        320/320
verify:all   711/0
verify:scope 354/354（首跑 353，A 组 target notes 单条 transient；rerun 354；target CRUD 未受 D2/D4 影响）
verify:bench 73/73
Electron --verify 26/26（D4 批量未破坏 UI 验收）
D3 s10 stream gate 17.2ms（pane 层仍 pass）
```

### 真实 full-UI 验证状态（更新 09:32）

- **目标连续不稳定**：11137 → 23928（down）→ 34766（unreachable，用户确认）。
- **run 3 尝试 1（23928）**：s11，44 tool calls，0 flag，0 审批；target down 后停止（`p6c-b23-run-3-monitor.json`）。
- **run 3 尝试 2（34766）**：s12，36 tool calls，**1 条审批 human approved**，0 flag；用户确认 target unreachable 后停止（`p6c-b24-run-3-monitor.json`）。
- **D2 确实生效**：23928 尝试 90,290 条 raw stream → **~8,193 次 IPC sends（约 11x 减少）**；D4 store 批量/rAF renderLeft 也生效。
- **但 D5.2 仍记录 heartbeat missing**：23928 尝试 **9 次**、34766 尝试 **6 次**（15–49s）；Tab RSS 133–151MB；main event-loop lag 323ms。**D2/D4 没有完全修好 full-UI 阻塞**。
- **没有第三个 flag 样本**；批次 2 最终是 2 个 flag 样本（run1 592.6s、run2 retry 533.7s）+ 旧 run2 预修复 partial + 2 个 run3 abort；计划 3 次未完成；P6-D 不能写结论。
- 两个 flag 候选均 new，未 auto-confirm/submit；task 均 solving/answer null。
- 目标 34766 当前不可达；s12 DB 仍 running（手动 kill，下次启动 recover）；无残留 Electron/agent。

### 代码 hash

| 文件 | sha256 |
|---|---|
| `main/electron/main.ts`（D2+D5.2） | `fa6a84ca041a3019c5887d9bea63a0103614db35b8292caad67541f50759a105` |
| `renderer/main.ts`（D4+D5.2） | `bff0076196425d2ea7d6b0440bbf2793f7fa5d2a8ad53199b619c98df4657893` |
| `renderer/panes/model.ts`（D3） | `8855f8b5cc6736dc83f0e9e13403a6256e3826f4a33617b8971ffdc6a713a7ef` |
| `renderer/panes/panes.ts`（D3） | `69d869d1822e38b8df30fc355061ed3523db10487e6dd3210e8d18b7d4bb3a5f` |
| `renderer/store.ts` / `hub.ts` / `board.ts` / `events.ts` | `498a535c…` / `2e13beab…` / `815402af…` / `cbf17a04…`（未改） |

### 证据（sha256）

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p6c-b22-smoke.txt` | smoke 320/320 | `cbab7ee2310b9aed698e3182b4b94da6158a2e9eb292bd6614088ebdb50cc854` |
| `evidence/p6c-b22-verify-all.txt` | verify:all 711/0 | `8617228aa628bf693748092b7dce903754147efd3aa0f2f5633b8afcaf984c17` |
| `evidence/p6c-b22-scope.txt` | scope 354/354（rerun） | `9fa2c20fa9f2af24df40ec2d2be381de340b5b13767db6a87febb447231374fc` |
| `evidence/p6c-b22-bench.txt` | bench 73/73 | `604ecfcd5e8ed7b0babcf2f0cadf4001bbbb34bcb879ab11fd6a690375d230ce` |
| `evidence/p6c-b22-electron-verify.txt` | Electron 26/26 | `943c34869b5103d983aff3c8fcd8bf887dba66a72ff3f1580f3cb5589e534c41` |

---

## 批次 2.3 · renderer full-UI mock stress（真实 s11 stream 回放，2026-10-25，09:41）

> 目标不可用，不再跑真实 agent。用 **Electron 真实 renderer + mock hub**，preload 注入真实 s11 stream（90,290 updates）回放；同时注入 tool_call→health/session.upsert、每 1000 条 board.appended；无 agent/靶场/token。
> 目的：区分“renderer pane/store 自身”与“主进程/IPC/真实 app 数据”。

### 结果

```text
renderer: real UI, mock hub, ?stress=replay
heartbeats: 12 / heartbeat missing: 0 / unresponsive: 0 / render-process-gone: null
blocks: 90（D3 cap 生效）
maxText: 32,779（MAX_THOUGHT_TEXT）
totalText: 247,495 / scrollHeight: 82,397
Tab (renderer) RSS: ~180MB stable
UI >50ms logs: only startup panes.sync 89.5ms + longtask 104ms
pane.flush / renderLeft: no >50ms logs during replay
errors: 0
```

**结论：renderer 的 D3（thought cap/window/incremental patch/rAF）+ D4（store batch/rAF renderLeft）+ D5.2 能扛住真实 90k stream 的 full-UI 回放。**

### 这意味着什么

- 真实 run 的 `renderer heartbeat missing`（D2/D4 后仍 6–9 次）**不是** mock full-UI 能复现的 pane/store 问题。
- 剩余嫌疑：
  1. **主进程/IPC**：D2 只把 renderer IPC 从 90,290 降到 ~8,193；主进程仍逐条处理 90k raw update（ingest/stream.jsonl/bus），heartbeat 由主进程 console-message 计时，主进程/IPC 延迟会造成 missing；
  2. **真实 app 数据/面板**：真实 app 有 14 任务、目标、审批卡、17 evidence artifacts、board facts、approvalsAll 等；mock 只有 2 任务/2 panes；
  3. **真实 ACP/agent 交互**：tool_call/agent_message 的分布、审批、target 面板与 mock 回放不同。
- D2 IPC 11x 减少已确认；D4 store batch 已确认；D3 gate 17.2ms；这些不是无效，但不足以单独解释真实 missing。

### 测试/代码

- `renderer/mock/engine.ts`：`stress` / `stressStream`（仅测试；默认关闭；smoke 320 不变）。
- `renderer/hub.ts`：`?stress` / `__stressStream`（仅测试）。
- `renderer/panes/panes.ts` / `renderer/main.ts`：`[ui panes.sync]` / `[ui pane.flush]` / `[ui renderLeft]` >50ms 计时日志（D5.2 扩展；默认行为不变）。
- 临时 harness/preload：`%TEMP%\p6c-b25-mock-stress.ts`、`p6c-b25-replay-preload.cjs`（非产品）。
- 证据：`evidence/p6c-b25-mock-stress.json`、`p6c-b25-replay-console.txt`。

### Gate

```text
smoke 320/320；verify:all 711/0；scope 354/354；bench 73/73；Electron 26/26
```

### 下一步方向（待用户选）

- **A. main+renderer IPC 压测**（fake Hub + 真实 preload/IPC + D2）：隔离主进程/IPC 是否是 missing 来源；无 agent/靶场。
- **B. 真实数据 mock full-UI**：复制 14 任务/审批/board/artifacts 数据 + 真实 stream；隔离真实 app 面板。
- **C. 暂停**。
- 目标仍不可用；run 3 未完成；P6-D 不写结论；flag 两个 new 未 confirm。

---

## 批次 2.4 · main+renderer IPC stress（2026-10-25，09:46）

> fake Hub/SessionManager + **真实 preload/IPC** + 真实 HubService/D2；s11 90,290 updates 逐条 `hub.publishStreamUpdate`；tool_call→publishHealth/publishSessionRec；每 1000 条 board.appended。无 agent/靶场/token。

### 结果

```text
raw updates: 90,290
D2 stream sends: 2,899（4k/s 回放；真实 run 100/s 时是 ~8,193）
D2 event sends: 3,078（含 health/session.upsert/board.appended）
heartbeats: 12 / missing: 0 / unresponsive: 0 / render-process-gone: null
blocks: 90；maxText: 32,779（D3 cap）；totalText: 252,766；scrollHeight: 84,575
Tab (renderer) RSS: 138–141MB stable
UI >50ms logs: none
errors: 0
```

**结论：main+renderer IPC（真实 preload/ipc、真实 Hub/D2、真实 s11 stream）也稳定，heartbeat missing=0。**

### 这排除了什么

- 排除了 **renderer pane/store**（2.3 mock full-UI 0 missing）和 **main/IPC/Hub/D2**（2.4 0 missing）作为 missing 的直接来源。
- 真实 run 的 missing 剩余嫌疑：
  1. **真实 app 数据/面板**：14 任务、targets、approval cards、17 evidence artifacts、board facts、approvalsAll、14 任务左栏；mock/IPC harness 只有 1–2 任务/0 artifacts；
  2. **真实 ACP/SessionManager**：ACP client/wire.jsonl（~27MB）、SessionManager.appendStream/history、真实 tool_call/approval 分布；
  3. **D5.2 observer 本身**：heartbeat 由主进程 console-message 计时；真实主进程还承担 ACP/DB/stream/wire/审批/监控 stdout；主进程/IPC 延迟可能造成 missing，而页面实际可用（用户 run2 retry/run3 未再报“页面卡住”）。
- **D2/D3/D4/D5.2 不是无效**：D2 已把 IPC 从 90k 降到 2.9k–8.2k；D3/D4 让 renderer/mock/IPC 都能扛住真实 stream。

### Gate

```text
smoke 320/320；verify:all 711/0；scope 354/354；bench 73/73；Electron 26/26
```

### 证据（sha256）

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p6c-b25-ipc-stress.json` | IPC stress 结构 | `50004aeb196dc2efa2b59658d4d8ac7157c96d736cc5612f4522b5adeb7fe9b9` |
| `evidence/p6c-b25-ipc-stress-console.txt` | IPC stress console | `6107fd793298ba85841c1a2560337d8a1ed7a51f56549b3e5567b300b7978faf` |
| `evidence/p6c-b25-mock-stress.json` | mock full-UI replay | `fb89f9f8537b4f88de4461eb5313375af48284d6fac09c56b044309be04e9723` |
| `evidence/p6c-b25-replay-console.txt` | mock replay console | `2fbc36d99b358e43058f4723cb986aa325f773522dce33816a3c56c5f63b21d8` |

### 下一步（待用户选）

- **B. 真实数据 mock full-UI**：复制 14 任务/审批/board/artifacts/targets + s11 stream 到 mock full-UI；隔离真实 app 面板。
- **C. D5.2/真实主进程审计**：检查真实 main 的 console-message/heartbeat 路径、ACP wire/stream log、SessionManager、监控 stdout；判断 missing 是页面真卡还是 observer 误报。
- **D. 暂停**。

---

## 批次 2.5 · 真实数据 mock full-UI（2026-10-25，09:52）

> 用真实 `.ui-run/board.db` 副本 + `D:/agent/xuanwo/work` 构造 Hub snapshot（17 tasks / 28 artifacts / 2 flags / 1 approval / board facts/deadends/intents / 1 target / 4 agents / scoreboard / skill / policy），preload 注入 `__realSnapshot` + s11 90,290 stream；真实 renderer + mock hub；无 agent/靶场/token。

### 结果

```text
real snapshot: tasks 17 / artifacts 28 / flags 2 / approvalsAll 1 / targets 1 / agents 4
stream: s11 90,290 updates
heartbeat: 12 / missing: 0 / unresponsive: 0 / render-process-gone: null
blocks: 90；maxText: 32,779；totalText: 249,288；scrollHeight: 82,811
Tab (renderer) RSS: 191MB stable
UI >50ms logs: only startup panes.sync 88ms + longtask 103ms
errors: 0
```

**结论：真实 app 数据/面板（17 任务/28 artifacts/2 flags/1 approval/board/targets/skill/policy）+ 真实 s11 stream，renderer full-UI 仍稳定，heartbeat missing=0。**

### 累计排除

- 2.3 mock full-UI（2 任务）：missing 0；
- 2.4 main+renderer IPC（真实 preload/IPC/Hub/D2，s11 90k）：missing 0；
- 2.5 真实数据 mock full-UI（17 任务/28 artifacts/approvals/board）：missing 0。
- **剩余嫌疑只剩**：
  1. **真实 ACP/SessionManager**：ACP client/wire.jsonl（~27MB）、`SessionManager.appendStream`/history、真实 tool_call/approval 分布；
  2. **D5.2 observer / 真实主进程**：heartbeat 由主进程 console-message 计时；真实主进程还承担 ACP/DB/stream/wire/审批/监控 stdout。真实 run 的 missing 可能是 observer 误报/主进程延迟，页面实际可用（用户 run2 retry/run3 未再报“页面卡住”）。

### Gate

```text
smoke 320/320；verify:all 711/0；scope 354/354；bench 73/73；Electron 26/26
```

### 证据（sha256）

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p6c-b25-real-stress.json` | 真实数据 full-UI stress | `474cd5518631717c0fe35d1f3cb3c17eb417eb102124fbbb6917b12ea800e2a3` |
| `evidence/p6c-b25-real-stress-console.txt` | 真实数据 console | `36698483434638d4f9a5756752e09dbf8cd2cda440478a6a7989b294d92e1d2b` |
| `evidence/p6c-b25-real-snapshot-summary.json` | 快照统计（17/28/2/1/…） | `1e0b2d052bed489f96c0291f6977cd85f2c208a2afb56f8aa6d531dfbd18a288` |
| `evidence/p6c-b25-ipc-stress.json` | A IPC stress | `50004aeb196dc2efa2b59658d4d8ac7157c96d736cc5612f4522b5adeb7fe9b9` |
| `evidence/p6c-b25-mock-stress.json` | 2.3 mock full-UI | `fb89f9f8537b4f88de4461eb5313375af48284d6fac09c56b044309be04e9723` |

### 下一步（待用户选）

- **C. D5.2/真实主进程审计**：检查真实 main 的 console-message/heartbeat、ACP wire/stream log、SessionManager、监控 stdout；判断 missing 是页面真卡还是 observer 误报。
- **D. 暂停**。
- 目标仍不可用；run 3 未完成；P6-D 不写结论；flag 2 个 new 未 confirm。

---

## 批次 2.6 / C · D5.2 / 真实主进程审计（2026-10-25，02:21，只读）

> 范围：无真实 agent、无靶场、无产品代码改动。目的：判断真实 run 的 `[obs] renderer heartbeat missing` 是 **renderer 主线程 stall**，还是 **观测/主进程误报**。

### 真实日志复盘

源：`evidence/p6c-b22-run-2-console.txt`（run2 retry，D3/D5.2 后、D2 前，s10，78,885 行）、`p6c-b23-run-3-console.txt`（s11，90,290 行，D2 后）、`p6c-b24-run-3-console.txt`（s12，45,811 行，D2 后）。

| run | heartbeat | missing | missingMs | main lag | longtask | [ui >50ms] | unresponsive | gone |
|---|---|---|---|---|---|---|---|---|
| b22 | 40 | 9 | 17,624–53,422 | max 124ms | 0 | 0 | 0 | 0 |
| b23 | 56 | 8 | 18,733–54,468 | max 323ms | 0 | 0 | 0 | 0 |
| b24 | 60 | 6 | 15,654–49,771 | max 575ms | 0 | 0 | 0 | 0 |

lastHB 反推（check 时间 − missingMs）：
- b22：00:49:32.987 → 00:50:33.013 → **00:55:32.996 起 1 次/分钟（:33）**
- b23：01:11:01.992 → 01:11:32.997 → **01:16:32.994 起 1 次/分钟（:33）**
- b24：01:22:41.998 → 01:25:01.994 → 01:25:32.983 → 01:30:07.013（有审批/窗口切换噪声）

**关键**：b22/b23 的 5s→1/min 转变恰好发生在最后一次正常 5s 心跳之后 **300s**（299.983s / 299.997s），之后心跳固定 :33 每分钟一次；missing 的 23s/53s 交替只是 30s 检查相位（:27/:57）。这是 Chromium 对隐藏页面 **5 分钟后 intensive timer throttling（定时器压到 1 次/分钟）** 的精确特征，不是 54s 主线程长任务。同期 main lag 仅 124/323/575ms、Tab RSS 稳定、无 longtask/UI 超时/unresponsive/gone。

### 代码事实（未改动）

- 真实 `BrowserWindow` webPreferences（`apps/desktop/src/main/electron/main.ts:1005-1012`）**没有 `backgroundThrottling: false`** → Electron 默认 true（最小化/遮挡/隐藏时节流 timer/animation）。
- renderer 5s heartbeat 是 `setInterval`（`apps/desktop/src/renderer/main.ts:767-769`）。
- D5.2 在主进程 `console-message` 到达时才更新 `lastRendererHeartbeat`（`main.ts:1042-1045`），每 5s 检查 missing>15s（`main.ts:319-334`）→ 测的是 **console 消息送达时间**，不是 renderer 计时器实际触发时间。
- 真实 run 以 `--remote-debugging-port=9333` 启动，D1 monitor 可选 one-shot CDP；live console 的 cdpSnapshots 与最终 monitor JSON 的 `cdp.enabled=false` 不一致（疑似第二个无 `--cdp-port` 实例覆盖 JSON），单独记录，不影响结论。

### 受控实验（真实 s11 90,290 updates；无 agent/靶场）

| 实验 | 数据/通道 | 结果 |
|---|---|---|
| 2.3 mock full-UI | mock engine + preload | HB 12，missing 0 |
| 2.4 fake + real IPC/D2 | fake Hub/SessionManager + 真 preload/IPC/D2 | raw 90,290 → 2,899 sends；HB 12，missing 0 |
| 2.5 real data + mock | .ui-run 快照（17 tasks/28 artifacts/2 flags/1 approval）+ mock | HB 12，missing 0 |
| C1 real data + real IPC/D2 | .ui-run 副本 + 真 HubService（fake SessionManager 读真实行）/preload/D2 | raw 90,290 → 2,899 sends；HB 12，**missing 0**；blocks 90、maxText 32,779、Tab RSS 149MB、UI>50ms 0、unresponsive 0、errors 0 |
| C2 C1 + CDP one-shot ×3 | 4s/29s/54s `window.bumimang.snapshot()`，10–24ms | HB 12，**missing 0** |
| C3 隐藏窗口 + 默认节流 + renderer 探针 | show→hide@5s，400.6s，独立 5s 时间戳数组 | **复现**：product HB 18、missing 11（19.9/50.0s 交替）；独立探针 gaps = **11×5s + 1×10s + 5×60s**；hide 后 ~55s 进入 10s→60s；无 CDP/agent/靶场；无 error/warn/unresponsive |

C3 结果：hide@02:09:27.559，probe visibility=hidden；product 18 次 heartbeat、independent probe 也 18 次且首末时间与 product 基本一致（02:09:27.984–02:15:32.993），两者同步被压到 60s → **renderer 自己的 5s 计时器被 Chromium 后台节流**，不是 console 送达延迟；隐藏期间 sampleDom 的 executeJavaScript 仍每 10s 准时返回（t+251…391），说明主线程可响应，只有 timer 被节流。final DOM blocks=50（visible C1=90），隐藏时 rAF/UI 也被节流。restore 变体（hide@5s→show@150s）show 后 probe 记录 visible 仅 36ms 又被系统置回 hidden，DOM 始终 50/90，**未形成补齐结论**（需可交互桌面/AlwaysOnTop 复测）。C3 的 55s 时点比真实 b22/b23 的 300s 更早（可能与 90k 高倍率回放更快耗尽后台 timer budget 有关），机制同为 background timer throttling。

### 结论

1. 真实 missing **不是 renderer 主线程 stall**：无 longtask/UI 超时/unresponsive，main lag <600ms、RSS 稳定；b22/b23 在最后一次正常心跳后恰好 300s 转为 1 次/分钟，符合后台窗口 intensive timer throttling，而不是 54s 长任务。
2. 机制链：窗口最小化/被完全遮挡/隐藏 → Electron 默认 `backgroundThrottling:true` → Chromium 后台 timer 节流（C3 hide 后 ~55s budget 耗尽进入 60s；真实 b22/b23 低流率下 5min intensive 后进入 1/min）→ 5s `setInterval` 被压到 1 次/分钟 → main 按 console-message 到达时间判 missing。D5.2 文案 “renderer main thread may be blocked” 在此场景是**误报**。
3. CDP one-shot 单独不足以复现（C2 missing 0）；C3 无 CDP 即复现，后台窗口在真实数据/IPC/D2 下已足够。
4. 隐藏时 DOM 只渲染到 50/90 blocks（rAF/任务被节流）；恢复可见后的补齐未在本批验证，不能据此判定 store 丢数据。
5. **不影响 D3/D4/D2 的结论**：D3 修的是真实 pane DOM 卡顿（run2 stream stress DOM 181ms→14–17ms），D4/D2 降 store/IPC 压力；真实 run3 的 missing 不能作为“renderer 仍卡住”的证据。pre-D3 的页面卡住是真实的，已修复。
6. 后续真实跑应在心跳里记录 `document.visibilityState`，否则无法区分“最小化/遮挡”与“真卡住”。

### 修复方向（本批不改，待用户选）

- **D7a（推荐）**：D5.2 v2 —— renderer 自测 gap（performance.now）+ visibilityState；main 在 hidden 时抑制/标注 missing，只在 visible 时告警“stall”。不改变后台行为，保留真实卡死检测。
- **D7b**：真实 BrowserWindow 加 `backgroundThrottling:false`（一行）。后台继续跑 timer/rAF/动画，心跳稳定，但有 CPU 代价，需评估。
- **D7c**：monitor CDP 只在页面可见/DB+stream 停滞时 snapshot，或降低频率；非本问题主因，可顺手降干扰。

### 限制

- 未在真实 agent run 复测（11137/23928/34766 全部 down/unreachable）；C3 是隐藏窗口模拟（`win.hide()`），不代表用户真实最小化/遮挡方式。
- Restore 变体（show@150s）受系统遮挡：show 后 36ms 又被置 hidden，仅一次 3.7s visible；恢复补齐/是否丢块未形成结论，需可交互桌面或 `setAlwaysOnTop` 复测。
- C3 的 90k 高倍率回放可能更快耗尽后台 timer budget（hide 后 ~55s 进入 60s），真实 run 的低流率下 5min intensive 才进入 1/min；机制相同、时点不同。
- b24 有审批/窗口切换噪声，300s 证据以 b22/b23 为准。
- monitor JSON 的 `cdp.enabled=false` 与 live console cdpSnapshots 不一致；未追查第二实例来源。
- 本批零产品代码改动；仅新增 evidence 与本文档。

### 证据（sha256）

- `evidence/p6c-c-audit.txt` `53b5cbd513eda7d9d445e4aaafdd281fa4b06b7b60da061f29f1f97ab1e34cc6`
- C1 `evidence/p6c-b25-ipc-real-stress.json` `dc34fb191b6e899247dc0365348741390708b8f58487c19c5b821a46957c68b1`
- C1 console `evidence/p6c-b25-ipc-real-stress-console.txt` `2ca3a269c6f642f7946ce1c18d6e9023ab1fcf556059b1d3455a64c9fa7f6f72`
- C2 `evidence/p6c-b25-ipc-real-cdp-stress.json` `e023486239d4573d68e4b1205c0d572c05a4759f92667eeeb1fb9cf4c6408e66`
- C2 console `evidence/p6c-b25-ipc-real-cdp-console.txt` `a3535a38e17053a7be3a31cab1305585014d6b2b53bf3bf54a7cf419d5aa0812`
- C3 `evidence/p6c-b25-ipc-real-hidden-stress.json` `2d307de03657ecea7756ae0bec212d38915ad1349f716bc18f3de835a15aecae`
- C3 console `evidence/p6c-b25-ipc-real-hidden-console.txt` `d19528104ebb8da8b8b486160d0b3d4232021ef3e9be76ffb61bca91418d9d16`
- Restore `evidence/p6c-b25-ipc-real-restore-stress.json` `86b703a2103735a9b3234338c6b6a722a05a2fba921baa7a8403cdaddee77170`
- Restore console `evidence/p6c-b25-ipc-real-restore-console.txt` `6d5f31ba92649f567217b5ed27d14110b0d0f3139d05288d9a5e6007953313f9`
- 真实 console：b22 `613246d2de59fd81d53e161dfad81ff0916df7423bf0c5c37967142a2111cfcf`、b23 `2011007a65ad06bc1ee64d5376ccec2785b23914ec9a265cfbf9ca82a1ff0a30`、b24 `a7e94a19ff691d64bdc9649ce655fb272989e4cc294f0ed6a2230f742c633116`

## 批次 2.7 · D7a 观测 + flag confirm 闭环 + 靶场探测（2026-10-25，10:3x，零行为改动）

> 用户要求：不启动真实 agent、不烧 token、不做 D7b/D7c。2.7a 仅改观测代码（renderer 心跳 + main D5.2）；2.7b 用现有 Hub action 操作 live board；2.7c 只读 GET `/`。

### 2.7a · D7a 观测改进

- `renderer/main.ts` 的 5s 心跳**间隔不变**，消息新增 `visibility` / `prevVisibility` / `gapMs` / `throttled`；`gapMs` 是 renderer 自己用 `performance.now()` 测的相邻两拍间隔。
- 新增 `main/electron/heartbeat.ts`（纯函数）：`parseRendererHeartbeat`、`classifyHeartbeatEvent`、`classifyHeartbeatMissing`。
- `main.ts` D5.2：hidden/`throttled=1` → `renderer heartbeat throttled-hidden`；visible 且真实 `gap>15s` → `renderer heartbeat stall`；记录 `renderer visibility X -> Y`；去掉 “renderer main thread may be blocked”。
- **未改** `backgroundThrottling`（仍默认 true）；**未改** renderer store/panes/events/config。
- 单测 **17/17**（旧格式兼容、hidden 60s→throttled-hidden、hidden→visible 60s 不算 stall、visible 20s→stall、missing 三分类）。
- **真实 app 集成**：批次 2 的 `evidence/p6c-b2-console.txt` 有 **73 条 `renderer heartbeat throttled-hidden`**（18,968–56,567ms，visibility=hidden），**0 条 `renderer heartbeat stall` / `may be blocked`**；D7a 在真实 main+renderer 生效。
- 门禁：verify:all **711/0**、scope **354/354**、flags **214/214**、electron `--verify` **26/26**。

### 2.7b · flag confirm/export/submit 闭环（live board）

两个 E2 flag：
- `flag-22d28fd0` / `task-f266bfb5` / `flag{b3f1a60403ab4cf5925f464951463485}` / `evidence/FLAG_FOUND.md` / s8
- `flag-eaa1ce39` / `task-b04592b2` / 同值 / `evidence/flag.txt` / s10

每个走：
- `flag.confirm` → 候选 `confirmed`、`task.answer=value`、`task.status=solved`、`solved_by=human`；events/audit 各 1 条 `flag.confirm`。
- `flag.export` md/csv/json → 均返回 content（含真实 value），不写文件；每次记 1 条 `flag.export` 事件。task-b04592b2 的导出还包含占位候选 `flag-bd3751f4`（new），未确认/未提交。
- `flag.submit` manual → `submitted_at>0`、`submit_status=manual`，返回 value + instructions（明确不自动提交/不调用平台 API）；events/audit 各 1。
- `flag.submit` dry_run → 只返回 argv（含 value），候选状态/时间、events/audit 均不变。

占位候选 `flag-bd3751f4`（`flag{...}` E0）保持 **new**。两个任务最终均 `solved`、answer 为真实 flag。live board post-close sha256 `d41dc98a…d6994f`；闭环检查 **58/58 PASS**。

### 2.7c · 靶场只读探测

只发 `GET /`，无 payload、无 POST、未访问 `/execute`：
- `hbc2.haobachang.com:44892` → **HTTP 200**（8,745B，114.66.24.20）
- `hbc2.haobachang.com:11137` / `23928` / `34766` / `37900` → connection refused（curl 7）
- 结论：当前仅 44892 可用；批次 2 若跑真实 agent 应使用 44892。

### 状态与限制

- `backgroundThrottling` 仍 true；hidden 节流现在标 `throttled-hidden`，不再当 stall。
- 占位候选仍留在 board（用户选择忽略）；导出 task-b04592b2 时会包含它，但它未 confirm/submit。
- 2.7b 操作为真实 live board 变更（两个 flag confirmed + manual submitted），非产品代码改动；备份在 `%TEMP%/p6c-b27-board-backup-*`。
- 靶场 44892 只做了 GET `/` 可达性探测，未验证题目内容/可用性。

### 证据（sha256）

- `evidence/p6c-b27-d7a.txt` `d4587668a1c9fbc59772483d622bbef0e97519395dbfa553b4b771a3d8965303`
- `evidence/p6c-b27-d7a-unit.txt` `d4326926d075452c34df3c70b4fb4c8926cf3348df08abcb74d3b7d1c269b87a`
- `evidence/p6c-b27-flag-confirm.txt` `5ba095005d948c155d0d3a3547e4f658d74a219178a0a0d654d5af44a293927c`
- `evidence/p6c-b27-target-probe.txt` `1457c27d15fb2bd22ff99cf2ce599d29d8ac3805e53baeafd7ace4b3ebf302fa`
- 基线：`p6c-b27-verify-all-post.txt` / `-scope-post` / `-flags-post` / `p6c-b27-electron-verify.txt`

## 批次 2 · 第二次真实跑（P6-C b2b，44892 → 53865，2026-10-25，11:00）

> 用户要求本窗口连续执行：1 题 × 3 次 × 1 agent（claude），每次独立 task、单 session，`scope.enabled=false`，手动 Electron + 人工审批，15min/run，跑间 60s。**不自动批准/不自动 confirm/submit**。这是 WP6 第二次真实跑，区别于 10-25 08:xx 的第一次批次 2。

### 参数与目标变更

- Run 1/2：`hbc2.haobachang.com:44892`（HTTP 200）
- Run 2 跑后 44892 **connection refused**；按规则标记 `target_down=true`，暂停 run3
- 用户 03:34 更新靶场为 `hbc2.haobachang.com:53865`（HTTP 200），run3 使用 53865
- 因此 run1/2 与 run3 是**不同 target 实例**；两枚 flag 值不同（run1 `flag{e54b…}`、run3 `flag{6d46…}`），跨 run 严格可比性有限

### 三次数据

| run | target | task / session | wall | first flag | tool calls | approvals (created/approved/denied) | tokens | flag / E2 | target_down | 终态 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 44892 | task-0f6e80f7 / s13 | 902.8s | **570.5s** | 36 | 0/0/0 | 260,654 | **E2** / `evidence/FLAG.txt` | false | timeout（monitor 停止） |
| 2 | 44892 | task-d318d279 / s14 | 904.9s | null | 33 | 1/1/0 | 0（1 条零 usage） | 无 | **true**（跑后 refused） | timeout（monitor 停止） |
| 3 | 53865 | task-1bc5b36b / s15 | 903.9s | **422.6s** | 32 | 2/2/0 | 224,441 | **E2** / `evidence/flag-read.txt` | false | timeout（monitor 停止） |

- 三次 wall 都是 **15min monitor timeout 边界**，不是 agent 完成时间；不能当作解题耗时。
- 每次 taskId/session 独立；run2 的 1 条审批为用户人工批准（本地 `/tmp/t` 命令）；run3 的 2 条审批均人工批准（本地 tmp-test /etc/passwd 子串实验）。无自动批准。
- run1/run3 flag 候选均 `new`，未 confirm/submit；run2 无候选。

### 聚合（evidence/p6c-b2-summary.json）

| 指标 | 值 |
|---|---|
| wall | median 903.9s / std 0.9s（timeout-bound，无信息量） |
| first flag | median **496.5s**（n=2：422.6s、570.5s；range 147.9s；std 74.0s） |
| tool calls | median **33**（32–36；std 1.7） |
| approvals | median **1**（0/1/2）；总 created 3 / approved 3 / denied 0 |
| flags | **2/3 E2**；1/3 无 flag 且 target_down |
| tokens | 260,654 / 0 / 224,441（run2 零记录不可比） |

### 观察

- **skill_search 使用**：run1 12 次、run2 18 次（+skill_read 5 次）、run3 **0 次**；黑板 read_since / submit_fact 三次都用。
- **E2 链**：run1 `evidence/FLAG.txt`、run3 `evidence/flag-read.txt` 均 E2；run2 无。
- **审批覆盖率低**：101 次工具调用只有 3 条审批，run1 为 0；agent 大量 Bash 未触发 `session/request_permission`（已知 WP4 限制）。
- **target 稳定性是外部主变量**：run2 无 flag 与目标 down 同时发生；run3 换 53865 后才出 flag。
- **一致性**：2/3 出 E2；三次 tool calls 32–36 接近，但 target 变更 + run2 down，不能断言 3 次一致。
- **扇出建议**：样本仅 2 个有效 flag、target 不稳定；**不足以给出扇出收益结论**，需稳定靶场 + 更多 run。

### 限制

- run1/2 与 run3 target 不同；flag 值不同，不能视为同一实例的 3 次重复。
- run2 `target_down=true` 来自跑后探测，不是连续 target 监控；无法精确判定宕机时刻。
- 所有 wall 都是 timeout 边界；first flag 是唯一可比的解题指标（n=2）。
- run2 tokens=0（1 条零 usage），不是真实消耗；token 中位数受 0 影响。
- 本轮未改产品代码；manifest 最终为 53865；flag 均未 confirm/submit。

### 门禁

- verify:all **711/0**、verify:flags **214/214**、verify:scope **354/354**（post-batch 首次 353/354，失败为已知 `target notes` transient，rerun 354/354）
- `.probe/backup-wp1/board.db` sha256 未变：`6d491f0b…ab5cf469`

### 证据

- run JSON：`evidence/p6c-b2-run1-2026-10-25T03-16-54-901Z.json`、`evidence/p6c-b2-run2-2026-10-25T03-33-08-035Z.json`、`evidence/p6c-b2-run3-2026-10-25T03-49-30-252Z.json`
- monitor：`evidence/p6c-b2-run{1,2,3}-monitor.json` / `.txt`
- setup：`evidence/p6c-b2-run{1,2,3}-setup.txt`
- 聚合：`evidence/p6c-b2-summary.json`
- target：`evidence/p6c-b27-target-probe.txt`、`evidence/p6c-b2-target-checks.txt`

## 下一手需要什么

- **B. 真实数据 mock full-UI 已稳定**：17 任务/28 artifacts/2 flags/1 approval/board/targets/skill/policy + s11 90,290 stream → **heartbeat missing 0**、blocks 90、maxText 32,779、Tab 191MB。结合 2.3/2.4，**renderer 数据/面板 + main/IPC/Hub/D2 都能扛住真实 stream**。
- **真实 missing 已归因（批次 2.6/C）**：不是 ACP/SessionManager，也不是 console 送达；是 **Electron 默认 `backgroundThrottling:true` 下，窗口最小化/遮挡/隐藏时 Chromium 把 5s 心跳压到 1/min**。C3 独立 renderer 探针与 product heartbeat 同步出现 60s gaps，确认不是主线程 stall。run2 retry/run3 未再报“页面卡住”与此一致；run3 missing 不能当页面卡住证据。
- **下一步（待用户选）**：
  - **D7a（推荐）**：D5.2 v2 —— renderer 自测 gap + visibilityState；main 在 hidden 时抑制/标注 missing，只在 visible 时告警“stall”。
  - **D7b**：真实 BrowserWindow 加 `backgroundThrottling:false`（一行，CPU 代价需评估）。
  - **D. 暂停**（等靶场恢复再跑真实）。
- **目标 11137/23928/34766 均不可用**；run 3 两次 abort；批次 2 仅 2 个 flag 样本（run1 592.6s、run2 retry 533.7s）+ 旧 partial；P6-D 不能写结论。
- **flag**：run1 `flag-22d28fd0`、retry run2 `flag-eaa1ce39`，同一值 `flag{b3f1a60403ab4cf5925f464951463485}`，均 **new，未 auto-confirm/submit**；task 均 solving/answer null。
- **审批**：s12 1 条 human approved；run1/retry run2 0。
- 60 分钟 soak 仍 interim PASS；multitask F flaky、render-verify 6 项仍挂账；command 模式未实现；`console-message` 弃用参数 warning 待迁移。

**目标不可用 + renderer/数据/main/IPC mock 都稳定 + C 审计完成（missing=后台 timer 节流）；停下等你选 D7a/D7b/D，不自动启动真实 agent。**
