param(
  [switch]$Force,
  [switch]$CheckOnly,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LauncherConfigPath = Join-Path $RepoRoot "codex-launcher.local.json"
$BaseConfigPath = Join-Path $RepoRoot "config\patcher.json"
$LocalConfigPath = Join-Path $RepoRoot "config\patcher.local.json"
$LogDir = Join-Path $RepoRoot "codex-patch-jobs\current-build"
$LogPath = Join-Path $LogDir "ensure-current.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-EnsureLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  if (-not $Quiet) {
    Write-Host $line
  }
}

function Read-JsonObject {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-MergedPatcherConfig {
  $merged = [ordered]@{}
  foreach ($path in @($BaseConfigPath, $LocalConfigPath)) {
    $value = Read-JsonObject -Path $path
    if ($null -eq $value) {
      continue
    }
    foreach ($property in $value.PSObject.Properties) {
      $merged[$property.Name] = $property.Value
    }
  }
  return [pscustomobject]$merged
}

function Get-CurrentCodexPackage {
  $package = Get-AppxPackage -Name OpenAI.Codex |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -eq $package) {
    throw "OpenAI.Codex is not installed for the current Windows user."
  }
  $appDir = Join-Path $package.InstallLocation "app"
  $asarPath = Join-Path $appDir "resources\app.asar"
  $exePath = @("ChatGPT.exe", "Codex.exe") |
    ForEach-Object { Join-Path $appDir $_ } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not (Test-Path -LiteralPath $asarPath) -or -not $exePath) {
    throw "Installed Codex package $($package.PackageFullName) is missing app.asar or its desktop executable."
  }
  return [pscustomobject]@{
    Version = [string]$package.Version
    PackageFullName = [string]$package.PackageFullName
    InstallLocation = [string]$package.InstallLocation
    AppDir = $appDir
    AsarPath = $asarPath
    ExePath = $exePath
  }
}

