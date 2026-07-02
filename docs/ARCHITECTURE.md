# BuildWise Architecture

## Private Repo and Data Layer

BuildWise backend data is managed privately. The local `db.json` file acts as the current source of truth for products, retailers, offers, price snapshots, URL status, and operational tables.

Raw backend data includes internal fields and tables that are not safe for Base44 or public clients.

## Public Serializer Boundary

`public_serializers.js` is the public data boundary. Any data sent to Base44, static JSON, or the public API must pass through this file.

The serializer layer:

- includes only verified public-safe offers by default
- includes only products with verified public-safe offers by default
- blanks seed/demo price fields by default
- hides price snapshots until pricing is verified
- excludes affiliate URLs, source URLs, review metadata, user data, admin data, scrape logs, and compliance logs

## CSV Exports

`export_base44_tables.js` creates Base44-ready CSV files:

- `products.csv`
- `retailer_offers.csv`
- `retailers.csv`
- `price_snapshots.csv`

The CSV export is useful for immediate Base44 bulk import. It is safe by default and does not mutate `db.json` unless `WRITE=true` is explicitly set for export logging.

## Public JSON

`export_public_json.js` creates public-safe JSON files under `public_data/`. These files mirror the public serializer output and include `status.json` for counts, warnings, data mode, and database hash.

## Public API

`public_api_server.js` serves the same public-safe views through Express routes under `/public/`. It uses a CORS allowlist, rate limiting, and public serializer output only.

Base44 should call this API only for public-safe data. It should not call raw GitHub URLs or require GitHub tokens.

## Base44 Integration

Base44 can consume BuildWise data in two ways:

- CSV import for immediate bulk loading.
- Public API or static JSON for longer-term app integration.

Both paths use the same public data boundary.

## Email Reporting

`buildwise_data_run.js` generates CSV exports, JSON exports, local reports, and an optional email summary. SMTP settings are optional. If missing, the run still succeeds locally and prints that email was skipped.

## Claude Co-Agent Review Loop

The support inbox `support@buildwise-pc.com` can receive data-run summaries. Claude can review warnings, watch verified counts, and flag the next safest action for the BuildWise operator.

Recommended review pattern:

1. Check verified product and offer counts.
2. Review hidden placeholder and seed price warnings.
3. Confirm `db_hash` matches the expected baseline.
4. Decide the next small URL or price verification batch.
5. Avoid bulk writes until the reviewed batch passes dry-run checks.
