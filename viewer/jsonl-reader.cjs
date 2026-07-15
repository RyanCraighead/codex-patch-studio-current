"use strict";

const fs = require("fs");

function* readJsonlLinesSync(filePath, options = {}) {
  const maxLineBytes = Number(options.maxLineBytes || 16 * 1024 * 1024);
  const chunkBytes = Number(options.chunkBytes || 1024 * 1024);
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error("maxLineBytes must be positive.");
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("chunkBytes must be positive.");

  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let chunks = [];
  let storedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  const append = (segment) => {
    totalBytes += segment.length;
    if (truncated || segment.length === 0) return;
    const remaining = maxLineBytes - storedBytes;
    if (segment.length <= remaining) {
      chunks.push(Buffer.from(segment));
      storedBytes += segment.length;
      return;
    }
    if (remaining > 0) {
      chunks.push(Buffer.from(segment.subarray(0, remaining)));
      storedBytes += remaining;
    }
    truncated = true;
  };

  const finish = () => {
    const line = {
      text: truncated ? "" : Buffer.concat(chunks, storedBytes).toString("utf8").replace(/\r$/, ""),
      truncated,
      byteLength: totalBytes,
    };
    chunks = [];
    storedBytes = 0;
    totalBytes = 0;
    truncated = false;
    return line;
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead);
      let offset = 0;
      while (offset < data.length) {
        const newline = data.indexOf(0x0a, offset);
        if (newline < 0) {
          append(data.subarray(offset));
          break;
        }
        append(data.subarray(offset, newline));
        yield finish();
        offset = newline + 1;
      }
    }
    if (totalBytes > 0 || storedBytes > 0 || truncated) yield finish();
  } finally {
    fs.closeSync(handle);
  }
}

module.exports = { readJsonlLinesSync };
