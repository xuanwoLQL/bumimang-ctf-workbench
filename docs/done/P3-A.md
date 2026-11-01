# P3-A · 附件导入 + ZIP 解析 + 预览 + attachments.json

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §6 WP3；`docs/plans/COMPETITION-READINESS.md` §6.2/§6.3/§6.5/§6.6；`docs/done/WP1-multitask.md`、`docs/done/WP2-skills.md`
> 日期：2026-10-23
> 状态：**P3-A 完成**。本轮只做附件导入/落盘/预览/扫描函数与契约可选增量；**没有**扩展 `inferEvidence`、没有 `cmd:` 回放、没有 renderer、没有动 WP1/WP2 的收口逻辑。
> 验收基线：**`verify:all` 578 PASS / 0 FAIL；`verify:skills` 149/149；`verify:multitask` 174/174；`verify:migration` 44/44；`verify:artifacts` 219/219（A 110 / B 51 / C 58）；Electron `--verify` 26/26。**

---

## 1. 做了什么

把「附件进不来、工件不可见」补成第一段可用链路：

- **导入**：`attachment.import` 接受文件 / 文件夹 / zip（一次只允许一种类型），把内容复制/解压到 `<workRoot>/<taskId>/attachments/`，并写 `attachments.json`（`name` / `relativePath` / `size` / `sha256` / `type` / `source` / `importedAt`）。
- **ZIP**：Node 标准库手写解析（EOCD + 中央目录 + 本地头），只支持 store/deflate；拒绝 zip-slip、绝对路径、盘符、反斜杠逃逸、NUL、symlink、加密、ZIP64、多卷、未知方法、坏 CRC、重复名/文件目录冲突；先解压到 `attachments/.import-<ts>-<rand>/`，全部校验通过后才逐个原子 rename；失败清理临时目录与本次已 rename 的产物。
- **预览**：文本（UTF-8，≤256KB）、图片（PNG/JPEG/GIF/WebP/BMP，魔数校验，≤2MB，base64 data URL）、二进制 hex（≤4KB）；HTML/SVG 只当文本，不渲染、不执行、不 `openPath`；路径 realpath 在任务目录内，路径上任何 symlink/junction 都拒绝。
- **扫描**：文本附件扫 `flag{...}`（大小写不敏感），只返回「任务内路径 + 命中串」，**不落 flag 候选、不写黑板**；P3-A 只建函数，不接 Hub。
- **Hub 快照**：`HubSnapshot.attachments?` = 焦点任务附件清单；`TaskView.attachmentCount?` 所有任务都有；`TaskView.attachments?` 只给焦点任务视图，避免一次快照重复搬运 N 份列表。
- **契约占位**：`HubAction.artifact.refresh` 只加类型，Hub 返回「P3-C 才实现」；`HubEvent.artifact.updated` 只加类型，本轮不广播。

**关键取舍**

- `board.ts` **没有改**：附件本体和 `attachments.json` 都在磁盘，快照按需读清单；没有加 `attachment_count` 列，也没有动 `user_version`（仍是 v1），避免和后续子步骤抢版本号。
- 导入先完整预检（路径/类型/大小/数量/重名/清单合法性），再 staging；单任务上限按「已有清单 + 本次新增」计算。
- ZIP 条目统一按普通文件写出；ZIP 没有标准 hardlink 条目，本实现从不调用 `link()`，即使外部塞入链接语义的条目也只会得到普通文件拷贝；symlink/特殊 Unix mode/Windows reparse point 直接拒绝。
- 预览/扫描共用 `preview.ts` 的路径校验；扫描先嗅探前 4KB，含 NUL 的 `.txt` 也按二进制跳过。

---

