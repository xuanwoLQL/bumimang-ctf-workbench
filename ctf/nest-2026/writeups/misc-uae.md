# Misc · UAE

## 结果

```text
flag{dr34m_0f_n01s3}
```

证据等级：E2。两个独立 QR 检测器均从恢复矩阵解出 `dr34m_0f_n01s3`。

## 题面

附件提供一个扩散模型分类器、`x_adv.npy`、采样器和配置。攻击者把接头暗号编码
在生成对抗样本时使用的初始噪声 `x_T` 中。

核心关系：

```text
x_T = G + P
```

- `G`：以 seed `555` 生成的标准正态噪声
- `P`：把 25×25 QR 模块写入 3×32×32 像素的扰动
- 每个模块写入 2×2 像素块
- `amp=0.65`
- structural 模块额外乘 `1.25`
- 像素级 mask seed：`20261012`

25×25 QR 共 625 个模块：

```text
module index k = row*25 + col
channel = k // 256
slot    = k % 256
block   = (slot // 16, slot % 16)
```

## 攻击链

1. 加载挑战提供的 `CifarResNet18`。
2. 使用 `sampler.py` 的 guided DDIM `invert_fixedpoint` 反演 `x_adv`。
3. 固定 `target=argmax(classifier(x_adv))`、`scale=3.0`、`steps=1000`、
   `iters=3`。
4. 减去 seed 555 的高斯载体。
5. 乘以 seed 20261012 的 ±1 mask，并聚合每个 2×2 block 的均值。
6. 修复 QR 的定位、分隔、时序、校正和暗模块。
7. 解码得到 `dr34m_0f_n01s3`。

## 复现

先按题目附件准备：

```text
attachments/uae/uae/
├─ car.png
├─ classifier.pt
├─ classifier.py
├─ config.json
├─ sampler.py
└─ x_adv.npy
```

下载 `google/ddpm-cifar10-32` 到本地模型目录后运行：

```bash
python scripts/uae/uae_solve.py \
  --challenge-dir attachments/uae/uae \
  --model-dir models/ddpm-cifar10-32 \
  --out work/x_T.npy \
  --steps 1000 --iters 3

python scripts/uae/qr_fix_decode.py \
  --x-t work/x_T.npy \
  --out-dir evidence
```

预期输出：

```text
payload=dr34m_0f_n01s3
flag=flag{dr34m_0f_n01s3}
```

本次实例使用 `steps=100` 的快速反演也能得到可用的结构信号；`alpha=0.5` 与
`alpha=0.6` 两组参数解出相同 payload。

## 为什么不是普通隐写

暗号位于反演后的 latent noise，而不是 PNG 像素、EXIF 或模型权重。只查看
`car.png` 或 `x_adv.npy` 的可见像素不会直接发现 QR。

## 修复建议

- 对抗样本交付时不要复用可推导的初始噪声 seed。
- 对训练/评估流水线中的随机源使用不可预测的 CSPRNG。
- 模型和样本包的元数据应最小化，避免泄露生成参数。
- 水印应使用密钥化、不可感知且可验证的方案，而不是结构性 QR。

## 证据

- `evidence/uae-flag.txt`
- `evidence/uae-final-decode.log`
- `evidence/uae-qr.png`
- `scripts/uae/`
