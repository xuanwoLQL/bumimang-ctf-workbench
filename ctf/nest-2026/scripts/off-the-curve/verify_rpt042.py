"""Second-run reproducibility check for rpt-042 recovery."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

RECORD_PATH = os.environ.get("NORTHSTAR_RECORD", "download_rpt-042.json")
PLAINTEXT_PATH = os.environ.get("NORTHSTAR_PLAINTEXT_OUT", "rpt042_plaintext.txt")
REC = json.load(open(RECORD_PATH, encoding="utf-8"))


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


digest = hashlib.sha256(canonical({"info": REC["info"], "aad": REC["aad"]})).hexdigest()
audit_digest = "c87e50c9ad81367b5e2eb22775d37c7ddd17c10aea6966215ffb9d5b978dfb70"
print("context_digest recomputed:", digest)
print("audit evt-1042 digest    :", audit_digest)
print("digest match:", digest == audit_digest)

out = subprocess.run([sys.executable, str(Path(__file__).with_name("decrypt_rpt042.py"))],
                     capture_output=True, text=True)
print("--- decrypt rerun stdout ---")
print(out.stdout)
print("--- decrypt rerun stderr ---")
print(out.stderr)
plain = open(PLAINTEXT_PATH, encoding="utf-8").read()
print("--- plaintext ---")
print(plain)
flag = [line.split("=", 1)[1] for line in plain.splitlines()
        if line.startswith("recovery_token=")][0]
print("FLAG:", flag)
open("evidence/flag_candidate.txt", "w", encoding="utf-8").write(
    "flag = " + flag + "\n"
    "source = evidence/rpt042_plaintext.txt (decrypted with d=13450493, sharedPoint=d*Q)\n"
    "digest_match = " + str(digest == audit_digest) + "\n"
)
