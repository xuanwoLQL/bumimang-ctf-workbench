# 不迷茫 · 低延迟改造（V3）

## 实测瓶颈

改造前比赛直播期间：

- renderer 可见 DOM 约 2431 个节点；
- 隐藏的 Agent 控制台仍在后台反复执行 `panes.sync`，单次 50–150ms；
- 比赛页每次 store 更新都重建顶栏、侧栏、题卡、详情和状态条；
- Chromium 记录到大量 100–250ms longtask，最坏主线程停顿 16 秒。

根因不是网络，而是隐藏视图继续渲染 + 可见视图整页重绘。

## 代码修复

1. **按视图订阅**
   - 比赛面板与 Agent 控制台使用独立订阅集合。
   - 隐藏视图不再接收 store 通知，不再重建 DOM。

2. **工作台延迟挂载**
   - 首次进入 Agent 控制台才创建 pane、拉取历史并挂载 DOM。
   - 返回比赛面板后停止消费 stream/health；再次进入时重新拉历史。

3. **主进程丢弃隐藏流**
   - renderer 通过 `ui.setView` 告知主进程当前视图。
   - 比赛面板显示期间，主进程不再向 renderer 发送 `session.stream` 和
     `health` 高频事件，减少 IPC 序列化与 renderer 唤醒。

4. **比赛页分区脏检查**
   - 顶栏、侧栏、题卡区、详情栏、底部状态条分别计算轻量签名。
   - 只有依赖数据变化时才重建对应区域。
   - 黑板/flag 更新不再导致整个比赛页重画。

5. **黑板刷新合并**
   - `board.appended` 触发的全量 snapshot 从“立即请求”改为 300ms 合并，
     避免 Agent 连续写板时形成 snapshot 请求链。

## 实测结果

同一台机器、同一份 24 题平台状态： 

| 指标 | 改造前 | 改造后 |
| --- | ---: | ---: |
| 比赛页可见 DOM 节点 | 2431 | 699 |
| Performance.Nodes | 24466 | 5131 |
| 隐藏 `panes.sync` | 50–150ms，持续触发 | 0，仅在打开控制台时一次 |
| 帧间隔 | 频繁 100–250ms longtask | 常规 8.3–8.6ms |
| 视图切换压测 p95 | 无法稳定测量 | 16.6ms |
| 视图切换压测 longtask | 多次 | 0 |

压测包含：16 次任务焦点切换、打开 Agent 控制台、创建 3 个 pane、
返回比赛面板。完成后比赛页保持无后台 pane 重绘。

## 回归

- `npm run smoke`：通过
- `npm run verify:flags`：214/214
- `npm run verify:all`：通过
- 打包态隔离实例启动成功，无 renderer 未捕获错误

## 产物

- 正式解包版：`D:\agent\xuanwo\dist\win-unpacked\不迷茫.exe`
- 便携包：`D:\agent\xuanwo\dist-release-v2\不迷茫 0.1.0.exe`
- 旧构建与测试临时目录已清理，工作区释放约 2.2 GB。
