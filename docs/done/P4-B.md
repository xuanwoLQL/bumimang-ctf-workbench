# P4-B · 目标解析 / 匹配 / 提取纯函数层

> 关联：`docs/PROMPT-COMPETITION-READINESS.md` §4 WP4；`docs/plans/COMPETITION-READINESS.md` §7.3（目标模型）/§7.5（测试计划）/§12（阶段门禁）；`docs/done/P4-A.md`（targets 数据模型）
> 日期：2026-10-23
> 状态：**P4-B 完成**。只做纯函数层：`parseTarget` / `cidrContains` / `matchTargets` / `extractTargets`。**没有接策略引擎（P4-C）、没有接 `acp/client.ts`/`session/manager.ts`、没有做代理（P4-D）、没有做 UI/config/rules 改动。**

---

## 做了什么

把「目标怎么解析、怎么判断在不在范围内、怎么从命令文本里提取」落成三个无副作用的纯函数模块：

- **`main/scope/parse.ts`**：解析并规范化单个目标。
  - IPv4（严格四段、0–255、拒绝前导零）、IPv4 CIDR（prefix 0–32，主机位按掩码规范化，如 `10.1.2.3/8` → `10.0.0.0/8`）。
  - URL（`http/https/ftp/ws/wss`）只取 authority 的 host[:port]；**手写 authority 解析，保留显式端口**（不用 `new URL`，避免 `http://example.com:80` 的显式 80 被抹掉）；支持 userinfo 剥离、路径/查询/片段忽略。
  - host[:port]、裸域名、`localhost`；域名小写、去尾部点、label 校验；端口 1–65535。
  - IPv6（裸 `::1`、`[::1]:80`、IPv6 CIDR、IPv6 URL）明确 `unknown` + `ipv6-not-supported`；空串/空白/NUL/非 ASCII/超长/非法 IPv4/非法 CIDR/非法端口等全部 `unknown` + 可读 reason，**不抛错**。
  - 单标签主机名只接受 `localhost`；`not-a-target`、`foo` 这类命令裸词不当 host，避免误判。
- **`main/scope/match.ts`**：
  - `cidrContains(cidr, ip)`：IPv4 位运算，`/0`/`/8`/`/32` 边界正确；非法 CIDR/IP、IPv6、带端口 IP 一律 `false`。
  - `matchTargets(targets, candidate, denyTargets?)` → `in` / `out` / `unknown`。
  - **deny 优先**：deny 精确命中/CIDR 命中直接 `out` + `denied-by-deny-target`；deny CIDR 对域名无法判定时保持 `unknown`，不猜。
  - 端口语义：target 显式带端口时 candidate 必须同端口；target 不带端口时接受任意端口；CIDR 忽略端口；URL 按 host[:port] 匹配。
  - 空 targets → `out`（没有授权任何目标）；targets 非空但全部解析失败 → `unknown`（配置坏了，不猜测）；域名 vs CIDR、候选非法/IPv6、未知候选 kind → `unknown`。
  - 域名大小写不敏感；不读 DNS。
- **`main/scope/extract.ts`**：
  - 从命令/权限文本提取 URL、CIDR、host:port、IPv4；按 span 排序、按规范化值去重。
  - 解析失败的目标（非法 CIDR、IPv6 URL、非法端口 URL 等）进 `unknowns`，不产生 candidate；已占用的 span 不会被后续阶段重复提取（CIDR 内部的 IP 不会单独出现）。
  - 误报控制：文件路径（`./a/b`、`/etc/passwd`、Windows 反斜杠路径含 IP/host:port）、版本号（`1.2.3`）、五段数字（`1.2.3.4.5`）不提取；裸域名默认**不提取**，只有 `bareDomainAllowlist` 显式配置（精确 host/子域或 TLD）才提取。
  - candidate 的 `span` 是原文 `[start, end)`；URL 的 span 覆盖整段 URL，`value` 是规范化 host[:port]。
- **`verify-scope.ts`**：A 组 80 条原样保留；新增 B 组 96 条（B1 31 / B2 12 / B3 21 / B4 32），总 **176/176**。
- **纯函数约束**：三个模块不读 DB/config、不调外部服务、不做策略 block/allow 判定、不依赖真实备份或真实 agent；全部进程内 fixture。

**关键取舍**

