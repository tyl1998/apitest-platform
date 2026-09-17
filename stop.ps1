#Requires -Version 5.1
<#
快速停止（Windows PowerShell 版，与仓库根的 ./stop.sh 同一套语义）。

用法:
  .\stop.ps1               # 停全部
  .\stop.ps1 api worker    # 只停指定服务（api | worker | scheduler | web）

若提示脚本被禁止运行：powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
或直接双击同目录的 stop.cmd。

与 bash 版的差异（Windows 没有 POSIX 信号）:
  - 停止用 taskkill /T（整棵进程树：cmd → pnpm → tsx → node），不留孤儿；
  - 先按 pidfile 杀，再按命令行模式兜底清理手动起过的活口；
  - Postgres/Redis 由外部常驻，本脚本不碰（要停：docker compose -f apitest-server\compose.yaml down）。
#>
param(
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Services = @()
)

# taskkill / Get-CimInstance 在进程已消失时会报错，统一静默处理，最后自己汇总。
$ErrorActionPreference = "SilentlyContinue"

$Root = $PSScriptRoot
$PidFile = Join-Path $Root ".dev-pids"
$AllServices = @("api", "worker", "scheduler", "web")

# 服务名 → 兜底清理的命令行模式（与 bash 版逐字一致；Windows 路径反斜杠在匹配前
# 会归一成正斜杠，所以模式里统一写正斜杠）。
$PatternOf = @{
  api       = "watch src/index.ts"
  worker    = "watch src/worker.ts"
  scheduler = "watch src/scheduler.ts"
  web       = "--port 5173"
}

$Full = $false
if ($Services.Count -eq 0) {
  $Full = $true
  $Services = $AllServices
}
foreach ($s in $Services) {
  if ($AllServices -notcontains $s) {
    Write-Host "未知服务: $s（api | worker | scheduler | web）" -ForegroundColor Red
    exit 1
  }
}

# 从最深的孩子往上杀：cmd → pnpm → tsx → node 是树，只杀父会留下孤儿。
function Kill-Tree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
}

$Killed = New-Object System.Collections.Generic.List[string]

# ── 1) pidfile 里的活口 ─────────────────────────────────────────────────────
if (Test-Path $PidFile) {
  foreach ($line in (Get-Content $PidFile)) {
    if ($line -notmatch "=") { continue }
    $parts = $line -split "=", 2
    $name = $parts[0].Trim()
    $processId = $parts[1].Trim()
    if ($Services -notcontains $name) { continue }
    if ($processId -notmatch '^\d+$') { continue }
    if (-not (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue)) { continue }
    Write-Host "[stop] $name (pid $processId)"
    Kill-Tree ([int]$processId)
    $Killed.Add($name)
  }
  if ($Full) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "[stop] 已清理 pid 记录"
  } else {
    # 部分停止：其余记录保留，已杀的移除
    $kept = Get-Content $PidFile | Where-Object {
      $n = ($_ -split "=", 2)[0].Trim()
      $Killed -notcontains $n
    }
    if ($kept) { Set-Content -Path $PidFile -Value $kept -Encoding ASCII } else { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
  }
} else {
  Write-Host "[stop] 无 pid 记录, 走残留清理"
}

# ── 2) 兜底：pidfile 之外可能还有活口（如进程被手动重启过）──────────────────
function Cleanup-Pattern([string]$Pattern, [string]$Label) {
  $normalized = $Pattern.ToLowerInvariant()
  $hits = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Replace("\", "/").Contains($normalized) }
  if (-not $hits) { return }
  $pids = @($hits | ForEach-Object { $_.ProcessId })
  Write-Host "[stop] 清理残留 $Label (pid $($pids -join ' '))"
  foreach ($processId in $pids) { Kill-Tree ([int]$processId) }
}

foreach ($name in $Services) {
  switch ($name) {
    "api"       { Cleanup-Pattern $PatternOf.api "API" }
    "worker"    { Cleanup-Pattern $PatternOf.worker "worker" }
    "scheduler" { Cleanup-Pattern $PatternOf.scheduler "调度器" }
    "web"       { Cleanup-Pattern $PatternOf.web "前端" }
  }
}

Write-Host "[stop] 已停止: $($Services -join ' ') (Postgres/Redis 保持运行)"
