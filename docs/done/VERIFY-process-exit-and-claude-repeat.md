# 补两条：markBlocked 后进程退出、claude 命令行为的重复测量

> 完成时间：2026-10-13 09:21

## 做了什么

两条都是我在自己的完成文档里标注过的"不精确处"，这次收掉。

### 1. `markBlocked` 之后进程确实退出了（18/18）

之前只验了"会话终态是 blocked"，**没验进程**。补上后：

```
PASS  库里记下了该会话的 pid（前置：否则没法验进程）  — pid=28184
PASS  markBlocked 之后 agent 进程确实退出了（不留孤儿）  — pid=28184 alive=false
PASS  此刻没有仍在 running 的会话（收尾干净）  — actual=0
```

方法：从库里取 `sessions.pid`，用 `process.kill(pid, 0)`（信号 0 = 只探活性）判断存活。

### 2. claude 的命令行为：从"单次测量"变成"3 次测量"

§4 那张表里 claude 的"跑命令不问"一行一直是**单次测量**，而且昨晚还被 Lane B 推翻过一次（简报轮它发了 11 条 shell 审批）。给探针加了 `--agent` 过滤，只测 claude 连跑三次：

```
第 1 次: claude  写文件时 request_permission=1   跑命令时 request_permission=0
第 2 次: claude  写文件时 request_permission=1   跑命令时 request_permission=0
第 3 次: claude  写文件时 request_permission=1   跑命令时 request_permission=0
```

**3/3 一致。** 但这与 Lane B 的观测并不矛盾——它那次发的是**读源码、枚举命名管道、grep**，不是无害的 `echo`。所以真实的规律是：

> **claude 区分命令的"分量"**：文件写入稳定会问（3/3）；无害命令（`echo`）稳定不问（3/3）；但读源码 / 枚举系统 / grep 这类探测动作会问。

§4 的表格已据此改成三档表述，而不是原来的"写文件问、跑命令不问"这种二元说法。

## 改了哪些文件

```
apps/desktop/src/cli/verify-concurrency-and-blocked.ts   补 3 条进程退出断言（15 → 18）
apps/desktop/src/cli/verify-agent-permission.ts          支持 --agent <id> 只测一家
docs/HANDOVER.md                                         §4 的 claude 一行改成实测过的三档表述
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:concurrency                                      # 18/18
node apps/desktop/src/cli/verify-agent-permission.ts --agent claude   # 连跑 3 次
```

输出见上两节。

## 没做什么 / 已知问题

1. **3 次仍然是小样本。** 足以说明"文件写入会问"很稳，但"无害命令不问"在别的无害命令（比如 `ls`）上没测——Lane B 的 `ls` 是**问过**的。也就是说这条的边界可能比我写的还细（`echo` 不问、`ls` 问？），**值得再用几条不同的无害命令测一轮**才能把边界画准。
2. **进程退出只测了 blocked 这一条路径**（那是最关键的一条）。正常结束、人工 stop、崩溃三条路径的进程回收没分别验。
3. **`process.kill(pid, 0)` 在 PID 被系统回收复用时会误判为"活着"**。这是理论风险，短时间窗口内不会发生，但严格说不够严谨（更稳的做法是查进程创建时间）。
4. **`--agent` 过滤是我为这次测量临时加的开关**，没进 HANDOVER 的脚本清单（它属于研究工具，不是回归套件）。

## 下一手需要什么

- 第 1 条值得做：用 3-5 条不同的"无害命令"（`echo` / `ls` / `cat 一个小文件` / `pwd`）各测几次，把"什么叫无害"的边界画出来——这条直接影响用户对"什么时候会被打断"的预期。
- 无待用户决策事项（B-4 安装流程那条仍等你）。
