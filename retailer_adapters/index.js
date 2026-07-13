const amazon = require("./amazon");
const bestbuy = require("./bestbuy");
const bh = require("./bh");
const microcenter = require("./microcenter");
const newegg = require("./newegg");
const walmart = require("./walmart");
const { createAdapter } = require("./generic");

const adapters = new Map([
  [amazon.retailerId, amazon],
  [bestbuy.retailerId, bestbuy],
  [bh.retailerId, bh],
  [microcenter.retailerId, microcenter],
  [newegg.retailerId, newegg],
  [walmart.retailerId, walmart]
]);

function adapterForRetailer(retailer = {}) {
  const existing = adapters.get(retailer.retailer_id);
  if (existing) return existing;
  return createAdapter({
    retailerId: retailer.retailer_id || "ret-generic",
    name: retailer.name || retailer.retailer_id || "Generic Retailer",
    domains: [retailer.domain].filter(Boolean)
  });
}

module.exports = {
  adapterForRetailer,
  adapters
};
