/**
 * BuildWise purpose:
 * Serve the public-safe BuildWise API for Base44 and future app clients.
 *
 * Plain-English summary:
 * This file exposes products, retailers, verified offers, price history, status, and search through safe public endpoints.
 *
 * Safety note:
 * It must never serve raw db.json, secrets, affiliate URLs, source URLs, URL review data, users, alerts, admin data, scrape logs, or compliance logs.
 */
const express = require("express");
const core = require("./buildwise_backend_core");
const publicDataMetrics = require("./public_data_metrics");

const DB_FILE = process.env.DB_FILE || "db.json";
const PORT = Number(process.env.PORT || 8080);
const RATE_LIMIT_PER_MINUTE = Number(process.env.PUBLIC_API_RATE_LIMIT_PER_MINUTE || 120);
const DEFAULT_LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

const rateBuckets = new Map();

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function allowedOrigins() {
  const configured = String(process.env.BASE44_ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_LOCAL_ORIGINS;
}

function unsafeFlagsEnabled() {
  return [
    "EXPORT_UNVERIFIED_OFFERS",
    "EXPORT_PRODUCTS_WITHOUT_VERIFIED_OFFERS",
    "EXPORT_UNVERIFIED_PRICES",
    "EXPORT_SEED_PRICE_DATA",
    "EXPORT_AFFILIATE_URLS"
  ].filter(name => normalizeText(process.env[name]) === "true");
}

function loadPublicData() {
  const db = core.readDb(DB_FILE);
  const options = publicDataMetrics.publicOptionsFromEnv();
  const rows = publicDataMetrics.rowsForPublicExports(db, options);
  const status = publicDataMetrics.buildPublicStatus(db, {
    ...options,
    dbFile: DB_FILE
  });
  return { rows, status };
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    const origins = allowedOrigins();
    if (!origins.includes(origin)) {
      return res.status(403).json({ error: "origin_not_allowed" });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

function rateLimitMiddleware(req, res, next) {
  if (!RATE_LIMIT_PER_MINUTE || RATE_LIMIT_PER_MINUTE < 1) return next();

  const now = Date.now();
  const windowMs = 60 * 1000;
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = rateBuckets.get(key) || { resetAt: now + windowMs, count: 0 };

  if (bucket.resetAt <= now) {
    bucket.resetAt = now + windowMs;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count > RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({ error: "rate_limit_exceeded" });
  }

  return next();
}

function searchPublicData(rows, query) {
  const q = normalizeText(query);
  if (!q) return { query: "", products: [], offers: [] };

  const products = rows.products.filter(product => {
    return [
      product.product_id,
      product.brand,
      product.model,
      product.slug,
      product.mpn
    ].some(value => normalizeText(value).includes(q));
  });

  const productIds = new Set(products.map(product => product.product_id));
  const offers = rows.retailer_offers.filter(offer => {
    return productIds.has(offer.product_id) ||
      normalizeText(offer.retailer_name).includes(q) ||
      normalizeText(offer.retailer_sku).includes(q);
  });

  return { query, products, offers };
}

function publicCategories(rows) {
  const categories = new Map();
  for (const product of rows.products || []) {
    const id = product.category_id || "unknown";
    const current = categories.get(id) || { category_id: id, product_count: 0 };
    current.product_count += 1;
    categories.set(id, current);
  }
  return [...categories.values()].sort((a, b) => a.category_id.localeCompare(b.category_id));
}

function publicBrands(rows) {
  const brands = new Map();
  for (const product of rows.products || []) {
    const name = product.brand || "Unknown";
    const key = normalizeText(name);
    const current = brands.get(key) || { brand: name, product_count: 0 };
    current.product_count += 1;
    brands.set(key, current);
  }
  return [...brands.values()].sort((a, b) => a.brand.localeCompare(b.brand));
}

function productById(rows, productId) {
  return rows.products.find(row => row.product_id === productId);
}

function offersForProduct(rows, productId) {
  return rows.retailer_offers.filter(row => row.product_id === productId);
}

function priceHistoryForProduct(rows, productId) {
  return rows.price_snapshots.filter(row => row.product_id === productId);
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(corsMiddleware);
  app.use(rateLimitMiddleware);

  app.get("/health", (req, res) => {
    const { rows, status } = loadPublicData();
    res.json({
      ok: true,
      safe_mode: true,
      status: status.status,
      data_last_updated_at: status.generated_at,
      base44_ready: status.base44_ready,
      base44_update_mode: status.base44_update_mode,
      counts: {
        products: rows.products.length,
        retailer_offers: rows.retailer_offers.length,
        retailers: rows.retailers.length,
        price_snapshots: rows.price_snapshots.length
      }
    });
  });

  app.get("/public/status", (req, res) => {
    const { status } = loadPublicData();
    res.json(status);
  });

  app.get("/public/products", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.products);
  });

  app.get("/public/products/:product_id", (req, res) => {
    const { rows } = loadPublicData();
    const product = rows.products.find(row => row.product_id === req.params.product_id);
    if (!product) return res.status(404).json({ error: "product_not_found" });
    return res.json(product);
  });

  app.get("/public/retailers", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.retailers);
  });

  app.get("/public/offers", (req, res) => {
    const { rows } = loadPublicData();
    const productId = req.query.product_id;
    const offers = productId
      ? rows.retailer_offers.filter(row => row.product_id === productId)
      : rows.retailer_offers;
    res.json(offers);
  });

  app.get("/public/price-history", (req, res) => {
    const { rows } = loadPublicData();
    const productId = req.query.product_id;
    const snapshots = productId
      ? rows.price_snapshots.filter(row => row.product_id === productId)
      : rows.price_snapshots;
    res.json(snapshots);
  });

  app.get("/public/search", (req, res) => {
    const { rows } = loadPublicData();
    res.json(searchPublicData(rows, req.query.q || ""));
  });

  app.get("/categories", (req, res) => {
    const { rows } = loadPublicData();
    res.json(publicCategories(rows));
  });

  app.get("/brands", (req, res) => {
    const { rows } = loadPublicData();
    res.json(publicBrands(rows));
  });

  app.get("/retailers", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.retailers);
  });

  app.get("/products", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.products);
  });

  app.get("/products/:product_id", (req, res) => {
    const { rows } = loadPublicData();
    const product = productById(rows, req.params.product_id);
    if (!product) return res.status(404).json({ error: "product_not_found" });
    return res.json(product);
  });

  app.get("/products/:product_id/specs", (req, res) => {
    const { rows } = loadPublicData();
    const product = productById(rows, req.params.product_id);
    if (!product) return res.status(404).json({ error: "product_not_found" });
    return res.json({ product_id: product.product_id, specs: {} });
  });

  app.get("/products/:product_id/offers", (req, res) => {
    const { rows } = loadPublicData();
    res.json(offersForProduct(rows, req.params.product_id));
  });

  app.get("/products/:product_id/price-history", (req, res) => {
    const { rows } = loadPublicData();
    res.json(priceHistoryForProduct(rows, req.params.product_id));
  });

  app.get("/search/products", (req, res) => {
    const { rows } = loadPublicData();
    res.json(searchPublicData(rows, req.query.q || "").products);
  });

  app.get("/specs", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.products.map(product => ({ product_id: product.product_id, specs: {} })));
  });

  app.get("/offers", (req, res) => {
    const { rows } = loadPublicData();
    const productId = req.query.product_id;
    res.json(productId ? offersForProduct(rows, productId) : rows.retailer_offers);
  });

  app.get("/offers/:retailer_offer_id/price-history", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.price_snapshots.filter(row => row.retailer_offer_id === req.params.retailer_offer_id));
  });

  app.get("/deals", (req, res) => {
    const { rows } = loadPublicData();
    res.json(rows.retailer_offers.filter(offer => offer.current_price !== null && offer.current_price !== undefined && offer.current_price !== ""));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: "public_api_error", message: error.message });
  });

  return app;
}

function startServer() {
  const startup = loadPublicData();
  const flags = unsafeFlagsEnabled();
  console.log("BuildWise public API starting.");
  console.log({
    data_source_path: DB_FILE,
    product_count: startup.rows.products.length,
    offer_count: startup.rows.retailer_offers.length,
    safe_mode_enabled: true,
    allowed_origins: allowedOrigins(),
    warning: flags.length ? `Unsafe review flags enabled: ${flags.join(", ")}` : null
  });

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`BuildWise public API listening on port ${PORT}.`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer
};
