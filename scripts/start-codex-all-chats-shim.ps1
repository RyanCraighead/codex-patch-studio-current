[CmdletBinding()]
param(
  [string]$LauncherConfigPath = "",
  [string]$CodexHome = "",
  [string]$SqliteHome = "",
  [int]$BasePort = 0,
  [int]$PortRange = 50
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $LauncherConfigPath) {
  $LauncherConfigPath = if ($env:CODEX_PATCHED_LAUNCHER_CONFIG) {
    $env:CODEX_PATCHED_LAUNCHER_CONFIG
  } else {
    Join-Path $RepoRoot "codex-launcher.local.json"
  }
}
if (-not (Test-Path -LiteralPath $LauncherConfigPath -PathType Leaf)) {
  throw "Catalog shim launcher configuration is missing: $LauncherConfigPath"
}

function Read-JsonObject {
  param([string]$Path)
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToUpperInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-Health {
  param([int]$Port)
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -UseBasicParsing -TimeoutSec 1
  } catch {
    return $null
  }
}

function Test-PathEqual {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  return [System.IO.Path]::GetFullPath($Left).Equals(
    [System.IO.Path]::GetFullPath($Right),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-MatchingHealth {
  param([object]$Health, [string]$ExpectedHash, [string]$ExpectedHome, [string]$ExpectedSqliteHome)
  return (
    $null -ne $Health -and
    [string]$Health.service -eq "codex-all-chats-shim" -and
    [string]$Health.upstreamCliSha256 -eq $ExpectedHash -and
    (Test-PathEqual -Left ([string]$Health.codexHome) -Right $ExpectedHome) -and
    (Test-PathEqual -Left ([string]$Health.sqliteHome) -Right $ExpectedSqliteHome)
  )
}

function Test-PortListening {
  param([int]$Port)
  return $null -ne (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

$launcher = Read-JsonObject -Path $LauncherConfigPath
$projectConfigPath = Join-Path $RepoRoot "config\patcher.json"
$projectConfig = if (Test-Path -LiteralPath $projectConfigPath) { Read-JsonObject -Path $projectConfigPath } else { [pscustomobject]@{} }

if (-not $CodexHome) {
  $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } elseif ($launcher.codexHome) { [string]$launcher.codexHome } else { Join-Path $env:USERPROFILE ".codex" }
}
if (-not $SqliteHome) {
  $SqliteHome = if ($env:CODEX_SQLITE_HOME) { $env:CODEX_SQLITE_HOME } elseif ($launcher.sqliteHome) { [string]$launcher.sqliteHome } else { $CodexHome }
}
$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$SqliteHome = [System.IO.Path]::GetFullPath($SqliteHome)

$upstreamCli = if ($launcher.catalogShim.upstreamCli) {
  [string]$launcher.catalogShim.upstreamCli
} elseif ($launcher.resourcesDir) {
  Join-Path ([string]$launcher.resourcesDir) "codex.exe"
} else {
  Join-Path (Join-Path ([string]$launcher.appDir) "resources") "codex.exe"
}
if (-not (Test-Path -LiteralPath $upstreamCli -PathType Leaf)) {
  throw "Catalog shim upstream Codex CLI is missing: $upstreamCli"
}
$upstreamCli = (Resolve-Path -LiteralPath $upstreamCli).Path
$actualHash = Get-Sha256Hex -Path $upstreamCli
$expectedHash = if ($launcher.catalogShim.upstreamCliSha256) {
  ([string]$launcher.catalogShim.upstreamCliSha256).ToUpperInvariant()
} else {
  $actualHash
}
if ($actualHash -ne $expectedHash) {
  throw "Catalog shim upstream Codex CLI hash mismatch. Expected $expectedHash but found $actualHash."
}

$maxThreads = if ($launcher.catalogShim.maxThreads) {
  [int]$launcher.catalogShim.maxThreads
} elseif ($projectConfig.catalogShimMaxThreads) {
  [int]$projectConfig.catalogShimMaxThreads
} else {
  10000
}
if ($BasePort -le 0) {
  $BasePort = if ($projectConfig.catalogShimPort) { [int]$projectConfig.catalogShimPort } else { 47851 }
}
if ($BasePort -lt 1 -or $BasePort -gt 65535 -or $PortRange -lt 1 -or ($BasePort + $PortRange - 1) -gt 65535) {
  throw "Invalid catalog shim port range: $BasePort through $($BasePort + $PortRange - 1)."
}

$selectedPort = $null
for ($port = $BasePort; $port -lt ($BasePort + $PortRange); $port++) {
  $health = Get-Health -Port $port
  if (Test-MatchingHealth -Health $health -ExpectedHash $expectedHash -ExpectedHome $CodexHome -ExpectedSqliteHome $SqliteHome) {
    [pscustomobject]@{
      ok = $true
      reused = $true
      pid = [int]$health.pid
      port = $port
      wsPath = [string]$health.wsPath
      wsUrl = "ws://127.0.0.1:$port$([string]$health.wsPath)"
      healthUrl = "http://127.0.0.1:$port/health"
      codexHome = $CodexHome
      sqliteHome = $SqliteHome
      upstreamCli = $upstreamCli
      upstreamCliSha256 = $expectedHash
      maxThreads = $maxThreads
    } | ConvertTo-Json -Depth 5
    return
  }
  if (-not (Test-PortListening -Port $port)) {
    $selectedPort = $port
    break
  }
}
if ($null -eq $selectedPort) {
  throw "No free catalog shim port was found from $BasePort through $($BasePort + $PortRange - 1)."
}

$shimScript = Join-Path $RepoRoot "scripts\codex-all-chats-shim.cjs"
if (-not (Test-Path -LiteralPath $shimScript -PathType Leaf)) {
  throw "Catalog shim runtime is missing: $shimScript"
}
$node = if ($env:CODEX_PATCHED_NODE -and (Test-Path -LiteralPath $env:CODEX_PATCHED_NODE -PathType Leaf)) {
  (Resolve-Path -LiteralPath $env:CODEX_PATCHED_NODE).Path
} else {
  @(
    (Join-Path ([string]$launcher.resourcesDir) "cua_node\bin\node.exe"),
    (Join-Path ([string]$launcher.resourcesDir) "node.exe"),
    [string](Get-Command node.exe -ErrorAction SilentlyContinue).Source,
    [string](Get-Command node -ErrorAction SilentlyContinue).Source
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $node) {
  throw "A Node.js runtime was not found for the catalog shim."
}

$tokenBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($tokenBytes)
} finally {
  $random.Dispose()
}
$token = -join ($tokenBytes | ForEach-Object { $_.ToString("x2") })
$logDir = Join-Path $RepoRoot "codex-launch-debug\catalog-shim"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "catalog-shim-$selectedPort.log"

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '"' + $shimScript.Replace('"', '\"') + '"'
$startInfo.WorkingDirectory = $RepoRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.Environment["CODEX_CATALOG_SHIM_CODEX_HOME"] = $CodexHome
$startInfo.Environment["CODEX_CATALOG_SHIM_SQLITE_HOME"] = $SqliteHome
$startInfo.Environment["CODEX_CATALOG_SHIM_UPSTREAM_CLI"] = $upstreamCli
$startInfo.Environment["CODEX_CATALOG_SHIM_EXPECTED_CLI_SHA256"] = $expectedHash
$startInfo.Environment["CODEX_CATALOG_SHIM_HOST"] = "127.0.0.1"
$startInfo.Environment["CODEX_CATALOG_SHIM_PORT"] = [string]$selectedPort
$startInfo.Environment["CODEX_CATALOG_SHIM_MAX_THREADS"] = [string]$maxThreads
$startInfo.Environment["CODEX_CATALOG_SHIM_TOKEN"] = $token
$startInfo.Environment["CODEX_CATALOG_SHIM_LOG"] = $logPath
$startInfo.Environment["CODEX_CATALOG_SHIM_QUIET"] = "1"
$process = [System.Diagnostics.Process]::Start($startInfo)

$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  Start-Sleep -Milliseconds 200
  $health = Get-Health -Port $selectedPort
  if (Test-MatchingHealth -Health $health -ExpectedHash $expectedHash -ExpectedHome $CodexHome -ExpectedSqliteHome $SqliteHome) {
    [pscustomobject]@{
      ok = $true
      reused = $false
      pid = [int]$health.pid
      port = $selectedPort
      wsPath = [string]$health.wsPath
      wsUrl = "ws://127.0.0.1:$selectedPort$([string]$health.wsPath)"
      healthUrl = "http://127.0.0.1:$selectedPort/health"
      codexHome = $CodexHome
      sqliteHome = $SqliteHome
      upstreamCli = $upstreamCli
      upstreamCliSha256 = $expectedHash
      maxThreads = $maxThreads
      logPath = $logPath
    } | ConvertTo-Json -Depth 5
    return
  }
} while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited)

$tail = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Tail 30) -join [Environment]::NewLine } else { "No shim log was created." }
throw "Catalog shim failed to start on port $selectedPort.`n$tail"
