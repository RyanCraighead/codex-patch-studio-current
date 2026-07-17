#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const url = require("url");
const { spawn, execFileSync } = require("child_process");
const { readJsonlLinesSync } = require("./jsonl-reader.cjs");

const rootDir = path.resolve(__dirname, "..");
const importManagerSourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
const publicDir = path.join(__dirname, "public");
const stateExportsDir = path.join(rootDir, "augment-vscode-state-exports");
const chatExportsDir = path.join(rootDir, "augment-chat-exports");
const rooExportsDir = path.join(rootDir, "roo-code-exports");
const clineExportsDir = path.join(rootDir, "cline-chat-exports");
const kiroExportsDir = path.join(rootDir, "kiro-chat-exports");
const importResultsDir = path.join(rootDir, "codex-import-results");
const importJobsDir = path.join(importResultsDir, "import-jobs");
const codexMoveResultsDir = path.join(rootDir, "codex-project-move-results");
const codexMoveJobsDir = path.join(codexMoveResultsDir, "jobs");
const defaultCodexHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const codexExportPrefix = "codex-";
const importerApiBase = "http://127.0.0.1:1";
const maxRolloutStatsBytes = 128 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const caches = {
  exports: null,
  indexes: new Map(),
  fileMaps: new Map(),
  editIndexes: new Map(),
  codexRolloutStats: new Map(),
  importStatus: null,
};

let NodeSqliteDatabaseSync = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function sendJson(response, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, { error: message }, status);
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024 * 5) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function importKey(exportId, conversationId) {
  return `${exportId}:${conversationId}`;
}

function normalizeCwd(cwd) {
  return String(cwd || "").replace(/^\\\\\?\\/, "");
}

function trimTrailingSeparators(value) {
  let output = String(value || "");
  while (output.length > 3 && /[\\/]$/.test(output)) {
    output = output.slice(0, -1);
  }
  return output;
}

function comparablePath(value) {
  const stripped = trimTrailingSeparators(normalizeCwd(value)).replace(/\//g, "\\");
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function timestampMsToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  const date = new Date(number > 100000000000 ? number : number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function walkFiles(dirPath, predicate, out = []) {
  if (!exists(dirPath)) {
    return out;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, predicate, out);
    } else if (!predicate || predicate(filePath, entry)) {
      out.push(filePath);
    }
  }
  return out;
}

function readFirstLine(filePath, maxBytes = 65536) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return text.split(/\r?\n/, 1)[0] || "";
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionIndexNames(codexHome = defaultCodexHome) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const names = new Map();
  if (!exists(indexPath)) {
    return names;
  }
  for (const rawLine of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(rawLine);
      if (entry.id && entry.thread_name) {
        names.set(entry.id, entry.thread_name);
      }
    } catch {
      // Ignore malformed legacy index lines.
    }
  }
  return names;
}

function sqliteJson(dbPath, sql) {
  if (!exists(dbPath)) {
    return [];
  }
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return output.trim() ? JSON.parse(output) : [];
  } catch (cliError) {
    try {
      if (!NodeSqliteDatabaseSync) {
        ({ DatabaseSync: NodeSqliteDatabaseSync } = require("node:sqlite"));
      }
      const database = new NodeSqliteDatabaseSync(dbPath, { readOnly: true });
      try {
        return database.prepare(sql).all();
      } finally {
        database.close();
      }
    } catch (nodeError) {
      nodeError.message = `Could not read SQLite database ${dbPath}: ${nodeError.message}; sqlite3 CLI failed with: ${cliError.message}`;
      throw nodeError;
    }
  }
}

function pathLooksLocal(pathValue) {
  const value = normalizeCwd(pathValue);
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function fileUriToPath(value) {
  if (typeof value !== "string" || !value.startsWith("file:")) {
    return "";
  }
  try {
    const parsed = new URL(value);
    let pathname = decodeURIComponent(parsed.pathname || "");
    if (/^\/[a-z]:/i.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, "\\");
  } catch {
    return "";
  }
}

function codexExportIdForProject(projectPath) {
  const encoded = Buffer.from(normalizeCwd(projectPath), "utf8").toString("base64url");
  return `${codexExportPrefix}${encoded}`;
}

function isCodexExportId(id) {
  return typeof id === "string" && id.startsWith(codexExportPrefix);
}

function projectPathFromCodexExportId(id) {
  if (!isCodexExportId(id)) {
    return "";
  }
  try {
    return Buffer.from(id.slice(codexExportPrefix.length), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function exportWorkspacePath(metadata) {
  const rawFolder = metadata?.workspace?.raw?.folder;
  const candidates = [
    metadata?.workspace?.targetPath,
    metadata?.workspace?.path,
    metadata?.workspace?.target,
    fileUriToPath(rawFolder),
    typeof rawFolder === "string" && pathLooksLocal(rawFolder) ? rawFolder : "",
  ].filter(Boolean);
  return candidates.find(pathLooksLocal) || candidates[0] || "";
}

function matchExportWorkspaceToCodexProject(metadata, codexProjects) {
  const workspacePath = exportWorkspacePath(metadata);
  const local = pathLooksLocal(workspacePath);
  const base = workspacePath ? path.basename(normalizeCwd(workspacePath)) : "";
  const empty = {
    status: workspacePath ? (local ? "none" : "nonlocal") : "unknown",
    augmentPath: workspacePath || null,
    sourcePath: workspacePath || null,
    matchedPath: null,
    matchedLabel: null,
    matchType: null,
    candidateCount: 0,
    candidates: [],
  };
  if (!workspacePath || !local) {
    return empty;
  }

  const exact = codexProjects.filter((project) => comparablePath(project.path) === comparablePath(workspacePath));
  if (exact.length === 1) {
    return {
      ...empty,
      status: "matched",
      matchedPath: exact[0].path,
      matchedLabel: exact[0].label,
      matchType: "exact",
      candidateCount: 1,
      candidates: exact.map((project) => ({ path: project.path, label: project.label, threadCount: project.threadCount })),
    };
  }

  const basenameMatches = codexProjects.filter((project) => path.basename(normalizeCwd(project.path)).toLowerCase() === base.toLowerCase());
  return {
    ...empty,
    status: basenameMatches.length ? "candidates" : "none",
    matchType: basenameMatches.length === 1 ? "basename" : null,
    candidateCount: basenameMatches.length,
    candidates: basenameMatches.slice(0, 8).map((project) => ({ path: project.path, label: project.label, threadCount: project.threadCount })),
  };
}

function listCodexProjects(codexHome = defaultCodexHome) {
  const projects = new Map();
  const statePath = path.join(codexHome, ".codex-global-state.json");
  const globalState = readJsonSafe(statePath) || {};

  const addProject = (rawPath, patch = {}) => {
    if (!rawPath || typeof rawPath !== "string") {
      return;
    }
    const projectPath = normalizeCwd(rawPath);
    const key = comparablePath(projectPath);
    if (!key) {
      return;
    }
    const existing = projects.get(key) || {
      path: projectPath,
      key,
      label: path.basename(projectPath) || projectPath,
      threadCount: 0,
      updatedAtMs: null,
      updatedAtIso: null,
      exists: pathLooksLocal(projectPath) ? exists(projectPath) : false,
      canMove: pathLooksLocal(projectPath),
      sources: [],
      active: false,
      pinned: false,
      saved: false,
      orderIndex: null,
    };
    if (patch.label) {
      existing.label = patch.label;
    }
    if (Number.isFinite(patch.threadCount)) {
      existing.threadCount += patch.threadCount;
    }
    if (Number.isFinite(patch.updatedAtMs) && (!existing.updatedAtMs || patch.updatedAtMs > existing.updatedAtMs)) {
      existing.updatedAtMs = patch.updatedAtMs;
      existing.updatedAtIso = timestampMsToIso(patch.updatedAtMs);
    }
    for (const source of patch.sources || []) {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }
    }
    if (patch.active) existing.active = true;
    if (patch.pinned) existing.pinned = true;
    if (patch.saved) existing.saved = true;
    if (Number.isFinite(patch.orderIndex) && (existing.orderIndex === null || patch.orderIndex < existing.orderIndex)) {
      existing.orderIndex = patch.orderIndex;
    }
    projects.set(key, existing);
  };

  const rows = sqliteJson(
    path.join(codexHome, "state_5.sqlite"),
    "SELECT cwd, COUNT(*) AS thread_count, MAX(updated_at_ms) AS updated_at_ms FROM threads WHERE COALESCE(thread_source, 'user') = 'user' GROUP BY cwd ORDER BY updated_at_ms DESC;"
  );
  for (const row of rows) {
    addProject(row.cwd, {
      threadCount: Number(row.thread_count) || 0,
      updatedAtMs: Number(row.updated_at_ms) || null,
      sources: ["threads"],
    });
  }

  const labels = globalState["electron-workspace-root-labels"];
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const [projectPath, label] of Object.entries(labels)) {
      addProject(projectPath, { label: String(label || path.basename(projectPath) || projectPath), sources: ["workspace-labels"] });
    }
  }

  const saved = Array.isArray(globalState["electron-saved-workspace-roots"]) ? globalState["electron-saved-workspace-roots"] : [];
  saved.forEach((projectPath) => addProject(projectPath, { saved: true, sources: ["saved-workspaces"] }));

  const active = Array.isArray(globalState["active-workspace-roots"]) ? globalState["active-workspace-roots"] : [];
  active.forEach((projectPath) => addProject(projectPath, { active: true, sources: ["active-workspaces"] }));

  const order = Array.isArray(globalState["project-order"]) ? globalState["project-order"] : [];
  order.forEach((projectPath, index) => addProject(projectPath, { orderIndex: index, sources: ["project-order"] }));

  const pinned = Array.isArray(globalState["pinned-project-ids"]) ? globalState["pinned-project-ids"] : [];
  pinned.forEach((projectPath) => addProject(projectPath, { pinned: true, sources: ["pinned-projects"] }));

  return [...projects.values()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if ((a.updatedAtMs || 0) !== (b.updatedAtMs || 0)) return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
    if ((a.orderIndex ?? 999999) !== (b.orderIndex ?? 999999)) return (a.orderIndex ?? 999999) - (b.orderIndex ?? 999999);
    return a.label.localeCompare(b.label);
  });
}

function resolveCodexProjectFromExportId(id, codexHome = defaultCodexHome) {
  const projectPath = projectPathFromCodexExportId(id);
  if (!projectPath) {
    return null;
  }
  const key = comparablePath(projectPath);
  return (
    listCodexProjects(codexHome).find((project) => project.key === key) || {
      path: normalizeCwd(projectPath),
      key,
      label: path.basename(normalizeCwd(projectPath)) || normalizeCwd(projectPath),
      threadCount: 0,
      updatedAtMs: null,
      updatedAtIso: null,
      exists: pathLooksLocal(projectPath) ? exists(projectPath) : false,
      canMove: pathLooksLocal(projectPath),
      sources: ["decoded-export-id"],
      active: false,
      pinned: false,
      saved: false,
      orderIndex: null,
    }
  );
}

