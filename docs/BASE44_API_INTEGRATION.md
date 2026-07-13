# Base44 API Integration

BuildWise public data should reach Base44 through the deployed public API, not through raw GitHub, raw `db.json`, encrypted database files, reports, or internal review files.

## Environment Configuration

Use an environment variable in Base44:

```text
VITE_BUILDWISE_API_BASE_URL=https://<buildwise-api-host>
```

The API base should not include a trailing slash. Public catalog endpoints are served directly under this host, with compatibility routes also available under `/public`.

## Base44 Provider Behavior

Base44 should call:

- `GET /health`
- `GET /public/status`
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

Base44 should not call:

- GitHub
- raw `db.json`
- `buildwise_private/*`
- encrypted DB files
- `buildwise_reports/*`
- `url_review_templates/*`
- private/admin/write endpoints

## Filters and Pagination

Products support:

```text
category_id
brand_id
brand
search
has_offers
in_stock
min_price
max_price
sort
limit
offset
```

Offers support:

```text
product_id
retailer_id
availability
condition
sort
limit
offset
```

Deals support:

```text
category_id
brand_id
brand
retailer_id
availability
sort
limit
offset
```

For backwards compatibility, list endpoints return arrays. Pagination metadata is provided in response headers:

- `X-Total-Count`
- `X-Result-Count`
- `X-Limit`
- `X-Offset`
- `X-Has-More`

## Expected States

Base44 should handle these states:

- `loading`: request in progress.
- `empty`: endpoint returns an empty array.
- `coming_soon`: product shell exists but no verified offer is available yet.
- `price_unavailable`: `current_price` is `null`.
- `out_of_stock`: verified offer availability is `out_of_stock`.
- `in_stock`: verified offer availability is `in_stock`.
- `api_error`: API request fails.
- `stale_data`: status endpoint reports stale or warning state.

Do not show fake, demo, seed, placeholder, or guessed prices. When `current_price` is `null`, show a label such as `Price unavailable` or `Check retailer`.

## Refresh Guidance

- Fetch products and reference data on page load.
- Refetch on route navigation when product context changes.
- Cache categories, brands, and retailers for the session.
- Do not poll aggressively.
- Price-sensitive views may refresh every few minutes once verified prices exist.
- If the API is unavailable, show an API unavailable state rather than falling back to fake prices.
- Seed mode should require an explicit development flag and should never run in production.

## CORS

Set the deployed API service:

```text
CORS_ALLOWED_ORIGINS=https://<base44-app-origin>
```

Local development origins are allowed by default only when no production CORS origin is configured.

## Copy-Ready Base44 Prompt

Paste this into Base44 when switching from seed data to the BuildWise API:

```text
Update the BuildWise data provider to use the live BuildWise public API while preserving the current UI and provider abstraction.

Use environment variable:
VITE_BUILDWISE_API_BASE_URL=https://<buildwise-api-host>

Call these endpoints:
- GET /health
- GET /public/status
- GET /categories
- GET /brands
- GET /retailers
- GET /products
- GET /products/:product_id
- GET /products/:product_id/offers
- GET /products/:product_id/price-history
- GET /offers
- GET /offers/:retailer_offer_id/price-history
- GET /deals
- GET /search/products?q=<query>

Keep existing UI layout and styling. Add graceful loading, empty, coming_soon, price_unavailable, out_of_stock, in_stock, api_error, and stale_data states.

Never call GitHub, raw db.json, encrypted database files, reports, review files, or private backend files from Base44.

Never fall back to fake, demo, seed, placeholder, or guessed prices in production. If current_price is null, show "Price unavailable" or "Check retailer".

Allow seed/demo mode only behind an explicit development-only flag. Production should use the API response only.

Use pagination headers X-Total-Count, X-Result-Count, X-Limit, X-Offset, and X-Has-More where useful.

If the API is unavailable, show an API unavailable message and keep the app stable without displaying fake data.
```
