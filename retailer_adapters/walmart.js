const { createAdapter } = require("./generic");

module.exports = createAdapter({
  retailerId: "ret-walmart",
  name: "Walmart",
  queryName: "Walmart",
  domains: ["walmart.com"]
});
