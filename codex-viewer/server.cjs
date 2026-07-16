#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  catalogFingerprint,
  compareVersion,
  compatibleWith,
  discoverFeatureModules,
  publicFeatureRecord,
} = require("../scripts/feature-registry.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const defaultCodexHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const orchestrationDir = path.join(rootDir, "codex-orchestrations");
const orchestrationRunsDir = path.join(orchestrationDir, "runs");
const patchJobsDir = path.join(rootDir, "codex-patch-jobs");
const patchLogsDir = path.join(patchJobsDir, "logs");
const patchResultsDir = path.join(patchJobsDir, "results");
const featureWorkflowScriptPath = path.join(rootDir, "scripts", "feature-development-workflow.cjs");
const communityFeatureRoot = path.join(rootDir, "features", "community");
const launcherConfigPath = path.resolve(
  process.env.CODEX_PATCH_STUDIO_LAUNCHER_CONFIG || path.join(rootDir, "codex-launcher.local.json")
);
const basePatcherConfigPath = path.join(rootDir, "config", "patcher.json");
const localPatcherConfigPath = path.join(rootDir, "config", "patcher.local.json");
const patchManagerSourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
const maxRequestBodyBytes = 1024 * 1024;
const maxRolloutStatsBytes = 16 * 1024 * 1024;
const maxRolloutDetailBytes = 8 * 1024 * 1024;
const maxFeatureWorkflowOutputBytes = 128 * 1024;
const featureActionResults = new Map();
const featureActionInFlight = new Map();
let activeFeatureActionId = null;
let currentCodexUpdateSnapshot = null;
const featureIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const featureRequestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const statCache = new Map();
const statsCache = new Map();

class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
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

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function sendJson(response, value, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  });
  response.end(body);
}

function mergedPatcherConfig() {
  return {
    ...(readJsonSafe(basePatcherConfigPath) || {}),
    ...(readJsonSafe(localPatcherConfigPath) || {}),
  };
}

function normalizeUpdatePolicy(value, fallback = "notify") {
  const policy = String(value || "").trim().toLowerCase();
  return ["off", "notify", "auto"].includes(policy) ? policy : fallback;
}

function sendError(response, status, message) {
  sendJson(response, { error: message }, status);
}

function sendCaughtError(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, { error: error.message, ...(error.details || {}) }, error.status);
    return;
  }
  if (error instanceof URIError) {
    sendError(response, 400, "Malformed URL path.");
    return;
  }
  console.error(error?.stack || error);
  sendError(response, 500, "Internal server error.");
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;
    let failed = false;
    request.on("data", (chunk) => {
      if (failed) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxRequestBodyBytes) {
        failed = true;
        body = "";
        reject(new HttpError(413, "Request body too large."));
        return;
      }
      body += chunk.toString();
    });
    request.on("end", () => {
      if (failed) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new HttpError(400, `Invalid JSON body: ${error.message}`));
      }
    });
    request.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function loopbackRequestHost(request) {
  const rawHost = String(request.headers.host || "").trim();
  if (!rawHost || /[\\/@\s]/.test(rawHost)) {
    throw new HttpError(403, "POST requests require a valid loopback Host header.");
  }
  let parsed = null;
  try {
    parsed = new url.URL(`http://${rawHost}`);
  } catch {
    throw new HttpError(403, "POST requests require a valid loopback Host header.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new HttpError(403, "POST requests are only accepted for a loopback host.");
  }
  return parsed.host.toLowerCase();
}

function assertSafePostRequest(request) {
  const requestHost = loopbackRequestHost(request);
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "POST requests require Content-Type: application/json.");
  }

  const origin = String(request.headers.origin || "").trim();
  const trustedCodexRenderer = origin.toLowerCase() === "app://-";
  const fetchSite = String(request.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite === "cross-site" && !trustedCodexRenderer) {
    throw new HttpError(403, "Cross-site POST requests are not allowed.");
  }

  if (trustedCodexRenderer) return;
  if (!origin) return;
  let parsedOrigin = null;
  try {
    parsedOrigin = new url.URL(origin);
  } catch {
    throw new HttpError(403, "POST request Origin is invalid.");
  }
  const originHostname = parsedOrigin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackOrigin = ["127.0.0.1", "localhost", "::1"].includes(originHostname);
  if (parsedOrigin.protocol !== "http:" || !loopbackOrigin || parsedOrigin.host.toLowerCase() !== requestHost) {
    throw new HttpError(403, "Cross-origin POST requests are not allowed.");
  }
}

function trustedFeatureDevelopmentOrigin(request) {
  const requestHost = loopbackRequestHost(request);
  const origin = String(request.headers.origin || "").trim();
  const fetchSite = String(request.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (origin.toLowerCase() === "app://-") {
    return "app://-";
  }
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "Feature Development requests do not accept cross-site web origins.");
  }

  const candidate = origin || String(request.headers.referer || "").trim();
  if (!candidate) {
    throw new HttpError(403, "Feature Development requests require an approved Origin or Referer.");
  }
  let parsed = null;
  try {
    parsed = new url.URL(candidate);
  } catch {
    throw new HttpError(403, "Feature Development request origin is invalid.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    parsed.host.toLowerCase() !== requestHost
  ) {
    throw new HttpError(403, "Feature Development requests must originate from this loopback bridge.");
  }
  return parsed.origin;
}

function assertFeatureDevelopmentRequest(request) {
  const allowedOrigin = trustedFeatureDevelopmentOrigin(request);
  if (request.method === "OPTIONS") {
    const requestedMethod = String(request.headers["access-control-request-method"] || "").trim().toUpperCase();
    const requestedHeaders = String(request.headers["access-control-request-headers"] || "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedMethod && !["GET", "POST"].includes(requestedMethod)) {
      throw new HttpError(403, "Feature Development preflight requested an unsupported method.");
    }
    if (requestedHeaders.some((header) => header !== "content-type")) {
      throw new HttpError(403, "Feature Development preflight requested unsupported headers.");
    }
  }
  if (request.method === "POST") {
    const contentType = String(request.headers["content-type"] || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new HttpError(415, "Feature Development commands require Content-Type: application/json.");
    }
  }
  return allowedOrigin;
}

