# Control Plane Reliability Design

**Date:** 2026-08-25  
**Status:** Approved for implementation by the user in this task

## Goal

Make the existing Pi, Vercel, Supabase, and Electron communication paths observable and recoverable without changing local checkout or queue execution behavior.

## Boundaries

- Electron continues to receive monitor events from authenticated Supabase Realtime with database catch-up.
- The Pi continues to publish monitoring telemetry through the existing Vercel ingest endpoint.
- Vercel remains the dashboard and command enqueue API; it is not used as a long-lived transport.
- Queue joining, checkout flows, browser sessions, credentials, payment data, and shipping data remain local and unchanged.
- The Pi control agent remains allow-list based and must never execute arbitrary commands.

## Reliability changes

1. Persist Electron monitor cursors and delivery counters locally so an app restart can replay beyond the in-memory five-minute window.
2. Add versioned event metadata and idempotency handling at ingest, retaining the existing `source_event_id` protection for drops.
3. Add command leases, acknowledgement timestamps, expiration, and stale-command recovery to the Pi command path.
4. Report process, transport, telemetry, and last-event freshness separately in the website.
5. Add bounded retries with backoff for trusted Pi telemetry delivery; do not add high-frequency dashboard polling.

## Security

- Supabase service credentials remain restricted to Vercel server code and the trusted Pi agent.
- Electron uses the publishable Supabase key plus the signed-in user's session.
- Realtime channels remain private and database RLS remains authoritative.
- Command validation remains duplicated in Vercel and the Pi agent.

## Rollout

Changes are observation-first. Existing command actions remain allow-listed, and checkout/queue handlers are not modified. The Pi agent source is currently outside a Git repository under `Test HTPPCLOACK`; tracked changes will include the patch/deployment contract and website/Electron code, while the untracked agent file will be updated locally and clearly reported.
