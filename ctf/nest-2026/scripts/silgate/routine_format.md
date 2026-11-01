# 刷写例程（routine）封装格式

通过 RequestDownload(0x34) + TransferData(0x36) 上传的例程数据，
必须以如下 16 字节头部开始（所有多字节字段大端）：

```
[0:4]   magic = 'RTN0'（ASCII）
[4:6]   crc16 (u16) —— 覆盖范围 [payload_off, payload_off+payload_len)
[6:8]   flags (u16，保留，填 0)
[8:12]  payload_off (u32) —— 必须为 16
[12:16] payload_len (u32)
```

- CRC 参数：**CRC16-CCITT**，多项式 0x1021，初值 0xFFFF，无反射、无输出异或。
- `RequestTransferExit(0x37)` 时校验 magic 与 CRC；校验通过后，
  例程区被置为可执行并**从例程缓冲区 +16 处开始执行**（x86-64 机器码，
  入口时无法依赖任何寄存器初值）。
- 执行环境受限：例程只能进行纯计算与内存读写；任何特权指令/陷入类
  指令序列都会导致加载被拒绝（具体清单自行归纳）。

> **注意**：刷写执行期间，例程需自行按约定节拍给看门狗喂狗，
> 否则 ECU 复位（缓冲区清零、会话锁定）。看门狗参数不在本文档范围内。
