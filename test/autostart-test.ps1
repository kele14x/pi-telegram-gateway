# Offline tests for parsing and exact matching of a previously registered task.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $Root "remove-autostart.ps1") -LibraryOnly

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

Write-Host "Autostart task parsing tests passed."
