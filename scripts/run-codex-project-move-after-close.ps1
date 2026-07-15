param(
  [string]$ProjectPath = "",
  [string]$NewPath = "",
  [string]$CodexHome = "$env:USERPROFILE\.codex",
  [string]$JobPath = "",
  [string]$LogPath = "",
  [int]$TimeoutMinutes = 30,
  [switch]$StopCodex,
  [switch]$NoRestartApp,
  [switch]$NoMoveFolder
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "codex-launcher.ps1")
$LogDir = Join-Path $RepoRoot "codex-project-move-results"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $LogPath) {
  $LogPath = Join-Path $LogDir "after-close-project-move-$Stamp.log"
}

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line
}

function Get-CodexAppProcess {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -in @("ChatGPT", "Codex") }
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

  if ($JobPath) {
    $job = Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json
    if ($job.codexHome) {
      $CodexHome = [string]$job.codexHome
    }
    $ProjectPath = [string]$job.projectPath
    $NewPath = [string]$job.newPath
    if ($null -ne $job.moveFolder -and -not [bool]$job.moveFolder) {
      $NoMoveFolder = $true
    }
  }

  if (-not $ProjectPath -or -not $NewPath) {
    throw "Provide -JobPath or both -ProjectPath and -NewPath."
  }

  Write-Log "ProjectPath=$ProjectPath"
  Write-Log "NewPath=$NewPath"
  Write-Log "CodexHome=$CodexHome"

  if ($StopCodex) {
    $processes = @((Get-CodexAppProcess) + (Get-CodexWorkerProcess))
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

  foreach ($process in @((Get-CodexAppProcess) + (Get-CodexWorkerProcess))) {
    Write-Log "Stopping leftover Codex process $($process.ProcessName) $($process.Id)."
    try {
      Stop-Process -Id $process.Id -Force
    } catch {
      Write-Log "Could not stop leftover process $($process.Id): $($_.Exception.Message)"
    }
  }

  Push-Location $RepoRoot
  try {
    $nodeArgs = @(
      (Join-Path $RepoRoot "scripts\move-codex-project.cjs"),
      "--project", $ProjectPath,
      "--to", $NewPath,
      "--codex-home", $CodexHome,
      "--apply",
      "--json"
    )
    if ($NoMoveFolder) {
      $nodeArgs += "--no-move-folder"
    }
    Write-Log "node $($nodeArgs -join ' ')"
    & node @nodeArgs *>> $LogPath
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "Codex project mover failed with exit code $exitCode."
    }
  } finally {
    Pop-Location
  }

  if (-not $NoRestartApp) {
    Start-CodexApp
  }

  Write-Log "Project move completed successfully."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
