# T6 渲染进程骨架

## 做了什么

用契约的 mock 数据渲染出三栏工作台骨架：左「任务树 + 会话列表 + 加号」、中「多窗格占位」、右「审批 + 台账」。关键取舍：渲染进程对契约只做 `import type`（运行时擦除），因此浏览器永远不需要加载 `packages/shared-protocol/events.ts`，运行时完全自包含于 `src/renderer/**` 之下；「无 bundler」靠 `electron/renderer-protocol.ts` 注册的自定义 scheme 现场用 `module.stripTypeScriptTypes` 剥类型实现。`hub.ts` 是 T11「mock → 真实 IPC」的唯一切换点。

## 改了哪些文件

```
apps/desktop/renderer.html                      三栏壳的 HTML 入口（module 加载 main.ts）
apps/desktop/src/renderer/contract.ts           契约类型再导出（import type，运行时擦除）
apps/desktop/src/renderer/store.ts              状态折叠：applySnapshot / applyEvent / Store
apps/desktop/src/renderer/dom.ts                DOM 小工具（顶层不碰 document，可被 Node import）
apps/desktop/src/renderer/ctx.ts                共享上下文 UiCtx
apps/desktop/src/renderer/hub.ts                resolveHub：真实桥 vs mock 的切换点
apps/desktop/src/renderer/mock/data.ts          mock HubSnapshot（四类黑板、审批、健康度、agent 全量）
apps/desktop/src/renderer/mock/engine.ts        Mock HubApi（snapshot/dispatch/onEvent + 模拟事件流）
apps/desktop/src/renderer/main.ts               入口：三栏 shell + 左栏渲染 + 事件接线
apps/desktop/src/renderer/styles.css            暗色工作台样式
apps/desktop/electron/preload.ts                contextBridge 暴露 window.bumimang（脚手架，未测）
apps/desktop/electron/renderer-protocol.ts      自定义 scheme + 现场剥类型（脚手架，未测）
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node apps/desktop/src/renderer/smoke.ts
```

真实输出（T6 段）：

```
== T6 渲染进程骨架 · mock 快照与状态折叠 ==
PASS  快照有任务  └─ task=不迷茫 · 夜间靶场：拿下 10.0.0.9
PASS  快照有 ≥2 会话  └─ sessions=3
PASS  快照有 pending 审批  └─ approvals=5
PASS  快照有四类黑板视图  └─ facts=4 deadEnds=2 intents=3 leases=2
PASS  快照有健康度  └─ health keys=s1,s2
PASS  快照有 4 个 agent 描述  └─ codex claude opencode dsh(未安装)
PASS  applySnapshot 折叠数量一致
PASS  applyEvent(session.upsert) 原地 upsert
```

另：`node --input-type=module -e "await import('./apps/desktop/src/renderer/main.ts')"` 通过（全依赖图可解析、可求值，Node 里不触发 DOM 引导）。

## 没做什么 / 已知问题

1. **没有真实窗口渲染过**：Electron 未安装（见 docs/BLOCKED.md），三栏布局只验证了「数据 + 逻辑」与模块可加载，没验证过像素级效果。
2. `file://` 直接双击 renderer.html **跑不起来**：Chromium 对 `.ts` 的 MIME/严格模块检查会拒绝加载，必须走自定义 scheme（renderer-protocol.ts）。
3. `store.applyEvent` 对 `session.stream` / `board.appended` 是有意 no-op：流走窗格节流器（T7），台账增量 MVP 阶段靠重拉快照。

## 下一手需要什么

- **Electron 装上**（Lane A 的 T5 也需要它）：`src/main/electron/main.ts` 调 `registerRendererProtocol()` 后 `loadURL("bumimang://app/renderer.html")`，preload 暴露 `window.bumimang`。
- T11 对接：`hub.ts` 的 `resolveHub()` 已经在等真实桥，A 把 `hub:snapshot`/`hub:event`/`hub:action` 三条通道打通即可切。
