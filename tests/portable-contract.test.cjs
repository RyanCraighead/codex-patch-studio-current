const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { requiredPackedVerification } = require("../scripts/packed-verification-contract.cjs");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("packed verification contract adds eager-history markers only when selected", () => {
  const lazy = requiredPackedVerification({ chatLimit: false });
  const eager = requiredPackedVerification({ chatLimit: true });

  assert.equal(new Set(lazy).size, lazy.length);
  assert.equal(lazy.includes("containsChatLimitPatch"), false);
  assert.equal(lazy.includes("containsHistoryHydrationDiagnostic"), false);
  assert.equal(eager.includes("containsChatLimitPatch"), true);
  assert.equal(eager.includes("containsHistoryHydrationDiagnostic"), true);
});

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
  assert.match(packager, /Join-Path \$payloadRoot "assets\\portable"/);
  assert.match(
    packager,
    /Join-Path \$payloadToolsDir "7z-sfx-as-invoker\.sfx"/,
  );
  assert.match(
    packager,
    /Join-Path \$payloadPortableAssetsDir "bootstrap-launcher\.cs"/,
  );
  assert.match(packager, /export-augment-webview-state\.cjs/);
  assert.match(packager, /"feature-registry\.cjs"/);
  assert.match(packager, /"packed-verification-contract\.cjs"/);
  assert.match(packager, /"feature-development-workflow\.cjs"/);
  assert.match(packager, /"check-source-only\.cjs"/);
  assert.match(packager, /"atomic-json\.cjs"/);
  assert.match(packager, /"build-lock\.cjs"/);
  assert.match(packager, /"run-tests\.cjs"/);
  assert.match(packager, /"codex-update-policy\.psm1"/);
  assert.match(packager, /"check-remote-update-channel\.cjs"/);
  assert.match(packager, /"generate-update-channel\.cjs"/);
  assert.match(packager, /"update-channel\.json"/);
  assert.match(packager, /Join-Path \$RepoRoot "update-channel"/);
  assert.match(packager, /"verify-portable-payload\.cjs"/);
  assert.match(packager, /"verify-current-patched-build\.cjs"/);
  assert.match(packager, /"verify-runtime-services\.cjs"/);
  assert.match(packager, /"verify-current-ui\.cjs"/);
  assert.match(packager, /"resolve-listening-process\.cjs"/);
  const payloadVerifier = read("scripts/verify-portable-payload.cjs");
  for (const dependency of [
    "codex-update-policy.psm1",
    "check-remote-update-channel.cjs",
    "generate-update-channel.cjs",
    "update-channel.json",
    "stable.json",
    "atomic-json.cjs",
    "build-lock.cjs",
    "feature-development-workflow.cjs",
    "packed-verification-contract.cjs",
    "run-tests.cjs",
    "check-source-only.cjs",
    "verify-portable-payload.cjs",
    "verify-current-patched-build.cjs",
    "verify-runtime-services.cjs",
    "verify-current-ui.cjs",
    "resolve-listening-process.cjs",
    "bootstrap-launcher.cs",
    "7z-sfx-as-invoker.sfx",
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

  const verifier = read("scripts/verify-portable-payload.cjs");
  assert.match(verifier, /Portable installer SFX module does not match the pinned verified build/);
  assert.match(verifier, /portableBuildAssetsPresent: true/);
});

test("portable payload uses long-path-safe verified extraction", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  const innerCompression = packager.slice(
    packager.indexOf("$compressionProfiles"),
    packager.indexOf("$payloadHash = Get-Sha256Hex"),
  );

  assert.match(packager, /codex-patched-payload\.7z/);
  assert.match(innerCompression, /"-m0=lzma2"/);
  assert.match(innerCompression, /"-mx=1"/);
  assert.match(innerCompression, /"-md=32m"/);
  assert.match(innerCompression, /"-mmt=1"/);
  assert.match(innerCompression, /name = "store-fallback"/);
  assert.match(innerCompression, /"-mx=0"/);
  assert.doesNotMatch(innerCompression, /"-mmt=on"/);
  assert.match(innerCompression, /@\(& \$sevenZip "t" \$payloadArchive 2>&1\)/);
  assert.match(innerCompression, /\$compressionLogsRoot = Join-Path \$workRoot "logs"/);
  assert.match(innerCompression, /payload-compression-\{0\}\.log/);
  assert.match(innerCompression, /if \(-not \$compressionSucceeded\)/);
  assert.match(packager, /extractorSha256/);
  assert.match(packager, /patchedAppAsarSha256/);
  assert.match(packager, /packedVerification = \$config\.packedVerification/);
  assert.match(packager, /packedVerification = \$sourceManifest\.packedVerification/);
  assert.match(packager, /packedVerification = \$manifest\.packedVerification/);
  assert.match(packager, /Bundled payload extraction failed/);
  assert.doesNotMatch(packager, /Compress-Archive/);
  assert.doesNotMatch(packager, /Expand-Archive/);
  assert.doesNotMatch(packager, /sourceConfigPath\s*=/);
  assert.doesNotMatch(packager, /sourceAppDir\s*=\s*\$sourceAppDir/);
  assert.match(read("scripts/verify-portable-payload.cjs"), /verificationMode/);
  assert.match(read("scripts/verify-portable-payload.cjs"), /bundled-self-extracting/);
  assert.match(read("scripts/verify-portable-payload.cjs"), /patchedAppAsarSha256/);
  assert.match(read("scripts/verify-runtime-services.cjs"), /CODEX_PATCHED_LAUNCHER_CONFIG/);
});

