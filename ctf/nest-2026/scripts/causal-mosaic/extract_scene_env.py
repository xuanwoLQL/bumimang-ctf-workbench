#!/usr/bin/env python3
"""Extract FLAG= values from a saved challenge-detail JSON response."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


FLAG_RE = re.compile(r"(?:^|;)FLAG=(flag\{[^}]+\})")


def walk(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)
    elif isinstance(value, str):
        yield value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("detail_json", type=Path)
    args = parser.parse_args()

    document = json.loads(args.detail_json.read_text(encoding="utf-8"))
    found = set()
    for text in walk(document):
        for match in FLAG_RE.finditer(text):
            found.add(match.group(1))

    for flag in sorted(found):
        print(flag)
    return 0 if found else 1


if __name__ == "__main__":
    raise SystemExit(main())
