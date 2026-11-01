#!/usr/bin/env python3
"""Solve Causal Mosaic through the intended topological-sort interface."""

from __future__ import annotations

import argparse
import heapq
import json
import re
from collections import defaultdict, deque

import requests


def normalize_edges(challenge: dict) -> set[tuple[str, str]]:
    events = challenge["events"]
    ids = [event["id"] for event in events]
    edges: set[tuple[str, str]] = set()

    for row in challenge["traces"]["A"]:
        edges.add((row["before"], row["after"]))

    for row in challenge["traces"]["B"]:
        left, right = re.split(r"\s*<-\s*", row["relation"], maxsplit=1)
        edges.add((right.strip(), left.strip()))

    for row in challenge["traces"]["C"]:
        before_index, after_index = row["pair"]
        edges.add((ids[before_index], ids[after_index]))
    return edges


def topological_order(events: list[dict], edges: set[tuple[str, str]]) -> list[str]:
    ids = [event["id"] for event in events]
    graph: dict[str, list[str]] = defaultdict(list)
    indegree = {event_id: 0 for event_id in ids}

    for before, after in edges:
        graph[before].append(after)
        indegree[after] += 1

    ready = [event_id for event_id in ids if indegree[event_id] == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        current = heapq.heappop(ready)
        order.append(current)
        for following in graph[current]:
            indegree[following] -= 1
            if indegree[following] == 0:
                heapq.heappush(ready, following)

    if len(order) != len(ids):
        raise RuntimeError("constraint graph contains a cycle")
    return order


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    session = requests.Session()
    created = session.post(f"{base}/api/new", json={}, timeout=30).json()
    challenge = created["challenge"]
    order = topological_order(challenge["events"], normalize_edges(challenge))

    payload = {
        "session_id": created["session_id"],
        "question_id": created["question_id"],
        "inputs": {"A": order, "B": order, "C": order},
    }
    result = session.post(f"{base}/api/submit", json=payload, timeout=30).json()
    print(json.dumps(result, indent=2, ensure_ascii=False))

    flag = result.get("flag")
    if flag:
        print(f"flag={flag}")
        return 0
    return 0 if result.get("complete") else 1


if __name__ == "__main__":
    raise SystemExit(main())
