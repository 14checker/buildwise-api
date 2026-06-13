const axios = require("axios");
const cheerio = require("cheerio");
const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const MAX_DISCOVERIES_PER_SOURCE = Number(process.env.MAX_DISCOVERIES_PER_SOURCE || 100);
const MIN_MATCH_CONFIDENCE = Number(process.env.MIN_MATCH_CONFIDENCE || 82);

function now() {
  return core.nowBase44DateTime();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeModel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9.\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const stop = new Set(["the", "and", "with", "for", "new", "edition", "version", "black", "white", "rgb", "oc", "pro", "plus", "max"]);
  return normalizeModel(value)
    .split(" ")
    .map(t => t.trim())
    .filter(t => t && !stop.has(t));
}

function jaccard(a, b) {
  const aa = new Set(a);
  const bb = new Set(b);
  const intersection = [...aa].filter(x => bb.has(x)).length;
  const union = new Set([...aa, ...bb]).size;
  return union === 0 ? 0 : intersection / union;
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, "").replace(/\s+/g, " ");
  const match = cleaned.match(/\$?\s*([0-9]+(?:\.[0-9]{2})?)/);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href || "";
  }
}

function getDiscoverySources(db) {
  const envUrls = String(process.env.DISCOVERY_URLS || "")
    .split(/[;,\n]/g)
    .map(s => s.trim())
    .filter(Boolean)
    .map((url, i) => ({
      discovery_source_id: `env-source-${String(i + 1).padStart(3, "0")}`,
      source_url: url,
      source_type: "env",
      active: true
    }));

  if (envUrls.length) return envUrls;

  if (Array.isArray(db.discovery_sources) && db.discovery_sources.length) {
    return db.discovery_sources.filter(source => core.normalizeKey(source.active || "true") !== "false");
  }

  return [];
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": "BuildWiseDiscovery/0.1 contact: 14checker@gmail.com",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 400
  });

  return data;
}

function getKnownBrands(db) {
  const brands = new Set();
  for (const row of db.brands || []) brands.add(String(row.brand_name || row.brand || "").trim());
  for (const product of db.products || []) brands.add(String(product.brand || "").trim());
  return [...brands].filter(Boolean).sort((a, b) => b.length - a.length);
}

function inferBrand(name, db) {
  const lower = String(name || "").toLowerCase();
  const knownBrands = getKnownBrands(db);
  const matched = knownBrands.find(brand => lower.includes(brand.toLowerCase()));
  if (matched) return matched;
  return normalizeText(name).split(" ")[0] || "Unknown";
}

function inferCategory(name) {
  const text = String(name || "").toLowerCase();

  if (/\b(ryzen|core\s+i[3579]|core\s+ultra|threadripper|intel\s+core)\b/.test(text)) return "cpu";
  if (/\b(rtx\s*\d{4}|geforce|radeon|rx\s*\d{4}|graphics card|gpu|arc\s+[ab]\d{3})\b/.test(text)) return "gpu";
  if (/\b(x870|x670|b650|a620|z790|z690|b760|motherboard|mainboard|atx|mini-itx|micro-atx)\b/.test(text)) return "motherboard";
  if (/\b(ddr4|ddr5|memory kit|ram|cl\d{2}|\d{4}\s*mhz)\b/.test(text)) return "ram";
  if (/\b(nvme|ssd|hdd|m\.2|sata|pcie\s*gen|\d+\s*tb|\d+\s*gb)\b/.test(text) && !/ram|memory kit/i.test(text)) return "storage";
  if (/\b(power supply|psu|80\+|\d{3,4}\s*w|atx\s*3\.0)\b/.test(text)) return "psu";
  if (/\b(case|chassis|tower|tempered glass|airflow)\b/.test(text)) return "case";

  return "unknown";
}

function categoryPrefix(category) {
  return {
    cpu: "cpu",
    gpu: "gpu",
    motherboard: "mb",
    ram: "ram",
    storage: "ssd",
    psu: "psu",
    case: "case"
  }[category] || "prod";
}

