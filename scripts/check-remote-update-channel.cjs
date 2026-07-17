#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  }
}

function parseSemver(value) {
  const match = String(value || "").trim().match(SEMVER_PATTERN);
  if (!match) throw new Error(`Invalid patcher semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference) return Math.sign(difference);
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const difference = left[index].localeCompare(right[index]);
      if (difference) return Math.sign(difference);
    }
  }
  return 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const key of ["major", "minor", "patch"]) {
    const difference = left[key] - right[key];
    if (difference) return Math.sign(difference);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function validRemoteUrl(value, field) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`Remote update manifest ${field} is not a valid URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Remote update manifest ${field} must use HTTPS`);
  }
  return url.toString();
}

function normalizeValidatedBuild(build) {
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error("Remote update manifest contains an invalid Codex build record");
  }
  const version = String(build.version || "").trim();
  if (!/^\d+(?:\.\d+){3}$/.test(version)) {
    throw new Error(`Remote update manifest has an invalid Codex version: ${version}`);
  }
  const appAsarSha256 = String(build.appAsarSha256 || "").toLowerCase();
  const desktopExeSha256 = String(build.desktopExeSha256 || "").toLowerCase();
  if (!HASH_PATTERN.test(appAsarSha256) || !HASH_PATTERN.test(desktopExeSha256)) {
    throw new Error(`Remote update manifest has invalid hashes for Codex ${version}`);
  }
  return {
    version,
    appAsarSha256,
    desktopExecutableName: String(build.desktopExecutableName || ""),
    desktopExeSha256,
    validatedAt: String(build.validatedAt || ""),
  };
}

function validateManifest(input, expectedChannel = "stable") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Remote update manifest must be an object");
  }
  if (input.schemaVersion !== 1) throw new Error("Unsupported remote update manifest schema");
  const channel = String(input.channel || "").trim();
  if (!channel || channel !== expectedChannel) {
    throw new Error(`Remote update manifest channel mismatch: expected ${expectedChannel}, received ${channel || "none"}`);
  }
  const revision = Number(input.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Remote update manifest revision must be a positive integer");
  }
  const version = String(input.patcher?.version || "").trim();
  parseSemver(version);
  const releaseUrl = validRemoteUrl(input.patcher?.releaseUrl, "patcher.releaseUrl");
  const sourceSha256 = String(input.patcher?.sourceSha256 || "").trim().toLowerCase();
  if (!HASH_PATTERN.test(sourceSha256)) {
    throw new Error("Remote update manifest patcher sourceSha256 must be a SHA-256 hash");
  }
  const commit = input.patcher?.commit == null ? "" : String(input.patcher.commit).trim().toLowerCase();
  if (commit && !COMMIT_PATTERN.test(commit)) {
    throw new Error("Remote update manifest patcher commit must be a full Git commit hash");
  }
  const validatedBuilds = input.codex?.validatedBuilds;
  if (!Array.isArray(validatedBuilds)) {
    throw new Error("Remote update manifest codex.validatedBuilds must be an array");
  }
  return {
    schemaVersion: 1,
    channel,
    revision,
    publishedAt: String(input.publishedAt || ""),
    patcher: { version, releaseUrl, sourceSha256, commit },
    codex: {
      packageName: String(input.codex?.packageName || ""),
      architecture: String(input.codex?.architecture || ""),
      validatedBuilds: validatedBuilds.map(normalizeValidatedBuild),
    },
  };
}

function localCommit(rootDir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  const commit = String(result.stdout || "").trim().toLowerCase();
  return result.status === 0 && COMMIT_PATTERN.test(commit) ? commit : "";
}

function evaluateManifest(manifest, local, cacheRecord = {}) {
  const remoteVersionComparison = compareSemver(manifest.patcher.version, local.patcherVersion);
  const revisionComparison = manifest.revision - local.revision;
  const updateAvailable = revisionComparison > 0 || remoteVersionComparison > 0;
  const remoteBehind = revisionComparison < 0 || remoteVersionComparison < 0;
  const commitsDiffer = Boolean(
    manifest.patcher.commit && local.commit && manifest.patcher.commit !== local.commit,
  );
  const sourceFingerprintAvailable = Boolean(manifest.patcher.sourceSha256 && local.patcherSha256);
  const sourceFingerprintMatches = Boolean(
    sourceFingerprintAvailable && manifest.patcher.sourceSha256 === local.patcherSha256,
  );
  const sourceFingerprintDiffers = sourceFingerprintAvailable && !sourceFingerprintMatches;
  const notificationKey = `${manifest.channel}:${manifest.revision}:${manifest.patcher.version}:${manifest.patcher.commit || "release"}`;
  const versionMatches = manifest.codex.validatedBuilds.filter(
    (build) => build.version === local.installedVersion,
  );
  const exactBuild = versionMatches.find(
    (build) =>
      build.appAsarSha256 === local.installedAsarSha256 &&
      build.desktopExeSha256 === local.installedExeSha256,
  );
  let compatibilityStatus = "pending";
  if (exactBuild) compatibilityStatus = "verified";
  else if (versionMatches.length) compatibilityStatus = "fingerprint-mismatch";
  else if (!local.installedVersion) compatibilityStatus = "not-checked";

  return {
    repository: {
      localRevision: local.revision,
      remoteRevision: manifest.revision,
      localVersion: local.patcherVersion,
      remoteVersion: manifest.patcher.version,
      localCommit: local.commit || null,
      remoteCommit: manifest.patcher.commit || null,
      localSourceSha256: local.patcherSha256 || null,
      remoteSourceSha256: manifest.patcher.sourceSha256,
      sourceFingerprintMatches,
      updateAvailable,
      remoteBehind,
      diverged: !updateAvailable && !remoteBehind && (commitsDiffer || sourceFingerprintDiffers),
      releaseUrl: manifest.patcher.releaseUrl,
      notificationKey,
      shouldNotify: updateAvailable && cacheRecord.notifiedKey !== notificationKey,
    },
    compatibility: {
      installedVersion: local.installedVersion || null,
      status: compatibilityStatus,
      exactFingerprint: Boolean(exactBuild),
      versionRecordCount: versionMatches.length,
      validatedBuild: exactBuild || null,
    },
  };
}

function mergedChannelConfig(rootDir) {
  const config = readJson(path.join(rootDir, "config", "update-channel.json"));
  if (!config || config.schemaVersion !== 1) {
    throw new Error("config/update-channel.json is missing or invalid");
  }
  const local = readJson(path.join(rootDir, "config", "patcher.local.json"), {}) || {};
  return {
    ...config,
    manifestUrl: local.updateChannelUrl || process.env.CODEX_PATCHER_UPDATE_CHANNEL_URL || config.manifestUrl,
    requestTimeoutMs: local.updateChannelTimeoutMs || config.requestTimeoutMs,
    cacheTtlSeconds: local.updateChannelCacheTtlSeconds || config.cacheTtlSeconds,
  };
}

function cachePaths(config, explicitCacheDir) {
  const base = explicitCacheDir || process.env.CODEX_PATCHER_UPDATE_CACHE || path.join(
    process.env.LOCALAPPDATA || os.tmpdir(),
    "CodexPatchStudioCurrent",
    "update-cache",
  );
  const safeChannel = String(config.channel || "stable").replace(/[^A-Za-z0-9._-]/g, "-");
  return { cacheDir: base, cachePath: path.join(base, `${safeChannel}.json`) };
}

async function fetchChannel(url, timeoutMs, etag, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This Node runtime does not provide fetch");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: etag ? { "If-None-Match": etag } : {},
      signal: controller.signal,
    });
    if (response.status === 304) return { notModified: true, etag };
    if (!response.ok) throw new Error(`GitHub channel returned HTTP ${response.status}`);
    return {
      manifest: await response.json(),
      etag: response.headers.get("etag") || "",
      notModified: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkRemoteUpdateChannel(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const config = mergedChannelConfig(rootDir);
  const manifestUrl = validRemoteUrl(options.manifestUrl || config.manifestUrl, "URL");
  const timeoutMs = Math.max(250, Math.min(30000, Number(options.timeoutMs || config.requestTimeoutMs || 2500)));
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlSeconds ?? config.cacheTtlSeconds ?? 21600) * 1000);
  const { cachePath } = cachePaths(config, options.cacheDir);
  let cacheRecord = readJson(cachePath, {}) || {};
  const now = Number(options.now || Date.now());
  const cachedAt = Date.parse(cacheRecord.fetchedAt || "");
  const cacheFresh =
    cacheRecord.url === manifestUrl &&
    cacheRecord.manifest &&
    Number.isFinite(cachedAt) &&
    now - cachedAt >= 0 &&
    now - cachedAt < cacheTtlMs;
  let manifest;
  let source = "unavailable";
  let reachable = false;
  let warning = "";

  if (!options.forceRefresh && cacheFresh) {
    manifest = validateManifest(cacheRecord.manifest, config.channel);
    source = "cache-fresh";
    reachable = true;
  } else if (!options.noNetwork) {
    try {
      const fetched = await fetchChannel(manifestUrl, timeoutMs, cacheRecord.etag || "", options.fetchImpl);
      if (fetched.notModified && cacheRecord.manifest) {
        manifest = validateManifest(cacheRecord.manifest, config.channel);
        source = "not-modified";
      } else {
        manifest = validateManifest(fetched.manifest, config.channel);
        source = "network";
        cacheRecord.manifest = manifest;
        cacheRecord.etag = fetched.etag;
      }
      reachable = true;
      cacheRecord = {
        ...cacheRecord,
        schemaVersion: 1,
        channel: config.channel,
        url: manifestUrl,
        fetchedAt: new Date(now).toISOString(),
      };
      writeJsonAtomic(cachePath, cacheRecord);
    } catch (error) {
      warning = error?.name === "AbortError" ? "GitHub channel request timed out" : error.message;
    }
  } else {
    warning = "Network access was disabled for this check";
  }

  if (!manifest && cacheRecord.manifest) {
    try {
      manifest = validateManifest(cacheRecord.manifest, config.channel);
      source = "cache-stale";
    } catch (error) {
      warning = `${warning ? `${warning}; ` : ""}cached channel is invalid: ${error.message}`;
    }
  }

  const packageManifest = readJson(path.join(rootDir, "package.json"), {});
  const local = {
    revision: Number(config.localRevision || 0),
    patcherVersion: String(packageManifest.version || "0.0.0"),
    commit: options.localCommit || localCommit(rootDir),
    patcherSha256: String(options.localPatcherSha256 || "").trim().toLowerCase(),
    installedVersion: String(options.installedVersion || ""),
    installedAsarSha256: String(options.installedAsarSha256 || "").toLowerCase(),
    installedExeSha256: String(options.installedExeSha256 || "").toLowerCase(),
  };
  if (local.patcherSha256 && !HASH_PATTERN.test(local.patcherSha256)) {
    throw new Error("Local patcher fingerprint must be a SHA-256 hash");
  }

  if (!manifest) {
    return {
      ok: true,
      channel: config.channel,
      checkedAt: new Date(now).toISOString(),
      network: { reachable: false, source, warning, manifestUrl, cachePath },
      repository: {
        localRevision: local.revision,
        localVersion: local.patcherVersion,
        localCommit: local.commit || null,
        updateAvailable: false,
        shouldNotify: false,
        releaseUrl: config.repositoryUrl,
      },
      compatibility: {
        installedVersion: local.installedVersion || null,
        status: "unknown",
        exactFingerprint: false,
      },
    };
  }

  return {
    ok: true,
    channel: manifest.channel,
    checkedAt: new Date(now).toISOString(),
    publishedAt: manifest.publishedAt,
    network: { reachable, source, warning, manifestUrl, cachePath },
    ...evaluateManifest(manifest, local, cacheRecord),
  };
}

function markNotified(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const config = mergedChannelConfig(rootDir);
  const { cachePath } = cachePaths(config, options.cacheDir);
  const cacheRecord = readJson(cachePath, {}) || {};
  if (!cacheRecord.manifest) throw new Error("No cached remote update channel is available to mark");
  const manifest = validateManifest(cacheRecord.manifest, config.channel);
  const notificationKey = options.notificationKey || `${manifest.channel}:${manifest.revision}:${manifest.patcher.version}:${manifest.patcher.commit || "release"}`;
  cacheRecord.notifiedKey = notificationKey;
  cacheRecord.notifiedAt = new Date().toISOString();
  writeJsonAtomic(cachePath, cacheRecord);
  return { ok: true, notificationKey, cachePath };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--force-refresh") result.forceRefresh = true;
    else if (value === "--no-network") result.noNetwork = true;
    else if (value === "--root") result.rootDir = argv[++index];
    else if (value === "--url") result.manifestUrl = argv[++index];
    else if (value === "--cache-dir") result.cacheDir = argv[++index];
    else if (value === "--installed-version") result.installedVersion = argv[++index];
    else if (value === "--installed-asar-sha256") result.installedAsarSha256 = argv[++index];
    else if (value === "--installed-exe-sha256") result.installedExeSha256 = argv[++index];
    else if (value === "--local-patcher-sha256") result.localPatcherSha256 = argv[++index];
    else if (value === "--mark-notified") result.markNotificationKey = argv[++index] || "";
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

module.exports = {
  checkRemoteUpdateChannel,
  compareSemver,
  evaluateManifest,
  markNotified,
  validateManifest,
};

if (require.main === module) {
  (async () => {
    const options = parseArguments(process.argv.slice(2));
    const result = Object.hasOwn(options, "markNotificationKey")
      ? markNotified({ ...options, notificationKey: options.markNotificationKey })
      : await checkRemoteUpdateChannel(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
