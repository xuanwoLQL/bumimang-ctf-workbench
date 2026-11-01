#!/usr/bin/env python3
"""Invert the guided DDIM sampler and recover the UAE initial noise."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import numpy as np
import torch
from diffusers import DDPMScheduler, UNet2DModel


def load_module(path: Path, name: str):
    module_spec = importlib.util.spec_from_file_location(name, path)
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--challenge-dir", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("x_T.npy"))
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--num-train", type=int, default=1000)
    parser.add_argument("--iters", type=int, default=3)
    parser.add_argument("--target", default="auto")
    parser.add_argument("--guidance-scale", type=float, default=3.0)
    args = parser.parse_args()

    challenge_dir = args.challenge_dir.resolve()
    sys.path.insert(0, str(challenge_dir))
    classifier_module = load_module(challenge_dir / "classifier.py", "challenge_classifier")
    sampler_module = load_module(challenge_dir / "sampler.py", "challenge_sampler")

    classifier = classifier_module.CifarResNet18()
    state = torch.load(
        challenge_dir / "classifier.pt",
        map_location="cpu",
        weights_only=True,
    )
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    classifier.load_state_dict(state, strict=False)
    classifier.eval()

    x_adv = np.load(challenge_dir / "x_adv.npy").astype(np.float32)
    tensor = torch.from_numpy(x_adv).unsqueeze(0)
    with torch.no_grad():
        probabilities = torch.softmax(classifier(tensor)[0], dim=-1)
    target = int(probabilities.argmax()) if args.target == "auto" else int(args.target)

    unet = UNet2DModel.from_pretrained(args.model_dir, subfolder="unet")
    scheduler = DDPMScheduler.from_pretrained(args.model_dir, subfolder="scheduler")
    sampler = sampler_module.GuidedDDIM(
        unet,
        scheduler.alphas_cumprod.float(),
        steps=args.steps,
        num_train=args.num_train,
    )

    guidance = {
        "clf": classifier,
        "target": target,
        "scale": args.guidance_scale,
    }
    x_t = sampler.invert_fixedpoint(tensor, guidance, iters=args.iters)
    out = x_t[0].detach().cpu().numpy().astype(np.float32)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.save(args.out, out)
    print(f"target={target}")
    print(f"saved={args.out}")
    print(f"shape={out.shape} mean={out.mean():.6f} std={out.std():.6f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
