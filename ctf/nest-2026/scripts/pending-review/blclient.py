import http.client
import json
import re


class Bench:
    def __init__(self, host='127.0.0.1', port=18080):
        self.host = host
        self.port = port
        self.sid = None

    def req(self, method, path, body=None, headers=None, timeout=8):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        host_hdr = '%s:%d' % (self.host, self.port)
        h = {'Host': host_hdr, 'Connection': 'close'}
        if headers:
            h.update(headers)
        if self.sid:
            h['Cookie'] = 'SID=' + self.sid
        if body is not None and 'Content-Length' not in h:
            h['Content-Length'] = str(len(body))
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        resp_headers = dict((k.lower(), v) for k, v in r.getheaders())
        conn.close()
        return r.status, resp_headers, data

    def login(self, user='operator', password=''):
        if not password:
            raise ValueError('pass the password parsed from /cgi-bin/config-backup.bin')
        body = ('username=%s&password=%s' % (user, password)).encode()
        st, hd, data = self.req('POST', '/api/login', body,
                                {'Content-Type': 'application/x-www-form-urlencoded'})
        sc = hd.get('set-cookie', '')
        m = re.search(r'SID=([0-9a-f]+)', sc)
        if m:
            self.sid = m.group(1)
        return st, data

    def dispatch_get(self):
        st, hd, data = self.req('GET', '/api/service/dispatch')
        return st, json.loads(data) if st == 200 else data

    def dispatch_post(self, hexstr):
        st, hd, data = self.req('POST', '/api/service/dispatch', hexstr.encode(),
                                {'Content-Type': 'text/plain'})
        return st, data

    def authorize(self):
        st, j = self.dispatch_get()
        env = j['review_envelope']
        b = bytearray(bytes.fromhex(env))
        b[27] ^= 0x01
        return self.dispatch_post(bytes(b).hex())

    def create_job(self, data):
        st, hd, body = self.req('POST', '/api/service/jobs', data,
                                {'Content-Type': 'application/octet-stream'})
        try:
            return st, json.loads(body)
        except Exception:
            return st, body

    def cancel(self, jid):
        return self.req('POST', '/api/service/jobs/%d/cancel' % jid, b'')

    def revision(self, jid, data3):
        return self.req('POST', '/api/service/jobs/%d/revision' % jid, data3)

    def evidence(self, jid, data):
        return self.req('POST', '/api/service/jobs/%d/evidence' % jid, data)

    def receipt(self, jid):
        st, hd, body = self.req('GET', '/api/service/jobs/%d/receipt' % jid)
        try:
            return st, json.loads(body)
        except Exception:
            return st, body

    def jobs(self):
        st, hd, body = self.req('GET', '/api/service/jobs')
        return st, json.loads(body)

    def snapshot_post(self):
        return self.req('POST', '/api/service/snapshots', b'')

    def snapshot_get(self):
        st, hd, body = self.req('GET', '/api/service/snapshots')
        try:
            return st, json.loads(body)
        except Exception:
            return st, body
