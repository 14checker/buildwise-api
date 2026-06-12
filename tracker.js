const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const core = require("./buildwise_backend_core");

// ============================================================
// CONFIG
// ============================================================

const DB_FILE = process.env.DB_FILE || "db.json";
const EXPORT_DIR = process.env.EXPORT_DIR || "buildwise_tracker_exports";

const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const MAX_OFFERS = Number(process.env.MAX_OFFERS || 25);
const CATEGORY_FILTER = String(process.env.CATEGORY || "").trim().toLowerCase();
const RETAILER_FILTER = String(process.env.RETAILER || "").trim().toLowerCase();

const CRAWL_DELAY_MS = Number(process.env.CRAWL_DELAY_MS || 61000);
const DRY_RUN_DELAY_MS = Number(process.env.DRY_RUN_DELAY_MS || 0);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const SKIP_PLACEHOLDER_URLS = String(process.env.SKIP_PLACEHOLDER_URLS || "true").toLowerCase() === "true";
const EFFECTIVE_DELAY_MS = DRY_RUN ? DRY_RUN_DELAY_MS : CRAWL_DELAY_MS;

// ============================================================
// RETAILER RULES
// ============================================================

const RETAILER_NAME_TO_ID = {
  amazon: "ret-amazon",
  "amazon.com": "ret-amazon",
  newegg: "ret-newegg",
  "newegg.com": "ret-newegg",
  bestbuy: "ret-bestbuy",
  "best buy": "ret-bestbuy",
  "bestbuy.com": "ret-bestbuy",
  microcenter: "ret-microcenter",
  "micro center": "ret-microcenter",
  "microcenter.com": "ret-microcenter",
  bh: "ret-bh",
  "b&h": "ret-bh",
  "b&h photo": "ret-bh",
  "b&h photo video": "ret-bh",
  "bhphotovideo.com": "ret-bh"
};

const SCRAPER_RULES = {
  "ret-amazon": {
    name: "Amazon",
    priceSelectors: [
      "#corePrice_feature_div .a-price .a-offscreen",
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#price_inside_buybox",
      "[itemprop='price']",
      "meta[itemprop='price']"
    ],
    availabilitySelectors: ["#availability span", "#availability", "#outOfStock", "#desktop_buybox", "body"],
    shippingSelectors: [
      "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
      "#deliveryBlockMessage",
      "#shippingMessageInsideBuyBox_feature_div",
      "body"
    ]
  },
  "ret-newegg": {
    name: "Newegg",
    priceSelectors: [".price-current", ".price-current strong", ".product-price", "[itemprop='price']", "meta[itemprop='price']"],
    availabilitySelectors: [".product-inventory", ".product-buy-box", ".flags-body", "body"],
    shippingSelectors: [".price-ship", ".product-shipping", ".product-buy-box", "body"]
  },
  "ret-bestbuy": {
    name: "Best Buy",
    priceSelectors: ["[data-testid='customer-price']", ".priceView-customer-price span", ".pricing-price__regular-price", ".priceView-hero-price span", "[itemprop='price']"],
    availabilitySelectors: [".fulfillment-add-to-cart-button", ".fulfillment-fulfillment-summary", ".availability-message", "body"],
    shippingSelectors: [".fulfillment-fulfillment-summary", ".shipping-price", "body"]
  },
  "ret-microcenter": {
    name: "Micro Center",
    priceSelectors: ["[itemprop='price']", ".price", ".sale-price", ".productPrice", ".pricing"],
    availabilitySelectors: [".inventory", ".stock", ".availability", "body"],
    shippingSelectors: [".shipping", ".delivery", "body"]
  },
  "ret-bh": {
    name: "B&H Photo",
    priceSelectors: ["[data-selenium='pricingPrice']", "[itemprop='price']", ".price"],
    availabilitySelectors: ["[data-selenium='stockStatus']", ".availability", ".stock", "body"],
    shippingSelectors: ["[data-selenium='freeShippingMessage']", ".shipping", "body"]
  }
};

