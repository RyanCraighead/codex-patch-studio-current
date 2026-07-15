param(
  [switch]$ForceRebuild,
  [ValidateSet("off", "notify", "auto")]
  [string]$UpdatePolicy = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$localConfigPath = Join-Path $RepoRoot "config\patcher.local.json"

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

function Select-UpdatePolicy {
  param([string]$RequestedPolicy, [System.Collections.IDictionary]$LocalConfig)

  if ($RequestedPolicy) {
    return $RequestedPolicy
  }
  $existing = ([string]$LocalConfig["updatePolicy"]).Trim().ToLowerInvariant()
  if ($existing -in @("off", "notify", "auto") -and $LocalConfig["updatePolicyConfigured"] -eq $true) {
    return $existing
  }
  if ($env:CI -or [Console]::IsInputRedirected) {
    return "notify"
  }

  $choices = @(
    [System.Management.Automation.Host.ChoiceDescription]::new("&Notify (recommended)", "Check on launch and ask before rebuilding."),
    [System.Management.Automation.Host.ChoiceDescription]::new("&Auto rebuild", "Check, validate, and rebuild automatically."),
    [System.Management.Automation.Host.ChoiceDescription]::new("&Off", "Do not check for installed Codex updates on launch.")
  )
  $selection = $Host.UI.PromptForChoice(
    "Codex update policy",
    "Codex updates can invalidate patch anchors. Choose how Codex Patch Studio should handle installed Codex updates.",
    $choices,
    0
  )
  return @("notify", "auto", "off")[$selection]
}

$localConfig = Read-LocalConfig
$resolvedUpdatePolicy = Select-UpdatePolicy -RequestedPolicy $UpdatePolicy -LocalConfig $localConfig
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