function featureDevelopmentCorsHeaders(allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function readFileSegment(filePath, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const count = fs.readSync(fd, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (!count) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buffer.subarray(0, bytesRead);
}

function readBoundedRollout(filePath, fileStats, maxBytes, scope) {
  const totalBytes = fileStats.size;
  const requestedBytes = Math.min(totalBytes, maxBytes);
  const requestedStart = scope === "tail" && totalBytes > maxBytes ? totalBytes - requestedBytes : 0;
  let buffer = readFileSegment(filePath, requestedStart, requestedBytes);
  let parsedStart = requestedStart;
  let parsedEnd = requestedStart + buffer.length;

  if (requestedStart > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) {
      parsedStart = parsedEnd;
      buffer = Buffer.alloc(0);
    } else {
      parsedStart += firstNewline + 1;
      buffer = buffer.subarray(firstNewline + 1);
    }
  } else if (parsedEnd < totalBytes) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      parsedEnd = 0;
      buffer = Buffer.alloc(0);
    } else {
      parsedEnd = lastNewline + 1;
      buffer = buffer.subarray(0, lastNewline + 1);
    }
  }

  const omittedBeforeBytes = parsedStart;
  const omittedAfterBytes = Math.max(0, totalBytes - parsedEnd);
  const truncated = omittedBeforeBytes > 0 || omittedAfterBytes > 0;
  return {
    text: buffer.toString("utf8"),
    totalBytes,
    scannedBytes: buffer.length,
    truncated,
    partial: truncated,
    scanScope: truncated ? scope : "full",
    omittedBeforeBytes,
    omittedAfterBytes,
    maxBytes,
  };
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function normalizeCwd(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
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

function pathLooksLocal(value) {
  const normalized = normalizeCwd(value);
  return /^[a-z]:[\\/]/i.test(normalized) || /^\\\\/.test(normalized);
}

function timestampMsToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  const date = new Date(number > 100000000000 ? number : number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function compactText(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function titleText(value, fallback, limit = 72) {
  return compactText(value, limit) || fallback;
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !/^[{\[]/.test(trimmed)) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function projectIdForPath(projectPath) {
  return Buffer.from(normalizeCwd(projectPath), "utf8").toString("base64url");
}

function pathFromProjectId(projectId) {
  try {
    return Buffer.from(projectId, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function sqliteRows(sql) {
  const dbPath = path.join(defaultCodexHome, "state_5.sqlite");
  if (!exists(dbPath)) {
    return [];
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function readSessionIndexNames() {
  const indexPath = path.join(defaultCodexHome, "session_index.jsonl");
  const names = new Map();
  if (!exists(indexPath)) {
    return names;
  }
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name) {
        names.set(entry.id, entry.thread_name);
      }
    } catch {
      // Ignore malformed index records.
    }
  }
  return names;
}

function readGlobalState() {
  return readJsonSafe(path.join(defaultCodexHome, ".codex-global-state.json")) || {};
}

function codexThreadRows() {
  return sqliteRows(
    [
      "SELECT",
      "id, title, cwd, archived, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,",
      "source, model_provider, model, thread_source, first_user_message, preview, tokens_used,",
      "git_branch, git_sha, git_origin_url, agent_nickname, agent_role, reasoning_effort",
      "FROM threads",
      "ORDER BY COALESCE(updated_at_ms, updated_at * 1000, 0) DESC;",
    ].join(" ")
  ).map((row) => ({
    ...row,
    cwd: normalizeCwd(row.cwd),
    rollout_path: normalizeCwd(row.rollout_path),
  }));
}

function isApprovalThread(row) {
  return String(row?.title || "").startsWith("The following is the Codex agent history whose request action you are assessing.");
}

function isSubagentThread(row) {
  return row?.thread_source === "subagent" && !isApprovalThread(row);
}

function threadTimestamp(row, kind) {
  return timestampMsToIso(row?.[`${kind}_at_ms`] || row?.[`${kind}_at`]);
}

function threadTitle(row, sessionNames) {
  return compactText(firstString(sessionNames.get(row.id), row.title, row.preview, row.first_user_message, row.id), 220);
}

function rolloutStats(rolloutPath) {
  const filePath = normalizeCwd(rolloutPath);
  const stats = statSafe(filePath);
  if (!stats) {
    return {
      exists: false,
      fileSizeBytes: 0,
      scannedBytes: 0,
      truncated: false,
      partial: false,
      scanScope: "none",
      omittedBeforeBytes: 0,
      omittedAfterBytes: 0,
      truncationReason: null,
      lineCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      toolOutputCount: 0,
      reasoningCount: 0,
      encryptedReasoningCount: 0,
      encryptedReasoningBytes: 0,
      patchDiffCount: 0,
      eventCount: 0,
      parseErrorCount: 0,
    };
  }

  const cacheKey = `${filePath}:${stats.mtimeMs}:${stats.size}`;
  if (statsCache.has(cacheKey)) {
    return statsCache.get(cacheKey);
  }

  const previousCacheKey = statCache.get(filePath);
  if (previousCacheKey && previousCacheKey !== cacheKey) {
    statsCache.delete(previousCacheKey);
  }
  statCache.set(filePath, cacheKey);

  const source = readBoundedRollout(filePath, stats, maxRolloutStatsBytes, "prefix");

  const result = {
    exists: true,
    fileSizeBytes: source.totalBytes,
    scannedBytes: source.scannedBytes,
    truncated: source.truncated,
    partial: source.partial,
    scanScope: source.scanScope,
    omittedBeforeBytes: source.omittedBeforeBytes,
    omittedAfterBytes: source.omittedAfterBytes,
    truncationReason: source.truncated
      ? `Rollout exceeds the ${maxRolloutStatsBytes}-byte stats limit; counts cover only the earliest complete records.`
      : null,
    lineCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolOutputCount: 0,
    reasoningCount: 0,
    encryptedReasoningCount: 0,
    encryptedReasoningBytes: 0,
    patchDiffCount: 0,
    eventCount: 0,
    parseErrorCount: 0,
  };

  for (const line of source.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    result.lineCount += 1;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      result.parseErrorCount += 1;
      continue;
    }
    const payload = record.payload || {};
    if (record.type === "event_msg") {
      result.eventCount += 1;
      if (payload.type === "patch_apply_end") {
        const changes = payload.changes && typeof payload.changes === "object" ? payload.changes : {};
        result.patchDiffCount += Object.keys(changes).length;
      }
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message") {
      if (payload.role === "user") result.userMessageCount += 1;
      if (payload.role === "assistant") result.assistantMessageCount += 1;
    } else if (payload.type === "reasoning") {
      result.reasoningCount += 1;
      if (payload.encrypted_content) {
        result.encryptedReasoningCount += 1;
        result.encryptedReasoningBytes += Buffer.byteLength(String(payload.encrypted_content), "utf8");
      }
    } else if (["function_call", "custom_tool_call", "tool_search_call", "web_search_call"].includes(payload.type)) {
      result.toolCallCount += 1;
    } else if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
      result.toolOutputCount += 1;
    }
  }

  statsCache.set(cacheKey, result);
  return result;
}

function projectPatch(projectPath, patch = {}) {
  const normalized = normalizeCwd(projectPath);
  return {
    id: projectIdForPath(normalized),
    path: normalized,
    key: comparablePath(normalized),
    label: patch.label || path.basename(normalized) || normalized,
    exists: pathLooksLocal(normalized) ? exists(normalized) : false,
    threadCount: 0,
    chatCount: 0,
    subagentCount: 0,
    approvalCount: 0,
    archivedCount: 0,
    updatedAtMs: null,
    updatedAtIso: null,
    active: false,
    pinned: false,
    saved: false,
    orderIndex: null,
    sources: [],
  };
}

function addSource(project, source) {
  if (source && !project.sources.includes(source)) {
    project.sources.push(source);
  }
}

function listProjects() {
  const rows = codexThreadRows();
  const projects = new Map();

  const ensureProject = (projectPath, patch = {}) => {
    if (!projectPath || typeof projectPath !== "string") return null;
    const normalized = normalizeCwd(projectPath);
    const key = comparablePath(normalized);
    if (!key) return null;
    const project = projects.get(key) || projectPatch(normalized, patch);
    if (patch.label) project.label = patch.label;
    if (patch.active) project.active = true;
    if (patch.pinned) project.pinned = true;
    if (patch.saved) project.saved = true;
    if (Number.isFinite(patch.orderIndex) && (project.orderIndex === null || patch.orderIndex < project.orderIndex)) {
      project.orderIndex = patch.orderIndex;
    }
    for (const source of patch.sources || []) addSource(project, source);
    projects.set(key, project);
    return project;
  };

  for (const row of rows) {
    const project = ensureProject(row.cwd, { sources: ["threads"] });
    if (!project) continue;
    project.threadCount += 1;
    if (isApprovalThread(row)) project.approvalCount += 1;
    else if (isSubagentThread(row)) project.subagentCount += 1;
    else project.chatCount += 1;
    if (row.archived) project.archivedCount += 1;
    const updatedAtMs = Number(row.updated_at_ms || (row.updated_at ? row.updated_at * 1000 : 0)) || null;
    if (updatedAtMs && (!project.updatedAtMs || updatedAtMs > project.updatedAtMs)) {
      project.updatedAtMs = updatedAtMs;
      project.updatedAtIso = timestampMsToIso(updatedAtMs);
    }
  }

  const globalState = readGlobalState();
  const labels = globalState["electron-workspace-root-labels"];
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const [projectPath, label] of Object.entries(labels)) {
      ensureProject(projectPath, { label: String(label || path.basename(projectPath) || projectPath), sources: ["workspace-labels"] });
    }
  }

  const saved = Array.isArray(globalState["electron-saved-workspace-roots"]) ? globalState["electron-saved-workspace-roots"] : [];
  saved.forEach((projectPath) => ensureProject(projectPath, { saved: true, sources: ["saved-workspaces"] }));

  const active = Array.isArray(globalState["active-workspace-roots"]) ? globalState["active-workspace-roots"] : [];
  active.forEach((projectPath) => ensureProject(projectPath, { active: true, sources: ["active-workspaces"] }));

  const pinned = Array.isArray(globalState["pinned-project-ids"]) ? globalState["pinned-project-ids"] : [];
  pinned.forEach((projectPath) => ensureProject(projectPath, { pinned: true, sources: ["pinned-projects"] }));

  const order = Array.isArray(globalState["project-order"]) ? globalState["project-order"] : [];
  order.forEach((projectPath, index) => ensureProject(projectPath, { orderIndex: index, sources: ["project-order"] }));

  return [...projects.values()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if ((a.updatedAtMs || 0) !== (b.updatedAtMs || 0)) return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
    if ((a.orderIndex ?? 999999) !== (b.orderIndex ?? 999999)) return (a.orderIndex ?? 999999) - (b.orderIndex ?? 999999);
    return a.label.localeCompare(b.label);
  });
}

function threadSummary(row, sessionNames) {
  const stats = rolloutStats(row.rollout_path);
  const kind = isApprovalThread(row) ? "approval" : isSubagentThread(row) ? "subagent" : "chat";
  return {
    id: row.id,
    title: threadTitle(row, sessionNames),
    kind,
    cwd: row.cwd,
    archived: Boolean(row.archived),
    createdAtIso: threadTimestamp(row, "created"),
    updatedAtIso: threadTimestamp(row, "updated"),
    updatedAtMs: Number(row.updated_at_ms || (row.updated_at ? row.updated_at * 1000 : 0)) || null,
    rolloutPath: row.rollout_path || null,
    model: firstString(row.model, row.model_provider),
    reasoningEffort: row.reasoning_effort || null,
    gitBranch: row.git_branch || null,
    gitSha: row.git_sha || null,
    preview: compactText(firstString(row.preview, row.first_user_message, row.title), 360),
    stats,
  };
}

function listThreadsForProject(projectId, includeApprovals, includeSubagents) {
  const projectPath = pathFromProjectId(projectId);
  const key = comparablePath(projectPath);
  const sessionNames = readSessionIndexNames();
  return codexThreadRows()
    .filter((row) => comparablePath(row.cwd) === key)
    .filter((row) => includeApprovals || !isApprovalThread(row))
    .filter((row) => includeSubagents || !isSubagentThread(row))
    .map((row) => threadSummary(row, sessionNames));
}

function findThread(threadId) {
  return codexThreadRows().find((row) => row.id === threadId) || null;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (/image/i.test(String(item.type || ""))) return "[image attachment]";
      if (typeof item.url === "string" && item.url && !item.url.startsWith("data:")) return item.url;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function isInternalUserText(text) {
  const value = String(text || "").trim();
  return !value || value.startsWith("# AGENTS.md instructions for ") || value.startsWith("<environment_context>");
}

function reasoningText(payload) {
  if (Array.isArray(payload.summary)) {
    const summary = payload.summary
      .map((item) => (typeof item === "string" ? item : firstString(item?.text, item?.summary)))
      .filter(Boolean)
      .join("\n\n");
    if (summary) return summary;
  }
  if (Array.isArray(payload.content)) {
    const content = payload.content
      .map((item) => (typeof item === "string" ? item : firstString(item?.text, item?.summary)))
      .filter(Boolean)
      .join("\n\n");
    if (content) return content;
  }
  return firstString(payload.summary);
}

function toolName(payload) {
  if (payload.type === "tool_search_call" || payload.type === "tool_search_output") return "tool_search";
  if (payload.type === "web_search_call") return "web_search";
  const namespace = typeof payload.namespace === "string" ? payload.namespace.replace(/^mcp__/, "").replace(/__$/, "") : "";
  return namespace ? `${namespace}.${payload.name || "tool"}` : firstString(payload.name, payload.tool, payload.type, "tool");
}

function toolInput(payload) {
  if (payload.type === "custom_tool_call") return payload.input || "";
  if (payload.type === "tool_search_call") return payload.arguments || {};
  if (payload.type === "web_search_call") return payload.action || {};
  return parseJsonMaybe(payload.arguments) || payload.arguments || {};
}

function summarizeToolInput(name, input) {
  if (typeof input === "string") {
    const firstLine = input.split(/\r?\n/).find((line) => line.trim()) || "";
    return compactText(firstLine, 180);
  }
  if (!input || typeof input !== "object") return "";
  const parts = [];
  for (const key of ["type", "path", "file", "target_file", "command", "cmd", "query", "title", "url"]) {
    if (input[key]) parts.push(String(input[key]));
  }
  if (input.code) parts.push(String(input.code).split(/\r?\n/).find((line) => line.trim()) || "code");
  if (input.information_request) parts.push(String(input.information_request));
  if (Array.isArray(input.view_range)) parts.push(`lines ${input.view_range.join("-")}`);
  if (parts.length) return compactText(parts.join(" · "), 220);
  return compactText(JSON.stringify(input), 180);
}

function toolOutputText(payload) {
  if (typeof payload.output === "string") {
    const parsed = parseJsonMaybe(payload.output);
    if (parsed && typeof parsed.output === "string") return parsed.output;
    return payload.output;
  }
  if (payload.tools) return JSON.stringify(payload.tools, null, 2);
  if (payload.result) return JSON.stringify(payload.result, null, 2);
  return "";
}

function mcpResultText(payload) {
  const ok = payload?.result?.Ok;
  const err = payload?.result?.Err;
  const content = ok?.content || err?.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => firstString(item?.text)).filter(Boolean).join("\n\n");
    if (text) return text;
  }
  return JSON.stringify(payload.result || payload, null, 2);
}

function relativePath(filePath, rootPath) {
  const normalized = normalizeCwd(filePath);
  const root = normalizeCwd(rootPath);
  if (!root) return normalized;
  try {
    const relative = path.relative(root, normalized);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  } catch {
    // Return the absolute path below.
  }
  return normalized;
}

function lineCount(text) {
  if (!text) return 0;
  return String(text).split(/\r?\n/).length;
}

function diffFromContent(filePath, rootPath, changeKind, beforeText, afterText) {
  return {
    path: relativePath(filePath, rootPath),
    changeKind,
    totalAddedLines: lineCount(afterText),
    totalRemovedLines: lineCount(beforeText),
    beforeText: beforeText || "",
    afterText: afterText || "",
    unifiedDiff: "",
  };
}

function diffFromUnified(filePath, rootPath, unifiedDiff) {
  let added = 0;
  let removed = 0;
  for (const line of String(unifiedDiff || "").split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return {
    path: relativePath(filePath, rootPath),
    changeKind: "edited",
    totalAddedLines: added,
    totalRemovedLines: removed,
    beforeText: "",
    afterText: "",
    unifiedDiff: unifiedDiff || "",
  };
}

function diffsFromPatchChanges(changes, rootPath) {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([filePath, change]) => {
    const type = change?.type || change?.kind?.type || "update";
    if (type === "add") return diffFromContent(filePath, rootPath, "created", "", firstString(change.content, change.diff));
    if (type === "delete" || type === "remove") return diffFromContent(filePath, rootPath, "deleted", firstString(change.content, change.diff), "");
    if (change?.unified_diff) return diffFromUnified(filePath, rootPath, change.unified_diff);
    return diffFromContent(filePath, rootPath, "edited", "", firstString(change.content, change.diff));
  });
}

function makeTool(payload, timestamp, fallbackId) {
  const input = toolInput(payload);
  const name = toolName(payload);
  return {
    id: firstString(payload.call_id, payload.id, fallbackId),
    name,
    input,
    inputJson: typeof input === "string" ? input : JSON.stringify(input, null, 2),
    inputSummary: summarizeToolInput(name, input),
    output: "",
    phase: payload.status || "called",
    isError: false,
    hasResult: false,
    diffs: [],
    timestamp,
  };
}

function parseRollout(row) {
  const filePath = normalizeCwd(row.rollout_path);
  const fileStats = statSafe(filePath);
  const source = fileStats ? readBoundedRollout(filePath, fileStats, maxRolloutDetailBytes, "tail") : null;
  const text = source?.text || "";
  const exchanges = [];
  const callMap = new Map();
  const metadata = {
    rolloutPath: filePath || null,
    fileSizeBytes: source?.totalBytes || 0,
    parsedBytes: source?.scannedBytes || 0,
    truncated: Boolean(source?.truncated),
    partial: Boolean(source?.partial),
    scanScope: source?.scanScope || "none",
    omittedBeforeBytes: source?.omittedBeforeBytes || 0,
    omittedAfterBytes: source?.omittedAfterBytes || 0,
    truncationReason: source?.truncated
      ? `Rollout exceeds the ${maxRolloutDetailBytes}-byte detail limit; only the most recent complete records are returned.`
      : null,
    lineCount: 0,
    parseErrors: 0,
    sessionMeta: null,
    turnContext: null,
  };

  let current = null;
  let turnIndex = 0;

  const ensureExchange = (timestamp) => {
    if (!current) {
      turnIndex += 1;
      current = {
        id: `turn-${turnIndex}`,
        timestamp: timestamp || "",
        request: "",
        events: [],
      };
      exchanges.push(current);
    }
    return current;
  };

  const startExchange = (request, timestamp) => {
    turnIndex += 1;
    current = {
      id: `turn-${turnIndex}`,
      timestamp: timestamp || "",
      request,
      events: [],
    };
    exchanges.push(current);
    return current;
  };

  const addTool = (payload, timestamp, lineNumber) => {
    const exchange = ensureExchange(timestamp);
    const tool = makeTool(payload, timestamp, `${payload.type || "tool"}-${lineNumber}`);
    exchange.events.push({ type: "tool", timestamp, tool });
    if (tool.id) callMap.set(tool.id, tool);
    return tool;
  };

  const applyToolOutput = (callId, payload, outputText, isError = false) => {
    if (!callId) return;
    const tool = callMap.get(callId);
    if (!tool) return;
    const output = outputText || toolOutputText(payload);
    if (output && !tool.output) tool.output = output;
    tool.hasResult = true;
    tool.isError = Boolean(isError || payload.is_error || payload.isError);
    tool.phase = payload.status || (tool.isError ? "error" : "done");
  };

  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    lineNumber += 1;
    metadata.lineCount += 1;
    let record = null;
    try {
      record = JSON.parse(rawLine);
    } catch {
      metadata.parseErrors += 1;
      continue;
    }

    const payload = record.payload || {};
    const timestamp = record.timestamp || "";

    if (record.type === "session_meta") {
      metadata.sessionMeta = payload;
      continue;
    }
    if (record.type === "turn_context") {
      metadata.turnContext = payload;
      continue;
    }

    if (record.type === "response_item" && payload.type === "message") {
      const textValue = contentText(payload.content);
      if (!textValue.trim()) continue;
      if (payload.role === "user") {
        if (!isInternalUserText(textValue)) startExchange(textValue, timestamp);
        continue;
      }
      if (payload.role === "assistant") {
        const exchange = ensureExchange(timestamp);
        exchange.events.push({ type: "assistant", timestamp, text: textValue });
      }
      continue;
    }

    if (record.type === "response_item" && payload.type === "reasoning") {
      const textValue = reasoningText(payload);
      const encryptedBytes = payload.encrypted_content ? Buffer.byteLength(String(payload.encrypted_content), "utf8") : 0;
      if (textValue || encryptedBytes) {
        const exchange = ensureExchange(timestamp);
        exchange.events.push({
          type: "thinking",
          timestamp,
          text: textValue,
          encryptedBytes,
        });
      }
      continue;
    }

    if (record.type === "response_item" && ["function_call", "custom_tool_call", "tool_search_call", "web_search_call"].includes(payload.type)) {
      addTool(payload, timestamp, lineNumber);
      continue;
    }

    if (record.type === "response_item" && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
      applyToolOutput(payload.call_id, payload);
      continue;
    }

    if (record.type === "event_msg" && payload.type === "mcp_tool_call_end") {
      const isError = Boolean(payload?.result?.Ok?.isError || payload?.result?.Err);
      applyToolOutput(payload.call_id, payload, mcpResultText(payload), isError);
      continue;
    }

    if (record.type === "event_msg" && payload.type === "patch_apply_end") {
      const tool = callMap.get(payload.call_id);
      if (!tool) continue;
      const output = [payload.stdout, payload.stderr].filter(Boolean).join("\n");
      if (output && !tool.output) tool.output = output;
      tool.hasResult = true;
      tool.isError = payload.success === false;
      tool.phase = tool.isError ? "error" : "done";
      tool.diffs = [...tool.diffs, ...diffsFromPatchChanges(payload.changes, row.cwd)];
    }
  }

  return { exchanges, metadata };
}

