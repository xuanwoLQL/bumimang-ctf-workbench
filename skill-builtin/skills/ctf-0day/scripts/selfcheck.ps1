# ctf-0day 开赛自检 —— 开赛第一件事跑这个，10 分钟内补齐缺失项。
# 用法:  pwsh -File selfcheck.ps1
$ErrorActionPreference = 'SilentlyContinue'

function W([string]$name, [bool]$ok, [string]$where, [string]$fix, [switch]$Manual) {
    # Manual：离线/图形工具，无法脚本探测。只提示，不计入"缺失"——否则每次跑都报红，真缺项会被无视。
    if ($Manual) { Write-Host ("  [人工] {0,-22} {1}" -f $name, $fix) }
    elseif ($ok) { Write-Host ("  [OK]   {0,-22} {1}" -f $name, $where) }
    else         { Write-Host ("  [MISS] {0,-22} {1}" -f $name, $fix) }
    return [pscustomobject]@{ Name = $name; Ok = $ok; Where = $where; Fix = $fix; Manual = [bool]$Manual }
}

$all = @()

Write-Host "`n=== 1. Windows 侧工具 ===" -ForegroundColor Cyan
$spec = @(
    @{ n = 'nmap';      p = 'nmap';                            f = '装 nmap 并加入 PATH' }
    @{ n = 'ffuf';      p = 'C:\tools\bin\ffuf.exe';           f = '放 C:\tools\bin 或加入 PATH' }
    @{ n = 'gobuster';  p = 'C:\tools\bin\gobuster.exe';       f = '放 C:\tools\bin' }
    @{ n = 'fscan';     p = 'C:\tools\bin\fscan.exe';          f = '下载单文件放 C:\tools\bin（gh-proxy 镜像）' }
    @{ n = 'nuclei';    p = 'nuclei';                          f = '装 nuclei 并加入 PATH' }
    @{ n = 'jq';        p = 'C:\tools\bin\jq.exe';             f = '放 C:\tools\bin' }
    @{ n = 'subfinder'; p = 'C:\tools\bin\subfinder.exe';      f = '放 C:\tools\bin' }
    @{ n = 'jadx';      p = 'C:\tools\jadx\bin\jadx.bat';      f = '解压 jadx 到 C:\tools\jadx' }
    @{ n = 'jdk17';     p = 'C:\tools\jdk17\bin\java.exe';     f = '解压 jdk17 到 C:\tools\jdk17' }
    @{ n = 'python';    p = 'python';                          f = 'AutoClaw 自带 python（无 pip）' }
    @{ n = 'wireshark'; p = 'C:\Program Files\Wireshark\Wireshark.exe'; f = '装 Wireshark（图形抓包）' }
)
foreach ($s in $spec) {
    $hit = $null
    if (Test-Path -LiteralPath $s.p) { $hit = $s.p }
    else { $c = Get-Command $s.p -ErrorAction SilentlyContinue; if ($c) { $hit = $c.Source } }
    $all += W $s.n ([bool]$hit) ($(if ($hit) { $hit } else { '' })) $s.f
}

Write-Host "`n=== 2. 字典 ===" -ForegroundColor Cyan
$dict = @(
    @{ n = 'SecLists 密码'; p = 'C:\tools\SecLists\Passwords\Common-Credentials\Pwdb_top-1000.txt' }
    @{ n = 'SecLists 用户名'; p = 'C:\tools\SecLists\Usernames\cirt-default-usernames.txt' }
    @{ n = 'wordlists 目录扫描'; p = 'C:\tools\wordlists\common.txt' }
    @{ n = '官方字典 Password'; p = 'C:\tools\dict\Password.txt' }
    @{ n = '官方字典 中文名'; p = 'C:\tools\dict\chinaname.txt' }
    @{ n = '官方字典 手机号'; p = 'C:\tools\dict\common_phones.txt' }
)
foreach ($d in $dict) {
    $fix = '从 SecLists 仓库拉对应文件'
    if ($d.n -like '官方字典*') {
        # 好靶场官方字典（登录爆破先交叉这三份，命中率高于通用字典）
        $fix = 'raw.githubusercontent.com/haobachang-1/haobachangBlog/main/dict/ 拉取；断连走 cdn.jsdelivr.net/gh/...'
    }
    $all += W $d.n (Test-Path -LiteralPath $d.p) $d.p $fix
}

# 字典编码自检：带 BOM 的字典会让第一个词变成 '\ufeffadmin'，静默登不上（实测坑）
foreach ($d in @('C:\tools\dict\Password.txt', 'C:\tools\SecLists\Passwords\Common-Credentials\Pwdb_top-1000.txt')) {
    if (Test-Path -LiteralPath $d) {
        $bytes = [System.IO.File]::ReadAllBytes($d)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            Write-Host ("  [WARN] {0,-22} 带 UTF-8 BOM ⇒ 读取必须用 utf-8-sig（否则第一个词永远登不上）" -f (Split-Path $d -Leaf)) -ForegroundColor Yellow
        }
    }
}

