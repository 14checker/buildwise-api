const urlQuality = require("./url_quality");

const PRODUCT_FIELDS = [
  "product_id",
  "category_id",
  "brand",
  "model",
  "slug",
  "mpn",
  "msrp",
  "status"
];

const RETAILER_FIELDS = [
  "retailer_id",
  "name",
  "domain",
  "active"
];

const RETAILER_OFFER_FIELDS = [
  "retailer_offer_id",
  "product_id",
  "retailer_id",
  "retailer_name",
  "retailer_domain",
  "retailer_sku",
  "retailer_product_url",
  "current_price",
  "availability",
  "condition",
  "seller_name",
  "last_scraped_at"
];

const PRICE_SNAPSHOT_FIELDS = [
  "snapshot_id",
  "retailer_offer_id",
  "product_id",
  "retailer_id",
  "retailer_name",
  "retailer_domain",
  "price",
  "shipping",
  "availability",
  "scraped_at"
];

const PUBLIC_TABLE_FIELDS = {
  products: PRODUCT_FIELDS,
  retailers: RETAILER_FIELDS,
  retailer_offers: RETAILER_OFFER_FIELDS,
  price_snapshots: PRICE_SNAPSHOT_FIELDS
};

const VERIFIED_URL_STATUSES = new Set(["verified_api", "verified_manual"]);
const VERIFIED_PRICE_STATUSES = new Set(["verified", "verified_api", "verified_manual"]);
const PRICE_FIELDS = ["current_price", "availability", "seller_name", "last_scraped_at"];
const TRACKING_PARAMS = new Set([
  "tag",
  "ascsubtag",
  "affid",
  "affiliate",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "ref_",
  "source",
  "campaign"
]);

function pick(row, fields) {
  return Object.fromEntries(fields.map(field => [field, row?.[field] ?? null]));
}

function affiliateUrlsEnabled(options = {}) {
  if (typeof options.exportAffiliateUrls === "boolean") return options.exportAffiliateUrls;
  return String(process.env.EXPORT_AFFILIATE_URLS || "false").toLowerCase() === "true";
}

function exportUnverifiedOffersEnabled(options = {}) {
  if (typeof options.exportUnverifiedOffers === "boolean") return options.exportUnverifiedOffers;
  return String(process.env.EXPORT_UNVERIFIED_OFFERS || "false").toLowerCase() === "true";
}

function exportProductsWithoutVerifiedOffersEnabled(options = {}) {
  if (typeof options.exportProductsWithoutVerifiedOffers === "boolean") return options.exportProductsWithoutVerifiedOffers;
  return String(process.env.EXPORT_PRODUCTS_WITHOUT_VERIFIED_OFFERS || "false").toLowerCase() === "true";
}

function exportUnverifiedPricesEnabled(options = {}) {
  if (typeof options.exportUnverifiedPrices === "boolean") return options.exportUnverifiedPrices;
  return String(process.env.EXPORT_UNVERIFIED_PRICES || "false").toLowerCase() === "true";
}

