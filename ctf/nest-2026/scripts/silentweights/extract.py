#!/usr/bin/env python3
"""Extract the SilentWeights payload from the float32 LSB stream."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import torch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path, help="path to the challenge model.pt")
    parser.add_argument("--tensor", default="fc2.weight")
    args = parser.parse_args()

    state = torch.load(args.model, map_location="cpu", weights_only=True)
    tensor = state[args.tensor].detach().cpu().numpy().astype(np.float32)
    bits = (tensor.view(np.uint32) & 1).astype(np.uint8)
    packed = np.packbits(bits, bitorder="big").tobytes()

    match = re.search(rb"flag\{[^}\r\n]{1,200}\}", packed)
    if not match:
        print("flag not found in selected tensor", file=sys.stderr)
        return 1

    value = match.group().decode("ascii")
    print(f"tensor={args.tensor}")
    print(f"shape={tensor.shape}")
    print(f"flag={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
