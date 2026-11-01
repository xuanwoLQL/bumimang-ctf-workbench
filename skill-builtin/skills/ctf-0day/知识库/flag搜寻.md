# flag 搜寻（拿到 shell 第一分钟）

> 比赛计分就是 flag。**拿到 shell 先搜 flag 再做任何事**（提权/横向是找完 flag 之后的事——很多题低权就能捡到 flag）。
> flag 形态先确认：题目说明给格式（`flag{...}`、`SUCTF{...}`、UUID）。没有格式说明就搜 `{` 开头长得像的串。

## Linux 一把梭

```bash
cat /flag /flag.txt /flag_* /root/flag* /home/*/flag* 2>/dev/null
find / -maxdepth 4 -name "*flag*" -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null
env | grep -i flag
grep -rlE "flag\{" /tmp /var/www /home /root --include="*.txt" --include="*.php" --include="*.html" 2>/dev/null
```

按命中率排序的藏点：

| 位置 | 说明 |
|------|------|
| `/`、`/root`、`/home/*`、`/tmp`、`/var/www/html` | 明文文件，第一优先 |
| **数据库**（mysql/postgres/mssql） | `flag` 库、`secret` 表。mysql 凭据看 `/var/www/html/*/config*` 或 `~/.mysql_history`；`select * from flag.flag` |
| `env` / `/proc/self/environ` / systemd 服务环境 | 环境变量 flag |
| `/etc/passwd` 用户的 gecos 字段、`/etc/motd` | 老六藏法 |
| web 目录注释 / `.env` 文件 | `grep -r "flag{" /var/www` |
| 非默认名：`this_is_flag`、`final.txt`、`.flag`（隐藏） | `ls -la /` |
| root 才能读的 `/root/flag` | 提权后回来拿（记下来别忘） |
| 内网其它机器 | 横向（`内网横向.md`） |
| 定时任务/计划脚本 | flag 可能每 N 分钟由脚本重新生成（防你删别人的），`crontab -l` |
| 容器场景：挂载卷、k8s env、`/var/run/secrets` | 容器逃逸后宿主机再搜一轮 |

## Windows 一把梭

```cmd
dir /s /b C:\*flag* 2>nul
type C:\flag.txt C:\Users\Administrator\Desktop\flag.txt 2>nul
set | findstr /i flag
reg query HKLM\SOFTWARE /f flag /s 2>nul | findstr /i "flag"
```

- 桌面（所有用户）、`C:\Users\*\Desktop`、回收站 `C:\$Recycle.Bin`
- 计划任务输出、IIS 站点目录（`C:\inetpub\wwwroot`）
- 注册表 RUN 键、无标题 txt
- **拿不到的（ACL 只允许 SYSTEM/管理员）**：提权回来拿，记清单

## 数据库定向

```sql
-- mysql
show databases; use flag; show tables; select * from flag;
select * from information_schema.tables where table_name like '%flag%';
-- 常见库表名：flag、fl4g、ctf、secret、this_is_flag
```

mssql：`xp_cmdshell` 开着的话直接 `exec master..xp_cmdshell 'type c:\flag.txt'`。

## 提交环节（别小看，丢分重灾区）

- flag 到手**立刻报告**，别攒批；**报告归 agent、提交归人工**（见 SKILL.md「平台接口纪律」）。人工提交失败时先看格式（大小写/花括号/多打空格）
- 判「已提交」的记台账时间——flag 轮换型题目过段时间可能变，回头重拿
- 台账三列：`flag 值 | 来自哪台机器哪个位置 | 是否已报告`；同一 flag 两台机器都有 → 只算一台的分，优先找独立 flag
- 低权拿到的 flag 和 root-only 的 flag 分开记，提权后回补

## 假点

- 找到 `flag.txt` 但内容是 `flag{fake}` /「加油」 → 是饵，真 flag 在别处（数据库/env/提权后）
- find 全盘太慢 → `maxdepth` 限制 + 排除 /proc /sys，别在 /usr 里磨
- web 源码里的 `flag{...}` 先看是不是硬编码演示串——真 flag 一般动态校验或独立存放；**但比赛里源码里直接写 flag 的也不少**，先提交试试
- flag 提交失败 ≠ 没找对，可能 flag 轮换（定时任务重新生成），注意看时间戳
- 低权看不到的别硬磨 → 记入「提权后动作清单」，继续跑下一台
