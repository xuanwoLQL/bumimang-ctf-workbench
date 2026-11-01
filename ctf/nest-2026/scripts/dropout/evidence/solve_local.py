#!/usr/bin/env python3
# Full local reproduction of the "dropout" crypto challenge using sympy's exact LLL
# (no fpylll / no Kali needed).  Run with:
#   "D:\Crypto tools\pyenv\Scripts\python.exe" evidence\solve_local.py
import json, hashlib, sys, time
from sympy import Matrix, QQ

d = json.load(open('attachments/samples/samples.json'))
q, n, m = d['q'], d['n'], d['m']
A, b = d['A'], d['b']
mu = bytes.fromhex(d['masked_update'])
print('q,n,m =', q, n, m, '| |masked_update| =', len(mu), 'bytes')
assert q == 7681 and n == 32 and m == 64

# ---- Kannan embedding, dim m+n+1 = 97 ----
dim = m + n + 1
M = Matrix.zeros(dim, dim)
for i in range(m):
    M[i, i] = q
for j in range(n):
    for i in range(m):
        M[m + j, i] = A[i][j]
    M[m + j, m + j] = 1
for i in range(m):
    M[m + n, i] = b[i]
M[m + n, m + n] = 1

t0 = time.time()
R = M.lll(delta=QQ(99, 100))
print('LLL done in %.1fs, dim=%d' % (time.time() - t0, dim))

def centered(x):
    x %= q
    return x - q if x > q // 2 else x

cands = []
for r in range(dim):
    row = [int(R[r, c]) for c in range(dim)]
    if abs(row[-1]) != 1:
        continue
    sign = row[-1]
    s = [row[m + j] * sign for j in range(n)]          # binary mask coefficients
    e = [row[i] * sign for i in range(m)]
    # relation checked independently below; store raw
    cands.append((s, e))

print('short vectors with last coord +-1:', len(cands))
best = None
for s, e in cands:
    # the row was normalised by its last coordinate, so the sign convention is
    # e = sign*b + A*s (mod q); try both sign conventions for the mask.
    for c in (s, [-x for x in s]):
        res = [centered(b[i] - sum(A[i][j] * c[j] for j in range(n))) for i in range(m)]
        if max(abs(x) for x in res) <= 1 and all(x in (0, 1) for x in c):
            best = c
            print('FOUND unique short solution')
            print('  s (bits) =', best)
            print('  e        =', res)
            print('  max|e|   =', max(abs(x) for x in res))
            break
    if best is not None:
        break

assert best is not None, 'no short solution found'
assert all(x in (0, 1) for x in best)

# ---- unmask ----
mb = bytes(best)
ks = hashlib.sha256(mb).digest()
flag = bytes(x ^ y for x, y in zip(mu, ks))
print('  mask bytes  =', mb.hex())
print('  sha256(mask)=', ks.hex())
print('  masked_upd  =', mu.hex())
print('  FLAG        =', flag.decode())
assert flag == b'flag{mask_seed_from_dropout}'
assert bytes(x ^ y for x, y in zip(flag, ks)) == mu
print('OK: full local reproduction succeeded')
