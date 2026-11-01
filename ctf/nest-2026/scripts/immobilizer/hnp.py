import json, hashlib, sys, time
from lll import lll
sys.path.insert(0, 'work')
from ec import n, G, mul

def z_of(msg):
    return int.from_bytes(hashlib.sha256(msg.encode()).digest(), 'big') % n

def build_and_lll(sigs, B, verbose=True):
    m = len(sigs)
    a=[]; b=[]
    for msg, r, s in sigs:
        si = pow(s, n-2, n)
        z = z_of(msg)
        a.append(r*si % n)
        b.append(z*si % n)
    dim = m+2
    M = [[0]*dim for _ in range(dim)]
    NB = n*B
    for i in range(m):
        M[i][i] = n*n
    for i in range(m):
        M[m][i] = (n*a[i]) % (n*n)
        M[m+1][i] = (n*b[i]) % (n*n)
    M[m][m] = B
    M[m+1][m+1] = NB
    t0=time.time()
    R, it = lll(M, verbose=verbose)
    if verbose: print(f'[lll] m={m} B=2^{B.bit_length()-1} dim={dim} iters={it} took {time.time()-t0:.1f}s', flush=True)
    return R

def try_recover(R, m, Q, sigs, B):
    NB = n*B
    found=[]
    for row in R:
        last = row[m+1]
        if last == 0: continue
        num = row[m]*n
        if num % last != 0: continue
        cand = (num // last) % n
        for d in {cand, (-cand) % n}:
            if mul(d, G) == Q:
                found.append(d)
    return found

def verify_all(d, sigs, B=None):
    res=[]
    for msg,r,s in sigs:
        z=z_of(msg)
        k = (pow(s, n-2, n) * (z + r*d)) % n
        ok = (s*k - z - r*d) % n == 0
        res.append((k, ok, k < B if B else None))
    return res

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'synth':
        import random
        random.seed(1234)
        d = random.randrange(1, n)
        Q = mul(d, G)
        l = int(sys.argv[2]) if len(sys.argv)>2 else 128
        m = int(sys.argv[3]) if len(sys.argv)>3 else 10
        sigs=[]
        ks=[]
        for i in range(m):
            k = random.randrange(1, 1<<l)
            ks.append(k)
            msg = f'test|ctr={i}'
            z = z_of(msg)
            r = mul(k, G)[0] % n
            s = (pow(k, n-2, n) * (z + r*d)) % n
            sigs.append((msg, r, s))
        B = 1 << l
        R = build_and_lll(sigs, B)
        found = try_recover(R, m, Q, sigs, B)
        print('found:', found[:1], 'expected:', d, 'match:', d in found)
    else:
        data = json.load(open('attachments/data/data.json'))
        Q = (int(data['public_key']['x']), int(data['public_key']['y']))
        sigs = [(sg['msg'], int(sg['r']), int(sg['s'])) for sg in data['signatures']]
        l = int(sys.argv[2]); m = int(sys.argv[3]) if len(sys.argv)>3 else len(sigs)
        B = 1 << l
        R = build_and_lll(sigs[:m], B)
        found = try_recover(R, m, Q, sigs[:m], B)
        print('FOUND d:', found)
        if found:
            d = found[0]
            print('d hex:', hex(d))
            chk = verify_all(d, sigs, B)
            print('signatures consistent:', sum(1 for _,ok,_ in chk if ok), '/', len(chk))
            print('nonce bit lengths:', [k.bit_length() for k,_,_ in chk])
            open('evidence/recovered_d.txt','w').write(hex(d)+'\n')
