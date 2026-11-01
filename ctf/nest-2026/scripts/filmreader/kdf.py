import hashlib, itertools, os, sys, time
from multiprocessing import Pool

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REC = os.path.join(BASE, 'evidence', 'recovered')
RODATA = open(os.path.join(BASE, 'extracted', 'ko__rodata.bin'), 'rb').read()

TARGET = bytes(b ^ 0xa6 for b in RODATA[0x3c0:0x3d0])
ITER = 0x1ffffff  # 33_554_431 extra iterations, +1 initial

INDEX = {}
for fn in os.listdir(REC):
    INDEX[fn.split('_', 1)[1]] = os.path.join(REC, fn)

def rd(name):
    return open(INDEX[name], 'rb').read()

def work(args):
    s1n, s2n, s3n = args
    s1, s2, s3 = rd(s1n), rd(s2n), rd(s3n)
    x = s2[0] & 3
    # dynamic path is /var/.cache/.kmod/.k{x}
    sxn = '.k%d' % x
    try:
        sx = rd(sxn)
    except FileNotFoundError:
        sx = b'\x00' * 64
    seed = s1[:4] + s2[:4] + s3[:4] + sx[:4]
    h = hashlib.sha256(seed).digest()
    for _ in range(ITER):
        h = hashlib.sha256(h).digest()
    ok = h[16:32] == TARGET
    return (s1n, s2n, s3n, sxn, ok, h.hex())

if __name__ == '__main__':
    combos = [(a, b, c) for a in ('.s1', '.s1.bak', '.s1.old')
                          for b in ('.s2', '.s2.bak')
                          for c in ('.s3', '.s3.bak')]
    t = time.time()
    with Pool(8) as p:
        for r in p.imap_unordered(work, combos):
            print(r, flush=True)
    print('target', TARGET.hex(), 'elapsed %.1fs' % (time.time() - t))
