const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.orchestrations composes its injection operation", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.orchestrations");
  assert.deepEqual(implementation.operations, ["orchestrations.inject"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), { nativeOrchestrator: { operationId: "orchestrations.inject" } });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "orchestrations.inject"], ["verify", "packed"]]);
});

test("core.orchestrations requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.orchestrations: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.orchestrations: context\.verifyCoreFeature must be a function\./);
});
