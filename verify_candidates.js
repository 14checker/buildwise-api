/**
 * BuildWise purpose:
 * Command-line entry point for safe retailer URL candidate verification.
 *
 * Plain-English summary:
 * This script scores reviewed retailer page candidates and can promote exact matches only when write flags explicitly allow it.
 *
 * Safety note:
 * Default mode is dry-run. AUTO_PROMOTE without WRITE=true is blocked before any work begins.
 */
const core = require("./buildwise_backend_core");
const publicDataMetrics = require("./public_data_metrics");
const { loadIngestionConfig, validateIngestionConfig } = require("./ingestion_config");
const { runRetailerIngestion } = require("./retailer_ingestion");

async function main() {
  const config = loadIngestionConfig();
  const validation = validateIngestionConfig(config);
  if (validation.warnings.length) {
    for (const warning of validation.warnings) console.warn(`INGESTION_WARNING ${warning}`);
  }
  if (!validation.valid) {
    for (const error of validation.errors) console.error(`INGESTION_CONFIG_ERROR ${error}`);
    process.exitCode = 1;
    return;
  }

  const hashBefore = publicDataMetrics.hashFile(config.dbFile);
  const db = core.readDb(config.dbFile);
  const summary = await runRetailerIngestion(db, config);

  if (config.write) {
    core.writeDb(db, config.dbFile);
  } else {
    console.log("DRY RUN - db.json was not written. Set WRITE=true to persist reviewed candidate records or promotions.");
  }

  const hashAfter = publicDataMetrics.hashFile(config.dbFile);
  console.log("BUILDWISE_INGESTION_SUMMARY " + JSON.stringify({
    db_file: config.dbFile,
    db_hash_before: hashBefore,
    db_hash_after: hashAfter,
    db_changed: Boolean(hashBefore && hashAfter && hashBefore !== hashAfter),
    write_enabled: Boolean(config.write),
    auto_promote_enabled: Boolean(config.autoPromote),
    allow_live_fetch: Boolean(config.allowLiveFetch),
    ...summary
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error("INGESTION_FAILED", error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
