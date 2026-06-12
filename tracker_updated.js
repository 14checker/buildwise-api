const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

const DB_FILE = process.env.DB_FILE || "buildwise_base44_db.json";
const EXPORT_DIR = process.env.EXPORT_DIR || "buildwise_tracker_exports";

const CRAWL_DELAY_MS = Number(process.env.CRAWL_DELAY_MS || 61000);

// Safety default: your dataset has ~2,100 retailer offers.
// At 61 seconds each, scanning all of them in one run would take ~35+ hours.
// Use MAX_OFFERS=0 if you intentionally want to scan everything.
const MAX_OFFERS = Number(process.env.MAX_OFFERS || 25);

const CATEGORY_FILTER = process.env.CATEGORY || "";
const RETAILER_FILTER = process.env.RETAILER || "";
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

// ------------------------------------------------------------
// RETAILER SCRAPER RULES
// ------------------------------------------------------------

const SCRAPER_RULES = {
  "ret-amazon": {
    name: "Amazon",
    priceSelectors: [
      "#corePrice_feature_div .a-price .a-offscreen",
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#price_inside_buybox"
    ],
    availabilitySelectors: [
      "#availability span",
      "#availability",
      "#outOfStock",
      "#desktop_buybox"
    ],
    shippingSelectors: [
      "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
      "#deliveryBlockMessage",
      "#shippingMessageInsideBuyBox_feature_div"
    ]
  },

  "ret-newegg": {
    name: "Newegg",
    priceSelectors: [
      ".price-current",
      ".price-current strong",
      ".product-price",
      "[itemprop='price']"
    ],
    availabilitySelectors: [
      ".product-inventory",
      ".product-buy-box",
      ".flags-body",
      "body"
    ],
    shippingSelectors: [
      ".price-ship",
      ".product-shipping",
      ".product-buy-box"
    ]
  },

  "ret-bestbuy": {
    name: "Best Buy",
    priceSelectors: [
      "[data-testid='customer-price']",
      ".priceView-customer-price span",
      ".pricing-price__regular-price",
      ".priceView-hero-price span"
    ],
    availabilitySelectors: [
      ".fulfillment-add-to-cart-button",
      ".fulfillment-fulfillment-summary",
      ".availability-message",
      "body"
    ],
    shippingSelectors: [
      ".fulfillment-fulfillment-summary",
      ".shipping-price",
      "body"
    ]
  },

  "ret-microcenter": {
    name: "Micro Center",
    priceSelectors: [
      "[itemprop='price']",
      ".price",
      ".sale-price",
      ".productPrice",
      ".pricing"
    ],
    availabilitySelectors: [
      ".inventory",
      ".stock",
      ".availability",
      "body"
    ],
    shippingSelectors: [
      ".shipping",
      ".delivery",
      "body"
    ]
  },

  "ret-bh": {
    name: "B&H Photo",
    priceSelectors: [
      "[data-selenium='pricingPrice']",
      "[itemprop='price']",
      ".price",
      ".price_1DPoToKrLP8uWvruGqgTA-"
    ],
    availabilitySelectors: [
      "[data-selenium='stockStatus']",
      ".availability",
      ".stock",
      "body"
    ],
    shippingSelectors: [
      "[data-selenium='freeShippingMessage']",
      ".shipping",
      "body"
    ]
  }
};

