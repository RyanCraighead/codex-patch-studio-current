#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");

function usage() {
  console.error(`Usage:
  node --no-warnings scripts/diagnose-codex-thread.cjs --thread-id <id> [options]

Options:
  --codex-home <path>     Codex home directory. Defaults to %USERPROFILE%\\.codex.
  --workspace <path>      Workspace path expected for this thread.
  --app-server            Also validate through codex app-server over stdio.
  --compact               Print only the high-signal summary fields.
  --json                  Print machine-readable JSON only.`);
}

function parseArgs(argv) {
  const options = {
    codexHome: path.join(os.homedir(), ".codex"),
    appServer: false,
    compact: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--thread-id") {
      options.threadId = argv[++index];
    } else if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg === "--workspace") {
      options.workspace = argv[++index];
    } else if (arg === "--app-server") {
      options.appServer = true;
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.threadId) {
    usage();
    process.exit(2);
  }

  options.codexHome = path.resolve(options.codexHome);
  if (options.workspace) {
    options.workspace = normalizeCwd(options.workspace);
  }
  return options;
}

function compactResult(result) {
  const thread = result.db?.thread || null;
  return {
    capturedAt: result.capturedAt,
    threadId: result.threadId,
    workspace: result.workspace,
    processCount: result.processes.length,
    visibleCodexProcessIds: result.processes
      .filter((process) => Number(process.MainWindowHandle || 0) !== 0)
      .map((process) => process.Id),
    files: result.files,
    thread: thread
      ? {
          id: thread.id,
          cwd: thread.cwd,
          source: thread.source,
          threadSource: thread.thread_source,
          archived: thread.archived,
          hasUserEvent: thread.has_user_event,
          updatedAtMs: thread.updated_at_ms,
          updatedAtIso: thread.updatedAtIso,
          rolloutPath: thread.rollout_path,
        }
      : null,
    rank: result.db?.rank || null,
    sameWorkspaceThreadCount: result.db?.sameWorkspaceThreads?.length || 0,
    sameWorkspaceThreadIds: (result.db?.sameWorkspaceThreads || []).map((item) => ({
      id: item.id,
      threadSource: item.threadSource,
      updatedAtIso: item.updatedAtIso,
      title: item.title,
    })),
    sessionIndexEntries: result.sessionIndex?.entries || [],
    globalState: {
      threadTitle: result.globalState?.threadTitle || null,
      threadOrderIndex: result.globalState?.threadOrderIndex ?? null,
      workspace: result.globalState?.workspace || null,
      workspaceLabel: result.globalState?.workspaceLabel || null,
    },
    appServer: result.appServer
      ? {
          exe: result.appServer.exe,
          listedCount: result.appServer.listedCount,
          targetListed: result.appServer.targetListed,
          nativeRecent50: result.appServer.nativeRecent50,
          nativeRecent200: result.appServer.nativeRecent200,
          nativeRecent1000: result.appServer.nativeRecent1000,
          readThread: result.appServer.readThread,
          listError: result.appServer.listError,
          readError: result.appServer.readError,
          error: result.appServer.error,
        }
      : null,
  };
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stripExtendedPrefix(value) {
  const text = String(value || "");
  return text.startsWith("\\\\?\\") ? text.slice(4) : text;
}

function normalizeCwd(value) {
  const stripped = stripExtendedPrefix(value).replace(/\//g, "\\");
  return path.win32.normalize(stripped);
}

function normalizeForCompare(value) {
  return normalizeCwd(value).replace(/\\+$/, "").toLowerCase();
}

function fileInfo(filePath) {
  if (!exists(filePath)) {
    return { path: filePath, exists: false };
  }
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function readJsonSafe(filePath, fallback = null) {
  if (!exists(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { parseError: error.message };
  }
}

function readSessionIndex(codexHome, threadId) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const result = { file: fileInfo(indexPath), entries: [], parseErrors: [] };
  if (!exists(indexPath)) {
    return result;
  }

  fs.readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (!line.trim()) {
        return;
      }
      try {
        const value = JSON.parse(line);
        if (value && value.id === threadId) {
          result.entries.push({ lineNumber: index + 1, value });
        }
      } catch (error) {
        result.parseErrors.push({ lineNumber: index + 1, error: error.message, sample: line.slice(0, 200) });
      }
    });

  return result;
}

function readDb(codexHome, threadId, workspace) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const result = { file: fileInfo(dbPath), thread: null, rank: null, topThreads: [], sameWorkspaceThreads: [], errors: [] };
  if (!exists(dbPath)) {
    return result;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name);
    result.columns = columns;
    result.thread = db
      .prepare("SELECT * FROM threads WHERE id = ?")
      .get(threadId);

    if (result.thread?.updated_at_ms) {
      result.thread.updatedAtIso = new Date(Number(result.thread.updated_at_ms)).toISOString();
    }

    result.rank = db
      .prepare(
        [
          "WITH ranked AS (",
          "SELECT id, updated_at_ms, ROW_NUMBER() OVER (ORDER BY updated_at_ms DESC) AS rank",
          "FROM threads",
          "WHERE archived = 0 AND COALESCE(thread_source, 'user') = 'user'",
          ") SELECT rank FROM ranked WHERE id = ?",
        ].join(" ")
      )
      .get(threadId);

    result.topThreads = db
      .prepare(
        [
          "SELECT id, title, cwd, source, thread_source, archived, has_user_event, updated_at, updated_at_ms",
          "FROM threads",
          "WHERE archived = 0 AND COALESCE(thread_source, 'user') = 'user'",
          "ORDER BY updated_at_ms DESC",
          "LIMIT 35",
        ].join(" ")
      )
      .all()
      .map((row, index) => ({
        rank: index + 1,
        id: row.id,
        updatedAtIso: row.updated_at_ms ? new Date(Number(row.updated_at_ms)).toISOString() : null,
        source: row.source,
        threadSource: row.thread_source,
        hasUserEvent: row.has_user_event,
        cwd: row.cwd,
        title: String(row.title || "").replace(/\s+/g, " ").slice(0, 120),
      }));

    if (workspace) {
      const normalizedWorkspace = normalizeForCompare(workspace);
      result.sameWorkspaceThreads = db
        .prepare(
          [
            "SELECT id, title, cwd, source, thread_source, archived, has_user_event, updated_at, updated_at_ms",
            "FROM threads",
            "WHERE archived = 0",
            "ORDER BY updated_at_ms DESC",
          ].join(" ")
        )
        .all()
        .filter((row) => normalizeForCompare(row.cwd) === normalizedWorkspace)
        .map((row) => ({
          id: row.id,
          updatedAtIso: row.updated_at_ms ? new Date(Number(row.updated_at_ms)).toISOString() : null,
          source: row.source,
          threadSource: row.thread_source,
          hasUserEvent: row.has_user_event,
          cwd: row.cwd,
          title: String(row.title || "").replace(/\s+/g, " ").slice(0, 120),
        }));
    }
  } catch (error) {
    result.errors.push(error.stack || error.message);
  } finally {
    db.close();
  }
  return result;
}

