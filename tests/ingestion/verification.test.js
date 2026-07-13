const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

const core = require("../../buildwise_backend_core");
const { validateIngestionConfig } = require("../../ingestion_config");
const { evaluateCandidate, runRetailerIngestion } = require("../../retailer_ingestion");
const publicSerializers = require("../../public_serializers");
const { stepsForMode } = require("../../pipeline_orchestrator");

const fixtureDir = path.join(__dirname, "..", "fixtures");

function fixture(name) {
  return path.join(fixtureDir, name);
}

function fixtureHtml(name) {
  return fs.readFileSync(fixture(name), "utf8");
}

function makeDb() {
  const db = core.emptyDb();
  db.retailers.push({
    retailer_id: "ret-newegg",
    name: "Newegg",
    domain: "newegg.com",
    active: true
  });
  db.products.push(
    {
      product_id: "cpu-9800x3d",
      category_id: "cpu",
      brand: "AMD",
      model: "Ryzen 7 9800X3D",
      mpn: "100-100001084WOF",
      status: "active"
    },
    {
      product_id: "ssd-990-pro-2tb",
      category_id: "storage",
      brand: "Samsung",
      model: "990 PRO 2TB NVMe SSD",
      status: "active"
    }
  );
  return db;
}

function candidate(overrides = {}) {
  return {
    product_id: "cpu-9800x3d",
    retailer_id: "ret-newegg",
    candidate_url: "https://www.newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877",
    html_path: fixture("exact_mpn_product.html"),
    ...overrides
  };
}

async function promoteOnce(db, overrides = {}) {
  const config = {
    write: true,
    autoPromote: true,
    autoPromoteExact: true,
    autoPromoteStrong: true,
    autoPromoteMinScore: 90,
    allowMarketplace: false,
    allowRefurbished: false,
    discoveryMaxProducts: 10,
    discoveryTargetOffersPerProduct: 1,
    discoveryStaleHours: 720
  };
  const result = await evaluateCandidate(db, candidate(overrides), config);
  if (result.promoted) {
    const { upsertCandidateRecord } = require("../../retailer_ingestion");
    if (upsertCandidateRecord) upsertCandidateRecord(db, result.candidate_record);
  }
  return result;
}

test("exact MPN match auto-promotes and creates one verified offer", async () => {
  const db = makeDb();
  const result = await promoteOnce(db);

  assert.equal(result.status, "promoted");
  assert.equal(result.evaluation.match_status, "verified_exact");
  assert.equal(result.evaluation.match_score, 100);
  assert.equal(db.retailer_offers.length, 1);
  assert.equal(db.retailer_offers[0].url_status, "verified_manual");
  assert.equal(db.retailer_offers[0].url_confidence, 100);
  assert.equal(db.price_snapshots.length, 1);
});

test("exact retailer SKU evidence can promote when MPN is missing", async () => {
  const db = makeDb();
  db.products[0].mpn = null;
  const result = await promoteOnce(db, {
    candidate_url: "https://www.newegg.com/amd-ryzen-7-9800x3d-8-core/p/N82E16819113888",
    html_path: fixture("exact_model_no_mpn_product.html"),
    expected_retailer_sku: "N82E16819113888"
  });

  assert.equal(result.status, "promoted");
  assert.equal(result.evaluation.match_status, "verified_exact");
  assert.ok(result.evaluation.match_score >= 90);
});

test("strong exact CPU model evidence stays promotable without MPN or SKU", async () => {
  const db = makeDb();
  db.products[0].mpn = null;
  const result = await promoteOnce(db, {
    candidate_url: "https://www.newegg.com/amd-ryzen-7-9800x3d-8-core/p/N82E16819113888",
    html_path: fixture("exact_model_no_mpn_product.html")
  });

  assert.equal(result.status, "promoted");
  assert.equal(result.evaluation.match_status, "verified_strong");
  assert.ok(result.evaluation.match_score >= 90);
});

test("capacity mismatch is rejected as a hard conflict", async () => {
  const db = makeDb();
  const result = await evaluateCandidate(db, {
    product_id: "ssd-990-pro-2tb",
    retailer_id: "ret-newegg",
    candidate_url: "https://www.newegg.com/samsung-990-pro-1tb/p/N82E16820147861",
    html_path: fixture("wrong_capacity_product.html")
  }, { write: false, autoPromote: true });

  assert.equal(result.status, "rejected");
  assert.equal(result.evaluation.match_score, 0);
  assert.ok(result.evaluation.hard_conflicts.some(conflict => conflict.reason === "capacity_mismatch"));
});

