import binascii
import hashlib
import itertools
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(r"D:/agent/xuanwo/work/task-65033674")
Z = zipfile.ZipFile(ROOT / "evidence" / "quarantine_snapshot.pt")
BLOB = Z.read("quarantine_snapshot/data/2")

VARIANTS = {
    "full512": BLOB,
    "strided128": bytes(BLOB[19 + r * 67 + c * 2] for r in range(4) for c in range(32)),
    "off19_128": BLOB[19:147],
    "head128": BLOB[:128],
}

ROUTE = "legacy-tar-bridge/quarantine-17"
NONCE_HEX = "6c6f61645f736166655f323032365f31"
NONCE_RAW = bytes.fromhex(NONCE_HEX).decode()

GLOBALS = [
    "modelhub_compat.rebuild_legacy_token",
    "modelhub_compat:rebuild_legacy_token",
    "modelhub_compat/rebuild_legacy_token",
    "modelhub_compat|rebuild_legacy_token",
    "modelhub_compat rebuild_legacy_token",
    "modelhub_compat\x00rebuild_legacy_token",
    "rebuild_legacy_token",
    "modelhub_compat",
]
NONCES = [NONCE_HEX, NONCE_RAW]
SKEYS = ["2", "storage", "data/2", "storage:2", "storage/2", "2:cpu", "torch.ByteStorage:2", "torch.ByteStorage", ""]
COUNTERS = [0, 1, 88, 89, 90]
ENCS = ["be32", "le32", "ascii"]


def salt_forms(raw_hex):
    raw = bytes.fromhex(raw_hex)
    forms = {raw_hex.lower(), raw_hex.upper()}
    forms.add("0x" + raw_hex.lower())
    forms.add(raw[::-1].hex())
    forms.add(raw[::-1].hex().upper())
    forms.add(str(int.from_bytes(raw, "big")))
    forms.add(str(int.from_bytes(raw, "little")))
    forms.add(raw.hex())
    return sorted(forms)


def block(prefix, ctr, enc):
    if enc == "be32":
        c = struct.pack(">I", ctr)
    elif enc == "le32":
        c = struct.pack("<I", ctr)
    else:
        c = str(ctr).encode()
    return hashlib.sha256(prefix + c).digest()


def score(pt):
    p = sum(32 <= c < 127 or c in (9, 10, 13) for c in pt) / len(pt)
    f = re.findall(rb"[A-Za-z0-9_]{2,}\{[ -~]{4,200}\}", pt)
    tar = pt[257:262] == b"ustar" if len(pt) > 300 else False
    gz = pt[:2] == b"\x1f\x8b"
    pk = pt[:4] == b"PK\x03\x04"
    return p, f, tar, gz, pk


def main():
    if len(sys.argv) > 1:
        raw_hex = sys.argv[1].strip()
    else:
        obj = json.load(open(ROOT / "evidence" / "peer_salt.json", encoding="utf-8"))
        text = json.dumps(obj)
        m = re.search(r'"salt_hex"\s*:\s*"([0-9a-fA-F]+)"', text)
        if not m:
            m = re.search(r'salt_hex[^0-9a-fA-F]+([0-9a-fA-F]{4,})', text)
        raw_hex = m.group(1)
    print("raw_hex", raw_hex, "len", len(raw_hex) // 2)
    salts = salt_forms(raw_hex)
    hits = []
    for vname, data in VARIANTS.items():
        for g, nonce, sk, salt, ctr, enc in itertools.product(GLOBALS, NONCES, SKEYS, salts, COUNTERS, ENCS):
            prefix = "|".join([g, ROUTE, nonce, sk, salt]).encode()
            ks = b"".join(block(prefix, ctr + i, enc) for i in range((len(data) + 31) // 32))[:len(data)]
            pt = bytes(a ^ b for a, b in zip(data, ks))
            p, f, tar, gz, pk = score(pt)
            if f or tar or gz or pk or p > 0.85:
                hits.append((p, f, tar, gz, pk, vname, g, nonce, sk, salt, ctr, enc, pt))
    hits.sort(key=lambda t: (bool(t[1]), t[2], t[3], t[4], t[0]), reverse=True)
    print("hits", len(hits))
    for h in hits[:12]:
        p, f, tar, gz, pk, vname, g, nonce, sk, salt, ctr, enc, pt = h
        print("\nprintable=%.3f flag=%r tar=%s gz=%s pk=%s" % (p, f, tar, gz, pk))
        print(" variant=%s global=%r nonce=%r sk=%r salt=%r ctr=%r enc=%s" % (vname, g, nonce, sk, salt, ctr, enc))
        print(" hex:", binascii.hexlify(pt[:200]).decode())
        print(" asc:", re.sub(rb"[^\x20-\x7e]", b".", pt[:300]).decode())


if __name__ == "__main__":
    main()
