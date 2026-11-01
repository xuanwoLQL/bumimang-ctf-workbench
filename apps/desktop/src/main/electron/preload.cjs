/**
 * Preload —— 把契约的 HubApi 通过 contextBridge 暴露成 `window.bumimang`。
 *
 * 为什么是 .cjs 而不是 .ts：Electron 加载 preload 走的是它自己的模块加载器，
 * **不做 type stripping**，所以 `.ts` preload 会直接解析失败。渲染进程里的
 * `.ts` 由 renderer-protocol 现场剥类型，但 preload 不在那条路径上。
 *
 * 通道名必须与 packages/shared-protocol/events.ts 的 HUB_CHANNELS 一致
 * （契约冻结，这里不能 import 值，只能照抄字面量）。语义与 Lane B 的
 * electron/preload.ts 完全相同 —— T11 对接时二者可择一保留。
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  snapshot: "hub:snapshot",
  dispatch: "hub:action",
  event: "hub:event",
  history: "hub:history",
  artifactPreview: "hub:artifact.preview",
  attachmentPick: "hub:attachment.pick",
};

const api = {
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  dispatch: (action) => ipcRenderer.invoke(CHANNELS.dispatch, action),
  history: (sessionId) => ipcRenderer.invoke(CHANNELS.history, sessionId),
  // P3-C：只读预览 / 文件选择器；主进程做路径校验与对话框。
  previewArtifact: (taskId, path) =>
    ipcRenderer.invoke(CHANNELS.artifactPreview, { taskId, path }),
  pickAttachments: (kind) => ipcRenderer.invoke(CHANNELS.attachmentPick, kind),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.event, listener);
    };
  },
};

contextBridge.exposeInMainWorld("bumimang", api);
