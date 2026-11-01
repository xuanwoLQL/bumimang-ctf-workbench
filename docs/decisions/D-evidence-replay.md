# D-evidence-replay · `cmd:` 证据回放默认关

- 日期：2026-10-23
- 状态：P3-B 批次 2 已实施
- 关联：`docs/PROMPT-COMPETITION-READINESS.md` §6 WP3；`docs/plans/COMPETITION-READINESS.md` §6.4/§6.5；`docs/done/P3-B.md`
- 实现：`apps/desktop/src/main/evidence/replay.ts`、`apps/desktop/src/main/mcp-host/bridge.ts`（`inferEvidence` 的 `cmd:` 分支）

## 背景

WP3 之前 E2 只认“任务工作目录内真实文件包含提交的 flag/事实”。命令回显类证据只能落到 `evidence/<name>.txt` 再走文件判定；如果 agent 只在终端里看到 flag、没有落盘，就只能 E1。R24 的收敛门槛因此被迫放宽到 E1。

`cmd:` 回放让 agent 可以提交 `witness = "cmd:<command>"`，由主进程重新执行命令并用 stdout 核对提交内容。它扩大了证据能力，也扩大了执行面：命令来自 agent 可控的 `witness`，因此必须默认关、过策略、可审计、失败只降级。

## 决策

### 1. 默认关，只认显式 `BUMIMANG_EVIDENCE_REPLAY=1`

1. `config/loader.ts` 的 `evidenceReplay` 缺省 `false`；只有 `opts.env.BUMIMANG_EVIDENCE_REPLAY === "1"` 才是 `true`。`"true"`、`"yes"`、空串都不开启。
2. `EvidenceReplayer` 构造器只认 `opts.enabled === true`；缺省/undefined 一律关闭。
3. 配置文件 `config/app.json` **不提供**这个开关；它是运行期安全开关，不随包分发。
4. 关闭时 `cmd:` 的判级与旧行为一致：不执行、判 E1；但仍写一条 `evidence.replay` 审计（`status=disabled`, `ran=false`），用于证明“没有 spawn”。

### 2. 无 shell、argv 数组

1. `cmd:` 后面的字符串由 `parseCommandLine()` 解析成 argv：空白分隔、单/双引号分组、双引号内 `\"` 为字面量 `"`、其它反斜杠原样保留（Windows 路径）、引号外反斜杠原样保留。
2. `spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, stdio: ["ignore","pipe","pipe"] })`。
3. **不拼 `cmd /c`**，不经过 `cmd.exe`/PowerShell。`type`、`echo`、`dir` 这类内建命令不会执行，会得到 `spawn_error` → E1；这是有意的边界。
4. 未闭合引号、NUL、空 argv 一律 `invalid` → E1，不执行。

### 3. 执行边界

| 项 | 值 | 说明 |
|---|---|---|
| cwd | 任务专属 workdir `<workRoot>/<taskId>` | 由 `inferEvidence` 传入；replay 不自己推导 |
| 超时 | 30s（`REPLAY_TIMEOUT_MS`） | 超时用 `taskkill /T /F`（Windows）或 `SIGKILL` 杀进程树；只降级 E1 |
| stdout | 最多 1MB（`REPLAY_MAX_OUTPUT_BYTES`） | 超出部分丢弃；匹配只在保留的前 1MB 内进行 |
| stderr | 最多 1MB | 只用于字节数/截断审计，不参与匹配 |
| stdin | `ignore` | 不把主进程 stdin 交给回放命令 |
| 环境变量 | 继承主进程 | 不额外注入凭据；不写全局配置 |

### 4. 策略 `evidence/replay`

1. 执行前调用 `policy.evaluate({ action: "evidence/replay", sessionId, tier, detail: { command, cwd, taskId } })`。
2. `tier` 取会话档位（`autonomous` / `guarded`）；会话查不到时按 `guarded`。
3. 判定：
   - `block` → 拒绝执行，`status=blocked`，写审计；
   - `approve` → 进入 `ApprovalQueue`（action=`evidence/replay`，命令脱敏后展示/落库），人工批准才执行；拒绝/超时 → `status=denied`，E1；
   - `allow` → 直接执行。
4. 没有策略引擎 → `blocked`（`rule=no-policy`），不执行；没有审批队列 → `needs_approval`，不执行。
5. **已知代价**：`approve` 会阻塞当前 `submit_fact` RPC，直到人工裁决或审批队列超时（默认 5 分钟）。这是“approve 必须进审批”的直接结果；其他会话不受影响。

### 5. 失败只降级，不崩

| 情况 | `status` | 判级 |
|---|---|---|
| 默认关 | `disabled` | E1 |
| 空/非法命令 | `invalid` | E1 |
| 策略 block / 无策略 | `blocked` | E1 |
| 无审批队列 | `needs_approval` | E1 |
| 人工拒绝/审批超时 | `denied` | E1 |
| spawn 失败（含 `.cmd`/内建命令） | `spawn_error` | E1 |
| 非零退出 | `failed` | E1（即使 stdout 有 flag 也不算命中） |
| 30s 超时 | `timeout` | E1 |
| 正常退出且 stdout 命中 | `ok` + `matched=true` | E2 |