test("portable bootstrap serializes extraction and self-heals incomplete runtimes", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  const hereStringStart = packager.indexOf("$bootstrap = @'");
  const bootstrapStart = packager.indexOf("$bundleMutex = $null", hereStringStart);
  const bootstrapEnd = packager.indexOf("'@", bootstrapStart);
  const bootstrap = packager.slice(hereStringStart, bootstrapEnd);
  const extractionIndex = bootstrap.indexOf('Write-BundleLog "Extracting');
  const markerWriteIndex = bootstrap.indexOf("Write-Utf8NoBom -Path $markerPath");
  const appAsarValidationIndex = bootstrap.indexOf(
    'throw "Bundled app.asar missing after extraction: $appAsarPath"',
  );

  assert.ok(hereStringStart >= 0, "portable bootstrap here-string is missing");
  assert.ok(
    bootstrapStart > hereStringStart,
    "portable bootstrap mutex initialization is missing",
  );
  assert.match(bootstrap, /System\.Threading\.Mutex/);
  assert.match(bootstrap, /Local\\CodexPatchStudioCurrent\.Bundle\./);
  assert.match(bootstrap, /WaitOne\(\[TimeSpan\]::FromMinutes\(10\)\)/);
  assert.match(bootstrap, /System\.Threading\.AbandonedMutexException/);
  assert.match(bootstrap, /function Write-Utf8NoBom/);
  assert.match(bootstrap, /System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(bootstrap, /\$runtimePayloadPresent/);
  assert.match(bootstrap, /app\\resources\\app\.asar/);
  assert.match(bootstrap, /scripts\\launch-patched-codex\.ps1/);
  assert.match(bootstrap, /patchedAppAsarSha256 = \[string\]\$manifest\.patchedAppAsarSha256/);
  assert.match(
    bootstrap,
    /if \(\(Test-Path -LiteralPath \$markerPath\) -and \$runtimePayloadPresent\)/,
  );
  assert.ok(extractionIndex >= 0, "portable extraction block is missing");
  assert.ok(appAsarValidationIndex > extractionIndex, "app.asar is not validated after extraction");
  assert.ok(markerWriteIndex > appAsarValidationIndex, "completion marker is written before validation");
  assert.match(bootstrap, /Write-Utf8NoBom -Path \$markerPath -Value \$markerJson/);
  assert.match(bootstrap, /Write-Utf8NoBom -Path \$launcherConfigPath -Value \$launcherConfigJson/);
  assert.match(bootstrap, /Write-Utf8NoBom -Path \$runtimePatchManifestPath -Value \$runtimePatchManifestJson/);
  assert.match(bootstrap, /finally \{[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/);
  assert.match(
    read("scripts/verify-current-patched-build.cjs"),
    /readFileSync\(filePath, "utf8"\)\.replace\(\/\^\\uFEFF\//,
  );
});

test("update detection fingerprints the runtime verification contract", () => {
  const fingerprint = read("scripts/patcher-fingerprint.cjs");
  for (const dependency of [
    "codex-update-policy.psm1",
    "ensure-current-codex-patch.ps1",
    "package-patched-codex-single-exe.ps1",
    "packed-verification-contract.cjs",
    "verify-portable-payload.cjs",
    "verify-current-patched-build.cjs",
    "verify-runtime-services.cjs",
    "verify-current-ui.cjs",
    "resolve-listening-process.cjs",
    "bootstrap-launcher.cs",
    "7z-sfx-as-invoker.sfx",
  ]) {
    assert.match(fingerprint, new RegExp(dependency.replaceAll(".", "\\.")));
  }
});

test("live verifier validates installed clones and bundled snapshots by their own contracts", () => {
  const verifier = read("scripts/verify-current-patched-build.cjs");

  assert.match(verifier, /CODEX_PATCHED_LAUNCHER_CONFIG/);
  assert.match(verifier, /bundled-self-extracting/);
  assert.match(verifier, /bundled-snapshot/);
  assert.match(verifier, /patchedAppAsarSha256/);
  assert.match(verifier, /Portable patched app\.asar hash does not match the bundle manifest/);
  assert.match(verifier, /required: !bundledSnapshot/);
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
