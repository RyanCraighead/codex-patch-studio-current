param(
  [string]$ConfigPath = "",
  [string]$OutputDirectory = "",
  [string]$BundleName = "",
  [string]$BundleDataRoot = "",
  [switch]$PortableElectronProfile,
  [switch]$KeepWork
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $RepoRoot "codex-launcher.local.json"
}
if (-not $OutputDirectory -and $env:CODEX_PATCHED_PACKAGE_OUTPUT_DIRECTORY) {
  $OutputDirectory = $env:CODEX_PATCHED_PACKAGE_OUTPUT_DIRECTORY
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $RepoRoot "codex-portable-packages"
}

function ConvertTo-SafeName {
  param([string]$Value)
  $safe = ($Value -replace '[<>:"/\\|?*]', '-').Trim()
  $safe = ($safe -replace '\s+', '-')
  if (-not $safe) {
    return "Codex-Patch-Studio-Current"
  }
  return $safe
}

function Get-ProjectConfig {
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

function Get-ExplicitBooleanSetting {
  param(
    [object[]]$Configs,
    [string]$Name,
    [bool]$Default = $false
  )

  foreach ($candidate in $Configs) {
    if ($null -eq $candidate) {
      continue
    }
    $property = $candidate.PSObject.Properties[$Name]
    if ($null -eq $property) {
      continue
    }
    if ($property.Value -isnot [bool]) {
      throw "Configuration setting '$Name' must be true or false."
    }
    return [bool]$property.Value
  }
  return $Default
}

function Find-SourceDesktopExecutable {
  param(
    [object]$Config,
    [string]$AppDir
  )

  $candidateNames = @()
  if ($Config.sourceDesktopExecutableName) {
    $candidateNames += Split-Path -Leaf ([string]$Config.sourceDesktopExecutableName)
  }
  if ($Config.codexExe) {
    $candidateNames += Split-Path -Leaf ([string]$Config.codexExe)
  }
  $candidateNames += "ChatGPT.exe"
  $candidateNames += "Codex.exe"

  $seen = @{}
  foreach ($candidateName in $candidateNames) {
    if (-not $candidateName -or $seen.ContainsKey($candidateName)) {
      continue
    }
    $seen[$candidateName] = $true
    $candidatePath = Join-Path $AppDir $candidateName
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      continue
    }
    if ($candidateName -ieq "Codex.exe") {
      Write-Warning "Using legacy Codex.exe desktop-shell fallback. Current Codex packages use ChatGPT.exe."
    }
    return (Resolve-Path -LiteralPath $candidatePath).Path
  }

  throw "Patched desktop executable not found in $AppDir. Expected ChatGPT.exe (or legacy Codex.exe)."
}

