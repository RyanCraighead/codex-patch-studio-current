#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function loadClassicLevel() {
  const prefix = process.env.CLASSIC_LEVEL_PREFIX;
  const candidates = [
    "classic-level",
    prefix && path.join(prefix, "node_modules", "classic-level"),
  ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate).ClassicLevel;
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(
    [
      "Could not load classic-level.",
      "Install it with: npm install --prefix %TEMP%\\codex-classic-level-reader classic-level@3.0.0",
      "Then run with CLASSIC_LEVEL_PREFIX set to that prefix.",
      "",
      errors.join("\n"),
    ].join("\n")
  );
}

function parseJson(value) {
  if (typeof value !== "string") {
    return { parsed: false, value };
  }

  try {
    return { parsed: true, value: JSON.parse(value) };
  } catch {
    return { parsed: false, value };
  }
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function maybeTimestamp(record) {
  return firstDefined(
    record.timestamp,
    record.created_at,
    record.createdAt,
    record.updated_at,
    record.updatedAt,
    record.last_updated_at,
    record.lastUpdatedAt
  );
}

function titleFromMetadata(metadata, conversationId) {
  if (!metadata || typeof metadata !== "object") {
    return conversationId;
  }

  return firstDefined(
    metadata.title,
    metadata.name,
    metadata.summary,
    metadata.conversation_title,
    metadata.conversationTitle,
    metadata.metadata && metadata.metadata.title,
    metadata.conversation && metadata.conversation.title,
    conversationId
  );
}

function normalizeExchange(exchange) {
  if (!exchange || typeof exchange !== "object") {
    return {
      timestamp: null,
      request: null,
      response: null,
      status: null,
      model: null,
    };
  }

  return {
    uuid: exchange.uuid,
    timestamp: maybeTimestamp(exchange),
    request: firstDefined(
      exchange.request_message,
      exchange.requestMessage,
      exchange.user_message,
      exchange.userMessage,
      exchange.prompt
    ),
    response: firstDefined(
      exchange.response_text,
      exchange.responseText,
      exchange.assistant_message,
      exchange.assistantMessage,
      exchange.answer
    ),
    status: exchange.status,
    model: firstDefined(exchange.model_id, exchange.modelId, exchange.model),
    nodeCount: Array.isArray(exchange.nodes) ? exchange.nodes.length : 0,
  };
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

async function main() {
  const [dbPathArg, outDirArg] = process.argv.slice(2);
  if (!dbPathArg) {
    console.error("Usage: node scripts/export-augment-chat-history.cjs <augment-kv-store-path> [out-dir]");
    process.exit(2);
  }

  const dbPath = path.resolve(dbPathArg);
  const outDir = path.resolve(
    outDirArg || path.join(process.cwd(), "augment-chat-exports", new Date().toISOString().replace(/[:.]/g, "-"))
  );

  if (!fs.existsSync(dbPath)) {
    throw new Error(`LevelDB path does not exist: ${dbPath}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "conversations"), { recursive: true });

  const ClassicLevel = loadClassicLevel();
  const db = new ClassicLevel(dbPath, {
    keyEncoding: "utf8",
    valueEncoding: "utf8",
  });

  const conversations = new Map();
  const counts = {
    total: 0,
    metadata: 0,
    exchange: 0,
    tooluse: 0,
    other: 0,
    jsonParseFailures: 0,
  };
  const otherSamples = [];

  function getConversation(conversationId) {
    if (!conversations.has(conversationId)) {
      conversations.set(conversationId, {
        conversationId,
        metadata: null,
        exchanges: [],
        toolUses: [],
      });
    }
    return conversations.get(conversationId);
  }

  await db.open();
  try {
    for await (const [key, rawValue] of db.iterator()) {
      counts.total += 1;
      const decoded = parseJson(rawValue);
      if (!decoded.parsed) {
        counts.jsonParseFailures += 1;
      }

      if (key.startsWith("metadata:")) {
        counts.metadata += 1;
        const conversationId = key.slice("metadata:".length);
        getConversation(conversationId).metadata = decoded.value;
        continue;
      }

      const exchangeMatch = key.match(/^exchange:([^:]+):(.+)$/);
      if (exchangeMatch) {
        counts.exchange += 1;
        const [, conversationId, exchangeId] = exchangeMatch;
        getConversation(conversationId).exchanges.push({
          key,
          exchangeId,
          parsed: decoded.parsed,
          value: decoded.value,
        });
        continue;
      }

      const toolUseMatch = key.match(/^tooluse:([^:]+):(.+)$/);
      if (toolUseMatch) {
        counts.tooluse += 1;
        const [, conversationId, toolUseId] = toolUseMatch;
        getConversation(conversationId).toolUses.push({
          key,
          toolUseId,
          parsed: decoded.parsed,
          value: decoded.value,
        });
        continue;
      }

      counts.other += 1;
      if (otherSamples.length < 20) {
        otherSamples.push({ key, parsed: decoded.parsed, valuePreview: String(rawValue).slice(0, 200) });
      }
    }
  } finally {
    await db.close();
  }

  const summary = {
    source: dbPath,
    exportedAt: new Date().toISOString(),
    counts,
    conversations: [],
    otherSamples,
  };

  for (const conversation of conversations.values()) {
    conversation.exchanges.sort((a, b) => {
      const aTime = maybeTimestamp(a.value) || "";
      const bTime = maybeTimestamp(b.value) || "";
      return String(aTime).localeCompare(String(bTime));
    });

    const title = titleFromMetadata(conversation.metadata, conversation.conversationId);
    const normalizedExchanges = conversation.exchanges.map((entry) => normalizeExchange(entry.value));
    const firstTimestamp = firstDefined(...normalizedExchanges.map((entry) => entry.timestamp));
    const lastTimestamp = [...normalizedExchanges].reverse().find((entry) => entry.timestamp)?.timestamp || null;

    summary.conversations.push({
      conversationId: conversation.conversationId,
      title,
      exchangeCount: conversation.exchanges.length,
      toolUseCount: conversation.toolUses.length,
      firstTimestamp,
      lastTimestamp,
      metadata: conversation.metadata,
    });

    const baseName = `${sanitizeFileName(title)} -- ${conversation.conversationId}`;
    const jsonPath = path.join(outDir, "conversations", `${baseName}.json`);
    const mdPath = path.join(outDir, "conversations", `${baseName}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(conversation, null, 2), "utf8");

    const markdown = [
      `# ${markdownEscape(title)}`,
      "",
      `Conversation ID: \`${conversation.conversationId}\``,
      `Exchange count: ${conversation.exchanges.length}`,
      `Tool use count: ${conversation.toolUses.length}`,
      "",
      ...normalizedExchanges.flatMap((exchange, index) => [
        `## Exchange ${index + 1}${exchange.timestamp ? ` - ${exchange.timestamp}` : ""}`,
        "",
        exchange.model ? `Model: \`${exchange.model}\`` : null,
        exchange.status ? `Status: \`${exchange.status}\`` : null,
        "",
        "### User",
        "",
        markdownEscape(exchange.request || "(no request_message field found)"),
        "",
        "### Assistant",
        "",
        markdownEscape(exchange.response || "(no response_text field found)"),
        "",
      ].filter((line) => line !== null)),
    ].join("\n");

    fs.writeFileSync(mdPath, markdown, "utf8");
  }

  summary.conversations.sort((a, b) => String(b.lastTimestamp || "").localeCompare(String(a.lastTimestamp || "")));
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify({
    outDir,
    counts,
    conversationCount: summary.conversations.length,
    newestConversations: summary.conversations.slice(0, 10).map((conversation) => ({
      title: conversation.title,
      conversationId: conversation.conversationId,
      exchangeCount: conversation.exchangeCount,
      lastTimestamp: conversation.lastTimestamp,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
