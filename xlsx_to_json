const XLSX = require("xlsx");
const fs = require("fs");

const INPUT_FILE = process.env.INPUT_FILE || "buildwise_compiled_datasets.xlsx";
const OUTPUT_FILE = process.env.OUTPUT_FILE || process.env.DB_FILE || "db.json";

const REQUIRED_TABLES = [
  "products",
  "retailers",
  "retailer_offers",
  "price_snapshots",
  "scrape_jobs",
  "scrape_errors",
  "admin_review_queue"
];

function normalizeSheetName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function findInputFile() {
  if (fs.existsSync(INPUT_FILE)) return INPUT_FILE;

  const xlsxFiles = fs
    .readdirSync(".")
    .filter(file => file.toLowerCase().endsWith(".xlsx") && !file.startsWith("~$"));

  if (!xlsxFiles.length) {
    throw new Error("No .xlsx file found in this folder. Move the Base44 workbook here and run again.");
  }

  return xlsxFiles[0];
}

const inputFile = findInputFile();
console.log(`Reading workbook: ${inputFile}`);

const workbook = XLSX.readFile(inputFile);
const db = {};

for (const sheetName of workbook.SheetNames) {
  const tableName = normalizeSheetName(sheetName);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: null,
    raw: false
  });

  db[tableName] = rows;
}

for (const table of REQUIRED_TABLES) {
  if (!Array.isArray(db[table])) db[table] = [];
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(db, null, 2));

console.log(`Converted ${inputFile} -> ${OUTPUT_FILE}`);
console.log("Tables:", Object.keys(db));
console.log("products:", db.products?.length);
console.log("retailer_offers:", db.retailer_offers?.length);
console.log("retailers:", db.retailers?.length);
console.log("price_snapshots:", db.price_snapshots?.length);

const missing = REQUIRED_TABLES.filter(table => !db[table] || !db[table].length);
if (missing.length) {
  console.warn("Warning: these expected tables are empty or missing:", missing);
}
