/**
 * BuildWise purpose:
 * Write public-safe JSON files for API fallback, hosting, or review.
 *
 * Plain-English summary:
 * This file turns the same safe public data used by Base44 into static JSON files.
 *
 * Safety note:
 * It must use public serializers only and must not write raw db.json, affiliate URLs, source URLs, or internal metadata.
 */
const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");
const publicDataMetrics = require("./public_data_metrics");

const DB_FILE = process.env.DB_FILE || "db.json";
const PUBLIC_DATA_DIR = process.env.PUBLIC_DATA_DIR || "public_data";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runExport(options = {}) {
  const dbFile = options.dbFile || DB_FILE;
  const outputDir = options.outputDir || PUBLIC_DATA_DIR;
  const db = options.db || core.readDb(dbFile);
  const publicOptions = options.publicOptions || publicDataMetrics.publicOptionsFromEnv();

  ensureDir(outputDir);

  const rows = publicDataMetrics.rowsForPublicExports(db, publicOptions);
  const status = publicDataMetrics.buildPublicStatus(db, {
    ...publicOptions,
    dbFile
  });

  const files = {
    products: path.join(outputDir, "products.json"),
    retailer_offers: path.join(outputDir, "retailer_offers.json"),
    retailers: path.join(outputDir, "retailers.json"),
    price_snapshots: path.join(outputDir, "price_snapshots.json"),
    status: path.join(outputDir, "status.json")
  };

  writeJson(files.products, rows.products);
  writeJson(files.retailer_offers, rows.retailer_offers);
  writeJson(files.retailers, rows.retailers);
  writeJson(files.price_snapshots, rows.price_snapshots);
  writeJson(files.status, status);

  console.log("Public JSON export complete.");
  console.log({
    output_dir: outputDir,
    products: rows.products.length,
    retailer_offers: rows.retailer_offers.length,
    retailers: rows.retailers.length,
    price_snapshots: rows.price_snapshots.length,
    data_mode: status.data_mode,
    warnings: status.warnings
  });

  return { output_dir: outputDir, files, counts: status, rows };
}

function main() {
  runExport();
}

if (require.main === module) {
  main();
}

module.exports = {
  runExport
};
