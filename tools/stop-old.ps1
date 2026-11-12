# Used by start.bat (closes an achat that is still running, so start.bat always
# just works) and by stop.bat with -StopOnly (stops achat completely, so the
# folder can be moved or deleted). It only ever closes achat's own programs;
# any other program on the port is left alone and reported.

param([switch]$StopOnly)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFile = Join-Path $root 'data\achat.pid'
$port = 7788
$found = $false
try {
  $cfg = Get-Content -Raw (Join-Path $root 'data\config.json') | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
} catch {
  # first run: no settings yet
}

# a start.bat window together with everything it started (its countdown timer
# would otherwise keep running and keep the folder in use)
function Stop-Tree($id) {
  & taskkill.exe /PID $id /T /F 2>$null | Out-Null
}

function Stop-Achat($proc) {
  if (-not $proc) { return }
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $script:found = $true
  # also close the old black window it was running in
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
  if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -match 'start\.bat') {
    Stop-Tree $parent.ProcessId
  }
}

# 1. the achat that start.bat launched (its id is saved in data\achat.pid)
if (Test-Path $pidFile) {
  $savedId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($savedId -match '^\d+$') {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$savedId" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server[\/]index\.js') { Stop-Achat $p }
  }
}

# 2. whatever achat is answering on the port (an older one, or one started another way)
$ids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $ids) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  if ($p.Name -eq 'node.exe' -and $p.CommandLine -match 'server[\/]index\.js') {
    Stop-Achat $p
  } else {
    Write-Host "  achat can't start: port $port is used by another program ($($p.Name))."
    Write-Host '  Close that program, or change "port" in data\config.json.'
    exit 1
  }
}

if ($StopOnly) {
  # 3. a start.bat window from this folder that is still counting down
  $me = $PID
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains("$root\start.bat") -and $_.ProcessId -ne $me } |
    ForEach-Object { Stop-Tree $_.ProcessId }

  # wait until the port is really free, so the folder is released
  for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 250
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  if ($found) { Write-Host '  achat stopped. You can move or delete the achat folder now.' }
  else { Write-Host '  achat was not running. If Windows still says the folder is in use, close any File Explorer window or program that has the achat folder open.' }
  exit 0
}

if ($found) {
  Write-Host '  Closed the achat that was already running. Starting the latest version...'
  Start-Sleep -Milliseconds 700
}
exit 0
