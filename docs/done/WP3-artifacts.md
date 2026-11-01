# WP3 · 题目接入、工件与证据链（P0）总收口

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP3；`docs/plans/COMPETITION-READINESS.md` §6（§6.1 目标 / §6.2 文件清单 / §6.3 数据模型 / §6.4 证据链 / §6.5 测试 / §6.6 风险 / §12 门禁）；`docs/decisions/D-attachments.md`、`D-evidence-replay.md`、`D-artifact-ipc.md`；`docs/done/P3-A.md`、`P3-B.md`、`P3-C.md`
> 日期：2026-10-23
> 状态：**WP3 完成（P3-A → P3-C）**。P3-D 只写文档 + 跑全量，没有改任何 `.ts` / `.css` / `.json` / `.cjs` 代码文件。
> 验收基线：**`verify:all` 607 PASS / 0 FAIL（确定性 391 + smoke 216）；`verify:artifacts` 324/324（A110/B51/C58/D33/E72）；`verify:skills` 149/149；`verify:multitask` 174/174（单跑）；`verify:migration` 44/44；Electron `--verify` 26/26。**
> 验收差距：计划 §6.5 第 1 条的“附件扫描产生 flag 候选”**未实现**（P3-B 只写 `attachment.scan` 审计，候选持久化留 WP5）；计划 §6.2/§6.4 的“简报注入附件清单”**未接**；第 6 条“重启后附件仍可访问”只有磁盘布局/快照逻辑，**没有自动化重启断言**。见“验收差距 / 计划偏差”。

---

## 做了什么

WP3 把「题面进不来、工件不可见、命令回显到不了 E2」补成三段可用链路：

- **P3-A 附件接入**：`attachment.import` 支持文件/文件夹/ZIP；手写 ZIP 解析（store/deflate）拒绝 zip-slip/绝对路径/盘符/symlink/加密/ZIP64/多卷/坏 CRC；写 `attachments.json`；`previewAttachment()` 提供文本/图片/hex 只读预览；`scanAttachmentForFlags()` 只返回路径+命中串。`board.ts` 仍 v1，附件元数据在磁盘。
- **P3-B 证据链**：`inferEvidence` 的 E2 从“文件含 flag”扩到“文件含 flag **或**提交的事实文本”；附件导入后扫描命中只写审计，不产生候选；新增默认关闭的 `cmd:` 回放（`BUMIMANG_EVIDENCE_REPLAY=1` 才开；无 shell、cwd=任务 workdir、30s/1MB、策略 `evidence/replay`、approve 进审批、审计脱敏、失败降级 E1）。
- **P3-C 工件与 UI**：创建任务弹窗支持文件/文件夹/ZIP（任务先建、附件后导入，失败不回滚）；任务看板附件数量/焦点任务卡附件摘要；右栏工件面板列附件+产物；文本/hex 用 `textContent`、图片只接受位图 data URL、HTML/SVG 只当文本；`artifact.refresh` 真实现并广播 `artifact.updated`；新增只读 `previewArtifact` IPC 和 `pickAttachments` 选择器。
- **P3-D 收口**：本文件 + `D-attachments.md` + `D-artifact-ipc.md` + `PROGRESS` + 六份 `wp3-final-*` 证据；不改代码。

**关键取舍**

- 附件本体和 `attachments.json` 在磁盘，不进 SQLite；`board.ts` 保持 v1，避免和 WP4 targets/WP5 flag 表抢版本号。
- ZIP 只支持 store/deflate，先临时目录再原子 rename；失败不部分写入。
- 预览只做文本/图片/hex 三态，不渲染 HTML/SVG，不 `openPath` 可执行；系统打开/reveal 本轮不做。
- `cmd:` 回放默认关，且不是附件预览的副作用；附件/工件永远不会被执行。
- 工件扫描只读、500 文件/深度 6、不跟随 symlink/junction；没有文件 watcher，刷新靠手动动作。
- 附件扫描只写审计，不产生 flag 候选；候选持久化/去重/确认留给 WP5，避免抢职责。

---

## WP3 目标与验收对照

### 1. 计划 §6.5 测试计划 7 条

