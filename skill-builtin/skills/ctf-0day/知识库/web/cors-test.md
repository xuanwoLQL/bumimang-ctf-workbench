# CORS（靶场照打 · 带凭据读接口） 

> **靶场抬头（覆盖下方 SRC 口径）**：靶场里 CORS 常以**"带凭据跨域读接口"**的形式出题（读到 `/api/me`、`/admin/*` 就算成）。
> 判据与打法：
>
> ```http
> Origin: https://evil.example            # 换成任意域 / 后缀域 / null
> Cookie: <受害者会话>                     # 必须带上凭据，否则不构成越权读
> ```
>
> - **命中条件**：响应回 `Access-Control-Allow-Origin: <你的域>` **且** `Access-Control-Allow-Credentials: true`（反射 Origin + ACAC 才是真洞；`*` 与 ACAC 不能共存）
> - **绕过变体**（白名单只校验前缀 / 后缀时）：`https://evil.<目标域>`、`https://<目标域>.evil.com`、`http://` 换 `https://`、`null`（沙箱 iframe / `data:` 页面）、大小写与端口变体、`Origin` 双写
> - **靶场里拿 flag 的路径**：CORS 本身不直接给 flag —— 用它**读到一个有权限的接口**，再由那个接口拿数据 / 换 token / 触发下一个洞（**串链思维**，见 `escalation-handbook.md`）
> - **假点**：只有 ACAO 没有 ACAC ⇒ 浏览器不带 Cookie ⇒ 不算越权读；预检（OPTIONS）被拦 ⇒ 试"简单请求"（GET / `text/plain` / 无自定义头）

> **SRC 原始口径（仅对照，靶场不适用）**：CORS 在靶场基本不是计分路径，属低优先。看到 ACAO/ACAC → 转注入 / SSRF / XSS / RCE / 越权 / 未授权业务读。
