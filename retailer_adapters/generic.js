const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^www\./, "");
}

function normalizeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    [...parsed.searchParams.keys()].forEach(key => {
      if (/^utm_/i.test(key) || ["tag", "ref", "ref_", "affid", "affiliate", "ascsubtag"].includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    });
    parsed.hash = "";
    parsed.hostname = normalizeHost(parsed.hostname);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return String(value || "").trim();
  }
}

function hostMatches(url, domains = []) {
  try {
    const host = normalizeHost(new URL(url).hostname);
    return domains.some(domain => {
      const normalized = normalizeHost(domain);
      return host === normalized || host.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function isSearchOrCategoryUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.includes("/search") ||
      pathname.includes("/category") ||
      pathname === "/s" ||
      pathname === "/site/searchpage.jsp" ||
      pathname === "/p/pl" ||
      pathname === "/c/search";
  } catch {
    return true;
  }
}

function buildSearchQueries(product, retailerName) {
  const base = [product.brand, product.model].filter(Boolean).join(" ").trim();
  const category = String(product.category_id || product.category || "").toLowerCase();
  const descriptors = category === "cpu"
    ? ["CPU", "processor", "desktop processor"]
    : category === "gpu"
      ? ["graphics card", "GPU"]
      : ["pc component"];
  return descriptors.map(descriptor => `${base} ${descriptor} ${retailerName}`.replace(/\s+/g, " ").trim());
}

async function fetchCandidatePage(url, config = {}) {
  const attempts = Math.max(1, Number(config.httpMaxRetries || 0) + 1);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: config.httpTimeoutMs || 15000,
        maxRedirects: 3,
        responseType: "text",
        headers: {
          "User-Agent": config.httpUserAgent || "BuildWiseIngestion/0.1 contact: support@buildwise-pc.com",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9"
        },
        validateStatus: status => status >= 200 && status < 500
      });
      return {
        ok: response.status >= 200 && response.status < 300,
        http_status: response.status,
        final_url: response.request?.res?.responseUrl || url,
        html: response.data || ""
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    http_status: null,
    final_url: url,
    html: "",
    error_code: "request_error",
    error_message: lastError ? lastError.message : "request_failed"
  };
}

function flattenJsonLd(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach(item => flattenJsonLd(item, output));
    return output;
  }
  if (typeof value === "object") {
    output.push(value);
    if (value["@graph"]) flattenJsonLd(value["@graph"], output);
    if (value.itemListElement) flattenJsonLd(value.itemListElement, output);
    if (value.item) flattenJsonLd(value.item, output);
  }
  return output;
}

function parseJsonLd($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((i, element) => {
    const raw = $(element).contents().text();
    if (!raw) return;
    try {
      flattenJsonLd(JSON.parse(raw), nodes);
    } catch {
      // Retailer pages often include malformed or multiple JSON-LD blocks. Ignore broken blocks.
    }
  });
  return nodes;
}

function firstText($, selectors) {
  for (const selector of selectors) {
    const element = $(selector).first();
    if (!element.length) continue;
    const content = normalizeText(element.attr("content"));
    if (content) return content;
    const value = normalizeText(element.attr("value"));
    if (value) return value;
    const text = normalizeText(element.text());
    if (text) return text;
  }
  return "";
}

function parsePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).replace(/,/g, "").match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function normalizeAvailability(value) {
  const text = String(value || "").toLowerCase();
  if (/out of stock|out_of_stock|outofstock|sold out|currently unavailable/.test(text)) return "out_of_stock";
  if (/backorder|backordered/.test(text)) return "backorder";
  if (/preorder|pre-order/.test(text)) return "preorder";
  if (/limited|only a few/.test(text)) return "limited";
  if (/in stock|in_stock|instock|add to cart|available/.test(text)) return "in_stock";
  return "unknown";
}

function extractIdentity(html, url = "") {
  const $ = cheerio.load(html || "");
  const jsonLdProduct = parseJsonLd($).find(node => {
    const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
    return /product/i.test(type) || node.name || node.sku || node.mpn;
  }) || {};
  const brandValue = typeof jsonLdProduct.brand === "object" ? jsonLdProduct.brand.name : jsonLdProduct.brand;
  const offers = Array.isArray(jsonLdProduct.offers) ? jsonLdProduct.offers[0] : jsonLdProduct.offers || {};
  const canonical = $("link[rel='canonical']").attr("href") || jsonLdProduct.url || offers.url || url;
  const pageTitle = firstText($, ["meta[property='og:title']", "meta[name='twitter:title']", "title"]);
  const productName = normalizeText(jsonLdProduct.name || pageTitle);
  const imageValue = Array.isArray(jsonLdProduct.image) ? jsonLdProduct.image[0] : jsonLdProduct.image;

  return {
    page_title: pageTitle || null,
    product_name: productName || null,
    brand: normalizeText(brandValue) || null,
    model: normalizeText(jsonLdProduct.model) || null,
    manufacturer_part_number: normalizeText(jsonLdProduct.mpn) || null,
    retailer_sku: normalizeText(jsonLdProduct.sku) || firstText($, ["[itemprop='sku']", "meta[itemprop='sku']"]) || null,
    upc: normalizeText(jsonLdProduct.gtin12 || jsonLdProduct.gtin13 || jsonLdProduct.gtin14) || null,
    category: normalizeText(jsonLdProduct.category) || null,
    capacity: null,
    generation: null,
    chipset: null,
    socket: null,
    form_factor: null,
    color: normalizeText(jsonLdProduct.color) || null,
    condition: normalizeText(offers.itemCondition).split("/").pop() || null,
    seller_name: normalizeText(offers.seller?.name || offers.seller) || null,
    price: parsePrice(offers.price || firstText($, ["meta[itemprop='price']", "[itemprop='price']", ".price"])),
    currency: normalizeText(offers.priceCurrency) || "USD",
    availability: normalizeAvailability(offers.availability || firstText($, ["[itemprop='availability']", ".availability", ".stock", "body"])),
    image_url: imageValue || $("meta[property='og:image']").attr("content") || null,
    canonical_url: normalizeUrl(canonical)
  };
}

function extractOffer(html, url = "") {
  const identity = extractIdentity(html, url);
  return {
    current_price: identity.price,
    currency: identity.currency || "USD",
    availability: identity.availability || "unknown",
    seller_name: identity.seller_name || null,
    condition: identity.condition || null,
    image_url: identity.image_url || null,
    product_page_title: identity.product_name || identity.page_title || null,
    retailer_sku: identity.retailer_sku || null,
    canonical_url: identity.canonical_url || normalizeUrl(url)
  };
}

function createAdapter({ retailerId, name, domains, queryName = name }) {
  return {
    retailerId,
    name,
    domains,
    buildSearchQueries: product => buildSearchQueries(product, queryName),
    normalizeUrl,
    validateCandidateUrl(url) {
      if (!url) return "missing_url";
      if (!hostMatches(url, domains)) return "retailer_domain_mismatch";
      if (isSearchOrCategoryUrl(url)) return "search_or_category_url";
      return null;
    },
    fetchCandidatePage,
    extractIdentity,
    extractOffer
  };
}

module.exports = {
  buildSearchQueries,
  createAdapter,
  extractIdentity,
  extractOffer,
  fetchCandidatePage,
  hostMatches,
  isSearchOrCategoryUrl,
  normalizeAvailability,
  normalizeHost,
  normalizeText,
  normalizeUrl,
  parsePrice
};