function Test-ConfiguredPatchedCodexRunning {
  param([object]$Launcher)

  $cloneRoot = [string]$Launcher.cloneRoot
  if (-not $cloneRoot -or -not [System.IO.Path]::IsPathRooted($cloneRoot)) {
    return $false
  }
  $normalizedRoot = [System.IO.Path]::GetFullPath($cloneRoot).TrimEnd("\") + "\"
  $process = Get-CimInstance Win32_Process |
    Where-Object {
      $candidate = [string]$_.ExecutablePath
      $_.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe") -and
        $candidate -and
        [System.IO.Path]::GetFullPath($candidate).StartsWith(
          $normalizedRoot,
          [System.StringComparison]::OrdinalIgnoreCase
        )
    } |
    Select-Object -First 1
  return $null -ne $process
}

function Stop-ConfiguredPatchedCodex {
  param([object]$Launcher)

  $cloneRoot = [string]$Launcher.cloneRoot
  if (-not $cloneRoot -or -not [System.IO.Path]::IsPathRooted($cloneRoot)) {
    return $false
  }
  $normalizedRoot = [System.IO.Path]::GetFullPath($cloneRoot).TrimEnd("\") + "\"
  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      $candidate = [string]$_.ExecutablePath
      $_.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe") -and
        $candidate -and
        [System.IO.Path]::GetFullPath($candidate).StartsWith(
          $normalizedRoot,
          [System.StringComparison]::OrdinalIgnoreCase
        )
    }
  if (-not $processes) {
    return $false
  }

  foreach ($process in $processes) {
    Write-EnsureLog "Stopping patched Codex process $($process.ProcessId) before rebuilding: $($process.ExecutablePath)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = Get-CimInstance Win32_Process |
      Where-Object {
        $candidate = [string]$_.ExecutablePath
        $_.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe") -and
          $candidate -and
          [System.IO.Path]::GetFullPath($candidate).StartsWith(
            $normalizedRoot,
            [System.StringComparison]::OrdinalIgnoreCase
          )
      }
  } while ($remaining -and (Get-Date) -lt $deadline)

  if ($remaining) {
    $ids = ($remaining | ForEach-Object { $_.ProcessId }) -join ", "
    throw "Patched Codex processes did not stop before rebuild: $ids"
  }
  Write-EnsureLog "Patched Codex processes stopped; stock Codex was left running."
  return $true
}

function Start-RebuiltPatchedCodex {
  $launchScript = Join-Path $RepoRoot "scripts\launch-patched-codex.ps1"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $powershell)) {
    $powershell = "powershell.exe"
  }
  $previousSkip = $env:CODEX_SKIP_CURRENT_PATCH_CHECK
  try {
    $env:CODEX_SKIP_CURRENT_PATCH_CHECK = "1"
    Start-Process `
      -FilePath $powershell `
      -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", "`"$launchScript`"",
        "-StopPatchedOnly"
      ) `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden | Out-Null
  } finally {
    $env:CODEX_SKIP_CURRENT_PATCH_CHECK = $previousSkip
  }
  Write-EnsureLog "Queued the rebuilt patched Codex relaunch."
}

$buildMutex = $null
$buildMutexOwned = $false
if (-not $CheckOnly) {
  $buildMutex = [System.Threading.Mutex]::new($false, "Global\CodexPatchStudioCurrentBuild")
  $buildMutexOwned = $buildMutex.WaitOne([TimeSpan]::FromSeconds(5))
  if (-not $buildMutexOwned) {
    $buildMutex.Dispose()
    throw "Another Codex Patch Studio build is already running. Wait for it to finish and try again."
  }
}

try {
$projectConfig = Get-MergedPatcherConfig
$current = Get-CurrentCodexPackage
$launcher = Read-JsonObject -Path $LauncherConfigPath
$outputRoot = [Environment]::ExpandEnvironmentVariables([string]$projectConfig.outputRoot)
if (-not $outputRoot) {
  $outputRoot = Join-Path $RepoRoot "build-output"
}

$configuredVersion = if ($launcher.sourceVersion) { [string]$launcher.sourceVersion } else { "" }
$configuredPackageDirName = if ($launcher.sourcePackageDirName) { [string]$launcher.sourcePackageDirName } else { "" }
$currentPackageDirName = Split-Path -Leaf ([string]$current.InstallLocation)
$configuredExe = [string]$launcher.codexExe
$fingerprintScript = Join-Path $RepoRoot "scripts\patcher-fingerprint.cjs"
$fingerprintNode = if ($env:CODEX_PATCHED_NODE -and (Test-Path -LiteralPath $env:CODEX_PATCHED_NODE)) {
  $env:CODEX_PATCHED_NODE
} else {
  "node"
}
$currentPatcherFingerprint = (& $fingerprintNode $fingerprintScript | ConvertFrom-Json).sha256
$configuredPatcherFingerprint = [string]$launcher.patcherSource.sha256
$currentAsarSha256 = Get-Sha256Hex -Path $current.AsarPath
$currentExeSha256 = Get-Sha256Hex -Path $current.ExePath
$configuredAsarSha256 = if ($launcher.sourceAsarSha256) { [string]$launcher.sourceAsarSha256 } else { "" }
$configuredExeSha256 = if ($launcher.sourceDesktopExeSha256) { [string]$launcher.sourceDesktopExeSha256 } else { "" }
$reasons = @()
if ($Force) { $reasons += "forced" }
if ($null -eq $launcher) { $reasons += "launcher-missing" }
if ($configuredVersion -ne $current.Version) { $reasons += "codex-version-changed" }
if ($configuredPackageDirName -ne $currentPackageDirName) { $reasons += "codex-package-changed" }
if ($configuredAsarSha256 -ne $currentAsarSha256) { $reasons += "installed-asar-changed" }
if ($configuredExeSha256 -ne $currentExeSha256) { $reasons += "installed-executable-changed" }
if ($configuredPatcherFingerprint -ne $currentPatcherFingerprint) { $reasons += "patcher-source-changed" }
if (-not $configuredExe -or -not (Test-Path -LiteralPath $configuredExe)) { $reasons += "patched-executable-missing" }
$reasons = @($reasons | Select-Object -Unique)
$needsBuild = $reasons.Count -gt 0
$codexUpdateAvailable = @($reasons | Where-Object { $_ -in @("codex-version-changed", "codex-package-changed", "installed-asar-changed", "installed-executable-changed") }).Count -gt 0
$patcherUpdateAvailable = $reasons -contains "patcher-source-changed"

if ($CheckOnly) {
  [pscustomobject]@{
    ok = $true
    checkOnly = $true
    needsBuild = $needsBuild
    codexUpdateAvailable = $codexUpdateAvailable
    patcherUpdateAvailable = $patcherUpdateAvailable
    reasons = $reasons
    installedVersion = $current.Version
    installedPackage = $current.PackageFullName
    installedAsarSha256 = $currentAsarSha256
    installedExeSha256 = $currentExeSha256
    patchedVersion = $configuredVersion
    patchedAsarSha256 = $configuredAsarSha256
    patchedExeSha256 = $configuredExeSha256
    codexExe = $configuredExe
    launcherConfigPath = $LauncherConfigPath
    logPath = $LogPath
  } | ConvertTo-Json -Depth 6
  return
}

if (-not $needsBuild) {
  Write-EnsureLog "Patched Codex is current at $configuredVersion."
  [pscustomobject]@{
    ok = $true
    rebuilt = $false
    needsBuild = $false
    codexUpdateAvailable = $false
    patcherUpdateAvailable = $false
    reasons = @()
    installedVersion = $current.Version
    patchedVersion = $configuredVersion
    codexExe = $configuredExe
    launcherConfigPath = $LauncherConfigPath
    logPath = $LogPath
  } | ConvertTo-Json -Depth 4
  return
}

$previousLauncher = $launcher
$relaunchAfterBuild = Test-ConfiguredPatchedCodexRunning -Launcher $previousLauncher
Write-EnsureLog "Building patch for installed Codex $($current.Version) from $($current.InstallLocation)."
$builder = Join-Path $RepoRoot "scripts\build-patched-codex-app.cjs"
$bundledNode = Join-Path $RepoRoot "app\resources\node.exe"
$node = if ($env:CODEX_PATCHED_NODE -and (Test-Path -LiteralPath $env:CODEX_PATCHED_NODE)) {
  $env:CODEX_PATCHED_NODE
} elseif (Test-Path -LiteralPath $bundledNode) {
  $bundledNode
} else {
  "node"
}

$arguments = @(
  $builder,
  "--json",
  "--no-shortcut",
  "--output-root",
  $outputRoot
)
$buildOutput = & $node @arguments 2>&1
$exitCode = $LASTEXITCODE
$buildText = ($buildOutput | Out-String).Trim()
if ($buildText) {
  Add-Content -LiteralPath $LogPath -Value $buildText -Encoding UTF8
}
if ($exitCode -ne 0) {
  throw "Current Codex patch build failed with exit code $exitCode. See $LogPath."
}

$launcher = Read-JsonObject -Path $LauncherConfigPath
if ($null -eq $launcher -or -not $launcher.codexExe -or -not (Test-Path -LiteralPath $launcher.codexExe)) {
  throw "Builder completed without a valid launcher configuration. See $LogPath."
}

Write-EnsureLog "Current Codex $($current.Version) patched successfully at $($launcher.codexExe)."
if ($relaunchAfterBuild) {
  Stop-ConfiguredPatchedCodex -Launcher $previousLauncher | Out-Null
  Start-RebuiltPatchedCodex
}
[pscustomobject]@{
  ok = $true
  rebuilt = $true
  needsBuild = $false
  codexUpdateAvailable = $codexUpdateAvailable
  patcherUpdateAvailable = $patcherUpdateAvailable
  reasons = $reasons
  installedVersion = $current.Version
  patchedVersion = [string]$launcher.sourceVersion
  codexExe = [string]$launcher.codexExe
  launcherConfigPath = $LauncherConfigPath
  logPath = $LogPath
} | ConvertTo-Json -Depth 4
} finally {
  if ($buildMutexOwned -and $null -ne $buildMutex) {
    $buildMutex.ReleaseMutex()
  }
  if ($null -ne $buildMutex) {
    $buildMutex.Dispose()
  }
}
