const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requiredPackedVerification } = require("../scripts/packed-verification-contract.cjs");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "scripts", "verify-current-patched-build.cjs");
const requiredVerification = requiredPackedVerification({ chatLimit: false });

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runVerifier(launcherPath) {
  return spawnSync(process.execPath, [verifier], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_PATCHED_LAUNCHER_CONFIG: launcherPath },
  });
}

test("bundled live verification uses packaged hashes and fails closed on tampering", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-portable-live-verifier-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const cloneRoot = path.join(temporaryRoot, "bundle");
  const appRoot = path.join(cloneRoot, "app");
  const resourcesRoot = path.join(appRoot, "resources");
  fs.mkdirSync(resourcesRoot, { recursive: true });
  const codexExe = path.join(appRoot, "ChatGPT.exe");
  const appAsar = path.join(resourcesRoot, "app.asar");
  fs.writeFileSync(codexExe, "portable desktop fixture", "utf8");
  fs.writeFileSync(appAsar, "portable patched asar fixture", "utf8");

  const launcherPath = path.join(temporaryRoot, "codex-launcher.local.json");
  const patchedAppAsarSha256 = sha256(appAsar);
  const launcher = {
    mode: "bundled-self-extracting",
    sourceMode: "bundled-snapshot",
    sourceVersion: "26.707.fixture",
    cloneRoot,
    codexExe,
    appAsar,
    sourceDesktopExeSha256: sha256(codexExe),
    patchedAppAsarSha256,
    features: { catalogShim: false, chatLimit: false },
  };
  writeJson(launcherPath, launcher);
  writeJson(path.join(cloneRoot, "patch-manifest.json"), {
    patchedAppAsarSha256,
    packedVerification: Object.fromEntries(requiredVerification.map((key) => [key, true])),
  });

  const valid = runVerifier(launcherPath);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  const output = JSON.parse(valid.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.bundledSnapshot, true);
  assert.equal(output.installedVersion === null || typeof output.installedVersion === "string", true);

  fs.appendFileSync(appAsar, "tampered", "utf8");
  const tampered = runVerifier(launcherPath);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /Portable patched app\.asar hash does not match the bundle manifest/);
});
