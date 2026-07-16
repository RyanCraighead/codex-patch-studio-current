const id = "core.reasoning-compat";
const operations = Object.freeze([
  "reasoning-compat.summary-conversion",
  "reasoning-compat.summary-rendering",
  "reasoning-compat.ambient-role",
]);

function requireContextMethod(context, method) {
  if (!context || typeof context[method] !== "function") {
    throw new Error(`${id}: context.${method} must be a function.`);
  }
}

function apply(context) {
  requireContextMethod(context, "runCoreOperation");
  return {
    summaryConversion: context.runCoreOperation(operations[0]),
    summaryRendering: context.runCoreOperation(operations[1]),
    ambientSuggestionRoleFallback: context.runCoreOperation(operations[2]),
  };
}

function verify(context, phase) {
  requireContextMethod(context, "verifyCoreFeature");
  return context.verifyCoreFeature(phase);
}

module.exports = { id, operations, apply, verify };
