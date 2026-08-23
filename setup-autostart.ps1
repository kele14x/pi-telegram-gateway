# Registers a Windows Scheduled Task that keeps the pi-telegram-gateway alive:
#   - starts at user logon
#   - restarts the gateway 1 minute after a crash (Task Scheduler supervises it)
#   - runs WITHOUT a visible console window (wscript hidden launcher)
#
# Usage:  powershell -ExecutionPolicy Bypass -File setup-autostart.ps1
# Run it: schtasks /Run /TN "pi-telegram-gateway"
# Stop:   schtasks /End /TN "pi-telegram-gateway"
# Remove: powershell -ExecutionPolicy Bypass -File remove-autostart.ps1
# Re-run this script after moving the repo or changing the Node path.

param(
  [switch]$LibraryOnly
)

$ErrorActionPreference = "Stop"

function New-GatewayLauncherContent {
  param(
    [Parameter(Mandatory = $true)][string]$GatewayRoot,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [Parameter(Mandatory = $true)][string]$RotateScriptPath,
    [Parameter(Mandatory = $true)][string]$GatewayLogPath,
    [Parameter(Mandatory = $true)][string]$CmdPath
  )

  $template = @'
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "{ROOT}"
rotateCode = sh.Run("{ROTATE}", 0, True)
code = sh.Run("{CMD}", 0, True)
WScript.Quit code
'@

  $rotateLine = '"{NODE}" "{ROTATE_SCRIPT}" --root "{ROOT}"'
  $rotateLine = $rotateLine.Replace("{NODE}", $NodePath).Replace("{ROTATE_SCRIPT}", $RotateScriptPath).Replace("{ROOT}", $GatewayRoot)
  $vbsRotate = $rotateLine.Replace('"', '""')

  # cmd.exe /s removes the outer quote pair after /c. The doubled opening
  # quote is therefore required to preserve the separately quoted Node path.
  $cmdLine = '"{CMD_EXE}" /d /s /c ""{NODE}" --env-file-if-exists=.env "{ENTRY}" >> "{LOG}" 2>&1"'
  $cmdLine = $cmdLine.Replace("{CMD_EXE}", $CmdPath).Replace("{NODE}", $NodePath).Replace("{ENTRY}", $EntryPath).Replace("{LOG}", $GatewayLogPath)
  $vbsCmd = $cmdLine.Replace('"', '""')

  return $template.Replace("{ROOT}", $GatewayRoot).Replace("{ROTATE}", $vbsRotate).Replace("{CMD}", $vbsCmd)
}

if ($LibraryOnly) { return }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = [IO.Path]::GetFullPath((Join-Path $Root "index.ts"))
$node = (Get-Command node).Source

# Idempotent refresh/migration: remove the prior task using the absolute paths
# recorded in its XML before generating and registering this repo's launcher.
& (Join-Path $Root "remove-autostart.ps1") -Quiet

$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── Generate the hidden launcher: wscript runs node with no console window,
#    waits for it, and passes the exit code through so Task Scheduler's
#    RestartOnFailure still sees crashes. ────────────────────────────────────
$vbsPath = Join-Path $Root "gateway-hidden.vbs"
$rotateScript = Join-Path $Root "scripts\rotate-logs.mjs"
$gatewayLog = Join-Path $logDir "gateway.log"
$cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
$vbs = New-GatewayLauncherContent -GatewayRoot $Root -NodePath $node -EntryPath $Entry `
  -RotateScriptPath $rotateScript -GatewayLogPath $gatewayLog -CmdPath $cmd
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
