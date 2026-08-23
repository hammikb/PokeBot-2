# Operations Console Refresh Design

Date: 2026-08-23

## Goal

Make the PokeAlert web dashboard a clearer operations console for the Raspberry Pi monitors, with reliable visibility into service state, schedules, proxy health, and monitor logs. Keep Target traffic on the Pi proxy path and preserve the Electron queue and checkout flows.

## Scope

In scope:

- Go Target Stock Monitor publishing low-volume structured logs to the existing Vercel `/api/ingest` endpoint.
- Logs dashboard filtering, refresh, severity/service presentation, and clearer empty/error states.
- Pi Controls redesign with separate schedule, service fleet, experimental services, and recent command sections.
- Consistent service labels, status badges, freshness indicators, responsive layout, and dashboard-wide visual cleanup.
- Infrastructure, Overview, Products, History, and Logs page review for presentation and reporting improvements.

Out of scope:

- Electron queue joining, checkout, automation flows, or renderer behavior.
- Moving Target requests to Windows or the home IP.
- Changing Supabase security policies or replacing the existing Vercel-to-Supabase path.
- Adding a second monitoring backend.

## Data flow

The Go monitor will publish bounded `log` events to the existing ingest route. Vercel will validate and insert them into `monitor_logs`; the dashboard will read the existing table through its server-side Supabase client. Logs will include a service label such as `target-stock-observer-go` and will cover startup, schedule changes, cycle summaries, proxy failover, watchlist refresh failures, stock transitions, and integration failures. Routine individual out-of-stock checks will remain in Pi journald only to control bandwidth and database volume.

## UI design

Pi Controls will be organized into:

1. A schedule card showing the authoritative schedule, active interval, timezone, unsaved state, and save/discard actions.
2. A service fleet grouped by production and experimental services, with readable names, live state, last signal, and explicit action buttons.
3. A recent commands area with filters or clearer result presentation.

The Logs page will add service/severity filters, text search, refresh/auto-refresh controls, summary counts, and an expandable or readable message layout. Status colors will use the existing design tokens and remain accessible on the dark theme.

The rest of the dashboard will receive targeted consistency improvements rather than a destructive rewrite: clearer freshness labels, consistent naming, more useful empty states, and responsive behavior at tablet/mobile widths.

## Reliability and safety

- Use the existing authenticated ingest token and Supabase admin path.
- Do not log secrets, proxy credentials, webhook URLs, or full authorization headers.
- Do not send every product observation to Vercel; summarize routine polling.
- Log publishing failures locally without recursively attempting to publish the logging failure.
- Preserve the legacy Python monitor as a rollback option and do not modify Electron service definitions.

## Verification

- Add Go unit tests for log envelopes, event classification/throttling, and safe service labels.
- Run Go tests, vet, and a Linux ARM64 build.
- Run the dashboard test suite and production build.
- Start the dashboard locally and verify Overview, Infrastructure, Pi Controls, Logs, Products, History, and Checkout Analytics load without console errors.
- Deploy the Go binary/service to the Pi only after local verification.
- Confirm a startup or cycle log appears in the Vercel Logs page and confirm Electron services are unchanged.