function listCodexExportDirs(codexProjects = listCodexProjects()) {
  return codexProjects.map((project) => ({
    id: codexExportIdForProject(project.path),
    label: `${project.label || path.basename(project.path) || project.path} (Codex)`,
    sourceType: "codex",
    sourceName: "Codex",
    workspacePath: project.path,
    codexProjectMatch: {
      status: "matched",
      augmentPath: project.path,
      sourcePath: project.path,
      matchedPath: project.path,
      matchedLabel: project.label,
      matchType: "exact",
      candidateCount: 1,
      candidates: [{ path: project.path, label: project.label, threadCount: project.threadCount }],
    },
    stateDir: null,
    chatDir: null,
    hasLevelDbExport: true,
    hasWebviewExport: false,
    conversationCount: project.threadCount || 0,
    importedCount: 0,
    unimportedCount: 0,
    newestConversation: null,
    updatedAt: project.updatedAtIso,
    viewOnly: true,
    metadata: {
      sourceType: "codex",
      sourceName: "Codex",
      workspace: {
        name: project.label,
        path: project.path,
        targetPath: project.path,
      },
      codexProject: project,
    },
  }));
}

function codexThreadRows(codexHome = defaultCodexHome) {
  return sqliteJson(
    path.join(codexHome, "state_5.sqlite"),
    [
      "SELECT",
      "id, title, cwd, archived, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,",
      "source, model_provider, model, thread_source, first_user_message, preview, tokens_used,",
      "git_branch, git_sha, git_origin_url, agent_nickname, agent_role, reasoning_effort",
      "FROM threads",
      "WHERE COALESCE(thread_source, 'user') = 'user'",
      "ORDER BY COALESCE(updated_at_ms, updated_at * 1000, 0) DESC;",
    ].join(" ")
  );
}

function codexThreadRowsForProject(projectPath, codexHome = defaultCodexHome) {
  const key = comparablePath(projectPath);
  return codexThreadRows(codexHome).filter((row) => comparablePath(row.cwd) === key);
}

function compactCodexTitle(value, fallback = "Untitled Codex thread") {
  const title = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return fallback;
  }
  return title.length > 180 ? `${title.slice(0, 177)}...` : title;
}

function codexThreadTimestamp(row, kind) {
  const ms = row?.[`${kind}_at_ms`];
  const seconds = row?.[`${kind}_at`];
  return timestampMsToIso(ms || seconds);
}

function codexRolloutStats(rolloutPath) {
  const filePath = normalizeCwd(rolloutPath);
  const stats = statSafe(filePath);
  if (!stats) {
    return {
      exists: false,
      lineCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      editDiffCount: 0,
      thinkingCount: 0,
      parseErrorCount: 0,
      oversizedLineCount: 0,
      fileSizeBytes: 0,
      statsSkippedLargeFile: false,
    };
  }

  const cacheKey = `${filePath}:${stats.mtimeMs}:${stats.size}`;
  if (caches.codexRolloutStats.has(cacheKey)) {
    return caches.codexRolloutStats.get(cacheKey);
  }

  const result = {
    exists: true,
    lineCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    editDiffCount: 0,
    thinkingCount: 0,
    parseErrorCount: 0,
    oversizedLineCount: 0,
    fileSizeBytes: stats.size,
    statsSkippedLargeFile: false,
  };

  if (stats.size > maxRolloutStatsBytes) {
    result.statsSkippedLargeFile = true;
    caches.codexRolloutStats.set(cacheKey, result);
    return result;
  }

  for (const line of readJsonlLinesSync(filePath)) {
    if (line.truncated) {
      result.lineCount += 1;
      result.parseErrorCount += 1;
      result.oversizedLineCount += 1;
      continue;
    }
    const rawLine = line.text;
    if (!rawLine.trim()) {
      continue;
    }
    result.lineCount += 1;
    let entry = null;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      result.parseErrorCount += 1;
      continue;
    }
    const payload = entry.payload || {};
    if (entry.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") result.userMessageCount += 1;
      if (payload.role === "assistant") result.assistantMessageCount += 1;
    }
    if (entry.type === "response_item" && payload.type === "reasoning") {
      result.thinkingCount += 1;
    }
    if (
      entry.type === "response_item" &&
      ["function_call", "custom_tool_call", "tool_search_call", "web_search_call"].includes(payload.type)
    ) {
      result.toolUseCount += 1;
    }
    if (entry.type === "event_msg" && payload.type === "patch_apply_end") {
      const changes = payload.changes && typeof payload.changes === "object" ? payload.changes : {};
      result.editDiffCount += Object.keys(changes).length;
    }
  }

  caches.codexRolloutStats.set(cacheKey, result);
  return result;
}

function codexIndexRecordFromThread(row, project, sessionNames) {
  const rolloutPath = normalizeCwd(row.rollout_path);
  const rolloutStats = codexRolloutStats(rolloutPath);
  const title = compactCodexTitle(
    firstString(sessionNames.get(row.id), row.title, row.preview, row.first_user_message, row.id),
    row.id
  );

  return {
    id: row.id,
    name: title,
    title,
    createdAtIso: codexThreadTimestamp(row, "created"),
    lastInteractedAtIso: codexThreadTimestamp(row, "updated"),
    chatHistoryCount: rolloutStats.userMessageCount || null,
    exchangeCount: rolloutStats.userMessageCount || null,
    levelExchangeCount: rolloutStats.userMessageCount || null,
    toolUseCount: rolloutStats.toolUseCount || 0,
    editDiffCount: rolloutStats.editDiffCount || 0,
    thinkingCount: rolloutStats.thinkingCount || 0,
    workspacePath: project.path,
    sourceType: "codex",
    sourceName: "Codex",
    rolloutPath,
    mode: row.thread_source || row.source || null,
    status: row.archived ? "archived" : "active",
    isPinned: Boolean(project.pinned),
    isShareable: null,
    isAgentConversation: true,
    isForked: false,
    archived: Boolean(row.archived),
    viewOnly: true,
    importStatus: { imported: false, viewOnly: true },
    rawThread: row,
  };
}

function getCodexIndex(id) {
  const project = resolveCodexProjectFromExportId(id);
  if (!project) {
    return null;
  }
  const names = readSessionIndexNames();
  return codexThreadRowsForProject(project.path).map((row) => codexIndexRecordFromThread(row, project, names));
}

function addImportStatus(statuses, entry) {
  if (!entry?.exportId || !entry?.conversationId) {
    return;
  }
  const key = importKey(entry.exportId, entry.conversationId);
  statuses.set(key, {
    imported: true,
    key,
    source: entry.source || "unknown",
    exportId: entry.exportId,
    conversationId: entry.conversationId,
    threadId: entry.threadId || null,
    title: entry.title || null,
    cwd: entry.cwd ? normalizeCwd(entry.cwd) : null,
    rolloutPath: entry.rolloutPath || null,
    resultDir: entry.resultDir || null,
    importedAt: entry.importedAt || null,
    validation: entry.validation || null,
    importMode: entry.importMode || null,
    cards: entry.cards,
    tools: entry.tools,
  });
}

function readRegisteredImportStatuses(statuses) {
  const registry = readJsonSafe(path.join(importResultsDir, "import-registry.json"));
  if (registry?.imports && typeof registry.imports === "object") {
    for (const entry of Object.values(registry.imports)) {
      addImportStatus(statuses, { ...entry, source: entry.source || "registry" });
    }
  }

  if (!exists(importResultsDir)) {
    return;
  }
  for (const manifestPath of walkFiles(importResultsDir, (filePath) => path.basename(filePath) === "manifest.json")) {
    const manifest = readJsonSafe(manifestPath);
    if (!manifest?.source?.exportId || !manifest?.source?.conversationId) {
      continue;
    }
    if (manifest.applied !== true) {
      continue;
    }
    addImportStatus(statuses, {
      source: "manifest",
      exportId: manifest.source.exportId,
      conversationId: manifest.source.conversationId,
      threadId: manifest.threadId,
      title: manifest.title,
      cwd: manifest.cwd,
      resultDir: path.dirname(manifestPath),
      importedAt: manifest.updatedIso || manifest.createdIso || null,
      importMode: manifest.importMode || null,
      cards: manifest.cards,
      tools: manifest.tools,
    });
  }
}

function isChatHistoryImportOriginator(originator) {
  return originator === "Augment Import" || originator === "Chat History Import" || originator === "Roo Code Import" || originator === "Kiro IDE Import";
}

