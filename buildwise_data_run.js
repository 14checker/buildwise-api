/**
 * BuildWise purpose:
 * Run a safe reporting pass for the current public data state.
 *
 * Plain-English summary:
 * This file creates CSV exports, JSON exports, local reports, and an optional email summary for review.
 *
 * Safety note:
 * It does not scrape, import URLs, use WRITE=true, or mutate db.json; email only sends when SMTP settings are present.
 */
const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");
const base44Export = require("./export_base44_tables");
const publicJsonExport = require("./export_public_json");
const publicDataMetrics = require("./public_data_metrics");

const DB_FILE = process.env.DB_FILE || "db.json";
const REPORT_DIR = process.env.BUILDWISE_REPORT_DIR || "buildwise_reports";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function reportStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function countSeedSellerOffers(db) {
  return (db.retailer_offers || []).filter(offer => {
    return /buildwise seed|\bseed\b|\bdemo\b|\btest\b/i.test(String(offer.seller_name || ""));
  }).length;
}

function nextRecommendedAction(status) {
  if (status.verified_offer_count < 25) {
    return "Continue the supervised AMD Ryzen URL pilot in small reviewed batches.";
  }
  if (status.hidden_seed_price_count > 0) {
    return "Add verified price-source metadata before publishing prices or price history.";
  }
  return "Review public export counts and prepare the next launch-readiness batch.";
}

function reportText(report) {
  return [
    "BuildWise Data Run",
    `Generated: ${report.generated_at}`,
    `Data mode: ${report.data_mode}`,
    `DB hash: ${report.db_hash}`,
    "",
    "Public output:",
    `- Products public: ${report.public_products}`,
    `- Offers public: ${report.public_offers}`,
    `- Retailers public: ${report.public_retailers}`,
    `- Price snapshots public: ${report.public_price_snapshots}`,
    "",
    "Catalog safety metrics:",
    `- Total products: ${report.total_products}`,
    `- Total retailer offers: ${report.total_retailer_offers}`,
    `- Verified products: ${report.verified_products}`,
    `- Verified offers: ${report.verified_offers}`,
    `- Hidden unverified offers: ${report.hidden_unverified_offers}`,
    `- Hidden placeholder offers: ${report.hidden_placeholder_offers}`,
    `- Offers with seed/demo seller_name: ${report.offers_with_seed_demo_seller_name}`,
    `- Hidden seed/demo prices: ${report.hidden_seed_demo_prices}`,
    "",
    "Export status:",
    `- CSV output: ${report.exports.csv.output_dir}`,
    `- JSON output: ${report.exports.json.output_dir}`,
    "",
    "Warnings:",
    ...(report.warnings.length ? report.warnings.map(warning => `- ${warning}`) : ["- None"]),
    "",
    `Next recommended action: ${report.next_recommended_action}`
  ].join("\n");
}

function smtpMissingVars() {
  return [
    "BUILDWISE_REPORT_EMAIL",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM"
  ].filter(name => !process.env[name]);
}

async function sendEmailIfConfigured(report) {
  const missing = smtpMissingVars();
  if (missing.length) {
    console.log("email skipped: missing SMTP config");
    return { sent: false, reason: "missing SMTP config", missing };
  }

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (error) {
    console.warn("email skipped: nodemailer dependency is not installed. Run npm install before enabling SMTP reports.");
    return { sent: false, reason: "nodemailer_missing" };
  }

  const port = Number(process.env.SMTP_PORT);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const subject = `BuildWise Data Run - ${report.verified_offers} verified offers, ${report.warnings.length} warnings`;
  await transporter.sendMail({
    to: process.env.BUILDWISE_REPORT_EMAIL,
    from: process.env.SMTP_FROM,
    subject,
    text: reportText(report)
  });

  console.log("email sent: BuildWise data-run summary");
  return { sent: true, to: process.env.BUILDWISE_REPORT_EMAIL, subject };
}

async function runDataRun(options = {}) {
  const dbFile = options.dbFile || DB_FILE;
  const reportDir = options.reportDir || REPORT_DIR;
  const db = options.db || core.readDb(dbFile);
  const publicOptions = publicDataMetrics.publicOptionsFromEnv();
  const status = publicDataMetrics.buildPublicStatus(db, {
    ...publicOptions,
    dbFile
  });

  const csvExport = base44Export.runExport({
    db,
    dbFile,
    writeEnabled: false,
    publicOptions
  });
  const jsonExport = publicJsonExport.runExport({
    db,
    dbFile,
    publicOptions
  });

  const report = {
    generated_at: status.generated_at,
    data_mode: status.data_mode,
    db_hash: status.db_hash,
    total_products: (db.products || []).length,
    total_retailer_offers: (db.retailer_offers || []).length,
    verified_products: status.verified_product_count,
    verified_offers: status.verified_offer_count,
    hidden_unverified_offers: status.hidden_unverified_offer_count,
    hidden_placeholder_offers: status.hidden_placeholder_offer_count,
    offers_with_seed_demo_seller_name: countSeedSellerOffers(db),
    hidden_seed_demo_prices: status.hidden_seed_price_count,
    public_products: status.products_count,
    public_offers: status.retailer_offers_count,
    public_retailers: status.retailers_count,
    public_price_snapshots: status.price_snapshots_count,
    warnings: status.warnings,
    exports: {
      csv: {
        output_dir: csvExport.output_dir,
        tables: csvExport.exported
      },
      json: {
        output_dir: jsonExport.output_dir,
        files: jsonExport.files
      }
    },
    next_recommended_action: nextRecommendedAction(status),
    email: null
  };

  report.email = await sendEmailIfConfigured(report);

  ensureDir(reportDir);
  const stamp = reportStamp();
  const jsonPath = path.join(reportDir, `data_run_${stamp}.json`);
  const textPath = path.join(reportDir, `data_run_${stamp}.txt`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(textPath, `${reportText(report)}\n`, "utf8");

  console.log("BuildWise data run complete.");
  console.log({
    json_report: jsonPath,
    text_report: textPath,
    products_public: report.public_products,
    offers_public: report.public_offers,
    retailers_public: report.public_retailers,
    price_snapshots_public: report.public_price_snapshots,
    verified_offers: report.verified_offers,
    warnings: report.warnings
  });

  return { report, json_report: jsonPath, text_report: textPath };
}

async function main() {
  await runDataRun();
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  runDataRun
};
