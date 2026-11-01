import json,struct,base64
d=json.load(open('attachments/samples/samples.json'))
A=d['A']; b=d['b']
raw=struct.pack('<HHH',d['q'],d['n'],d['m'])
for row in A:
    raw+=struct.pack('<%dH'%len(row),*row)
raw+=struct.pack('<%dH'%len(b),*b)
mu=bytes.fromhex(d['masked_update'])
raw+=bytes([len(mu)])+mu
b64=base64.b64encode(raw).decode()
open('evidence/samples.bin','wb').write(raw)
open('evidence/samples_bin.b64','w').write(b64)
print('raw',len(raw),'b64',len(b64))
for i in range(0,len(b64),1800):
    print('CHUNK%d'%(i//1800), b64[i:i+1800])
