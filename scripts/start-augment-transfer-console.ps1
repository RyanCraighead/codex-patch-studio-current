param(
  [int]$Port = 4577,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutLog = Join-Path $RepoRoot "viewer\viewer.out.log"
$ErrLog = Join-Path $RepoRoot "viewer\viewer.err.log"

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Remove-Item -LiteralPath $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath "node" `
    -ArgumentList @("viewer\server.cjs", [string]$Port) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog
  Start-Sleep -Seconds 1
}

$url = "http://127.0.0.1:$Port"
if (-not $NoBrowser) {
  Start-Process $url
}

Write-Output $url
