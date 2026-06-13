const { spawnSync } = require("child_process");

const DB_FILE = process.env.DB_FILE || "db.json";
const TRACKER_EVERY_MINUTES = Number(process.env.TRACKER_EVERY_MINUTES || 15);
const PROMOTE_EVERY_MINUTES = Number(process.env.PROMOTE_EVERY_MINUTES || 15);
const DISCOVERY_EVERY_MINUTES = Number(process.env.DISCOVERY_EVERY_MINUTES || 240);
const GROUP_EVERY_MINUTES = Number(process.env.GROUP_EVERY_MINUTES || 240);

const TRACKER_MAX_OFFERS = process.env.TRACKER_MAX_OFFERS || "25";
const TRACKER_DRY_RUN = process.env.TRACKER_DRY_RUN || "false";
const DISCOVERY_DRY_RUN = process.env.DISCOVERY_DRY_RUN || "true";
const PROMOTE_DRY_RUN = process.env.PROMOTE_DRY_RUN || "false";
const AUTO_PROMOTE = process.env.AUTO_PROMOTE || "false";
const REQUIRE_APPROVED_SOURCE = process.env.REQUIRE_APPROVED_SOURCE || "false";

let running = false;

function now() {
  return new Date().toISOString();
}

function runScript(script, env = {}) {
  if (running) {
    console.log(`[${now()}] Skipping ${script}; another job is running.`);
    return;
  }

  running = true;
  console.log(`\n[${now()}] Running ${script}`);

  const result = spawnSync("node", [script], {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      DB_FILE,
      ...env
    }
  });

  if (result.error) console.error(`[${now()}] ${script} failed:`, result.error.message);
  if (result.status !== 0) console.error(`[${now()}] ${script} exited with code ${result.status}`);

  running = false;
}

function every(minutes, script, env) {
  const ms = minutes * 60 * 1000;
  setInterval(() => runScript(script, env), ms);
}

console.log("BuildWise scheduler started.");
console.log({
  DB_FILE,
  TRACKER_EVERY_MINUTES,
  PROMOTE_EVERY_MINUTES,
  DISCOVERY_EVERY_MINUTES,
  GROUP_EVERY_MINUTES,
  TRACKER_MAX_OFFERS,
  TRACKER_DRY_RUN,
  DISCOVERY_DRY_RUN,
  PROMOTE_DRY_RUN,
  AUTO_PROMOTE,
  REQUIRE_APPROVED_SOURCE
});

// Run once on start.
runScript("validate_db.js", { MAX_OFFERS: "0" });
runScript("group_products.js", {});
runScript("promote_candidates.js", { DRY_RUN: PROMOTE_DRY_RUN, AUTO_PROMOTE });
runScript("tracker_updated.js", { DRY_RUN: TRACKER_DRY_RUN, MAX_OFFERS: TRACKER_MAX_OFFERS, REQUIRE_APPROVED_SOURCE });

// Scheduled runs.
every(TRACKER_EVERY_MINUTES, "tracker_updated.js", { DRY_RUN: TRACKER_DRY_RUN, MAX_OFFERS: TRACKER_MAX_OFFERS, REQUIRE_APPROVED_SOURCE });
every(PROMOTE_EVERY_MINUTES, "promote_candidates.js", { DRY_RUN: PROMOTE_DRY_RUN, AUTO_PROMOTE });
every(DISCOVERY_EVERY_MINUTES, "discover_products.js", { DRY_RUN: DISCOVERY_DRY_RUN });
every(GROUP_EVERY_MINUTES, "group_products.js", {});