function scanCodexRolloutImports(statuses, codexHome = defaultCodexHome) {
  const sessionsDir = path.join(codexHome, "sessions");
  const names = readSessionIndexNames(codexHome);
  for (const rolloutPath of walkFiles(sessionsDir, (filePath) => path.basename(filePath).startsWith("rollout-") && filePath.endsWith(".jsonl"))) {
    let firstLine = "";
    let firstEntry = null;
    try {
      firstLine = readFirstLine(rolloutPath);
      firstEntry = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (firstEntry.type !== "session_meta" || !isChatHistoryImportOriginator(firstEntry.payload?.originator)) {
      continue;
    }

    let threadId = null;
    let cwd = null;
    let createdAt = null;
    let isHistoryImport = false;
    let importText = "";

    try {
      for (const line of readJsonlLinesSync(rolloutPath)) {
        if (line.truncated || !line.text.trim()) continue;
        let entry = null;
        try {
          entry = JSON.parse(line.text);
        } catch {
          continue;
        }
        const payload = entry.payload || {};
        if (entry.type === "session_meta") {
          threadId = payload.id || threadId;
          cwd = payload.cwd || cwd;
          createdAt = payload.timestamp || entry.timestamp || createdAt;
          isHistoryImport = isChatHistoryImportOriginator(payload.originator);
        }
        if (!isHistoryImport) continue;
        if (entry.type === "response_item" && payload.type === "message") {
          const content = Array.isArray(payload.content) ? payload.content : [];
          for (const item of content) {
            if (typeof item.text === "string" && (item.text.includes("Augment export:") || item.text.includes("Source export:"))) {
              importText = item.text;
              break;
            }
          }
        }
        if (
          !importText &&
          entry.type === "event_msg" &&
          payload.type === "agent_message" &&
          typeof payload.message === "string" &&
          (payload.message.includes("Augment export:") || payload.message.includes("Source export:"))
        ) {
          importText = payload.message;
        }
        if (importText) break;
      }
    } catch {
      continue;
    }

    if (!isHistoryImport || !importText) {
      continue;
    }

    const exportId =
      importText.match(/^Source export:\s*(.+)$/m)?.[1]?.trim() ||
      importText.match(/^Augment export:\s*(.+)$/m)?.[1]?.trim();
    const conversationId =
      importText.match(/^Source conversation:\s*(.+)$/m)?.[1]?.trim() ||
      importText.match(/^Augment conversation:\s*(.+)$/m)?.[1]?.trim();
    if (!exportId || !conversationId) {
      continue;
    }

    try {
      const meta = firstEntry;
      threadId = meta.payload?.id || null;
      cwd = meta.payload?.cwd || null;
      createdAt = meta.payload?.timestamp || meta.timestamp || null;
    } catch {
      // Keep the source match even if metadata parsing fails.
    }

    addImportStatus(statuses, {
      source: "codex-sessions",
      exportId,
      conversationId,
      threadId,
      cwd,
      rolloutPath,
      importedAt: createdAt,
      title: threadId ? names.get(threadId) : null,
    });
  }
}

function getImportStatusIndex() {
  if (caches.importStatus) {
    return caches.importStatus;
  }
  const statuses = new Map();
  readRegisteredImportStatuses(statuses);
  scanCodexRolloutImports(statuses);
  caches.importStatus = statuses;
  return statuses;
}

function importStatusFor(exportId, conversationId) {
  return getImportStatusIndex().get(importKey(exportId, conversationId)) || { imported: false };
}

function withImportStatus(exportId, conversations) {
  return conversations.map((conversation) => ({
    ...conversation,
    importStatus: importStatusFor(exportId, conversation.id),
  }));
}

function listExportDirs() {
  if (caches.exports) {
    return caches.exports;
  }
  const candidates = new Map();
  const importStatuses = getImportStatusIndex();
  const codexProjects = listCodexProjects();

  const addCandidate = (id, patch) => {
    if (!id) return;
    const existing = candidates.get(id) || { id, stateDir: null, chatDir: null, sourceType: "augment", sourceName: "Augment Code" };
    candidates.set(id, { ...existing, ...patch });
  };

  for (const dir of [stateExportsDir, chatExportsDir]) {
    if (!exists(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        addCandidate(entry.name, {
          stateDir: dir === stateExportsDir ? path.join(dir, entry.name) : candidates.get(entry.name)?.stateDir || null,
          chatDir: dir === chatExportsDir ? path.join(dir, entry.name) : candidates.get(entry.name)?.chatDir || null,
          sourceType: "augment",
          sourceName: "Augment Code",
        });
      }
    }
  }

  for (const [dir, sourceType, sourceName] of [
    [rooExportsDir, "roo-code", "Roo Code"],
    [clineExportsDir, "cline", "Cline"],
    [kiroExportsDir, "kiro", "Kiro IDE"],
  ]) {
    if (!exists(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const exportDir = path.join(dir, entry.name);
      if (entry.isDirectory() && exists(path.join(exportDir, "summary.json"))) {
        addCandidate(entry.name, { chatDir: exportDir, sourceType, sourceName });
      }
    }
  }

  const externalExports = [...candidates.values()]
    .map((candidate) => {
      const id = candidate.id;
      const stateDir = candidate.stateDir || path.join(stateExportsDir, id);
      const chatDir = candidate.chatDir || path.join(chatExportsDir, id);
      const indexPath = path.join(stateDir, "conversation-index.json");
      const summaryPath = path.join(chatDir, "summary.json");
      const metadata =
        readJsonSafe(path.join(stateDir, "workspace-export-metadata.json")) ||
        readJsonSafe(path.join(chatDir, "workspace-export-metadata.json")) ||
        {};
      if (!exists(indexPath) && !exists(summaryPath)) {
        return null;
      }

      const statsSourcePath = exists(indexPath) ? indexPath : summaryPath;
      const indexStats = statSafe(statsSourcePath);
      let conversationCount = null;
      let newestConversation = null;
      let conversationIds = [];
      if (exists(indexPath)) {
        const index = readJsonSafe(indexPath);
        conversationCount = Array.isArray(index) ? index.length : null;
        newestConversation = Array.isArray(index) ? index[0] : null;
        conversationIds = Array.isArray(index) ? index.map((conversation) => conversation.id).filter(Boolean) : [];
      } else {
        const summary = readJsonSafe(summaryPath);
        conversationCount = Array.isArray(summary?.conversations) ? summary.conversations.length : null;
        newestConversation = Array.isArray(summary?.conversations) ? summary.conversations[0] : null;
        conversationIds = Array.isArray(summary?.conversations)
          ? summary.conversations.map((conversation) => conversation.conversationId || conversation.id).filter(Boolean)
          : [];
      }
      const importedCount = conversationIds.filter((conversationId) => importStatuses.get(importKey(id, conversationId))?.imported).length;
      const codexProjectMatch = matchExportWorkspaceToCodexProject(metadata, codexProjects);
      const sourceType = metadata.sourceType || candidate.sourceType || "augment";
      const sourceName = metadata.sourceName || candidate.sourceName || "Augment Code";

      return {
        id,
        label: metadata?.workspace?.name ? `${metadata.workspace.name} (${sourceName})` : `${id} (${sourceName})`,
        sourceType,
        sourceName,
        workspacePath: codexProjectMatch.augmentPath,
        codexProjectMatch,
        stateDir: exists(stateDir) ? stateDir : null,
        chatDir: exists(chatDir) ? chatDir : null,
        hasLevelDbExport: exists(summaryPath),
        hasWebviewExport: exists(indexPath),
        conversationCount,
        importedCount,
        unimportedCount: Math.max(0, (conversationCount || 0) - importedCount),
        newestConversation,
        updatedAt: indexStats ? indexStats.mtime.toISOString() : null,
        metadata,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const exports = [...externalExports, ...listCodexExportDirs(codexProjects)].sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  );

  caches.exports = exports;
  return exports;
}

function getExport(id) {
  return listExportDirs().find((entry) => entry.id === id);
}

function getIndex(id) {
  if (caches.indexes.has(id)) {
    return caches.indexes.get(id);
  }

  if (isCodexExportId(id)) {
    const index = getCodexIndex(id);
    if (index) {
      caches.indexes.set(id, index);
    }
    return index;
  }

  const entry = getExport(id);
  if (!entry) {
    return null;
  }

  const indexPath = entry.stateDir ? path.join(entry.stateDir, "conversation-index.json") : null;
  if (indexPath && exists(indexPath)) {
    const index = withImportStatus(id, readJson(indexPath));
    caches.indexes.set(id, index);
    return index;
  }

  const summaryPath = entry.chatDir ? path.join(entry.chatDir, "summary.json") : null;
  const summary = summaryPath && exists(summaryPath) ? readJson(summaryPath) : null;
  const index = Array.isArray(summary?.conversations)
    ? summary.conversations.map((conversation) => ({
        id: conversation.conversationId || conversation.id,
        name: conversation.title || conversation.name,
        createdAtIso: conversation.firstTimestamp || null,
        lastInteractedAtIso: conversation.lastTimestamp || null,
        chatHistoryCount: conversation.exchangeCount,
        toolUseCount: conversation.toolUseCount || 0,
        editDiffCount: conversation.editDiffCount || 0,
        workspacePath: conversation.workspacePath || summary?.workspace?.targetPath || summary?.workspace?.path || null,
        sourceType: summary?.sourceType || entry.sourceType || null,
        sourceName: summary?.sourceName || entry.sourceName || null,
        mode: conversation.mode || null,
        status: conversation.status || null,
        isPinned: null,
        isShareable: null,
        isAgentConversation: null,
        isForked: Boolean(conversation.isForked),
      }))
    : [];
  const withStatus = withImportStatus(id, index);
  caches.indexes.set(id, withStatus);
  return withStatus;
}

function buildConversationFileMap(dirPath) {
  const map = new Map();
  if (!dirPath || !exists(dirPath)) {
    return map;
  }

  for (const file of fs.readdirSync(dirPath)) {
    if (!file.endsWith(".json")) {
      continue;
    }

    const match = file.match(/ -- (.+)\.json$/);
    if (match) {
      map.set(match[1], path.join(dirPath, file));
    }
  }
  return map;
}

function getFileMaps(id) {
  if (caches.fileMaps.has(id)) {
    return caches.fileMaps.get(id);
  }

  const entry = getExport(id);
  if (!entry) {
    return null;
  }

  const maps = {
    webview: buildConversationFileMap(entry.stateDir ? path.join(entry.stateDir, "conversations") : null),
    level: buildConversationFileMap(entry.chatDir ? path.join(entry.chatDir, "conversations") : null),
  };
  caches.fileMaps.set(id, maps);
  return maps;
}

function timestampFromExchange(exchange) {
  const value = exchange && exchange.value ? exchange.value : {};
  return (
    value.timestamp ||
    value.created_at ||
    value.createdAt ||
    value.updated_at ||
    value.updatedAt ||
    ""
  );
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") {
    return value || null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length) || "";
}

function idsFromToolUseKey(key) {
  const value = String(key || "");
  const levelMatch = value.match(/^tooluse:([^:]+):([^;]+);(.+)$/);
  if (levelMatch) {
    return { conversationId: levelMatch[1], requestId: levelMatch[2], toolUseId: levelMatch[3] };
  }

  const webviewMatch = value.match(/^([^;]+);(.+)$/);
  return webviewMatch ? { requestId: webviewMatch[1], toolUseId: webviewMatch[2] } : {};
}

function findToolUseDiffs(value, seen = new Set(), output = []) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return output;
  }

  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "tool_use_diff" && child && typeof child === "object") {
      output.push(child);
      continue;
    }

    if (child && typeof child === "object") {
      findToolUseDiffs(child, seen, output);
    }
  }
  return output;
}

function normalizeDiff(diff) {
  const edits = Array.isArray(diff.edits)
    ? diff.edits.map((edit) => ({
        lineStart: edit.line_start ?? edit.lineStart ?? edit.startLine ?? null,
        beforeText: firstString(edit.before_text, edit.beforeText, edit.oldText),
        afterText: firstString(edit.after_text, edit.afterText, edit.newText),
      }))
    : [];

  return {
    rootPath: firstString(diff.root_path, diff.rootPath),
    path: firstString(diff.path, diff.file, diff.relPath),
    edits,
  };
}

