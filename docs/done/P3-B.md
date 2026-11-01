# P3-B · 证据链扩展：事实文本 E2 + 附件扫描审计 + `cmd:` 回放（默认关）

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §6 WP3；`docs/plans/COMPETITION-READINESS.md` §6.4/§6.5；`docs/done/P3-A.md`；`docs/decisions/D-evidence-replay.md`
> 日期：2026-10-23
> 状态：**P3-B 完成（批次 1 + 批次 2）**。批次 1 只扩 E2 与附件扫描审计；批次 2 只加 `cmd:` 回放（默认关）。
> 验收基线：**`verify:all` 578 PASS / 0 FAIL；`verify:artifacts` 324/324（A 110 / B 51 / C 58 / D 33 / E 72）；`verify:skills` 149/149；`verify:multitask` 174/174；`verify:migration` 44/44；Electron `--verify` 26/26。**

---

## 1. 做了什么

一句话：把 E2 从“文件含 flag”扩到“文件含 flag 或提交的事实文本”，把附件扫描接进 Hub（只写审计、不产生候选），并新增默认关闭的 `cmd:` 证据回放（策略闸门 + 审批 + 无 shell + 30s/1MB + 审计脱敏 + 失败降级 E1）。

**批次 1**

- `inferEvidence` 扩展：witness 文件内容包含提交的 flag **或**提交的事实文本 → E2；事实文本按**包含**匹配，空/纯空白不算命中，退回 E1。
- 附件扫描接入 Hub：`attachment.import` 成功后扫描本次新增附件，命中 `flag{...}` 写 `attachment.scan` 审计；**不产生 flag 候选、不写事实、不写黑板**。
- 简报 `evidence_convention` 文案更新：E2 明确“flag 或事实文本”；witness 用任务目录相对路径，禁止 `..` 与目录外路径；事实文本按包含匹配。

**批次 2**

- 新增 `apps/desktop/src/main/evidence/replay.ts`：`cmd:` 回放默认关；`BUMIMANG_EVIDENCE_REPLAY=1` 才开；argv 解析、`spawn` 无 shell、cwd=任务 workdir、30s 超时、stdout/stderr 各 1MB、执行前过策略 `evidence/replay`、approve 进审批、失败只降级 E1、审计脱敏。
- `inferEvidence` 增加 `cmd:` 分支：默认关/未配置 → E1；开启且回放成功且 stdout 命中提交内容 → E2；开启但超时/非零退出/策略拒绝/人工拒绝 → E1。
- `config/loader.ts` 只增加 `evidenceReplay`（默认 false，只认 env `=1`）。
- `electron/main.ts` 只增加 replay 初始化、策略/审批延迟注入、桥接；未改启动恢复/配额/审批守卫。

**关键取舍**

- `cmd:` 回放是**主进程执行**，不是 agent 自己执行；命令来自 witness，因此默认关 + 策略 + 审批 + 审计四道闸门。
- 回放 stdout 的命中语义复用 `inferEvidence` 的 `evidenceMatches`，replay 不复制 flag/事实文本逻辑。
- 附件扫描只做“发现并留痕”，不抢 WP5 的 flag 候选/去重/确认职责。
- E 组红测用“未实现桩”跑，随后还原真实实现并校验 sha256（见 §3.1）。

---

## 2. 改了哪些文件

**新增**

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/evidence/replay.ts` | `cmd:` 回放：argv 解析、无 shell spawn、策略/审批、超时/输出上限、脱敏、失败降级 |
| `docs/decisions/D-evidence-replay.md` | 默认关、策略/审批、审计、失败降级、已知边界 |
| `docs/done/P3-B.md` | 本文件 |

**修改**

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/main/mcp-host/bridge.ts` | `BridgeOptions.replay?`；`inferEvidence` 改为 async、加 `cmd:` 分支、加 `sessionTier`/`auditReplay`；文件/flag/事实文本路径保持原样 |
| `apps/desktop/src/main/briefing/build.ts` | 只改 `EVIDENCE_CONVENTION` 的 E2/rule 字符串 |
| `apps/desktop/src/main/hub/hub.ts` | 只加 `attachment.import` 成功后的 `scanAttachmentForFlags` 调用与 `attachment.scan` 审计；焦点/归档/配额/收敛/flag 逻辑未动 |
| `apps/desktop/src/main/config/loader.ts` | 只加 `evidenceReplay`（默认 false，只认 `BUMIMANG_EVIDENCE_REPLAY=1`） |
| `apps/desktop/src/main/electron/main.ts` | 只加 replay 初始化、策略/审批延迟引用、桥接与一行启动日志；未改启动恢复/配额/审批守卫 |
| `apps/desktop/src/cli/verify-artifacts.ts` | 加 D 组 33 条、E 组 72 条；A/B/C 旧断言一条未改、一条未删 |
| `docs/PROGRESS.md` | 追加一行 |