function nextProductId(db, category, brand, model) {
  const prefix = categoryPrefix(category);
  const slug = slugify(`${brand}-${model}`).slice(0, 80);
  let max = 0;

  for (const product of db.products || []) {
    const id = String(product.product_id || "");
    const match = id.match(new RegExp(`^${prefix}-.+-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }

  for (const row of db.product_insert_queue || []) {
    const id = String(row.product_id || "");
    const match = id.match(new RegExp(`^${prefix}-.+-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }

  return `${prefix}-${slug}-${String(max + 1).padStart(3, "0")}`;
}

function comparableKey(category, brand, model) {
  const m = normalizeModel(model);
  const b = slugify(brand);

  if (category === "cpu") {
    const ryzen = m.match(/ryzen\s+([3579])\s+(\d{4,5})(x3d|x|g|f|d)?/i);
    if (ryzen) return slugify(`cpu-${b}-${ryzen[1]}-${ryzen[2]}-${ryzen[3] || ""}`);
    const intel = m.match(/core\s+(ultra\s+)?i?([3579])\s*(\d{3,5})([a-z]*)/i);
    if (intel) return slugify(`cpu-${b}-${intel[1] || ""}-${intel[2]}-${intel[3]}-${intel[4] || ""}`);
  }

  if (category === "gpu") {
    const rtx = m.match(/rtx\s+(\d{4})(\s*ti)?(\s*super)?/i);
    if (rtx) return slugify(`gpu-${b}-rtx-${rtx[1]}-${rtx[2] ? "ti" : ""}-${rtx[3] ? "super" : ""}`);
    const rx = m.match(/rx\s+(\d{4})(\s*xtx|\s*xt)?/i);
    if (rx) return slugify(`gpu-${b}-rx-${rx[1]}-${rx[2] || ""}`);
  }

  return slugify(`${category}-${b}-${tokenize(model).slice(0, 5).join("-")}`);
}

function buildExistingProductIndex(db) {
  return db.products.map(product => ({
    product,
    key: comparableKey(product.category_id, product.brand, product.model),
    tokens: tokenize(`${product.brand} ${product.model}`)
  }));
}

function findBestMatch(db, candidate) {
  const existing = buildExistingProductIndex(db).filter(row => row.product.category_id === candidate.category_id);
  const candidateKey = comparableKey(candidate.category_id, candidate.brand, candidate.model);
  const candidateTokens = tokenize(`${candidate.brand} ${candidate.model}`);

  let best = null;

  for (const row of existing) {
    let score = Math.round(jaccard(candidateTokens, row.tokens) * 100);
    if (row.key === candidateKey) score = Math.max(score, 96);

    if (!best || score > best.score) {
      best = { product: row.product, score, key: row.key };
    }
  }

  if (!best) return null;
  return best;
}

function extractJsonLdProducts(html, baseUrl, db) {
  const $ = cheerio.load(html);
  const products = [];

  $('script[type="application/ld+json"]').each((i, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      const flattened = [];

      function walk(value) {
        if (!value) return;
        if (Array.isArray(value)) return value.forEach(walk);
        if (typeof value === "object") {
          flattened.push(value);
          if (value["@graph"]) walk(value["@graph"]);
          if (value.itemListElement) walk(value.itemListElement);
          if (value.item) walk(value.item);
        }
      }

      nodes.forEach(walk);

      for (const node of flattened) {
        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
        if (!/product/i.test(type) && !node.name) continue;

        const name = normalizeText(node.name || node.item?.name || "");
        if (!name || name.length < 5) continue;

        const brandValue = typeof node.brand === "object" ? node.brand.name : node.brand;
        const brand = normalizeText(brandValue) || inferBrand(name, db);
        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
        const url = absoluteUrl(baseUrl, node.url || offers.url || "");

        products.push({
          name,
          brand,
          model: name.replace(new RegExp(`^${brand}\\s+`, "i"), "").trim() || name,
          mpn: node.mpn || node.sku || null,
          price: offers.price ? Number(offers.price) : parsePrice(offers.lowPrice || offers.highPrice || ""),
          availability: offers.availability ? String(offers.availability).split("/").pop() : null,
          url,
          source_parser: "json_ld"
        });
      }
    } catch {
      // Ignore broken JSON-LD blocks.
    }
  });

  return products;
}

function extractLinkedProducts(html, baseUrl, db) {
  const $ = cheerio.load(html);
  const products = [];
  const seen = new Set();

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    const text = normalizeText($(el).text());
    const url = absoluteUrl(baseUrl, href);

    if (!text || text.length < 8) return;
    if (seen.has(url + text)) return;
    if (!/(cpu|processor|ryzen|core|rtx|geforce|radeon|motherboard|ddr|ram|ssd|nvme|psu|power supply|case|pcpartpicker|product)/i.test(url + " " + text)) return;

    seen.add(url + text);

    const brand = inferBrand(text, db);
    products.push({
      name: text,
      brand,
      model: text.replace(new RegExp(`^${brand}\\s+`, "i"), "").trim() || text,
      mpn: null,
      price: null,
      availability: null,
      url,
      source_parser: "linked_product"
    });
  });

  return products.slice(0, MAX_DISCOVERIES_PER_SOURCE);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const rows = [];

  for (const candidate of candidates) {
    const key = `${candidate.name}|${candidate.url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(candidate);
  }

  return rows;
}

function nextDiscoveryId(db) {
  let max = 0;
  for (const row of db.discovered_products || []) {
    const match = String(row.discovery_id || "").match(/^disc-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `disc-${String(max + 1).padStart(6, "0")}`;
}

function nextOfferDiscoveryId(db) {
  let max = 0;
  for (const row of db.discovered_offers || []) {
    const match = String(row.discovery_offer_id || "").match(/^disc-offer-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `disc-offer-${String(max + 1).padStart(6, "0")}`;
}

function nextSpecQueueId(db) {
  let max = 0;
  for (const row of db.component_spec_insert_queue || []) {
    const match = String(row.spec_queue_id || "").match(/^specq-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `specq-${String(max + 1).padStart(6, "0")}`;
}

function nextProductQueueId(db) {
  let max = 0;
  for (const row of db.product_insert_queue || []) {
    const match = String(row.queue_id || "").match(/^prodq-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `prodq-${String(max + 1).padStart(6, "0")}`;
}

function targetSpecTable(category) {
  return {
    cpu: "cpu_specs",
    gpu: "gpu_specs",
    motherboard: "motherboard_specs",
    ram: "ram_specs",
    storage: "storage_specs",
    psu: "psu_specs",
    case: "case_specs"
  }[category] || null;
}

function extractBasicSpecs(category, name) {
  const text = String(name || "");

  if (category === "cpu") {
    return {
      socket: /ryzen\s+[579]\s+9\d{3,4}|ryzen\s+[579]\s+7\d{3,4}/i.test(text) ? "AM5" : null,
      cores: null,
      threads: null,
      base_clock_ghz: null,
      boost_clock_ghz: null,
      tdp_watts: null,
      integrated_graphics: null
    };
  }

  if (category === "gpu") {
    const vram = text.match(/\b(8|10|12|16|20|24|32)\s*gb\b/i);
    return {
      vram_gb: vram ? Number(vram[1]) : null,
      memory_type: /gddr7/i.test(text) ? "GDDR7" : /gddr6x/i.test(text) ? "GDDR6X" : /gddr6/i.test(text) ? "GDDR6" : null,
      boost_clock_mhz: null,
      tdp_watts: null,
      length_mm: null,
      ray_tracing: /rtx|radeon|rx/i.test(text) ? true : null
    };
  }

  if (category === "ram") {
    const capacity = text.match(/\b(16|24|32|48|64|96|128)\s*gb\b/i);
    const speed = text.match(/\b(4\d{3}|5\d{3}|6\d{3}|7\d{3}|8\d{3})\s*mhz\b/i) || text.match(/\b(4\d{3}|5\d{3}|6\d{3}|7\d{3}|8\d{3})\b/);
    const cl = text.match(/\bcl\s*(\d{2})\b/i);
    return {
      capacity_gb: capacity ? Number(capacity[1]) : null,
      speed_mhz: speed ? Number(speed[1]) : null,
      ddr_type: /ddr5/i.test(text) ? "DDR5" : /ddr4/i.test(text) ? "DDR4" : null,
      cas_latency: cl ? Number(cl[1]) : null,
      rgb: /rgb/i.test(text) ? true : null,
      voltage: null
    };
  }

  return {};
}

function ensureDiscoveryTables(db) {
  db.discovery_sources = Array.isArray(db.discovery_sources) ? db.discovery_sources : [];
  db.discovered_products = Array.isArray(db.discovered_products) ? db.discovered_products : [];
  db.discovered_offers = Array.isArray(db.discovered_offers) ? db.discovered_offers : [];
  db.product_insert_queue = Array.isArray(db.product_insert_queue) ? db.product_insert_queue : [];
  db.component_spec_insert_queue = Array.isArray(db.component_spec_insert_queue) ? db.component_spec_insert_queue : [];
}

function saveCandidate(db, source, candidate) {
  const category = inferCategory(candidate.name);
  if (category === "unknown") return { saved: false, reason: "unknown_category" };

  const brand = candidate.brand || inferBrand(candidate.name, db);
  const model = candidate.model || candidate.name;
  const bestMatch = findBestMatch(db, { category_id: category, brand, model });
  const matched = bestMatch && bestMatch.score >= MIN_MATCH_CONFIDENCE;

  const discoveryId = nextDiscoveryId(db);
  const newProductId = matched ? null : nextProductId(db, category, brand, model);
  const targetTable = targetSpecTable(category);

  const discoveredProduct = {
    discovery_id: discoveryId,
    source_id: source.discovery_source_id || null,
    source_url: source.source_url,
    discovered_url: candidate.url || null,
    source_parser: candidate.source_parser || null,
    candidate_category_id: category,
    candidate_brand: brand,
    candidate_model: model,
    candidate_slug: slugify(`${brand}-${model}`),
    candidate_mpn: candidate.mpn || null,
    candidate_msrp: candidate.price || null,
    matched_product_id: matched ? bestMatch.product.product_id : null,
    matched_group_id: null,
    match_confidence: matched ? bestMatch.score : 0,
    action_recommendation: matched ? "map_to_existing_product" : "create_new_product_row",
    target_table: "products",
    target_spec_table: targetTable,
    status: matched ? "matched_existing" : "new_row_candidate",
    created_at: now()
  };

  db.discovered_products.push(discoveredProduct);

  if (candidate.price || candidate.url) {
    db.discovered_offers.push({
      discovery_offer_id: nextOfferDiscoveryId(db),
      discovery_id: discoveryId,
      candidate_product_id: newProductId,
      matched_product_id: discoveredProduct.matched_product_id,
      retailer_id: null,
      merchant_name: null,
      price: candidate.price || null,
      availability: candidate.availability || null,
      discovered_url: candidate.url || null,
      matched_retailer_offer_id: null,
      status: matched ? "matched_existing_product" : "new_offer_candidate",
      created_at: now()
    });
  }

  if (!matched) {
    db.product_insert_queue.push({
      queue_id: nextProductQueueId(db),
      source_discovery_id: discoveryId,
      product_id: newProductId,
      category_id: category,
      brand,
      model,
      slug: slugify(`${brand}-${model}`),
      mpn: candidate.mpn || null,
      msrp: candidate.price || null,
      status: "review",
      target_table: "products",
      review_status: "pending",
      created_at: now()
    });

    db.component_spec_insert_queue.push({
      spec_queue_id: nextSpecQueueId(db),
      source_discovery_id: discoveryId,
      product_id: newProductId,
      category_id: category,
      target_spec_table: targetTable,
      extracted_json: JSON.stringify(extractBasicSpecs(category, candidate.name)),
      review_status: "pending",
      created_at: now()
    });
  }

  return { saved: true, matched, category, discoveryId };
}

async function discoverFromSource(db, source) {
  console.log(`\nDiscovering from: ${source.source_url}`);
  const html = await fetchHtml(source.source_url);
  const candidates = dedupeCandidates([
    ...extractJsonLdProducts(html, source.source_url, db),
    ...extractLinkedProducts(html, source.source_url, db)
  ]).slice(0, MAX_DISCOVERIES_PER_SOURCE);

  console.log(`Candidates found: ${candidates.length}`);

  const results = [];
  for (const candidate of candidates) {
    const result = saveCandidate(db, source, candidate);
    if (result.saved) results.push(result);
  }

  console.log(`Candidates saved: ${results.length}`);
  return results;
}

async function main() {
  const db = core.readDb(DB_FILE);
  ensureDiscoveryTables(db);

  const sources = getDiscoverySources(db);

  if (!sources.length) {
    console.log("No discovery sources found.");
    console.log("Add db.discovery_sources rows or run with:");
    console.log('$env:DISCOVERY_URLS="https://example.com/products/cpu;https://example.com/products/gpu"');
    return;
  }

  const before = core.getSummary(db);
  const allResults = [];

  for (const source of sources) {
    try {
      const results = await discoverFromSource(db, source);
      allResults.push(...results);
      await sleep(Number(process.env.DISCOVERY_DELAY_MS || 1000));
    } catch (err) {
      core.applyScrapeFailure(db, {
        retailer_offer_id: null,
        retailer_id: null,
        error_type: "discovery_error",
        message: `${err.message}. Source=${source.source_url}`
      });
      console.error(`Discovery failed: ${err.message}`);
    }
  }

  const after = core.getSummary(db);

  if (!DRY_RUN) core.writeDb(db, DB_FILE);

  console.log("\nDiscovery complete.");
  console.log({ dry_run: DRY_RUN, sources: sources.length, saved_candidates: allResults.length });
  console.log("Before:", before);
  console.log("After:", after);

  if (DRY_RUN) {
    console.log("Dry run only. Set $env:DRY_RUN=\"false\" to save candidates into db.json.");
  }
}

main().catch(err => {
  console.error("Fatal discovery error:", err.message);
  process.exit(1);
});
