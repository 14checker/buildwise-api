const { createAdapter } = require("./generic");

module.exports = createAdapter({
  retailerId: "ret-newegg",
  name: "Newegg",
  queryName: "Newegg",
  domains: ["newegg.com"]
});
