import json, os, urllib.request, urllib.error
BASE = os.environ.get("WASMNESIA_BASE", "http://127.0.0.1:8080")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "evidence")
def http(url, data=None, token=None, timeout=20):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    b = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=b, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp: return resp.status, resp.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
    except Exception as e: return -1, str(e).encode()
st,b = http(BASE+"/api/v1/login", {"username":"reviewer@edgeledger.test","password":"Replay-Wasm-2026"})
tok = json.loads(b)["token"]

URL = "http://preview.reports.local@127.0.0.1:9090/internal/v1/artifacts/runs/job-f1234001/formal.wexp"
st,b = http(BASE+"/api/v1/connectors/fetch", {"url":URL}, token=tok)
print("outer", st, len(b))
print(b[:1000])
open(os.path.join(OUT,"connector_formal_raw.json"),"wb").write(b)
try:
    outer = json.loads(b)
    inner = outer.get("body")
    print("outer keys", outer.keys(), "inner type", type(inner), "len", len(inner) if inner else None)
    if isinstance(inner, str):
        open(os.path.join(OUT,"formal_wexp_response.txt"),"w",encoding="utf-8").write(inner)
        try:
            j = json.loads(inner)
            print("inner keys", list(j.keys()))
            print(json.dumps(j, indent=1)[:3000])
            open(os.path.join(OUT,"formal_meta.json"),"w").write(json.dumps(j, indent=1))
        except Exception as e:
            print("inner not json", e)
except Exception as e:
    print("parse err", e)
