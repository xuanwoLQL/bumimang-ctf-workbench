# Misc · FilmReader

## 结果

```text
flag{n0_m0d3l_r34d5_7h15_d33p}
```

## 题目类型

ext4 镜像取证 + Linux kernel module 逆向 + 自定义 VM 解密。

镜像中的 `note.txt` 提示：

> `cat` 没有骗你，骗你的是 `read`。  
> `flag.txt` 是安慰奖；真正的缓存已删除；钥匙碎成四瓣。

## 证据恢复

使用 Sleuth Kit / debugfs 枚举删除 inode，恢复：

```text
27_.real_cache.bak
28_.real_cache
29_.s1
30_.s2
31_.s3
32_.k2
```

其中：

- `.real_cache.bak` 解出草稿 flag
- `.real_cache` 解出真 flag
- `.s1/.s2/.s3/.k2` 是 KDF 的四段输入

## kcompat.ko

`init_module` 读取四个文件前 4 字节，拼成 16 字节 seed：

```text
seed = s1[0:4] || s2[0:4] || s3[0:4] || k{s2[0] & 3}[0:4]
```

随后计算：

```text
digest = SHA256^2^25(seed)
a6     = rodata[0x3c0:0x3e0] XOR 0xa6
assert digest[16:32] == a6
```

用 `digest[0:4]` 作为 u32，异或 `0x5a5a5a5a5a5a5a5a`，得到 VM 流密钥种子。

## 自定义 VM

VM 的 448 字节程序位于 `rodata+0x200`，先按 splitmix/LCG 流异或解密：

```text
state = state * 0x5851F42D4C957F2D + 0x14057B7EF767814F
stream_byte = state >> 56
```

`read` hook 挂在 `__x64_sys_read`：

- 当路径为 `/home/ctf/flag.txt` 且 dial>2 时，实际读取 `.real_cache`
- 每 8 字节块以 `digest[0:16] || block` 为 VM 上下文
- VM 输出 `ctx[16:24]` 作为明文块

## 解密结果

```text
/home/ctf/flag.txt       -> flag{r34d_h00k_d3crypt5_3v3ryth1ng}
.real_cache.bak           -> flag{f1r57_c4ch3_15_4_dr4ft}
.real_cache               -> flag{n0_m0d3l_r34d5_7h15_d33p}
```

## 复现

将题目 ext4 镜像恢复后的文件放到：

```text
evidence/recovered/
├─ 27_.real_cache.bak
├─ 28_.real_cache
├─ 29_.s1
├─ 30_.s2
├─ 31_.s3
└─ 32_.k2
```

执行：

```powershell
python scripts/filmreader/kdf.py
python scripts/filmreader/dec_prog.py
python scripts/filmreader/decode_all.py
```

脚本源自实际工作目录，路径与输入名需要按本机附件布局调整。

## 证据

- `evidence/01_cat_note_flag.txt`
- `evidence/deleted_inodes.txt`
- `evidence/fls_deleted.txt`
- `evidence/vm_prog.bin`
- `evidence/vm_disasm.txt`
- `evidence/decode_output.txt`
- `evidence/flag_real.txt`

## 结论

三层诱饵：

1. 直接 `cat flag.txt` 得到乱码。
2. `read` hook 将读取重定向到缓存。
3. 缓存还有草稿版和正式版，必须通过 VM 解密后区分。