// ------------------------------------------------------------
// GENERAL HELPERS
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toBase44DateTime(timestamp = Date.now()) {
  const d = new Date(timestamp);

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function parsePrice(text) {
  if (!text) return null;

  const cleaned = String(text)
    .replace(/\s+/g, " ")
    .replace(/,/g, "")
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

  if (
    lower.includes("out of stock") ||
    lower.includes("sold out") ||
    lower.includes("currently unavailable") ||
    lower.includes("unavailable")
  ) {
    return "Out of Stock";
  }

  if (lower.includes("backorder") || lower.includes("backordered")) {
    return "Backorder";
  }

  if (lower.includes("pre-order") || lower.includes("preorder")) {
    return "Preorder";
  }

  if (lower.includes("limited stock") || lower.includes("only a few left")) {
    return "Limited Stock";
  }

  if (
    lower.includes("add to cart") ||
    lower.includes("in stock") ||
    lower.includes("available")
  ) {
    return "In Stock";
  }

  return "In Stock";
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ------------------------------------------------------------
// DB HELPERS
// ------------------------------------------------------------

function emptyDb() {
  return {
    categories: [],
    brands: [],
    retailers: [],
    products: [],
    retailer_offers: [],
    price_snapshots: [],
    users: [],
    watchlists: [],
    price_alerts: [],
    affiliate_clicks: [],
    scrape_jobs: [],
    scrape_errors: [],
    admin_review_queue: []
  };
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(
      `Missing ${DB_FILE}. Export your Base44 data into this JSON file first.`
    );
  }

  const raw = fs.readFileSync(DB_FILE, "utf8");
  const db = {
    ...emptyDb(),
    ...JSON.parse(raw)
  };

  validateDb(db);

  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function validateDb(db) {
  const requiredTables = [
    "products",
    "retailers",
    "retailer_offers",
    "price_snapshots",
    "scrape_jobs",
    "scrape_errors",
    "admin_review_queue"
  ];

  for (const table of requiredTables) {
    if (!Array.isArray(db[table])) {
      throw new Error(`Missing or invalid table: ${table}`);
    }
  }
}

function nextSequentialId(rows, field, prefix, width) {
  let max = 0;

  for (const row of rows) {
    const value = row[field];

    if (!value || typeof value !== "string") continue;

    const match = value.match(new RegExp(`^${prefix}-(\\d+)$`));

    if (!match) continue;

    max = Math.max(max, Number(match[1]));
  }

  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

function buildIndexes(db) {
  return {
    productsById: new Map(db.products.map(product => [product.product_id, product])),
    retailersById: new Map(db.retailers.map(retailer => [retailer.retailer_id, retailer])),
    offersById: new Map(
      db.retailer_offers.map(offer => [offer.retailer_offer_id, offer])
    )
  };
}

// ------------------------------------------------------------
// TARGET BUILDER
// ------------------------------------------------------------

function buildScrapeTargets(db) {
  const { productsById, retailersById } = buildIndexes(db);

  let targets = db.retailer_offers
    .map(offer => {
      const product = productsById.get(offer.product_id);
      const retailer = retailersById.get(offer.retailer_id);

      return {
        offer,
        product,
        retailer
      };
    })
    .filter(target => {
      const { offer, product, retailer } = target;

      if (!offer || !product || !retailer) return false;
      if (product.status !== "active") return false;
      if (retailer.active !== true) return false;
      if (!isValidUrl(offer.retailer_product_url)) return false;
      if (offer.availability === "Discontinued") return false;

      if (CATEGORY_FILTER && product.category_id !== CATEGORY_FILTER) return false;
      if (RETAILER_FILTER && retailer.retailer_id !== RETAILER_FILTER) return false;

      return true;
    });

  // Oldest last_scraped_at first, so the scanner naturally catches stale data.
  targets.sort((a, b) => {
    const aTime = new Date(a.offer.last_scraped_at || "1970-01-01").getTime();
    const bTime = new Date(b.offer.last_scraped_at || "1970-01-01").getTime();

    return aTime - bTime;
  });

  if (MAX_OFFERS > 0) {
    targets = targets.slice(0, MAX_OFFERS);
  }

  return targets;
}

// ------------------------------------------------------------
// HTML EXTRACTION
// ------------------------------------------------------------

function extractFirstText($, selectors) {
  for (const selector of selectors) {
    const el = $(selector).first();

    if (!el || !el.length) continue;

    const content = normalizeText(el.attr("content"));
    if (content) return content;

    const aria = normalizeText(el.attr("aria-label"));
    if (aria) return aria;

    const text = normalizeText(el.text());
    if (text) return text;
  }

  return "";
}

function getScraperRule(retailer_id) {
  return SCRAPER_RULES[retailer_id] || {
    name: retailer_id,
    priceSelectors: [
      "[itemprop='price']",
      "[data-price]",
      ".price",
      ".sale-price",
      "body"
    ],
    availabilitySelectors: [
      ".availability",
      ".stock",
      ".inventory",
      "body"
    ],
    shippingSelectors: [
      ".shipping",
      ".delivery",
      "body"
    ]
  };
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": "BuildWisePrototype/0.1 contact: 14checker@gmail.com",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    timeout: 15000,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 400
  });

  return data;
}

function parseOfferPage(html, retailer_id) {
  const $ = cheerio.load(html);
  const rule = getScraperRule(retailer_id);

  const priceText = extractFirstText($, rule.priceSelectors);
  const availabilityText = extractFirstText($, rule.availabilitySelectors);
  const shippingText = extractFirstText($, rule.shippingSelectors);

  return {
    raw_price_text: priceText,
    raw_availability_text: availabilityText,
    raw_shipping_text: shippingText,
    price: parsePrice(priceText),
    shipping: parseShipping(shippingText),
    availability: normalizeAvailability(availabilityText)
  };
}

// ------------------------------------------------------------
// LOGGING TABLE HELPERS
// ------------------------------------------------------------

function addPriceSnapshot(db, offer, parsed, scrapedAt) {
  const snapshot = {
    snapshot_id: nextSequentialId(
      db.price_snapshots,
      "snapshot_id",
      "snap",
      8
    ),
    retailer_offer_id: offer.retailer_offer_id,
    price: parsed.price,
    shipping: parsed.shipping,
    availability: parsed.availability,
    scraped_at: scrapedAt
  };

  db.price_snapshots.push(snapshot);

  return snapshot;
}

function addScrapeError(db, offer, errorType, message, scrapedAt) {
  const error = {
    error_id: nextSequentialId(db.scrape_errors, "error_id", "err", 5),
    retailer_offer_id: offer?.retailer_offer_id || null,
    retailer_id: offer?.retailer_id || null,
    error_type: errorType,
    message,
    occurred_at: scrapedAt,
    status: "open"
  };

  db.scrape_errors.push(error);

  return error;
}

function addAdminReview(db, product, offer, issueType, confidence, notes) {
  const review = {
    review_id: nextSequentialId(
      db.admin_review_queue,
      "review_id",
      "review",
      5
    ),
    product_id: product?.product_id || offer?.product_id || null,
    retailer_offer_id: offer?.retailer_offer_id || null,
    issue_type: issueType,
    match_confidence: confidence,
    notes,
    status: "open"
  };

  db.admin_review_queue.push(review);

  return review;
}

function updateScrapeJob(db, retailer_id, scrapedAt) {
  const job = db.scrape_jobs.find(job => job.retailer_id === retailer_id);

  if (job) {
    job.last_run_at = scrapedAt;
  }
}

function shouldSendToAdminReview(product, offer, parsed) {
  const msrp = safeNumber(product.msrp);
  const oldPrice = safeNumber(offer.current_price);
  const newPrice = safeNumber(parsed.price);

  if (newPrice === null) {
    return {
      review: true,
      issue_type: "missing_price",
      confidence: 0,
      notes: "Parsed price was null."
    };
  }

  if (msrp && newPrice > msrp * 3) {
    return {
      review: true,
      issue_type: "suspicious_high_price",
      confidence: 35,
      notes: `Parsed price ${newPrice} is more than 3x MSRP ${msrp}.`
    };
  }

  if (msrp && newPrice < msrp * 0.2) {
    return {
      review: true,
      issue_type: "suspicious_low_price",
      confidence: 35,
      notes: `Parsed price ${newPrice} is less than 20% of MSRP ${msrp}.`
    };
  }

  if (oldPrice && Math.abs(newPrice - oldPrice) / oldPrice > 0.5) {
    return {
      review: true,
      issue_type: "large_price_change",
      confidence: 60,
      notes: `Price moved from ${oldPrice} to ${newPrice}, which is more than a 50% change.`
    };
  }

  return {
    review: false
  };
}

// ------------------------------------------------------------
// CSV EXPORT HELPERS
// ------------------------------------------------------------

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

  const body = rows
    .map(row => columns.map(column => csvEscape(row[column])).join(","))
    .join("\n");

  return `${header}\n${body}`;
}

