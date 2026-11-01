# dropout · Crypto — Writeup（最终版）

- **状态**：已解，平台已接受
- **flag**：`flag{mask_seed_from_dropout}`
- **主复现**：16+16 位中间相遇（meet-in-the-middle）枚举 + SHA256 流式解掩
- **交叉验证**：`evidence/verify_flag.py` 断言；Kannan embedding + sympy LLL 归档运行（失败路径，见 §7）

---

## 1. 题目信息

| 项目 | 值 |
|---|---|
| 题名 | dropout |
| 方向 | Crypto（crypto） |
| 题目分值 | 606（解题时） |
| 已解队伍 | 142 |
| 附件 | `samples.zip` → `attachments/samples/samples.json` |
| 靶机 | 无（纯离线附件题，未开实例） |
| 平台结果 | `is_pass=true` `score=534` `duplicate=false` |

题目描述只有单词 “dropout”。结合附件内容可判定：`dropout` 指神经网络训练中的 dropout 掩码，秘密向量是一个 0/1 稀疏掩码。

---

## 2. 附件结构

`samples.zip` 解压后只有一个文件，重命名为 `samples/samples.json`。JSON 顶层键：

```
q, n, m, A, b, masked_update
```

实测（`python` 读入后打印）：

| 字段 | 形状 / 值 |
|---|---|
| `q` | 7681 |
| `n` | 32 |
| `m` | 64 |
| `A` | 64 × 32 矩阵，元素在 `[0, q)` |
| `b` | 长度 64 的向量，元素在 `[0, q)` |
| `masked_update` | 28 字节，hex = `7c53ddbd82faf811c0397982909a9498644d63fb50a6e697d7cf97f6` |

注意 `masked_update` 只有 28 字节，而 SHA256 输出 32 字节；解掩时只取 keystream 前 28 字节（等价于对 update 做了截断），这一点在 §9 会再次强调。

---

## 3. 数学模型

附件给出的是一个标准 LWE（Learning With Errors）实例：

```
b = A · s + e  (mod q)
```

- `A ∈ Z_q^{64×32}`，`b ∈ Z_q^{64}`，`q = 7681`
- 未知量：`s ∈ Z_q^{32}`（秘密），`e ∈ Z_q^{64}`（误差）
- 已知量：`A, b, q, n, m`
- 目标：恢复 `s`，再用 `s` 派生密钥解开 `masked_update`

之所以可解，是因为参数异常弱：`m = 2n`、`q` 只有 7681，且 `s`、`e` 的取值空间都极小（见 §4）。常规 LWE 的安全性依赖 `q` 大、误差连续，这里完全不成立。

---

## 4. dropout 的稀疏秘密解释

把题名和 `masked_update` 联系起来：

- `s ∈ {0,1}^32` 是一个 **dropout 掩码**：1 表示该维度保留，0 表示被丢弃。
- 掩码不是任意的，实测只有 **12 个 1**（32 维中保留 12 维）。
- 误差 `e` 也不是高斯噪声，而是 `e ∈ {-1,0,1}^64`，实测 `max|e| = 1`。
- 残差分布：64 行中 **22 行为 0**，其余 **42 行为 ±1**（其中 **23 个 +1、19 个 −1**）。

因为只有 22 行残差为 0（< 32），**不存在 32 行全零的子系统**可以直接解线性方程组；必须做格约简或穷举/中间相遇。

唯一性估计（黑板已确认的事实）：满足 `e ∈ {-1,0,1}^64` 的候选比例约为 `3^64 / 7681^32 ≪ 1`，因此短解唯一。本 WP 的中间相遇是**穷尽全空间**验证唯一性，不依赖该概率估计。

---

## 5. 主解法：16+16 位中间相遇（获胜复现）

直接枚举 `s ∈ {0,1}^32` 是 `2^32 ≈ 4.3×10^9` 次，Python 不可行。利用线性结构拆半：

### 5.1 拆分

把 32 位掩码拆成低 16 位与高 16 位：

```
s = s_low  |  (s_high << 16),    s_low, s_high ∈ {0,1}^16
A·s = A[:, :16]·s_low + A[:, 16:]·s_high   (mod q)
```

### 5.2 预计算两张表

```python
idx   = arange(2**16)
bits1 = (idx[:,None] >> arange(16)) & 1      # 2^16 × 16
S1    = (bits1 @ A[:, :16].T) % q             # 2^16 × 64
S2    = (bits2 @ A[:, 16:].T) % q             # 2^16 × 64
```

