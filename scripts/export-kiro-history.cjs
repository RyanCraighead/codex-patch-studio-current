#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const defaultKiroRoot = path.join(
  process.env.APPDATA || "",
  "Kiro",
  "User",
  "globalStorage",
  "kiro.kiroagent"
);
const defaultOutRoot = path.join(rootDir, "kiro-chat-exports");
const diffSnapshotDirName = "74a08cf8613c7dec4db7b264470db812";

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(value, fallback = "untitled") {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || fallback;
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 10);
}

function toIso(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return new Date(number > 100000000000 ? number : number * 1000).toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function stringify(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function contentToText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      return firstString(item?.text, item?.content);
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function walkFiles(dirPath, onFile, skipDir = () => false) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(filePath, entry)) {
        walkFiles(filePath, onFile, skipDir);
      }
    } else {
      onFile(filePath, entry);
    }
  }
}

function buildExecutionIndex(kiroRoot) {
  const index = new Map();
  const workspaceRootPattern = /^[0-9a-f]{32}$/i;
  const skipNames = new Set([
    "index",
    "workspace-sessions",
    "sessions",
    "default",
    "dev_data",
    ".diffs",
    ".migrations",
    ".utils",
    diffSnapshotDirName,
  ]);

  for (const entry of fs.readdirSync(kiroRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !workspaceRootPattern.test(entry.name) || skipNames.has(entry.name)) {
      continue;
    }
    const workspaceRoot = path.join(kiroRoot, entry.name);
    walkFiles(
      workspaceRoot,
      (filePath, fileEntry) => {
        if (fileEntry.name.endsWith(".chat") || fileEntry.name.endsWith(".tmp")) {
          return;
        }
        const stats = fs.statSync(filePath);
        if (stats.size < 100 || stats.size > 10 * 1024 * 1024) {
          return;
        }
        const preview = fs.readFileSync(filePath, "utf8").slice(0, 4096);
        if (!preview.includes('"executionId"')) {
          return;
        }
        const data = readJsonSafe(filePath);
        if (!data?.executionId || !Array.isArray(data.actions)) {
          return;
        }
        index.set(data.executionId, {
          filePath,
          workspaceRoot,
          data,
        });
      },
      (_dirPath, dirEntry) => skipNames.has(dirEntry.name)
    );
  }

  return index;
}

function diffLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
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
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
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
  if (!beforeMiddle.length || !afterMiddle.length || (beforeMiddle.length + 1) * (afterMiddle.length + 1) > 400000) {
    return fallbackDiffEdit(beforeLines, afterLines, prefix, suffix);
  }

  const width = afterMiddle.length + 1;
  const dp = Array.from({ length: beforeMiddle.length + 1 }, () => new Uint32Array(width));
  for (let i = beforeMiddle.length - 1; i >= 0; i -= 1) {
    for (let j = afterMiddle.length - 1; j >= 0; j -= 1) {
      dp[i][j] = beforeMiddle[i] === afterMiddle[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
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
    if (!removedLines.length && !addedLines.length) return;
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
      (beforeIndex === beforeMiddle.length || dp[beforeIndex][afterIndex + 1] >= dp[beforeIndex + 1][afterIndex])
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

function diffFromBeforeAfter(filePath, beforeText, afterText) {
  const beforeLines = diffLines(beforeText);
  const afterLines = diffLines(afterText);
  const edits = diffEditsFromLines(beforeLines, afterLines);
  return {
    path: filePath || "unknown",
    source: "kiro-diff-snapshot",
    changeKind: !beforeLines.length && afterLines.length ? "created" : beforeLines.length && !afterLines.length ? "deleted" : "edited",
    totalAddedLines: edits.reduce((sum, edit) => sum + (Number(edit.addedLineCount) || 0), 0),
    totalRemovedLines: edits.reduce((sum, edit) => sum + (Number(edit.removedLineCount) || 0), 0),
    edits,
  };
}

function filePathFromKiroDiffUri(uri) {
  const decoded = decodeURIComponent(String(uri || ""));
  const match = decoded.match(/^kiro-diff:\/(.+?)(?:\?|$)/);
  return match ? match[1].replace(/^\//, "") : "";
}

function commitIdFromKiroDiffUri(uri) {
  const decoded = decodeURIComponent(String(uri || ""));
  return decoded.match(/[?&]commitId=([^&]+)/)?.[1] || "";
}

function readKiroDiffContent(workspaceRoot, uri) {
  const commitId = commitIdFromKiroDiffUri(uri);
  const filePath = filePathFromKiroDiffUri(uri);
  if (!commitId || !filePath) {
    return "";
  }
  const diskPath = path.join(workspaceRoot, diffSnapshotDirName, commitId, ...filePath.split(/[\\/]/).filter(Boolean));
  try {
    return fs.readFileSync(diskPath, "utf8");
  } catch {
    return "";
  }
}

function diffsFromAction(action, workspaceRoot) {
  const input = action.input || {};
  if (!["write", "replace", "append"].includes(action.actionType)) {
    return [];
  }
  const filePath = firstString(input.file, filePathFromKiroDiffUri(input.modified), filePathFromKiroDiffUri(input.original));
  const beforeText = firstString(input.originalContent, readKiroDiffContent(workspaceRoot, input.original));
  const afterText = firstString(input.modifiedContent, readKiroDiffContent(workspaceRoot, input.modified));
  if (!beforeText && !afterText) {
    return [];
  }
  return [diffFromBeforeAfter(filePath, beforeText, afterText)];
}

function summarizeActionInput(action) {
  const input = action.input || {};
  const parts = [];
  if (input.serverName) parts.push(String(input.serverName));
  if (input.toolName) parts.push(String(input.toolName));
  if (input.file) parts.push(String(input.file));
  if (input.path) parts.push(String(input.path));
  if (input.command) parts.push(String(input.command));
  if (input.query) parts.push(String(input.query));
  if (input.why) parts.push(String(input.why));
  if (Array.isArray(input.files)) parts.push(`${input.files.length} files`);
  if (Array.isArray(input.paths)) parts.push(`${input.paths.length} paths`);
  return parts.join(" · ") || action.actionType || action.type || "action";
}

function actionOutputText(action) {
  const output = action.output;
  return firstString(
    output?.response,
    output?.message,
    output?.stdout,
    output?.stderr,
    output?.text,
    stringify(output),
    stringify(action.result)
  );
}

function normalizeAction(action, executionRecord) {
  const actionType = action.actionType || action.type || "action";
  if (actionType === "say") {
    const message = firstString(action.output?.message, action.output?.text);
    return message ? { type: "assistant_text", text: message } : null;
  }
  if (actionType === "model" || actionType === "intentClassification") {
    return null;
  }

  const toolName =
    actionType === "mcp" && action.input?.serverName && action.input?.toolName
      ? `${action.input.serverName}.${action.input.toolName}`
      : actionType;
  const diffs = diffsFromAction(action, executionRecord.workspaceRoot);

  return {
    type: "tool",
    tool: {
      requestId: action.executionId || executionRecord.data.executionId || "",
      toolUseId: action.actionId || `${toolName}-${executionRecord.data.startTime || ""}`,
      toolName,
      input: action.input || null,
      inputJson: action.input ? JSON.stringify(action.input) : "",
      inputSummary: summarizeActionInput(action),
      phase: action.actionState || "",
      isError: /fail|error|reject/i.test(String(action.actionState || "")),
      text: actionOutputText(action),
      metrics: {},
      diffs,
    },
  };
}

function normalizeExecutionEvents(executionRecord) {
  if (!executionRecord?.data) {
    return [];
  }
  const events = [];
  for (const action of executionRecord.data.actions || []) {
    const event = normalizeAction(action, executionRecord);
    if (event) events.push(event);
  }
  return events;
}

function lastAssistantText(events) {
  const event = [...events].reverse().find((item) => item.type === "assistant_text" && item.text && item.text.trim());
  return event ? event.text : "";
}

function normalizeSession(session, sessionSummary, executionIndex) {
  const history = Array.isArray(session.history) ? session.history : [];
  const createdAt = toIso(sessionSummary?.dateCreated || session.dateCreated) || new Date(0).toISOString();
  const exchanges = [];
  let current = null;

  const startExchange = (request, timestamp) => {
    current = {
      exchangeId: `${session.sessionId || sessionSummary?.sessionId || "kiro"}-${exchanges.length + 1}`,
      timestamp: timestamp || createdAt,
      status: "",
      model: "",
      request: request || "",
      response: "",
      events: [],
      tools: [],
      raw: {},
    };
    exchanges.push(current);
  };

  for (const [index, item] of history.entries()) {
    const role = item.message?.role;
    const text = contentToText(item.message?.content);
    if (role === "user") {
      startExchange(text, toIso(Number(sessionSummary?.dateCreated || 0) + index));
      continue;
    }
    if (!current) {
      startExchange("", toIso(Number(sessionSummary?.dateCreated || 0) + index));
    }

    const executionRecord = item.executionId ? executionIndex.get(item.executionId) : null;
    if (executionRecord?.data?.startTime) {
      current.timestamp = toIso(executionRecord.data.startTime) || current.timestamp;
      current.status = executionRecord.data.status || current.status;
      current.model = firstString(executionRecord.data.modelId, executionRecord.data.metadata?.modelId, current.model);
    }
    if (text) {
      current.events.push({ type: "assistant_text", text });
    }
    for (const event of normalizeExecutionEvents(executionRecord)) {
      current.events.push(event);
      if (event.type === "tool") current.tools.push(event.tool);
    }
    current.response = lastAssistantText(current.events);
  }

  return exchanges.filter((exchange) => exchange.request.trim() || exchange.events.length || exchange.response.trim());
}

function exportSession(outDir, session, sessionSummary, executionIndex) {
  const sessionId = session.sessionId || sessionSummary?.sessionId;
  const title = firstString(session.title, sessionSummary?.title, sessionId).slice(0, 180);
  const exchanges = normalizeSession(session, sessionSummary, executionIndex);
  const toolUseCount = exchanges.reduce((sum, exchange) => sum + (exchange.tools || []).length, 0);
  const editDiffCount = exchanges.reduce(
    (sum, exchange) => sum + (exchange.tools || []).reduce((toolSum, tool) => toolSum + ((tool.diffs || []).length), 0),
    0
  );
  const firstTimestamp = exchanges[0]?.timestamp || toIso(sessionSummary?.dateCreated);
  const lastTimestamp = [...exchanges].reverse().find((exchange) => exchange.timestamp)?.timestamp || firstTimestamp;

  const conversation = {
    normalizedConversationVersion: 1,
    sourceType: "kiro",
    sourceName: "Kiro IDE",
    conversationId: sessionId,
    title,
    workspacePath: session.workspaceDirectory || sessionSummary?.workspaceDirectory || "",
    metadata: {
      sessionSummary,
      sessionType: session.sessionType || "",
    },
    exchanges,
    toolUseCount,
    editDiffCount,
  };

  const baseName = `${sanitizeFileName(title)} -- ${sessionId}`;
  fs.writeFileSync(path.join(outDir, "conversations", `${baseName}.json`), `${JSON.stringify(conversation, null, 2)}\n`, "utf8");

  return {
    conversationId: sessionId,
    id: sessionId,
    title,
    exchangeCount: exchanges.length,
    toolUseCount,
    firstTimestamp,
    lastTimestamp,
    workspacePath: conversation.workspacePath,
    isPinned: null,
    isForked: false,
    hidden: Boolean(sessionSummary?.hidden),
  };
}

function main() {
  const kiroRoot = path.resolve(process.argv[2] || defaultKiroRoot);
  const outRoot = path.resolve(process.argv[3] || defaultOutRoot);
  const workspaceSessionsRoot = path.join(kiroRoot, "workspace-sessions");
  if (!fs.existsSync(workspaceSessionsRoot)) {
    throw new Error(`Kiro workspace sessions root does not exist: ${workspaceSessionsRoot}`);
  }

  ensureDir(outRoot);
  const executionIndex = buildExecutionIndex(kiroRoot);
  const exports = [];

  for (const dirEntry of fs.readdirSync(workspaceSessionsRoot, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(workspaceSessionsRoot, dirEntry.name);
    const sessions = readJsonSafe(path.join(sourceDir, "sessions.json"));
    if (!Array.isArray(sessions) || !sessions.length) {
      continue;
    }
    const workspace = firstString(sessions[0]?.workspaceDirectory);
    const workspaceName = path.basename(workspace) || dirEntry.name;
    const exportId = `kiro-${sanitizeFileName(workspaceName, "workspace").toLowerCase()}-${shortHash(workspace || dirEntry.name)}`;
    const outDir = path.join(outRoot, exportId);
    ensureDir(path.join(outDir, "conversations"));

    const metadata = {
      sourceType: "kiro",
      sourceName: "Kiro IDE",
      storageId: exportId,
      sourceRoot: kiroRoot,
      sourceDir,
      exportedAt: new Date().toISOString(),
      workspace: {
        name: workspaceName,
        path: workspace,
        targetPath: workspace,
        raw: { encodedWorkspace: dirEntry.name },
      },
    };
    fs.writeFileSync(path.join(outDir, "workspace-export-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const conversations = [];
    for (const sessionSummary of sessions) {
      const sessionId = sessionSummary.sessionId;
      const sessionPath = path.join(sourceDir, `${sessionId}.json`);
      const session = readJsonSafe(sessionPath);
      if (!session) {
        continue;
      }
      conversations.push(exportSession(outDir, session, sessionSummary, executionIndex));
    }
    conversations.sort((a, b) => String(b.lastTimestamp || "").localeCompare(String(a.lastTimestamp || "")));
    const summary = {
      ...metadata,
      source: sourceDir,
      counts: {
        sessions: sessions.length,
        conversations: conversations.length,
        indexedExecutions: executionIndex.size,
      },
      conversations,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    exports.push({ exportId, workspace, conversationCount: conversations.length, outDir });
  }

  console.log(JSON.stringify({ outRoot, executionLogCount: executionIndex.size, exportCount: exports.length, exports }, null, 2));
}

main();
