"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const {
  checkRemoteUpdateChannel,
  compareSemver,
  markNotified,
  validateManifest,
} = require("../scripts/check-remote-update-channel.cjs");

const appAsarSha256 = "a".repeat(64);
const desktopExeSha256 = "b".repeat(64);
const sourceSha256 = "c".repeat(64);

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    channel: "stable",
    revision: 2,
    publishedAt: "2026-07-16T12:00:00.000Z",
    patcher: {
      version: "0.2.0",
      releaseUrl: "https://github.com/RyanCraighead/codex-patch-studio-current/releases/tag/v0.2.0",
      sourceSha256,
    },
    codex: {
      packageName: "OpenAI.Codex",
      architecture: "x64",
      validatedBuilds: [
        {
          version: "26.800.1.0",
          appAsarSha256,
          desktopExecutableName: "ChatGPT.exe",
          desktopExeSha256,
          validatedAt: "2026-07-16T11:00:00.000Z",
        },
      ],
    },
    ...overrides,
  };
}

test("remote update channel validates versions, hashes, and transport", () => {
  const parsed = validateManifest(manifest(), "stable");
  assert.equal(parsed.revision, 2);
  assert.equal(parsed.codex.validatedBuilds[0].appAsarSha256, appAsarSha256);
  assert.equal(parsed.patcher.sourceSha256, sourceSha256);
  assert.equal(compareSemver("0.2.0", "0.1.9"), 1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.throws(
    () => validateManifest(manifest({ patcher: { version: "0.2.0", releaseUrl: "http://example.com/release" } })),
    /must use HTTPS/,
  );
  const invalid = manifest();
  invalid.codex.validatedBuilds[0].appAsarSha256 = "not-a-hash";
  assert.throws(() => validateManifest(invalid), /invalid hashes/);
});

test("remote update channel caches GitHub state and falls back offline", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-channel-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const body = JSON.stringify(manifest());
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json", ETag: '"channel-v2"' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const manifestUrl = `http://127.0.0.1:${address.port}/stable.json`;
  const options = {
    rootDir: root,
    cacheDir,
    manifestUrl,
    installedVersion: "26.800.1.0",
    installedAsarSha256: appAsarSha256,
    installedExeSha256: desktopExeSha256,
    localPatcherSha256: sourceSha256,
  };

  const fresh = await checkRemoteUpdateChannel({ ...options, forceRefresh: true });
  assert.equal(fresh.network.source, "network");
  assert.equal(fresh.repository.updateAvailable, true);
  assert.equal(fresh.repository.shouldNotify, true);
  assert.equal(fresh.repository.sourceFingerprintMatches, true);
  assert.equal(fresh.compatibility.status, "verified");
  assert.equal(requests, 1);

  const cached = await checkRemoteUpdateChannel(options);
  assert.equal(cached.network.source, "cache-fresh");
  assert.equal(requests, 1);

  markNotified({
    rootDir: root,
    cacheDir,
    notificationKey: fresh.repository.notificationKey,
  });
  const notified = await checkRemoteUpdateChannel({ ...options, noNetwork: true, forceRefresh: true });
  assert.equal(notified.network.source, "cache-stale");
  assert.equal(notified.network.reachable, false);
  assert.equal(notified.repository.shouldNotify, false);

  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("remote update channel distinguishes known-version fingerprint drift", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-channel-drift-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(manifest()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const result = await checkRemoteUpdateChannel({
    rootDir: root,
    cacheDir,
    manifestUrl: `http://127.0.0.1:${address.port}/stable.json`,
    forceRefresh: true,
    installedVersion: "26.800.1.0",
    installedAsarSha256: "c".repeat(64),
    installedExeSha256: desktopExeSha256,
  });
  assert.equal(result.compatibility.status, "fingerprint-mismatch");
  assert.equal(result.compatibility.exactFingerprint, false);
});

test("remote update channel reports same-release local source divergence", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-channel-source-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const sameRelease = manifest({
    revision: 1,
    patcher: {
      version: "0.1.0",
      releaseUrl: "https://github.com/RyanCraighead/codex-patch-studio-current/releases/tag/v0.1.0",
      sourceSha256,
    },
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(sameRelease));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const result = await checkRemoteUpdateChannel({
    rootDir: root,
    cacheDir,
    manifestUrl: `http://127.0.0.1:${address.port}/stable.json`,
    forceRefresh: true,
    localPatcherSha256: "d".repeat(64),
  });
  assert.equal(result.repository.updateAvailable, false);
  assert.equal(result.repository.diverged, true);
  assert.equal(result.repository.sourceFingerprintMatches, false);
});
