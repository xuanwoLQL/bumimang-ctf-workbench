# Crypto · Off the Curve

## 结果

```text
flag{m3OqSILqXQDmrd5yHI98cgoQ6q3JZe6M4arDmaEa}
```

证据等级：E2。明文由 `rpt-042` 的 AES-256-GCM 解密得到，并完成
`context_digest` 与审计记录二次校验。

## 题目结构

Northstar Docs 的 SDK 使用一条很小的自定义曲线：

```text
p = 65519
a = 1
b = 7
n = 65444
G = (4, 17054)
```

报告 `rpt-042` 的加密流程是 ECIES 变体：

1. 客户端把 `d·Q` 作为 shared point。
2. 把 `encodeFull(sharedPoint)`、私有标量和上下文摘要送入 scrypt/HMAC KDF。
3. 使用 AES-256-GCM 加密报告。

## 漏洞一：空 HMAC key 的 JWT 提权

`/api/v1/auth/config` 暴露：

```json
{
  "implementation": "fast-jwt-compatible/6.2.3",
  "resolver": "async-kid"
}
```

未知 `kid` 使 async resolver 返回空字符串，fast-jwt 以空 HMAC key 验签。
攻击者可以自行签发 `role=admin` 的 JWT：

```python
header = {"alg": "HS256", "typ": "JWT", "kid": "probe-nokey"}
payload = {
    "role": "admin",
    "scope": ["projects:read", "reports:read", "keys:read",
              "admin", "diagnostics", "audit"],
}
```

签名密钥为空：

```python
sig = HMAC-SHA256(b"", b64url(header) + "." + b64url(payload))
```

`GET /api/v1/me` 返回：

```json
{
  "name": "Security administrator",
  "role": "admin",
  "permissions": {
    "audit": true,
    "diagnostics": true,
    "read": true,
    "register_keys": true
  }
}
```

## 漏洞二：invalid-curve oracle 泄露私钥

六个 legacy 公钥不在主曲线上，但旧客户端校验器仍标记 verified。管理端
`POST /api/v1/diagnostics/compat` 对每个 `key_id` 计算 `S=d·K`，并返回：

```text
tag = SHA256("DOCSHARE-DIAG\0" || key_id || nonce || encodeFull(S))[:16]
```

由于 off-curve 点的阶很小，可以离线枚举 `k·K` 与 tag 匹配，得到：

```text
d mod ord(K)
```

对四个 v3 key 做 CRT：

```text
d = 13450493
模数 1.459e14 > 2^32
```

即 32-bit 标量范围内的唯一解。

## 解密 rpt-042

`rpt-042` 的 recipient key：

```text
Q = decompress(02315f) = (12639, 7624)
sharedPoint = d·Q = (7234, 37652)
```

按照 `sdk.js` 的 scrypt+HMAC KDF 和 AES-256-GCM 解密：

```text
recovery_token=flag{m3OqSILqXQDmrd5yHI98cgoQ6q3JZe6M4arDmaEa}
```

## 复现

脚本需要当前实例地址；所有值都不写死在仓库中：

```powershell
$env:NORTHSTAR_BASE='http://<TARGET_HOST>:<TARGET_PORT>'
python scripts/off-the-curve/forge_admin.py
python scripts/off-the-curve/offcurve_dlog.py

$env:NORTHSTAR_RECORD="$PWD\evidence\off-the-curve-download.json"
$env:NORTHSTAR_PLAINTEXT_OUT="$PWD\evidence\off-the-curve-plaintext.txt"
python scripts/off-the-curve/decrypt_rpt042.py
python scripts/off-the-curve/verify_rpt042.py
```

`offcurve_dlog.py` 中保存的是本次实例的六个诊断 tag。若在新实例复现，需要
先运行 `forge_admin.py`，把新的 `key_id / compressed K / nonce / tag` 更新到
脚本后再做 CRT。

二次验证命令：

```powershell
Get-Content evidence\off-the-curve-plaintext.txt
```

关键结果：

```text
context_digest match = True
flag{m3OqSILqXQDmrd5yHI98cgoQ6q3JZe6M4arDmaEa}
```

## 修复建议

1. JWT resolver 拒绝空 key 和未知 `kid`，锁定算法与密钥来源。
2. 公钥导入必须执行完整曲线方程校验，不能只做格式兼容。
3. 所有 ECDH 实现拒绝非主曲线点和小阶点。
4. 不要把私有标量直接作为 KDF 绑定材料暴露给诊断接口。
5. 诊断 tag 应使用服务端随机 challenge 和不可逆的认证数据结构。

## 证据

- `evidence/off-the-curve-download.json`
- `evidence/off-the-curve-plaintext.txt`
- `evidence/off-the-curve-dlog.json`
- `scripts/off-the-curve/`
