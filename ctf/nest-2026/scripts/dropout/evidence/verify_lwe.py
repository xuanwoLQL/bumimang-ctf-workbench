#!/usr/bin/env python3
import struct, sys, json
from fpylll import IntegerMatrix, LLL, BKZ

def load(path):
    raw = open(path,'rb').read()
    q,n,m = struct.unpack_from('<HHH', raw, 0)
    off = 6
    A = []
    for i in range(m):
        A.append(list(struct.unpack_from('<%dH'%n, raw, off))); off += 2*n
    b = list(struct.unpack_from('<%dH'%m, raw, off)); off += 2*m
    ln = raw[off]; off += 1
    mu = raw[off:off+ln]
    return q,n,m,A,b,mu

q,n,m,A,b,mu = load('/tmp/samples.bin')
print('q,n,m',q,n,m,'mu',mu.hex())

def build():
    d = m+n+1
    B = IntegerMatrix(d, d)
    for i in range(m): B[i,i] = q
    for j in range(n):
        for i in range(m): B[m+j, i] = A[i][j]
        B[m+j, m+j] = 1
    for i in range(m): B[m+n, i] = b[i]
    B[m+n, m+n] = 1
    return B,d

def candidates(B,d):
    out=[]
    for r in range(d):
        row=[B[r,c] for c in range(d)]
        if abs(row[-1])!=1: continue
        sign=row[-1]
        c=[row[m+j]*sign for j in range(n)]
        e=[row[i]*sign for i in range(m)]
        # relation: e = sign*b + A*c mod q  --> verify
        pred=[(sign*b[i] + sum(A[i][j]*c[j] for j in range(n))) % q for i in range(m)]
        pred=[x-q if x>q//2 else x for x in pred]
        ok = pred==e
        out.append((sign,c,e,ok))
    return out

B,d = build()
LLL.reduction(B, delta=0.99)
print('--- after LLL ---')
for sign,c,e,ok in candidates(B,d):
    nz=sum(1 for x in c if x)
    if max(abs(x) for x in c)<=2 and max(abs(x) for x in e)<=2:
        print('sign',sign,'s-nonzero',nz,'s=',c)
        print('  e maxabs',max(abs(x) for x in e),'e-nz',sum(1 for x in e if x))
        print('  relation ok(verify sign*b+A*c==e):',ok)
        print('  s-bits',''.join('1' if x!=0 else '0' for x in c))
print('--- BKZ 20 ---')
BKZ.reduction(B, BKZ.Param(block_size=20, max_loops=8))
seen=set()
for sign,c,e,ok in candidates(B,d):
    if max(abs(x) for x in c)<=2 and max(abs(x) for x in e)<=2:
        key=tuple(c)
        if key in seen: continue
        seen.add(key)
        print('CAND s=',c,'ok',ok,'bits',''.join('1' if x!=0 else '0' for x in c),'e-nz',sum(1 for x in e if x))
print('num distinct small cands',len(seen))
