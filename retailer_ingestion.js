/**
 * BuildWise purpose:
 * Run the controlled retailer ingestion workflow from candidate URLs to verified offers.
 *
 * Plain-English summary:
 * This file finds products that need retailer coverage, evaluates candidate retailer pages, scores the match, and only promotes safe matches when explicitly allowed.
 *
 * Safety note:
 * By default this is read-only. Database writes and automatic promotion require WRITE=true plus AUTO_PROMOTE=true.
 */
const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");
const { adapterForRetailer } = require("./retailer_adapters");
const { normalizeUrl } = require("./retailer_adapters/generic");
const verification = require("./candidate_verification");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(header => header.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function readJsonOrCsv(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return readCsv(filePath);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.candidates)) return parsed.candidates;
  throw new Error(`Candidate file must be an array or contain a candidates array: ${filePath}`);
}

function ensureIngestionTables(db) {
  if (!Array.isArray(db.retailer_url_candidates)) db.retailer_url_candidates = [];
  if (!Array.isArray(db.admin_review_queue)) db.admin_review_queue = [];
  if (!Array.isArray(db.system_events)) db.system_events = [];
  return db;
}

function productName(product = {}) {
  return [product.brand, product.model].filter(Boolean).join(" ").trim() || product.name || product.product_id || "";
}

function activeRetailers(db, config = {}) {
  const allowed = new Set((config.discoveryRetailers || []).map(normalizeKey));
  return (db.retailers || []).filter(retailer => {
    const active = retailer.active === undefined || retailer.active === true || normalizeKey(retailer.active) === "true";
    if (!active) return false;
    if (!adapterForRetailer(retailer)) return false;
    if (allowed.size && !allowed.has(normalizeKey(retailer.retailer_id)) && !allowed.has(normalizeKey(retailer.name))) return false;
    if (config.discoveryRetailerId && normalizeKey(config.discoveryRetailerId) !== normalizeKey(retailer.retailer_id)) return false;
    return true;
  });
}

function offerIsVerified(offer = {}) {
  return ["verified_api", "verified_manual"].includes(normalizeKey(offer.url_status));
}

function hoursSince(value) {
  if (!value) return Infinity;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return Infinity;
  return (Date.now() - time) / (60 * 60 * 1000);
}

function productNeedsCoverage(db, product, retailers, config = {}) {
  const offers = (db.retailer_offers || []).filter(offer => offer.product_id === product.product_id);
  const verifiedOffers = offers.filter(offerIsVerified);
  if (verifiedOffers.length < config.discoveryTargetOffersPerProduct) return true;
  return retailers.some(retailer => {
    const offer = offers.find(row => row.retailer_id === retailer.retailer_id && offerIsVerified(row));
    return !offer || hoursSince(offer.last_scraped_at || offer.url_verified_at) > config.discoveryStaleHours;
  });
}

function analyzeProductCoverage(db, config = {}) {
  const retailers = activeRetailers(db, config);
  let products = (db.products || []).filter(product => {
    if (config.discoveryProductId && product.product_id !== config.discoveryProductId) return false;
    if (config.discoveryCategory && normalizeKey(product.category_id || product.category) !== normalizeKey(config.discoveryCategory)) return false;
    return normalizeKey(product.status || "active") !== "disabled";
  });

  products = products
    .filter(product => productNeedsCoverage(db, product, retailers, config))
    .slice(0, Math.max(0, Number(config.discoveryMaxProducts || 25)));

  return products.flatMap(product => retailers.map(retailer => {
    const adapter = adapterForRetailer(retailer);
    return {
      product_id: product.product_id,
      product_name: productName(product),
      retailer_id: retailer.retailer_id,
      retailer_name: retailer.name,
      status: "needs_candidate_url",
      recommended_action: "review_retailer_search_results",
      search_queries: adapter ? adapter.buildSearchQueries(product) : []
    };
  }));
}

