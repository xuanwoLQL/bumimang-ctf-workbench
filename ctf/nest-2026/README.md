# 第九届“强网”拟态防御国际精英挑战赛预选赛

> 比赛时间：2026-10-31 10:00 至 2026-11-01 12:00（Asia/Shanghai）  
> 参赛队：不迷茫队  
> 结果：平台可访问 24 题，完成 18 题。排行榜截图为第 157 名、7547 分；
> 本地终态快照按动态分值折算为 7555 分。

本目录保存本次比赛可公开的题目记录、flag、复现脚本和 Writeup。

## 公开范围

- 已公开题目与比赛结果。
- 本地证据中能够确认的已接受 flag。
- 已脱敏的真实靶机复现逻辑、关键脚本和回显。
- 平台已判定完成、但本地没有保留 flag 原文的题目会明确标记为“证据缺口”，
  不猜测、不伪造。

## 题目结果

完整台账见 [competition-ledger.md](competition-ledger.md)。

| 题名 | 方向 | flag |
| --- | --- | --- |
| Ghost-in-the-Queue | Web | `flag{MyGyp8qmPOFVEpcqUcFUuCFkTxrlaMGxr7tqL076}` |
| Undercurrent | Web | `flag{OnID0LXdWhQNFIRM47xSPKCbbAcr8TiQaSn8PnHd}` |
| Pending Review | Pwn | `flag{Y2IocPvKVi7x5BQKH14XtwDIuL5tye0Vnl05rtNv}` |
| Smart Surveillance Camera | Pwn | `flag{a99b94028914616a52ee3710af475836}` |
| dropout | Crypto | `flag{mask_seed_from_dropout}` |
| Immobilizer | Crypto | `flag{top_byte_of_the_nonce}` |
| Off the Curve | Crypto | `flag{m3OqSILqXQDmrd5yHI98cgoQ6q3JZe6M4arDmaEa}` |
| FilmReader | Misc | `flag{n0_m0d3l_r34d5_7h15_d33p}` |
| Pickle-Me-Not | Misc | `flag{5oXM93hnumDZYQQ48ed96uVK9usAFbsHuFJdeNnD}` |
| LLM Pipeline | Misc | `flag{k7XYBQAi5LAwEnII6RKmYngWBT2hcmJH1iIxw6Kg}` |
| UAE | Misc | `flag{dr34m_0f_n01s3}` |
| Causal Mosaic | Misc | `flag{W3nxZB8RVy4tcddDVAvpHIo8}` |
| SilentWeights | Misc | `flag{w31ghts_d0nt_l13_but_th3y_wh1sp3r}` |
| Wasmnesia | Reverse | `flag{DN72WGbTvmLJU9JVX1o9GWLE9DiSZdarl3ixBDao}` |

本地保留并确认的已接受 flag 共 **14** 个。平台已完成但本地未保留 flag
原文的题目为：Premaster、SilGate、Bootleg Update、Crossed Signals。

## Writeup

完整索引见 [writeups/README.md](writeups/README.md)。

- [Web · Ghost-in-the-Queue](writeups/web-ghost-in-the-queue.md)
- [Web · Undercurrent](writeups/web-undercurrent.md)
- [Web · Crossed Signals](writeups/web-crossed-signals.md)
- [Pwn · Pending Review](writeups/pwn-pending-review.md)
- [Pwn · Smart Surveillance Camera](writeups/pwn-smart-surveillance.md)
- [Pwn · SilGate](writeups/pwn-silgate.md)
- [Crypto · dropout](writeups/crypto-dropout.md)
- [Crypto · Immobilizer](writeups/crypto-immobilizer.md)
- [Crypto · Off the Curve](writeups/crypto-off-the-curve.md)
- [Crypto · Premaster](writeups/crypto-premaster.md)
- [Misc · FilmReader](writeups/misc-filmreader.md)
- [Misc · Pickle-Me-Not](writeups/misc-pickle-me-not.md)
- [Misc · LLM Pipeline](writeups/misc-llm-pipeline.md)
- [Misc · UAE](writeups/misc-uae.md)
- [Misc · Causal Mosaic](writeups/misc-causal-mosaic.md)
- [Misc · SilentWeights](writeups/misc-silentweights.md)
- [Reverse · Wasmnesia](writeups/reverse-wasmnesia.md)
- [Reverse · Bootleg Update](writeups/reverse-bootleg-update.md)

## 复现约定

- 所有靶机地址均写作 `<TARGET_HOST>` / `<TARGET_PORT>`，实际地址由比赛平台动态下发。
- 平台账号、密码、DES key、JWT、Cookie 不进入仓库。
- 仅复现已授权比赛题目；不要将脚本指向未授权目标。
- 附件哈希与文件名用于确认题目边界。挑战附件不随仓库重新分发时，脚本需要手工放入
  `attachments/`。

## 目录

```text
ctf/nest-2026/
├─ competition-ledger.json
├─ competition-ledger.md
├─ curated-flags.json
├─ evidence/
├─ scripts/
└─ writeups/
```
