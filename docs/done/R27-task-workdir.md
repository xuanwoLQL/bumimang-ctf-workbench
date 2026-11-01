# R27 · A1 任务级工作目录（Codex 评审最后一条）

**日期**：2026-10-20 17:41 · **范围**：`packages/shared-protocol/events.ts`、`src/main/{session/manager,hub/hub,mcp-host/bridge,electron/main}.ts`、`src/renderer/main.ts`、`src/cli/{fake-agent,verify-r18}.ts`

## 做了什么

Codex 评审 A1：所有任务的会话共用同一个 work 根，跨任务脚本/产物/witness 互相可见甚至覆盖。修法（**与 R16 的既有收益对齐**）：

- **任务专属目录 `<workRoot>/<taskId>`**：同任务多会话共享（R16 收益 3「队友写的脚本别的会话能直接看到」保留），跨任务隔离（A1 修复）。`SessionManager.startSession` 惰性 mkdir + 该任务目录作为：agent cwd、`AcpClient` 的越界检查根（fs/write、terminal/create）、MCP env `BUMIMANG_WORKDIR`、简报「工作目录」段落。
- **契约**：`TaskView.workDir?: string | null`——快照每个任务带自己的目录；`snapshot.workDir` 仍指根（向后兼容）。渲染层任务卡显示任务专属目录，缺席退回根。
- **证据回放**：`bridge.inferEvidence` 的 E2 根改为任务专属目录（agent cwd 就是它，相对 witness 才能解析对）。
- **示例任务种子**：`target/index.html` 种进任务目录（简报里的相对路径才成立），启动接回的旧任务也确保目录存在。
- **验收**：fake-agent 新增 `FAKE_ECHO_PROMPT`（回显收到的第一条 prompt 文本 + `BUMIMANG_WORKDIR` 环境变量）；verify-r18 新 part I（+10 断言）：A/B 两个任务的会话分别拿到各自专属目录、简报正文含该目录、快照 task.workDir 一致、两目录互不相同；electron `--verify` 新增「快照任务带任务专属工作目录」断言（19→20）。

## 改了哪些文件

- 契约：`events.ts`（TaskView.workDir）
- 主进程：`manager.ts`（taskWork + 4 处使用点）、`hub.ts`（视图填充）、`bridge.ts`（inferEvidence 按任务）、`electron/main.ts`（种子 + verify 探测）
- 渲染层：`renderer/main.ts`（任务卡显示）
- 测试：`fake-agent.ts`（FAKE_ECHO_PROMPT）、`verify-r18.ts`（part I，129→139）

## 怎么验证的

```powershell
npm run verify:r18       # 139/139（+10：I 节任务专属目录全链）
npm run verify:all       # 52+16+17+19+90+139 = 333 + smoke，exit=0
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
                         # 20/20（+1 任务专属目录断言）
# 渲染层 11 个 electron 套件 + smoke 全量重扫：全 ALL_PASS
# 打包态（17:41 重打包）：win-unpacked --verify 20/20；绿色包证据 20/20；asar 10/10
```

真实输出（I 节节选）：
```
PASS  BUMIMANG_WORKDIR 是任务 A 专属目录  — D:\...\r18\i\work\task-6d3dfe0b
PASS  简报正文含任务 A 专属目录
PASS  快照 task.workDir 是任务 A 专属目录
PASS  A/B 两个任务目录互不相同  — …task-6d3dfe0b vs …task-9062b6e4
```

## 没做什么 / 已知问题

- **不是 OS 级 jail**：agent 仍能用绝对路径读其它任务目录——这跟 R16 时期一样的既有边界（UI 文案已降级）。任务目录解决的是「无意的互相覆盖/污染」，恶意逃逸要等 Job Object/沙箱那轮。
- **旧 work/ 下的存量文件没迁移**：已有任务的历史产物还在旧根下，新会话从空的任务目录开始。旧文件不会丢，只是不在新目录里（可人工搬）。
- **`.probe/packaged-flow.mjs`（Lane B 的真实 agent 探针）断言产物落在 `%APPDATA%\bumimang\workspace\`**——现在会落在 `workspace\work\<taskId>\` 下。该探针本轮未跑（烧 token），下轮跑打包态真实流程时需更新其路径断言。
- **A2 的租约全局主键另一半仍没动**（跨任务互斥的语义选择），与 R23 文档记录一致。

## 下一手需要什么

无阻塞项。Codex 评审的 5 条建议（A2 holder ✓ / P2 收敛 ✓ / A7 安全 ✓ / A3+A4+A6 ✓ / A1 任务目录 ✓）全部落地。剩余候选：A2 复合键语义、OS 级沙箱（Job Object）、真实 A/B 复测（要烧 token，等用户点头）、NSIS 安装流程（B-4，需干净机器）。
