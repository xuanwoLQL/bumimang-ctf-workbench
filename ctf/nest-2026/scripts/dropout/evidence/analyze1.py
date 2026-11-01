import json, numpy as np
d=json.load(open('attachments/samples/samples.json'))
q,n,m=d['q'],d['n'],d['m']
A=np.array(d['A'],dtype=np.int64); b=np.array(d['b'],dtype=np.int64)
print('q',q,'n',n,'m',m,'A',A.shape,'b',b.shape)
print('A min/max/mean',A.min(),A.max(),round(A.mean(),1))
print('b min/max/mean',b.min(),b.max(),round(b.mean(),1))
# rank mod q
def rank_mod(M,p):
    M=M.copy()%p; r=0; rows,cols=M.shape
    for c in range(cols):
        piv=None
        for i in range(r,rows):
            if M[i,c]%p: piv=i;break
        if piv is None: continue
        M[[r,piv]]=M[[piv,r]]
        inv=pow(int(M[r,c]),p-2,p)
        M[r]=(M[r]*inv)%p
        for i in range(rows):
            if i!=r and M[i,c]%p:
                M[i]=(M[i]-M[i,c]*M[r])%p
        r+=1
        if r==rows: break
    return r
print('rank A mod q =',rank_mod(A,q))
print('num distinct A vals',len(set(A.flatten().tolist())))
print('num zeros in A',int((A==0).sum()))
# check row duplicates
print('dup rows',m-len(set(map(tuple,A.tolist()))))
# masked update
mu=bytes.fromhex(d['masked_update'])
print('masked_update len',len(mu),mu)
