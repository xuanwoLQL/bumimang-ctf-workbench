# P7-A · 启动备份 + 迁移失败回滚 + 哈希链断裂检测

> 状态：**P7-A 完成**。范围：启动前备份 board.db + WAL/SHM、迁移失败自动恢复、events 哈希链断裂告警；**不改 v1/v2/v3 迁移逻辑本身**。
> 日期：2026-10-25。不启动真实 agent、不碰真实 `.probe/backup-wp1/board.db`。

## 做了什么

1. **新增 `apps/desktop/src/main/reliability/backup.ts`**
   - `backupBeforeOpen(dbPath)`：复制 `board.db` + `-wal` + `-shm` 到 `%APPDATA%/bumimang/backups/<ts>-<rand>/`；返回备份目录；db 不存在返回 null；滚动保留最近 5 份。
   - `restoreFromBackup(backupPath, dbPath)`：迁移失败时恢复；先移除目标 `-wal/-shm`，再复制备份文件。
   - `listBackups()`：按 mtime 新→旧列出；`defaultBackupRoot()` 支持 `BUMIMANG_BACKUP_DIR` 覆盖（测试用）。
2. **`board.ts` open 包装**
   - 新增公开 `Blackboard.open(dbPath, { backup? })`：打开前备份；内部 `openRaw()` 保留原 v1/v2/v3 迁移逻辑；迁移/打开失败时关闭句柄、恢复备份、抛出可读错误（不静默重置）。
   - 临时目录默认不备份（避免 verify 套件写满 `%APPDATA%`）；显式 `backup:true` 强制；生产 main 传 `{ backup: !VERIFY }`。
   - 新增 `checkEventChain(db)` 与 `getHealthChain()`：按 `prev_hash` 连续性检测首个断点；断裂只写 stderr 告警，不截断/不改链。
3. **`events.ts`**：`HubSnapshot.healthChain?: { ok: boolean; brokenAt?: number }`（可选；旧快照/旧 mock 不带不炸）。
4. **`main.ts`**：
   - board.open 失败时 stderr + `dialog.showErrorBox`（`--verify` 不弹窗）+ `app.exit(1)`；不静默重置。
   - 快照 IPC 附带 `healthChain: board.getHealthChain()`。
5. **`verify-reliability.ts`（A 组）**：备份一致性/迁移失败恢复/滚动 5 份/断链检测/不截断；**15 条**。
6. **`package.json`**：`verify:reliability`（不并入 verify:all）。

## 改了哪些文件

| 文件 | 变更 |
|---|---|
| `apps/desktop/src/main/reliability/backup.ts` | 新增 |
| `apps/desktop/src/main/blackboard/board.ts` | open 包装、backup/restore、healthChain |
| `apps/desktop/src/main/electron/main.ts` | 启动失败提示、快照 healthChain |
| `packages/shared-protocol/events.ts` | 可选 healthChain |
| `apps/desktop/src/cli/verify-reliability.ts` | 新增 A 组 |
| `package.json` | verify:reliability |
| `docs/done/P7-A.md`、`docs/PROGRESS.md` | 文档 |

