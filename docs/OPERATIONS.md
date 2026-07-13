# BuildWise Operations

## Repository Ownership

BuildWise has a production repo and a development/source repo:

- Production / operational repo: `tjvoelkel/buildwise-api`
- Development / source repo: `14checker/buildwise-api`

Daily scheduled reporting runs from Taylor's production repo only. Caleb's repo is used for Codex branches, development, experiments, and PR preparation. The Caleb workflow is manual-only and should be used for smoke testing, not production daily email.

Base44 must not use raw GitHub repo access, GitHub tokens, raw `db.json`, the encrypted database passphrase, SMTP secrets, or private backend files. Base44 should consume only public-safe CSV exports, public-safe JSON exports, or public API endpoints. All public data must pass through `public_serializers.js`.

## Daily or Manual Data Run

Run locally:

```powershell
npm run data:run
```

The data run is safe by default. It audits the public data state, creates Base44 CSV exports, creates public JSON exports, writes reports, and optionally emails a summary.

It does not scrape, import URLs, use `WRITE=true`, or mutate `db.json`.

Default mode:

- `BUILDWISE_RUN_MODE=audit_only`
- `BUILDWISE_AUTONOMY_LEVEL=report_only`
- `BUILDWISE_REPORT_EMAIL=support@buildwise-pc.com`

Taylor's production GitHub Actions workflow runs the same safe daily report on a schedule and can also be triggered manually with `workflow_dispatch`. Caleb's development workflow keeps only `workflow_dispatch` for manual smoke tests.

## Private Database in GitHub Actions

Raw `db.json` is private production data. It must never be committed, printed in logs, uploaded as an artifact, or sent to Base44.

Because GitHub Actions runs in a fresh runner, the daily workflow needs a private database source. The short-term BuildWise path is:

- commit only the encrypted file `buildwise_private/db.json.gpg`
- store the passphrase as the GitHub secret `BUILDWISE_DB_GPG_PASSPHRASE`
- decrypt to `db.json` only inside the workflow runner
- keep decrypted `db.json` ignored and never upload it as an artifact

Local preparation:

```bash
export BUILDWISE_DB_GPG_PASSPHRASE="<your private passphrase>"
./scripts/encrypt_db_for_actions.sh
```

Workflow behavior:

1. Checkout the repo.
2. Install dependencies.
3. Decrypt `buildwise_private/db.json.gpg` to `db.json`.
4. Run syntax checks, exports, reporting, and optional email.
5. Upload only sanitized reports/exports. Never upload `db.json`, `buildwise_private/*`, `.env`, credentials, or secrets.

If `buildwise_private/db.json.gpg` or `BUILDWISE_DB_GPG_PASSPHRASE` is missing, the workflow should fail clearly before exports or reporting begin.

This encrypted file approach is a short-term bridge. Longer-term production should move BuildWise data to managed storage or a hosted backend database with proper access controls.

## Report Outputs

Reports are written to `buildwise_reports/`:

- `data_run_<timestamp>.json`
- `data_run_<timestamp>.txt`

Generated reports are ignored by git.

## What the Metrics Mean

- `public_products`: products currently safe for Base44.
- `public_offers`: verified public-safe retailer offers.
- `public_retailers`: public retailer reference rows.
- `public_price_snapshots`: verified public-safe price history rows.
- `verified_offers`: offers with verified URL status and safe URLs.
- `hidden_placeholder_offers`: offers hidden because URLs are missing, placeholder, wrong-domain, or unsafe.
- `hidden_seed_demo_prices`: offer price fields hidden because pricing is unverified or seed/demo data.
- `db_hash`: SHA256 of the database file used for the run.

## Email Reporting

If SMTP variables are configured, `buildwise_data_run.js` emails a summary to `BUILDWISE_REPORT_EMAIL`, expected to be `support@buildwise-pc.com`.

Required email variables:

