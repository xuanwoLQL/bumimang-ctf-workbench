#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bleichenbacher PKCS#1 v1.5 oracle solver for the Premaster challenge.

The service announces a session ciphertext c0 and one multiplier s0 for which
c0 * s0^e mod n decrypts to a PKCS#1 v1.5 type-02 block.  Each subsequent line
is a ciphertext; the service replies "ok" exactly when its plaintext is a
conforming type-02 block.
"""

import argparse
import heapq
import json
import socket
import ssl
import sys
import time
from pathlib import Path


DEFAULT_PUBKEY = Path(__file__).resolve().with_name("pubkey.json")


def ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


class PremasterOracle:
    def __init__(
        self,
        host: str,
        port: int,
        use_ssl: bool,
        batch_size: int,
        timeout: float,
    ):
        self.host = host
        self.port = port
        self.use_ssl = use_ssl
        self.batch_size = batch_size
        self.timeout = timeout
        self.sock = None
        self.reader = None
        self.queries = 0
        self.started = time.monotonic()
        self.c0 = 0
        self.s0 = 0

    def connect(self):
        raw = socket.create_connection(
            (self.host, self.port), timeout=self.timeout
        )
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self.use_ssl:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            self.sock = context.wrap_socket(raw, server_hostname=self.host)
        else:
            self.sock = raw
        self.sock.settimeout(30)
        self.reader = self.sock.makefile("rb")
        line = self.reader.readline(4096).decode("ascii", "replace").strip()
        fields = line.split()
        if len(fields) != 3 or fields[0] != "session":
            raise RuntimeError(f"unexpected service banner: {line!r}")
        self.c0 = int(fields[1], 16)
        self.s0 = int(fields[2])
        print(
            f"[+] session: c0={self.c0.bit_length()} bits, "
            f"s0={self.s0.bit_length()} bits",
            flush=True,
        )

    def _send_batch(self, ciphertexts):
        payload = "".join(f"{value:x}\n" for value in ciphertexts).encode()
        self.sock.sendall(payload)
        self.queries += len(ciphertexts)
        answers = []
        for _ in ciphertexts:
            line = self.reader.readline(128).strip()
            if line == b"ok":
                answers.append(True)
            elif line == b"bad":
                answers.append(False)
            else:
                raise RuntimeError(f"unexpected oracle response: {line!r}")
        return answers

    def find_first(self, candidates):
        """Return the first oracle-positive candidate, preserving order."""
        iterator = iter(candidates)
        while True:
            batch = []
            try:
                for _ in range(self.batch_size):
                    batch.append(next(iterator))
            except StopIteration:
                pass
            if not batch:
                return None
            answers = self._send_batch(batch)
            for candidate, answer in zip(batch, answers):
                if answer:
                    return candidate

    def find_first_s(self, c0, e, n, candidates):
        """Test c0*s^e for ordered candidate multipliers and return first s."""
        iterator = iter(candidates)
        missing_batches = 0
        while True:
            multipliers = []
            ciphertexts = []
            try:
                for _ in range(self.batch_size):
                    s = next(iterator)
                    multipliers.append(s)
                    ciphertexts.append((c0 * pow(s, e, n)) % n)
            except StopIteration:
                pass
            if not multipliers:
                return None
            answers = self._send_batch(ciphertexts)
            positives = sum(answers)
            for position, (multiplier, answer) in enumerate(
                zip(multipliers, answers), 1
            ):
                if answer:
                    print(
                        f"    hit at batch position {position}/{len(multipliers)}",
                        flush=True,
                    )
                    return multiplier
            missing_batches += 1
            if missing_batches <= 3 or missing_batches % 50 == 0:
                print(
                    f"    no hit: batch={missing_batches} "
                    f"range={multipliers[0]}..{multipliers[-1]} "
                    f"positives={positives} total_queries={self.queries}",
                    flush=True,
                )

    def is_conforming(self, ciphertext: int) -> bool:
        return self._send_batch([ciphertext])[0]

    def stats(self):
        return self.queries, time.monotonic() - self.started

    def close(self):
        if self.reader:
            self.reader.close()
        if self.sock:
            self.sock.close()


def refine_intervals(intervals, s, n, b):
    result = set()
    two_b = 2 * b
    three_b = 3 * b
    for a, upper in intervals:
        r_min = ceil_div(a * s - (three_b - 1), n)
        r_max = (upper * s - two_b) // n
        if r_max < r_min:
            continue
        for r in range(r_min, r_max + 1):
            lo = max(a, ceil_div(two_b + r * n, s))
            hi = min(upper, (three_b - 1 + r * n) // s)
            if lo <= hi:
                result.add((lo, hi))
    return sorted(result)


def search_general(oracle, n, e, c0, start_s):
    def candidates():
        s = start_s
        while True:
            yield s
            s += 1

    s = oracle.find_first_s(c0, e, n, candidates())
    if s is None:
        raise RuntimeError("general s search exhausted")
    return s


def search_single(oracle, n, e, c0, start_s, interval, b):
    a, upper = interval
    r = ceil_div(2 * (upper * start_s - 2 * b), n)
    s = max(ceil_div(2 * b + r * n, upper), start_s + 1)

    def candidates():
        nonlocal s
        while True:
            yield s
            s += 1

    found = oracle.find_first_s(c0, e, n, candidates())
    if found is None:
        raise RuntimeError("single-interval s search exhausted")
    return found


def feasible_multiplier_stream(interval, start_s, n, b):
    """Yield only s values that can satisfy the interval for some raw integer r."""
    lower, upper = interval
    three_b_minus_one = 3 * b - 1
    two_b = 2 * b
    # Start from the standard step-2c r value.  This makes s roughly double
    # each round instead of crawling through low-value r choices.
    r = max(0, ceil_div(2 * (upper * start_s - two_b), n))
    while True:
        low = max(start_s, ceil_div(two_b + r * n, upper))
        high = (three_b_minus_one + r * n) // lower
        if low <= high:
            for candidate in range(low, high + 1):
                yield candidate
        r += 1


def search_next_feasible(oracle, n, e, c0, start_s, intervals, b):
    """Return the next oracle-positive s without testing impossible s values."""
    def candidates():
        heap = []
        streams = []
        for index, interval in enumerate(intervals):
            stream = iter(feasible_multiplier_stream(interval, start_s, n, b))
            streams.append(stream)
            try:
                candidate = next(stream)
            except StopIteration:
                continue
            heapq.heappush(heap, (candidate, index))

        last_candidate = None
        while heap:
            candidate, index = heapq.heappop(heap)
            try:
                following = next(streams[index])
                heapq.heappush(heap, (following, index))
            except StopIteration:
                pass
            if candidate != last_candidate:
                last_candidate = candidate
                yield candidate

    return oracle.find_first_s(c0, e, n, candidates())


def solve(host, port, use_ssl, batch_size, timeout, pubkey_path):
    pubkey = json.loads(Path(pubkey_path).read_text(encoding="utf-8"))
    n = int(pubkey["n"])
    e = int(pubkey["e"])
    k = (n.bit_length() + 7) // 8
    b = 1 << (8 * (k - 2))

    oracle = PremasterOracle(host, port, use_ssl, batch_size, timeout)
    oracle.connect()
    c0 = oracle.c0
    s = oracle.s0
    intervals = [(2 * b, 3 * b - 1)]

    try:
        announced_ciphertext = (c0 * pow(s, e, n)) % n
        if not oracle.is_conforming(announced_ciphertext):
            raise RuntimeError(
                "announced multiplier failed; public key does not match this session"
            )
        print("[+] announced s0 verified against the oracle", flush=True)
        rounds = 0
        while True:
            rounds += 1
            intervals = refine_intervals(intervals, s, n, b)
            if not intervals:
                raise RuntimeError(f"interval set became empty at round {rounds}")

            queries, elapsed = oracle.stats()
            if rounds <= 20 or rounds % 100 == 0:
                print(
                    f"[*] round={rounds} intervals={len(intervals)} "
                    f"s={s.bit_length()}bits queries={queries} "
                    f"elapsed={elapsed:.1f}s",
                    flush=True,
                )

            if len(intervals) == 1 and intervals[0][0] == intervals[0][1]:
                blinded = intervals[0][0]
                break
            if any(a <= 2 * b and upper >= 3 * b - 1 for a, upper in intervals):
                # This condition is harmless and just kept for visibility.
                pass

            s = search_next_feasible(
                oracle, n, e, c0, s + 1, intervals, b
            )
            if s is None:
                raise RuntimeError("feasible-multiplier search exhausted")
    finally:
        oracle.close()

    message = (blinded * pow(oracle.s0, -1, n)) % n
    block = message.to_bytes(k, "big")
    separator = block.find(b"\x00", 2)
    payload = block[separator + 1 :] if separator >= 2 else block
    queries, elapsed = oracle.stats()
    print(f"[+] recovered plaintext after {queries} oracle queries in {elapsed:.1f}s")
    print(f"[+] raw block: {block.hex()}")
    print(f"[+] payload repr: {payload!r}")
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    parser.add_argument("port", type=int)
    parser.add_argument("--ssl", action="store_true")
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--pubkey", default=str(DEFAULT_PUBKEY))
    args = parser.parse_args()
    solve(
        args.host,
        args.port,
        args.ssl,
        args.batch_size,
        args.timeout,
        args.pubkey,
    )


if __name__ == "__main__":
    sys.exit(main())
