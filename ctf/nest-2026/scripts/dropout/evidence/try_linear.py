import json, itertools, numpy as np
d=json.load(open('attachments/samples/samples.json'))
q,n,m=d['q'],d['n'],d['m']
A=np.array(d['A'],dtype=np.int64); b=np.array(d['b'],dtype=np.int64)

def solve_mod(Ain, bin, q):
    # Gaussian elimination over F_q, returns one solution if consistent (square)
    A=Ain.copy()%q; b=bin.copy()%q; N=A.shape[0]
    for c in range(N):
        piv=None
        for i in range(c,N):
            if A[i,c]%q: piv=i;break
        if piv is None: return None
        A[[c,piv]]=A[[piv,c]]; b[[c,piv]]=b[[piv,c]]
        inv=pow(int(A[c,c]),q-2,q)
        A[c]=(A[c]*inv)%q; b[c]=(b[c]*inv)%q
        for i in range(N):
            if i!=c and A[i,c]%q:
                f=A[i,c]%q
                A[i]=(A[i]-f*A[c])%q; b[i]=(b[i]-f*b[c])%q
    return b%q

def check(s, label):
    s=np.array(s)%q
    resid=(A@s-b)%q
    ss=[int(x) if x<q//2 else int(x)-q for x in s]
    small=all(-256<x<256 for x in ss)
    print(label,'small s?',small)
    print('  s=',ss[:12],'...')
    try:
        bs=bytes([x%256 for x in s])
        print('  bytes:',bs)
    except Exception as e: print(e)
    print('  resid nonzero among all rows:',int((resid!=0).sum()),'maxresid',int(np.max(np.minimum(resid,q-resid))))

# try many subsets of 32 rows
import random
random.seed(1)
for t in range(5):
    idx=random.sample(range(m),n)
    s=solve_mod(A[idx],b[idx],q)
    if s is None: print('singular'); continue
    check(s,f'random subset {t} rows {sorted(idx)[:6]}...')
