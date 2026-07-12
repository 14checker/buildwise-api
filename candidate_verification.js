/**
 * BuildWise purpose:
 * Verify retailer product-page candidates before they can become public-safe offers.
 *
 * Plain-English summary:
 * This compares expected BuildWise product identity with extracted retailer page identity, blocks hard conflicts, scores evidence, and upserts safe offers.
 *
 * Safety note:
 * A numeric score cannot override hard conflicts. Price snapshots are created only for meaningful value changes.
 */
const core = require("./buildwise_backend_core");
const { normalizeUrl, normalizeText, parsePrice, normalizeAvailability } = require("./retailer_adapters/generic");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function words(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function tokens(value) {
  return new Set(words(value).filter(token => token.length > 1));
}

function productName(product = {}) {
  return [product.brand, product.model].filter(Boolean).join(" ").trim() || product.name || product.product_id || "";
}

function titleText(identity = {}) {
  return normalizeText([identity.product_name, identity.page_title, identity.model, identity.manufacturer_part_number].filter(Boolean).join(" "));
}

function hasAllModelTokens(product = {}, identity = {}) {
  const modelTokens = words(product.model).filter(token => token.length > 1 && !["new", "desktop", "processor", "cpu"].includes(token));
  const titleTokens = tokens(titleText(identity));
  return modelTokens.length > 0 && modelTokens.every(token => titleTokens.has(token.toLowerCase()));
}

function extractCpuModel(value) {
  const text = normalizeText(value).toLowerCase();
  const ryzen = text.match(/\bryzen\s+([3579])\s+(\d{4,5})(x3d|x|g|f)?\b/);
  if (ryzen) return `ryzen ${ryzen[1]} ${ryzen[2]}${ryzen[3] || ""}`;
  const ultra = text.match(/\bcore\s+ultra\s+([579])\s+(\d{3})(k|kf|f|ks)?\b/);
  if (ultra) return `core ultra ${ultra[1]} ${ultra[2]}${ultra[3] || ""}`;
  const intel = text.match(/\bcore\s+i([3579])-?(\d{4,5})(k|kf|f|ks)?\b/);
  if (intel) return `core i${intel[1]} ${intel[2]}${intel[3] || ""}`;
  return null;
}

function extractCapacity(value) {
  const text = normalizeText(value).toLowerCase();
  const tb = text.match(/\b(\d+(?:\.\d+)?)\s*tb\b/);
  if (tb) return `${tb[1]}tb`;
  const gb = text.match(/\b(\d+)\s*gb\b/);
  if (gb) return `${gb[1]}gb`;
  return null;
}

function variantSignals(value) {
  const text = normalizeText(value).toLowerCase();
  return ["tray", "boxed", "bulk", "oem", "bundle", "creator edition", "gaming bundle", "anniversary", "open box", "refurbished", "renewed", "used"]
    .filter(signal => text.includes(signal));
}

function addConflict(conflicts, field, expected, actual, reason) {
  conflicts.push({
    field,
    expected: expected || null,
    actual: actual || null,
    reason
  });
}

function detectHardConflicts(product = {}, identity = {}, candidate = {}, policy = {}) {
  const conflicts = [];
  const expectedText = productName(product);
  const actualText = titleText(identity);
  const expectedCategory = normalizeKey(product.category_id || product.category);
  const actualCategory = normalizeKey(identity.category);

  if (candidate.url_issue) addConflict(conflicts, "url", candidate.candidate_url, candidate.url_issue, candidate.url_issue);
  if (candidate.http_status && Number(candidate.http_status) >= 400) {
    addConflict(conflicts, "http_status", "2xx", candidate.http_status, "dead_or_error_page");
  }

  if (product.mpn && identity.manufacturer_part_number && normalizeKey(product.mpn) !== normalizeKey(identity.manufacturer_part_number)) {
    addConflict(conflicts, "manufacturer_part_number", product.mpn, identity.manufacturer_part_number, "mpn_mismatch");
  }

  if (expectedCategory && actualCategory && !actualCategory.includes(expectedCategory)) {
    addConflict(conflicts, "category", expectedCategory, actualCategory, "wrong_category");
  }

  if (expectedCategory === "cpu") {
    const expectedCpu = extractCpuModel(expectedText);
    const actualCpu = extractCpuModel(actualText);
    if (expectedCpu && actualCpu && expectedCpu !== actualCpu) {
      addConflict(conflicts, "cpu_model", expectedCpu, actualCpu, "cpu_model_mismatch");
    }
  }

  if (["storage", "ram", "memory"].includes(expectedCategory)) {
    const expectedCapacity = extractCapacity(expectedText);
    const actualCapacity = extractCapacity(actualText);
    if (expectedCapacity && actualCapacity && expectedCapacity !== actualCapacity) {
      addConflict(conflicts, "capacity", expectedCapacity, actualCapacity, "capacity_mismatch");
    }
  }

  const expectedVariants = variantSignals(expectedText);
  const actualVariants = variantSignals(actualText);
  for (const signal of actualVariants) {
    if (!expectedVariants.includes(signal)) {
      if (["refurbished", "renewed", "used", "open box"].includes(signal) && policy.allowRefurbished) continue;
      addConflict(conflicts, "condition_or_variant", expectedVariants.join(","), signal, `${signal.replace(/\s+/g, "_")}_mismatch`);
    }
  }
  for (const signal of expectedVariants) {
    if (!actualVariants.includes(signal)) {
      addConflict(conflicts, "variant", signal, actualVariants.join(","), "expected_variant_missing");
    }
  }

  if (!policy.allowMarketplace && /marketplace|third[- ]party|sold by/i.test(String(identity.seller_name || ""))) {
    addConflict(conflicts, "seller_name", "retailer_direct_or_unknown", identity.seller_name, "marketplace_seller_blocked");
  }

  return conflicts;
}

function jaccardScore(expected, actual) {
  const a = tokens(expected);
  const b = tokens(actual);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(token => b.has(token)).length;
  return Math.round((overlap / new Set([...a, ...b]).size) * 100);
}

function scoreCandidate(product = {}, identity = {}, candidate = {}, policy = {}) {
  const reasons = [];
  const missing = [];
  let score = 0;

  if (product.mpn && identity.manufacturer_part_number && normalizeKey(product.mpn) === normalizeKey(identity.manufacturer_part_number)) {
    score += 45;
    reasons.push("exact_mpn_match");
  } else if (product.mpn && !identity.manufacturer_part_number) {
    missing.push("manufacturer_part_number");
  }

  if (candidate.expected_retailer_sku && identity.retailer_sku && normalizeKey(candidate.expected_retailer_sku) === normalizeKey(identity.retailer_sku)) {
    score += 40;
    reasons.push("exact_retailer_sku_match");
  } else if (!identity.retailer_sku) {
    missing.push("retailer_sku");
  }

  if (product.brand && identity.brand && normalizeKey(product.brand) === normalizeKey(identity.brand)) {
    score += 20;
    reasons.push("brand_match");
  } else if (product.brand && !identity.brand && titleText(identity).toLowerCase().includes(normalizeKey(product.brand))) {
    score += 15;
    reasons.push("brand_in_title");
  } else if (product.brand) {
    missing.push("brand");
  }

  if (hasAllModelTokens(product, identity)) {
    score += 35;
    reasons.push("exact_model_tokens_match");
  } else {
    const similarity = jaccardScore(productName(product), titleText(identity));
    score += Math.round(similarity * 0.25);
    if (similarity >= 50) reasons.push("strong_title_token_similarity");
    else missing.push("strong_model_evidence");
  }

  const expectedCategory = normalizeKey(product.category_id || product.category);
  if (expectedCategory === "cpu") {
    const expectedCpu = extractCpuModel(productName(product));
    const actualCpu = extractCpuModel(titleText(identity));
    if (expectedCpu && actualCpu && expectedCpu === actualCpu) {
      score += 30;
      reasons.push("cpu_model_identity_match");
    }
  }
  if (expectedCategory && identity.category && normalizeKey(identity.category).includes(expectedCategory)) {
    score += 10;
    reasons.push("category_match");
  } else if (!identity.category) {
    missing.push("category");
  }

  if (candidate.candidate_url) {
    score += Math.min(4, Math.round(jaccardScore(productName(product), candidate.candidate_url) * 0.04));
    reasons.push("url_tokens_considered_low_weight");
  }

  if (identity.canonical_url) reasons.push("canonical_url_available");
  if (identity.product_name || identity.page_title) reasons.push("page_identity_extracted");

  const hardConflicts = detectHardConflicts(product, identity, candidate, policy);
  let matchStatus = "review_required";
  const finalScore = Math.max(0, Math.min(100, score));

  if (hardConflicts.length) {
    matchStatus = "rejected";
  } else if (
    (reasons.includes("exact_mpn_match") || reasons.includes("exact_retailer_sku_match")) &&
    reasons.some(reason => ["brand_match", "brand_in_title"].includes(reason))
  ) {
    matchStatus = "verified_exact";
  } else if (finalScore >= (policy.autoPromoteMinScore || 90) && hasAllModelTokens(product, identity)) {
    matchStatus = "verified_strong";
  } else if (finalScore >= 70) {
    matchStatus = "provisional";
  }

  return {
    match_score: hardConflicts.length ? 0 : finalScore,
    match_status: matchStatus,
    match_reasons: reasons,
    hard_conflicts: hardConflicts,
    missing_identity_fields: [...new Set(missing)]
  };
}

function shouldPromote(evaluation, policy = {}) {
  if (!policy.autoPromote) return false;
  if (evaluation.hard_conflicts.length) return false;
  if (evaluation.match_status === "verified_exact") return Boolean(policy.autoPromoteExact);
  if (evaluation.match_status === "verified_strong") {
    return Boolean(policy.autoPromoteStrong) && evaluation.match_score >= (policy.autoPromoteMinScore || 90);
  }
  return false;
}

function nextSequentialId(rows, field, prefix, width) {
  let max = 0;
  for (const row of rows || []) {
    const match = String(row?.[field] || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

function latestSnapshot(db, offerId) {
  return (db.price_snapshots || [])
    .filter(snapshot => snapshot.retailer_offer_id === offerId || snapshot.offer_id === offerId)
    .sort((a, b) => new Date(b.captured_at || b.scraped_at || 0) - new Date(a.captured_at || a.scraped_at || 0))[0] || null;
}

function valuesMeaningfullyChanged(previous = {}, current = {}) {
  return ["price", "currency", "availability", "seller_name", "condition"].some(field => {
    const oldValue = field === "price" ? core.safeNumber(previous.price) : normalizeKey(previous[field]);
    const newValue = field === "price" ? core.safeNumber(current.price) : normalizeKey(current[field]);
    return oldValue !== newValue;
  });
}

function createSnapshotIfChanged(db, offer, extractedOffer = {}, source = "scheduled_tracker") {
  const price = parsePrice(extractedOffer.current_price ?? extractedOffer.price);
  if (price === null) return null;

  const current = {
    price,
    currency: extractedOffer.currency || "USD",
    availability: extractedOffer.availability || offer.availability || "unknown",
    seller_name: extractedOffer.seller_name || offer.seller_name || null,
    condition: extractedOffer.condition || offer.condition || null
  };
  const previous = latestSnapshot(db, offer.retailer_offer_id);
  if (previous && !valuesMeaningfullyChanged(previous, current)) return null;

  const snapshot = {
    snapshot_id: nextSequentialId(db.price_snapshots, "snapshot_id", "snap", 8),
    retailer_offer_id: offer.retailer_offer_id,
    offer_id: offer.retailer_offer_id,
    product_id: offer.product_id,
    retailer_id: offer.retailer_id,
    price: current.price,
    currency: current.currency,
    availability: current.availability,
    seller_name: current.seller_name,
    condition: current.condition,
    captured_at: core.nowBase44DateTime(),
    source
  };
  db.price_snapshots.push(snapshot);
  return snapshot;
}

function offerMatches(db, productId, retailerId, canonicalUrl) {
  const normalized = normalizeUrl(canonicalUrl);
  return (db.retailer_offers || []).find(offer => {
    if (offer.product_id !== productId || offer.retailer_id !== retailerId) return false;
    return normalizeUrl(offer.canonical_url || offer.retailer_product_url || offer.source_url) === normalized ||
      (!normalized && offer.product_id === productId && offer.retailer_id === retailerId);
  }) || (db.retailer_offers || []).find(offer => offer.product_id === productId && offer.retailer_id === retailerId);
}

function upsertVerifiedOffer(db, { product, retailer, candidate, identity, offerData, evaluation, source = "live_page_identity" }) {
  const canonicalUrl = normalizeUrl(identity.canonical_url || offerData.canonical_url || candidate.candidate_url);
  let offer = offerMatches(db, product.product_id, retailer.retailer_id, canonicalUrl);
  const now = core.nowBase44DateTime();
  const inserted = !offer;

  if (!offer) {
    offer = {
      retailer_offer_id: nextSequentialId(db.retailer_offers, "retailer_offer_id", "offer", 6),
      product_id: product.product_id,
      retailer_id: retailer.retailer_id,
      retailer_sku: null,
      retailer_product_url: canonicalUrl,
      affiliate_url: null,
      current_price: null,
      availability: null,
      condition: null,
      seller_name: null,
      last_scraped_at: null,
      source_url: canonicalUrl
    };
    db.retailer_offers.push(offer);
  }

  offer.retailer_product_url = canonicalUrl;
  offer.source_url = canonicalUrl;
  offer.canonical_url = canonicalUrl;
  offer.retailer_sku = identity.retailer_sku || offerData.retailer_sku || offer.retailer_sku || null;
  offer.url_status = "verified_manual";
  offer.url_confidence = evaluation.match_score;
  offer.url_verification_method = source;
  offer.url_verified_at = now;
  offer.url_verification_reasons = evaluation.match_reasons;
  offer.last_scraped_at = now;
  offer.last_successful_scrape_at = now;
  offer.consecutive_failures = 0;

  const parsedPrice = parsePrice(offerData.current_price ?? offerData.price);
  if (parsedPrice !== null) offer.current_price = parsedPrice;
  if (offerData.availability) offer.availability = normalizeAvailability(offerData.availability);
  if (offerData.seller_name) offer.seller_name = offerData.seller_name;
  if (offerData.condition) offer.condition = offerData.condition;
  if (offerData.image_url) offer.image_url = offerData.image_url;

  const snapshot = createSnapshotIfChanged(db, offer, offerData, source);
  return {
    offer,
    inserted,
    updated: !inserted,
    snapshot
  };
}

module.exports = {
  createSnapshotIfChanged,
  detectHardConflicts,
  extractCapacity,
  extractCpuModel,
  hasAllModelTokens,
  nextSequentialId,
  productName,
  scoreCandidate,
  shouldPromote,
  titleText,
  upsertVerifiedOffer,
  valuesMeaningfullyChanged,
  variantSignals
};