- URL 显式端口必须保留：P4-C 的端口语义依赖它；`new URL().port` 会抹掉默认端口，所以手写 authority 解析。
- 裸域名默认不提取：命令里 `script.py`、`example.com` 太容易是文件名/普通参数；宁可漏提，不制造误报；allowlist 默认空。
- 单标签 host 只认 `localhost`：避免把 `not-a-target` 这类普通单词当目标；FQDN/IP 不受影响。
- `matchTargets` 对「候选本身是 CIDR」返回 `unknown`：CIDR 与 CIDR 的包含/相交语义留给 P4-C 明确，不在 P4-B 猜。
- 域名 vs CIDR 不查 DNS，返回 `unknown`；P4-C 可以按策略决定是审批还是拒绝。

---

## 改了哪些文件

源码：

- `apps/desktop/src/main/scope/parse.ts`（新增）
  - `ParsedTarget { kind: "host"|"cidr"|"url"|"unknown"; normalized; reason? }`；`parseTarget(value)`；`ipv4OfHost(host)`。
  - 常量：最大原始长度 4096、host 253、label 63；URL scheme 白名单。
- `apps/desktop/src/main/scope/match.ts`（新增）
  - `MatchVerdict`、`MatchResult`；`cidrContains(cidr, ip)`；`matchTargets(targets, candidate, denyTargets?)`。
  - 只依赖 `parse.ts` 与 `TargetView` 类型，不读 board。
- `apps/desktop/src/main/scope/extract.ts`（新增）
  - `ExtractedTarget { kind: "host"|"cidr"|"url"; value; span: [number, number] }`；`ExtractResult { candidates; unknowns }`；`ExtractOptions { bareDomainAllowlist? }`；`extractTargets(text, options?)`。
- `apps/desktop/src/cli/verify-scope.ts`
  - 顶部静态 import 三个 scope 模块；新增 `tv()` / `extractedValues()` fixture 辅助。
  - 新增 `partB()`（B1 parse / B2 cidrContains / B3 matchTargets / B4 extractTargets）；A 组 80 条未改，仍在 `partB()` 之前执行。
  - 新增三条回归断言：Windows 路径含 IP、Windows 路径含 host:port、IPv6 内嵌 IPv4 不提取。
  - B 组 span 断言按 `[start, end)` 修正：`curl http://10.1.2.3/x` 的 URL 是 17 字符，起点 5，end=22（原先写成 23 是测试笔误，不是实现放宽）。

文档/证据：

- `docs/done/P4-B.md`（本文件）、`docs/PROGRESS.md`（追加一行）。
- `evidence/p4b-verify-all.txt`、`p4b-scope.txt`、`p4b-scope-red.txt`、`p4b-migration.txt`、`p4b-artifacts.txt`、`p4b-skills.txt`、`p4b-multitask.txt`、`p4b-electron-verify.txt`。

**明确未改**

`policy/**`、`acp/client.ts`、`session/manager.ts`、`hub/hub.ts`、`blackboard/board.ts`、`electron/validate-action.ts`、`packages/shared-protocol/events.ts`、`renderer/**`、`config/**`、`rules/competition.json`、`verify-r18.ts`、`verify-hardening.ts`、`verify-multitask.ts`、`verify-skills.ts`、`verify-artifacts.ts`、`verify-migration.ts`、`smoke.ts`、`mock/**`、`D:\agent\skill`、`docs/ARCHITECTURE.md`、全局配置；`verify:scope` 未并入 `verify:all`。

---

## 怎么验证的

### 1. 红测 → 绿测

红测在三个模块创建前运行，`verify-scope.ts` 因静态 import 找不到 `scope/parse.ts`（当时 `match.ts`/`extract.ts` 也不存在）直接 `ERR_MODULE_NOT_FOUND`，exit=1；证据 `evidence/p4b-scope-red.txt`。这是“模块尚未实现”的红，不是断言级红。

实现后：

```text
$ npm run verify:scope
...
================ 176/176 通过 ================
exit=0
```

分组：A 组 **80/80**（P4-A 原样）；B 组 **96/96**（B1 31、B2 12、B3 21、B4 32）；FAIL=0。

### 2. 全量回归

```text
$ npm run verify:all
...
ALL PASS
（607 PASS / 0 FAIL = 确定性 391 + smoke 216）
```

```text
$ npm run verify:migration   → 73/73
$ npm run verify:artifacts   → 324/324
$ npm run verify:skills      → 149/149
$ npm run verify:multitask   → 174/174（单跑；F 组同毫秒排序 flaky，见已知问题）
$ npm run verify:scope       → 176/176
Electron --verify            → 26/26
```

完整输出见 `evidence/p4b-*.txt`。证据 sha256：

