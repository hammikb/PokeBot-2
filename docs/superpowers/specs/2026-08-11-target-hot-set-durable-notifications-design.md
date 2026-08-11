# Target hot-set coverage and durable notifications

**Date:** 2026-08-11

**Status:** Approved (brainstorm)

**Systems:** PokeBot 2 Supabase project (`jbnnouwhesexfllninwb`), PokeAlert web,
and Raspberry Pi worker `pokebot-worker`

## Incident evidence

Target TCIN `95163306` was present in `target_catalog` from 2026-07-04, but it
was not present in the active `products` watchlist until the Electron task was
created at `2026-08-11T07:55:56Z`. The Pi refreshed its watchlist at
`07:56:32Z`, rebuilt three browser contexts, and made its first successful
inventory observation at `07:57:36Z`. That observation was already
`OUT_OF_STOCK` with ATP quantity zero. Later requests received HTTP 403.

There is no in-stock inventory observation, `drops` row, `drop_log` row, or
local Electron drop receipt for this TCIN. Discord was therefore never called.
The failure occurred before notification fan-out: a known catalog product was
not promoted into the active watchlist before its stock window.

The investigation also found three independent reliability gaps:

- the Pi refreshes the dashboard watchlist every 180 seconds;
- any watchlist change cancels and rebuilds every Target browser watcher,
  creating an avoidable blind period; and
- final cloud-ingest failures are swallowed, while Discord responses are not
  checked for non-2xx status codes and failed Discord messages are not durable.

## Goal

1. Proactively monitor a bounded set of high-demand Target Pokemon products
   before a user creates an Electron task.
2. Preserve explicit user subscriptions and admin pins as the highest-priority
   monitoring inputs.
3. Deliver every detected in-stock transition idempotently to Supabase and
   durably to Discord, including across transient failures and Pi restarts.
4. Reduce watchlist propagation time without multiplying Target traffic enough
   to worsen the existing HTTP 403 rate.

## Non-goals

- Monitoring all 263 Target catalog products. The live worker already saw 403s
  with 21 products, so unbounded expansion is unsafe.
- Changing Target checkout behavior. This design ends when a durable drop event
  reaches the existing checkout subscriber.
- Building a general rule-management UI. Initial rules are database-managed;
  a dashboard editor can be added separately.
- Replacing the browser-warmed Redsky monitor with an unofficial mobile API.

## Design

### 1. Database-owned bounded hot-set watchlist

Add `products.auto_watch boolean not null default false`. The authoritative
monitoring invariant becomes:

```text
products.active = products.pinned
               OR products.auto_watch
               OR EXISTS(subscription for the product)
```

Add a service-role-only `target_auto_watch_rules` table with a rule name,
case-insensitive literal match term, priority, and enabled flag. Seed two rules:

- `Prismatic Evolutions`
- `Ascended Heroes`

A `refresh_target_auto_watch_products()` security-definer function selects
direct-sold Target catalog rows matching enabled rules, orders them by rule
priority and catalog recency, and caps automatic coverage at 50 products.
It upserts selected rows into `products` with `auto_watch=true`, canonical
catalog names and canonical Target URLs. Previously automatic rows that no
longer match are set to `auto_watch=false`; their `active` value is recomputed
without disturbing pins or subscriptions.

Statement-level triggers refresh the materialized automatic set after changes
to `target_catalog` or `target_auto_watch_rules`. Statement-level execution
avoids rescanning the catalog once per row during a bulk catalog upsert.

At the approval-time snapshot, the initial rules match 24 catalog products.
Nine are already active, so the live numeric Target watchlist grows by 15, from
23 to 38 products. Explicit pins and subscriptions do not count against the
50-product automatic cap. These counts are rollout assertions rather than
hard-coded behavior because manual pins/subscriptions may change meanwhile.

The existing `/api/watchlist` contract remains unchanged because it already
returns every `products.active=true` row.

### 2. Fast, incremental Pi watchlist reconciliation

Reduce the Pi's default `POKEALERT_WATCHLIST_REFRESH` from 180 seconds to 15
seconds. This is a small authenticated request to PokeAlert, not a Target
request, so it does not consume a Target proxy identity.

Replace all-or-nothing watcher rebuilding with a batch supervisor keyed by each
batch's ordered TCIN signature:

- unchanged batch tasks continue running;
- new or changed batch tasks start before obsolete tasks are cancelled;
- only obsolete batch tasks are cancelled after replacements have started; and
- task cleanup is awaited so closed-context exceptions are consumed.

Because the watchlist endpoint orders existing products by creation time, a
newly appended product normally changes only the final batch. Existing hot-set
products are already warm before a drop and do not depend on this path.

### 3. Idempotent drop delivery and a durable local outbox

