# T6–T10 真实 Electron 窗口渲染验证

## 做了什么

把 T6–T10 的渲染进程从「纯逻辑 smoke」升级到「真实 Electron 窗口里真的画出来」：
写了一个 Lane B 自用的 Electron 主入口 `apps/desktop/electron/render-verify.ts`，注册
`bumimang://` 自定义 scheme → 开 `BrowserWindow` → `loadURL("bumimang://./renderer.html")`
→ `executeJavaScript` 对三栏做 DOM 断言 → `capturePage` 截图。**14/14 断言全过**。

前置（本不存在的两个 blocker 已由用户解决）：
- B1：`electron@44.7.0` 已装，exe 在 `node_modules/electron/dist/electron.exe`。
- B2：内嵌 Node 24.21.0，`module.stripTypeScriptTypes` 可用（`function`）。

## 验证过程中发现并修复的两个真坑（Lane A 必须知道）

1. **scheme URL 不能用 host 名 `app`，要用 `./`**：`loadURL("bumimang://app/renderer.html")`
   不会触发 `protocol.handle`（handler 一次都不被调用，页面空白）。改成
   `bumimang://./renderer.html` 后 handler 正常被调。原因：`standard: true` 下
   `bumimang://app/renderer.html` 的 host 是 `app`，而 Electron 里可路由的自定义 scheme
   导航走的是 `scheme://./path` 这种「空/`.` host」形式。**所以 Lane A 的
   `src/main/electron/main.ts` 必须 `loadURL("bumimang://./renderer.html")`。**

2. **`protocol.handle` 的 handler 内部做文件 I/O 会卡死**：handler 里无论
   `fs/promises` 的 `readFile`（Promise 永不 settle）还是 `fs.readFileSync`（不返回）都会
   卡住，导致页面空白、且不抛任何异常。同样代码放在 handler 之外（启动时）完全正常。
   绕过：把 `renderer-protocol.ts` 改成**在 `registerRendererProtocol()` 时一次性把整个
   `src/renderer/**` + `renderer.html` 读进内存并现场剥类型，handler 里只做内存查表、零 I/O**。
   若 Lane A 以后要在主进程读盘，请勿放在 protocol handler 内。

## 改了哪些文件

```
apps/desktop/electron/render-verify.ts        新增：验证用 Electron 主入口（非 Lane A 的 src/main）
apps/desktop/electron/renderer-protocol.ts    重写：启动时预载资产 + 剥类型，handler 内存查表
```

（`apps/desktop/src/renderer/**` 与 `apps/desktop/electron/preload.ts` 未改；`packages/shared-protocol/events.ts` 未动。）

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node_modules\electron\dist\electron.exe apps/desktop/electron/render-verify.ts --no-sandbox
```

真实输出（2026-10-13 00:04，Electron 44.7.0 / Node 24.21.0）：

```
PASS  三栏在 8s 内出现
PASS  三栏容器数量 = 3  └─ classes=col col-left,col col-center,col col-right
PASS  #app 是 CSS grid 三列  └─ display=grid cols="240px 594.4px 400px"
PASS  三栏水平排布（左 < 中 < 右）  └─ lefts=8,256,858
PASS  三栏均有非零尺寸（真的画出来）  └─ rects=[{"x":8,"y":8,"w":240,"h":722},{"x":256,"y":8,"w":594,"h":722},{"x":858,"y":8,"w":400,"h":722}]
PASS  窗口标题正确  └─ title=不迷茫 · 多 agent 并行解题工作台
PASS  左栏任务卡渲染  └─ task=不迷茫 · 夜间靶场：拿下 10.0.0.9
PASS  左栏会话列表 ≥3  └─ sessions=3 agents=opencode,codex,opencode
PASS  左栏加号按钮存在  └─ text=+ 扇出
PASS  中栏窗格 ≥3  └─ panes=3 agents=opencode,codex,opencode
PASS  右栏审批卡 ≥4  └─ cards=4 countText=待审批 4 条
PASS  右栏台账四区  └─ titles=["事实 · 4","死路 · 2","意图 · 3","租约 · 2"]
PASS  冲突事实并列高亮  └─ conflictFacts=2/4
PASS  截图写入成功  └─ ...render-verify.png (252760 bytes, 1583x922) + jpg 141048 bytes
ALL_PASS
```

渲染进程 `consoleLogs=[]`（无报错）、`loadFailures=[]`、`rendererGone=null`。

截图像素抽查（`nativeImage.toBitmap`）：三栏中心点均为暗色工作台底色（RGB 22,27,34 一带），
整帧采样到 **757 种独立颜色**（4bit/通道）——不是空白帧（空白帧只有 1~2 种色）。

## 证据落盘

```
docs/logs/render-verify.json   14 条断言 + DOM 探针原文 + console/load 记录
docs/logs/render-verify.png    1583x922 有效 RGB PNG（252760 bytes，IDAT/IEND 齐全）
docs/logs/render-verify.jpg    同帧 JPEG（141048 bytes）
```

## 没做什么 / 已知问题

1. **没加载 preload**：preload 暴露的 `window.bumimang` 走真实 IPC（hub:snapshot/hub:event/
   hub:action），那三条 ipcMain 通道是 Lane A 的 T2/T5/T11。不加载 preload → `resolveHub()`
   回落到进程内 mock，恰好验证 Lane B 自己的 UI。真实桥接通后 `hub.ts` 无需改动。
2. **扇出弹窗没在窗口里点过**：T10 的「点加号 → 弹窗」只验证了加号按钮存在与动作构造
   （smoke），没在真实窗口里模拟点击；弹窗 DOM 代码路径与 mock 一致，风险低。
3. `file://` 直开 `renderer.html` 仍跑不起来（Chromium 拒收 `.ts`），必须走 `bumimang://`。

## 下一手需要什么

- Lane A 的 `src/main/electron/main.ts`（T5）接上时：`registerRendererProtocol()` 后
  `loadURL("bumimang://./renderer.html")`，preload 暴露 `window.bumimang`，并实现
  `hub:snapshot` / `hub:event` / `hub:action` 三条 ipcMain。三栏 UI 已就绪，无需改。