function readGlobalState(codexHome, threadId, workspace) {
  const statePath = path.join(codexHome, ".codex-global-state.json");
  const state = readJsonSafe(statePath, {});
  const result = { file: fileInfo(statePath), parseError: state?.parseError || null };
  if (!state || state.parseError) {
    return result;
  }

  const workspaceKeys = ["electron-saved-workspace-roots", "active-workspace-roots", "project-order"];
  result.threadTitle = state?.["thread-titles"]?.titles?.[threadId] || null;
  result.threadOrderIndex = Array.isArray(state?.["thread-titles"]?.order)
    ? state["thread-titles"].order.indexOf(threadId)
    : -1;
  result.threadOrderHead = Array.isArray(state?.["thread-titles"]?.order) ? state["thread-titles"].order.slice(0, 20) : [];
  result.workspace = {};

  for (const key of workspaceKeys) {
    const values = Array.isArray(state[key]) ? state[key] : [];
    result.workspace[key] = {
      count: values.length,
      index: workspace ? values.findIndex((item) => normalizeForCompare(item) === normalizeForCompare(workspace)) : -1,
      head: values.slice(0, 10),
    };
  }

  const labels = state["electron-workspace-root-labels"] || {};
  result.workspaceLabel = workspace ? labels[workspace] || labels[stripExtendedPrefix(workspace)] || null : null;
  return result;
}