function writeRunExports(runData) {
  ensureDir(EXPORT_DIR);

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);

  const runDir = path.join(EXPORT_DIR, `run_${stamp}`);
  ensureDir(runDir);

  fs.writeFileSync(
    path.join(runDir, "price_snapshots_new.csv"),
    toCsv(runData.newSnapshots, [
      "snapshot_id",
      "retailer_offer_id",
      "price",
      "shipping",
      "availability",
      "scraped_at"
    ])
  );

  fs.writeFileSync(
    path.join(runDir, "retailer_offers_updates.csv"),
    toCsv(runData.updatedOffers, [
      "retailer_offer_id",
      "product_id",
      "retailer_id",
      "retailer_sku",
      "retailer_product_url",
      "affiliate_url",
      "current_price",
      "availability",
      "condition",
      "seller_name",
      "last_scraped_at"
    ])
  );

  fs.writeFileSync(
    path.join(runDir, "scrape_errors_new.csv"),
    toCsv(runData.newErrors, [
      "error_id",
      "retailer_offer_id",
      "retailer_id",
      "error_type",
      "message",
      "occurred_at",
      "status"
    ])
  );

  fs.writeFileSync(
    path.join(runDir, "admin_review_queue_new.csv"),
    toCsv(runData.newReviews, [
      "review_id",
      "product_id",
      "retailer_offer_id",
      "issue_type",
      "match_confidence",
      "notes",
      "status"
    ])
  );

  fs.writeFileSync(
    path.join(runDir, "run_summary.json"),
    JSON.stringify(runData.summary, null, 2)
  );

  return runDir;
}

