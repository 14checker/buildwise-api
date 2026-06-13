const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const WRITE = String(process.env.WRITE || "true").toLowerCase() !== "false";
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY || 0.72);

const STOPWORDS = new Set([
  "the", "and", "with", "for", "new", "edition", "version", "black", "white", "silver",
  "rgb", "argb", "airflow", "tempered", "glass", "boxed", "tray", "bundle", "gaming",
  "creator", "pro", "plus", "max", "ultra", "oc", "evo", "wifi", "wi", "fi"
]);

function now() {
  return core.nowBase44DateTime();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  return normalizeModel(value)
    .split(" ")
    .map(t => t.trim())
    .filter(t => t && !STOPWORDS.has(t));
}

function jaccard(a, b) {
  const aa = new Set(a);
  const bb = new Set(b);
  const intersection = [...aa].filter(x => bb.has(x)).length;
  const union = new Set([...aa, ...bb]).size;
  return union === 0 ? 0 : intersection / union;
}

function extractCpuKey(product, model) {
  const ryzen = model.match(/ryzen\s+([3579])\s+(\d{4,5})(x3d|x|g|f|d)?/i);
  if (ryzen) return `cpu-${product.brand}-${ryzen[1]}-${ryzen[2]}-${ryzen[3] || ""}`;

  const coreUltra = model.match(/core\s+ultra\s+([3579])\s+(\d{3,5})([a-z]*)/i);
  if (coreUltra) return `cpu-${product.brand}-ultra-${coreUltra[1]}-${coreUltra[2]}-${coreUltra[3] || ""}`;

  const intelCore = model.match(/core\s+i([3579])\s*(\d{4,5})([a-z]*)/i);
  if (intelCore) return `cpu-${product.brand}-i${intelCore[1]}-${intelCore[2]}-${intelCore[3] || ""}`;

  return null;
}

function extractGpuKey(product, model) {
  const rtx = model.match(/(?:geforce\s+)?rtx\s+(\d{4})(\s*ti)?(\s*super)?/i);
  if (rtx) return `gpu-${product.brand}-rtx-${rtx[1]}-${rtx[2] ? "ti" : ""}-${rtx[3] ? "super" : ""}`;

  const rx = model.match(/(?:radeon\s+)?rx\s+(\d{4})(\s*xtx|\s*xt)?/i);
  if (rx) return `gpu-${product.brand}-rx-${rx[1]}-${(rx[2] || "").trim()}`;

  const arc = model.match(/arc\s+([a-z])\s*(\d{3,4})/i);
  if (arc) return `gpu-${product.brand}-arc-${arc[1]}-${arc[2]}`;

  return null;
}

function extractMotherboardKey(product, model) {
  const chipset = model.match(/\b(x870e|x870|x670e|x670|b650e|b650|a620|z890|z790|z690|b860|b760|b660|h610)\b/i);
  const form = model.match(/\b(e-atx|eatx|atx|micro-atx|matx|mini-itx|itx)\b/i);
  if (chipset) return `motherboard-${product.brand}-${chipset[1]}-${form ? form[1] : ""}`;
  return null;
}

function extractRamKey(product, model) {
  const ddr = model.match(/\bddr\s*([45])\b/i) || model.match(/\bddr([45])\b/i);
  const speed = model.match(/\b(4\d{3}|5\d{3}|6\d{3}|7\d{3}|8\d{3})\b/);
  const capacity = model.match(/\b(16|24|32|48|64|96|128)\s*gb\b/i);
  if (ddr || speed || capacity) return `ram-${product.brand}-ddr${ddr ? ddr[1] : ""}-${speed ? speed[1] : ""}-${capacity ? capacity[1] + "gb" : ""}`;
  return null;
}

function extractStorageKey(product, model) {
  const capacity = model.match(/\b(250|256|500|512)\s*gb\b/i) || model.match(/\b(1|2|4|8)\s*tb\b/i);
  const type = model.match(/\b(nvme|sata|pcie\s*5|pcie\s*4|m\.2)\b/i);
  const seriesTokens = tokenize(model).slice(0, 3).join("-");
  if (capacity || type) return `storage-${product.brand}-${seriesTokens}-${capacity ? capacity[0].replace(/\s+/g, "") : ""}-${type ? type[0].replace(/\s+/g, "") : ""}`;
  return null;
}

function extractPsuKey(product, model) {
  const watts = model.match(/\b(450|500|550|600|650|700|750|800|850|900|1000|1200|1300|1500|1600)\s*w\b/i);
  const rating = model.match(/\b(bronze|silver|gold|platinum|titanium)\b/i);
  if (watts || rating) return `psu-${product.brand}-${watts ? watts[1] + "w" : ""}-${rating ? rating[1] : ""}`;
  return null;
}

function extractCaseKey(product, model) {
  const tokens = tokenize(model).filter(t => !["case", "mid", "tower", "full", "mini", "micro"].includes(t)).slice(0, 4);
  return `case-${product.brand}-${tokens.join("-")}`;
}

function getComparableKey(product) {
  const category = core.normalizeKey(product.category_id);
  const brand = slugify(product.brand);
  const model = normalizeModel(product.model);

  let extracted = null;
  if (category === "cpu") extracted = extractCpuKey({ ...product, brand }, model);
  if (category === "gpu") extracted = extractGpuKey({ ...product, brand }, model);
  if (category === "motherboard") extracted = extractMotherboardKey({ ...product, brand }, model);
  if (category === "ram") extracted = extractRamKey({ ...product, brand }, model);
  if (category === "storage") extracted = extractStorageKey({ ...product, brand }, model);
  if (category === "psu") extracted = extractPsuKey({ ...product, brand }, model);
  if (category === "case") extracted = extractCaseKey({ ...product, brand }, model);

  if (extracted) return slugify(extracted);
  return slugify(`${category}-${brand}-${tokenize(model).slice(0, 5).join("-")}`);
}

