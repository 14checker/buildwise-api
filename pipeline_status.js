const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const EXPORT_DIR = process.env.EXPORT_DIR || "buildwise_tracker_exports";
const BACKUP_DIR = process.env.BACKUP_DIR || "backups";

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).length;
}

function latestDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const items = fs.readdirSync(dir).map(name => ({ name, full: path.join(dir, name) })).filter(item => fs.statSync(item.full).isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));
  return items.length ? items[items.length - 1].name : null;
}

function main() {
  const db = core.readDb(DB_FILE);
  const summary = core.getSummary(db);

  const queue = Array.isArray(db.product_insert_queue) ? db.product_insert_queue : [];
  const pending = queue.filter(row => ["pending", "new_row_candidate", "needs_review", "review"].includes(core.normalizeKey(row.review_status || row.status))).length;
  const approved = queue.filter(row => ["approved", "approve"].includes(core.normalizeKey(row.review_status || row.status))).length;
  const promoted = queue.filter(row => ["promoted"].includes(core.normalizeKey(row.review_status || row.status))).length;

  console.log("BuildWise pipeline status:");
  console.log({
    ...summary,
    queue_pending: pending,
    queue_approved: approved,
    queue_promoted: promoted,
    backups_count: countFiles(BACKUP_DIR),
    export_runs_count: countFiles(EXPORT_DIR),
    latest_export_run: latestDir(EXPORT_DIR)
  });
}

main();