function splitDiffLines(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  if (!text.length) {
    return [];
  }

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function fallbackDiffEdit(beforeLines, afterLines, prefix, suffix) {
  const removedLines = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedLines = afterLines.slice(prefix, afterLines.length - suffix);

  return removedLines.length || addedLines.length
    ? [
        {
          lineStart: prefix + 1,
          beforeText: removedLines.join("\n"),
          afterText: addedLines.join("\n"),
          removedLineCount: removedLines.length,
          addedLineCount: addedLines.length,
        },
      ]
    : [];
}

function diffEditsFromLines(beforeLines, afterLines) {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);
  if (!beforeMiddle.length || !afterMiddle.length) {
    return fallbackDiffEdit(beforeLines, afterLines, prefix, suffix);
  }

  const cellCount = (beforeMiddle.length + 1) * (afterMiddle.length + 1);
  if (cellCount > 500000) {
    return fallbackDiffEdit(beforeLines, afterLines, prefix, suffix);
  }

  const width = afterMiddle.length + 1;
  const dp = Array.from({ length: beforeMiddle.length + 1 }, () => new Uint32Array(width));
  for (let i = beforeMiddle.length - 1; i >= 0; i -= 1) {
    for (let j = afterMiddle.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        beforeMiddle[i] === afterMiddle[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const edits = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let originalLine = prefix + 1;
  let hunkStart = null;
  let removedLines = [];
  let addedLines = [];

  const flush = () => {
    if (!removedLines.length && !addedLines.length) {
      return;
    }

    edits.push({
      lineStart: hunkStart || originalLine,
      beforeText: removedLines.join("\n"),
      afterText: addedLines.join("\n"),
      removedLineCount: removedLines.length,
      addedLineCount: addedLines.length,
    });
    hunkStart = null;
    removedLines = [];
    addedLines = [];
  };

  while (beforeIndex < beforeMiddle.length || afterIndex < afterMiddle.length) {
    if (
      beforeIndex < beforeMiddle.length &&
      afterIndex < afterMiddle.length &&
      beforeMiddle[beforeIndex] === afterMiddle[afterIndex]
    ) {
      flush();
      beforeIndex += 1;
      afterIndex += 1;
      originalLine += 1;
      continue;
    }

    if (
      afterIndex < afterMiddle.length &&
      (beforeIndex === beforeMiddle.length ||
        dp[beforeIndex][afterIndex + 1] >= dp[beforeIndex + 1][afterIndex])
    ) {
      hunkStart ??= originalLine;
      addedLines.push(afterMiddle[afterIndex]);
      afterIndex += 1;
      continue;
    }

    hunkStart ??= originalLine;
    removedLines.push(beforeMiddle[beforeIndex]);
    beforeIndex += 1;
    originalLine += 1;
  }

  flush();
  return edits;
}

function makeCheckpointDiff(document) {
  const originalCode = typeof document?.originalCode === "string" ? document.originalCode : "";
  const modifiedCode = typeof document?.modifiedCode === "string" ? document.modifiedCode : "";
  const beforeLines = splitDiffLines(originalCode);
  const afterLines = splitDiffLines(modifiedCode);
  const edits = diffEditsFromLines(beforeLines, afterLines);
  const totalRemovedLines = edits.reduce((sum, edit) => sum + (Number(edit.removedLineCount) || 0), 0);
  const totalAddedLines = edits.reduce((sum, edit) => sum + (Number(edit.addedLineCount) || 0), 0);
  const pathInfo = document?.path || {};

  return {
    rootPath: firstString(pathInfo.rootPath, pathInfo.root_path),
    path: firstString(pathInfo.relPath, pathInfo.rel_path, pathInfo.path),
    source: "checkpoint-document",
    changeKind:
      !beforeLines.length && afterLines.length
        ? "created"
          : beforeLines.length && !afterLines.length
            ? "deleted"
            : "edited",
    totalAddedLines,
    totalRemovedLines,
    edits,
  };
}

function checkpointSourceId(fileName) {
  const match = fileName.match(/-\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i);
  return match ? match[1] : "";
}

function addMapArray(map, key, value) {
  if (!key) {
    return;
  }

  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function buildEditIndex(chatDir, conversationId) {
  const cacheKey = `${chatDir || ""}:${conversationId || ""}`;
  if (caches.editIndexes.has(cacheKey)) {
    return caches.editIndexes.get(cacheKey);
  }

  const byRequestId = new Map();
  const checkpointDir = chatDir
    ? path.join(chatDir, "user-assets", "checkpoint-documents", conversationId)
    : null;

  if (checkpointDir && exists(checkpointDir)) {
    for (const entry of fs.readdirSync(checkpointDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const requestId = checkpointSourceId(entry.name);
      const document = readJsonSafe(path.join(checkpointDir, entry.name));
      if (!requestId || !document) {
        continue;
      }

      const diff = makeCheckpointDiff(document);
      if (diff.path || diff.edits.length) {
        addMapArray(byRequestId, requestId, diff);
      }
    }
  }

  const index = {
    byRequestId,
    diffCount: [...byRequestId.values()].reduce((sum, diffs) => sum + diffs.length, 0),
  };
  caches.editIndexes.set(cacheKey, index);
  return index;
}

function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (key !== "tool_use_diff") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function mergeEditMetrics(metrics, diffs) {
  const merged = { ...(metrics || {}) };
  const added = diffs.reduce((sum, diff) => sum + (Number(diff.totalAddedLines) || 0), 0);
  const removed = diffs.reduce((sum, diff) => sum + (Number(diff.totalRemovedLines) || 0), 0);

  if (added && !Number.isFinite(merged.tool_lines_added)) {
    merged.tool_lines_added = added;
  }
  if (removed && !Number.isFinite(merged.tool_lines_deleted)) {
    merged.tool_lines_deleted = removed;
  }
  return merged;
}

function normalizeToolUseRecord(record) {
  const value = record.value || {};
  const result = value.result || {};
  const ids = idsFromToolUseKey(record.key);
  const requestId = firstString(value.requestId, value.request_id, ids.requestId);
  const toolUseId = firstString(value.toolUseId, value.tool_use_id, ids.toolUseId);
  const metrics = normalizeMetrics(result.metrics);
  const diffs = findToolUseDiffs(value).map(normalizeDiff);

  return {
    key: record.key,
    requestId,
    toolUseId,
    phase: value.phase,
    isError: Boolean(result.isError),
    text: firstString(result.text, result.output, value.text),
    metrics,
    diffs,
  };
}

function buildToolUseIndexes(toolUses) {
  const records = Array.isArray(toolUses) ? toolUses.map(normalizeToolUseRecord) : [];
  const byComposite = new Map();
  const byToolUseId = new Map();

  for (const record of records) {
    if (record.requestId && record.toolUseId) {
      byComposite.set(`${record.requestId};${record.toolUseId}`, record);
    }
    if (record.toolUseId && !byToolUseId.has(record.toolUseId)) {
      byToolUseId.set(record.toolUseId, record);
    }
  }

  return { records, byComposite, byToolUseId };
}

function toolUseStatesToRecords(toolUseStates) {
  if (!toolUseStates || typeof toolUseStates !== "object") {
    return [];
  }

  return Object.entries(toolUseStates).map(([key, value]) => ({
    key,
    parsed: true,
    value,
  }));
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== "object") {
    return "";
  }

  const parts = [];
  if (input.type) parts.push(String(input.type));
  if (input.path) parts.push(String(input.path));
  if (input.file) parts.push(String(input.file));
  if (input.target_file) parts.push(String(input.target_file));
  if (input.command) parts.push(String(input.command));
  if (input.cmd) parts.push(String(input.cmd));
  if (input.query) parts.push(String(input.query));
  if (input.title) parts.push(String(input.title));
  if (input.url) parts.push(String(input.url));
  if (input.code) parts.push(String(input.code).split(/\r?\n/).find((line) => line.trim()) || "code");
  if (input.information_request) parts.push(String(input.information_request));
  if (Array.isArray(input.view_range)) {
    parts.push(`lines ${input.view_range.join("-")}`);
  }

  if (parts.length) {
    return parts.join(" · ");
  }

  const fallback = JSON.stringify(input);
  return fallback.length > 180 ? `${fallback.slice(0, 177)}...` : fallback;
}

function collectToolNodes(value) {
  const nodes = [
    ...(Array.isArray(value.request_nodes) ? value.request_nodes : []),
    ...(Array.isArray(value.response_nodes) ? value.response_nodes : []),
    ...(Array.isArray(value.structured_request_nodes) ? value.structured_request_nodes : []),
    ...(Array.isArray(value.structured_output_nodes) ? value.structured_output_nodes : []),
    ...(Array.isArray(value.nodes) ? value.nodes : []),
  ];

  return nodes.filter((node) => node && typeof node === "object" && node.tool_use);
}

function normalizeToolNode(node, value, toolIndexes, editIndex) {
  const tool = node.tool_use || {};
  const requestId = firstString(value.request_id, value.requestId, node.request_id);
  const toolUseId = firstString(tool.tool_use_id, tool.toolUseId, tool.id);
  const inputJson = typeof tool.input_json === "string" ? tool.input_json : "";
  const input = parseJsonMaybe(inputJson) || {};
  const record =
    toolIndexes.byComposite.get(`${requestId};${toolUseId}`) ||
    toolIndexes.byToolUseId.get(toolUseId) ||
    null;
  const checkpointDiffs = editIndex?.byRequestId.get(requestId) || [];
  const diffs = [...(record ? record.diffs : []), ...checkpointDiffs];
  const metrics = mergeEditMetrics(record ? record.metrics : {}, checkpointDiffs);

  return {
    requestId,
    toolUseId,
    toolName: firstString(tool.tool_name, tool.toolName, "tool"),
    input,
    inputJson,
    inputSummary: summarizeToolInput(tool.tool_name, input),
    isPartial: Boolean(tool.is_partial),
    hasResult: Boolean(record || checkpointDiffs.length),
    phase: record ? record.phase : null,
    isError: record ? record.isError : false,
    text: record ? record.text : "",
    metrics,
    diffs,
  };
}

function normalizeThinkingNode(node) {
  const thinking = node.thinking || {};
  const summary = firstString(thinking.summary);
  const hasEncryptedContent = Boolean(thinking.encrypted_content);
  if (!summary && !hasEncryptedContent) {
    return null;
  }

  return {
    type: "thinking",
    nodeId: node.id,
    summary,
    hasEncryptedContent,
    provider: firstString(node.metadata && node.metadata.provider),
  };
}

function normalizeAssistantTextNode(node) {
  const text = firstString(node.content, node.text_node && node.text_node.content);
  if (!text.trim()) {
    return null;
  }

  return {
    type: "assistant_text",
    nodeId: node.id,
    text,
  };
}

function normalizeResponseEvents(value, toolIndexes, editIndex) {
  const nodes = Array.isArray(value.response_nodes)
    ? value.response_nodes
    : Array.isArray(value.structured_output_nodes)
      ? value.structured_output_nodes
      : [];
  const thinkingEvents = [];
  const textEvents = [];
  const toolEvents = [];

  for (const node of nodes) {
    const thinking = node.thinking ? normalizeThinkingNode(node) : null;
    if (thinking) {
      thinkingEvents.push(thinking);
    }

    const text = normalizeAssistantTextNode(node);
    if (text) {
      textEvents.push(text);
    }

    if (node.tool_use) {
      toolEvents.push({
        type: "tool",
        nodeId: node.id,
        tool: normalizeToolNode(node, value, toolIndexes, editIndex),
      });
    }
  }

  // Augment's UI presents reasoning summaries and assistant text before the tool cards
  // for a response turn, even when the serialized nodes place text after tool calls.
  return [...thinkingEvents, ...textEvents, ...toolEvents];
}

function normalizeLevelExchange(exchange, toolIndexes, editIndex) {
  const value = exchange.value || {};
  const tools = collectToolNodes(value).map((node) => normalizeToolNode(node, value, toolIndexes, editIndex));
  const events = normalizeResponseEvents(value, toolIndexes, editIndex);
  return {
    exchangeId: exchange.exchangeId || value.uuid || value.request_id,
    requestId: value.request_id,
    timestamp: timestampFromExchange(exchange),
    status: value.status,
    seenState: value.seen_state,
    model: value.model_id || value.modelId || value.model,
    request: value.request_message || value.requestMessage || value.user_message || value.userMessage || "",
    response: value.response_text || value.responseText || value.assistant_message || value.assistantMessage || "",
    nodeCount: Array.isArray(value.nodes) ? value.nodes.length : 0,
    requestNodeCount: Array.isArray(value.request_nodes) ? value.request_nodes.length : 0,
    responseNodeCount: Array.isArray(value.response_nodes) ? value.response_nodes.length : 0,
    tools,
    events,
    raw: value,
  };
}

function normalizeWebviewExchange(item, index, toolIndexes, editIndex) {
  const value = item || {};
  const tools = collectToolNodes(value).map((node) => normalizeToolNode(node, value, toolIndexes, editIndex));
  const events = normalizeResponseEvents(value, toolIndexes, editIndex);
  const exchangeId = firstString(value.exchangeUuid, value.uuid, value.request_id, `webview-${index + 1}`);
  return {
    exchangeId,
    requestId: value.request_id,
    timestamp: value.timestamp || value.createdAtIso || value.created_at || "",
    status: value.status,
    seenState: value.seen_state,
    model: value.model_id || value.modelId || value.model,
    request: value.request_message || value.requestMessage || value.user_message || value.userMessage || "",
    response: value.response_text || value.responseText || value.assistant_message || value.assistantMessage || "",
    nodeCount: Array.isArray(value.nodes) ? value.nodes.length : 0,
    requestNodeCount: Array.isArray(value.structured_request_nodes)
      ? value.structured_request_nodes.length
      : Array.isArray(value.request_nodes)
        ? value.request_nodes.length
        : 0,
    responseNodeCount: Array.isArray(value.structured_output_nodes)
      ? value.structured_output_nodes.length
      : Array.isArray(value.response_nodes)
        ? value.response_nodes.length
        : 0,
    tools,
    events,
    raw: value,
    source: "webview",
  };
}

function isWebviewExchangeItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }

  return Boolean(
    item.request_message ||
    item.response_text ||
    item.request_id ||
    (Array.isArray(item.structured_output_nodes) && item.structured_output_nodes.length) ||
    (Array.isArray(item.response_nodes) && item.response_nodes.length)
  );
}

function normalizeGenericExchange(exchange, index) {
  const events = Array.isArray(exchange.events) ? exchange.events : [];
  const tools = Array.isArray(exchange.tools)
    ? exchange.tools
    : events.filter((event) => event.type === "tool" && event.tool).map((event) => event.tool);
  return {
    exchangeId: firstString(exchange.exchangeId, exchange.id, `exchange-${index + 1}`),
    requestId: exchange.requestId || null,
    timestamp: firstString(exchange.timestamp, exchange.createdAtIso, exchange.created_at),
    status: exchange.status || "",
    seenState: exchange.seenState || null,
    model: exchange.model || "",
    request: firstString(exchange.request, exchange.userMessage, exchange.prompt),
    response: firstString(exchange.response, exchange.assistantMessage, exchange.answer),
    nodeCount: Number(exchange.nodeCount) || events.length,
    requestNodeCount: Number(exchange.requestNodeCount) || 0,
    responseNodeCount: Number(exchange.responseNodeCount) || events.length,
    tools,
    events,
    raw: exchange.raw || exchange,
    source: "normalized",
  };
}

function countVisibleTools(exchanges) {
  let visibleToolCallCount = 0;
  let thinkingCount = 0;
  for (const exchange of exchanges) {
    thinkingCount += (exchange.events || []).filter((event) => event.type === "thinking").length;
    visibleToolCallCount += (exchange.events || []).filter((event) => event.type === "tool" && event.tool).length;
    if (!(exchange.events || []).some((event) => event.type === "tool")) {
      visibleToolCallCount += (exchange.tools || []).length;
    }
  }
  return { visibleToolCallCount, thinkingCount };
}

function getGenericConversation(id, conversationId, entry, indexRecord, levelPath, level) {
  const exchanges = Array.isArray(level.exchanges)
    ? level.exchanges.map((exchange, index) => normalizeGenericExchange(exchange, index))
    : [];
  const counts = countVisibleTools(exchanges);
  const toolUseCount =
    Number(level.toolUseCount) ||
    exchanges.reduce((sum, exchange) => sum + (exchange.tools || []).length, 0);
  const editDiffCount =
    Number(level.editDiffCount) ||
    exchanges.reduce(
      (sum, exchange) => sum + (exchange.tools || []).reduce((toolSum, tool) => toolSum + ((tool.diffs || []).length), 0),
      0
    );

  return {
    exportId: id,
    conversationId,
    sourceType: level.sourceType || entry.sourceType || "normalized",
    sourceName: level.sourceName || entry.sourceName || "Imported Chat",
    workspacePath: level.workspacePath || indexRecord?.workspacePath || entry.workspacePath || null,
    importStatus: importStatusFor(id, conversationId),
    indexRecord,
    webview: null,
    levelMetadata: level.metadata || null,
    exchanges,
    exchangeSource: level.sourceType || entry.sourceType || "normalized",
    exchangeSourceLabel: level.sourceName || entry.sourceName || "Imported Chat",
    levelExchangeCount: exchanges.length,
    webviewExchangeCount: 0,
    toolUseCount,
    levelToolUseCount: toolUseCount,
    webviewToolUseCount: 0,
    editDiffCount,
    visibleToolCallCount: counts.visibleToolCallCount,
    thinkingCount: counts.thinkingCount,
    linkedToolUseCount: toolUseCount,
    unlinkedToolUseCount: 0,
    sourceFiles: {
      webview: null,
      level: levelPath || null,
    },
  };
}

function codexContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      if (typeof item.text === "string") {
        return item.text;
      }
      if (/image/i.test(String(item.type || ""))) {
        return "[image attachment]";
      }
      if (typeof item.url === "string" && item.url && !item.url.startsWith("data:")) {
        return item.url;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function isCodexInternalUserText(text) {
  const value = String(text || "").trim();
  if (!value) {
    return true;
  }
  if (value.startsWith("# AGENTS.md instructions for ") || value.startsWith("<environment_context>")) {
    return true;
  }
  return /^# AGENTS\.md instructions for [\s\S]+<\/environment_context>$/.test(value);
}

function codexReasoningSummary(payload) {
  const summary = Array.isArray(payload.summary)
    ? payload.summary.map((item) => (typeof item === "string" ? item : firstString(item?.text, item?.summary))).filter(Boolean).join("\n\n")
    : firstString(payload.summary);
  const content = Array.isArray(payload.content)
    ? payload.content.map((item) => (typeof item === "string" ? item : firstString(item?.text))).filter(Boolean).join("\n\n")
    : "";
  return firstString(summary, content);
}

function codexToolName(payload) {
  if (payload.type === "tool_search_call" || payload.type === "tool_search_output") {
    return "tool_search";
  }
  if (payload.type === "web_search_call") {
    return "web_search";
  }
  const namespace = typeof payload.namespace === "string" ? payload.namespace.replace(/^mcp__/, "").replace(/__$/, "") : "";
  return namespace ? `${namespace}.${payload.name || "tool"}` : firstString(payload.name, payload.tool, payload.type, "tool");
}

function codexToolInput(payload) {
  if (payload.type === "custom_tool_call") {
    return payload.input || "";
  }
  if (payload.type === "tool_search_call") {
    return payload.arguments || {};
  }
  if (payload.type === "web_search_call") {
    return payload.action || {};
  }
  return parseJsonMaybe(payload.arguments) || payload.arguments || {};
}

function summarizeCodexToolInput(toolName, input) {
  if (typeof input === "string") {
    const firstLine = input.split(/\r?\n/).find((line) => line.trim()) || "";
    return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
  }
  return summarizeToolInput(toolName, input);
}

function codexToolOutputText(payload) {
  if (typeof payload.output === "string") {
    const parsed = parseJsonMaybe(payload.output);
    if (parsed && typeof parsed === "object" && typeof parsed.output === "string") {
      return parsed.output;
    }
    return payload.output;
  }
  if (payload.tools) {
    return JSON.stringify(payload.tools, null, 2);
  }
  if (payload.result) {
    return JSON.stringify(payload.result, null, 2);
  }
  return "";
}

function codexMcpResultText(payload) {
  const ok = payload?.result?.Ok;
  const err = payload?.result?.Err;
  const content = ok?.content || err?.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => firstString(item?.text)).filter(Boolean).join("\n\n");
    if (text) {
      return text;
    }
  }
  return JSON.stringify(payload.result || payload, null, 2);
}

function makeCodexTool(payload, exchange, timestamp, fallbackId) {
  const input = codexToolInput(payload);
  const inputJson = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const toolName = codexToolName(payload);
  return {
    requestId: exchange.exchangeId,
    toolUseId: firstString(payload.call_id, payload.id, fallbackId),
    toolName,
    input,
    inputJson,
    inputSummary: summarizeCodexToolInput(toolName, input),
    isPartial: false,
    hasResult: false,
    phase: payload.status || null,
    isError: false,
    text: "",
    metrics: {},
    diffs: [],
    timestamp,
    raw: payload,
  };
}

function relativeCodexPath(filePath, rootPath) {
  const normalized = normalizeCwd(filePath);
  const root = normalizeCwd(rootPath);
  if (!root) {
    return normalized;
  }
  try {
    const relative = path.relative(root, normalized);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  } catch {
    // Fall through to the absolute path.
  }
  return normalized;
}

function lineCountForText(text) {
  return splitDiffLines(text).length;
}

function codexContentDiff(filePath, rootPath, changeKind, beforeText, afterText) {
  const removedLineCount = lineCountForText(beforeText);
  const addedLineCount = lineCountForText(afterText);
  return {
    rootPath: rootPath || "",
    path: relativeCodexPath(filePath, rootPath),
    source: "codex-patch",
    changeKind,
    totalAddedLines: addedLineCount,
    totalRemovedLines: removedLineCount,
    edits: [
      {
        lineStart: 1,
        beforeText: beforeText || "",
        afterText: afterText || "",
        removedLineCount,
        addedLineCount,
      },
    ],
  };
}

function codexUnifiedDiff(filePath, rootPath, unifiedDiff) {
  const edits = [];
  let current = null;

  const flush = () => {
    if (!current || (!current.before.length && !current.after.length)) {
      current = null;
      return;
    }
    edits.push({
      lineStart: current.lineStart,
      beforeText: current.before.join("\n"),
      afterText: current.after.join("\n"),
      removedLineCount: current.before.length,
      addedLineCount: current.after.length,
    });
    current = null;
  };

  for (const line of String(unifiedDiff || "").split(/\r?\n/)) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush();
      current = { lineStart: Number(hunk[1]) || Number(hunk[2]) || 1, before: [], after: [] };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.before.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.after.push(line.slice(1));
    }
  }
  flush();

  return {
    rootPath: rootPath || "",
    path: relativeCodexPath(filePath, rootPath),
    source: "codex-patch",
    changeKind: "edited",
    totalAddedLines: edits.reduce((sum, edit) => sum + edit.addedLineCount, 0),
    totalRemovedLines: edits.reduce((sum, edit) => sum + edit.removedLineCount, 0),
    edits,
    unifiedDiff,
  };
}

