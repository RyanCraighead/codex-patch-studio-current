param(
  [string]$SourceCodexHome = "$env:USERPROFILE\.codex",
  [string]$PatchedCodexHome = "$env:USERPROFILE\.codex-patch-studio-current",
  [string]$SharedSqliteHome = "",
  [switch]$RefreshConfig
)

$ErrorActionPreference = "Stop"

function Convert-ToTomlLiteralString {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Set-OrAddTopLevelTomlValue {
  param(
    [string]$Text,
    [string]$Key,
    [string]$Value
  )

  $line = "$Key = $Value"
  $pattern = "(?m)^$([regex]::Escape($Key))\s*=.*$"
  if ($Text -match $pattern) {
    return [regex]::Replace($Text, $pattern, $line, 1)
  }

  $firstTable = [regex]::Match($Text, "(?m)^\[")
  if ($firstTable.Success) {
    return $Text.Insert($firstTable.Index, "$line`r`n")
  }

  if ($Text.EndsWith("`n")) {
    return "$Text$line`r`n"
  }
  return "$Text`r`n$line`r`n"
}

function Remove-TomlTable {
  param(
    [string]$Text,
    [string]$TableName
  )

  $escaped = [regex]::Escape($TableName)
  return [regex]::Replace($Text, "(?ms)^\[$escaped\]\s*.*?(?=^\[|\z)", "")
}

function Set-OrAddTomlTableValue {
  param(
    [string]$Text,
    [string]$TableName,
    [string]$Key,
    [string]$Value
  )

  $headerPattern = "(?m)^\[$([regex]::Escape($TableName))\]\s*$"
  $headerMatch = [regex]::Match($Text, $headerPattern)
  $line = "$Key = $Value"
  if (-not $headerMatch.Success) {
    $suffix = if ($Text.EndsWith("`n")) { "" } else { "`r`n" }
    return "$Text$suffix`r`n[$TableName]`r`n$line`r`n"
  }

  $tableStart = $headerMatch.Index + $headerMatch.Length
  $nextTableMatch = [regex]::Match($Text.Substring($tableStart), "(?m)^\[")
  $tableEnd = if ($nextTableMatch.Success) { $tableStart + $nextTableMatch.Index } else { $Text.Length }
  $before = $Text.Substring(0, $tableStart)
  $tableBody = $Text.Substring($tableStart, $tableEnd - $tableStart)
  $after = $Text.Substring($tableEnd)

  $keyPattern = "(?m)^$([regex]::Escape($Key))\s*=.*$"
  if ($tableBody -match $keyPattern) {
    $tableBody = [regex]::Replace($tableBody, $keyPattern, $line, 1)
  } else {
    if (-not $tableBody.EndsWith("`n")) {
      $tableBody += "`r`n"
    }
    $tableBody += "$line`r`n"
  }

  return "$before$tableBody$after"
}

function Ensure-DirectoryJunction {
  param(
    [string]$Path,
    [string]$Target
  )

  if (-not (Test-Path -LiteralPath $Target)) {
    return
  }

  if (Test-Path -LiteralPath $Path) {
    return
  }

  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

function Ensure-FileHardLinkOrCopy {
  param(
    [string]$Path,
    [string]$Target,
    [switch]$ReplaceExisting,
    [switch]$ReplaceEmpty
  )

  if (-not (Test-Path -LiteralPath $Target)) {
    return
  }

  if (Test-Path -LiteralPath $Path) {
    $pathInfo = Get-Item -LiteralPath $Path
    $targetInfo = Get-Item -LiteralPath $Target
    $shouldReplace = $ReplaceExisting -or ($ReplaceEmpty -and $targetInfo.Length -gt 0 -and $pathInfo.Length -eq 0)
    if (-not $shouldReplace) {
      return
    }
    Remove-Item -LiteralPath $Path -Force
  }

  try {
    New-Item -ItemType HardLink -Path $Path -Target $Target | Out-Null
  } catch {
    Copy-Item -LiteralPath $Target -Destination $Path -Force
  }
}

function Copy-FileIfMissingOrNewer {
  param(
    [string]$Path,
    [string]$Target
  )

  if (-not (Test-Path -LiteralPath $Target)) {
    return
  }

  $shouldCopy = -not (Test-Path -LiteralPath $Path)
  if (-not $shouldCopy) {
    $sourceInfo = Get-Item -LiteralPath $Target
    $destInfo = Get-Item -LiteralPath $Path
    $shouldCopy = $sourceInfo.LastWriteTimeUtc -gt $destInfo.LastWriteTimeUtc
  }

  if ($shouldCopy) {
    Copy-Item -LiteralPath $Target -Destination $Path -Force
  }
}

function Copy-FileAlways {
  param(
    [string]$Path,
    [string]$Target
  )

  if (-not (Test-Path -LiteralPath $Target)) {
    return
  }

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }

  Copy-Item -LiteralPath $Target -Destination $Path -Force
}

New-Item -ItemType Directory -Force -Path $SourceCodexHome | Out-Null
$SourceCodexHome = (Resolve-Path -LiteralPath $SourceCodexHome).Path
if (-not $SharedSqliteHome) {
  $SharedSqliteHome = $SourceCodexHome
}
New-Item -ItemType Directory -Force -Path $SharedSqliteHome | Out-Null
$SharedSqliteHome = (Resolve-Path -LiteralPath $SharedSqliteHome).Path

New-Item -ItemType Directory -Force -Path $PatchedCodexHome | Out-Null
$PatchedCodexHome = (Resolve-Path -LiteralPath $PatchedCodexHome).Path

$sourceConfig = Join-Path $SourceCodexHome "config.toml"
$patchedConfig = Join-Path $PatchedCodexHome "config.toml"
if ($RefreshConfig -or -not (Test-Path -LiteralPath $patchedConfig)) {
  $configText = if (Test-Path -LiteralPath $sourceConfig) {
    Get-Content -LiteralPath $sourceConfig -Raw
  } else {
    ""
  }
  $configText = Set-OrAddTopLevelTomlValue -Text $configText -Key "sqlite_home" -Value (Convert-ToTomlLiteralString $SharedSqliteHome)
  $configText = [regex]::Replace(
    $configText,
    "(?m)^CODEX_HOME\s*=\s*(['""]).*?\1\s*$",
    "CODEX_HOME = $(Convert-ToTomlLiteralString $PatchedCodexHome)"
  )

  if ($configText -notmatch "(?m)^\[model_providers\.deepseek\]\s*$") {
    $configText = $configText.TrimEnd() + @"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:47731"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
"@ + "`r`n"
  }

  if ($configText -notmatch "(?m)^\[model_providers\.zai\]\s*$") {
    $configText = $configText.TrimEnd() + @"

[model_providers.zai]
name = "Z.ai"
base_url = "http://127.0.0.1:47732"
wire_api = "responses"
env_key = "ZAI_API_KEY"
"@ + "`r`n"
  }

  if ($configText -notmatch "(?m)^\[model_providers\.dashscope\]\s*$") {
    $configText = $configText.TrimEnd() + @"

[model_providers.dashscope]
name = "Alibaba Qwen"
base_url = "http://127.0.0.1:47733"
wire_api = "responses"
env_key = "DASHSCOPE_API_KEY"
"@ + "`r`n"
  }

  if ($configText -notmatch "(?m)^\[model_providers\.cerebras\]\s*$") {
    $configText = $configText.TrimEnd() + @"

[model_providers.cerebras]
name = "Cerebras"
base_url = "http://127.0.0.1:47734"
wire_api = "responses"
env_key = "CEREBRAS_API_KEY"
"@ + "`r`n"
  }

  Set-Content -LiteralPath $patchedConfig -Value $configText -Encoding UTF8
}

$configText = Get-Content -LiteralPath $patchedConfig -Raw
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.deepseek" `
  -Key "name" `
  -Value '"DeepSeek"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.deepseek" `
  -Key "base_url" `
  -Value '"http://127.0.0.1:47731"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.deepseek" `
  -Key "wire_api" `
  -Value '"responses"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.deepseek" `
  -Key "env_key" `
  -Value '"DEEPSEEK_API_KEY"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.zai" `
  -Key "name" `
  -Value '"Z.ai"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.zai" `
  -Key "base_url" `
  -Value '"http://127.0.0.1:47732"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.zai" `
  -Key "wire_api" `
  -Value '"responses"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.zai" `
  -Key "env_key" `
  -Value '"ZAI_API_KEY"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.dashscope" `
  -Key "name" `
  -Value '"Alibaba Qwen"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.dashscope" `
  -Key "base_url" `
  -Value '"http://127.0.0.1:47733"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.dashscope" `
  -Key "wire_api" `
  -Value '"responses"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.dashscope" `
  -Key "env_key" `
  -Value '"DASHSCOPE_API_KEY"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.cerebras" `
  -Key "name" `
  -Value '"Cerebras"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.cerebras" `
  -Key "base_url" `
  -Value '"http://127.0.0.1:47734"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.cerebras" `
  -Key "wire_api" `
  -Value '"responses"'
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "model_providers.cerebras" `
  -Key "env_key" `
  -Value '"CEREBRAS_API_KEY"'
$trustedCodePaths = @($PatchedCodexHome, $SourceCodexHome) -join [IO.Path]::PathSeparator
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "mcp_servers.node_repl.env" `
  -Key "CODEX_HOME" `
  -Value (Convert-ToTomlLiteralString $PatchedCodexHome)
$configText = Set-OrAddTomlTableValue `
  -Text $configText `
  -TableName "mcp_servers.node_repl.env" `
  -Key "NODE_REPL_TRUSTED_CODE_PATHS" `
  -Value (Convert-ToTomlLiteralString $trustedCodePaths)
Set-Content -LiteralPath $patchedConfig -Value $configText -Encoding UTF8

Copy-FileIfMissingOrNewer -Path (Join-Path $PatchedCodexHome "auth.json") -Target (Join-Path $SourceCodexHome "auth.json")
Copy-FileIfMissingOrNewer -Path (Join-Path $PatchedCodexHome "AGENTS.md") -Target (Join-Path $SourceCodexHome "AGENTS.md")
Copy-FileIfMissingOrNewer -Path (Join-Path $PatchedCodexHome "installation_id") -Target (Join-Path $SourceCodexHome "installation_id")
Copy-FileIfMissingOrNewer -Path (Join-Path $PatchedCodexHome "version.json") -Target (Join-Path $SourceCodexHome "version.json")

# Native sidebar visibility is stored here, and Codex rewrites the source file
# atomically, which can break hardlinks. Copy it fresh on every patched launch.
Copy-FileAlways -Path (Join-Path $PatchedCodexHome ".codex-global-state.json") -Target (Join-Path $SourceCodexHome ".codex-global-state.json")

foreach ($dirName in @(
  ".sandbox",
  ".sandbox-bin",
  ".sandbox-secrets",
  "sessions",
  "attachments",
  "archived_sessions",
  "plugins",
  "skills",
  "rules",
  "automations",
  "browser",
  "computer-use",
  "generated_images",
  "vendor_imports"
)) {
  Ensure-DirectoryJunction -Path (Join-Path $PatchedCodexHome $dirName) -Target (Join-Path $SourceCodexHome $dirName)
}

foreach ($dirName in @(
  "node_repl",
  "node_repl\active_execs",
  "node_repl\assets",
  "node_repl\kernels",
  "node_repl\tmp"
)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $PatchedCodexHome $dirName) | Out-Null
}

foreach ($fileName in @(
  "state_5.sqlite",
  "state_5.sqlite-wal",
  "state_5.sqlite-shm"
)) {
  Ensure-FileHardLinkOrCopy -Path (Join-Path $PatchedCodexHome $fileName) -Target (Join-Path $SharedSqliteHome $fileName) -ReplaceExisting
}

foreach ($fileName in @(
  ".codex-global-state.json.bak",
  "cap_sid",
  "sandbox.log",
  "session_index.jsonl",
  "history.jsonl",
  "chrome-native-hosts.json",
  "chrome-native-hosts-v2.json"
)) {
  Ensure-FileHardLinkOrCopy -Path (Join-Path $PatchedCodexHome $fileName) -Target (Join-Path $SourceCodexHome $fileName)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$managedAgentTemplateDir = Join-Path $repoRoot "native-patches\agents"
$patchedAgentsDir = Join-Path $PatchedCodexHome "agents"
New-Item -ItemType Directory -Force -Path $patchedAgentsDir | Out-Null
if (Test-Path -LiteralPath $managedAgentTemplateDir) {
  Get-ChildItem -LiteralPath $managedAgentTemplateDir -Filter "*.toml" -File | ForEach-Object {
    Copy-FileIfMissingOrNewer -Path (Join-Path $patchedAgentsDir $_.Name) -Target $_.FullName
  }
}

[pscustomobject]@{
  patchedCodexHome = $PatchedCodexHome
  sourceCodexHome = $SourceCodexHome
  sharedSqliteHome = $SharedSqliteHome
  patchedConfig = $patchedConfig
  patchedAgentsDir = $patchedAgentsDir
} | ConvertTo-Json -Depth 3
