# BuildWise Backend

BuildWise is a PC parts data backend for powering a Base44 app with clean product, retailer, offer, and price-history data. The backend remains the source of truth, while Base44 receives only public-safe views.

## Product Vision

BuildWise should help shoppers compare PC hardware using verified retailer links, trustworthy prices, and clear product data. The short-term launch path is conservative: publish verified product and retailer links first, keep seed/demo prices blank, and add price history only after pricing is verified.

## Backend Architecture

The private backend stores the full working dataset in `db.json` and supports URL review, data quality checks, exports, reporting, and future retailer connectors. Public app data must pass through `public_serializers.js` before it reaches Base44, static JSON, or the public API.

Core layers:

- `db.json`: private local source of truth.
- `public_serializers.js`: public data boundary.
- `export_base44_tables.js`: public-safe CSV export for Base44 bulk import.
- `export_public_json.js`: public-safe JSON export for hosting or fallback.
- `public_api_server.js`: public API for Base44 and future app clients.
- `buildwise_data_run.js`: safe reporting run for exports, metrics, and optional email.

## Private Backend vs Public Data

Private backend work stays private. Base44 must never receive raw `db.json`, GitHub tokens, secrets, internal review files, scrape logs, compliance logs, user data, watchlists, alerts, or admin queues.

Public exports include only public-safe products, retailers, verified retailer offers, and verified price history. Unverified URLs stay hidden. Seed/demo prices stay blank. Price history stays hidden until verified.

## Base44 CSV Workflow

Run:

```powershell
npm run export:base44
```

This creates public-safe CSV files under `base44_table_exports/`:

- `products.csv`
- `retailer_offers.csv`
- `retailers.csv`
- `price_snapshots.csv`

Generated exports are ignored by git and should not be committed unless explicitly approved.

## Public JSON Workflow

Run:

```powershell
npm run export:json
```

This writes public-safe JSON files under `public_data/`, including `status.json` with counts, warnings, data mode, and database hash. The JSON output is also ignored by git.

## Public API Workflow

Run:

```powershell
npm run api:public
```

The API serves only public serializer output. Base44 can call the public API without a GitHub token. Configure CORS with `BASE44_ALLOWED_ORIGINS` before production use.

Public routes:

- `GET /health`
- `GET /public/status`
- `GET /public/products`
- `GET /public/products/:product_id`
- `GET /public/retailers`
- `GET /public/offers`
- `GET /public/offers?product_id=<id>`
- `GET /public/price-history`
- `GET /public/price-history?product_id=<id>`
- `GET /public/search?q=<query>`

## Automated Data-Run Workflow

Run:

```powershell
npm run data:run
```

The data run performs safe audit/export/report work only. It does not scrape, import URLs, use `WRITE=true`, or mutate `db.json`.

Default daily run settings:

- `BUILDWISE_RUN_MODE=audit_only`
- `BUILDWISE_AUTONOMY_LEVEL=report_only`
- `BUILDWISE_REPORT_EMAIL=support@buildwise-pc.com`

If SMTP variables are configured, the summary is emailed to `support@buildwise-pc.com`, where Claude can monitor the report stream. If SMTP is missing, the run still writes local reports and records `email skipped: missing SMTP config`.

Daily reports explain:

- what happened
- what changed since the last run
- what was skipped and why
- whether `db.json` changed
- whether Base44 can safely pull public data
- what requires human review
- the next recommended action

Run modes:

- `audit_only`: default daily audit/export/report/email mode; no mutation.
- `review_prepare`: future review-file preparation mode; no mutation.
- `connector_check`: future read-only connector check mode; no mutation by default.
- `approved_import`: future supervised import mode; requires `WRITE=true`, an explicit import file, and a prior dry-run pass.
- `publish_ready_check`: safe readiness check for Base44 public data.

Autonomy levels:

- `report_only`: default; audit/export/report/email only.
- `prepare_reviews`: future review file and read-only connector preparation.
- `supervised_import`: future approved import mode only.
- `full_auto_safe`: future only; blocked unless explicitly enabled and all safety prerequisites exist.

Report statuses:

- `PASS`: clean safe run.
- `PASS_WITH_WARNINGS`: safe run with warnings such as hidden placeholder URLs or hidden seed prices.
- `NEEDS_REVIEW`: review files, uncertain candidates, or human decisions need attention.
- `BLOCKED`: requested mode is missing required enablement, credentials, or inputs.
- `FAILED`: critical safety issue or export failure.

Email sections include executive summary, public data now, deltas since the last run, actions taken, actions skipped, safety checks, warnings, required human review, Base44 readiness, next action, and a machine-readable summary for Claude/co-agent parsing.

Base44 should pull only when `base44_ready=true`. The report marks the update mode as `csv_ready`, `api_ready`, or `blocked`.

## URL Verification Workflow

`url_matcher.js` supports audits, review CSVs, dry-run imports, score thresholds, and manual override checks. Real URL imports require explicit approval and must use both:

- `DRY_RUN=false`
- `WRITE=true`

Unverified, placeholder, wrong-domain, search-page, or low-confidence URLs stay hidden from public outputs.

## Price Verification Workflow

Current catalog prices are seed/demo data. BuildWise intentionally blanks public price fields and hides price history until price records or snapshots include verified price status metadata.

That means Base44 can show verified retailer links while prices remain blank or unavailable. This is safer than presenting synthetic prices as real production prices.

## Required Environment Variables

- `DB_FILE`: path to `db.json`. Defaults to `db.json`.
- `PORT`: public API port. Defaults to `8080`.
- `BASE44_ALLOWED_ORIGINS`: comma-separated CORS allowlist for the public API.
- `PUBLIC_API_RATE_LIMIT_PER_MINUTE`: optional API rate limit. Defaults to `120`.
- `BUILDWISE_REPORT_EMAIL`: report recipient.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: SMTP settings for report email.

## Safe Commands

```powershell
npm run check:safe
npm run export:base44
npm run export:json
npm run api:public
npm run data:run
```

## Safety Rules

- Do not expose raw `db.json`.
- Do not put secrets or tokens in Base44 client code.
- Do not run live scraping by default.
- Do not mutate `db.json` unless explicitly approved.
- Require `WRITE=true` for real imports.
- Do not commit generated exports, reports, temp files, local backups, `.env`, credentials, or workbooks.

## Documentation

- [Engineering Style Guide](docs/STYLE_GUIDE.md)
- [Base44 CSV Import](docs/BASE44_DATA_IMPORT.md)
- [Base44 Public API](docs/BASE44_API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Data Safety Model](docs/DATA_SAFETY_MODEL.md)
