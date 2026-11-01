# Pwn · SilGate

## 平台状态

- 方向：Pwn
- 平台状态：已完成
- 证据等级：E1（协议客户端与部分利用链完整，本地未保留最终 flag 原文）

> 本题公开完整的已确认协议链和证据缺口，不伪造最终 flag。

## 目标

vECU 暴露一个 TLS 包装的 DoIP 风格诊断端口：

```text
<TARGET_HOST>:<TARGET_PORT>
```

服务实现：

- DoIP 8 字节头：`03 FC <type u16> <len u32>`
- ISO-TP 单帧、首帧、连续帧和流控
- UDS：`10 11 14 19 22 23 27 2E 31 34 35 36 37 3E`
- 每个 TCP 连接等价一次独立上电周期

## 已确认的入口

### 1. 车辆识别

```text
0x0001 -> 0x0004
VIN = LSILGATE26K7A3901
ECU = 0x0E80
版本 = SEC-GATE v2.3.1 (legacy-compat build)
OEM 16B = 0000000000000000000001dX00000000
```

### 2. Routing Activation 缺陷

```text
activation type = 0x01
OEM credential length = 0
```

服务返回结果码 `0x10`，产线刷写激活成功。非空 OEM 凭据反而被拒绝，说明
legacy 校验逻辑把“缺失”当成了“符合”。

### 3. 会话与安全访问

```text
10 02 -> 7F 10 33
27 11 -> 67 11 <8-byte seed>
27 12 <4-byte key> -> 67 12 / 7F 27 35
```

错误 key 会锁一次安全访问序列，必须断开重连并重新取 seed。

### 4. 内存读取边界

```text
23 24 <relative offset u32> <size u16>
```

可读区域包含 libc/OpenSSL 镜像，但 vECU 主程序不在公开读窗口内。4 字节地址
表示会话相关相对偏移，8 字节地址表示绝对地址；`size > 0x800` 或主程序高地址
会返回 `NRC 0x31`。

## 预期最终链

题目要求：

1. 进入 programming session。
2. 完成 SecurityAccess。
3. 完成 RoutineControl `0x0203` 握手。
4. 通过 `0x34 + 0x36` 下载自制 routine。
5. `0x37` 触发 routine。
6. routine 自行喂看门狗，并回传产线主密钥。

routine 容器格式：

```text
[0:4]   RTN0
[4:6]   CRC16-CCITT(payload)
[6:8]   flags = 0
[8:12]  payload_off = 16
[12:16] payload_len
[16:]   x86-64 machine code
```

本次本地记录已打通 DoIP、ISO-TP、UDS 和大响应流控，但未保存 seed→key 的最后
一步，也未保留 routine 执行后的 flag 原文。平台后来显示题目完成，但现有证据
不足以声称本地完整复现了最终步骤。

## 复现客户端

```powershell
$env:SILGATE_HOST='<TARGET_HOST>'
$env:SILGATE_PORT='<TARGET_PORT>'
python - <<'PY'
from silgate_lib import SilGate

c = SilGate()
print("vin:", c.vehicle_info())
print("route:", hex(c.route(0x01, b"")))
print("session:", c.uds(bytes.fromhex("1003")).hex())
print("seed:", c.uds(bytes.fromhex("2711")).hex())
c.close()
PY
```

仓库中的客户端会自动处理：

- TLS
- DoIP 包头
- ISO-TP 多帧
- 服务端 FC `BS=4 / STmin=5ms`
- 大响应流控
- `TesterPresent` 保活

## 证据缺口与结论

公开材料可以确认：

- 产线 activation 的空凭据绕过；
- DoIP/ISO-TP/UDS 端点与状态隔离；
- 可读镜像布局和主程序不可读边界；
- routine 封装格式和看门狗约束。

不能确认：

- SecurityAccess seed→key 的最终算法；
- 本次 routine 的机器码；
- 平台接受的主密钥/flag 原文。

## 修复建议

1. Routing Activation 对“缺失凭据”和“合法凭据”做显式区分。
2. SecurityAccess 使用每会话随机 seed、失败计数和速率限制。
3. 刷写窗口必须校验来源、会话、安全等级和 routine 签名。
4. 禁止执行未签名机器码；使用受限 VM 或签名容器。
5. 看门狗不能由上传的任意代码直接控制。
6. 主密钥不应固化在可被例程读取的同一进程地址空间。

## 文件

- `scripts/silgate/silgate_lib.py`
- `scripts/silgate/protocol.md`
- `scripts/silgate/routine_format.md`
