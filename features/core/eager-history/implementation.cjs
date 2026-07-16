const id = "core.eager-history";
const operations = Object.freeze(["eager-history.patch-loader"]);

function requireContextMethod(context, method) {
  if (!context || typeof context[method] !== "function") {
    throw new Error(`${id}: context.${method} must be a function.`);
  }
}

function apply(context) {
  requireContextMethod(context, "runCoreOperation");
  return { patchResult: context.runCoreOperation(operations[0]) };
}

function verify(context, phase) {
  requireContextMethod(context, "verifyCoreFeature");
  return context.verifyCoreFeature(phase);
}

module.exports = { id, operations, apply, verify };
