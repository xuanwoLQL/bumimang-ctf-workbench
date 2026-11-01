#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal MQTT-over-WebSocket probe (authorized CTF use).

Usage:
  python ws_mqtt_probe.py --host HOST --port 58080 --path /mqtt \
      [--topics '#,frigate/#,home/#'] [--publish 'topic=payload'] [--wait 8]

Prints handshake status, CONNACK return code, SUBACK codes and every PUBLISH
packet (topic + payload) received within the wait window.
"""
import argparse
import base64
import os
import socket
import struct
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def enc_rem_len(n):
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            b |= 0x80
        out.append(b)
        if not n:
            break
    return bytes(out)


def utf8(s):
    raw = s.encode("utf-8")
    return struct.pack(">H", len(raw)) + raw


def mqtt_connect(client_id, keepalive=30):
    vh = utf8("MQTT") + bytes([4, 0x02]) + struct.pack(">H", keepalive) + utf8(client_id)
    return bytes([0x10]) + enc_rem_len(len(vh)) + vh


def mqtt_subscribe(pkt_id, topics):
    payload = struct.pack(">H", pkt_id)
    for t in topics:
        payload += utf8(t) + bytes([0x00])
    return bytes([0x82]) + enc_rem_len(len(payload)) + payload


def mqtt_publish(topic, data, qos=0):
    vh = utf8(topic)
    if qos:
        vh += struct.pack(">H", 1)
    body = vh + data
    return bytes([0x30 | (qos << 1)]) + enc_rem_len(len(body)) + body


def ws_frame(payload, opcode=0x2):
    mask = os.urandom(4)
    out = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        out.append(0x80 | n)
    elif n < 65536:
        out.append(0x80 | 126)
        out += struct.pack(">H", n)
    else:
        out.append(0x80 | 127)
        out += struct.pack(">Q", n)
    out += mask
    out += bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return bytes(out)


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("eof")
        buf += chunk
    return buf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=58080)
    ap.add_argument("--path", default="/mqtt")
    ap.add_argument("--topics", default="#")
    ap.add_argument("--publish", action="append", default=[])
    ap.add_argument("--wait", type=float, default=8.0)
    ap.add_argument("--client-id", default="probe-%d" % (os.getpid() % 100000))
    args = ap.parse_args()

    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: mqtt\r\n"
        "User-Agent: ws-mqtt-probe\r\n\r\n"
    ) % (args.path, args.host, args.port, key)

    s = socket.create_connection((args.host, args.port), timeout=10)
    s.settimeout(args.wait + 3)
    s.sendall(req.encode("ascii"))
    hdr = b""
    while b"\r\n\r\n" not in hdr:
        c = s.recv(1)
        if not c:
            break
        hdr += c
        if len(hdr) > 8192:
            break
    print("[handshake]")
    print(hdr.decode("latin-1", errors="replace").strip())

    s.sendall(ws_frame(mqtt_connect(args.client_id)))
    topics = [t for t in args.topics.split(",") if t]
    s.sendall(ws_frame(mqtt_subscribe(1, topics)))
    for item in args.publish:
        if "=" in item:
            t, p = item.split("=", 1)
            s.sendall(ws_frame(mqtt_publish(t, p.encode("utf-8"))))
            print("[sent PUBLISH] %s -> %s" % (t, p))

    buf = b""          # websocket payload accumulation
    mqtt = b""         # mqtt byte stream
    deadline = time.time() + args.wait
    while time.time() < deadline:
        try:
            data = s.recv(4096)
        except socket.timeout:
            break
        if not data:
            print("[closed by server]")
            break
        buf += data
        while True:
            if len(buf) < 2:
                break
            b0, b1 = buf[0], buf[1]
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            ln = b1 & 0x7F
            off = 2
            if ln == 126:
                if len(buf) < 4:
                    break
                ln = struct.unpack(">H", buf[2:4])[0]
                off = 4
            elif ln == 127:
                if len(buf) < 10:
                    break
                ln = struct.unpack(">Q", buf[2:10])[0]
                off = 10
            if masked:
                if len(buf) < off + 4:
                    break
                mk = buf[off:off + 4]
                off += 4
            if len(buf) < off + ln:
                break
            payload = buf[off:off + ln]
            if masked:
                payload = bytes(b ^ mk[i % 4] for i, b in enumerate(payload))
            buf = buf[off + ln:]
            if opcode == 0x8:
                print("[ws close] %r" % payload)
                break
            if opcode in (0x1, 0x2, 0x0):
                mqtt += payload

        # parse mqtt packets
        while len(mqtt) >= 2:
            b0 = mqtt[0]
            mult = 1
            rl = 0
            i = 1
            while True:
                if i >= len(mqtt):
                    break
                d = mqtt[i]
                rl += (d & 0x7F) * mult
                mult *= 128
                i += 1
                if not (d & 0x80):
                    break
            if i > len(mqtt) or len(mqtt) < i + rl:
                break
            pkt = mqtt[i:i + rl]
            mqtt = mqtt[i + rl:]
            ptype = b0 >> 4
            if ptype == 2:      # CONNACK
                code = pkt[1] if len(pkt) > 1 else -1
                print("[CONNACK] return_code=%d (%s)" % (code, {
                    0: "accepted", 1: "bad protocol", 2: "bad client id",
                    3: "server unavailable", 4: "bad credentials", 5: "not authorized",
                }.get(code, "unknown")))
            elif ptype == 9:    # SUBACK
                print("[SUBACK] packet_id=%s codes=%s" % (
                    struct.unpack(">H", pkt[:2])[0] if len(pkt) >= 2 else "?",
                    list(pkt[2:])))
            elif ptype == 3:    # PUBLISH
                tl = struct.unpack(">H", pkt[:2])[0] if len(pkt) >= 2 else 0
                topic = pkt[2:2 + tl].decode("utf-8", errors="replace")
                qos = (b0 >> 1) & 0x03
                off2 = 2 + tl + (2 if qos else 0)
                body = pkt[off2:]
                print("[PUBLISH] topic=%s qos=%d len=%d payload=%s" % (
                    topic, qos, len(body), body.decode("utf-8", errors="replace")))
            elif ptype == 13:   # PINGRESP
                print("[PINGRESP]")
            else:
                print("[MQTT type=%d] %r" % (ptype, pkt[:200]))

    try:
        s.sendall(ws_frame(b"", opcode=0x8))
    except Exception:
        pass
    s.close()
    print("[done]")


if __name__ == "__main__":
    main()
