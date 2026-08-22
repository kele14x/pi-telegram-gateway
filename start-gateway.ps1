# Starts the pi-telegram-gateway fully detached from this console, with a
# durable log. Re-runnable: stops any existing instance first.
# Usage: powershell -ExecutionPolicy Bypass -File start-gateway.ps1
#   -or-  ./start-gateway.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Stop any existing gateway instance (npm wrapper or node index.ts)
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*index.ts*' -or $_.CommandLine -like '*npm-cli*start*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$node = (Get-Command node).Source
$proc = Start-Process -FilePath $node `
  -ArgumentList '--env-file-if-exists=.env', 'index.ts' `
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