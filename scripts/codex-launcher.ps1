$script:CodexLauncherRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:CodexLauncherConfigPath = Join-Path $script:CodexLauncherRepoRoot "codex-launcher.local.json"

function Write-CodexLauncherLog {
  param([string]$Message)
  if (Get-Command Write-Log -ErrorAction SilentlyContinue) {
    Write-Log $Message
  } else {
    Write-Host $Message
  }
}

function Get-CodexLauncherConfig {
  if (-not (Test-Path -LiteralPath $script:CodexLauncherConfigPath)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $script:CodexLauncherConfigPath -Raw | ConvertFrom-Json
  } catch {
    Write-CodexLauncherLog "Could not read Codex launcher config $script:CodexLauncherConfigPath`: $($_.Exception.Message)"
    return $null
  }
}

function Test-CodexConfiguredProcessPath {
  param([string]$Path)
  if (-not $Path) {
    return $false
  }

  $config = Get-CodexLauncherConfig
  if ($null -eq $config) {
    return $false
  }

  $roots = @($config.cloneRoot, $config.appDir, $config.resourcesDir) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    ForEach-Object { (Resolve-Path -LiteralPath $_).Path.TrimEnd('\') }

  foreach ($root in $roots) {
    if ($Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }

  return $false
}

function Assert-CodexLauncherCompatibleBuild {
  param([object]$Config)

  if ($env:CODEX_ALLOW_STALE_PATCHED_LAUNCH -eq "1") {
    return
  }

  $sourceVersion = if ($Config.sourceVersion) { [string]$Config.sourceVersion } else { "" }
  if (-not $sourceVersion) {
    throw "Refusing to launch a patched build without source-version metadata. Rebuild it with npm run setup."
  }

  $manifestPath = Join-Path ([string]$Config.cloneRoot) "patch-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Patched Codex manifest is missing: $manifestPath"
  }

  $bundledSnapshot =
    ([string]$Config.mode -eq "bundled-self-extracting") -or
    ([string]$Config.sourceMode -eq "bundled-snapshot")
  if ($bundledSnapshot) {
    return
  }

  $installed = Get-AppxPackage -Name OpenAI.Codex |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -ne $installed -and [string]$installed.Version -ne $sourceVersion) {
    throw "Patched Codex targets $sourceVersion but the installed Codex version is $($installed.Version). Run npm run update:current or launch through the managed shortcut."
  }

}

function Start-CodexAppFromLauncher {
  param(
    [string]$FallbackPackageAppId = "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App",
    [string]$CodexHome = "",
    [string]$CodexSqliteHome = "",
    [string]$AppServerWsUrl = ""
  )

  $config = Get-CodexLauncherConfig
  if ($null -ne $config -and $config.codexExe -and (Test-Path -LiteralPath $config.codexExe)) {
    Assert-CodexLauncherCompatibleBuild -Config $config

    $exe = (Resolve-Path -LiteralPath $config.codexExe).Path
    $workingDirectory = Split-Path -Parent $exe
    $electronUserDataPath = [string]$config.electronUserDataPath
    if (-not $electronUserDataPath -and $config.cloneRoot) {
      $electronUserDataPath = Join-Path ([string]$config.cloneRoot) "electron-user-data"
    }
    if (-not $CodexHome) {
      if ($env:CODEX_HOME) {
        $CodexHome = $env:CODEX_HOME
      } else {
        $CodexHome = Join-Path $env:USERPROFILE ".codex"
      }
    }

    Write-CodexLauncherLog "Relaunching patched Codex: $exe"
    if ($electronUserDataPath) {
      Write-CodexLauncherLog "Using CODEX_ELECTRON_USER_DATA_PATH=$electronUserDataPath"
    }
    Write-CodexLauncherLog "Using CODEX_HOME=$CodexHome"
    if ($CodexSqliteHome) {
      Write-CodexLauncherLog "Using CODEX_SQLITE_HOME=$CodexSqliteHome"
    }
    if ($AppServerWsUrl) {
      Write-CodexLauncherLog "Using the tokenized all-chats app-server shim."
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exe
    $startInfo.WorkingDirectory = $workingDirectory
    $argumentParts = @()
    if ($electronUserDataPath) {
      New-Item -ItemType Directory -Force -Path $electronUserDataPath | Out-Null
      $argumentParts += "--user-data-dir=`"$electronUserDataPath`""
    }
    if ($env:CODEX_PATCHED_REMOTE_DEBUGGING_PORT -match '^\d+$') {
      $argumentParts += "--remote-debugging-port=$($env:CODEX_PATCHED_REMOTE_DEBUGGING_PORT)"
      $argumentParts += "--remote-allow-origins=*"
    }
    $startInfo.Arguments = $argumentParts -join " "
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    if ($electronUserDataPath) {
      $startInfo.Environment["CODEX_ELECTRON_USER_DATA_PATH"] = $electronUserDataPath
    }
    if ($CodexHome) {
      $startInfo.Environment["CODEX_HOME"] = $CodexHome
    }
    if ($CodexSqliteHome) {
      $startInfo.Environment["CODEX_SQLITE_HOME"] = $CodexSqliteHome
    }
    [void]$startInfo.Environment.Remove("CODEX_APP_SERVER_FORCE_CLI")
    [void]$startInfo.Environment.Remove("CODEX_APP_SERVER_WS_URL")
    if ($AppServerWsUrl) {
      $startInfo.Environment["CODEX_APP_SERVER_WS_URL"] = $AppServerWsUrl
    }
    foreach ($providerEnvKey in @("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ZAI_API_KEY", "DASHSCOPE_API_KEY", "CEREBRAS_API_KEY")) {
      $providerEnvValue = [Environment]::GetEnvironmentVariable($providerEnvKey, "Process")
      if (-not $providerEnvValue) {
        $providerEnvValue = [Environment]::GetEnvironmentVariable($providerEnvKey, "User")
      }
      if ($providerEnvValue) {
        $startInfo.Environment[$providerEnvKey] = $providerEnvValue
      }
    }
    [System.Diagnostics.Process]::Start($startInfo) | Out-Null
    return
  }

  Write-CodexLauncherLog "Relaunching packaged Codex: $FallbackPackageAppId"
  Start-Process explorer.exe $FallbackPackageAppId
}
