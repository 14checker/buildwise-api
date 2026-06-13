const core = require("./buildwise_backend_core");
const governance = require("./source_governance");

const DB_FILE = process.env.DB_FILE || "db.json";

const SOURCES = [
  {
    source_id: "source-manual-import",
    source_name: "Manual/Admin Import",
    retailer_id: null,
    source_type: "manual",
    base_domain: "",
    allowed_use: "all",
    terms_status: "approved",
    active: true,
    rate_limit_per_hour: 0,
    requires_attribution: false,
    requires_affiliate_disclosure: false,
    notes: "Internal/manual data entry and approved file imports."
  },
  {
    source_id: "source-bestbuy-api",
    source_name: "Best Buy Products API",
    retailer_id: "ret-bestbuy",
    source_type: "api",
    base_domain: "developer.bestbuy.com",
    allowed_use: "pricing catalog availability specs discovery",
    terms_status: "needs_review",
    active: false,
    rate_limit_per_hour: 100,
    requires_attribution: false,
    requires_affiliate_disclosure: true,
    notes: "Enable only after API credentials/terms are reviewed."
  },
  {
    source_id: "source-amazon-paapi",
    source_name: "Amazon Product Advertising API",
    retailer_id: "ret-amazon",
    source_type: "api",
    base_domain: "webservices.amazon.com",
    allowed_use: "pricing catalog availability affiliate",
    terms_status: "needs_review",
    active: false,
    rate_limit_per_hour: 50,
    requires_attribution: true,
    requires_affiliate_disclosure: true,
    notes: "Enable only after Associates/PA API approval and policy review."
  },
  {
    source_id: "source-newegg-affiliate",
    source_name: "Newegg Affiliate/Approved Feed",
    retailer_id: "ret-newegg",
    source_type: "affiliate_feed",
    base_domain: "newegg.com",
    allowed_use: "affiliate pricing catalog",
    terms_status: "needs_review",
    active: false,
    rate_limit_per_hour: 50,
    requires_attribution: false,
    requires_affiliate_disclosure: true,
    notes: "Enable only after affiliate/data-feed terms are reviewed."
  },
  {
    source_id: "source-pcpartpicker-discovery",
    source_name: "PCPartPicker Discovery Pages",
    retailer_id: null,
    source_type: "public_page",
    base_domain: "pcpartpicker.com",
    allowed_use: "discovery",
    terms_status: "needs_review",
    active: false,
    rate_limit_per_hour: 10,
    requires_attribution: true,
    requires_affiliate_disclosure: false,
    notes: "Keep disabled until terms/robots/source policy are reviewed."
  }
];

function main() {
  const db = core.readDb(DB_FILE);
  governance.ensureGovernanceTables(db);

  let inserted = 0;
  let updated = 0;

  for (const source of SOURCES) {
    const existing = db.data_sources.find(row => row.source_id === source.source_id);
    if (existing) {
      Object.assign(existing, { ...source, last_reviewed_at: existing.last_reviewed_at || null });
      updated++;
    } else {
      db.data_sources.push({ ...source, last_reviewed_at: null });
      inserted++;
    }
  }

  core.writeDb(db, DB_FILE);
  console.log("Seeded data_sources.");
  console.log({ inserted, updated, total: db.data_sources.length });
}

main();
