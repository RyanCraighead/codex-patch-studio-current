const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(filePath, value) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tempPath, jsonText(value), { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempPath, absolutePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function promoteVerifiedJson(filePath, value, verify) {
  if (typeof verify !== "function") throw new TypeError("A verification callback is required before promotion.");
  const evidence = verify();
  if (!evidence) throw new Error("Candidate verification did not produce promotion evidence.");
  writeJsonAtomic(filePath, value);
  return evidence;
}

module.exports = { promoteVerifiedJson, writeJsonAtomic };