function getCodexProcesses() {
  if (process.platform !== "win32") {
    return [];
  }
  const command = [
    "Get-Process -ErrorAction SilentlyContinue |",
    "Where-Object { $_.ProcessName -in @('ChatGPT','Codex') -or ($_.ProcessName -eq 'codex' -and ($_.Path -like '*\\OpenAI\\Codex\\bin\\*' -or $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*' -or $_.Path -like '*\\CodexPatchStudioCurrent\\*')) } |",
    "Select-Object ProcessName,Id,MainWindowHandle,Path | ConvertTo-Json -Depth 3",
  ].join(" ");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return [{ error: error.message }];
  }
}

function findCodexExe() {
  const launcherConfig = readJsonSafe(path.join(rootDir, "codex-launcher.local.json"));
  const configuredCli = launcherConfig?.resourcesDir ? path.join(launcherConfig.resourcesDir, "codex.exe") : null;
  if (configuredCli && exists(configuredCli)) {
    return configuredCli;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [];
  if (exists(binRoot)) {
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(binRoot, entry.name, "codex.exe"));
      }
    }
  }
  candidates.push(path.join(binRoot, "codex.exe"));

  const existing = candidates
    .filter(exists)
    .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (existing.length) {
    return existing[0].candidate;
  }

  try {
    const output = execFileSync("where.exe", ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().includes("\\appdata\\local\\openai\\codex\\bin\\") && line.toLowerCase().endsWith("codex.exe"));
    if (match) {
      return match;
    }
  } catch {
    // Fall through.
  }

  return "codex";
}

function jsonRpcWait(responses, id, child, stderrRef, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        try {
          child.kill();
        } catch {
          // Ignore cleanup failure.
        }
        reject(new Error(`Timed out waiting for app-server response ${id}. ${stderrRef.value.slice(-2000)}`));
      }
    }, 50);
  });
}