| # | 计划要求 | 覆盖位置 | 结果 | 说明 / 证据 |
|---|---|---|---|---|
| 1 | 上传含 `flag.txt` 的 zip：解压、`attachments.json`、预览、flag 候选（source=artifact path）正确 | `verify:artifacts` A/B/C + D 扫描审计 | **部分 PASS** | ZIP 解压、manifest、预览、扫描命中审计都 PASS（`A：导入 store zip`、`A：manifest 字段完整`、`C：预览附件文本`、`D：附件扫描命中写一条审计`）。**未产生 flag 候选**：P3-B 明确只写 `attachment.scan` 审计，候选持久化/去重/确认留 WP5。 |
| 2 | 恶意 zip：`../evil`、绝对路径、盘符、symlink、加密/ZIP64 被拒且无文件写出；清理临时目录 | `verify:artifacts` B 组 51 条 | **PASS** | `B：拒绝 ../ 逃逸`、`B：拒绝绝对路径`、`B：拒绝盘符`、`B：拒绝 symlink`、`B：拒绝加密`、`B：拒绝 ZIP64`、`B：拒绝坏 CRC`；失败后目录/manifest 不变。 |
| 3 | 文本/图片/二进制预览正常；超大文件截断并提示；不执行 | `verify:artifacts` C 组 58 条 | **PASS** | 文本 256KB、图片 2MB、hex 4KB；HTML/SVG 只当文本；可执行文件只给 hex；`C：预览只读`。 |
| 4 | `evidence/out.txt` 含 flag，`submit_fact` 带相对 witness → E2；不带 witness → E0；witness 指向目录外 → E1/拒绝；事实文本匹配 → E2 | `verify:artifacts` D 组 33 条 | **PASS** | 旧 16 条 E0/E1/E2 断言全绿；新增事实文本 2 条、扫描审计 2 条；D 红 248/252→绿 252/252。 |
| 5 | 回放默认关闭；开启后命中/超时/非零退出行为确定且审计；失败降级 E1；非白名单/策略 block 拒绝 | `verify:artifacts` E 组 72 条 | **PASS（带边界）** | 默认关、开启命中 E2、超时/非零/block/denied → E1、审计脱敏、stdout/stderr 截断都覆盖；**没有独立命令白名单**，依赖默认关+策略 `evidence/replay`+审批+审计（见已知限制 3）。 |
| 6 | 附件目录在任务切换/重启后仍可访问；A 任务附件不出现在 B；归档后仍可查 | `verify:artifacts` A 组跨任务/归档断言 | **部分 PASS** | 任务切换、跨任务隔离、归档后仍可查均 PASS；**进程重启后的附件访问没有自动化断言**（只由磁盘布局 + `readAttachments()` 快照读保证）。 |
| 7 | 预览路径越界/symlink 逃逸拒绝；可执行文件不提供“系统打开” | `verify:artifacts` C 组 | **PASS** | `C：拒绝 ../`、`C：拒绝越界 junction`、`C：拒绝任务内 junction`、`C：exe 不允许系统打开`；可执行只给 hex。 |

**小计：5 条完整 PASS、2 条部分 PASS（第 1 条候选留 WP5、第 6 条重启未自动化）。**

### 2. 计划 §6.3 目录 / `attachments.json` / 限制

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| `<workRoot>/<taskId>/attachments/`、`artifacts/`、`evidence/` | **PASS** | 任务目录隔离；`attachments/` 与 `attachments.json` 被工件扫描跳过，避免重复。 |
| `attachments.json` `version/taskId/files` + name/relativePath/size/sha256/type/source/importedAt | **PASS** | `version:1`；`relativePath` POSIX；清单最后原子写；损坏/缺失读为 `[]`；坏清单导入时拒绝覆盖。 |
| 单任务 200MB / 1000 文件 | **PASS** | `ATTACHMENT_LIMITS`；已有+本次合计；超限可读错误、不部分写入。 |
| ZIP 只 store/deflate；拒绝加密/ZIP64/multi-disk/symlink/`../`/绝对/盘符/NUL | **PASS** | 见 `D-attachments.md`；hardlink 语义是“从不调用 `link()`”，不是识别标志位。 |
| 不自动执行任何附件/工件/脚本；预览只文本/图片/hex | **PASS** | 预览只读；无 `openPath`/`shell.openExternal`；ZIP 只在导入阶段解压。 |
| 系统打开只允许安全扩展名（计划 §6.2/§6.3） | **未实现（有意）** | `isSystemOpenAllowed()` 只是 P3-A 的白名单函数；P3-C 明确不做系统打开/reveal 入口。 |

