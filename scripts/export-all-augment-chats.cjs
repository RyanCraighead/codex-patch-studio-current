#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fileURLToPath } = require("url");

const rootDir = path.resolve(__dirname, "..");
const stateExportsRoot = path.join(rootDir, "augment-vscode-state-exports");
const chatExportsRoot = path.join(rootDir, "augment-chat-exports");
const defaultWorkspaceStorageRoot = path.join(
  process.env.APPDATA || "",
  "Code",
  "User",
  "workspaceStorage"
);

function sanitizeFileName(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function decodeUriMaybe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function workspaceTargetToPath(target) {
  if (!target || typeof target !== "string") {
    return null;
  }

  if (target.startsWith("file:")) {
    try {
      return fileURLToPath(target);
    } catch {
      return decodeUriMaybe(target.replace(/^file:\/\/\/?/i, ""));
    }
  }

  if (/^[a-z]+:\/\//i.test(target)) {
    const decoded = decodeUriMaybe(target);
    const parts = decoded.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts.join(path.sep) : decoded;
  }

  return decodeUriMaybe(target);
}

function workspaceInfo(storageDir) {
  const workspaceJsonPath = path.join(storageDir, "workspace.json");
  const raw = readJsonSafe(workspaceJsonPath) || {};
  const target = raw.folder || raw.workspace || raw.configuration || null;
  const targetPath = workspaceTargetToPath(target);
  const name = targetPath ? path.basename(targetPath) : path.basename(storageDir);

  return {
    raw,
    target,
    targetPath,
    name: name || path.basename(storageDir),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...options,
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function copyLevelDbSnapshot(sourceDir, storageId) {
  const snapshotRoot = path.join(rootDir, "augment-kv-snapshots");
  const snapshotDir = path.join(
    snapshotRoot,
    `${sanitizeFileName(storageId)}-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );

  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.cpSync(sourceDir, snapshotDir, {
    recursive: true,
    force: true,
    filter: (source) => path.basename(source) !== "LOCK",
  });
  return snapshotDir;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function exportWebviewState(storageDir, outDir) {
  const candidates = [
    path.join(storageDir, "state.vscdb"),
    path.join(storageDir, "state.vscdb.backup"),
  ].filter((candidate, index, array) => fs.existsSync(candidate) && array.indexOf(candidate) === index);

  const attempts = [];
  for (const dbPath of candidates) {
    const nodeExecutable = process.env.CODEX_PATCHED_NODE || process.execPath;
    const result = run(nodeExecutable, [
      "--no-warnings",
      path.join("scripts", "export-augment-webview-state.cjs"),
      dbPath,
      outDir,
    ]);
    attempts.push({
      dbPath,
      ok: result.ok,
      status: result.status,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    });
    if (result.ok) {
      return { ok: true, dbPath, result: parseJsonOutput(result.stdout), attempts };
    }
  }

  const combinedErrors = attempts.map((attempt) => attempt.stderr).join("\n");
  const missingWebviewState =
    /Key not found/.test(combinedErrors) ||
    /KeyError: 'webviewState'/.test(combinedErrors);

  return {
    ok: false,
    skipped: missingWebviewState,
    reason: missingWebviewState ? "No Augment webview state in this workspace storage entry" : null,
    attempts,
  };
}

function exportLevelDb(kvPath, outDir, storageId) {
  const env = { ...process.env };
  const bundledClassicLevel = path.resolve("node_modules", "classic-level");
  if (!env.CLASSIC_LEVEL_PREFIX && fs.existsSync(bundledClassicLevel)) {
    env.CLASSIC_LEVEL_PREFIX = path.resolve(".");
  }
  const defaultClassicLevelPrefix = path.join(process.env.TEMP || "", "codex-classic-level-reader");
  if (!env.CLASSIC_LEVEL_PREFIX && fs.existsSync(path.join(defaultClassicLevelPrefix, "node_modules", "classic-level"))) {
    env.CLASSIC_LEVEL_PREFIX = defaultClassicLevelPrefix;
  }

  const args = [
    path.join("scripts", "export-augment-chat-history.cjs"),
    kvPath,
    outDir,
  ];
  const result = run(process.execPath, args, { env });
  let snapshot = null;
  let finalResult = result;

  if (!result.ok && /Database failed to open|LOCK|being used by another process/i.test(`${result.stderr}\n${result.stdout}`)) {
    snapshot = copyLevelDbSnapshot(kvPath, storageId);
    finalResult = run(process.execPath, [
      path.join("scripts", "export-augment-chat-history.cjs"),
      snapshot,
      outDir,
    ], { env });
  }

  return {
    ok: finalResult.ok,
    status: finalResult.status,
    stderr: finalResult.stderr.trim(),
    stdout: finalResult.stdout.trim(),
    result: parseJsonOutput(finalResult.stdout),
    directOpenFailed: snapshot ? true : false,
    snapshot,
    directError: snapshot ? result.stderr.trim() || result.stdout.trim() : null,
  };
}

function writeMetadata(outDir, metadata) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "workspace-export-metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8"
  );
}

function copyUserEditAssets(storageDir, outDir) {
  const sourceRoot = path.join(storageDir, "Augment.vscode-augment", "augment-user-assets");
  const targetRoot = path.join(outDir, "user-assets");
  const safeOutDir = path.resolve(outDir);
  const copied = [];

  for (const name of ["agent-edits", "checkpoint-documents"]) {
    const source = path.join(sourceRoot, name);
    if (!fs.existsSync(source)) {
      continue;
    }

    const target = path.join(targetRoot, name);
    const resolvedTarget = path.resolve(target);
    const relativeTarget = path.relative(safeOutDir, resolvedTarget);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new Error(`Refusing to copy user edit assets outside export directory: ${resolvedTarget}`);
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
    copied.push(name);
  }

  return {
    copied,
    targetRoot: copied.length ? targetRoot : null,
  };
}

function discoverWorkspaceStorage(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const storageDir = path.join(root, entry.name);
      const kvPath = path.join(storageDir, "Augment.vscode-augment", "augment-kv-store");
      const stateDbPath = path.join(storageDir, "state.vscdb");
      const backupStateDbPath = path.join(storageDir, "state.vscdb.backup");
      return {
        storageId: entry.name,
        storageDir,
        kvPath,
        hasLevelDb: fs.existsSync(kvPath),
        hasStateDb: fs.existsSync(stateDbPath) || fs.existsSync(backupStateDbPath),
        workspace: workspaceInfo(storageDir),
      };
    })
    .filter((entry) => entry.hasLevelDb || entry.hasStateDb);
}

async function main() {
  const workspaceStorageRoot = path.resolve(process.argv[2] || defaultWorkspaceStorageRoot);
  if (!workspaceStorageRoot || !fs.existsSync(workspaceStorageRoot)) {
    throw new Error(`workspaceStorage root does not exist: ${workspaceStorageRoot}`);
  }

  fs.mkdirSync(stateExportsRoot, { recursive: true });
  fs.mkdirSync(chatExportsRoot, { recursive: true });

  const discovered = discoverWorkspaceStorage(workspaceStorageRoot);
  const report = {
    workspaceStorageRoot,
    exportedAt: new Date().toISOString(),
    discoveredCount: discovered.length,
    stateExportCount: 0,
    skippedStateExportCount: 0,
    levelDbExportCount: 0,
    skippedLevelDbCount: 0,
    failedStateExportCount: 0,
    failedLevelDbExportCount: 0,
    totalWebviewConversations: 0,
    totalLevelDbConversations: 0,
    totalExchanges: 0,
    totalToolUses: 0,
    workspaces: [],
  };

  for (const [index, entry] of discovered.entries()) {
    const label = sanitizeFileName(entry.workspace.name || entry.storageId);
    const exportId = `${label}-${entry.storageId}`;
    const stateOutDir = path.join(stateExportsRoot, exportId);
    const chatOutDir = path.join(chatExportsRoot, exportId);
    const baseMetadata = {
      exportId,
      storageId: entry.storageId,
      storageDir: entry.storageDir,
      workspace: entry.workspace,
      hasStateDb: entry.hasStateDb,
      hasLevelDb: entry.hasLevelDb,
      exportedAt: report.exportedAt,
    };

    console.error(`[${index + 1}/${discovered.length}] ${exportId}`);

    let stateExport = null;
    if (entry.hasStateDb) {
      stateExport = exportWebviewState(entry.storageDir, stateOutDir);
      if (stateExport.ok) {
        report.stateExportCount += 1;
        report.totalWebviewConversations += stateExport.result?.conversationCount || 0;
      } else if (stateExport.skipped) {
        report.skippedStateExportCount += 1;
      } else {
        report.failedStateExportCount += 1;
      }
      if (stateExport.ok || !stateExport.skipped) {
        writeMetadata(stateOutDir, { ...baseMetadata, exportKind: "webview-state", stateExport });
      }
    }

    let levelDbExport = null;
    if (entry.hasLevelDb) {
      levelDbExport = exportLevelDb(entry.kvPath, chatOutDir, entry.storageId);
      if (levelDbExport.ok) {
        report.levelDbExportCount += 1;
        report.totalLevelDbConversations += levelDbExport.result?.conversationCount || 0;
        report.totalExchanges += levelDbExport.result?.counts?.exchange || 0;
        report.totalToolUses += levelDbExport.result?.counts?.tooluse || 0;
      } else {
        report.failedLevelDbExportCount += 1;
      }
    } else {
      report.skippedLevelDbCount += 1;
    }

    const userEditAssets = copyUserEditAssets(entry.storageDir, chatOutDir);
    if (entry.hasLevelDb || userEditAssets.copied.length > 0) {
      writeMetadata(chatOutDir, {
        ...baseMetadata,
        exportKind: entry.hasLevelDb ? "leveldb-chat" : "user-assets",
        levelDbExport,
        userEditAssets,
      });
    } else {
      levelDbExport = null;
    }

    report.workspaces.push({
      exportId,
      storageId: entry.storageId,
      workspace: entry.workspace,
      hasStateDb: entry.hasStateDb,
      hasLevelDb: entry.hasLevelDb,
      stateOk: stateExport ? stateExport.ok : false,
      levelDbOk: levelDbExport ? levelDbExport.ok : false,
      stateConversationCount: stateExport?.result?.conversationCount ?? null,
      levelDbConversationCount: levelDbExport?.result?.conversationCount ?? null,
      exchangeCount: levelDbExport?.result?.counts?.exchange ?? null,
      toolUseCount: levelDbExport?.result?.counts?.tooluse ?? null,
      userEditAssets: userEditAssets.copied,
      stateError: stateExport && !stateExport.ok ? stateExport.attempts.map((attempt) => attempt.stderr).filter(Boolean).join("\n") : null,
      stateSkipReason: stateExport?.skipped ? stateExport.reason : null,
      levelDbError: levelDbExport && !levelDbExport.ok ? levelDbExport.stderr : null,
    });
  }

  report.workspaces.sort((a, b) => String(a.exportId).localeCompare(String(b.exportId)));
  fs.writeFileSync(path.join(rootDir, "augment-export-all-summary.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
