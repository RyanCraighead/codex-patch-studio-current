param(
  [int]$DeepSeekPort = 47731,
  [int]$ZaiPort = 47732,
  [int]$DashScopePort = 47733,
  [int]$CerebrasPort = 47734
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ProxyScript = Join-Path $RepoRoot "scripts\codex-responses-chat-proxy.cjs"
$LogPath = Join-Path $RepoRoot "codex-provider-proxy.log"
$ModelCacheDir = Join-Path $RepoRoot "codex-provider-model-cache"

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

function Get-ProviderProxyHealth {
  param([string]$Url)
  try {
    return Invoke-RestMethod -Uri $Url -UseBasicParsing -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-ProviderProxyReady {
  param(
    [string]$Provider,
    [int]$Port,
    [string]$ExpectedSourceSha256,
    [string]$ExpectedRuntimeRoot
  )
  $health = Get-ProviderProxyHealth "http://127.0.0.1:$Port/health"
  return (
    $null -ne $health -and
    $health.ok -eq $true -and
    $health.provider -eq $Provider -and
    [string]$health.sourceSha256 -eq $ExpectedSourceSha256 -and
    [string]$health.runtimeRoot -and
    [System.IO.Path]::GetFullPath([string]$health.runtimeRoot).TrimEnd('\') -ieq
      [System.IO.Path]::GetFullPath($ExpectedRuntimeRoot).TrimEnd('\') -and
    $null -ne $health.features -and
    $health.features.envAdmin -eq $true -and
    $health.features.modelReasoningProfiles -eq $true -and
    [long]$health.features.modelReasoningProfilesVersion -ge 2 -and
    [long]$health.features.bodyLimitBytes -ge 1048576
  )
}

function Stop-StaleProviderProxy {
  param([int]$Port)
  $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      continue
    }
    $commandLine = [string]$process.CommandLine
    if ($commandLine -like "*codex-responses-chat-proxy.cjs*") {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-ResponsesProxy {
  param(
    [string]$Provider,
    [int]$Port,
    [string]$EnvKey
  )

  if (Test-ProviderProxyReady -Provider $Provider -Port $Port -ExpectedSourceSha256 $script:ExpectedProxySourceSha256 -ExpectedRuntimeRoot $RepoRoot) {
    return
  }

  Stop-StaleProviderProxy -Port $Port
  Start-Sleep -Milliseconds 250

  $bundledNode = Join-Path $RepoRoot "app\resources\node.exe"
  $node = if ($env:CODEX_PATCHED_NODE -and (Test-Path -LiteralPath $env:CODEX_PATCHED_NODE)) {
    $env:CODEX_PATCHED_NODE
  } elseif (Test-Path -LiteralPath $bundledNode) {
    $bundledNode
  } else {
    "node"
  }
  $env:CODEX_PROXY_PROVIDER = $Provider
  $env:CODEX_PROXY_PORT = [string]$Port
  $env:CODEX_PROXY_LOG = $LogPath
  $env:CODEX_PROVIDER_MODEL_CACHE_DIR = $ModelCacheDir

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $node
  $startInfo.Arguments = "`"$ProxyScript`""
  $startInfo.WorkingDirectory = $RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.Environment["CODEX_PROXY_PROVIDER"] = $Provider
  $startInfo.Environment["CODEX_PROXY_PORT"] = [string]$Port
  $startInfo.Environment["CODEX_PROXY_LOG"] = $LogPath
  $startInfo.Environment["CODEX_PROVIDER_MODEL_CACHE_DIR"] = $ModelCacheDir
  $existingKey = [Environment]::GetEnvironmentVariable($EnvKey, "Process")
  if (-not $existingKey) {
    $existingKey = [Environment]::GetEnvironmentVariable($EnvKey, "User")
  }
  if ($existingKey) {
    $startInfo.Environment[$EnvKey] = $existingKey
  }
  $baseUrlKey = if ($EnvKey -match "_API_KEY$") {
    $EnvKey -replace "_API_KEY$", "_BASE_URL"
  } else {
    "$($Provider.ToUpperInvariant())_BASE_URL"
  }
  $baseUrl = [Environment]::GetEnvironmentVariable($baseUrlKey, "Process")
  if (-not $baseUrl) {
    $baseUrl = [Environment]::GetEnvironmentVariable($baseUrlKey, "User")
  }
  if ($baseUrl) {
    $startInfo.Environment[$baseUrlKey] = $baseUrl
  }

  [System.Diagnostics.Process]::Start($startInfo) | Out-Null

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-ProviderProxyReady -Provider $Provider -Port $Port -ExpectedSourceSha256 $script:ExpectedProxySourceSha256 -ExpectedRuntimeRoot $RepoRoot) {
      return
    }
  }

  throw "$Provider Responses proxy did not start on http://127.0.0.1:$Port. See $LogPath"
}

if (-not (Test-Path -LiteralPath $ProxyScript -PathType Leaf)) {
  throw "Provider proxy runtime is missing: $ProxyScript"
}
$script:ExpectedProxySourceSha256 = Get-Sha256Hex -Path $ProxyScript

Start-ResponsesProxy -Provider "deepseek" -Port $DeepSeekPort -EnvKey "DEEPSEEK_API_KEY"
Start-ResponsesProxy -Provider "zai" -Port $ZaiPort -EnvKey "ZAI_API_KEY"
Start-ResponsesProxy -Provider "dashscope" -Port $DashScopePort -EnvKey "DASHSCOPE_API_KEY"
Start-ResponsesProxy -Provider "cerebras" -Port $CerebrasPort -EnvKey "CEREBRAS_API_KEY"
