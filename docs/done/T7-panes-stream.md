# T7 多窗格实时事件流

## 做了什么

每个会话一个窗格，消费 `session.stream`，并做了**强制节流聚合**（ARCHITECTURE §6 已知坑）。关键取舍：`tool_call_update` 只数不画（折叠成计数徽标），`tool_call` 才计入 tool call 计数；每个会话一个 `SessionStreamSink`，默认 80ms 一刷，把高频事件压成低频 DOM 写。节流器与聚合是纯逻辑，可脱离浏览器用 Node 验证。

## 改了哪些文件

```
apps/desktop/src/renderer/throttle.ts         StreamThrottler（时间窗节流）+ aggregateStream（聚合）
apps/desktop/src/renderer/panes/model.ts      SessionStreamSink：每会话流缓冲 → 节流 → 聚合 → PaneLog
apps/desktop/src/renderer/panes/panes.ts      窗格 DOM：header（状态/档位/同步健康度）+ body 追加行
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node apps/desktop/src/renderer/smoke.ts
```

真实输出（T7 段）：

```
== T7 多窗格 · 流式事件节流聚合 ==
PASS  aggregateStream 折叠 tool_call_update  └─ collapsed=2
PASS  aggregateStream 只数 tool_call  └─ toolCalls=2
PASS  aggregateStream 保留重要事件  └─ items=3
PASS  aggregateStream 取到最近 status
PASS  150 条事件被节流成 ≤2 次 flush  └─ flushes=2
PASS  节流不丢事件  └─ total=150
PASS  sink 折叠 150 条 tool_call_update  └─ collapsed=150
PASS  sink 计数 3 条 tool_call  └─ toolCalls=3
PASS  sink 保留 4 行重要事件  └─ lines=4
```

## 没做什么 / 已知问题

1. **真实高频事件下的卡顿没测**：没有 Electron 窗口，节流正确性只在逻辑层验证（150→2 flush），没在真实 Chromium 里压过 150 条/轮的渲染帧率。
2. 同一批 flush 内的 `agent_message` 文本增量是逐条 append 的，没有做「同一消息拼接成一段」的合并——视觉上是多行而不是流式打字机效果。
3. 同步健康度徽标（syncLag 黄/红）已按契约渲染，但 mock 不推 `health` 事件，所以只对快照里已有的会话展示，动态变化待真实主进程。

## 下一手需要什么

- 真实主进程的 `session.stream` 事件（Lane A T5/T11）；接上后本模块无需改动，`hub.onEvent` 已把 stream 路由到对应 sink。
