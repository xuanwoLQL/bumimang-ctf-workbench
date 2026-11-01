import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vmm import run

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = bytes.fromhex('a65dc30a337a3faee5a58c868fc3e715')  # digest[0:16] from init KDF
TABLE = b'sh4d0w_1n_7h3_k3rn3l'

def ror8(x, n):
    n &= 7
    return ((x >> n) | (x << (8 - n))) & 0xff if n else x

def simple_dec(data):
    out = bytearray()
    for i, c in enumerate(data):
        b = (c - TABLE[(3 + 7 * i) % 20]) & 0xff
        b = ror8(b, i & 7)
        b ^= TABLE[i % 20]
        out.append(b)
    return bytes(out)

def vm_dec(data):
    out = bytearray()
    for off in range(0, len(data) - 7, 8):
        blk = data[off:off + 8]
        ctx = bytearray(KEY + blk)
        run(bytes(ctx))
        # run() returns full buffer; recompute here
        res, _ = run(bytes(KEY + blk))
        out += res[16:24]
    return bytes(out)

if __name__ == '__main__':
    flag = open(os.path.join(BASE, 'extracted', 'home_ctf_flag.txt'), 'rb').read()
    print('flag.txt len', len(flag))
    print('simple  :', simple_dec(flag))
    for name in ('28_.real_cache', '27_.real_cache.bak'):
        d = open(os.path.join(BASE, 'evidence', 'recovered', name), 'rb').read()
        print(name, len(d))
        r = vm_dec(d)
        print('  vm_dec:', r)
        print('  txt   :', r.decode('latin1'))
        # also try applying simple_dec after vm, just in case
        print('  vm+simple:', simple_dec(r))