function codexDiffsFromPatchChanges(changes, rootPath) {
  if (!changes || typeof changes !== "object") {
    return [];
  }
  return Object.entries(changes).map(([filePath, change]) => {
    const type = change?.type || change?.kind?.type || "update";
    if (type === "add") {
      return codexContentDiff(filePath, rootPath, "created", "", firstString(change.content, change.diff));
    }
    if (type === "delete" || type === "remove") {
      return codexContentDiff(filePath, rootPath, "deleted", firstString(change.content, change.diff), "");
    }
    if (change?.unified_diff) {
      return codexUnifiedDiff(filePath, rootPath, change.unified_diff);
    }
    return codexContentDiff(filePath, rootPath, "edited", "", firstString(change.content, change.diff));
  });
}

function parseCodexRollout(rolloutPath, row, entry) {
  const filePath = normalizeCwd(rolloutPath);
  const exchanges = [];
  const callMap = new Map();
  const metadata = {
    sessionMeta: null,
    lineCount: 0,
    parseErrors: 0,
    oversizedLines: 0,
    rolloutPath: filePath,
  };
  let current = null;
  let turnIndex = 0;

  const ensureExchange = (timestamp) => {
    if (!current) {
      turnIndex += 1;
      current = {
        exchangeId: `codex-turn-${turnIndex}`,
        requestId: null,
        timestamp: timestamp || "",
        status: row?.archived ? "archived" : "active",
        seenState: null,
        model: firstString(row?.model, row?.model_provider),
        request: "",
        response: "",
        nodeCount: 0,
        requestNodeCount: 0,
        responseNodeCount: 0,
        tools: [],
        events: [],
        raw: { threadId: row?.id },
        source: "codex",
      };
      exchanges.push(current);
    }
    return current;
  };

  const startExchange = (request, timestamp, payload) => {
    turnIndex += 1;
    current = {
      exchangeId: `codex-turn-${turnIndex}`,
      requestId: null,
      timestamp: timestamp || "",
      status: row?.archived ? "archived" : "active",
      seenState: null,
      model: firstString(row?.model, row?.model_provider),
      request,
      response: "",
      nodeCount: 0,
      requestNodeCount: 1,
      responseNodeCount: 0,
      tools: [],
      events: [],
      raw: payload,
      source: "codex",
    };
    exchanges.push(current);
    return current;
  };

  const addTool = (payload, timestamp, fallbackId) => {
    const exchange = ensureExchange(timestamp);
    const tool = makeCodexTool(payload, exchange, timestamp, fallbackId);
    exchange.tools.push(tool);
    exchange.events.push({ type: "tool", nodeId: tool.toolUseId, tool });
    exchange.nodeCount += 1;
    exchange.responseNodeCount += 1;
    if (tool.toolUseId) {
      callMap.set(tool.toolUseId, tool);
    }
    return tool;
  };

  const applyToolOutput = (callId, payload, textValue, isError = false) => {
    if (!callId) {
      return;
    }
    const tool = callMap.get(callId);
    if (!tool) {
      return;
    }
    const output = textValue || codexToolOutputText(payload);
    if (output && !tool.text) {
      tool.text = output;
    }
    tool.hasResult = true;
    tool.isError = Boolean(isError || payload.is_error || payload.isError);
    tool.phase = tool.phase || payload.status || "completed";
  };

  let lineNumber = 0;
  const lines = exists(filePath) ? readJsonlLinesSync(filePath) : [];
  for (const line of lines) {
    if (line.truncated) {
      metadata.lineCount += 1;
      metadata.parseErrors += 1;
      metadata.oversizedLines += 1;
      continue;
    }
    const rawLine = line.text;
    if (!rawLine.trim()) {
      continue;
    }
    lineNumber += 1;
    metadata.lineCount += 1;
    let record = null;
    try {
      record = JSON.parse(rawLine);
    } catch {
      metadata.parseErrors += 1;
      continue;
    }

    const timestamp = record.timestamp || "";
    const payload = record.payload || {};
    if (record.type === "session_meta") {
      metadata.sessionMeta = payload;
      continue;
    }

    if (record.type === "response_item" && payload.type === "message") {
      const textValue = codexContentText(payload.content);
      if (!textValue.trim()) {
        continue;
      }
      if (payload.role === "user") {
        if (!isCodexInternalUserText(textValue)) {
          startExchange(textValue, timestamp, payload);
        }
        continue;
      }
      if (payload.role === "assistant") {
        const exchange = ensureExchange(timestamp);
        exchange.response = exchange.response ? `${exchange.response}\n\n${textValue}` : textValue;
        exchange.events.push({
          type: "assistant_text",
          nodeId: payload.id || `assistant-${lineNumber}`,
          text: textValue,
          phase: payload.phase || null,
        });
        exchange.nodeCount += 1;
        exchange.responseNodeCount += 1;
      }
      continue;
    }

    if (record.type === "response_item" && payload.type === "reasoning") {
      const summary = codexReasoningSummary(payload);
      const hasEncryptedContent = Boolean(payload.encrypted_content);
      if (summary || hasEncryptedContent) {
        const exchange = ensureExchange(timestamp);
        exchange.events.push({
          type: "thinking",
          nodeId: payload.id || `reasoning-${lineNumber}`,
          summary,
          hasEncryptedContent,
        });
        exchange.nodeCount += 1;
        exchange.responseNodeCount += 1;
      }
      continue;
    }

    if (
      record.type === "response_item" &&
      ["function_call", "custom_tool_call", "tool_search_call", "web_search_call"].includes(payload.type)
    ) {
      addTool(payload, timestamp, `${payload.type}-${lineNumber}`);
      continue;
    }

    if (
      record.type === "response_item" &&
      ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)
    ) {
      applyToolOutput(payload.call_id, payload);
      continue;
    }

    if (record.type === "event_msg" && payload.type === "patch_apply_end") {
      const tool = callMap.get(payload.call_id);
      if (tool) {
        const output = [payload.stdout, payload.stderr].filter(Boolean).join("\n");
        if (output && !tool.text) {
          tool.text = output;
        }
        tool.hasResult = true;
        tool.isError = payload.success === false;
        tool.diffs = [...(tool.diffs || []), ...codexDiffsFromPatchChanges(payload.changes, entry.workspacePath)];
        tool.metrics = mergeEditMetrics(tool.metrics || {}, tool.diffs || []);
      }
      continue;
    }

    if (record.type === "event_msg" && payload.type === "mcp_tool_call_end") {
      const isError = Boolean(payload?.result?.Ok?.isError || payload?.result?.Err);
      applyToolOutput(payload.call_id, payload, codexMcpResultText(payload), isError);
    }
  }

  return { exchanges, metadata };
}

