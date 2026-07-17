param(
  [int]$Port = 4590
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PatchManagerScript = Join-Path $RepoRoot "codex-viewer\server.cjs"
$LogDir = Join-Path $RepoRoot "codex-patch-jobs\patch-manager"
$OutLog = Join-Path $LogDir "server.out.log"
$ErrLog = Join-Path $LogDir "server.err.log"

function Get-PatchManagerHealth {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/patch/status" -UseBasicParsing -TimeoutSec 2
  } catch {
    return $null
  }
}

function Stop-StalePatchManager {
  $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      continue
    }
    $commandLine = [string]$process.CommandLine
    if ($commandLine -like "*codex-viewer/server.cjs*" -or $commandLine -like "*codex-viewer\server.cjs*") {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not (Test-Path -LiteralPath $PatchManagerScript)) {
  throw "Codex patch manager server not found: $PatchManagerScript"
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

$expectedSourceSha256 = Get-Sha256Hex -Path $PatchManagerScript
$currentHealth = Get-PatchManagerHealth
if (
  $currentHealth -and
  ([string]$currentHealth.patchManagerSourceSha256).ToLowerInvariant() -eq $expectedSourceSha256 -and
  [string]$currentHealth.runtimePaths.repoRoot -and
  [System.IO.Path]::GetFullPath([string]$currentHealth.runtimePaths.repoRoot).TrimEnd('\') -ieq
    [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
) {
  return
}

Stop-StalePatchManager
Start-Sleep -Milliseconds 250

$currentHealth = Get-PatchManagerHealth
if (
  $currentHealth -and
  ([string]$currentHealth.patchManagerSourceSha256).ToLowerInvariant() -eq $expectedSourceSha256 -and
  [string]$currentHealth.runtimePaths.repoRoot -and
  [System.IO.Path]::GetFullPath([string]$currentHealth.runtimePaths.repoRoot).TrimEnd('\') -ieq
    [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
) {
  return
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$bundledNode = Join-Path $RepoRoot "app\resources\node.exe"
$node = if ($env:CODEX_PATCHED_NODE -and (Test-Path -LiteralPath $env:CODEX_PATCHED_NODE)) {
  $env:CODEX_PATCHED_NODE
} elseif (Test-Path -LiteralPath $bundledNode) {
  $bundledNode
} else {
  "node"
}

Start-Process `
  -FilePath $node `
  -ArgumentList "`"$PatchManagerScript`" $Port" `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog | Out-Null

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  if (Get-PatchManagerHealth) {
    return
  }
}

throw "Codex patch manager did not start on http://127.0.0.1:$Port. Check $OutLog and $ErrLog."