Extend the Pi's atomic state file from only `in_stock` to also contain pending
alert events. Each out-of-stock to in-stock transition receives a UUID
`drop_cycle_id` and one outbox entry containing the normalized drop payload,
cloud-delivery state, Discord-delivery state, and retry metadata. An
`asyncio.Lock` serializes every in-memory mutation and atomic file replacement
so concurrent product batches and the dispatcher cannot overwrite each other.

The critical sequence is:

1. Persist the new outbox entry atomically.
2. Post the drop to PokeAlert/Supabase synchronously.
3. After a confirmed 2xx response, atomically mark cloud delivery complete and
   add the TCIN to `in_stock`.
4. Let the background Discord dispatcher deliver the same event and remove the
   outbox entry only after every configured destination has confirmed success.

`_post_ingest` must raise after its final failed attempt. `_apply` must not add
the TCIN to `in_stock` before cloud delivery succeeds. A later poll therefore
retries rather than consuming the transition.

Add a partial unique index on `drops(drop_cycle_id)`. The ingest route attempts
an insert and treats PostgreSQL unique-violation code `23505` for that cycle ID
as idempotent success without updating the existing row. Replaying an event
after an ambiguous timeout or Pi restart therefore cannot create a second
durable drop row or a second checkout trigger.

The Discord dispatcher must call `raise_for_status()` on webhook responses,
use bounded exponential backoff with jitter, and retain failed entries on disk.
The first Discord payload is intentionally useful without enrichment: product
name, canonical URL, availability, quantity, and detected time. Price/image
enrichment may update a still-pending entry but never gates delivery.

Discord delivery is at-least-once. Discord webhooks do not provide an
idempotency key, so a connection loss after Discord accepted a message but
before the Pi received the response can produce a duplicate. Retrying in that
ambiguous case is preferable to silently losing the alert. Supabase drop and
checkout delivery remains idempotent by `drop_cycle_id`.

If Discord is not configured, the worker emits a prominent health warning and
does not accumulate an undeliverable Discord queue. Supabase drop delivery
continues independently.

### 4. Health and operational evidence

Extend `worker_health` with nullable fields for:

- `watchlist_product_count`
- `watchlist_last_success_at`
- `alert_outbox_pending`
- `last_drop_delivery_at`
- `last_discord_delivery_at`

Existing monitor logs retain per-product response evidence. Repeated Target
403s remain a monitoring-health problem, but they cannot be mislabeled as a
Discord failure. A synthetic delivery check will be available in tests without
creating a real checkout.

## Failure handling

- **Watchlist endpoint unavailable:** keep the last known watchlist and retry;
  never replace it with an empty list.
- **Catalog rule matches too broadly:** automatic rows are deterministically
  capped at 50; explicit pins/subscriptions remain active.
- **New watcher fails to warm:** unchanged batches remain live. The failed batch
  follows the existing proxy rotation/backoff path.
- **Supabase timeout after commit:** replay the same `drop_cycle_id`; the unique
  index makes it idempotent.
- **Discord 4xx/5xx or network failure:** retain the outbox entry and retry. A
  non-2xx response is a failure, not a successful send.
- **Pi restart:** load `in_stock` and pending outbox entries from the same atomic
  state file, then resume incomplete cloud and Discord delivery.
- **Out-of-stock transition:** clear `in_stock` only after a valid observation;
  a later restock creates a new cycle ID.

## Testing and rollout

Implementation follows test-driven development.

1. **Supabase SQL tests:** verify the new active invariant across every
   pin/auto-watch/subscription combination; rule matching; rule disable; the
   50-product cap; and `drop_cycle_id` uniqueness.
2. **PokeAlert web tests:** verify ingest stores `drop_cycle_id`, replay is
   idempotent, and malformed cycle IDs are rejected.
3. **Pi unit tests:** first force failures proving that ingest errors currently
   consume a transition, Discord 500 responses currently look successful, a
   restart loses failed Discord delivery, and a watchlist addition currently
   restarts unchanged batches. Implement only after each regression test fails
   for the expected reason.
4. **Shadow verification:** load the expected 38-product watchlist, confirm no
   more than four browser contexts at ten products per context, and observe at
   least two complete poll cycles without enabling synthetic drop output.
5. **Delivery canary:** publish one synthetic event using a non-buyable test
   product/event type and verify one Discord message. Replay its ingest payload
   with the same cycle ID and verify Supabase still contains exactly one row.
6. **Production rollout:** back up the Pi source and state, deploy, restart only
   `api-monitor.service`, and verify service health, watchlist count, outbox
   depth, Supabase delivery, Discord delivery, and Electron catch-up.

Rollback disables the two automatic rules first, then restores the prior Pi
source. Schema additions remain backward-compatible and do not need destructive
rollback.

## Security note

The existing PokeAlert routes and Pi service contain a legacy ingest-token
fallback in source/configuration. Token rotation and removal of hard-coded
fallbacks should be handled as a separate credential-maintenance change so it
does not obscure the notification incident fix.
