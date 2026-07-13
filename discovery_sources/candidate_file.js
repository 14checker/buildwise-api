const fs = require("fs");
const path = require("path");

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(header => header.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function readJsonOrCsv(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return readCsv(filePath);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.candidates)) return parsed.candidates;
  throw new Error(`Candidate file must be an array or contain a candidates array: ${filePath}`);
}

function normalizeCandidate(row = {}) {
  return {
    product_id: row.product_id || row.productId || row.product,
    retailer_id: row.retailer_id || row.retailerId || row.retailer,
    candidate_url: row.candidate_url || row.url || row.retailer_product_url,
    expected_retailer_sku: row.expected_retailer_sku || row.retailer_sku || row.sku,
    html_path: row.html_path || row.fixture_path || row.local_html_path,
    page_html: row.page_html,
    discovery_source: row.discovery_source || row.source || "candidate_file",
    discovery_query: row.discovery_query || "",
    source_rank: Number(row.source_rank || 0) || null,
    source: row.source || "candidate_file",
    reviewer_notes: row.reviewer_notes || row.notes || ""
  };
}

function discoverCandidates(config = {}) {
  if (!config.discoveryCandidateFile) return [];
  if (!fs.existsSync(config.discoveryCandidateFile)) {
    throw new Error(`DISCOVERY_CANDIDATE_FILE not found: ${config.discoveryCandidateFile}`);
  }
  return readJsonOrCsv(config.discoveryCandidateFile)
    .map(normalizeCandidate)
    .filter(row => row.product_id && row.retailer_id && row.candidate_url);
}

module.exports = {
  discoverCandidates,
  readJsonOrCsv
};
