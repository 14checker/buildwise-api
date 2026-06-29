const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");
const urlQuality = require("./url_quality");

const DB_FILE = process.env.DB_FILE || "db.json";
const REPORT_DIR = process.env.REPORT_DIR || "buildwise_reports";
const MODE = String(process.argv[2] || process.env.URL_MATCH_MODE || "audit").toLowerCase();
const IMPORT_FILE = process.env.URL_MATCH_IMPORT || "";
const WRITE_ENABLED = String(process.env.WRITE || "false").toLowerCase() === "true";
const REQUESTED_DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const WRITE_BLOCKED = !REQUESTED_DRY_RUN && !WRITE_ENABLED;
const DRY_RUN = REQUESTED_DRY_RUN || !WRITE_ENABLED;
const MAX_ROWS = Number(process.env.URL_MATCH_MAX_ROWS || 0);
const IMPORT_AFFILIATE_URLS = String(process.env.IMPORT_AFFILIATE_URLS || "false").toLowerCase() === "true";
const STRIP_TRACKING_PARAMS = String(process.env.STRIP_TRACKING_PARAMS || "true").toLowerCase() === "true";

const TRACKING_PARAMS = new Set([
  "tag",
  "ascsubtag",
  "affid",
  "affiliate",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "ref_",
  "source",
  "campaign"
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  return [columns.join(","), ...rows.map(row => columns.map(col => csvEscape(row[col])).join(","))].join("\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows
    .filter(values => values.some(value => String(value || "").trim()))
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productTokens(product) {
  const stop = new Set(["the", "and", "with", "for", "new", "edition", "version", "black", "white", "rgb", "pro", "plus"]);
  return normalizeText(`${product.brand || ""} ${product.model || ""}`)
    .split(" ")
    .filter(token => token.length >= 2 && !stop.has(token));
}

function scoreUrlMatch(product, url) {
  let urlText = "";
  try {
    const parsed = new URL(url);
    urlText = decodeURIComponent(`${parsed.hostname} ${parsed.pathname} ${parsed.search}`);
  } catch {
    return 0;
  }

  const tokens = productTokens(product);
  if (!tokens.length) return 0;

  const normalizedUrl = normalizeText(urlText);
  const matched = tokens.filter(token => normalizedUrl.includes(token)).length;
  return Math.round((matched / tokens.length) * 100);
}

function buildSearchQuery(product, retailer) {
  const domain = urlQuality.getRetailerDomain(retailer?.retailer_id, retailer);
  const productName = core.normalizeText(`${product.brand || ""} ${product.model || ""}`);
  return `"${productName}" site:${domain}`;
}

function productSearchText(product) {
  return core.normalizeText([
    product?.brand,
    product?.model,
    product?.mpn
  ].filter(Boolean).join(" "));
}

function searchUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function buildRetailerSearchUrl(product, retailer) {
  const query = productSearchText(product);

  switch (retailer?.retailer_id) {
    case "ret-amazon":
      return searchUrl("https://www.amazon.com/s", { k: query });
    case "ret-newegg":
      return searchUrl("https://www.newegg.com/p/pl", { d: query });
    case "ret-bestbuy":
      return searchUrl("https://www.bestbuy.com/site/searchpage.jsp", { st: query });
    case "ret-microcenter":
      return searchUrl("https://www.microcenter.com/search/search_results.aspx", { Ntt: query });
    case "ret-bh":
      return searchUrl("https://www.bhphotovideo.com/c/search", {
        Ntt: query,
        N: "0",
        InitialSearch: "yes",
        sts: "ma"
      });
    default:
      return "";
  }
}

function buildWebSearchUrl(product, retailer) {
  return searchUrl("https://www.bing.com/search", { q: buildSearchQuery(product, retailer) });
}

function cleanCandidateUrl(value) {
  if (!STRIP_TRACKING_PARAMS) return value;

  const parsed = urlQuality.parseUrl(value);
  if (!parsed) return value;

  for (const key of [...parsed.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized)) parsed.searchParams.delete(key);
  }

  return parsed.toString();
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

function logChange(db, payload) {
  db.change_log = Array.isArray(db.change_log) ? db.change_log : [];
  db.change_log.push({
    change_id: nextId(db.change_log, "change_id", "change", 6),
    entity_type: payload.entity_type,
    entity_id: payload.entity_id,
    action: payload.action,
    message: payload.message,
    created_at: core.nowBase44DateTime()
  });
}

function buildContext(db) {
  return {
    productsById: new Map(db.products.map(product => [product.product_id, product])),
    retailersById: new Map(db.retailers.map(retailer => [retailer.retailer_id, retailer])),
    offersById: new Map(db.retailer_offers.map(offer => [offer.retailer_offer_id, offer]))
  };
}

function analyzeOffers(db) {
  const { productsById, retailersById } = buildContext(db);
  const rows = [];
  const counts = {};

  for (const offer of db.retailer_offers) {
    const product = productsById.get(offer.product_id);
    const retailer = retailersById.get(offer.retailer_id);
    const currentUrl = core.getScrapeUrl(offer);
    const issue = urlQuality.getUrlQualityIssue(currentUrl, {
      retailerId: offer.retailer_id,
      retailer
    });

    if (!issue) continue;
    counts[issue] = (counts[issue] || 0) + 1;

    rows.push({
      retailer_offer_id: offer.retailer_offer_id,
      product_id: offer.product_id,
      category_id: product?.category_id || "",
      brand: product?.brand || "",
      model: product?.model || "",
      retailer_id: offer.retailer_id,
      retailer_name: retailer?.name || "",
      expected_domain: urlQuality.getRetailerDomain(offer.retailer_id, retailer),
      current_url: currentUrl,
      url_issue: issue,
      search_query: product && retailer ? buildSearchQuery(product, retailer) : "",
      review_status: "pending",
      candidate_url: "",
      affiliate_url: "",
      notes: ""
    });
  }

  rows.sort((a, b) =>
    String(a.category_id).localeCompare(String(b.category_id)) ||
    String(a.product_id).localeCompare(String(b.product_id)) ||
    String(a.retailer_id).localeCompare(String(b.retailer_id))
  );

  return { rows: MAX_ROWS > 0 ? rows.slice(0, MAX_ROWS) : rows, counts, total: rows.length };
}

function runAudit() {
  const db = core.readDb(DB_FILE);
  const audit = analyzeOffers(db);
  ensureDir(REPORT_DIR);

  const columns = [
    "retailer_offer_id",
    "product_id",
    "category_id",
    "brand",
    "model",
    "retailer_id",
    "retailer_name",
    "expected_domain",
    "current_url",
    "url_issue",
    "search_query",
    "review_status",
    "candidate_url",
    "affiliate_url",
    "notes"
  ];

  const csvFile = path.join(REPORT_DIR, `url_match_review_${stamp()}.csv`);
  const jsonFile = path.join(REPORT_DIR, `url_match_audit_${stamp()}.json`);

  fs.writeFileSync(csvFile, toCsv(audit.rows, columns));
  fs.writeFileSync(jsonFile, JSON.stringify({
    created_at: core.nowBase44DateTime(),
    db_file: DB_FILE,
    retailer_offers: db.retailer_offers.length,
    offers_needing_url_review: audit.total,
    exported_rows: audit.rows.length,
    issue_counts: audit.counts,
    review_csv: csvFile
  }, null, 2));

  console.log("URL matching audit complete.");
  console.log({
    retailer_offers: db.retailer_offers.length,
    offers_needing_url_review: audit.total,
    exported_rows: audit.rows.length,
    issue_counts: audit.counts,
    review_csv: csvFile,
    report_json: jsonFile
  });
}

function runCandidates() {
  const db = core.readDb(DB_FILE);
  const audit = analyzeOffers(db);
  const { productsById, retailersById } = buildContext(db);
  ensureDir(REPORT_DIR);

  const rows = audit.rows.map(row => {
    const product = productsById.get(row.product_id);
    const retailer = retailersById.get(row.retailer_id);

    return {
      ...row,
      product_search_text: product ? productSearchText(product) : core.normalizeText(`${row.brand} ${row.model}`),
      retailer_search_url: product && retailer ? buildRetailerSearchUrl(product, retailer) : "",
      web_search_url: product && retailer ? buildWebSearchUrl(product, retailer) : "",
      source_method: "manual_candidate_review",
      review_status: "pending",
      candidate_url: "",
      affiliate_url: "",
      notes: "Paste only a verified direct product page into candidate_url."
    };
  });

  const columns = [
    "retailer_offer_id",
    "product_id",
    "category_id",
    "brand",
    "model",
    "retailer_id",
    "retailer_name",
    "expected_domain",
    "current_url",
    "url_issue",
    "product_search_text",
    "search_query",
    "retailer_search_url",
    "web_search_url",
    "source_method",
    "review_status",
    "candidate_url",
    "affiliate_url",
    "notes"
  ];

  const csvFile = path.join(REPORT_DIR, `url_candidate_review_${stamp()}.csv`);
  const jsonFile = path.join(REPORT_DIR, `url_candidate_audit_${stamp()}.json`);

  fs.writeFileSync(csvFile, toCsv(rows, columns));
  fs.writeFileSync(jsonFile, JSON.stringify({
    created_at: core.nowBase44DateTime(),
    db_file: DB_FILE,
    retailer_offers: db.retailer_offers.length,
    offers_needing_url_review: audit.total,
    exported_rows: rows.length,
    issue_counts: audit.counts,
    candidate_csv: csvFile,
    mode: "candidates",
    note: "Search URLs are review helpers only. candidate_url is intentionally blank until a direct product page is verified."
  }, null, 2));

  console.log("URL candidate export complete.");
  console.log({
    retailer_offers: db.retailer_offers.length,
    offers_needing_url_review: audit.total,
    exported_rows: rows.length,
    issue_counts: audit.counts,
    candidate_csv: csvFile,
    report_json: jsonFile
  });
}

function getCandidateUrl(row) {
  return core.normalizeText(row.candidate_url || row.approved_url || row.retailer_product_url || "");
}

function isApproved(row) {
  return ["approved", "approve", "verified", "replace"].includes(core.normalizeKey(row.review_status || row.status));
}

function validateImportRow(row, db, context) {
  const offer = context.offersById.get(row.retailer_offer_id);
  if (!offer) return { ok: false, reason: "unknown_retailer_offer" };

  const product = context.productsById.get(offer.product_id);
  const retailer = context.retailersById.get(offer.retailer_id);
  const candidateUrl = getCandidateUrl(row);
  if (!candidateUrl) return { ok: false, reason: "missing_candidate_url" };

  const cleanedUrl = cleanCandidateUrl(candidateUrl);
  const issue = urlQuality.getUrlQualityIssue(cleanedUrl, {
    retailerId: offer.retailer_id,
    retailer
  });

  if (issue) return { ok: false, reason: issue };

  return {
    ok: true,
    offer,
    product,
    retailer,
    cleanedUrl,
    static_match_score: product ? scoreUrlMatch(product, cleanedUrl) : 0
  };
}

function runImport() {
  if (!IMPORT_FILE) throw new Error("Set URL_MATCH_IMPORT to the reviewed CSV path.");
  if (!fs.existsSync(IMPORT_FILE)) throw new Error(`Import file not found: ${IMPORT_FILE}`);

  const db = core.readDb(DB_FILE);
  const context = buildContext(db);
  const rows = parseCsv(fs.readFileSync(IMPORT_FILE, "utf8"));
  const approvedRows = rows.filter(isApproved);
  const updated = [];
  const rejected = [];

  for (const row of approvedRows) {
    const validation = validateImportRow(row, db, context);
    if (!validation.ok) {
      rejected.push({ ...row, reject_reason: validation.reason });
      continue;
    }

    const { offer, product, cleanedUrl, static_match_score } = validation;
    const before = {
      retailer_product_url: offer.retailer_product_url || null,
      source_url: offer.source_url || null,
      affiliate_url: offer.affiliate_url || null
    };

    offer.retailer_product_url = cleanedUrl;
    offer.source_url = cleanedUrl;
    offer.url_review_status = "verified";
    offer.url_reviewed_at = core.nowBase44DateTime();
    offer.url_match_confidence = static_match_score;
    offer.url_match_source = row.url_match_source || "manual_review_csv";

    if (IMPORT_AFFILIATE_URLS && row.affiliate_url) offer.affiliate_url = row.affiliate_url;

    updated.push({
      retailer_offer_id: offer.retailer_offer_id,
      product_id: offer.product_id,
      retailer_id: offer.retailer_id,
      product: core.normalizeText(`${product?.brand || ""} ${product?.model || ""}`),
      previous_url: before.retailer_product_url,
      new_url: cleanedUrl,
      static_match_score
    });

    logChange(db, {
      entity_type: "retailer_offer",
      entity_id: offer.retailer_offer_id,
      action: "url_match_import",
      message: `Updated product URL for ${offer.product_id}; static_match_score=${static_match_score}.`
    });
  }

  ensureDir(REPORT_DIR);
  const rejectFile = path.join(REPORT_DIR, `url_match_rejected_${stamp()}.csv`);
  if (rejected.length) {
    fs.writeFileSync(rejectFile, toCsv(rejected, [...Object.keys(rejected[0])]));
  }

  if (WRITE_BLOCKED) {
    console.warn("WRITE=true required for db.json mutation. Running as dry-run.");
  }

  if (!DRY_RUN) core.writeDb(db, DB_FILE);

  console.log("URL matching import complete.");
  console.log({
    dry_run: DRY_RUN,
    import_file: IMPORT_FILE,
    rows_in_file: rows.length,
    approved_rows: approvedRows.length,
    updated_offers: updated.length,
    rejected_rows: rejected.length,
    rejected_csv: rejected.length ? rejectFile : null,
    affiliate_urls_imported: IMPORT_AFFILIATE_URLS
  });

  if (DRY_RUN) {
    console.log('Dry run only. Set $env:DRY_RUN="false" and $env:WRITE="true" to update db.json after reviewing the summary.');
  }
}

function main() {
  if (MODE === "audit") return runAudit();
  if (["candidate", "candidates", "find"].includes(MODE)) return runCandidates();
  if (MODE === "import") return runImport();
  throw new Error(`Unknown URL_MATCH_MODE=${MODE}. Use "audit", "candidates", or "import".`);
}

main();
