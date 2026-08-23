# Stops only the pi-telegram-gateway instance owned by this repository.
# Usage: powershell -ExecutionPolicy Bypass -File stop.ps1     (or: npm run stop)

$ErrorActionPreference = "SilentlyContinue"
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$Entry = [IO.Path]::GetFullPath((Join-Path $Root "index.ts"))
$HiddenLauncher = [IO.Path]::GetFullPath((Join-Path $Root "gateway-hidden.vbs"))
$LockMetadata = [IO.Path]::GetFullPath((Join-Path $Root "logs\gateway.lock"))
$NativeLockDir = [IO.Path]::GetFullPath((Join-Path $Root "logs\gateway.instance.lock"))
$LogsRoot = [IO.Path]::GetFullPath((Join-Path $Root "logs")) + [IO.Path]::DirectorySeparatorChar
$EntryPattern = '(?i)(?:^|[\s"])' + [Regex]::Escape($Entry) + '(?=$|[\s"])'
$LauncherPattern = '(?i)(?:^|[\s"])' + [Regex]::Escape($HiddenLauncher) + '(?=$|[\s"])'

schtasks /End /TN "pi-telegram-gateway" | Out-Null

function Get-OwnedGatewayProcesses {
  $all = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(node|cmd|wscript)\.exe$' -and $_.CommandLine -and
      ($_.CommandLine -match $EntryPattern -or $_.CommandLine -match $LauncherPattern)
  })

  # A directly-started gateway may have been launched before absolute entry
  # paths were introduced. Its JSON lock record is acceptable only when both
  # repository identity and process start time still match (protects PID reuse).
  if (Test-Path -LiteralPath $LockMetadata) {
    try {
      $record = Get-Content -LiteralPath $LockMetadata -Raw | ConvertFrom-Json
      $recordEntry = [IO.Path]::GetFullPath([string]$record.entry)
      $recordStarted = [DateTimeOffset]::Parse([string]$record.startedAt)
      $candidate = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$record.pid)
      if ($candidate -and $candidate.Name -eq 'node.exe' -and $recordEntry -eq $Entry) {
        $candidateProcess = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
        $actualStarted = [DateTimeOffset]$candidateProcess.StartTime
        if ([Math]::Abs(($actualStarted - $recordStarted).TotalSeconds) -le 10) {
          $all += $candidate
        }
      }
    } catch {
      # Corrupt or legacy lock metadata is not authority to kill a process.
    }
  }
  return @($all | Sort-Object ProcessId -Unique)
}

$owned = @(Get-OwnedGatewayProcesses)
foreach ($process in $owned) {
  taskkill /PID $process.ProcessId /T /F 2>$null | Out-Null
}

Start-Sleep -Seconds 2
$left = @(Get-OwnedGatewayProcesses)
if ($left) {
  Write-Host "WARNING: this repository's gateway is still running:"
  $left | ForEach-Object { Write-Host ("  PID " + $_.ProcessId + " " + $_.Name) }
} else {
  # Only metadata for this exact repository can authorize lock cleanup. If its
  # owner PID is absent (or has been reused with a different start time), the
  # heartbeat directory is provably stale. Corrupt/legacy metadata is retained
  # for proper-lockfile's automatic stale recovery rather than guessed at.
  $canClearOwnedLock = $false
  if (Test-Path -LiteralPath $LockMetadata) {
    try {
      $record = Get-Content -LiteralPath $LockMetadata -Raw | ConvertFrom-Json
      $recordEntry = [IO.Path]::GetFullPath([string]$record.entry)
      $recordStarted = [DateTimeOffset]::Parse([string]$record.startedAt)
      if ($recordEntry -eq $Entry) {
        $candidate = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$record.pid)
        $canClearOwnedLock = -not $candidate
        if ($candidate) {
          $candidateProcess = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
          $actualStarted = [DateTimeOffset]$candidateProcess.StartTime
          $canClearOwnedLock = [Math]::Abs(($actualStarted - $recordStarted).TotalSeconds) -gt 10
        }
      }
    } catch {
      $canClearOwnedLock = $false
    }
  }
  if ($canClearOwnedLock) {
    # Targets are fixed, verified children of this repository's logs directory.
    if ($NativeLockDir.StartsWith($LogsRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $NativeLockDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($LockMetadata.StartsWith($LogsRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $LockMetadata -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host "Gateway stopped."
}
