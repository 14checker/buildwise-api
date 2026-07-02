/**
 * BuildWise purpose:
 * Compute public export counts, safety metrics, warnings, and database hashes.
 *
 * Plain-English summary:
 * This file keeps CSV, JSON, API status, and data-run reports speaking the same measurement language.
 *
 * Safety note:
 * Metrics may describe hidden internal data counts, but they must not expose raw records, secrets, affiliate URLs, or review metadata.
 */
const crypto = require("crypto");
const fs = require("fs");
const publicSerializers = require("./public_serializers");
const urlQuality = require("./url_quality");

const PUBLIC_TABLES = ["products", "retailer_offers", "retailers", "price_snapshots"];
const VERIFIED_URL_STATUSES = new Set(["verified_api", "verified_manual"]);
const VERIFIED_PRICE_STATUSES = new Set(["verified", "verified_api", "verified_manual"]);
const AFFILIATE_FIELDS = new Set(["affiliate_url"]);
const SOURCE_FIELDS = new Set(["source_url", "scrape_url", "price_source_url"]);
const INTERNAL_FIELDS = new Set([
  "url_status",
  "url_confidence",
  "url_verified_at",
  "url_verified_by",
  "url_verification_method",
  "url_review_notes",
  "source_terms_status",
  "scrape_errors",
  "admin_review_queue",
  "source_request_log",
  "source_compliance_log",
  "source_terms_reviews",
  "users",
  "watchlists",
  "price_alerts",
  "affiliate_clicks"
]);
const PUBLIC_PRICE_FIELDS = ["current_price", "availability", "condition", "seller_name", "last_scraped_at"];

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return normalizeKey(value) === "true";
}

function publicOptionsFromEnv(overrides = {}) {
  return {
    exportAffiliateUrls: false,
    exportUnverifiedOffers: envFlag("EXPORT_UNVERIFIED_OFFERS"),
    exportProductsWithoutVerifiedOffers: envFlag("EXPORT_PRODUCTS_WITHOUT_VERIFIED_OFFERS"),
    exportUnverifiedPrices: envFlag("EXPORT_UNVERIFIED_PRICES"),
    exportSeedPriceData: envFlag("EXPORT_SEED_PRICE_DATA"),
    ...overrides
  };
}

function hashFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
}

function rowsForPublicExports(db, options = {}) {
  return {
    products: publicSerializers.rowsForPublicTable(db, "products", options) || [],
    retailer_offers: publicSerializers.rowsForPublicTable(db, "retailer_offers", options) || [],
    retailers: publicSerializers.rowsForPublicTable(db, "retailers", options) || [],
    price_snapshots: publicSerializers.rowsForPublicTable(db, "price_snapshots", options) || []
  };
}

function hasVerifiedPriceStatus(row = {}) {
  return [
    row.price_status,
    row.snapshot_status,
    row.data_quality_status
  ].some(status => VERIFIED_PRICE_STATUSES.has(normalizeKey(status)));
}

function hasSeedOrDemoMarker(row = {}) {
  const sellerName = String(row.seller_name || "");
  return /buildwise seed|\bseed\b|\bdemo\b|\btest\b/i.test(sellerName);
}

function hasCurrentPrice(row = {}) {
  return row.current_price !== null && row.current_price !== undefined && row.current_price !== "";
}

function hasPublicPriceValue(row = {}) {
  return PUBLIC_PRICE_FIELDS.some(field => row[field] !== null && row[field] !== undefined && row[field] !== "");
}

function retailerById(db) {
  return new Map((db.retailers || []).map(retailer => [retailer.retailer_id, retailer]));
}

function isVerifiedPublicOffer(offer, retailer) {
  if (!VERIFIED_URL_STATUSES.has(normalizeKey(offer?.url_status))) return false;
  return publicSerializers.isPublicSafeOffer(offer, retailer);
}