// ============================================================
// UTILS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parsePrice(text) {
  if (!text) return null;

  const cleaned = String(text)
    .replace(/\s+/g, " ")
    .replace(/,/g, "")
    .replace(/\$\s+/g, "$")
    .replace(/(\d)\s+\.(\d{2})/g, "$1.$2")
    .trim();

  const match = cleaned.match(/\$?\s*([0-9]+(?:\.[0-9]{2})?)/);
  if (!match) return null;

  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function parseShipping(text) {
  if (!text) return 0;
  const lower = String(text).toLowerCase();
  if (lower.includes("free")) return 0;
  const price = parsePrice(text);
  return price === null ? 0 : price;
}

function normalizeAvailability(text) {
  const lower = String(text || "").toLowerCase();

  if (lower.includes("out of stock") || lower.includes("sold out") || lower.includes("currently unavailable") || lower.includes("unavailable")) {
    return "Out of Stock";
  }
  if (lower.includes("backorder") || lower.includes("backordered")) return "Backorder";
  if (lower.includes("pre-order") || lower.includes("preorder")) return "Preorder";
  if (lower.includes("limited stock") || lower.includes("only a few left")) return "Limited Stock";
  if (lower.includes("add to cart") || lower.includes("in stock") || lower.includes("available")) return "In Stock";

  return "In Stock";
}

function normalizeRetailerIdFromMerchantName(name) {
  const raw = core.normalizeKey(name).replace(/\.com$/g, "").replace(/\s+/g, " ");
  return RETAILER_NAME_TO_ID[raw] || RETAILER_NAME_TO_ID[`${raw}.com`] || null;
}

function getUrlQualityIssue(url, retailerId) {
  if (!url) return "missing_url";
  if (!isValidUrl(url)) return "invalid_url";

  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const full = url.toLowerCase();

  if (host.includes("example.com")) return "placeholder_url";
  if (full.includes("placeholder") || full.includes("sku=demo")) return "placeholder_url";

  // Known fake seed URL patterns from the generated dataset.
  if (retailerId === "ret-amazon" && pathname.startsWith("/p/")) return "likely_placeholder_amazon_url";
  if (retailerId === "ret-bestbuy" && pathname.startsWith("/p/")) return "likely_placeholder_bestbuy_url";

  return null;
}

function isPcPartPickerUrl(url) {
  return getHostname(url).includes("pcpartpicker.com");
}

// ============================================================
// HTML FETCH / PARSE
// ============================================================

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": "BuildWisePrototype/0.3 contact: 14checker@gmail.com",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 400
  });

  return data;
}

function extractFirstText($, selectors) {
  for (const selector of selectors) {
    const el = $(selector).first();
    if (!el || !el.length) continue;

    const content = core.normalizeText(el.attr("content"));
    if (content) return content;

    const aria = core.normalizeText(el.attr("aria-label"));
    if (aria) return aria;

    const value = core.normalizeText(el.attr("value"));
    if (value) return value;

    const text = core.normalizeText(el.text());
    if (text) return text;
  }
  return "";
}

function getScraperRule(retailerId) {
  return SCRAPER_RULES[retailerId] || {
    name: retailerId,
    priceSelectors: ["[itemprop='price']", "meta[itemprop='price']", "[data-price]", ".price", ".sale-price", "body"],
    availabilitySelectors: [".availability", ".stock", ".inventory", "body"],
    shippingSelectors: [".shipping", ".delivery", "body"]
  };
}

function parseDirectRetailerPage(html, retailerId) {
  const $ = cheerio.load(html);
  const rule = getScraperRule(retailerId);

  const priceText = extractFirstText($, rule.priceSelectors);
  const availabilityText = extractFirstText($, rule.availabilitySelectors);
  const shippingText = extractFirstText($, rule.shippingSelectors);

  return {
    parser: "direct_retailer",
    raw_price_text: priceText,
    raw_availability_text: availabilityText,
    raw_shipping_text: shippingText,
    price: parsePrice(priceText),
    shipping: parseShipping(shippingText),
    availability: normalizeAvailability(availabilityText)
  };
}

