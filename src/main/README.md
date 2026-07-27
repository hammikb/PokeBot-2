# Electron Main-Process Domains

- `accounts/`, `payments/`, `shipping/` — encrypted user checkout data.
- `automation/` — browser lifecycle, queue handling, checkout flows, and safety helpers.
- `db/` and `db.js` — schema migrations plus SQLite/JSON persistence.
- `health/` — startup and central-monitor health reporting.
- `monitor/` — monitor source adapters and durable Supabase delivery.
- `notify/` — local notification dispatch.
- `products/` — catalog metadata, lookup, and retailer-link matching.
- `proxies/` — proxy import, testing, and health utilities.
- `security/` — per-install vault-key lifecycle.
- `supabase/` — public catalog client and authenticated session management.
- `tasks/` — task orchestration, drop idempotency, and order-submit gates.
- `telemetry/` — sanitized checkout analytics.
- `experimental/` — unconnected prototypes; never assume these run in production.
- `utils/` — shared production utilities with active callers.

`index.js` is the composition root and `ipc.js` is the validated
renderer-to-main boundary.
