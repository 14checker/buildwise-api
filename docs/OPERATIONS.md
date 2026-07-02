# BuildWise Operations

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

The GitHub Actions workflow runs the same safe daily report on a schedule and can also be triggered manually with `workflow_dispatch`.

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
