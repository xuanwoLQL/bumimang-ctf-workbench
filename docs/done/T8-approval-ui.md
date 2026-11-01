# T8 审批队列 UI

## 做了什么

三栏审批卡片（左：命令全文+目标；中：agent 自述意图，缺省退化「暂无自述意图」；右：命中规则+风险+同类历史），支持放行 / 拒绝 / 放行并记住，以及顶部全放行 / 全拒绝。关键取舍：排序严格按 ARCHITECTURE §9.5「风险高到低、同风险 FIFO」，同会话同动作做批次聚合 key（`groupBatches`）为「批量」留好接口。

## 改了哪些文件

```
apps/desktop/src/renderer/approval/model.ts     排序 / 过滤 / 批次聚合 / buildDecideAction / buildBulkAction
apps/desktop/src/renderer/approval/approval.ts  三栏卡片 + 按钮 + 批量条（DOM）
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node apps/desktop/src/renderer/smoke.ts
```

真实输出（T8 段）：

```
== T8 审批队列 · 排序 / 批量 ==
PASS  pendingApprovals 过滤出 4 条  └─ pending=4
PASS  风险排序：blocked/high 在前  └─ order=blocked,high,medium,low
PASS  sortApprovals 风险优先  └─ first=blocked
PASS  groupBatches 同会话同动作聚批  └─ batches=4
PASS  buildDecideAction 形状正确
PASS  buildBulkAction 形状正确
```

Mock 集成段同时验证了 `dispatch(approval.decide)` 返回 ok 且 `ap1` 状态变 `approved`。

## 没做什么 / 已知问题

1. **批量只做了「全放行/全拒绝」**，`groupBatches` 算出的同会话同动作批次还没有做成「每批一键放行」按钮——接口在，UI 没铺开。
2. **「记住并放行」只发 `remember` 标志**，Mock 引擎忽略它；真正的规则学习落库是 Lane A 策略引擎的事（§9.5）。
3. 审批卡片的「同类历史」直接用了契约 `sameKindCount`，没有本地再数；若真实主进程不维护该字段，UI 会显示 0 次。
4. 排序后的队列只展示 pending；已决（approved/denied）不进列表，复盘视图不在本轮范围。

## 下一手需要什么

- Lane A 的真实审批队列（T4）推 `approval.upsert` + 消费 `approval.decide/approval.bulk`。UI 已经只依赖契约动作，不依赖实现。
