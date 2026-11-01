"""Decrypt rpt-042 using recovered delivery scalar d = 13450493."""
import hashlib
import hmac
import json
import os
from base64 import b64decode

from Crypto.Cipher import AES

P, A, B, N, G = 65519, 1, 7, 65444, (4, 17054)
RECORD_PATH = os.environ.get("NORTHSTAR_RECORD", "download_rpt-042.json")
PLAINTEXT_PATH = os.environ.get("NORTHSTAR_PLAINTEXT_OUT", "rpt042_plaintext.txt")
REC = json.load(open(RECORD_PATH, encoding="utf-8"))


def inv(x):
    return pow(x % P, P - 2, P)


def add(Pt, Qt):
    if Pt is None:
        return Qt
    if Qt is None:
        return Pt
    x1, y1 = Pt
    x2, y2 = Qt
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if Pt == Qt:
        m = (3 * x1 * x1 + A) * inv(2 * y1) % P
    else:
        m = (y2 - y1) * inv(x2 - x1) % P
    x3 = (m * m - x1 - x2) % P
    return (x3, (m * (x1 - x3) - y1) % P)


def mul(k, Pt):
    R = None
    while k:
        if k & 1:
            R = add(R, Pt)
        Pt = add(Pt, Pt)
        k >>= 1
    return R


def decompress(hexs):
    raw = bytes.fromhex(hexs)
    x = int.from_bytes(raw[1:], "big")
    rhs = (x * x * x + A * x + B) % P
    y = pow(rhs, (P + 1) // 4, P)
    if (y & 1) != (raw[0] & 1):
        y = (-y) % P
    return (x, y)


def encode_full(Pt):
    if Pt is None:
        return b"\x00"
    x, y = Pt
    return bytes([4, x >> 8, x & 255, y >> 8, y & 255])


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def derive(shared_pt, scalar, info, iv):
    info_hash = hashlib.sha256(canonical(info)).digest()
    binding = hashlib.sha256(
        b"northstar-report-scalar-binding\0" + int(scalar).to_bytes(4, "big") + info_hash
    ).digest()
    salt = b"northstar-report-v3\0" + iv + info_hash
    master = hashlib.scrypt(encode_full(shared_pt) + binding, salt=salt,
                            n=32768, r=8, p=1, dklen=32, maxmem=2**28)
    return hmac.new(master, b"northstar-aes256-gcm-key\0" + info_hash, hashlib.sha256).digest()


def attempt(shared_pt, scalar, label):
    info, aad = REC["info"], REC["aad"]
    iv = bytes.fromhex(REC["nonce"])
    ct = b64decode(REC["ciphertext"])
    tag = bytes.fromhex(REC["tag"])
    key = derive(shared_pt, scalar, info, iv)
    c = AES.new(key, AES.MODE_GCM, nonce=iv)
    c.update(canonical({"info": info, "aad": aad}))
    try:
        pt = c.decrypt_and_verify(ct, tag)
        print("HIT", label, "shared", shared_pt, "scalar", scalar)
        print(pt.decode("utf-8", "replace"))
        return pt
    except Exception:
        print("miss", label)
        return None


if __name__ == "__main__":
    d = 13450493
    Q = decompress(REC["recipient_public_key"])
    print("Q", Q, "on curve", (Q[1] * Q[1] - (Q[0] ** 3 + A * Q[0] + B)) % P == 0)
    points = {
        "d*Q": mul(d, Q),
        "d*G": mul(d, G),
        "Q": Q,
        "d*P31337": mul(d, mul(31337, G)),
        "Q_31337": mul(31337, G),
    }
    scalars = {"d": d, "dlogQ=31337": 31337, "1": 1}
    for sname, S in points.items():
        for scname, sc in scalars.items():
            out = attempt(S, sc, f"{sname}/{scname}")
            if out:
                open(PLAINTEXT_PATH, "wb").write(out)
                raise SystemExit(0)
    print("no hit")
