#Requires -Version 5.1
<#
快速启动/重启（Windows PowerShell 版，与仓库根的 ./start.sh 同一套语义）。

用法:
  .\start.ps1                        # 启动全部（已在运行的跳过）
  .\start.ps1 -Restart               # 重启全部
  .\start.ps1 -Restart api worker    # 只重启指定服务（api | worker | scheduler | web）
  .\start.ps1 -SkipMigrate           # 跳过迁移（迁移不变时更快）

若提示「无法加载文件，因为在此系统上禁止运行脚本」，二选一：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
  或直接双击同目录的 start.cmd（包装脚本自带 ExecutionPolicy Bypass）。

与 bash 版的差异（Windows 没有 POSIX 信号 / nohup / lsof）:
  - 后台进程用 Start-Process 拉起（独立隐藏窗口，关掉终端不死）；
  - pidfile 里记的是每个服务 cmd 包装进程的 PID，停止时用 taskkill /T 整棵树杀；
  - 每个服务的 stdout/stderr 合并进 .dev-logs/<name>.log（运行时还会生成
    .dev-logs/<name>.run.cmd 包装文件，可随时删，下次启动重建）。
#>
param(
  [switch]$Restart,
  [switch]$SkipMigrate,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Services = @()
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$Server = Join-Path $Root "apitest-server"
$Web = Join-Path $Root "apitest-web"
$LogDir = Join-Path $Root ".dev-logs"
$PidFile = Join-Path $Root ".dev-pids"
$AllServices = @("api", "worker", "scheduler", "web")

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ── 参数（与 bash 同款：-Restart 后跟服务名；不跟服务名 = 全部）───────────────
if ($Services.Count -gt 0 -and -not $Restart) {
  Write-Host "未知参数: $($Services -join ' ')（支持 -Restart [服务名...] / -SkipMigrate）" -ForegroundColor Red
  exit 1
}
if ($Restart) {
  foreach ($s in $Services) {
    if ($AllServices -notcontains $s) {
      Write-Host "未知服务: $s（api | worker | scheduler | web）" -ForegroundColor Red
      exit 1
    }
  }
  if ($Services.Count -gt 0) {
    Write-Host "[restart] 重启: $($Services -join ' ')"
    & (Join-Path $Root "stop.ps1") @Services
  } else {
    Write-Host "[restart] 重启全部服务"
    & (Join-Path $Root "stop.ps1")
  }
}

# ── 企业内部 CA（*.***.net 之类内网 https 域名）──────────────────────────────
# Node 不读 Windows 证书存储里的企业根证书，没有这份 PEM 时 fetch 会报
# SELF_SIGNED_CERT_IN_CHAIN。文件存在才注入，不存在则保持原生行为（公共 CA 站点
# 不受影响）。把企业 CA 导出的 PEM 放到 .dev-certs/***-ca.pem 即可（CA 证书是公开
# 材料不是密钥，可以直接进部署包）。
$CaBundle = Join-Path $Root ".dev-certs/***-ca.pem"
if (Test-Path $CaBundle) {
  $env:NODE_EXTRA_CA_CERTS = $CaBundle
  Write-Host "[env] NODE_EXTRA_CA_CERTS=$CaBundle"
}

# ── .env（DB / Redis / 产物存储 / 助手默认上游等）────────────────────────────
# 进程代码只读 process.env，加载文件这一层归启动脚本。文件存在才注入，且不覆盖
# 已存在的变量（本机临时 override 优先）。
$EnvFile = Join-Path $Server ".env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1)
    if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { return }
    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
  Write-Host "[env] 已加载 $EnvFile"
}

# Postgres/Redis 由外部常驻（OrbStack / 手动起的 docker），脚本不再负责。
# 需要脚本代管时，取消下面两行注释：
# Write-Host "[1/3] Postgres + Redis (docker compose)"
# docker compose -f "$Server/compose.yaml" up -d --wait

