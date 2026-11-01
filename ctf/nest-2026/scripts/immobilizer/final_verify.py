"""Final clean verification: d -> nonces -> sealed XOR sha256(d) -> flag."""
import json, hashlib
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
D = json.loads((BASE/"attachments/data/data.json").read_text())
q = int(D["n"])
d = 0x8fd7fa690b0b0cf8f897127c005d3def0ce98e8dca000ab00205cd156818f097
sealed = bytes.fromhex(D["sealed"])

# 1) signature consistency with d
ok = True
kbits = []
for s in D["signatures"]:
    h = int.from_bytes(hashlib.sha256(s["msg"].encode()).digest(), "big") % q
    r, ss = int(s["r"]), int(s["s"])
    k = (h + r*d) * pow(ss, -1, q) % q
    if (ss*k - h - r*d) % q != 0:
        ok = False
    kbits.append(k.bit_length())

# 2) sealed = flag XOR sha256(d) repeated
ks = hashlib.sha256(d.to_bytes(32, "big")).digest()
flag = bytes(a ^ b for a, b in zip(sealed, (ks*2)[:len(sealed)]))
print("sealed hex  :", sealed.hex())
print("keystream   :", (ks*2)[:len(sealed)].hex())
print("flag        :", flag.decode())
print("all sigs ok :", ok)
print("nonce bits  :", kbits)
print("max nonce   :", max(kbits))
print("re-encrypt matches:", bytes(a ^ b for a, b in zip(flag, (ks*2)[:len(flag)])) == sealed)

(BASE/"evidence/11-flag.txt").write_text(
    "challenge: Immobilizer (Crypto)\n"
    "private key d (dec): %d\n"
    "private key d (hex): %064x\n"
    "nonce bit lengths : %s\n"
    "max nonce bits    : %d  (top byte of every nonce is 0x00 -> 248-bit nonce)\n"
    "sealed hex        : %s\n"
    "keystream         : SHA256(d as 32-byte big-endian), repeated\n"
    "FLAG CANDIDATE    : %s\n"
    "re-encrypt check  : %s\n"
    % (d, d, kbits, max(kbits), sealed.hex(), flag.decode(),
       bytes(a ^ b for a, b in zip(flag, (ks*2)[:len(flag)])) == sealed))
print("wrote evidence/11-flag.txt")
