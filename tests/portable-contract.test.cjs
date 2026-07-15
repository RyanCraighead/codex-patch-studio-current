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

  assert.match(packager, /codex-patched-payload\.7z/);
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
