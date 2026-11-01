# 论文改编 CTF 实战案例集

> **用途**：赛前 10 分钟扫一遍，建立"论文题长什么样"的直觉；现场遇到立刻对照。
> **资料来源**：全部为公开可验证的论文 URL + writeup URL（2026-10 采集核对）。
> **判读纪律**：标注「**直接引用**」= 出题人/WP 自己写明论文；「**特征对齐**」= 靠技术特征推断，**属强候选不是定论**。

---

## 一、核实案例表

| 赛事 | 年份/场次 | 题名 | 论文 | 考点 | 难度/解出数 |
|---|---|---|---|---|---|
| **PlaidCTF** | 2020 crypto 350 | **MPKC** | [Chen et al. eprint 2020/053](https://eprint.iacr.org/2020/053) | 多变量二次公钥线性化，**论文 §3 STEP1-3 原样实现** | 42 队解出（中） |
| **PlaidCTF** | 2019 pwn | **Spectre** | [Spectre, Kocher et al.](https://spectreattack.com/spectre.pdf) | 分支预测 + 缓存计时；**缺 `_mm_clflush` 要自己造** | 高 |
| **西湖论剑** | 2022 初赛 crypto | MyCurveErrorLearn / MyErrorLearn / MyErrorLearnTwice / MyOracle | HNP §7、§7.1（**官方题解直接写章节号**）→ 推断 [Boneh & Venkatesan CRYPTO'96](http://theory.stanford.edu/~dabo/pubs/abstracts/dhmsb.html) ｜**特征对齐** | 格攻击 / 二元 Coppersmith / LLL / MT19937 state 恢复 | 高 |
| **看雪 KCTF** | 2024 大赛第五题 | **废弃星球** | [Boneh & Franklin, IBE from the Weil Pairing](https://crypto.stanford.edu/~dabo/papers/bfibe.pdf) | BF-IBE + HMAC 伪碰撞 + BLS12-381 子群攻击 + RSA-LSB-Oracle→BSGS | ★**全队 0 解出** |
| **USTC Hackergame** | 2024 general 100 | **每日论文太多了！** | [ACM 10.1145/3650212.3652145](https://dl.acm.org/doi/10.1145/3650212.3652145)（**论文本体即题面**） | PDF 里被白色图片遮挡的文字 / `pdfimages` | 中 |
| **USTC Hackergame** | 2022 math | **置换魔群** | [Landau's function, arXiv:0803.2160](http://arxiv.org/abs/0803.2160) + [OEIS A000793](http://oeis.org/A000793) | 置换群上 RSA/DLP/最大阶元素；**第 3 问是开放题** | 高 |
| **iCTF (UCSB)** | — | **Evil Model** | [EvilModel, arXiv:2107.08590](https://arxiv.org/abs/2107.08590) | 模型权重**低三位藏字节** + 内嵌 eval | 需读论文 |
| **iCTF (UCSB)** | — | **Stop the model thief!** | [Princeton CASS icmr12](https://www.cs.princeton.edu/cass/papers/icmr12.pdf) | 近重复图像检测定位模型窃取者 | 中 |
| **DEF CON Quantum Village CTF** | 2025 决赛 | The Shapiro Incident | [PRL 2000](https://doi.org/10.1103/PhysRevLett.85.1330) + [Decoy State QKD](https://arxiv.org/abs/quant-ph/0411004) | BB84 光子数分离（PNS）攻击 | 中高 |
| **DEF CON Quantum Village CTF** | 2025 决赛 | Navigation Log Extract | 量子态层析（Bloch 球） | X/Y/Z 概率→(θ,φ)→5bit+3bit 拼字节 | 中 |
| **DEF CON Quantum Village CTF** | 2026 决赛 | qtris? #99 No-Cloning Zone | 盲量子计算 + 测量驱动量子计算 | LCG 种子恢复 + OTP + feed-forward 校正 | ★**0-solve** |
| **DEF CON Quantum Village CTF** | 2026 决赛 | qtris? #100 You already solved it! | **Gottesman-Knill 定理** | Clifford vs 魔法角；stabilizer 模拟 | ★**0-solve（全场无解）** |
| **CISCN** | 2024 初赛 misc | Power_Trajectory | 侧信道功耗分析（按提示找文章） | 从 .npz 迹线筛正确字符 | 中 |
| **强网杯** | 2024 | ez_vm | 白盒 AES DFA（谱系：[eprint 2020/342](https://eprint.iacr.org/archive/2020/342/1585009196.pdf)）｜**特征对齐** | 手撕 VM + 白盒 AES 差分故障分析 | 高 |

**主题分布**：密码学（格/HNP、pairing、MPKC、白盒）> 量子 > AI/ML > 侧信道。

---

## 二、★ 入口：从线索**倒推**论文（六种线索形态，全部有原文）

> **关键认知**：入口不是"读论文找题"，而是"**抠题面的线索去搜论文**"。

| 线索形态 | 真实案例原文 |
|---|---|
| **源码/题面注释写了作者名** | PlaidCTF 2020 MPKC 选手原话：*"By searching based on the comments(`Jiahui Chen et al. cryptosystem, 80-bit security`), I found the paper"* ⇒ **注释就是入口** |
| **题面留了制度名/缩写** | KCTF 废弃星球出题人原话：*"本题给出了提示 **Identity Based Encryption**，加上 pairing-ce 库函数，去 Google 一下现有的 IBE 体制，就能找到最著名的一篇实现"* |
| **题目明说问题名** | 西湖论剑官方题解：*"**参考文献 HNP 第 7.1 节** Elliptic Curve Hidden Number Problem 中的构造"* |
| **库 / API 指纹** | `pairing-ce` ⇒ pairing 类密码；`libil2cpp` 之类同理 |
| **常量指纹** | Quantum CTF 2026：`1103515245 / 12345` = **C `rand()` 的 LCG** ⇒ 直接锁定"这是 LCG，要恢复种子" |
| **题名本身** | 「置换魔群」= Landau's function；「#100 You already solved it!」= Gottesman-Knill |

**现场动作（30 秒）**：
```bash
strings -n 6 SAMPLE | grep -iE "et al|paper|cryptosystem|scheme|protocol|IEEE|ACM|eprint|arXiv|20[0-9]{2}"
# 同时：把题面的人名 / 制度名 / 算法名 / 常数值 / 库名 抠出来，丢进 Google + arXiv + DBLP
```

---

## 三、★ 拿到论文后：**抄章节级施工图，不要通读**

**选手原话（PlaidCTF MPKC）**：
> *"My goal is simply follow the exploit plan (step 1 to 3) at section 3 of the paper."*

**并且他把论文引理写成了断言当检查点**：
```python
# Evidence of 3.1: Linearly independent set of n - a degree-one polynomial
kernel_basis = Quad.kernel().basis()
assert len(kernel_basis) == n - a
```

**另一选手引论文原句**：
> *"In Section 3.1, they pointed out an important property of the public key... So we can put aside the quadratic terms and solve the linear part directly."*

⇒ **行动**：找 `Algorithm / Protocol / Step 1-2-3 / Theorem N` 编号，**把伪代码逐行翻成 Sage/Python**，并**用 `assert` 复现论文引理**作为检查点。

---

## 四、★★ 论文只给 70% —— **那 30% 才是真正拉分的地方**

> 这一节是整篇最值钱的部分，因为它解释了"为什么照着论文抄还是会卡"。

| 案例 | 论文覆盖不到的部分 | 怎么破 |
|---|---|---|
| **PlaidCTF Spectre** | **缺 `_mm_clflush`**（没有缓存刷新指令） | 用"持续访问不需要的页（超过 3M cache）**把目标页挤出去**"替代；作者还自述：训练 `builtin_bc` **必须在汇编层重复、不能写循环**；清缓存后**要空转给 CPU 时间**（*"比赛时我没注意到"*）；测量要**打乱顺序** `(i*67)&0xff` 防预取 |
| **KCTF 废弃星球** | *"乍一看这似乎是一个 Hidden Number Problem，但是基于 Lattice 求解 HNP 在这里**行不通**"*（只能重置两次、最多 3 个方程） | 改走 **LSB-Oracle + BSGS** |
| **Hackergame 置换魔群** | **单个**元素最大阶有论文（Landau's function），**两个**元素 *"网上也没有找到确定性的研究结论"* | 自己**背包扩容 + 近似子集和** |
| **Quantum #100** | 知道是 Gottesman-Knill 也没用，**缺出题人的资源态几何** | 作者诚实承认卡住（0-solve） |

**⇒ 结论**：论文给的是"骨架"，**出题人考的恰恰是骨架之外的那 30%**。

---

## 五、校验类经验（纯工程，必须记住）

| 经验 | 出处原文 / 说明 |
|---|---|
| **解出来被拒 ⇒ 继续往下解** | Quantum #99 解出 `qv{n0_cl0n1ng_th30r3m}` **被拒**，真 flag 是 `qv{n0_cl0n1ng_th30r3m_ftw}`。作者原话：*"when a decode gives a clean, on-theme string but the flag is rejected, **keep decoding past the first `}`**"* |
| **拿到 key 不要当 flag 交** | 同题：*"The seed is the key, not the message"*（种子提交全格式被拒） |
| **已知明文是最强武器** | `qv{` 这个前缀直接砍掉 `8!` 的映射搜索空间 |
| **用论文的数值结论反验证** | iCTF Evil Model 注入 flag 后精度仍是 `0.9509999752044678`（与原始完全相同）才证明方法对 |
| **半成品也有分** | IDS 赛题论文原文：*"teams earn points when submitting a flag, allowing them to gain credit even for intermediate results"* |

---

## 六、难度的真相（**直接回答"我害怕出现这种个别难题"**）

**收集到的 0-solve 案例**：
- 看雪 KCTF 2024 第五题「废弃星球」（**全队零解出**）
- DEF CON Quantum CTF 2026 #99 / #100

**这些 0-solve 题的共同点**：**要同时串起 2~3 个不相关的技术**
```
废弃星球  = IBE 误用 + 子群攻击 + LSB-Oracle（三条独立链）
Quantum#100 = 盲量子计算 + OTP + 前置反馈校正
```

**★ 反过来说（这条最能安你的心）**：
> **只考"认出论文并抄论文"的单点题，通常不是 0-solve** ——
> PlaidCTF MPKC **42 队解出**，靠的就是"从注释搜到论文 + 照 §3 抄"。

⇒ **"认出论文"这一步本身就能甩开绝大多数队伍。** 这正是现场最该练的肌肉，而不是把论文全读懂。

**出题人的立场（Quantum CTF 出题人自述）**：
> *"I wanted to avoid challenges where the solution was simply to recognise a formula and apply it."*
⇒ 出题人在**主动回避**"认出公式就完事"的题 ⇒ 所以你练的重点应该是
**"认出 + 补上那 30%"**，而不是"背公式"。

---

## 七、未核实区（**不要当论文题用**）

| 项 | 真相 |
|---|---|
| Nullcon HackIM 2025「Ancient paper」 | **不是论文题**：题名 paper 指**打孔卡片**。原文 *"the image is of an **IBM-29 punch card**"* ⇒ `1337 FORMAT ENO H0LL3R1TH 3NC0D3D F0RTR4N`，flag `ENO{H0LL3R1TH_3NC0D3D_F0RTR4N}` |
| N1CTF「nipple」 | **与论文无关**：纯 pwn 堆题，作者自述"利用手法并不是很难……逆向量较大" |
| PlaidCTF 2021「leaky block cipher」 | 自定义密码（GF(2^128) 上 255 次单位根，判据 `h^{(2^128-1)/255}=1`），**未找到论文出处** |
| 西湖论剑 "HNP" 的论文对应 | **是我推断的**（依据章节号 7/7.1 与题名 EC-HNP 吻合），官方未给标题 URL ⇒ **引用前再核** |
| SSTIC Challenge（法国学术型，历年解法齐全） | 官方解法**全是 PDF**，抓取工具不支持 ⇒ 手动下载：[2025](https://static.sstic.org/challenge2025/PierreBienaime/solution_bienaime.pdf) / [2023 face0xff](https://static.sstic.org/challenge2023/face0xff/Challenge%20SSTIC%202023%20-%20Writeup%20-%20face0xff.pdf) / [nneonneo/sstic-2022](https://github.com/nneonneo/sstic-2022) / [nneonneo/sstic-2023](https://github.com/nneonneo/sstic-2023) |
| 学术会议自带 CTF（USENIX/CCS/NDSS/S&P 出论文题） | **未找到可信实例** |

---

## 八、决赛现场一句话

> 看到"**没有现成 POC、机制诡异、参数像学术符号**"的题，**先别写代码** ——
> 把题面的**专有名词、人名、常量、库名**抠出来搜论文；找到后**直接翻到 Algorithm / Section 3**，
> 把伪代码**逐行翻成脚本**，并用 `assert` **复现论文引理**；
> **论文覆盖不到的那 30%，才是这题真正在考你。**