## 2. 改了哪些文件

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/artifacts/import.ts` | 文件/文件夹/zip 导入、流式 sha256/复制、预检、临时目录 + 原子 rename、`attachments.json` 读写 |
| `apps/desktop/src/main/artifacts/zip.ts` | 最小 ZIP 解析/解压（store/deflate）、安全校验、CRC、限额 |
| `apps/desktop/src/main/artifacts/preview.ts` | 路径校验（realpath + 逐段 symlink/junction 拒绝）、文本/图片/hex 预览、系统打开白名单 |
| `apps/desktop/src/main/artifacts/scan.ts` | 文本附件 `flag{...}` 扫描（只返回路径 + 命中串） |
| `apps/desktop/src/cli/verify-artifacts.ts` | A/B/C 三组验收（219 条） |
| `docs/done/P3-A.md` | 本文件 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/shared-protocol/events.ts` | 新增 `AttachmentView`；`TaskView.attachments?`；`HubSnapshot.attachments?`；`HubAction.attachment.import` / `artifact.refresh`；`HubEvent.artifact.updated`（只加类型） |
| `apps/desktop/src/main/electron/validate-action.ts` | 校验 `attachment.import`（paths 非空/数量/长度/NUL、taskId/note）；放行 `artifact.refresh` 结构 |
| `apps/desktop/src/main/hub/hub.ts` | `attachment.import` 处理 + 审计；快照附件字段；`artifact.refresh` 占位；附件清单按焦点/数量填充 |
| `package.json` | 新增 `verify:artifacts`（**不并入** `verify:all`） |
| `docs/PROGRESS.md` | 追加一行 |

