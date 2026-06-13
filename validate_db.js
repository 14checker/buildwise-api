const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const db = core.readDb(DB_FILE);

console.log("Database summary:");
console.log(core.getSummary(db));

const activeProducts = db.products.filter(p => core.normalizeKey(p.status || "active") === "active");
const targets = core.getScrapeTargets(db, {
  maxOffers: Number(process.env.MAX_OFFERS || 0),
  category: process.env.CATEGORY || "",
  retailer: process.env.RETAILER || ""
});

const coveredProducts = new Set(targets.map(t => t.product.product_id));
const productsWithoutTargets = activeProducts.filter(p => !coveredProducts.has(p.product_id));

console.log("\nTracker coverage:");
console.log({
  active_products: activeProducts.length,
  scrape_targets: targets.length,
  covered_products: coveredProducts.size,
  products_without_targets: productsWithoutTargets.length
});

console.log("\nSample scrape targets:");
for (const target of targets.slice(0, 10)) {
  console.log({
    retailer_offer_id: target.offer.retailer_offer_id,
    product_id: target.offer.product_id,
    retailer_id: target.offer.retailer_id,
    category_id: target.product.category_id,
    url: target.scrapeUrl
  });
}

if (productsWithoutTargets.length) {
  console.log("\nSample products without scrape targets:");
  for (const product of productsWithoutTargets.slice(0, 10)) {
    console.log({ product_id: product.product_id, category_id: product.category_id, brand: product.brand, model: product.model });
  }
}