function Invoke-RobocopyChecked {
  param(
    [string]$Source,
    [string]$Target,
    [string[]]$ExcludeFiles = @()
  )

  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $args = @($Source, $Target, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  if ($ExcludeFiles.Count) {
    $args += "/XF"
    $args += $ExcludeFiles
  }
  $result = Start-Process -FilePath "robocopy.exe" -ArgumentList $args -NoNewWindow -PassThru -Wait
  if ($result.ExitCode -gt 7) {
    throw "robocopy failed with exit code $($result.ExitCode): $Source -> $Target"
  }
}

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Value
  )
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToUpperInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Find-SevenZipTool {
  $candidates = @(
    (Join-Path $env:ProgramFiles "7-Zip\7z.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe"),
    "7z.exe"
  )
  foreach ($candidate in $candidates) {
    if (-not $candidate) {
      continue
    }
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "7-Zip was not found. Install 7-Zip or add 7z.exe to PATH before bundling."
}

function Find-SevenZipSfx {
  $repoSfx = Join-Path $RepoRoot "tools\7z-sfx-as-invoker.sfx"
  if (-not (Test-Path -LiteralPath $repoSfx -PathType Leaf)) {
    throw "Installer SFX module missing: $repoSfx. The interactive 7z.sfx module is not a valid substitute."
  }
  $expectedHash = "E1E9AA1EB9FE7F331DE76479154AC4BB9998C8919DBC79BEBE4F6EAA795CE312"
  $actualHash = Get-Sha256Hex -Path $repoSfx
  if ($actualHash -ne $expectedHash) {
    throw "Installer SFX module hash mismatch. Expected $expectedHash but found $actualHash."
  }
  return (Resolve-Path -LiteralPath $repoSfx).Path
}

function Find-FrameworkCSharpCompiler {
  $frameworkRoot = Join-Path $env:SystemRoot "Microsoft.NET"
  $candidates = @(
    (Join-Path $frameworkRoot "Framework64\v4.0.30319\csc.exe"),
    (Join-Path $frameworkRoot "Framework\v4.0.30319\csc.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw ".NET Framework C# compiler was not found. Enable .NET Framework 4.x before bundling."
}

function Build-BootstrapLauncher {
  param(
    [string]$SourcePath,
    [string]$OutputPath
  )

  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Portable bootstrap launcher source missing: $SourcePath"
  }
  $compiler = Find-FrameworkCSharpCompiler
  & $compiler /nologo /target:winexe /optimize+ "/out:$OutputPath" $SourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw "Portable bootstrap launcher compilation failed with exit code $LASTEXITCODE."
  }
}

function Join-BinaryFiles {
  param(
    [string]$OutputPath,
    [string[]]$InputPaths
  )

  $output = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    foreach ($inputPath in $InputPaths) {
      $input = [System.IO.File]::OpenRead($inputPath)
      try {
        $input.CopyTo($output)
      } finally {
        $input.Dispose()
      }
    }
  } finally {
    $output.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Launcher config not found: $ConfigPath. Run npm run patch:codex first."
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$projectConfig = Get-ProjectConfig
$shareChatDatabaseWithStock = Get-ExplicitBooleanSetting `
  -Configs @($config, $projectConfig) `
  -Name "shareChatDatabaseWithStock" `
  -Default $false
$sourceAppDir = [string]$config.appDir
if (-not $sourceAppDir -or -not (Test-Path -LiteralPath $sourceAppDir)) {
  throw "Patched app directory not found from launcher config: $sourceAppDir"
}

function Find-SqliteTool {
  $command = Get-Command "sqlite3.exe" -ErrorAction SilentlyContinue
  if (-not $command) {
    $command = Get-Command "sqlite3" -ErrorAction SilentlyContinue
  }
  if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) {
    return (Resolve-Path -LiteralPath $command.Source).Path
  }
  throw "sqlite3.exe was not found. Install the SQLite CLI before bundling; it is copied into the portable payload."
}
$sourceAppDir = (Resolve-Path -LiteralPath $sourceAppDir).Path
$sourceCodexExe = Find-SourceDesktopExecutable -Config $config -AppDir $sourceAppDir
$sourceAppAsar = Join-Path $sourceAppDir "resources\app.asar"
if (-not (Test-Path -LiteralPath $sourceAppAsar)) {
  throw "Patched app.asar not found: $sourceAppAsar"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$version = [string]$config.sourceVersion
if (-not $version) {
  throw "Launcher config is missing sourceVersion metadata: $ConfigPath"
}
$BundleDataRoot = $BundleDataRoot.Trim()
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $BundleName) {
  $BundleName = "Codex-Patched-$version-$timestamp"
}
$safeBundleName = ConvertTo-SafeName $BundleName
$bundleId = ConvertTo-SafeName "$safeBundleName-$timestamp"
$workRoot = Join-Path $OutputDirectory ".tmp-$bundleId"
$payloadRoot = Join-Path $workRoot "payload"
$sfxRoot = Join-Path $workRoot "sfx"
$payloadArchive = Join-Path $sfxRoot "codex-patched-payload.7z"
$manifestPath = Join-Path $sfxRoot "bundle-manifest.json"
$bootstrapPath = Join-Path $sfxRoot "bootstrap.ps1"
$bootstrapLauncherPath = Join-Path $sfxRoot "bootstrap-launcher.exe"
$sedPath = Join-Path $workRoot "bundle.sed"
$sevenZipArchivePath = Join-Path $workRoot "bundle.7z"
$sevenZipSfxConfigPath = Join-Path $workRoot "7z-sfx-config.txt"
$outputExe = Join-Path $OutputDirectory "$safeBundleName.exe"

if (Test-Path -LiteralPath $workRoot) {
  Remove-Item -LiteralPath $workRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payloadRoot, $sfxRoot | Out-Null
if (Test-Path -LiteralPath $outputExe) {
  Remove-Item -LiteralPath $outputExe -Force
}

Write-Host "Staging patched Codex app from $sourceAppDir"
Invoke-RobocopyChecked `
  -Source $sourceAppDir `
  -Target (Join-Path $payloadRoot "app") `
  -ExcludeFiles @("app.asar.before-*", "app.asar.failed-*", "app.asar.original")

$payloadScriptsDir = Join-Path $payloadRoot "scripts"
New-Item -ItemType Directory -Force -Path $payloadScriptsDir | Out-Null
$runtimeScripts = @(
  "codex-launcher.ps1",
  "launch-patched-codex.ps1",
  "initialize-patched-codex-home.ps1",
  "start-codex-provider-proxies.ps1",
  "start-codex-import-manager.ps1",
  "start-codex-patch-manager.ps1",
  "start-codex-all-chats-shim.ps1",
  "codex-all-chats-shim.cjs",
  "codex-responses-chat-proxy.cjs",
  "build-patched-codex-app.cjs",
  "feature-registry.cjs",
  "patcher-fingerprint.cjs",
  "ensure-current-codex-patch.ps1",
  "create-patched-codex-shortcut.ps1",
  "package-patched-codex-single-exe.ps1",
  "export-all-chat-sources.cjs",
  "export-all-augment-chats.cjs",
  "export-augment-chat-history.cjs",
  "export-augment-webview-state.cjs",
  "export-kiro-history.cjs",
  "export-roo-code-history.cjs",
  "export-cline-history.cjs",
  "preflight-and-schedule-codex-import.cjs",
  "preflight-and-schedule-codex-thread-repair.cjs",
  "import-augment-to-codex.cjs",
  "run-codex-import-after-close.ps1",
  "run-codex-thread-repair-after-close.ps1",
  "run-codex-project-visibility-repair-after-close.ps1",
  "run-codex-project-move-after-close.ps1",
  "repair-codex-thread-index.cjs",
  "repair-codex-native-chat-store.cjs",
  "repair-codex-project-visibility.cjs",
  "move-codex-project.cjs",
  "diagnose-codex-thread.cjs",
  "link-codex-orchestration-threads.cjs",
  "run-codex-orchestration.cjs"
)
foreach ($scriptName in $runtimeScripts) {
  $sourceScript = Join-Path $RepoRoot "scripts\$scriptName"
  if (-not (Test-Path -LiteralPath $sourceScript)) {
    throw "Required runtime script missing: $sourceScript"
  }
  Copy-Item -LiteralPath $sourceScript -Destination (Join-Path $payloadScriptsDir $scriptName) -Force
}

foreach ($projectFileName in @("package.json", "package-lock.json", "THIRD_PARTY_NOTICES.md")) {
  $projectFile = Join-Path $RepoRoot $projectFileName
  if (-not (Test-Path -LiteralPath $projectFile)) {
    throw "Required portable dependency manifest missing: $projectFile"
  }
  Copy-Item -LiteralPath $projectFile -Destination (Join-Path $payloadRoot $projectFileName) -Force
}

$nodeModules = Join-Path $RepoRoot "node_modules"
if (-not (Test-Path -LiteralPath (Join-Path $nodeModules "classic-level"))) {
  throw "Portable dependency classic-level is missing. Run npm install before bundling."
}
Invoke-RobocopyChecked -Source $nodeModules -Target (Join-Path $payloadRoot "node_modules")

$payloadToolsDir = Join-Path $payloadRoot "tools"
New-Item -ItemType Directory -Force -Path $payloadToolsDir | Out-Null
$sqliteTool = Find-SqliteTool
Copy-Item -LiteralPath $sqliteTool -Destination (Join-Path $payloadToolsDir "sqlite3.exe") -Force

$payloadConfigDir = Join-Path $payloadRoot "config"
New-Item -ItemType Directory -Force -Path $payloadConfigDir | Out-Null
foreach ($configName in @("patcher.json", "compatibility.json")) {
  $sourceConfig = Join-Path $RepoRoot "config\$configName"
  if (-not (Test-Path -LiteralPath $sourceConfig)) {
    throw "Required patcher config missing: $sourceConfig"
  }
  Copy-Item -LiteralPath $sourceConfig -Destination (Join-Path $payloadConfigDir $configName) -Force
}
$payloadPatcherConfigPath = Join-Path $payloadConfigDir "patcher.json"
$payloadPatcherConfig = Get-Content -LiteralPath $payloadPatcherConfigPath -Raw | ConvertFrom-Json
$shareProperty = $payloadPatcherConfig.PSObject.Properties["shareChatDatabaseWithStock"]
if ($null -eq $shareProperty) {
  $payloadPatcherConfig | Add-Member -NotePropertyName "shareChatDatabaseWithStock" -NotePropertyValue $shareChatDatabaseWithStock
} else {
  $shareProperty.Value = $shareChatDatabaseWithStock
}
Write-Utf8NoBom `
  -Path $payloadPatcherConfigPath `
  -Value ($payloadPatcherConfig | ConvertTo-Json -Depth 20)

Invoke-RobocopyChecked `
  -Source (Join-Path $RepoRoot "viewer") `
  -Target (Join-Path $payloadRoot "viewer") `
  -ExcludeFiles @("*.log", "*.png")

Invoke-RobocopyChecked `
  -Source (Join-Path $RepoRoot "codex-viewer") `
  -Target (Join-Path $payloadRoot "codex-viewer") `
  -ExcludeFiles @("*.log", "*.png")

Invoke-RobocopyChecked `
  -Source (Join-Path $RepoRoot "native-patches") `
  -Target (Join-Path $payloadRoot "native-patches") `
  -ExcludeFiles @("*.log")

Invoke-RobocopyChecked `
  -Source (Join-Path $RepoRoot "features") `
  -Target (Join-Path $payloadRoot "features") `
  -ExcludeFiles @("*.log")

$fingerprintNode = @(
  (Join-Path $payloadRoot "app\resources\cua_node\bin\node.exe"),
  (Join-Path $payloadRoot "app\resources\node.exe"),
  [string](Get-Command "node.exe" -ErrorAction SilentlyContinue).Source,
  [string](Get-Command "node" -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $fingerprintNode) {
  throw "Node.js was not found for computing the packaged patcher fingerprint."
}
$patcherSource = & $fingerprintNode (Join-Path $payloadRoot "scripts\patcher-fingerprint.cjs") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $patcherSource.sha256) {
  throw "Could not compute the packaged patcher source fingerprint."
}

$sourceManifest = [ordered]@{
  bundleId = $bundleId
  bundleName = $BundleName
  bundleDataRoot = $BundleDataRoot
  packagedAt = (Get-Date).ToUniversalTime().ToString("o")
  sourcePackageDirName = [string]$config.sourcePackageDirName
  sourceVersion = $version
  sourceDesktopExecutableName = Split-Path -Leaf $sourceCodexExe
  sourceAsarSha256 = [string]$config.sourceAsarSha256
  sourceDesktopExeSha256 = [string]$config.sourceDesktopExeSha256
  sourceAppServerCliSha256 = [string]$config.sourceAppServerCliSha256
  patcherSource = $patcherSource
  limit = if ($config.limit) { [int]$config.limit } else { 1000 }
  features = $config.features
  featureModules = $config.featureModules
  catalogShim = $config.catalogShim
  shareChatDatabaseWithStock = $shareChatDatabaseWithStock
}
$sourceManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $payloadRoot "bundle-source.json") -Encoding UTF8

Write-Host "Compressing payload with long-path-safe 7-Zip. This can take a few minutes."
$sevenZip = Find-SevenZipTool
$sevenZipSfx = Find-SevenZipSfx
$bundledSevenZip = Join-Path $sfxRoot "7z.exe"
Copy-Item -LiteralPath $sevenZip -Destination $bundledSevenZip -Force
$innerSevenZipArgs = @(
  "a",
  "-t7z",
  "-mx=7",
  "-mmt=on",
  $payloadArchive,
  (Join-Path $payloadRoot "*")
)
& $sevenZip @innerSevenZipArgs | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $payloadArchive)) {
  throw "7-Zip payload compression failed with exit code $LASTEXITCODE."
}
$payloadHash = Get-Sha256Hex -Path $payloadArchive
$extractorHash = Get-Sha256Hex -Path $bundledSevenZip

