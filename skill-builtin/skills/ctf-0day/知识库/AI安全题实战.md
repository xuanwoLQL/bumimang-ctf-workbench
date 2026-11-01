# AI 安全题的题型与应对（含 2025 CISCN 初赛真题实测）

> **数据来源**：`CTF-Archives/2025-CCB-CISCN-Quals` 真题附件（本人下载并实测，SHA256 与 GitHub 官方 digest 一致）。
> **标注规则**：写「**实测**」的是我自己跑出来的；写「**来源**」的引自可验证资料；写「**待验**」的是推断，别当结论用。

---

## 一、这类题的真实形态（实测，不是想象）

2025 第十九届 CISCN / 第三届长城杯初赛，**AI 安全已成独立题类**（不是 Misc 的一个小分支）。实测附件：

| 题 | 附件 | 形态 | 难度线索 |
|---|---|---|---|
| **欺诈猎手的后门陷阱** | `fraud_detector_supply_chain.pth`（91,020 字节）<br>`fraud_samples.csv`<br>`normal_samples.csv`（189 KB） | **模型后门逆向**：给定模型 + 正常/欺诈样本，要求**逆向出后门触发规则** | 10 特征 × 100 棵树；**文件是自定义容器**（见 §二） |
| **The Silent Heist** | `public_ledger.csv`（366,733 字节）<br>README | **对抗 ML 检测**：伪造交易记录骗过 Isolation Forest | 20 维特征、1000 条正常样本<br>通关条件：**总额 > $2,000,000** + 全部判为正常 + **禁重放 + 禁重复** |
| **AI_WAF**（Web 类，同赛） | — | **绕过 AI WAF** | 考点是"对抗模型"而非"打组件" |

**共同点（这三题的共性）**：
1. **必给数据/模型文件**，而不是给一个可交互的 Web 服务
2. 考点是「**逆向一个模型的判定逻辑**」或「**构造输入骗过模型**」
3. **常规手法（换 payload、扫目录、试 CVE）零收益**
4. **没有公开 writeup**（实测：多组中文查询 0 篇有效 writeup —— 这正好解释了"比赛时搜不到"）

---

## 二、★ 第一道坎是文件格式，不是 AI（欺诈猎手实测）

**实测结论（2026-10-10 更正）：那个 `.pth` 不是 PyTorch、也不是自定义容器，而是 `xgboost` 的
UBJSON 模型格式 —— 用标准 `xgb.Booster().load_model()` 直接加载即可（详见 §2.2 与 §2.4）。**

### 2.1 排查过程（照这个顺序走，省时间）

```bash
# ① 先看魔数（别信扩展名！）
xxd -l 64 fraud_detector_supply_chain.pth
# 实测输出：7b 4c 00 00 00 00 00 00 00 07 6c 65 61 72 6e 65 72   "{L" + len + "learner"
```

```python
# ② 直接尝试 pickle / torch.load —— 实测【失败】
import pickle
pickle.load(open("*.pth", "rb"))     # → _pickle.UnpicklingError: invalid load key, '{'
```
⇒ **看到 `invalid load key, '{'` 说明它不是 pickle** —— 但**不要就此判定"自定义格式"**（我一开始就是这么判错的，见 §2.3）。

### 2.2 ★ 正解：它是 UBJSON（XGBoost 模型标准格式）

> **2026-10 纠错**：本节原先写"自定义容器 + 8 字节**小端**长度"，**错的**。正确的是 **UBJSON**：
> `L` 是 **int64 标记**，**整数大端**。判错原因：我只试了"1 字节长度"和"8 字节小端"两版猜法，**没想起来去查 UBJSON 规范**。

**决定性实证（逐字节相同）**：
```
真题 fraud_detector_supply_chain.pth : 7b 4c 00 00 00 00 00 00 00 07 6c 65 61 72 6e 65 72
xgboost 自己 save_model() 出的 .ubj  : 7b 4c 00 00 00 00 00 00 00 07 6c 65 61 72 6e 65 72
```
⇒ `{ L <8字节大端=7> learner`。**同一个编码**，不是自定义容器。

**实测可行的加载链（已在本机跑通）**：
```python
import xgboost as xgb

b = xgb.Booster()
b.load_model("fraud_detector_supply_chain.pth")     # ★ 直接加载，不用手写解析器
print(b.num_features(), len(b.get_dump()))           # 10, 100

# ★★ 后门逆向的关键一步：dump 直接给「特征 < 阈值」
dump = b.get_dump(dump_format="text")
print(dump[0][:120])     # 0:[feat_3<0.231981665] yes=1,no=2,missing=2
```
**并且这一步不需要 sklearn**（`XGBClassifier` 才需要 sklearn，`Booster` 不需要）。