### 3. 计划 §6.4 证据链

| 要求 | 状态 | 实现 / 说明 |
|---|---|---|
| E2：witness 文件 realpath 在任务 workdir 内，且含提交 flag **或**事实文本 | **PASS** | `inferEvidence` 扩展；事实按包含匹配，空/空白退回 E1；旧 16 条语义断言全绿。 |
| E1：真实文件但内容不匹配 / 独立会话见证 / `cmd:` 失败或超时 | **PASS** | P3-B D/E 组覆盖；失败只降级，不崩。 |
| E0：只有自述 | **PASS** | 无 witness → E0；旧行为保留。 |
| `cmd:` 回放默认关；`BUMIMANG_EVIDENCE_REPLAY=1` 才开；spawn 无 shell、30s、cwd=任务目录、stdout/stderr 各 1MB、策略、审计 | **PASS** | `EvidenceReplayer`；`config/loader.ts` 只认 `=1`；`evidence.replay` 审计脱敏；approve 进审批；失败 E1。 |
| `witness` 支持 `{path?, sessionId?, artifactId?, cmd?}` 对象（字符串兼容） | **未实现（计划偏差）** | 实际 witness 仍是**字符串**：任务相对路径或 `cmd:` 前缀；没有对象形态、没有 `artifactId`。P3-B 沿用旧字符串协议，不破契约；若 WP4/WP5 需要对象 witness，先写请求/决策。 |
| 简报明确要求命令回显写 `evidence/<name>.txt`，witness 用相对路径；附件清单写明路径 | **部分 PASS** | `evidence_convention` 文案已更新（E2=flag 或事实文本；witness 相对路径；禁止 `..`）；**附件清单没有注入简报**（`briefing/build.ts`/`SessionManager` 未改）。见验收差距。 |

---

## P3-A / P3-B / P3-C 每步摘要与证据

| 步骤 | 一行摘要 | 关键数字 | Evidence |
|---|---|---|---|
| **P3-A** | 附件导入 + ZIP 解析 + 预览 + `attachments.json` + 契约可选增量；`artifact.refresh`/`artifact.updated` 只占位 | `verify:artifacts` **219/219**（A110/B51/C58）；`verify:all` 578；skills 149；multitask 174；migration 44；Electron 26；红测 52/136 | `evidence/p3a-verify-all.txt`、`p3a-artifacts.txt`、`p3a-artifacts-red.txt`、`p3a-skills.txt`、`p3a-multitask.txt`、`p3a-migration.txt`、`p3a-electron-verify.txt` |
| **P3-B** | E2 扩事实文本 + 附件扫描审计 + `cmd:` 回放（默认关）；简报 `evidence_convention` 文案更新 | `verify:artifacts` 219→**324/324**（+D33/E72）；D 红 248/252→绿 252/252；E 红（桩）286/324→绿 324/324；`verify:all` 578；skills 149；multitask 174；migration 44；Electron 26 | `evidence/p3b-verify-all.txt`、`p3b-artifacts.txt`、`p3b-d-red.txt`、`p3b-d-green.txt`、`p3b-e-red.txt`、`p3b-e-green.txt`、`p3b-skills.txt`、`p3b-multitask.txt`、`p3b-migration.txt`、`p3b-electron-verify.txt` |
| **P3-C** | 渲染层附件选择/工件面板/只读预览 + 最小 Lane A（`artifact.refresh` 真实现、`artifact.updated` 广播、preview/pick IPC） | smoke **187→216（+29）**；`verify:all` **607**（391+216）；artifacts 324；skills 149；multitask 174；migration 44；Electron 26；后端 23/23；IPC 4/4 | `evidence/p3c-verify-all.txt`、`p3c-artifacts.txt`、`p3c-skills.txt`、`p3c-multitask.txt`、`p3c-migration.txt`、`p3c-electron-verify.txt`、`p3c-smoke-red.txt`、`p3c-smoke.txt`、`p3c-artifact-backend.txt`、`p3c-ipc-verify.txt` |
| **P3-D** | WP3 总收口：本文件 + `D-attachments.md` + `D-artifact-ipc.md` + PROGRESS + 六份最终证据；不改代码 | **607 / 324 / 149 / 174 / 44 / 26** | `evidence/wp3-final-verify-all.txt`、`wp3-final-artifacts.txt`、`wp3-final-skills.txt`、`wp3-final-multitask.txt`、`wp3-final-migration.txt`、`wp3-final-electron-verify.txt` |

