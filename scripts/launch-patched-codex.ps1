param(
  [switch]$NoStopExisting,
  [switch]$StopPatchedOnly,
  [switch]$StopAllCodex
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $RepoRoot "codex-launch-debug"
$LogPath = Join-Path $LogDir "patched-codex-launch.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  Write-Host $line
}

function Test-ConfiguredPatchedCodexProcess {
  param([object]$Process)

  $path = [string]$Process.ExecutablePath
  return $Process.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe") -and
    (Test-CodexConfiguredProcessPath -Path $path)
}

function Test-AnyCodexProcess {
  param([object]$Process)

  return $Process.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe")
}

function Stop-CodexProcessesForPatchedLaunch {
  param([switch]$PatchedOnly)

  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      if ($PatchedOnly) {
        Test-ConfiguredPatchedCodexProcess -Process $_
      } else {
        Test-AnyCodexProcess -Process $_
      }
    }

  if (-not $processes) {
    if ($PatchedOnly) {
      Write-Log "No existing configured patched Codex processes found."
    } else {
      Write-Log "No existing Codex processes found."
    }
    return
  }

  foreach ($process in $processes) {
    $label = if ($PatchedOnly) { "patched Codex" } else { "Codex" }
    Write-Log "Stopping $label process $($process.ProcessId): $($process.ExecutablePath)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = Get-CimInstance Win32_Process |
      Where-Object {
        if ($PatchedOnly) {
          Test-ConfiguredPatchedCodexProcess -Process $_
        } else {
          Test-AnyCodexProcess -Process $_
        }
      }
  } while ($remaining -and (Get-Date) -lt $deadline)

  if ($remaining) {
    $ids = ($remaining | ForEach-Object { $_.ProcessId }) -join ", "
    Write-Log "Warning: Codex processes still present after stop: $ids"
  } else {
    if ($PatchedOnly) {
      Write-Log "Existing configured patched Codex processes stopped."
    } else {
      Write-Log "Existing Codex processes stopped."
    }
  }
}

function Clear-SharedProcessManagerState {
  param([string]$CodexHome)

  $processManagerDir = Join-Path $CodexHome "process_manager"
  if (-not (Test-Path -LiteralPath $processManagerDir)) {
    return
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  foreach ($file in @("chat_processes.json")) {
    $path = Join-Path $processManagerDir $file
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }

    $backupPath = Join-Path $processManagerDir "$file.before-patched-launch-$stamp.bak"
    Move-Item -LiteralPath $path -Destination $backupPath -Force
    Write-Log "Moved stale shared process-manager state to $backupPath"
  }
}

Write-Log "Starting patched Codex launcher."
. (Join-Path $PSScriptRoot "codex-launcher.ps1")
Import-Module (Join-Path $PSScriptRoot "codex-update-policy.psm1") -Force

function Get-PatcherProjectConfig {
  $merged = [ordered]@{}
  foreach ($path in @(
    (Join-Path $RepoRoot "config\patcher.json"),
    (Join-Path $RepoRoot "config\patcher.local.json")
  )) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    $value = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    foreach ($property in $value.PSObject.Properties) {
      $merged[$property.Name] = $property.Value
    }
  }
  return [pscustomobject]$merged
}

function Show-CodexUpdatePrompt {
  param([object]$State)

  Add-Type -AssemblyName System.Windows.Forms
  $detail = Get-CodexUpdatePromptText -State $State
  $result = [System.Windows.Forms.MessageBox]::Show(
    $detail,
    "Codex Patch Studio update detected",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Information,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button1
  )
  return $result -eq [System.Windows.Forms.DialogResult]::Yes
}

function Show-CodexUpdateFailure {
  param([string]$Message)

  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      (Get-CodexUpdateFailureText -Message $Message),
      "Codex Patch Studio update failed",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    Write-Log "Could not display update failure dialog: $($_.Exception.Message)"
  }
}

$projectConfig = Get-PatcherProjectConfig
$existingLauncherConfig = Get-CodexLauncherConfig
$updatePolicy = Resolve-CodexUpdatePolicy -Config $projectConfig

$sourceCodexHome = Join-Path $env:USERPROFILE ".codex"
$patchedCodexHome = if ($env:CODEX_PATCHED_HOME) {
  $env:CODEX_PATCHED_HOME
} elseif ($projectConfig.patchedCodexHome) {
  [Environment]::ExpandEnvironmentVariables([string]$projectConfig.patchedCodexHome)
} else {
  Join-Path $env:USERPROFILE ".codex-patch-studio-current"
}

$sharedSqliteHome = if ($env:CODEX_PATCHED_SQLITE_HOME) {
  $env:CODEX_PATCHED_SQLITE_HOME
} elseif ($projectConfig.shareChatDatabaseWithStock -eq $false) {
  Join-Path $patchedCodexHome "chat-database"
} else {
  $sourceCodexHome
}

