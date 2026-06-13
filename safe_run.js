const { spawnSync } = require("child_process");

const script = process.argv[2];
const args = process.argv.slice(3);
const SKIP_BACKUP = String(process.env.SKIP_BACKUP || "false").toLowerCase() === "true";
const SKIP_POST_AUDIT = String(process.env.SKIP_POST_AUDIT || "false").toLowerCase() === "true";

function run(label, commandArgs, allowFail = false) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync("node", commandArgs, {
    stdio: "inherit",
    shell: true,
    env: process.env
  });

  if (result.error) {
    console.error(result.error.message);
    if (!allowFail) process.exit(1);
  }

  if (result.status !== 0 && !allowFail) {
    console.error(`${label} failed with exit code ${result.status}.`);
    process.exit(result.status || 1);
  }

  return result.status;
}

function main() {
  if (!script) {
    console.error("Usage: node .\\safe_run.js <script.js>");
    console.error("Example: node .\\safe_run.js tracker_updated.js");
    process.exit(1);
  }

  if (!SKIP_BACKUP) run("Backup", ["backup_db.js"]);
  run("Pre-audit", ["audit_db.js"], true);
  run(`Run ${script}`, [script, ...args]);
  if (!SKIP_POST_AUDIT) run("Post-audit", ["audit_db.js"], true);

  console.log("\nSafe run complete.");
}

main();
