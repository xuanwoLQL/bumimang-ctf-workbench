#!/usr/bin/env python3
"""Render and decode the QR matrix recovered from the UAE initial noise."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


N = 25


def block_values(x: np.ndarray) -> np.ndarray:
    out = np.zeros((N, N), dtype=np.float64)
    for module in range(N * N):
        channel = 0 if module < 256 else (1 if module < 512 else 2)
        slot = module if channel == 0 else (
            module - 256 if channel == 1 else module - 512
        )
        row, col = slot // 16, slot % 16
        out[module // N, module % N] = x[
            channel, 2 * row : 2 * row + 2, 2 * col : 2 * col + 2
        ].mean()
    return out


def finder_pattern() -> np.ndarray:
    pattern = np.zeros((7, 7), dtype=bool)
    pattern[0, :] = True
    pattern[-1, :] = True
    pattern[:, 0] = True
    pattern[:, -1] = True
    pattern[2:5, 2:5] = True
    return pattern


def fix_function_patterns(matrix: np.ndarray) -> np.ndarray:
    fixed = matrix.copy()
    finder = finder_pattern()
    for row, col in ((0, 0), (0, N - 7), (N - 7, 0)):
        fixed[row : row + 7, col : col + 7] = finder

    fixed[7, 0:8] = False
    fixed[0:8, 7] = False
    fixed[7, N - 8 : N] = False
    fixed[0:8, N - 8 : N] = False
    fixed[N - 8, 0:8] = False
    fixed[N - 8 : N, 7] = False

    for index in range(8, N - 8):
        fixed[6, index] = index % 2 == 0
        fixed[index, 6] = index % 2 == 0

    alignment = np.array(
        [
            [1, 1, 1, 1, 1],
            [1, 0, 0, 0, 1],
            [1, 0, 1, 0, 1],
            [1, 0, 0, 0, 1],
            [1, 1, 1, 1, 1],
        ],
        dtype=bool,
    )
    fixed[16:21, 16:21] = alignment
    fixed[17, 8] = True
    return fixed


def render(matrix: np.ndarray, scale: int = 16, quiet: int = 4) -> np.ndarray:
    image = np.ones((N + 2 * quiet, N + 2 * quiet), dtype=np.uint8) * 255
    image[quiet : quiet + N, quiet : quiet + N] = np.where(matrix, 0, 255)
    return np.kron(image, np.ones((scale, scale), dtype=np.uint8))


def decode(matrix: np.ndarray, output: Path) -> str:
    image = render(matrix)
    cv2.imwrite(str(output), image)
    detector = cv2.QRCodeDetector()
    value, points, _ = detector.detectAndDecode(image)
    if not value and hasattr(cv2, "QRCodeDetectorAruco"):
        value, points, _ = cv2.QRCodeDetectorAruco().detectAndDecode(image)
    if not value or points is None:
        raise RuntimeError("QR decode failed")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--x-t", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--g-seed", type=int, default=555)
    parser.add_argument("--mask-seed", type=int, default=20261012)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    x_t = np.load(args.x_t).astype(np.float64).reshape(3, 32, 32)
    carrier = np.random.default_rng(args.g_seed).standard_normal((3, 32, 32))
    mask = (
        np.random.default_rng(args.mask_seed).integers(0, 2, size=(3, 32, 32))
        * 2
        - 1
    )

    for alpha in (0.5, 0.55, 0.6, 0.65, 0.7):
        residual = block_values((x_t - alpha * carrier) * mask)
        for inverted in (True, False):
            matrix = ~(residual > 0) if inverted else (residual > 0)
            matrix = fix_function_patterns(matrix)
            output = args.out_dir / f"qr-alpha{alpha}-inv{int(inverted)}.png"
            try:
                payload = decode(matrix, output)
            except RuntimeError:
                continue
            print(f"alpha={alpha} inverted={inverted}")
            print(f"payload={payload}")
            print(f"flag=flag{{{payload}}}")
            return 0

    print("no decodable QR candidate")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