test("bundle and refurbished variants are not promoted by default", async () => {
  const db = makeDb();
  const result = await evaluateCandidate(db, {
    product_id: "cpu-9800x3d",
    retailer_id: "ret-newegg",
    candidate_url: "https://www.newegg.com/amd-ryzen-7-9800x3d-bundle/p/N82E16819113999",
    html_path: fixture("bundle_refurbished_product.html")
  }, { write: true, autoPromote: true, autoPromoteExact: true, autoPromoteStrong: true });

  assert.equal(result.status, "rejected");
  assert.ok(result.evaluation.hard_conflicts.some(conflict => /bundle|refurbished/.test(conflict.reason)));
});

test("search or category URLs are rejected before scoring", async () => {
  const db = makeDb();
  const result = await evaluateCandidate(db, {
    product_id: "cpu-9800x3d",
    retailer_id: "ret-newegg",
    candidate_url: "https://www.newegg.com/p/pl?d=ryzen+9800x3d"
  }, { write: false, autoPromote: false });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "search_or_category_url");
});

test("canonical URL normalization strips tracking parameters", async () => {
  const db = makeDb();
  const result = await promoteOnce(db, {
    candidate_url: "https://www.newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877?utm_source=x&tag=bad#reviews"
  });

  assert.equal(result.status, "promoted");
  assert.equal(db.retailer_offers[0].retailer_product_url, "https://newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877");
});

test("re-running unchanged candidate does not create duplicate price snapshots", async () => {
  const db = makeDb();
  await promoteOnce(db);
  await promoteOnce(db);

  assert.equal(db.retailer_offers.length, 1);
  assert.equal(db.price_snapshots.length, 1);
});

test("price and availability changes create meaningful snapshots", async () => {
  const db = makeDb();
  await promoteOnce(db);
  await promoteOnce(db, { page_html: fixtureHtml("exact_mpn_product.html").replace("479.99", "469.99") });
  await promoteOnce(db, { page_html: fixtureHtml("exact_mpn_product.html").replace("479.99", "469.99").replace("InStock", "OutOfStock") });

  assert.equal(db.price_snapshots.length, 3);
  assert.equal(db.retailer_offers[0].availability, "out_of_stock");
});

test("scrape failure logging preserves last known valid offer price", () => {
  const db = makeDb();
  db.retailer_offers.push({
    retailer_offer_id: "offer-000001",
    product_id: "cpu-9800x3d",
    retailer_id: "ret-newegg",
    current_price: 479.99
  });

  core.applyScrapeFailure(db, {
    retailer_offer_id: "offer-000001",
    retailer_id: "ret-newegg",
    error_type: "temporary_network_error",
    message: "timeout"
  });

  assert.equal(db.retailer_offers[0].current_price, 479.99);
  assert.equal(db.scrape_errors.length, 1);
});

test("public serializer hides internal candidate and verification fields", async () => {
  const db = makeDb();
  await promoteOnce(db);
  const rows = publicSerializers.publicRetailerOffers(db);

  assert.equal(rows.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(rows[0], "source_url"));
  assert.ok(!Object.prototype.hasOwnProperty.call(rows[0], "url_verification_reasons"));
  assert.equal(rows[0].current_price, null);
});

test("public API aliases return newly verified offer without internal fields", async () => {
  const db = makeDb();
  await promoteOnce(db);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildwise-api-test-"));
  const dbFile = path.join(dir, "db.json");
  core.writeDb(db, dbFile);
  process.env.DB_FILE = dbFile;

  delete require.cache[require.resolve("../../public_api_server")];
  const { createApp } = require("../../public_api_server");
  const server = createApp().listen(0);
  const port = server.address().port;

  try {
    const products = await getJson(`http://127.0.0.1:${port}/products`);
    const offers = await getJson(`http://127.0.0.1:${port}/products/cpu-9800x3d/offers`);
    const deals = await getJson(`http://127.0.0.1:${port}/deals`);

    assert.equal(products.length, 1);
    assert.equal(offers.length, 1);
    assert.equal(deals.length, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(offers[0], "source_url"));
    assert.ok(!Object.prototype.hasOwnProperty.call(offers[0], "url_confidence"));
  } finally {
    server.close();
  }
});

test("low-confidence candidates remain review-only", async () => {
  const db = makeDb();
  const result = await evaluateCandidate(db, {
    product_id: "cpu-9800x3d",
    retailer_id: "ret-newegg",
    candidate_url: "https://www.newegg.com/samsung-990-pro-1tb/p/N82E16820147861",
    html_path: fixture("wrong_capacity_product.html")
  }, { write: true, autoPromote: true });

  assert.notEqual(result.status, "promoted");
  assert.equal(db.retailer_offers.length, 0);
});

test("config validation blocks automatic promotion without WRITE=true", () => {
  const validation = validateIngestionConfig({
    autoPromote: true,
    write: false,
    pipelineMode: "production_sync",
    discoveryDryRun: true,
    trackerDryRun: true,
    promoteDryRun: true,
    autoPromoteMinScore: 90
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes("AUTO_PROMOTE=true requires WRITE=true")));
});