function loadCandidateInputs(config = {}) {
  if (!config.discoveryCandidateFile) return [];
  if (!fs.existsSync(config.discoveryCandidateFile)) {
    throw new Error(`DISCOVERY_CANDIDATE_FILE not found: ${config.discoveryCandidateFile}`);
  }
  return readJsonOrCsv(config.discoveryCandidateFile).map(row => ({
    product_id: row.product_id || row.productId || row.product,
    retailer_id: row.retailer_id || row.retailerId || row.retailer,
    candidate_url: row.candidate_url || row.url || row.retailer_product_url,
    expected_retailer_sku: row.expected_retailer_sku || row.retailer_sku || row.sku,
    html_path: row.html_path || row.fixture_path || row.local_html_path,
    page_html: row.page_html,
    source: row.source || "candidate_file",
    reviewer_notes: row.reviewer_notes || row.notes || ""
  })).filter(row => row.product_id && row.retailer_id);
}

function nextCandidateId(db) {
  return verification.nextSequentialId
    ? verification.nextSequentialId(db.retailer_url_candidates, "candidate_id", "urlcand", 6)
    : `urlcand-${String((db.retailer_url_candidates || []).length + 1).padStart(6, "0")}`;
}

function candidateKey(candidate = {}) {
  return [
    candidate.product_id,
    candidate.retailer_id,
    normalizeUrl(candidate.candidate_url || "")
  ].join("|");
}

function findExistingCandidate(db, candidate = {}) {
  const key = candidateKey(candidate);
  return (db.retailer_url_candidates || []).find(row => candidateKey(row) === key);
}

function upsertCandidateRecord(db, record) {
  const existing = findExistingCandidate(db, record);
  if (existing) {
    Object.assign(existing, record, {
      candidate_id: existing.candidate_id,
      first_seen_at: existing.first_seen_at || record.first_seen_at
    });
    return existing;
  }
  const inserted = {
    candidate_id: nextCandidateId(db),
    first_seen_at: core.nowBase44DateTime(),
    ...record
  };
  db.retailer_url_candidates.push(inserted);
  return inserted;
}

function duplicateUrlExists(db, candidate = {}, excludeOfferId = null) {
  const normalized = normalizeUrl(candidate.candidate_url);
  if (!normalized) return false;
  return (db.retailer_offers || []).some(offer => {
    if (excludeOfferId && offer.retailer_offer_id === excludeOfferId) return false;
    return normalizeUrl(offer.retailer_product_url || offer.source_url || "") === normalized &&
      (offer.product_id !== candidate.product_id || offer.retailer_id !== candidate.retailer_id);
  });
}

function loadCandidateHtml(candidate = {}, config = {}) {
  if (candidate.page_html) return { ok: true, html: candidate.page_html, source: "inline_html" };
  if (candidate.html_path) {
    if (!fs.existsSync(candidate.html_path)) return { ok: false, error: `html_path_not_found:${candidate.html_path}` };
    return { ok: true, html: fs.readFileSync(candidate.html_path, "utf8"), source: "html_fixture" };
  }
  if (!config.allowLiveFetch) return { ok: false, error: "page_identity_required_or_live_fetch_disabled" };
  return null;
}