即 `S1[m1] = A[:, :16]·bits(m1) mod q`，`S2[m2]` 同理。

### 5.3 用第 0 行做 join

对任意候选，`(b - A·s) mod q` 的每个分量都必须落在 `{0, 1, q-1}`（对应 `e ∈ {0, 1, -1}`）。先只用第 0 行剪枝：

```
target = (b[0] - S2[m2][0]) mod q
需要 S1[m1][0] ∈ {target-1, target, target+1} mod q
```

把 `S1[·][0]` 建成哈希桶，枚举 `m2` 时做 3 次查表即可得到候选 `(m1, m2)` 对。每 2048 个 `m2` 一块，候选约 5.2 万对（总候选量约 `2^32 × 3 / 7681 ≈ 1.7×10^6`）。

### 5.4 全 64 行过滤

对每个候选计算

```
R = (S1[m1] + S2[m2] - b) mod q
```

仅保留 **所有 64 个分量都满足 `R_i ∈ {0,1,q-1}`** 的候选（`q-1 = 7680` 即 `-1`）。

### 5.5 结果

全空间**恰好 1 个解**：

```
total solutions with s in {0,1}^32 and e in {-1,0,1}^64: 1
mask = 10000001000001100011101001110100   (12 个 1)
e set = [-1, 0, 1]   max|e| = 1
```

该解与 `verify_flag.py` 中由 fpylll LLL/BKZ 得到的掩码逐位一致，SHA256 派生值一致。

---

## 6. 恢复出的 s 结构

```
s = 10000001000001100011101001110100   (二进制，最高位在左)
```

- 长度 32，**12 个 1**（bit 位置按 0 起算）：`0, 7, 13, 14, 18, 19, 20, 22, 25, 26, 27, 29`
- 按 1 起算即第 `1, 8, 14, 15, 19, 20, 21, 23, 26, 27, 28, 30` 维被保留
- 作为 32 字节序列（每字节 0x00/0x01）：

```
0100000000000001000000000001010000000101010001000001010100010000
```

- 误差 `e`：22 个 0，23 个 +1，19 个 −1；`||e||² = 42`，`max|e| = 1`
- 短向量 `(e, -s, 1)` 的欧氏范数平方 = `42 + 12 + 1 = 55`，`||·|| ≈ 7.42`

---

## 7. 失败路径：Kannan embedding + sympy LLL（归档运行，符号归一化失败）

这一节如实记录另一条尝试，它**不是**最终获胜复现。

### 7.1 格基构造（`evidence/solve_local.py`）

维度 `d = m + n + 1 = 97`，基矩阵 `M` 为：

```
        [ q·I_m        0        0 ]   ← m 行，模数对角块
M  =    [ A^T           I_n      0 ]   ← n 行，第 j 行为 (A[:,j], e_j)
        [ b             0        1 ]   ← 1 行，目标向量 + 嵌入位
```

对应代码：

```python
M = Matrix.zeros(97, 97)
for i in range(m):          M[i, i] = q
for j in range(n):
    for i in range(m):      M[m + j, i] = A[i][j]
    M[m + j, m + j] = 1
for i in range(m):          M[m + n, i] = b[i]
M[m + n, m + n] = 1
R = M.lll(delta=QQ(99, 100))
```

### 7.2 符号关系

基向量的整数组合（系数 `k ∈ Z^m, c ∈ Z^n, t ∈ Z`）为

```
( q·k + A·c + t·b ,  c ,  t )
```

取 `t = 1, c = -s, k = 0`，得到

```
( b - A·s , -s , 1 ) = ( e , -s , 1 )
```

即：末位为 `+1` 的短向量中，**第 `m..m+n-1` 个分量是 `-s`**，所以正确归一化是

```
t = row[-1]          # ±1
mask = [ -t * row[m+j] for j in range(n) ]
```

（先乘以 `t` 把末位统一成 `+1`，再取负。）若不按此归一化、或只尝试单一符号，就会把 `-s` 当成 `s` 去校验，从而全部候选被拒。

### 7.3 归档输出与失败

`evidence/solve_local_output.txt` 记录的那次运行：

```
q,n,m = 7681 32 64 | |masked_update| = 28 bytes
LLL done in 93.9s, dim=97
short vectors with last coord +-1: 2
AssertionError: no short solution found
```

