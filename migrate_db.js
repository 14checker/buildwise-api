const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const TARGET_SCHEMA_VERSION = "8.0.0";

function ensureArray(db, name) {
  if (!Array.isArray(db[name])) db[name] = [];
}

function ensureObject(db, name, fallback = {}) {
  if (!db[name] || Array.isArray(db[name]) || typeof db[name] !== "object") db[name] = fallback;
}

function main() {
  const db = core.readDb(DB_FILE);

  [
    "change_log",
    "alert_queue",
    "pipeline_runs",
    "data_quality_reports",
    "quarantine_records",
    "import_export_log",
    "system_events",
    "source_request_log",
    "source_compliance_log",
    "source_terms_reviews",
    "data_sources"
  ].forEach(table => ensureArray(db, table));

  ensureObject(db, "system_settings", {
    schema_version: TARGET_SCHEMA_VERSION,
    environment: process.env.BUILDWISE_ENV || "local",
    strict_compliance_default: false,
    auto_promote_default: false,
    public_price_max_age_hours: 24,
    last_migrated_at: null
  });

  ensureObject(db, "affiliate_disclosure_config", {
    default_disclosure: "BuildWise may earn a commission when you buy through links on this site. Prices and availability may change at the retailer.",
    status: "draft",
    last_reviewed_at: null
  });

  ensureObject(db, "public_data_policy", {
    max_price_age_hours: 24,
    show_discovered_products_publicly: false,
    require_approved_source_for_public_prices: true,
    status: "draft",
    last_reviewed_at: null
  });

  db.system_settings.schema_version = TARGET_SCHEMA_VERSION;
  db.system_settings.last_migrated_at = core.nowBase44DateTime();

  core.writeDb(db, DB_FILE);

  console.log("Migration complete.");
  console.log({ schema_version: db.system_settings.schema_version, db_file: DB_FILE });
}

main();
