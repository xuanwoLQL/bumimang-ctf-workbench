"""UAE challenge helpers.

Loads the challenge-provided classifier/sampler modules from the attachment
path (audited small files), loads the google/ddpm-cifar10-32 UNet from the
locally downloaded old-format checkpoint, remapping the 2022-era attention
parameter names (query/key/value/proj_attn) to the modern ones.
"""
import importlib.util
import json
import sys

import numpy as np
import torch
from safetensors.torch import load_file


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def load_guided_ddim_cls(path):
    return load_module(path, "challenge_sampler").GuidedDDIM


def load_classifier(classifier_py, ckpt_path, device="cpu"):
    mod = load_module(classifier_py, "challenge_classifier")
    clf = mod.CifarResNet18()
    sd = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    missing, unexpected = clf.load_state_dict(sd, strict=False)
    if missing or unexpected:
        print(f"[warn] classifier missing={missing[:5]} unexpected={unexpected[:5]}", file=sys.stderr)
    clf.eval().to(device)
    return clf


OLD2NEW = [
    (".query.", ".to_q."),
    (".key.", ".to_k."),
    (".value.", ".to_v."),
    (".proj_attn.", ".to_out.0."),
]


def _map_key(k):
    for old, new in OLD2NEW:
        if old in k:
            return k.replace(old, new)
    return k


def load_unet(model_dir, device="cpu"):
    from diffusers import UNet2DModel

    cfg = json.load(open(f"{model_dir}/config.json", "r", encoding="utf-8"))
    unet = UNet2DModel.from_config(cfg)
    sd = load_file(f"{model_dir}/diffusion_pytorch_model.safetensors")
    mapped = {_map_key(k): v for k, v in sd.items()}
    missing, unexpected = unet.load_state_dict(mapped, strict=False)
    if missing or unexpected:
        raise RuntimeError(f"unet load mismatch: missing={missing[:10]} unexpected={unexpected[:10]}")
    unet.eval().to(device)
    return unet


def load_scheduler(model_dir):
    from diffusers import DDPMScheduler

    return DDPMScheduler.from_config(json.load(open(f"{model_dir}/scheduler_config.json", "r", encoding="utf-8")))


# ---- noise-scheme reconstruction (config.json noise_scheme) ----

def qr_layout(amp=0.65, structural_scale=1.25, mask=None, rng_mask=None):
    """Return P (3,32,32) and the 25x25 module matrix placeholder.

    Layout from config.json:
      module index k = r*25+c (row-major) -> channel k//256, block k%256
      block b -> 2x2 pixels at row 2*(b//16), col 2*(b%16)
    """
    P = np.zeros((3, 32, 32), dtype=np.float32)
    return P


def build_noise(rng_G, rng_mask, qr_modules, amp=0.65, structural_scale=1.25):
    """Construct G + P from config.json's noise_scheme.

    qr_modules: (25,25) array, True = dark (-amp), False = light (+amp).
    G: standard normal, torch/numpy generator with carrier_seed.
    mask: per-pixel +/-1 from mask generator.
    Order of RNG draws is a hypothesis we can vary.
    """
    G = rng_G.standard_normal((3, 32, 32)).astype(np.float32)
    if rng_mask is not None:
        mask = rng_mask.integers(0, 2, size=(3, 32, 32)).astype(np.float32) * 2.0 - 1.0
    else:
        mask = np.ones((3, 32, 32), dtype=np.float32)
    P = np.zeros((3, 32, 32), dtype=np.float32)
    for r in range(25):
        for c in range(25):
            k = r * 25 + c
            ch = k // 256
            b = k % 256
            br, bc = b // 16, b % 16
            A = amp * (structural_scale if qr_modules[r, c] else 1.0)
            # sign convention: dark = -amp
            v = -A if qr_modules[r, c] else A
            P[ch, 2 * br:2 * br + 2, 2 * bc:2 * bc + 2] = v
    P = P * mask
    return G + P, G, P, mask
