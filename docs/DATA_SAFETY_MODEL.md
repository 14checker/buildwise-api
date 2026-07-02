# BuildWise Data Safety Model

## Verified URL Gate

Retailer offers are public only when their URL status is `verified_api` or `verified_manual` and the URL passes public safety checks.

Hidden URL cases include:

- missing URL
- placeholder URL
- wrong retailer domain
- search page
- category page
- tracking-heavy URL
- low-confidence URL without manual review
- unverified or rejected URL status

## Production Price Gate

BuildWise can publish verified retailer links before it publishes prices. Price fields stay blank unless price data has verified source/status metadata.

Public offer price fields hidden by default:

- `current_price`
- `availability`
- `condition` when seed-derived
- `seller_name`
- `last_scraped_at`

## Seed/Demo Data Handling

Seed/demo data is useful for development, but it must not look like production truth. Public exports hide seed/demo pricing and price history by default.

This keeps Base44 from showing synthetic prices as real market prices.

## Public-Safe Fields

Public exports may include safe display fields such as:

- product ID, category, brand, model, slug, MPN, MSRP, status
- retailer ID, name, domain, active status
- retailer offer ID, product ID, retailer ID, retailer display fields, SKU, verified product URL
- verified price history fields after price data is trusted

## Internal-Only Fields

Do not expose:

- raw `db.json`
- `affiliate_url`
- `source_url`, `scrape_url`, `price_source_url`
- URL review notes or reviewer metadata
- users, watchlists, alerts, affiliate clicks
- admin queues, scrape errors, source governance logs, compliance logs
- generated reports, temp URL files, local backups, credentials

## Unsafe Review Flags

These flags are for internal review only and should remain off for production:

- `EXPORT_UNVERIFIED_OFFERS=true`
- `EXPORT_PRODUCTS_WITHOUT_VERIFIED_OFFERS=true`
- `EXPORT_UNVERIFIED_PRICES=true`
- `EXPORT_SEED_PRICE_DATA=true`

They can help diagnose data coverage, but they weaken production safety. Never enable them for a public Base44 import or public API deployment.

## Public Output Rule

If a field is not clearly safe and useful for a shopper-facing app, leave it out or blank it until it is verified.