test("production sync runs backup and migration before verification and tracker steps", () => {
  const scripts = stepsForMode("production_sync").map(([script]) => script);

  assert.ok(scripts.indexOf("backup_db.js") > -1);
  assert.ok(scripts.indexOf("migrate_db.js") > -1);
  assert.ok(scripts.indexOf("verify_candidates.js") > -1);
  assert.ok(scripts.indexOf("tracker_updated.js") > -1);
  assert.ok(scripts.indexOf("backup_db.js") < scripts.indexOf("migrate_db.js"));
  assert.ok(scripts.indexOf("migrate_db.js") < scripts.indexOf("verify_candidates.js"));
  assert.ok(scripts.indexOf("migrate_db.js") < scripts.indexOf("tracker_updated.js"));
});

test("runRetailerIngestion dry-run does not mutate db tables", async () => {
  const db = makeDb();
  const before = JSON.stringify(db);
  const candidateFile = path.join(os.tmpdir(), `buildwise-candidates-${Date.now()}.json`);
  fs.writeFileSync(candidateFile, JSON.stringify([candidate()], null, 2));

  const summary = await runRetailerIngestion(db, {
    write: false,
    autoPromote: false,
    discoveryCandidateFile: candidateFile,
    discoveryMaxProducts: 1,
    discoveryTargetOffersPerProduct: 1
  });

  assert.equal(summary.candidate_rows, 1);
  assert.equal(summary.write_enabled, false);
  assert.equal(JSON.stringify(db), before);
});

test("autonomous discovery works without a candidate file", async () => {
  const db = makeDb();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildwise-search-fixtures-"));
  fs.copyFileSync(fixture("exact_mpn_product.html"), path.join(fixtureDir, "exact_mpn_product.html"));
  fs.writeFileSync(path.join(fixtureDir, "ret-newegg_cpu-9800x3d_search.html"), `
    <a href="https://www.newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877" data-fixture="exact_mpn_product.html">AMD Ryzen 7 9800X3D</a>
  `);

  const summary = await runRetailerIngestion(db, {
    write: true,
    autoPromote: true,
    autoPromoteExact: true,
    autoPromoteStrong: true,
    autoPromoteMinScore: 90,
    discoveryMode: "auto",
    discoverySearchFixtureDir: fixtureDir,
    discoveryMaxProducts: 1,
    discoveryTargetOffersPerProduct: 1
  });

  assert.equal(summary.discovery_mode, "auto");
  assert.equal(summary.candidates_discovered, 1);
  assert.equal(summary.promoted, 1);
  assert.equal(db.retailer_offers.length, 1);
  assert.equal(db.retailer_url_candidates.length, 2);
});

test("autonomous discovery suppresses duplicate normalized candidate URLs", async () => {
  const db = makeDb();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildwise-search-fixtures-"));
  fs.copyFileSync(fixture("exact_mpn_product.html"), path.join(fixtureDir, "exact_mpn_product.html"));
  fs.writeFileSync(path.join(fixtureDir, "ret-newegg_cpu-9800x3d_search.html"), `
    <a href="https://www.newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877?utm_source=a" data-fixture="exact_mpn_product.html">AMD Ryzen 7 9800X3D</a>
    <a href="https://newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877" data-fixture="exact_mpn_product.html">AMD Ryzen 7 9800X3D duplicate</a>
  `);

  const summary = await runRetailerIngestion(db, {
    write: false,
    autoPromote: false,
    discoveryMode: "auto",
    discoverySearchFixtureDir: fixtureDir,
    discoveryMaxProducts: 1,
    discoveryTargetOffersPerProduct: 1
  });

  assert.equal(summary.candidates_discovered, 1);
});

test("API filters, pagination headers, and CORS behavior are stable", async () => {
  const db = makeDb();
  await promoteOnce(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildwise-api-filter-test-"));
  const dbFile = path.join(dir, "db.json");
  core.writeDb(db, dbFile);
  process.env.DB_FILE = dbFile;
  process.env.CORS_ALLOWED_ORIGINS = "https://base44.example";

  delete require.cache[require.resolve("../../public_api_server")];
  const { createApp } = require("../../public_api_server");
  const server = createApp().listen(0);
  const port = server.address().port;

  try {
    const products = await getJsonWithStatus(`http://127.0.0.1:${port}/products?category_id=cpu&search=9800&limit=1&offset=0`, { Origin: "https://base44.example" });
    const rejected = await getJsonWithStatus(`http://127.0.0.1:${port}/products`, { Origin: "https://elsewhere.example" });

    assert.equal(products.statusCode, 200);
    assert.equal(products.headers["x-total-count"], "1");
    assert.equal(products.headers["access-control-allow-origin"], "https://base44.example");
    assert.equal(products.json.length, 1);
    assert.equal(rejected.statusCode, 403);
  } finally {
    server.close();
  }
});

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function getJsonWithStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, headers: response.headers, json: body ? JSON.parse(body) : null });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}
