import hashlib
import json
import os
import re
import struct
import zipfile
from pathlib import Path

ROOT = Path(os.environ.get("PICKLE_TASK_DIR", Path(__file__).resolve().parents[2]))
SALT_HEX = "69c429c475ee3c2c89aa14ae514d2c75"
ROUTE = "legacy-tar-bridge/quarantine-17"
NONCE = "6c6f61645f736166655f323032365f31"
STORAGE_KEY = "2"
GLOBAL = "modelhub_compat.rebuild_legacy_token"

z = zipfile.ZipFile(ROOT / "evidence" / "quarantine_snapshot.pt")
blob = z.read("quarantine_snapshot/data/2")
# tensor view: storage_offset=19, size=(4,32), stride=(67,2)
ct = bytes(blob[19 + r * 67 + c * 2] for r in range(4) for c in range(32))

prefix = "|".join([GLOBAL, ROUTE, NONCE, STORAGE_KEY, SALT_HEX]).encode()
ks = b"".join(hashlib.sha256(prefix + struct.pack(">I", i)).digest() for i in range(4))[:len(ct)]
pt = bytes(a ^ b for a, b in zip(ct, ks))
text = pt.decode("latin1")
m = re.search(r"flag\{[^}\r\n]{4,200}\}", text)
flag = m.group(0) if m else None

lines = []
lines.append("Pickle-Me-Not — independent flag verification")
lines.append("target: <TARGET_BASE>")
lines.append("source: evidence/quarantine_snapshot.pt (sha256 9dc6d955c842fdb15129886478d360b34185bc78584267fa5d695f85035e382a)")
lines.append("salt (guard.kdf_salt from model-00001-of-00002.safetensors): %s" % SALT_HEX)
lines.append("kdf: mhkdf-sha256-v1")
lines.append("prefix: %s" % "|".join([GLOBAL, ROUTE, NONCE, STORAGE_KEY, SALT_HEX]))
lines.append("counter: be32 starting at 0; ciphertext: data/2 strided view (offset=19,size=(4,32),stride=(67,2))")
lines.append("plaintext_hex: " + pt.hex())
lines.append("plaintext_text: " + repr(text))
lines.append("FLAG: %s" % flag)
lines.append("sha256(plaintext): " + hashlib.sha256(pt).hexdigest())

out = "\n".join(lines) + "\n"
(ROOT / "evidence" / "flag.txt").write_text(out, encoding="utf-8")
print(out)
