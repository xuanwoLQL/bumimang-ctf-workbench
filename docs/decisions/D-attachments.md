# D-attachments · 附件导入、ZIP 边界与只读预览

- 日期：2026-10-23
- 状态：P3-A 已实施；P3-B/P3-C 只复用；P3-D 补写本决策（未改代码）
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` §6 WP3；`docs/plans/COMPETITION-READINESS.md` §6.2/§6.3/§6.5/§6.6；`docs/done/P3-A.md`、`P3-B.md`、`P3-C.md`
- 实现：`apps/desktop/src/main/artifacts/import.ts`、`zip.ts`、`preview.ts`、`scan.ts`；Hub/IPC 接线见 P3-A/P3-C

## 背景

WP3 要让题面/附件进入任务，同时不把「打开附件」变成「执行附件」。附件来自用户本机或比赛题包，可能是恶意 ZIP、越界路径、超大文件、可执行文件或 HTML/SVG。预览必须让人看见内容，但不能渲染 HTML、不能执行脚本、不能把可执行文件交给系统打开。

本决策把 P3-A 已经落地的附件存储、ZIP 解析、预览和限额固化，避免后续 WP5/WP6/WP7 重新打开这些边界。

## 决策

### 1. 存储布局与 `attachments.json`

每个任务一个独立目录：

```text
<workRoot>/<taskId>/
  attachments/
    attachments.json
    <name> / <dir>...
  artifacts/          # agent/人产生的工件；P3-C 只读扫描
  evidence/           # 证据文件约定；P3-B 判定
