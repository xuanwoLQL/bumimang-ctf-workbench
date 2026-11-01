from __future__ import annotations

import os
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "work"
OUT = ROOT / "ctf" / "nest-2026"

# These inputs are intentionally machine-local. Set the environment variables
# before running this helper; no local user path is committed to the repository.
WP = Path(os.environ["BUMIMANG_NEST_WP_DIR"]) if os.environ.get("BUMIMANG_NEST_WP_DIR") else None
RANK_IMAGE = Path(os.environ["BUMIMANG_RANK_IMAGE"]) if os.environ.get("BUMIMANG_RANK_IMAGE") else None

FILES = {
    "ghost-in-the-queue/fresh_scene_run.py": WORK / "task-4a36a071/tools/fresh_scene_run.py",
    "ghost-in-the-queue/k2_attack.py": WORK / "task-4a36a071/tools/k2_attack.py",
    "pending-review/blclient.py": WORK / "task-90b3dbf8/tools/blclient.py",
    "pending-review/remote_pivot.py": WORK / "task-90b3dbf8/tools/remote_pivot.py",
    "filmreader/kdf.py": WORK / "task-027c2b47/scripts/kdf.py",
    "filmreader/verify_kdf.py": WORK / "task-027c2b47/scripts/verify_kdf.py",
    "filmreader/dec_prog.py": WORK / "task-027c2b47/scripts/dec_prog.py",
    "filmreader/decode_all.py": WORK / "task-027c2b47/scripts/decode_all.py",
    "pickle-me-not/kdf_final.py": WORK / "task-65033674/tools/kdf_final.py",
    "pickle-me-not/verify_flag.py": WORK / "task-65033674/tools/verify_flag.py",
    "wasmnesia/fetch_formal.py": WORK / "task-7c9cac8d/fetch_formal.py",
    "wasmnesia/get.py": WORK / "task-7c9cac8d/get.py",
    "wasmnesia/decrypt_s54.py": WORK / "task-7c9cac8d/decrypt_s54.py",
    "wasmnesia/privesc.py": WORK / "task-7c9cac8d/privesc.py",
    "wasmnesia/capture_flag.py": WORK / "task-7c9cac8d/capture_flag.py",
    "immobilizer/final_verify.py": WORK / "task-c70a394f/evidence/final_verify.py",
    "immobilizer/hnp.py": WORK / "task-c70a394f/work/hnp.py",
    "immobilizer/ec.py": WORK / "task-c70a394f/work/ec.py",
    "immobilizer/lll.py": WORK / "task-c70a394f/work/lll.py",
    "smart-surveillance/sscp_prefix_bypass.py": WORK / "task-8eb4abca/sscp_prefix_bypass.py",
    "smart-surveillance/probe_vhttpd_digest_creds.py": WORK / "task-8eb4abca/probe_vhttpd_digest_creds.py",
    "off-the-curve/forge_admin.py": WORK / "task-5ef8cc4d/scripts/forge_admin.py",
    "off-the-curve/offcurve_dlog.py": WORK / "task-5ef8cc4d/scripts/offcurve_dlog.py",
    "off-the-curve/decrypt_rpt042.py": WORK / "task-5ef8cc4d/scripts/decrypt_rpt042.py",
    "off-the-curve/verify_rpt042.py": WORK / "task-5ef8cc4d/scripts/verify_rpt042.py",
    "uae/uae_solve.py": WORK / "task-22bc9fda/scripts/uae_solve.py",
    "uae/uae_lib.py": WORK / "task-22bc9fda/scripts/uae_lib.py",
    "uae/qr_fix_decode.py": WORK / "task-22bc9fda/scripts/qr_fix_decode.py",
    "llm-pipeline/rag_exploit.py": WORK / "task-1aac76d3/rag_exploit.py",
}

DIRS = {}
if WP is not None:
    DIRS["dropout"] = WP / "04-脚本与exp" / "dropout-20261031"

