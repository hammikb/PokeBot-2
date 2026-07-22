# Ref-counted central monitoring (sub-project C)

**Date:** 2026-07-14
**Status:** Approved (brainstorm)
**Repo:** PokeBot 2 (Electron client) + Supabase project PokeAlert (`jbnnouwhesexfllninwb`)
**Builds on:** Sub-project A (per-user Supabase Auth), merged to master. This is the "task ↔
central monitoring" sub-project scoped conversationally back when auth was first designed,
named there as **sub-project C**.

## Context

PokeAlert's Supabase project currently has **two unrelated schemas**, both with tables present:

- **Schema A** — `products` / `subscriptions` / `drops` / `worker_health` / `monitor_logs` /
  `monitor_snapshots` / `drop_log` / `proxy_health`. This is what `SupabaseMonitorSource.js`
  (Electron) and the real Raspberry Pi worker (`ApiMonitor.py`, host `pokebot-worker`) use today.
  Confirmed live: `worker_health` shows `pokebot-worker` and `pokebot2` heartbeating within the
  last minute.
- **Schema B** — `tasks` / `devices` / `commands` / `runs` / `canonical_products` /
  `retailer_listings` / `monitor_workers` / `listing_leases` / `task_subscriptions` — a more
  elaborate multi-device orchestration system (device-assigned tasks, a remote command queue,
  distributed leases with fencing tokens). Confirmed **not** current: last activity was 17 days
  ago, all within one ~7-hour burst from a single worker whose hostname was a Docker container
  ID, and its `tasks` table has never had a row. Likely a stale prototype (possibly related to
  the `feat/pokebot-control-plane` worktree present on this machine) — out of scope, not touched
  by this work.

This spec builds exclusively on **Schema A**.

Today, Schema A only half-implements ref-counted monitoring:

- `SupabaseMonitorSource.addProduct()` (added in the auth-merge session) already self-registers a
  missing product into `products` and upserts a `subscriptions` row for the calling user — but
  this currently **cannot work**, because `products` has no RLS policy granting `authenticated`
  users `INSERT` (verified via `pg_policies`; the only policy on `products` is a `SELECT` for
  `anon,authenticated`).
- `SupabaseMonitorSource.removeProduct()` only tears down the local Supabase Realtime channel — it
  never deletes the caller's `subscriptions` row. So today, a user's subscription is never
  actually removed once created, regardless of the RLS gap above.
- Nothing computes or enforces "how many users are still subscribed" — there is no ref-count at
  all yet.

## Goal

- Creating/starting a Supabase-mode task in the Electron app registers the product centrally (if
  not already known) and marks the current user as watching it.
- Stopping/deleting that task removes only _this_ user's subscription.
- A product stays centrally monitored (`products.active = true`) while **any** user is subscribed
  to it, and is deactivated the moment the **last** subscriber leaves — regardless of which
  client's action was the one that dropped the count to zero.
- The Raspberry Pi worker requires **no code changes** — it already re-pulls its watchlist
  (`WHERE active = true`) on an interval and will pick up/drop products as `active` flips.
- The Vercel admin dashboard's ability to add anything to monitoring is assumed to already work
  via a service-role-backed API route (bypassing RLS) and is out of scope for this spec — flagged
  as an assumption to verify, not something this spec changes.

**Why the ref-count must live in the database, not the client:** RLS on `subscriptions` scopes
`SELECT`/`ALL` to `user_id = auth.uid()` — a client can only ever see its _own_ subscription rows.
It has no way to know whether it is the last subscriber for a product; only a database-side
trigger (running with the privilege to see every row) can compute the true global count.

## Architecture

Three pieces, in dependency order:

1. **Migration — `products` INSERT policy.** Grant `authenticated` `INSERT` on `products`,
   `WITH CHECK (retailer IN ('target','walmart'))`. This is the one-line fix that makes the
   already-written client-side self-registration in `SupabaseMonitorSource.addProduct()` actually
   work. No `UPDATE` policy is added for `products` — only the trigger (below) is ever allowed to
   flip `active`, keeping the client's write surface minimal.