Write-Host "`n=== 3. WSL ghost（EXP 编译 / 爆破 / 取证全在这）===" -ForegroundColor Cyan
# 多行脚本必须走 stdin 管道，否则引号会被转义层吞掉（实测坑）
$scriptLines = @(
    'for t in gcc make nc socat nmap sqlmap python3 hydra hashcat tshark vol; do'
    '  p=$(command -v $t 2>/dev/null)'
    '  if [ -n "$p" ]; then echo "OK $t $p"; else echo "MISS $t"; fi'
    'done'
)
$wslScript = ($scriptLines -join "`n") + "`n"
# 落地成 LF 文件再让 WSL 从 /mnt/c 执行 —— 唯一稳的方式。
# 不能用 `$bytes | wsl.exe`：PS 5.1 把 byte[] 传原生命令时逐元素转十进制字符串，
# bash 收到的是 "102 111 114 32..."（实测 2026-10-09 复现），整段自检假报 MISS。
$wslTmp = Join-Path $env:TEMP 'ctf0day_wslcheck.sh'
[IO.File]::WriteAllText($wslTmp, $wslScript, (New-Object Text.UTF8Encoding($false)))
# C:\Users\x\Temp\a.sh -> /mnt/c/Users/x/Temp/a.sh
$wslPath = $wslTmp -replace '\\', '/'
if ($wslPath -match '^([A-Za-z]):') { $wslPath = '/mnt/' + $Matches[1].ToLower() + $wslPath.Substring(2) }
$wslOut = wsl.exe -d ghost -- bash $wslPath 2>&1 | Out-String
# wsl.exe 在 PowerShell 里回来的是 UTF-16 字节流，含 NUL——匹配前必须剥掉
$wslOut = $wslOut -replace "`0", ''
Remove-Item -LiteralPath $wslTmp -Force -ErrorAction SilentlyContinue
if ($wslOut -notmatch 'OK ') {
    Write-Host "  [MISS] WSL ghost 无法启动或无工具" -ForegroundColor Red
    $all += [pscustomobject]@{ Name = 'WSL ghost'; Ok = $false; Where = ''; Fix = 'wsl -d ghost 确认能进；缺工具在 ghost 内 apt/pip 装' }
} else {
    foreach ($line in ($wslOut -split "`r?`n")) {
        $line = $line.Trim()
        if ($line -match '^OK\s+(\S+)\s+(\S+)') { $all += W $Matches[1] $true $Matches[2] '' }
        elseif ($line -match '^MISS\s+(\S+)') { $all += W $Matches[1] $false '' 'ghost 内 apt install / pip install' }
    }
}

Write-Host "`n=== 4. 应急线自备（U 盘 / 本地）===" -ForegroundColor Cyan
$ir = @(
    @{ n = 'arthas-boot.jar'; p = 'C:\tools\arthas-boot.jar' }
    @{ n = 'impacket 示例脚本'; p = 'C:\tools\impacket-src\examples' }
)
foreach ($i in $ir) {
    $all += W $i.n (Test-Path -LiteralPath $i.p) $i.p '开赛前自备（见 SKILL.md §八）'
}
foreach ($n in @('D盾 / 河马', '蓝队研判工具箱', 'LinuxCheck')) {
    $all += W $n $false '' '图形/离线工具，需人工确认（U 盘）' -Manual
}

Write-Host "`n=== 5. 自带武器 ===" -ForegroundColor Cyan
$weapons = Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Name -ne 'selfcheck.ps1' }
if ($weapons) { $weapons | ForEach-Object { Write-Host ("  [OK]   {0}" -f $_.Name) } }
else { Write-Host "  [--]   暂无额外武器脚本" }

Write-Host "`n=== 6. Des-CTF 外源库 ===" -ForegroundColor Cyan
$skillRoot = Split-Path -Parent $PSScriptRoot
$desRoot = Join-Path $skillRoot '外部参考\Des-CTF'
$wpIndex = Join-Path $desRoot 'wp-index.jsonl'
$scriptIndex = Join-Path $desRoot 'script-index.jsonl'
$wpDir = Join-Path $desRoot 'WP'
$deepDir = Join-Path $desRoot 'deep'
$wpTotal = if (Test-Path -LiteralPath $wpIndex) { @(Get-Content -LiteralPath $wpIndex -Encoding UTF8).Count } else { 0 }
$scriptTotal = if (Test-Path -LiteralPath $scriptIndex) { @(Get-Content -LiteralPath $scriptIndex -Encoding UTF8).Count } else { 0 }
$wpFiles = if (Test-Path -LiteralPath $wpDir) { @(Get-ChildItem -LiteralPath $wpDir -File -Filter '*.md').Count } else { 0 }
$deepFiles = if (Test-Path -LiteralPath $deepDir) { @(Get-ChildItem -LiteralPath $deepDir -File).Count } else { 0 }
$desFix = '运行 scripts\des_ctf_sync.py 从固定快照重建外源库'
$all += W 'Des-CTF 外源目录' (Test-Path -LiteralPath $desRoot) $desRoot $desFix
$all += W 'WP 全量索引' ($wpTotal -eq 1027) "$wpTotal/1027 条" $desFix
$all += W 'WP 精选正文' ($wpFiles -eq 142) "$wpFiles/142 篇" $desFix
$all += W '经典深文' ($deepFiles -eq 23) "$deepFiles/23 份" $desFix
$all += W '脚本目录索引' ($scriptTotal -eq 110) "$scriptTotal/110 条" $desFix

Write-Host "`n=== 汇总 ===" -ForegroundColor Cyan
$miss = @($all | Where-Object { -not $_.Ok -and -not $_.Manual })
$manual = @($all | Where-Object { $_.Manual })
Write-Host ("  通过 {0} / 缺失 {1} / 需人工确认 {2}" -f ($all.Count - $miss.Count - $manual.Count), $miss.Count, $manual.Count)
if ($miss.Count) {
    Write-Host "`n  需处理：" -ForegroundColor Yellow
    $miss | ForEach-Object { Write-Host ("   - {0}：{1}" -f $_.Name, $_.Fix) }
}
Write-Host "`n提示：WSL 多行脚本一律落地成 LF 文件再 `wsl -d ghost -- bash /mnt/c/...`；不要用 wsl -- bash -c `"多行`"，也不要用 byte[] 管道（PS 5.1 会转成十进制字符串）。`n" -ForegroundColor DarkGray
