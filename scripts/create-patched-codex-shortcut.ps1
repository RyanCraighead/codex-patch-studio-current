param(
  [string]$ShortcutName = "Codex Patch Studio Current",
  [string]$ShortcutDirectory = "",
  [string]$LauncherScript = "",
  [string]$IconPath = "",
  [string]$WorkingDirectory = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $ShortcutDirectory) {
  $ShortcutDirectory = [Environment]::GetFolderPath("Desktop")
}
if (-not $ShortcutDirectory) {
  $ShortcutDirectory = Join-Path $env:USERPROFILE "Desktop"
}
if (-not $LauncherScript) {
  $LauncherScript = Join-Path $PSScriptRoot "launch-patched-codex.ps1"
}
if (-not $WorkingDirectory) {
  $WorkingDirectory = $RepoRoot
}

$configPath = Join-Path $RepoRoot "codex-launcher.local.json"
if (-not $IconPath -and (Test-Path -LiteralPath $configPath)) {
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.codexExe -and (Test-Path -LiteralPath $config.codexExe)) {
      $IconPath = [string]$config.codexExe
    }
  } catch {
    # A shortcut can still be created without a custom icon.
  }
}

if (-not (Test-Path -LiteralPath $LauncherScript)) {
  throw "Launcher script not found: $LauncherScript"
}

New-Item -ItemType Directory -Path $ShortcutDirectory -Force | Out-Null

$safeName = $ShortcutName -replace '[<>:"/\\|?*]', '-'
if (-not $safeName.Trim()) {
  $safeName = "Codex Patch Studio Current"
}
$shortcutPath = Join-Path $ShortcutDirectory "$safeName.lnk"

$powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $powershellExe)) {
  $powershellExe = "powershell.exe"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellExe
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherScript`" -StopPatchedOnly"
$shortcut.WorkingDirectory = $WorkingDirectory
$shortcut.Description = "Launch Codex Patch Studio Current and handle installed Codex updates using the configured policy."
if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
  $shortcut.IconLocation = "$IconPath,0"
}
$shortcut.Save()

[pscustomobject]@{
  ShortcutPath = $shortcutPath
  TargetPath = $shortcut.TargetPath
  Arguments = $shortcut.Arguments
  WorkingDirectory = $shortcut.WorkingDirectory
  IconPath = $IconPath
} | ConvertTo-Json -Depth 3
