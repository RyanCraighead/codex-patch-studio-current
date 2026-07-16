const { spawnSync } = require("node:child_process");
const path = require("node:path");

function samePath(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function extractUserDataPath(commandLine) {
  const match = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(String(commandLine || ""));
  return match ? match[1] || match[2] || match[3] || null : null;
}

function hostsForAddress(localAddress) {
  const address = String(localAddress || "").trim();
  if (!address || address === "0.0.0.0") return ["127.0.0.1"];
  if (address === "::" || address === "::1") return ["[::1]"];
  if (address.includes(":")) return [`[${address}]`];
  return [address];
}

function inspectListeningProcesses(port) {
  const script = [
    `$connections = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue)`,
    "$owners = @($connections | ForEach-Object {",
    "  $owner = Get-CimInstance Win32_Process -Filter (\"ProcessId = {0}\" -f $_.OwningProcess) -ErrorAction SilentlyContinue",
    "  if ($owner) {",
    "    [PSCustomObject]@{ localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; pid = [int]$_.OwningProcess; executablePath = [string]$owner.ExecutablePath; commandLine = [string]$owner.CommandLine }",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $owners -Compress -Depth 3",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(`Could not inspect processes listening on TCP port ${port}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown PowerShell failure").trim();
    throw new Error(`Could not inspect processes listening on TCP port ${port}: ${detail}`);
  }

  let owners;
  try {
    owners = JSON.parse(String(result.stdout || "[]").trim() || "[]");
  } catch (error) {
    throw new Error(`Could not parse TCP port ${port} owners: ${error.message}`);
  }
  return (Array.isArray(owners) ? owners : [owners]).filter(
    (owner) => Number.isInteger(owner?.pid) && owner.executablePath,
  );
}

function resolveListeningProcess(port, options = {}) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error(`Invalid TCP listener port: ${port}`);
  }
  if (process.platform !== "win32" && !Array.isArray(options.listeners)) {
    throw new Error("Desktop process ownership verification is only supported on Windows.");
  }

  const owners = Array.isArray(options.listeners)
    ? options.listeners
    : inspectListeningProcesses(normalizedPort);
  if (!owners.length) {
    throw new Error(`No process is listening on TCP port ${normalizedPort}.`);
  }

  const expectedExecutablePath = options.expectedExecutablePath || null;
  const expectedUserDataPath = options.expectedUserDataPath || null;
  const matches = owners.filter((owner) => {
    if (expectedExecutablePath && !samePath(owner.executablePath, expectedExecutablePath)) return false;
    if (expectedUserDataPath && !samePath(extractUserDataPath(owner.commandLine), expectedUserDataPath)) return false;
    return true;
  });
  if (!matches.length) {
    const expectation = [
      expectedExecutablePath ? `executable ${expectedExecutablePath}` : null,
      expectedUserDataPath ? `profile ${expectedUserDataPath}` : null,
    ].filter(Boolean).join(" and ");
    const observed = owners.map((owner) => ({
      localAddress: owner.localAddress,
      pid: owner.pid,
      executablePath: owner.executablePath,
      userDataPath: extractUserDataPath(owner.commandLine),
    }));
    throw new Error(
      `DevTools port ${normalizedPort} is not owned by the configured desktop clone${expectation ? ` (${expectation})` : ""}. Observed listeners: ${JSON.stringify(observed)}`,
    );
  }

  const rank = (owner) => ["127.0.0.1", "::1"].includes(String(owner.localAddress)) ? 0 : 1;
  matches.sort((left, right) => rank(left) - rank(right) || Number(left.pid) - Number(right.pid));
  const owner = matches[0];
  const hosts = [...new Set(matches.flatMap((candidate) => hostsForAddress(candidate.localAddress)))];
  return {
    port: normalizedPort,
    pid: Number(owner.pid),
    executablePath: owner.executablePath,
    commandLine: owner.commandLine,
    userDataPath: extractUserDataPath(owner.commandLine),
    localAddress: owner.localAddress,
    hosts,
  };
}

module.exports = {
  extractUserDataPath,
  hostsForAddress,
  inspectListeningProcesses,
  resolveListeningProcess,
  samePath,
};
