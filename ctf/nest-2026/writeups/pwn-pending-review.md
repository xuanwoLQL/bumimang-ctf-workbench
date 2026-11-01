# Pwn · Pending Review

## 结果

```text
flag{Y2IocPvKVi7x5BQKH14XtwDIuL5tye0Vnl05rtNv}
```

## 入口

目标是 BenchLink gateway 的 `httpd`：

- HTTP：`http://<TARGET_HOST>:<TARGET_PORT>`
- 附件：`httpd.zip`
- 运行环境：glibc 2.36、PIE、Full RELRO、NX、Canary

## 漏洞链

### 1. 动态管理员口令

`GET /cgi-bin/config-backup.bin` 无需认证，直接返回 `/app/device.cfg` 原文，其中包含：

```text
admin_user=operator
admin_password=<RUNTIME_PASSWORD>
```

每次重开实例都会轮换口令，所以脚本必须在开火时重新读取，不能依赖旧值。

登录使用 form-urlencoded：

```python
requests.post(
    base + "/api/login",
    data={"username": "operator", "password": leaked_password},
)
```

### 2. review envelope 权限翻转

`GET /api/service/dispatch` 返回的 `review_envelope` 是 96 字节：

```text
IV(16) || AES-CBC ciphertext(80)
```

第二块明文含 `role=0`。翻转第 27 字节，即 `C0[11] XOR 0x01`，可把 `'0'` 改成 `'1'`。
提交后服务端返回 `field_service_authorized`，解锁 jobs / snapshots。

```python
env = bytearray.fromhex(dispatch["review_envelope"])
env[27] ^= 0x01
requests.post(base + "/api/service/dispatch", data=env.hex())
```

### 3. job/snapshot UAF 与任意读

核心原语：

1. 创建 0x480 的 job，随后 cancel，保留悬空引用。
2. 用同尺寸对象重占，伪造 snapshot 对象中的指针字段。
3. `GET /api/service/snapshots` 返回 `trace_tag`，把任意地址的 8 字节作为十六进制泄露。
4. 顺序泄露 heap、PIE、libc unsorted 和 stack `environ`。

关键地址来自本地验证：

```text
heap    H = 0x559764e30000
pie     P = 0x55974eb0f000
libc    L = 0x7f14c0bd4000
stack   T = 0x7ffe18b84c70
```

### 4. tcache 覆写与栈迁移

泄露完成后：

- 在 0x120 job 中写入第一段 ROP；
- 通过 tcache 结构覆写，让返回地址落到 `pop rbp; leave; ret`；
- 把栈迁移到可预测 heap 地址上的 1280 字节长链；
- 长链依次对 `/flag`、`/flag.txt`、`/app/flag.txt`、`/app/flag`、
  `/root/flag`、`/proc/self/environ`、`/secret`、`/app/secret` 做 `open/read/write`；
- HTTP 响应体直接回显第一份成功读到的内容。

## 一键复现

```powershell
python scripts/pending-review/remote_pivot.py `
  --host "<TARGET_HOST>" `
  --port <TARGET_PORT> `
  --out evidence/remote_pivot_out.bin `
  --no-envscan
```

脚本会：

- 自动从 `config-backup.bin` 解析本次实例的管理员口令；
- 登录并执行 dispatch 权限翻转；
- 做 heap/pie/libc/stack 泄露；
- 构建长链 ROP；
- 输出原始响应体。

## 成功回显

```text
EXIT=0
final status=200
bodylen=4096
first bytes = flag{Y2IocPvKVi7x5BQKH14XtwDIuL5tye0Vnl05rtNv}
```

证据：

- `evidence/FLAG_FOUND.txt`
- `evidence/remote_pivot_run_newhost.txt`
- `evidence/remote_pivot_out.bin`

## 关键文件

- `scripts/pending-review/blclient.py`
- `scripts/pending-review/remote_pivot.py`

## 复盘

- 实例被堆破坏后可能永久 502；重新开靶会更换 host/port 和密码。
- 不可以复用旧实例的 heap/libc 地址。
- 管理员密码必须每次从备份接口动态获取。
- 最终利用要写成一次执行，减少实例回收窗口。