function getThreadDetail(threadId) {
  const row = findThread(threadId);
  if (!row) return null;
  const sessionNames = readSessionIndexNames();
  const parsed = parseRollout(row);
  const stats = rolloutStats(row.rollout_path);
  return {
    thread: threadSummary(row, sessionNames),
    rawThread: row,
    metadata: parsed.metadata,
    exchanges: parsed.exchanges,
    stats,
  };
}

function summary() {
  const rows = codexThreadRows();
  const projects = listProjects();
  const latest = rows.reduce((best, row) => Math.max(best, Number(row.updated_at_ms || (row.updated_at ? row.updated_at * 1000 : 0)) || 0), 0);
  return {
    codexHome: defaultCodexHome,
    projectCount: projects.length,
    threadCount: rows.length,
    chatCount: rows.filter((row) => !isApprovalThread(row) && !isSubagentThread(row)).length,
    subagentCount: rows.filter(isSubagentThread).length,
    approvalCount: rows.filter(isApprovalThread).length,
    updatedAtIso: timestampMsToIso(latest),
  };
}

function orchestrationRunPath(runId) {
  const safeId = String(runId || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return safeId ? path.join(orchestrationRunsDir, `${safeId}.json`) : "";
}

function readOrchestrationRun(runId) {
  const filePath = orchestrationRunPath(runId);
  return filePath ? readJsonSafe(filePath) : null;
}

function listOrchestrationRuns() {
  if (!exists(orchestrationRunsDir)) {
    return [];
  }
  return fs
    .readdirSync(orchestrationRunsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJsonSafe(path.join(orchestrationRunsDir, entry.name)))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function orchestrationId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `orch-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

function selectedProjects(projectIds) {
  const ids = Array.isArray(projectIds) ? projectIds.map(String) : [];
  const idSet = new Set(ids);
  const projects = listProjects().filter((project) => idSet.has(project.id));
  const missingIds = ids.filter((id) => !projects.some((project) => project.id === id));
  return { projects, missingIds };
}

function childPromptForProject({ prompt, project, runTitle }) {
  return [
    "You are a child Codex agent launched by a multi-project orchestration run.",
    "",
    `Orchestration: ${runTitle}`,
    `Target project: ${project.label}`,
    `Target path: ${project.path}`,
    "",
    "Scope rules:",
    "- Treat this target project as your primary workspace.",
    "- Do not modify unrelated projects unless the task explicitly requires it.",
    "- Start by inspecting the repository state before making edits.",
    "- Keep your final response focused on what changed, what was verified, and any blockers.",
    "",
    "User orchestration request:",
    prompt.trim(),
  ].join("\n");
}

function orchestrationChildrenForPayload(payload) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    throw new HttpError(400, "Orchestration prompt is required.");
  }
  const { projects, missingIds } = selectedProjects(payload.projectIds);
  if (missingIds.length) {
    throw new HttpError(400, `Unknown project ids: ${missingIds.join(", ")}`);
  }
  if (!projects.length) {
    throw new HttpError(400, "Select at least one project.");
  }
  if (projects.length > 50) {
    throw new HttpError(400, "Refusing to start more than 50 child chats in one run.");
  }
  const runTitle = titleText(payload.title, "Multi-project orchestration", 96);
  const children = projects.map((project, index) => ({
    index,
    projectId: project.id,
    projectPath: project.path,
    projectLabel: project.label,
    title: titleText(`${runTitle} · ${project.label}`, `Orchestration · ${project.label}`, 140),
    prompt: childPromptForProject({ prompt, project, runTitle }),
    status: "queued",
    threadId: null,
    turnId: null,
    error: null,
    createdAt: null,
    updatedAt: null,
  }));
  return { prompt, runTitle, children };
}

function previewOrchestration(payload) {
  const { prompt, runTitle, children } = orchestrationChildrenForPayload(payload);
  return {
    title: runTitle,
    prompt,
    startTurns: payload.startTurns !== false,
    projectCount: children.length,
    children: children.map((child) => ({
      projectId: child.projectId,
      projectLabel: child.projectLabel,
      projectPath: child.projectPath,
      title: child.title,
      prompt: child.prompt,
    })),
  };
}

function startOrchestration(payload) {
  const { prompt, runTitle, children } = orchestrationChildrenForPayload(payload);
  const now = new Date().toISOString();
  const runId = orchestrationId();
  const runPath = orchestrationRunPath(runId);
  const run = {
    id: runId,
    title: runTitle,
    prompt,
    codexHome: defaultCodexHome,
    status: "queued",
    startTurns: payload.startTurns !== false,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    runnerPid: null,
    logPath: path.join(orchestrationDir, "logs", `${runId}.log`),
    children,
  };
  writeJsonFile(runPath, run);

  const child = spawn(process.execPath, [path.join(rootDir, "scripts", "run-codex-orchestration.cjs"), "--run-path", runPath], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  run.runnerPid = child.pid;
  run.updatedAt = new Date().toISOString();
  writeJsonFile(runPath, run);
  return run;
}

const patchFeatureDefinitions = [
  {
    id: "catalogShim",
    label: "All chats performance shim",
    description: "Load every task as a lightweight catalog summary and hydrate conversation bodies only when opened.",
    defaultEnabled: true,
  },
  {
    id: "chatLimit",
    label: "Legacy eager history hydration",
    description: "Eagerly hydrate a larger sidebar window. This can lag badly with large catalogs and cannot be combined with the shim.",
    defaultEnabled: false,
  },
  {
    id: "remoteControl",
    label: "Enable remote control",
    description: "Keep app-server remote_control enabled instead of stripping it from config.",
    defaultEnabled: true,
  },
  {
    id: "remoteControlSettings",
    label: "Show remote control setting",
    description: "Remove the settings UI filter that hides the remote_control feature.",
    defaultEnabled: true,
  },
  {
    id: "nativeOrchestrator",
    label: "Native orchestrations",
    description: "Inject the Orchestrations sidebar/settings patch into the native Codex webview.",
    defaultEnabled: true,
  },
  {
    id: "providerSettings",
    label: "Provider/model settings",
    description: "Inject native settings for OpenAI, Ollama, DeepSeek, Z.ai GLM, and custom model providers.",
    defaultEnabled: true,
  },
  {
    id: "importSettings",
    label: "Native chat imports",
    description: "Inject a native Imports settings page for Augment, Kiro, Roo Code, and Cline chat imports.",
    defaultEnabled: true,
  },
  {
    id: "patcherSettings",
    label: "Native patcher controls",
    description: "Inject the native Patcher settings page and Help menu About Patcher dialog.",
    defaultEnabled: true,
  },
  {
    id: "forceMainWindowStartup",
    label: "Force main window on launch",
    description: "Patch startup so a visible main Codex window opens shortly after launch.",
    defaultEnabled: false,
  },
  {
    id: "shortcut",
    label: "Desktop shortcut",
    description: "Create or refresh a shortcut that launches the current patched Codex clone.",
    defaultEnabled: true,
  },
];

function defaultPatchOptions() {
  const patcherConfig = mergedPatcherConfig();
  const persistedBuildFeatures =
    patcherConfig.buildFeatures && typeof patcherConfig.buildFeatures === "object" && !Array.isArray(patcherConfig.buildFeatures)
      ? patcherConfig.buildFeatures
      : {};
  const configuredOutputRoot = String(patcherConfig.outputRoot || path.join(rootDir, "build-output")).replace(
    /%([^%]+)%/g,
    (match, name) => process.env[name] || match
  );
  return {
    limit: Number(patcherConfig.chatLimit || 1000),
    sourceMode: "current",
    sourceAppDir: "",
    sourceAsar: "",
    outputRoot: path.resolve(configuredOutputRoot),
    shortcutName: String(patcherConfig.shortcutName || "Codex Patch Studio Current"),
    shortcutDir: "",
    keepWork: false,
    features: Object.fromEntries(
      patchFeatureDefinitions.map((feature) => [
        feature.id,
        Object.prototype.hasOwnProperty.call(persistedBuildFeatures, feature.id)
          ? persistedBuildFeatures[feature.id] !== false
          : feature.defaultEnabled,
      ])
    ),
  };
}

function normalizePatchOptions(payload = {}) {
  const defaults = defaultPatchOptions();
  const incomingFeatures = payload.features && typeof payload.features === "object" ? payload.features : {};
  const options = {
    ...defaults,
    ...payload,
    features: {
      ...defaults.features,
      ...incomingFeatures,
    },
  };

  options.limit = Number(options.limit || defaults.limit);
  if (!Number.isInteger(options.limit) || options.limit < 50 || options.limit > 10000) {
    throw new HttpError(400, "Chat limit must be an integer from 50 through 10000.");
  }

  if (options.sourceMode === "latest") options.sourceMode = "current";
  options.sourceMode = ["current", "manual"].includes(options.sourceMode) ? options.sourceMode : "current";
  options.sourceAppDir = String(options.sourceAppDir || "").trim();
  options.sourceAsar = String(options.sourceAsar || "").trim();
  options.outputRoot = String(options.outputRoot || defaults.outputRoot).trim();
  options.shortcutName = titleText(options.shortcutName, defaults.shortcutName, 80);
  options.shortcutDir = String(options.shortcutDir || "").trim();
  options.keepWork = options.keepWork === true;

  for (const feature of patchFeatureDefinitions) {
    options.features[feature.id] = options.features[feature.id] !== false;
  }
  if (options.features.catalogShim && options.features.chatLimit) {
    throw new HttpError(400, "All chats performance shim and legacy eager history hydration are mutually exclusive.");
  }
  if (options.sourceMode === "manual" && !options.sourceAppDir) {
    throw new HttpError(400, "Manual source mode requires a source app directory.");
  }
  return options;
}

function patchBuildArgs(options) {
  const args = [path.join(rootDir, "scripts", "build-patched-codex-app.cjs"), "--json", "--limit", String(options.limit)];
  if (options.sourceMode === "manual") {
    args.push("--source-app-dir", options.sourceAppDir);
    if (options.sourceAsar) args.push("--source-asar", options.sourceAsar);
  }
  if (!options.features.catalogShim) args.push("--no-catalog-shim");
  if (options.features.chatLimit) args.push("--chat-limit");
  else args.push("--no-chat-limit");
  if (!options.features.remoteControl) args.push("--no-remote-control");
  if (!options.features.remoteControlSettings) args.push("--no-remote-control-settings");
  if (!options.features.nativeOrchestrator) args.push("--no-native-orchestrator");
  if (!options.features.providerSettings) args.push("--no-provider-settings");
  if (!options.features.importSettings) args.push("--no-import-settings");
  if (!options.features.patcherSettings) args.push("--no-patcher-settings");
  if (options.features.forceMainWindowStartup) args.push("--force-main-window-startup");
  if (!options.features.shortcut) args.push("--no-shortcut");
  if (options.shortcutName) args.push("--shortcut-name", options.shortcutName);
  if (options.shortcutDir) args.push("--shortcut-dir", options.shortcutDir);
  if (options.outputRoot) args.push("--output-root", options.outputRoot);
  if (options.keepWork) args.push("--keep-work");
  return args;
}

function patchPreview(payload) {
  const options = normalizePatchOptions(payload);
  const args = patchBuildArgs(options);
  return {
    options,
    command: [process.execPath, ...args],
    selectedFeatures: patchFeatureDefinitions.filter((feature) => options.features[feature.id]),
  };
}

function patchJobId(type = "patch") {
  const safeType = String(type || "patch").replace(/[^a-zA-Z0-9_.-]/g, "") || "patch";
  return `${safeType}-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
}

function patchJobPath(jobId) {
  const safeId = String(jobId || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return safeId ? path.join(patchJobsDir, `${safeId}.json`) : "";
}

function readPatchJob(jobId) {
  const filePath = patchJobPath(jobId);
  return filePath ? readJsonSafe(filePath) : null;
}

function writePatchJob(job) {
  job.updatedAt = new Date().toISOString();
  writeJsonFile(patchJobPath(job.id), job);
}

function listPatchJobs() {
  if (!exists(patchJobsDir)) {
    return [];
  }
  return fs
    .readdirSync(patchJobsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJsonSafe(path.join(patchJobsDir, entry.name)))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function readLogTail(filePath, maxBytes = 60000) {
  const stats = statSafe(filePath);
  if (!stats) return "";
  const start = Math.max(0, stats.size - maxBytes);
  const buffer = Buffer.alloc(stats.size - start);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

function parseLastJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some commands print progress text before their final JSON object.
  }
  const starts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(trimmed.slice(starts[index]));
    } catch {
      // Try the previous opening brace.
    }
  }
  return null;
}

