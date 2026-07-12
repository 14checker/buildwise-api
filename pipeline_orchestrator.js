const fs = require("fs");
const { spawnSync } = require("child_process");
const core = require("./buildwise_backend_core");
const { loadIngestionConfig, validateIngestionConfig } = require("./ingestion_config");

const config = loadIngestionConfig({ pipelineMode: process.env.PIPELINE_MODE || "safe_daily" });
const DB_FILE = config.dbFile;
const LOCK_FILE = process.env.LOCK_FILE || ".buildwise_pipeline.lock";
const MODE = config.pipelineMode;

function dryRunValue(flagValue, fallback) {
  if (flagValue !== undefined && flagValue !== null && flagValue !== "") return String(flagValue);
  return fallback ? "true" : "false";
}

function stepsForMode(mode) {
  const write = Boolean(config.write);
  const safeTrackerDryRun = dryRunValue(process.env.TRACKER_DRY_RUN, !write);
  const safePromoteDryRun = dryRunValue(process.env.PROMOTE_DRY_RUN, !write);
  const safeDiscoveryDryRun = dryRunValue(process.env.DISCOVERY_DRY_RUN, !write);

  const modes = {
    safe_daily: [
      ["env_check.js", {}],
      ["backup_db.js", {}],
      ["migrate_db.js", { WRITE: write ? "true" : "" }],
      ["validate_db.js", {}],
      ["audit_db.js", {}],
      ["compliance_audit.js", {}],
      ["group_products.js", {}],
      ["promote_candidates.js", { DRY_RUN: safePromoteDryRun, AUTO_PROMOTE: process.env.AUTO_PROMOTE || "false" }],
      ["tracker_updated.js", { DRY_RUN: safeTrackerDryRun, MAX_OFFERS: process.env.TRACKER_MAX_OFFERS || "25", REQUIRE_APPROVED_SOURCE: process.env.REQUIRE_APPROVED_SOURCE || "false" }],
      ["alert_engine.js", { DRY_RUN: process.env.ALERT_DRY_RUN || "true" }],
      ["data_quality_audit.js", {}],
      ["pipeline_status.js", {}],
      ["generate_admin_report.js", {}]
    ],
    discovery_review: [
      ["backup_db.js", {}],
      ["seed_discovery_sources.js", {}],
      ["discover_products.js", { DRY_RUN: safeDiscoveryDryRun }],
      ["verify_candidates.js", { AUTO_PROMOTE: "false" }],
      ["data_quality_audit.js", {}],
      ["generate_admin_report.js", {}]
    ],
    production_sync: [
      ["env_check.js", {}],
      ["backup_db.js", {}],
      ["migrate_db.js", { WRITE: write ? "true" : "" }],
      ["validate_db.js", {}],
      ["audit_db.js", {}],
      ["compliance_audit.js", {}],
      ["discover_products.js", { DRY_RUN: safeDiscoveryDryRun }],
      ["verify_candidates.js", {}],
      ["group_products.js", {}],
      ["promote_candidates.js", { DRY_RUN: safePromoteDryRun, AUTO_PROMOTE: process.env.AUTO_PROMOTE || "false" }],
      ["tracker_updated.js", { DRY_RUN: safeTrackerDryRun, MAX_OFFERS: process.env.TRACKER_MAX_OFFERS || "25", REQUIRE_APPROVED_SOURCE: process.env.REQUIRE_APPROVED_SOURCE || "true" }],
      ["alert_engine.js", { DRY_RUN: process.env.ALERT_DRY_RUN || "true" }],
      ["data_quality_audit.js", {}],
      ["export_public_json.js", {}],
      ["export_base44_tables.js", {}],
      ["pipeline_status.js", {}],
      ["generate_admin_report.js", {}]
    ],
    export: [
      ["backup_db.js", {}],
      ["validate_db.js", {}],
      ["audit_db.js", {}],
      ["export_base44_tables.js", {}],
      ["export_public_json.js", {}]
    ]
  };
  return modes[mode];
}

function runStep(script, env) {
  console.log(`\n=== Running ${script} ===`);
  const result = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, DB_FILE, PIPELINE_MODE: MODE, ...env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed with code ${result.status}`);
  return { script, status: "complete" };
}

function appendPipelineRun(status, startedAt, steps, error = null) {
  if (!config.write) {
    console.log("DRY RUN - pipeline run history not written to db.json. Set WRITE=true to persist pipeline run records.");
    return null;
  }

  const db = core.readDb(DB_FILE);
  db.pipeline_runs = Array.isArray(db.pipeline_runs) ? db.pipeline_runs : [];
  const run = {
    run_id: `pipe-${String(db.pipeline_runs.length + 1).padStart(6, "0")}`,
    mode: MODE,
    status,
    started_at: startedAt,
    finished_at: core.nowBase44DateTime(),
    steps,
    error: error ? error.message : null
  };
  db.pipeline_runs.push(run);
  core.writeDb(db, DB_FILE);
  return run;
}

function main() {
  const validation = validateIngestionConfig(config);
  if (validation.warnings.length) validation.warnings.forEach(warning => console.warn(`PIPELINE_WARNING ${warning}`));
  if (!validation.valid) throw new Error(validation.errors.join(" "));

  const steps = stepsForMode(MODE);
  if (!steps) throw new Error(`Unknown PIPELINE_MODE=${MODE}`);
  if (fs.existsSync(LOCK_FILE)) throw new Error(`Pipeline lock exists: ${LOCK_FILE}. Delete it only if no pipeline is running.`);

  const startedAt = core.nowBase44DateTime();
  const completedSteps = [];
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ mode: MODE, started_at: startedAt, write_enabled: config.write }, null, 2));

  try {
    for (const [script, env] of steps) completedSteps.push(runStep(script, env));
    appendPipelineRun("complete", startedAt, completedSteps);
    console.log(`Pipeline complete: ${MODE}`);
  } catch (error) {
    appendPipelineRun("failed", startedAt, completedSteps, error);
    throw error;
  } finally {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  stepsForMode
};
