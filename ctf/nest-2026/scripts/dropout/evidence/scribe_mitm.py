#!/usr/bin/env python3
"""Scribe independent solve of 'dropout' via meet-in-the-middle.

No lattice reduction and no reuse of the teammate's mask: enumerate all
2^16 low-bit and 2^16 high-bit halves of a 32-bit 0/1 mask, join on row 0
(b - A s must lie in {-1,0,1} mod q for every row) and filter remaining rows.
Then unmask with SHA256(bytes(mask)).
"""
import json, hashlib
import numpy as np

d = json.load(open('attachments/samples/samples.json'))
q, n, m = d['q'], d['n'], d['m']
A = np.array(d['A'], dtype=np.int64)
b = np.array(d['b'], dtype=np.int64)
mu = bytes.fromhex(d['masked_update'])
assert (q, n, m) == (7681, 32, 64) and A.shape == (64, 32) and b.shape == (64,)

LO, HI = 16, 16
idx = np.arange(1 << LO, dtype=np.int64)
bits1 = ((idx[:, None] >> np.arange(LO)) & 1).astype(np.int64)   # (2^16,16)
bits2 = ((idx[:, None] >> np.arange(HI)) & 1).astype(np.int64)
S1 = (bits1 @ A[:, :LO].T) % q       # (65536,64)
S2 = (bits2 @ A[:, LO:].T) % q
print('tables built:', S1.shape, S2.shape, 'q=', q)

# bucket low-half vectors by their row-0 value
table = {}
for r, v in enumerate(S1[:, 0].tolist()):
    table.setdefault(v, []).append(r)

sols = []
CH = 2048
for start in range(0, 1 << HI, CH):
    t = ((b[0] - S2[start:start + CH, 0]) % q).tolist()
    I1, I2 = [], []
    for off, tv in enumerate(t):
        for delta in (-1, 0, 1):
            need = (tv + delta) % q
            hit = table.get(need)
            if hit:
                I1.extend(hit)
                I2.extend([start + off] * len(hit))
    if not I1:
        continue
    I1 = np.array(I1, dtype=np.int64)
    I2 = np.array(I2, dtype=np.int64)
    R = (S1[I1] + S2[I2] - b) % q
    ok = np.all((R == 0) | (R == 1) | (R == q - 1), axis=1)
    for k in np.nonzero(ok)[0]:
        s = int(I1[k]) | (int(I2[k]) << LO)
        mask = [(s >> j) & 1 for j in range(n)]
        e = R[k].copy()
        e[e == q - 1] = -1
        sols.append((mask, e))
    print(f'chunk {start:5d}: candidates={len(I1):7d} surviving={len(sols)}')

print('total solutions with s in {0,1}^32 and e in {-1,0,1}^64:', len(sols))
assert len(sols) >= 1
for mask, e in sols:
    ks = hashlib.sha256(bytes(mask)).digest()
    flag = bytes(x ^ y for x, y in zip(mu, ks))
    print('mask      =', ''.join(map(str, mask)), f'ones={sum(mask)}')
    print('e set     =', sorted(set(int(x) for x in e)), 'max|e| =', int(np.max(np.abs(e))))
    print('sha256    =', ks.hex())
    print('FLAG      =', flag.decode())
    print('roundtrip =', bytes(x ^ y for x, y in zip(flag, ks)) == mu)
    if flag == b'flag{mask_seed_from_dropout}':
        out = {'unique': len(sols) == 1, 'mask': mask, 'flag': flag.decode(),
               'ones': sum(mask), 'e_set': sorted(set(int(x) for x in e))}
        json.dump(out, open('evidence/scribe_mitm_output.json', 'w'), indent=1)
        print('MATCHED flag{mask_seed_from_dropout}')
