# P3-C · 渲染层附件选择 + 工件面板 + 只读预览 + 最小 Lane A IPC

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §6 WP3；`docs/plans/COMPETITION-READINESS.md` §6.3/§6.5；`docs/done/P3-A.md`、`docs/done/P3-B.md`、`docs/requests/B-to-A-artifact-ipc.md`
> 日期：2026-10-23
> 状态：**P3-C 完成**。按用户批准的「扩到最小 Lane A」实施：渲染层 + mock + 契约/IPC 最小增量。
> 验收基线：**`verify:all` 607 PASS / 0 FAIL（确定性 391 + smoke 216）；`verify:artifacts` 324/324；`verify:skills` 149/149；`verify:multitask` 174/174；`verify:migration` 44/44；Electron `--verify` 26/26。**

---

## 1. 做了什么

一句话：把「附件能导入但界面看不见、产物不可见、预览没有通道」补成可用链路：创建任务时可选文件/文件夹/ZIP；任务卡显示附件数量与摘要；右栏工件面板列出附件与产物；文本/图片/hex 只读预览；`artifact.refresh` 真实现并广播 `artifact.updated`；全程不执行、不系统打开、不渲染 HTML。

**渲染层**

- 新建任务弹窗增加「选择文件 / 选择文件夹 / 选择 ZIP」；任务先创建，再导入附件；导入失败不回滚任务，可在右栏工件面板补导入。
- 任务看板每行显示附件数量徽标；焦点任务卡显示最多 6 条附件摘要（名称、大小、sha256 短格式、导入时间）。
- 右栏新增「工件」面板：
  - 附件区：来自 `HubSnapshot.attachments?` / `TaskView.attachments?`；
  - 产物区：来自 `HubSnapshot.artifacts?` / `artifact.updated`；
  - 「刷新工件」调 `artifact.refresh`；
  - 「＋文件 / ＋文件夹 / ＋ZIP」用于补导入；
  - 点击条目打开只读预览弹窗。
- 预览：
  - 文本/hex 用 `<pre>` + `textContent`，HTML/SVG 只显示源码；
  - 图片只接受 `data:image/(png|jpeg|gif|webp|bmp);base64`，拒绝 `data:text/html` / SVG；
  - 不提供系统打开/执行按钮，`systemOpen` 恒为 `false`。
- 旧快照/旧 mock 没有 `attachments` / `artifacts` 时按空数组处理，面板显示「暂无工件」，不炸。

**最小 Lane A（经用户批准）**

- 契约新增 `ArtifactView`、`ArtifactPreview`、`AttachmentPickKind`、`AttachmentPickResult`；`HubSnapshot.artifacts?`；`HubApi.previewArtifact?` / `pickAttachments?`；`HUB_CHANNELS.artifactPreview` / `attachmentPick`；`artifact.updated` 的 `artifacts` 改为 `ArtifactView[]`。
- 新增 `main/artifacts/list.ts`：任务目录产物扫描（跳过 `attachments/`、`node_modules/.git/dist/build/target` 等；不跟随 symlink/junction；500 文件/深度 6 上限）。
- `hub.ts`：`HubSnapshot.artifacts`、`previewArtifact()`、`artifact.refresh` 真实现、`artifact.updated` 广播；列产物/预览前都检查任务目录是否经 junction 逃出 workRoot。
- `electron/main.ts` + `preload.cjs`：`dialog.showOpenDialog` 选择器、`hub:artifact.preview` 只读预览通道；路径仍由 P3-A `previewAttachment()` 做 realpath/越界/symlink 校验。
- `validate-action.ts` 只更新 `artifact.refresh` 注释；结构校验不变。

**关键取舍**

- 附件选择放主进程：Electron 44 renderer 的 `File.path` 已移除，`webUtils.getPathForFile()` 未暴露；只有 `dialog.showOpenDialog` 能稳定拿到绝对路径。附件导入仍走 P3-A 的预检/限额/原子落盘，不重写导入。
- 工件扫描只读、不缓存：任务目录通常很小；用 500 文件/深度 6 上限防止异常目录拖慢快照。没有文件 watcher，刷新靠手动 `artifact.refresh`。
- 预览不做系统打开：`isSystemOpenAllowed()` 仍只在 P3-A 函数层存在；本轮没有 `openPath` / `shell.openExternal` / `artifact.reveal`。ZIP 在导入阶段按 P3-A 既有语义解压；工件面板不提供再次解压/执行。
- 图片安全在渲染层再校验一次 MIME：即使后端返回异常 data URL，也不会被 `<img>` 渲染。

