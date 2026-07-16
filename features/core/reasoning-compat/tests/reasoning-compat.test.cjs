const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.reasoning-compat composes its compatibility operations", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.reasoning-compat");
  assert.deepEqual(implementation.operations, ["reasoning-compat.summary-conversion", "reasoning-compat.summary-rendering", "reasoning-compat.ambient-role"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), {
    summaryConversion: { operationId: "reasoning-compat.summary-conversion" },
    summaryRendering: { operationId: "reasoning-compat.summary-rendering" },
    ambientSuggestionRoleFallback: { operationId: "reasoning-compat.ambient-role" },
  });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "reasoning-compat.summary-conversion"], ["apply", "reasoning-compat.summary-rendering"], ["apply", "reasoning-compat.ambient-role"], ["verify", "packed"]]);
});

test("core.reasoning-compat requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.reasoning-compat: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.reasoning-compat: context\.verifyCoreFeature must be a function\./);
});
