const implementation = require("../implementation.cjs");

module.exports = {
  apiVersion: 1,
  codexVersion: "26.707.x",
  apply(context) {
    return implementation.apply(context);
  },
  verify(context, phase) {
    return implementation.verify(context, phase);
  },
};
