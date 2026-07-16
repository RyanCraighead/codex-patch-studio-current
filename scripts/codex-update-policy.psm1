Set-StrictMode -Version Latest

function Resolve-CodexUpdatePolicy {
  param([Parameter(Mandatory = $true)][object]$Config)

  $policy = ([string]$Config.updatePolicy).Trim().ToLowerInvariant()
  if ($policy -in @("off", "notify", "auto")) {
    return $policy
  }
  if ($Config.autoRebuildOnLaunch -eq $false) {
    return "off"
  }
  return "notify"
}

function Get-CodexUpdatePlan {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("off", "notify", "auto")]
    [string]$Policy,
    [bool]$NeedsBuild = $false,
    [object]$PromptAccepted = $null,
    [switch]$CheckFailed
  )

  if ($Policy -eq "off") {
    return [pscustomobject]@{
      check = $false
      rebuild = $false
      allowStale = $true
      failClosed = $false
      reason = "policy-off"
    }
  }

  if ($CheckFailed) {
    return [pscustomobject]@{
      check = $true
      rebuild = $false
      allowStale = $Policy -eq "notify"
      failClosed = $Policy -eq "auto"
      reason = if ($Policy -eq "auto") { "auto-check-failed" } else { "notify-check-failed" }
    }
  }

  if (-not $NeedsBuild) {
    return [pscustomobject]@{
      check = $true
      rebuild = $false
      allowStale = $false
      failClosed = $false
      reason = "current"
    }
  }

  $accepted = $PromptAccepted -eq $true
  $rebuild = $Policy -eq "auto" -or ($Policy -eq "notify" -and $accepted)
  return [pscustomobject]@{
    check = $true
    rebuild = $rebuild
    allowStale = -not $rebuild
    failClosed = $false
    reason = if ($rebuild) { "rebuild" } else { "deferred" }
  }
}

function Select-CodexUpdatePolicy {
  param(
    [string]$RequestedPolicy = "",
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$LocalConfig,
    [switch]$NonInteractive,
    [scriptblock]$Prompt
  )

  $requested = $RequestedPolicy.Trim().ToLowerInvariant()
  if ($requested -in @("off", "notify", "auto")) {
    return $requested
  }
  $existing = ([string]$LocalConfig["updatePolicy"]).Trim().ToLowerInvariant()
  if ($existing -in @("off", "notify", "auto") -and $LocalConfig["updatePolicyConfigured"] -eq $true) {
    return $existing
  }
  if ($NonInteractive) {
    return "notify"
  }
  if ($Prompt) {
    $selected = ([string](& $Prompt)).Trim().ToLowerInvariant()
    if ($selected -notin @("off", "notify", "auto")) {
      throw "The update policy prompt returned an unsupported policy: $selected"
    }
    return $selected
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

Export-ModuleMember -Function Resolve-CodexUpdatePolicy, Get-CodexUpdatePlan, Select-CodexUpdatePolicy
