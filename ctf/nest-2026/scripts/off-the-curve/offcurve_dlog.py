"""Recover the v3 delivery scalar d from off-curve diagnostic tags.

For each archived client public key K (not on y^2=x^3+x+7), the server computes
S = d*K on the curve through K.  The diagnostic tag is
SHA256('DOCSHARE-DIAG\\0' || key_id || nonce || encodeFull(S))[:16].
We enumerate k*K and find the k whose tag matches -> d mod ord(K).
Then CRT the congruences.
"""
import hashlib
import json
import os
from math import gcd

P, A = 65519, 1

# key_id -> (compressed hex, nonce hex, tag hex) captured from admin_forge.txt
DIAG = {
    "legacy-rotated-05": ("022308", "c00eb14585757a3f", "2a2cf0d689125fb03c2bc362124ee74b"),
    "legacy-rotated-06": ("024c87", "00d11f9047a49969", "6a8c8588075c5b20c3add3cd64db17b2"),
    "legacy-android-01": ("025c5d", "72d8a13f0073d227", "15ead0afc6d110c32ae5d613de3acf9a"),
    "legacy-browser-02": ("02c535", "bb73fdeb3e8ba284", "90a5f80202cdb7ca3cdcf2868aa9bbee"),
    "legacy-rn-03": ("022b09", "192d4ec8378c62d9", "64ad02084d018bf5647525de808328ea"),
    "legacy-browser-04": ("025d04", "3d5a340d9fbf6b02", "033299a73e0a9f57a28a2bc6c684a910"),
}

# v3 keys only (rpt-042 was sealed under doc-kek-2026.09-v3)
V3 = ["legacy-android-01", "legacy-browser-02", "legacy-rn-03", "legacy-browser-04"]


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


def decompress(hexs):
    raw = bytes.fromhex(hexs)
    x = int.from_bytes(raw[1:], "big")
    rhs = (x * x * x + A * x + 7) % P
    y = pow(rhs, (P + 1) // 4, P)
    if (y & 1) != (raw[0] & 1):
        y = (-y) % P
    return (x, y)


def encode_full(Pt):
    if Pt is None:
        return b"\x00"
    x, y = Pt
    return bytes([4, x >> 8, x & 255, y >> 8, y & 255])


def tag_for(key_id, nonce_hex, full):
    prefix = b"DOCSHARE-DIAG\0" + key_id.encode()
    return hashlib.sha256(prefix + bytes.fromhex(nonce_hex) + full).hexdigest()[:32]


def recover():
    results = {}
    for key_id in DIAG:
        hexs, nonce, expected = DIAG[key_id]
        K = decompress(hexs)
        # sanity: is K on the main curve?
        on_main = (K[1] * K[1] - (K[0] ** 3 + A * K[0] + 7)) % P == 0
        cur = None
        found = None
        order = None
        # candidate k=0 -> infinity
        if tag_for(key_id, nonce, b"\x00") == expected:
            found, order = 0, 1
        for k in range(1, 66100):
            cur = add(cur, K)
            if tag_for(key_id, nonce, encode_full(cur)) == expected:
                found = k
                break
            if cur is None:
                order = k
                break
        if found is not None:
            # order of K: keep adding from infinity until it returns to infinity
            t = None
            for j in range(1, 66100):
                t = add(t, K)
                if t is None:
                    order = j
                    break
            if order:
                found %= order
        results[key_id] = {"K": K, "on_main": on_main, "d_mod_order": found,
                           "order": order}
        print(key_id, "K", K, "on_main", on_main, "k", found, "order", order)
    return results


def crt(congruences):
    """congruences: list of (residue, modulus) -> (x, lcm) or None."""
    x, m = 0, 1
    for r, mod in congruences:
        if mod is None or r is None:
            continue
        g = gcd(m, mod)
        if (r - x) % g:
            print("CRT incompatible", (r, mod))
            return None
        lcm = m // g * mod
        mg = (m // g) % (mod // g) if mod // g > 1 else 0
        if mod // g > 1:
            t = ((r - x) // g) * pow(mg, -1, mod // g) % (mod // g)
        else:
            t = 0
        x = (x + m * t) % lcm
        m = lcm
    return x, m


if __name__ == "__main__":
    res = recover()
    cong = [(res[k]["d_mod_order"], res[k]["order"]) for k in V3]
    print("congruences", cong)
    out = crt(cong)
    print("CRT", out)
    if out:
        d, m = out
        print("d mod m =", d, "mod", m, "m>2^32:", m > 2**32)
        json.dump({"d": d, "m": m, "cong": cong,
                   "detail": {k: {"order": res[k]["order"],
                                  "d_mod": res[k]["d_mod_order"],
                                  "K": res[k]["K"]} for k in res}},
                  open(os.environ.get("NORTHSTAR_DLOG_OUT", "offcurve_dlog.json"), "w"),
                  indent=1)
