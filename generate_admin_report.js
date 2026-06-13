const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const REPORT_DIR = process.env.REPORT_DIR || "buildwise_reports";

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function esc(value) { return String(value ?? "").replace(/[&<>]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[ch])); }

function main() {
  const db = core.readDb(DB_FILE);
  ensureDir(REPORT_DIR);

  const queue = Array.isArray(db.product_insert_queue) ? db.product_insert_queue : [];
  const pending = queue.filter(row => ["pending", "new_row_candidate", "needs_review", "review"].includes(core.normalizeKey(row.review_status || row.status))).slice(0, 50);
  const errors = (db.scrape_errors || []).slice(-50).reverse();
  const summary = core.getSummary(db);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>BuildWise Admin Report</title>
<style>body{font-family:Arial,sans-serif;margin:24px;}table{border-collapse:collapse;width:100%;margin-bottom:24px;}td,th{border:1px solid #ddd;padding:8px;text-align:left;}th{background:#f4f4f4;}code{background:#eee;padding:2px 4px;}</style></head>
<body>
<h1>BuildWise Admin Report</h1>
<p>Generated: ${esc(core.nowBase44DateTime())}</p>
<h2>Summary</h2>
<table><tbody>${Object.entries(summary).map(([k,v])=>`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
<h2>Pending Candidate Queue</h2>
<table><thead><tr><th>Product ID</th><th>Category</th><th>Brand</th><th>Model</th><th>Status</th></tr></thead><tbody>${pending.map(row=>`<tr><td>${esc(row.product_id)}</td><td>${esc(row.category_id)}</td><td>${esc(row.brand)}</td><td>${esc(row.model)}</td><td>${esc(row.review_status || row.status)}</td></tr>`).join("")}</tbody></table>
<h2>Recent Scrape Errors</h2>
<table><thead><tr><th>When</th><th>Offer</th><th>Retailer</th><th>Type</th><th>Message</th></tr></thead><tbody>${errors.map(row=>`<tr><td>${esc(row.occurred_at)}</td><td>${esc(row.retailer_offer_id)}</td><td>${esc(row.retailer_id)}</td><td>${esc(row.error_type)}</td><td>${esc(row.message)}</td></tr>`).join("")}</tbody></table>
</body></html>`;

  const file = path.join(REPORT_DIR, `admin_report_${new Date().toISOString().replace(/[:.]/g,"-").slice(0,19)}.html`);
  fs.writeFileSync(file, html);
  console.log(`Admin report written to: ${file}`);
}

main();
