const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");
const governance = require("./source_governance");

const DB_FILE = process.env.DB_FILE || "db.json";
const REPORT_DIR = process.env.REPORT_DIR || "buildwise_reports";
const MAX_PRICE_AGE_HOURS = Number(process.env.MAX_PRICE_AGE_HOURS || 24);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function hoursAgo(value) {
  const t = new Date(value || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60);
}

function scoreProduct(product, offers, specRows) {
  let score = 100;
  const reasons = [];
  if (!product.brand) { score -= 10; reasons.push("missing_brand"); }
  if (!product.model) { score -= 10; reasons.push("missing_model"); }
  if (!product.slug) { score -= 5; reasons.push("missing_slug"); }
  if (!specRows.length) { score -= 20; reasons.push("missing_spec_row"); }
  if (!offers.length) { score -= 25; reasons.push("no_retailer_offers"); }
  const freshOffers = offers.filter(o => hoursAgo(o.last_scraped_at) <= MAX_PRICE_AGE_HOURS);
  if (offers.length && !freshOffers.length) { score -= 15; reasons.push("stale_offer_data"); }
  return { score: Math.max(0, score), reasons };
}

function specTable(categoryId) {
  return { cpu:"cpu_specs", gpu:"gpu_specs", motherboard:"motherboard_specs", ram:"ram_specs", storage:"storage_specs", psu:"psu_specs", case:"case_specs" }[core.normalizeKey(categoryId)] || null;
}

function main() {
  const db = core.readDb(DB_FILE);
  governance.ensureGovernanceTables(db);
  ensureDir(REPORT_DIR);

  const offersByProduct = new Map();
  for (const offer of db.retailer_offers) {
    if (!offersByProduct.has(offer.product_id)) offersByProduct.set(offer.product_id, []);
    offersByProduct.get(offer.product_id).push(offer);
  }

  const productScores = db.products.map(product => {
    const table = specTable(product.category_id);
    const specs = table && Array.isArray(db[table]) ? db[table].filter(row => row.product_id === product.product_id) : [];
    const offers = offersByProduct.get(product.product_id) || [];
    return { product_id: product.product_id, category_id: product.category_id, brand: product.brand, model: product.model, ...scoreProduct(product, offers, specs) };
  });

  const lowQuality = productScores.filter(row => row.score < 75);
  const staleOffers = db.retailer_offers.filter(offer => hoursAgo(offer.last_scraped_at) > MAX_PRICE_AGE_HOURS);
  const missingUrls = db.retailer_offers.filter(offer => !core.getScrapeUrl(offer));

  const report = {
    created_at: core.nowBase44DateTime(),
    max_price_age_hours: MAX_PRICE_AGE_HOURS,
    products: db.products.length,
    low_quality_products: lowQuality.length,
    average_product_quality_score: Math.round(productScores.reduce((sum, row) => sum + row.score, 0) / Math.max(1, productScores.length)),
    retailer_offers: db.retailer_offers.length,
    stale_offers: staleOffers.length,
    offers_missing_urls: missingUrls.length,
    top_low_quality_products: lowQuality.slice(0, 100)
  };

  const file = path.join(REPORT_DIR, `data_quality_${new Date().toISOString().replace(/[:.]/g,"-").slice(0,19)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  db.data_quality_reports = Array.isArray(db.data_quality_reports) ? db.data_quality_reports : [];
  db.data_quality_reports.push({ report_id: `dq-${String(db.data_quality_reports.length + 1).padStart(6,"0")}`, created_at: report.created_at, average_score: report.average_product_quality_score, low_quality_products: lowQuality.length, stale_offers: staleOffers.length, report_file: file });
  core.writeDb(db, DB_FILE);

  console.log("Data quality audit complete.");
  console.log(report);
  console.log(`Report written to: ${file}`);
}

main();
