# Target hot-set coverage and durable notifications

**Date:** 2026-08-11

**Status:** Amended after drop analytics review; awaiting written-spec review

**Systems:** PokeBot 2 Electron client, Supabase project (`jbnnouwhesexfllninwb`),
PokeAlert web, and Raspberry Pi worker `pokebot-worker`

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

The subsequent 2026-08-11 release-night review found 15 Target in-stock rows and
15 matching Discord posts between 00:07 and 02:11 PDT. Nine rows were one
flapping product. Twelve drops had no Electron Realtime subscriber; all three
drops with a subscriber reached Electron. Checkout began about 1.3 seconds after
the two measured Supabase rows, but one attempt stopped while the Pi continued
to report stock and another running Electron process still used the superseded
API-first Target flow because it had not been restarted after the browser-only
changes. A 19-second Realtime recovery episode also showed repeated channel
`CLOSED` callbacks while both the source and task manager attempted recovery.

This evidence changes two initial recommendations:

- permanently extending 15-second polling beyond 04:00 would not have helped
  these drops and would add Target traffic while valid requests already receive
  occasional 403 responses; release-night extension must be an explicit dated
  override, not the default; and
- `drop_cycle_id` cannot be unique because it intentionally groups actionable
  reports for the same product within five minutes. Delivery idempotency needs a
  separate event identifier.

## Goal

1. Proactively monitor a bounded set of high-demand Target Pokemon products
   before a user creates an Electron task.
2. Preserve explicit user subscriptions and admin pins as the highest-priority
   monitoring inputs.
3. Deliver every detected in-stock transition idempotently to Supabase and
   durably to Discord, including across transient failures and Pi restarts.
4. Reduce watchlist propagation time without multiplying Target traffic enough
   to worsen the existing HTTP 403 rate.
5. Keep browser-only Target add-to-cart recovery active while the authoritative
   monitor still reports stock, with a bounded safety ceiling and an immediate
   stop after a later valid out-of-stock observation.
6. Make Discord, Electron desktop-notification, and Realtime recovery outcomes
   observable instead of relying on the absence of an error log.

## Non-goals

- Monitoring all 263 Target catalog products. The live worker already saw 403s
  with 21 products, so unbounded expansion is unsafe.
- Building a general rule-management UI. Initial rules are database-managed;
  a dashboard editor can be added separately.
- Replacing the browser-warmed Redsky monitor with an unofficial mobile API.
- Adding Discord role or user mentions. The user explicitly excluded that
  improvement; delivery verification is independent of mention behavior.
- Running the 15-second Target schedule later every night. Only explicitly
  configured release dates receive the longer window.

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
`source_event_id` and one outbox entry containing the normalized drop payload,
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

Add nullable `drops.source_event_id uuid` with a partial unique index for
non-null values. The ingest route attempts an insert and treats PostgreSQL
unique-violation code `23505` for that source event as idempotent success without
updating the existing row. The existing `assign_drop_cycle_id` trigger remains
authoritative for grouping related reports into a checkout cycle. Replaying an
event after an ambiguous timeout or Pi restart therefore cannot create a second
durable row, while legitimate reports may still share a cycle.

The Discord dispatcher must execute the webhook with `wait=true`, call
`raise_for_status()`, parse the returned Discord message ID, use bounded
exponential backoff with jitter, and retain failed entries on disk. Each outbox
destination records attempt count, last HTTP status/error, next retry time,
confirmed-at time, and returned message ID when available.
The first Discord payload is intentionally useful without enrichment: product
name, canonical URL, availability, quantity, and detected time. Price/image
enrichment may update a still-pending entry but never gates delivery.

Discord delivery is at-least-once. Discord webhooks do not provide an
idempotency key, so a connection loss after Discord accepted a message but
before the Pi received the response can produce a duplicate. Retrying in that
ambiguous case is preferable to silently losing the alert. Supabase row delivery
is idempotent by `source_event_id`; Electron checkout deduplication remains
cycle-based by `drop_cycle_id`.

If Discord is not configured, the worker emits a prominent health warning and
does not accumulate an undeliverable Discord queue. Supabase drop delivery
continues independently.

### 4. Inventory-aware Target checkout lifetime

Publish each valid Target inventory change to the existing private
`drops:product:{product_id}` topic as an `inventory` event in addition to storing
it in `target_inventory_observations`. HTTP errors, blocked requests, malformed
responses, and timeouts do not publish inventory state.

`SupabaseMonitorSource` caches the last inventory event for each subscribed
Target product and exposes a read-only snapshot to `TaskManager`. The Target
flow receives a cancellation/lifetime callback with these rules:

- retain the existing 120-second browser add-to-cart deadline when no inventory
  state is available or the Realtime channel is unhealthy;
- while the last valid post-drop state is in stock and the channel plus durable
  catch-up are healthy, allow the browser-only high-demand retry controller to
  continue up to a hard 10-minute ceiling;
- stop retrying before the next click when a valid out-of-stock observation newer
  than the triggering drop arrives; and
- never extend or retry after order submission has started, after cart/success
  evidence, or for a non-retryable account/payment/safety failure.

The Pi already emits inventory only after a valid Target response changes the
state. A 403/429 therefore cannot masquerade as out of stock. A later in-stock
transition remains eligible for the existing receipt-reclaim behavior if the
previous pre-submit checkout already ended.

### 5. Release-night schedule override

Keep the production default fast window unchanged. Extend the existing
dashboard-owned `target-schedule.json` contract with dated overrides. A release
date may use 15-second polling from 22:00 through 06:00 local time; dates without
an override keep the normal window. Reject expired/malformed overrides and show
the active profile plus next transition in worker health.

