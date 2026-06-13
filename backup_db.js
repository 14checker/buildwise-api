const fs = require("fs");
const path = require("path");

const DB_FILE = process.env.DB_FILE || "db.json";
const BACKUP_DIR = process.env.BACKUP_DIR || "backups";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`Missing database file: ${DB_FILE}`);
    process.exit(1);
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const backupFile = path.join(BACKUP_DIR, `db_backup_${stamp()}.json`);
  fs.copyFileSync(DB_FILE, backupFile);

  console.log(`Backup created: ${backupFile}`);
}

main();
