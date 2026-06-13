# BuildWise Optimized Backend Files v8

v8 is the expanded “data operations” package. It keeps all v7 capabilities and adds migrations, environment checks, data quality scoring, alert queue generation, Base44 export packs, admin HTML reports, and a pipeline orchestrator with lock protection.

## What v8 adds over v7

```txt
migrate_db.js
env_check.js
data_quality_audit.js
alert_engine.js
export_base44_tables.js
generate_admin_report.js
pipeline_orchestrator.js
```

New/expanded tables:

```txt
system_settings
change_log
alert_queue
pipeline_runs
data_quality_reports
quarantine_records
import_export_log
system_events
```

## Install

```powershell
npm.cmd install
```

## First setup flow

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

## Full safe daily pipeline

This runs a complete controlled pass:

```txt
env check
backup
migrate
validate
audit
compliance audit
group products
promote approved candidates
track stale/current offers
run alert engine
data quality audit
pipeline status
admin report
```

Command:

```powershell
$env:DB_FILE="db.json"
$env:PIPELINE_MODE="safe_daily"
$env:TRACKER_DRY_RUN="true"
$env:TRACKER_MAX_OFFERS="25"
$env:PROMOTE_DRY_RUN="true"
$env:AUTO_PROMOTE="false"
$env:ALERT_DRY_RUN="true"
$env:REQUIRE_APPROVED_SOURCE="false"
node .\pipeline_orchestrator.js
```

When ready to actually save known price/promotion changes:

```powershell
$env:TRACKER_DRY_RUN="false"
$env:PROMOTE_DRY_RUN="false"
$env:ALERT_DRY_RUN="false"
node .\pipeline_orchestrator.js
```

## Discovery review pipeline

```powershell
$env:DB_FILE="db.json"
$env:PIPELINE_MODE="discovery_review"
$env:DISCOVERY_DRY_RUN="true"
node .\pipeline_orchestrator.js
```

Save discovery candidates:

```powershell
$env:DISCOVERY_DRY_RUN="false"
node .\pipeline_orchestrator.js
```

## Export pipeline for Base44

```powershell
$env:DB_FILE="db.json"
$env:PIPELINE_MODE="export"
node .\pipeline_orchestrator.js
```

This creates:

```txt
base44_table_exports/export_xxxx/*.csv
buildwise_compiled_datasets_UPDATED.xlsx
```

## Individual v8 commands

Environment check:

```powershell
node .\env_check.js
```

Migrate/upgrade db structure:

```powershell
node .\migrate_db.js
```

Data quality report:

```powershell
node .\data_quality_audit.js
```

Alert queue generation:

```powershell
$env:DRY_RUN="true"
node .\alert_engine.js
```

Admin report:

```powershell
node .\generate_admin_report.js
```

Base44 CSV table export:

```powershell
node .\export_base44_tables.js
```

## Strict source compliance mode

Use this when you want the tracker to refuse unapproved sources:

```powershell
$env:REQUIRE_APPROVED_SOURCE="true"
node .\safe_run.js tracker_updated.js
```

## Scheduler

Recommended local scheduler:

```powershell
$env:DB_FILE="db.json"
$env:TRACKER_EVERY_MINUTES="15"
$env:PROMOTE_EVERY_MINUTES="15"
$env:DISCOVERY_EVERY_MINUTES="240"
$env:GROUP_EVERY_MINUTES="240"
$env:TRACKER_MAX_OFFERS="25"
$env:TRACKER_DRY_RUN="false"
$env:PROMOTE_DRY_RUN="false"
$env:DISCOVERY_DRY_RUN="true"
$env:AUTO_PROMOTE="false"
$env:REQUIRE_APPROVED_SOURCE="false"
node .\scheduler.js
```

## Operating rule

For anything risky, use:

```powershell
node .\safe_run.js script_name.js
```

For full workflow control, use:

```powershell
node .\pipeline_orchestrator.js
```

v8 is still local-file based. The next major step after this would be moving from `db.json` into a hosted database/API.