> **口径纪律**：`save_model()` 出的 `.ubj` 与本文件逐字节同形，证明**文件本身可被标准库解析**。
> 但**"能在真题上跑出结果"需在真题原件上实测才算数**（原件属一次性素材，可能不在手边）。
> 依赖缺口见 §四（`xgboost` 必装；`sklearn`/`torch` 非阻塞）。

**内层结构（UBJSON 解出的模型描述）**：
```
learner{
  attributes{}
  feature_names[# S  trans_amount_usd S addr_deviation_score S trans_time_risk_score
                    S merchant_code_hash S card_issuer_code S pos_terminal_id
                    S transaction_type_code S cvv_verify_score S account_age_month
                    S daily_trans_count ]
  feature_types[# S float ×10 ]
  gradient_booster{ model{ gbtree_model_param{ num_parallel_tree S 1  num_trees S 100 }
                           tree_info[# ... 100 棵 ... ]
                           num_feature S 10  num_nodes S 11  size_leaf_vector S 1 }
                    name S gbtree }
  learner_model_param{ base_score S 1.6528925E-1  boost_from_average S 1
                       num_class S 0  num_feature S 10  num_target S 1 }
  objective{ name S binary:logistic  reg_loss_param{ scale_pos_weight S 1 } }
  version[# i i i ]
}
```
⇒ **二分类 GBDT**：10 特征、100 棵树、`binary:logistic`、`base_score≈0.165`。

### 2.3 我踩的坑（你直接跳过）

| 我试的 | 结果 | 教训 |
|---|---|---|
| `pickle.load` | ❌ `invalid load key, '{'` | 先试标准库没错，但**别据此断定"自定义格式"** |
| 假设长度是 **1 字节** | ❌ 数据膨胀/错位（84KB→98KB） | 长度宽度猜错会**静默产出垃圾** |
| 假设长度是 **8 字节小端** | ❌ 解出巨大值（`0x0700…`） | ★ **大端才对**；**猜字节序前先去查规范** |
| 直接搜 `backdoor`/`trigger`/`flag` | ❌ 无命中 | 后门信息**不在字符串里**，要以「树结构 / 阈值」逆向 |

**★ 最值钱的一条教训**：
> **看到"像结构化数据但解不开"的二进制，先查"这格式是不是某个知名序列化"**（UBJSON / MessagePack / BSON / Cap'n Proto），
> 再考虑手写解析器。引擎名、字段名（`learner` / `gbtree` / `binary:logistic`）就是指纹 ——
> **它们直接会把你引到 XGBoost/UBJSON**，而我当时用了 4 轮猜长度宽度，**没去搜这几个词**。

### 2.4 ★ 真题端到端实测结论（2026-10-10，已跑通）

> 口径：**在真题原件 `fraud_detector_supply_chain.pth` 上实测**（91,020 字节），不是构造样本。

```
[加载] xgboost 自己给出判据：
       WARNING: Unknown file format: `pth`. Using UBJSON (`ubj`) as a guess.
       ✅ load_model() 成功 → num_features=10，树数量=100

[预测] 用 CSV 真列名对齐后：
       正常样本(1000 条) 预测均值 0.0001  [0.0001, 0.0005]
       欺诈样本(200 条)  预测均值 0.8060  [0.0296, 0.9996]
       ⇒ 判别力 +0.8059（模型完全可用）
```

**★ 后门指纹（可迁移的判据）**：

```
统计每棵树的「分裂特征 + 阈值」，按特征计数：
  trans_amount_usd       70 次分裂   阈值【全部 = 9874.6113】   ← ★ 极异常
  card_issuer_code       42 次       0.3989 ~ 0.5080
  cvv_verify_score       40 次       0.4843 ~ 0.5031
  daily_trans_count      37 次       3.8041 ~ 4.5021
  addr_deviation_score   30 次       4.5372 ~ 7.7810
  ...
  merchant_code_hash      2 次       1.9818
```

**判据（一句话）**：
> **同一特征被反复分裂、且阈值几乎完全相同（甚至一模一样）= 后门指纹。**
> 正常训练的 GBDT 不会把 70 次分裂全压在 `9874.6113` 这一个值上 ——
> 这说明**该阈值是被人为"焊进去"的**（触发点），而不是从数据学出来的。

