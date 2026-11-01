# WEB CTF INTAKE · V3 状态

> 日期：2026-10-25
> 新靶场：`http://hbc2.haobachang.com:18420/`（已替换旧 `http://hbc2.haobachang.com:35190/`）
> 旧样本：`D:/agent/xuanwo/evidence/ctf-intake-hbc-command-demo/INTAKE.json`、`INTAKE.md`、`D:/benchmarks-local/hbc-command-demo-20261025/ground-truth.json` **仅历史参考，不是新题**。

## 状态

```text
WEB_CTF_SELECTED_CHALLENGE=BLOCKED_WAITING_INTAKE
WEB_CTF_RESET_METHOD=UNKNOWN
REAL_AGENT_RUN=BLOCKED_NOT_AUTHORIZED
```

证据：`evidence/ctf-intake-18420/STATUS.json`。

## 已确认

- 用户手动 launch 和选择题目；未确认前不假设方向（可能是 file-upload-bypass / jwt-crack，但未确认）。
- 用户负责 reset、人工确认和最终 submit。
- Claude 不得 launch / reset / submit / batch-submit / 查询 token。
- 截图 Cookie 已视为泄露，不读取、不使用。
- 未访问新靶场；未做任何 HTTP 请求；未读取旧样本作为新题。

## 缺失字段（全部需要用户提供/确认）

| 字段 | 状态 |
|---|---|
| 题名 | 缺 |
| challenge ID | 缺 |
| target URL / IP:端口 | 已知入口 `http://hbc2.haobachang.com:18420/`，未确认题目 |
| allowed hosts | 缺 |
| deny hosts | 缺 |
| 题面本地路径 | 缺 |
| 附件本地路径和 SHA-256 | 缺 |
| AnswerSpec / flag 格式 | 缺 |
| 标准答案本地路径 | 缺（旧 ground-truth 不适用） |
| 重置方式 | **UNKNOWN** |
| 健康检查方式 | 缺 |
| 时限 | 缺 |
| 禁止动作 | 缺（至少：不自动提交/不批量/不开环境/不读 token） |
| 是否需要登录会话 | 缺 |
| 会话引用类型和引用名 | 缺（只允许环境变量名或临时文件路径） |

## 安全边界

- 收到会话凭据时只允许只读 GET；Cookie/token 值不得进入源码、日志、evidence 或终端输出。
- 在 intake 完整前不启动真实 agent、不消耗 token、不访问靶场、不做 benchmark。
- 需要用户提供完整字段后，才做 1 次 S1 校准；校准通过并获授权后才进入 S1/S2/S3 × 3。
