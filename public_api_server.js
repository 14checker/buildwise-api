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

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(corsMiddleware);
  app.use(rateLimitMiddleware);

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      safe_mode: true
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
