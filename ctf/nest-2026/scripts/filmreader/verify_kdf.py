import hashlib, struct, sys, time
base = "extracted/deleted/"
name = {27:'.real_cache.bak',28:'.real_cache',29:'.s1',30:'.s2',31:'.s3',32:'.k2',
        33:'.s1.bak',34:'.s1.old',35:'.s2.bak',36:'.s3.bak',37:'.k0',38:'.k1',39:'.k3'}
D = {ino: open(base+f'ino{ino}.bin','rb').read() for ino in name}
ro = open("evidence/verify/rodata_s.bin","rb").read()
target = bytes(b ^ 0xa6 for b in ro[0x3c0:0x3d0])
print("target h[16:32] =", target.hex())

def kdf(seed, iters):
    h = hashlib.sha256(seed).digest()
    for _ in range(iters):
        h = hashlib.sha256(h).digest()
    return h

# candidate combos
s1s = [(29,'.s1'),(33,'.s1.bak'),(34,'.s1.old')]
s2s = [(30,'.s2'),(35,'.s2.bak')]
s3s = [(31,'.s3'),(36,'.s3.bak')]
iters = 0x1ffffff
results = []
t0=time.time()
for i1,n1 in s1s:
    for i2,n2 in s2s:
        for i3,n3 in s3s:
            kino = {0:37,1:38,2:32,3:39}[D[i2][0] & 3]
            seed = D[i1][:4] + D[i2][:4] + D[i3][:4] + D[kino][:4]
            h = kdf(seed, iters)
            ok = (h[16:32] == target)
            print(f"{n1}+{n2}+{n3}+{name[kino]} seed={seed.hex()} h16={h[16:32].hex()} match={ok} t={time.time()-t0:.1f}s", flush=True)
            results.append((ok,n1,n2,n3,name[kino],h.hex(),seed.hex()))
            if ok: break
        if any(r[0] for r in results): break
    if any(r[0] for r in results): break
with open("evidence/verify/kdf_results.txt","w") as f:
    for r in results:
        f.write(repr(r)+"\n")
print("done", time.time()-t0)
