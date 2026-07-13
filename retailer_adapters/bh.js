const { createAdapter } = require("./generic");

module.exports = createAdapter({
  retailerId: "ret-bh",
  name: "B&H Photo",
  queryName: "B&H",
  domains: ["bhphotovideo.com"]
});
