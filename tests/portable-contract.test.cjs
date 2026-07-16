const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("portable package carries its runtime dependencies", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(packageJson.dependencies["classic-level"], "3.0.0");
  assert.equal(packageJson.dependencies.ws, "8.21.0");
  assert.match(packager, /cua_node\\bin\\node\.exe/);
  assert.match(packager, /7z-sfx-as-invoker\.sfx/);
  assert.match(packager, /bootstrap-launcher\.cs/);
  assert.match(packager, /RunProgram="bootstrap-launcher\.exe"/);
  assert.doesNotMatch(packager, /RunProgram="powershell\.exe/);
  assert.doesNotMatch(packager, /ProgramFiles.*7-Zip\\7z\.sfx/);
  assert.match(packager, /CODEX_PATCHED_NODE/);
  assert.match(packager, /node_modules/);
  assert.match(packager, /sqlite3\.exe/);
  assert.match(packager, /export-augment-webview-state\.cjs/);
  assert.match(packager, /"feature-registry\.cjs"/);
  assert.match(packager, /"feature-development-workflow\.cjs"/);
  assert.match(packager, /"check-source-only\.cjs"/);
  assert.match(packager, /"atomic-json\.cjs"/);
  assert.match(packager, /"build-lock\.cjs"/);
  assert.match(packager, /"run-tests\.cjs"/);
  assert.match(packager, /"codex-update-policy\.psm1"/);
  assert.match(packager, /"verify-portable-payload\.cjs"/);
  const payloadVerifier = read("scripts/verify-portable-payload.cjs");
  for (const dependency of [
    "codex-update-policy.psm1",
    "atomic-json.cjs",
    "build-lock.cjs",
    "feature-development-workflow.cjs",
    "run-tests.cjs",
    "check-source-only.cjs",
    "verify-portable-payload.cjs",
  ]) {
    assert.match(payloadVerifier, new RegExp(dependency.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(packager, /export-augment-webview-state\.py/);
  assert.doesNotMatch(read("scripts/start-codex-patch-manager.ps1"), /Get-FileHash/);
  assert.doesNotMatch(read("scripts/launch-patched-codex.ps1"), /E:\\CodexPatchStudioCurrent\\\*/);
});

test("portable package carries version-aware feature modules", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  assert.match(packager, /-Source \(Join-Path \$RepoRoot "features"\)/);
  assert.match(packager, /-Target \(Join-Path \$payloadRoot "features"\)/);
});

test("portable package pins the verified installer SFX module", () => {
  const sfx = fs.readFileSync(path.join(root, "tools", "7z-sfx-as-invoker.sfx"));
  const hash = crypto.createHash("sha256").update(sfx).digest("hex").toUpperCase();

  assert.equal(sfx.length, 141824);
  assert.equal(hash, "E1E9AA1EB9FE7F331DE76479154AC4BB9998C8919DBC79BEBE4F6EAA795CE312");
});

test("portable payload uses long-path-safe verified extraction", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  const innerCompression = packager.slice(
    packager.indexOf("$innerSevenZipArgs"),
    packager.indexOf("& $sevenZip @innerSevenZipArgs"),
  );

  assert.match(packager, /codex-patched-payload\.7z/);
  assert.match(innerCompression, /"-m0=lzma2"/);
  assert.match(innerCompression, /"-md=64m"/);
  assert.match(innerCompression, /"-mmt=2"/);
  assert.doesNotMatch(innerCompression, /"-mmt=on"/);
  assert.match(packager, /extractorSha256/);
  assert.match(packager, /Bundled payload extraction failed/);
  assert.doesNotMatch(packager, /Compress-Archive/);
  assert.doesNotMatch(packager, /Expand-Archive/);
  assert.doesNotMatch(packager, /sourceConfigPath\s*=/);
  assert.doesNotMatch(packager, /sourceAppDir\s*=\s*\$sourceAppDir/);
  assert.match(read("scripts/verify-portable-payload.cjs"), /verificationMode/);
  assert.match(read("scripts/verify-portable-payload.cjs"), /bundled-self-extracting/);
  assert.match(read("scripts/verify-runtime-services.cjs"), /CODEX_PATCHED_LAUNCHER_CONFIG/);
});

test("packager verifies the dormant payload before compression and fails closed", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  const verificationIndex = packager.indexOf(
    "$dormantVerificationJson = & $fingerprintNode $payloadVerifierPath $payloadRoot",
  );
  const compressionIndex = packager.indexOf(
    'Write-Host "Compressing payload with long-path-safe 7-Zip.',
  );
  const sfxIndex = packager.indexOf(
    'Write-Host "Building single bundled exe with 7-Zip SFX.',
  );

  assert.ok(verificationIndex >= 0, "dormant verification invocation is missing");
  assert.ok(verificationIndex < compressionIndex, "payload was compressed before verification");
  assert.ok(verificationIndex < sfxIndex, "SFX assembly began before verification");
  assert.match(packager, /\$dormantVerificationExitCode -ne 0/);
  assert.match(packager, /Dormant portable payload verification returned invalid JSON/);
  assert.match(packager, /\$dormantVerification\.ok -isnot \[bool\]/);
  assert.match(packager, /verificationMode -ne "dormant-payload"/);
  assert.match(packager, /generatedLauncherConfigPresent -ne \$false/);
});

