#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const defaultTasksRoot = path.join(
  process.env.APPDATA || "",
  "Code",
  "User",
  "globalStorage",
  "saoudrizwan.claude-dev",
  "tasks"
);
const defaultOutRoot = path.join(rootDir, "cline-chat-exports");

function main() {
  const tasksRoot = process.argv[2] || defaultTasksRoot;
  const outRoot = process.argv[3] || defaultOutRoot;
  const exporter = path.join(rootDir, "scripts", "export-roo-code-history.cjs");
  const result = spawnSync(process.execPath, [exporter, tasksRoot, outRoot, "cline", "Cline", "cline"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 128,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status || 0;
}

main();
