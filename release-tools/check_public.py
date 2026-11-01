#!/usr/bin/env python3
"""Validate public JSON, writeup inventory, evidence and relative links."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
CTF = ROOT / "ctf" / "nest-2026"
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def validate_json() -> list[str]:
    errors: list[str] = []
    paths = [
        ROOT / "package.json",
        ROOT / "package-lock.json",
        *sorted((ROOT / "config").glob("*.example.json")),
        ROOT / "config" / "permissions.json",
        *sorted((CTF / "scripts").rglob("*.json")),
        *sorted((CTF / "evidence").glob("*.json")),
        *sorted(CTF.glob("*.json")),
    ]
    for path in paths:
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"invalid JSON: {path.relative_to(ROOT)}: {exc}")
    return errors


def validate_ledger() -> list[str]:
    errors: list[str] = []
    ledger = json.loads((CTF / "competition-ledger.json").read_text(encoding="utf-8"))
    if ledger["summary"]["solved"] != 18:
        errors.append(f"ledger solved={ledger['summary']['solved']}, expected 18")
    if ledger["summary"]["capturedAcceptedFlags"] != 14:
        errors.append(
            "ledger capturedAcceptedFlags="
            f"{ledger['summary']['capturedAcceptedFlags']}, expected 14"
        )
    writeups = list((CTF / "writeups").glob("*.md"))
    if len(writeups) != 19:
        errors.append(f"writeup count={len(writeups)}, expected 18 + index")
    required = [
        CTF / "evidence" / "workbench.png",
        CTF / "evidence" / "platform-rank.png",
        CTF / "evidence" / "silentweights-flag.txt",
        CTF / "scripts" / "silentweights" / "extract.py",
    ]
    for path in required:
        if not path.exists():
            errors.append(f"missing required public file: {path.relative_to(ROOT)}")
    return errors


def validate_links() -> list[str]:
    errors: list[str] = []
    markdown_files = [ROOT / "README.md", *sorted(CTF.rglob("*.md"))]
    for source in markdown_files:
        text = source.read_text(encoding="utf-8")
        for raw in LINK_RE.findall(text):
            target = raw.strip().split("#", 1)[0].split("?", 1)[0]
            if not target or target.startswith(
                ("http://", "https://", "mailto:", "tel:", "<", "#")
            ):
                continue
            target = unquote(target)
            if "*" in target or "{" in target:
                continue
            resolved = (source.parent / target).resolve()
            if not resolved.exists():
                errors.append(
                    f"broken relative link: {source.relative_to(ROOT)} -> {raw}"
                )
    return errors


def validate_sizes() -> list[str]:
    errors: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts:
            continue
        relative = path.relative_to(ROOT)
        root = relative.parts[0]
        if root.startswith("dist") or root in {
            ".m1",
            ".ui-run",
            ".hugo-tools",
            "node_modules",
            "work",
            "evidence",
        }:
            if not ({"ctf", "nest-2026", "evidence"} <= set(path.parts)):
                continue
        if path.stat().st_size > 20 * 1024 * 1024:
            errors.append(
                f"public file exceeds 20 MiB: {relative} "
                f"({path.stat().st_size} bytes)"
            )
    return errors


def main() -> int:
    errors = [
        *validate_json(),
        *validate_ledger(),
        *validate_links(),
        *validate_sizes(),
    ]
    for error in errors:
        print(f"FAIL {error}")
    print(f"public_checks={len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
