const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  checkpointWorkflow,
  convertWorkflow,
  pullRequestWorkflow,
  pushWorkflow,
  statusWorkflow,
} = require("../scripts/feature-development-workflow.cjs");

const workflowScript = path.resolve(__dirname, "..", "scripts", "feature-development-workflow.cjs");
const INITIAL_IDENTITY = {
  version: "26.715.1000.0",
  sourceAsarSha256: "a".repeat(64),
  sourceCliSha256: "b".repeat(64),
};
const UPDATED_IDENTITY = {
  version: "26.715.1001.0",
  sourceAsarSha256: "c".repeat(64),
  sourceCliSha256: "d".repeat(64),
};

function identityArgs(identity = INITIAL_IDENTITY) {
  return [
    "--codex-version", identity.version,
    "--source-asar-sha256", identity.sourceAsarSha256,
    "--source-cli-sha256", identity.sourceCliSha256,
  ];
}

function writeEvidence(worktree, featureRoot, fileName, kind, feature, identity = INITIAL_IDENTITY) {
  const evidence = {
    schemaVersion: 1,
    kind,
    feature,
    codexVersion: identity.version,
    sourceAsarSha256: identity.sourceAsarSha256,
    sourceCliSha256: identity.sourceCliSha256,
    result: { ok: true, summary: `${kind} passed` },
    checks: [{ id: "synthetic-check", ok: true }],
  };
  if (kind === "packed-verification") {
    evidence.patchManifest = {
      feature,
      codexVersion: identity.version,
      sourceAsarSha256: identity.sourceAsarSha256,
    };
  }
  const directory = path.join(worktree, featureRoot, "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const fullPath = path.join(directory, fileName);
  fs.writeFileSync(fullPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return `evidence/${fileName}`;
}

function completeContributionWorkflow(worktree, feature, featureRoot) {
  if (statusWorkflow({ worktree }).milestones.firstSuccessfulPatch.state === "pending") {
    const adapterPath = path.join(worktree, featureRoot, "adapters", `${INITIAL_IDENTITY.version}.cjs`);
    fs.appendFileSync(adapterPath, "\n// Synthetic first-patch marker.\n", "utf8");
    checkpointWorkflow({ worktree, milestone: "first-successful-patch", adapters: ["renderer@26.715"] });
  }
  const packedEvidence = writeEvidence(worktree, featureRoot, "packed.json", "packed-verification", feature);
  checkpointWorkflow({ worktree, milestone: "packed-verification", evidence: packedEvidence, adapters: ["packed@26.715"] });
  const runtimeEvidence = writeEvidence(worktree, featureRoot, "runtime.json", "runtime-ui-validation", feature);
  checkpointWorkflow({ worktree, milestone: "runtime-ui-validation", evidence: runtimeEvidence, adapters: ["ui@26.715"] });
  return checkpointWorkflow({ worktree, milestone: "docs" });
}

function run(command, args, cwd, allowedStatuses = [0]) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_EDITOR: "true",
    },
  });
  if (result.error) throw result.error;
  assert.ok(
    allowedStatuses.includes(result.status),
    `${command} ${args.join(" ")} exited ${result.status}:\n${result.stderr || result.stdout}`
  );
  return result;
}

function git(cwd, ...args) {
  return run("git", args, cwd).stdout.trim();
}

function tempRepository(t, { remote = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-workflow-"));
  const root = path.join(parent, "repo");
  fs.mkdirSync(root);
  run("git", ["init", "-b", "main"], root);
  git(root, "config", "user.name", "Workflow Test");
  git(root, "config", "user.email", "workflow@example.test");
  fs.writeFileSync(path.join(root, "README.md"), "# Temporary feature repository\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), "features/local/\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "--no-gpg-sign", "-m", "baseline");

  let remotePath = null;
  if (remote) {
    remotePath = path.join(parent, "remote.git");
    run("git", ["init", "--bare", remotePath], parent);
    git(root, "remote", "add", "origin", remotePath);
  }

  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root, remotePath };
}

function runCli(args, cwd) {
  const result = run(process.execPath, [workflowScript, ...args], cwd);
  return JSON.parse(result.stdout);
}

function remoteBranchExists(remotePath, branch) {
  return run("git", ["--git-dir", remotePath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], path.dirname(remotePath), [0, 1]).status === 0;
}

