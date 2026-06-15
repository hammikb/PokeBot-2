# Sub-project B2 — PokeBot Supabase monitor mode + catalog publish

**Date:** 2026-06-15
**Status:** Approved (brainstorm)
**Repo:** PokeBot 2 (Electron client)
**Supabase project:** PokeAlert (`jbnnouwhesexfllninwb`, org `jmhfmfrhaoimrhqbbwsn`, us-west-2, Postgres 17)
**Builds on:** ServerSide Alert Bot — Sub-project A (monitoring core) + B1 (Supabase backbone + serverside publish). This is **B2**, named as out-of-scope in the B1 spec.

## Goal

Add a **monitoring mode toggle** to PokeBot:

- **Local (ON, default, today's behavior):** PokeBot polls retailers itself via `MonitorEngine` + per-retailer pollers.
- **Supabase (OFF):** PokeBot stops polling. It signs into Supabase, subscribes to the products it cares about, and receives in-stock drops over Realtime that the central ServerSide bot produces. One central check serves all clients (Guppy fan-out).

Checkout **always runs locally** (BrowserPool + local accounts) in both modes. The toggle only changes *where the "in stock" signal comes from*.

Plus a second capability: **publish catalog items to Supabase `products`** so the central monitor knows what to watch.

## The full loop (context)

```
1. PokeBot Catalog  ──publish──▶  Supabase `products`        (this spec: Feature B)
2. ServerSide bot (docker)  reads active products, monitors, inserts `drops`  (repo A, external)
3. Supabase trigger `drops_broadcast` ──▶ realtime.send to private topic drops:product:{id}, event 'drop'
4. PokeBot (Supabase mode)  receives broadcast ──▶ max_price gate ──▶ local checkout   (this spec: Feature A)
```

## Authoritative contract (from repo A migrations — already applied to PokeAlert)

Verified by reading `ServerSide Alert Bot/supabase/migrations/` and the B1 design doc.

### Tables (RLS enabled on all)
- **`products`**: `id uuid pk`, `retailer text`, `product_url text`, `product_key text` (TCIN / Walmart itemId), `name text`, `active bool default true`, `created_at`. **`unique (retailer, product_key)`** — shared monitored product across users.
- **`subscriptions`**: `id uuid pk`, `user_id uuid → auth.users`, `product_id uuid → products`, `max_price numeric null`, `created_at`. **`unique (user_id, product_id)`**.
- **`drops`**: `id uuid pk`, `product_id uuid → products`, `retailer text`, `name text`, `price numeric null`, `drop_type text`, `created_at`. Insert-only; broadcast source.

### RLS / authorization
- `products`: `select` true for authenticated; `insert` for authenticated `with check (retailer in ('target','walmart'))`. No client update/delete.
- `subscriptions`: full CRUD where `user_id = auth.uid()`.
- `drops`: `select` for authenticated **only for subscribed products**. Inserts are service-role (server only).
- `realtime.messages`: `select` (receive) for authenticated **only on `drops:product:{id}` where the user holds a matching subscription** (policy `subscribed users receive drops`, scoped to `extension = 'broadcast'`).

### Realtime fan-out — **Broadcast, not postgres_changes**
Trigger `drops_broadcast` after insert on `drops` runs:
```sql
realtime.send(to_jsonb(new), 'drop', 'drops:product:'||new.product_id, true /* private */)
```
So the client joins a **private** channel **per product**: topic `drops:product:{product_id}`, event `drop`, payload = the full `drops` row.

### Behavior change that B2 MUST honor
The serverside worker **drops the per-product `maxPrice` gate** and publishes **every** in-stock transition (price included). Per the B1 spec: *"per-user max_price filtering happens client-side in B2."* → **B2 applies each task's `max_price` before triggering checkout.**

## Prerequisites already completed (2026-06-14, via MCP)

- Bot Supabase Auth user created + verified: `kaib1121@gmail.com` / `1234` (email-confirmed, password hash verified). **Weak password — rotate before real use.**
- A `subscriptions` row linking the bot user to the seed product (`51c9450b-…`, target `94336414`) — proves the read/authorize path end to end (verified: an authenticated read of `drops` under RLS returned the row).
- **Cleanup owed:** an earlier `alter publication supabase_realtime add table public.drops` (postgres_changes) was added on a wrong assumption. The real path is Broadcast; this is harmless but unused. **Revert during implementation** (`alter publication supabase_realtime drop table public.drops;`) to keep PokeAlert matching repo A's migrations.

## Architecture in PokeBot

Mirrors the existing local path so checkout/notify code is untouched. Both signal sources emit the **same** `drop` event consumed by `TaskManager._onDrop`.

```
Local mode:    MonitorEngine + retailer pollers ─┐
                                                  ├─ emit 'drop' ─▶ TaskManager._onDrop ─▶ local checkout
Supabase mode: SupabaseMonitorSource (realtime) ─┘
```

### New files
- **`src/main/supabase/SupabaseClient.js`** — lazy singleton wrapping `@supabase/supabase-js` (new dependency). Responsibilities: `createClient(url, publishableKey)`, `signIn(email, password)`, hold/refresh session, `realtime.setAuth()` so **private** channels authorize, expose `.client`. One instance shared across the app.
- **`src/main/monitor/SupabaseMonitorSource.js`** — `EventEmitter`, emits `drop`. API parallels `MonitorEngine`:
  - `start()` — ensure signed in + realtime auth set.
  - `addProduct({ productUrl, retailer, productKey, maxPrice })` — resolve `(retailer, product_key)` → `products.id` (select); upsert a `subscriptions` row; cache `product_id → { productUrl, maxPrice }`; open `channel('drops:product:'+id, { config: { private: true } }).on('broadcast', { event: 'drop' }, handler).subscribe()`.
  - handler — payload → `dropEvent { retailer, productName: name, productUrl (from cache), price, dropType: drop_type }`; **gate: if cached maxPrice != null and price > maxPrice → skip**; else `emit('drop', dropEvent)`.
  - `removeProduct(productUrl)` — unsubscribe that channel (and optionally delete the subscription) when no task needs it.
  - `stop()` — remove all channels; keep/clear session.
  - Resolution misses (product not in Supabase yet) → emit a feed notice ("not tracked centrally — publish it from Catalog first"), no crash.

### Changed files
- **`src/main/tasks/TaskManager.js`**
  - Constructor takes `getSettings` (wired in `src/main/index.js`).
  - Lazy `_getSupabaseSource()` builds `SupabaseMonitorSource` from settings (url, key, email, decrypted password) and wires its `drop` → existing `_onDrop`.
  - `startTask(taskRow)` reads `monitorMode` (`getSettings().monitorMode || 'local'`):
    - `local` → existing poller path (unchanged).
    - `supabase` → derive `product_key` for the task (tasks store only `product_url`): look it up from the local `product_catalog` row whose `product_url` matches the task, using `retailer_item_id`; fall back to parsing the id from the URL with the same extractor the catalog uses (`A-<TCIN>` for Target, trailing itemId for Walmart). Then `supabaseSource.addProduct({ productUrl, retailer, productKey, maxPrice: task.max_price })`; still record the task in `_tasks` so `_onDrop` finds it by `product_url`; emit status `monitoring`.
  - `stopTask(id)` → if supabase mode, `supabaseSource.removeProduct(url)`; remove from `_tasks`.
  - `setMonitorMode(mode)` → record active task ids, `stopAll()`, restart those ids under the new source (**restart-live**, per approval).
- **`src/main/ipc.js`** — new handlers:
  - `MONITOR_SET_MODE` → `taskManager.setMonitorMode(mode)`.
  - `CATALOG_PUSH_SUPABASE` (`'catalog:push-supabase'`) → Feature B (below).
- **`src/shared/constants.js`** — add `MONITOR_SET_MODE`, `CATALOG_PUSH_SUPABASE` channels.
- **`src/renderer/src/pages/Settings.jsx`** — Local↔Supabase toggle bound to `monitorMode` (calls `MONITOR_SET_MODE` on change); conditional Supabase fields (URL, publishable key, bot email, bot password) shown when mode = supabase. Defaults prefilled with the PokeAlert URL + publishable key.
- **`src/renderer/src/store/appStore`** — actions: `setMonitorMode`, `pushCatalogToSupabase(id)`.
- **`src/renderer/src/pages/Catalog.jsx`** — per-item **"publish to PokeAlert"** button + status (added / already tracked / error).
- **preload** — expose the two new IPC calls.

## Feature B — publish Catalog item → Supabase `products`

`CATALOG_PUSH_SUPABASE(id)`:
1. Read local catalog row (`product_catalog`): has `retailer`, `retailer_item_id`, `product_url`, `title`.
2. Sign in (shared `SupabaseClient`).
3. Upsert `products` `{ retailer, product_url, product_key: retailer_item_id, name: title, active: true }` with `onConflict: 'retailer,product_key', ignoreDuplicates: false` → returns the row (existing or new).
4. Return `{ status: 'added' | 'exists', productId }`.

RLS permits it for `target`/`walmart` (PokeBot's only retailers). This is what populates the scheduler's active product list in repo A.

## Feature C — running the docker producer (external repo, ops only)

`C:\Users\kaib1\OneDrive\Desktop\Projects\ServerSide Alert Bot` — **no PokeBot code change**. Runbook:

```bash
# in ServerSide Alert Bot/ — .env must have:
#   SUPABASE_URL=https://jbnnouwhesexfllninwb.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY=<Supabase dashboard → Project Settings → API → service_role; SERVER ONLY>
#   PROXIES=host:port:user:pass,...   (residential — required, or the cheap path is blocked)
docker compose up -d --build redis warmer worker
docker compose run --rm scheduler          # seed BullMQ queue from Supabase products
docker compose logs worker | grep "Worker up"   # expect "sinks":{"supabase":true,...}
```
The `sinks.supabase:true` line confirms the worker is publishing to Supabase (both `SUPABASE_URL` + service-role key set). Service-role key is server-only — never in PokeBot.

## Config / secrets (PokeBot settings table, key/value JSON)
- `monitorMode`: `'local'` (default) | `'supabase'`.
- `supabaseUrl`: default `https://jbnnouwhesexfllninwb.supabase.co`.
- `supabaseKey`: publishable key `sb_publishable_ISHuDgo14iTtTsRdJFnkYQ__6e9nYlx` (client-safe).
- `supabaseEmail`: bot login email.
- `supabasePassword`: **encrypted at rest** via existing `src/main/crypto.js` + in-memory vault key (matches how account passwords are handled); never stored plaintext.

## Error handling
- Not signed in / auth failure → feed error, mode stays idle, never crash monitoring.
- Product not in Supabase → feed notice to publish from Catalog; task stays idle.
- Realtime disconnect → supabase-js auto-reconnect; re-assert `realtime.setAuth()` on token refresh.
- `max_price` gate applied per task before checkout (serverside no longer filters).
- Toggle restart-live must not double-arm: `setMonitorMode` fully stops the old source before starting the new.

## Testing
- **Unit (fakes, no network):**
  - payload → `dropEvent` mapping, incl. `max_price` gate (skip when `price > max_price`).
  - `addProduct` resolves `(retailer, product_key)` → id, upserts subscription, opens the right topic.
  - Feature B maps catalog row → `products` upsert payload.
  - `startTask` selects the correct source per `monitorMode`; `setMonitorMode` stops old + starts new.
- **Live (MCP):** with the existing bot user + seed subscription, insert a test `drops` row for the seed product and confirm the realtime authorization policy + delivery (full socket delivery exercised by the running app).

## Out of scope
- Repo A (producer) code changes.
- Admin / product-deactivation UI; multi-retailer beyond target/walmart.
- Per-subscription `max_price` stored in Supabase (PokeBot filters locally via task `max_price`).
- Rotating the bot password (manual; recommended before real use).

## Rollout order
1. Add `@supabase/supabase-js`; build `SupabaseClient` + `SupabaseMonitorSource` with unit tests.
2. Wire `TaskManager` mode switch + `getSettings`; restart-live.
3. Settings toggle + fields + IPC.
4. Feature B: catalog publish (IPC + button).
5. Revert the redundant `supabase_realtime` publication add; live MCP verification.
6. Manual end-to-end with the docker producer running.