**提取方法（照抄可跑 —— 已实测）**：
```python
import re, collections, numpy as np, xgboost as xgb

b = xgb.Booster()
b.load_model("fraud_detector_supply_chain.pth")      # ★ 先加载，再取 dump（load_model 返回 None，不能链式）

cnt, thrs = collections.Counter(), collections.defaultdict(list)
for t in b.get_dump():
    for m in re.finditer(r"\[([A-Za-z_0-9]+)<([-0-9.eE+]+)\]", t):
        cnt[m.group(1)] += 1
        thrs[m.group(1)].append(float(m.group(2)))

# 找「分裂次数多 且 阈值几乎不变」的特征 ⇒ 触发维度
for k, v in cnt.most_common():
    a = np.array(thrs[k])
    if v > 10 and a.std() < 1e-6:
        print(f"★ 后门候选: {k}  分裂 {v} 次  阈值恒为 {a[0]}")
```

**实测副作用（省时间的）**：
- 单特征敏感度扫描（固定其他维为正常均值、拉某一维到极端）**没有出现显著翻转** ⇒
  说明该后门**需要多特征同时满足条件**，不能靠"单维试探"找到 ⇒ **别在这条路上耗时间**。

---

## 三、两类正解的路线（按题型分）

### 3.1 模型后门逆向（欺诈猎手型）

**核心思路**：后门 = 某个（或某几个）特征取特定值区间时，模型输出被翻转。所以要做的是**找出那些"异常敏感"的分裂条件**。

```
① 直接标准加载：xgb.Booster().load_model(path)          ← 不需要手写解析器（见 §2.2）
② 提取全部分裂条件：b.get_dump() → 形如 0:[feat_3<0.231981665] yes=1,no=2,missing=2
③ 找"可疑分裂"：正常训练的树不会出现的模式 ——
     · 某个特征被反复用于分裂，且阈值集中在一个极窄区间
     · 某棵树的某个分支指向极高的 leaf_value（强行判为"欺诈"）
     · 单特征上出现"只有某区间的样本会走到这个叶子"
④ 用 fraud_samples.csv / normal_samples.csv 做对照：
     把正常样本喂进去，看哪一维的取值让输出翻转
     （= §「逐维度敏感度扫描」：固定其他维，扫描第 i 维，记录输出概率变化）
⑤ 命中的那组特征+取值 = 后门触发规则 → 按题目要求提交
```

**提速判据**：
- **100 棵树 × 10 特征 = 小规模** ⇒ 完全可以**全量遍历分裂条件**（不需要采样）
- 有 `fraud_samples.csv`（含 label=1）⇒ **先拿它反推**：欺诈样本 vs 正常样本在**哪一维的分布明显不同**，那一维大概率就是后门维度

### 3.2 对抗 ML 检测（Silent Heist 型）

**题目要求（实测原文）**：
```
1. 伪造交易总金额 (feat_0 总和) 必须超过 $2,000,000
2. 所有交易必须完美骗过 AI 模型，全部判为"正常"
3. 禁止直接重放截取到的日志（服务端有黑名单）
4. 禁止大量重复单一数据（服务端有去重检测）
```

**核心思路**：这是**从正常样本学习分布 → 生成新的、总额达标的、但不重复的样本**。

```
① 用 public_ledger.csv 拟合 20 维的分布（协方差矩阵 / 边缘分布）
② 生成候选样本：
     · 简单路线：对正常样本加小噪声（保分布内）
     · 进阶路线：按协方差结构做多元正态采样
③ 满足硬约束：
     · feat_0 总和 > 2,000,000  → 既然正常样本 feat_0 均值不大，需要【数量】堆总额
     · 不重复                    → 每条都要有随机性
     · 不在黑名单（= 不是原样本）  → 与日志里每条都保持距离
④ 自检：用 Isolation Forest 打分（异常分数低于正常样本的分布上界）
⑤ 按格式提交（**CSV 表头 + 末尾 "EOF"**）
```

**关键判据**：Isolation Forest 对"偏离分布"敏感 ⇒ **保守策略是"贴着正常样本分布生成"**，而不是追求极端值。

---

## 四、★ 本机工具实况（实测，2026-10-10）

**这是当前最实际的短板**：

| 库 | 状态 | 用途 |
|---|---|---|
| **`xgboost`** | ✅ **3.4.1（2026-10-10 已装）** | **GBDT 模型加载 + `get_dump()` 提取分裂条件 —— 后门逆向的必需项** |
| **`numpy`** | ✅ **2.5.3** | 数值计算（够用） |
| `lightgbm` | ❌ 缺 | LightGBM 型模型（本类题以 XGBoost 为多，非首要） |
| **`scikit-learn`** | ❌ **缺** | ⚠️ **`XGBClassifier` 需要它；但 `Booster` 不需要** ⇒ 走底层 API 可绕开。Isolation Forest（Silent Heist 型）仍需它 |
| `torch` | ❌ 缺 | 真 PyTorch 模型（体积大，确认有题再装） |
| `pandas` | ❌ 缺 | CSV 可用 numpy/csv 标准库替代，非阻塞 |

