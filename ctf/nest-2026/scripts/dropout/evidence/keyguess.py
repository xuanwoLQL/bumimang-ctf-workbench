#!/usr/bin/env python3
import hashlib, hmac, random, struct, json, itertools

MU = bytes.fromhex('7c53ddbd82faf811c0397982909a9498644d63fb50a6e697d7cf97f6')
# recovered secret (dropout mask): -1 positions
S = [-1, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, -1, -1, -1, 0, -1, 0, 0, -1, -1, -1, 0, -1, 0, 0]
E = None  # fill if needed

bits = bytes(1 if x!=0 else 0 for x in S)          # 32 bytes 0/1
bits_ff = bytes(0xff if x!=0 else 0 for x in S)
packed_be = int(''.join('1' if x else '0' for x in S), 2).to_bytes(4,'big')
packed_le = int(''.join('1' if x else '0' for x in S)[::-1], 2).to_bytes(4,'big')
packed_lsb = int.from_bytes(bytes(1 if x!=0 else 0 for x in S), 'little').to_bytes(32,'little')
strs = {
 'bits_raw': bits,
 'bits_ff': bits_ff,
 'packed_be': packed_be,
 'packed_le': packed_le,
 'packed_lsb': packed_lsb,
 'repr': repr(S).encode(),
 'str': str(S).encode(),
 'json': json.dumps(S).encode(),
 'concat': ''.join(str(x) for x in S).encode(),
 'hex': bytes(S).hex().encode() if all(0<=x<256 for x in S) else b'',
 'joincomma': ','.join(str(x) for x in S).encode(),
}
ints = {
 'bits_int_be': int(''.join('1' if x else '0' for x in S), 2),
 'bits_int_lsb': int(''.join('1' if x else '0' for x in S)[::-1], 2),
 'bits_bytes_be': int.from_bytes(bits,'big'),
 'bits_bytes_le': int.from_bytes(bits,'little'),
 'bits_ff_be': int.from_bytes(bits_ff,'big'),
}

def ok(pt):
    if not pt: return False
    if b'{' in pt and b'}' in pt and all(32<=c<127 for c in pt):
        return True
    return False

hits=[]
def report(label, pt):
    if ok(pt):
        hits.append((label,pt))
        print('HIT',label,pt)

# XOR helpers
def xorrep(data, key):
    if not key: return b''
    return bytes(c ^ key[i%len(key)] for i,c in enumerate(data))

# 1. hash-derived keystreams
for name,k in strs.items():
    for hn in ['md5','sha1','sha224','sha256','sha384','sha512','sha3_256','sha3_512','blake2b','blake2s']:
        d = hashlib.new(hn, k).digest()
        report('xor_%s_%s'%(hn,name), xorrep(MU,d))
        # hex digest as ascii
        report('xorhex_%s_%s'%(hn,name), xorrep(MU,hashlib.new(hn,k).hexdigest().encode()))
    # shake
    for sh in ['shake_128','shake_256']:
        for outlen in [len(MU), 64]:
            d = hashlib.new(sh, k).digest(outlen)
            report('xor_%s_%s'%(sh,name), xorrep(MU,d))
    # hmac with key hash
    for hn in ['sha256','sha512']:
        d = hashlib.new(hn,k).digest()
        for hn2 in ['sha256','sha512']:
            report('hmac_%s_%s'%(hn2,name), xorrep(MU, hmac.new(d, MU, hn2).digest()))

# 2. python random seeds
for name,seed in ints.items():
    for tag,gen in [('randbytes', lambda r: r.randbytes(len(MU))),
                    ('getrandbits8', lambda r: bytes(r.getrandbits(8) for _ in range(len(MU)))),
                    ('randrange256', lambda r: bytes(r.randrange(256) for _ in range(len(MU)))),
                    ('randint255', lambda r: bytes(r.randint(0,255) for _ in range(len(MU)))),
                    ('getrandbits28', lambda r: (r.getrandbits(len(MU)*8)).to_bytes(len(MU),'big'))]:
        r = random.Random(seed)
        try:
            ks = gen(r)
        except Exception as ex:
            continue
        report('py_%s_%s'%(tag,name), xorrep(MU,ks))

# 3. AES / ChaCha
try:
    from Crypto.Cipher import AES, ChaCha20
    have=True
except Exception:
    have=False
print('pycryptodome',have)
if have:
    keycands={}
    for name,k in strs.items():
        keycands['raw16_'+name]=hashlib.sha256(k).digest()[:16]
        keycands['raw32_'+name]=hashlib.sha256(k).digest()
        keycands['md5_'+name]=hashlib.md5(k).digest()
        keycands['key_'+name]=k[:32].ljust(32,b'\0')[:32]
    for name,key in keycands.items():
        for nonce in [b'\0'*16, b'\0'*8, bytes(8)+b'\0'*8]:
            for ctr in [0,1]:
                try:
                    ct = AES.new(key[:32] if len(key) in (24,32) else key[:16].ljust(16,b'\0'),
                                  AES.MODE_CTR, nonce=nonce[:8], initial_value=ctr)
                    report('aesctr_%s_%s_%d'%(name,nonce.hex(),ctr), ct.decrypt(MU))
                except Exception as ex:
                    pass
        try:
            c = ChaCha20.new(key=key[:32], nonce=b'\0'*8)
            report('chacha_'+name, c.decrypt(MU))
        except Exception:
            pass

print('total hits',len(hits))
for h in hits: print(h)
