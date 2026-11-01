# P7-C · 可移植 workDir/skillDir + 打包态验证

> 状态：**P7-C 完成**。workDir 不再依赖 `D:/agent/xuanwo/work`；skillDir 五级解析已验证；config 无盘符硬编码；dir 包 `--verify` **26/26**。
> 日期：2026-10-25。**不重打包 NSIS**；不启动真实 agent。

## 做了什么

### 1. workDir 可移植

- `config/loader.ts` 新增 `resolveWorkDir()`：
  1. `BUMIMANG_WORK_DIR`（新）
  2. `BUMIMANG_WORKDIR`（旧，兼容）
  3. `config.workDir`（相对配置文件目录）
  4. 开发态 `<repo>/work`
  5. 打包态 `<documents>/bumimang/work`（`app.getPath("documents")`）
- `main.ts` 用 `resolveWorkDir()`；启动日志打印实际 workDir；`--verify` 打包态仍用临时沙箱。
- `config/app.json` 删除 `workDir: "D:/agent/xuanwo/work"`；不写盘符/用户目录。
- `main.ts` 新增 `warnLegacyWorkRoot()`：旧路径（默认 `<repo>/work`，可用 `BUMIMANG_LEGACY_WORKDIR` 指定）存在且新目录为空时 stderr 提示；**不自动迁移**。

### 2. skillDir 五级解析

- 现有 `skill/index.ts` 已按 `BUMIMANG_SKILL_DIR → config.skillDir → 开发态 <repo>/../skill → 打包态 resources/app-source/skill → configured=false` 解析；P7-C 用 C 组测试逐级验证（未改解析逻辑）。
- `config/app.json` 删除 `skillDir: "D:/agent/skill"`；开发态仍走 `<repo>/../skill`（本机 `D:/agent/skill`），打包态默认 `resources/app-source/skill`。
- **skill 外置**：electron-builder 未打包 skill；打包态需 `BUMIMANG_SKILL_DIR` 或 config.skillDir，否则 configured=false（不假装有技能）。

### 3. 打包配置

- `package.json build.files` 排除：
  - `apps/desktop/src/cli/**`、`renderer/smoke.ts`
  - `benchmarks/**`、`evidence/**`、`docs/**`、`.probe/**`
  - `**/benchmarks/**`、`**/test/**`、`**/tests/**`、`**/__tests__/**`、`**/*.test.*`
- asar 不含项目 test/verify/bench/evidence/docs；`apps/desktop/src/main/evidence`（产品代码 replay.ts）保留。
- 只跑 `npm run pack:dir` + `dist/win-unpacked/不迷茫.exe --verify`；**未重打 NSIS 安装包**。

## 改了哪些文件

| 文件 | 变更 |
|---|---|
| `apps/desktop/src/main/config/loader.ts` | `resolveWorkDir` |
| `apps/desktop/src/main/electron/main.ts` | 使用 resolveWorkDir、旧路径提示、日志 |
| `config/app.json` | 删除 workDir/skillDir 硬编码 |
| `package.json` | asar 排除测试/文档/证据 |
| `apps/desktop/src/cli/verify-reliability.ts` | C 组 15 条 |
| `docs/done/P7-C.md`、`docs/PROGRESS.md` | 文档 |

**未改**：hub/board/acp/session/mcp-host/renderer 产品逻辑、electron-builder 应用名/图标/签名、NSIS、rules/benchmarks.example、skill 解析逻辑。

## 怎么验证的

### C 组（A+B+C = 45/45）

```text
npm run verify:reliability → 45/45 PASS
C1 workDir：新 env / 旧 env / config / 开发态 / 打包态 documents
C2 skillDir：env / env 缺失报错 / config / dev / packaged resources / 全缺省
C3 config/app.json 无盘符硬编码
C4 asar 排除 cli/bench/evidence/docs；skill 外置
```

### 门禁

