/**
 * P3-C：工件面板的纯视图逻辑 + DOM 渲染（先桩，红测后补实现）。
 *
 * 安全边界（实现时保持）：
 *  - 附件/产物名称、路径、预览内容一律走文本节点，绝不 innerHTML；
 *  - 图片只接受 data:image/(png|jpeg|gif|webp|bmp);base64，SVG/HTML 只当文本；
 *  - 不提供系统打开/执行入口，systemOpen 恒为 false；
 *  - 预览路径只来自快照里的 attachments/artifacts，渲染层不自己拼任意路径。
 */
import type { AttachmentPickKind, AttachmentView, ArtifactPreview } from "./contract.ts";
import type { AppState } from "./store.ts";
import type { UiCtx } from "./ctx.ts";
import { clear, el } from "./dom.ts";
import { notify } from "./notice.ts";

export interface ArtifactPanelItem {
  id: string;
  source: "attachment" | "artifact";
  sourceLabel: string;
  name: string;
  displayPath: string;
  previewPath: string;
  size: number;
  sizeText: string;
  sha256Short: string | null;
  importedAtText: string | null;
  mtimeText: string | null;
  kind: string;
  kindLabel: string;
  previewable: boolean;
  /** P3-C 明确不提供系统打开；保留字段让 smoke 锁死这个语义。 */
  systemOpen: false;
}