test("start creates and checkpoints a local feature without touching main or its remote", (t) => {
  const repository = tempRepository(t, { remote: true });
  const worktree = path.join(repository.parent, "local-worktree");
  const mainHead = git(repository.root, "rev-parse", "HEAD");

  const result = runCli([
    "start",
    "--mode",
    "local",
    "--feature",
    "local.focus-mode",
    ...identityArgs(),
    "--adapter",
    "renderer@26.715",
    "--repo",
    repository.root,
    "--worktree",
    worktree,
  ], repository.root);

  assert.equal(result.branch, "local/focus-mode");
  assert.equal(result.mode, "local");
  assert.equal(result.nextMilestone, "first-successful-patch");
  assert.equal(result.commitsSinceBaseline, 1);
  assert.equal(result.milestones.scaffold.state, "complete");
  assert.match(result.milestones.scaffold.checkpointCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(git(repository.root, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(repository.root, "status", "--porcelain=v1"), "");
  assert.equal(git(worktree, "branch", "--show-current"), "local/focus-mode");
  assert.match(git(worktree, "ls-files", "features/local/local-focus-mode/feature.json"), /feature\.json/);
  assert.equal(remoteBranchExists(repository.remotePath, "local/focus-mode"), false);

  const metadata = JSON.parse(fs.readFileSync(path.join(worktree, result.metadataPath), "utf8"));
  assert.deepEqual(metadata.baseline, { ref: "main", commit: mainHead });
  assert.equal(metadata.baselineCommit, mainHead);
  assert.deepEqual(metadata.testedAdapters, ["renderer@26.715"]);
  assert.equal(metadata.featureRoot, "features/local/local-focus-mode");
  assert.equal(metadata.branch, "local/focus-mode");
  assert.deepEqual(metadata.codexIdentity, {
    version: "26.715.1000.0",
    sourceAsarSha256: "a".repeat(64),
    sourceCliSha256: "b".repeat(64),
  });
  assert.match(git(worktree, "log", "-1", "--format=%B"), /Codex-Feature-Milestone: scaffold/);

  const absentOnMain = run("git", ["show", "main:features/local/local-focus-mode/feature.json"], repository.root, [0, 128]);
  assert.equal(absentOnMain.status, 128);
});

test("ordered checkpoints persist status, adapters, and source-only failures", (t) => {
  const repository = tempRepository(t);
  const worktree = path.join(repository.parent, "contribution-worktree");
  runCli([
    "start",
    "--mode",
    "contribution",
    "--feature",
    "example.command-palette",
    ...identityArgs(),
    "--repo",
    repository.root,
    "--worktree",
    worktree,
  ], repository.root);

  assert.throws(
    () => checkpointWorkflow({ worktree, milestone: "packed-verification" }),
    /Complete first-successful-patch/
  );
  assert.throws(
    () => checkpointWorkflow({ worktree, milestone: "first-successful-patch" }),
    /requires source or test changes/
  );

  const modulePath = path.join(
    worktree,
    "features",
    "community",
    "example-command-palette",
    "adapters",
    "26.715.1000.0.cjs"
  );
  fs.appendFileSync(modulePath, "\n// Synthetic first-patch marker.\n", "utf8");
  let status = checkpointWorkflow({
    worktree,
    milestone: "first-successful-patch",
    adapters: ["renderer@26.715", "settings@26.715"],
    note: "Synthetic patch test passed.",
  });
  assert.equal(status.milestones.firstSuccessfulPatch.state, "complete");

  const forbiddenPath = path.join(worktree, "leak.asar");
  fs.writeFileSync(forbiddenPath, "not an application bundle", "utf8");
  const invalidPackedEvidence = writeEvidence(
    worktree,
    "features/community/example-command-palette",
    "packed-invalid.json",
    "packed-verification",
    "example.command-palette"
  );
  assert.throws(
    () => checkpointWorkflow({ worktree, milestone: "packed-verification", evidence: invalidPackedEvidence }),
    /Source-only validation failed/
  );
  fs.rmSync(forbiddenPath);
  assert.equal(statusWorkflow({ worktree }).milestones.packedVerification.state, "pending");

  const nextAdapterPath = path.join(worktree, "features", "community", "example-command-palette", "adapters", "26.715.1001.0.cjs");
  fs.writeFileSync(
    nextAdapterPath,
    fs.readFileSync(modulePath, "utf8").replaceAll("26.715.1000.0", "26.715.1001.0"),
    "utf8"
  );
  const manifestPath = path.join(worktree, "features", "community", "example-command-palette", "feature.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.supports.codexVersions.push("26.715.1001.0");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const packedEvidence = writeEvidence(
    worktree,
    "features/community/example-command-palette",
    "packed.json",
    "packed-verification",
    "example.command-palette",
    UPDATED_IDENTITY
  );
  status = checkpointWorkflow({
    worktree,
    milestone: "packed-verification",
    codexVersion: UPDATED_IDENTITY.version,
    sourceAsarSha256: UPDATED_IDENTITY.sourceAsarSha256,
    sourceCliSha256: UPDATED_IDENTITY.sourceCliSha256,
    evidence: packedEvidence,
    adapters: ["packed@26.715", "renderer@26.715"],
  });
  assert.equal(status.codexVersion, "26.715.1001.0");
  assert.deepEqual(status.testedAdapters, ["packed@26.715", "renderer@26.715", "settings@26.715"]);

  status = checkpointWorkflow({
    worktree,
    milestone: "runtime-ui-validation",
    notApplicable: true,
    note: "No runtime or UI behavior changed.",
  });
  assert.equal(status.milestones.runtimeUiValidation.state, "not-applicable");
  status = checkpointWorkflow({ worktree, milestone: "docs", note: "Feature notes complete." });
  assert.equal(status.readyForReview, true);
  assert.equal(status.clean, true);
  assert.equal(status.commitsSinceBaseline, 5);
  assert.equal(git(worktree, "rev-list", "--count", "--grep=Codex-Feature-Milestone:", "main..HEAD"), "5");
});

test("convert copies a local module onto a fresh contribution branch", (t) => {
  const repository = tempRepository(t, { remote: true });
  const localWorktree = path.join(repository.parent, "local-worktree");
  const contributionWorktree = path.join(repository.parent, "contribution-worktree");
  runCli([
    "start",
    "--mode",
    "local",
    "--feature",
    "local.timeline-tools",
    ...identityArgs(),
    "--repo",
    repository.root,
    "--worktree",
    localWorktree,
  ], repository.root);

  const localModule = path.join(
    localWorktree,
    "features",
    "local",
    "local-timeline-tools",
    "adapters",
    "26.715.1000.0.cjs"
  );
  fs.writeFileSync(localModule, "module.exports={apiVersion:1,apply(){return{changed:true}},verify(){return{ok:true}}};\n", "utf8");
  checkpointWorkflow({
    worktree: localWorktree,
    milestone: "first-successful-patch",
    adapters: ["timeline@26.715"],
  });
  const localHead = git(localWorktree, "rev-parse", "HEAD");

  const converted = convertWorkflow({
    worktree: localWorktree,
    targetWorktree: contributionWorktree,
    feature: "example.timeline-tools",
  });

  assert.equal(converted.branch, "contrib/timeline-tools");
  assert.equal(converted.mode, "contribution");
  assert.equal(converted.commitsSinceBaseline, 1);
  assert.equal(converted.milestones.firstSuccessfulPatch.state, "pending");
  assert.deepEqual(converted.testedAdapters, ["timeline@26.715"]);
  const contributionRoot = path.join(contributionWorktree, "features", "community", "example-timeline-tools");
  assert.match(fs.readFileSync(path.join(contributionRoot, "adapters", "26.715.1000.0.cjs"), "utf8"), /changed:true/);
  const manifest = JSON.parse(fs.readFileSync(path.join(contributionRoot, "feature.json"), "utf8"));
  assert.equal(manifest.id, "example.timeline-tools");
  assert.equal(manifest.kind, "contribution");
  assert.equal(manifest.name, "Example Timeline Tools");
  const convertedTest = fs.readFileSync(path.join(contributionRoot, "tests", "adapter.test.cjs"), "utf8");
  assert.match(convertedTest, /example\.timeline-tools/);
  assert.doesNotMatch(convertedTest, /local\.timeline-tools/);
  const metadata = JSON.parse(fs.readFileSync(path.join(contributionWorktree, converted.metadataPath), "utf8"));
  assert.deepEqual(metadata.convertedFrom, {
    feature: "local.timeline-tools",
    branch: "local/timeline-tools",
    commit: localHead,
  });
  assert.equal(git(localWorktree, "branch", "--show-current"), "local/timeline-tools");
  assert.equal(JSON.parse(fs.readFileSync(path.join(localWorktree, "features", "local", "local-timeline-tools", "feature.json"), "utf8")).kind, "local");
  assert.equal(remoteBranchExists(repository.remotePath, "contrib/timeline-tools"), false);
});

test("incomplete publication is denied and a fully evidenced contribution pushes only explicitly", (t) => {
  const repository = tempRepository(t, { remote: true });
  const worktree = path.join(repository.parent, "contribution-worktree");
  runCli([
    "start",
    "--mode",
    "contribution",
    "--feature",
    "example.explicit-publish",
    ...identityArgs(),
    "--repo",
    repository.root,
    "--worktree",
    worktree,
  ], repository.root);

  assert.equal(remoteBranchExists(repository.remotePath, "contrib/explicit-publish"), false);
  assert.throws(
    () => pullRequestWorkflow({ worktree }),
    /Publication requires every milestone/
  );
  assert.throws(() => pushWorkflow({ worktree, remote: "origin" }), /Publication requires every milestone/);
  assert.equal(remoteBranchExists(repository.remotePath, "contrib/explicit-publish"), false);
  const status = completeContributionWorkflow(
    worktree,
    "example.explicit-publish",
    "features/community/example-explicit-publish"
  );
  assert.equal(status.readyForReview, true);
  assert.equal(status.hasRequiredCheckpoints, true);
  const pushed = pushWorkflow({ worktree, remote: "origin" });
  assert.deepEqual({ action: pushed.action, branch: pushed.branch, remote: pushed.remote }, {
    action: "push",
    branch: "contrib/explicit-publish",
    remote: "origin",
  });
  assert.equal(remoteBranchExists(repository.remotePath, "contrib/explicit-publish"), true);
  assert.throws(() => checkpointWorkflow({ worktree: repository.root, milestone: "docs" }), /protected branch main/);
});

test("fake or missing evidence is denied and deleted historical secrets block publication", (t) => {
  const repository = tempRepository(t, { remote: true });
  const worktree = path.join(repository.parent, "contribution-worktree");
  runCli([
    "start",
    "--mode",
    "contribution",
    "--feature",
    "example.history-guard",
    ...identityArgs(),
    "--repo",
    repository.root,
    "--worktree",
    worktree,
  ], repository.root);
  const featureRoot = "features/community/example-history-guard";
  const adapterPath = path.join(worktree, featureRoot, "adapters", `${INITIAL_IDENTITY.version}.cjs`);
  fs.appendFileSync(adapterPath, "\n// Synthetic first-patch marker.\n", "utf8");
  checkpointWorkflow({ worktree, milestone: "first-successful-patch" });
  assert.throws(
    () => checkpointWorkflow({ worktree, milestone: "packed-verification", evidence: "evidence/missing.json" }),
    /Evidence file is missing/
  );
  const fakeEvidence = writeEvidence(worktree, featureRoot, "fake.json", "packed-verification", "example.wrong-feature");
  assert.throws(
    () => checkpointWorkflow({ worktree, milestone: "packed-verification", evidence: fakeEvidence }),
    /does not match the workflow identity/
  );
  completeContributionWorkflow(worktree, "example.history-guard", featureRoot);
  const secretPath = path.join(worktree, "deleted-secret.txt");
  const syntheticCredential = ["csk", "0123456789abcdefghijklmnopqrstuv"].join("-");
  fs.writeFileSync(secretPath, `CEREBRAS_KEY=${syntheticCredential}\n`, "utf8");
  git(worktree, "add", "deleted-secret.txt");
  git(worktree, "commit", "--no-gpg-sign", "-m", "temporary secret");
  fs.rmSync(secretPath);
  git(worktree, "add", "deleted-secret.txt");
  git(worktree, "commit", "--no-gpg-sign", "-m", "remove temporary secret");
  assert.throws(() => pushWorkflow({ worktree, remote: "origin" }), /Publication source-only validation failed.*credential or private-key pattern/s);
  assert.equal(remoteBranchExists(repository.remotePath, "contrib/history-guard"), false);
});

test("local workflows cannot push or open pull requests", (t) => {
  const repository = tempRepository(t, { remote: true });
  const worktree = path.join(repository.parent, "local-worktree");
  runCli([
    "start",
    "--mode",
    "local",
    "--feature",
    "local.no-publish",
    ...identityArgs(),
    "--repo",
    repository.root,
    "--worktree",
    worktree,
  ], repository.root);
  assert.throws(() => pushWorkflow({ worktree, remote: "origin" }), /local workflows never publish/);
  assert.throws(() => pullRequestWorkflow({ worktree }), /only for contribution workflows/);
});
