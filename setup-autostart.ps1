# Registers a Windows Scheduled Task that keeps the pi-telegram-gateway alive:
#   - starts at user logon
#   - restarts the gateway 1 minute after a crash (Task Scheduler supervises it)
#   - runs WITHOUT a visible console window (wscript hidden launcher)
#
# Usage:  powershell -ExecutionPolicy Bypass -File setup-autostart.ps1
# Run it: schtasks /Run /TN "pi-telegram-gateway"
# Stop:   schtasks /End /TN "pi-telegram-gateway"
# Remove: schtasks /Delete /TN "pi-telegram-gateway" /F
# Re-run this script after moving the repo or changing the Node path.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── Generate the hidden launcher: wscript runs node with no console window,
#    waits for it, and passes the exit code through so Task Scheduler's
#    RestartOnFailure still sees crashes. ────────────────────────────────────
$vbsPath = Join-Path $Root "gateway-hidden.vbs"
# Run with window style 0 = hidden (CREATE_NO_WINDOW) and wait for exit,
# returning the exit code so Task Scheduler still sees crashes.
$vbs = @'
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "{ROOT}"
code = sh.Run("{CMD}", 0, True)
WScript.Quit code
'@
# Build the command line, then double every quote so it embeds cleanly in VBS.
$cmdLine = 'cmd /c "{NODE}" --env-file-if-exists=.env index.ts >> logs\gateway.log 2>&1'
$cmdLine = $cmdLine.Replace("{NODE}", $node)
$vbsCmd = $cmdLine.Replace('"', '""')
$vbs = $vbs.Replace("{ROOT}", $Root).Replace("{CMD}", $vbsCmd)
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

# ── Register the scheduled task ─────────────────────────────────────────────
function XmlEscape([string]$s) {
  return $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;'
}

$user    = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$xmlCmd  = XmlEscape "$env:SystemRoot\System32\wscript.exe"
$xmlArgs = XmlEscape ('"{0}"' -f $vbsPath)
$xmlRoot = XmlEscape $Root

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pi-telegram-gateway chat bot (logon start, crash-restart, hidden window)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$xmlCmd</Command>
      <Arguments>$xmlArgs</Arguments>
      <WorkingDirectory>$xmlRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = Join-Path $env:TEMP "pi-gateway-task.xml"
$xml | Set-Content -Path $tmp -Encoding Unicode   # schtasks expects UTF-16 XML
schtasks /Create /F /TN "pi-telegram-gateway" /XML $tmp /RU $user | Out-Null
Remove-Item $tmp -Force

Write-Host "Scheduled task 'pi-telegram-gateway' registered (hidden window)."
schtasks /Query /TN "pi-telegram-gateway" /V /FO LIST | Select-String -Pattern "TaskName|Status|Task To Run|Start In" | ForEach-Object { $_.Line.Trim() }
Write-Host ""
Write-Host "Start it now with: schtasks /Run /TN `"pi-telegram-gateway`""