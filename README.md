# BuildWise Backend

BuildWise is a PC parts data backend for powering a Base44 app with clean product, retailer, offer, and price-history data. The backend remains the source of truth, while Base44 receives only public-safe views.

## Product Vision

BuildWise should help shoppers compare PC hardware using verified retailer links, trustworthy prices, and clear product data. The short-term launch path is conservative: publish verified product and retailer links first, keep seed/demo prices blank, and add price history only after pricing is verified.

## Repository Ownership

BuildWise uses two GitHub repos with different jobs:

- Production / operational repo: `tjvoelkel/buildwise-api`
- Development / source repo: `14checker/buildwise-api`

Daily scheduled reporting should run from Taylor's production repo only. Caleb's repo is for Codex branches, development, experiments, and PR preparation. Its data-run workflow is manual-only so it can be used for smoke tests without accidentally sending production daily emails.

Base44 must not use raw GitHub repo access, GitHub tokens, raw `db.json`, the encrypted database passphrase, SMTP secrets, or private backend files. Base44 should consume only public-safe CSV exports, public-safe JSON exports, or public API endpoints. All public data must pass through `public_serializers.js`.

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

Production start:

```powershell
npm start
```

The API serves only public serializer output. Base44 can call the public API without a GitHub token. Configure CORS with `CORS_ALLOWED_ORIGINS` before production use.

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

Base44 app routes are also available:

- `GET /categories`
- `GET /brands`
- `GET /retailers`
- `GET /products`
- `GET /products/:product_id`
- `GET /products/:product_id/offers`
- `GET /products/:product_id/price-history`
- `GET /offers`
- `GET /offers/:retailer_offer_id/price-history`
- `GET /deals`
- `GET /search/products?q=<query>`

See [Base44 API Integration](docs/BASE44_API_INTEGRATION.md).

## Automated Data-Run Workflow

Run:

```powershell
npm run data:run
```

The data run performs safe audit/export/report work only. It does not scrape, import URLs, use `WRITE=true`, or mutate `db.json`.

Scheduled production reporting runs from `tjvoelkel/buildwise-api`. In `14checker/buildwise-api`, the workflow is retained for manual development smoke tests only.

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

## Private Database for GitHub Actions

Raw `db.json` is private production data and must never be committed, uploaded as an artifact, pasted into logs, or exposed to Base44.

GitHub Actions still needs a private database source to run the daily report. The short-term operating path is to commit only an encrypted database file:

- encrypted file: `buildwise_private/db.json.gpg`
- GitHub Actions secret: `BUILDWISE_DB_GPG_PASSPHRASE`
- decrypted runtime path inside the runner: `db.json`

To prepare the encrypted file locally, set `BUILDWISE_DB_GPG_PASSPHRASE` in your shell and run:

```bash
./scripts/encrypt_db_for_actions.sh
```

The workflow decrypts `buildwise_private/db.json.gpg` only inside the GitHub Actions runner. The decrypted `db.json` remains ignored by git and must never be uploaded as an artifact. Safe report artifacts may include sanitized reports, Base44 CSV exports, and public JSON output only.

Longer term, BuildWise should move this private source of truth to managed storage or a hosted backend database instead of relying on an encrypted file in the repo.

## URL Verification Workflow

`url_matcher.js` supports audits, review CSVs, dry-run imports, score thresholds, and manual override checks. Real URL imports require explicit approval and must use both:

- `DRY_RUN=false`
- `WRITE=true`

Unverified, placeholder, wrong-domain, search-page, or low-confidence URLs stay hidden from public outputs.

## Automated Retailer Ingestion Pipeline

This branch adds the first controlled retailer ingestion path for production readiness. It is designed to reduce manual URL work without weakening the public safety model.

Pipeline sequence:

1. Find products that need retailer coverage.
2. Generate review rows and search queries for supported retailers.
3. Evaluate reviewed candidate product-page URLs.
4. Extract page identity from JSON-LD/meta data or approved local fixtures.
5. Score the candidate against BuildWise product identity using brand, model, MPN, SKU, category, and hard conflict checks.
6. Reject wrong-domain, search/category, bundle, refurbished, capacity-mismatch, and model-mismatch candidates.
7. Promote only verified exact or strong matches when `WRITE=true` and `AUTO_PROMOTE=true`.
8. Update offers and create price snapshots only when values meaningfully change.
9. Export public-safe CSV/JSON/API output through `public_serializers.js`.

Safe commands:

```powershell
npm run verify:candidates
npm run smoke:ingestion
npm run smoke:base44
npm run test:ingestion
npm run pipeline:production:dry
```