try {
  if (-not $NoStopExisting) {
    $patchedOnlyLaunch = $StopPatchedOnly -or (-not $StopAllCodex)
    Stop-CodexProcessesForPatchedLaunch -PatchedOnly:$patchedOnlyLaunch
    if (-not $patchedOnlyLaunch) {
      Clear-SharedProcessManagerState -CodexHome $sourceCodexHome
    }
  }

  $bundledSnapshot = [string]$existingLauncherConfig.mode -eq "bundled-self-extracting"
  if (-not $bundledSnapshot -and $env:CODEX_SKIP_CURRENT_PATCH_CHECK -ne "1") {
    Write-Log "Codex update policy: $updatePolicy"
    if ($updatePolicy -eq "off") {
      $env:CODEX_ALLOW_STALE_PATCHED_LAUNCH = "1"
      Write-Log "Skipping installed Codex update detection by user policy."
    } else {
      try {
        Write-Log "Checking the installed Codex build before launch."
        $checkResult = & (Join-Path $PSScriptRoot "ensure-current-codex-patch.ps1") -CheckOnly -Quiet
        $checkSummary = $checkResult | ConvertFrom-Json
        Write-Log "Patch check complete. installed=$($checkSummary.installedVersion) patched=$($checkSummary.patchedVersion) needsBuild=$($checkSummary.needsBuild) reasons=$(@($checkSummary.reasons) -join ',')"

        $promptAccepted = $null
        if ($updatePolicy -eq "notify" -and $checkSummary.needsBuild) {
          $promptAccepted = Show-CodexUpdatePrompt -State $checkSummary
        }
        $updatePlan = Get-CodexUpdatePlan -Policy $updatePolicy -NeedsBuild ([bool]$checkSummary.needsBuild) -PromptAccepted $promptAccepted

        if ($updatePlan.rebuild) {
          $ensureResult = & (Join-Path $PSScriptRoot "ensure-current-codex-patch.ps1") -Quiet
          $ensureSummary = $ensureResult | ConvertFrom-Json
          Write-Log "Patch rebuild complete. installed=$($ensureSummary.installedVersion) rebuilt=$($ensureSummary.rebuilt)"
          $existingLauncherConfig = Get-CodexLauncherConfig
        } elseif ($updatePlan.allowStale) {
          $env:CODEX_ALLOW_STALE_PATCHED_LAUNCH = "1"
          Write-Log "User deferred the rebuild; launching the existing immutable clone."
        }
      } catch {
        Show-CodexUpdateFailure -Message $_.Exception.Message
        $failurePlan = Get-CodexUpdatePlan -Policy $updatePolicy -CheckFailed
        if ($failurePlan.allowStale) {
          $env:CODEX_ALLOW_STALE_PATCHED_LAUNCH = "1"
          Write-Log "Update check failed in notify mode; launching the existing clone. Error: $($_.Exception.Message)"
        } else {
          throw
        }
      }
    }
  }

  Write-Log "Initializing patched Codex home: $patchedCodexHome"
  & (Join-Path $PSScriptRoot "initialize-patched-codex-home.ps1") `
    -SourceCodexHome $sourceCodexHome `
    -PatchedCodexHome $patchedCodexHome `
    -SharedSqliteHome $sharedSqliteHome | Out-Null

  Write-Log "Starting provider proxies."
  & (Join-Path $PSScriptRoot "start-codex-provider-proxies.ps1")

  Write-Log "Starting chat import manager bridge."
  & (Join-Path $PSScriptRoot "start-codex-import-manager.ps1")

  Write-Log "Starting native patch manager bridge."
  & (Join-Path $PSScriptRoot "start-codex-patch-manager.ps1")

  $env:CODEX_HOME = $patchedCodexHome
  $env:CODEX_SQLITE_HOME = $sharedSqliteHome

  $catalogShimUrl = ""
  if ($existingLauncherConfig.features.catalogShim -eq $true) {
    Write-Log "Starting lazy all-chats catalog shim."
    $shimJson = & (Join-Path $PSScriptRoot "start-codex-all-chats-shim.ps1") `
      -LauncherConfigPath $script:CodexLauncherConfigPath `
      -CodexHome $patchedCodexHome `
      -SqliteHome $sharedSqliteHome
    $shim = $shimJson | ConvertFrom-Json
    if ($shim.ok -ne $true -or -not $shim.wsUrl) {
      throw "The all-chats catalog shim did not return a usable WebSocket endpoint."
    }
    $catalogShimUrl = [string]$shim.wsUrl
    Write-Log "All-chats catalog shim ready on loopback port $($shim.port); reused=$($shim.reused)."
  } else {
    Write-Log "Lazy all-chats catalog shim is disabled for this build."
  }

  Write-Log "Launching patched Codex with CODEX_HOME=$patchedCodexHome and CODEX_SQLITE_HOME=$sharedSqliteHome."
  Start-CodexAppFromLauncher `
    -CodexHome $patchedCodexHome `
    -CodexSqliteHome $sharedSqliteHome `
    -AppServerWsUrl $catalogShimUrl
  Write-Log "Patched Codex launch request completed."
} catch {
  Write-Log "Launch failed: $($_.Exception.Message)"
  throw
}