function expandEnvironmentPath(value) {
  return String(value || "")
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] || match)
    .replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE || process.env.HOME || "~");
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function readJsonBoundedSafe(filePath, maxBytes = 8 * 1024 * 1024) {
  const stats = statSafe(filePath);
  if (!stats?.isFile() || stats.size > maxBytes) return null;
  return readJsonSafe(filePath);
}

function runGitText(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish("");
    }, 5000);
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout, "utf8") < 256 * 1024) stdout += chunk.toString();
    });
    child.once("error", () => finish(""));
    child.once("close", (code) => finish(code === 0 ? stdout.trim() : ""));
  });
}

function sanitizedRepositorySource(value, fallback) {
  const source = String(value || "").trim();
  if (!source) return fallback;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
  try {
    const parsed = new url.URL(source);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

async function sourceInfoForFeature(record, cache) {
  const cachedRoot = [...cache.keys()].find((candidate) => isPathInside(candidate, record.rootPath));
  const candidateRoot = cachedRoot || (await runGitText(record.rootPath, ["rev-parse", "--show-toplevel"]));
  const gitRoot = candidateRoot && isPathInside(candidateRoot, record.rootPath) ? path.resolve(candidateRoot) : "";
  if (!gitRoot) {
    return {
      repository: record.rootPath,
      commit: null,
      branch: null,
      dirty: null,
      worktree: record.rootPath,
      modulePath: record.rootPath,
    };
  }
  let repositoryPromise = cache.get(gitRoot);
  if (!repositoryPromise) {
    repositoryPromise = Promise.all([
      runGitText(gitRoot, ["remote", "get-url", "origin"]),
      runGitText(gitRoot, ["rev-parse", "HEAD"]),
      runGitText(gitRoot, ["branch", "--show-current"]),
      runGitText(gitRoot, ["status", "--porcelain", "--untracked-files=normal"]),
    ]).then(([remote, commit, branch, dirtyOutput]) => ({
      repository: sanitizedRepositorySource(remote, gitRoot),
      commit: commit || null,
      branch: branch || null,
      dirty: Boolean(dirtyOutput),
      worktree: gitRoot,
    }));
    cache.set(gitRoot, repositoryPromise);
  }
  const repository = await repositoryPromise;
  return {
    ...repository,
    modulePath: record.rootPath,
  };
}

function compatibilityForFeature(record, sourceVersion) {
  const versions = Array.isArray(record.manifest.supportedCodexVersions)
    ? record.manifest.supportedCodexVersions
    : Array.isArray(record.manifest.supports?.codexVersions)
      ? record.manifest.supports.codexVersions
      : [];
  const minimum = record.manifest.supports?.minimumCodexVersion || null;
  const maximum = record.manifest.supports?.maximumCodexVersion || null;
  if (!sourceVersion) {
    return { status: "unknown", sourceVersion: null, versions, minimum, maximum };
  }
  return {
    status: compatibleWith(record, sourceVersion) ? "compatible" : "incompatible",
    sourceVersion,
    versions,
    minimum,
    maximum,
  };
}

function featureEvidenceStatus(evidence, fallback) {
  if (!evidence) return fallback;
  const resultFailed = evidence.result && typeof evidence.result === "object" && evidence.result.ok === false;
  const verificationFailed = Array.isArray(evidence.verification) && evidence.verification.some((item) => item?.matched === false);
  if (resultFailed || verificationFailed) return "failed";
  const verified =
    evidence.receipt?.validated === true ||
    evidence.receipt?.path ||
    evidence.result?.ok === true ||
    (Array.isArray(evidence.verification) && evidence.verification.length > 0 && evidence.verification.every((item) => item?.matched === true));
  return verified ? "passed" : "unknown";
}

function featureEvidenceDetail(evidence, fallback) {
  if (!evidence) return fallback;
  const value = evidence.result ?? evidence.verification ?? null;
  if (value == null) return "Completed without structured detail.";
  const serialized = JSON.stringify(value);
  return serialized.length > 320 ? `${serialized.slice(0, 317)}...` : serialized;
}

function verifiedPatchManifest(launcher) {
  const cloneRoot = String(launcher?.cloneRoot || "").trim();
  if (!cloneRoot || !path.isAbsolute(cloneRoot)) return null;
  const configuredOutputRoot = path.resolve(defaultPatchOptions().outputRoot);
  const launcherOutputRoot = expandEnvironmentPath(launcher?.outputRoot);
  const approvedOutputRoots = [configuredOutputRoot];
  if (launcherOutputRoot && path.isAbsolute(launcherOutputRoot)) {
    approvedOutputRoots.push(path.resolve(launcherOutputRoot));
  }
  if (!approvedOutputRoots.some((outputRoot) => isPathInside(outputRoot, cloneRoot))) return null;

  const launcherCodexExe = String(launcher?.codexExe || "").trim();
  if (!launcherCodexExe || !path.isAbsolute(launcherCodexExe) || !isPathInside(cloneRoot, launcherCodexExe)) return null;
  if (!statSafe(launcherCodexExe)?.isFile()) return null;

  const manifest = readJsonBoundedSafe(path.join(cloneRoot, "patch-manifest.json"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const samePath = (left, right) => {
    if (!left || !right) return false;
    const normalizedLeft = path.resolve(String(left));
    const normalizedRight = path.resolve(String(right));
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  };
  if (!samePath(manifest.cloneRoot, cloneRoot) || !samePath(manifest.codexExe, launcherCodexExe)) return null;

  const matchingFields = ["sourceVersion", "sourceAsarSha256", "sourceAppServerCliSha256", "buildIdentity"];
  if (
    matchingFields.some(
      (field) => launcher?.[field] != null && String(manifest?.[field] || "") !== String(launcher[field])
    )
  ) {
    return null;
  }
  const launcherPatcherSha = String(launcher?.patcherSource?.sha256 || "").trim();
  if (launcherPatcherSha && String(manifest?.patcherSource?.sha256 || "") !== launcherPatcherSha) return null;
  return manifest;
}

function directVerifiedBuild(patchManifest) {
  if (!patchManifest) return null;
  const identity = String(patchManifest.buildIdentity || patchManifest.patcherSource?.sha256 || "verified")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80);
  const builtAt = patchManifest.candidateFinalizedAt || patchManifest.builtAt || null;
  return {
    id: `direct-${identity}`,
    status: "passed",
    createdAt: patchManifest.builtAt || builtAt,
    completedAt: builtAt,
    exitCode: 0,
    error: null,
    logTail: "Verified immutable build manifest.",
  };
}

function safePatchJobLog(job) {
  const logPath = String(job?.logPath || "");
  if (!logPath || !isPathInside(patchLogsDir, logPath)) return "";
  return readLogTail(logPath, 12000);
}

async function featureDevelopmentStatus() {
  try {
    const config = mergedPatcherConfig();
    const catalog = discoverFeatureModules(rootDir, config);
    const configured = config.featureModules && typeof config.featureModules === "object" ? config.featureModules : {};
    const launcher = readJsonSafe(launcherConfigPath);
    const patchManifest = verifiedPatchManifest(launcher);
    const latestBuildJob = listPatchJobs().find((job) => ["patch", "update"].includes(job?.type)) || null;
    const sourceVersion =
      currentCodexUpdateSnapshot?.installedVersion || launcher?.sourceVersion || latestBuildJob?.result?.sourceVersion || null;
    const built = new Map(
      Array.isArray(launcher?.featureModules) ? launcher.featureModules.map((feature) => [feature.id, feature]) : []
    );
    const application = new Map(
      Array.isArray(patchManifest?.featureModuleApplication)
        ? patchManifest.featureModuleApplication.map((result) => [result.id, result])
        : []
    );
    const packed = new Map(
      Array.isArray(patchManifest?.packedVerification?.featureModules)
        ? patchManifest.packedVerification.featureModules.map((result) => [result.id, result])
        : []
    );
    const buildDefaults = defaultPatchOptions().features;
    const gitCache = new Map();
    const sources = await Promise.all(catalog.records.map((record) => sourceInfoForFeature(record, gitCache)));
    const modules = catalog.records.map((record, index) => {
      const legacyFeatureIds = Array.isArray(record.manifest.legacyFeatureIds) ? record.manifest.legacyFeatureIds : [];
      const configuredEnabled = Object.prototype.hasOwnProperty.call(configured, record.id)
        ? configured[record.id] !== false
        : legacyFeatureIds.length
          ? legacyFeatureIds.some((id) => buildDefaults[id] === true)
          : record.manifest.enabledByDefault === true;
      const builtRecord = built.get(record.id);
      const builtEnabled = builtRecord?.enabled === true;
      const applicationEvidence = application.get(record.id);
      const packedEvidence = packed.get(record.id);
      const buildFallback = builtEnabled ? "unknown" : configuredEnabled ? "pending" : "disabled";
      const testFallback = builtEnabled ? "unknown" : "not-run";
      return {
        ...publicFeatureRecord(record, configuredEnabled),
        configurable: record.kind !== "core" && record.manifest.implementation === "module",
        legacyFeatureIds,
        supports: {
          codexVersions: Array.isArray(record.manifest.supportedCodexVersions)
            ? record.manifest.supportedCodexVersions
            : [],
          minimumCodexVersion: record.manifest.supports?.minimumCodexVersion || null,
          maximumCodexVersion: record.manifest.supports?.maximumCodexVersion || null,
        },
        built: builtEnabled,
        compatibility: compatibilityForFeature(record, sourceVersion),
        source: sources[index],
        build: {
          status: featureEvidenceStatus(applicationEvidence, buildFallback),
          at: launcher?.builtAt || null,
          detail: featureEvidenceDetail(applicationEvidence, builtEnabled ? "Included, but no per-feature application evidence was recorded." : "Not included in the last verified build."),
        },
        test: {
          status: featureEvidenceStatus(packedEvidence, testFallback),
          at: launcher?.builtAt || null,
          detail: featureEvidenceDetail(packedEvidence, patchManifest ? "No per-feature packed verification evidence was recorded." : "No packed verification result is available."),
        },
      };
    });
    const localRoot = path.resolve(
      expandEnvironmentPath(config.localFeatureRoot || "%USERPROFILE%\\.codex-patch-studio-current\\features")
    );
    return {
      ok: true,
      fingerprint: catalogFingerprint(catalog),
      sourceVersion,
      sourceAsarSha256: launcher?.sourceAsarSha256 || latestBuildJob?.result?.sourceAsarSha256 || null,
      sourceCliSha256: launcher?.sourceAppServerCliSha256 || latestBuildJob?.result?.sourceAppServerCliSha256 || null,
      localRoot,
      communityRoot: communityFeatureRoot,
      modules,
      lastBuild: latestBuildJob
        ? {
            id: latestBuildJob.id,
            status: latestBuildJob.status,
            createdAt: latestBuildJob.createdAt,
            completedAt: latestBuildJob.completedAt,
            exitCode: latestBuildJob.exitCode,
            error: latestBuildJob.error,
            logTail: safePatchJobLog(latestBuildJob),
          }
        : directVerifiedBuild(patchManifest),
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error), modules: [] };
  }
}

function patchStatus() {
  const launcherConfig = readJsonSafe(launcherConfigPath);
  const latestJob = listPatchJobs()[0] || null;
  return {
    patchManagerSourceSha256,
    defaults: defaultPatchOptions(),
    bundleDefaults: defaultBundleOptions(),
    updatePolicy: updatePolicyStatus(),
    featureModules: featureModuleStatus(),
    features: patchFeatureDefinitions,
    launcherConfig,
    latestJob,
    runtimePaths: {
      repoRoot: rootDir,
      orchestrationRoot: path.join(rootDir, "codex-orchestrations"),
      providerModelCacheRoot: path.join(rootDir, "codex-provider-model-cache"),
    },
  };
}

function featureModuleStatus() {
  try {
    const config = mergedPatcherConfig();
    const catalog = discoverFeatureModules(rootDir, config);
    const configured = config.featureModules && typeof config.featureModules === "object" ? config.featureModules : {};
    const launcher = readJsonSafe(launcherConfigPath);
    const built = new Map(
      Array.isArray(launcher?.featureModules) ? launcher.featureModules.map((feature) => [feature.id, feature.enabled === true]) : []
    );
    return {
      ok: true,
      fingerprint: catalogFingerprint(catalog),
      localRoot: path.resolve(
        String(config.localFeatureRoot || "%USERPROFILE%\\.codex-patch-studio-current\\features").replace(
          /%([^%]+)%/g,
          (match, name) => process.env[name] || match
        )
      ),
      modules: catalog.records.map((record) => {
        const configuredEnabled = Object.prototype.hasOwnProperty.call(configured, record.id)
          ? configured[record.id] !== false
          : record.manifest.enabledByDefault === true;
        return {
          ...publicFeatureRecord(record, configuredEnabled),
          built: built.get(record.id) === true,
          configurable: record.kind !== "core" && record.manifest.implementation === "module",
        };
      }),
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error), modules: [] };
  }
}

function saveFeatureModuleSelection(payload = {}) {
  const id = String(payload.id || "").trim();
  const status = featureModuleStatus();
  if (!status.ok) throw new HttpError(400, status.error || "Feature catalog is invalid.");
  const feature = status.modules.find((candidate) => candidate.id === id);
  if (!feature) throw new HttpError(404, `Unknown feature module: ${id}`);
  if (!feature.configurable) throw new HttpError(400, `${id} is controlled by the built-in feature settings.`);
  const local = readJsonSafe(localPatcherConfigPath) || {};
  const merged = mergedPatcherConfig();
  const featureModules = {
    ...(merged.featureModules && !Array.isArray(merged.featureModules) && typeof merged.featureModules === "object"
      ? merged.featureModules
      : {}),
    ...(local.featureModules && !Array.isArray(local.featureModules) && typeof local.featureModules === "object"
      ? local.featureModules
      : {}),
  };
  featureModules[id] = payload.enabled === true;
  writeJsonFile(localPatcherConfigPath, { ...local, featureModules });
  return featureModuleStatus();
}

function validatedFeatureId(value, label, expectedKind = null) {
  const id = String(value || "").trim();
  if (id.length > 120 || !featureIdPattern.test(id)) {
    throw new HttpError(400, `${label} must be a namespaced lowercase feature ID.`);
  }
  if (expectedKind === "local" && !id.startsWith("local.")) {
    throw new HttpError(400, `${label} must start with local.`);
  }
  if (expectedKind === "contribution" && (id.startsWith("local.") || id.startsWith("core."))) {
    throw new HttpError(400, `${label} must use a contribution namespace, not local. or core.`);
  }
  return id;
}

function validatedFeatureRequestId(value) {
  const requestId = String(value || "").trim();
  if (!featureRequestIdPattern.test(requestId)) {
    throw new HttpError(400, "Feature Development commands require a valid one-shot requestId.");
  }
  return requestId;
}

function featureCatalogForAction() {
  const config = mergedPatcherConfig();
  const catalog = discoverFeatureModules(rootDir, config);
  const localRoot = path.resolve(
    expandEnvironmentPath(config.localFeatureRoot || "%USERPROFILE%\\.codex-patch-studio-current\\features")
  );
  return { config, catalog, localRoot };
}

function featureRecordForAction(catalog, id, expectedKind = null) {
  const feature = catalog.byId.get(id);
  if (!feature) throw new HttpError(404, `Unknown feature module: ${id}`);
  if (expectedKind && feature.kind !== expectedKind) {
    throw new HttpError(400, `${id} is not a ${expectedKind} feature module.`);
  }
  return feature;
}

function appendBoundedOutput(current, chunk) {
  const remaining = maxFeatureWorkflowOutputBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return { value: current, truncated: true };
  const buffer = Buffer.from(chunk);
  if (buffer.length <= remaining) return { value: current + buffer.toString("utf8"), truncated: false };
  return { value: current + buffer.subarray(0, remaining).toString("utf8"), truncated: true };
}

function outputLogLines(label, stdout, stderr, truncated) {
  const lines = [`${label}: ${path.relative(rootDir, featureWorkflowScriptPath)} (fixed argv; shell disabled)`];
  if (stdout.trim()) lines.push(...stdout.trim().split(/\r?\n/).slice(-80));
  if (stderr.trim()) lines.push(...stderr.trim().split(/\r?\n/).slice(-80));
  if (truncated) lines.push(`Output was truncated at ${maxFeatureWorkflowOutputBytes} bytes.`);
  return lines;
}

function runFeatureSourceWorkflow(args, label, timeoutMs = 30000) {
  if (!exists(featureWorkflowScriptPath)) {
    throw new HttpError(500, `Feature source workflow is missing: ${featureWorkflowScriptPath}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [featureWorkflowScriptPath, ...args], {
      cwd: rootDir,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      const logs = outputLogLines(label, stdout, stderr, truncated);
      finish(() => reject(new HttpError(504, `${label} timed out.`, { logs })));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const next = appendBoundedOutput(stdout, chunk);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendBoundedOutput(stderr, chunk);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.on("error", (error) => {
      const logs = outputLogLines(label, stdout, `${stderr}\n${error.message}`, truncated);
      finish(() => reject(new HttpError(500, `${label} could not start: ${error.message}`, { logs })));
    });
    child.on("close", (code) => {
      const logs = outputLogLines(label, stdout, stderr, truncated);
      if (code !== 0) {
        const detail = (stderr || stdout || `exit code ${code}`).trim().split(/\r?\n/).slice(-1)[0];
        finish(() => reject(new HttpError(409, `${label} failed: ${detail}`, { logs })));
        return;
      }
      finish(() => resolve({ result: parseLastJsonObject(stdout), logs }));
    });
  });
}

async function validatedWorkflowWorktree(result, expectedMode, logs) {
  const worktreeValue = String(result?.worktree || "").trim();
  if (!worktreeValue || !path.isAbsolute(worktreeValue)) {
    throw new HttpError(500, "The source workflow did not return an absolute worktree path.", { logs });
  }
  const worktree = path.resolve(worktreeValue);
  if (!statSafe(worktree)?.isDirectory()) {
    throw new HttpError(500, `The source workflow worktree does not exist: ${worktree}`, { logs });
  }
  const gitRoot = await runGitText(worktree, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot || comparablePath(gitRoot) !== comparablePath(worktree)) {
    throw new HttpError(500, "The source workflow returned a path that is not a Git worktree root.", { logs });
  }
  const expectedPrefix = expectedMode === "local" ? "local/" : "contrib/";
  if (result?.mode !== expectedMode || !String(result?.branch || "").startsWith(expectedPrefix)) {
    throw new HttpError(500, `The source workflow returned invalid ${expectedMode} metadata.`, { logs });
  }
  return worktree;
}

async function createLocalFeature(id) {
  const snapshot = await featureDevelopmentStatus();
  if (!snapshot.ok) throw new HttpError(409, snapshot.error || "Feature catalog is invalid.");
  if (!snapshot.sourceVersion) {
    throw new HttpError(409, "Build patched Codex once before creating a feature so its exact compatibility version is known.");
  }
  if (!/^[0-9a-f]{64}$/i.test(String(snapshot.sourceAsarSha256 || "")) || !/^[0-9a-f]{64}$/i.test(String(snapshot.sourceCliSha256 || ""))) {
    throw new HttpError(409, "The verified Codex source fingerprints are unavailable. Rebuild patched Codex before creating a feature.");
  }
  const workflow = await runFeatureSourceWorkflow(
    [
      "start",
      "--json",
      "--mode",
      "local",
      "--feature",
      id,
      "--codex-version",
      snapshot.sourceVersion,
      "--source-asar-sha256",
      snapshot.sourceAsarSha256,
      "--source-cli-sha256",
      snapshot.sourceCliSha256,
      "--repo",
      rootDir,
    ],
    `Create local feature workflow ${id}`,
    120000
  );
  const worktree = await validatedWorkflowWorktree(workflow.result, "local", workflow.logs);
  if (workflow.result?.feature !== id) {
    throw new HttpError(500, "The source workflow returned the wrong local feature ID.", { logs: workflow.logs });
  }
  const relativeFeatureRoot = String(workflow.result?.featureRoot || "").trim();
  const featureRoot = path.resolve(worktree, relativeFeatureRoot);
  if (!relativeFeatureRoot || path.isAbsolute(relativeFeatureRoot) || !isPathInside(worktree, featureRoot) || !exists(path.join(featureRoot, "feature.json"))) {
    throw new HttpError(500, "The source workflow returned an invalid local feature root.", { logs: workflow.logs });
  }
  const local = readJsonSafe(localPatcherConfigPath) || {};
  const merged = mergedPatcherConfig();
  const featureRoots = [
    ...(Array.isArray(merged.featureRoots) ? merged.featureRoots : []),
    ...(Array.isArray(local.featureRoots) ? local.featureRoots : []),
  ].filter((entry, index, entries) => {
    const value = typeof entry === "string" ? entry : entry?.path;
    if (!value) return false;
    return entries.findIndex((candidate) => {
      const candidateValue = typeof candidate === "string" ? candidate : candidate?.path;
      return candidateValue && comparablePath(expandEnvironmentPath(candidateValue)) === comparablePath(expandEnvironmentPath(value));
    }) === index;
  });
  if (!featureRoots.some((entry) => {
    const value = typeof entry === "string" ? entry : entry?.path;
    return value && comparablePath(expandEnvironmentPath(value)) === comparablePath(featureRoot);
  })) {
    featureRoots.push({ path: featureRoot, kind: "local" });
  }
  const featureModules = {
    ...(merged.featureModules && typeof merged.featureModules === "object" && !Array.isArray(merged.featureModules) ? merged.featureModules : {}),
    ...(local.featureModules && typeof local.featureModules === "object" && !Array.isArray(local.featureModules) ? local.featureModules : {}),
    [id]: true,
  };
  writeJsonFile(localPatcherConfigPath, { ...local, featureRoots, featureModules });
  return {
    message: `Created and registered ${id} in dedicated worktree ${worktree}.`,
    logs: workflow.logs,
    worktree,
    workflow: workflow.result,
    status: await featureDevelopmentStatus(),
  };
}

async function convertLocalFeature(id, targetId) {
  const { catalog } = featureCatalogForAction();
  const sourceRecord = featureRecordForAction(catalog, id, "local");
  const source = await sourceInfoForFeature(sourceRecord, new Map());
  const sourceWorktree = path.resolve(source.worktree || sourceRecord.rootPath);
  const gitRoot = await runGitText(sourceWorktree, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot || comparablePath(gitRoot) !== comparablePath(sourceWorktree) || !isPathInside(sourceWorktree, sourceRecord.rootPath)) {
    throw new HttpError(409, `${id} is not inside a valid local feature workflow worktree.`);
  }
  const workflow = await runFeatureSourceWorkflow(
    ["convert", "--json", "--feature", targetId, "--worktree", sourceWorktree],
    `Convert ${id} to contribution ${targetId}`,
    120000
  );
  const worktree = await validatedWorkflowWorktree(workflow.result, "contribution", workflow.logs);
  if (workflow.result?.feature !== targetId) {
    throw new HttpError(500, "The source workflow returned the wrong contribution feature ID.", { logs: workflow.logs });
  }
  const relativeFeatureRoot = String(workflow.result?.featureRoot || "").trim();
  const featureRoot = path.resolve(worktree, relativeFeatureRoot);
  if (
    !relativeFeatureRoot ||
    path.isAbsolute(relativeFeatureRoot) ||
    !isPathInside(worktree, featureRoot) ||
    !exists(path.join(featureRoot, "feature.json"))
  ) {
    throw new HttpError(500, "The source workflow returned an invalid contribution feature root.", { logs: workflow.logs });
  }
  const local = readJsonSafe(localPatcherConfigPath) || {};
  const merged = mergedPatcherConfig();
  const featureRoots = [
    ...(Array.isArray(merged.featureRoots) ? merged.featureRoots : []),
    ...(Array.isArray(local.featureRoots) ? local.featureRoots : []),
  ].filter((entry, index, entries) => {
    const value = typeof entry === "string" ? entry : entry?.path;
    if (!value) return false;
    return entries.findIndex((candidate) => {
      const candidateValue = typeof candidate === "string" ? candidate : candidate?.path;
      return candidateValue && comparablePath(expandEnvironmentPath(candidateValue)) === comparablePath(expandEnvironmentPath(value));
    }) === index;
  });
  if (!featureRoots.some((entry) => {
    const value = typeof entry === "string" ? entry : entry?.path;
    return value && comparablePath(expandEnvironmentPath(value)) === comparablePath(featureRoot);
  })) {
    featureRoots.push({ path: featureRoot, kind: "contribution" });
  }
  writeJsonFile(localPatcherConfigPath, { ...local, featureRoots });
  return {
    message: `Converted and registered ${id} as ${targetId} in dedicated worktree ${worktree}.`,
    logs: workflow.logs,
    worktree,
    workflow: workflow.result,
    status: await featureDevelopmentStatus(),
  };
}

async function openFeatureWorktree(record) {
  const source = await sourceInfoForFeature(record, new Map());
  const worktree = path.resolve(source.worktree || record.rootPath);
  if (!isPathInside(worktree, record.rootPath) || !statSafe(worktree)?.isDirectory()) {
    throw new HttpError(400, `Feature worktree is not an approved directory for ${record.id}.`);
  }
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [worktree], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(new HttpError(500, `Could not open ${worktree}: ${error.message}`, { logs: [error.message] }));
    });
    child.once("spawn", () => {
      child.unref();
      resolve({
        message: `Opened the worktree for ${record.id}.`,
        logs: [`Opened ${worktree} with the platform folder handler.`, `Process ID: ${child.pid || "unknown"}.`],
        worktree,
      });
    });
  });
}

function validatedFeatureBuildPayload(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowed = new Set(["limit", "sourceMode", "outputRoot", "shortcutName", "shortcutDir", "keepWork", "features"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new HttpError(400, `Unsupported rebuild option: ${key}`);
  }
  if (payload.sourceMode && payload.sourceMode !== "current") {
    throw new HttpError(400, "Feature Development rebuilds only accept the current installed Codex source.");
  }
  for (const key of ["outputRoot", "shortcutDir"]) {
    const candidate = String(payload[key] || "").trim();
    if (candidate && (!path.isAbsolute(candidate) || candidate.includes("\0"))) {
      throw new HttpError(400, `${key} must be an absolute local path.`);
    }
  }
  return payload;
}

function assertFeatureActionKeys(payload, allowedKeys) {
  const allowed = new Set(["requestId", "action", ...allowedKeys]);
  const unsupported = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new HttpError(400, `Unsupported Feature Development field(s): ${unsupported.join(", ")}`);
  }
}

async function executeFeatureDevelopmentAction(payload, requestId) {
  if (activeFeatureActionId && activeFeatureActionId !== requestId) {
    throw new HttpError(409, `Feature Development command ${activeFeatureActionId} is still running.`);
  }
  activeFeatureActionId = requestId;
  try {
    const action = String(payload.action || "").trim();
    if (action === "set-enabled") {
      assertFeatureActionKeys(payload, ["id", "enabled"]);
      const id = validatedFeatureId(payload.id, "Feature ID");
      const selection = saveFeatureModuleSelection({ id, enabled: payload.enabled === true });
      if (!selection.ok) throw new HttpError(400, selection.error || "Feature catalog is invalid.");
      return {
        ok: true,
        requestId,
        action,
        message: `${id} ${payload.enabled === true ? "enabled" : "disabled"}. Rebuild to apply the selection.`,
        logs: [`Saved ${id}=${payload.enabled === true} in config/patcher.local.json.`],
        status: await featureDevelopmentStatus(),
      };
    }
    if (action === "create-local") {
      assertFeatureActionKeys(payload, ["id"]);
      const id = validatedFeatureId(payload.id, "Local feature ID", "local");
      return { ok: true, requestId, action, ...(await createLocalFeature(id)) };
    }
    if (action === "convert-contribution") {
      assertFeatureActionKeys(payload, ["id", "targetId"]);
      const id = validatedFeatureId(payload.id, "Local feature ID");
      const targetId = validatedFeatureId(payload.targetId, "Contribution feature ID", "contribution");
      return { ok: true, requestId, action, ...(await convertLocalFeature(id, targetId)) };
    }
    if (action === "open-worktree") {
      assertFeatureActionKeys(payload, ["id"]);
      const id = validatedFeatureId(payload.id, "Feature ID");
      const { catalog } = featureCatalogForAction();
      return { ok: true, requestId, action, ...(await openFeatureWorktree(featureRecordForAction(catalog, id))) };
    }
    if (action === "rebuild") {
      assertFeatureActionKeys(payload, ["build"]);
      const job = startPatchBuild(validatedFeatureBuildPayload(payload.build));
      return {
        ok: true,
        requestId,
        action,
        message: `Started verified rebuild ${job.id}.`,
        logs: [`Job: ${job.id}`, `Status: ${job.status}`, `Log: ${job.logPath}`],
        job,
      };
    }
    throw new HttpError(400, "Unknown Feature Development action.");
  } finally {
    if (activeFeatureActionId === requestId) activeFeatureActionId = null;
  }
}

async function runFeatureDevelopmentAction(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Feature Development command body must be an object.");
  }
  const requestId = validatedFeatureRequestId(payload.requestId);
  const completed = featureActionResults.get(requestId);
  if (completed) return { ...completed, replayed: true };
  const pending = featureActionInFlight.get(requestId);
  if (pending) return { ...(await pending), replayed: true };
  const operation = executeFeatureDevelopmentAction(payload, requestId);
  featureActionInFlight.set(requestId, operation);
  try {
    const result = await operation;
    featureActionResults.set(requestId, result);
    while (featureActionResults.size > 100) {
      featureActionResults.delete(featureActionResults.keys().next().value);
    }
    return result;
  } finally {
    featureActionInFlight.delete(requestId);
  }
}

function updatePolicyStatus() {
  const config = mergedPatcherConfig();
  return {
    policy: normalizeUpdatePolicy(config.updatePolicy, config.autoRebuildOnLaunch === false ? "off" : "notify"),
    configured: config.updatePolicyConfigured === true,
    recommended: "notify",
    choices: [
      { id: "off", label: "Off", description: "Do not check the installed Codex build on launch." },
      { id: "notify", label: "Notify", description: "Check on launch and ask before rebuilding." },
      { id: "auto", label: "Auto rebuild", description: "Check, validate, and rebuild automatically." },
    ],
  };
}

function saveUpdatePolicy(payload = {}) {
  const policy = normalizeUpdatePolicy(payload.policy, "");
  if (!policy) {
    throw new HttpError(400, "Update policy must be off, notify, or auto.");
  }
  const local = readJsonSafe(localPatcherConfigPath) || {};
  writeJsonFile(localPatcherConfigPath, {
    ...local,
    updatePolicy: policy,
    updatePolicyConfigured: true,
    autoRebuildOnLaunch: policy === "auto",
  });
  return updatePolicyStatus();
}

function powershellExecutable() {
  const systemPowerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return exists(systemPowerShell) ? systemPowerShell : "powershell.exe";
}

function checkCurrentCodexUpdate(refreshRemote = false) {
  const scriptPath = path.join(rootDir, "scripts", "ensure-current-codex-patch.ps1");
  const arguments_ = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-CheckOnly", "-Quiet"];
  if (refreshRemote) arguments_.push("-RefreshRemote");
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExecutable(),
      arguments_,
      { cwd: rootDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new HttpError(504, "Codex update check timed out.")));
    }, 120000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(() => reject(new HttpError(500, `Codex update check failed: ${error.message}`)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new HttpError(500, `Codex update check failed: ${(stderr || stdout || "unknown error").trim()}`));
          return;
        }
        const updateState = parseLastJsonObject(stdout);
        if (!updateState) {
          reject(new HttpError(500, "Codex update check did not return structured status."));
          return;
        }
        currentCodexUpdateSnapshot = updateState;
        resolve({ ...updateState, updatePolicy: updatePolicyStatus() });
      });
    });
  });
}

function startCurrentCodexUpdate() {
  const scriptPath = path.join(rootDir, "scripts", "ensure-current-codex-patch.ps1");
  return startPatchJob("update", {
    options: { updatePolicy: updatePolicyStatus().policy, force: true },
    command: [
      powershellExecutable(),
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Force",
      "-Quiet",
    ],
  });
}

function startPatchJob(type, preview) {
  const activeJob = listPatchJobs().find((job) => {
    if (job?.status !== "running" || !Number.isInteger(Number(job.pid))) return false;
    try {
      process.kill(Number(job.pid), 0);
      return true;
    } catch {
      return false;
    }
  });
  if (activeJob) {
    throw new HttpError(409, `Patch job ${activeJob.id} is already running.`);
  }
  const now = new Date().toISOString();
  const id = patchJobId(type);
  const logPath = path.join(patchLogsDir, `${id}.log`);
  const resultPath = path.join(patchResultsDir, `${id}.json`);
  fs.mkdirSync(patchLogsDir, { recursive: true });
  fs.mkdirSync(patchResultsDir, { recursive: true });

  const job = {
    id,
    type,
    status: "running",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    pid: null,
    exitCode: null,
    options: preview.options,
    command: preview.command,
    logPath,
    resultPath,
    error: null,
    result: null,
  };
  writePatchJob(job);
  fs.writeFileSync(logPath, `${type} job ${id}\n${preview.command.join(" ")}\n\n`, "utf8");

  const child = spawn(preview.command[0], preview.command.slice(1), {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = child.pid;
  writePatchJob(job);

  let stdout = "";
  const append = (prefix, chunk) => {
    const text = chunk.toString();
    if (prefix === "stdout") stdout += text;
    fs.appendFileSync(logPath, text, "utf8");
  };

  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.stack || error.message;
    job.completedAt = new Date().toISOString();
    writePatchJob(job);
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.completedAt = new Date().toISOString();
    if (code === 0) {
      const parsed = parseLastJsonObject(stdout);
      if (parsed) {
        job.result = parsed;
        writeJsonFile(resultPath, job.result);
        job.status = "completed";
      } else {
        job.status = "failed";
        job.error = `${type} job completed but did not return JSON.`;
      }
    } else {
      job.status = "failed";
      job.error = `${type} job exited with code ${code}.`;
    }
    writePatchJob(job);
  });

  return job;
}

function startPatchBuild(payload) {
  const preview = patchPreview(payload);
  const local = readJsonSafe(localPatcherConfigPath) || {};
  writeJsonFile(localPatcherConfigPath, {
    ...local,
    buildFeatures: { ...preview.options.features },
  });
  return startPatchJob("patch", preview);
}

function defaultBundleOptions() {
  return {
    configPath: launcherConfigPath,
    outputDirectory: path.join(rootDir, "codex-portable-packages"),
    bundleName: "",
    portableElectronProfile: false,
    keepWork: false,
  };
}

function normalizeBundleOptions(payload = {}) {
  const defaults = defaultBundleOptions();
  const options = {
    ...defaults,
    ...payload,
  };
  options.configPath = String(options.configPath || defaults.configPath).trim();
  options.outputDirectory = String(options.outputDirectory || defaults.outputDirectory).trim();
  options.bundleName = String(options.bundleName || "").trim();
  options.portableElectronProfile = options.portableElectronProfile === true;
  options.keepWork = options.keepWork === true;
  if (!exists(options.configPath)) {
    throw new HttpError(409, `Launcher config not found: ${options.configPath}. Build a patched clone first.`);
  }
  return options;
}

function bundleBuildArgs(options) {
  const scriptPath = path.join(rootDir, "scripts", "package-patched-codex-single-exe.ps1");
  const args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
  if (options.configPath) args.push("-ConfigPath", options.configPath);
  if (options.outputDirectory) args.push("-OutputDirectory", options.outputDirectory);
  if (options.bundleName) args.push("-BundleName", options.bundleName);
  if (options.portableElectronProfile) args.push("-PortableElectronProfile");
  if (options.keepWork) args.push("-KeepWork");
  return args;
}

function bundlePreview(payload) {
  const options = normalizeBundleOptions(payload);
  const args = bundleBuildArgs(options);
  return {
    options,
    command: args,
  };
}

function startBundleBuild(payload) {
  return startPatchJob("bundle", bundlePreview(payload));
}

function launchPatchedCodex() {
  const scriptPath = path.join(rootDir, "scripts", "launch-patched-codex.ps1");
  if (!exists(scriptPath)) {
    throw new HttpError(409, `Launcher script not found: ${scriptPath}`);
  }
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, scriptPath };
}

function serveStatic(requestPath, response) {
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  } catch {
    sendError(response, 400, "Malformed URL path.");
    return;
  }
  const filePath = path.resolve(publicDir, `.${decodedPath}`);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
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
    });
    response.end(content);
  });
}

async function handleApi(request, requestUrl, response) {
  if (request.method === "POST") {
    assertSafePostRequest(request);
  }
  let parts = [];
  try {
    parts = requestUrl.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new HttpError(400, "Malformed URL path.");
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/summary") {
    sendJson(response, summary());
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/projects") {
    sendJson(response, { projects: listProjects() });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/orchestrations") {
    sendJson(response, { runs: listOrchestrationRuns() });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/patch/feature-development") {
    const allowedOrigin = assertFeatureDevelopmentRequest(request);
    sendJson(response, await featureDevelopmentStatus(), 200, featureDevelopmentCorsHeaders(allowedOrigin));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/feature-development/action") {
    const allowedOrigin = assertFeatureDevelopmentRequest(request);
    sendJson(
      response,
      await runFeatureDevelopmentAction(await readRequestJson(request)),
      201,
      featureDevelopmentCorsHeaders(allowedOrigin)
    );
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/patch/status") {
    sendJson(response, patchStatus());
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/update-policy") {
    sendJson(response, saveUpdatePolicy(await readRequestJson(request)));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/feature-module") {
    sendJson(response, saveFeatureModuleSelection(await readRequestJson(request)));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/update/check") {
    const payload = await readRequestJson(request);
    sendJson(response, await checkCurrentCodexUpdate(payload?.refreshRemote === true));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/update/apply") {
    await readRequestJson(request);
    sendJson(response, startCurrentCodexUpdate(), 201);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/preview") {
    sendJson(response, patchPreview(await readRequestJson(request)));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/bundle/preview") {
    sendJson(response, bundlePreview(await readRequestJson(request)));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/build") {
    sendJson(response, startPatchBuild(await readRequestJson(request)), 201);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/bundle/build") {
    sendJson(response, startBundleBuild(await readRequestJson(request)), 201);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/patch/launch") {
    sendJson(response, launchPatchedCodex(), 201);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/patch/jobs") {
    sendJson(response, { jobs: listPatchJobs() });
    return;
  }
  if (request.method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "patch" && parts[2] === "jobs") {
    const job = readPatchJob(parts[3]);
    if (!job) {
      sendError(response, 404, "Patch job not found");
      return;
    }
    sendJson(response, { ...job, logTail: readLogTail(job.logPath) });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/orchestrations/preview") {
    sendJson(response, previewOrchestration(await readRequestJson(request)));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/orchestrations/start") {
    sendJson(response, startOrchestration(await readRequestJson(request)), 201);
    return;
  }
  if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "orchestrations") {
    const run = readOrchestrationRun(parts[2]);
    if (!run) {
      sendError(response, 404, "Orchestration run not found");
      return;
    }
    sendJson(response, run);
    return;
  }
  if (request.method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "projects" && parts[3] === "threads") {
    const includeApprovals = requestUrl.searchParams.get("includeApprovals") === "1";
    const includeSubagents = requestUrl.searchParams.get("includeSubagents") === "1";
    sendJson(response, { threads: listThreadsForProject(parts[2], includeApprovals, includeSubagents) });
    return;
  }
  if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "threads") {
    const detail = getThreadDetail(parts[2]);
    if (!detail) {
      sendError(response, 404, "Thread not found");
      return;
    }
    sendJson(response, detail);
    return;
  }
  sendError(response, 404, "Unknown API route");
}

const server = http.createServer((request, response) => {
  let requestUrl = null;
  try {
    requestUrl = new url.URL(request.url || "/", "http://localhost");
  } catch {
    sendError(response, 400, "Malformed request URL.");
    return;
  }
  if (request.method === "OPTIONS") {
    if (requestUrl.pathname.startsWith("/api/patch/feature-development")) {
      try {
        const allowedOrigin = assertFeatureDevelopmentRequest(request);
        response.writeHead(204, {
          ...featureDevelopmentCorsHeaders(allowedOrigin),
          "Cache-Control": "no-store",
        });
      } catch (error) {
        sendCaughtError(response, error);
        return;
      }
    } else {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      });
    }
    response.end();
    return;
  }
  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(request, requestUrl, response).catch((error) => {
      sendCaughtError(response, error);
    });
    return;
  }
  serveStatic(requestUrl.pathname, response);
});

const requestedPort = Number(process.env.PORT || process.argv[2] || 4590);
server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  console.log(`Codex project viewer listening at http://127.0.0.1:${address.port}`);
});
