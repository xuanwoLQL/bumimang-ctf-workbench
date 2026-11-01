#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Strict DoIP / ISO-TP / UDS client for SilGate."""

import os
import socket
import ssl
import struct
import time


HOST = os.environ.get("SILGATE_HOST", "")
PORT = int(os.environ.get("SILGATE_PORT", "13400"))
ECU = 0x0E80
TESTER = 0x0E00


class SilGate:
    def __init__(self, host=HOST, port=PORT, timeout=5.0):
        if not host:
            raise ValueError("SilGate host is required (argument or SILGATE_HOST)")
        context = ssl._create_unverified_context()
        raw = socket.create_connection((host, port), timeout=10)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock = context.wrap_socket(raw, server_hostname=host)
        self.sock.settimeout(timeout)
        self.timeout = timeout
        self.last_tester_present = 0.0

    def close(self):
        self.sock.close()

    def _doip(self, payload_type, payload=b""):
        return (
            b"\x03\xfc"
            + struct.pack(">H", payload_type)
            + struct.pack(">I", len(payload))
            + payload
        )

    def _recv_doip(self, timeout=None):
        timeout = self.timeout if timeout is None else timeout
        self.sock.settimeout(timeout)
        header = b""
        while len(header) < 8:
            chunk = self.sock.recv(8 - len(header))
            if not chunk:
                raise ConnectionError("peer closed while reading DoIP header")
            header += chunk
        if header[:2] != b"\x03\xfc":
            raise ValueError(f"invalid DoIP header: {header.hex()}")
        payload_type, length = struct.unpack(">HI", header[2:8])
        body = b""
        while len(body) < length:
            chunk = self.sock.recv(length - len(body))
            if not chunk:
                raise ConnectionError("peer closed while reading DoIP body")
            body += chunk
        return payload_type, body

    def send_doip(self, payload_type, payload=b""):
        self.sock.sendall(self._doip(payload_type, payload))

    def diag_message(self, isotp):
        self.send_doip(
            0x8001,
            struct.pack(">HH", TESTER, ECU) + isotp,
        )

    def route(self, activation_type=0x01, oem=b"", timeout=5.0):
        payload = (
            struct.pack(">H", TESTER)
            + bytes([activation_type & 0xFF, len(oem) & 0xFF])
            + oem
        )
        self.send_doip(0x0005, payload)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            payload_type, body = self._recv_doip(
                max(0.1, deadline - time.monotonic())
            )
            if payload_type == 0x0006 and len(body) >= 5:
                _, _, result = struct.unpack(">HHB", body[:5])
                return result
        return None

    def vehicle_info(self):
        self.send_doip(0x0001)
        payload_type, body = self._recv_doip()
        if payload_type != 0x0004:
            raise ValueError(f"unexpected vehicle response {payload_type:#x}")
        return body

    def tester_present(self):
        request = bytes.fromhex("3e80")
        self.diag_message(bytes([len(request)]) + request)
        self.last_tester_present = time.monotonic()

    def keepalive(self):
        if time.monotonic() - self.last_tester_present > 1.2:
            self.tester_present()

    def _wait_diag_frame(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            payload_type, body = self._recv_doip(
                max(0.05, deadline - time.monotonic())
            )
            if payload_type == 0x8001 and len(body) >= 5:
                return body[4:]
            if payload_type == 0x8003:
                raise RuntimeError(f"diagnostic NACK: {body.hex()}")
        return None

    def _send_multiframe(self, data):
        length = len(data)
        if length <= 0xFFF:
            first = bytes([0x10 | ((length >> 8) & 0x0F), length & 0xFF])
            first += data[:6]
            offset = 6
        else:
            first = b"\x10\x00" + struct.pack(">I", length) + data[:4]
            offset = 4
        self.diag_message(first)

        flow = self._wait_diag_frame(self.timeout)
        if flow is None:
            raise TimeoutError("no ISO-TP flow-control frame")
        if (flow[0] & 0xF0) != 0x30:
            raise RuntimeError(f"unexpected flow control: {flow.hex()}")
        block_size = flow[1]
        stmin = flow[2]
        delay = max(0.020, (stmin / 1000.0) + 0.010)

        sequence = 1
        sent_in_block = 0
        while offset < length:
            if delay:
                time.sleep(delay)
            chunk = data[offset : offset + 7]
            self.diag_message(bytes([0x20 | (sequence & 0x0F)]) + chunk)
            offset += len(chunk)
            sequence += 1
            sent_in_block += 1
            if block_size and sent_in_block >= block_size and offset < length:
                flow = self._wait_diag_frame(self.timeout)
                if flow is None:
                    raise TimeoutError("no flow-control frame after block")
                if (flow[0] & 0xF0) != 0x30:
                    raise RuntimeError(
                        f"unexpected block flow control: {flow.hex()}"
                    )
                block_size = flow[1]
                stmin = flow[2]
                delay = max(0.020, (stmin / 1000.0) + 0.010)
                sent_in_block = 0

    def _recv_response(self, timeout=None):
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self._wait_diag_frame(
                max(0.05, deadline - time.monotonic())
            )
            if frame is None:
                break
            pci = frame[0] & 0xF0
            if pci == 0x00:
                length = frame[0] & 0x0F
                return frame[1 : 1 + length]
            if pci == 0x10:
                total = ((frame[0] & 0x0F) << 8) | frame[1]
                data = bytearray(frame[2:8])
                self.diag_message(b"\x30\x00\x00")
                expected_sequence = 1
                while len(data) < total:
                    following = self._wait_diag_frame(
                        max(0.05, deadline - time.monotonic())
                    )
                    if following is None:
                        raise TimeoutError("timeout while receiving CF")
                    if (following[0] & 0xF0) != 0x20:
                        continue
                    if (following[0] & 0x0F) != (expected_sequence & 0x0F):
                        raise RuntimeError(
                            "ISO-TP response sequence mismatch: "
                            f"got {following[0] & 0x0F}, "
                            f"expected {expected_sequence & 0x0F}"
                        )
                    data.extend(following[1:8])
                    expected_sequence += 1
                return bytes(data[:total])
            if pci == 0x20:
                continue
        return b""

    def uds(self, request, timeout=None):
        if len(request) <= 7:
            self.diag_message(bytes([len(request)]) + request)
        else:
            self._send_multiframe(request)
        response = self._recv_response(timeout)
        if response[:3] == b"\x7f\x3e\x78":
            self.last_tester_present = time.monotonic()
        return response

    def read_relative(self, offset, size=0x100, timeout=None):
        request = (
            b"\x23\x24"
            + (offset & 0xFFFFFFFF).to_bytes(4, "big")
            + size.to_bytes(2, "big")
        )
        return self.uds(request, timeout=timeout)

