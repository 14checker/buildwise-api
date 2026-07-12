/**
 * BuildWise purpose:
 * Start the production ingestion pipeline with platform-safe environment defaults.
 *
 * Plain-English summary:
 * This wrapper lets Windows, macOS, Linux, and GitHub Actions run the same production pipeline command.
 *
 * Safety note:
 * The --dry-run flag forces mutation-capable stages into dry-run mode and clears WRITE.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const dryRun = process.argv.includes("--dry-run");
const env = {
  ...process.env,
  PIPELINE_MODE: process.env.PIPELINE_MODE || "production_sync"
};

if (dryRun) {
  env.WRITE = "";
  env.DISCOVERY_DRY_RUN = "true";
  env.PROMOTE_DRY_RUN = "true";
  env.TRACKER_DRY_RUN = "true";
  env.ALERT_DRY_RUN = "true";
}

const result = spawnSync(process.execPath, [path.join(__dirname, "..", "pipeline_orchestrator.js")], {
  stdio: "inherit",
  shell: false,
  env
});

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status || 0;
}