```

`attachments.json`（`version: 1`）：

```json
{
  "version": 1,
  "taskId": "task-...",
  "files": [
    {
      "name": "flag.txt",
      "relativePath": "flag.txt",
      "size": 123,
      "sha256": "…",
      "type": "text/plain",
      "source": "upload",
      "importedAt": 1792723905606
    }
  ]
}
```

约定：

1. `relativePath` 是 **attachments 目录相对路径**，一律 POSIX `/`；禁止 `..`、绝对路径、盘符、NUL、Windows 保留名/非法字符。预览时调用方再加 `attachments/` 前缀，得到任务目录相对路径。
2. `files` 按 `relativePath` 排序；`importedAt` 是一次导入的统一时间戳；`source` 当前固定 `upload`。
3. 清单最后写：临时文件 + `rename`，避免读到半截 JSON；导入失败清理临时目录和本次已 rename 的产物，不改旧清单。
4. 读清单是安全的：缺失/损坏/版本不符返回 `[]`；只暴露 `relativePath` 能通过 `normalizeRelativePath` 的条目。导入时如果旧清单存在但结构非法，拒绝覆盖（不把坏清单“修”成空）。
5. 附件本体在磁盘，不进 SQLite；`board.ts` 没有附件列，`user_version` 仍为 **v1**。快照按焦点任务读清单，`TaskView.attachmentCount` 给所有任务，完整 `attachments` 只给焦点任务。

### 2. 导入范围与限额

1. 一次导入只允许一种来源类型：文件 / 文件夹 / ZIP；最多 **100 个路径**。
2. 单任务（已有 + 本次）上限 **200MB / 1000 个文件**；超限返回可读错误，**不部分写入**。
3. 文件 → `attachments/<文件名>`；文件夹 → `attachments/<文件夹名>/...`；ZIP → `attachments/<zip 名去掉 .zip>/...`。
4. 导入前做完整预检（路径/类型/大小/数量/重名/清单合法性），再写 staging；ZIP 先解压到 `attachments/.import-<ts>-<rand>/`，全部校验通过后才逐个原子 rename。
5. ZIP 压缩数据也计入大小限额，避免“压缩数据巨大、解压后很小”的流式读取消耗。
6. 导入是进程内、按任务加锁；跨进程并发写同一任务不在本轮范围。

### 3. ZIP 支持范围

只支持 **store（method 0）/ deflate（method 8）**。以下一律拒绝，且不写出文件：

- 加密条目（GPB bit0/bit6/bit13）；
- ZIP64（EOCD/中央目录/本地头任一迹象）；
- 多卷 / 分卷；
- 未知压缩方法、patched-data；
- 损坏的中央目录/本地头、CRC 不匹配、重复名、文件/目录冲突；
- `../`、绝对路径、盘符、反斜杠逃逸、NUL；
- symlink、Windows reparse point、设备/FIFO/socket 等特殊 mode。

关于 hardlink：**ZIP 没有标准 hardlink 条目**。本实现从不调用 `link()`，所有条目都按普通文件写出，因此不会创建硬链接；这里的“拒绝 hardlink”落地为“不会创建链接 + 拒绝 symlink/特殊 mode”，不是识别某个 hardlink 标志位。

ZIP 文件名统一按 UTF-8 解码；CP437 非 ASCII 文件名可能出现替换字符（路径仍受校验，不会逃逸）。需要完整 CP437 支持时再单独加。

### 4. 预览安全

预览是**只读**函数 `previewAttachment({ taskDir, relativePath })`：

1. 路径先做语法拒绝（空、`..`、绝对路径、盘符、NUL、非法段、保留名、超长），再 `realpath` + 逐段 `lstat`；任何 symlink/junction 都拒绝，realpath 必须仍在任务目录内。
2. 文本：UTF-8，最多 **256KB**；超出截断并标记。
3. 图片：PNG/JPEG/GIF/WebP/BMP，先看大小（最多 **2MB**）再看魔数；返回 `data:image/<bitmap>;base64,...`。假 PNG、超大图不按图片渲染；不生成部分 data URL。
4. 二进制：hex dump，最多 **4KB** 原始字节；可执行文件也只给 hex，不执行。
5. HTML/SVG 只当**文本**返回；渲染层用 `textContent`，绝不 `innerHTML`。图片 data URL 在渲染层再校验一次 MIME，SVG/HTML data URL 一律拒绝。
6. 不 `openPath`、不 `shell.openExternal`、不调用 `isSystemOpenAllowed()`；P3-A 只保留该白名单函数，P3-C 明确没有系统打开/reveal 入口。可执行文件即使在白名单逻辑外也不会被打开。
7. 预览不是 OS 级 jail：realpath + 逐段 lstat 仍有本机用户并发替换路径的 TOCTOU 窗口；Windows 没有 `O_NOFOLLOW`。这是已知边界，WP7 若要更强隔离再评估。

### 5. 不执行任何附件/工件/脚本

1. 附件导入只复制/解压，不执行；ZIP 只在导入阶段解压，工件面板不再次解压。
2. 预览只读；扫描函数只读前 4MB 找 `flag{...}`，不执行。
3. `cmd:` 证据回放是**另一条**默认关闭的能力（见 `D-evidence-replay.md`），不是附件预览的副作用；附件/工件本身永远不会触发命令执行。
4. 工件扫描跳过 `attachments/` 与 `attachments.json`，避免与附件面板重复；工件列表只读，500 文件/深度 6 上限，不跟随 symlink/junction。

### 6. 扫描与候选的边界

`scanAttachmentForFlags()` 对文本附件/证据文件扫 `flag{...}`（大小写不敏感），只返回任务内路径 + 命中串。P3-B 把它接到 `attachment.import` 成功之后，但**只写 `attachment.scan` 审计，不产生 flag 候选、不写事实、不写黑板**。候选持久化/去重/确认属于 WP5。

## 备选方案与取舍

- **允许任意 ZIP 压缩方法**：需要更多解压器/攻击面；否决，只 store/deflate。
- **先解压到最终目录，失败再删**：失败可能留下半套文件/覆盖旧文件；否决，临时目录 + 原子 rename。
- **预览用 `<iframe>`/HTML 渲染**：XSS/脚本执行风险；否决，文本/图片/hex 三态。
- **系统打开安全扩展名**：P3-A 有白名单函数，但 P3-C 明确不做入口；比赛期优先“绝不执行”，不为了便利打开系统关联程序。
- **把附件元数据写 SQLite**：多一套 schema/迁移，且附件本体已在磁盘；本轮不做，`user_version` 保持 v1。
- **扫描命中直接产生 flag 候选**：会抢 WP5 的去重/确认职责，且候选当前只在内存；否决，只写审计。

## 影响

- **加法**：附件存储/清单/预览/扫描都是新模块；`AttachmentView`、`TaskView.attachments?`、`attachmentCount?`、`HubSnapshot.attachments?` 都是可选字段；旧快照/旧渲染层不炸。
- **性能**：导入流式 sha256/复制；快照每次读清单（最多 1000 条/任务），暂无 mtime 缓存；工件扫描 500 文件/深度 6。
- **安全**：ZIP 边界、路径边界、预览 XSS/执行边界、限额和失败清理都有测试；但不是 OS 级隔离。
- **已知边界**：200MB/1000 文件、100 路径、一次一种来源；CP437；hardlink 语义；TOCTOU；导入无字节级进度；无文件 watcher；无系统打开/reveal；`source` 固定 `upload`。

## 后续

- **WP5**：flag 候选持久化/去重/确认；附件扫描命中可在那时决定是否升级为候选，但仍不应自动 solved。
- **WP6**：benchmark 需要统计附件导入耗时/失败率；若要文件 watcher/字节级进度，先更新本决策。
- **WP7**：打包态附件选择/预览、更强路径隔离（OS 级）再评估。
- 若要系统打开/reveal：必须先补安全扩展名白名单的运行时校验、路径 realpath 校验和用户确认；当前明确不做。
