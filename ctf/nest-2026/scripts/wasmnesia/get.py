import json, os, sys, urllib.request, urllib.error, base64

BASE = os.environ.get("WASMNESIA_BASE", "http://127.0.0.1:8080")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "evidence")
os.makedirs(OUT, exist_ok=True)

def req(path, data=None, token=None, method=None, timeout=30):
    url = BASE + path
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None
    if data is not None:
        body = json.dumps(data).encode()
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()

def main():
    print("cwd", os.getcwd())
    st, hd, body = req("/api/v1/login", {"username": "reviewer@edgeledger.test", "password": "Replay-Wasm-2026"})
    print("login", st, body[:200])
    token = json.loads(body)["token"]
    open(os.path.join(OUT, "token.txt"), "w").write(token + "\n")

    st, hd, body = req("/api/v1/runs/job-f1234001/support-artifacts/edge_context_diag_aarch64", token=token)
    print("artifact", st, len(body), body[:8])
    with open(os.path.join(OUT, "edge_context_diag_aarch64"), "wb") as f:
        f.write(body)

    st, hd, body = req("/api/v1/preview", token=token)
    print("preview", st, len(body))
    open(os.path.join(OUT, "preview.json"), "wb").write(body)
    pj = json.loads(body)
    blob = base64.b64decode(pj["sample_b64"])
    open(os.path.join(OUT, "preview_sample.bin"), "wb").write(blob)
    print("sample bytes", len(blob), blob[:16].hex())

    # try connector to sidecar
    for u in ["http://preview.reports.local:9090/internal/v1/artifacts/runs/job-f1234001/formal.wexp",
              "http://preview.reports.local:9090/catalog/roadrunner-q3",
              "http://preview.reports.local/internal/v1/artifacts/runs/job-f1234001/formal.wexp"]:
        st, hd, body = req("/api/v1/connectors/fetch", {"url": u}, token=token)
        print("connector", u, st, body[:300])
        fn = "connector_" + str(abs(hash(u)))[:8] + ".json"
        open(os.path.join(OUT, fn), "wb").write(body)

if __name__ == "__main__":
    main()
