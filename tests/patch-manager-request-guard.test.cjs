const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function request(port, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/request-guard-probe",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2",
          ...headers,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "codex-viewer", "server.cjs"), "0"], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Patch manager test server did not start: ${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += String(chunk);
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      resolve({ child, port: Number(match[1]) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && !output.match(/127\.0\.0\.1:(\d+)/)) {
        clearTimeout(timeout);
        reject(new Error(`Patch manager test server exited ${code}: ${output}`));
      }
    });
  });
}

test("patch manager accepts the packaged Codex renderer and rejects web origins", async (context) => {
  const { child, port } = await startServer();
  context.after(() => child.kill());

  const codexRenderer = await request(port, {
    origin: "app://-",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(codexRenderer.status, 404);

  const loopbackRenderer = await request(port, {
    origin: `http://127.0.0.1:${port}`,
    "sec-fetch-site": "same-origin",
  });
  assert.equal(loopbackRenderer.status, 404);

  const hostileWebOrigin = await request(port, {
    origin: "https://example.invalid",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(hostileWebOrigin.status, 403);
  assert.match(hostileWebOrigin.body, /Cross-site POST requests are not allowed/);
});
