const { createAdapter } = require("./generic");

module.exports = createAdapter({
  retailerId: "ret-amazon",
  name: "Amazon",
  queryName: "Amazon",
  domains: ["amazon.com"]
});