---

## 2. 改了哪些文件

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/artifacts/list.ts` | 任务目录产物扫描（只读、跳过附件/重目录、拒绝 symlink、500/6 上限） |
| `apps/desktop/src/renderer/artifacts.ts` | 工件面板/附件列表/预览的纯视图 + DOM；注入局部样式；不 innerHTML |
| `docs/requests/B-to-A-artifact-ipc.md` | 经用户批准的最小 Lane A 契约/IPC 请求 |
| `docs/done/P3-C.md` | 本文件 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | `ArtifactView`/`ArtifactPreview`/`AttachmentPickKind`/`AttachmentPickResult`；`HubSnapshot.artifacts?`；`HubApi.previewArtifact?`/`pickAttachments?`；两个 IPC 通道；`artifact.updated` 用 `ArtifactView[]` |
| `apps/desktop/src/main/hub/hub.ts` | `taskArtifacts()`；`HubSnapshot.artifacts`；`previewArtifact()`；`artifact.refresh` 真实现 + `artifact.updated` 广播 |
| `apps/desktop/src/main/electron/main.ts` | `dialog` 选择器 IPC；`hub:artifact.preview` IPC；仅结构校验后转 Hub |
| `apps/desktop/src/main/electron/preload.cjs` | 暴露 `previewArtifact` / `pickAttachments` |
| `apps/desktop/src/main/electron/validate-action.ts` | 只更新 `artifact.refresh` 注释 |
| `apps/desktop/src/renderer/contract.ts` | 再导出新类型 |
| `apps/desktop/src/renderer/store.ts` | `attachments`/`artifacts` 状态；快照/`task.upsert`/`artifact.updated` 折叠；旧字段缺席按空 |
| `apps/desktop/src/renderer/task.ts` | 创建弹窗附件选择/导入中提示/失败不回滚；任务卡附件数量 |
| `apps/desktop/src/renderer/main.ts` | 任务卡附件摘要；看板附件徽标；右栏工件面板 |
| `apps/desktop/src/renderer/mock/data.ts` | 3 个附件 + 5 个产物的世界；`attachments:"none"` 空世界；旧默认世界仍不带新字段 |
| `apps/desktop/src/renderer/mock/engine.ts` | `attachment.import` / `artifact.refresh` / `previewArtifact` / `pickAttachments`；快照带附件/产物 |
| `apps/desktop/src/renderer/smoke.ts` | 新增 29 条 P3-C 断言；旧 187 条零删除零改语义 |
| `apps/desktop/src/cli/verify-artifacts.ts` | A 组 1 条占位断言随 `artifact.refresh` 真实现更新；总数仍 324 |
| `docs/PROGRESS.md` | 追加一行 |

**明确没改**：`board.ts`（仍 v1、无附件/工件列）、`session/manager.ts`、`mcp-host/server.ts`、`mcp-host/bridge.ts`、`briefing/**`、`skill/**`、`rules/**`、`config/**`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify-skills.ts`、`verify-migration.ts`、`verify:all` 链、`D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置。

---

## 3. 怎么验证的

### 3.1 Smoke 红测 / 绿测

先加渲染层断言与 `artifacts.ts` 桩（面板返回空、预览函数已实现但 store/mock 未接），跑红：

```text
$ node apps/desktop/src/renderer/smoke.ts
== P3-C 附件选择 / 工件面板 / 预览 ==
FAIL  P3-C mock 世界带 3 个附件
FAIL  P3-C mock 世界带产物列表
FAIL  P3-C applySnapshot 读附件  └─ attachments=undefined
FAIL  P3-C applySnapshot 读产物  └─ artifacts=undefined
FAIL  P3-C 工件面板列出 3 个附件  └─ attachments=0
FAIL  P3-C 工件面板列出产物  └─ artifacts=0
FAIL  P3-C 附件 sha256 短格式  └─ undefined
FAIL  P3-C 附件导入时间可读  └─ undefined
FAIL  P3-C 任务卡带附件数量  └─ undefined
FAIL  P3-C mock hub 快照带附件  └─ attachments=undefined
FAIL  P3-C mock hub 快照带产物  └─ artifacts=undefined
FAIL  P3-C mock artifact.refresh 返回 ok  └─ {"ok":false,"error":"unknown action"}
FAIL  P3-C mock 文本预览  └─ null
FAIL  P3-C mock 附件选择返回路径  └─ null

14 FAILED
```

证据：`evidence/p3c-smoke-red.txt`（215 条计分，14 FAIL；旧 187 条全绿）。红测后补了 1 条“先建任务后补附件”的 `attachment.import` 断言，因此绿测是 216 条。

**绿测**：

```text
$ node apps/desktop/src/renderer/smoke.ts
...
PASS  P3-C mock attachment.import 增加附件（可先建任务后补）  └─ {"res":{"ok":true,"message":"mock: 已导入 1 个文件"},"attachments":4}

ALL PASS
```

- smoke **187 → 216（+29，旧 187 条零删除零改语义）**。
- 新增 29 条覆盖：3 附件/5 产物 mock 世界；`applySnapshot` 读附件/产物；面板数量/短 sha/导入时间；`systemOpen=false`；导入中提示；文件选择计数；HTML/SVG 文本预览；非位图 data URL 拒绝；位图 data URL；hex；可执行不系统打开；任务卡附件数量；后台 `artifact.updated` 丢弃；焦点 `artifact.updated` 更新；旧快照无附件/产物不炸；mock hub 快照附件/产物；`artifact.refresh`；mock 文本预览；mock 选择器；补导入。

### 3.2 后端临时验收

`evidence/p3c-artifact-backend.txt`（23/23 PASS）：

- 扫描：列到 `evidence/flag.txt` / `artifacts/*` / `sub/nested.txt`；不列 `attachments/`、`attachments.json`、`node_modules/`、`.git/`、junction 逃逸目录；分类 text/image/binary 正确。
- 预览：附件文本、HTML 只当文本、可执行只给 hex、PNG data URL、`../` 与 junction 拒绝。
- Hub 集成：`previewArtifact` 文本/越界/未知任务；`artifact.refresh` 返回 ok 并广播 `artifact.updated`。

### 3.3 真实 Electron IPC 临时验收

`evidence/p3c-ipc-verify.txt`（4/4 PASS）：

- preload 暴露 `previewArtifact` / `pickAttachments`；
- `window.bumimang.previewArtifact(taskId, "artifacts/page.html")` 经 `hub:artifact.preview` 返回文本（HTML 源码）；
- `../outside.txt` 经 IPC 仍被拒绝。
- 说明：该临时脚本在测试进程里注册了与 `main.ts` 同形的 handler（`preload → IPC → Hub.previewArtifact`），验证的是通道/序列化/后端校验；`main.ts` 的 `registerIpc` 由 Electron `--verify` 加载真实主进程覆盖（26/26），但没有在自动断言里调用预览通道。
- `dialog.showOpenDialog` 无法在无头环境弹框，未做自动点击；代码路径由 Electron `--verify` 加载 + 真实窗口确认面板存在。

### 3.4 全套回归

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run verify:all` | **607 PASS / 0 FAIL**（391 + smoke 216） | `evidence/p3c-verify-all.txt` |
| `npm run verify:artifacts` | **324/324**（A110/B51/C58/D33/E72） | `evidence/p3c-artifacts.txt` |
| `npm run verify:skills` | **149/149** | `evidence/p3c-skills.txt` |
| `npm run verify:multitask` | **174/174** | `evidence/p3c-multitask.txt` |
| `npm run verify:migration` | **44/44** | `evidence/p3c-migration.txt` |
| Electron `--verify` | **26/26** | `evidence/p3c-electron-verify.txt` |

### 3.5 保护面

- `.probe/backup-wp1/board.db`：348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，未变。
- `board.ts`（`2882feae…`）、`session/manager.ts`（`c816a8f2…`）、`mcp-host/server.ts`（`ed878004…`）、`bridge.ts`（`aec9307f…`）、`briefing/build.ts`（`98852b37…`）与 P3-C 开工前一致；`board.ts` 仍 v1、无附件/工件列。
- `skill/**`、`verify-r18/hardening/multitask/skills/migration` mtime 均早于 P3-C；`verify:all` 链未改。
- `.probe/backup-p3c/` 保留了 P3-C 开工前 12 个目标文件与 `verify-artifacts.ts` 备份。

---

## 4. 行为变更

> 与 WP1 的四个行为变更、WP2 的加法变更、P3-A 的契约加法、P3-B 的证据链变更并列。

1. **契约加法（全部可选/不删旧字段）**
   - 新增 `ArtifactView` / `ArtifactPreview` / `AttachmentPickKind` / `AttachmentPickResult`；
   - `HubSnapshot.artifacts?`（焦点任务）；
   - `HubApi.previewArtifact?` / `pickAttachments?`（旧 preload/mock 不实现时 UI 降级）；
   - `HUB_CHANNELS.artifactPreview` / `attachmentPick`；
   - `artifact.updated.artifacts` 从内联对象改为 `ArtifactView[]`（结构兼容）。
   - **影响**：旧快照/旧 mock 不读新字段仍然工作；新字段缺席按空处理。

2. **`artifact.refresh` 从占位变为真实现**
   - **改了哪条**：旧行为 `{ok:false,error:"artifact.refresh 将在 P3-C 实现…"}`；新行为扫描任务目录、返回 `{ok:true,message:"已刷新 N 个工件"}` 并广播 `artifact.updated`。
   - **为什么**：P3-C 工件面板需要真实数据源；P3-A 已明确把实现留给 P3-C。
   - **影响历史证据**：无；只影响新动作调用。
   - **旧测试怎么处理**：`verify-artifacts.ts` A 组 1 条占位断言更新为“刷新成功并带工件数”；总数仍 **324**，其余 323 条未改。`smoke.ts` 旧 187 条未改。

3. **新增 `previewArtifact` 只读 IPC**
   - **改了哪条**：新增通道，不改旧通道；`HubApi` 方法可选。
   - **为什么**：渲染层在 contextIsolation 下不能 import 主进程 `preview.ts`。
   - **安全**：复用 P3-A `previewAttachment()` 的 realpath/越界/symlink 校验；文本/hex 文本节点；图片位图 data URL；HTML/SVG 文本；不执行/不 openPath。
   - **旧测试**：纯加法；Electron 26 不变，smoke 新增预览断言。

4. **新增附件选择器 `pickAttachments`**
   - **改了哪条**：新增主进程 `dialog.showOpenDialog` 通道；`attachment.import` 语义不变。
   - **为什么**：Electron 44 renderer 拿不到稳定绝对路径；`attachment.import` 需要绝对路径。
   - **行为**：文件多选 / 文件夹 / ZIP 三选一；返回取消或绝对路径；导入仍由 P3-A 预检/限额/原子落盘。
   - **旧测试**：纯加法；mock 返回演示路径。

5. **创建任务弹窗：先建任务，再导入附件**
   - **改了哪条**：旧弹窗只发 `task.create` 后立即关闭；新弹窗在创建成功后如有选择，继续发 `attachment.import`。
   - **为什么**：导入 200MB 可能耗时；导入失败不能回滚已创建任务。
   - **行为**：显示「正在导入附件…」；失败显示可读错误并保留任务；可在右栏工件面板补导入。
   - **旧测试**：smoke 旧断言未改；新增导入中提示/补导入断言。

6. **任务卡/工件面板读取新快照字段**
   - **改了哪条**：新增显示，不改旧布局语义；看板新增附件数量徽标，焦点任务卡新增附件摘要，右栏新增「工件」面板。
   - **旧快照**：`attachments` / `artifacts` 缺席时面板显示「暂无工件」，任务卡不显示附件区，不炸。
   - **旧测试**：smoke 新增旧快照兼容断言。

7. **不做系统打开/执行**
   - **明确边界**：没有 `openPath` / `shell.openExternal` / `artifact.reveal`；`systemOpen` 恒 `false`；可执行文件只给 hex 预览；ZIP 导入按 P3-A 既有语义解压，面板不再次解压/执行。
   - **为什么**：P3-C 风险要求“不执行、不 openPath 可执行”。

---

## 5. 没做什么 / 已知问题（含已知中间状态）

1. **没有文件 watcher**：agent 新写产物不会自动出现在面板；需要点「刷新工件」或重新拉快照。`artifact.updated` 只在 `artifact.refresh` 后广播。
2. **工件扫描上限**：500 文件、深度 6；超出部分不列。跳过 `attachments/`、`attachments.json`、`node_modules/.git/dist/build/target` 等。
3. **没有系统打开/reveal**：这是有意的安全边界；P3-A 的 `isSystemOpenAllowed()` 仍未接 UI。
4. **图片预览上限**：P3-A 2MB；超过返回 `unsupported+truncated`，不生成部分 data URL。
5. **文本/hex 上限**：文本 256KB、hex 4KB；截断只显示提示，不提供“加载更多”。
6. **导入没有字节级进度**：只显示「正在导入附件…」；200MB 上限由 P3-A 预检执行，失败返回可读错误。
7. **附件选择器未无头自动点击**：`dialog.showOpenDialog` 需要真实桌面交互；已用 Electron `--verify` 确认窗口/面板加载，用真实 IPC 脚本确认 `previewArtifact` 通道（测试进程注册同形 handler，非 `main.ts` 的 `registerIpc` 自动断言）。
8. **旧 preload 降级**：没有 `previewArtifact` / `pickAttachments` 的旧 preload，UI 显示“当前后端不支持”，不崩。
9. **预览 TOCTOU**：P3-A 的 realpath + 逐段 lstat 仍有本机并发替换窗口；不是 OS 级 jail。
10. **`verify-artifacts` 1 条旧占位断言更新**：`artifact.refresh` 行为变更的直接结果；总数仍 324。其余 verify 套件未改。
11. **未跑真实 agent、未烧 token**：全部是进程内 Hub / mock / 临时 Electron 脚本；没有动 `D:/agent/skill`、没有改全局配置、没有自动提交 flag。
12. **未重打包**：`dist/` 不是本轮产物；打包态附件选择/预览留 WP7。
13. **旧 `render-verify.ts` harness 仍有 6 项既有断言失败**：它按旧的 3 会话/4 审批 mock 期望写，而当前 multiTask mock 是 2 会话/1 审批；P3-C 未改会话/审批计数，该 harness 不在 `verify:all` 链，未纳入本轮门禁。
14. **`verify:artifacts` 仍未并入 `verify:all`**：按用户要求保持独立运行。

---

## 6. 下一手需要什么（P3-D / WP4 交接）

- P3-C 已完成附件选择、附件列表、工件面板、文本/图片/hex 预览、`artifact.refresh`、`artifact.updated` 广播；不要重做 P3-A 的导入/ZIP 安全、P3-B 的证据判定/回放。
- 可直接复用：
  - `listArtifacts(taskDir)`（只读、500/6 上限）；
  - `previewAttachment({ taskDir, relativePath })`（附件要加 `attachments/` 前缀；产物用 `ArtifactView.path`）；
  - `HubService.previewArtifact(taskId, relativePath)`；
  - `buildArtifactPanelView` / `buildArtifactPreviewView` / `buildAttachmentSelectionView`。
- 若要加文件 watcher / 字节级导入进度 / 系统打开（安全扩展名白名单）：先更新决策与契约，再写代码；本轮明确不做。
- 门禁：`verify:all` **607**、`artifacts` **324**、`skills` **149**、`multitask` **174**、`migration` **44**、Electron **26**；新增测试只加不改旧断言（本轮唯一例外是 `artifact.refresh` 占位断言）。

---

## 7. 证据

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p3c-smoke-red.txt` | smoke 红测 215 条 / 14 FAIL（旧 187 全绿） | `2aa0a411543bd2121bc56c80b3e28984287b2283c00b27a1375c53c79bf797c6` |
| `evidence/p3c-smoke.txt` | smoke 绿测 216/216 | `1deb89854399f4a986fb4ca3d5779ad0375fb29762d707016c08f0537daa8608` |
| `evidence/p3c-artifact-backend.txt` | 后端扫描/预览/Hub 23/23 | `38e32804ef8484bbd723b6d9a0d35c4f4acc5dc101e131a316815da4fc2d5f43` |
| `evidence/p3c-ipc-verify.txt` | 真实 Electron preload→IPC 预览 4/4 | `999870809e87c250b35bb946082d934bc4df6268c4c85a9bcecd9190a3a2149f` |
| `evidence/p3c-verify-all.txt` | verify:all 607 PASS / 0 FAIL | `bb4698c1ee5acfb8b55e20251e4227255cfbaec3f7f761adc17121820a2fafa0` |
| `evidence/p3c-artifacts.txt` | 324/324（A–E） | `801d2fe2239e69f41dc563c065a88a5cc2846b7c4cc5db8a42519a06c6329f40` |
| `evidence/p3c-skills.txt` | 149/149 | `0592fce9050ba27a9ee7c4d24113e9571fe2b9916034872f1c775eef29b38a3c` |
| `evidence/p3c-multitask.txt` | 174/174 | `71f23477ad93b9c12638d3750654083670ad90cb051c693b09b9738fe0f18ad8` |
| `evidence/p3c-migration.txt` | 44/44 | `808bc1569fd3e4b63808ab1370a08a326689ee53048fdfae0149ac5904cbb758` |
| `evidence/p3c-electron-verify.txt` | Electron 26/26 | `255815dce1ef98a78d43b1fe682fb136d5b0938e89f861c34f219d2e37c08736` |

`.probe/backup-p3c/` 保留了 P3-C 开工前目标文件；`.probe/p3c-artifact-backend.ts`、`.probe/p3c-ipc-verify.ts` 是临时验收脚本（不并入 `verify:*`）。
