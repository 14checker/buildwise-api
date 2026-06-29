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

function pick(row, fields) {
  return Object.fromEntries(fields.map(field => [field, row?.[field] ?? null]));
}

function affiliateUrlsEnabled(options = {}) {
  if (typeof options.exportAffiliateUrls === "boolean") return options.exportAffiliateUrls;
  return String(process.env.EXPORT_AFFILIATE_URLS || "false").toLowerCase() === "true";
}

function publicProducts(db) {
  return (db.products || []).map(product => pick(product, PRODUCT_FIELDS));
}

function publicRetailers(db) {
  return (db.retailers || []).map(retailer => pick(retailer, RETAILER_FIELDS));
}

function publicRetailerOffers(db, options = {}) {
  const retailersById = new Map((db.retailers || []).map(retailer => [retailer.retailer_id, retailer]));

  return (db.retailer_offers || []).map(offer => {
    const retailer = retailersById.get(offer.retailer_id) || {};
    const row = pick(
      {
        ...offer,
        retailer_name: retailer.name || null,
        retailer_domain: retailer.domain || null
      },
      RETAILER_OFFER_FIELDS
    );

    if (affiliateUrlsEnabled(options)) row.affiliate_url = offer.affiliate_url ?? null;
    return row;
  });
}

function publicPriceSnapshots(db) {
  const offersById = new Map((db.retailer_offers || []).map(offer => [offer.retailer_offer_id, offer]));
  const retailersById = new Map((db.retailers || []).map(retailer => [retailer.retailer_id, retailer]));

  return (db.price_snapshots || []).map(snapshot => {
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
  if (table === "products") return publicProducts(db);
  if (table === "retailers") return publicRetailers(db);
  if (table === "retailer_offers") return publicRetailerOffers(db, options);
  if (table === "price_snapshots") return publicPriceSnapshots(db);
  return undefined;
}

module.exports = {
  publicProducts,
  publicRetailers,
  publicRetailerOffers,
  publicPriceSnapshots,
  rowsForPublicTable
};
