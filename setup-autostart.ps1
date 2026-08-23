# Registers a Windows Scheduled Task that keeps the pi-telegram-gateway alive:
#   - starts at user logon
#   - restarts the gateway 1 minute after a crash (Task Scheduler supervises it)
#
# Usage:  powershell -ExecutionPolicy Bypass -File setup-autostart.ps1
# Run it: schtasks /Run /TN "pi-telegram-gateway"
# Remove: schtasks /Delete /TN "pi-telegram-gateway" /F
# Re-run this script after moving the repo or changing the Node path.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# The task runs the gateway in the foreground (cmd >> log) so Task Scheduler
# sees a crash and can restart it. Full node path is pinned at setup time.
$node = (Get-Command node).Source
$cmd  = "$env:SystemRoot\System32\cmd.exe"
$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function XmlEscape([string]$s) {
  return $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;'
}

$user    = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$xmlCmd  = XmlEscape $cmd
$xmlNode = XmlEscape $node
$xmlArgs = XmlEscape ('/c "{0}" --env-file-if-exists=.env index.ts >> logs\gateway.log 2>&1' -f $node)
$xmlRoot = XmlEscape $Root

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pi-telegram-gateway chat bot (starts at logon, restarts on crash)</Description>
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

Write-Host "Scheduled task 'pi-telegram-gateway' registered:"
schtasks /Query /TN "pi-telegram-gateway" /V /FO LIST | Select-String -Pattern "TaskName|Status|Next Run|Last Run|Task To Run|Start In|Schedule Type" | ForEach-Object { $_.Line.Trim() }
Write-Host ""
Write-Host "Start it now with: schtasks /Run /TN `"pi-telegram-gateway`""
Write-Host "Remove it with:    schtasks /Delete /TN `"pi-telegram-gateway`" /F"