const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.eager-history composes its patch loader operation", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.eager-history");
  assert.deepEqual(implementation.operations, ["eager-history.patch-loader"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), { patchResult: { operationId: "eager-history.patch-loader" } });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "eager-history.patch-loader"], ["verify", "packed"]]);
});

test("core.eager-history requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.eager-history: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.eager-history: context\.verifyCoreFeature must be a function\./);
});
