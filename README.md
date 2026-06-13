# BuildWise Backend Pipeline

Local backend/data-pipeline utilities aligned to the Base44 dataset.

## Includes

- Base44 schema alignment
- Existing offer tracking
- Product discovery across 7 categories
- Similar product grouping
- Candidate review/promotion
- Source governance and compliance audit
- Data quality scoring
- Alert queue generation
- Backups, rollback, safe execution
- Base44 CSV/XLSX export
- Local scheduler and pipeline orchestrator

## Install

```powershell
npm.cmd install
```

## First run

```powershell
node .\env_check.js
node .\xlsx_to_json.js
$env:DB_FILE="db.json"
node .\migrate_db.js
node .\seed_data_sources.js
node .\validate_db.js
node .\audit_db.js
node .\compliance_audit.js
node .\data_quality_audit.js
node .\pipeline_status.js
```

## Git rule

Commit code. Do not commit local data, `.env`, backups, exports, reports, or workbooks.
