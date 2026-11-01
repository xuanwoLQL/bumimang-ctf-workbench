#!/usr/bin/env python3
"""Scribe independent re-derivation of the dropout flag.

Does NOT reuse the mask hardcoded in verify_flag.py: it re-solves the LWE
instance from attachments/samples/samples.json with z3 and then performs
the SHA256 unmask. Also checks uniqueness by blocking the first model.
Writes a JSON summary to evidence/scribe_independent_output.json.
"""
import json, hashlib, sys
from z3 import Bool, Int, If, Sum, Solver, sat

P = 'attachments/samples/samples.json'
raw = open(P, 'rb').read()
d = json.loads(raw)
q, n, m = d['q'], d['n'], d['m']
A, b = d['A'], d['b']
mu = bytes.fromhex(d['masked_update'])

print('samples.json sha256 =', hashlib.sha256(raw).hexdigest())
print(f'q={q} n={n} m={m} A={len(A)}x{len(A[0])} b={len(b)} masked_update={len(mu)}B')
assert (n, m) == (32, 64) and q == 7681
assert len(A) == m and all(len(r) == n for r in A) and len(b) == m

s = [Bool(f's{j}') for j in range(n)]
e = [Int(f'e{i}') for i in range(m)]
sol = Solver()
for i in range(m):
    lin = Sum([If(s[j], A[i][j], 0) for j in range(n)]) + e[i]
    sol.add(lin % q == b[i] % q)
    sol.add(e[i] >= -1, e[i] <= 1)

def model_mask(model):
    return [1 if model.eval(s[j]) else 0 for j in range(n)]

found = []
while len(found) < 2:
    if sol.check() != sat:
        break
    md = sol.model()
    mask = model_mask(md)
    ev = [md.eval(e[i]).as_long() for i in range(m)]
    found.append((mask, ev))
    # block this exact assignment
    sol.add(sum((s[j] if mask[j] else ~s[j]) for j in range(n)) < n)

print('number of (0/1-mask, e in {-1,0,1}) models found:', len(found))
for k, (mask, ev) in enumerate(found):
    res = [(b[i] - sum(A[i][j]*mask[j] for j in range(n))) % q for i in range(m)]
    res = [r - q if r > q//2 else r for r in res]
    ok = (res == ev) and max(abs(x) for x in res) <= 1
    ks = hashlib.sha256(bytes(mask)).digest()
    flag = bytes(x ^ y for x, y in zip(mu, ks)).decode()
    print(f'[{k}] ones={sum(mask)} mask={"".join(map(str,mask))} max|e|={max(abs(x) for x in res)} '
          f'zeros={res.count(0)} SHA256={ks.hex()} FLAG={flag} consistent={ok}')

if len(found) == 1:
    mask = found[0][0]
    ks = hashlib.sha256(bytes(mask)).digest()
    flag = bytes(x ^ y for x, y in zip(mu, ks))
    assert flag == b'flag{mask_seed_from_dropout}', flag
    print('UNIQUE model; FLAG matches flag{mask_seed_from_dropout}; re-mask roundtrip OK:',
          bytes(x ^ y for x, y in zip(flag, ks)) == mu)
    json.dump({'unique': True, 'mask': mask, 'flag': flag.decode(),
               'samples_sha256': hashlib.sha256(raw).hexdigest()},
              open('evidence/scribe_independent_output.json', 'w'), indent=1)
else:
    print('WARNING: not unique within z3 model search', file=sys.stderr)
    sys.exit(2)