**明确没改**：`bridge.ts`（`inferEvidence` 原样）、`briefing/**`、`skill/**`、`session/manager.ts`、`renderer/**`、`board.ts`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify-skills.ts`、`smoke.ts`、`config/**`、`mcp-host/**`、`D:/agent/skill`、`docs/ARCHITECTURE.md`。

---

## 3. 怎么验证的

### 3.1 红测

先写 `verify-artifacts.ts`，把四个新模块替换成「未实现」桩后运行：

```text
================ 52/136 通过 ================
FAILED:
  - A：CRC-32 已知答案（123456789） — actual=0 expected=3421780262
  - A：单文件导入成功 — {"ok":false,"error":"桩：附件导入未实现"}
  ...
  - B：拒绝../ 逃逸 — {"ok":false,"error":"桩：附件导入未实现"}
  ...
  - C 组崩溃 — 桩：未实现
--- exit=1 18:08:53 ---
```

证据：`evidence/p3a-artifacts-red.txt`（52/136；84 条计分 FAIL + 1 条 A 组崩溃标记 = 85 行 FAIL；exit=1）。桩文件已全部还原（还原校验通过）；之后又对 import/zip 做了两处加固（压缩数据限额、任务路径非目录校验），不改变红测结论。

### 3.2 绿测（A/B/C）

```text
$ npm run verify:artifacts
================ A 组：附件导入与落盘 ================
================ B 组：ZIP 安全 ================
================ C 组：预览与路径安全 ================

================ 219/219 通过 ================
--- exit=0 18:16:32 ---
```

分组：**A 110 / B 51 / C 58 = 219**。覆盖：

- **A**：文件/文件夹/store zip/deflate zip/多 zip 导入；manifest 字段、sha256、POSIX relativePath；200MB/1000 模拟上限；失败不残留（临时目录、目录列表、manifest 不变）；坏 CRC 回滚；混合类型/相对路径/空目录/来源 junction/保留名/重名/taskId 非法/工作目录不存在；损坏或非法 `attachments.json` 拒绝覆盖；任务目录 junction 拒绝；跨任务隔离；扫描函数（大小写不敏感、maxBytes、含 NUL 跳过、不接 Hub）；Hub 快照/后台任务/切换/归档/`artifact.refresh` 占位；`validateHubAction` 正反例。
- **B**：`../`、绝对路径、盘符、`..\\`、NUL、symlink、加密、ZIP64、坏 CRC、大小写重复、文件/目录冲突、空 zip、只有目录全部拒绝且无任务目录残留；store/deflate 正常解压且产物都是普通文件（非链接）；zip+文件、zip+文件夹混合明确报错；已有清单时失败不改目录/清单。
- **C**：文本/大文本截断、图片 data URL 与解码一致、超大图片 `unsupported+truncated`、假 PNG 不按图片、二进制 hex 截断、目录 `unsupported`、HTML/SVG 只当文本、含 NUL 的 `.txt` 走 hex、预览只读；`../`/反斜杠/绝对路径/盘符/NUL/不存在/越界 junction/任务内 junction/空路径全部拒绝；可执行/脚本/HTML/SVG/lnk 不允许系统打开；扫描跨预览窗口仍命中、二进制与含 NUL 文本跳过。

### 3.3 全套回归

```text
npm run verify:all          → 578 PASS / 0 FAIL（52+16+17+19+90+148+49 确定性 + smoke 187）
npm run verify:skills       → 149/149
npm run verify:multitask    → 174/174
npm run verify:migration    → 44/44
electron ... --verify       → 26/26
npm run verify:artifacts    → 219/219
```

证据：`evidence/p3a-verify-all.txt`、`p3a-skills.txt`、`p3a-multitask.txt`、`p3a-migration.txt`、`p3a-artifacts.txt`、`p3a-artifacts-red.txt`、`p3a-electron-verify.txt`。

### 3.4 保护面

- `.probe/backup-wp1/board.db`：348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录一致。
- 对 P3-A 开工前记录的 49 个受保护文件逐个比对 sha256：除允许修改的 `hub.ts` / `events.ts` / `validate-action.ts` 外，**零意外变化**（`bridge.ts`、`briefing/**`、`skill/**`、`manager.ts`、`renderer/**`、`board.ts`、四个 verify 套件、`smoke.ts`、`config/**` 均未动）。
- `user_version` 未变（v1）；`board.ts` 未改。

---

## 4. 行为变更（WP3 第一条，单独记录）

> 与 WP1 的四个行为变更、WP2 的加法变更并列。P3-A 的变更是**契约加法 + 新增动作**，没有改现有动作语义。

1. **契约新增（全部可选，不删旧字段、不加必填字段）**
   - `AttachmentView { name, relativePath, size, sha256, type, source, importedAt }`；
   - `TaskView.attachments?: AttachmentView[]`（只给焦点任务视图；其他任务只填 `attachmentCount`）；
   - `TaskView.attachmentCount?: number`（P1-A 已有字段，本轮开始真实填充）；
   - `HubSnapshot.attachments?: AttachmentView[]`（焦点任务；无任务/无附件时为 `[]`）；
   - `HubAction` 新增 `attachment.import { taskId?, paths, note? }` 与 `artifact.refresh { taskId? }`；
   - `HubEvent` 新增 `artifact.updated { taskId, artifacts }`（**只加类型，不广播**）。
2. **新动作 `attachment.import`**：任意**存在且未归档**任务都可导入（与 `session.start` 的任务范围一致）；`taskId` 缺省 = 焦点；导入成功后写审计 `attachment.import`，焦点任务推一次 `task.upsert`，后台任务只落盘等下次快照。`validate-action` 只做结构与长度校验，`taskId` 是否存在/是否归档由 Hub 在导入前检查。焦点/归档/配额/收敛/flag 逻辑**未改**。
3. **附件落盘约定**：文件 → `attachments/<文件名>`；文件夹 → `attachments/<文件夹名>/...`；zip → `attachments/<zip 名去掉 .zip>/...`。`relativePath` 一律 POSIX，禁止 `..`/盘符/绝对路径/NUL；清单按 `relativePath` 排序。
4. **导入限制**：单任务（已有 + 本次）200MB / 1000 文件；一次最多 100 个路径；一次只允许一种来源类型。超限/失败返回可读错误，**不部分写入**。
5. **预览/扫描是只读函数**：`previewAttachment` / `scanAttachmentForFlags` 已建但**没有接 Hub、没有 IPC**；`artifact.refresh` 调用返回「P3-C 才实现」；`artifact.updated` 不广播。`isSystemOpenAllowed` 只是白名单判断，本轮不实现系统打开。
6. **旧快照/旧 mock 不炸**：所有新字段可选；旧渲染层只读原有字段仍然工作。注意渲染层 `store.ts` 的 `applyEvent` 有 `default: never` 穷尽检查——新增 `artifact.updated` 后，未来若跑 `tsc` 会提示该分支；运行时无影响，P3-C 接渲染层时补 case。

---

## 5. 没做什么 / 已知问题（含已知中间状态）

1. **`inferEvidence` 未扩展**：E2 仍只认「任务工作目录内真实文件包含提交的 flag」；相对路径/事实文本/`cmd:` 回放/命令白名单都是 P3-B。
2. **`cmd:` 回放未实现**（P3-B，默认关）。
3. **附件 UI 未接**（P3-C）：没有 `dialog.showOpenDialog`、没有 `hub:attachment.*` IPC、没有工件列表/预览面板；渲染层不知道这些附件。
4. **扫描函数已建但未接入 Hub**（P3-B 接）：导入时不会自动扫 flag，不产生候选、不写黑板。
5. **flag 候选仍只在内存**（WP5 才持久化）。
6. **工件列表 / 预览面板未接**（P3-C）；`HubAction.artifact.refresh` 是占位，`artifact.updated` 不广播。
7. **证据约定未更新**（P3-B）：简报里没有附件清单，也没有要求命令回显写 `evidence/<name>.txt`。
8. **`board.ts` 没有附件列**：`attachmentCount` 来自每次快照读 `attachments.json`；任务多、附件多时每次快照会重复解析清单（最多 1000 条/任务），暂未加缓存。P3-C/WP6 若观察到卡顿再加 mtime 缓存。
9. **ZIP 的 hardlink 语义**：ZIP 没有标准 hardlink 条目；本实现拒绝 symlink/特殊 mode/reparse point，所有条目按普通文件写出，从不 `link()`。因此“拒绝 hardlink”在 ZIP 语境下是“不会创建硬链接”，不是“识别并拒绝某个 hardlink 标志位”。
10. **ZIP 文件名编码**：统一按 UTF-8 解码；CP437 非 ASCII 文件名可能被解码成替换字符（路径仍受校验，不会逃逸）。需要完整 CP437 支持时再加。
11. **图片 >2MB 不生成部分 data URL**：返回 `unsupported + truncated + totalBytes`，避免把半张图当可用图片。
12. **预览路径校验不是 OS 级 jail**：realpath + 逐段 lstat，存在本机用户并发替换路径的 TOCTOU 窗口；Windows 没有 `O_NOFOLLOW`。P3-C/WP7 若要更强隔离再评估。
13. **导入预检与解压之间有 TOCTOU**：zip 在预检后、解压前被替换时，解压会重新解析并再次校验；不会写出未校验条目，但可能导入与预检不同的内容（来源是用户本机文件）。
14. **导入锁是进程内、按任务**：单主进程成立；跨进程并发写同一任务不在本轮范围。
15. **导入路径必须绝对路径**：UI（P3-C）从 dialog 拿到的就是绝对路径；脚本/测试需自己传绝对路径。
16. **`source` 固定 `upload`**：文件/文件夹/zip 都用 `upload`；来源细分（例如 `zip:xxx`）留给 P3-B/P3-C。
17. **`attachment.import` 的 `note` 只进审计**，不写 `attachments.json`；`importedAt` 是本次导入的统一时间戳。
18. **未跑真实 agent、未烧 token**：本轮全部是进程内 Hub / fake fixture；没有动 `D:/agent/skill`、没有改全局配置、没有自动提交 flag。
19. **未重打包**：`dist/` 不是本轮产物；P3-C 接渲染层后再按 WP7 的打包流程处理。
20. **`verify:artifacts` 未并入 `verify:all`**：按用户要求保持独立运行。
21. **扫描默认只读前 4MB**：`maxBytes` 可覆盖；超过 4MB 的文本/证据文件末尾的 flag 不会被扫到（预览窗口更小，只有 256KB）。
22. **ZIP 压缩数据也占限额**：单个条目的 `compSize` 超过任务上限会直接拒绝，避免“压缩数据巨大、解压后很小”的流式读取消耗。

---

## 6. 下一手需要什么（P3-B 交接）

- **P3-B 只做证据链**：`inferEvidence` 扩展（相对路径、事实文本、`cmd:` 回放）、简报附件清单/证据约定、把 `scan.ts` 接到 Hub（导入后/证据文件写入后扫候选）。不要重做 P3-A 的导入/预览/ZIP 安全。
- **P3-B 可直接复用**：
  - `readAttachments(taskDir)` 安全读清单（损坏返回 `[]`）；
  - `scanAttachmentForFlags({ taskDir, relativePath })`，注意 `relativePath` 是**任务目录相对路径**，附件要传 `attachments/<manifest.relativePath>`；
  - `previewAttachment({ taskDir, relativePath })` 同样按任务目录相对路径；`AttachmentView.relativePath` 是 attachments 目录相对路径，调用方需加 `attachments/` 前缀（P3-C 建议在渲染层封装这个转换）。
  - `ZipError` / `ArtifactPathError` 的 `code` 可用于 P3-B 的错误分流。
- **P3-B 不要碰**：`HubAction` 现有语义、焦点/归档/配额/收敛/flag 逻辑、`board.ts` schema（如确需列，先读 `user_version`，当前 v1）。
- **P3-C 再接**：`dialog.showOpenDialog`、附件选择/工件面板、预览 IPC、`artifact.refresh` 真正实现与 `artifact.updated` 广播、渲染层 `applyEvent` 补 `artifact.updated` case。
- **门禁保持不变**：`verify:all` **578**、`skills` **149**、`multitask` **174**、`migration` **44**、Electron **26**、`artifacts` **219**；新增测试只加不改旧断言。

---

## 7. 证据

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p3a-verify-all.txt` | 578 PASS / 0 FAIL，exit=0（18:15:43） | `36d7608605aff9f7c75beb26d56c6b47218a06458cb346a59f71471e237733e3` |
| `evidence/p3a-skills.txt` | 149/149，exit=0（18:16:02） | `b953c495f19218b9c534b06f98692489d3f8d28034ab8d7314cac965eb4cff02` |
| `evidence/p3a-multitask.txt` | 174/174，exit=0（18:16:15） | `fe6158c71e7c6c2d74382563e42fc6221e4efe0483638cee95773a3ee30bc87e` |
| `evidence/p3a-migration.txt` | 44/44，exit=0（18:16:03） | `a2bc85c409174073a462bf15735f75c343d5bcd31bda452c67624a907cb1ff12` |
| `evidence/p3a-artifacts.txt` | 219/219，exit=0（18:16:32） | `a91e86efdf4a62d2c1f761b791e9bf3faef3d6cecfc2ea5d0142af2b8b86afaf` |
| `evidence/p3a-artifacts-red.txt` | 52/136，85 行 FAIL（84 计分 + A 组崩溃），exit=1（桩，18:08:53） | `152318c4f0e9c1ba1f98ac4789877fe3d51925d43b34f195e72c407d434cbae8` |
| `evidence/p3a-electron-verify.txt` | 26/26，exit=0（18:16:18） | `33f93fa780703c95db9930ba5ac9245c62c6ad175bbb003f483a8b035b6b3eac` |

`.probe/backup-wp1/board.db`：348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`（未变）。
