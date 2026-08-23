# pi-telegram-gateway status: task, process, uptime, recent log, sessions.
# Usage: powershell -ExecutionPolicy Bypass -File status.ps1      (or: npm run status)

$ErrorActionPreference = "SilentlyContinue"
$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$lock   = Join-Path $Root "logs\gateway.lock"
$log    = Join-Path $Root "logs\gateway.log"
$sess   = Join-Path $Root "sessions"

Write-Host "== Scheduled task =="
schtasks /Query /TN "pi-telegram-gateway" /V /FO LIST |
  Select-String -Pattern "Status:|Last Run Time:|Last Result:" |
  ForEach-Object { "  " + $_.Line.Trim() }

Write-Host "== Gateway process =="
if (Test-Path $lock) {
  $rawLock = Get-Content -LiteralPath $lock -Raw
  try {
    $record = $rawLock | ConvertFrom-Json
    $gpid = [int]$record.pid
    $entry = [string]$record.entry
  } catch {
    # Backward-compatible display for the former PID-only lock format.
    $gpid = [int]$rawLock
    $entry = "(legacy lock metadata)"
  }
  $p = Get-Process -Id $gpid -ErrorAction SilentlyContinue
  if ($p) {
    $win = if ($p.MainWindowHandle -eq 0) { "hidden" } else { "VISIBLE" }
    Write-Host "  PID $gpid running ($($p.ProcessName)), started $($p.StartTime), window: $win"
    Write-Host "  entry: $entry"
  } else {
    Write-Host "  PID $gpid is NOT running (stale lock, will be reclaimed on next start)"
  }
} else {
  Write-Host "  no lock file - gateway not running"
}

Write-Host "== Recent log =="
if (Test-Path $log) {
  Get-Content $log -Tail 10 | ForEach-Object { "  " + $_ }
} else {
  Write-Host "  no log yet - start the gateway first"
}

Write-Host "== Sessions (per-chat history) =="
Get-ChildItem $sess -Filter *.jsonl -ErrorAction SilentlyContinue |
  ForEach-Object { "  $($_.Name)  $([math]::Round($_.Length / 1024, 1)) KB  last write $($_.LastWriteTime)" }
if (-not (Get-ChildItem $sess -Filter *.jsonl -ErrorAction SilentlyContinue)) {
  Write-Host "  none yet"
}
