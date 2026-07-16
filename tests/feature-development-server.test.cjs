const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

test("native Feature Development settings use a dedicated event-driven settings route", () => {
  const source = fs.readFileSync(path.join(root, "features", "core", "patcher-ui", "payload", "codex-native-patcher-settings.js"), "utf8");
  const builder = fs.readFileSync(path.join(root, "scripts", "build-patched-codex-app.cjs"), "utf8");
  const server = fs.readFileSync(path.join(root, "codex-viewer", "server.cjs"), "utf8");
  assert.match(source, /\/api\/patch\/feature-development\/action/);
  assert.match(source, /codex-native-feature-development-settings-route/);
  assert.match(source, /\/settings\/\$\{targetRoute\}/);
  assert.match(source, /Create local feature/);
  assert.match(source, /Convert to contribution/);
  assert.match(source, /Open worktree/);
  assert.match(source, /Rebuild patched Codex/);
  assert.match(source, /host\.dataset\.cpxRendered !== "1"/);
  assert.match(source, /refreshFeatureDevelopment\(\{ showBusy: false \}\)\.catch/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /\/api\/patch\/jobs/);
  assert.match(builder, /codex-native-feature-development-settings-page\.js/);
  assert.match(builder, /defaultMessage:`Feature Development`/);
  assert.match(builder, /slug:`feature-development`/);
  assert.match(server, /status: compatibleWith\(record, sourceVersion\) \? "compatible" : "incompatible"/);
  assert.match(server, /Created and registered/);
  assert.match(server, /Converted and registered/);
  assert.match(server, /kind: "contribution"/);
  assert.match(server, /featureRoots\.push\(\{ path: featureRoot, kind: "local" \}\)/);
  assert.match(server, /buildFeatures: \{ \.\.\.preview\.options\.features \}/);
  assert.doesNotMatch(server, /const buildFallback = builtEnabled \? "passed"/);
});

function request(port, options = {}) {
  const body = options.body == null ? "" : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path || "/api/patch/feature-development",
        method: options.method || "GET",
        headers: {
          ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
          ...(options.headers || {}),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, headers: response.headers, body: responseBody });
        });
      }
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function startServer(profileRoot, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "codex-viewer", "server.cjs"), "0"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: profileRoot,
        USERPROFILE: profileRoot,
        LOCALAPPDATA: path.join(profileRoot, "AppData", "Local"),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Feature Development test server did not start: ${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += String(chunk);
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      resolve({ child, port: Number(match[1]), output: () => output });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && !/127\.0\.0\.1:(\d+)/.test(output)) {
        clearTimeout(timeout);
        reject(new Error(`Feature Development test server exited ${code}: ${output}`));
      }
    });
  });
}

