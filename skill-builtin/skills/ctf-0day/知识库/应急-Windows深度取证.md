# 应急：Windows 主机深度取证

> 触发：应急题给的是 Windows 主机 / 事件日志 / 磁盘镜像，且要"时间线 + 攻击链"。
> 原技能只有事件 ID 与 Prefetch，本篇补齐**执行痕迹、文件系统时间线、注册表、日志被清的补证**。

---

## 一、事件日志：先背这张 ID 表

| 事件 ID | 含义 | 应急价值 |
|---|---|---|
| **4624** | 登录成功 | **Logon Type 是关键：2=本地交互、3=网络、10=RDP**。攻击者的入口时间 |
| **4625** | 登录失败 | 爆破证据（高频 + 同一源 IP） |
| **4634 / 4647** | 注销 | 会话时长 |
| **4672** | 授予特殊特权 | 特权登录（提权后动作的锚点） |
| **4720** | **新建账户** | 后门账户（必查） |
| **4722 / 4724 / 4726** | 启账户 / 重置密码 / 删账户 | 账户操作链 |
| **4732** | 加入管理员组 | 提权痕迹 |
| **7045** | **安装新服务** | 后门服务最常藏在这 |
| **1102** | **审计日志被清** | 攻击者反取证动作本身 |
| **4688** | 进程创建 | 需开审核策略；开了就是金矿 |
| **5140 / 5145** | 网络共享访问 | 横向取文件 |

> **4624 的反直觉点（真实样本实测）**：RDP **隧道**（RDP over something）或经端口转发进来的 RDP，
> 其 `IpAddress` 会是 **`127.0.0.1`**（回环）。**看到回环不要当噪声丢掉**——它往往是隧道/转发的特征，
> 这时要横向对照 `TerminalServices-RemoteConnectionManager/Operational` 的 **1149** 事件、以及
> `Microsoft-Windows-Security-Auditing` 的 5156（连接允许）才能还原真实源。
> 同理：`LogonType=3` + `ANONYMOUS LOGON` 来自内网 IP，通常是**横向移动**（PsExec/WMI 一类）的痕迹。

原生查询（无第三方工具时）：

```cmd
:: 看某事件最近 50 条
wevtutil qe Security /q:"*[System[(EventID=4624)]]" /f:text /c:50 /rd:true
:: 只看 RDP 成功（Type 10）
wevtutil qe Security /q:"*[System[(EventID=4624)] and EventData[Data[@Name='LogonType']='10']]" /f:text /c:30
:: 导出给工具分析
wevtutil epl Security C:\case\Security.evtx
```

批量解析推荐 **EvtxECmd**（Eric Zimmerman 套件）或 **LogParser**——能把几千条日志一键转 CSV 再排序成时间线。图形化看用 Event Log Explorer / Timeline Explorer。

---

## 二、执行痕迹：日志被清也能还原"跑过什么"

这是 Windows 取证里**最容易漏、也最出分**的一层。