Production-style command, still dry-run unless write flags are added:

```powershell
$env:PIPELINE_MODE="production_sync"
$env:DISCOVERY_MODE="auto"
npm run pipeline:production
```

Write-capable promotion requires all of the following:

- `WRITE=true`
- `AUTO_PROMOTE=true`
- candidate page identity available through a reviewed URL plus live fetch approval or local fixture/page HTML
- no hard conflicts
- verified exact match or strong match above `AUTO_PROMOTE_MIN_SCORE`

Live retailer fetching is disabled by default. Set `INGESTION_ALLOW_LIVE_FETCH=true` only for approved low-volume connector checks that respect retailer terms. The pipeline does not bypass login, CAPTCHA, robots controls, blocks, or rate limits.

Supported adapter files live under `retailer_adapters/` for Amazon, Best Buy, B&H, Micro Center, Newegg, and Walmart. Unsupported retailers fall back to a generic domain-aware adapter.

One-product autonomous pilot, without a candidate CSV:

```powershell
$env:PIPELINE_MODE="production_sync"
$env:DISCOVERY_MODE="auto"
$env:WRITE="true"
$env:AUTO_PROMOTE="true"
$env:DISCOVERY_DRY_RUN="false"
$env:PROMOTE_DRY_RUN="false"
$env:TRACKER_DRY_RUN="false"
$env:DISCOVERY_PRODUCT_ID="<product-id>"
$env:DISCOVERY_RETAILER_ID="<retailer-id>"
$env:DISCOVERY_MAX_PRODUCTS="1"
$env:TRACKER_MAX_OFFERS="5"
npm run pipeline:production
```

Run that only after confirming the private DB path, backup path, source terms, and retailer request policy. For local proof without network access, use `npm run smoke:base44`.

## Price Verification Workflow

Current catalog prices are seed/demo data. BuildWise intentionally blanks public price fields and hides price history until price records or snapshots include verified price status metadata.

That means Base44 can show verified retailer links while prices remain blank or unavailable. This is safer than presenting synthetic prices as real production prices.

## Required Environment Variables

- `DB_FILE`: path to `db.json`. Defaults to `db.json`.
- `PORT`: public API port. Defaults to `8080`.
- `API_HOST`: bind host for the public API. Defaults to `0.0.0.0`.
- `PUBLIC_API_BASE_URL`: deployed API base URL used in docs/deployment.
- `CORS_ALLOWED_ORIGINS`: preferred comma-separated CORS allowlist for production API calls.
- `BASE44_ALLOWED_ORIGINS`: comma-separated CORS allowlist for the public API.
- `PUBLIC_API_RATE_LIMIT_PER_MINUTE`: optional API rate limit. Defaults to `120`.
- `BUILDWISE_REPORT_EMAIL`: report recipient.
- `BUILDWISE_DB_GPG_PASSPHRASE`: passphrase for decrypting `buildwise_private/db.json.gpg` in GitHub Actions.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: SMTP settings for report email.

Retailer ingestion variables:

- `PIPELINE_MODE=production_sync`: runs the production ingestion/export/report sequence.
- `DISCOVERY_MODE=auto|file|hybrid`: controls autonomous discovery, candidate-file fallback, or both. Defaults to `auto`.
- `DISCOVERY_CANDIDATE_FILE`: reviewed CSV/JSON candidate file to verify.
- `DISCOVERY_SEARCH_FIXTURE_DIR`: local search-result fixtures for tests and smoke runs.
- `DISCOVERY_SEARCH_PROVIDER_FILE`: optional approved search-provider result fixture/file.
- `DISCOVERY_MAX_PRODUCTS`: caps product coverage review rows. Defaults to `25`.
- `DISCOVERY_TARGET_OFFERS_PER_PRODUCT`: desired retailer coverage per product. Defaults to `3`.
- `DISCOVERY_RETAILERS`: comma-separated retailer IDs/names to include.
- `DISCOVERY_STALE_HOURS`: age threshold for refreshing verified offers. Defaults to 30 days.
- `INGESTION_ALLOW_LIVE_FETCH`: defaults to `false`; enables direct candidate page fetches only when approved.
- `AUTO_PROMOTE_MIN_SCORE`: defaults to `90`.
- `AUTO_PROMOTE=true`: allows exact/strong matches to promote only when `WRITE=true`.
- `WRITE=true`: the required database mutation gate.

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
- Do not commit raw `db.json`; commit only encrypted `buildwise_private/db.json.gpg` when using the short-term Actions path.
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
