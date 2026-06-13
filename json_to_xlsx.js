const XLSX = require("xlsx");
const fs = require("fs");

const INPUT_FILE = process.env.DB_FILE || process.env.INPUT_FILE || "db.json";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "buildwise_compiled_datasets_UPDATED.xlsx";

if (!fs.existsSync(INPUT_FILE)) {
  throw new Error(`Missing input JSON file: ${INPUT_FILE}`);
}

const db = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));
const workbook = XLSX.utils.book_new();

const preferredOrder = [
  "categories",
  "brands",
  "retailers",
  "products",
  "retailer_offers",
  "price_snapshots",
  "users",
  "watchlists",
  "price_alerts",
  "affiliate_clicks",
  "scrape_jobs",
  "scrape_errors",
  "admin_review_queue",
  "product_groups",
  "product_group_members",
  "product_similarity_map",
  "product_offer_summary",
  "discovery_sources",
  "discovered_products",
  "discovered_offers",
  "product_insert_queue",
  "component_spec_insert_queue",
  "promotion_log",
  "data_sources",
  "source_request_log",
  "source_compliance_log",
  "source_terms_reviews",
  "change_log",
  "alert_queue",
  "pipeline_runs",
  "data_quality_reports",
  "quarantine_records",
  "import_export_log",
  "system_events"
];

const tableNames = [
  ...preferredOrder.filter(name => Array.isArray(db[name])),
  ...Object.keys(db).filter(name => Array.isArray(db[name]) && !preferredOrder.includes(name))
];

for (const tableName of tableNames) {
  const rows = db[tableName] || [];
  const worksheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, tableName.slice(0, 31));
}

XLSX.writeFile(workbook, OUTPUT_FILE);

console.log(`Converted ${INPUT_FILE} -> ${OUTPUT_FILE}`);
console.log("Sheets written:", tableNames);
