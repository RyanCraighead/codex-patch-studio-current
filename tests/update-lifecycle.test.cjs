const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const { promoteVerifiedJson } = require("../scripts/atomic-json.cjs");
const { acquireBuildLockSync, releaseBuildLockSync } = require("../scripts/build-lock.cjs");

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test("Off, Notify, and Auto produce explicit launch decisions", () => {
  const modulePath = path.join(root, "scripts", "codex-update-policy.psm1");
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-policy-")), "test.ps1");
  fs.writeFileSync(
    scriptPath,
    `$ErrorActionPreference='Stop'
Import-Module ${quotePowerShell(modulePath)} -Force
$plans=@(
  [pscustomobject]@{name='off';value=(Get-CodexUpdatePlan -Policy off -NeedsBuild $true)},
  [pscustomobject]@{name='notify-current';value=(Get-CodexUpdatePlan -Policy notify -NeedsBuild $false)},
  [pscustomobject]@{name='notify-accept';value=(Get-CodexUpdatePlan -Policy notify -NeedsBuild $true -PromptAccepted $true)},
  [pscustomobject]@{name='notify-decline';value=(Get-CodexUpdatePlan -Policy notify -NeedsBuild $true -PromptAccepted $false)},
  [pscustomobject]@{name='notify-failure';value=(Get-CodexUpdatePlan -Policy notify -CheckFailed)},
  [pscustomobject]@{name='auto-update';value=(Get-CodexUpdatePlan -Policy auto -NeedsBuild $true)},
  [pscustomobject]@{name='auto-failure';value=(Get-CodexUpdatePlan -Policy auto -CheckFailed)}
)
$selections=[pscustomobject]@{
  requested=(Select-CodexUpdatePolicy -RequestedPolicy off -LocalConfig @{})
  configured=(Select-CodexUpdatePolicy -LocalConfig @{updatePolicy='auto';updatePolicyConfigured=$true})
  prompted=(Select-CodexUpdatePolicy -LocalConfig @{} -Prompt { 'auto' })
  nonInteractive=(Select-CodexUpdatePolicy -LocalConfig @{} -NonInteractive)
}
[pscustomobject]@{plans=$plans;selections=$selections}|ConvertTo-Json -Depth 8 -Compress
`,
    "utf8"
  );
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  const plans = Object.fromEntries(payload.plans.map((entry) => [entry.name, entry.value]));
  assert.deepEqual(plans.off, { check: false, rebuild: false, allowStale: true, failClosed: false, reason: "policy-off" });
  assert.equal(plans["notify-current"].rebuild, false);
  assert.equal(plans["notify-accept"].rebuild, true);
  assert.equal(plans["notify-decline"].allowStale, true);
  assert.equal(plans["notify-failure"].allowStale, true);
  assert.equal(plans["auto-update"].rebuild, true);
  assert.equal(plans["auto-failure"].failClosed, true);
  assert.deepEqual(payload.selections, {
    requested: "off",
    configured: "auto",
    prompted: "auto",
    nonInteractive: "notify",
  });
});

test("failed candidate verification cannot replace the last-known-good launcher config", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-promotion-"));
  const configPath = path.join(directory, "codex-launcher.local.json");
  const original = { cloneRoot: "known-good", sourceVersion: "1" };
  fs.writeFileSync(configPath, `${JSON.stringify(original)}\n`, "utf8");

  assert.throws(
    () => promoteVerifiedJson(configPath, { cloneRoot: "broken" }, () => { throw new Error("packed verification failed"); }),
    /packed verification failed/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), original);
  assert.throws(() => promoteVerifiedJson(configPath, { cloneRoot: "unverified" }, () => false), /verification/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), original);

  promoteVerifiedJson(configPath, { cloneRoot: "verified", sourceVersion: "2" }, () => ({ packed: true }));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { cloneRoot: "verified", sourceVersion: "2" });
  assert.deepEqual(fs.readdirSync(directory), ["codex-launcher.local.json"]);
});

test("the real setup, launcher, and builder use the tested update lifecycle", () => {
  const setup = fs.readFileSync(path.join(root, "scripts", "setup-current-patcher.ps1"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "scripts", "launch-patched-codex.ps1"), "utf8");
  const builder = fs.readFileSync(path.join(root, "scripts", "build-patched-codex-app.cjs"), "utf8");
  assert.match(setup, /Select-CodexUpdatePolicy/);
  assert.match(launcher, /Get-CodexUpdatePlan/);
  assert.match(launcher, /Show-CodexUpdatePrompt/);
  assert.match(launcher, /CODEX_ALLOW_STALE_PATCHED_LAUNCH/);
  assert.match(builder, /promoteVerifiedJson\(launcherConfigPath/);
  assert.ok(builder.indexOf("const packedVerification = verifyPackedAsar") < builder.indexOf("promoteVerifiedJson(launcherConfigPath"));
  assert.ok(builder.indexOf("writeJson(patchManifestPath") < builder.indexOf("promoteVerifiedJson(launcherConfigPath"));
  assert.equal((builder.match(/promoteVerifiedJson\(launcherConfigPath/g) || []).length, 1);
  assert.match(builder, /withBuildLockSync\(rootDir, main\)/);
});

test("the shared build lock fails closed for overlapping builders and releases cleanly", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-lock-"));
  const lockPath = path.join(directory, "builder.lock");
  const first = acquireBuildLockSync("test-builder", { lockPath, timeoutMs: 100 });
  assert.throws(
    () => acquireBuildLockSync("test-builder", { lockPath, timeoutMs: 40, retryMs: 10 }),
    /Timed out waiting for the Codex patch build lock/
  );
  releaseBuildLockSync(first);
  const second = acquireBuildLockSync("test-builder", { lockPath, timeoutMs: 100 });
  releaseBuildLockSync(second);
  assert.equal(fs.existsSync(lockPath), false);
});
