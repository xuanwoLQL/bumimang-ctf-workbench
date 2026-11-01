# Misc · Pickle-Me-Not

## 结果

```text
flag{5oXM93hnumDZYQQ48ed96uVK9usAFbsHuFJdeNnD}
```

## 题目结构

ModelHub Trust Center 模拟“权重-only 策略下的 legacy pickle 兼容导入”：

- `GET /api/v1/models`
- `GET /api/v1/artifacts?path=<object_key>`，只允许 `.json`
- `POST /api/v1/import-jobs/<id>/replay`，接受 `LEGACY\n` 前缀 pickle
- trusted `normal_reference.pt`
- quarantined `quarantine_snapshot.pt`

不能在本机直接 `pickle.loads` 不可信检查点。

## 路径穿越

artifact 过滤器在网关解码一次后判断 `.json`，存储层又解码一次：

```text
path=%252e%252e%252fquarantine%252f<file>.json
```

双重解码后变成：

```text
../quarantine/<file>.json
```

可读取 quarantine 下的 JSON 元数据。

## Replay oracle

二进制工件通过 `LEGACY\n + pickle` 交给隔离 worker 读取，不把不可信 pickle
放到本机 Python 进程。

关键对象：

```text
modelhub_compat.rebuild_legacy_token(
  tensor(ByteStorage '2', offset=19, size=(4,32), stride=(67,2)),
  'legacy-tar-bridge/quarantine-17',
  '6c6f61645f736166655f323032365f31',
  89,
  512947548
)
```

replay 连续请求会触发 `429 replay_limit`。重新创建本队自己的场景后计数器清零。

## Key derivation

从 safetensors index 的 `guard.kdf_salt` 找到真实 salt：

```text
69c429c475ee3c2c89aa14ae514d2c75
```

KDF 为 `mhkdf-sha256-v1`：

```text
prefix = global|route_id|nonce|storage_key|peer_salt_hex
block_i = SHA256(prefix || counter_be32)
```

从 strided view 取出 `data/2` 的 128 字节，异或 keystream 后：

```text
MODEL_IMPORT_REVIEW|tensor=guard.trace|flag{...}|END
```

## 复现命令

```powershell
python scripts/pickle-me-not/kdf_final.py
python scripts/pickle-me-not/verify_flag.py
```

脚本需要将目标地址、ticket、quarantine 工件按当前实例注入。不要对未知 pickle
使用普通 `pickle.load`。

## 证据

- `evidence/flag.txt`
- `evidence/blob_analysis.txt`
- `evidence/kdf_candidates.txt`
- `evidence/findings_scribe.md`
- `evidence/timeline.md`

## 复盘

- 关键不是构造 pickle RCE，而是把 replay worker 当作受限 oracle。
- 后缀过滤必须与真实存储路径在同一规范化层完成，否则双重解码会破坏信任边界。
- 重开场景会重置 replay 计数，这是最终拿到 salt 的转折点。
