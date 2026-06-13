const fs = require("fs");
const path = require("path");

const DB_FILE = process.env.DB_FILE || "db.json";
const BACKUP_DIR = process.env.BACKUP_DIR || "backups";
const ROLLBACK_FILE = process.env.ROLLBACK_FILE || "";

function getBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter(file => file.endsWith(".json") && file.startsWith("db_backup_"))
    .sort()
    .map(file => path.join(BACKUP_DIR, file));
}

function main() {
  const backups = getBackups();

  if (!backups.length) {
    console.error(`No backups found in ${BACKUP_DIR}.`);
    process.exit(1);
  }

  const backupToRestore = ROLLBACK_FILE || backups[backups.length - 1];

  if (!fs.existsSync(backupToRestore)) {
    console.error(`Rollback file not found: ${backupToRestore}`);
    process.exit(1);
  }

  const preRollback = path.join(BACKUP_DIR, `pre_rollback_${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}.json`);
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, preRollback);

  fs.copyFileSync(backupToRestore, DB_FILE);

  console.log(`Restored ${DB_FILE} from ${backupToRestore}`);
  if (fs.existsSync(preRollback)) console.log(`Previous db preserved at ${preRollback}`);
}

main();
