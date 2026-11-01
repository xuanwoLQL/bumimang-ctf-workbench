# B-to-A · 工件预览与附件选择 IPC（P3-C）

- 日期：2026-10-23
- 状态：**用户已批准，P3-C 已实施**
- 关联：`docs/done/P3-A.md` §6、`docs/done/P3-C.md`、`docs/plans/COMPETITION-READINESS.md` §6.3
- 批准方式：用户在 P3-C 状态确认后选择「扩到最小 Lane A（推荐）」

## 为什么需要

P3-A 只实现了附件导入/落盘、`previewAttachment()` / `scanAttachmentForFlags()` 函数与
`HubSnapshot.attachments?`；它把以下四项明确留给 P3-C：

1. `dialog.showOpenDialog` 附件选择；
2. 工件列表 / 预览 IPC；
3. `artifact.refresh` 真正实现；
4. `artifact.updated` 广播。

P3-C 原始范围是“严格 Lane B，只改 renderer + mock”。但仅改渲染层时：

- `artifact.refresh` 在 `hub.ts` 仍返回占位错误，没有工件数据；
- `HubSnapshot` 没有 `artifacts?`，渲染层无法列出产物；
- `preload.cjs` 没有预览/选择器通道，渲染层在 contextIsolation 下不能 import 主进程
  `preview.ts`；
- `attachment.import` 需要绝对路径，而 Electron 44 renderer 的 `File.path` 已移除，
  `webUtils.getPathForFile()` 未暴露，`dialog.showOpenDialog` 只在主进程。

因此按原范围无法达到 P3-C 的“真实附件选择 / 产物列表 / 预览 / 刷新”验收。用户批准最小
Lane A 扩展后，按本文件实施。

## 契约增量（全部可选/加法）

```ts
export interface ArtifactView {
  path: string;                 // 任务目录相对路径（POSIX）
  name: string;
  size: number;
  mtime: number;
  kind: "text" | "image" | "binary" | "dir";
  previewable: boolean;
}

export interface ArtifactPreview {
  kind: "text" | "image" | "hex" | "unsupported";
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
  totalBytes?: number;
  mime?: string;
  error?: string;
}

export type AttachmentPickKind = "files" | "folder" | "zip";
export interface AttachmentPickResult { canceled: boolean; paths: string[]; error?: string; }

// HubSnapshot
artifacts?: ArtifactView[];     // 焦点任务

// HubApi
previewArtifact?(taskId: string | undefined, path: string): Promise<ArtifactPreview>;
pickAttachments?(kind: AttachmentPickKind): Promise<AttachmentPickResult>;

// HUB_CHANNELS
artifactPreview: "hub:artifact.preview";
attachmentPick: "hub:attachment.pick";
```

`HubEvent.artifact.updated` 的 `artifacts` 从内联对象类型改为 `ArtifactView[]`（结构兼容）。

## 实现边界

- `artifact.refresh`：扫描 `<workRoot>/<taskId>`，跳过 `attachments/`、`attachments.json`、
  `node_modules/.git/dist/build/target` 等；不跟随 symlink/junction；最多 500 文件、深度 6；
  广播 `artifact.updated`。
- `previewArtifact`：复用 P3-A `previewAttachment()`；realpath/逐段 symlink 校验；
  文本 256KB、图片 2MB、hex 4KB；HTML/SVG 只当文本；不执行、不 `openPath`。
- 附件选择：主进程 `dialog.showOpenDialog`；文件多选/文件夹/zip 三选一；返回绝对路径；
  导入仍走 P3-A `attachment.import` 的预检、限额、原子落盘。
- 旧快照/旧 mock：`artifacts`/`attachments` 缺席时渲染层按空处理；`previewArtifact` /
  `pickAttachments` 为可选方法，缺失时 UI 显示“当前后端不支持”，不崩。

## 测试影响

- `verify-artifacts.ts` A 组有 1 条旧断言明确检查“artifact.refresh 返回 P3-C 占位”；
  行为变更后更新为“刷新成功并带工件数”。**断言总数仍 324**，其余 323 条未改。
- `smoke.ts` 旧 187 条零删除零改语义；新增 29 条 P3-C 断言，187→216。
- `verify:all` 由 578→607（确定性 391 + smoke 216）；skills 149、multitask 174、
  migration 44、Electron 26 不变。
