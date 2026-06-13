# Compliance Checklist

Before enabling a source:

```txt
[ ] Source exists in data_sources
[ ] Terms reviewed
[ ] terms_status set intentionally
[ ] Rate limit defined
[ ] Affiliate disclosure requirement captured
[ ] Attribution requirement captured
[ ] Scraper uses source_url, not affiliate_url
```

Recommended stricter production mode:

```powershell
$env:REQUIRE_APPROVED_SOURCE="true"
```
