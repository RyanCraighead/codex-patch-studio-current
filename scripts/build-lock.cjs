const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function buildLockPath(identity) {
  const digest = crypto.createHash("sha256").update(String(identity).toLowerCase()).digest("hex").slice(0, 20);
  return path.join(os.tmpdir(), `codex-patch-studio-build-${digest}.lock`);
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function acquireBuildLockSync(identity, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 10 * 60 * 1000);
  const retryMs = Number(options.retryMs ?? 250);
  const malformedGraceMs = Number(options.malformedGraceMs ?? 30_000);
  const lockPath = options.lockPath || buildLockPath(identity);
  const token = crypto.randomUUID();
  const startedAt = Date.now();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(
          descriptor,
          `${JSON.stringify({ pid: process.pid, token, identity: String(identity), acquiredAt: new Date().toISOString() })}\n`,
          "utf8"
        );
      } finally {
        fs.closeSync(descriptor);
      }
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = readLock(lockPath);
    let stale = owner ? !processIsRunning(Number(owner.pid)) : false;
    if (!owner) {
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > malformedGraceMs;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        continue;
      }
    }
    if (stale) {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const ownerDescription = owner?.pid ? `pid ${owner.pid}` : "another process";
      throw new Error(`Timed out waiting for the Codex patch build lock held by ${ownerDescription}: ${lockPath}`);
    }
    sleepSync(retryMs);
  }
}

function releaseBuildLockSync(lock) {
  if (!lock?.lockPath || !lock?.token) return;
  const owner = readLock(lock.lockPath);
  if (!owner || owner.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function withBuildLockSync(identity, callback, options = {}) {
  const lock = acquireBuildLockSync(identity, options);
  try {
    return callback();
  } finally {
    releaseBuildLockSync(lock);
  }
}

module.exports = {
  acquireBuildLockSync,
  buildLockPath,
  releaseBuildLockSync,
  withBuildLockSync,
};