async function appServerDiagnostics(codexHome, threadId, workspace) {
  const exe = findCodexExe();
  const child = spawn(exe, ["app-server", "--listen", "stdio://"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const responses = new Map();
  const stderrRef = { value: "" };
  let stdout = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    let index;
    while ((index = stdout.indexOf("\n")) >= 0) {
      const raw = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (!raw.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(raw);
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      } catch {
        stderrRef.value += `\nUnparsed stdout: ${raw.slice(0, 500)}`;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrRef.value += chunk.toString();
  });

  const send = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };

  try {
    send(1, "initialize", {
      clientInfo: { name: "codex-thread-diagnostics", title: "Codex Thread Diagnostics", version: "0.0.0" },
      capabilities: null,
    });
    const init = await jsonRpcWait(responses, 1, child, stderrRef);

    const requests = [
      jsonRpcWait(responses, 2, child, stderrRef),
      jsonRpcWait(responses, 3, child, stderrRef),
      jsonRpcWait(responses, 4, child, stderrRef),
      jsonRpcWait(responses, 5, child, stderrRef),
      jsonRpcWait(responses, 6, child, stderrRef),
    ];
    send(2, "thread/list", {
      limit: 1000,
      sourceKinds: ["vscode"],
      cwd: workspace,
      useStateDbOnly: false,
    });
    send(3, "thread/read", {
      threadId,
      includeTurns: true,
    });
    send(4, "thread/list", {
      limit: 50,
      cursor: null,
      sortKey: "updated_at",
      modelProviders: null,
      sourceKinds: [],
      archived: false,
    });
    send(5, "thread/list", {
      limit: 200,
      cursor: null,
      sortKey: "updated_at",
      modelProviders: null,
      sourceKinds: [],
      archived: false,
    });
    send(6, "thread/list", {
      limit: 1000,
      cursor: null,
      sortKey: "updated_at",
      modelProviders: null,
      sourceKinds: [],
      archived: false,
    });
    const [listResponse, readResponse, nativeRecent50Response, nativeRecent200Response, nativeRecent1000Response] =
      await Promise.all(requests);
    const listed = listResponse.result?.data || [];
    const nativeRecent50 = nativeRecent50Response.result?.data || [];
    const nativeRecent200 = nativeRecent200Response.result?.data || [];
    const nativeRecent1000 = nativeRecent1000Response.result?.data || [];
    const readThread = readResponse.result?.thread || null;
    const turns = readThread?.turns || [];
    const itemCounts = turns
      .flatMap((turn) => turn.items || [])
      .reduce((counts, item) => {
        counts[item.type] = (counts[item.type] || 0) + 1;
        return counts;
      }, {});

    return {
      exe,
      initializeError: init.error || null,
      listError: listResponse.error || null,
      readError: readResponse.error || null,
      listedCount: listed.length,
      listedIds: listed.map((thread) => ({ id: thread.id, name: thread.name, updatedAt: thread.updatedAt, cwd: thread.cwd })),
      targetListed: listed.some((thread) => thread.id === threadId),
      nativeRecent50: summarizeThreadList(nativeRecent50Response, nativeRecent50, threadId),
      nativeRecent200: summarizeThreadList(nativeRecent200Response, nativeRecent200, threadId),
      nativeRecent1000: summarizeThreadList(nativeRecent1000Response, nativeRecent1000, threadId),
      readThread: readThread
        ? {
            id: readThread.id,
            name: readThread.name,
            turnCount: turns.length,
            itemCounts,
          }
        : null,
      stderrTail: stderrRef.value.slice(-4000),
    };
  } finally {
    try {
      child.kill();
    } catch {
      // Ignore cleanup failure.
    }
  }
}

function summarizeThreadList(response, listed, threadId) {
  const targetIndex = listed.findIndex((thread) => thread.id === threadId);
  const target = targetIndex >= 0 ? listed[targetIndex] : null;
  return {
    error: response.error || null,
    count: listed.length,
    targetListed: targetIndex >= 0,
    targetIndex,
    target: target
      ? {
          id: target.id,
          name: target.name,
          source: target.source,
          cwd: target.cwd,
          updatedAt: target.updatedAt,
          updatedAtIso: Number.isFinite(Number(target.updatedAt)) ? new Date(Number(target.updatedAt) * 1000).toISOString() : null,
        }
      : null,
    first: listed.slice(0, 10).map((thread, index) => ({
      rank: index + 1,
      id: thread.id,
      name: thread.name,
      source: thread.source,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
      updatedAtIso: Number.isFinite(Number(thread.updatedAt)) ? new Date(Number(thread.updatedAt) * 1000).toISOString() : null,
    })),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = readDb(options.codexHome, options.threadId, options.workspace);
  const rolloutPath = db.thread?.rollout_path || null;
  const result = {
    capturedAt: new Date().toISOString(),
    codexHome: options.codexHome,
    threadId: options.threadId,
    workspace: options.workspace || null,
    normalizedWorkspace: options.workspace ? normalizeForCompare(options.workspace) : null,
    processes: getCodexProcesses(),
    files: {
      db: db.file,
      dbWal: fileInfo(path.join(options.codexHome, "state_5.sqlite-wal")),
      dbShm: fileInfo(path.join(options.codexHome, "state_5.sqlite-shm")),
      globalState: fileInfo(path.join(options.codexHome, ".codex-global-state.json")),
      sessionIndex: fileInfo(path.join(options.codexHome, "session_index.jsonl")),
      rollout: rolloutPath ? fileInfo(rolloutPath) : null,
    },
    db,
    sessionIndex: readSessionIndex(options.codexHome, options.threadId),
    globalState: readGlobalState(options.codexHome, options.threadId, options.workspace),
    appServer: null,
  };

  if (options.appServer) {
    try {
      result.appServer = await appServerDiagnostics(options.codexHome, options.threadId, options.workspace || db.thread?.cwd || "");
    } catch (error) {
      result.appServer = { error: error.stack || error.message };
    }
  }

  process.stdout.write(`${JSON.stringify(options.compact ? compactResult(result) : result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
