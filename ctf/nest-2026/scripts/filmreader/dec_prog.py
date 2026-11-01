import hashlib, os
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROD = open(os.path.join(BASE, 'extracted', 'ko__rodata.bin'), 'rb').read()
blob = ROD[0x200:0x3c0]
digest = bytes.fromhex('a65dc30a337a3faee5a58c868fc3e715e3b9cbcd45c9fcec9fd1f00a1f4a2371')
M = (1 << 64) - 1
st = (int.from_bytes(digest[:4], 'little') ^ 0x5a5a5a5a5a5a5a5a) & M
out = bytearray()
for b in blob:
    st = (st * 0x5851f42d4c957f2d + 0x14057b7ef767814f) & M
    out.append(b ^ (st >> 56))
open(os.path.join(BASE, 'evidence', 'vm_prog.bin'), 'wb').write(out)
print('seed words', digest[:8].hex(), digest[8:16].hex())
print('prog:', out.hex(' '))
print('low<0x20 ratio', sum(1 for b in out if b < 0x20) / len(out))
