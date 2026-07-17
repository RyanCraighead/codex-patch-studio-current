const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.provider-suite composes its provider operations", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.provider-suite");
  assert.deepEqual(implementation.operations, ["provider-suite.catalog", "provider-suite.preload", "provider-suite.settings", "provider-suite.prompt-catalog"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), {
    providerModelCatalog: { operationId: "provider-suite.catalog" },
    preloadOutboundInterceptor: { operationId: "provider-suite.preload" },
    providerSettings: { operationId: "provider-suite.settings" },
    defaultPromptCatalog: { operationId: "provider-suite.prompt-catalog" },
  });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "provider-suite.catalog"], ["apply", "provider-suite.preload"], ["apply", "provider-suite.settings"], ["apply", "provider-suite.prompt-catalog"], ["verify", "packed"]]);
});

test("core.provider-suite requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.provider-suite: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.provider-suite: context\.verifyCoreFeature must be a function\./);
});