test("Feature Development bridge is origin-guarded and returns actionable module state", async (context) => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-development-server-"));
  const outputRoot = path.join(profileRoot, "custom-build-output");
  const cloneRoot = path.join(outputRoot, "verified-clone");
  const codexExe = path.join(cloneRoot, "app", "ChatGPT.exe");
  const launcherConfig = path.join(profileRoot, "launcher.json");
  const buildIdentity = "server-test-build";
  const sourceAsarSha256 = "a".repeat(64);
  const sourceAppServerCliSha256 = "b".repeat(64);
  const patcherSha256 = "c".repeat(64);
  fs.mkdirSync(path.dirname(codexExe), { recursive: true });
  fs.writeFileSync(codexExe, "test executable placeholder");
  fs.writeFileSync(
    launcherConfig,
    JSON.stringify({
      outputRoot,
      cloneRoot,
      codexExe,
      sourceVersion: "26.707.9981.0",
      sourceAsarSha256,
      sourceAppServerCliSha256,
      buildIdentity,
      patcherSource: { sha256: patcherSha256 },
      builtAt: "2026-07-16T00:00:00.000Z",
      featureModules: [{ id: "core.settings-shell", enabled: true }],
    })
  );
  const patchManifestPath = path.join(cloneRoot, "patch-manifest.json");
  const patchManifest = {
    cloneRoot,
    codexExe,
    sourceVersion: "26.707.9981.0",
    sourceAsarSha256,
    sourceAppServerCliSha256,
    buildIdentity,
    patcherSource: { sha256: patcherSha256 },
    builtAt: "2026-07-16T00:00:00.000Z",
    candidateFinalizedAt: "2026-07-16T00:01:00.000Z",
    featureModuleApplication: [{ id: "core.settings-shell", result: { ok: true } }],
    packedVerification: {
      featureModules: [{ id: "core.settings-shell", verification: [{ matched: true }] }],
    },
  };
  fs.writeFileSync(patchManifestPath, JSON.stringify(patchManifest));
  const { child, port, output } = await startServer(profileRoot, {
    CODEX_PATCH_STUDIO_LAUNCHER_CONFIG: launcherConfig,
  });
  context.after(() => {
    child.kill();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });

  const missingOrigin = await request(port);
  assert.equal(missingOrigin.status, 403);
  assert.match(missingOrigin.body, /approved Origin or Referer/);

  const hostileOrigin = await request(port, {
    headers: { origin: "https://example.invalid", "sec-fetch-site": "cross-site" },
  });
  assert.equal(hostileOrigin.status, 403);

  const hostileHost = await request(port, {
    headers: { host: "example.invalid", origin: "app://-", "sec-fetch-site": "cross-site" },
  });
  assert.equal(hostileHost.status, 403);
  assert.match(hostileHost.body, /loopback host/i);

  const preflight = await request(port, {
    method: "OPTIONS",
    headers: {
      origin: "app://-",
      "sec-fetch-site": "cross-site",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "app://-");

  const unsafePreflight = await request(port, {
    method: "OPTIONS",
    headers: {
      origin: "app://-",
      "sec-fetch-site": "cross-site",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-run-command",
    },
  });
  assert.equal(unsafePreflight.status, 403);

  const accepted = await request(port, {
    headers: { origin: "app://-", "sec-fetch-site": "cross-site" },
  });
  assert.equal(accepted.status, 200, output());
  assert.equal(accepted.headers["access-control-allow-origin"], "app://-");
  const status = JSON.parse(accepted.body);
  assert.equal(status.ok, true, status.error);
  assert.ok(status.modules.length > 0);
  assert.ok(status.modules.some((feature) => feature.kind === "core"));
  assert.ok(status.modules.every((feature) => ["core", "contribution", "local"].includes(feature.kind)));
  const settingsShell = status.modules.find((feature) => feature.id === "core.settings-shell");
  assert.ok(settingsShell);
  assert.match(settingsShell.source.repository, /.+/);
  assert.match(settingsShell.source.commit, /^[0-9a-f]{40,64}$/i);
  assert.ok(["compatible", "incompatible", "unknown"].includes(settingsShell.compatibility.status));
  assert.match(settingsShell.build.status, /^(passed|failed|pending|disabled|unknown)$/);
  assert.match(settingsShell.test.status, /^(passed|failed|not-run|unknown)$/);
  assert.equal(settingsShell.build.status, "passed");
  assert.equal(settingsShell.test.status, "passed");
  assert.equal(status.lastBuild.status, "passed");
  assert.match(status.lastBuild.id, /^direct-/);
  assert.equal(status.lastBuild.logTail, "Verified immutable build manifest.");

  fs.writeFileSync(patchManifestPath, JSON.stringify({ ...patchManifest, codexExe: path.join(cloneRoot, "wrong.exe") }));
  const rejected = await request(port, {
    headers: { origin: "app://-", "sec-fetch-site": "cross-site" },
  });
  assert.equal(rejected.status, 200, output());
  const rejectedStatus = JSON.parse(rejected.body);
  const rejectedSettingsShell = rejectedStatus.modules.find((feature) => feature.id === "core.settings-shell");
  assert.equal(rejectedSettingsShell.build.status, "unknown");
  assert.equal(rejectedSettingsShell.test.status, "unknown");
  assert.equal(rejectedStatus.lastBuild, null);

  const invalidId = await request(port, {
    method: "POST",
    path: "/api/patch/feature-development/action",
    headers: { origin: "app://-", "sec-fetch-site": "cross-site" },
    body: {
      requestId: "server-test-invalid-id",
      action: "create-local",
      id: "../../outside",
    },
  });
  assert.equal(invalidId.status, 400);
  assert.match(invalidId.body, /namespaced lowercase feature ID/);

  const injectedPath = await request(port, {
    method: "POST",
    path: "/api/patch/feature-development/action",
    headers: { origin: "app://-", "sec-fetch-site": "cross-site" },
    body: {
      requestId: "server-test-extra-path",
      action: "open-worktree",
      id: "core.settings-shell",
      worktree: "C:\\Windows",
    },
  });
  assert.equal(injectedPath.status, 400);
  assert.match(injectedPath.body, /Unsupported Feature Development field\(s\): worktree/);
});