function countVerifiedOffers(db) {
  const retailersById = retailerById(db);
  return (db.retailer_offers || []).filter(offer => {
    return isVerifiedPublicOffer(offer, retailersById.get(offer.retailer_id) || {});
  }).length;
}

function countVerifiedProducts(db) {
  const retailersById = retailerById(db);
  const productIds = new Set(
    (db.retailer_offers || [])
      .filter(offer => isVerifiedPublicOffer(offer, retailersById.get(offer.retailer_id) || {}))
      .map(offer => offer.product_id)
      .filter(Boolean)
  );
  return productIds.size;
}

function countHiddenPlaceholderOffers(db) {
  const retailersById = retailerById(db);
  return (db.retailer_offers || []).filter(offer => {
    const issue = urlQuality.getUrlQualityIssue(offer.retailer_product_url, {
      retailerId: offer.retailer_id,
      retailer: retailersById.get(offer.retailer_id) || {}
    });
    return Boolean(issue);
  }).length;
}

function countHiddenSeedPrices(db) {
  return (db.retailer_offers || []).filter(offer => {
    if (!hasCurrentPrice(offer)) return false;
    return hasSeedOrDemoMarker(offer) || !hasVerifiedPriceStatus(offer);
  }).length;
}

function rowsContainFields(rows, fields) {
  return Object.values(rows || {}).some(tableRows => {
    return (tableRows || []).some(row => {
      return Object.keys(row || {}).some(key => fields.has(key));
    });
  });
}

function pricesVisible(rows) {
  return (rows.retailer_offers || []).some(hasPublicPriceValue);
}

function seedPricesExposed(db, rows) {
  const offersById = new Map((db.retailer_offers || []).map(offer => [offer.retailer_offer_id, offer]));
  return (rows.retailer_offers || []).some(row => {
    if (!hasPublicPriceValue(row)) return false;
    const offer = offersById.get(row.retailer_offer_id) || {};
    return hasSeedPriceData(offer) || !hasVerifiedPriceStatus(offer);
  });
}

function unverifiedUrlsExposed(db, rows) {
  const retailersById = retailerById(db);
  const offersById = new Map((db.retailer_offers || []).map(offer => [offer.retailer_offer_id, offer]));
  return (rows.retailer_offers || []).some(row => {
    const offer = offersById.get(row.retailer_offer_id);
    return !offer || !isVerifiedPublicOffer(offer, retailersById.get(offer.retailer_id) || {});
  });
}

function buildPublicSafety(db, rows = rowsForPublicExports(db, publicOptionsFromEnv())) {
  const rawDbExposed = false;
  const affiliateUrlExposed = rowsContainFields(rows, AFFILIATE_FIELDS);
  const sourceUrlExposed = rowsContainFields(rows, SOURCE_FIELDS);
  const internalFieldsExposed = rowsContainFields(rows, INTERNAL_FIELDS);
  const seedPriceExposed = seedPricesExposed(db, rows);
  const unverifiedUrlExposed = unverifiedUrlsExposed(db, rows);
  const publicExportSafe = !(
    rawDbExposed ||
    affiliateUrlExposed ||
    sourceUrlExposed ||
    internalFieldsExposed ||
    seedPriceExposed ||
    unverifiedUrlExposed
  );

  return {
    raw_db_exposed: rawDbExposed,
    affiliate_url_exposed: affiliateUrlExposed,
    source_url_exposed: sourceUrlExposed,
    internal_fields_exposed: internalFieldsExposed,
    seed_prices_exposed: seedPriceExposed,
    unverified_urls_exposed: unverifiedUrlExposed,
    public_export_safe: publicExportSafe
  };
}

