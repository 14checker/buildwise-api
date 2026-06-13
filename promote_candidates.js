const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const AUTO_PROMOTE = String(process.env.AUTO_PROMOTE || "false").toLowerCase() === "true";
const PROMOTE_LIMIT = Number(process.env.PROMOTE_LIMIT || 50);

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function nextSequentialId(rows, field, prefix, width) {
  let max = 0;
  for (const row of rows || []) {
    const value = row?.[field];
    if (!value || typeof value !== "string") continue;
    const match = value.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${pad(max + 1, width)}`;
}

function ensureTables(db) {
  db.promotion_log = Array.isArray(db.promotion_log) ? db.promotion_log : [];
  db.product_insert_queue = Array.isArray(db.product_insert_queue) ? db.product_insert_queue : [];
  db.component_spec_insert_queue = Array.isArray(db.component_spec_insert_queue) ? db.component_spec_insert_queue : [];
  db.discovered_offers = Array.isArray(db.discovered_offers) ? db.discovered_offers : [];
}

function specColumnsForTable(tableName) {
  return {
    cpu_specs: ["product_id", "socket", "cores", "threads", "base_clock_ghz", "boost_clock_ghz", "tdp_watts", "integrated_graphics"],
    gpu_specs: ["product_id", "vram_gb", "memory_type", "boost_clock_mhz", "tdp_watts", "length_mm", "ray_tracing"],
    motherboard_specs: ["product_id", "chipset", "socket", "form_factor", "ram_support", "pcie_gen", "wifi", "m2_slots"],
    ram_specs: ["product_id", "capacity_gb", "speed_mhz", "ddr_type", "cas_latency", "rgb", "voltage"],
    storage_specs: ["product_id", "capacity_gb", "type", "interface", "read_speed_mbps", "write_speed_mbps", "dram_cache"],
    psu_specs: ["product_id", "wattage", "efficiency", "modular", "atx_standard", "pcie_5_ready", "fan_size_mm"],
    case_specs: ["product_id", "form_factor_support", "gpu_clearance_mm", "cpu_cooler_clearance_mm", "included_fans", "tempered_glass", "front_panel"]
  }[tableName] || ["product_id"];
}

function shouldPromote(row) {
  const status = core.normalizeKey(row.review_status || row.status);
  if (AUTO_PROMOTE && ["pending", "new_row_candidate", "needs_review", "review"].includes(status)) return true;
  return ["approved", "approve"].includes(status);
}

function productExists(db, productId) {
  return db.products.some(product => product.product_id === productId);
}

function specExists(db, tableName, productId) {
  return Array.isArray(db[tableName]) && db[tableName].some(row => row.product_id === productId);
}

function createProductRow(queueRow) {
  return {
    product_id: queueRow.product_id,
    category_id: queueRow.category_id,
    brand: queueRow.brand,
    model: queueRow.model,
    slug: queueRow.slug,
    mpn: queueRow.mpn || null,
    msrp: queueRow.msrp === undefined ? null : queueRow.msrp,
    status: "active"
  };
}

function createSpecRow(specQueueRow) {
  const tableName = specQueueRow.target_spec_table;
  const columns = specColumnsForTable(tableName);

  let extracted = {};
  try {
    extracted = JSON.parse(specQueueRow.extracted_json || "{}");
  } catch {
    extracted = {};
  }

  const row = {};
  for (const col of columns) row[col] = col === "product_id" ? specQueueRow.product_id : extracted[col] ?? null;
  return row;
}

function createOfferRows(db, queueRow) {
  const discoveredOffers = db.discovered_offers.filter(row => row.candidate_product_id === queueRow.product_id);
  const rows = [];

  for (const discovered of discoveredOffers) {
    if (!discovered.retailer_id) continue;

    rows.push({
      retailer_offer_id: nextSequentialId([...db.retailer_offers, ...rows], "retailer_offer_id", "offer", 6),
      product_id: queueRow.product_id,
      retailer_id: discovered.retailer_id,
      retailer_sku: null,
      retailer_product_url: discovered.discovered_url || null,
      affiliate_url: null,
      current_price: discovered.price || null,
      availability: discovered.availability || "Unknown",
      condition: "New",
      seller_name: "Discovery",
      last_scraped_at: core.nowBase44DateTime(),
      source_url: discovered.discovered_url || null
    });
  }

  return rows;
}

function logPromotion(db, payload) {
  const entry = {
    promotion_id: nextSequentialId(db.promotion_log, "promotion_id", "promo", 6),
    product_id: payload.product_id,
    source_queue_id: payload.source_queue_id || null,
    action: payload.action,
    message: payload.message || null,
    created_at: core.nowBase44DateTime()
  };

  db.promotion_log.push(entry);
  return entry;
}

function promoteOne(db, queueRow) {
  const result = {
    product_id: queueRow.product_id,
    queue_id: queueRow.queue_id,
    product_created: false,
    spec_created: false,
    offers_created: 0,
    status: "skipped",
    message: null
  };

  if (!queueRow.product_id || !queueRow.category_id || !queueRow.brand || !queueRow.model) {
    result.status = "error";
    result.message = "Queue row is missing required product fields.";
    logPromotion(db, { product_id: queueRow.product_id, source_queue_id: queueRow.queue_id, action: "error", message: result.message });
    return result;
  }

  if (!productExists(db, queueRow.product_id)) {
    db.products.push(createProductRow(queueRow));
    result.product_created = true;
  }

  const specQueue = db.component_spec_insert_queue.find(row => row.product_id === queueRow.product_id || row.source_discovery_id === queueRow.source_discovery_id);
  if (specQueue && specQueue.target_spec_table) {
    const tableName = specQueue.target_spec_table;
    db[tableName] = Array.isArray(db[tableName]) ? db[tableName] : [];

    if (!specExists(db, tableName, queueRow.product_id)) {
      db[tableName].push(createSpecRow(specQueue));
      specQueue.review_status = "promoted";
      specQueue.promoted_at = core.nowBase44DateTime();
      result.spec_created = true;
    }
  }

  const offerRows = createOfferRows(db, queueRow);
  for (const offer of offerRows) db.retailer_offers.push(offer);
  result.offers_created = offerRows.length;

  queueRow.review_status = "promoted";
  queueRow.status = "promoted";
  queueRow.promoted_at = core.nowBase44DateTime();

  result.status = "promoted";
  result.message = `Promoted ${queueRow.product_id}.`;
  logPromotion(db, { product_id: queueRow.product_id, source_queue_id: queueRow.queue_id, action: "promoted", message: result.message });

  return result;
}

function main() {
  const db = core.readDb(DB_FILE);
  ensureTables(db);

  const candidates = db.product_insert_queue.filter(shouldPromote).slice(0, PROMOTE_LIMIT);
  const results = candidates.map(row => promoteOne(db, row));

  if (!DRY_RUN) core.writeDb(db, DB_FILE);

  console.log("Candidate promotion complete.");
  console.log({
    dry_run: DRY_RUN,
    auto_promote: AUTO_PROMOTE,
    candidates_considered: candidates.length,
    promoted: results.filter(r => r.status === "promoted").length,
    errors: results.filter(r => r.status === "error").length,
    products_created: results.filter(r => r.product_created).length,
    specs_created: results.filter(r => r.spec_created).length,
    offers_created: results.reduce((sum, r) => sum + r.offers_created, 0)
  });

  if (DRY_RUN) console.log("Dry run only. Set $env:DRY_RUN=\"false\" to save promotions.");
}

main();
