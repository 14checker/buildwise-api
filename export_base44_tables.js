const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const EXPORT_DIR = process.env.EXPORT_DIR || "base44_table_exports";

const TABLES = (process.env.TABLES || "products,retailer_offers,price_snapshots,scrape_errors,admin_review_queue,product_insert_queue,component_spec_insert_queue,promotion_log,data_sources,alert_queue")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function toCsv(rows) {
  const cols = Array.from(new Set(rows.flatMap(row => Object.keys(row || {}))));
  return [cols.join(","), ...rows.map(row => cols.map(col => csvEscape(row[col])).join(","))].join("\n");
}

function main() {
  const db = core.readDb(DB_FILE);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0,19);
  const runDir = path.join(EXPORT_DIR, `export_${stamp}`);
  ensureDir(runDir);

  const exported = [];
  for (const table of TABLES) {
    if (!Array.isArray(db[table])) continue;
    fs.writeFileSync(path.join(runDir, `${table}.csv`), toCsv(db[table]));
    exported.push({ table, rows: db[table].length });
  }

  db.import_export_log = Array.isArray(db.import_export_log) ? db.import_export_log : [];
  db.import_export_log.push({ export_id: `export-${String(db.import_export_log.length + 1).padStart(6,"0")}`, type: "base44_csv_export", tables: exported.map(e=>e.table).join(","), created_at: core.nowBase44DateTime(), output_dir: runDir });
  core.writeDb(db, DB_FILE);

  console.log("Base44 table export complete.");
  console.log({ output_dir: runDir, exported });
}

main();
