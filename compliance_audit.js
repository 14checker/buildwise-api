const core = require("./buildwise_backend_core");
const governance = require("./source_governance");

const DB_FILE = process.env.DB_FILE || "db.json";

function main() {
  const db = core.readDb(DB_FILE);
  governance.ensureGovernanceTables(db);

  const issues = [];
  const warnings = [];

  for (const source of db.data_sources) {
    const status = core.normalizeKey(source.terms_status || "needs_review");
    if (!source.source_id) issues.push("A data_sources row is missing source_id.");
    if (!source.source_name) warnings.push(`${source.source_id} is missing source_name.`);
    if (!["approved", "needs_review", "blocked", "restricted", "deprecated"].includes(status)) {
      warnings.push(`${source.source_id} has unusual terms_status=${source.terms_status}`);
    }
    if (status !== "approved" && core.normalizeKey(source.active || true) !== "false") {
      warnings.push(`${source.source_id} is active but terms_status=${source.terms_status || "needs_review"}.`);
    }
    if (source.requires_affiliate_disclosure === true && !db.affiliate_disclosure_config) {
      warnings.push(`${source.source_id} requires affiliate disclosure but affiliate_disclosure_config is missing.`);
    }
  }

  const offers = db.retailer_offers || [];
  let unregisteredUrls = 0;
  let blockedByCompliance = 0;

  for (const offer of offers) {
    const url = core.getScrapeUrl(offer);
    if (!url) continue;

    const evalResult = governance.evaluateScrapePermission(db, {
      url,
      retailer_id: offer.retailer_id,
      request_type: "pricing",
      requireApprovedSource: true
    });

    if (!evalResult.source) unregisteredUrls++;
    if (!evalResult.allowed) blockedByCompliance++;
  }

  const summary = {
    data_sources: db.data_sources.length,
    source_request_log: db.source_request_log.length,
    source_compliance_log: db.source_compliance_log.length,
    source_terms_reviews: db.source_terms_reviews.length,
    offers_with_unregistered_urls: unregisteredUrls,
    offers_blocked_in_strict_mode: blockedByCompliance,
    issues: issues.length,
    warnings: warnings.length
  };

  console.log("BuildWise compliance audit summary:");
  console.log(summary);

  if (issues.length) {
    console.log("\nIssues:");
    for (const issue of issues) console.log(`- ${issue}`);
  }

  if (warnings.length) {
    console.log("\nWarnings:");
    for (const warning of warnings.slice(0, 75)) console.log(`- ${warning}`);
    if (warnings.length > 75) console.log(`...and ${warnings.length - 75} more warnings.`);
  }

  if (issues.length) process.exit(1);
}

main();