$manifest = [ordered]@{
  bundleId = $bundleId
  bundleName = $BundleName
  bundleDataRoot = $BundleDataRoot
  payloadFile = (Split-Path -Leaf $payloadArchive)
  payloadSha256 = $payloadHash
  extractorFile = "7z.exe"
  extractorSha256 = $extractorHash
  packagedAt = $sourceManifest.packagedAt
  sourcePackageDirName = $sourceManifest.sourcePackageDirName
  sourceVersion = $sourceManifest.sourceVersion
  sourceDesktopExecutableName = $sourceManifest.sourceDesktopExecutableName
  sourceAsarSha256 = $sourceManifest.sourceAsarSha256
  sourceDesktopExeSha256 = $sourceManifest.sourceDesktopExeSha256
  sourceAppServerCliSha256 = $sourceManifest.sourceAppServerCliSha256
  patcherSource = $sourceManifest.patcherSource
  limit = $sourceManifest.limit
  features = $sourceManifest.features
  featureModules = $sourceManifest.featureModules
  catalogShim = $sourceManifest.catalogShim
  shareChatDatabaseWithStock = $sourceManifest.shareChatDatabaseWithStock
}
$manifestJson = $manifest | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $manifestPath -Value $manifestJson -Encoding UTF8

$bootstrap = @'
$ErrorActionPreference = "Stop"

