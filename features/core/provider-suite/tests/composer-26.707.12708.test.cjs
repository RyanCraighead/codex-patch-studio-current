const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const rootDir = path.resolve(__dirname, "../../../..");
const builderPath = path.join(rootDir, "scripts", "build-patched-codex-app.cjs");

function loadComposerPatch() {
  const source = fs.readFileSync(builderPath, "utf8").replace(/^#!.*\r?\n/, "");
  const invocationPattern = /try \{\r?\n\s*withBuildLockSync\(rootDir, main\);\r?\n\} catch \(error\) \{[\s\S]*$/;
  assert.match(source, invocationPattern, "builder entry point changed; update the composer adapter test harness");
  const instrumented = source.replace(
    invocationPattern,
    "globalThis.__composerPatchTestInternals = { patchComposerProviderModels };"
  );
  const sandbox = {
    Buffer,
    __dirname: path.dirname(builderPath),
    __filename: builderPath,
    clearTimeout,
    console,
    process,
    require: createRequire(builderPath),
    setTimeout,
  };
  vm.runInNewContext(instrumented, sandbox, { filename: builderPath, timeout: 5000 });
  return sandbox.__composerPatchTestInternals.patchComposerProviderModels;
}

const patchComposerProviderModels = loadComposerPatch();

const helperMarker =
  "function lk({conversationId:e,hideLabel:t,permissionsCwdOverride:n,permissionsHostId:r}){";
const catalogSource =
  "{data:m,status:h}=So({hostId:s.hostId}),g=m?.models,{modelSettings:y,selectComposerModelAndReasoningEffort:b}=OO({conversationId:e,cwdOverride:n,hostId:r}),x=y.model;_(Wi,e);let{data:S}=_(to,{cwd:s.cwd,hostId:s.hostId}),{serviceTierSettings:C";
const nativeSelect =
  "function Te(t,n){return b(t,n,()=>{t===x?n!=null&&n!==H&&Fa(i,Zr,{reasoningEffort:n}):Fa(i,di,{model:t}),D&&t!==x&&!ba(x,t)&&i.get(Nn).info((0,mk.jsx)(Q,{id:`composer.modelChangeDuringConversationWarning.toast`,defaultMessage:`Changing models mid-conversation will degrade performance.`,description:`Warning toast shown when user changes model during an ongoing conversation`}),{id:`composer.modelChangeDuringConversationWarning.${e}`})})}";

test("provider suite patches the Codex 26.707.12708 composer shape", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-composer-12708-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetDir = path.join(root, "webview", "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  const assetPath = path.join(assetDir, "composer-fixture.js");
  fs.writeFileSync(
    assetPath,
    [
      "const supportedReasoningEfforts=[];const semanticMarker=`data-codex-intelligence-trigger`;",
      helperMarker,
      catalogSource,
      ",setServiceTier:w}=jo(e);",
      nativeSelect,
      "return{models:g,onSelectModel:(e,t)=>{Te(e,t)}}}",
    ].join(""),
    "utf8"
  );

  const result = patchComposerProviderModels(root);
  const patched = fs.readFileSync(assetPath, "utf8");

  assert.equal(result.containsProviderCatalogPatch, true);
  assert.equal(result.patches.length, 3);
  assert.match(patched, /function cpsProviderCatalog/);
  assert.match(patched, /g=cpsProviderCatalog\(m\?\.models,S\),x=cpsSelectedModel\(y\.model\)/);
  assert.match(patched, /selectModelFromNativeMenu\?\.\(\{model:t,providerId:r,reasoningEffort:n\}\)/);
  assert.doesNotMatch(patched, new RegExp(catalogSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
