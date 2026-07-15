#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const importResultsDir = path.join(rootDir, "codex-import-results");
const importerApiBase = "http://127.0.0.1:1";

function usage() {
  console.error("Usage: node scripts/preflight-and-schedule-codex-import.cjs --job-path <path> --log-path <path>");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--job-path") {
      options.jobPath = argv[++index];
    } else if (arg === "--log-path") {
      options.logPath = argv[++index];
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.jobPath || !options.logPath) {
    usage();
    process.exit(2);
  }
  options.jobPath = path.resolve(options.jobPath);
  options.logPath = path.resolve(options.logPath);
  return options;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function log(logPath, message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copyCodexHomeForPreflight(codexHome) {
  const tempHome = path.join(importResultsDir, "preflight-codex-home", timestampStamp());
  fs.mkdirSync(tempHome, { recursive: true });

  const sourceDb = path.join(codexHome, "state_5.sqlite");
  const targetDb = path.join(tempHome, "state_5.sqlite");
  if (exists(sourceDb)) {
    execFileSync("sqlite3", [sourceDb, `.backup '${targetDb.replace(/'/g, "''")}'`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  for (const file of [".codex-global-state.json", "session_index.jsonl"]) {
    const source = path.join(codexHome, file);
    if (exists(source)) {
      fs.copyFileSync(source, path.join(tempHome, file));
    }
  }

  return tempHome;
}

function runImporterJson(args, timeoutMs = 300000) {
  const output = execFileSync(process.execPath, [path.join(rootDir, "scripts", "import-augment-to-codex.cjs"), ...args], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return JSON.parse(output);
}

function importerErrorMessage(error) {
  const parts = [error?.message || String(error)];
  const stdout = String(error?.stdout || "").trim();
  const stderr = String(error?.stderr || "").trim();
  if (stdout) {
    parts.push(`stdout: ${stdout.slice(-4000)}`);
  }
  if (stderr) {
    parts.push(`stderr: ${stderr.slice(-4000)}`);
  }
  return parts.join("\n");
}

function importerArgsForItem(item, modeArgs = []) {
  const args = [
    "--api-base",
    importerApiBase,
    "--export-id",
    item.exportId,
    "--conversation-id",
    item.conversationId,
    "--title",
    item.title || "",
    ...modeArgs,
  ];
  if (item.threadId) {
    args.push("--thread-id", item.threadId);
  }
  if (item.targetCwd) {
    args.push("--cwd", item.targetCwd);
  }
  return args;
}

function startHiddenPowerShell(args, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const out = fs.openSync(outputPath, "a");
  let closed = false;
  const closeOutput = () => {
    if (!closed) {
      closed = true;
      fs.closeSync(out);
    }
  };
  const child = spawn("powershell.exe", args, {
    cwd: rootDir,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      closeOutput();
      error.pid = child.pid;
      reject(error);
    });
    child.on("exit", (code, signal) => {
      closeOutput();
      resolve({ code, signal });
    });
  });
  return { pid: child.pid, completion };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const job = JSON.parse(fs.readFileSync(options.jobPath, "utf8"));
  const items = Array.isArray(job.items) ? job.items : [];
  if (!items.length) {
    throw new Error("Import job has no items.");
  }

  const preflightPath =
    job.preflightPath || path.join(path.dirname(options.jobPath), `${path.basename(options.jobPath, ".json")}.preflight.json`);
  log(options.logPath, `Starting background preflight for ${items.length} import(s).`);

  const preflight = {
    status: "running",
    createdAt: job.createdAt || new Date().toISOString(),
    startedAt: new Date().toISOString(),
    total: items.length,
    fastPreflight: Boolean(job.fastPreflight),
    tempCodexHome: null,
    skipped: [],
    validations: [],
  };
  writeJson(preflightPath, preflight);

  const validatedItems = [];
  if (job.fastPreflight) {
    log(options.logPath, `Fast preflight metadata pass for ${items.length} import(s). Full rollouts are built once during apply.`);
    for (const item of items) {
      if (!item.exportId || !item.conversationId) {
        preflight.skipped.push({
          exportId: item.exportId || "",
          conversationId: item.conversationId || "",
          reason: "missing-source-id",
        });
        continue;
      }
      validatedItems.push(item);
      preflight.validations.push({
        exportId: item.exportId,
        conversationId: item.conversationId,
        threadId: item.threadId || null,
        title: item.title || "",
        cwd: item.targetCwd || item.cwd || "",
        validation: { skipped: true, reason: "fast-preflight-metadata-only" },
      });
    }
    writeJson(preflightPath, preflight);
  } else {
    preflight.tempCodexHome = copyCodexHomeForPreflight(job.codexHome);
    writeJson(preflightPath, preflight);
  }

  for (const [index, item] of (job.fastPreflight ? [] : items).entries()) {
    log(options.logPath, `Preflight dry run ${index + 1}/${items.length}: ${item.exportId} / ${item.conversationId}`);
    let dryRun;
    try {
      dryRun = runImporterJson(importerArgsForItem(item, ["--dry-run"]));
    } catch (error) {
      const message = importerErrorMessage(error);
      log(options.logPath, `Skipping failed dry run ${index + 1}/${items.length}: ${item.exportId} / ${item.conversationId}\n${message}`);
      preflight.skipped.push({
        exportId: item.exportId,
        conversationId: item.conversationId,
        reason: "dry-run-failed",
        error: message,
      });
      writeJson(preflightPath, preflight);
      continue;
    }
    if (!dryRun.turnCount || !dryRun.exchangeCount) {
      log(options.logPath, `Skipping empty conversation ${index + 1}/${items.length}: ${item.exportId} / ${item.conversationId}`);
      preflight.skipped.push({
        exportId: item.exportId,
        conversationId: item.conversationId,
        reason: "empty-conversation",
        lineCount: dryRun.lineCount || 0,
        turnCount: dryRun.turnCount || 0,
        exchangeCount: dryRun.exchangeCount || 0,
      });
      writeJson(preflightPath, preflight);
      continue;
    }
    const validatedItem = {
      ...item,
      threadId: dryRun.threadId,
      title: dryRun.title,
      targetCwd: dryRun.cwd,
    };

    if (job.fastPreflight) {
      validatedItems.push(validatedItem);
      preflight.validations.push({
        exportId: item.exportId,
        conversationId: item.conversationId,
        threadId: validatedItem.threadId,
        title: validatedItem.title,
        cwd: validatedItem.targetCwd,
        lineCount: dryRun.lineCount,
        turnCount: dryRun.turnCount,
        exchangeCount: dryRun.exchangeCount,
        toolUseCount: dryRun.toolUseCount,
        checkpointDiffCount: dryRun.checkpointDiffCount,
        validation: { skipped: true, reason: "fast-preflight" },
      });
      writeJson(preflightPath, preflight);
      continue;
    }

    log(options.logPath, `Validating ${index + 1}/${items.length}: ${validatedItem.threadId}`);
    let validation;
    try {
      validation = runImporterJson(
        importerArgsForItem(validatedItem, [
          "--codex-home",
          preflight.tempCodexHome,
          "--apply",
          "--validate",
          "--allow-running",
          "--no-registry",
        ])
      );
    } catch (error) {
      const message = importerErrorMessage(error);
      log(options.logPath, `Skipping failed validation ${index + 1}/${items.length}: ${item.exportId} / ${item.conversationId}\n${message}`);
      preflight.skipped.push({
        exportId: item.exportId,
        conversationId: item.conversationId,
        threadId: validatedItem.threadId,
        title: validatedItem.title,
        reason: "validation-failed",
        error: message,
      });
      writeJson(preflightPath, preflight);
      continue;
    }

    validatedItems.push(validatedItem);
    preflight.validations.push({
      exportId: item.exportId,
      conversationId: item.conversationId,
      threadId: validation.threadId,
      title: validation.title,
      cwd: validation.cwd,
      lineCount: validation.lineCount,
      turnCount: validation.turnCount,
      exchangeCount: validation.exchangeCount,
      toolUseCount: validation.toolUseCount,
      checkpointDiffCount: validation.checkpointDiffCount,
      validation: validation.validation,
    });
    writeJson(preflightPath, preflight);
  }

  if (!validatedItems.length) {
    preflight.status = "passed";
    preflight.completedAt = new Date().toISOString();
    writeJson(preflightPath, preflight);
    log(options.logPath, "Preflight found no importable conversations. No after-close watcher was started.");
    return;
  }

  const importLogPath = path.resolve(
    job.importLogPath || path.join(path.dirname(options.jobPath), `${path.basename(options.jobPath, ".json")}.import.log`)
  );
  preflight.status = "passed";
  preflight.completedAt = new Date().toISOString();
  preflight.importLogPath = importLogPath;
  const updatedJob = {
    ...job,
    preflightPath,
    importLogPath,
    stopCodex: job.stopCodex !== false,
    preflightCompletedAt: preflight.completedAt,
    items: validatedItems,
  };
  writeJson(options.jobPath, updatedJob);

  const scriptPath = path.join(rootDir, "scripts", "run-codex-import-after-close.ps1");
  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    scriptPath,
    "-JobPath",
    options.jobPath,
    "-LogPath",
    importLogPath,
  ];
  if (updatedJob.stopCodex) {
    psArgs.push("-StopCodex");
  }
  if (job.noRestartApp) {
    psArgs.push("-NoRestartApp");
  }
  writeJson(preflightPath, preflight);

  const importerPowerShellLogPath = `${importLogPath}.powershell.log`;
  const importer = startHiddenPowerShell(psArgs, importerPowerShellLogPath);
  preflight.importerPid = importer.pid;
  preflight.importerStartedAt = new Date().toISOString();
  preflight.importerPowerShellLogPath = importerPowerShellLogPath;
  writeJson(preflightPath, preflight);
  log(
    options.logPath,
    `Preflight passed. Running hidden stop/import/relaunch importer as PowerShell PID ${importer.pid}. Import log: ${importLogPath}. PowerShell log: ${importerPowerShellLogPath}`
  );

  const result = await importer.completion;
  preflight.importerExitedAt = new Date().toISOString();
  preflight.importerExitCode = result.code;
  preflight.importerExitSignal = result.signal || null;
  writeJson(preflightPath, preflight);
  log(
    options.logPath,
    `Importer PowerShell PID ${importer.pid} exited with code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}.`
  );
  if (result.code !== 0) {
    throw new Error(`Importer PowerShell exited with code ${result.code}. See ${importLogPath} and ${importerPowerShellLogPath}`);
  }
}

main().catch((error) => {
  const message = error.stack || error.message;
  try {
    const options = parseArgs(process.argv.slice(2));
    log(options.logPath, `ERROR: ${message}`);
    const job = exists(options.jobPath) ? JSON.parse(fs.readFileSync(options.jobPath, "utf8")) : {};
    const preflightPath =
      job.preflightPath || path.join(path.dirname(options.jobPath), `${path.basename(options.jobPath, ".json")}.preflight.json`);
    const existing = exists(preflightPath) ? JSON.parse(fs.readFileSync(preflightPath, "utf8")) : {};
    writeJson(preflightPath, {
      ...existing,
      status: "failed",
      failedAt: new Date().toISOString(),
      error: message,
    });
  } catch {
    // Keep the original failure as the process exit signal.
  }
  console.error(message);
  process.exit(1);
});