function getVariantLabel(product) {
  const model = normalizeModel(product.model);
  const labels = [];
  for (const word of ["boxed", "tray", "creator", "gaming", "bundle", "oc", "rgb", "black", "white", "airflow", "wifi"]) {
    if (model.includes(word)) labels.push(word);
  }
  return labels.length ? labels.join("+") : "base";
}

function confidenceForMember(product, group) {
  const productTokens = tokenize(`${product.brand} ${product.model}`);
  const groupTokens = tokenize(group.group_name);
  const score = jaccard(productTokens, groupTokens);
  return Math.round(Math.max(0.7, Math.min(0.99, score)) * 100);
}

function makeGroupId(category, index) {
  return `grp-${category}-${String(index).padStart(4, "0")}`;
}

function getOfferSummary(db, members) {
  const groupByProduct = new Map(members.map(row => [row.product_id, row.group_id]));
  const offersByProduct = new Map();

  for (const offer of db.retailer_offers) {
    if (!offersByProduct.has(offer.product_id)) offersByProduct.set(offer.product_id, []);
    offersByProduct.get(offer.product_id).push(offer);
  }

  return db.products.map(product => {
    const offers = offersByProduct.get(product.product_id) || [];
    const priced = offers
      .map(offer => ({ ...offer, numeric_price: Number(offer.current_price) }))
      .filter(offer => Number.isFinite(offer.numeric_price));

    const best = priced.slice().sort((a, b) => a.numeric_price - b.numeric_price)[0] || null;

    return {
      product_id: product.product_id,
      group_id: groupByProduct.get(product.product_id) || null,
      offer_count: offers.length,
      priced_offer_count: priced.length,
      min_current_price: priced.length ? Math.min(...priced.map(o => o.numeric_price)) : null,
      max_current_price: priced.length ? Math.max(...priced.map(o => o.numeric_price)) : null,
      best_offer_id: best ? best.retailer_offer_id : null,
      best_retailer_id: best ? best.retailer_id : null,
      updated_at: now()
    };
  });
}

function buildSimilarityMap(products, members) {
  const groupMembers = new Map();
  for (const member of members) {
    if (!groupMembers.has(member.group_id)) groupMembers.set(member.group_id, []);
    groupMembers.get(member.group_id).push(member.product_id);
  }

  const productById = new Map(products.map(p => [p.product_id, p]));
  const rows = [];

  for (const [groupId, productIds] of groupMembers.entries()) {
    for (const productId of productIds) {
      const product = productById.get(productId);
      for (const similarProductId of productIds) {
        if (productId === similarProductId) continue;
        const similar = productById.get(similarProductId);
        const score = Math.round(jaccard(tokenize(product.model), tokenize(similar.model)) * 100);
        if (score >= Math.round(MIN_SIMILARITY * 100)) {
          rows.push({
            product_id: productId,
            similar_product_id: similarProductId,
            group_id: groupId,
            similarity_score: score,
            similarity_reason: "same_product_group",
            created_at: now()
          });
        }
      }
    }
  }

  return rows;
}

function groupProducts(db) {
  const activeProducts = db.products.filter(product => core.normalizeKey(product.status || "active") === "active");
  const buckets = new Map();

  for (const product of activeProducts) {
    const key = getComparableKey(product);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(product);
  }

  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const categoryCounters = new Map();

  const productGroups = [];
  const members = [];

  for (const [groupKey, products] of sortedBuckets) {
    const primary = products.slice().sort((a, b) => Number(b.msrp || 0) - Number(a.msrp || 0))[0];
    const category = core.normalizeKey(primary.category_id || "component");
    const nextIndex = (categoryCounters.get(category) || 0) + 1;
    categoryCounters.set(category, nextIndex);

    const groupId = makeGroupId(category, nextIndex);
    const groupName = `${primary.brand} ${primary.model}`.trim();

    const group = {
      group_id: groupId,
      category_id: primary.category_id,
      brand: primary.brand,
      group_key: groupKey,
      group_name: groupName,
      primary_product_id: primary.product_id,
      product_count: products.length,
      created_at: now(),
      updated_at: now()
    };

    productGroups.push(group);

    for (const product of products) {
      members.push({
        group_id: groupId,
        product_id: product.product_id,
        match_confidence: confidenceForMember(product, group),
        match_reason: "category_brand_model_key",
        variant_label: getVariantLabel(product)
      });
    }
  }

  db.product_groups = productGroups;
  db.product_group_members = members;
  db.product_similarity_map = buildSimilarityMap(activeProducts, members);
  db.product_offer_summary = getOfferSummary(db, members);

  return {
    product_groups: db.product_groups.length,
    product_group_members: db.product_group_members.length,
    product_similarity_map: db.product_similarity_map.length,
    product_offer_summary: db.product_offer_summary.length
  };
}

function main() {
  const db = core.readDb(DB_FILE);
  const before = core.getSummary(db);
  const result = groupProducts(db);

  if (WRITE) core.writeDb(db, DB_FILE);

  console.log("Product grouping complete.");
  console.log("Before:", before);
  console.log("Generated:", result);
  console.log(`Write mode: ${WRITE}`);
}

main();
