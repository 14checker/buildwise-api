const { createAdapter } = require("./generic");

module.exports = createAdapter({
  retailerId: "ret-bestbuy",
  name: "Best Buy",
  queryName: "Best Buy",
  domains: ["bestbuy.com"]
});
