---
name: ctf-solver
description: |
  经典 CTF 解题知识库（Web / Misc / Crypto / Reverse / 取证方向）。
  内容：SQL 注入、命令执行/RCE、文件上传、文件包含、SSRF、SSTI、JWT、PHP 反序列化、
  PHP 代码审计、图片隐写、音频隐写、压缩包攻击共 12 篇深度文章（每篇带 .idx.md 分段索引）；
  PAYLOAD-CHEATSHEET（10 类高频 payload）；1027 篇历年大赛 WriteUp；50+ 现成解题脚本；
  sqlmap/ffuf/Dirsearch/Wireshark/tshark/Volatility 工具速查。
  必须触发关键词：CTF、ctf 题、解题、writeup、wp、payload、SQL注入、命令执行、RCE、
  文件上传、文件包含、SSRF、SSTI、JWT、反序列化、代码审计、隐写、图片隐写、音频隐写、
  压缩包、CRC、misc、crypto、密码学、RSA、流量分析、内存取证、reverse、逆向、pwn、
  ctf-solver、找同类 WP、找现成脚本。
  触发边界：本技能做「CTF 单题 / 出题 / 找 payload / 找同类 WP / 找现成脚本」；
  「授权靶场实战渗透 + 内网 + 应急响应」由 ctf-0day 技能负责，本技能不做现场攻防判据。
  线上真实资产（SRC 语境）不归本技能。
---

# CTF 解题知识库（ctf-solver）

> 经典 CTF 题的第二大脑：从「这题是什么」→「怎么解」→「现成 payload / 脚本 / 同类 WP」。
> 与 `ctf-0day`（靶场渗透 + 应急）互补：**做 CTF 单题查这里，打实战靶场用 ctf-0day**。

## 检索入口（先读索引，再按需加载，别通读）

1. **`AI-SEARCH-INDEX.md`** —— 全局检索索引（~250 行）。收到 CTF 题先读它，定位到具体文章/脚本/WP。
2. **`PAYLOAD-CHEATSHEET.md`** —— 10 类高频 payload 速查（做题直接翻）。
3. **12 篇深文** —— 每篇配 `.idx.md` 分段索引；长文（如 PHP 反序列化 6959 行）用 `Read offset=行号 limit=行数` 定点读，禁止通读全文。
4. **`CTF常用脚本及工具/SCRIPTS-INDEX.md`** —— 50+ 脚本速查，命中即用。
5. **1027 篇 WP** —— `CTF大赛WP集合/articles/`，按大赛名/题名 grep 文件名定位。

## 按题型快速路由

| 题型 | 读哪 | 脚本 |
|---|---|---|
| SQL 注入 | `SQL.md` | sqlmap |
| 命令执行 / RCE | `命令执行.md` | — |
| 文件上传 | `文件上传漏洞.md` | — |
| 文件包含 / LFI | `文件包含.md` | 日志匹配脚本 |
| SSRF | `SSRF漏洞.md` | — |
| SSTI | `SSTI.md` | — |
| JWT | `JWT.md` | jwt-cracker |
| PHP 反序列化 | `PHP反序列化漏洞总结.md` | python-Pickle 序列化 |
| PHP 代码审计 | `php代码审计.md` | — |
| 图片隐写 | `图片隐写.md` | 宽高爆破 / 盲水印 / RGB 转图 / steghide |
| 音频隐写 | `音频隐写.md` | — |
| 压缩包 | `压缩包总结.md` | CRC32 爆破 / 批量解压 / 明文攻击 |
| 编码 / 密码 | `python-note.md` + 脚本目录 | Base / RSA / 古典密码 / md5 爆破 |
| 流量分析 | `工具使用/` | USB / TTL / 曼彻斯特 / 流量提取 |
| 取证 (Memory) | `工具使用/内存取证秒杀所有命令.md` | — |
| Reverse | `reverse/` | xor / Brainfuck / 文件异或 |
| PWN | 大赛 WP 集合 grep PWN | — |

> 完整逐题型映射（优先级阅读 / 可用脚本 / 相关 WP）见 `AI-SEARCH-INDEX.md`。

## 找同类题 WP

```bash
# 按方向搜文件名
ls CTF大赛WP集合/articles/ | grep -iE "Web|SQL|SSRF|SSTI|JWT|upload|反序列化"
ls CTF大赛WP集合/articles/ | grep -iE "隐写|取证|流量|内存|USB|图片|音频"
ls CTF大赛WP集合/articles/ | grep -iE "RSA|Crypto|密码|AES|ECC"
# 搜正文
grep -rl "wakeup\|反序列化" CTF大赛WP集合/articles/ | head
```

## 脚本调用

脚本在 `CTF常用脚本及工具/<分类>/`，绝大多数是 Python，直接 `python <路径>/<脚本>.py`。
先查 `CTF常用脚本及工具/SCRIPTS-INDEX.md` 拿到入口文件名与用途，再按脚本内说明传参。

## 许可与边界

- 内容来源公开渠道（ctfiot.com 等），MIT 汇编许可；文章/脚本可能保留原作者权利（见 `LICENSE`）。
- 仅供 CTF 竞赛训练、授权安全测试与学习；不得用于未授权攻击。
- 本技能是「知识库 + 脚本」，不含实战打靶/应急的现场判据与平台纪律；实战靶场走 `ctf-0day`。
