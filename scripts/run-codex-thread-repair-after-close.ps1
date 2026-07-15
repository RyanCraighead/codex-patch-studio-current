param(
  [string]$ThreadId = "",
  [string]$Workspace = "",
  [string]$Title = "",
  [string]$CodexHome = "$env:USERPROFILE\.codex",
  [string]$JobPath = "",
  [string]$LogPath = "",
  [int]$TimeoutMinutes = 30,
  [switch]$StopCodex,
  [switch]$NoRestartApp
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "codex-launcher.ps1")
$LogDir = Join-Path $RepoRoot "codex-repair-results"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $LogPath) {
  $LogPath = Join-Path $LogDir "thread-index-repair-$Stamp.log"
}

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line
}

function Get-CodexAppProcess {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessName -in @("ChatGPT", "Codex")
    }
}

function Get-CodexVisibleWindowProcess {
  Get-CodexAppProcess |
    Where-Object {
      $_.MainWindowHandle -ne 0
    }
}

function Get-CodexWorkerProcess {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessName -eq "codex" -and
      ($_.Path -like "*\OpenAI\Codex\bin\*" -or $_.Path -like "*\WindowsApps\OpenAI.Codex_*" -or (Test-CodexConfiguredProcessPath $_.Path))
    }
}

function Write-ProcessSnapshot {
  param([string]$Label)
  Write-Log "PROCESS SNAPSHOT BEGIN: $Label"
  $processes = @((Get-CodexAppProcess) + (Get-CodexWorkerProcess)) |
    Where-Object { $_ -and $_.Id } |
    Sort-Object Id -Unique
  if ($processes.Count -eq 0) {
    Write-Log "  no Codex/Codex worker processes found"
  }
  foreach ($process in $processes) {
    Write-Log "  process name=$($process.ProcessName) pid=$($process.Id) window=$($process.MainWindowHandle) path=$($process.Path)"
  }
  Write-Log "PROCESS SNAPSHOT END: $Label"
}

function Invoke-ThreadDiagnostics {
  param(
    [string]$Label,
    [object]$Item,
    [switch]$AppServer
  )

  $itemThreadId = [string]$Item.threadId
  if (-not $itemThreadId) {
    Write-Log "DIAGNOSTICS SKIPPED: $Label missing threadId"
    return
  }

  $diagnosticScript = Join-Path $RepoRoot "scripts\diagnose-codex-thread.cjs"
  $diagnosticArgs = @(
    "--no-warnings",
    $diagnosticScript,
    "--codex-home", $CodexHome,
    "--thread-id", $itemThreadId,
    "--compact",
    "--json"
  )
  if ($Item.workspace) {
    $diagnosticArgs += @("--workspace", [string]$Item.workspace)
  }
  if ($AppServer) {
    $diagnosticArgs += @("--app-server")
  }

  Write-Log "DIAGNOSTICS BEGIN: $Label thread=$itemThreadId appServer=$($AppServer.IsPresent)"
  Write-Log "node $($diagnosticArgs -join ' ')"
  $diagnosticOutput = & node @diagnosticArgs 2>&1
  $diagnosticExitCode = $LASTEXITCODE
  foreach ($line in $diagnosticOutput) {
    Write-Log "DIAGNOSTICS OUT: $line"
  }
  Write-Log "DIAGNOSTICS END: $Label exit=$diagnosticExitCode"
}

