/**
 * Preload：把契约的 `HubApi` 通过 contextBridge 暴露给渲染进程的 `window.bumimang`。
 *
 * 通道名必须与 `packages/shared-protocol/events.ts` 的 `HUB_CHANNELS` 保持一致
 * （那是冻结契约，这里不能 import 值，只能照抄字符串字面量）：
 *   snapshot → "hub:snapshot"
 *   dispatch → "hub:action"
 *   event    → "hub:event"
 *
 * ⚠ 实际加载的 preload 是 `preload.cjs`（Electron 加载 preload 不做 type stripping，
 *    所以 .ts 跑不起来）。此 .ts 文件保留为类型化脚手架，二者语义相同，择一保留。
 */
import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = {
  snapshot: "hub:snapshot",
  dispatch: "hub:action",
  event: "hub:event",
  history: "hub:history",
} as const;

const api = {
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  dispatch: (action: unknown) => ipcRenderer.invoke(CHANNELS.dispatch, action),
  history: (sessionId: string) => ipcRenderer.invoke(CHANNELS.history, sessionId),
  onEvent: (cb: (e: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.event, listener);
    };
  },
};

contextBridge.exposeInMainWorld("bumimang", api);
