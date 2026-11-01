# Web · Crossed Signals

## 平台状态

- 方向：Web
- 平台状态：已完成
- 证据等级：E2（前端、预览包和 MCP 请求协议完整；最终 flag 原文未保留）

> 本题公开已确认的信任边界与可测试利用点，不把未实测的请求写成既定事实。

## 入口

服务台前端把车辆信号转成维修工单：

```text
http://<TARGET_HOST>:<TARGET_PORT>
```

凭据由题目动态下发。登录后：

```http
POST /api/login
GET  /api/me
GET  /api/cases
POST /mcp
```

## 可见结构

`/api/me` 返回 `assigned_vins`，`/api/cases` 只应允许访问该 VIN 的车辆数据。
工具注册表：

- `get_vehicle_health(vin)`
- `get_update_status(vin)`

前端在 MCP 请求中同时放入两份 VIN：

```json
{
  "params": {
    "name": "get_update_status",
    "arguments": {"vin": "<CASE_VIN>"}
  }
}
```

```http
Mcp-Param-VIN: <CASE_VIN>
Mcp-Name: get_update_status
MCP-Protocol-Version: 2026-07-28
```

同一安全上下文由 HTTP 头和 JSON-RPC 参数重复表达，是本题最明显的信任边界。

## 预览包线索

本地保存的 `SR-26042-advisor-preview.zip`：

```text
manifest.json
diagnostics/telemetry.json
diagnostics/update-history.json
```

`manifest.json` 的 `entries` 却引用了：

```text
private/recovery.txt
```

预览 ZIP 不包含该文件。目标案例为：

```text
case_id = SR-26042
VIN     = CTF6SVC0000000002
```

这说明恢复令牌位于服务端私有服务记录，不在预览包本身。

## 可测试边界

以下请求用于确认 gateway 是否按 `Mcp-Param-VIN` 授权、而工具是否按 JSON 参数
读取 VIN：

```powershell
python scripts/crossed-signals/mcp_boundary_probe.py `
  --base http://<TARGET_HOST>:<TARGET_PORT> `
  --token '<USER_JWT>' `
  --assigned-vin '<ME_ASSIGNED_VIN>' `
  --target-vin 'CTF6SVC0000000002' `
  --tool get_update_status
```

若返回目标车辆状态而不是 `403`，即证明 header/body 参数不同步可跨车辆边界。
随后应使用同一授权链读取原始服务记录中的 `private/recovery.txt`。

## 证据缺口

本次平台显示该题完成，但本地没有保留成功请求的响应、恢复令牌或 flag 原文。
因此本 WP 只确认：

- 前端工具调用的双 VIN 结构；
- 预览包 manifest 指向未随包发布的私有文件；
- 目标 VIN 与案例 ID；
- 服务端工具边界值得测试。

不把上述边界测试直接声明为最终成功 payload。

## 修复建议

1. 授权主体只使用一个不可伪造的服务端会话字段。
2. 不接受客户端自定义 `Mcp-Param-VIN` 作为安全上下文。
3. 网关和工具执行器必须使用同一授权对象，不允许 header/body 各自解析。
4. 每个 case 查询做对象级授权，并按 enrolled vehicle 过滤。
5. 私有文件不进入可枚举的 bundle 路径。
6. 恢复令牌采用一次性、短 TTL、强绑定 case 与操作者。

## 文件

- `scripts/crossed-signals/mcp_boundary_probe.py`
- 静态前端与预览包来自本次比赛现场副本