function getCodexConversation(id, conversationId) {
  const entry = getExport(id);
  const index = getIndex(id);
  if (!entry || !index) {
    return null;
  }
  const indexRecord = index.find((conversation) => conversation.id === conversationId) || null;
  const threadRow = indexRecord?.rawThread || codexThreadRowsForProject(entry.workspacePath).find((row) => row.id === conversationId);
  if (!threadRow) {
    return null;
  }

  const rolloutPath = normalizeCwd(threadRow.rollout_path);
  const parsed = parseCodexRollout(rolloutPath, threadRow, entry);
  const counts = countVisibleTools(parsed.exchanges);
  const toolUseCount = parsed.exchanges.reduce((sum, exchange) => sum + (exchange.tools || []).length, 0);
  const editDiffCount = parsed.exchanges.reduce(
    (sum, exchange) => sum + (exchange.tools || []).reduce((toolSum, tool) => toolSum + ((tool.diffs || []).length), 0),
    0
  );

  return {
    exportId: id,
    conversationId,
    sourceType: "codex",
    sourceName: "Codex",
    workspacePath: entry.workspacePath || normalizeCwd(threadRow.cwd),
    importStatus: { imported: false, viewOnly: true },
    indexRecord,
    webview: null,
    levelMetadata: {
      thread: threadRow,
      ...parsed.metadata,
    },
    exchanges: parsed.exchanges,
    exchangeSource: "codex",
    exchangeSourceLabel: "Codex rollout",
    levelExchangeCount: parsed.exchanges.length,
    webviewExchangeCount: 0,
    toolUseCount,
    levelToolUseCount: toolUseCount,
    webviewToolUseCount: 0,
    editDiffCount,
    visibleToolCallCount: counts.visibleToolCallCount,
    thinkingCount: counts.thinkingCount,
    linkedToolUseCount: parsed.exchanges.reduce(
      (sum, exchange) => sum + (exchange.tools || []).filter((tool) => tool.hasResult).length,
      0
    ),
    unlinkedToolUseCount: parsed.exchanges.reduce(
      (sum, exchange) => sum + (exchange.tools || []).filter((tool) => !tool.hasResult).length,
      0
    ),
    viewOnly: true,
    sourceFiles: {
      webview: null,
      level: rolloutPath || null,
    },
  };
}

function getConversation(id, conversationId) {
  if (isCodexExportId(id)) {
    return getCodexConversation(id, conversationId);
  }

  const entry = getExport(id);
  const index = getIndex(id);
  const maps = getFileMaps(id);
  if (!entry || !index || !maps) {
    return null;
  }

  const indexRecord = index.find((conversation) => conversation.id === conversationId) || null;
  const webviewPath = maps.webview.get(conversationId);
  const levelPath = maps.level.get(conversationId);
  const webview = webviewPath ? readJson(webviewPath) : null;
  const level = levelPath ? readJson(levelPath) : null;
  if (level?.normalizedConversationVersion) {
    return getGenericConversation(id, conversationId, entry, indexRecord, levelPath, level);
  }
  const levelToolUseRecords = level && Array.isArray(level.toolUses) ? level.toolUses : [];
  const webviewToolUseRecords = toolUseStatesToRecords(webview?.toolUseStates);
  const toolIndexes = buildToolUseIndexes([...levelToolUseRecords, ...webviewToolUseRecords]);
  const editIndex = buildEditIndex(entry.chatDir, conversationId);
  const levelExchanges = level && Array.isArray(level.exchanges)
    ? level.exchanges.map((exchange) => normalizeLevelExchange(exchange, toolIndexes, editIndex)).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    : [];
  const webviewExchanges = webview && Array.isArray(webview.chatHistory)
    ? webview.chatHistory
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => isWebviewExchangeItem(item))
        .map(({ item, index }) => normalizeWebviewExchange(item, index, toolIndexes, editIndex))
    : [];
  const exchanges = levelExchanges.length ? levelExchanges : webviewExchanges;
  const exchangeSource = levelExchanges.length ? "leveldb" : "webview";
  const linkedToolUseIds = new Set();
  let visibleToolCallCount = 0;
  let thinkingCount = 0;
  for (const exchange of exchanges) {
    thinkingCount += (exchange.events || []).filter((event) => event.type === "thinking").length;
    for (const tool of exchange.tools || []) {
      visibleToolCallCount += 1;
      if (tool.hasResult && tool.toolUseId) {
        linkedToolUseIds.add(tool.toolUseId);
      }
    }
  }

  return {
    exportId: id,
    conversationId,
    importStatus: importStatusFor(id, conversationId),
    indexRecord,
    webview,
    levelMetadata: level ? level.metadata : null,
    exchanges,
    exchangeSource,
    levelExchangeCount: levelExchanges.length,
    webviewExchangeCount: webviewExchanges.length,
    toolUseCount: toolIndexes.records.length,
    levelToolUseCount: levelToolUseRecords.length,
    webviewToolUseCount: webviewToolUseRecords.length,
    editDiffCount: editIndex.diffCount,
    visibleToolCallCount,
    thinkingCount,
    linkedToolUseCount: linkedToolUseIds.size,
    unlinkedToolUseCount: Math.max(0, toolIndexes.records.length - linkedToolUseIds.size),
    sourceFiles: {
      webview: webviewPath || null,
      level: levelPath || null,
    },
  };
}

