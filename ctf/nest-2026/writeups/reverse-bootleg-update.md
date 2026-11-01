# Reverse · Bootleg Update

## 平台状态

- 方向：Reverse
- 平台状态：已完成
- 证据等级：E1（平台题面与场景配置存在，本地未保存附件、利用回执或 flag 原文）

> 本题是“证据缺口说明”，不是伪造的完整题解。

## 已知信息

题面设定：

- Roadrunner mule 07 在一次 OTA 更新后重新上线。
- MimicIVI 将 `CMU 4.1.3` 标记为部署完成。
- 后端为 Secondary ECU identity mismatch 开了工单。
- 操作者以 field-service engineer 身份检查 `VIP-CTRL-07`。
- 更新主机保留 deployment records。
- 题目提供标准 service console，无附件。

现场部署信息显示：

- 入口协议：HTTP
- 容器端口：8080
- 启动命令包含 `pushflag.sh {FLAG[0]}`
- 题目数据位于容器镜像 `bootleg-update`

## 目前缺失的证据

现场目录没有以下任何一项：

- 下载后的 deployment JSON / OTA 包
- service console 的网络响应
- ECU identity 原始记录
- patch / diff / 反汇编输出
- 成功请求或 flag 原文

因此无法可靠写出：

- 实际字段名和 API 路由；
- expected/actual identity 的推导过程；
- 触发 secret 返回的最终请求；
- 平台接受的确切 flag。

任何补值都会是猜测，不符合本仓库“证据驱动、不伪造”的发布规则。

## 重新采集时的最短路径

1. 记录 `/`、`/health` 和静态 JS，提取 API 路由。
2. 登录 service console，导出 deployment records。
3. 对比 `CMU 4.1.3` 中 Primary / Secondary ECU identity。
4. 检查 update manifest、签名、版本和时间线是否被重放或替换。
5. 在标准 service 权限内读取 secondary identity 对应的原始记录。
6. 将 secret 与平台 flag 格式对齐后再提交。
7. 每个请求保存 method、path、status、body hash 和时间。

## 想补全这篇 WP 需要的最少材料

把以下任一材料放入本地题目的 `attachments/` 或 `evidence/`：

```text
OTA deployment record
service console HAR
ECU identity diff
固件/容器镜像
平台接受回执
```

即可把本文件升级为完整复现型 WP。

## 安全建议

1. 服务控制台必须校验 operator、vehicle 和 ECU role。
2. Secondary ECU identity 必须由硬件根信任或签名证明。
3. OTA manifest、安装结果和审计日志要绑定同一 transaction id。
4. 不允许仅凭版本字符串或 UI 的 “complete” 状态判断更新成功。

## 证据

- `competition-ledger.json` 中该题 `isSolved=true`
- 现场 `scene_config` 仅包含部署描述，不含 flag