| 痕迹 | 位置 | 能回答什么 |
|---|---|---|
| **Prefetch** | `C:\Windows\Prefetch\*.pf` | 某个 EXE **跑过几次、何时最后跑**（默认只留 1024 个）。看 `WHOAMI.EXE`、`MIMIKATZ.EXE`、`PSEXEC*.pf`、`RUNDLL32` |
| **Amcache** | `C:\Windows\AppCompat\Programs\Amcache.hve` | **执行过的程序路径 + SHA1**（比 Prefetch 更全，含已删文件） |
| **ShimCache / AppCompatCache** | 注册表 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\AppCompatCache` | 系统"见过"的程序路径（**可能看不出来跑了**） |
| **USN Journal** | `C:\$Extend\$UsnJrnl` | 文件的**增 / 删 / 改名**流水 |
| **$MFT** | `C:\$MFT` | 全盘文件时间戳（含已删除） |
| **SRUM** | `C:\Windows\System32\sru\SRUDB.dat` | 每进程的**网络流量与使用时长**（看外传量、C2 活跃度） |

配套工具（Zimmerman 套件，都是单文件）：`PECmd`（Prefetch）、`AmcacheParser`、`AppCompatCacheParser`、`MFTECmd`（$MFT + USN）、`SrumECmd`、`RECmd`（注册表）、`JLECmd` / `LECmd`（跳转列表 / LNK）、`MFTECmd` 出 CSV 后统一进 **Timeline Explorer** 排时间线。

> **判据**：Amcache 有路径 ≠ 跑过（它记录"见过"）；**Prefetch / USN / 事件日志三者交叉**才能证明执行。

---

## 三、文件系统时间线

```cmd
:: 全盘按修改时间取最早的异常文件
forfiles /P C:\ /S /M * /D -30 /C "cmd /c echo @fdate @ftime @path" 2>nul | findstr /i "temp users programdata"
:: 直接看目录
dir /a /s /tc C:\Users\Public 2>nul
```

$MFT 出 CSV 后用时间线工具按 `Created0x10 / LastModified0x10 / LastAccess0x10` 排序，找**攻击窗口内的新建 / 改名**——落地工具、写 webshell、删日志都能看到。

**注意**：攻击者能用 `timestomp` 改时间戳。若发现"所有时间一致"或"修改时间早于创建时间"，本身就是强异常信号。

---

## 四、注册表：持久化与凭据

```
HKLM\Software\Microsoft\Windows\CurrentVersion\Run       自启
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
HKLM\SYSTEM\CurrentControlSet\Services\                   服务（后门服务）
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon  Shell / Userinit 劫持
HKLM\...\Image File Execution Options\                     IFEO 劫持（粘滞键后门）
HKLM\...\Windows\Installer\AlwaysInstallElevated           MSI 提权
HKLM\SAM\SAM\Domains\Account\Users\Names                   隐藏账户
HKCU\Software\Microsoft\Terminal Server Client\Servers     RDP 连过谁
HKLM\...\WMI\...\CommandLineEventConsumer                  **WMI 持久化**（最隐蔽，常被漏）
HKLM\SAM\SAM\Domains\Account\Users\Names\                  **隐藏账户**（`$` 结尾的键名）
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\RecentDocs   最近文档
```

### 隐藏账户：只有日志时怎么发现（真实样本实测）

比赛给的多半是**日志**而不是活体机器，"读注册表"这条路走不通。**日志侧的证据是 Sysmon 事件 13**：

```xml
Event ID 13 (RegistryValueSet)
  RuleName     = Hidden Local Account Created
  TargetObject = HKLM\SAM\SAM\Domains\Account\Users\Names\hideme0007$\(Default)
  Image        = C:\Windows\system32\lsass.exe
