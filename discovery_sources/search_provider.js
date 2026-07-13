const fs = require("fs");
const { normalizeUrl } = require("../retailer_adapters/generic");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function readProviderRows(config = {}) {
  if (!config.discoverySearchProviderFile) return [];
  if (!fs.existsSync(config.discoverySearchProviderFile)) {
    throw new Error(`DISCOVERY_SEARCH_PROVIDER_FILE not found: ${config.discoverySearchProviderFile}`);
  }
  const parsed = JSON.parse(fs.readFileSync(config.discoverySearchProviderFile, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.results)) return parsed.results;
  return [];
}

async function discoverCandidates(product, retailer, config = {}) {
  const rows = readProviderRows(config).filter(row => {
    return (!row.product_id || row.product_id === product.product_id) &&
      (!row.retailer_id || row.retailer_id === retailer.retailer_id || normalizeKey(row.retailer) === normalizeKey(retailer.name));
  });

  return {
    candidates: rows.map((row, index) => ({
      product_id: product.product_id,
      retailer_id: retailer.retailer_id,
      candidate_url: normalizeUrl(row.candidate_url || row.url),
      discovery_source: row.discovery_source || "search_provider",
      discovery_query: row.discovery_query || row.query || "",
      discovered_at: new Date().toISOString(),
      source_rank: Number(row.source_rank || index + 1),
      html_path: row.html_path || row.fixture_path || "",
      source: "search_provider"
    })).filter(row => row.candidate_url),
    stats: {
      queries_generated: 0,
      search_sources_called: rows.length ? 1 : 0,
      errors: []
    }
  };
}

module.exports = {
  discoverCandidates
};
