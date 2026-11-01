import os, struct, re, hashlib
E=os.path.join(os.path.dirname(os.path.abspath(__file__)),"evidence")
raw=open(os.path.join(E,"formal.wexp"),"rb").read()
print("file",len(raw))
for off in [64,80]:
    body=raw[off:off+1088]
    print("off",off,"bodylen",len(body),"tail",len(raw)-off-1088)
body=raw[80:80+1088]
open(os.path.join(E,"formal_payload_0x50.bin"),"wb").write(body)
M=0xffffffff
def rol(x,n):n&=31;return ((x<<n)|(x>>((32-n)&31)))&M
C1=0x9e3779b9;C2=0x85ebca6b;C3=0xc2b2ae35
def mix(a,b):
    v=(a+b*C1)&M;v^=rol(v,13);v=(v*C2)&M;v^=v>>16;return (rol(v,7)+C3)&M
seed=0xc6adc3e6
n=(mix(seed,0)&15)+1;m=mix(seed,1)%17;sh=mix(seed,2)&63
print("params",n,m,sh)
P=bytearray(1088)
for i in range(17):
    j=(i*n+m)%17
    for k in range(64):
        pos=(k*13+sh)&63
        P[j*64+pos]=body[i*64+k]^(mix(seed,i*64+k)&0xff)
P=bytes(P)
open(os.path.join(E,"formal_plain_0xc6adc3e6.bin"),"wb").write(P)
print("magic",P[:4],"ver",struct.unpack_from("<H",P,4)[0],"bs",struct.unpack_from("<H",P,6)[0],"rows",struct.unpack_from("<I",P,8)[0])
f,p,mm,h,g=[struct.unpack_from("<I",P,o)[0] for o in (28,32,36,40,44)]
print("f,p,m,h,g",f,p,mm,h,g)
rows=struct.unpack_from("<I",P,8)[0]
for t in range(rows):
    s=struct.unpack_from("<I",P,mm+t*4)[0]; e=struct.unpack_from("<I",P,mm+(t+1)*4)[0]
    print(t, P[h+s:h+e])
print("all strings:")
for s in re.findall(rb"[\x20-\x7e]{6,}",P):
    print("  ",s.decode("latin1"))
txt=P.decode("latin1")
for kw in ["flag","FLAG","secret","key","token","redrive","sha256","export_id"]:
    j=txt.lower().find(kw.lower())
    if j>=0: print("KW",kw,"at",j,repr(txt[max(0,j-80):j+160]))