| 文件 | sha256 |
|---|---|
| `evidence/p4b-verify-all.txt` | `81ba4777c33fb8e40ad13eb502cb81c4624228c9dacd4f7e53979ab723f7d448` |
| `evidence/p4b-scope.txt` | `d868af92f5d1bd1bf1cd795a1419161a248b8538b2ce678012105cc50d302853` |
| `evidence/p4b-scope-red.txt` | `eeac747c8739a1af92672e6720131ad827cf142270331e7dd45e89fbc43d4c07` |
| `evidence/p4b-migration.txt` | `af2996db8acb522520260ff22de92a20ebfc6a6d5109eb58c0a93b9bb4def7c0` |
| `evidence/p4b-artifacts.txt` | `ef53b3f416c53a12be8a2830acdb7df8224537a975b69bf94e1a4657262796f2` |
| `evidence/p4b-skills.txt` | `a3d63b42c0153fd53f533f91f9220d971179c17e35c2c7adae40afa9dd8d192f` |
| `evidence/p4b-multitask.txt` | `ffdcb694a4e14ee4dabc75246f9561f8b958db5c8b0142757dfc98b3df15e0ff` |
| `evidence/p4b-electron-verify.txt` | `199e28d9f9689da48739d6e985a71d994ac4e7e32e76999623f6787a4bf59619` |

### 3. 文件收口

新增/修改文件 sha256：

| 文件 | sha256 |
|---|---|
| `scope/parse.ts` | `d1c76e3e4623f730861c15c690472b29398090556a443685255801d24655731f` |
| `scope/match.ts` | `81ce4bb07ade2f8d2df3559afe2d9120f80fd8299cafd0eff792ac1de99a3185` |
| `scope/extract.ts` | `23d6b8ca011df8e41f7a63201b063b0958308e5e9ded2891740f4de412ff3381` |
| `verify-scope.ts` | `23fbb790e019642dcd4c0c30524365deaa80cdabba29c2fa81eb94639a0cf09e` |

受保护面未改（内容哈希与 P4-A 收口一致）：

- `policy/engine.ts` `a7377d31992585b377fafefcdded6bb38a0a09e1873a1e8d081fb3e12696ed52`
- `blackboard/board.ts` `4d217201c032ab036e69bf828e80c8452996e78cf55c11a2d48baf947838aebe`
- `packages/shared-protocol/events.ts` `9f1e34b5b50ac428a68b13bb3e208898087dc4592b43888bbb610ee91c59e24c`
- `hub/hub.ts` `1e69b3fce432f3e59d95e676614054a0cf50d067d76cb0d0984edf9dfd7f7c12`
- `electron/validate-action.ts` `94dd36395edfe4d99600c825bd663888819fff2e69c14fb20661c1a0a2a98f1d`
- `session/manager.ts` `c816a8f24e4aef0b6b041aedf4bda983936df2dd44fc7f2aa89609c15c3ec5e2`
- `acp/client.ts` `2a65d7a6a883e8676c7bd33225dea0f7cc3e68f55fe5086b97eda014c0db130d`
- `package.json` `9360bad5585281ac6c862d48779e350f71ac1ec1ea81cde71b70e73ddcf070ab`
- `rules/competition.json` `a2979f983a9da79538d24df46739a4bf13b4a41dc72ab8d3ee3fb7760b51390d`
- `.probe/backup-wp1/board.db` `6d491f0b1c0b88994543614f5421803b84c5d406456487ec5bab2287ab5cf469`（348160 B，未动）

---

## 行为变更

**生产行为变更：无。** 三个模块还没有任何生产调用方：

- 策略引擎仍只读 `action/command_regex/text_regex/tool_regex`，不会因为 targets/denyTargets 自动 block/allow（P4-C）。
- `acp/client.ts`/`session/manager.ts` 不调用 `extractTargets`；真实命令/审批文本没有被扫描。
- Hub/快照/UI/config/rules 均未改；`verify:scope` 仍独立于 `verify:all`。
- 没有新增 SQLite 迁移，`user_version` 仍为 v2。

测试面变更：`verify:scope` 从 A 组 80 条扩到 **176 条**（新增 B 组 96 条，A 组 80 条未改）。B 组 span 断言按 `[start,end)` 修正为 22（测试笔误，见上）。

---

## 已知中间状态 / 已知问题

