"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readJsonlLinesSync } = require("../viewer/jsonl-reader.cjs");

test("streams JSONL and bounds oversized individual records", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jsonl-reader-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rollout.jsonl");
  fs.writeFileSync(filePath, `${"x".repeat(4096)}\n{"ok":true}\n`, "utf8");

  const lines = [...readJsonlLinesSync(filePath, { maxLineBytes: 1024, chunkBytes: 257 })];
  assert.equal(lines.length, 2);
  assert.equal(lines[0].truncated, true);
  assert.equal(lines[0].byteLength, 4096);
  assert.equal(lines[0].text, "");
  assert.deepEqual(JSON.parse(lines[1].text), { ok: true });
});
