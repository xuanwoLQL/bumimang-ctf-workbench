#!/usr/bin/env python3
import struct, sys
from fpylll import IntegerMatrix, LLL, BKZ

def load(path):
    raw = open(path,'rb').read()
    q,n,m = struct.unpack_from('<HHH', raw, 0)
    off = 6
    A = []
    for i in range(m):
        row = list(struct.unpack_from('<%dH'%n, raw, off)); off += 2*n
        A.append(row)
    b = list(struct.unpack_from('<%dH'%m, raw, off)); off += 2*m
    ln = raw[off]; off += 1
    mu = raw[off:off+ln]
    return q,n,m,A,b,mu

q,n,m,A,b,mu = load(sys.argv[1] if len(sys.argv)>1 else '/tmp/samples.bin')
print('q,n,m',q,n,m,'mu',mu.hex())

def centered(x):
    x %= q
    return x-q if x> q//2 else x

def stats(v):
    return 'maxabs=%d norm2=%d' % (max(abs(x) for x in v), sum(x*x for x in v))

def try_embedding(delta=0.99, bkz=0):
    d = m+n+1
    B = IntegerMatrix(d, d)
    for i in range(m):
        B[i,i] = q
    for j in range(n):
        for i in range(m):
            B[m+j, i] = A[i][j]
        B[m+j, m+j] = 1
    for i in range(m):
        B[m+n, i] = b[i]
    B[m+n, m+n] = 1
    print('reducing dim',d,'delta',delta,'bkz',bkz)
    LLL.reduction(B, delta=delta)
    if bkz:
        BKZ.reduction(B, BKZ.Param(block_size=bkz, max_loops=4))
    found = []
    for r in range(d):
        row = [B[r,c] for c in range(d)]
        if abs(row[-1]) == 1:
            c = [row[m+j]*row[-1] for j in range(n)]  # normalize sign
            e = [row[i]*row[-1] for i in range(m)]
            found.append((sum(x*x for x in c), c, e))
    found.sort(key=lambda t:t[0])
    for norm2,c,e in found[:10]:
        print('CAND s-norm2',norm2,'s=',c)
        print('   e stats',stats(e))
        bb = [ (b[i] - sum(A[i][j]*c[j] for j in range(n))) % q for i in range(m)]
        print('   resid(from b-As) stats', stats([centered(x) for x in bb]))
        # look like ascii?
        if all(0 <= x < 256 for x in c):
            print('   ASCII?', bytes([x%256 for x in c]))
    return found

if __name__ == '__main__':
    try_embedding(delta=0.99, bkz=0)