function buildBase44Readiness(safety, options = {}) {
  const csvExportSucceeded = options.csvExportSucceeded !== false;
  const jsonExportSucceeded = options.jsonExportSucceeded !== false;
  const apiSmokePassed = Boolean(options.apiSmokePassed);
  const ready = Boolean(csvExportSucceeded && jsonExportSucceeded && safety.public_export_safe);

  return {
    base44_ready: ready,
    base44_update_mode: ready ? (apiSmokePassed ? "api_ready" : "csv_ready") : "blocked",
    base44_should_pull: ready,
    base44_blocked_reason: ready ? null : "public_export_safety_or_export_failure"
  };
}

function publicStatusValue(warnings, safety) {
  if (!safety.public_export_safe) return "FAILED";
  if ((warnings || []).length) return "PASS_WITH_WARNINGS";
  return "PASS";
}

function unsafeReviewFlags() {
  return [
    "EXPORT_UNVERIFIED_OFFERS",
    "EXPORT_PRODUCTS_WITHOUT_VERIFIED_OFFERS",
    "EXPORT_UNVERIFIED_PRICES",
    "EXPORT_SEED_PRICE_DATA",
    "EXPORT_AFFILIATE_URLS"
  ].filter(name => envFlag(name));
}

function buildWarnings(db, rows, metrics) {
  const warnings = [];
  const flags = unsafeReviewFlags();

  if (flags.length) {
    warnings.push(`Unsafe review/export flags are enabled: ${flags.join(", ")}`);
  }
  if (metrics.hidden_placeholder_offer_count > 0) {
    warnings.push(`${metrics.hidden_placeholder_offer_count} offers are hidden because URLs are missing, placeholder, or not public-safe.`);
  }
  if (metrics.hidden_seed_price_count > 0) {
    warnings.push(`${metrics.hidden_seed_price_count} offer price fields are hidden because pricing is unverified or seed/demo data.`);
  }
  if ((db.price_snapshots || []).length > rows.price_snapshots.length) {
    warnings.push(`${(db.price_snapshots || []).length - rows.price_snapshots.length} price snapshots are hidden because price history is not verified.`);
  }

  return warnings;
}

function buildPublicStatus(db, options = {}) {
  const rows = rowsForPublicExports(db, options);
  const verifiedOfferCount = countVerifiedOffers(db);
  const verifiedProductCount = countVerifiedProducts(db);
  const hiddenPlaceholderOfferCount = countHiddenPlaceholderOffers(db);
  const hiddenSeedPriceCount = countHiddenSeedPrices(db);
  const totalOffers = (db.retailer_offers || []).length;

  const metrics = {
    generated_at: options.generatedAt || new Date().toISOString(),
    products_count: rows.products.length,
    retailer_offers_count: rows.retailer_offers.length,
    retailers_count: rows.retailers.length,
    price_snapshots_count: rows.price_snapshots.length,
    verified_offer_count: verifiedOfferCount,
    verified_product_count: verifiedProductCount,
    hidden_unverified_offer_count: Math.max(0, totalOffers - verifiedOfferCount),
    hidden_placeholder_offer_count: hiddenPlaceholderOfferCount,
    hidden_seed_price_count: hiddenSeedPriceCount,
    data_mode: unsafeReviewFlags().length ? "internal_review" : "production_safe",
    db_hash: options.dbHash || hashFile(options.dbFile),
    warnings: []
  };

  metrics.warnings = buildWarnings(db, rows, metrics);
  const safety = buildPublicSafety(db, rows);
  const readiness = buildBase44Readiness(safety, options);
  metrics.warnings_count = metrics.warnings.length;
  metrics.status = publicStatusValue(metrics.warnings, safety);
  metrics.base44_ready = readiness.base44_ready;
  metrics.base44_update_mode = readiness.base44_update_mode;
  metrics.base44_should_pull = readiness.base44_should_pull;
  metrics.base44_blocked_reason = readiness.base44_blocked_reason;
  return metrics;
}

module.exports = {
  PUBLIC_TABLES,
  buildBase44Readiness,
  buildPublicSafety,
  buildPublicStatus,
  hashFile,
  pricesVisible,
  publicOptionsFromEnv,
  rowsForPublicExports
};
