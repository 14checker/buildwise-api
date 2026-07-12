const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadIngestionConfig } = require("./ingestion_config");

const config = loadIngestionConfig();
const DB_FILE = config.dbFile;
const LOCK_DIR = process.env.SCHEDULER_LOCK_DIR || ".buildwise_locks";
const LOCK_STALE_MINUTES = Number(process.env.SCHEDULER_LOCK_STALE_MINUTES || 120);
const RUN_ON_START = String(process.env.RUN_ON_START || "true").toLowerCase() === "true";
const TRACKER_EVERY_MINUTES = Number(process.env.TRACKER_EVERY_MINUTES || 15);
const PROMOTE_EVERY_MINUTES = Number(process.env.PROMOTE_EVERY_MINUTES || 15);
const DISCOVERY_EVERY_MINUTES = Number(process.env.DISCOVERY_EVERY_MINUTES || 240);
const GROUP_EVERY_MINUTES = Number(process.env.GROUP_EVERY_MINUTES || 240);
const PRODUCTION_SYNC_EVERY_MINUTES = Number(process.env.PRODUCTION_SYNC_EVERY_MINUTES || 0);

const TRACKER_MAX_OFFERS = process.env.TRACKER_MAX_OFFERS || "25";
const TRACKER_DRY_RUN = process.env.TRACKER_DRY_RUN || (config.write ? "false" : "true");
const DISCOVERY_DRY_RUN = process.env.DISCOVERY_DRY_RUN || (config.write ? "false" : "true");
const PROMOTE_DRY_RUN = process.env.PROMOTE_DRY_RUN || (config.write ? "false" : "true");
const AUTO_PROMOTE = process.env.AUTO_PROMOTE || "false";
const REQUIRE_APPROVED_SOURCE = process.env.REQUIRE_APPROVED_SOURCE || "true";

function now() {
  return new Date().toISOString();
}

function ensureLockDir() {
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
}

function lockPath(jobName) {
  return path.join(LOCK_DIR, `${jobName.replace(/[^a-z0-9_-]/gi, "_")}.lock`);
}

function lockIsStale(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MINUTES * 60 * 1000;
  } catch {
    return false;
  }
}

function acquireLock(jobName) {
  ensureLockDir();
  const filePath = lockPath(jobName);
  if (fs.existsSync(filePath)) {
    if (lockIsStale(filePath)) {
      console.warn(`[${now()}] Removing stale lock ${filePath}.`);
      fs.unlinkSync(filePath);
    } else {
      return null;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify({ job_name: jobName, pid: process.pid, started_at: now() }, null, 2));
  return filePath;
}

function runScript(jobName, script, env = {}, options = {}) {
  const lockFile = acquireLock(options.writeLock ? "db-write" : jobName);
  if (!lockFile) {
    console.log(`[${now()}] Skipping ${jobName}; matching lock is active.`);
    return;
  }

  console.log(`\n[${now()}] Running ${jobName}: ${script}`);

  try {
    const result = spawnSync(process.execPath, [script], {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        DB_FILE,
        ...env
      }
    });

    if (result.error) console.error(`[${now()}] ${script} failed:`, result.error.message);
    if (result.status !== 0) console.error(`[${now()}] ${script} exited with code ${result.status}`);
  } finally {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  }
}

function every(minutes, jobName, script, env, options = {}) {
  if (!minutes || minutes < 1) return;
  const ms = minutes * 60 * 1000;
  setInterval(() => runScript(jobName, script, env, options), ms);
}

console.log("BuildWise scheduler started.");
console.log({
  DB_FILE,
  TRACKER_EVERY_MINUTES,
  PROMOTE_EVERY_MINUTES,
  DISCOVERY_EVERY_MINUTES,
  GROUP_EVERY_MINUTES,
  PRODUCTION_SYNC_EVERY_MINUTES,
  TRACKER_MAX_OFFERS,
  TRACKER_DRY_RUN,
  DISCOVERY_DRY_RUN,
  PROMOTE_DRY_RUN,
  AUTO_PROMOTE,
  REQUIRE_APPROVED_SOURCE,
  WRITE: config.write
});

// Run once on start.
if (RUN_ON_START) {
  runScript("validate", "validate_db.js", { MAX_OFFERS: "0" });
  runScript("group", "group_products.js", {});
  runScript("promote", "promote_candidates.js", { DRY_RUN: PROMOTE_DRY_RUN, AUTO_PROMOTE }, { writeLock: PROMOTE_DRY_RUN === "false" });
  runScript("tracker", "tracker_updated.js", { DRY_RUN: TRACKER_DRY_RUN, MAX_OFFERS: TRACKER_MAX_OFFERS, REQUIRE_APPROVED_SOURCE }, { writeLock: TRACKER_DRY_RUN === "false" });
}

// Scheduled runs.
every(TRACKER_EVERY_MINUTES, "tracker", "tracker_updated.js", { DRY_RUN: TRACKER_DRY_RUN, MAX_OFFERS: TRACKER_MAX_OFFERS, REQUIRE_APPROVED_SOURCE }, { writeLock: TRACKER_DRY_RUN === "false" });
every(PROMOTE_EVERY_MINUTES, "promote", "promote_candidates.js", { DRY_RUN: PROMOTE_DRY_RUN, AUTO_PROMOTE }, { writeLock: PROMOTE_DRY_RUN === "false" });
every(DISCOVERY_EVERY_MINUTES, "discovery", "discover_products.js", { DRY_RUN: DISCOVERY_DRY_RUN }, { writeLock: DISCOVERY_DRY_RUN === "false" });
every(GROUP_EVERY_MINUTES, "group", "group_products.js", {});
every(PRODUCTION_SYNC_EVERY_MINUTES, "production-sync", "pipeline_orchestrator.js", { PIPELINE_MODE: "production_sync" }, { writeLock: config.write });
