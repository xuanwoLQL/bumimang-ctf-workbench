# 开源方案调研与取舍

调研日期：2026-10-31。下面项目只用于架构比较，没有复制未经兼容的源码。

| 项目 | 许可证 | 借鉴点 | 本项目取舍 |
|---|---|---|---|
| `verialabs/ctf-agent` | MIT | 平台轮询、按题 swarm、多模型竞速、跨 solver 消息、首解收敛 | 保留多 Agent 竞争与黑板共享；不引入 Docker，直接复用本机工具和本机 Agent |
| `NYU-LLM-CTF/nyuctf_agents` | MIT | D-CIPHER 的 planner / executor / auto-prompter 分工 | 映射为 lead / verify / recon / scribe 四角色 |
| `aielte-research/HackSynth` | AGPL-3.0 | Planner + Summarizer 的反馈回路 | 只借鉴反馈闭环，不引用其代码 |
| `MuWinds/BUUCTF_Agent` | Apache-2.0 | 平台适配层、checkpoint、输入/提交抽象 | 保留轻量平台适配思路；不引入其停维护的运行框架 |
| `aliasrobotics/cai` | Apache-2.0 | Agent 与安全工具解耦、事件流 | 工具仍由本机 Agent 直接调用，不重复封装数百个工具 |

最终采用的最小架构：

1. 主进程负责平台凭据、DES 登录、题目同步、附件下载和显式提交。
2. 渲染进程只拿脱敏后的平台视图，不接触 token。
3. 每个题目物化为独立任务目录，WP 只复制命中的少量文件。
4. Codex / Claude / OpenCode / DeepSeek Harness 通过各自已安装的 ACP 接口并发运行。
5. 共享黑板承担事实、死路、意图和租约；首个有效 flag 候选触发收敛。
6. 平台提交统一走主进程适配器；识别到有效候选后自动提交，平台拒绝则把结构化
   纠错回灌给 Agent，临时网络失败保留候选并重试。

参考链接：

- <https://github.com/verialabs/ctf-agent>
- <https://github.com/NYU-LLM-CTF/nyuctf_agents>
- <https://github.com/aielte-research/HackSynth>
- <https://github.com/MuWinds/BUUCTF_Agent>
- <https://github.com/aliasrobotics/cai>