test("portable Electron profile selection is explicit and stable", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  const payloadVerifier = read("scripts/verify-portable-payload.cjs");

  assert.match(packager, /\$portableElectronProfileEnabled = \$PortableElectronProfile\.IsPresent/);
  assert.doesNotMatch(packager, /\$portableElectronProfile = \[bool\]\$PortableElectronProfile/);
  assert.match(packager, /portableElectronProfile = \$portableElectronProfileEnabled/);
  assert.match(packager, /portableElectronProfile = \$sourceManifest\.portableElectronProfile/);
  assert.match(packager, /Bundle manifest portableElectronProfile must be true or false/);
  assert.match(
    packager,
    /\$portableElectronUserDataPath = Join-Path \$profileRoot "electron-user-data"/,
  );
  assert.match(
    packager,
    /\$stableElectronProfileRoot = Join-Path \$localAppData "CodexPatchStudioCurrent"/,
  );
  assert.match(
    packager,
    /\$electronUserDataPath = if \(\$portableElectronProfile\) \{\s*\$portableElectronUserDataPath\s*\} else \{\s*\$stableElectronUserDataPath\s*\}/,
  );
  assert.match(packager, /"isolated-per-bundle"/);
  assert.match(packager, /"stable-local-app-data"/);
  assert.match(payloadVerifier, /typeof sourceManifest\.portableElectronProfile !== "boolean"/);
  assert.match(
    payloadVerifier,
    /runtimeLauncher\.portableElectronProfile !== sourceManifest\.portableElectronProfile/,
  );
  assert.match(payloadVerifier, /Initialized portable runtime launcher selected the wrong Electron profile path/);
});

test("manager and README identify bundles as local-only installed Codex artifacts", () => {
  const managerHtml = read("codex-viewer/public/index.html");
  const readme = read("README.md");

  assert.match(managerHtml, /<small>Local-only artifact<\/small>/);
  assert.match(managerHtml, /contains your installed Codex copy and must not be published/i);
  assert.match(readme, /local-only artifact containing the user's installed Codex copy/i);
  assert.match(readme, /%LOCALAPPDATA%\\CodexPatchStudioCurrent\\electron-user-data/);
  assert.match(readme, /-PortableElectronProfile/);
});

test("current runtime recognizes ChatGPT and has no predecessor fallbacks", () => {
  const files = [
    "scripts/run-codex-import-after-close.ps1",
    "scripts/run-codex-thread-repair-after-close.ps1",
    "scripts/run-codex-project-move-after-close.ps1",
    "scripts/run-codex-project-visibility-repair-after-close.ps1",
    "scripts/import-augment-to-codex.cjs",
    "scripts/repair-codex-thread-index.cjs",
    "scripts/repair-codex-native-chat-store.cjs",
    "scripts/repair-codex-project-visibility.cjs",
  ];

  const combined = files.map(read).join("\n");
  assert.match(combined, /ChatGPT/);
  assert.doesNotMatch(combined, /\.codex-patched(?:["'\\])/);
  assert.doesNotMatch(combined, /codex-patched-app/);
});
