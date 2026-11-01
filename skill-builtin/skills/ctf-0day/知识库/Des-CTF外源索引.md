# Des-CTF 外源参考索引

> 上游：[Dest1ny-Sec/Des-CTF-Knowledge](https://github.com/Dest1ny-Sec/Des-CTF-Knowledge)
> 固定提交：`03525c6104c6f9c9a8061f05c2d045ecc31428b2`（2026-09-23）
> 本地快照：`D:\agent\skill\skills\ctf-solver`
> 受控副本：`skill/外部参考/Des-CTF/`

## 什么时候开

- 核心 `知识库/` 没有命中，但题目像经典 Web / Misc / Crypto / 历史比赛题。
- 需要查 SSTI、PHP 代码审计、PHP 反序列化、文件包含、上传、SSRF、SQL/RCE 的
  经典 payload 或更多样例。
- 需要找同型大赛 WP、取证题案例，或 RSA / Base / CRC / USB / 隐写脚本目录。
- 只有在这时开外源；不要每次开局预读，也不要拿外源覆盖本技能的现场判据。

## 检索方式

```text
kb_search("SSTI", source="des", limit=8)
kb_search("内存取证 攻击者 IP", source="des", limit=8)
kb_search("RSA 共模", source="des", limit=8)
kb_search("SSTI", source="all", limit=12)
```

- `source="core"`：默认，只查核心知识库，行为与旧版一致。
- `source="des"`：查 1027 篇 WP 的结构化索引、142 篇精选正文、23 份深文和
  110 个脚本目录条目。
- `source="all"`：核心与外源同时查，按两路结果合并。
- 命中 `local_path` 时直接读 `外部参考/Des-CTF/<local_path>`；未收录正文的 WP
  用 `upstream_path` 到 `D:\agent\skill\skills\ctf-solver` 定点读取。

## 收录边界

- 全量索引：1027 篇 WP 的标题、赛事、年份、分类、标签、攻击链、观察与经验。
- 精选正文：37 篇取证类 + 105 篇高价值 Web 类，共 142 篇。
- 深度资料：23 个经典 Web/Misc 文档及分段索引。
- 脚本目录：110 个 Python 脚本的路径、用途摘要与大小，不在本技能内直接执行。
- 上游 WP 均标记 `images_removed: true`，依赖截图的题目必须结合原文链接复核。
- 上游整体为 MIT 汇编许可；文章和脚本可能保留原作者权利，详见
  `外部参考/Des-CTF/LICENSE-UPSTREAM.txt`。

## 维护

外源内容由 `scripts/des_ctf_sync.py` 从固定快照生成。更新上游前先确认提交差异，
不要直接编辑 `wp-index.jsonl` 或 `WP/`、`deep/` 下的副本。