function parsePcPartPickerPage(html, retailerId) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((i, row) => {
    const merchantName =
      core.normalizeText($(row).find(".td__logo img").attr("alt")) ||
      core.normalizeText($(row).find(".td__merchant").text()) ||
      core.normalizeText($(row).find("[data-merchant]").attr("data-merchant"));

    const mappedRetailerId = normalizeRetailerIdFromMerchantName(merchantName);

    const priceText =
      core.normalizeText($(row).find(".td__base").text()) ||
      core.normalizeText($(row).find(".price").text());

    const shippingText =
      core.normalizeText($(row).find(".td__shipping").text()) ||
      core.normalizeText($(row).find(".shipping").text());

    const rowText = core.normalizeText($(row).text());
    const price = parsePrice(priceText);

    if (!merchantName || price === null) return;

    rows.push({
      parser: "pcpartpicker",
      merchant_name: merchantName,
      retailer_id: mappedRetailerId,
      raw_price_text: priceText,
      raw_availability_text: rowText,
      raw_shipping_text: shippingText,
      price,
      shipping: parseShipping(shippingText),
      availability: normalizeAvailability(rowText)
    });
  });

  const exact = rows.find(row => row.retailer_id === retailerId);
  if (exact) return exact;

  return {
    parser: "pcpartpicker",
    raw_price_text: "",
    raw_availability_text: "",
    raw_shipping_text: "",
    price: null,
    shipping: 0,
    availability: "Unknown",
    available_rows_found: rows.length,
    message: `No PCPartPicker row matched retailer_id=${retailerId}`
  };
}

function parseOfferPage(html, retailerId, scrapeUrl) {
  if (isPcPartPickerUrl(scrapeUrl)) return parsePcPartPickerPage(html, retailerId);
  return parseDirectRetailerPage(html, retailerId);
}

// ============================================================
// EXPORTS
// ============================================================

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows, columns) {
  const header = columns.join(",");
  const body = rows.map(row => columns.map(column => csvEscape(row[column])).join(",")).join("\n");
  return `${header}\n${body}`;
}

function writeRunExports(runData) {
  ensureDir(EXPORT_DIR);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runDir = path.join(EXPORT_DIR, `run_${stamp}`);
  ensureDir(runDir);

  fs.writeFileSync(path.join(runDir, "price_snapshots_new.csv"), toCsv(runData.newSnapshots, [
    "snapshot_id", "retailer_offer_id", "price", "shipping", "availability", "scraped_at"
  ]));

  fs.writeFileSync(path.join(runDir, "retailer_offers_updates.csv"), toCsv(runData.updatedOffers, [
    "retailer_offer_id", "product_id", "retailer_id", "retailer_sku", "retailer_product_url", "affiliate_url", "current_price", "availability", "condition", "seller_name", "last_scraped_at", "source_url", "scrape_url", "price_source_url"
  ]));

  fs.writeFileSync(path.join(runDir, "scrape_errors_new.csv"), toCsv(runData.newErrors, [
    "error_id", "retailer_offer_id", "retailer_id", "error_type", "message", "occurred_at", "status"
  ]));

  fs.writeFileSync(path.join(runDir, "admin_review_queue_new.csv"), toCsv(runData.newReviews, [
    "review_id", "product_id", "retailer_offer_id", "issue_type", "match_confidence", "notes", "status"
  ]));

  fs.writeFileSync(path.join(runDir, "skipped_offers.csv"), toCsv(runData.skippedOffers, [
    "retailer_offer_id", "product_id", "retailer_id", "reason", "url"
  ]));

  fs.writeFileSync(path.join(runDir, "run_summary.json"), JSON.stringify(runData.summary, null, 2));

  return runDir;
}

// ============================================================
// SCRAPE LOOP
// ============================================================