function Start-CodexApp {
  $launchCodexHome = if ($env:CODEX_PATCHED_HOME) {
    $env:CODEX_PATCHED_HOME
  } else {
    Join-Path $env:USERPROFILE ".codex-patch-studio-current"
  }
  $sharedSqliteHome = if ($env:CODEX_PATCHED_SQLITE_HOME) {
    $env:CODEX_PATCHED_SQLITE_HOME
  } else {
    $CodexHome
  }
  & (Join-Path $PSScriptRoot "initialize-patched-codex-home.ps1") `
    -SourceCodexHome $CodexHome `
    -PatchedCodexHome $launchCodexHome `
    -SharedSqliteHome $sharedSqliteHome | Out-Null
  & (Join-Path $PSScriptRoot "start-codex-provider-proxies.ps1")
  Start-CodexAppFromLauncher -CodexHome $launchCodexHome -CodexSqliteHome $sharedSqliteHome
}

try {
  Write-Log "Waiting for visible Codex desktop window to close."
  Write-Log "ThreadId=$ThreadId Workspace=$Workspace Title=$Title JobPath=$JobPath"
  Write-Log "RepoRoot=$RepoRoot CodexHome=$CodexHome Pid=$PID User=$env:USERNAME Computer=$env:COMPUTERNAME"
  Write-ProcessSnapshot "script-start"

  $items = @()
  if ($JobPath) {
    Write-Log "JOB JSON BEGIN: $JobPath"
    (Get-Content -LiteralPath $JobPath -Raw) -split "\r?\n" | ForEach-Object {
      if ($_) {
        Write-Log "  $_"
      }
    }
    Write-Log "JOB JSON END: $JobPath"
    $job = Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json
    if ($job.codexHome) {
      $CodexHome = [string]$job.codexHome
      Write-Log "CodexHome overridden by job: $CodexHome"
    }
    if ($job.items) {
      $items = @($job.items)
    } elseif ($job.threadId) {
      $items = @($job)
    }
  } elseif ($ThreadId) {
    $items = @([pscustomobject]@{
      threadId = $ThreadId
      workspace = $Workspace
      title = $Title
    })
  } else {
    throw "Provide either -JobPath or -ThreadId."
  }

  if ($items.Count -eq 0) {
    throw "Repair job has no items."
  }
  Write-Log "Repair item count: $($items.Count)"
  foreach ($item in $items) {
    Invoke-ThreadDiagnostics "before-stop" $item
  }

  if ($StopCodex) {
    Write-Log "StopCodex was set. Stopping Codex desktop and worker processes."
    $processes = @((Get-CodexAppProcess) + (Get-CodexWorkerProcess)) |
      Where-Object { $_ -and $_.Id } |
      Sort-Object Id -Unique
    foreach ($process in $processes) {
      Write-Log "Stopping $($process.ProcessName) pid $($process.Id)."
      try {
        Stop-Process -Id $process.Id -Force
      } catch {
        Write-Log "Could not stop pid $($process.Id): $($_.Exception.Message)"
      }
    }
    Start-Sleep -Seconds 1
    Write-ProcessSnapshot "after-stopcodex"
  } else {
    Write-Log "StopCodex was not set. The repair will wait for visible Codex windows to close."
  }

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while (@(Get-CodexVisibleWindowProcess).Count -gt 0) {
    if ((Get-Date) -gt $deadline) {
      throw "Timed out after $TimeoutMinutes minutes waiting for Codex to close."
    }
    Write-Log "Visible Codex window still open; waiting."
    Start-Sleep -Seconds 2
  }
  Write-Log "No visible Codex desktop window remains."

  $leftoverProcesses = @((Get-CodexAppProcess) + (Get-CodexWorkerProcess)) |
    Where-Object { $_ -and $_.Id } |
    Sort-Object Id -Unique
  foreach ($process in $leftoverProcesses) {
    Write-Log "Stopping leftover Codex process $($process.ProcessName) $($process.Id)."
    try {
      Stop-Process -Id $process.Id -Force
    } catch {
      Write-Log "Could not stop leftover process $($process.Id): $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 1
  Write-ProcessSnapshot "after-leftover-stop"

  Push-Location $RepoRoot
  try {
    $index = 0
    foreach ($item in $items) {
      $index += 1
      $itemThreadId = [string]$item.threadId
      if (-not $itemThreadId) {
        throw "Repair item $index is missing threadId."
      }

      Write-Log "Repairing $index/$($items.Count): $itemThreadId"
      $nodeArgs = @(
        "--no-warnings",
        (Join-Path $RepoRoot "scripts\repair-codex-thread-index.cjs"),
        "--codex-home", $CodexHome,
        "--thread-id", $itemThreadId,
        "--apply",
        "--json"
      )
      if ($item.workspace) {
        $nodeArgs += @("--workspace", [string]$item.workspace)
      }
      if ($item.title) {
        $nodeArgs += @("--title", [string]$item.title)
      }
      if ($item.normalizeThreadSource) {
        $nodeArgs += @("--normalize-thread-source")
      }
      if ($item.touchUpdatedAtNow) {
        $nodeArgs += @("--touch-updated-at-now")
      } elseif ($item.touchUpdatedAt) {
        $nodeArgs += @("--touch-updated-at", [string]$item.touchUpdatedAt)
      }

      Invoke-ThreadDiagnostics "before-repair-$index" $item
      Write-Log "node $($nodeArgs -join ' ')"
      $nodeOutput = & node @nodeArgs 2>&1
      $exitCode = $LASTEXITCODE
      foreach ($line in $nodeOutput) {
        Write-Log "REPAIR OUT: $line"
      }
      if ($exitCode -ne 0) {
        throw "Repair script failed with exit code $exitCode for $itemThreadId."
      }
      Invoke-ThreadDiagnostics "after-repair-$index" $item -AppServer
    }
  } finally {
    Pop-Location
  }

  if (-not $NoRestartApp) {
    Start-CodexApp
    Start-Sleep -Seconds 8
    Write-ProcessSnapshot "after-relaunch"
    foreach ($item in $items) {
      Invoke-ThreadDiagnostics "after-relaunch" $item -AppServer
    }
  } else {
    Write-Log "NoRestartApp was set. Codex was not relaunched."
  }

  Write-Log "Thread index repair completed successfully."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
