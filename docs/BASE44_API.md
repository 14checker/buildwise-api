# Base44 Public API

The BuildWise public API is the long-term app-facing layer for Base44. It serves only `public_serializers.js` output and must not expose raw `db.json` or internal backend data.

## Endpoints

### `GET /health`

Returns a simple service health response.

```json
{
  "ok": true,
  "safe_mode": true,
  "data_source": "db.json"
}
```

### `GET /public/status`

Returns public export counts, verification counts, hidden data counts, warnings, data mode, and db hash.

### `GET /public/products`

Returns public products that have at least one verified public-safe offer by default.

Example shape:

```json
[
  {
    "product_id": "cpu-ryzen-9-9950x3d-001",
    "category_id": "cpu",
    "brand": "AMD",
    "model": "Ryzen 9 9950X3D",
    "slug": "amd-ryzen-9-9950x3d",
    "mpn": null,
    "msrp": null,
    "status": "active"
  }
]
```

### `GET /public/products/:product_id`

Returns one public product by `product_id`, or `404` if it is not public-safe.

### `GET /public/retailers`

Returns public retailer reference rows.

### `GET /public/offers`

Returns verified public-safe retailer offers.

### `GET /public/offers?product_id=<id>`

Returns verified public-safe offers for one product.

Price fields may be blank until pricing is verified.

### `GET /public/price-history`

Returns verified public-safe price history. This may be empty until BuildWise has verified production price sources.

### `GET /public/price-history?product_id=<id>`

Returns verified public-safe price history for one product.

### `GET /public/search?q=<query>`

Searches public products and matching public offers. Search results are limited to already-public data.

## Security Model

- The GitHub repo stays private.
- The API can be public.
- The API serves only `public_serializers.js` output.
- Base44 does not receive GitHub tokens.
- Base44 does not call the raw GitHub private repo.
- Raw `db.json` is never served.
- Affiliate URLs, source URLs, URL review metadata, users, watchlists, alerts, admin queues, scrape errors, and compliance logs are not exposed.

## Environment Variables

- `DB_FILE`: path to the backend database file. Defaults to `db.json`.
- `PORT`: public API port. Defaults to `8080`.
- `BASE44_ALLOWED_ORIGINS`: comma-separated CORS allowlist. Defaults to local development origins only.
- `BUILDWISE_REPORT_EMAIL`: report recipient for data-run email.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: SMTP settings for data-run email.

## Data Notes

Prices may be blank because current catalog prices are seed/demo data. BuildWise should only publish prices after price rows or snapshots have verified source/status metadata.

Price history may be empty for the same reason. Empty price history is safer than presenting synthetic history as real market data.
