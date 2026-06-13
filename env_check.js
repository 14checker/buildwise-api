const fs = require("fs");

const requiredFiles = [
  "buildwise_backend_core.js",
  "tracker_updated.js",
  "discover_products.js",
  "promote_candidates.js",
  "validate_db.js",
  "audit_db.js",
  "safe_run.js",
  "package.json"
];

const DB_FILE = process.env.DB_FILE || "db.json";

function main() {
  const missing = [];
  for (const file of requiredFiles) if (!fs.existsSync(file)) missing.push(file);

  const warnings = [];
  if (!fs.existsSync(DB_FILE)) warnings.push(`Database file not found yet: ${DB_FILE}`);
  if (!process.version) warnings.push("Node version unavailable.");

  console.log("BuildWise environment check:");
  console.log({ node: process.version, cwd: process.cwd(), db_file: DB_FILE, missing_required_files: missing.length, warnings: warnings.length });

  if (missing.length) {
    console.log("Missing files:");
    for (const file of missing) console.log(`- ${file}`);
    process.exit(1);
  }

  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
}

main();