---

## 行为变更汇总

> 与 WP1 的四个行为变更、WP2 的加法变更并列。每条写清“改了哪条 / 为什么 / 影响 / 旧测试怎么处理”。

### 1. P3-A 契约新增（全部可选/加法）

- **改了哪条**：新增 `AttachmentView`；`TaskView.attachments?` / `attachmentCount?`；`HubSnapshot.attachments?`；`HubAction.attachment.import` / `artifact.refresh`；`HubEvent.artifact.updated`（P3-A 只加类型，不广播）。
- **为什么**：让附件能进任务、快照能带清单、后续动作/事件有契约占位；不一次加太多必填字段。
- **影响**：旧快照/旧渲染层只读原字段仍然工作；附件本体在磁盘，`board.ts` 不加列、`user_version` 仍 v1。
- **旧测试**：`verify:all` 仍 578；新增独立 `verify:artifacts` 219；旧断言零删除零改语义。

### 2. P3-B 批次 1：E2 扩展 + 附件扫描审计 + 简报文案

- **改了哪条**：E2 从“文件含 flag”扩到“文件含 flag **或**提交的事实文本”；`attachment.import` 成功后扫描本次新增附件，命中写 `attachment.scan` 审计；`evidence_convention` 文案更新。
- **为什么**：命令回显/事实文本不一定含 `flag{...}`；让人知道附件里已有 flag，同时不抢 WP5 的候选职责。
- **影响历史证据**：无；`inferEvidence` 只在 `submit_fact` 时执行，已落库 E0/E1/E2 不重判；扫描不产生候选/事实/黑板事件，只多审计行。
- **旧测试**：纯加法；D 组 16 条旧 E0/E1/E2 语义断言全绿，A/B/C 219 条未改；新增 4 条红全部是新增语义。

### 3. P3-B 批次 2：`cmd:` 回放（默认关）

- **改了哪条**：旧 `cmd:` witness 被当路径解析（不存在→E1）；新代码识别 `cmd:` 前缀，开启时执行回放，成功且 stdout 命中→E2；关闭/未配置→E1。新增 `config/loader.ts` 的 `evidenceReplay`、`EvidenceReplayer`、策略 `evidence/replay`、审批、审计脱敏。
- **为什么**：让“只在终端里看到、没落盘”的证据也能到 E2；默认关保证不扩大执行面。
- **影响历史证据**：无；只影响新提交；已落库事实不重判。默认关时判级与旧行为一致（E1），但多一条 `evidence.replay` 审计（`status=disabled`）。
- **旧测试**：纯加法；E 组新增 72 条；默认关 7 条全绿；E 红测用“未实现桩”286/324，绿测 324/324。**没有独立命令白名单**，见已知限制 3。

### 4. P3-C：`artifact.refresh` 真实现 + 广播 + 预览/选择器 IPC + 渲染层

- **改了哪条**：`artifact.refresh` 从占位 `{ok:false,error:"artifact.refresh 将在 P3-C 实现…"}` 变为扫描任务目录、返回 `{ok:true,message:"已刷新 N 个工件"}` 并广播 `artifact.updated`；新增 `previewArtifact` 只读 IPC、`pickAttachments` 选择器；渲染层新增附件选择/工件面板/文本/图片/hex 预览；`artifact.updated` 在 store 折叠（只更新焦点）。
- **为什么**：P3-C 验收要求真实附件选择、产物列表、预览、刷新；渲染层不能直接扫 workdir/读文件。
- **影响**：旧 preload/mock 不实现可选方法时 UI 降级；旧快照/旧 mock 缺 `attachments`/`artifacts` 按空；没有系统打开/执行。
- **旧测试**：`verify-artifacts` A 组 **1 条**占位断言更新为“刷新成功并带工件数”，总数仍 **324**，其余 323 条未改；`smoke.ts` 旧 187 条零删除零改语义，新增 29 条 → 216。

