#!/usr/bin/env python3
"""Fail closed when private material reaches the public source tree.

Known contest credentials are represented only by salted SHA-256 digests. The
scanner extracts token-shaped strings from each text line, hashes them, and
compares the digest. This keeps the guard useful without embedding the secrets
that it is meant to protect.
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_ROOT_DIRS = {
    ".git",
    ".m1",
    ".ui-run",
    "node_modules",
    "dist",
    "work",
    "evidence",
}
SKIP_RELATIVE_FILES = {
    Path("config/app.json"),
    Path("config/platform.json"),
    Path("config/ir-tools.json"),
    Path("config/platform-credentials.bin"),
}
SKIP_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".exe",
    ".dll",
    ".bin",
    ".pyc",
    ".zip",
    ".pt",
}

HASH_SALT = "bumimang-audit:"
KNOWN_SECRET_HASHES = {
    "eff2285050f605abdf3608ee8c355012667e6f4a1b9cb79605a80ff90c80f70b",
    "4954ec39430555a6d2f4f0643e2c1ec96b79f0072f67e669c84cfe7eb667b90f",
    "eb35e3bf5e579f373fed37f2a90d6f37e62ab53d31c34396d651993316117df4",
}
PUBLIC_EXAMPLE_HASHES = {
    # JWT.io / OWASP documentation example used in the bundled knowledge base.
    "c83cd3f4cead065b216f3f3c5c8e4b707486ea6faa85017c7e3b396b8060c782",
}

CHECKS = [
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    (
        "JWT literal",
        re.compile(
            r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"
            r"\.[A-Za-z0-9_-]{10,}"
        ),
    ),
    ("dynamic contest host", re.compile(r"\b[A-Za-z0-9-]+\.nestctf\.cyberpeace\.cn\b")),
]

TOKEN_RE = re.compile(r"[^\s\"'`<>\[\]{}(),;|]+")


def digest(value: str) -> str:
    return hashlib.sha256((HASH_SALT + value).encode("utf-8")).hexdigest()


def token_matches_known_secret(line: str) -> bool:
    # Split compound assignments and URLs before hashing candidate values.
    for raw in TOKEN_RE.findall(line):
        for part in re.split(r"[=:]+", raw):
            if len(part) >= 6 and digest(part) in KNOWN_SECRET_HASHES:
                return True
        if len(raw) >= 6 and digest(raw) in KNOWN_SECRET_HASHES:
            return True
    return False


def iter_public_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if relative.parts[0] in SKIP_ROOT_DIRS or relative.parts[0].startswith("dist-"):
            continue
        if relative.parts[:2] == ("docs", "logs"):
            continue
        if relative in SKIP_RELATIVE_FILES:
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        yield path, relative


def main() -> int:
    findings: list[tuple[str, Path, int]] = []
    for path, relative in iter_public_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            for label, pattern in CHECKS:
                match = pattern.search(line)
                if match and label == "JWT literal":
                    token_hash = hashlib.sha256(
                        match.group().encode("utf-8")
                    ).hexdigest()
                    if token_hash in PUBLIC_EXAMPLE_HASHES:
                        continue
                if match:
                    findings.append((label, relative, line_no))
            if token_matches_known_secret(line):
                findings.append(("known contest credential", relative, line_no))

    for label, path, line_no in findings:
        print(f"{label}: {path}:{line_no} (value redacted)")
    print(f"findings={len(findings)}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
