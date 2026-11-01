# AB-1 · A/B 首次真跑（好靶场 hbc2 命令执行题，1 会话 vs 3 会话）

**日期**：2026-10-20 16:08–16:21 · **范围**：`src/cli/verify-ab.ts`（1 行修复）· 消耗：4 个真实 claude 轮次

## 做了什么

`npm run ab` 工具 10-13 就绪后**第一次不带 `--dry` 真跑**。题目由用户提供：`hbc2.haobachang.com:16516`（好靶场「命令执行 Demo」，nginx 1.20.2 + PHP 7.3.33）。跑前先修了工具文档里记录的真缺陷：`facts` 的 `created_by` 没取到（`listFacts` 的 SELECT 在 R16/R17 已补上该列，verify-ab.ts 还在写死 `"?"`），一行修复后事实类判重恢复可用。

## A/B 结果（样本 1，单次测量）

| 指标 | 单会话 | 3 会话 |
|---|---|---|
| 墙钟时间（全队收尾） | **79.0s** | 157.9s |
| **首个 flag 时间** | 69.5s | **58.8s** |
| 工具调用合计 | **11** | 50 |
| 黑板读取（wire 实测） | 5 | 9+9+21 |
| 死路/事实/意图 | 1/2/0 | 1/7/0 |
| 审批次数 | 0 | 0 |
| 疑似重复劳动 | 0 | **1**（flag 被 s2 与 s3 各写一遍，bigram 相似度 1.0） |

**结论（诚实版，含勘误后的最终口径）**：**「先碰到答案」三路并行更快（58.8s vs 69.5s，快 15%），但「全队收尾」三路慢一倍、工具调用多 4.5 倍**，且出现重复劳动（flag 写两遍）。真正缺的不是「agent 不读黑板」而是**「首个有效结果不会让其他会话收敛」**——s2 的 flag 落库后 s3 又写了一遍、s1 再做复核，makespan 因此翻倍。单次测量不能当规律，要下结论需 3 次取中位数 + 修配对顺序。

## flag（已报告 16:22，提交归人工）

- **flag{11519b171bc24ec99afe0c017a2aabfa}**
- 位置：`/tmp/flag.txt`（root:root 0644，39 字节）；`/flag`、`/flag.txt` 根目录不存在，`GZCTF_FLAG` 环境变量为空。
- 手法：POST `http://hbc2.haobachang.com:16516/` 参数 `command` 直通 `shell_exec` 并回显；黑名单 `preg_match('/(\?\*|cat|tac|head|tail|more|less|nl|sort|uniq|od|xxd|hexdump|base32|base64|strings|grep|file|find|cp|mv|wget|curl|nc|ncat)/i')`，用 `dd if=/tmp/flag.txt` 绕过（备选 `awk 1`、`rev`）。三个会话独立复核一致（s2/s3 独立读到，s1 用 dd 与 awk 两条路径二次确认）。
- 台账：`docs/CTF-台账-hbc2.md`（含重拿手法）。
- 注意：好靶场实例是分钟级回收的，flag 与实例强绑定——若实例已回收，提交需重开环境重拿。

## 改了哪些文件

- `src/cli/verify-ab.ts`：facts 判重改用 `f.created_by ?? "?"`（1 行）。

## 怎么验证的

```powershell
npm run ab -- --dry          # 修复后 dry 仍 PASS（参数/报告/判重/落盘）
npm run ab -- --brief "授权 CTF 靶机：http://hbc2.haobachang.com:16516/ —— 好靶场「命令执行 Demo」题（nginx 1.20.2 + PHP 7.3.33），页面上有一个命令执行输入框，提交的命令会在服务器执行并回显。目标：利用命令执行读到本题的 flag（格式 flag{...}），拿到后把完整 flag 原样写进黑板（submit_fact），成功手法与失败尝试也如实记进黑板（blackboard_declare_dead_end / submit_fact）。flag 常见位置：/flag、/flag.txt、/var/www/html 下、根目录。只做侦察与读文件，不做破坏性操作。" --sessions 3 --agent claude --timeout 600
# → 对照表见上；原始数据 docs/logs/ab-result.json（at=2026-10-20T08:21:13Z）
```

跑前五连发确认靶机存活（全 200，0.12–0.18s），并做了一次最小 RCE 探针（`echo BM_PROBE_ok` 回显命中）确认题可解——避免 4 轮 agent 打在死靶/不可解题上。

## 没做什么 / 已知问题

- **样本量 1**。工具自己印着「单次测量不能当结论」；要下结论需各跑 3 次（12 个 agent 轮次）取中位数。
- **配对顺序没做**：单会话先跑、多会话后跑，第二次可能因模型/网络波动系统性偏快或偏慢。
- **超时未触发**（两轮都在 600s 内自然结束），「超时后直接 shutdown 导致多会话侧数字偏低」的已知缺陷本轮未暴露。
- **首答时间指标当时没有**（本轮跑完才加进工具），上面的 69.5s/58.8s 是从 board.db 的 `facts.created_at` 与 `sessions.started_at` 事后算的。

## 勘误（2026-10-20 17:05，见 docs/done/R22-codex-review-triage.md）

1. **「三家 boardReads=0 ⇒ 简报继承没被消费」是错的。** 真因是 A/B 工具建桥时没接 `onBoardRead` 回调（桥有回调、manager 有计数点，唯独 harness 没接），`boardReads` 恒 0。wire.jsonl 实测：单会话读了 5 次黑板，三会话分别 9/9/21 次——**agent 确实在消费黑板**。已修工具并新增首答时间指标。
2. **「3 会话没有省时间」的口径要细分**：首答时间三路快 15%，慢的是全队收尾。结论改为「缺收敛机制」，见正文。

## 下一手需要什么

- 想拿可靠结论：同一道题再跑 2 次（或换一道更难的题——简单题单人 70 秒就解完，可省的余量小），并加一组 guarded 档对照（这轮 0 审批，没验证「人工只处理审批边界」）。
- 「首个有效结果 → 收敛其他会话」的机制（Codex 评审 P2，见 R22）。
