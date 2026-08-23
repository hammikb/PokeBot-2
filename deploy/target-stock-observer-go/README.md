# Target Stock Observer (Go)

The Go observer polls the configured Target product watchlist from the Raspberry Pi through the proxy pool. It checks products concurrently with a bounded worker pool so a 44-product watchlist can complete within the configured 15/30-second cadence when Target and the proxies respond quickly. It publishes inventory, drop, proxy-health, and bounded operational log events to the existing PokeAlert `/api/ingest` endpoint.

Operational logs use `type: "log"` with service `target-stock-observer-go`. Startup, schedule, watchlist, proxy, transition, delivery-error, and throttled cycle-summary messages appear in the PokeAlert Logs page. Individual routine product observations remain in Pi journald to keep Vercel and Supabase traffic low.

The observer requires `POKEALERT_INGEST_URL`, `POKEALERT_INGEST_TOKEN`, `TARGET_REDSKY_API_KEY`, and a non-empty proxy file. It refuses to connect to Target directly when the proxy file is empty. `TARGET_STOCK_CONCURRENCY` controls the bounded worker count and defaults to 12, capped by the number of configured proxies.