| 门禁 | 结果 |
|---|---|
| `verify:all` | **712/0** |
| `verify:scope` | **354/354** |
| `verify:flags` | **214/214** |
| `verify:migration` | **127/127** |
| `verify:artifacts` | **324/324** |
| `verify:skills` | **149/149** |
| `verify:multitask` | **173/174**（已知 F 组“焦点取最新任务”同毫秒 flaky；rerun 仍 173，非本步路径回归；P7-C 出口不依赖该项） |
| `verify:reliability` A+B+C | **45/45** |
| electron `--verify`（dev） | **26/26** |
| `pack:dir` | exit 0 |
| 打包态 `--verify` | **26/26** |
| asar | 3,029 entries；项目 cli/smoke/bench/evidence/docs 0；无 test/tests/benchmarks 目录 |
| `config/app.json` | 无 `D:\`/`D:/` |

## 行为变更

- workDir 默认：开发态 `<repo>/work`；打包态 `<documents>/bumimang/work`；env/config 可覆盖。
- 旧 workDir 存在且新目录为空时提示用户，**不自动迁移**。
- skillDir 五级解析；打包态不再依赖 `D:\`；未配置时 configured=false。
- config/app.json 不再含盘符/user 目录。
- asar 排除测试/验证/基准/证据/文档。
- 打包 dir 包 `--verify` 全绿；NSIS 仍未验证（B-4）。

## 已知限制

1. **NSIS 安装未验证**（B-4）：只跑 dir 包；未装到干净机器/未验卸载。
2. **干净机器未验证**（B-4）：本机有 Electron/ACP 缓存，不能证明队友开箱可用。
3. skill **外置**：打包态默认无 `resources/app-source/skill`，需 env/config；未打包内置 skill。
4. 打包态 `--verify` 使用临时 workDir（`--verify` 沙箱），没有在打包态实际使用 `<documents>/bumimang/work`；C1 只做单元解析。
5. 旧 workDir 只 stderr 提示，无 UI 弹窗/自动迁移；用户需手动复制或设 `BUMIMANG_WORK_DIR`。
6. `BUMIMANG_WORKDIR` 仅兼容旧名；新文档使用 `BUMIMANG_WORK_DIR`。
7. `verify:multitask` 173/174（已知 F 组 flaky）；未在本步修（不属 P7-C）。
8. asar 排除后未做运行时逐模块加载验证（仅打包态 --verify 26/26 + asar 列表）。
9. `config/app.json` 的 `_comment_scope` 仍保留；无盘符。
10. skill 解析逻辑未改；C 组用注入 exists 验证五级，未真实扫描打包 resources。
11. 未重打 NSIS/未验证安装器载荷后运行。
12. 未做 P7-D 收口/全量最终证据。

## 代码/产物 hash

| 文件 | sha256 |
|---|---|
| `config/loader.ts` | `18d14a7d…819d42f7` |
| `main.ts` | `fe23c164…aa35787f` |
| `config/app.json` | `4d18f057…136ebf10` |
| `package.json` | `d04f5721…de54a9c` |
| `verify-reliability.ts` | `e759aac2…7a2641c4` |
| `skill/index.ts`（未改） | `c5309ff3…a34abc3` |
| `dist/win-unpacked/resources/app.asar` | `2ac01614215e270b2c55d1b236f740391c403d0499ca2534f55ce0055156b0c1`（15,680,835B） |

## 证据

- `evidence/p7c-verify-reliability.txt` `276dc085…69a88803`（45/45）
- `evidence/p7c-verify-all.txt` `0e4fbab0…0ca805b`
- `evidence/p7c-verify-scope.txt` `a6b940fa…4c3e9320`
- `evidence/p7c-verify-flags.txt` `6b13c165…3dfc85c1`
- `evidence/p7c-verify-migration.txt` `3ace1464…d57e3d`
- `evidence/p7c-verify-artifacts.txt` `9a8a3f02…c7f2d8`
- `evidence/p7c-verify-skills.txt` `a310ed95…f6ae4b2`
- `evidence/p7c-electron-verify.txt` `85ed3e09…bfe849bb`
- `evidence/p7c-pack-dir-final.txt` `209bd8f6…ec6a29d0`
- `evidence/p7c-packaged-verify-final.txt` `9c1eba51…57362f6`
- `evidence/p7c-asar-list-final.txt` `e1169d7b…2b42d1080`

## 下一手需要什么

- P7-D：只写 WP7 收口文档 + 最后全量；更新 B-4 为“dir 包验证通过；NSIS 未验证”。
- 继续基线：verify:all 712/0、scope 354/354、flags 214/214、migration 127/127、artifacts 324/324、skills 149/149、reliability 45/45、electron 26/26；multitask 173/174 已知 flaky。
- P7-D 不需要重打包；保留 dir 包证据。
