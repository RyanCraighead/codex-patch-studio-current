#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");

function discoverTests(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  const pending = [rootPath];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && entry.name.endsWith(".test.cjs")) files.push(filePath);
    }
  }
  return files;
}

const tests = [
  ...discoverTests(path.join(rootDir, "tests")),
  ...discoverTests(path.join(rootDir, "features")),
].sort((left, right) => left.localeCompare(right));

if (!tests.length) {
  console.error("No test files were discovered.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: rootDir,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
