const candidateFile = require("./candidate_file");
const retailerSearch = require("./retailer_search");
const searchProvider = require("./search_provider");

async function discoverAutoCandidates(product, retailer, config = {}) {
  const sources = [searchProvider, retailerSearch];
  const candidates = [];
  const stats = {
    queries_generated: 0,
    search_sources_called: 0,
    errors: []
  };

  for (const source of sources) {
    const result = await source.discoverCandidates(product, retailer, config);
    candidates.push(...(result.candidates || []));
    stats.queries_generated += Number(result.stats?.queries_generated || 0);
    stats.search_sources_called += Number(result.stats?.search_sources_called || 0);
    stats.errors.push(...(result.stats?.errors || []));
  }

  return { candidates, stats };
}

function discoverFileCandidates(config = {}) {
  return candidateFile.discoverCandidates(config);
}

module.exports = {
  discoverAutoCandidates,
  discoverFileCandidates
};
