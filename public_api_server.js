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
const API_VERSION = process.env.PUBLIC_API_VERSION || "v1";
const PORT = Number(process.env.PORT || 8080);
const API_HOST = process.env.API_HOST || "0.0.0.0";
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
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || process.env.BASE44_ALLOWED_ORIGINS || "")
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
    dbFile: DB_FILE,
    publicApiLive: true
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

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function paginate(rows, query = {}) {
  const total = rows.length;
  const limit = Math.max(1, Math.min(100, parseNumber(query.limit, 25)));
  const offset = Math.max(0, parseNumber(query.offset, 0));
  const data = rows.slice(offset, offset + limit);
  return {
    data,
    meta: {
      count: data.length,
      total,
      limit,
      offset,
      has_more: offset + data.length < total
    }
  };
}

function sendList(req, res, rows) {
  const page = paginate(rows, req.query);
  res.setHeader("X-Total-Count", String(page.meta.total));
  res.setHeader("X-Result-Count", String(page.meta.count));
  res.setHeader("X-Limit", String(page.meta.limit));
  res.setHeader("X-Offset", String(page.meta.offset));
  res.setHeader("X-Has-More", String(page.meta.has_more));
  return res.json(page.data);
}

function sortRows(rows, sort) {
  const key = String(sort || "").toLowerCase();
  const copy = rows.slice();
  if (key === "brand") copy.sort((a, b) => String(a.brand || "").localeCompare(String(b.brand || "")));
  if (key === "model") copy.sort((a, b) => String(a.model || "").localeCompare(String(b.model || "")));
  if (key === "price_asc") copy.sort((a, b) => Number(a.current_price ?? Infinity) - Number(b.current_price ?? Infinity));
  if (key === "price_desc") copy.sort((a, b) => Number(b.current_price ?? -Infinity) - Number(a.current_price ?? -Infinity));
  return copy;
}

function filterProducts(rows, query = {}) {
  let products = rows.products || [];
  const offers = rows.retailer_offers || [];
  const productIdsWithOffers = new Set(offers.map(offer => offer.product_id));
  const productIdsInStock = new Set(offers.filter(offer => normalizeText(offer.availability) === "in_stock").map(offer => offer.product_id));
  const pricedByProduct = new Map();
  for (const offer of offers) {
    const price = Number(offer.current_price);
    if (Number.isFinite(price)) {
      const current = pricedByProduct.get(offer.product_id) || [];
      current.push(price);
      pricedByProduct.set(offer.product_id, current);
    }
  }

  if (query.category_id) products = products.filter(product => normalizeText(product.category_id) === normalizeText(query.category_id));
  if (query.brand_id || query.brand) {
    const brand = query.brand_id || query.brand;
    products = products.filter(product => normalizeText(product.brand) === normalizeText(brand));
  }
  if (query.search) {
    const q = normalizeText(query.search);
    products = products.filter(product => [product.product_id, product.brand, product.model, product.slug, product.mpn].some(value => normalizeText(value).includes(q)));
  }
  if (String(query.has_offers || "").toLowerCase() === "true") products = products.filter(product => productIdsWithOffers.has(product.product_id));
  if (String(query.in_stock || "").toLowerCase() === "true") products = products.filter(product => productIdsInStock.has(product.product_id));
  if (query.min_price || query.max_price) {
    const min = parseNumber(query.min_price, 0);
    const max = parseNumber(query.max_price, Infinity);
    products = products.filter(product => (pricedByProduct.get(product.product_id) || []).some(price => price >= min && price <= max));
  }
  return sortRows(products, query.sort);
}

function filterOffers(rows, query = {}) {
  let offers = rows.retailer_offers || [];
  if (query.product_id) offers = offers.filter(offer => offer.product_id === query.product_id);
  if (query.retailer_id) offers = offers.filter(offer => offer.retailer_id === query.retailer_id);
  if (query.availability) offers = offers.filter(offer => normalizeText(offer.availability) === normalizeText(query.availability));
  if (query.condition) offers = offers.filter(offer => normalizeText(offer.condition) === normalizeText(query.condition));
  return sortRows(offers, query.sort);
}

