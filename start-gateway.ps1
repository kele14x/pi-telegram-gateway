# Starts the pi-telegram-gateway fully detached from this console, with a
# durable log. Re-runnable: stops any existing instance first.
# Usage: powershell -ExecutionPolicy Bypass -File start-gateway.ps1
#   -or-  ./start-gateway.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = [IO.Path]::GetFullPath((Join-Path $Root "index.ts"))
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Stop only the instance owned by this repository. stop.ps1 validates the
# absolute entry path and lock metadata before terminating a process tree.
& (Join-Path $Root "stop.ps1") | Out-Null
Start-Sleep -Seconds 1

$node = (Get-Command node).Source
& $node (Join-Path $Root "scripts\rotate-logs.mjs") --root $Root
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Log rotation failed; starting the gateway without rotating."
}
$proc = Start-Process -FilePath $node `
  -ArgumentList '--env-file-if-exists=.env', ('"{0}"' -f $Entry) `
  -WorkingDirectory $Root `
  -RedirectStandardOutput (Join-Path $LogDir "gateway.log") `
  -RedirectStandardError  (Join-Path $LogDir "gateway-err.log") `
  -WindowStyle Hidden -PassThru

$proc.Id | Set-Content (Join-Path $LogDir "gateway.pid")
Write-Host ("Started gateway, PID " + $proc.Id)
Write-Host ("Log: " + (Join-Path $LogDir "gateway.log"))
Start-Sleep -Seconds 6
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
  Write-Host "Gateway is running."
} else {
  Write-Host "Gateway exited early - check the log."
}
