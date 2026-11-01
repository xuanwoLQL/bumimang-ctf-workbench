# D-artifact-ipc · P3-C 最小 Lane A 扩展授权与理由

- 日期：2026-10-23
- 状态：P3-C 已实施；P3-D 补写本决策（未改代码）
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` §6 WP3；`docs/plans/COMPETITION-READINESS.md` §6.2/§6.3；`docs/done/P3-C.md`；`docs/requests/B-to-A-artifact-ipc.md`
- 实现：`packages/shared-protocol/events.ts`、`apps/desktop/src/main/hub/hub.ts`、`apps/desktop/src/main/electron/main.ts`、`preload.cjs`、`validate-action.ts`（仅注释）、`apps/desktop/src/main/artifacts/list.ts`、`apps/desktop/src/renderer/**`

## 授权记录

- **时间**：2026-10-23，P3-C 开工前的状态确认阶段（精确时钟未落盘；`docs/requests/B-to-A-artifact-ipc.md` 创建于 19:47）。
- **渠道**：本次会话的 `AskUserQuestion`，在“严格 Lane B 无法按验收完成”的说明后给出选项。
- **用户选择**：**「扩到最小 Lane A（推荐）」**。
- **授权范围**：只补 P3-C 验收所必需的契约/IPC/后端最小增量；不扩到完整 Lane A，不改 board/session/briefing/skill/config，不做系统打开/执行，不新增 `artifact.reveal`。
- **留痕**：`docs/requests/B-to-A-artifact-ipc.md` 记录了契约增量、原因、安全边界和测试影响；本文件记录决策理由与实施边界。

## 背景

P3-C 原范围是“严格 Lane B，只改 renderer + mock”。状态确认时发现仅改渲染层无法达到验收：

1. `hub.ts` 的 `artifact.refresh` 仍返回“P3-C 才实现”的占位错误；
2. `HubSnapshot` 没有 `artifacts?`，渲染层无法列出产物；
3. `preload.cjs` 只有 snapshot/history/dispatch/event 四个通道，没有预览/选择器；
4. Electron 44 renderer 的 `File.path` 已移除，`webUtils.getPathForFile()` 未暴露，`dialog.showOpenDialog` 只在主进程；
5. P3-A 的 `previewAttachment()` 在主进程，contextIsolation 下渲染层不能直接 import。

按用户“任何不符先停下问”的规则，P3-C 未直接开工；用户批准最小 Lane A 后按本决策实施。

## 决策

### 1. 为什么 `artifact.refresh` 必须后端真实现

- 渲染层没有 Node/`fs`，也不能安全地扫描 `<workRoot>/<taskId>`；即使能读，也会绕开 P3-A 的 realpath/越界/symlink 校验。
- `artifact.refresh` 是 Hub 动作，语义应是“重扫任务目录并广播新快照”；只在渲染层刷新空列表或 mock 数据是假实现。
- 因此 `hub.ts` 增加 `taskArtifacts()`，`artifact.refresh` 扫描任务目录、返回 `{ok:true,message:"已刷新 N 个工件"}`，并 `bus.emit({type:"artifact.updated", taskId, artifacts})`。
- 列产物/预览前都检查任务目录未通过 junction 逃出 workRoot；扫描本身只读、跳过 `attachments/`、重目录、symlink，500 文件/深度 6 上限。

### 2. 为什么 `HubSnapshot.artifacts?` 必须后端提供

- 渲染层不能自己拼任务目录绝对路径，也不能直接 `readdir`；路径必须来自后端已校验的快照。
- 产物列表是焦点任务视图的一部分；后端提供 `HubSnapshot.artifacts?`，渲染层只读，不缓存路径、不推导路径。
- 字段是**可选**的：旧快照/旧 mock 没有它时按空数组处理，面板显示「暂无工件」，不炸。

### 3. 为什么预览 IPC 必须 preload 暴露

- contextIsolation + sandbox 下，renderer 不能 import 主进程 `preview.ts`，也不能直接读文件。
- 预览必须复用 P3-A `previewAttachment()` 的路径校验、大小/魔数/截断逻辑；不能在渲染层复制一套。
- 因此新增 `hub:artifact.preview` 通道，preload 暴露 `previewArtifact(taskId, path)`；主进程只做结构截断（taskId/path 长度）后转 `HubService.previewArtifact()`，由 Hub 再做任务存在/目录边界和 P3-A 文件校验。
- 返回 `ArtifactPreview`；文本/hex 只作为文本节点渲染，图片只接受位图 data URL，HTML/SVG 只当文本。

### 4. 为什么 `pickAttachments` 必须主进程

- Electron 44 renderer 拿不到稳定绝对路径；`attachment.import` 需要绝对路径。
- `dialog.showOpenDialog` 只能在主进程调用；新增 `hub:attachment.pick`，返回 `{canceled, paths}`；导入仍走 P3-A `attachment.import` 的预检/限额/原子落盘。
- 文件多选 / 文件夹 / ZIP 三选一；选择器本身不读文件、不执行。

### 5. 为什么不能延后到 P3-D

- P3-D 是 **WP3 收口步骤，只写文档 + 跑全量，不改代码**。
- 若把契约/IPC/后端延后，P3-C 只能交付 mock 世界：真实任务没有产物列表、预览按钮没有通道、`artifact.refresh` 仍是占位；这不符合 P3-C 的验收，也会把“真实可用”推迟到没有代码窗口的收口步。
- 因此必须在 P3-C 内完成最小 Lane A，P3-D 只记录授权与边界。

## 实施边界（只加可选字段，不破契约冻结）

| 文件 | 改动 | 是否破坏契约 |
|---|---|---|
| `packages/shared-protocol/events.ts` | 新增 `ArtifactView` / `ArtifactPreview` / `AttachmentPickKind` / `AttachmentPickResult`；`HubSnapshot.artifacts?`；`HubApi.previewArtifact?` / `pickAttachments?`；`HUB_CHANNELS.artifactPreview` / `attachmentPick`；`artifact.updated.artifacts` 从内联对象改为 `ArtifactView[]` | **否**：全是加法/结构兼容；旧 preload/mock 不实现可选方法时 UI 降级 |
| `apps/desktop/src/main/hub/hub.ts` | `taskArtifacts()`、`HubSnapshot.artifacts`、`previewArtifact()`、`artifact.refresh` 真实现 + 广播 | **否**：只实现 P3-A 已占位的动作 |
| `apps/desktop/src/main/artifacts/list.ts` | 新增只读工件扫描（500/6，跳过附件/重目录/symlink） | **否**：新模块 |
| `apps/desktop/src/main/electron/main.ts` | `hub:artifact.preview` / `hub:attachment.pick` 两个 IPC；`dialog.showOpenDialog` | **否**：新通道，不改旧通道 |
| `apps/desktop/src/main/electron/preload.cjs` | 暴露 `previewArtifact` / `pickAttachments` | **否**：新方法 |
| `apps/desktop/src/main/electron/validate-action.ts` | 只更新 `artifact.refresh` 注释；结构校验不变 | **否**：无行为变化 |
| `apps/desktop/src/renderer/**` | store/task/main/contract/artifacts 消费新字段；附件选择/工件面板/只读预览 | **否**：旧快照缺字段按空 |
| `apps/desktop/src/renderer/mock/**`、`smoke.ts` | 3 附件/5 产物 mock 世界；新增 29 条断言 | **否**：旧 187 条零删除零改语义 |

**明确没有做**：

- 没有 `artifact.reveal`、`shell.showItemInFolder`、`openPath`、`shell.openExternal`；
- 没有执行任何附件/工件/脚本；ZIP 只在导入阶段解压；
- 没有改 `board.ts` schema（仍 v1）、`session/manager.ts`、`mcp-host/**`、`briefing/**`、`skill/**`、`config/**`；
- 没有把附件清单注入简报（见 WP3 收口文档的验收差距）；
- 没有发新的 `docs/requests/B-to-A-*.md`（P3-D 明确不发）。

## 测试影响

- `verify-artifacts.ts` A 组 1 条旧占位断言随 `artifact.refresh` 真实现更新为“刷新成功并带工件数”；**总数仍 324**，其余 323 条未改。
- `smoke.ts` 旧 187 条零删除零改语义；新增 29 条，187→216；`verify:all` 578→607。
- `verify:skills` 149、`verify:multitask` 174、`verify:migration` 44、Electron 26 不变。
- 临时验收：后端扫描/预览/Hub 23/23；真实 Electron preload→IPC→Hub 4/4（测试进程注册与 `main.ts` 同形 handler；`main.ts` 的 `registerIpc` 由 Electron `--verify` 加载覆盖，但没有自动断言调用预览通道）。
- `dialog.showOpenDialog` 未做无头自动点击；选择器需要真实桌面交互。

## 备选方案与取舍

- **严格 Lane B**：无法拿绝对路径、无法扫目录、无法预览、无法刷新；只能全 mock，否决。
- **完整 Lane A**：会顺带改 board/session/briefing/skill/config，超出 P3-C 验收；否决，只取最小增量。
- **renderer 直接读 workdir**：contextIsolation 下不可行，且绕过后端路径校验；否决。
- **把预览做成 `data:`/`file://` 直接加载**：会绕过 MIME/路径/大小校验，且可能渲染 HTML/SVG；否决。
- **延后到 P3-D**：P3-D 不改代码，等于 P3-C 交付假功能；否决。
- **系统打开安全扩展名**：P3-A 有白名单函数，但比赛期优先“不执行”；P3-C 明确不做入口。

## 已知边界

1. 预览 IPC 的 4/4 临时验收使用同形 handler，不是 `main.ts` 的 `registerIpc` 自动断言；真实主进程只由 Electron `--verify` 加载覆盖。
2. `dialog.showOpenDialog` 无法在无头环境弹框；未做真实点击。
3. 没有文件 watcher：agent 新写产物需点「刷新工件」或重拉快照。
4. 工件扫描 500 文件/深度 6；超出不列。
5. 导入无字节级进度，只有「正在导入附件…」。
6. 没有系统打开/reveal；可执行文件只给 hex 预览。
7. 预览路径校验不是 OS 级 jail，存在本机并发替换的 TOCTOU 窗口。
8. 附件清单未注入简报（WP3 验收差距；留 WP4 前评估）。

## 后续

- **WP3 收口**：`docs/done/WP3-artifacts.md` 记录本扩展与验收差距。
- **WP4**：若需要新 `HubAction`/`HubEvent`/快照字段，先写 `docs/requests/` 并停下问用户；不要直接改 `events.ts`。
- **WP6**：文件 watcher / 字节级进度 / 更强隔离再评估；不要把 `previewArtifact` 当 OS 级沙箱。
- **WP7**：打包态选择器/预览端到端；当前 `dist/` 不是 P3-C 产物。