function filterDeals(rows, query = {}) {
  const productsById = new Map((rows.products || []).map(product => [product.product_id, product]));
  let deals = (rows.retailer_offers || []).filter(offer => offer.current_price !== null && offer.current_price !== undefined && offer.current_price !== "");
  if (query.category_id) deals = deals.filter(offer => normalizeText(productsById.get(offer.product_id)?.category_id) === normalizeText(query.category_id));
  if (query.brand_id || query.brand) {
    const brand = query.brand_id || query.brand;
    deals = deals.filter(offer => normalizeText(productsById.get(offer.product_id)?.brand) === normalizeText(brand));
  }
  if (query.retailer_id) deals = deals.filter(offer => offer.retailer_id === query.retailer_id);
  if (query.availability) deals = deals.filter(offer => normalizeText(offer.availability) === normalizeText(query.availability));
  return sortRows(deals, query.sort);
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
      service: "buildwise-api",
      environment: process.env.NODE_ENV || "development",
      api_version: API_VERSION,
      safe_mode: true,
      status: status.status,
      data_last_updated_at: status.generated_at,
      last_successful_pipeline_run_at: status.last_successful_pipeline_run_at,
      last_pipeline_status: status.pipeline_status,
      base44_ready: status.base44_ready,
      base44_update_mode: status.base44_update_mode,
      base44_should_pull: status.base44_should_pull,
      counts: {
        products: rows.products.length,
        retailer_offers: rows.retailer_offers.length,
        retailers: rows.retailers.length,
        price_snapshots: rows.price_snapshots.length
      }
    });
  });

  app.get("/public/status", (req, res) => {
    const { rows, status } = loadPublicData();
    res.json({
      service: "buildwise-api",
      environment: process.env.NODE_ENV || "development",
      api_version: API_VERSION,
      ...status,
      products_public: status.products_count,
      offers_public: status.retailer_offers_count,
      offers_with_verified_price: rows.retailer_offers.filter(offer => offer.current_price !== null && offer.current_price !== undefined && offer.current_price !== "").length,
      price_snapshots_public: status.price_snapshots_count
    });
  });

  app.get("/public/products", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, filterProducts(rows, req.query));
  });

  app.get("/public/products/:product_id", (req, res) => {
    const { rows } = loadPublicData();
    const product = rows.products.find(row => row.product_id === req.params.product_id);
    if (!product) return res.status(404).json({ error: "product_not_found" });
    return res.json(product);
  });

  app.get("/public/retailers", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, rows.retailers);
  });

  app.get("/public/offers", (req, res) => {
    const { rows } = loadPublicData();
    const productId = req.query.product_id;
    const offers = productId
      ? rows.retailer_offers.filter(row => row.product_id === productId)
      : rows.retailer_offers;
    sendList(req, res, filterOffers({ ...rows, retailer_offers: offers }, req.query));
  });

  app.get("/public/price-history", (req, res) => {
    const { rows } = loadPublicData();
    const productId = req.query.product_id;
    const snapshots = productId
      ? rows.price_snapshots.filter(row => row.product_id === productId)
      : rows.price_snapshots;
    sendList(req, res, snapshots);
  });

  app.get("/public/search", (req, res) => {
    const { rows } = loadPublicData();
    res.json(searchPublicData(rows, req.query.q || ""));
  });

  app.get("/categories", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, publicCategories(rows));
  });

  app.get("/brands", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, publicBrands(rows));
  });

  app.get("/retailers", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, rows.retailers);
  });

  app.get("/products", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, filterProducts(rows, req.query));
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
    sendList(req, res, filterOffers({ ...rows, retailer_offers: offersForProduct(rows, req.params.product_id) }, req.query));
  });

  app.get("/products/:product_id/price-history", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, priceHistoryForProduct(rows, req.params.product_id));
  });

  app.get("/search/products", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, searchPublicData(rows, req.query.q || req.query.search || "").products);
  });

  app.get("/specs", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, rows.products.map(product => ({ product_id: product.product_id, specs: {} })));
  });

  app.get("/offers", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, filterOffers(rows, req.query));
  });

  app.get("/offers/:retailer_offer_id/price-history", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, rows.price_snapshots.filter(row => row.retailer_offer_id === req.params.retailer_offer_id));
  });

  app.get("/deals", (req, res) => {
    const { rows } = loadPublicData();
    sendList(req, res, filterDeals(rows, req.query));
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
  const server = app.listen(PORT, API_HOST, () => {
    console.log(`BuildWise public API listening on port ${PORT}.`);
  });

  return server;
}

if (require.main === module) {
  const server = startServer();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`Received ${signal}; shutting down BuildWise public API.`);
      server.close(() => process.exit(0));
    });
  }
}

module.exports = {
  createApp,
  filterDeals,
  filterOffers,
  filterProducts,
  paginate,
  startServer
};