export interface ArtifactPanelView {
  attachments: ArtifactPanelItem[];
  artifacts: ArtifactPanelItem[];
  attachmentCount: number;
  artifactCount: number;
  empty: boolean;
  emptyText: string;
  canRefresh: boolean;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${Math.floor(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function shortSha256(sha: string | null | undefined): string | null {
  const text = typeof sha === "string" ? sha.trim() : "";
  if (!text) return null;
  return text.length <= 12 ? text : `${text.slice(0, 12)}…`;
}

export function formatImportedAt(ts: number | null | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function kindLabelForArtifact(kind: string): string {
  switch (kind) {
    case "text":
      return "文本";
    case "image":
      return "图片";
    case "binary":
      return "二进制";
    case "dir":
      return "目录";
    default:
      return kind || "未知";
  }
}

function attachmentKindLabel(type: string): string {
  const t = (type || "").trim();
  return t ? t.toUpperCase() : "附件";
}

function joinAttachmentPath(relativePath: string): string {
  const p = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return p.startsWith("attachments/") ? p : `attachments/${p}`;
}

export function buildArtifactPanelView(
  state: Pick<AppState, "task" | "attachments" | "artifacts">,
): ArtifactPanelView {
  // 快照的 attachments 是焦点任务的权威清单；旧快照可能只在 task.attachments 上带。
  const attachments =
    (state.attachments?.length ?? 0) > 0 ? state.attachments : (state.task?.attachments ?? []);
  const artifacts = state.artifacts ?? [];
  const attachmentItems: ArtifactPanelItem[] = attachments.map((a) => ({
    id: `attachment:${a.relativePath}`,
    source: "attachment",
    sourceLabel: "附件",
    name: a.name,
    displayPath: joinAttachmentPath(a.relativePath),
    previewPath: joinAttachmentPath(a.relativePath),
    size: a.size,
    sizeText: formatBytes(a.size),
    sha256Short: shortSha256(a.sha256),
    importedAtText: formatImportedAt(a.importedAt),
    mtimeText: null,
    kind: a.type,
    kindLabel: attachmentKindLabel(a.type),
    previewable: true,
    systemOpen: false,
  }));
  const artifactItems: ArtifactPanelItem[] = artifacts.map((a) => ({
    id: `artifact:${a.path}`,
    source: "artifact",
    sourceLabel: "产物",
    name: a.name,
    displayPath: a.path,
    previewPath: a.path,
    size: a.size,
    sizeText: formatBytes(a.size),
    sha256Short: null,
    importedAtText: null,
    mtimeText: formatImportedAt(a.mtime),
    kind: a.kind,
    kindLabel: kindLabelForArtifact(a.kind),
    previewable: a.previewable !== false,
    systemOpen: false,
  }));
  const attachmentCount =
    attachmentItems.length > 0
      ? attachmentItems.length
      : (state.task?.attachmentCount ?? 0);
  return {
    attachments: attachmentItems,
    artifacts: artifactItems,
    attachmentCount,
    artifactCount: artifactItems.length,
    empty: attachmentItems.length === 0 && artifactItems.length === 0,
    emptyText: "暂无工件",
    canRefresh: Boolean(state.task),
  };
}

export interface AttachmentSelectionState {
  kind: AttachmentPickKind | null;
  paths: string[];
  importing: boolean;
  error: string | null;
}

export interface AttachmentSelectionView {
  kindLabel: string;
  count: number;
  pathsText: string;
  importingText: string | null;
  error: string | null;
  canImport: boolean;
}

export function buildAttachmentSelectionView(
  state: AttachmentSelectionState,
): AttachmentSelectionView {
  const kindLabel =
    state.kind === "files"
      ? "文件"
      : state.kind === "folder"
        ? "文件夹"
        : state.kind === "zip"
          ? "ZIP"
          : "未选择";
  const paths = state.paths.filter((p) => typeof p === "string" && p.trim().length > 0);
  return {
    kindLabel,
    count: paths.length,
    pathsText: paths.length > 0 ? paths.join("；") : "尚未选择附件",
    importingText: state.importing ? "正在导入附件…" : null,
    error: state.error,
    canImport: paths.length > 0 && !state.importing,
  };
}

export type ArtifactPreviewRenderKind = "text" | "image" | "hex" | "unsupported";

export interface ArtifactPreviewView {
  renderKind: ArtifactPreviewRenderKind;
  text: string | null;
  dataUrl: string | null;
  note: string | null;
  error: string | null;
}

/** 只允许 P3-A 会返回的位图 data URL；SVG/HTML/其它 MIME 一律不按图片渲染。 */
export function isSafeImageDataUrl(dataUrl: string | null | undefined): boolean {
  if (typeof dataUrl !== "string") return false;
  return /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(dataUrl);
}

export function buildArtifactPreviewView(
  preview: ArtifactPreview | null | undefined,
): ArtifactPreviewView {
  if (!preview) {
    return { renderKind: "unsupported", text: null, dataUrl: null, note: null, error: "没有预览数据" };
  }
  if (preview.error) {
    return { renderKind: "unsupported", text: null, dataUrl: null, note: null, error: preview.error };
  }
  const noteParts: string[] = [];
  if (preview.truncated) noteParts.push("内容已截断");
  if (typeof preview.totalBytes === "number" && preview.totalBytes >= 0) {
    noteParts.push(`原始大小 ${formatBytes(preview.totalBytes)}`);
  }
  const note = noteParts.length > 0 ? noteParts.join("；") : null;

  if (preview.kind === "text" || preview.kind === "hex") {
    return {
      renderKind: preview.kind,
      text: typeof preview.content === "string" ? preview.content : "",
      dataUrl: null,
      note,
      error: null,
    };
  }
  if (preview.kind === "image") {
    if (!isSafeImageDataUrl(preview.dataUrl)) {
      return {
        renderKind: "unsupported",
        text: null,
        dataUrl: null,
        note,
        error: "图片 data URL 不是允许的位图类型，已拒绝按图片渲染",
      };
    }
    return {
      renderKind: "image",
      text: null,
      dataUrl: preview.dataUrl ?? null,
      note,
      error: null,
    };
  }
  return {
    renderKind: "unsupported",
    text: typeof preview.content === "string" ? preview.content : null,
    dataUrl: null,
    note,
    error: null,
  };
}

/** P3-C 明确不做系统打开；保留函数让 UI/smoke 锁死“可执行也不打开”。 */
export function canSystemOpenArtifact(_path: string): false {
  return false;
}

let stylesInjected = false;

/** 面板/任务卡附件列表共用一套小样式；注入一次，避免改全局 styles.css。 */
export function ensureArtifactStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  if (document.getElementById("artifact-panel-styles")) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = "artifact-panel-styles";
  style.textContent = `
.artifact-panel-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.artifact-panel-hint { color: var(--text-dim); font-size: 11px; }
.artifact-import-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.artifact-panel-body { min-height: 0; }
.artifact-section-title { color: var(--text-dim); font-size: 11px; font-weight: 600; margin: 8px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; }
.artifact-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.artifact-item { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.artifact-item-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.artifact-badge { flex: 0 0 auto; border: 1px solid var(--border); border-radius: 999px; padding: 0 5px; font-size: 10px; color: var(--text-dim); }
.task-attachment-tag { border: 1px solid var(--border); border-radius: 999px; padding: 0 5px; font-size: 10px; color: var(--text-dim); }
.artifact-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifact-meta { color: var(--text-dim); font-size: 11px; overflow-wrap: anywhere; margin-top: 2px; }
.artifact-actions { display: flex; gap: 6px; margin-top: 4px; }
.artifact-empty { color: var(--text-dim); font-size: 12px; padding: 8px 0; }
.artifact-preview-modal { width: min(920px, 92vw); max-height: 86vh; display: flex; flex-direction: column; }
.artifact-preview-path { color: var(--text-dim); font-size: 11px; overflow-wrap: anywhere; margin-bottom: 6px; }
.artifact-preview-body { overflow: auto; min-height: 80px; }
.artifact-preview-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 58vh; overflow: auto; background: #f6f8fa; border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin: 0; font-size: 12px; }
.artifact-preview-image { display: block; max-width: 100%; max-height: 58vh; margin: 0 auto; }
.artifact-preview-note { color: var(--text-dim); font-size: 11px; margin-top: 6px; }
.artifact-preview-error { color: #b42318; font-size: 12px; padding: 8px; border: 1px solid #fecdca; border-radius: 6px; background: #fffbfa; }
.task-attachment-field { display: flex; flex-direction: column; gap: 6px; }
.task-attachment-picker { display: flex; gap: 6px; flex-wrap: wrap; }
.task-attachment-status { color: var(--text-dim); font-size: 11px; overflow-wrap: anywhere; }
.task-attachment-list { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; }
.task-attachment-item { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; padding: 2px 0; }
.task-attachment-item .artifact-meta { margin-top: 0; text-align: right; }
`;
  document.head.appendChild(style);
  stylesInjected = true;
}

function renderPreview(preview: ArtifactPreview): HTMLElement {
  const view = buildArtifactPreviewView(preview);
  if (view.error) return el("div", { class: "artifact-preview-error" }, view.error);
  let node: HTMLElement;
  if (view.renderKind === "image" && view.dataUrl) {
    node = el("img", {
      class: "artifact-preview-image",
      src: view.dataUrl,
      alt: "工件预览",
    });
  } else if (view.renderKind === "text" || view.renderKind === "hex") {
    const pre = el("pre", { class: "artifact-preview-text" });
    // 关键：只写 textContent，HTML/SVG/脚本都按字面量显示，绝不 innerHTML。
    pre.textContent = view.text ?? "";
    node = pre;
  } else {
    node = el("div", { class: "artifact-preview-error" }, view.text ?? "不支持预览该文件");
  }
  if (view.note) node.appendChild(el("div", { class: "artifact-preview-note" }, view.note));
  return node;
}

/** P3-C：右栏工件面板（附件 + 产物 + 只读预览 + 刷新）。 */
export function createArtifactsPanel(container: HTMLElement, ctx: UiCtx): { dispose(): void } {
  ensureArtifactStyles();
  let refreshing = false;
  let importingAttachments = false;
  const refreshBtn = el("button", { class: "btn btn-small", type: "button" }, "刷新工件") as HTMLButtonElement;
  const importFilesBtn = el("button", { class: "btn btn-small", type: "button" }, "＋文件") as HTMLButtonElement;
  const importFolderBtn = el("button", { class: "btn btn-small", type: "button" }, "＋文件夹") as HTMLButtonElement;
  const importZipBtn = el("button", { class: "btn btn-small", type: "button" }, "＋ZIP") as HTMLButtonElement;
  const importButtons = [importFilesBtn, importFolderBtn, importZipBtn];
  const importStatus = el("span", { class: "artifact-panel-hint" });
  const body = el("div", { class: "artifact-panel-body" });
  container.append(
    el("div", { class: "artifact-panel-tools" }, [
      el("span", { class: "artifact-panel-hint" }, "只读 · 不执行 · 不系统打开"),
      refreshBtn,
    ]),
    el("div", { class: "artifact-import-row" }, [
      el("span", { class: "artifact-panel-hint" }, "导入附件："),
      ...importButtons,
      importStatus,
    ]),
    body,
  );

  const currentTaskId = (): string | null => ctx.store.get().task?.id ?? null;

  async function importAttachments(kind: "files" | "folder" | "zip"): Promise<void> {
    const taskId = currentTaskId();
    if (!taskId) {
      notify("没有活动任务，先创建任务", "error");
      return;
    }
    if (importingAttachments) return;
    if (typeof ctx.hub.pickAttachments !== "function") {
      notify("当前环境不支持系统文件选择（需要 Electron 主进程）", "error");
      return;
    }
    importingAttachments = true;
    importStatus.textContent = "正在导入附件…";
    for (const b of importButtons) b.disabled = true;
    try {
      const picked = await ctx.hub.pickAttachments(kind);
      if (picked.canceled) return;
      if (picked.error) {
        notify(`选择附件失败：${picked.error}`, "error");
        return;
      }
      if (picked.paths.length === 0) return;
      const res = await ctx.hub.dispatch({
        type: "attachment.import",
        taskId,
        paths: picked.paths,
        note: "工件面板导入",
      });
      if (!res?.ok) notify(`导入附件失败：${res?.error ?? "未知错误"}`, "error");
      else notify(res.message ?? "已导入附件", "info");
    } catch (err) {
      notify(`导入附件失败：${(err as Error).message ?? String(err)}`, "error");
    } finally {
      importingAttachments = false;
      importStatus.textContent = "";
      for (const b of importButtons) b.disabled = false;
      render();
    }
  }

  importFilesBtn.addEventListener("click", () => void importAttachments("files"));
  importFolderBtn.addEventListener("click", () => void importAttachments("folder"));
  importZipBtn.addEventListener("click", () => void importAttachments("zip"));

  async function refresh(): Promise<void> {
    const taskId = currentTaskId();
    if (!taskId || refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "刷新中…";
    try {
      const res = await ctx.hub.dispatch({ type: "artifact.refresh", taskId });
      if (!res?.ok) notify(`刷新工件失败：${res?.error ?? "未知错误"}`, "error");
      else if (res.message) notify(res.message, "info");
    } catch (err) {
      notify(`刷新工件失败：${(err as Error).message ?? String(err)}`, "error");
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = "刷新工件";
      render();
    }
  }
  refreshBtn.addEventListener("click", () => void refresh());

  function openPreview(item: ArtifactPanelItem): void {
    const taskId = currentTaskId();
    if (!taskId) return;
    const overlay = el("div", { class: "task-overlay" });
    const previewBody = el("div", { class: "artifact-preview-body" }, "正在加载预览…");
    const closeBtn = el("button", { class: "btn btn-cancel", type: "button" }, "关闭");
    const modal = el("div", { class: "task-modal artifact-preview-modal" }, [
      el("h3", { class: "task-modal-title" }, `预览：${item.name}`),
      el("div", { class: "artifact-preview-path" }, item.displayPath),
      previewBody,
      el(
        "div",
        { class: "artifact-preview-note" },
        "只读预览；不执行、不系统打开可执行文件；HTML/SVG 按文本显示。",
      ),
      el("div", { class: "task-form-actions" }, [closeBtn]),
    ]);
    const close = (): void => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    if (typeof ctx.hub.previewArtifact !== "function") {
      clear(previewBody);
      previewBody.appendChild(
        el("div", { class: "artifact-preview-error" }, "当前后端不支持预览（previewArtifact 未实现）"),
      );
      return;
    }
    void ctx.hub
      .previewArtifact(taskId, item.previewPath)
      .then((preview) => {
        clear(previewBody);
        previewBody.appendChild(renderPreview(preview));
      })
      .catch((err) => {
        clear(previewBody);
        previewBody.appendChild(
          el("div", { class: "artifact-preview-error" }, `预览失败：${(err as Error).message ?? String(err)}`),
        );
      });
  }

  function renderItem(item: ArtifactPanelItem): HTMLElement {
    const metaParts = [item.sizeText, item.kindLabel];
    if (item.sha256Short) metaParts.push(`sha256 ${item.sha256Short}`);
    if (item.importedAtText) metaParts.push(`导入 ${item.importedAtText}`);
    if (item.mtimeText) metaParts.push(`修改 ${item.mtimeText}`);
    const previewBtn = el("button", { class: "btn btn-small", type: "button" }, "预览") as HTMLButtonElement;
    previewBtn.disabled = !item.previewable;
    if (item.previewable) previewBtn.addEventListener("click", () => openPreview(item));
    return el("li", { class: "artifact-item", "data-artifact-id": item.id }, [
      el("div", { class: "artifact-item-head" }, [
        el("span", { class: "artifact-badge" }, item.sourceLabel),
        el("span", { class: "artifact-name", title: item.displayPath }, item.name),
      ]),
      el("div", { class: "artifact-meta" }, metaParts.join(" · ")),
      el("div", { class: "artifact-actions" }, [previewBtn]),
    ]);
  }

  function render(): void {
    clear(body);
    const state = ctx.store.get();
    const view = buildArtifactPanelView(state);
    const hasTask = Boolean(state.task);
    for (const b of importButtons) b.disabled = !hasTask || importingAttachments;
    if (!state.task) {
      body.appendChild(el("div", { class: "artifact-empty" }, "暂无任务；创建任务后可查看附件与产物。"));
      refreshBtn.disabled = true;
      return;
    }
    refreshBtn.disabled = refreshing;
    if (view.empty) {
      body.appendChild(el("div", { class: "artifact-empty" }, view.emptyText));
      return;
    }
    if (view.attachments.length > 0) {
      body.appendChild(el("div", { class: "artifact-section-title" }, `附件（${view.attachments.length}）`));
      const ul = el("ul", { class: "artifact-list" });
      for (const item of view.attachments) ul.appendChild(renderItem(item));
      body.appendChild(ul);
    }
    if (view.artifacts.length > 0) {
      body.appendChild(el("div", { class: "artifact-section-title" }, `产物（${view.artifacts.length}）`));
      const ul = el("ul", { class: "artifact-list" });
      for (const item of view.artifacts) ul.appendChild(renderItem(item));
      body.appendChild(ul);
    }
  }

  const unsubscribe = ctx.store.subscribeWorkspace(render);
  render();
  return { dispose: unsubscribe };
}

/** 焦点任务卡上的紧凑附件列表（最多 6 条；完整列表在右栏工件面板）。 */
export function renderAttachmentList(attachments: AttachmentView[]): HTMLElement | null {
  if (!attachments || attachments.length === 0) return null;
  ensureArtifactStyles();
  const box = el("div", { class: "task-attachment-list" });
  box.appendChild(el("div", { class: "artifact-section-title" }, `附件（${attachments.length}）`));
  const max = 6;
  for (const a of attachments.slice(0, max)) {
    const meta = [
      formatBytes(a.size),
      shortSha256(a.sha256) ? `sha256 ${shortSha256(a.sha256)}` : null,
      formatImportedAt(a.importedAt) ? `导入 ${formatImportedAt(a.importedAt)}` : null,
    ]
      .filter((x): x is string => Boolean(x))
      .join(" · ");
    box.appendChild(
      el("div", { class: "task-attachment-item", title: a.relativePath }, [
        el("span", { class: "artifact-name" }, a.name),
        el("span", { class: "artifact-meta" }, meta),
      ]),
    );
  }
  if (attachments.length > max) {
    box.appendChild(el("div", { class: "artifact-meta" }, `还有 ${attachments.length - max} 个附件…`));
  }
  return box;
}
