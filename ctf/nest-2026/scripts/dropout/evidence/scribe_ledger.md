# dropout — scribe 台账（独立复核）

- 题目：dropout · Crypto · 606 分 · 142 队已解
- 附件：`attachments/samples/samples.json`，SHA256 = `BFC91ADC4F577207D0CC84A8F968C836D3567843E748B61E6A97E2076C53275D`
- 参数：q=7681, n=32, m=64, A 64×32, b 64 维, masked_update 28 字节
- 结论：**flag{mask_seed_from_dropout}**（E2，证据见 `evidence/scribe_mitm_output.txt`）

## 时间线（2026-10-31，本机时间）

| 时间 | 动作 | 命令 / 产物 | 结论 | 证据级 |
|---|---|---|---|---|
| 20:03:40 | 队友产出 z3 尝试脚本 | `evidence/solve_z3.py` | 未作为最终路线 | E1 |
| 20:04:37 | scribe 复跑队友验证脚本 | `python evidence/verify_flag.py` → `evidence/scribe_verify_run1.txt` | max\|b-A·s\|=1，FLAG=flag{mask_seed_from_dropout}，roundtrip OK | E2 |
| 20:04:46 | 写 z3 独立求解 | `evidence/scribe_independent.py` | z3 在 64 条模方程上 120s 未收敛，转中间相遇 | E0（失败尝试） |
| 20:07:12 | 写中间相遇求解 | `evidence/scribe_mitm.py` | 2^16 × 2^16 分半、按残差行过滤 | — |
| 20:07:17 | 运行并落盘 | `python evidence/scribe_mitm.py` → `evidence/scribe_mitm_output.txt` / `.json` | 唯一解 mask=`10000001000001100011101001110100`（12 个 1），e∈{-1,0,1}，FLAG 命中 | E2 |

## 独立求解要点
- 把 32 位 0/1 mask 拆成低 16 位与高 16 位，各枚举 65536 种。
- 用第 0 行做 join：要求 `(b0 - A0·s) mod q ∈ {-1,0,1}`，候选约 5.2 万/块。
- 再用其余 63 行同时过滤 `(b - A·s) mod q ∈ {0,1,q-1}`。
- 全空间仅 1 个解 → 唯一性由枚举直接给出（不依赖 3^64/q^32 估计）。
- 该解与队友用 Kannan embedding + LLL/BKZ 得到的 mask 完全一致，SHA256 派生 keystream 相同。

## 复现（工作目录 = 任务根）
```
python evidence/verify_flag.py
python evidence/scribe_mitm.py
```
两者都会打印 `FLAG = flag{mask_seed_from_dropout}`；后者额外打印 `MATCHED` 行并写 `evidence/scribe_mitm_output.json`。

## 备注
- `evidence/scribe_independent_output.txt` 是被中止的 z3 尝试的残缺输出，不作为证据。
- 本轮未使用 `reference/wp`：题面参数已足够定位为弱参数 LWE + 流式掩码，直接复现更快。
- 未开靶机；本题为离线附件题，无需实例。
