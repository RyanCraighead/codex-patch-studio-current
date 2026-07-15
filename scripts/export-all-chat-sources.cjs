#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

function run(label, script, args = []) {
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", script), ...args], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
  });
  return {
    label,
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function main() {
  const [augmentWorkspaceStorageRoot] = process.argv.slice(2);
  const jobs = [
    run("Augment", "export-all-augment-chats.cjs", augmentWorkspaceStorageRoot ? [augmentWorkspaceStorageRoot] : []),
    run("Roo Code", "export-roo-code-history.cjs"),
    run("Cline", "export-cline-history.cjs"),
    run("Kiro IDE", "export-kiro-history.cjs"),
  ];

  for (const job of jobs) {
    console.log(`\n=== ${job.label} ===`);
    if (job.stdout.trim()) console.log(job.stdout.trim());
    if (job.stderr.trim()) console.error(job.stderr.trim());
    if (!job.ok) {
      console.error(`${job.label} export failed with status ${job.status}: ${job.error || "process error"}`);
    }
  }

  const failures = jobs.filter((job) => !job.ok);
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        completed: jobs.filter((job) => job.ok).map((job) => job.label),
        failed: failures.map((job) => ({ label: job.label, status: job.status, error: job.error })),
      },
      null,
      2
    )
  );

  if (failures.length === jobs.length) {
    process.exit(1);
  }
}

main();
