/**
 * BuildWise purpose:
 * Centralize automated retailer ingestion configuration and write-safety checks.
 *
 * Plain-English summary:
 * This file turns environment variables into one predictable config object so production sync does not scatter dry-run and write rules across scripts.
 *
 * Safety note:
 * Automatic promotion and database writes are blocked unless the required explicit flags are set together.
 */
function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(normalizeKey(value));
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envList(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return String(value)
    .split(/[,\n;]/g)
    .map(item => item.trim())
    .filter(Boolean);
}

function loadIngestionConfig(overrides = {}) {
  const write = envFlag("WRITE", false);
  const autoPromote = envFlag("AUTO_PROMOTE", false);
  return {
    dbFile: process.env.DB_FILE || "db.json",
    pipelineMode: process.env.PIPELINE_MODE || "safe_daily",
    write,
    autoPromote,
    autoPromoteExact: envFlag("AUTO_PROMOTE_EXACT", true),
    autoPromoteStrong: envFlag("AUTO_PROMOTE_STRONG", true),
    autoPromoteMinScore: envNumber("AUTO_PROMOTE_MIN_SCORE", 90),
    allowProvisionalPublic: envFlag("ALLOW_PROVISIONAL_PUBLIC", false),
    allowMarketplace: envFlag("ALLOW_MARKETPLACE", false),
    allowRefurbished: envFlag("ALLOW_REFURBISHED", false),
    discoveryDryRun: envFlag("DISCOVERY_DRY_RUN", !write),
    discoveryMode: normalizeKey(process.env.DISCOVERY_MODE || "auto"),
    promoteDryRun: envFlag("PROMOTE_DRY_RUN", !write),
    trackerDryRun: envFlag("TRACKER_DRY_RUN", !write),
    discoveryMaxProducts: envNumber("DISCOVERY_MAX_PRODUCTS", 25),
    discoveryTargetOffersPerProduct: envNumber("DISCOVERY_TARGET_OFFERS_PER_PRODUCT", 3),
    discoveryRetailers: envList("DISCOVERY_RETAILERS"),
    discoveryStaleHours: envNumber("DISCOVERY_STALE_HOURS", 24 * 30),
    discoveryCategory: process.env.DISCOVERY_CATEGORY || "",
    discoveryProductId: process.env.DISCOVERY_PRODUCT_ID || "",
    discoveryRetailerId: process.env.DISCOVERY_RETAILER_ID || "",
    discoveryCandidateFile: process.env.DISCOVERY_CANDIDATE_FILE || "",
    discoverySearchFixtureDir: process.env.DISCOVERY_SEARCH_FIXTURE_DIR || "",
    discoverySearchProviderFile: process.env.DISCOVERY_SEARCH_PROVIDER_FILE || "",
    discoveryMaxQueriesPerProduct: envNumber("DISCOVERY_MAX_QUERIES_PER_PRODUCT", 4),
    discoveryMaxCandidatesPerQuery: envNumber("DISCOVERY_MAX_CANDIDATES_PER_QUERY", 5),
    allowLiveFetch: envFlag("INGESTION_ALLOW_LIVE_FETCH", false),
    httpTimeoutMs: envNumber("HTTP_TIMEOUT_MS", 15000),
    httpMaxRetries: envNumber("HTTP_MAX_RETRIES", 2),
    httpRetryBaseMs: envNumber("HTTP_RETRY_BASE_MS", 500),
    httpMaxConcurrency: envNumber("HTTP_MAX_CONCURRENCY", 2),
    httpUserAgent: process.env.HTTP_USER_AGENT || "BuildWiseIngestion/0.1 contact: support@buildwise-pc.com",
    retailerRequestDelayMs: envNumber("RETAILER_REQUEST_DELAY_MS", 1000),
    ...overrides
  };
}

function validateIngestionConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.autoPromote && !config.write) {
    errors.push("AUTO_PROMOTE=true requires WRITE=true.");
  }
  if (!["auto", "file", "hybrid"].includes(normalizeKey(config.discoveryMode))) {
    errors.push("DISCOVERY_MODE must be one of: auto, file, hybrid.");
  }
  if (normalizeKey(config.discoveryMode) === "file" && !config.discoveryCandidateFile) {
    errors.push("DISCOVERY_MODE=file requires DISCOVERY_CANDIDATE_FILE.");
  }
  if (config.pipelineMode === "production_sync" && config.write && config.discoveryDryRun && config.trackerDryRun && config.promoteDryRun) {
    warnings.push("production_sync is write-enabled, but discovery, tracker, and promote stages are all dry-run.");
  }
  if (config.autoPromote && config.autoPromoteMinScore < 80) {
    warnings.push("AUTO_PROMOTE_MIN_SCORE below 80 is not recommended for production.");
  }
  if (config.allowProvisionalPublic) {
    warnings.push("ALLOW_PROVISIONAL_PUBLIC weakens the public URL gate and should remain false for production.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = {
  envFlag,
  envList,
  envNumber,
  loadIngestionConfig,
  normalizeKey,
  validateIngestionConfig
};