IMAGES = {
    "evidence/smart-surveillance-board.png": WORK / "task-8eb4abca/evidence/flag_board_zoom.png",
    "evidence/workbench.png": ROOT / ".ui-run/current-live.png",
}
if RANK_IMAGE is not None:
    IMAGES["evidence/platform-rank.png"] = RANK_IMAGE

EVIDENCE = {
    "ghost-in-the-queue-final-vault.txt": WORK / "task-4a36a071/evidence/final_vault.txt",
    "ghost-in-the-queue-flag.txt": WORK / "task-4a36a071/evidence/FLAG.txt",
    "ghost-in-the-queue-static-keys.txt": WORK / "task-4a36a071/evidence/static_keys_verified.txt",
    "pending-review-flag.txt": WORK / "task-90b3dbf8/evidence/FLAG_FOUND.txt",
    "pending-review-run.txt": WORK / "task-90b3dbf8/evidence/remote_pivot_run_newhost.txt",
    "pending-review-body.bin": WORK / "task-90b3dbf8/evidence/remote_pivot_out.bin",
    "filmreader-flag.txt": WORK / "task-027c2b47/evidence/flag_real.txt",
    "filmreader-decode.txt": WORK / "task-027c2b47/evidence/decode_output.txt",
    "filmreader-vm-disasm.txt": WORK / "task-027c2b47/evidence/vm_disasm.txt",
    "pickle-me-not-flag.txt": WORK / "task-65033674/evidence/flag.txt",
    "pickle-me-not-findings.md": WORK / "task-65033674/evidence/findings_scribe.md",
    "wasmnesia-flag.txt": WORK / "task-7c9cac8d/evidence/FLAG.txt",
    "wasmnesia-rce.txt": WORK / "task-7c9cac8d/evidence/rce_flag_output.txt",
    "wasmnesia-formal-plain.txt": WORK / "task-7c9cac8d/evidence/formal_plain.txt",
    "immobilizer-flag.txt": WORK / "task-c70a394f/evidence/11-flag.txt",
    "immobilizer-verify.txt": WORK / "task-c70a394f/evidence/12-final-verify.txt",
    "smart-surveillance-flag.txt": WORK / "task-8eb4abca/evidence/flag.txt",
    "smart-surveillance-sscp.txt": WORK / "task-8eb4abca/evidence/sscp_auth_bypass.txt",
    "off-the-curve-download.json": WORK / "task-5ef8cc4d/evidence/http/download_rpt-042.json",
    "off-the-curve-dlog.txt": WORK / "task-5ef8cc4d/evidence/offcurve_dlog.txt",
    "off-the-curve-dlog.json": WORK / "task-5ef8cc4d/evidence/offcurve_dlog.json",
    "off-the-curve-plaintext.txt": WORK / "task-5ef8cc4d/evidence/rpt042_plaintext.txt",
    "undercurrent-flag.txt": WORK / "task-38376538/evidence/undercurrent_flag.txt",
    "uae-flag.txt": WORK / "task-22bc9fda/evidence/flag_candidate.txt",
    "uae-final-decode.log": WORK / "task-22bc9fda/evidence/final_decode.log",
    "uae-qr.png": WORK / "task-22bc9fda/evidence/qrfix_a0.6_inv1.png",
    "llm-pipeline-flag.txt": WORK / "task-1aac76d3/evidence/flag_rag_leak.txt",
}
if WP is not None:
    EVIDENCE["causal-mosaic.json"] = WP / "05-附件与流量" / "causal_detail.json"


def safe_copy(src: Path, dst: Path) -> None:
    if not src.exists():
        print(f"MISS {src}")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"COPY {src} -> {dst.relative_to(ROOT)}")


def main() -> None:
    tools = OUT / "scripts"
    for rel, src in FILES.items():
        safe_copy(src, tools / rel)
    for rel, src in DIRS.items():
        dst = tools / rel
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(
            src,
            dst,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        print(f"COPYDIR {src} -> {dst.relative_to(ROOT)}")
    for rel, src in IMAGES.items():
        safe_copy(src, OUT / rel)
    for name, src in EVIDENCE.items():
        safe_copy(src, OUT / "evidence" / name)


if __name__ == "__main__":
    main()