function exportSeedPriceDataEnabled(options = {}) {
  if (typeof options.exportSeedPriceData === "boolean") return options.exportSeedPriceData;
  return String(process.env.EXPORT_SEED_PRICE_DATA || "false").toLowerCase() === "true";
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function hasVerifiedPriceStatus(row = {}) {
  return [
    row.price_status,
    row.snapshot_status,
    row.data_quality_status
  ].some(status => VERIFIED_PRICE_STATUSES.has(normalizeKey(status)));
}

function hasSeedPriceData(row = {}) {
  return /buildwise seed|\bseed\b|\bdemo\b|\btest\b/i.test(String(row.seller_name || ""));
}

function priceDataAllowed(row = {}, options = {}) {
  if (exportSeedPriceDataEnabled(options) || exportUnverifiedPricesEnabled(options)) {
    // Unsafe for production: these flags are only for internal review exports.
    return true;
  }
  return hasVerifiedPriceStatus(row);
}

function snapshotPriceDataAllowed(snapshot = {}, offer = {}, options = {}) {
  if (exportSeedPriceDataEnabled(options) || exportUnverifiedPricesEnabled(options)) {
    // Unsafe for production: these flags are only for internal review exports.
    return true;
  }
  return hasVerifiedPriceStatus(snapshot) || hasVerifiedPriceStatus(offer);
}

function redactUnverifiedPriceFields(row, offer, options = {}) {
  if (priceDataAllowed(offer, options)) return row;

  for (const field of PRICE_FIELDS) row[field] = null;
  if (hasSeedPriceData(offer)) row.condition = null;
  return row;
}

function hasUnsafeSearchOrTrackingUrl(value) {
  const parsed = urlQuality.parseUrl(value);
  if (!parsed) return true;

  const host = urlQuality.normalizeHost(parsed.hostname);
  const pathname = parsed.pathname.toLowerCase();
  const searchKeys = [...parsed.searchParams.keys()].map(key => key.toLowerCase());

  if (searchKeys.some(key => key.startsWith("utm_") || TRACKING_PARAMS.has(key))) return true;
  if (pathname.includes("/search") || pathname.includes("/category")) return true;
  if (host === "amazon.com" && pathname === "/s") return true;
  if (host === "bestbuy.com" && pathname === "/site/searchpage.jsp") return true;
  if (host === "newegg.com" && pathname === "/p/pl") return true;
  if (host === "microcenter.com" && pathname === "/search/search_results.aspx") return true;
  if (host === "bhphotovideo.com" && pathname === "/c/search") return true;

  return false;
}

function isPublicSafeOffer(offer, retailer = null) {
  if (!VERIFIED_URL_STATUSES.has(normalizeKey(offer?.url_status))) return false;

  const issue = urlQuality.getUrlQualityIssue(offer?.retailer_product_url, {
    retailerId: offer?.retailer_id,
    retailer
  });
  if (issue) return false;

  return !hasUnsafeSearchOrTrackingUrl(offer?.retailer_product_url);
}

function publicSafeOffers(db, options = {}) {
  const retailersById = new Map((db.retailers || []).map(retailer => [retailer.retailer_id, retailer]));

  if (exportUnverifiedOffersEnabled(options)) {
    // Unsafe for production: this is only for internal review exports.
    return (db.retailer_offers || []).map(offer => ({
      offer,
      retailer: retailersById.get(offer.retailer_id) || {}
    }));
  }

  return (db.retailer_offers || [])
    .map(offer => ({
      offer,
      retailer: retailersById.get(offer.retailer_id) || {}
    }))
    .filter(({ offer, retailer }) => isPublicSafeOffer(offer, retailer));
}

function verifiedPublicSafeOffers(db) {
  const retailersById = new Map((db.retailers || []).map(retailer => [retailer.retailer_id, retailer]));
  return (db.retailer_offers || [])
    .map(offer => ({
      offer,
      retailer: retailersById.get(offer.retailer_id) || {}
    }))
    .filter(({ offer, retailer }) => isPublicSafeOffer(offer, retailer));
}

function publicProducts(db, options = {}) {
  const products = db.products || [];
  if (exportProductsWithoutVerifiedOffersEnabled(options)) {
    return products.map(product => pick(product, PRODUCT_FIELDS));
  }

  const productIdsWithSafeOffers = new Set(verifiedPublicSafeOffers(db).map(({ offer }) => offer.product_id));
  return products
    .filter(product => productIdsWithSafeOffers.has(product.product_id))
    .map(product => pick(product, PRODUCT_FIELDS));
}

function publicRetailers(db) {
  return (db.retailers || []).map(retailer => pick(retailer, RETAILER_FIELDS));
}

function publicRetailerOffers(db, options = {}) {
  return publicSafeOffers(db, options).map(({ offer, retailer }) => {
    const row = pick(
      {
        ...offer,
        retailer_name: retailer.name || null,
        retailer_domain: retailer.domain || null
      },
      RETAILER_OFFER_FIELDS
    );

    redactUnverifiedPriceFields(row, offer, options);
    if (affiliateUrlsEnabled(options)) row.affiliate_url = offer.affiliate_url ?? null;
    return row;
  });
}

function publicPriceSnapshots(db, options = {}) {
  const offersById = new Map((db.retailer_offers || []).map(offer => [offer.retailer_offer_id, offer]));
  const retailersById = new Map((db.retailers || []).map(retailer => [retailer.retailer_id, retailer]));
  const safeOfferIds = new Set(verifiedPublicSafeOffers(db).map(({ offer }) => offer.retailer_offer_id));

  return (db.price_snapshots || [])
    .filter(snapshot => safeOfferIds.has(snapshot.retailer_offer_id))
    .filter(snapshot => snapshotPriceDataAllowed(snapshot, offersById.get(snapshot.retailer_offer_id) || {}, options))
    .map(snapshot => {
    const offer = offersById.get(snapshot.retailer_offer_id) || {};
    const retailer = retailersById.get(offer.retailer_id) || {};
    return pick(
      {
        ...snapshot,
        product_id: offer.product_id || null,
        retailer_id: offer.retailer_id || null,
        retailer_name: retailer.name || null,
        retailer_domain: retailer.domain || null
      },
      PRICE_SNAPSHOT_FIELDS
    );
  });
}

function rowsForPublicTable(db, table, options = {}) {
  if (table === "products") return publicProducts(db, options);
  if (table === "retailers") return publicRetailers(db);
  if (table === "retailer_offers") return publicRetailerOffers(db, options);
  if (table === "price_snapshots") return publicPriceSnapshots(db, options);
  return undefined;
}

function fieldsForPublicTable(table, options = {}) {
  const fields = PUBLIC_TABLE_FIELDS[table];
  if (!fields) return undefined;
  if (table === "retailer_offers" && affiliateUrlsEnabled(options)) {
    return [...fields, "affiliate_url"];
  }
  return [...fields];
}

module.exports = {
  fieldsForPublicTable,
  isPublicSafeOffer,
  publicProducts,
  publicRetailers,
  publicRetailerOffers,
  publicPriceSnapshots,
  rowsForPublicTable
};
