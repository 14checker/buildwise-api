const { URL } = require("url");
const core = require("./buildwise_backend_core");

function ensureGovernanceTables(db) {
  db.data_sources = Array.isArray(db.data_sources) ? db.data_sources : [];
  db.source_request_log = Array.isArray(db.source_request_log) ? db.source_request_log : [];
  db.source_compliance_log = Array.isArray(db.source_compliance_log) ? db.source_compliance_log : [];
  db.source_terms_reviews = Array.isArray(db.source_terms_reviews) ? db.source_terms_reviews : [];
}

function normalizeHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function nextId(rows, field, prefix, width) {
  let max = 0;
  for (const row of rows || []) {
    const value = row?.[field];
    if (!value || typeof value !== "string") continue;
    const match = value.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

function findSourceForUrl(db, url, retailerId = null) {
  ensureGovernanceTables(db);
  const host = normalizeHost(url);
  if (!host) return null;

  const activeSources = db.data_sources.filter(source => core.normalizeKey(source.active || true) !== "false");

  return activeSources.find(source => {
    const sourceDomain = String(source.base_domain || "").toLowerCase().replace(/^www\./, "");
    if (retailerId && source.retailer_id && source.retailer_id === retailerId) return true;
    if (sourceDomain && (host === sourceDomain || host.endsWith(`.${sourceDomain}`))) return true;
    return false;
  }) || null;
}

function requestsWithinLastHour(db, sourceId) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return db.source_request_log.filter(row => {
    if (row.source_id !== sourceId) return false;
    const t = new Date(row.requested_at || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  }).length;
}

function logCompliance(db, payload) {
  ensureGovernanceTables(db);
  const row = {
    compliance_log_id: nextId(db.source_compliance_log, "compliance_log_id", "sclog", 6),
    source_id: payload.source_id || null,
    retailer_id: payload.retailer_id || null,
    url: payload.url || null,
    action: payload.action || "checked",
    status: payload.status || "info",
    message: String(payload.message || "").slice(0, 1000),
    created_at: core.nowBase44DateTime()
  };
  db.source_compliance_log.push(row);
  return row;
}

function logRequest(db, payload) {
  ensureGovernanceTables(db);
  const row = {
    request_log_id: nextId(db.source_request_log, "request_log_id", "req", 8),
    source_id: payload.source_id || null,
    retailer_id: payload.retailer_id || null,
    url: payload.url || null,
    request_type: payload.request_type || "scrape",
    status: payload.status || "attempted",
    requested_at: core.nowBase44DateTime()
  };
  db.source_request_log.push(row);
  return row;
}

function evaluateScrapePermission(db, { url, retailer_id, request_type = "scrape", requireApprovedSource = false }) {
  ensureGovernanceTables(db);

  if (!url) {
    return { allowed: false, reason: "missing_url", source: null };
  }

  const source = findSourceForUrl(db, url, retailer_id);

  if (!source) {
    const allowed = !requireApprovedSource;
    return {
      allowed,
      reason: allowed ? "unregistered_source_allowed_by_config" : "unregistered_source_blocked",
      source: null
    };
  }

  const active = core.normalizeKey(source.active || true) !== "false";
  if (!active) return { allowed: false, reason: "source_inactive", source };

  const termsStatus = core.normalizeKey(source.terms_status || "needs_review");
  if (["blocked", "rejected", "do_not_use"].includes(termsStatus)) {
    return { allowed: false, reason: `source_terms_${termsStatus}`, source };
  }

  if (requireApprovedSource && termsStatus !== "approved") {
    return { allowed: false, reason: `source_not_approved_${termsStatus || "unknown"}`, source };
  }

  const allowedUse = core.normalizeKey(source.allowed_use || "");
  if (allowedUse && !allowedUse.includes(request_type) && !allowedUse.includes("all")) {
    return { allowed: false, reason: `source_use_not_allowed_${request_type}`, source };
  }

  const maxPerHour = Number(source.rate_limit_per_hour || 0);
  if (maxPerHour > 0 && requestsWithinLastHour(db, source.source_id) >= maxPerHour) {
    return { allowed: false, reason: "source_rate_limit_exceeded", source };
  }

  return { allowed: true, reason: "allowed", source };
}

module.exports = {
  ensureGovernanceTables,
  findSourceForUrl,
  evaluateScrapePermission,
  logCompliance,
  logRequest,
  normalizeHost
};