2. **Migration — ref-counting trigger on `subscriptions`.** A trigger function fires
   `AFTER INSERT OR DELETE ON subscriptions FOR EACH ROW`, and for the affected `product_id`
   (`NEW.product_id` on insert, `OLD.product_id` on delete) runs a single atomic statement:

   ```sql
   UPDATE products
   SET active = EXISTS (SELECT 1 FROM subscriptions WHERE product_id = affected_id)
   WHERE id = affected_id;
   ```

   One statement (not a separate read-then-write) so there's no race between two clients
   subscribing/unsubscribing concurrently — Postgres's row lock on the `products` row during the
   `UPDATE` serializes concurrent trigger firings for the same product. The trigger function runs
   as its owner (not the invoking `authenticated` role), so it can update `products.active`
   without needing a client-facing `UPDATE` policy.

3. **Electron fix — `SupabaseMonitorSource.removeProduct(productUrl)`.** Currently only calls
   `this._client.removeChannel(entry.channel)` and clears local maps. Add a
   `.from('subscriptions').delete().eq('product_id', entry.productId)` call before that — RLS's
   own `user_id = auth.uid()` scoping on `subscriptions` means this can only ever delete the
   caller's own row, so no explicit `user_id` filter is needed. This is the change that actually
   makes ref-counts go down; without it, nothing else in this spec has any effect, since no
   subscription is ever removed once created.

No other file changes. `TaskManager.stopTask()` / task deletion in Supabase mode already calls
`SupabaseMonitorSource.removeProduct()` — confirmed by reading `TaskManager.js`'s `stopTask`
method, which unconditionally calls `this._supabaseSource?.removeProduct(entry.product_url)` for
`source === 'supabase'` tasks. No caller-side change needed.

## Data flow

**Subscribe:** start a Supabase-mode task → `TaskManager._startSupabaseTask` →
`SupabaseMonitorSource.addProduct()` → look up `products` by `(retailer, product_key)` → if
missing, insert it (now permitted by the new RLS policy) → upsert this user's `subscriptions` row
→ trigger fires on the insert, recomputes and sets `active = true` (a no-op if it was already
true, but correctly re-activates a product whose last previous subscriber had left) → Pi's next
poll cycle sees the product in its `active` watchlist.

**Unsubscribe:** stop/delete that task → `TaskManager.stopTask` →
`SupabaseMonitorSource.removeProduct()` → delete this user's `subscriptions` row (new) → tear down
the local realtime channel (existing) → trigger fires on the delete, recomputes the count for that
product, sets `active = false` only if zero rows remain → Pi's next poll cycle drops it.

## Error handling

- Deleting a `subscriptions` row that doesn't exist (e.g., a task that never successfully
  subscribed) is a normal no-op delete — zero rows affected, no error.
- If `addProduct`'s insert into `products` fails for any reason (e.g., a retailer outside
  `target`/`walmart` somehow reaches this code path), the existing `registerResult.error` handling
  already added in the prior session emits a `notice` and returns `{ subscribed: false }` rather
  than throwing — unchanged by this spec.
- Concurrent subscribe/unsubscribe races are handled by the single-statement `EXISTS` recompute
  inside the trigger (see Architecture #2) — no read-modify-write gap for two triggers to race
  through.

## Testing

- One focused test added to `tests/main/monitor/SupabaseMonitorSource.test.js`:
  `removeProduct` deletes the caller's `subscriptions` row (scoped by `product_id`) in addition to
  tearing down the channel — extends the existing fake-client pattern already in that file.
- The RLS policy and trigger are database-side SQL, outside the JS test suite. Verified manually
  after migration: insert a `subscriptions` row as a real authenticated test user and confirm
  `products.active` flips to `true`; delete it and confirm `active` flips back to `false`.
  (`test@gmail.com` / `123456`, created in the prior session, is available for this manual check.)

## Explicitly out of scope

- Schema B (`tasks`/`devices`/`retailer_listings`) — confirmed stale, not touched.
- Any change to the Pi worker (`ApiMonitor.py`) — its existing polling interval already covers
  picking up/dropping `active` products.
- Any change to the Vercel dashboard's admin-add flow — assumed already correct via a
  service-role route; flagged as an assumption, not verified in this spec.
- A UI affordance in the Electron app showing "N other users are also watching this" — not
  requested; the ref count is purely a backend mechanism for this spec.