**明确没改**：`board.ts`（仍 v1、无附件列）、`session/manager.ts`、`mcp-host/server.ts`、`renderer/**`、`packages/shared-protocol/events.ts`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify-skills.ts`、`verify-migration.ts`、`smoke.ts`、`mock/**`、`config/app.json`、`rules/**`、`verify:all` 链、`D:\agent\skill`、`docs/ARCHITECTURE.md`。保护面比对见 §3.5。

---

## 3. 怎么验证的

### 3.1 D 组红测 / 绿测

**红测（改 inferEvidence 前）**：`evidence/p3b-d-red.txt`

```text
================ 248/252 通过 ================

FAILED:
  - D：witness 文件含提交的事实文本（无 flag）→ E2 — actual="E1" expected="E2"
  - D：事实文本按包含匹配（文件有前后缀）→ E2 — actual="E1" expected="E2"
  - D：附件扫描命中写一条审计 — actual=0 expected=1
  - D：扫描审计记录命中串
```

- D 组 33 条：**29 PASS / 4 FAIL**；A/B/C 219 条全绿。
- 16 条旧 E0/E1/E2 语义断言全绿（无 witness→E0、空/空白→E0、任务内真实文件不含内容→E1、含 flag→E2、任务内绝对路径→E2、带引号→E2、目录外→E1、绝对目录外→E1、目录→E1、junction 逃逸→E1、不存在→E1、文件含 flag 但提交内容不含→E1、flag A vs flag B→E1、flag 优先→E2、无 workRoot→E1）。
- 4 条红全部是新增语义（事实文本 2 条、扫描审计 2 条）。

**绿测**：`evidence/p3b-d-green.txt`

```text
================ 252/252 通过 ================
```

首轮绿测发现扫描审计路径出现 `attachments/attachments/...` 双前缀，已修正为单层并复跑。

### 3.2 E 组红测 / 绿测

E 组写完后，用“未实现桩”替换 `replay.ts` 跑红测（与 P3-A 红测同样的做法）；随后从 `.probe/backup-p3b/replay.ts` 还原真实实现，sha256 校验一致（`c1d828ad…f126d`）。还原后又补了一处 `execute().catch` 防御（确保任何意外 rejection 也只降级 E1），并给策略/审批结果加了显式类型标注；最终实现 sha256 `9e1853c6…5fc95`；这些改动不影响判级，绿测与全套回归均已复跑。

**红测（桩）**：`evidence/p3b-e-red.txt`

```text
================ 286/324 通过 ================
```

38 条计分 FAIL，覆盖：argv 解析、开启命中、审计 status/ran/exitCode/matched、审计脱敏、cwd、非零退出审计、block 审计、approve 进审批、真实 ApprovalQueue、denied、超时、stdout/stderr 截断。默认关 7 条全绿（判 E1、不执行、审计 disabled、未进审批）。

**绿测（真实实现）**：`evidence/p3b-e-green.txt`

```text
================ 324/324 通过 ================
```

E 组 72 条，覆盖：

- **默认关**：`loader` 缺省 false、env 只认 `1`、仓库 `config/app.json` 缺省 false；`cmd:` 判 E1、marker 不存在（没 spawn）、审计 `status=disabled/ran=false/matched=false/policyVerdict=null`、未进审批。
- **开启命中**：E2、命令真的执行、审计 `status=ok/ran=true/exitCode=0/matched=true/policyVerdict=allow`、cwd=任务 workdir、审计 command 已脱敏、审计不含 flag 明文。
- **失败降级**：非零退出 → E1（即使 stdout 有 flag）、审计 `failed/exitCode=3/matched=false`；超时 → E1、审计 `timeout/ran=true/matched=false`、3s 内返回。
- **策略/审批**：block → E1、不执行、未进审批、审计 `blocked`；approve + 人工批准 → E2、执行、审批一次、action=`evidence/replay`、审批请求不含 flag；approve + 人工拒绝 → E1、不执行、审计 `denied`；**真实 `ApprovalQueue`**（待批即批准）→ E2、队列收到 `evidence/replay`、状态 approved、command 脱敏。
- **路径边界**：开启回放后目录外/junction/目录 witness 仍 E1；空 `cmd:` → E1、审计 `invalid`。
- **输出上限**：stdout 截断后 flag 不可见 → E1、`stdoutTruncated=true/stdoutBytes=1024`；stderr 截断但 stdout 命中 → E2、`stderrTruncated=true/stderrBytes=1024`。

### 3.3 审计样例（脱敏）

来自 `evidence/p3b-e-green.txt`：

```json
{"taskId":"task-7cb46a88","command":"\"D:\\Program Files\\nodejs\\node.exe\" -e \"require('fs').writeFileSync('on-ran.txt','1'); console.log('flag{***}')\"","status":"ok","ran":true,"matched":true,"policyVerdict":"allow","rule":"e-allow","approvalDecision":null,"exitCode":0,"durationMs":77,"stdoutBytes":20,"stderrBytes":0,"stdoutTruncated":false,"stderrTruncated":false,"error":null}
```

审计不含 stdout/stderr 内容；`flag{E_REPLAY_FLAG}` 被脱敏为 `flag{***}`；只记 `matched=true`。

### 3.4 全套回归

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run verify:all` | **578 PASS / 0 FAIL**（确定性 391 + smoke 187） | `evidence/p3b-verify-all.txt` |
| `npm run verify:artifacts` | **324/324**（A 110 / B 51 / C 58 / D 33 / E 72） | `evidence/p3b-artifacts.txt` |
| `npm run verify:skills` | **149/149** | `evidence/p3b-skills.txt` |
| `npm run verify:multitask` | **174/174** | `evidence/p3b-multitask.txt` |
| `npm run verify:migration` | **44/44** | `evidence/p3b-migration.txt` |
| Electron `--verify` | **26/26** | `evidence/p3b-electron-verify.txt` |

8KB 简报：正常 **4535B**、超大黑板 **7272B**，仍 ≤ 8192B（`verify:skills` D 组）。

### 3.5 保护面

- `.probe/backup-wp1/board.db`：348160 B，sha256 `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`，与 P1-A 记录一致。
- 对 P3-B 开工前 `.probe/backup-p3b/` 逐文件比对：`scan.ts`、`events.ts`、`board.ts`、`session/manager.ts`、`mcp-host/server.ts` **UNCHANGED**；允许修改的 6 个文件 CHANGED。
- `renderer/**` 没有文件晚于 18:20（P3-B 开工）；`verify-r18/hardening/multitask/skills/migration/smoke` mtime 全部早于 P3-B。
- `board.ts` 仍 `user_version=1`，无附件列；`events.ts` 未加字段。

---

## 4. 行为变更（批次 1 / 批次 2 分列）

> 每条写清“改了哪条旧语义 / 为什么 / 影响哪些历史证据 / 旧测试怎么处理”。

### 批次 1

1. **E2 命中条件扩展**
   - **改了哪条**：旧 E2 = “提交内容里有 flag 且 witness 文件包含该 flag”；新 E2 = “witness 文件包含提交的 flag **或**提交的事实文本”。
   - **为什么**：命令回显/事实文本不一定含 `flag{...}`；只认 flag 会让大量可核对的事实停在 E1。
   - **影响历史证据**：无。`inferEvidence` 只在 `submit_fact` 时执行，已落库的 E0/E1/E2 不重新判级。
   - **旧测试怎么处理**：**纯加法**。旧 E0/E1/E2 断言一条未改、一条未删；D 组 16 条旧语义断言全绿，新增 5 条事实文本断言。
2. **附件扫描只写审计**
   - **改了哪条**：`attachment.import` 成功后新增扫描；命中写 `attachment.scan` 审计。
   - **为什么**：让人知道导入的附件里已有 flag，同时不抢 WP5 的候选/去重/确认职责。
   - **影响历史证据**：不产生/不修改任何 flag 候选、事实、黑板事件；只多审计行。
   - **旧测试怎么处理**：**纯加法**。A/B/C 219 条未改；D 组新增 12 条扫描断言。
3. **简报 `evidence_convention` 文案**
   - **改了哪条**：E2 描述加“或事实文本”；rule 加“禁止 `..` 与目录外路径”“事实文本按包含匹配”。
   - **为什么**：让 agent 知道新的 E2 依据和 witness 边界。
   - **影响历史证据**：无；只影响新简报。
   - **旧测试怎么处理**：`verify:skills` D 组只检查字段存在与 8KB，不检查具体文案；149/149 仍绿。**纯加法/文案更新**。

### 批次 2

1. **`cmd:` 回放（默认关）**
   - **改了哪条**：旧 `cmd:` witness 被当路径解析（不存在 → E1）；新代码识别 `cmd:` 前缀，开启时执行回放，成功且 stdout 命中 → E2；关闭/未配置 → E1。
   - **为什么**：让“只在终端里看到、没落盘”的证据也能到 E2；默认关保证不扩大执行面。
   - **影响历史证据**：无；只影响新提交。已落库事实不重判。
   - **旧测试怎么处理**：**纯加法**。旧 E0/E1/E2 路径断言未改；E 组新增 72 条。默认关时判级与旧行为一致（E1），但多一条 `evidence.replay` 审计（`status=disabled`）。
2. **开启后 E2 多一条路径**
   - **改了哪条**：开启且策略 allow/审批通过、命令正常退出、stdout 命中提交内容 → E2。
   - **为什么**：这是 WP3 的目标能力。
   - **影响历史证据**：无；只影响新提交。
   - **旧测试怎么处理**：**纯加法**；E 组覆盖命中/超时/非零/block/approve/denied/截断。
3. **approve 进审批**
   - **改了哪条**：策略 `evidence/replay` 判 `approve` 时，`submit_fact` 会阻塞并进入审批队列；人工批准才执行，拒绝/超时 → E1。
   - **为什么**：命令来自 agent 可控 witness，approve 不能静默放行。
   - **影响历史证据**：无；只影响开启后的新提交。
   - **旧测试怎么处理**：**纯加法**；E 组新增 approve approved/denied 断言。
4. **审计新增 `evidence.replay`**
   - **改了哪条**：每次 `cmd:` 判级写一条审计（含默认关的 `disabled`）。
   - **为什么**：证明“有没有 spawn、为什么执行/没执行”，并满足脱敏要求。
   - **影响历史证据**：只多审计行；不改事实/候选。
   - **旧测试怎么处理**：**纯加法**；E 组断言审计字段与脱敏。

**与 WP1/WP2/P3-A 并列**：WP1 的四个行为变更、WP2 的加法变更、P3-A 的契约/导入加法均未被本步修改；P3-B 只动证据判定、扫描审计和回放。

---

## 5. 没做什么 / 已知问题（含已知中间状态）

1. **附件 UI/IPC/预览面板未接**（P3-C）：没有 `dialog.showOpenDialog`、没有附件选择/工件列表/预览面板；`artifact.refresh` 仍是占位，`artifact.updated` 不广播。
2. **`board.ts` 无附件列，`user_version` 仍 v1**：本步不加表不加列；WP5 若需要 flag 表再议。
3. **flag 候选仍只在内存**（WP5 持久化）：附件扫描命中不产生候选；`cmd:` 回放命中也不产生候选。
4. **跨任务批量授权仍未实现**（WP1 遗留，WP6 评估）。
5. **CVE 精确检索差距**（WP2 已知，WP6 评估）。
6. **简报轮即开工**（WP2 观察，WP6 分开统计）。
7. **`cmd:` 回放没有独立命令白名单**：开启且策略 allow 时 argv 可为任意可执行文件；依赖默认关 + 策略 + 审批 + 审计。详见 `D-evidence-replay.md`。
8. **Windows 内建命令不可用**：`type`/`echo`/`dir` 在 `shell:false` 下 `spawn_error` → E1；本轮明确不支持 `cmd /c`。
9. **approve 阻塞 `submit_fact`**：审批队列默认 5 分钟超时；超时按拒绝（E1）。其他会话不受影响。
10. **stdout/stderr 各 1MB 截断**：flag 在 1MB 之后不匹配；需要更大输出时先落盘走文件 witness。
11. **审计不含 stdout/stderr**：只记字节数/截断/命中布尔值；排障需 agent 落盘。
12. **`cmd:` 前缀大小写不敏感**：`CMD:` 也会被识别；旧行为下是路径 → E1，这是轻微扩展。
13. **不是 OS 级沙箱**：回放命令继承主进程权限/环境变量，可访问网络/文件系统；策略只做文本/动作判定，不能阻止命令内部行为。
14. **E 组红测是“桩”跑出来的**：真实实现写入后，E 组首次绿测发现 witness 整串去引号导致 `cmd:` 尾部引号被剥掉（`命令引号未闭合`），已改为“仅非 cmd 走旧去引号逻辑”并复跑；红测文件保留的是桩运行结果，不是这次 bug 的运行结果。
15. **未跑真实 agent、未烧 token**：全部是进程内 Hub / fake fixture；真实 A/B 仍只有 `docs/logs/ab-result.json` 那一次（样本 1）。
16. **未重打包**：`dist/` 不是本轮产物；打包态 replay 行为留 WP7。
17. **`verify:artifacts` 未并入 `verify:all`**：按用户要求保持独立运行。

---

## 6. 下一手需要什么（P3-C 交接）

- **P3-C 只做界面/IPC**：附件选择（`dialog.showOpenDialog`）、工件列表、文本/图片/hex 预览、`artifact.refresh` 真实现、`artifact.updated` 广播、渲染层 `applyEvent` 补 case。不要重做 P3-A 的导入/ZIP 安全、不要重做 P3-B 的证据判定/回放。
- **可直接复用**：
  - `readAttachments(taskDir)`、`previewAttachment({ taskDir, relativePath })`（任务内相对路径；附件要加 `attachments/` 前缀）；
  - `scanAttachmentForFlags({ taskDir, relativePath })` 返回任务内相对路径 + 命中串；
  - `EvidenceReplayer` / `redactFlagText` / `parseCommandLine`；
  - `attachment.scan` / `evidence.replay` 审计行。
- **不要碰**：`board.ts` schema（v1）、`events.ts` 契约（P3-A 已定）、WP1 焦点/归档/配额/收敛/flag 逻辑、`session/manager.ts`、`mcp-host/server.ts`、`renderer/**`（P3-C 才做）。
- **门禁保持不变**：`verify:all` **578**、`skills` **149**、`multitask` **174**、`migration` **44**、Electron **26**、`artifacts` **324**；新增测试只加不改旧断言。
- **若要改简报传参**（例如把附件清单注入简报）：先停下问；本步只改了 `evidence_convention` 文案，没改 `SessionManager` 传参。

---

## 7. 证据

| 文件 | 内容 | sha256 |
|---|---|---|
| `evidence/p3b-d-red.txt` | D 组红测 248/252（4 条新增语义 FAIL） | `a5d5e85a05944963cc767d2d9496d7b635c81cc924f16221a3591c98ba712875` |
| `evidence/p3b-d-green.txt` | D 组绿测 252/252 | `354ba65ceaec8e7ff24ac4d3aef9a00a3d5912fdf1e48de32de76b40b829c7f5` |
| `evidence/p3b-e-red.txt` | E 组红测（桩）286/324 | `9d3e174854d5779b48eeb38578a7062e15cefa6496554932b4ded46ca6047229` |
| `evidence/p3b-e-green.txt` | E 组绿测 324/324 | `8cc2ba069ad93ebd67b13bc4e23df0413c8c71e13da81cb76e54bc923cf5adaf` |
| `evidence/p3b-verify-all.txt` | 578 PASS / 0 FAIL | `a4b0f0b542f48173a2050cd481c80cd464dc359f4facc1905e5984db2c7e81cd` |
| `evidence/p3b-artifacts.txt` | 324/324（A–E） | `4bbd7c92343297180ca558a43178da3edb2e4188f3b9708a380a6d4980889033` |
| `evidence/p3b-skills.txt` | 149/149 | `fff6a97a036db91f7736a4f83989770f6b757d8e464fe05d1f018ef20843a5ed` |
| `evidence/p3b-multitask.txt` | 174/174 | `e766f0e1c16068551ca4a71f62d164e5753921a43dc1d1aee10734088d6cca85` |
| `evidence/p3b-migration.txt` | 44/44 | `2d6eb5d29a83faf9ab9db6331e69692defce0943d9aee6fbcb5f209af1f0d70e` |
| `evidence/p3b-electron-verify.txt` | 26/26 | `1e7f86881ab6eac15d510af3dc3097d376d70ccb01bc39a0312bf790980544e3` |

`.probe/backup-p3b/` 保留了 P3-B 开工前 11 个文件的备份与 `replay.ts` 还原副本；`.probe/backup-wp1/board.db` 未被测试改动。
