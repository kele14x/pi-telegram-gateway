# Stops the pi-telegram-gateway cleanly.
# schtasks /End alone leaks the cmd->node tree, so also kill any survivor by
# pid (tree, force) and drop the stale single-instance lock.
# Usage: powershell -ExecutionPolicy Bypass -File stop.ps1     (or: npm run stop)

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

schtasks /End /TN "pi-telegram-gateway" | Out-Null

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(node|cmd|wscript)\.exe$' -and $_.CommandLine -match 'index\.ts|gateway-hidden' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }

Remove-Item (Join-Path $Root "logs\gateway.lock") -Force -ErrorAction SilentlyContinue

Start-Sleep -Milliseconds 500
$left = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(node|cmd|wscript)\.exe$' -and $_.CommandLine -match 'index\.ts|gateway-hidden' }
if ($left) {
  Write-Host "WARNING: still running:"
  $left | ForEach-Object { Write-Host ("  PID " + $_.ProcessId + " " + $_.Name) }
} else {
  Write-Host "Gateway stopped."
}