**未改**：v1/v2/v3 迁移 SQL、acp/client.ts、session/manager.ts、config/loader.ts、renderer/**、其他 verify/smoke/mock、config/rules/benchmarks、electron-builder。

## 怎么验证的

### 红测

```text
node --experimental-strip-types apps/desktop/src/cli/verify-reliability.ts
→ ERR_MODULE_NOT_FOUND: reliability/backup.ts
evidence/p7a-red.txt
```

### 绿测

```text
npm run verify:reliability
→ 15/15 PASS
- A1 备份存在 + 内容 sha256 一致 + listBackups
- A2 破坏 v3 迁移 → 自动恢复 → tasks/events 不丢
- A3 7 次备份 → 只保留最近 5 份，最新在、最旧清
- A4 改 events.prev_hash → brokenAt=首个断点，事件数不变，不截断
evidence/p7a-verify-reliability.txt
```

### 门禁

| 门禁 | 结果 |
|---|---|
| `verify:all` | **711/0** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:reliability` A | **15/15** |
| electron `--verify` | **26/26** |
| `.probe/backup-wp1/board.db` | `6d491f0b…ab5cf469`（未变） |

## 行为变更

- 启动打开已有 board.db 前，备份 db + WAL/SHM 到 `%APPDATA%/bumimang/backups/`，滚动保留 5 份。
- 迁移失败自动恢复启动前备份，抛可读错误；主进程弹错误并退出，**不静默重置**。
- events 链 `prev_hash` 不连续时告警，并在快照带可选 `healthChain`；不自动截断。
- 旧快照没有 `healthChain` 不炸；旧迁移逻辑 SQL 未改。
- 临时目录默认不备份（测试便利）；生产 main 显式 `backup: !VERIFY`。

## 没做什么 / 已知限制

- 备份用文件复制（db/wal/shm 三件套），不是 SQLite Online Backup API；依赖单实例/无并发写（当前架构主进程唯一写者）。
- 未测量大库（>100MB）备份耗时；A1 只验证小库一致性与滚动。要求“<1s”未做基准。
- 哈希链只校验 `prev_hash` 连续性，不重算历史 hash（旧格式兼容）；链尾截断/整链重算不在检测范围。
- 断链只告警 + 快照字段，未做 UI 展示/只读模式；主进程启动失败是弹窗后退出。
- 迁移失败恢复的是“打开前备份”，如果备份本身损坏，会抛“恢复失败”；不尝试多份回退。
- 备份目录默认 `%APPDATA%/bumimang/backups`；未做用户可配置 UI（`BUMIMANG_BACKUP_DIR` 仅 env）。
- 未做进程清理（P7-B）、MCP 崩溃 UI（P7-B）、workDir/skillDir 可移植（P7-C）、打包态（P7-C）。
- 临时目录默认跳过备份，与生产路径行为不同；已在代码/文档注明。

## 代码 hash

| 文件 | sha256 |
|---|---|
| `board.ts` | `88363dcd1750e81d63aa649850da87330a13c1ff92f6b19c57e8a059b4561583` |
| `backup.ts` | `857031a868fe8a7f0769546d98aae3b1d75c2e61eb9d777b55b1ae877555a95f` |
| `main.ts` | `183bbb2d9e166587d7f7af5bb5080b6108139f379bdb0594c120b7b4f3c1d522` |
| `events.ts` | `8f33dee749e27e8a143b3a667feb590c97aa905d616d3f998d715925eea9121a` |
| `verify-reliability.ts` | `be5f8c102693927fc0d79f57dd750ee44a582a202465e43eb2076209cc01559e` |
| `package.json` | `260b1096a05495b154c41472037d3a4b1b36cd912260756182a735e9207fc5b9` |
| `acp/client.ts`（未改） | `9f61931a…ae3f0bd` |
| `session/manager.ts`（未改） | `fb0fda7c…ac1e377` |
| `config/loader.ts`（未改） | `fe318019…d31209` |
| `renderer/main.ts`（未改） | `67ddca91…3fe73f` |

## 证据

- `evidence/p7a-red.txt` `14eca675…c647eac`
- `evidence/p7a-verify-reliability.txt` `f0540917…d9eda343`
- `evidence/p7a-verify-all.txt` `d01e1597…b0a059`
- `evidence/p7a-verify-scope.txt` `c4cda557…232f99`
- `evidence/p7a-verify-flags.txt` `b0a076ef…f7dad43`
- `evidence/p7a-verify-migration.txt` `4079e161…0503e3c`
- `evidence/p7a-electron-verify.txt` `0cb9a8f7…501f80`

## 下一手需要什么

- P7-B：进程清理（PID+启动时间）+ MCP 崩溃 UI；不改 P7-A 的 A 组断言。
- P7-A 生成的备份默认在 `%APPDATA%/bumimang/backups`；P7-B 不要清理该目录。
- 继续基线：verify:all 711/0、scope 354/354、flags 214/214、migration 127/127、reliability A 15/15、electron 26/26。
