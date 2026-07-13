/**
 * BuildWise purpose:
 * Prove Base44 can consume public-safe data after an autonomous fixture-backed ingestion run.
 *
 * Plain-English summary:
 * This starts from a product with no offer, discovers a fixture search result, promotes a verified offer, starts the API, and checks Base44-facing routes.
 *
 * Safety note:
 * Uses only temp files and local fixtures. It does not touch production db.json or live retailer pages.
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const core = require("../buildwise_backend_core");
const { runRetailerIngestion } = require("../retailer_ingestion");

const FORBIDDEN_FIELDS = [
  "source_url",
  "discovery_query",
  "hard_conflicts",
  "match_reasons",
  "review_notes",
  "reviewer_notes",
  "url_confidence",
  "url_verified_at",
  "url_verified_by",
  "source_terms_status",
  "scrape_errors",
  "source_compliance_log"
];

function makeDb() {
  const db = core.emptyDb();
  db.categories.push({ category_id: "cpu", name: "CPU" });
  db.retailers.push({ retailer_id: "ret-newegg", name: "Newegg", domain: "newegg.com", active: true });
  db.products.push({
    product_id: "cpu-9800x3d",
    category_id: "cpu",
    brand: "AMD",
    model: "Ryzen 7 9800X3D",
    slug: "amd-ryzen-7-9800x3d",
    mpn: "100-100001084WOF",
    status: "active"
  });
  return db;
}

function hasForbiddenField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenField);
  return Object.keys(value).some(key => FORBIDDEN_FIELDS.includes(key)) ||
    Object.values(value).some(hasForbiddenField);
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
      });
      response.on("end", () => {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch (error) {
          return reject(error);
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, json });
      });
    });
    req.on("error", reject);
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildwise-base44-smoke-"));
  const fixtureDir = path.join(tempDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const productFixture = path.join(__dirname, "..", "tests", "fixtures", "exact_mpn_product.html");
  fs.copyFileSync(productFixture, path.join(fixtureDir, "exact_mpn_product.html"));
  fs.writeFileSync(path.join(fixtureDir, "ret-newegg_cpu-9800x3d_search.html"), `
    <!doctype html>
    <html><body>
      <a href="https://www.newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877" data-fixture="exact_mpn_product.html">AMD Ryzen 7 9800X3D Desktop Processor</a>
    </body></html>
  `);

  const db = makeDb();
  const summary = await runRetailerIngestion(db, {
    write: true,
    autoPromote: true,
    autoPromoteExact: true,
    autoPromoteStrong: true,
    autoPromoteMinScore: 90,
    discoveryMode: "auto",
    discoverySearchFixtureDir: fixtureDir,
    discoveryMaxProducts: 1,
    discoveryTargetOffersPerProduct: 1,
    allowLiveFetch: false
  });

  if (summary.candidates_discovered !== 1) throw new Error("Expected one autonomously discovered fixture candidate.");
  if (summary.promoted !== 1) throw new Error("Expected one promoted offer.");
  if (db.retailer_offers.length !== 1) throw new Error("Expected one inserted offer.");
  if (db.price_snapshots.length !== 1) throw new Error("Expected one internal price snapshot.");

  db.pipeline_runs.push({
    run_id: "pipe-000001",
    mode: "production_sync",
    status: "complete",
    started_at: core.nowBase44DateTime(),
    finished_at: core.nowBase44DateTime()
  });

  const dbFile = path.join(tempDir, "db.json");
  core.writeDb(db, dbFile);
  process.env.DB_FILE = dbFile;
  process.env.CORS_ALLOWED_ORIGINS = "https://base44.example";
  process.env.PUBLIC_API_RATE_LIMIT_PER_MINUTE = "0";

  delete require.cache[require.resolve("../public_api_server")];
  const { createApp } = require("../public_api_server");
  const server = createApp().listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await requestJson(`${base}/health`);
    const status = await requestJson(`${base}/public/status`);
    const products = await requestJson(`${base}/products?limit=10&offset=0&search=9800X3D`);
    const offers = await requestJson(`${base}/products/cpu-9800x3d/offers`);
    const priceHistory = await requestJson(`${base}/products/cpu-9800x3d/price-history`);
    const categories = await requestJson(`${base}/categories`);
    const brands = await requestJson(`${base}/brands`);
    const retailers = await requestJson(`${base}/retailers`);
    const deals = await requestJson(`${base}/deals`);
    const search = await requestJson(`${base}/search/products?q=Ryzen`);
    const corsAllowed = await requestJson(`${base}/products`, { Origin: "https://base44.example" });
    const corsRejected = await requestJson(`${base}/products`, { Origin: "https://not-base44.example" });

    if (!health.json.ok) throw new Error("Health route did not return ok=true.");
    if (status.json.base44_update_mode !== "api_live") throw new Error("Expected Base44 update mode api_live.");
    if (products.json.length !== 1) throw new Error("Expected one public product.");
    if (offers.json.length !== 1) throw new Error("Expected one public offer.");
    if (priceHistory.json.length !== 0) throw new Error("Unverified price history should stay hidden.");
    if (categories.json.length !== 1 || brands.json.length !== 1 || retailers.json.length !== 1) throw new Error("Reference endpoints returned unexpected counts.");
    if (deals.json.length !== 0) throw new Error("Deals should stay empty while prices are unverified.");
    if (search.json.length !== 1) throw new Error("Search endpoint did not find fixture product.");
    if (corsAllowed.statusCode !== 200 || corsAllowed.headers["access-control-allow-origin"] !== "https://base44.example") throw new Error("Allowed CORS origin failed.");
    if (corsRejected.statusCode !== 403) throw new Error("Rejected CORS origin was not blocked.");
    for (const payload of [health.json, status.json, products.json, offers.json, priceHistory.json, categories.json, brands.json, retailers.json, deals.json, search.json]) {
      if (hasForbiddenField(payload)) throw new Error("Forbidden internal field leaked in public API response.");
    }

    console.log("BUILDWISE_BASE44_SMOKE_PASS " + JSON.stringify({
      candidates_discovered: summary.candidates_discovered,
      promoted: summary.promoted,
      internal_snapshots_created: db.price_snapshots.length,
      public_products: products.json.length,
      public_offers: offers.json.length,
      public_price_history: priceHistory.json.length,
      base44_update_mode: status.json.base44_update_mode,
      cors_allowed: corsAllowed.statusCode,
      cors_rejected: corsRejected.statusCode,
      temp_dir: tempDir
    }, null, 2));
  } finally {
    server.close();
  }
}

main().catch(error => {
  console.error("BUILDWISE_BASE44_SMOKE_FAIL", error.message);
  process.exitCode = 1;
});