```

读法：**`TargetObject` 里 `Users\Names\<账户名>$` 就是隐藏账户名**（上例 = `hideme0007$`）。
条数少但极准——这是 Sysmon 配置里专门针对 SAM 键的规则，一旦出现基本可定罪。

**三条路径并存，按拿到的检材选**：

| 手里有 | 走哪条 |
|---|---|
| 活体机器 | `net user` 看不全（`$` 户默认隐藏）→ **`wmic useraccount get name,sid`** 或直接读 `HKLM\SAM\...\Users\Names` |
| Sysmon 日志 | **事件 13 + `TargetObject` 含 `Users\Names\`**（上例），看 `RuleName` |
| Security 日志 | 4720（建号）——但**攻击者常借 lsass 直接写 SAM 绕过 4720**，所以 4720 缺失不代表没建号 |

> **答题卡问"隐藏账户的密码"时**：先按上表定位账户名 → 再提 hash（`reg save hklm\sam` +
> `hklm\system`，或内存镜像 `hashdump`）→ **hashcat/john 破出明文**（题面要明文，交 hash 不算分）。

凭据类：`HKLM\...\Winlogon\DefaultPassword`（明文装机密码）、`sysprep\unattend.xml`、`Panther` 目录、IIS `applicationHost.config` 连接串、浏览器 `Login Data`、`cmdkey /list`。

---

## 五、日志被清后的补证链

事件日志 1102 被清 / `.evtx` 缺失时，按这个顺序补：

1. **Prefetch** → 跑过什么（工具名本身就是证据）
2. **USN journal** → 文件增删改名时间
3. **$MFT** → 全盘时间戳（含删掉的）
4. **Amcache / ShimCache** → 执行与"见过"的路径
5. **SRUM** → 网络行为与进程活跃期
6. **Web 日志 / 数据库日志** → 常与系统日志分开存放，**攻击者常只清一半**
7. **`.evtx` 残留**：`C:\Windows\System32\winevt\Logs\` 下被删的日志可能有 `.evtx.old` 或卷影副本

---

## 六、答题卡要素（Windows 题通用）

```
初始入口：      （4624 Type 10 的 RDP / 漏洞利用 / 钓鱼 —— 要 IP + 时间）
攻击者 IP：
首次登录时间：  （注明时区）
提权方式：      （4732 / 4672 / 新服务 / 内核 EXP）
落地工具：      （Prefetch / Amcache 出的 EXE 名 + 时间）
持久化清单：    （账户 / 服务 / 计划任务 / Run 键 / WMI 订阅）
横向目标：      （5140 / SMB 连接 / RDP 记录里的其它主机）
痕迹清除：      （1102 日志清空 / vssadmin 删卷影 / 工具自带清理）
```

---

## 七、PowerShell 与无文件攻击（4104 是金子）

真实赛题（Solar杯）把"无文件攻击"列为独立考点。攻击者不落地 exe，全靠 PowerShell / WMI / 反射加载，此时**文件系统上什么都没留**，但 PowerShell 日志会留下执行的脚本原文。

**关键事件 ID**

| ID | 日志 | 内容 |
|---|---|---|
| **4104** | `Microsoft-Windows-PowerShell/Operational` | **Script Block Logging：还原执行过的脚本原文**（金矿，编码后的 payload 也能解出） |
| 4103 | 同上 | 模块/管道执行记录 |
| 400 / 600 | 同上 | 引擎启动（能看出起过 PowerShell） |
| 4688 | Security | 进程创建，**含命令行**（需开审核策略） |
| 4697 / 7045 | Security / System | 服务安装（常配合无文件落地） |

**取日志（原生）**

```powershell
# 拉全部脚本块记录
Get-WinEvent -LogName 'Microsoft-Windows-PowerShell/Operational' |
  Where-Object Id -eq 4104 | Format-List TimeCreated, Message
```

```cmd
wevtutil qe Microsoft-Windows-PowerShell/Operational /q:"*[System[(EventID=4104)]]" /f:text /c:50 /rd:true
```

**看什么**

- `-EncodedCommand` 后面一长串 base64 → `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('...'))` 解出原文
- `IEX` / `Invoke-Expression` / `DownloadString` / `FromBase64String` / `Reflection.Assembly` → 典型的无文件加载
- `-nop -w hidden -c` 这类参数组合出现即高危
- 下载地址（C2 / 工具分发服务器）常直接写在脚本里

**没开 4104 怎么办**

1. 4688 的命令行（若开了审核）
2. Prefetch 里有 `POWERSHELL.EXE-x86.pf` / `POWERSHELL_ISE.EXE-*.pf` = 跑过
3. Amcache 里 PowerShell 的路径记录
4. 内存镜像里 `windows.cmdline` 能抓到**当前还活着的** PowerShell 命令行（见 `内存取证.md`）

> **答题卡常见问法**：攻击者执行过的命令 / 下载地址 / 恶意脚本内容。答案基本都能从 4104 原文里直接抄。

---

## 假点

- 只跑 `wevtutil` 看几条 → **几千条日志必须导 CSV 排时间线**，人眼看不过来
- Amcache 有路径就判"执行过" → 要 Prefetch / USN 交叉
- 只查 4624/4625 → **4720（建号）、7045（服务）、1102（清日志）**才是后门与反取证的关键
- 忽略 WMI 订阅 → 无文件持久化，`CommandLineEventConsumer` 是经典藏点
- 时间没统一时区 → 日志 UTC、其他地方本地时间，差 8 小时会让整条时间线错位
