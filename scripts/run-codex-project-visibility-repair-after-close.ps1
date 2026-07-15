param(
  [string]$CodexHome = "$env:USERPROFILE\.codex",
  [string]$LogPath = "",
  [int]$TimeoutMinutes = 30,
  [int]$DelaySeconds = 0,
  [switch]$StopCodex,
  [switch]$MaterializeWorkspaces,
  [switch]$TouchUpdatedAtNow,
  [switch]$NoRestartPatched,
  [switch]$RestartStore
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $RepoRoot "codex-repair-results"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $LogPath) {
  $LogPath = Join-Path $LogDir "project-visibility-repair-$Stamp.log"
}

function Write-Log {
  param([string]$Message)
  Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $Message"
}

function Get-CodexProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe") }
}

function Get-CodexVisibleWindowProcess {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -in @("ChatGPT", "Codex") -and $_.MainWindowHandle -ne 0 }
}

function Stop-CodexProcesses {
  $processes = @(Get-CodexProcess) | Sort-Object ProcessId -Unique
  foreach ($process in $processes) {
    Write-Log "Stopping $($process.Name) pid $($process.ProcessId) path=$($process.ExecutablePath)"
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Log "Could not stop pid $($process.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Start-PatchedCodex {
  $launcher = Join-Path $PSScriptRoot "launch-patched-codex.ps1"
  if (Test-Path -LiteralPath $launcher) {
    Write-Log "Starting patched Codex through $launcher"
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      $launcher
    ) | Out-Null
  } else {
    Write-Log "Patched launcher missing: $launcher"
  }
}

function Start-StoreCodex {
  Write-Log "Starting Microsoft Store Codex package."
  Start-Process -FilePath "explorer.exe" -ArgumentList "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App" | Out-Null
}

try {
  if ($DelaySeconds -gt 0) {
    Write-Log "Initial delay $DelaySeconds second(s)."
    Start-Sleep -Seconds $DelaySeconds
  }

  Write-Log "Project visibility repair starting. RepoRoot=$RepoRoot CodexHome=$CodexHome StopCodex=$($StopCodex.IsPresent)"
  if ($StopCodex) {
    Stop-CodexProcesses
    Start-Sleep -Seconds 1
  } else {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while (@(Get-CodexVisibleWindowProcess).Count -gt 0) {
      if ((Get-Date) -gt $deadline) {
        throw "Timed out after $TimeoutMinutes minutes waiting for Codex windows to close."
      }
      Write-Log "Visible Codex window still open; waiting."
      Start-Sleep -Seconds 2
    }
    Stop-CodexProcesses
    Start-Sleep -Seconds 1
  }

  Push-Location $RepoRoot
  try {
    $nodeArgs = @(
      "--no-warnings",
      (Join-Path $RepoRoot "scripts\repair-codex-project-visibility.cjs"),
      "--codex-home",
      $CodexHome,
      "--apply",
      "--json"
    )
    if ($MaterializeWorkspaces) {
      $nodeArgs += "--materialize-workspaces"
    }
    if ($TouchUpdatedAtNow) {
      $nodeArgs += "--touch-updated-at-now"
    }
    Write-Log "node $($nodeArgs -join ' ')"
    $output = & node @nodeArgs 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) {
      Write-Log "REPAIR OUT: $line"
    }
    if ($exitCode -ne 0) {
      throw "Project visibility repair failed with exit code $exitCode."
    }
  } finally {
    Pop-Location
  }

  if (-not $NoRestartPatched) {
    Start-PatchedCodex
  }
  if ($RestartStore) {
    Start-StoreCodex
  }

  Write-Log "Project visibility repair completed successfully."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
