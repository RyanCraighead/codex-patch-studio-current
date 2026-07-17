param(
  [switch]$ForceRebuild,
  [ValidateSet("off", "notify", "auto")]
  [string]$UpdatePolicy = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$localConfigPath = Join-Path $RepoRoot "config\patcher.local.json"
Import-Module (Join-Path $PSScriptRoot "codex-update-policy.psm1") -Force

function Read-LocalConfig {
  if (-not (Test-Path -LiteralPath $localConfigPath)) {
    return [ordered]@{}
  }
  $value = Get-Content -LiteralPath $localConfigPath -Raw | ConvertFrom-Json
  $result = [ordered]@{}
  foreach ($property in $value.PSObject.Properties) {
    $result[$property.Name] = $property.Value
  }
  return $result
}

$localConfig = Read-LocalConfig
$resolvedUpdatePolicy = Select-CodexUpdatePolicy `
  -RequestedPolicy $UpdatePolicy `
  -LocalConfig $localConfig `
  -NonInteractive:([bool]($env:CI -or [Console]::IsInputRedirected))
$localConfig["updatePolicy"] = $resolvedUpdatePolicy
$localConfig["updatePolicyConfigured"] = $true
$localConfig["autoRebuildOnLaunch"] = $resolvedUpdatePolicy -eq "auto"
$localConfigJson = ($localConfig | ConvertTo-Json -Depth 20) + [Environment]::NewLine
[System.IO.File]::WriteAllText(
  $localConfigPath,
  $localConfigJson,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Codex update policy: $resolvedUpdatePolicy"

$ensureArgs = @{}
if ($ForceRebuild) {
  $ensureArgs.Force = $true
}
$ensureJson = & (Join-Path $PSScriptRoot "ensure-current-codex-patch.ps1") @ensureArgs
$ensure = $ensureJson | ConvertFrom-Json
if (-not $ensure.ok) {
  throw "Current Codex patch setup failed."
}

$baseConfig = Get-Content -LiteralPath (Join-Path $RepoRoot "config\patcher.json") -Raw | ConvertFrom-Json
$shortcutName = if ($baseConfig.shortcutName) { [string]$baseConfig.shortcutName } else { "Codex Patch Studio Current" }
$shortcutJson = & (Join-Path $PSScriptRoot "create-patched-codex-shortcut.ps1") `
  -ShortcutName $shortcutName `
  -IconPath ([string]$ensure.codexExe) `
  -WorkingDirectory $RepoRoot
$shortcut = $shortcutJson | ConvertFrom-Json

[pscustomobject]@{
  ok = $true
  installedVersion = $ensure.installedVersion
  rebuilt = $ensure.rebuilt
  codexExe = $ensure.codexExe
  shortcutPath = $shortcut.ShortcutPath
  updatePolicy = $resolvedUpdatePolicy
} | ConvertTo-Json -Depth 4