// ------------------------------------------------------------
// MAIN SCRAPER LOGIC
// ------------------------------------------------------------

async function scrapeTarget(db, target, runData) {
  const scrapedAt = toBase44DateTime();

  const { offer, product, retailer } = target;

  const productName = `${product.brand} ${product.model}`;

  console.log(
    `\nScanning ${productName} | ${retailer.name} | ${offer.retailer_offer_id}`
  );

  try {
    const html = await fetchHtml(offer.retailer_product_url);
    const parsed = parseOfferPage(html, offer.retailer_id);

    if (parsed.price === null) {
      const error = addScrapeError(
        db,
        offer,
        "parse_error",
        `Could not parse price. Raw price text: "${parsed.raw_price_text}"`,
        scrapedAt
      );

      runData.newErrors.push(error);
      console.warn(`⚠️ Price not found for ${offer.retailer_offer_id}`);
      return;
    }

    const reviewCheck = shouldSendToAdminReview(product, offer, parsed);

    if (reviewCheck.review) {
      const review = addAdminReview(
        db,
        product,
        offer,
        reviewCheck.issue_type,
        reviewCheck.confidence,
        reviewCheck.notes
      );

      runData.newReviews.push(review);

      const error = addScrapeError(
        db,
        offer,
        "admin_review_required",
        reviewCheck.notes,
        scrapedAt
      );

      runData.newErrors.push(error);

      console.warn(
        `⚠️ Admin review required for ${offer.retailer_offer_id}: ${reviewCheck.issue_type}`
      );

      return;
    }

    offer.current_price = parsed.price;
    offer.availability = parsed.availability;
    offer.last_scraped_at = scrapedAt;

    const snapshot = addPriceSnapshot(db, offer, parsed, scrapedAt);
    updateScrapeJob(db, offer.retailer_id, scrapedAt);

    runData.newSnapshots.push(snapshot);
    runData.updatedOffers.push({ ...offer });

    console.log(
      `✅ ${offer.retailer_offer_id} updated: $${parsed.price} | ${parsed.availability}`
    );
  } catch (err) {
    const error = addScrapeError(
      db,
      offer,
      "request_error",
      err.message,
      scrapedAt
    );

    runData.newErrors.push(error);

    console.error(`❌ Request failed for ${offer.retailer_offer_id}: ${err.message}`);
  }
}

async function runAll() {
  const startedAt = toBase44DateTime();
  const db = readDb();

  const targets = buildScrapeTargets(db);

  const runData = {
    newSnapshots: [],
    updatedOffers: [],
    newErrors: [],
    newReviews: [],
    summary: {
      started_at: startedAt,
      finished_at: null,
      db_file: DB_FILE,
      dry_run: DRY_RUN,
      crawl_delay_ms: CRAWL_DELAY_MS,
      max_offers: MAX_OFFERS,
      category_filter: CATEGORY_FILTER || null,
      retailer_filter: RETAILER_FILTER || null,
      targets_found: targets.length,
      snapshots_created: 0,
      offers_updated: 0,
      errors_created: 0,
      reviews_created: 0
    }
  };

  console.log("\nBuildWise tracker started.");
  console.log(`Targets found: ${targets.length}`);
  console.log(`DB file: ${DB_FILE}`);
  console.log(`Dry run: ${DRY_RUN}`);

  for (let i = 0; i < targets.length; i++) {
    await scrapeTarget(db, targets[i], runData);

    if (i < targets.length - 1) {
      console.log(`Waiting ${CRAWL_DELAY_MS / 1000}s before next request...`);
      await sleep(CRAWL_DELAY_MS);
    }
  }

  runData.summary.finished_at = toBase44DateTime();
  runData.summary.snapshots_created = runData.newSnapshots.length;
  runData.summary.offers_updated = runData.updatedOffers.length;
  runData.summary.errors_created = runData.newErrors.length;
  runData.summary.reviews_created = runData.newReviews.length;

  if (!DRY_RUN) {
    writeDb(db);
  }

  const exportPath = writeRunExports(runData);

  console.log("\nBuildWise tracker finished.");
  console.log(`Snapshots created: ${runData.summary.snapshots_created}`);
  console.log(`Offers updated: ${runData.summary.offers_updated}`);
  console.log(`Errors created: ${runData.summary.errors_created}`);
  console.log(`Admin reviews created: ${runData.summary.reviews_created}`);
  console.log(`Exports written to: ${exportPath}`);
}

runAll().catch(err => {
  console.error("Fatal tracker error:", err.message);
  process.exit(1);
});
