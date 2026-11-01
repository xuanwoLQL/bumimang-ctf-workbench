# 平台 MCP（awd-mcp）

> **它是什么**：把本技能的**知识库检索**与**本地武器**暴露成 MCP 工具，让 AI 直接调用，不必手打命令行。
> **位置**：`C:\Users\Administrator\.codex\vendor_imports\android_mcp_project\android_mcp\servers\awd_mcp\server.py`
> **注册**：`~\.claude.json` → `mcpServers.awd-mcp`（2026-10-10 注册；同批已有 js-reverse / frida-orchestrator / reverse-index / algo-lab / stitch）

---

## 一、★ 它**故意不含**平台写接口（纪律硬约束）

`SKILL.md` 的「平台接口纪律」是**最高优先级**：

```
> 本技能只负责「打」和「报告」。不允许调用打分平台的任何接口。
  · 不开靶场：不调 start_challenge / 任何"开启环境"动作
  · 不提交 flag：不调 submit / 任何"交答案"动作 ⇒ 找到就【报告】，提交由人工做
  · 不读 token：不读 Agent-Token / HBC_TOKEN，也不读 hbc.py 一类封好的接口脚本
```

**为什么这条这么硬（实测后果）**：多个 agent 同时调 `start_challenge` ⇒
平台限制「每账号同时只能开 1 个靶场」⇒ **自己开的新环境把正在打的那个顶掉了**，
而 flag 与实例强绑定 ⇒ **已到手的 flag 当场作废**。

⇒ **因此本 server 不实现** `hbc_start` / `hbc_submit` / 任何读 token 或改动平台状态的工具。
**历史教训**：2026-10-10 首版误把 `hbc_start`/`hbc_submit` 暴露出来（违反纪律），已全部移除；
`tests/smoke_test_awd_mcp.py` 里加了**纪律合规断言**，一旦重新出现 start/submit 类工具就会 FAIL。

---

## 二、工具清单（只有 2 个，都不碰平台）

| 工具 | 作用 | 说明 |
|---|---|---|
| `kb_search(query, regex?, limit?, context?, source?)` | **知识库只读检索** | `source=core`（默认）只查 `知识库/**/*.md`，保持旧行为；`des` 查 Des-CTF 的 1027 篇 WP 索引、142 篇精选正文、23 份深文和 110 个脚本目录；`all` 两边合并。返回「文件/行号/上下文」及外源路径字段。**纯本地文件读取** |
| `run_weapon(script, args?, timeout_sec?)` | **调 scripts/ 下的武器** | 只允许 `scripts/` 内的 `.py`；返回 stdout/stderr 尾部；**路径越界会被拒** |

**典型用法**：
```
kb_search("时间簇")                  → 定位判据所在文件与行号
kb_search("ADCS|ESC1", regex="1")    → 正则检索
kb_search("SSTI", source="des")      → 只查 Des-CTF 外源
kb_search("RCE", source="all")       → 核心 + 外源合并
run_weapon("iphdr_matrix.py", "--url http://T/ --value 127.0.0.1")
run_weapon("webbrute.py", "--url http://T/login --user admin --passwords p.txt --fail 密码错误 --confirm")
```

外源正文路径由 `DES_CTF_UPSTREAM` 指向上游快照，默认
`D:\agent\skill\skills\ctf-solver`。命中 `local_path` 时读技能内副本；未收录正文时按
`upstream_path` 到该快照定点读取。默认 `source="core"` 不得改成 `all`，否则会稀释核心判据。

---

## 三、与 `scripts/hbc.py` 的分工（**关键**）

| | 用途 | 谁能用 |
|---|---|---|
| **`hbc.py`（命令行）** | 平台查询/开环境/提交 | **仅人工**（agent 不许调，见 §一） |
| **`awd-mcp`（MCP 工具）** | 知识库检索 + 本地武器 | agent 可用 |

⇒ **agent 的产出是「报告 flag」**（值 / 在哪台机器哪个路径 / 什么手法拿到的），**提交由人工做**。

---

## 四、验收方式（改了它就跑这个）

```powershell
$v = "C:\Users\Administrator\.codex\vendor_imports\android_mcp_project\.venv\Scripts\python.exe"
$p = "C:\Users\Administrator\.codex\vendor_imports\android_mcp_project"
& $v "$p\android_mcp\tests\smoke_test_awd_mcp.py"
```
**预期 8 行全过**：
```
[1] initialize OK
[2] tools/list OK: 2 个工具 → ['kb_search', 'run_weapon']
[3] 纪律合规 OK: 无 start/submit 类工具
[4] kb_search('后门指纹') → 命中
[5] kb_search(SSTI, source=des) → 外源命中
[6] kb_search(SSTI, source=all) → 核心+外源命中
[7] run_weapon(...) → ok=True
[8] 路径越界防护 → 已拒
```
> 同目录 `smoke_test_mcp.py` 是**既有三个 MCP** 的冒烟测试；awd_mcp 用**单独文件**，避免改动别人的测试。

---

## 五、改它时的注意事项

1. **复用 `android_mcp.common.mcp_stdio.StdioMcpServer`** —— venv 里**没有官方 `mcp` SDK**，新写 server 必须用这套自研框架
2. **启动时藏控制台**（`_hide_own_console()`）—— MCP 宿主无控制台时 Windows 会弹一个可见窗口
3. **不持有业务状态** —— flag / 进度 / 凭据一律由 AI 传参或落台账，MCP 内不缓存（换会话就丢）
4. **别再加平台写接口** —— 加之前先回读 `SKILL.md` §平台接口纪律，并让 smoke test 的合规断言通过
5. **改 `~\.claude.json` 前先备份** —— 它有 20 个顶层键，手工编辑容易破坏格式
