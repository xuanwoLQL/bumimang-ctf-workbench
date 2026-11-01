# Crypto · Immobilizer

## 结果

```text
flag{top_byte_of_the_nonce}
```

## 题意

附件包含 secp256k1 的 40 组 ECDSA 签名：

```text
(r_i, s_i), msg_i = immobilizer|vin=LDC613P23A0000001|ctr=i
sealed = 27-byte ciphertext
```

z 的约定已验证为：

```text
z_i = SHA256(msg_i) mod n
```

40 个 `r` 互不相同，不能靠直接 nonce 复用恢复私钥。

## 关键弱点

每个 nonce 的实际位长最高只有 248 bit，且所有 nonce 的最高字节均为 0:

```text
k_i < 2^248
```

这是带泄漏界的小 nonce HNP。对 secp256k1 的 256-bit 模数，248-bit nonce
意味着每个 nonce 泄漏 8 bit 以上；40 组签名足以恢复私钥。

## 复现

```powershell
python scripts/immobilizer/analyze.py
python scripts/immobilizer/hnp.py
python scripts/immobilizer/final_verify.py
```

`hnp.py` 先做合成数据校准：

```text
k < 2^128  -> recover
k < 2^192  -> recover
k < 2^224  -> recover
k < 2^240  -> recover
k < 2^248  -> recover
k >= 2^248 -> fail
```

真实数据恢复：

```text
d(hex) = 8fd7fa690b0b0cf8f897127c005d3def0ce98e8dca000ab00205cd156818f097
d(dec) = 65062337734878525051969737001582398336729906718165769482557093642791334506647
```

用 `SHA256(d || d)` 作为重复 keystream 解 27 字节 sealed 数据，得到 flag。

最终校验：

```text
all sigs ok = True
re-encrypt matches = True
flag{top_byte_of_the_nonce}
```

## 证据

- `evidence/01-signature-analysis.txt`
- `evidence/04-hnp-cvp-40.txt`
- `evidence/08-recovered-key.txt`
- `evidence/11-flag.txt`
- `evidence/12-final-verify.txt`

## 教训

- ECDSA 只检查“nonce 不重复”不够，必须检查 nonce 的熵和位宽。
- 248-bit 看起来接近 256-bit，但 40 个样本上的 8-bit 泄漏已经足够做 HNP。
- 题目 flag 直接描述了这个弱点：`top_byte_of_the_nonce`。