### 5. P3-C 最小 Lane A 扩展（已获用户授权）

- **授权**：2026-10-23 P3-C 状态确认阶段，用户通过 `AskUserQuestion` 选择 **「扩到最小 Lane A（推荐）」**；渠道/理由/边界详见 `docs/decisions/D-artifact-ipc.md` 与 `docs/requests/B-to-A-artifact-ipc.md`。
- **扩了哪些文件**：`events.ts`（新增 `ArtifactView`/`ArtifactPreview`/`AttachmentPickKind`/`AttachmentPickResult`、`HubSnapshot.artifacts?`、可选 `HubApi.previewArtifact?`/`pickAttachments?`、两个 IPC 通道）；`hub.ts`（`taskArtifacts`/`previewArtifact`/`artifact.refresh`/广播）；`electron/main.ts`（两个 IPC + dialog）；`preload.cjs`（两个方法）；`validate-action.ts`（**仅注释**）；新增 `artifacts/list.ts`。
- **是否破契约冻结**：否。全是可选/加法；`artifact.updated.artifacts` 从内联对象改为 `ArtifactView[]` 结构兼容；旧 preload/mock 不实现可选方法时 UI 显示“当前后端不支持”，不崩。
- **为什么不能延后到 P3-D**：P3-D 只写文档、不改代码；延后等于 P3-C 交付 mock 假功能。详见 `D-artifact-ipc.md`。

---

## 已知限制清单

> 每条写“现状 / 为什么不修 / 留到哪一步”。P3-D 不改代码。

