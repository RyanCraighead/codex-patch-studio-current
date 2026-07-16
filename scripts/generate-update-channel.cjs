#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateManifest } = require("./check-remote-update-channel.cjs");
const { patcherFingerprint } = require("./patcher-fingerprint.cjs");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function buildChannelManifest(rootDir, options = {}) {
  const channelConfig = readJson(path.join(rootDir, "config", "update-channel.json"));
  const compatibility = readJson(path.join(rootDir, "config", "compatibility.json"));
  const packageManifest = readJson(path.join(rootDir, "package.json"));
  const sourceFingerprint = patcherFingerprint(rootDir).sha256;
  const existingPath = path.join(rootDir, "update-channel", `${channelConfig.channel}.json`);
  const existing = fs.existsSync(existingPath) ? readJson(existingPath) : {};
  const commit = String(options.commit || existing.patcher?.commit || "").trim().toLowerCase();
  const manifest = {
    schemaVersion: 1,
    channel: channelConfig.channel,
    revision: Number(channelConfig.localRevision),
    publishedAt: options.publishedAt || existing.publishedAt || new Date().toISOString(),
    patcher: {
      version: packageManifest.version,
      releaseUrl: `${String(channelConfig.repositoryUrl).replace(/\/$/, "")}/releases`,
      sourceSha256: sourceFingerprint,
      ...(commit ? { commit } : {}),
    },
    codex: {
      packageName: compatibility.packageName,
      architecture: compatibility.architecture,
      validatedBuilds: compatibility.validatedBuilds,
    },
  };
  validateManifest(manifest, channelConfig.channel);
  return { manifest, outputPath: existingPath };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

module.exports = { buildChannelManifest, stableJson };

if (require.main === module) {
  const rootDir = path.resolve(__dirname, "..");
  const arguments_ = process.argv.slice(2);
  const write = arguments_.includes("--write");
  const commitIndex = arguments_.indexOf("--commit");
  const commit = commitIndex >= 0 ? arguments_[commitIndex + 1] : process.env.GITHUB_SHA || process.env.GITEA_COMMIT || "";
  const { manifest, outputPath } = buildChannelManifest(rootDir, {
    commit,
    publishedAt: write ? new Date().toISOString() : undefined,
  });
  const expected = stableJson(manifest);
  if (write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, expected, "utf8");
    process.stdout.write(`${outputPath}\n`);
  } else {
    const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "") : "";
    if (actual !== expected) {
      process.stderr.write("The committed update channel does not match package and compatibility metadata. Run npm run channel:write.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ok: true, outputPath, revision: manifest.revision, version: manifest.patcher.version })}\n`);
    }
  }
}
