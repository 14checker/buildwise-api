const { URL } = require("url");

const RETAILER_DOMAINS = {
  "ret-amazon": "amazon.com",
  "ret-newegg": "newegg.com",
  "ret-bestbuy": "bestbuy.com",
  "ret-microcenter": "microcenter.com",
  "ret-bh": "bhphotovideo.com"
};

function normalizeHost(value) {
  return String(value || "").toLowerCase().replace(/^www\./, "");
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isValidUrl(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && ["http:", "https:"].includes(parsed.protocol));
}

function getHostname(value) {
  const parsed = parseUrl(value);
  return parsed ? parsed.hostname.toLowerCase() : "";
}

function getRetailerDomain(retailerId, retailer = null) {
  return normalizeHost(retailer?.domain || RETAILER_DOMAINS[retailerId] || "");
}

function hostMatchesDomain(host, expectedDomain) {
  const normalizedHost = normalizeHost(host);
  const normalizedDomain = normalizeHost(expectedDomain);
  if (!normalizedHost || !normalizedDomain) return true;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function getUrlQualityIssue(value, options = {}) {
  if (!value) return "missing_url";
  if (!isValidUrl(value)) return "invalid_url";

  const parsed = parseUrl(value);
  const host = normalizeHost(parsed.hostname);
  const pathname = parsed.pathname.toLowerCase();
  const full = String(value).toLowerCase();
  const expectedDomain = getRetailerDomain(options.retailerId, options.retailer);

  if (expectedDomain && !hostMatchesDomain(host, expectedDomain)) return "retailer_domain_mismatch";
  if (host.includes("example.com")) return "placeholder_url";
  if (full.includes("placeholder") || full.includes("sku=demo")) return "placeholder_url";

  const seedSku = /[?&]sku=(am|be|ne|mi|b%26|b&)\d{5,}/i.test(full);
  if (pathname.startsWith("/p/") && seedSku) return "likely_seed_placeholder_url";

  if (options.retailerId === "ret-amazon" && pathname.startsWith("/p/")) return "likely_placeholder_amazon_url";
  if (options.retailerId === "ret-bestbuy" && pathname.startsWith("/p/")) return "likely_placeholder_bestbuy_url";
  if (options.retailerId === "ret-microcenter" && pathname.startsWith("/p/")) return "likely_placeholder_microcenter_url";
  if (options.retailerId === "ret-bh" && pathname.startsWith("/p/")) return "likely_placeholder_bh_url";

  return null;
}

module.exports = {
  RETAILER_DOMAINS,
  getRetailerDomain,
  getHostname,
  getUrlQualityIssue,
  hostMatchesDomain,
  isValidUrl,
  normalizeHost,
  parseUrl
};