1. **`board.ts` 仍 `user_version` v1，无附件列**：附件本体 + `attachments.json` 在磁盘，快照按需读；不加列是为了不和 WP4 targets（v2）/WP5 flag（v3）抢版本号。留到 WP4/WP5 统一规划 schema。
2. **`inferEvidence` 的 E2 扩展只影响新提交，历史事实不重判**：调用点只有 `submit_fact`；已落库 E0/E1/E2 不会因新代码重新判级。这是有意的“不追溯改写历史”，避免历史证据在升级后突变；若 WP6 需要重判，单独写迁移/决策。
3. **`cmd:` 回放默认关；开启时仍有执行面**：只认 `BUMIMANG_EVIDENCE_REPLAY=1`；`spawn` 无 shell、cwd=任务 workdir、30s、stdout/stderr 各 1MB、过策略 `evidence/replay`、approve 进审批、审计脱敏、失败 E1。**没有独立命令白名单**；开启且策略 allow 时 argv 可为任意可执行文件，继承主进程权限/环境变量，**不是 OS 级沙箱**。留 WP6/WP7 评估白名单或更强隔离。
4. **附件扫描不产生 flag 候选**：`attachment.import` 命中只写 `attachment.scan` 审计，不产生候选/事实/黑板事件；计划 §6.5 第 1 条的“候选”因此是部分 PASS。候选持久化/去重/确认留 **WP5**，避免抢职责。
5. **没有文件 watcher**：agent 新写产物不会自动出现在工件面板；需要点「刷新工件」或重拉快照。`artifact.updated` 只在 `artifact.refresh` 后广播。留 WP6 评估 watcher；先保持只读/手动，避免后台扫描干扰。
6. **工件扫描上限 500 文件/深度 6**：超出部分不列；跳过 `attachments/`、`attachments.json`、`node_modules/.git/dist/build/target` 等重目录，不跟随 symlink/junction。上限是为了不让异常目录拖慢快照；WP6 若遇到大任务目录再加缓存/增量。
7. **导入无字节级进度，只有「正在导入附件…」**：200MB 上限由 P3-A 预检执行，失败返回可读错误；没有分块进度条。比赛期先保证正确性/不部分写入；WP6/WP7 再做进度。
8. **不提供系统打开/reveal（有意安全边界）**：没有 `openPath`/`shell.openExternal`/`artifact.reveal`/`shell.showItemInFolder`；`systemOpen` 恒 `false`；可执行文件只给 hex。ZIP 只在导入阶段解压，工件面板不再次解压/执行。计划 §6.2 的 `artifact.reveal`/系统打开是**有意偏差**，不是漏做；若要加，先写决策+安全扩展名白名单+用户确认。
9. **`dialog.showOpenDialog` 未做无头自动点击；IPC 4/4 用测试进程注册的同形 handler**：选择器需要真实桌面交互；临时脚本验证的是 `preload → IPC → Hub.previewArtifact` 的通道/序列化/后端校验，`main.ts` 的 `registerIpc` 由 Electron `--verify` 加载覆盖，但自动断言没有调用预览通道。留 WP7 打包态/真实点击。
10. **`verify:multitask` F 组 flaky（既有）**：`board.listTasks()` 是 `ORDER BY created_at DESC`，同毫秒创建的任务没有 tie-break；F 组期望 `cId` 最新，负载下可能取到另一条。P3-C 未改 `board.ts`/`verify-multitask.ts`，不是本轮引入；单跑 174/174。留 **WP6 soak** 用 tie-break（`created_at DESC, id DESC`）或显式 seq 修。
11. **`render-verify.ts` 6 项既有失败（P1-E mock 变更遗留）**：harness 仍按旧 3 会话/4 审批/任务标题 `10.0.0.9` 写，而当前 multiTask mock 是 2 会话/1 审批、焦点“多任务 B · Crypto”；失败项为 8s 等待（要求 ≥3 会话）、任务卡标题、会话数、窗格数、审批卡数、冲突事实。它**不在 `verify:all` 链**，P3-C 未改这些计数；留 **WP6 前**修或明确不修。
12. **`ctf-solver` 根目录主题 `.md`（如 `SSTI.md`）不进 docs 索引**：`skill_search` 不返回它们；routing 给路径提示，`skill_read` 可读。WP2 已知；WP6 评估是否纳入索引。
13. **跨任务批量授权 `permission.grantAll.taskId` 仍未实现**：`scope=session/agent/all` 仍只取焦点任务会话；`taskId` 只是契约透传。WP1 遗留；WP6 评估。
14. **CVE 精确检索差距**：`skill_search("CVE-2021-44228")` 真实库 0 命中；`log4j`/`JNDI`/`Log4Shell` 有命中。原因是指引只索引元数据+头几行，不读 WP 全文。WP2 已知；WP6 评估轻量 CVE 索引/分段回退。
15. **简报轮即开工（WP2 观察，WP6 分开统计）**：真实冒烟中简报本身是“开始解题”型 prompt，agent 在简报轮已调用工具并在 120s 保护阈值内未结束；benchmark 的计时/计量必须把简报轮与显式 prompt 轮分开，soak 也要算简报轮活跃度。

### 验收差距 / 计划偏差（补充）

1. **附件清单未注入简报**：计划 §6.2/§6.4 要求 `briefing/build.ts`/`SessionManager` 把附件清单告诉 agent；实际只更新了 `evidence_convention` 文案，agent 仍不知道附件文件名/路径。原因：P3-B 明确“若要改简报传参先停下问”，本轮未获新授权。留 WP4 前评估；若要接，需先写请求/决策，不能顺手改。
2. **`witness` 仍是字符串协议**：实际只支持任务相对路径和 `cmd:` 前缀；计划 §6.4 的 `{path?, sessionId?, artifactId?, cmd?}` 对象形态未实现，也没有 `artifactId`。原因是沿用旧 `submit_fact` 字符串 witness、不破契约；对象 witness 需要契约/调用点改动，留 WP4/WP5 评估。
3. **计划 §6.5 第 6 条“重启后附件仍可访问”未自动化**：A 组覆盖任务切换/跨任务/归档；进程重启没有断言，只有磁盘布局 + `readAttachments()` 的代码保证。留 WP6/WP7 或补一条迁移/重启测试。
4. **任务创建 UI 的 flag 格式/目标列表未做**：计划 §6.2 的 renderer task 改动包含 flag 格式和目标占位；P3-C 只做附件选择。目标列表属 WP4；flag 格式/闭环属 WP5。
5. **`verify-artifacts` 是 5 组 A–E，不是计划写的 6 组**：P3-A A/B/C + P3-B D/E 合并覆盖 7 条测试；不是少测，是分组合并。

