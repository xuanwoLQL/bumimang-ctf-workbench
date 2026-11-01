# Crypto · Premaster

## 平台状态

- 方向：Crypto
- 平台状态：已完成
- 证据等级：E1（附件与复现脚本完整，本地未保留 flag 原文）

> 本题不由人工猜测 flag。公开 WP 只记录可验证的协议漏洞、求解器和证据缺口。

## 题目结构

服务使用 legacy RSA PKCS#1 v1.5 type-02 握手：

```text
session <c0_hex> <s0>
```

随后每行提交一个 ciphertext：

- `ok`：解密结果是合法 type-02 block
- `bad`：解密结果不是 type-02 block

每次连接的 flag 明文固定，但 PKCS#1 v1.5 padding 重新随机生成。

`s0` 是服务端直接公布的首个合法 multiplier：`c0 * s0^e` 解密后必然
通过 padding 检查。这等价于向攻击者免费提供 Bleichenbacher oracle 的第一跳。

## 求解器

`solver` 维护满足条件的明文区间：

```text
2B <= m*s mod n < 3B
B = 2^(8*(k-2))
```

每轮：

1. 从合法 `s` 候选中有序批量查询。
2. 只测试理论上可能落入当前区间的 multiplier。
3. 用 oracle 的 `ok` 结果细化区间。
4. 区间收缩为单点后，消去首轮 blinding，恢复完整 PKCS#1 block。

服务端实现了批量读取和多帧 CRT 解密，因此每个 TCP 连接内可以高速做几千到
数万次 oracle 查询。

## 复现

```powershell
python scripts/premaster/premaster_solver.py <TARGET_HOST> <TARGET_PORT> `
  --ssl --batch-size 1024 --timeout 15
```

成功时脚本输出：

```text
[+] announced s0 verified against the oracle
[+] recovered plaintext after N oracle queries
[+] payload repr: b'flag{...}'
```

## 证据缺口

本次比赛平台最终显示该题已完成，但本地任务数据库没有关联 flag 原文，也没有保留
成功会话的 payload 行。发布时因此不填写猜测值。

附件公钥、协议源码和求解器均保留在仓库中，可在授权的新实例上重新运行并恢复
该实例的实际 flag。

## 修复建议

1. 生产握手必须使用 constant-time 校验，不能暴露 padding 成功/失败位。
2. 不应向客户端公布首个 conforming multiplier。
3. 对错误解密统一返回同一种错误，限制连接数和查询速率。
4. 使用 OAEP 或经过审计的 TLS 库，不自行实现 legacy RSA 握手。
5. 定期轮换私钥，避免低指数、共享模数和侧信道组合。

## 文件

- `scripts/premaster/premaster_solver.py`
- `scripts/premaster/pubkey.json`
