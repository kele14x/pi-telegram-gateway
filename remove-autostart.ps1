# Removes the pi-telegram-gateway Scheduled Task and its generated launcher.
# The task XML is read first so cleanup still targets the old absolute path
# after this repository has been moved or copied.
#
# This script never removes .env, sessions, logs, or conversation history.
# Usage: powershell -ExecutionPolicy Bypass -File remove-autostart.ps1

param(
  [switch]$LibraryOnly,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$TaskName = "pi-telegram-gateway"
$CurrentRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$CurrentLauncher = [IO.Path]::GetFullPath((Join-Path $CurrentRoot "gateway-hidden.vbs"))

function Test-AbsoluteWindowsPath([string]$path) {
  if (-not $path) { return $false }
  return $path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

function Get-TaskLauncher([xml]$taskXml) {
  $ns = [System.Xml.XmlNamespaceManager]::new($taskXml.NameTable)
  $ns.AddNamespace("task", $taskXml.DocumentElement.NamespaceURI)
  $argumentsNode = $taskXml.SelectSingleNode("//task:Actions/task:Exec/task:Arguments", $ns)
  $workingNode = $taskXml.SelectSingleNode("//task:Actions/task:Exec/task:WorkingDirectory", $ns)
  if (-not $argumentsNode) { return $null }

  $arguments = $argumentsNode.InnerText.Trim()
  $candidate = $null
  if ($arguments -match '^"(?<path>[^"]+)"$') {
    $candidate = $Matches.path
  } elseif ($arguments -notmatch '\s') {
    $candidate = $arguments
  }
  if (-not $candidate) { return $null }

  if (-not (Test-AbsoluteWindowsPath $candidate)) {
    if (-not $workingNode -or -not (Test-AbsoluteWindowsPath $workingNode.InnerText)) { return $null }
    $candidate = Join-Path $workingNode.InnerText $candidate
  }
  $launcher = [IO.Path]::GetFullPath($candidate)
  if ([IO.Path]::GetFileName($launcher) -ine "gateway-hidden.vbs") { return $null }

  if ($workingNode -and (Test-AbsoluteWindowsPath $workingNode.InnerText)) {
    $workingRoot = [IO.Path]::GetFullPath($workingNode.InnerText).TrimEnd('\', '/')
    $launcherRoot = [IO.Path]::GetFullPath((Split-Path -Parent $launcher)).TrimEnd('\', '/')
    if ($workingRoot -ine $launcherRoot) { return $null }
  }
  return $launcher
}

function Get-ExactPathPattern([string]$path) {
  return '(?i)(?:^|[\s"])' + [Regex]::Escape($path) + '(?=$|[\s"])'
}

function Get-OwnedGatewayProcesses([string]$root, [string]$launcher) {
  $entry = [IO.Path]::GetFullPath((Join-Path $root "index.ts"))
  $entryPattern = Get-ExactPathPattern $entry
  $launcherPattern = Get-ExactPathPattern $launcher
  $allProcesses = @(Get-CimInstance Win32_Process)
  $owned = @($allProcesses | Where-Object {
    $_.Name -match '^(node|cmd|wscript)\.exe$' -and $_.CommandLine -and
      ($_.CommandLine -match $entryPattern -or $_.CommandLine -match $launcherPattern)
  })

  # A pre-absolute-path direct launch can still be identified from the
  # ownership-aware JSON lock, with start-time validation protecting PID reuse.
  $metadata = [IO.Path]::GetFullPath((Join-Path $root "logs\gateway.lock"))
  if (Test-Path -LiteralPath $metadata) {
    $rawMetadata = Get-Content -LiteralPath $metadata -Raw
    try {
      $record = $rawMetadata | ConvertFrom-Json
      $recordEntry = [IO.Path]::GetFullPath([string]$record.entry)
      $recordStarted = [DateTimeOffset]::Parse([string]$record.startedAt)
      $candidate = $allProcesses | Where-Object { $_.ProcessId -eq [int]$record.pid } | Select-Object -First 1
      if ($candidate -and $candidate.Name -eq 'node.exe' -and $recordEntry -eq $entry) {
        $candidateProcess = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
        $actualStarted = [DateTimeOffset]$candidateProcess.StartTime
        if ([Math]::Abs(($actualStarted - $recordStarted).TotalSeconds) -le 10) {
          $owned += $candidate
        }
      }
    } catch {
      # Legacy releases stored only a PID. Accept it only when process name,
      # relative entry argument, and start time all match the old lock file.
      $legacyPid = 0
      if ([int]::TryParse($rawMetadata.Trim(), [ref]$legacyPid)) {
        try {
          $candidate = $allProcesses | Where-Object { $_.ProcessId -eq $legacyPid } | Select-Object -First 1
          $relativeEntryPattern = '(?i)(?:^|[\s"])index\.ts(?=$|[\s"])'
          if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine -match $relativeEntryPattern) {
            $candidateProcess = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
            $lockWritten = [DateTimeOffset](Get-Item -LiteralPath $metadata).LastWriteTime
            $actualStarted = [DateTimeOffset]$candidateProcess.StartTime
            if ([Math]::Abs(($actualStarted - $lockWritten).TotalSeconds) -le 10) {
              $owned += $candidate
            }
          }
        } catch {
          # An unverifiable legacy PID is never authority to terminate.
        }
      }
    }
  }
  return @($owned | Sort-Object ProcessId -Unique)
}

function Clear-OwnedStaleLock([string]$root) {
  $logsRoot = [IO.Path]::GetFullPath((Join-Path $root "logs")) + [IO.Path]::DirectorySeparatorChar
  $metadata = [IO.Path]::GetFullPath((Join-Path $root "logs\gateway.lock"))
  $nativeLock = [IO.Path]::GetFullPath((Join-Path $root "logs\gateway.instance.lock"))
  $entry = [IO.Path]::GetFullPath((Join-Path $root "index.ts"))
  if (-not (Test-Path -LiteralPath $metadata)) { return }

  try {
    $rawMetadata = Get-Content -LiteralPath $metadata -Raw
    try {
      $record = $rawMetadata | ConvertFrom-Json
      if (-not ($record.PSObject.Properties.Name -contains "entry")) { throw "legacy lock metadata" }
    } catch {
      $legacyPid = 0
      if ([int]::TryParse($rawMetadata.Trim(), [ref]$legacyPid) -and
          -not (Get-Process -Id $legacyPid -ErrorAction SilentlyContinue)) {
        if ($metadata.StartsWith($logsRoot, [StringComparison]::OrdinalIgnoreCase)) {
          Remove-Item -LiteralPath $metadata -Force -ErrorAction SilentlyContinue
        }
      }
      return
    }
    if ([IO.Path]::GetFullPath([string]$record.entry) -ne $entry) { return }
    $candidate = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($candidate) {
      $recordStarted = [DateTimeOffset]::Parse([string]$record.startedAt)
      $actualStarted = [DateTimeOffset]$candidate.StartTime
      if ([Math]::Abs(($actualStarted - $recordStarted).TotalSeconds) -le 10) { return }
    }
    if ($nativeLock.StartsWith($logsRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $nativeLock -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($metadata.StartsWith($logsRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $metadata -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # Let proper-lockfile reclaim unknown/corrupt state by age; do not guess.
  }
}

if ($LibraryOnly) { return }

$taskRegistered = $false
$taskLauncher = $null
try {
  $xmlText = (& schtasks /Query /TN $TaskName /XML 2>$null | Out-String)
  if ($LASTEXITCODE -eq 0 -and $xmlText.Trim()) {
    $taskRegistered = $true
  }
} catch {
  $taskRegistered = $false
}
if ($taskRegistered) {
  try {
    $taskLauncher = Get-TaskLauncher ([xml]$xmlText)
  } catch {
    $taskLauncher = $null
  }
}

if ($taskRegistered) {
  $taskRoot = if ($taskLauncher) { [IO.Path]::GetFullPath((Split-Path -Parent $taskLauncher)) } else { $null }
} else {
  # Idempotent recovery: if a previous removal deleted the task before process
  # cleanup completed, still stop only this repository's exactly-matched tree.
  $taskLauncher = $CurrentLauncher
  $taskRoot = $CurrentRoot
}
$ownedBefore = @()
$inspectionFailed = $false
if ($taskRoot) {
  try {
    $ownedBefore = @(Get-OwnedGatewayProcesses $taskRoot $taskLauncher)
  } catch {
    $inspectionFailed = $true
    Write-Warning "Could not inspect the existing gateway process tree: $($_.Exception.Message)"
  }
}

if ($taskRegistered -and -not $taskLauncher) {
  throw "Scheduled Task '$TaskName' has an unrecognized action; refusing unverified process cleanup."
}
if ($inspectionFailed) {
  throw "Could not verify the existing gateway process tree; the Scheduled Task was not changed."
}

if ($taskRegistered) {
  # Disable first so Task Scheduler cannot race cleanup with RestartOnFailure.
  & schtasks /Change /TN $TaskName /Disable 2>$null | Out-Null
  # Deleting a task does not terminate its running action. Delete first, then
  # taskkill the launcher PID captured above so /T still sees the whole tree.
  & schtasks /Delete /TN $TaskName /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to delete Scheduled Task '$TaskName'." }
}

foreach ($process in $ownedBefore) {
  # The task deletion may already have ended a captured launcher. Treat an
  # already-gone PID as success, and suppress taskkill's native stderr race.
  if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
    try {
      $previousErrorAction = $ErrorActionPreference
      $ErrorActionPreference = "SilentlyContinue"
      & taskkill /PID $process.ProcessId /T /F 2>$null | Out-Null
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
  }
}

$remaining = @()
if ($taskRoot) {
  Start-Sleep -Seconds 2
  try {
    $remaining = @(Get-OwnedGatewayProcesses $taskRoot $taskLauncher)
  } catch {
    $inspectionFailed = $true
    Write-Warning "Could not verify gateway process cleanup: $($_.Exception.Message)"
  }
}

if ($inspectionFailed) {
  throw "The Scheduled Task was removed, but process cleanup could not be verified."
}

if ($remaining) {
  Write-Warning "The Scheduled Task was removed, but a verified gateway process is still running:"
  $remaining | ForEach-Object { Write-Warning ("PID " + $_.ProcessId + " " + $_.Name) }
  throw "Autostart process cleanup is incomplete."
}

if ($taskRoot) { Clear-OwnedStaleLock $taskRoot }

# gateway-hidden.vbs is generated by setup-autostart.ps1. Remove the launcher
# recorded in the old task and the one beside this cleanup script, if present.
$launchers = @($taskLauncher, $CurrentLauncher) | Where-Object { $_ } | Sort-Object -Unique
foreach ($launcher in $launchers) {
  if ([IO.Path]::GetFileName($launcher) -ieq "gateway-hidden.vbs") {
    Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
  }
}

if (-not $Quiet) {
  if ($taskRegistered) {
    Write-Host "Scheduled Task '$TaskName' and its generated launcher were removed."
  } else {
    Write-Host "Scheduled Task '$TaskName' was not registered; generated launcher cleanup is complete."
  }
  Write-Host "Configuration, sessions, and log files were left untouched."
}
$global:LASTEXITCODE = 0
