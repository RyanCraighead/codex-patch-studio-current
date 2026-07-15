#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const forbiddenExtensions = new Set([
  ".asar", ".exe", ".dll", ".node", ".msi", ".msix", ".appx", ".appxbundle",
  ".cab", ".sfx", ".7z", ".rar", ".db", ".sqlite", ".sqlite3",
]);
const forbiddenPathParts = [
  "app.asar.extracted", "windowsapps", "codex-patched-app", "codex-portable-packages",
  "electron-user-data", "codex-chat-backups", "codex-import-backups", "build-output",
];
const allowedBuildToolBinaries = new Map([
  ["tools/7z-sfx-as-invoker.sfx", {
    size: 141824,
    sha256: "e1e9aa1eb9fe7f331de76479154ac4bb9998c8919dbc79bebe4f6eaa795ce312",
  }],
]);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:DEEPSEEK|DASHSCOPE|ZAI|OPENAI|ANTHROPIC)_API_KEY\s*[=:]\s*["']?[^\s"']{12,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function candidateFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  return result.stdout.split("\0").filter(Boolean);
}

function likelyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function scan() {
  const violations = [];
  for (const relativePath of candidateFiles()) {
    const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
    const filePath = path.join(rootDir, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const extension = path.extname(normalized);
    const allowedBuildTool = allowedBuildToolBinaries.get(normalized);
    const buffer = fs.readFileSync(filePath);
    if (allowedBuildTool) {
      const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      if (buffer.length !== allowedBuildTool.size || actualSha256 !== allowedBuildTool.sha256) {
        violations.push({ file: relativePath, reason: "allowlisted build-tool binary hash or size mismatch" });
      }
    } else if (forbiddenExtensions.has(extension)) {
      violations.push({ file: relativePath, reason: `forbidden binary/data extension ${extension}` });
    }
    if (forbiddenPathParts.some((part) => normalized.includes(part))) violations.push({ file: relativePath, reason: "generated, installed, or private application data path" });
    if (!allowedBuildTool && buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) violations.push({ file: relativePath, reason: "Windows executable payload" });
    if (!allowedBuildTool && buffer.length > 5 * 1024 * 1024 && !/\.(png|jpe?g|webp)$/i.test(extension)) violations.push({ file: relativePath, reason: "unexpected source file larger than 5 MiB" });
    if (!likelyText(buffer)) continue;
    const text = buffer.toString("utf8");
    for (const pattern of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) violations.push({ file: relativePath, reason: "credential or private-key pattern" });
    }
    if (/C:\\Users\\Ryan(?:\\|\b)/i.test(text)) violations.push({ file: relativePath, reason: "user-specific absolute path" });
    if (
      /\b(?:const|let|var)\s+\w*(?:Before|Original)\w*\s*=\s*[`"'][^\n]{600,}/.test(text) ||
      /\b(?:const|let|var)\s+\w*(?:Before|Original)\w*\s*=\s*[`"'][^\n]{120,}function\s/.test(text)
    ) {
      violations.push({ file: relativePath, reason: "large embedded upstream-source anchor; use structural matching" });
    }
  }
  return violations;
}

const violations = scan();
const result = { ok: violations.length === 0, scannedRoot: rootDir, violations };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (violations.length) process.exitCode = 1;
