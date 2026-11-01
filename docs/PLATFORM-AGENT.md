# 比赛平台与多 Agent 解题工作台

## 启动

开发态：

```powershell
cd D:\agent\xuanwo
$env:NEST_PASS='<比赛平台密码>'
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox
```

正式启动后也可在界面点击“连接平台”，密码用 Electron `safeStorage` 加密保存。

## 数据流

1. 登录 `POST /api/mp/auth/login`，密码按 DES/ECB/PKCS7 加密后提交。
2. 同步比赛、方向题单和单题详情，展示分值、已解数、附件和靶机地址。
3. 点击开题后创建独立任务目录：
   `work/<task-id>/attachments/`、`reference/wp/`、`evidence/`。
4. 从 `D:\hzw\CTF` 检索同名/同方向 WP，只复制最相关的少量文件。
5. Codex / Claude / OpenCode / DeepSeek Harness 并发运行，共享黑板。
6. 题目列表支持服务端分页；平台只返回当前账号可访问的题，UI 会同时显示
   “平台标注 / 当前可见”数量，不伪造未解锁题。
7. 自动编队按全局配额把运行中的题目填到 3 道（12 个 Agent）；单题仍最多 4 个。
8. 每 30 秒对运行中题目的 HTTP/TCP 靶机做一次有界只读探测。502/断连持续
   4 分钟后冷却该题并切下一道，避免四个 Agent 一起空转。
9. 识别到标准 flag 候选后自动提交平台。平台明确拒绝时把候选标记为
   `false_positive` 并把拒绝原因回灌给全部活跃 Agent；网络/登录等临时失败
   只标记 `timeout` 并自动重试，不误判成错误 flag。

## 安全边界

- 平台 token 只保存在主进程内存，不进入渲染快照。
- 平台状态文件不保存明文密码。
- 附件下载、WP 复制和工作产物都在配置的任务目录内。
- 平台提交只走主进程 `platform.submitFlag`，渲染层拿不到 token；自动提交
  默认由 `config/platform.json` 的 `autoSubmit=true` 控制。

流程图：`docs/流程图-多Agent竞赛解题系统.html`
