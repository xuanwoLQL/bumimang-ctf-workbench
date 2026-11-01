# dropout — Crypto 606

## 结论
`flag{mask_seed_from_dropout}`

## 题面素材
`attachments/samples/samples.json` 只有一个 LWE 实例：

- `q = 7681`, `n = 32`, `m = 64`
- `A` 为 64×32 随机矩阵（模 q），`b` 为 64 维向量
- `masked_update` 为 28 字节：`7c53ddbd82faf811c0397982909a9498644d63fb50a6e697d7cf97f6`

## 识别
`b = A·s + e (mod q)`，名字 dropout 指秘密 `s` 是神经网络 dropout 掩码（0/1 向量）。
m=2n、q 很小，属于弱参数 LWE，可直接格约简。

## 攻击
Kannan embedding（维度 m+n+1 = 97）：

```
[ q·I_m      0     0 ]
[ A^T? ...   I_n   0 ]   (每列 A[:,j] 与单位向量)
[ b          0     1 ]
```

LLL(delta=0.99) 后即命中最后一位 ±1 的短向量，BKZ-20 复核唯一：

- `s = 10000001000001100011101001110100`（12 个 1）
- `e = b - A·s mod q ∈ {-1,0,1}^64`，`max|e| = 1`
- 残差分布：22 行为 0、42 行为 ±1；零残差行只有 22 行（<32），不存在 32 行全零子系统，必须格约简
- 该短解唯一（3^64 / 7681^32 ≪ 1）

## 解掩
```
ks   = SHA256(bytes(s))        # 32 字节 0x00/0x01 直接作为哈希输入
flag = masked_update XOR ks
     = flag{mask_seed_from_dropout}
```

## 复现（仅用附件，无需 Kali）
```
python evidence/verify_flag.py
```
输出见 `evidence/verify_flag_output.txt`，脚本内含断言：
`max|b - A·s| = 1`，且 `flag XOR ks == masked_update`。

## 独立复核（scribe）
不依赖上述 mask、也不做格约简，用中间相遇枚举（16+16 位分半，按行残差
`(b-A·s) mod q ∈ {-1,0,1}` 过滤）重解，全空间唯一解与上面完全一致：

```
python evidence/scribe_mitm.py
# 输出 evidence/scribe_mitm_output.txt：唯一解、12 个 1、FLAG 命中 MATCHED
```

细节见 `evidence/scribe_ledger.md`。

## 中间产物
- `evidence/solve_lwe.py` / `evidence/verify_lwe.py`：fpylll LLL+BKZ 求解与唯一性检查（Kali 侧运行）
- `evidence/keyguess.py`：密钥派生枚举，命中 `xor_sha256_bits_raw`
- `evidence/samples.bin` / `evidence/samples_bin.b64`：samples.json 的紧凑打包（供远端求解）
