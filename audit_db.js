const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const FAIL_ON_WARNINGS = String(process.env.FAIL_ON_WARNINGS || "false").toLowerCase() === "true";

function countDuplicates(rows, field) {
  const seen = new Set();
  const dupes = new Set();

  for (const row of rows || []) {
    const value = row?.[field];
    if (!value) continue;
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }

  return dupes.size;
}

function byId(rows, field) {
  return new Set((rows || []).map(row => row?.[field]).filter(Boolean));
}

function categorySpecTable(categoryId) {
  return {
    cpu: "cpu_specs",
    gpu: "gpu_specs",
    motherboard: "motherboard_specs",
    ram: "ram_specs",
    storage: "storage_specs",
    psu: "psu_specs",
    case: "case_specs"
  }[String(categoryId || "").toLowerCase()] || null;
}

function main() {
  const db = core.readDb(DB_FILE);
  const productIds = byId(db.products, "product_id");
  const retailerIds = byId(db.retailers, "retailer_id");
  const offerIds = byId(db.retailer_offers, "retailer_offer_id");

  const issues = [];
  const warnings = [];

  const idChecks = [
    ["products", "product_id"],
    ["retailers", "retailer_id"],
    ["retailer_offers", "retailer_offer_id"],
    ["price_snapshots", "snapshot_id"],
    ["scrape_errors", "error_id"],
    ["admin_review_queue", "review_id"]
  ];

  for (const [table, field] of idChecks) {
    const duplicateCount = countDuplicates(db[table], field);
    if (duplicateCount > 0) issues.push(`${table}.${field} has ${duplicateCount} duplicate IDs.`);
  }

  const orphanOffers = db.retailer_offers.filter(offer => !productIds.has(offer.product_id) || !retailerIds.has(offer.retailer_id));
  if (orphanOffers.length) issues.push(`retailer_offers has ${orphanOffers.length} orphan rows.`);

  const orphanSnapshots = db.price_snapshots.filter(snapshot => !offerIds.has(snapshot.retailer_offer_id));
  if (orphanSnapshots.length) issues.push(`price_snapshots has ${orphanSnapshots.length} orphan rows.`);

  const orphanErrors = db.scrape_errors.filter(error => error.retailer_offer_id && !offerIds.has(error.retailer_offer_id));
  if (orphanErrors.length) warnings.push(`scrape_errors has ${orphanErrors.length} rows pointing to missing offers.`);

  for (const product of db.products) {
    const specTable = categorySpecTable(product.category_id);
    if (!specTable) {
      warnings.push(`Product ${product.product_id} has unknown category_id=${product.category_id}`);
      continue;
    }
    const specRows = Array.isArray(db[specTable]) ? db[specTable] : [];
    if (!specRows.some(row => row.product_id === product.product_id)) {
      warnings.push(`Product ${product.product_id} is missing ${specTable} row.`);
    }
  }

  const queueRows = Array.isArray(db.product_insert_queue) ? db.product_insert_queue : [];
  const promotable = queueRows.filter(row => ["approved", "approve"].includes(core.normalizeKey(row.review_status || row.status)));
  const pending = queueRows.filter(row => ["pending", "new_row_candidate", "needs_review", "review"].includes(core.normalizeKey(row.review_status || row.status)));

  const summary = {
    ...core.getSummary(db),
    orphan_offers: orphanOffers.length,
    orphan_snapshots: orphanSnapshots.length,
    promotable_candidates: promotable.length,
    pending_candidates: pending.length,
    issues: issues.length,
    warnings: warnings.length
  };

  console.log("BuildWise audit summary:");
  console.log(summary);

  if (issues.length) {
    console.log("\nIssues:");
    for (const issue of issues.slice(0, 50)) console.log(`- ${issue}`);
  }

  if (warnings.length) {
    console.log("\nWarnings:");
    for (const warning of warnings.slice(0, 50)) console.log(`- ${warning}`);
    if (warnings.length > 50) console.log(`...and ${warnings.length - 50} more warnings.`);
  }

  if (issues.length || (FAIL_ON_WARNINGS && warnings.length)) process.exit(1);
}

main();
