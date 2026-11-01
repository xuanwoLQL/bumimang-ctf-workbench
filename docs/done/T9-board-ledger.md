# T9 黑板台账视图

## 做了什么

四类可视化：事实 / 死路 / 意图 / 租约，各一区。冲突事实并列高亮（§8.5：系统只高亮、裁决权归人工）。关键取舍：契约的 `FactView` 没有「挑战了哪条事实」的外键，所以冲突判定只做两件诚实的事——同一归一化内容出现多条 → 并列冲突组；单条 `challenged` → 单独高亮。更细的语义冲突配对需要契约加字段。

## 改了哪些文件

```
apps/desktop/src/renderer/board/model.ts      normalizeContent / findConflicts / isChallenged / inConflict
apps/desktop/src/renderer/board/board.ts      四区渲染 + 冲突高亮 + 证据/状态徽标（DOM）
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node apps/desktop/src/renderer/smoke.ts
```

真实输出（T9 段）：

```
== T9 黑板台账 · 冲突检测 ==
PASS  findConflicts 找到并列冲突  └─ groups=1
PASS  冲突组内 2 条事实  └─ facts=candidate+challenged
PASS  normalizeContent 归一化
PASS  isChallenged 标出被质疑事实
```

## 没做什么 / 已知问题

1. **语义冲突配对（「X 成立」vs「X 不成立」）做不了**：`FactView` 没有 challenge 链接字段，只能按「同一归一化内容」配对 + `challenged` 单条高亮。要支持需要在契约加字段，走 docs/requests/。
2. `board.appended` 事件不折叠进视图：台账 MVP 只消费快照，实时增量靠重拉快照。
3. 冲突组没有做「暂按候选推进」的人工按钮（§8.5 的裁决推迟选项），本轮只做并列高亮。

## 下一手需要什么

- 真实主进程的快照里 facts 带真实状态流转（candidate → verified / challenged）。UI 已按契约字段渲染，无需改。
- 若要语义冲突配对，需要契约新增 fact 之间的引用字段（走文档请求，不能单方面改 events.ts）。
