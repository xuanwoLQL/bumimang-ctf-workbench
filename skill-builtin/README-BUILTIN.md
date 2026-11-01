# 内置最小技能库（不迷茫 V2）

> 这是随安装包分发的**最小可用知识库**，不是完整技能库。
> 生成日期：2026-10-25；内容清单与哈希见同目录 `manifest.json`。

## 1. 包含什么

| 包 | 内容 |
|---|---|
| `ctf-0day` | `SKILL.md`、`知识库/**`（33 篇自有知识库）、`scripts/`（webbrute、iphdr_matrix、react2shell、selfcheck、台账模板） |
| `ctf-solver` | `SKILL.md`、`AI-SEARCH-INDEX.md`、`PAYLOAD-CHEATSHEET.md`、`*.idx.md`、`CTF常用脚本及工具/SCRIPTS-INDEX.md`、`LICENSE` |

## 2. 刻意不包含什么（以及为什么）

| 不包含 | 原因 |
|---|---|
| `ctf-solver/CTF大赛WP集合/**` | 第三方 WP 全文，未确认逐篇授权；不默认分发 |
| `ctf-solver/WP汇总/**` | 同上 |
| `ctf-solver/CTF常用脚本及工具/**/` 的脚本正文 | 第三方脚本可能各有许可；只随包分发索引 |
| `ctf-0day/外部参考/**` | 第三方 WP 索引/全文 |
| `ctf-0day/scripts/hbc.py`、`des_ctf_sync.py` | 平台接口/同步脚本；平台纪律禁止自动开环境/提交/读 token |

因此，内置包检索到的 `*.idx.md` 可能指向未随包分发的全文。`skill_read` 对缺失文件会返回可读错误；此时：

1. 用 `skill_search` 找包里实际存在的文档；或
2. 配置外置完整技能库（见下）。

## 3. 如何切换到完整技能库

优先级（代码 `main/skill/index.ts`）：

1. `BUMIMANG_SKILL_DIR` 环境变量（显式指向不存在目录会直接报错，不静默回退）
2. `config/app.json` 的 `skillDir`
3. 开发态 `<repo>/../skill`
4. 打包态 `resources/app-source/skill`（本内置包）

设置外置后，UI 技能库状态会显示“外置（env/config）”；未设置时显示“内置（packaged）”。

## 4. 平台纪律

内置 `ctf-0day/SKILL.md` 中的平台纪律仍然有效：

- 不调用比赛平台开环境/提交/批量提交/读取 token 接口；
- flag/答案由人工提交；
- 只做授权靶场内的侦察与取证。

## 5. 索引说明

- `skills/ctf-0day/scripts/script-index.jsonl` 由 `manifest.json` 的生成流程构建；
- 内置包没有 `wp-index.jsonl`，所以 `skill_list` 的 `wps=0` 是预期行为；
- 文档索引只读开头 20 行/8KB，完整内容用 `skill_read` 按行读取。

## 6. 许可

- `ctf-0day`：项目自有技能内容。
- `ctf-solver`：MIT License（见 `skills/ctf-solver/LICENSE`）；其 LICENSE 明确说明部分文章/脚本来自公开来源、可能各有许可，因此内置包只分发索引与自有内容，不分发第三方全文。