即 LLL 在 93.9 秒完成、确实出现了 2 条末位为 ±1 的短向量，但候选过滤阶段因**符号归一化/候选校验**处理不当而全部拒绝，脚本停在 `assert best is not None`。

补充说明（版本差异）：该输出文件时间戳为 `20:02:01`，早于 `solve_local.py` 的最后修改时间 `20:02:07`，说明归档输出对应的是**旧版脚本**。当前版本已改为对每条候选同时尝试 `c` 与 `-c` 两种符号；对该版本复跑可成功（85.4s，输出 `evidence/scribe_solve_local_rerun.txt`），但它仍只作为交叉验证，**本文的获胜复现链以 §5 的中间相遇 + `verify_flag.py` 为准**。

---

## 8. masked_update 解密

`masked_update` 是流式掩码，不是分组密码（AES-CTR/ChaCha20、Python `random` 等均已排除，见黑板死路）。密钥直接由掩码字节的 SHA256 给出：

```python
mb = bytes(mask)                      # 32 字节，每字节 0x00 或 0x01
ks = hashlib.sha256(mb).digest()      # 32 字节
flag = bytes(c ^ k for c, k in zip(mu, ks))   # mu 仅 28 字节，取 ks 前 28 字节
```

实测中间值：

```
mask bytes   = 0100000000000001000000000001010000000101010001000001010100010000
sha256(mask) = 1a3fbcdaf9979962ab660ae7f5fecbfe16220ea434d489e7b8bae38b10185e4d
masked_update= 7c53ddbd82faf811c0397982909a9498644d63fb50a6e697d7cf97f6
FLAG         = flag{mask_seed_from_dropout}
```

反向验证：`flag XOR ks == masked_update`（28 字节）成立，说明解掩与重新掩码可往返。

---

## 9. 精确复现命令

工作目录必须切换到本题复现目录（`samples.json` 使用相对路径）：

```powershell
cd .\scripts\dropout

# 1) 断言式验证：检查 b - A·s ∈ {-1,0,1}，并解掩得到 flag
python evidence\verify_flag.py

# 2) 独立的中间相遇求解：从 samples.json 重新解出唯一 mask 并解掩
python evidence\scribe_mitm.py

# 3)（可选，交叉验证）sympy 精确 LLL 版本
python evidence\solve_local.py
```

对应输出文件：

- `evidence/verify_flag_output.txt`
- `evidence/scribe_mitm_output.txt`、`evidence/scribe_mitm_output.json`
- `evidence/scribe_solve_local_rerun.txt`

> 本机 `Tee-Object` 写出的 `.txt` 是 UTF-16LE（带 BOM），用 `Get-Content` 或 `open(..., encoding='utf-16')` 读取；直接按 UTF-8 读会显示为“二进制”。

---

## 10. 验证输出

### 10.1 `python evidence/verify_flag.py`

```
LWE check: max|b-A*s| = 1  values set = [-1, 0, 1]
mask_bytes  = 0100000000000001000000000001010000000101010001000001010100010000
sha256(mask)= 1a3fbcdaf9979962ab660ae7f5fecbfe16220ea434d489e7b8bae38b10185e4d
masked_update= 7c53ddbd82faf811c0397982909a9498644d63fb50a6e697d7cf97f6
FLAG        = flag{mask_seed_from_dropout}
OK: reproducible
```

脚本内含三处断言，均可通过：`max|b-A·s| ≤ 1`；重掩码等于原 `masked_update`；`flag == b'flag{mask_seed_from_dropout}'`。

### 10.2 `python evidence/scribe_mitm.py`（关键行）

```
tables built: (65536, 64) (65536, 64) q= 7681
...
chunk 10240: candidates=  52481 surviving=1
...
total solutions with s in {0,1}^32 and e in {-1,0,1}^64: 1
mask      = 10000001000001100011101001110100 ones=12
e set     = [-1, 0, 1] max|e| = 1
sha256    = 1a3fbcdaf9979962ab660ae7f5fecbfe16220ea434d489e7b8bae38b10185e4d
FLAG      = flag{mask_seed_from_dropout}
roundtrip = True
MATCHED flag{mask_seed_from_dropout}
```

`total solutions ... : 1` 是穷尽全空间得到的唯一性结论。

---

## 11. Flag

```
flag{mask_seed_from_dropout}
```

（原文逐字提交，无空格、无换行。）