---

## 验收数字

| 项 | 数字 | 证据 |
|---|---|---|
| `npm run verify:all` | **607 PASS / 0 FAIL**（确定性 391 = 52+16+17+19+90+148+49；smoke 216） | `evidence/wp3-final-verify-all.txt` |
| `npm run verify:artifacts` | **324/324**（A110+B51+C58+D33+E72） | `evidence/wp3-final-artifacts.txt` |
| `npm run verify:skills` | **149/149** | `evidence/wp3-final-skills.txt` |
| `npm run verify:multitask` | **174/174**（单跑；并行负载曾有既有 flaky） | `evidence/wp3-final-multitask.txt` |
| `npm run verify:migration` | **44/44** | `evidence/wp3-final-migration.txt` |
| Electron `--verify` | **26/26** | `evidence/wp3-final-electron-verify.txt` |
| `verify:artifacts` 后端临时验收 | **23/23**（P3-C） | `evidence/p3c-artifact-backend.txt` |
| 真实 Electron IPC 预览 | **4/4**（P3-C；同形 handler，见已知限制 9） | `evidence/p3c-ipc-verify.txt` |
| `render-verify.ts` | **6 项既有失败**（不计入门禁；P1-E mock 遗留） | `/tmp` 运行输出 / `docs/logs/render-verify.json` |

### smoke 121 → 162 → 187 → 216 的演进

- **P1-E：121 → 162（+41）**：多任务看板/配额/全局审批/后台计数/焦点 pane 上限；旧 121 条零删除、零改名。
- **P2-C：162 → 187（+25）**：技能库状态/未配置提示/category 验证/简报预览；旧 162 条零删除、零改名。
- **P3-C：187 → 216（+29）**：3 附件/5 产物 mock 世界、`applySnapshot` 读附件/产物、工件面板数量/短 sha/导入时间、`systemOpen=false`、导入中提示、文件选择计数、HTML/SVG 文本预览、非位图 data URL 拒绝、位图 data URL、hex、可执行不系统打开、任务卡附件数量、后台 `artifact.updated` 丢弃、焦点 `artifact.updated` 更新、旧快照空、mock hub 快照、mock `artifact.refresh`/文本预览/选择器/补导入。
- **旧 187 条 diff 删除行 = 0**：P3-C 的 `smoke.ts` 与 `.probe/backup-p3c/.../smoke.ts` 对比，`-` 行计数为 0；旧断言语义未改。
- **红测**：P3-C 红测 215 条计分 / 14 FAIL（旧 187 全绿），绿测 216/216；P3-A 红测 52/136，P3-B D 红 248/252、E 红（桩）286/324。

---

## 怎么验证的 / 保护面

- **P3-D 状态检查**：`verify:all` 607 / artifacts 324 / skills 149 / multitask 174（单跑）/ migration 44 / Electron 26；与 P3-C 一致。
- **最终六份 evidence**：`evidence/wp3-final-*.txt`，见 §7。
- **备份库**：`.probe/backup-wp1/board.db` 348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录一致；WP3 期间未改。
- **board schema**：`board.ts` sha256 `2882feae941002b1…`，`PRAGMA user_version = 1`；没有附件/工件/flag 新表。
- **保护面**：`board.ts`、`session/manager.ts`、`mcp-host/server.ts`、`bridge.ts`、`briefing/build.ts`、`skill/**`、`config/**`、`verify-r18/hardening/multitask/skills/migration`、`verify:all` 链在 P3-D 均未改；P3-A/B/C 的改动边界见各自 done 文档。
- **没有跑真实 agent、没有烧 token**：P3-D 0 token；全部是进程内 Hub / fake fixture / mock / 临时 Electron 脚本。
- **没有重打包**：`dist/` 不是本轮产物；打包态附件选择/预览/replay 留 WP7。
- **没有改 `D:\agent\skill`、没有改全局配置、没有改 `docs/ARCHITECTURE.md`、没有删测试、没有自动提交 flag。**

---

## WP4 之前必须知道的事（交接）

