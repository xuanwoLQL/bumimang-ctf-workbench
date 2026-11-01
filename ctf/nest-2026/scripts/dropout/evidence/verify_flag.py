#!/usr/bin/env python3
# Independent local verification of the dropout challenge flag, using only attachments/samples/samples.json
import json, hashlib

d = json.load(open('attachments/samples/samples.json'))
q, n, m = d['q'], d['n'], d['m']
A, b = d['A'], d['b']
mu = bytes.fromhex(d['masked_update'])

# Recovered dropout mask (1 = kept) from fpylll LLL/BKZ Kannan embedding.
# Raw lattice vector had c_j = -mask_j, i.e. c in {0,-1}; mask below is s = -c.
mask = [1,0,0,0,0,0,0,1,0,0,0,0,0,1,1,0,0,0,1,1,1,0,1,0,0,1,1,1,0,1,0,0]
assert len(mask) == n

# 1) verify the LWE relation: b - A*mask mod q has entries in {-1,0,1}
res = []
for i in range(m):
    r = (b[i] - sum(A[i][j]*mask[j] for j in range(n))) % q
    res.append(r - q if r > q//2 else r)
print('LWE check: max|b-A*s| =', max(abs(x) for x in res), ' values set =', sorted(set(res)))
assert max(abs(x) for x in res) <= 1

# 2) derive keystream = SHA256(bytes of mask bits) and unmask the update
mask_bytes = bytes(mask)                      # 32 bytes of 0x00 / 0x01
ks = hashlib.sha256(mask_bytes).digest()      # 32-byte digest
flag = bytes(c ^ k for c, k in zip(mu, ks))
print('mask_bytes  =', mask_bytes.hex())
print('sha256(mask)=', ks.hex())
print('masked_update=', mu.hex())
print('FLAG        =', flag.decode())

# 3) re-mask to confirm round trip
assert bytes(c ^ k for c, k in zip(flag, ks)) == mu
assert flag == b'flag{mask_seed_from_dropout}'
print('OK: reproducible')
