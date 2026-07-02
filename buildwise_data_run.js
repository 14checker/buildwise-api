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
const { execFileSync } = require("child_process");
const core = require("./buildwise_backend_core");
const base44Export = require("./export_base44_tables");
const publicJsonExport = require("./export_public_json");
const publicDataMetrics = require("./public_data_metrics");

const DB_FILE = process.env.DB_FILE || "db.json";
const REPORT_DIR = process.env.BUILDWISE_REPORT_DIR || "buildwise_reports";
const DEFAULT_REPORT_EMAIL = "support@buildwise-pc.com";
const VALID_RUN_MODES = new Set([
  "audit_only",
  "review_prepare",
  "connector_check",
  "approved_import",
  "publish_ready_check"
]);
const VALID_AUTONOMY_LEVELS = new Set([
  "report_only",
  "prepare_reviews",
  "supervised_import",
  "full_auto_safe"
]);
const FUTURE_EVENT_TYPES = [
  "url_candidates_found",
  "approved_import_completed",
  "connector_check_completed",
  "price_update_completed",
  "public_export_blocked",
  "base44_ready_changed",
  "critical_safety_failure"
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function reportStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function secondsBetween(startedAt, finishedAt) {
  return Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

function envValue(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function safeGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function countSeedSellerOffers(db) {
  return (db.retailer_offers || []).filter(offer => {
    return /buildwise seed|\bseed\b|\bdemo\b|\btest\b/i.test(String(offer.seller_name || ""));
  }).length;
}

function countVerifiedPriceSnapshots(db) {
  return (db.price_snapshots || []).filter(snapshot => {
    return ["price_status", "snapshot_status", "data_quality_status"].some(field => {
      return ["verified", "verified_api", "verified_manual"].includes(normalizeKey(snapshot[field]));
    });
  }).length;
}

function modeConfig() {
  const requestedRunMode = normalizeKey(envValue("BUILDWISE_RUN_MODE", "audit_only"));
  const requestedAutonomyLevel = normalizeKey(envValue("BUILDWISE_AUTONOMY_LEVEL", "report_only"));
  const runMode = VALID_RUN_MODES.has(requestedRunMode) ? requestedRunMode : "audit_only";
  const autonomyLevel = VALID_AUTONOMY_LEVELS.has(requestedAutonomyLevel) ? requestedAutonomyLevel : "report_only";
  const configWarnings = [];
  const configCritical = [];
  const blockedReasons = [];

  if (!VALID_RUN_MODES.has(requestedRunMode)) {
    configWarnings.push(`Unknown BUILDWISE_RUN_MODE '${requestedRunMode}' defaulted to audit_only.`);
  }
  if (!VALID_AUTONOMY_LEVELS.has(requestedAutonomyLevel)) {
    configWarnings.push(`Unknown BUILDWISE_AUTONOMY_LEVEL '${requestedAutonomyLevel}' defaulted to report_only.`);
  }
  if (autonomyLevel === "full_auto_safe" && normalizeKey(process.env.BUILDWISE_ENABLE_FULL_AUTO_SAFE) !== "true") {
    blockedReasons.push("full_auto_safe_blocked_missing_enablement");
  }
  if (runMode === "approved_import") {
    if (normalizeKey(process.env.WRITE) !== "true") blockedReasons.push("approved_import_blocked_write_true_required");
    if (!process.env.URL_MATCH_IMPORT) blockedReasons.push("approved_import_blocked_import_file_required");
    configWarnings.push("approved_import mode is declared for future supervised imports; this data-run PR does not import URLs.");
  }
  if (runMode === "connector_check" && autonomyLevel === "report_only") {
    configWarnings.push("connector_check requested but blocked by report_only autonomy.");
  }

  return { runMode, autonomyLevel, configWarnings, configCritical, blockedReasons };
}

function actionPlan(runMode, autonomyLevel, smtpMissing) {
  const connectorAllowed = runMode === "connector_check" && ["prepare_reviews", "supervised_import"].includes(autonomyLevel);
  return {
    imports_attempted: false,
    imports_completed: false,
    review_files_created: false,
    connector_checks_ran: false,
    api_smoke_ran: false,
    csv_export_ran: true,
    json_export_ran: true,
    skipped_url_import_reason: "run_mode_not_approved_import",
    skipped_price_update_reason: "price_updates_not_enabled_for_daily_report",
    skipped_scraping_reason: "live_scraping_disabled_by_default",
    skipped_email_reason: smtpMissing.length ? "missing SMTP config" : null,
    skipped_publish_reason: "data_run_reports_readiness_only_base44_pulls_separately",
    skipped_connector_check_reason: connectorAllowed ? null : "autonomy_level_report_only"
  };
}

function buildConnectorSummary(actionState) {
  return {
    connector_checks_ran: actionState.connector_checks_ran,
    skipped_connector_check_reason: actionState.skipped_connector_check_reason,
    connectors: [],
    template: {
      retailer: null,
      credentials_present: false,
      source_terms_status: null,
      products_checked: 0,
      candidates_found: 0,
      high_confidence_matches: 0,
      needs_review_count: 0,
      rejected_count: 0,
      prices_verified: 0,
      urls_verified: 0,
      db_mutations: 0,
      next_review_file: null
    }
  };
}

function buildLiveEventSummary() {
  return {
    live_event_reporting_enabled: false,
    event_reports_emitted: [],
    future_event_types: FUTURE_EVENT_TYPES
  };
}

function diffNumber(current, previous, field) {
  if (!previous || typeof previous[field] !== "number") return null;
  return Number(current[field] || 0) - Number(previous[field] || 0);
}

function warningDelta(currentWarnings, previousWarnings) {
  const previousSet = new Set(previousWarnings || []);
  return (currentWarnings || []).filter(warning => !previousSet.has(warning));
}

function buildDeltas(summary, previous) {
  return {
    public_products_delta: diffNumber(summary, previous, "public_products_count"),
    public_offers_delta: diffNumber(summary, previous, "public_offers_count"),
    public_price_snapshots_delta: diffNumber(summary, previous, "public_price_snapshots_count"),
    verified_offers_delta: diffNumber(summary, previous, "verified_offers"),
    warnings_delta: previous ? warningDelta(summary.warnings, previous.warnings).length : null,
    db_hash_changed_since_last_run: previous ? summary.db_hash_after !== previous.db_hash_after : false,
    new_warnings: previous ? warningDelta(summary.warnings, previous.warnings) : summary.warnings
  };
}

function severityBuckets(summary, deltas, configCritical) {
  const info = [];
  const warnings = [...(summary.warnings || [])];
  const critical = [...configCritical];

  if (summary.actions.skipped_email_reason) info.push("email skipped because SMTP missing");
  if (!summary.public_price_snapshots_count) info.push("no price snapshots public because price data is unverified");
  if (summary.actions.skipped_connector_check_reason) info.push(`connector checks skipped because ${summary.actions.skipped_connector_check_reason}`);
  if (summary.actions.skipped_scraping_reason) info.push(`live scraping skipped because ${summary.actions.skipped_scraping_reason}`);

  if (deltas.public_offers_delta !== null && deltas.public_offers_delta < 0) warnings.push("public offer count decreased");
  if (deltas.verified_offers_delta !== null && deltas.verified_offers_delta < 0) warnings.push("verified offer count decreased");
  if (summary.run_mode === "audit_only" && summary.db_changed) warnings.push("db hash changed during audit_only mode");
  if (deltas.db_hash_changed_since_last_run && summary.run_mode === "audit_only") warnings.push("db hash changed since previous run in audit_only mode");

  if (summary.safety.raw_db_exposed) critical.push("raw db exposed");
  if (summary.safety.affiliate_url_exposed) critical.push("affiliate_url exposed publicly");
  if (summary.safety.source_url_exposed) critical.push("source_url exposed publicly");
  if (summary.safety.seed_prices_exposed) critical.push("seed prices exposed publicly");
  if (summary.safety.unverified_urls_exposed) critical.push("unverified URLs exposed publicly");
  if (summary.safety.internal_fields_exposed) critical.push("internal fields exposed publicly");
  if (summary.run_mode === "audit_only" && summary.db_changed) critical.push("db mutation occurred without approved mode");
  if (!summary.exports.csv.success) critical.push("public export failed");
  if (!summary.exports.json.success) critical.push("JSON export failed");

  return {
    info: [...new Set(info)],
    warnings: [...new Set(warnings)],
    critical: [...new Set(critical)]
  };
}

function computeOverallStatus(summary, severities, blockedReasons) {
  if (severities.critical.length) return "FAILED";
  if (blockedReasons.length) return "BLOCKED";
  if (summary.requires_human_review) return "NEEDS_REVIEW";
  if (severities.warnings.length) return "PASS_WITH_WARNINGS";
  return "PASS";
}

function base44Readiness(safety, csvSuccess, jsonSuccess, apiSmokeRan) {
  const ready = Boolean(csvSuccess && jsonSuccess && safety.public_export_safe);
  let mode = "blocked";
  if (ready && apiSmokeRan) mode = "api_ready";
  else if (ready) mode = "csv_ready";

  return {
    base44_ready: ready,
    base44_update_mode: mode,
    base44_should_pull: ready,
    base44_blocked_reason: ready ? null : "public_export_safety_or_export_failure"
  };
}

function requiredHumanReview(status) {
  const review = [];
  if (status.hidden_placeholder_offer_count > 0) {
    review.push("Continue reviewed URL verification batches for hidden placeholder/unverified offers.");
  }
  if (status.hidden_seed_price_count > 0) {
    review.push("Add verified price-source metadata before publishing prices or price history.");
  }
  return review;
}

function nextRecommendedAction(summary) {
  if (!summary.safety.public_export_safe) return "Block Base44 updates and inspect public export safety immediately.";
  if (summary.verified_offers < 25) return "Continue the supervised AMD Ryzen URL pilot in small reviewed batches.";
  if (summary.hidden_seed_price_count > 0) return "Add verified price-source metadata before publishing prices or price history.";
  return "Review public export counts and prepare the next launch-readiness batch.";
}

function buildMachineSummary(report) {
  return {
    run_id: report.run_id,
    status: report.status,
    run_mode: report.run_mode,
    autonomy_level: report.autonomy_level,
    db_changed: report.db_changed,
    public_products_count: report.public_products_count,
    public_offers_count: report.public_offers_count,
    public_retailers_count: report.public_retailers_count,
    public_price_snapshots_count: report.public_price_snapshots_count,
    base44_ready: report.base44_ready,
    base44_update_mode: report.base44_update_mode,
    base44_should_pull: report.base44_should_pull,
    warnings_count: report.warnings.length,
    critical_count: report.severity.critical.length,
    next_action: report.next_action,
    safe_to_update_base44: report.safe_to_update_base44
  };
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function reportText(report) {
  return [
    "BuildWise Data Run",
    "",
    "Executive summary",
    `BuildWise daily data run completed in ${report.run_mode}/${report.autonomy_level} mode with status ${report.status}. Public exports are ${report.safety.public_export_safe ? "safe" : "not safe"} for Base44. Database mutation ${report.db_changed ? "was detected" : "did not occur"}.`,
    "",
    "Run identity",
    `- Run ID: ${report.run_id}`,
    `- Started: ${report.run_started_at}`,
    `- Finished: ${report.run_finished_at}`,
    `- Duration seconds: ${report.duration_seconds}`,
    `- Git branch: ${report.git_branch || "unknown"}`,
    `- Git commit: ${report.git_commit || "unknown"}`,
    `- DB hash before: ${report.db_hash_before || "unknown"}`,
    `- DB hash after: ${report.db_hash_after || "unknown"}`,
    `- DB changed: ${yesNo(report.db_changed)}`,
    "",
    "Public data now",
    `- Products public: ${report.public_products_count}`,
    `- Retailer offers public: ${report.public_offers_count}`,
    `- Retailers public: ${report.public_retailers_count}`,
    `- Price snapshots public: ${report.public_price_snapshots_count}`,
    `- Prices visible: ${yesNo(report.prices_visible)}`,
    `- Price history visible: ${yesNo(report.price_history_visible)}`,
    "",
    "What changed since last run",
    `- Public products delta: ${report.deltas.public_products_delta ?? "n/a"}`,
    `- Public offers delta: ${report.deltas.public_offers_delta ?? "n/a"}`,
    `- Verified offers delta: ${report.deltas.verified_offers_delta ?? "n/a"}`,
    `- Price snapshots delta: ${report.deltas.public_price_snapshots_delta ?? "n/a"}`,
    `- DB hash changed: ${yesNo(report.deltas.db_hash_changed_since_last_run)}`,
    `- New warnings: ${report.deltas.new_warnings.length ? report.deltas.new_warnings.join("; ") : "none"}`,
    "",
    "Actions taken",
    `- CSV export: ${report.actions.csv_export_ran ? "ran" : "not run"}`,
    `- JSON export: ${report.actions.json_export_ran ? "ran" : "not run"}`,
    `- API smoke: ${report.actions.api_smoke_ran ? "ran" : "not run by data-run"}`,
    `- Email report: ${report.email.sent ? "sent" : "not sent"}`,
    `- Imports: ${report.actions.imports_attempted ? "attempted" : "not attempted"}`,
    `- Connector checks: ${report.actions.connector_checks_ran ? "ran" : "not run"}`,
    `- Review files: ${report.actions.review_files_created ? "created" : "not created"}`,
    "",
    "Actions skipped",
    `- URL import skipped because: ${report.actions.skipped_url_import_reason}`,
    `- Price update skipped because: ${report.actions.skipped_price_update_reason}`,
    `- Scraping skipped because: ${report.actions.skipped_scraping_reason}`,
    `- Connector checks skipped because: ${report.actions.skipped_connector_check_reason || "not skipped"}`,
    `- Email skipped because: ${report.actions.skipped_email_reason || "not skipped"}`,
    `- Publish skipped because: ${report.actions.skipped_publish_reason}`,
    "",
    "Safety checks",
    `- Raw db exposed: ${yesNo(report.safety.raw_db_exposed)}`,
    `- Affiliate URLs exposed: ${yesNo(report.safety.affiliate_url_exposed)}`,
    `- Source URLs exposed: ${yesNo(report.safety.source_url_exposed)}`,
    `- Internal metadata exposed: ${yesNo(report.safety.internal_fields_exposed)}`,
    `- Unverified URLs exposed: ${yesNo(report.safety.unverified_urls_exposed)}`,
    `- Seed prices exposed: ${yesNo(report.safety.seed_prices_exposed)}`,
    `- Public export safe: ${yesNo(report.safety.public_export_safe)}`,
    "",
    "Warnings",
    ...(report.warnings.length ? report.warnings.map(warning => `- ${warning}`) : ["- None"]),
    "",
    "Required human review",
    ...(report.human_review_items.length ? report.human_review_items.map(item => `- ${item}`) : ["- None blocking this daily run"]),
    "",
    "Base44 readiness",
    `- Base44 ready: ${yesNo(report.base44_ready)}`,
    `- Base44 update mode: ${report.base44_update_mode}`,
    `- Base44 should pull: ${yesNo(report.base44_should_pull)}`,
    `- Blocked reason: ${report.base44_blocked_reason || "none"}`,
    "",
    "Next recommended action",
    report.next_action,
    "",
    "Machine-readable summary",
    "```json",
    JSON.stringify(buildMachineSummary(report), null, 2),
    "```"
  ].join("\n");
}

function smtpMissingVars() {
  return [
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
    return { sent: false, reason: "missing SMTP config", missing, to: report.report_email };
  }

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    console.warn("email skipped: nodemailer dependency is not installed. Run npm install before enabling SMTP reports.");
    return { sent: false, reason: "nodemailer_missing", to: report.report_email };
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

  const subject = `BuildWise Data Run — ${report.status} — ${report.public_offers_count} public offers — ${report.warnings.length} warnings`;
  await transporter.sendMail({
    to: report.report_email,
    from: process.env.SMTP_FROM,
    subject,
    text: reportText(report)
  });

  console.log("email sent: BuildWise data-run summary");
  return { sent: true, to: report.report_email, subject };
}

async function runDataRun(options = {}) {
  const runStartedAt = new Date().toISOString();
  const runId = `data-run-${reportStamp(new Date(runStartedAt))}`;
  const { runMode, autonomyLevel, configWarnings, configCritical, blockedReasons } = modeConfig();
  const dbFile = options.dbFile || DB_FILE;
  const reportDir = options.reportDir || REPORT_DIR;
  const reportEmail = envValue("BUILDWISE_REPORT_EMAIL", DEFAULT_REPORT_EMAIL);
  const latestSummaryPath = path.join(reportDir, "latest_data_run_summary.json");
  const previousSummary = readJsonIfExists(latestSummaryPath);
  const dbHashBefore = publicDataMetrics.hashFile(dbFile);
  const db = options.db || core.readDb(dbFile);
  const publicOptions = publicDataMetrics.publicOptionsFromEnv();
  const initialStatus = publicDataMetrics.buildPublicStatus(db, {
    ...publicOptions,
    dbFile,
    generatedAt: runStartedAt
  });
  const actionState = actionPlan(runMode, autonomyLevel, smtpMissingVars());

  let csvExport = { output_dir: null, exported: [], success: false, error: null };
  let jsonExport = { output_dir: null, files: {}, success: false, error: null };

  try {
    const result = base44Export.runExport({ db, dbFile, writeEnabled: false, publicOptions });
    csvExport = { ...result, success: true, error: null };
  } catch (error) {
    csvExport = { output_dir: null, exported: [], success: false, error: error.message };
  }

  try {
    const result = publicJsonExport.runExport({ db, dbFile, publicOptions });
    jsonExport = { ...result, success: true, error: null };
  } catch (error) {
    jsonExport = { output_dir: null, files: {}, success: false, error: error.message };
  }

  const dbHashAfter = publicDataMetrics.hashFile(dbFile);
  const dbChanged = dbHashBefore !== dbHashAfter;
  const status = publicDataMetrics.buildPublicStatus(db, {
    ...publicOptions,
    dbFile,
    dbHash: dbHashAfter,
    generatedAt: new Date().toISOString()
  });
  const safety = publicDataMetrics.buildPublicSafety(db, publicDataMetrics.rowsForPublicExports(db, publicOptions));
  const readiness = base44Readiness(safety, csvExport.success, jsonExport.success, actionState.api_smoke_ran);
  const verifiedPriceSnapshots = countVerifiedPriceSnapshots(db);
  const runFinishedAt = new Date().toISOString();
  const humanReviewItems = [];
  const deltasBase = {
    public_products_count: status.products_count,
    public_offers_count: status.retailer_offers_count,
    public_price_snapshots_count: status.price_snapshots_count,
    verified_offers: status.verified_offer_count,
    db_hash_after: dbHashAfter,
    warnings: [...status.warnings, ...configWarnings]
  };
  const deltas = buildDeltas(deltasBase, previousSummary);

  const report = {
    run_id: runId,
    run_started_at: runStartedAt,
    run_finished_at: runFinishedAt,
    duration_seconds: secondsBetween(runStartedAt, runFinishedAt),
    run_mode: runMode,
    autonomy_level: autonomyLevel,
    report_email: reportEmail,
    git_branch: safeGit(["branch", "--show-current"]),
    git_commit: safeGit(["rev-parse", "HEAD"]),
    db_hash_before: dbHashBefore,
    db_hash_after: dbHashAfter,
    db_changed: dbChanged,
    data_mode: status.data_mode,
    total_products: (db.products || []).length,
    total_retailer_offers: (db.retailer_offers || []).length,
    verified_products: status.verified_product_count,
    verified_offers: status.verified_offer_count,
    hidden_unverified_offers: status.hidden_unverified_offer_count,
    hidden_placeholder_offers: status.hidden_placeholder_offer_count,
    offers_with_seed_price_data: countSeedSellerOffers(db),
    offers_with_seed_demo_seller_name: countSeedSellerOffers(db),
    hidden_seed_price_count: status.hidden_seed_price_count,
    hidden_seed_demo_prices: status.hidden_seed_price_count,
    unverified_price_snapshot_count: Math.max(0, (db.price_snapshots || []).length - verifiedPriceSnapshots),
    verified_price_snapshot_count: verifiedPriceSnapshots,
    public_products_count: status.products_count,
    public_offers_count: status.retailer_offers_count,
    public_retailers_count: status.retailers_count,
    public_price_snapshots_count: status.price_snapshots_count,
    public_products: status.products_count,
    public_offers: status.retailer_offers_count,
    public_retailers: status.retailers_count,
    public_price_snapshots: status.price_snapshots_count,
    prices_visible: publicDataMetrics.pricesVisible(publicDataMetrics.rowsForPublicExports(db, publicOptions)),
    price_history_visible: status.price_snapshots_count > 0,
    actions: actionState,
    exports: {
      csv: {
        success: csvExport.success,
        output_dir: csvExport.output_dir,
        tables: csvExport.exported,
        error: csvExport.error
      },
      json: {
        success: jsonExport.success,
        output_dir: jsonExport.output_dir,
        files: jsonExport.files,
        error: jsonExport.error
      }
    },
    safety,
    warnings: [...status.warnings, ...configWarnings],
    severity: null,
    deltas,
    human_review_items: humanReviewItems,
    requires_human_review: false,
    requires_credentials: runMode === "connector_check",
    connector_report: buildConnectorSummary(actionState),
    live_event_report: buildLiveEventSummary(),
    next_action: null,
    next_batch: "next supervised AMD Ryzen URL batch",
    safe_to_update_base44: readiness.base44_ready,
    ...readiness,
    email: null,
    status: null
  };

  report.human_review_items = humanReviewItems;
  report.next_action = nextRecommendedAction(report);
  report.severity = severityBuckets(report, deltas, configCritical);
  report.status = computeOverallStatus(report, report.severity, blockedReasons);
  report.base44_blocked_reason = report.base44_ready ? null : report.base44_blocked_reason;

  report.email = await sendEmailIfConfigured(report);
  report.actions.email_sent = report.email.sent;
  report.actions.skipped_email_reason = report.email.sent ? null : report.email.reason;

  ensureDir(reportDir);
  const stamp = reportStamp();
  const jsonPath = path.join(reportDir, `data_run_${stamp}.json`);
  const textPath = path.join(reportDir, `data_run_${stamp}.txt`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(textPath, `${reportText(report)}\n`, "utf8");
  fs.writeFileSync(latestSummaryPath, `${JSON.stringify({
    run_id: report.run_id,
    status: report.status,
    run_finished_at: report.run_finished_at,
    db_hash_after: report.db_hash_after,
    public_products_count: report.public_products_count,
    public_offers_count: report.public_offers_count,
    public_price_snapshots_count: report.public_price_snapshots_count,
    verified_offers: report.verified_offers,
    warnings: report.warnings,
    base44_ready: report.base44_ready,
    base44_update_mode: report.base44_update_mode
  }, null, 2)}\n`, "utf8");

  console.log("BuildWise data run complete.");
  console.log({
    run_id: report.run_id,
    status: report.status,
    run_mode: report.run_mode,
    autonomy_level: report.autonomy_level,
    json_report: jsonPath,
    text_report: textPath,
    latest_summary: latestSummaryPath,
    products_public: report.public_products_count,
    offers_public: report.public_offers_count,
    retailers_public: report.public_retailers_count,
    price_snapshots_public: report.public_price_snapshots_count,
    base44_ready: report.base44_ready,
    db_changed: report.db_changed,
    warnings: report.warnings
  });

  return { report, json_report: jsonPath, text_report: textPath, latest_summary: latestSummaryPath };
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