黑板记录：事实 `flag{mask_seed_from_dropout}`，证据级 **E2**，witness `evidence/flag.txt`。

---

## 12. 平台提交结果

```
is_pass=true  score=534  duplicate=false
```

动态分从题面 606 降至 534，属正常计分变化；`duplicate=false` 表示首次有效提交。

---

## 13. 时间线（2026-10-31，本机时间）

| 时间 | 事件 | 产物 |
|---|---|---|
| 19:52 | 开始分析附件，确认 JSON 结构与 `q,n,m` | `evidence/analyze1.py` |
| 19:54–19:57 | 线性/残差试探，打包 `samples.json` 供远端求解 | `evidence/try_linear.py`、`samples.bin` |
| 19:58 | fpylll LLL/BKZ 求解脚本（Kali 侧） | `evidence/solve_lwe.py`、`verify_lwe.py` |
| 19:59 | 密钥派生枚举命中 `xor_sha256_bits_raw`；写完 `verify_flag.py` 并跑通 | `evidence/keyguess.py`、`verify_flag_output.txt` |
| 20:02 | sympy 精确 LLL 归档运行：93.9s 后因符号归一化失败 | `evidence/solve_local.py`、`solve_local_output.txt` |
| 20:03 | z3 直接 Mod 编码尝试，120s 未收敛（放弃） | `evidence/solve_z3.py` |
| 20:04 | scribe 复跑 `verify_flag.py`，独立确认 | `evidence/scribe_verify_run1.txt` |
| 20:07 | 16+16 中间相遇全空间求解，唯一解，flag 命中 | `evidence/scribe_mitm.py`、`scribe_mitm_output.txt` |
| — | 平台提交通过（`is_pass=true score=534 duplicate=false`） | 平台回执 |

---

## 14. 踩坑清单

1. **LLL 行的符号归一化**：末位 `t=±1` 时，行内 `s` 分量是 `±s`；必须先乘 `t` 统一末位为 `+1`，再取负得到 `mask`。归档版只做单符号校验，导致 2 条短向量全部被拒，报 `no short solution found`。
2. **归档输出与脚本版本不一致**：`solve_local_output.txt`（20:02:01）早于脚本最后修改（20:02:07），看到失败输出时先核对 mtime，避免误判脚本现状。
3. **不能靠“零残差行”直接解方程**：只有 22 行残差为 0（< 32），凑不出 32×32 的可逆子系统。
4. **`2^32` 暴力不可行**：必须利用线性结构拆 16+16 做中间相遇；只用第 0 行 join 后候选约 170 万，再全行过滤。
5. **`masked_update` 只有 28 字节**：SHA256 是 32 字节，`zip` 自动截断到 28，XOR 时不要越界或补零。
6. **掩码字节是 0x00/0x01，不是 ASCII `'0'/'1'`**：`bytes(mask)` 与 `b'1000...'` 的哈希完全不同；各种种子/编码枚举失败多因踩此坑。
7. **残差要中心化**：模 q 后的 `7680` 必须映射为 `-1`，否则 `max|e|` 判断会失败。
8. **z3 直接 `Mod` 整数编码很慢**：64 条模方程 + 32 个布尔变量，120s 内未给模型，不适合作为首选。
9. **`Tee-Object` 输出是 UTF-16LE**：证据文件按 UTF-8 读会显示“binary file”，需按 UTF-16 解码。
10. **AES/ChaCha/PRNG 方向是死路**：已系统枚举均无命中，不要重复投入；密钥就是 `SHA256(bytes(s))`。

---

## 15. 证据清单

| 文件 | 作用 | 等级 |
|---|---|---|
| `attachments/samples/samples.json` | 题目原始附件（SHA256 `BFC91ADC…C53275D`） | E2 |
| `evidence/verify_flag.py` + `verify_flag_output.txt` | 断言式验证，输出 flag | E2 |
| `evidence/scribe_mitm.py` + `scribe_mitm_output.txt` | 独立全空间求解，唯一解 + flag | E2 |
| `evidence/flag.txt` | flag 原文落盘 | E2 |
| `evidence/solve_local_output.txt` | sympy LLL 归档失败记录（失败路径） | E1 |
| `evidence/scribe_solve_local_rerun.txt` | 当前 sympy LLL 版复跑（交叉验证） | E1 |
| `evidence/scribe_ledger.md` | scribe 台账 | E1 |