function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function titleForImportItem(exportId, conversationId) {
  const index = getIndex(exportId) || [];
  const conversation = index.find((entry) => entry.id === conversationId);
  return conversation ? titleForIndexRecord(conversation) : "";
}

function titleForIndexRecord(conversation) {
  return firstString(conversation?.name, conversation?.title, conversation?.summary, conversation?.id);
}

function isEmptyConversationRecord(conversation) {
  if (!conversation || typeof conversation !== "object") {
    return false;
  }
  if (Number(conversation.chatHistoryCount) === 0) {
    return true;
  }
  if (Number(conversation.exchangeCount) === 0 || Number(conversation.levelExchangeCount) === 0) {
    return true;
  }
  return false;
}

function isViewOnlyExportEntry(entry) {
  return Boolean(entry?.viewOnly || entry?.sourceType === "codex");
}

function importableRawItemsForAllExports(body = {}) {
  const statuses = getImportStatusIndex();
  const items = [];
  const skipped = [];
  for (const entry of listExportDirs()) {
    if (isViewOnlyExportEntry(entry)) {
      skipped.push({ exportId: entry.id, conversationId: "", reason: "view-only-export" });
      continue;
    }
    const index = getIndex(entry.id) || [];
    for (const conversation of index) {
      const conversationId = String(conversation.id || "").trim();
      if (!conversationId) {
        continue;
      }
      const key = importKey(entry.id, conversationId);
      const existing = statuses.get(key);
      if (body.skipImported !== false && existing?.imported) {
        skipped.push({ exportId: entry.id, conversationId, reason: "already-imported", threadId: existing.threadId || null });
        continue;
      }
      if (isEmptyConversationRecord(conversation)) {
        skipped.push({ exportId: entry.id, conversationId, reason: "empty-conversation" });
        continue;
      }
      items.push({
        exportId: entry.id,
        conversationId,
        title: titleForIndexRecord(conversation),
        targetCwd: codexTargetCwdForExport(entry.id),
      });
    }
  }
  return { items, skipped };
}

function importTitleForItem(exportId, title) {
  const rawTitle = firstString(title, titleForImportItem(exportId, ""));
  if (/^\[[^\]]+\]\s+/.test(rawTitle)) {
    return rawTitle;
  }
  const entry = getExport(exportId);
  const label =
    entry?.sourceType === "augment"
      ? "Augment"
      : entry?.sourceName
        ? entry.sourceName.replace(/\s+(Code|IDE)$/i, "")
        : entry?.sourceType || "Imported";
  return `[${label}] ${rawTitle || "Imported chat"}`;
}

function codexTargetCwdForExport(exportId) {
  const entry = getExport(exportId);
  const match = entry?.codexProjectMatch;
  return match?.matchType === "exact" && match.matchedPath
    ? match.matchedPath
    : firstString(entry?.workspacePath, entry?.metadata?.workspace?.targetPath, entry?.metadata?.workspace?.path);
}