function takeNewRows(db, startingCounts) {
  return {
    newSnapshots: db.price_snapshots.slice(startingCounts.price_snapshots),
    newErrors: db.scrape_errors.slice(startingCounts.scrape_errors),
    newReviews: db.admin_review_queue.slice(startingCounts.admin_review_queue)
  };
}

async function scrapeTarget(db, target, runData) {
  const scrapedAt = core.nowBase44DateTime();
  const { offer, product, retailer, scrapeUrl } = target;

  const productName = core.normalizeText(`${product.brand || ""} ${product.model || ""}`) || product.product_id;
  const retailerName = retailer.name || retailer.retailer_id;

  console.log(`\nScanning ${productName} | ${retailerName} | ${offer.retailer_offer_id}`);

  const urlIssue = getUrlQualityIssue(scrapeUrl, offer.retailer_id);

  if (urlIssue && SKIP_PLACEHOLDER_URLS) {
    const error = core.applyScrapeFailure(db, {
      retailer_offer_id: offer.retailer_offer_id,
      retailer_id: offer.retailer_id,
      error_type: urlIssue,
      message: `Skipped due to URL issue: ${urlIssue}. URL=${scrapeUrl || ""}`,
      occurred_at: scrapedAt
    });

    runData.skippedOffers.push({
      retailer_offer_id: offer.retailer_offer_id,
      product_id: offer.product_id,
      retailer_id: offer.retailer_id,
      reason: urlIssue,
      url: scrapeUrl || ""
    });

    console.warn(`⚠️ Skipped ${offer.retailer_offer_id}: ${urlIssue}`);
    return { status: "skipped", error };
  }

  try {
    const html = await fetchHtml(scrapeUrl);
    const parsed = parseOfferPage(html, offer.retailer_id, scrapeUrl);

    if (parsed.price === null) {
      const error = core.applyScrapeFailure(db, {
        retailer_offer_id: offer.retailer_offer_id,
        retailer_id: offer.retailer_id,
        error_type: "parse_error",
        message: `Could not parse price. Parser=${parsed.parser || "unknown"}. Raw="${parsed.raw_price_text || ""}". URL=${scrapeUrl}`,
        occurred_at: scrapedAt
      });

      console.warn(`⚠️ Price not found for ${offer.retailer_offer_id}`);
      return { status: "error", error };
    }

    const beforeCounts = {
      price_snapshots: db.price_snapshots.length,
      scrape_errors: db.scrape_errors.length,
      admin_review_queue: db.admin_review_queue.length
    };

    const result = core.applyScrapeResult(db, {
      retailer_offer_id: offer.retailer_offer_id,
      retailer_id: offer.retailer_id,
      price: parsed.price,
      shipping: parsed.shipping,
      availability: parsed.availability,
      scraped_at: scrapedAt
    });

    const newRows = takeNewRows(db, beforeCounts);
    runData.newSnapshots.push(...newRows.newSnapshots);
    runData.newErrors.push(...newRows.newErrors);
    runData.newReviews.push(...newRows.newReviews);

    if (result.status === "updated") {
      runData.updatedOffers.push({ ...offer });
      console.log(`✅ ${offer.retailer_offer_id} updated: $${result.price} | ${result.availability}`);
      return result;
    }

    if (result.status === "review") {
      console.warn(`⚠️ Admin review required for ${offer.retailer_offer_id}: ${result.reason}`);
      return result;
    }

    return result;
  } catch (err) {
    const status = err.response?.status;
    const errorType = status ? `http_${status}` : "request_error";
    const statusText = status ? `HTTP ${status}` : "request_error";

    const error = core.applyScrapeFailure(db, {
      retailer_offer_id: offer.retailer_offer_id,
      retailer_id: offer.retailer_id,
      error_type: errorType,
      message: `${statusText}: ${err.message}. URL=${scrapeUrl}`,
      occurred_at: scrapedAt
    });

    console.error(`❌ Request failed for ${offer.retailer_offer_id}: ${err.message}`);
    return { status: "error", error };
  }
}

