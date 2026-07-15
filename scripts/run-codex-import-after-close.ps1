param(
  [string]$ExportId = "",

  [string]$ConversationId = "",

  [string]$ThreadId = "",
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
$LogDir = Join-Path $RepoRoot "codex-import-results"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $LogPath) {
  $LogPath = Join-Path $LogDir "after-close-import-$Stamp.log"
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

function Get-AllCodexProcess {
  @(@(Get-CodexAppProcess) + @(Get-CodexWorkerProcess)) |
    Where-Object { $_ -and $_.Id } |
    Sort-Object Id -Unique
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
  Write-Log "ExportId=$ExportId ConversationId=$ConversationId ThreadId=$ThreadId JobPath=$JobPath"

  $items = @()
  if ($JobPath) {
    $job = Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json
    if ($job.codexHome) {
      $CodexHome = [string]$job.codexHome
    }
    $ValidateImports = $true
    if ($null -ne $job.validateImports) {
      $ValidateImports = [bool]$job.validateImports
    }
    $items = @($job.items)
  } elseif ($ExportId -and $ConversationId) {
    $ValidateImports = $true
    $items = @([pscustomobject]@{
      exportId = $ExportId
      conversationId = $ConversationId
      threadId = $ThreadId
      title = $Title
    })
  } else {
    throw "Provide either -JobPath or both -ExportId and -ConversationId."
  }

  if ($items.Count -eq 0) {
    throw "Import job has no items."
  }

  if ($StopCodex) {
    $processes = @(Get-AllCodexProcess)
    foreach ($process in $processes) {
      Write-Log "Stopping $($process.ProcessName) pid $($process.Id)."
      try {
        Stop-Process -Id $process.Id -Force
      } catch {
        Write-Log "Could not stop pid $($process.Id): $($_.Exception.Message)"
      }
    }
  }

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while (@(Get-CodexVisibleWindowProcess).Count -gt 0) {
    if ((Get-Date) -gt $deadline) {
      throw "Timed out after $TimeoutMinutes minutes waiting for Codex to close."
    }
    Start-Sleep -Seconds 2
  }

  $leftoverProcesses = @(Get-AllCodexProcess)
  foreach ($process in $leftoverProcesses) {
    Write-Log "Stopping leftover Codex process $($process.ProcessName) $($process.Id)."
    try {
      Stop-Process -Id $process.Id -Force
    } catch {
      Write-Log "Could not stop leftover process $($process.Id): $($_.Exception.Message)"
    }
  }

  Push-Location $RepoRoot
  $failedItems = @()
  try {
    Write-Log "Batch importing $($items.Count) item(s) from $JobPath"
    $nodeArgs = @(
      (Join-Path $RepoRoot "scripts\import-augment-to-codex.cjs"),
      "--job-path", $JobPath,
      "--codex-home", $CodexHome,
      "--apply"
    )
    if ($ValidateImports) {
      $nodeArgs += @("--validate")
    }
    Write-Log "node $($nodeArgs -join ' ')"
    & node @nodeArgs *>> $LogPath
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "Batch importer failed with exit code $exitCode."
    }
  } finally {
    Pop-Location
  }

  if (-not $NoRestartApp) {
    Start-CodexApp
  }

  Write-Log "Import completed. See batch summary above for per-item success/failure counts."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
