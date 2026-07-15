#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const port = Number(process.argv[2] || process.env.CODEX_PATCHED_REMOTE_DEBUGGING_PORT || 9229);
const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".tmp", "renderer-diagnostics");
fs.mkdirSync(outputDir, { recursive: true });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getPageTarget() {
  let targets = null;
  let lastError = null;
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`);
      if (!response.ok) throw new Error(`CDP endpoint returned ${response.status}.`);
      targets = await response.json();
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!targets) throw lastError || new Error("CDP endpoint is unavailable.");
  const target = targets.find((entry) => entry.type === "page" && entry.url === "app://-/index.html") || targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error("No Codex page target exposed by CDP.");
  return target;
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

function simplifyEvent(event) {
  if (event.method === "Runtime.exceptionThrown") {
    const details = event.params?.exceptionDetails || {};
    return {
      method: event.method,
      text: details.text,
      exception: details.exception?.description || details.exception?.value,
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      stackTrace: details.stackTrace,
    };
  }
  if (event.method === "Runtime.consoleAPICalled") {
    return {
      method: event.method,
      type: event.params?.type,
      args: (event.params?.args || []).map((entry) => entry.value ?? entry.description),
      stackTrace: event.params?.stackTrace,
    };
  }
  if (event.method === "Log.entryAdded") {
    return { method: event.method, ...event.params?.entry };
  }
  return null;
}

async function main() {
  const target = await getPageTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await Promise.all([
    client.send("Runtime.enable"),
    client.send("Log.enable"),
    client.send("Page.enable"),
  ]);
  await client.send("Page.reload", { ignoreCache: true });
  await delay(10_000);

  const state = await client.send("Runtime.evaluate", {
    expression: `({ href: location.href, title: document.title, text: document.body?.innerText || '' })`,
    returnByValue: true,
  });
  const events = client.events.map(simplifyEvent).filter(Boolean);
  const report = {
    capturedAt: new Date().toISOString(),
    target: { title: target.title, url: target.url },
    state: state.result?.value,
    events,
  };
  const reportPath = path.join(outputDir, `renderer-${Date.now()}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  client.close();
  process.stdout.write(`${JSON.stringify({ reportPath, state: report.state, events }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