# ── 迁移 ────────────────────────────────────────────────────────────────────
if (-not $SkipMigrate) {
  Write-Host "[1/3] 数据库迁移"
  Push-Location $Server
  try {
    & pnpm.cmd migrate
    if ($LASTEXITCODE -ne 0) { throw "pnpm migrate 失败 (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
} else {
  Write-Host "[1/3] 跳过迁移"
}

# ── pidfile 读写 ────────────────────────────────────────────────────────────
function Get-PidFor([string]$Name) {
  if (-not (Test-Path $PidFile)) { return $null }
  $hit = Get-Content $PidFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $hit) { return $null }
  return ($hit -split "=", 2)[1].Trim()
}

# 记录在 pidfile 里且进程还活着，才算「已在运行」。
function Test-ServiceUp([string]$Name) {
  $processId = Get-PidFor $Name
  if (-not $processId) { return $false }
  return [bool](Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue)
}

function Remove-PidLine([string]$Name) {
  if (-not (Test-Path $PidFile)) { return }
  $kept = Get-Content $PidFile | Where-Object { $_ -notmatch "^$([regex]::Escape($Name))=" }
  if ($kept) { Set-Content -Path $PidFile -Value $kept -Encoding ASCII } else { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
}

# 后台起一个服务：写一个运行期 .cmd 包装（避免 PowerShell 版本间 -ArgumentList 的
# 引号差异），Start-Process 起它，stdout/stderr 合并进 <name>.log，PID 落 pidfile。
function Start-ServiceProcess([string]$Name, [string]$WorkDir, [string]$CommandLine) {
  $log = Join-Path $LogDir "$Name.log"
  $wrapper = Join-Path $LogDir "$Name.run.cmd"
  $content = "@echo off`r`ncd /d `"$WorkDir`"`r`n$CommandLine > `"$log`" 2>&1`r`n"
  Set-Content -Path $wrapper -Value $content -Encoding ASCII
  $proc = Start-Process -FilePath $wrapper -WindowStyle Hidden -PassThru
  Add-Content -Path $PidFile -Value "$Name=$($proc.Id)" -Encoding ASCII
}

function Start-One([string]$Name, [string]$WorkDir, [string]$CommandLine) {
  if (Test-ServiceUp $Name) {
    Write-Host "[2/3] $Name 已在运行, 跳过"
    return
  }
  Write-Host "[2/3] 启动 $Name"
  Remove-PidLine $Name   # 替换同名旧记录，避免 pidfile 无限增长
  Start-ServiceProcess $Name $WorkDir $CommandLine
}

Write-Host "[2/3] 应用进程"
Start-One api       $Server "pnpm.cmd dev"
# worker 只服务 default 分区（本机所在网段）；别的网段要在那台机器上另起 worker。
$env:WORKER_LABELS = "default"
Start-One worker    $Server "pnpm.cmd worker"
Remove-Item Env:WORKER_LABELS -ErrorAction SilentlyContinue
# 调度器（P3-4）：第三个进程。cron 认领 / 漏跑判定 / 告警派发都在它里面；多实例安全
# 但推荐单实例。改后端调度逻辑后 .\start.ps1 -Restart scheduler 即可单独回收它。
Start-One scheduler $Server "pnpm.cmd scheduler"
Start-One web       $Web "pnpm.cmd dev -- --host 0.0.0.0 --port 5173"

# 执行分区（P2-8）与 Runner（P4.5）**本脚本不自动拉起**：前者要在目标网段的机器上，
# 后者通常部署在另一台机器（只出站 HTTPS 到本平台）。Runner 见 apitest-runner\start.ps1。

# ── 等待就绪 ────────────────────────────────────────────────────────────────
function Test-TcpPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect("127.0.0.1", $Port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-Port([string]$Name, [int]$Port, [string]$Log) {
  for ($waited = 0; $waited -lt 60; $waited++) {
    if (Test-TcpPort $Port) {
      Write-Host "[3/3] $Name 就绪 (http://localhost:$Port)"
      return $true
    }
    Start-Sleep -Seconds 1
  }
  Write-Host "[3/3] $Name 启动超时, 日志: $Log" -ForegroundColor Yellow
  return $false
}

Write-Host "[3/3] 等待就绪"
Wait-Port "API" 3000 (Join-Path $LogDir "api.log") | Out-Null
Wait-Port "前端" 5173 (Join-Path $LogDir "web.log") | Out-Null

# worker 不监听端口，用日志确认
Start-Sleep -Seconds 1
if (Select-String -Path (Join-Path $LogDir "worker.log") -Pattern "consuming" -Quiet -ErrorAction SilentlyContinue) {
  Write-Host "[3/3] worker 就绪"
} else {
  Write-Host "[3/3] worker 可能未就绪, 日志: $(Join-Path $LogDir 'worker.log')" -ForegroundColor Yellow
}
# 调度器同样只看日志：启动行会打出 tick 与宽限期参数
if (Select-String -Path (Join-Path $LogDir "scheduler.log") -Pattern "ticking every" -Quiet -ErrorAction SilentlyContinue) {
  Write-Host "[3/3] 调度器就绪"
} else {
  Write-Host "[3/3] 调度器可能未就绪, 日志: $(Join-Path $LogDir 'scheduler.log')" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "全部启动完成"
Write-Host "  前端   http://localhost:5173"
Write-Host "  后端   http://localhost:3000"
Write-Host "  日志   $LogDir"
Write-Host "  停止   .\stop.ps1"
