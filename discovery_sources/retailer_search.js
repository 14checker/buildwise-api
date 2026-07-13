const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { URL } = require("url");
const { adapterForRetailer } = require("../retailer_adapters");
const { normalizeUrl } = require("../retailer_adapters/generic");

function normalizeFilePart(value) {
  return String(value || "").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "");
}

function fixtureSearchPath(product, retailer, config = {}) {
  if (!config.discoverySearchFixtureDir) return "";
  return path.join(
    config.discoverySearchFixtureDir,
    `${normalizeFilePart(retailer.retailer_id)}_${normalizeFilePart(product.product_id)}_search.html`
  );
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl || "https://example.com").toString();
  } catch {
    return href || "";
  }
}

function extractCandidatesFromSearchHtml(html, product, retailer, adapter, query, sourceUrl, config = {}) {
  const $ = cheerio.load(html || "");
  const rows = [];
  const seen = new Set();
  const max = Math.max(1, Number(config.discoveryMaxCandidatesPerQuery || 5));

  $("a[href]").each((index, element) => {
    if (rows.length >= max) return;
    const href = $(element).attr("href");
    const candidateUrl = normalizeUrl(absoluteUrl(sourceUrl, href));
    if (!candidateUrl || seen.has(candidateUrl)) return;
    if (adapter.validateCandidateUrl(candidateUrl)) return;
    seen.add(candidateUrl);

    const fixtureName = $(element).attr("data-fixture") || $(element).attr("data-html-path") || "";
    const htmlPath = fixtureName && config.discoverySearchFixtureDir
      ? path.resolve(config.discoverySearchFixtureDir, fixtureName)
      : "";

    rows.push({
      product_id: product.product_id,
      retailer_id: retailer.retailer_id,
      candidate_url: candidateUrl,
      discovery_source: "retailer_search",
      discovery_query: query,
      discovery_source_url: sourceUrl || "",
      discovered_at: new Date().toISOString(),
      source_rank: rows.length + 1,
      html_path: htmlPath,
      source: "retailer_search"
    });
  });

  return rows;
}

async function discoverCandidates(product, retailer, config = {}) {
  const adapter = adapterForRetailer(retailer);
  if (!adapter) return { candidates: [], stats: { search_sources_called: 0, queries_generated: 0, errors: ["unsupported_retailer"] } };

  const queries = adapter
    .buildSearchQueries(product)
    .slice(0, Math.max(1, Number(config.discoveryMaxQueriesPerProduct || 4)));
  const fixturePath = fixtureSearchPath(product, retailer, config);
  const candidates = [];
  const stats = {
    queries_generated: queries.length,
    search_sources_called: 0,
    errors: []
  };

  for (const query of queries) {
    if (fixturePath && fs.existsSync(fixturePath)) {
      stats.search_sources_called += 1;
      candidates.push(...extractCandidatesFromSearchHtml(
        fs.readFileSync(fixturePath, "utf8"),
        product,
        retailer,
        adapter,
        query,
        adapter.buildSearchUrl ? adapter.buildSearchUrl(query) : "",
        config
      ));
      continue;
    }

    if (!config.allowLiveFetch || !adapter.buildSearchUrl) continue;
    const searchUrl = adapter.buildSearchUrl(query);
    if (!searchUrl) continue;

    try {
      stats.search_sources_called += 1;
      const page = await adapter.fetchCandidatePage(searchUrl, config);
      if (!page.ok) {
        stats.errors.push(`search_failed:${retailer.retailer_id}:${page.http_status || page.error_code || "unknown"}`);
        continue;
      }
      candidates.push(...extractCandidatesFromSearchHtml(page.html, product, retailer, adapter, query, page.final_url || searchUrl, config));
    } catch (error) {
      stats.errors.push(`search_error:${retailer.retailer_id}:${error.message}`);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const row of candidates) {
    const key = `${row.product_id}|${row.retailer_id}|${normalizeUrl(row.candidate_url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return { candidates: deduped, stats };
}

module.exports = {
  discoverCandidates,
  extractCandidatesFromSearchHtml,
  fixtureSearchPath
};
