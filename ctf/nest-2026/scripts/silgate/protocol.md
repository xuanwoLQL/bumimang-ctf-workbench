# SilGate 公开协议规格

vECU 实现 ISO-13400 (DoIP) 风格封装 + UDS (ISO-14229) 服务子集 +
ISO-TP (ISO-15765-2) 分段传输。所有多字节整数均为大端。

## 1. DoIP 封装

报头 8 字节：

```
[0]    protocol version = 0x03
[1]    ~version（按位取反，校验用）
[2:4]  payload type (u16)
[4:8]  payload length (u32)
```

实现的 payload type：

| type   | 含义                                    |
|--------|-----------------------------------------|
| 0x0001 | Vehicle Identification 请求             |
| 0x0004 | Vehicle Announcement 响应               |
| 0x0005 | Routing Activation 请求                 |
| 0x0006 | Routing Activation 响应                 |
| 0x8001 | Diagnostic message                      |
| 0x8002 | Diagnostic message ACK                  |
| 0x8003 | Diagnostic message NACK                 |

### Vehicle Announcement（0x0004 响应载荷，73 字节）

```
[0:17]   VIN（ASCII）
[17:19]  逻辑地址 = 0x0E80
[19]     软件版本字符串长度 N
[20:20+N] 软件版本字符串
[57:73]  OEM 保留（16 字节，语义未公开）
```

### Routing Activation（0x0005 请求载荷）

```
[0:2]  tester 源地址 (u16)
[2]    activation type：0x00 = 默认诊断；0x01 = 产线刷写（需 OEM 凭据）
[3]    OEM 凭据长度 oem_len (u8)
[4:..] OEM 凭据
```

0x0006 响应载荷：`[tester 源地址 u16][ECU 逻辑地址 u16][结果码]`。
结果码 0x10 = 激活成功；其他 = 拒绝。产线刷写会话（0x10 服务子功能 0x02）
需要先以 0x01 类型激活。未完成 Routing Activation 的诊断报文会被 NACK。

### Diagnostic message（0x8001 载荷）

```
[0:2]  源地址 (u16)
[2:4]  目标地址 (u16)   # tester -> ECU 为 0x0E80
[4:..] ISO-TP 数据
```

ECU 收到后先回 0x8002 ACK，诊断响应以另一条 0x8001 送达。

## 2. ISO-TP（ISO-15765-2 经典寻址）

单帧 SF：`[0x0L][L 字节数据]`，L ≤ 7。
首帧 FF：`[0x10|len[11:8]][len[7:0]][6 字节数据]`；
len > 0xFFF 时使用转义形式 `[0x10][0x00][len u32][4 字节数据]`。
连续帧 CF：`[0x20|SN][7 字节数据]`，SN 从 1 起模 16 滚动。
流控帧 FC：`[0x30][BS][STmin]`。

模拟器侧（作为接收方）参数与违例处理：

- 收到 FF 后回 FC：CTS=0、**BS=4**、**STmin=5ms**；此后每收满 4 个 CF 再发一次 FC。
- SN 滚动错误 → 否定响应 NRC 0x73，传输中止。
- 未等 FC 超块突发 → NRC 0x73，传输中止。
- CF 间隔 > 500ms → 传输中止。
- CF 提前于 STmin 到达（容差 +2ms）→ NRC 0x24，传输中止。所有 CF 间隔
  （含 FF 后的第一个 CF、每次 FC 后的第一个 CF）均须 ≥ STmin。

模拟器作为发送方（大响应）时遵守你 FC 中的 BS/STmin；本地测试建议
BS=0、STmin=0。

## 3. UDS 服务

| SID  | 服务 |
|------|------|
| 0x10 | DiagnosticSessionControl |
| 0x11 | ECUReset |
| 0x14 | ClearDiagnosticInformation |
| 0x19 | ReadDTCInformation |
| 0x22 | ReadDataByIdentifier |
| 0x23 | ReadMemoryByAddress |
| 0x27 | SecurityAccess |
| 0x2E | WriteDataByIdentifier |
| 0x31 | RoutineControl |
| 0x34 | RequestDownload |
| 0x35 | RequestUpload |
| 0x36 | TransferData |
| 0x37 | RequestTransferExit |
| 0x3E | TesterPresent |

否定响应统一为 `[0x7F][SID][NRC]`。

### 会话（0x10）

子功能：0x01 default / 0x02 programming / 0x03 extended。

- programming 会话需要：产线 activation（Routing Activation type 0x01）
  **且**相应安全等级已解锁，否则分别报 NRC 0x22 / 0x33。
- **S3 服务器定时器 = 2000ms**：非默认会话期间，只有 TesterPresent(0x3E)
  会重置该定时器；超时后 ECU 回到默认会话、清空传输缓冲、安全解锁状态清零。
- 0x3E 格式 `[0x3E][sub]`；sub bit7 置位（0x80）时抑制肯定响应。

### SecurityAccess（0x27）

等级 0x11/0x12（请求 seed / 发送 key）：

```
请求  [0x27][0x11]            响应 [0x67][0x11][seed 8 字节]
请求  [0x27][0x12][key 4B]    响应 [0x67][0x12]（或 NRC 0x35）
```

seed 为密码学安全随机数，key 派生算法不在本文档范围内。

### ReadMemoryByAddress（0x23）

```
请求  [0x23][addrLenFmt][addr][size]
响应  [0x63][data...]
```

`addrLenFmt`：高半字节 = size 字段字节数（1 或 2），低半字节 = addr 字段
字节数（4 或 8）。addr 字段支持两种格式：4 字节地址表示诊断会话相关的
相对偏移，8 字节地址表示绝对地址。size 上限 0x800，超过回 NRC 0x31。

### RoutineControl（0x31）

RID 0x0203 为刷写准备例程，执行前需完成例程握手：

```
请求  [0x31][0x04][0x02][0x03]              响应 [0x71][0x04][0x02][0x03][seed 3 字节]
请求  [0x31][0x05][0x02][0x03][key 4B]      响应 [0x71][0x05][0x02][0x03][0x00]（或 NRC 0x35）
```

握手通过后方允许 RequestTransferExit 执行例程，否则报 NRC 0x33。
key 派生算法不在本文档范围内。

### RequestDownload / RequestUpload（0x34 / 0x35）

```
请求  [0x34][dataFormat=0x00][addrLenFmt=0x44][addr u32][len u32]
响应  [0x74][0x20][maxBlockLength u16]
```

addr/len 必须落在合法刷写窗口内，否则 NRC 0x31。0x35 对称。

### TransferData（0x36）

下载方向：`[0x36][blockCounter][data...]`，blockCounter 从 1 起滚动，
错误报 NRC 0x73；响应 `[0x76][blockCounter]`。单条消息数据上限 0xFFE 字节。
上传方向：`[0x36][blockCounter]` → 响应 `[0x76][blockCounter][chunk]`。

### RequestTransferExit（0x37）

校验例程封装头（见 `routine_format.md`）与 CRC，通过后例程被加载执行。
失败按原因返回 NRC。响应 `[0x77]`。
