# Web 应用层手法子库（靶场模式）

> **本子库是靶场语料，不是 SRC 语料。**原始素材收集自线上资产（SRC）语境，进入本技能后按下面三条改造后使用：
>
> 1. 「安全红线 / 最小伤害 / 禁批量 / 只证不 dump / 报告定级」类条款**一律不适用**，只取手法。
>    靶场里批量扫、爆破、dump、写数据、上传 webshell 都是正常比赛动作。
> 2. 凡提到 **FOFA / 互联网测绘 / 外部规则文件（`~/.grok/rules` 等）/ 旧技能名** 的地方**一律忽略**——
>    比赛是内网靶机，没有互联网测绘。
> 3. 本技能只认 `SKILL.md` 与 `知识库/` 目录；篇内出现的外部路径与规则名不做参考。
> 4. ★ **「不交 / 不写 / 禁开」这类措辞要按靶场语义重新翻译**——它们来自 SRC 的**评审视角**（"这条单独提报告不合格"），
>    不是"这条不用打"。对照表：
>
>    | 篇内原话 | 靶场里的真实含义 | 该怎么做 |
>    |---|---|---|
>    | "几乎不交 / 不交报告" | 打成**独立报告**不合格 | 靶场不要报告 ⇒ **照样打**；若这类题计分，它就是你的一分 |
>    | "缺头不写"（如点击劫持） | 单列成漏洞不够格 | 但**用来拿 flag / 串链**完全可用 |
>    | "禁开 / 勿当开场" | SRC 提交时别把它当主证据 | 靶场里**没有这个限制**，需要就用 |
>    | "低优先 / 基本不是计分路径" | 出题概率低 | **不是不可能**——出题人偏偏爱抄冷门；指纹对上就试 |
>
>    一句话：**靶场只问"能不能拿到 flag"，不问"能不能立案"。**凡看到上述措辞，按右列执行，不要被劝退。

## 使用约定

- 开局先看 `手法索引.md`；对得上再打开对应篇。**禁止每站通读本目录。**
- 手法索引不是上限：现场有什么打什么，表上没有的照样试。
- 组合/链式升级路径见 `escalation-handbook.md`；打不动时先回 `../破局模型.md`。
- **超过 300 行的篇已统一加「目录」**：先读目录定位，再定点读该节，不要线性通读（最长的篇 1200+ 行）。

## 出分主力（优先开）

| 篇 | 覆盖 |
|---|---|
| `injection-test.md` | 注入类（SQL / NoSQL 操作符 / ES / HQL / SpEL / SSTI 探测） |
| `file-upload-test.md` | 文件上传、对象存储、STS、分享鉴权 |
| `ssrf-test.md` | SSRF、云元数据、GOPROXY、对象存储回源 |
| `idor-test.md` | 越权（水平 / 垂直 / 租户 / 密文 id / 哨兵值） |
| `authbypass-test.md` | 认证绕过、会话票、发签口、SSO 壳后的账密口 |
| `deserialization-test.md` | 反序列化（Java / PHP / .NET 链） |
| `jndi-injection-test.md` | JNDI 注入与出网受限时的替代姿势 |
| `oauth-jwt-test.md` | OAuth / JWT / SAML / OIDC |
| `path-traversal-lfi-test.md` | 路径穿越 / 文件包含 / 日志包含 |
| `xss-test.md` | XSS（含 XSS → RCE、自定义协议链） |
| `logic-test.md` | 业务逻辑、支付/流程/券、状态机跳步 |
| `race-condition-test.md` | 竞态（兑换 / 限领 / 并发下单） |
| `info-leak-test.md` | 信息泄露（版本 / health / 无账密壳 / 指纹跟进） |
| `api-gateway-test.md` | API 网关 |
| `graphql-test.md` | GraphQL（introspection / 过度取数 / 批次） |
| `websocket-test.md` | WebSocket（握手 / 订阅越权 / 重放） |
| `http-smuggling-test.md` | 请求走私（前后端解析差异） |
| `waf-bypass.md` | WAF 绕过 |
| `js-reverse-guide.md` | JS 逆向（抽接口 / 盐 / 密文 id 公钥 / 隐藏路由） |
| `escalation-handbook.md` | 低危升高危链式升级路径字典 |

## 专项链

`cloud-ide-codex-rce-chain.md`（云 IDE / Codex 系：弱口令 → RPC RCE → 集群/API Key 链）、
`agent-tool-exec-test.md`（对话式工具真执行）、
`ghost-bits-cast-test.md`（隐形字符 / Ghost Bits）、
`el-injection-test.md`（表达式注入）、
`prototype-pollution-test.md`（原型污染 → 模板 RCE）、
`type-juggling-test.md`（PHP 类型杂耍）、
`cache-poisoning-test.md`（缓存投毒 / 欺骗）、
`http-host-header-test.md`（Host 头毒化 → 重置信）、
`insecure-scm-test.md`（不安全源码管理 / .git 泄露）、
`open-redirect-test.md`、`subdomain-takeover-test.md`、`xxe-test.md`、`csrf-test.md`、
`insecure-scm-test.md`、`dns-rebinding-test.md`、`crlf-injection-test.md`、
`hpp-test.md`、`http2-attacks-test.md`、`xslt-injection-test.md`、
`clickjacking-test.md`、`csp-bypass-test.md`、`csv-formula-injection-test.md`、
`dangling-markup-test.md`、`dependency-confusion-test.md`、`email-header-injection-test.md`、
`401-403-bypass.md`、`cors-test.md`、`llm-security-test.md`

> 后一段里体积很小的（<1KB）是**收成一行的指针篇**：它们原本只做"转到别的篇"的路由，**信息量在指针那头**。
> **靶场用法**：保留指针去向（去对应大篇），但**别把"低出分概率"当成"不用试"**——靶场看的是题目什么时候出现，不是它像不像一个能立案的漏洞。
> 其中 4 类在靶场**确实会考**，已在篇内补了靶场抬头与打法：`llm-security-test.md`（AI 应用题）、`cors-test.md`、`crlf-injection-test.md`、`401-403-bypass.md`。
> `recon-methodology.md` 是互联网测绘方法论，**靶场（内网）基本不适用**，只借用其中"参数怎么想 / 错误页 / 移动端 API 别漏"的思路。

**合计：49 个内容文件 + 本 README + `手法索引.md`。**