1. **WP4 会第一次改 `policy/engine.ts`**（放行/阻断的唯一闸口），比 P3-B 的 `inferEvidence` 更危险；改之前先锁旧语义（现有策略测试/`verify-r18`/`verify-hardening` 全绿），再动规则。
2. **WP4 会新增 SQLite 表 `targets`，`user_version` 从 v1 → v2；WP5 flag 表会是 v3**。版本号顺序要跟 WP5 协调，别抢；`board.ts` 的迁移必须幂等、旧库可打开。
3. **WP4 的目标提取（从命令/审批文本）会误报**：默认只对“明确 IP/CIDR/URL/host:port”判定；解析失败不 block；不要把任意字符串当目标。
4. **WP4 本地代理默认关**：启用前单独问用户；只注入环境变量，不改 OS 代理/防火墙/全局配置。
5. **WP4 的“强制”边界**：策略只在看得见的权限请求/终端调用上判定；`nmap`/raw socket/DNS 等可绕过；UI 与文档必须明示“尽力强制，不承诺 OS 级隔离”。
6. **契约冻结**：WP4 若需新 `HubAction`/`HubEvent`/快照字段，先写 `docs/requests/` 并停下问用户；不要直接改 `events.ts`。
7. **仍挂账**：`verify:multitask` F 组同毫秒排序 flaky、`render-verify.ts` 6 项 P1-E mock 遗留失败；WP6 修（tie-break/seq + 更新 mock 期望或明确不修）。

**WP3 不重开**：附件导入/ZIP 安全/预览边界（P3-A）、E2 事实文本/回放（P3-B）、工件面板/最小 Lane A（P3-C）已完成；WP4 只消费，不重做。

---

## 没做什么 / 已知问题

- **P3-D 不改代码**：没有改任何 `.ts` / `.css` / `.json` / `.cjs`；没有改 `hub.ts`、`board.ts`、`session/manager.ts`、`mcp-host/**`、`briefing/**`、`skill/**`、`renderer/**`、`events.ts`、`config/**`、`electron/**`、各 verify 套件、`smoke.ts`、`mock/**`、`package.json`、`verify:all` 链。
- **没有发新的 `docs/requests/B-to-A-*.md`**；已有 `B-to-A-artifact-ipc.md` 是 P3-C 授权留痕。
- **没有实现**：附件清单注入简报、对象 witness、附件扫描候选、文件 watcher、系统打开/reveal、字节级进度、独立回放命令白名单、跨任务批量授权、CVE 精确索引、真实 8 会话长跑、打包态端到端。
- **没有跑真实 agent、没有烧 token、没有自动提交 flag、没有改全局配置/技能库/架构文档。**
- **未验证项**：真实进程重启后的附件访问；`dialog.showOpenDialog` 真实点击；`main.ts` 预览 IPC 的自动断言；真实大任务目录（>500 文件/深度 >6）面板性能；`cmd:` 回放在真实 agent/审批队列长等待下的体验。

---

## 证据

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/wp3-final-verify-all.txt` | verify:all 607 PASS / 0 FAIL | `1040e582463dcbee13c4603d4ea58c80bbda91a5d6b8c096b6e29b3cfdf4be8b` |
| `evidence/wp3-final-artifacts.txt` | verify:artifacts 324/324 | `1eb0af60df595f60ac32b1ea3f4a322295370b606fe01147dd38d0f19929d6ae` |
| `evidence/wp3-final-skills.txt` | verify:skills 149/149 | `6470c38121e06a7d18e3910fe6a46cd2d65f544dff6db9ddd10242642fbf49c9` |
| `evidence/wp3-final-multitask.txt` | verify:multitask 174/174 | `6c0cd078ec648d47a10a2311596e0a8f11e15e5ba39a5c8168fec4ebd90b6084` |
| `evidence/wp3-final-migration.txt` | verify:migration 44/44 | `f1762fac0399f44e459e6560245316c126cf10f873ebb42531a9649c2be07148` |
| `evidence/wp3-final-electron-verify.txt` | Electron 26/26 | `fad08b0302da9d62bc91cc2a3724b9cf7d89a598666b1cbfe31944cf4f11973a` |

`.probe/backup-wp1/board.db`：348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`（未变）。P3-A/B/C 的详细证据与 sha256 见各自 done 文档；P3-D 只新增 `wp3-final-*`。
