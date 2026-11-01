# CRLF 头注入（靶场照打）

> **靶场抬头（覆盖下方 SRC 口径）**：CRLF 在靶场有两类可得分形态：
>
> 1. **响应拆分 / 头注入**：参数值进入响应头（`Location`、`Set-Cookie`、自定义头）⇒ 注入 `%0d%0a` 追加头或整段响应体
>    ```
>    ?next=%0d%0aSet-Cookie:%20admin=1
>    ?next=%0d%0a%0d%0a<script>alert(1)</script>      # 拆分出响应体 → XSS
>    ```
>    **注意编码层次**：`%0d%0a` 可能先被 URL 解码一次，也可能是双重编码 `%250d%250a`，还可能要 `\r\n` 字面量 —— 三种都要试。
> 2. **请求头注入到后端**：参数被拼进后端请求头（如 `X-Forwarded-Host`、`Referer`）⇒ 影响上游解析（配合 Host 头毒化拿重置链接，见 `http-host-header-test.md`）
>
> **算成判据**：响应里出现你注入的头 / 拆出了第二段响应体 ⇒ 通。
>
> **假点**：`%0d%0a` 被过滤 ⇒ 试 `%0a`、`%0d`、`\u000d\u000a`、UTF-8 变长编码；只回显在 body 不在头 ⇒ 那就走 XSS 路子（`xss-test.md`）。

> **SRC 原始口径（仅对照）**：纯 CRLF 头注入默认不写。Host 毒重置走 `http-host-header-test.md`。Ghost Bits 邮件/走私用公式 `chr((k<<8)|T)`，见 `ghost-bits-cast-test.md`。
