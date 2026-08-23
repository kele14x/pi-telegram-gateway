# Offline tests for parsing and exact matching of a previously registered task.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $Root "remove-autostart.ps1") -LibraryOnly
. (Join-Path $Root "setup-autostart.ps1") -LibraryOnly

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

$oldRoot = "D:\Old Repo\pi-telegram-gateway"
$oldLauncher = Join-Path $oldRoot "gateway-hidden.vbs"
$fixture = [xml]@"
<?xml version="1.0"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions><Exec>
    <Command>C:\Windows\System32\wscript.exe</Command>
    <Arguments>&quot;$oldLauncher&quot;</Arguments>
    <WorkingDirectory>$oldRoot</WorkingDirectory>
  </Exec></Actions>
</Task>
"@

Assert ((Get-TaskLauncher $fixture) -eq $oldLauncher) "task launcher path was not recovered"

$fixture.Task.Actions.Exec.Arguments = '"D:\Elsewhere\other.vbs"'
Assert ((Get-TaskLauncher $fixture) -eq $null) "unrecognized launcher was accepted"

$entry = Join-Path $oldRoot "index.ts"
$pattern = Get-ExactPathPattern $entry
Assert (('node.exe "' + $entry + '"') -match $pattern) "exact entry path was not matched"
Assert (-not (('node.exe "' + $entry + '.backup"') -match $pattern)) "entry path matched a sibling filename"
Assert (Test-AbsoluteWindowsPath $oldLauncher) "absolute drive path was rejected"
Assert (-not (Test-AbsoluteWindowsPath "gateway-hidden.vbs")) "relative launcher path was accepted"

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("pi gateway autostart " + [guid]::NewGuid().ToString("N"))))
Assert ($tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) "temporary fixture escaped the system temp directory"
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  $testEntry = Join-Path $tempRoot "entry with spaces.ts"
  $testRotate = Join-Path $tempRoot "rotate with spaces.mjs"
  $testLog = Join-Path $tempRoot "gateway output.log"
  $testLauncher = Join-Path $tempRoot "gateway-hidden.vbs"
  Set-Content -LiteralPath $testEntry -Encoding ASCII -Value 'console.log("AUTOSTART_LAUNCH_OK");'
  Set-Content -LiteralPath $testRotate -Encoding ASCII -Value 'process.exit(0);'

  $launcher = New-GatewayLauncherContent -GatewayRoot $tempRoot -NodePath (Get-Command node).Source `
    -EntryPath $testEntry -RotateScriptPath $testRotate -GatewayLogPath $testLog `
    -CmdPath (Join-Path $env:SystemRoot "System32\cmd.exe")
  Set-Content -LiteralPath $testLauncher -Encoding ASCII -Value $launcher

  & (Join-Path $env:SystemRoot "System32\cscript.exe") '//NoLogo' $testLauncher
  Assert ($LASTEXITCODE -eq 0) "generated hidden launcher returned exit code $LASTEXITCODE"
  $testLogText = Get-Content -LiteralPath $testLog -Raw
  Assert ($testLogText -match '(?m)^AUTOSTART_LAUNCH_OK\r?$') "generated hidden launcher did not preserve its quoted paths"
} finally {
  if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}

Write-Host "Autostart task parsing and launcher tests passed."
