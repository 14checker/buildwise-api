const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");
const publicSerializers = require("./public_serializers");

const DB_FILE = process.env.DB_FILE || "db.json";
const EXPORT_DIR = process.env.EXPORT_DIR || "base44_table_exports";
const INTERNAL_TABLES = String(process.env.INTERNAL_TABLES || "false").toLowerCase() === "true";
const EXPORT_AFFILIATE_URLS = String(process.env.EXPORT_AFFILIATE_URLS || "false").toLowerCase() === "true";
const WRITE_ENABLED = String(process.env.WRITE || "false").toLowerCase() === "true";

const PUBLIC_TABLES = ["products", "retailer_offers", "price_snapshots", "retailers"];
const INTERNAL_TABLE_LIST = [
  "scrape_errors",
  "admin_review_queue",
  "product_insert_queue",
  "component_spec_insert_queue",
  "promotion_log",
  "data_sources",
  "alert_queue",
  "import_export_log",
  "source_request_log",
  "source_compliance_log",
  "source_terms_reviews",
  "orphan_offers",
  "orphan_snapshots",
  "discovered_products",
  "discovered_offers"
];

const ALLOWED_TABLES = new Set([...PUBLIC_TABLES, ...(INTERNAL_TABLES ? INTERNAL_TABLE_LIST : [])]);
const REQUESTED_TABLES = (process.env.TABLES || [...PUBLIC_TABLES, ...(INTERNAL_TABLES ? INTERNAL_TABLE_LIST : [])].join(","))
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const BLOCKED_TABLES = REQUESTED_TABLES.filter(table => !ALLOWED_TABLES.has(table));
const TABLES = REQUESTED_TABLES.filter(table => ALLOWED_TABLES.has(table));

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function toCsv(rows, columns = null) {
  const cols = Array.isArray(columns) && columns.length
    ? columns
    : Array.from(new Set(rows.flatMap(row => Object.keys(row || {}))));
  return [cols.join(","), ...rows.map(row => cols.map(col => csvEscape(row[col])).join(","))].join("\n");
}

function rowsForExport(db, table) {
  if (PUBLIC_TABLES.includes(table)) {
    return publicSerializers.rowsForPublicTable(db, table, {
      exportAffiliateUrls: EXPORT_AFFILIATE_URLS
    });
  }
  return db[table];
}

function columnsForExport(table) {
  if (PUBLIC_TABLES.includes(table)) {
    return publicSerializers.fieldsForPublicTable(table, {
      exportAffiliateUrls: EXPORT_AFFILIATE_URLS
    });
  }
  return null;
}

function main() {
  if (BLOCKED_TABLES.length) {
    console.warn(`Warning: skipped disallowed export tables: ${BLOCKED_TABLES.join(", ")}`);
  }

  const db = core.readDb(DB_FILE);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0,19);
  const runDir = path.join(EXPORT_DIR, `export_${stamp}`);
  ensureDir(runDir);

  const exported = [];
  for (const table of TABLES) {
    const rows = rowsForExport(db, table);
    if (!Array.isArray(rows)) continue;
    fs.writeFileSync(path.join(runDir, `${table}.csv`), toCsv(rows, columnsForExport(table)));
    exported.push({ table, rows: rows.length });
  }

  if (WRITE_ENABLED) {
    db.import_export_log = Array.isArray(db.import_export_log) ? db.import_export_log : [];
    db.import_export_log.push({ export_id: `export-${String(db.import_export_log.length + 1).padStart(6,"0")}`, type: "base44_csv_export", tables: exported.map(e=>e.table).join(","), created_at: core.nowBase44DateTime(), output_dir: runDir });
    core.writeDb(db, DB_FILE);
  } else {
    console.log("DRY RUN — export log not written to db.json.");
  }

  console.log("Base44 table export complete.");
  console.log({ output_dir: runDir, exported });
}

main();
