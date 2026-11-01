#!/usr/bin/env python3
"""生成确定性、离线的小 PCAP（DNS + HTTP），仅用于 V2.1 真实工具烟测。

不抓取任何真实网络流量；内容固定为文档示例域名 evil.example。
"""
import struct
import sys


def checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"
    total = 0
    for i in range(0, len(data), 2):
        total += (data[i] << 8) + data[i + 1]
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def ipv4(src: str, dst: str, proto: int, payload: bytes) -> bytes:
    src_b = bytes(int(x) for x in src.split("."))
    dst_b = bytes(int(x) for x in dst.split("."))
    total_len = 20 + len(payload)
    header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45, 0, total_len, 0x1234, 0, 64, proto, 0, src_b, dst_b,
    )
    csum = checksum(header)
    header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45, 0, total_len, 0x1234, 0, 64, proto, csum, src_b, dst_b,
    )
    return header + payload


def eth(payload: bytes) -> bytes:
    # 固定 MAC，避免依赖本机网卡。
    dst = bytes.fromhex("020000000002")
    src = bytes.fromhex("020000000001")
    return dst + src + b"\x08\x00" + payload


def udp(src_port: int, dst_port: int, payload: bytes) -> bytes:
    length = 8 + len(payload)
    # IPv4 UDP 校验和 0 表示不校验；Wireshark 仍会解析。
    return struct.pack("!HHHH", src_port, dst_port, length, 0) + payload


def dns_query(name: str) -> bytes:
    qname = b"".join(bytes([len(part)]) + part.encode("ascii") for part in name.split(".")) + b"\0"
    # ID=0x1234, flags=0x0100 (standard query), QD=1, AN/NS/AR=0
    return struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + qname + struct.pack("!HH", 1, 1)


def tcp(src_port: int, dst_port: int, seq: int, ack: int, flags: int, payload: bytes) -> bytes:
    data_offset = 5 << 4
    # IPv4 TCP 校验和 0；Wireshark 仍会按端口解析 HTTP。
    header = struct.pack(
        "!HHIIBBHHH", src_port, dst_port, seq, ack, data_offset, flags, 8192, 0, 0
    )
    return header + payload


def pcap_record(payload: bytes, sec: int, usec: int) -> bytes:
    return struct.pack("<IIII", sec, usec, len(payload), len(payload)) + payload


def main(path: str, count: int = 3) -> None:
    if count < 3:
        raise SystemExit("count 至少为 3")
    sec = 1760000000
    packets = []

    # 1) DNS query: 10.1.2.3 -> 10.9.8.7:53 evil.example
    dns = dns_query("evil.example")
    pkt = eth(ipv4("10.1.2.3", "10.9.8.7", 17, udp(53000, 53, dns)))
    packets.append(pcap_record(pkt, sec, 0))

    # 2) HTTP GET: /shell.jsp，Host evil.example；URI 里带逗号，测试 CSV 字段。
    http = (
        b"GET /shell.jsp?x=1,2 HTTP/1.1\r\n"
        b"Host: evil.example\r\n"
        b"User-Agent: v3-reality-check,offline\r\n"
        b"Accept: */*\r\n"
        b"\r\n"
    )
    pkt = eth(ipv4("10.1.2.3", "10.9.8.7", 6, tcp(53001, 80, 1000, 1, 0x18, http)))
    packets.append(pcap_record(pkt, sec, 1000))

    # 3) 第二个 HTTP 请求，空 Host/URI 之外的字段用于空值测试。
    http2 = b"GET / HTTP/1.0\r\nHost: evil.example\r\n\r\n"
    pkt = eth(ipv4("10.1.2.3", "10.9.8.7", 6, tcp(53002, 80, 2000, 1, 0x18, http2)))
    packets.append(pcap_record(pkt, sec, 2000))

    # 4..count-1 填充包；第 count 个包（若 >=6000）放独特 sentinel HTTP 标记。
    for index in range(4, count + 1):
        usec = (index % 1000) * 1000
        if index == count and count >= 6000:
            sentinel = (
                b"GET /sentinel?x=9 HTTP/1.0\r\n"
                b"Host: sentinel.example\r\n"
                b"User-Agent: v3-sentinel,offline\r\n"
                b"\r\n"
            )
            pkt = eth(ipv4("203.0.113.66", "10.9.8.7", 6, tcp(53003, 80, index * 10, 1, 0x18, sentinel)))
        else:
            filler = dns_query("filler.example")
            pkt = eth(ipv4("10.1.2.3", "10.9.8.7", 17, udp(53000, 53, filler)))
        packets.append(pcap_record(pkt, sec + index // 1000, usec))

    global_header = struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)
    with open(path, "wb") as f:
        f.write(global_header + b"".join(packets))


if __name__ == "__main__":
    if len(sys.argv) < 2 or len(sys.argv) > 3:
        raise SystemExit("usage: make-v3-pcap.py <out.pcap> [packet_count]")
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) == 3 else 3)