function Write-BundleLog {
  param([string]$Message)
  $logRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "CodexPatchStudioCurrent\logs"
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $Message
  Add-Content -LiteralPath (Join-Path $logRoot "codex-patch-studio-current-bundle.log") -Value $line -Encoding UTF8
}

function Assert-ChildPath {
  param(
    [string]$Base,
    [string]$Path
  )
  $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
  $pathFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') + '\'
  if (-not $pathFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside bundle root: $Path"
  }
}

function Resolve-BundleDataRoot {
  param(
    [object]$Manifest,
    [string]$LocalAppData
  )

  $configuredRoot = if ($env:CODEX_PATCHED_BUNDLE_DATA_ROOT) {
    [string]$env:CODEX_PATCHED_BUNDLE_DATA_ROOT
  } else {
    [string]$Manifest.bundleDataRoot
  }
  if (-not $configuredRoot) {
    $configuredRoot = Join-Path $LocalAppData "CodexPatchStudioCurrent"
  }
  $expandedRoot = [Environment]::ExpandEnvironmentVariables($configuredRoot)
  if (-not [System.IO.Path]::IsPathRooted($expandedRoot)) {
    throw "Bundle data root must be an absolute path: $configuredRoot"
  }
  return [System.IO.Path]::GetFullPath($expandedRoot)
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToUpperInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

try {
  $sfxRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  $manifestPath = Join-Path $sfxRoot "bundle-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Bundle manifest missing: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
  $bundleDataRoot = Resolve-BundleDataRoot -Manifest $manifest -LocalAppData $localAppData
  $bundleBase = Join-Path $bundleDataRoot "bundled-apps"
  $profileBase = Join-Path $bundleDataRoot "bundled-profiles"
  $targetRoot = Join-Path $bundleBase ([string]$manifest.bundleId)
  $profileRoot = Join-Path $profileBase ([string]$manifest.bundleId)
  Assert-ChildPath -Base $bundleBase -Path $targetRoot
  Assert-ChildPath -Base $profileBase -Path $profileRoot
  New-Item -ItemType Directory -Force -Path $bundleBase, $profileRoot | Out-Null

  $desktopExecutableName = [string]$manifest.sourceDesktopExecutableName
  $allowLegacyDesktopFallback = -not $desktopExecutableName
  if (-not $desktopExecutableName) {
    $desktopExecutableName = "ChatGPT.exe"
  }
  $codexExe = Join-Path $targetRoot "app\$desktopExecutableName"
  $legacyCodexExe = Join-Path $targetRoot "app\Codex.exe"
  $desktopExecutablePresent = Test-Path -LiteralPath $codexExe -PathType Leaf
  if (-not $desktopExecutablePresent -and $allowLegacyDesktopFallback) {
    $desktopExecutablePresent = Test-Path -LiteralPath $legacyCodexExe -PathType Leaf
  }
  $markerPath = Join-Path $targetRoot ".bundle-complete.json"
  $needsExtract = $true
  if ((Test-Path -LiteralPath $markerPath) -and $desktopExecutablePresent) {
    try {
      $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
      $needsExtract = ([string]$marker.payloadSha256 -ne [string]$manifest.payloadSha256)
    } catch {
      $needsExtract = $true
    }
  }

  if ($needsExtract) {
    $payloadArchive = Join-Path $sfxRoot ([string]$manifest.payloadFile)
    if (-not (Test-Path -LiteralPath $payloadArchive)) {
      throw "Bundle payload missing: $payloadArchive"
    }
    Write-BundleLog "Extracting $($manifest.bundleName) to $targetRoot"
    $actualHash = Get-Sha256Hex -Path $payloadArchive
    if ([string]$actualHash -ne [string]$manifest.payloadSha256) {
      throw "Bundle payload hash mismatch."
    }
    $sevenZip = Join-Path $sfxRoot ([string]$manifest.extractorFile)
    if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
      throw "Bundled 7-Zip extractor missing: $sevenZip"
    }
    $actualExtractorHash = Get-Sha256Hex -Path $sevenZip
    if ([string]$actualExtractorHash -ne [string]$manifest.extractorSha256) {
      throw "Bundled 7-Zip extractor hash mismatch."
    }
    if (Test-Path -LiteralPath $targetRoot) {
      Remove-Item -LiteralPath $targetRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
    & $sevenZip x -y "-o$targetRoot" $payloadArchive | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Bundled payload extraction failed with exit code $LASTEXITCODE."
    }
    [ordered]@{
      bundleId = [string]$manifest.bundleId
      bundleName = [string]$manifest.bundleName
      payloadSha256 = [string]$manifest.payloadSha256
      extractedAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $markerPath -Encoding UTF8
  } else {
    Write-BundleLog "Using existing extracted bundle at $targetRoot"
  }

  if (-not (Test-Path -LiteralPath $codexExe -PathType Leaf)) {
    if ($allowLegacyDesktopFallback -and (Test-Path -LiteralPath $legacyCodexExe -PathType Leaf)) {
      $desktopExecutableName = "Codex.exe"
      $codexExe = $legacyCodexExe
      Write-BundleLog "Using legacy Codex.exe desktop-shell fallback because the manifest predates executable metadata."
    } else {
      throw "Patched desktop executable missing after extraction: $codexExe"
    }
  }

  $appDir = Join-Path $targetRoot "app"
  $resourcesDir = Join-Path $appDir "resources"
  $patchedCodexHome = Join-Path $profileRoot "codex-home"
  $electronUserDataPath = Join-Path $profileRoot "electron-user-data"
  $isolatedSqliteHome = Join-Path $profileRoot "chat-database"
  New-Item `
    -ItemType Directory `
    -Force `
    -Path $patchedCodexHome, $electronUserDataPath, $isolatedSqliteHome | Out-Null

  $shareChatDatabaseWithStock = `
    ($manifest.shareChatDatabaseWithStock -is [bool]) -and `
    [bool]$manifest.shareChatDatabaseWithStock
  $stockCodexHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex"
  $sqliteHome = if ($shareChatDatabaseWithStock) {
    $stockCodexHome
  } else {
    $isolatedSqliteHome
  }

  $launcherConfig = [ordered]@{
    version = 2
    mode = "bundled-self-extracting"
    limit = [int]$manifest.limit
    features = $manifest.features
    featureModules = $manifest.featureModules
    builtAt = [string]$manifest.packagedAt
    bundleId = [string]$manifest.bundleId
    bundleName = [string]$manifest.bundleName
    bundleDataRoot = $bundleDataRoot
    profileRoot = $profileRoot
    sourcePackageDirName = [string]$manifest.sourcePackageDirName
    sourceMode = "bundled-snapshot"
    sourceVersion = [string]$manifest.sourceVersion
    sourceDesktopExecutableName = $desktopExecutableName
    sourceAsarSha256 = [string]$manifest.sourceAsarSha256
    sourceDesktopExeSha256 = [string]$manifest.sourceDesktopExeSha256
    sourceAppServerCliSha256 = [string]$manifest.sourceAppServerCliSha256
    patcherSource = $manifest.patcherSource
    cloneRoot = $targetRoot
    appDir = $appDir
    resourcesDir = $resourcesDir
    codexExe = $codexExe
    catalogShim = [ordered]@{
      enabled = ($manifest.features.catalogShim -eq $true)
      implementation = "lazy-thread-list-cursor-proxy"
      sourceProject = "https://github.com/RyanCraighead/codex-all-chats-shim"
      upstreamCli = (Join-Path $resourcesDir "codex.exe")
      upstreamCliSha256 = [string]$manifest.sourceAppServerCliSha256
      basePort = if ($manifest.catalogShim.basePort) { [int]$manifest.catalogShim.basePort } else { 47851 }
      maxThreads = if ($manifest.catalogShim.maxThreads) { [int]$manifest.catalogShim.maxThreads } else { 10000 }
    }
    codexHome = $patchedCodexHome
    sqliteHome = $sqliteHome
    electronUserDataPath = $electronUserDataPath
    shareChatDatabaseWithStock = $shareChatDatabaseWithStock
    appAsar = (Join-Path $resourcesDir "app.asar")
    originalAppAsarBackup = $null
  }
  $launcherConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $targetRoot "codex-launcher.local.json") -Encoding UTF8

  $runtimePatchManifest = [ordered]@{}
  foreach ($entry in $launcherConfig.GetEnumerator()) {
    $runtimePatchManifest[$entry.Key] = $entry.Value
  }
  $runtimePatchManifest["payloadSha256"] = [string]$manifest.payloadSha256
  $runtimePatchManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $targetRoot "patch-manifest.json") -Encoding UTF8

  $bundledNodeCandidates = @(
    (Join-Path $resourcesDir "cua_node\bin\node.exe"),
    (Join-Path $resourcesDir "node.exe")
  )
  $bundledNode = $bundledNodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $bundledNode) {
    throw "Bundled Codex Node runtime was not found under $resourcesDir."
  }
  $toolsDir = Join-Path $targetRoot "tools"
  $env:CODEX_PATCHED_NODE = $bundledNode
  $env:PATH = @((Split-Path -Parent $bundledNode), $toolsDir, $env:PATH) -join [IO.Path]::PathSeparator
  $env:CODEX_PATCHED_BUNDLE_ROOT = $targetRoot
  $env:CODEX_PATCHED_BUNDLE_DATA_ROOT = $bundleDataRoot
  $env:CODEX_PATCHED_HOME = $patchedCodexHome
  $env:CODEX_HOME = $patchedCodexHome
  $env:CODEX_PATCHED_SQLITE_HOME = $sqliteHome
  $env:CODEX_SQLITE_HOME = $sqliteHome
  $env:CODEX_ELECTRON_USER_DATA_PATH = $electronUserDataPath

  $launchScript = Join-Path $targetRoot "scripts\launch-patched-codex.ps1"
  if (-not (Test-Path -LiteralPath $launchScript)) {
    throw "Launch script missing: $launchScript"
  }

  $powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $powershellExe)) {
    $powershellExe = "powershell.exe"
  }
  Write-BundleLog "Starting bundled patched Codex from $targetRoot with CODEX_HOME=$patchedCodexHome, Electron profile=$electronUserDataPath, SQLite home=$sqliteHome, share stock chat DB=$shareChatDatabaseWithStock"
  Start-Process `
    -FilePath $powershellExe `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launchScript`"" `
    -WorkingDirectory $targetRoot `
    -WindowStyle Hidden
} catch {
  Write-BundleLog "Bundle launch failed: $($_.Exception.Message)"
  throw
}
'@
Write-Utf8NoBom -Path $bootstrapPath -Value $bootstrap
$bootstrapLauncherSource = Join-Path $RepoRoot "assets\portable\bootstrap-launcher.cs"
Build-BootstrapLauncher -SourcePath $bootstrapLauncherSource -OutputPath $bootstrapLauncherPath

Write-Host "Building single bundled exe with 7-Zip SFX."
$sfxTitle = $BundleName.Replace('"', "'")
$sfxConfig = @"
;!@Install@!UTF-8!
Title="$sfxTitle"
GUIMode="2"
RunProgram="bootstrap-launcher.exe"
;!@InstallEnd@!
"@
Write-Utf8NoBom -Path $sevenZipSfxConfigPath -Value $sfxConfig

$sevenZipArgs = @(
  "a",
  "-t7z",
  "-mx=0",
  "-mmt=on",
  $sevenZipArchivePath,
  (Join-Path $sfxRoot "*")
)
$sevenZipResult = Start-Process -FilePath $sevenZip -ArgumentList $sevenZipArgs -NoNewWindow -PassThru -Wait
if ($sevenZipResult.ExitCode -ne 0) {
  throw "7-Zip failed with exit code $($sevenZipResult.ExitCode)."
}

Join-BinaryFiles -OutputPath $outputExe -InputPaths @($sevenZipSfx, $sevenZipSfxConfigPath, $sevenZipArchivePath)
if (-not (Test-Path -LiteralPath $outputExe)) {
  throw "7-Zip SFX build reported success but output exe was not created: $outputExe"
}

$outputInfo = Get-Item -LiteralPath $outputExe
$payloadInfo = Get-Item -LiteralPath $payloadArchive
$result = [ordered]@{
  ok = $true
  outputExe = $outputInfo.FullName
  outputSizeMB = [math]::Round($outputInfo.Length / 1MB, 1)
  payloadArchive = $payloadInfo.FullName
  payloadSizeMB = [math]::Round($payloadInfo.Length / 1MB, 1)
  bundleId = $bundleId
  bundleDataRoot = if ($BundleDataRoot) { $BundleDataRoot } else { $null }
  outputDirectory = $OutputDirectory
  sourceVersion = $version
  sourceDesktopExecutableName = Split-Path -Leaf $sourceCodexExe
  shareChatDatabaseWithStock = $shareChatDatabaseWithStock
  sfxMode = "7zip"
  profileMode = "isolated-per-bundle"
}

if (-not $KeepWork) {
  Remove-Item -LiteralPath $workRoot -Recurse -Force
  $result.payloadArchive = $null
}

$result | ConvertTo-Json -Depth 8