async function runAll() {
  const startedAt = core.nowBase44DateTime();
  const db = core.readDb(DB_FILE);

  const startingCounts = {
    price_snapshots: db.price_snapshots.length,
    scrape_errors: db.scrape_errors.length,
    admin_review_queue: db.admin_review_queue.length
  };

  const targets = core.getScrapeTargets(db, {
    maxOffers: MAX_OFFERS,
    category: CATEGORY_FILTER,
    retailer: RETAILER_FILTER,
    includeMissingUrls: true
  });

  const runData = {
    newSnapshots: [],
    updatedOffers: [],
    newErrors: [],
    newReviews: [],
    skippedOffers: [],
    summary: {
      started_at: startedAt,
      finished_at: null,
      db_file: DB_FILE,
      dry_run: DRY_RUN,
      crawl_delay_ms: EFFECTIVE_DELAY_MS,
      max_offers: MAX_OFFERS,
      category_filter: CATEGORY_FILTER || null,
      retailer_filter: RETAILER_FILTER || null,
      skip_placeholder_urls: SKIP_PLACEHOLDER_URLS,
      targets_found: targets.length,
      snapshots_created: 0,
      offers_updated: 0,
      errors_created: 0,
      reviews_created: 0,
      skipped_offers: 0,
      starting_counts: core.getSummary(db),
      ending_counts: null
    }
  };

  console.log("\nBuildWise tracker started.");
  console.log(`Targets found: ${targets.length}`);
  console.log(`DB file: ${DB_FILE}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Delay: ${EFFECTIVE_DELAY_MS}ms`);
  console.log(`Category filter: ${CATEGORY_FILTER || "none"}`);
  console.log(`Retailer filter: ${RETAILER_FILTER || "none"}`);

  for (let i = 0; i < targets.length; i++) {
    const result = await scrapeTarget(db, targets[i], runData);

    // Capture errors created by skip/request paths that didn't use applyScrapeResult.
    const newRows = takeNewRows(db, startingCounts);
    runData.newErrors = newRows.newErrors;
    runData.newReviews = newRows.newReviews;
    // Keep snapshots from core result plus any already tracked.
    runData.newSnapshots = newRows.newSnapshots;

    const shouldWait = i < targets.length - 1 && EFFECTIVE_DELAY_MS > 0 && result.status !== "skipped";
    if (shouldWait) {
      console.log(`Waiting ${EFFECTIVE_DELAY_MS / 1000}s before next request...`);
      await sleep(EFFECTIVE_DELAY_MS);
    }
  }

  runData.summary.finished_at = core.nowBase44DateTime();
  runData.summary.snapshots_created = runData.newSnapshots.length;
  runData.summary.offers_updated = runData.updatedOffers.length;
  runData.summary.errors_created = runData.newErrors.length;
  runData.summary.reviews_created = runData.newReviews.length;
  runData.summary.skipped_offers = runData.skippedOffers.length;
  runData.summary.ending_counts = core.getSummary(db);

  if (!DRY_RUN) {
    core.writeDb(db, DB_FILE);
  }

  const exportPath = writeRunExports(runData);

  console.log("\nBuildWise tracker finished.");
  console.log(`Snapshots created: ${runData.summary.snapshots_created}`);
  console.log(`Offers updated: ${runData.summary.offers_updated}`);
  console.log(`Errors created: ${runData.summary.errors_created}`);
  console.log(`Admin reviews created: ${runData.summary.reviews_created}`);
  console.log(`Skipped offers: ${runData.summary.skipped_offers}`);
  console.log(`Exports written to: ${exportPath}`);

  if (runData.summary.skipped_offers > 0) {
    console.log("\nNote: skipped offers usually mean your seed URLs are placeholders.");
    console.log("Add real source_url values or replace retailer_product_url with real product pages.");
  }
}

runAll().catch(err => {
  console.error("Fatal tracker error:", err.message);
  process.exit(1);
});