1. **未接策略引擎（P4-C）**：`matchTargets` 只返回数据；不在 targets 里的动作仍按原策略走，`denyTargets` 不参与判定。
2. **未接真实命令/审批路径（P4-C）**：`extractTargets` 目前只在 `verify-scope` 里被调用；`acp/client.ts`、`session/manager.ts`、Hub 快照都没有消费它。
3. **未做代理/UI/config（P4-D）**：不注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`，不改系统代理/防火墙；没有目标面板/创建任务目标输入；`config/**` 的 scope/proxy 段未加；`rules/competition.json` 未加 `no-out-of-scope`。
4. **IPv6 明确不支持**：所有 IPv6 形态（裸地址、方括号、CIDR、URL）在 `parseTarget` 中都返回 `unknown` + `ipv6-not-supported`，不猜测、不误判为 host。`extractTargets` 目前只把 IPv6 URL 放进 `unknowns`；裸 IPv6 token 不产生 candidate，也不进 `unknowns`（但 IPv6 内嵌的 IPv4 也不会被误提取）。P4-C 若需要按文本强制，需补裸 IPv6 token 扫描或直接拒绝含 `::` 的 token。
5. **不查 DNS**：域名 vs CIDR 永远是 `unknown`；域名 vs 域名/URL 是字符串 host 匹配；P4-C 若需要 DNS/解析结果，需要显式引入并承担网络副作用。
6. **不推断 URL 默认端口**：`http://example.com` 规范化成 `example.com`，不会自动补 `:80`；因此 target `example.com:80` 对不带端口的 URL 候选是 `out`。P4-C 若需要按 scheme 补默认端口，应在策略层显式做，并保持「target 显式端口必须匹配」的规则不变。
7. **CIDR 候选不匹配**：`matchTargets` 对候选本身是 CIDR 返回 `unknown`；CIDR 与 CIDR 的包含/相交语义留给 P4-C 定义。
8. **提取是保守启发式**：裸域名默认不提取（allowlist 默认空）；单标签 host 只认 `localhost`；Windows 路径中的 IP/host:port 用反斜杠 lookbehind 排除；复杂 shell 引号/转义/变量展开不做语义解析，可能漏提或把参数当目标。P4-C 应把 `unknowns` 当“需要人工确认”的信号，而不是自动放行依据。
9. **P4-A 的字符串级唯一约束仍在**：`targets` 表 `UNIQUE(task_id,value)` 不会把 `10.1.2.3` 与 `10.1.2.3:80`、大小写不同的 URL 视为同值；P4-B 只在读侧规范化，没有回写/去重迁移。
10. **span 语义**：candidate 的 `span` 是原文 `[start, end)`；URL 覆盖整段 URL，CIDR/IP/host:port 覆盖 token 本身；`unknowns` 只有原始字符串，没有 span。
11. **红测证据较弱**：`p4b-scope-red.txt` 是模块缺失导致的 `ERR_MODULE_NOT_FOUND`，不是断言级红；后续若要严格 TDD 证据，可先提交桩模块再跑断言红。
12. **multitask F 组 flaky（既有）**：`listTasks()` 同毫秒创建无 tie-break，F 组偶发 173/174；本轮未改 `verify-multitask.ts`/排序逻辑，复跑后 174/174，留 WP6 修。
13. **`verify:scope` 不在 `verify:all`**：保持独立，避免把纯函数测试混进 607 条全量链；门禁需单独跑。

---

## 下一手需要什么

- **P4-C（策略判定）**：先读 `policy/engine.ts` 现有 `RuleMatch/evaluate`（基线 `action/command_regex/text_regex/tool_regex`，block 机制写死、不可被 allow 覆盖）；加 `out_of_scope`/`target_regex` 时保持规则包数据化；在命令/审批进入策略前调用 `extractTargets` + `matchTargets`，把 `in/out/unknown` 映射成策略输入；`rules/competition.json` 的 `no-out-of-scope` 在 P4-C 加。先明确「候选是 CIDR」「域名 vs CIDR」两类 unknown 的策略含义（审批/拒绝/放行）。
- **P4-D（代理/UI/config）**：代理默认关、只注入环境变量；目标面板/创建任务目标输入；`config/**` 的 scope/proxy 段。不要把 P4-B 的纯函数当成“已经拦截”。
- 保持门禁：`verify:all` **607**、`verify:scope` **176**（A80+B96）、migration **73**、artifacts **324**、skills **149**、multitask **174**（单跑）、Electron **26**；`verify:scope` 保持独立。
- 若 WP5 需要新表：`user_version` 用 **v3**，不要回退/跳版本；迁移仍在 `open()` 内按版本顺序追加。
