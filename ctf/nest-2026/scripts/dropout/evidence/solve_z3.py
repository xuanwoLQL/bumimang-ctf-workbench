#!/usr/bin/env python3
# Independent z3-based recovery of the dropout mask (second method, no LLL).
#   "D:\Crypto tools\pyenv\Scripts\python.exe" evidence\solve_z3.py
import json, hashlib
from z3 import Int, Solver, Or, sat, Sum

d = json.load(open('attachments/samples/samples.json'))
q, n, m = d['q'], d['n'], d['m']
A, b = d['A'], d['b']
mu = bytes.fromhex(d['masked_update'])

s = [Int('s_%d' % j) for j in range(n)]
e = [Int('e_%d' % i) for i in range(m)]
k = [Int('k_%d' % i) for i in range(m)]
S = Solver()
for j in range(n):
    S.add(Or(s[j] == 0, s[j] == 1))
for i in range(m):
    S.add(Or(e[i] == -1, e[i] == 0, e[i] == 1))
    # b_i = A_i . s + e_i - q*k_i
    S.add(b[i] == Sum([A[i][j] * s[j] for j in range(n)]) + e[i] - q * k[i])
print('solving with z3 ...')
assert S.check() == sat, 'unsat'
M = S.model()
mask = [M.eval(x).as_long() for x in s]
ev = [M.eval(x).as_long() for x in e]
print('mask =', mask)
print('e    =', ev)
print('max|e| =', max(abs(x) for x in ev))
mb = bytes(mask)
ks = hashlib.sha256(mb).digest()
flag = bytes(x ^ y for x, y in zip(mu, ks))
print('FLAG =', flag.decode())
assert flag == b'flag{mask_seed_from_dropout}'
print('OK: z3 reproduction agrees with LLL result')