**⇒ 结论（已更新）**：**XGBoost/UBJSON 这一类现在可完整跑通（加载 → dump → 分裂条件）**；
只有 **Isolation Forest 与真 PyTorch** 两类还缺库。

**赛前补（按性价比，注意本机 pip 可用）**：
```bash
pip install lightgbm xgboost scikit-learn    # 三个一起装，覆盖 95% 的 ML 安全题
# torch 体积大（~2GB），除非确认有 PyTorch 题，否则先不装
```

---

## 五、识别与止损（一血视角）

### 5.1 「这是 AI 安全题」的信号（命中 2 条即判定）

| 信号 | 表现 |
|---|---|
| 附件是**模型/数据**文件 | `.pth` / `.pt` / `.onnx` / `.h5` / `.pkl` / `.csv`（大量样本） |
| 题面出现**统计/ML 术语** | 协方差、分布、异常检测、孤立森林、XGBoost、后门、触发规则、对抗样本 |
| 任务是「**伪造/骗过/逆向**」而不是「利用」 | "伪造一批记录骗过模型"、"逆向推导其多维特征分布规律" |
| 有明显的**约束条件** | 总额 > $2M、全部判为正常、禁重放、禁重复 |
| 要求提交的**不是 flag 而是数据流** | "将生成的 CSV 文本流发送到题目端口" |

### 5.2 止损判据（论文级证据）

> `AutoAdvExBench`（arXiv:2503.01811，Nicholas Carlini 等）原文：
> 一个强 agent 能破 **75% 的 CTF 式（"homework exercise"）对抗样本防御**，但在**真实世界防御上只成功 13%**。

⇒ **推论（对比赛的意义）**：
- 比赛题多为**简化版**（CTF-style）⇒ **该投**，别被"AI"吓退
- 但若题目要求复现**论文里的完整实验**（大规模数据 + 训练）⇒ **止损**

**硬止损线**：
- **格式逆向 > 15 分钟无进展 ⇒ 跳**（第一道坎过不去，后面全白搭）
- **模型跑起来但拿不到中间结果 ⇒ 20 分钟止损**

### 5.3 半成品得分点（这类题特别明显）

| 半成品 | 价值 |
|---|---|
| **答出模型类型/结构**（GBDT / 10 特征 / 100 棵树 / binary:logistic） | 常常是一道独立 flag |
| 答出**用的算法名**（Isolation Forest / XGBoost） | 同上 |
| 还原出**特征名列表** | 同上 |
| 部分样本通过检测 | 分页/多问赛制下独立计分 |
| 留下**可复现脚本** | 二血/三血靠它 |

---

## 六、赛前 2 天的最优动作（针对这个赛制）

| 优先级 | 动作 | 理由 |
|---|---|---|
| **P0** | **装 ML 库**：`pip install lightgbm xgboost scikit-learn` | 不装 = AI 题直接 0 分；装了三分钟的事 |
| **P0** | **把 §二 的容器逆向练通**（用已下载的欺诈猎手附件） | 已实测到"内层是标准 GBDT"，只差把它还原成 lightgbm 能加载的形式 |
| **P1** | **练 Silent Heist**（Isolation Forest 采样生成） | 这是**纯 numpy/sklearn 可做**的题型，不依赖 GPU |
| **P1** | 把 `CTF-Archives` 里其它 AI 题下下来（`2026-WQB-Quals` 等） | 题型窗口期短，练最新 |
| **P2** | torch（若确认有 PyTorch 题） | 体积大，最后装 |

> **附件已就位**：`E:\0day渗透安全专项\_work\ciscn2025\extracted\`（17 题全下载，SHA256 已核对）

---

## 七、待验与未知（诚实标注）

| 项 | 状态 |
|---|---|
| 容器格式的**完整**解析规则 | **待验**：已确定是 `L` + 长度 + 内容的嵌套结构，但递归解析器未写通（我试了 1 字节/8 字节两版都不完整） |
| 三道 AI 题的**官方 writeup** | **未找到**（实测多组查询 0 命中） |
| "欺诈猎手"的论文源头 | **特征对齐推断**（`Backdoor Attacks on Transformers for Tabular Data`，arXiv:2311.07550），**非出题人自述** ⇒ 别当定论 |
| Silent Heist 的 Isolation Forest 具体实现 | **未知**（题目只说是 Isolation Forest，未见代码/参数） |
