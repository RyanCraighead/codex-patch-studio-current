param(
  [int]$Port = 4577
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ViewerScript = Join-Path $RepoRoot "viewer\server.cjs"
$LogDir = Join-Path $RepoRoot "codex-import-results\import-manager"
$OutLog = Join-Path $LogDir "server.out.log"
$ErrLog = Join-Path $LogDir "server.err.log"

function Get-ImportManagerHealth {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
  } catch {
    return $null
  }
}

function Stop-StaleImportManager {
  $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      continue
    }
    $commandLine = [string]$process.CommandLine
    if ($commandLine -like "*viewer/server.cjs*" -or $commandLine -like "*viewer\server.cjs*") {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not (Test-Path -LiteralPath $ViewerScript)) {
  throw "Codex import manager server not found: $ViewerScript"
}

if (Get-ImportManagerHealth) {
  return
}

Stop-StaleImportManager
Start-Sleep -Milliseconds 250

$healthAfterStop = Get-ImportManagerHealth
if ($healthAfterStop) {
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
  -ArgumentList "`"$ViewerScript`" $Port" `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog | Out-Null

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  if (Get-ImportManagerHealth) {
    return
  }
}

throw "Codex import manager did not start on http://127.0.0.1:$Port. Check $OutLog and $ErrLog."