function copyCodexHomeForPreflight(codexHome) {
  const stamp = timestampStamp();
  const tempHome = path.join(importResultsDir, "preflight-codex-home", stamp);
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

function importerArgsForItem(item, modeArgs = []) {
  const args = [
    "--api-base",
    importerApiBase,
    "--export-id",
    item.exportId,
    "--conversation-id",
    item.conversationId,
    "--title",
    item.title,
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

function preflightImportItems(items, codexHome) {
  const tempCodexHome = copyCodexHomeForPreflight(codexHome);
  const validatedItems = [];
  const validations = [];

  for (const item of items) {
    const dryRun = runImporterJson(importerArgsForItem(item, ["--dry-run"]));
    const validatedItem = {
      ...item,
      threadId: dryRun.threadId,
      title: dryRun.title,
      targetCwd: dryRun.cwd,
    };
    const validation = runImporterJson(
      importerArgsForItem(validatedItem, ["--codex-home", tempCodexHome, "--apply", "--validate", "--allow-running", "--no-registry"])
    );
    validatedItems.push(validatedItem);
    validations.push({
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
  }

  return {
    tempCodexHome,
    items: validatedItems,
    validations,
  };
}

function startDetached(command, args, logPath) {
  if (process.platform === "win32") {
    return startDetachedWindowsHidden(command, args, logPath);
  }
  const out = fs.openSync(logPath, "a");
  try {
    const child = spawn(command, args, {
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startDetachedWindowsHidden(command, args, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stdoutPath = `${logPath}.process.out.log`;
  const stderrPath = `${logPath}.process.err.log`;
  const psCommand = [
    "$ErrorActionPreference = 'Stop'",
    "function Quote-ProcessArgument {",
    "  param([string]$Value)",
    "  if ($Value -notmatch '[\\s\"]') { return $Value }",
    "  return '\"' + ($Value -replace '\"', '\\\"') + '\"'",
    "}",
    `$filePath = ${psSingleQuoted(command)}`,
    `$workingDirectory = ${psSingleQuoted(rootDir)}`,
    `$stdoutPath = ${psSingleQuoted(stdoutPath)}`,
    `$stderrPath = ${psSingleQuoted(stderrPath)}`,
    `$arguments = @(${args.map(psSingleQuoted).join(", ")})`,
    "$argumentString = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '",
    "$process = Start-Process -FilePath $filePath -ArgumentList $argumentString -WorkingDirectory $workingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru",
    "$process.Id",
  ].join("\n");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", psCommand],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  ).trim();
  const pid = Number(output.split(/\s+/).pop());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not start hidden background process: ${command} ${args.join(" ")}. Output: ${output}`);
  }
  return pid;
}

function scheduleImportJob(body) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const codexHome = body.codexHome || defaultCodexHome;
  const statuses = getImportStatusIndex();
  const seen = new Set();
  const skipped = [];
  const items = [];

  for (const raw of rawItems) {
    const exportId = String(raw.exportId || "").trim();
    const conversationId = String(raw.conversationId || "").trim();
    if (!exportId || !conversationId) {
      continue;
    }
    const key = importKey(exportId, conversationId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const entry = getExport(exportId);
    if (isViewOnlyExportEntry(entry)) {
      skipped.push({ exportId, conversationId, reason: "view-only-export" });
      continue;
    }
    const existing = statuses.get(key);
    if (body.skipImported !== false && existing?.imported) {
      skipped.push({ exportId, conversationId, reason: "already-imported", threadId: existing.threadId || null });
      continue;
    }
    if (body.skipImported === false && existing?.imported && !raw.threadId && !existing.threadId) {
      skipped.push({ exportId, conversationId, reason: "imported-thread-id-missing" });
      continue;
    }
    const index = getIndex(exportId) || [];
    const conversation = index.find((entry) => entry.id === conversationId);
    if (isEmptyConversationRecord(conversation)) {
      skipped.push({ exportId, conversationId, reason: "empty-conversation" });
      continue;
    }
    items.push({
      exportId,
      conversationId,
      title: importTitleForItem(exportId, firstString(raw.title, titleForImportItem(exportId, conversationId))),
      threadId: raw.threadId || (body.skipImported === false && existing?.threadId ? existing.threadId : ""),
      targetCwd: firstString(raw.targetCwd, raw.cwd, codexTargetCwdForExport(exportId)),
    });
  }

  if (!items.length) {
    return { scheduled: false, skipped, message: "No new conversations to import." };
  }

  fs.mkdirSync(importJobsDir, { recursive: true });
  const stamp = timestampStamp();
  const jobPath = path.join(importJobsDir, `codex-import-${stamp}.json`);
  const logPath = path.join(importJobsDir, `codex-import-${stamp}.log`);
  const importLogPath = path.join(importJobsDir, `codex-import-${stamp}.import.log`);
  const preflightPath = path.join(importJobsDir, `codex-import-${stamp}.preflight.json`);
  const job = {
    createdAt: new Date().toISOString(),
    codexHome,
    preflightPath,
    importLogPath,
    stopCodex: body.stopCodex !== false,
    noRestartApp: Boolean(body.noRestartApp),
    materializeCwd: body.materializeCwd !== false,
    fastPreflight: body.fastPreflight !== false,
    validateImports: body.validateImports === true,
    importMode: "full",
    items,
  };
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    preflightPath,
    `${JSON.stringify(
      {
        createdAt: job.createdAt,
        status: "queued",
        tempCodexHome: null,
        validations: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const args = [
    path.join(rootDir, "scripts", "preflight-and-schedule-codex-import.cjs"),
    "--job-path",
    jobPath,
    "--log-path",
    logPath,
  ];
  const pid = startDetached(process.execPath, args, logPath);
  caches.importStatus = null;
  caches.exports = null;
  caches.indexes.clear();

  return {
    scheduled: true,
    preflightPending: true,
    pid,
    jobName: path.basename(jobPath),
    jobPath,
    logPath,
    importLogPath,
    preflightPath,
    count: items.length,
    skipped,
    items,
    validations: [],
  };
}

function scheduleAllImportableJob(body = {}) {
  const collected = importableRawItemsForAllExports(body);
  if (body.previewOnly) {
    return {
      scheduled: false,
      previewOnly: true,
      count: collected.items.length,
      skipped: collected.skipped,
      message: `${collected.items.length} importable conversation${collected.items.length === 1 ? "" : "s"} found.`,
    };
  }
  const scheduled = scheduleImportJob({
    ...body,
    items: collected.items,
    skipImported: body.skipImported !== false,
    fastPreflight: body.fastPreflight !== false,
    validateImports: body.validateImports === true,
  });
  return {
    ...scheduled,
    allSources: true,
    collectedCount: collected.items.length,
    skipped: [...(scheduled.skipped || []), ...collected.skipped],
  };
}

function tailText(filePath, maxChars = 12000) {
  if (!filePath || !exists(filePath)) {
    return "";
  }
  const stats = fs.statSync(filePath);
  const start = Math.max(0, stats.size - maxChars);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function isProcessRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeImportJobPath(jobName) {
  const basename = path.basename(String(jobName || ""));
  if (!basename.endsWith(".json")) {
    throw new Error("Import job name must be a .json file.");
  }
  const jobPath = path.resolve(importJobsDir, basename);
  if (!jobPath.startsWith(path.resolve(importJobsDir) + path.sep)) {
    throw new Error("Import job path is outside the import jobs directory.");
  }
  return jobPath;
}

function getImportJobStatus(jobName) {
  const jobPath = safeImportJobPath(jobName);
  const job = readJsonSafe(jobPath) || {};
  const base = jobPath.slice(0, -".json".length);
  const logPath = path.join(path.dirname(jobPath), `${path.basename(base)}.log`);
  const preflightPath = job.preflightPath || path.join(path.dirname(jobPath), `${path.basename(base)}.preflight.json`);
  const importLogPath = job.importLogPath || path.join(path.dirname(jobPath), `${path.basename(base)}.import.log`);
  const preflight = readJsonSafe(preflightPath) || null;
  const logTail = tailText(logPath);
  const importLogTail = tailText(importLogPath);
  const importLogExists = exists(importLogPath);
  const importCompleted = /Import completed successfully\./.test(importLogTail);
  const importFailed = /(?:^|\n).+ERROR:/m.test(importLogTail) || /Importer failed/.test(importLogTail);
  const preflightFailed = preflight?.status === "failed";
  const importerPid = Number(preflight?.importerPid || 0);
  const importerExitedWithError = preflight?.importerExitCode != null && Number(preflight.importerExitCode) !== 0;
  const importerDiedBeforeLogging =
    preflight?.status === "passed" &&
    importerPid > 0 &&
    !preflight?.importerExitedAt &&
    !importLogExists &&
    !isProcessRunning(importerPid);
  let phase = "queued";
  if (preflightFailed || importFailed || importerExitedWithError || importerDiedBeforeLogging) {
    phase = "failed";
  } else if (importCompleted) {
    phase = "complete";
  } else if (importerPid > 0) {
    phase = "importer-started";
  } else if (preflight?.status === "passed") {
    phase = "preflight-passed";
  } else if (preflight?.status === "running") {
    phase = "preflight-running";
  }

  const originalTotal = Array.isArray(job.items) ? job.items.length : 0;
  const validatedCount = Array.isArray(preflight?.validations) ? preflight.validations.length : 0;
  const skippedCount = Array.isArray(preflight?.skipped) ? preflight.skipped.length : 0;
  const preflightTotal = Number(preflight?.total || preflight?.itemCount || originalTotal || validatedCount + skippedCount || 0);
  const importMatches = [...String(importLogTail || "").matchAll(/Importing\s+(\d+)\/(\d+):/g)];
  const lastImportMatch = importMatches.length ? importMatches[importMatches.length - 1] : null;
  const importCurrent = lastImportMatch ? Number(lastImportMatch[1]) : 0;
  const importTotal = lastImportMatch ? Number(lastImportMatch[2]) : originalTotal;
  let progressDone = 0;
  let progressTotal = preflightTotal || originalTotal || importTotal || 0;
  let progressStage = "Queued";
  if (phase === "preflight-running") {
    progressDone = validatedCount + skippedCount;
    progressStage = "Preflight";
  } else if (phase === "preflight-passed") {
    progressDone = preflightTotal || validatedCount + skippedCount;
    progressStage = "Preflight complete";
  } else if (phase === "importer-started") {
    progressTotal = importTotal || originalTotal || 0;
    progressDone = importCurrent ? Math.max(0, importCurrent - 1) : 0;
    progressStage = importCurrent ? `Importing ${importCurrent}/${progressTotal}` : "Importing";
  } else if (phase === "complete") {
    progressTotal = importTotal || originalTotal || preflightTotal || 0;
    progressDone = progressTotal;
    progressStage = "Complete";
  } else if (phase === "failed") {
    progressDone = Math.max(importCurrent ? importCurrent - 1 : 0, validatedCount + skippedCount);
    progressStage = "Failed";
  }
  const progressPercent = progressTotal > 0 ? Math.max(0, Math.min(100, Math.round((progressDone / progressTotal) * 100))) : 0;

  return {
    jobName: path.basename(jobPath),
    jobPath,
    logPath,
    preflightPath,
    importLogPath,
    phase,
    job,
    preflight,
    progress: {
      phase,
      stage: progressStage,
      done: progressDone,
      total: progressTotal,
      percent: progressPercent,
      validated: validatedCount,
      skipped: skippedCount,
      importCurrent,
      importTotal,
    },
    logTail,
    importLogTail,
    importLogExists,
    importerDiedBeforeLogging,
  };
}

function runCodexProjectMovePreview(body) {
  const projectPath = String(body.projectPath || "").trim();
  const newPath = String(body.newPath || "").trim();
  if (!projectPath || !newPath) {
    throw new Error("Select a Codex project and enter a destination folder.");
  }
  const args = [
    path.join(rootDir, "scripts", "move-codex-project.cjs"),
    "--project",
    projectPath,
    "--to",
    newPath,
    "--codex-home",
    body.codexHome || defaultCodexHome,
    "--json",
  ];
  if (body.moveFolder === false) {
    args.push("--no-move-folder");
  }
  const output = execFileSync(process.execPath, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return JSON.parse(output);
}

function scheduleCodexProjectMove(body) {
  const preview = runCodexProjectMovePreview(body);
  if (body.moveFolder !== false) {
    if (!preview.oldExists) {
      throw new Error(`Codex project folder does not exist: ${preview.oldPath}`);
    }
    if (preview.newExists) {
      throw new Error(`Destination already exists: ${preview.newPath}`);
    }
  }
  if (!preview.threadCount && !preview.globalStateChanged) {
    throw new Error("Codex does not appear to reference the selected project.");
  }

  fs.mkdirSync(codexMoveJobsDir, { recursive: true });
  const stamp = timestampStamp();
  const jobPath = path.join(codexMoveJobsDir, `codex-project-move-${stamp}.json`);
  const logPath = path.join(codexMoveJobsDir, `codex-project-move-${stamp}.log`);
  const job = {
    createdAt: new Date().toISOString(),
    codexHome: body.codexHome || defaultCodexHome,
    projectPath: preview.oldPath,
    newPath: preview.newPath,
    moveFolder: body.moveFolder !== false,
  };
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  const scriptPath = path.join(rootDir, "scripts", "run-codex-project-move-after-close.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    scriptPath,
    "-JobPath",
    jobPath,
    "-LogPath",
    logPath,
  ];
  if (body.noRestartApp) {
    args.push("-NoRestartApp");
  }
  if (body.moveFolder === false) {
    args.push("-NoMoveFolder");
  }
  const pid = startDetached("powershell.exe", args, logPath);

  return {
    scheduled: true,
    pid,
    jobPath,
    logPath,
    preview,
  };
}

function scheduleExportAllJob(body) {
  fs.mkdirSync(importJobsDir, { recursive: true });
  const stamp = timestampStamp();
  const logPath = path.join(importJobsDir, `chat-source-export-${stamp}.log`);
  const args = [path.join(rootDir, "scripts", "export-all-chat-sources.cjs")];
  if (body.workspaceStorageRoot) {
    args.push(body.workspaceStorageRoot);
  }
  const pid = startDetached(process.execPath, args, logPath);
  caches.exports = null;
  caches.indexes.clear();
  caches.fileMaps.clear();
  caches.editIndexes.clear();
  return {
    scheduled: true,
    pid,
    logPath,
  };
}

function listJobLogs() {
  if (!exists(importJobsDir)) {
    return [];
  }
  return fs
    .readdirSync(importJobsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => {
      const filePath = path.join(importJobsDir, entry.name);
      const stats = fs.statSync(filePath);
      let tail = "";
      try {
        const text = fs.readFileSync(filePath, "utf8");
        tail = text.slice(-5000);
      } catch {
        // Ignore unreadable logs.
      }
      return {
        name: entry.name,
        path: filePath,
        updatedAt: stats.mtime.toISOString(),
        size: stats.size,
        tail,
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function serveStatic(requestPath, response) {
  const decodedPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  const filePath = path.resolve(publicDir, `.${decodedPath}`);

  if (!filePath.startsWith(publicDir)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendError(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end(content);
  });
}

async function handleApi(request, requestUrl, response) {
  const parts = requestUrl.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, {
      ok: true,
      service: "codex-import-manager",
      pid: process.pid,
      sourceSha256: importManagerSourceSha256,
      runtimeRoot: rootDir,
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/exports") {
    sendJson(response, { exports: listExportDirs() });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/exports/refresh") {
    const body = await readRequestJson(request);
    sendJson(response, scheduleExportAllJob(body));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/imports/status") {
    const statuses = [...getImportStatusIndex().values()].sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
    sendJson(response, { statuses });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/imports/schedule") {
    const body = await readRequestJson(request);
    sendJson(response, scheduleImportJob(body));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/imports/schedule-all") {
    const body = await readRequestJson(request);
    sendJson(response, scheduleAllImportableJob(body));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/imports/job-status") {
    sendJson(response, getImportJobStatus(requestUrl.searchParams.get("job")));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/codex/projects") {
    sendJson(response, { projects: listCodexProjects() });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/codex/projects/move/preview") {
    const body = await readRequestJson(request);
    sendJson(response, runCodexProjectMovePreview(body));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/codex/projects/move/schedule") {
    const body = await readRequestJson(request);
    sendJson(response, scheduleCodexProjectMove(body));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/jobs") {
    sendJson(response, { jobs: listJobLogs() });
    return;
  }

  if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "exports" && parts[2]) {
    const index = getIndex(parts[2]);
    if (!index) {
      sendError(response, 404, "Export not found");
      return;
    }
    sendJson(response, { conversations: index });
    return;
  }

  if (request.method === "GET" && parts.length === 5 && parts[0] === "api" && parts[1] === "exports" && parts[3] === "conversations") {
    const conversation = getConversation(parts[2], parts[4]);
    if (!conversation) {
      sendError(response, 404, "Conversation not found");
      return;
    }
    sendJson(response, conversation);
    return;
  }

  sendError(response, 404, "Unknown API route");
}

const server = http.createServer((request, response) => {
  const requestUrl = new url.URL(request.url, "http://localhost");

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(request, requestUrl, response).catch((error) => {
      sendError(response, 500, error.stack || error.message);
    });
    return;
  }

  serveStatic(requestUrl.pathname, response);
});

const requestedPort = Number(process.env.PORT || process.argv[2] || 4577);
server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  console.log(`Chat transfer viewer listening at http://127.0.0.1:${address.port}`);
});
