const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractUserDataPath,
  hostsForAddress,
  resolveListeningProcess,
} = require("../scripts/resolve-listening-process.cjs");

test("extractUserDataPath handles quoted and unquoted Electron arguments", () => {
  assert.equal(
    extractUserDataPath('ChatGPT.exe --user-data-dir="C:\\Profiles\\Patched Codex" --remote-debugging-port=9231'),
    "C:\\Profiles\\Patched Codex",
  );
  assert.equal(extractUserDataPath("ChatGPT.exe --user-data-dir=C:\\Profiles\\Codex"), "C:\\Profiles\\Codex");
  assert.equal(extractUserDataPath("ChatGPT.exe --remote-debugging-port=9231"), null);
});

test("hostsForAddress preserves the listener address family", () => {
  assert.deepEqual(hostsForAddress("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(hostsForAddress("0.0.0.0"), ["127.0.0.1"]);
  assert.deepEqual(hostsForAddress("::1"), ["[::1]"]);
  assert.deepEqual(hostsForAddress("::"), ["[::1]"]);
});

test("resolveListeningProcess skips a wrong IPv4 clone and selects the exact IPv6 clone and profile", () => {
  const expectedExecutablePath = "C:\\Builds\\Expected\\app\\ChatGPT.exe";
  const expectedUserDataPath = "C:\\Profiles\\Expected";
  const owner = resolveListeningProcess(9231, {
    expectedExecutablePath,
    expectedUserDataPath,
    listeners: [
      {
        localAddress: "127.0.0.1",
        localPort: 9231,
        pid: 100,
        executablePath: "C:\\Builds\\Wrong\\app\\ChatGPT.exe",
        commandLine: 'ChatGPT.exe --user-data-dir="C:\\Profiles\\Wrong"',
      },
      {
        localAddress: "::1",
        localPort: 9231,
        pid: 200,
        executablePath: expectedExecutablePath,
        commandLine: `ChatGPT.exe --user-data-dir="${expectedUserDataPath}"`,
      },
    ],
  });

  assert.equal(owner.pid, 200);
  assert.equal(owner.executablePath, expectedExecutablePath);
  assert.equal(owner.userDataPath, expectedUserDataPath);
  assert.equal(owner.localAddress, "::1");
  assert.deepEqual(owner.hosts, ["[::1]"]);
});

test("resolveListeningProcess fails when the executable matches but the profile does not", () => {
  assert.throws(
    () => resolveListeningProcess(9231, {
      expectedExecutablePath: "C:\\Builds\\Expected\\app\\ChatGPT.exe",
      expectedUserDataPath: "C:\\Profiles\\Expected",
      listeners: [{
        localAddress: "127.0.0.1",
        localPort: 9231,
        pid: 300,
        executablePath: "C:\\Builds\\Expected\\app\\ChatGPT.exe",
        commandLine: 'ChatGPT.exe --user-data-dir="C:\\Profiles\\Other"',
      }],
    }),
    /is not owned by the configured desktop clone/,
  );
});