- `BUILDWISE_REPORT_EMAIL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

If any are missing, email is skipped and local reports are still written.

## HTML Email Report

BuildWise sends daily report email as multipart email with a dashboard-style HTML body and the existing plain-text fallback.

The HTML report uses inline, email-safe styling with dark BuildWise colors, metric cards, status badges, warning cards, and Base44 readiness details. It does not rely on external CSS, scripts, remote fonts, remote images, or background images.

Each data run also writes a local HTML preview report under `buildwise_reports/`:

- `data_run_<timestamp>.html`

Email delivery still requires SMTP secrets. If an email client blocks HTML, the plain-text fallback remains available.

The email contains:

- executive summary
- public data counts
- deltas since the last run
- actions taken
- skipped actions and reasons
- safety checks
- warnings
- required human review
- Base44 readiness
- next recommended action
- machine-readable summary block

## Claude Review Loop

Claude should treat the email as an operations summary, not as proof that hidden data is safe. Claude should review warnings, compare counts to the previous baseline, and recommend the next small reviewed batch.

Warnings usually mean:

- URL verification is still incomplete.
- Seed/demo pricing is being hidden.
- Price history is unavailable because source/status metadata is missing.
- A database file was missing from the environment.

Claude should recommend Base44 pulls only when:

- `base44_ready=true`
- `base44_should_pull=true`
- no critical safety failures are present
- public output remains free of raw db data, affiliate URLs, source URLs, review metadata, internal fields, unverified URLs, and seed prices

Human review is required when reports list review files, uncertain candidate rows, failed checks, missing credentials, or source/terms decisions.

Status meanings:

- `PASS`: safe and clean.
- `PASS_WITH_WARNINGS`: safe but incomplete or attention-worthy.
- `NEEDS_REVIEW`: a human decision is needed before the next action.
- `BLOCKED`: a requested mode cannot continue because enablement, credentials, or inputs are missing.
- `FAILED`: a critical safety or export failure occurred.

## Failed Run Response

If a safe data run fails:

1. Do not retry with `WRITE=true`.
2. Check `DB_FILE` and confirm the database exists.
3. Run `npm run check:safe`.
4. Review the error and the most recent report.
5. Fix code in a focused branch, then rerun safe checks.

If the report is blocked, do not bypass the blocker. Fix the missing configuration, review input, credential, or source-governance decision first.

## Recovery After a Bad Import

If a real import mutates `db.json` incorrectly:

1. Stop before running tracker or exports.
2. Hash the current `db.json`.
3. Compare changed offer IDs against the approved import file.
4. Restore from the most recent approved backup in `buildwise_backups/`.
5. Hash the restored file.
6. Dry-run the corrected import before any future `WRITE=true` run.

Never recover by guessing or manually editing production data without a clear approved plan.

## Automated Retailer Ingestion Runbook

The automated ingestion layer helps BuildWise move from reviewed candidate URLs to verified public-safe offers. It is not an uncontrolled scraper. It is a gated pipeline around reviewed candidate URLs, retailer-domain checks, page identity extraction, deterministic scoring, and explicit write flags.

Primary files:

- `ingestion_config.js`: central environment parsing and write-safety validation.
- `retailer_adapters/`: retailer-aware URL validation, search query helpers, page fetch, and identity extraction.
- `candidate_verification.js`: match scoring, hard conflict detection, safe offer upsert, and meaningful price snapshot checks.
- `retailer_ingestion.js`: product coverage review generation, candidate evaluation, and optional promotion.
- `verify_candidates.js`: CLI entry point for reviewed candidate verification.
- `pipeline_orchestrator.js`: ordered production sync flow.
- `scheduler.js`: long-running job scheduler with lock files.

Dry-run candidate verification:

```powershell
$env:DISCOVERY_CANDIDATE_FILE="url_review_templates\\reviewed_candidates.csv"
npm run verify:candidates
```

This validates and scores rows but does not mutate `db.json` unless `WRITE=true` is set. If `AUTO_PROMOTE=true` is set without `WRITE=true`, the run fails before work begins.

Autonomous discovery dry-run, without a candidate file:

```powershell
$env:PIPELINE_MODE="production_sync"
$env:DISCOVERY_MODE="auto"
npm run pipeline:production:dry
```

Supervised write-capable verification:

```powershell
$env:DISCOVERY_CANDIDATE_FILE="url_review_templates\\reviewed_candidates.csv"
$env:AUTO_PROMOTE="true"
$env:WRITE="true"
npm run verify:candidates
```

Use this only after a dry-run report confirms:

- candidate URLs are direct product pages
- retailer domains match
- source terms are approved
- hard conflicts are empty
- match score meets policy
- pricing changes, if any, are expected
- a backup exists

Production sync dry-run:

```powershell
$env:PIPELINE_MODE="production_sync"
npm run pipeline:production
```

Production sync sequence:

1. environment check
2. backup
3. migration, guarded by `WRITE=true`
4. database validation
5. database audit
6. source compliance audit
7. discovery review
8. candidate verification
9. grouping
10. promotion, dry-run unless explicitly enabled
11. tracker, dry-run unless explicitly enabled
12. alerts
13. data quality audit
14. public JSON export
15. Base44 CSV export
16. pipeline status
17. admin report

The orchestrator appends `pipeline_runs` only when `WRITE=true`. Dry-run pipeline runs print that the run history was not written.

One-product autonomous pilot:

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

Do not run that against production data until the dry-run output shows the expected product, retailer, queries, candidates, and no hard conflicts.

Scheduler controls:

- `RUN_ON_START=false` disables immediate startup jobs.
- `PRODUCTION_SYNC_EVERY_MINUTES` schedules full production sync when greater than zero.
- `TRACKER_EVERY_MINUTES`, `PROMOTE_EVERY_MINUTES`, `DISCOVERY_EVERY_MINUTES`, and `GROUP_EVERY_MINUTES` schedule individual jobs.
- `.buildwise_locks/` prevents overlapping write-capable jobs.
- `SCHEDULER_LOCK_STALE_MINUTES` controls stale-lock cleanup.

The ingestion pipeline will not:

- bypass robots, CAPTCHA, login, geo-blocks, or access controls
- bulk scrape search/category pages
- approve marketplace/refurbished/bundle variants by default
- treat low-confidence fuzzy matches as exact
- expose candidate records publicly
- approve seed/demo pricing
- generate fake price history
- mutate `db.json` without `WRITE=true`

## API and Worker Deployment

The production deployment should separate the public API from the worker:

- API service: `npm start`
- Worker service: `npm run scheduler`
- Shared persistent storage: the same `DB_FILE` path or volume

Current JSON database limitation:

- API and worker need shared persistent storage.
- Horizontally scaled writers are unsafe without a centralized transactional database.
- Start production with one API instance and one controlled worker.
- A future PostgreSQL or managed database migration can replace JSON persistence later, but that is outside this branch.

Public API deployment variables:

- `NODE_ENV=production`
- `PORT=8080`
- `API_HOST=0.0.0.0`
- `DB_FILE=/data/db.json`
- `CORS_ALLOWED_ORIGINS=https://<base44-app-origin>`
- `PUBLIC_API_BASE_URL=https://<buildwise-api-host>`

Worker variables:

- `PIPELINE_MODE=production_sync`
- `DISCOVERY_MODE=auto`
- `WRITE=true`
- `AUTO_PROMOTE=true`
- `PRODUCTION_SYNC_EVERY_MINUTES=1440`
- `RUN_ON_START=false`

Base44 setup is documented in `docs/BASE44_API_INTEGRATION.md`.
