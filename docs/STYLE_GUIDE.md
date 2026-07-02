# BuildWise Engineering Style Guide

## 1. Product Vision

BuildWise helps shoppers compare PC hardware using verified product data, direct retailer links, and trustworthy pricing. The product should favor accuracy and launch safety over showing incomplete or unverified data.

## 2. Core Architecture Principle

Private backend work stays private. Public app data must pass through `public_serializers.js` before it reaches Base44, static JSON, or the public API.

Base44 must never receive raw `db.json`. Base44 must not need a GitHub token. The public app layer should receive only product, retailer, offer, and price-history fields that are safe to show.

## 3. Data Safety Rules

- Unverified URLs stay hidden.
- Placeholder URLs stay hidden.
- Seed/demo prices stay blank.
- Price history stays hidden until verified.
- Affiliate URLs are not public by default.
- Source URLs, scrape URLs, review notes, user data, alerts, admin queues, scrape logs, and compliance logs stay internal.

## 4. Verification Standards

Every public export, API route, import, or reporting change needs syntax checks and a safe behavior check. Any command that could mutate `db.json` must be clearly gated and should default to dry-run behavior.

## 5. Default Safety Behavior

Defaults should be safe and dry-run oriented. Real database mutation requires explicit approval and `WRITE=true`. URL imports also require `DRY_RUN=false`.

## 6. File Comment Standard

Important workflow files should start with a concise block comment:

```js
/**
 * BuildWise purpose:
 * ...
 *
 * Plain-English summary:
 * ...
 *
 * Safety note:
 * ...
 */
```

The comment should help a new reviewer understand why the file exists and what it must not expose or change.

## 7. Naming Standards

Use clear names that match the data model:

- `product_id`, `retailer_id`, `retailer_offer_id`, `snapshot_id`
- `public*` for app-safe serialized views
- `verified_*` for production-safe URL or price statuses
- `*_review` for internal review files only

Avoid names that imply production trust before verification exists.

## 8. Folder Standards

- `docs/`: durable engineering and operations documentation.
- `base44_table_exports/`: generated CSV output, ignored by git.
- `public_data/`: generated public JSON output, ignored by git.
- `buildwise_reports/`: generated reports, ignored by git.
- `url_review_templates/`: local URL review/import files, ignored by git.
- `buildwise_backups/`: local data backups, ignored by git.

## 9. API Standards

Public API routes must serve only public serializer output. They must not expose raw database records, secrets, affiliate URLs, source URLs, URL review metadata, users, watchlists, alerts, admin queues, scrape errors, or compliance logs.

Use explicit routes under `/public/`, restrictive CORS defaults, simple rate limiting, and clear startup logs.

## 10. CSV/JSON Export Standards

CSV and JSON exports must use `public_serializers.js`. Public CSVs should preserve stable headers even when a table has zero rows. Public JSON should include a status file with counts, warnings, data mode, and database hash when available.

## 11. Automation/Reporting Standards

Automated data runs should audit, export, report, and email summaries only. They must not scrape, import URLs, mutate `db.json`, or commit generated files. Missing email configuration should skip email without failing the safe local report run.

## 12. Retailer Connector Standards

Prefer official APIs or approved feeds. Do not scrape aggressively or bypass site restrictions. Add source governance, rate limits, and compliance notes before automated retailer fetching.

## 13. Documentation Standards

Docs should explain what to run, what output means, what is intentionally hidden, and what requires approval. Write for a partner or senior engineer who is new to the repo.

## 14. Git Hygiene Standards

Do not commit local data, `.env`, credentials, generated exports, generated reports, temp URL files, backups, or `node_modules/`. Keep PRs focused and avoid unrelated refactors.

## 15. PR Standards

A PR should include a plain-English summary, launch impact, files changed, safety behavior, verification commands, remaining risks, and manual checks before merge.

## 16. BuildWise Quality Bar

Public data should be boringly safe: verified links only, blank unverified prices, no hidden client-side secrets, no accidental internal fields, and clear reporting when data is missing or blocked.