async function evaluateCandidate(db, rawCandidate, config = {}) {
  const { productsById, retailersById } = core.buildIndexes(db);
  const product = productsById.get(rawCandidate.product_id);
  const retailer = retailersById.get(rawCandidate.retailer_id);
  const adapter = retailer ? adapterForRetailer(retailer) : null;
  const now = core.nowBase44DateTime();
  const candidate = {
    ...rawCandidate,
    candidate_url: normalizeUrl(rawCandidate.candidate_url)
  };

  const baseRecord = {
    product_id: candidate.product_id,
    retailer_id: candidate.retailer_id,
    candidate_url: candidate.candidate_url,
    source: candidate.source || "candidate_file",
    reviewed_at: null,
    last_evaluated_at: now,
    promotion_status: "not_promoted",
    reviewer_notes: candidate.reviewer_notes || ""
  };

  if (!product || !retailer || !adapter) {
    return {
      status: "rejected",
      reason: !product ? "unknown_product" : !retailer ? "unknown_retailer" : "unsupported_retailer",
      candidate_record: { ...baseRecord, match_status: "rejected", match_score: 0 }
    };
  }

  const urlIssue = adapter.validateCandidateUrl(candidate.candidate_url);
  if (urlIssue) {
    return {
      status: "rejected",
      reason: urlIssue,
      candidate_record: { ...baseRecord, match_status: "rejected", match_score: 0, hard_conflicts: [{ field: "url", reason: urlIssue }] }
    };
  }

  if (duplicateUrlExists(db, candidate)) {
    return {
      status: "rejected",
      reason: "duplicate_url_for_different_offer",
      candidate_record: { ...baseRecord, match_status: "rejected", match_score: 0, hard_conflicts: [{ field: "candidate_url", reason: "duplicate_url_for_different_offer" }] }
    };
  }

  let page = loadCandidateHtml(candidate, config);
  if (page === null) page = await adapter.fetchCandidatePage(candidate.candidate_url, config);
  if (!page.ok) {
    return {
      status: "review_required",
      reason: page.error || "page_fetch_failed",
      candidate_record: { ...baseRecord, match_status: "review_required", match_score: 0, missing_identity_fields: ["page_identity"] }
    };
  }

  const identity = adapter.extractIdentity(page.html, candidate.candidate_url);
  const offerData = adapter.extractOffer(page.html, candidate.candidate_url);
  const evaluation = verification.scoreCandidate(
    product,
    identity,
    {
      ...candidate,
      expected_retailer_sku: candidate.expected_retailer_sku,
      http_status: page.http_status,
      url_issue: null
    },
    config
  );
  const promote = verification.shouldPromote(evaluation, config);
  const promoted = promote && config.write;
  let upsert = null;

  if (promoted) {
    upsert = verification.upsertVerifiedOffer(db, {
      product,
      retailer,
      candidate,
      identity,
      offerData,
      evaluation,
      source: "retailer_ingestion"
    });
  }

  return {
    status: promoted ? "promoted" : promote ? "would_promote" : evaluation.match_status,
    reason: evaluation.hard_conflicts.length ? "hard_conflict" : evaluation.match_status,
    product,
    retailer,
    identity,
    offerData,
    evaluation,
    promoted,
    upsert,
    candidate_record: {
      ...baseRecord,
      canonical_url: identity.canonical_url || candidate.candidate_url,
      match_status: evaluation.match_status,
      match_score: evaluation.match_score,
      match_reasons: evaluation.match_reasons,
      hard_conflicts: evaluation.hard_conflicts,
      missing_identity_fields: evaluation.missing_identity_fields,
      auto_promotion_eligible: promote,
      promotion_status: promoted ? "promoted" : promote ? "would_promote" : "review_required"
    }
  };
}

async function runRetailerIngestion(db, config = {}) {
  ensureIngestionTables(db);
  const generatedReviews = analyzeProductCoverage(db, config);
  const inputs = loadCandidateInputs(config);
  const results = [];

  for (const input of inputs) {
    const result = await evaluateCandidate(db, input, config);
    results.push(result);
    if (config.write) upsertCandidateRecord(db, result.candidate_record);
  }

  if (config.write) {
    for (const review of generatedReviews) {
      upsertCandidateRecord(db, {
        ...review,
        candidate_url: "",
        last_evaluated_at: core.nowBase44DateTime(),
        promotion_status: "needs_candidate_url"
      });
    }
  }

  const promoted = results.filter(result => result.promoted).length;
  const wouldPromote = results.filter(result => result.status === "would_promote").length;
  const rejected = results.filter(result => result.status === "rejected").length;
  const reviewRequired = results.filter(result => ["review_required", "provisional"].includes(result.status)).length;

  return {
    generated_review_rows: generatedReviews.length,
    candidate_rows: inputs.length,
    promoted,
    would_promote: wouldPromote,
    rejected,
    review_required: reviewRequired,
    write_enabled: Boolean(config.write),
    auto_promote_enabled: Boolean(config.autoPromote),
    results: results.map(result => ({
      product_id: result.candidate_record.product_id,
      retailer_id: result.candidate_record.retailer_id,
      candidate_url: result.candidate_record.candidate_url,
      status: result.status,
      reason: result.reason,
      match_status: result.candidate_record.match_status,
      match_score: result.candidate_record.match_score,
      promotion_status: result.candidate_record.promotion_status,
      hard_conflicts: result.candidate_record.hard_conflicts || [],
      offer_id: result.upsert?.offer?.retailer_offer_id || null,
      snapshot_id: result.upsert?.snapshot?.snapshot_id || null
    }))
  };
}

module.exports = {
  analyzeProductCoverage,
  duplicateUrlExists,
  ensureIngestionTables,
  evaluateCandidate,
  loadCandidateInputs,
  runRetailerIngestion
};