This delivers the operational capability without permanently increasing proxy
traffic. No automatic release-calendar scraper is introduced in this change.

### 6. Single-owner Realtime recovery

`SupabaseMonitorSource` becomes the only owner of per-channel reconnection.
Every channel has a generation token; status callbacks from intentionally
removed or superseded generations are ignored. Unexpected interruptions use
bounded exponential backoff with jitter and reset the attempt counter only after
`SUBSCRIBED` plus successful durable catch-up.

The task manager heartbeat no longer destroys and recreates the authenticated
source for ordinary channel interruptions. It requests one debounced source
recovery sweep, and only an authentication change or explicit shutdown replaces
the whole source. Existing table catch-up remains the loss-recovery mechanism;
Realtime replay is not substituted because its retained batch is more limited
than the current durable table query.

### 7. Electron desktop-notification evidence

The desktop adapter returns a structured result instead of silently swallowing
unsupported-platform and construction errors. It records `supported`, `shown`,
`failed`, `clicked`, and `closed` events with the drop/event ID and timestamps,
without logging product-account secrets. On Windows, urgent stock alerts use
critical urgency and a non-expiring timeout; checkout-step chatter keeps the
existing lower-priority behavior.

Notification telemetry is non-blocking and cannot delay checkout. The renderer
health view distinguishes "drop received" from "desktop notification shown" so
an operating-system notification problem is not mistaken for a monitoring miss.

### 8. Health and operational evidence

Extend `worker_health` with nullable fields for:

- `watchlist_product_count`
- `watchlist_last_success_at`
- `alert_outbox_pending`
- `last_drop_delivery_at`
- `last_discord_delivery_at`
- `last_discord_status`
- `last_discord_message_id`
- `active_schedule_profile`
- `schedule_next_transition_at`

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
- **Supabase timeout after commit:** replay the same `source_event_id`; its unique
  index makes the row insert idempotent while cycle assignment stays unchanged.
- **Discord 4xx/5xx or network failure:** retain the outbox entry and retry. A
  non-2xx response is a failure, not a successful send.
- **Pi restart:** load `in_stock` and pending outbox entries from the same atomic
  state file, then resume incomplete cloud and Discord delivery.
- **Out-of-stock transition:** clear `in_stock` only after a valid observation;
  a later restock receives a new `source_event_id`, while the existing database
  trigger decides whether it belongs to the current five-minute checkout cycle.
- **Realtime channel intentionally removed:** its stale `CLOSED` callback is
  ignored by generation, so it cannot start a reconnect loop.
- **Inventory feed unavailable during checkout:** fall back to the existing
  120-second deadline; never assume indefinite stock.
- **Release override missing or invalid:** retain the normal schedule and report
  the validation error in health rather than silently widening the fast window.
- **Desktop notifications unsupported or rejected by Windows:** checkout and
  renderer delivery continue; the failure is recorded and surfaced.

## Testing and rollout

Implementation follows test-driven development.

1. **Supabase SQL tests:** verify the new active invariant across every
   pin/auto-watch/subscription combination; rule matching; rule disable; the
   50-product cap; `source_event_id` uniqueness; unchanged multi-row
   `drop_cycle_id` grouping; and private inventory broadcasts.
2. **PokeAlert web tests:** verify ingest stores `source_event_id`, replay is
   idempotent, malformed IDs are rejected, and inventory events map to the
   correct product topic.
3. **Pi unit tests:** first force failures proving that ingest errors currently
   consume a transition, Discord 500 responses currently look successful, a
   restart loses failed Discord delivery, a watchlist addition currently
   restarts unchanged batches, and dated schedule selection is deterministic.
   Implement only after each regression test fails for the expected reason.
4. **Electron unit tests:** prove stale `CLOSED` callbacks currently reschedule
   channels, checkout currently expires despite a valid in-stock state, a fresh
   out-of-stock state cancels before another click, and desktop notification
   failures currently disappear. Verify generation guards, bounded recovery,
   120-second fallback, 10-minute ceiling, and structured notification results.
5. **Shadow verification:** load the expected 38-product watchlist, confirm no
   more than four browser contexts at ten products per context, and observe at
   least two complete poll cycles without enabling synthetic drop output.
6. **Delivery canary:** publish one synthetic event using a non-buyable test
   product/event type and verify one Discord message. Replay its ingest payload
   with the same source event ID and verify Supabase still contains exactly one
   row; record the Discord HTTP status and returned message ID.
7. **Checkout canary:** inject synthetic inventory events into a test task and
   verify in-stock extends retry, out-of-stock cancels before another click,
   channel failure restores the 120-second deadline, and submission safety is
   never bypassed.
8. **Production rollout:** back up the Pi source and state, deploy database/web
   changes, canary the Pi in shadow mode, restart only `api-monitor.service`, and
   verify service health, watchlist count, outbox depth, Supabase delivery,
   Discord delivery, Electron catch-up, and the absence of a reconnect loop.
   Restart PokeBot only after tests pass so the already-completed browser-only
   Target controller is loaded, then verify the process start time and active
   browser-only policy from logs.

Rollback disables the two automatic rules first, then restores the prior Pi
source. Schema additions remain backward-compatible and do not need destructive
rollback.

## Security note

The existing PokeAlert routes and Pi service contain a legacy ingest-token
fallback in source/configuration. Token rotation and removal of hard-coded
fallbacks should be handled as a separate credential-maintenance change so it
does not obscure the notification incident fix.