`run()` 内部捕获策略/审批/解析/spawn 异常；`inferEvidence` 不因回放失败抛错。审计写入失败也吞掉，不影响 `submit_fact`。

### 6. 审计与脱敏

每次 `cmd:` 判级写一条 `audit.action = "evidence.replay"`，字段：

```json
{
  "taskId": "task-...",
  "command": "…flag{***}…",
  "status": "ok",
  "ran": true,
  "matched": true,
  "policyVerdict": "allow",
  "rule": "e-allow",
  "approvalDecision": null,
  "exitCode": 0,
  "durationMs": 77,
  "stdoutBytes": 20,
  "stderrBytes": 0,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "error": null
}
```

- **不写 stdout/stderr 内容**，只写字节数/截断/是否命中。
- `command` 与 `error` 都经 `redactFlagText()`：`flag{...}` → `flag{***}`。
- 审批卡/`approvals` 落库同样使用脱敏后的命令；flag 只以 `matched=true` 表达，不落值。
- `rule` / `policyVerdict` / `approvalDecision` 用于回答“为什么执行/为什么没执行”。

## 备选方案与取舍

- **默认开启**：命令来自 agent 可控的 witness，等于给 agent 一条无审批的任意执行路径；否决。默认关，且开启也要过策略。
- **用 shell 执行**：能支持内建命令/管道，但注入面与平台差异大；否决。argv + `shell:false` 是硬边界。
- **approve 直接放行**：会绕过人工审批；否决。approve 进审批，宁可阻塞当前 `submit_fact`。
- **approve 只记审计、不执行**：实现简单，但“人工批准后能回放”的能力不存在；否决。
- **命令白名单**：计划 §6.4 提到“白名单/策略允许”。本轮没有做独立白名单，原因是白名单会把回放限制在少数只读命令上，而证据命令可能是 `python`/`node`/`grep`/`findstr` 等；改为“默认关 + 策略 `evidence/replay` + 无 shell + cwd/超时/输出上限 + 全量审计”。这是已知边界，见下。
- **把 flag 明文写进审计**：违反“不把 flag 写进日志”；否决。只记命中布尔值。

## 影响

- **行为变更（批次 2，开启时）**：`cmd:` witness 多了一条 E2 路径；默认关时判级与旧行为一致（E1），但会多一条 `evidence.replay` 审计。
- **行为变更（批次 2，默认关）**：`cmd:` 不再走“当路径解析”的隐式路径，而是显式 `disabled` → E1；判级相同，审计可区分“没开”与“开了但没命中”。
- **性能**：默认关零 spawn；开启后每次 `cmd:` 最多 30s、最多 2MB 输出采集。`submit_fact` 在 approve 路径可能等待人工。
- **安全边界**：无 shell、cwd 限定、超时/输出上限、策略闸门、审计脱敏；但**不是 OS 级沙箱**——命令仍以当前用户权限运行，可访问网络/文件系统。UI/文档不得宣称“已强制隔离”。
- **历史证据**：只影响新提交；已落库的 E0/E1/E2 不重新判级。

## 已知限制

1. **没有独立命令白名单**：开启且策略 `allow` 时，argv 可以是任意可执行文件；安全依赖“默认关 + 策略 + 人工审计”。比赛期若要保持更窄的面，建议只给 autonomous 会话开，或后续加白名单。
2. **Windows 内建命令不可用**：`type`/`echo`/`dir` 没有 `.exe`，`shell:false` 下会 `spawn_error` → E1；需要 `cmd /c` 的场景本轮明确不支持。
3. **approve 阻塞 `submit_fact`**：审批队列默认 5 分钟超时；超时按拒绝处理（E1）。极端情况下 agent 的 MCP 调用会等很久；这是“必须人工批准”的代价。
4. **stdout 1MB 截断**：flag 在 1MB 之后不会被匹配；需要更大输出时先落盘再用文件 witness。
5. **`cmd:` 前缀大小写不敏感**：`CMD:` 也会被当作回放；旧行为下它是路径 → E1。这是为了兼容 agent 的大小写习惯，属于轻微扩展。
6. **没有网络/文件系统沙箱**：命令继承主进程权限与环境变量；策略只能按文本/动作判定，不能阻止命令内部的任意行为。
7. **审计不含 stdout/stderr**：排障时只能看字节数/退出码/命中布尔值；需要完整输出时由 agent 落盘到 `evidence/<name>.txt`。
8. **策略档位**：`guarded` 会话在 competition 包下没有 `evidence/replay` 规则，会走 `tier-guarded-default` → approve → 进审批；`autonomous` 会话无规则命中 → allow。若希望 guarded 也直接执行，需要在规则包里加 allow 规则（本步不改 `rules/`）。

## 后续

- **P3-C**：不碰回放；工件面板/预览 IPC 另做。
- **WP5**：`cmd:` 回放的命中仍只写审计，不产生 flag 候选；候选持久化/去重由 WP5 接管。
- **WP6**：benchmark 若使用 `cmd:` 证据，需要把“回放执行时间/审批等待”单独统计，不能算进 agent 首答。
- **WP7**：进程树回收可复用 `killTree` 的思路；本轮只做超时杀树，不做 Job Object。
- 若要加命令白名单：先更新本决策（白名单路径、允许的解释器、参数限制），再写代码；默认仍保持关闭。
