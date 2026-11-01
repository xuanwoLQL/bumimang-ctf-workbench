# Misc · SilentWeights

## 结果

```text
flag{w31ghts_d0nt_l13_but_th3y_wh1sp3r}
```

证据等级：E2。脚本从模型 `fc2.weight` 的 float32 LSB 流直接恢复 flag。

## 题面

附件模型在测试集上准确率 100%，前向推理和权重分布看起来正常，但文件内隐藏
间谍活动信息。附件包含：

```text
evaluate.py
model.py
model.pt
test.npz
requirements.txt
```

模型结构：

```text
16 -> 64 -> 32 -> 10
```

## 定位

先验证业务行为：

```text
accuracy: 100.00%  (2000/2000)
```

然后检查每个参数的 IEEE-754 低位平面。`fc2.weight` 的最低有效位形成 ASCII
字节流，开头很快出现：

```text
flag{w31ghts_d0nt_l13_but_th3y_wh1sp3r}
```

注意：

- 不是整个 `state_dict` 连续拼接后的随机文本；
- 目标张量是 `fc2.weight`，形状 `(32, 64)`；
- 每个 float32 提取 bit 0；
- 按 C 行优先顺序、每 8 bit 高位在前打包。

## 复现

```powershell
python scripts/silentweights/extract.py model.pt
```

输出：

```text
tensor=fc2.weight
shape=(32, 64)
flag=flag{w31ghts_d0nt_l13_but_th3y_wh1sp3r}
```

附件 SHA-256：

```text
70ad16bd8636dcce010376160094b29033aa0977567811d24e629be702670508
```

## 为什么普通评估看不出来

只修改浮点参数最低位，对权重分布、前向输出和测试集准确率几乎没有影响；
但序列化成 float32 后，最低位可以被无损读出。若再做正常训练或量化，隐写
内容就会被破坏。

## 检查脚本

```python
import numpy as np
import torch

state = torch.load("model.pt", map_location="cpu", weights_only=True)
weight = state["fc2.weight"].numpy().astype(np.float32)
bits = weight.view(np.uint32) & 1
payload = np.packbits(bits, bitorder="big").tobytes()
print(payload)
```

## 修复建议

1. 模型发布前做低位清理、重新量化或重新序列化。
2. 对权重执行 canonicalization，并记录哈希。
3. 不把模型文件当作可信或隐蔽存储介质。
4. 引入发布门禁：检测 LSB 熵、异常 ASCII 序列和额外 ZIP/pickle 对象。

## 证据

- `evidence/silentweights-flag.txt`
- `scripts/silentweights/extract.py`
