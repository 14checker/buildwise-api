const fs = require("fs");
const { spawnSync } = require("child_process");
const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const LOCK_FILE = process.env.LOCK_FILE || ".buildwise_pipeline.lock";
const MODE = process.env.PIPELINE_MODE || "safe_daily";

const MODES = {
  safe_daily: [
    ["env_check.js", {}],
    ["backup_db.js", {}],
    ["migrate_db.js", {}],
    ["validate_db.js", {}],
    ["audit_db.js", {}],
    ["compliance_audit.js", {}],
    ["group_products.js", {}],
    ["promote_candidates.js", { DRY_RUN: process.env.PROMOTE_DRY_RUN || "false", AUTO_PROMOTE: process.env.AUTO_PROMOTE || "false" }],
    ["tracker_updated.js", { DRY_RUN: process.env.TRACKER_DRY_RUN || "false", MAX_OFFERS: process.env.TRACKER_MAX_OFFERS || "25", REQUIRE_APPROVED_SOURCE: process.env.REQUIRE_APPROVED_SOURCE || "false" }],
    ["alert_engine.js", { DRY_RUN: process.env.ALERT_DRY_RUN || "true" }],
    ["data_quality_audit.js", {}],
    ["pipeline_status.js", {}],
    ["generate_admin_report.js", {}]
  ],
  discovery_review: [
    ["backup_db.js", {}],
    ["seed_discovery_sources.js", {}],
    ["discover_products.js", { DRY_RUN: process.env.DISCOVERY_DRY_RUN || "true" }],
    ["data_quality_audit.js", {}],
    ["generate_admin_report.js", {}]
  ],
  export: [
    ["backup_db.js", {}],
    ["validate_db.js", {}],
    ["audit_db.js", {}],
    ["export_base44_tables.js", {}],
    ["json_to_xlsx.js", {}]
  ]
};

function runStep(script, env) {
  console.log(`\n=== Running ${script} ===`);
  const result = spawnSync("node", [script], { stdio: "inherit", shell: true, env: { ...process.env, DB_FILE, ...env } });
  if (result.status !== 0) throw new Error(`${script} failed with code ${result.status}`);
}

function main() {
  if (fs.existsSync(LOCK_FILE)) throw new Error(`Pipeline lock exists: ${LOCK_FILE}. Delete it only if no pipeline is running.`);
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ mode: MODE, started_at: core.nowBase44DateTime() }, null, 2));

  const db = core.readDb(DB_FILE);
  db.pipeline_runs = Array.isArray(db.pipeline_runs) ? db.pipeline_runs : [];
  const run = { run_id: `pipe-${String(db.pipeline_runs.length + 1).padStart(6,"0")}`, mode: MODE, status: "running", started_at: core.nowBase44DateTime(), finished_at: null };
  db.pipeline_runs.push(run);
  core.writeDb(db, DB_FILE);

  try {
    const steps = MODES[MODE];
    if (!steps) throw new Error(`Unknown PIPELINE_MODE=${MODE}`);
    for (const [script, env] of steps) runStep(script, env);

    const finalDb = core.readDb(DB_FILE);
    const finalRun = finalDb.pipeline_runs.find(row => row.run_id === run.run_id);
    if (finalRun) { finalRun.status = "complete"; finalRun.finished_at = core.nowBase44DateTime(); }
    core.writeDb(finalDb, DB_FILE);
    console.log(`Pipeline complete: ${MODE}`);
  } catch (err) {
    const finalDb = core.readDb(DB_FILE);
    const finalRun = finalDb.pipeline_runs.find(row => row.run_id === run.run_id);
    if (finalRun) { finalRun.status = "failed"; finalRun.finished_at = core.nowBase44DateTime(); finalRun.error = err.message; }
    core.writeDb(finalDb, DB_FILE);
    throw err;
  } finally {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  }
}

main();
