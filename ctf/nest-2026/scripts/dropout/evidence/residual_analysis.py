import json
d=json.load(open('attachments/samples/samples.json'))
q,n,m=d['q'],d['n'],d['m']; A=d['A']; b=d['b']
mask=[1,0,0,0,0,0,0,1,0,0,0,0,0,1,1,0,0,0,1,1,1,0,1,0,0,1,1,1,0,1,0,0]
res=[]
for i in range(m):
    r=(b[i]-sum(A[i][j]*mask[j] for j in range(n)))%q
    res.append(r-q if r>q//2 else r)
zeros=[i for i,x in enumerate(res) if x==0]
print('A shape',len(A),'x',len(A[0]))
print('residual values',sorted(set(res)))
print('zero-residual rows:',len(zeros),zeros)
print('+-1 rows:',m-len(zeros))
print('<32 zero rows => no 32-row all-zero subsystem; lattice needed')
