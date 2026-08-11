# Target monitoring and durable delivery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-watch a bounded Target Pokemon hot set and deliver every detected stock transition durably and observably to Supabase and Discord.

**Architecture:** Supabase owns the bounded watchlist invariant and private inventory fan-out. PokeAlert validates one immutable source event ID per Pi transition. The Pi persists transition and destination state before network I/O, reconciles watcher batches incrementally, and supports dated release-night schedules.

**Tech Stack:** PostgreSQL 17/Supabase Realtime, Next.js Route Handlers, Python 3 `asyncio`/`httpx`, Node test runner, Python `unittest`.

## Global Constraints

- Keep automatic Target coverage capped at exactly 50 catalog products; explicit pins and subscriptions never count against that cap.
- Seed only the literal case-insensitive rules `Prismatic Evolutions` and `Ascended Heroes`.
- Keep the default Target fast window unchanged; only explicit release-date overrides may run 15-second polling through 06:00 America/Los_Angeles.
- Do not add Discord role/user mentions.
- Preserve five-minute `drop_cycle_id` grouping; idempotent Pi delivery uses a separate UUID `source_event_id`.
- A Target 403, 429, timeout, malformed response, or navigation error must never be interpreted as out of stock.
- Never log or commit ingest tokens, webhook URLs, Supabase secret/service keys, proxy credentials, or account data.
- Supabase CLI `2.113.0` was attempted twice but failed with `LegacyMigrationNewWriteError` on the existing OneDrive migrations directory; use the exact timestamped `apply_patch` scaffold recorded below and apply reviewed DDL through the Supabase migration tool.

---

### Task 1: Supabase hot-set, delivery identity, inventory fan-out, and health schema

**Files:**
- Create: `supabase/migrations/20260811165458_target_hotset_delivery.sql`
- Mirror after verification: `C:/Users/kaib1/OneDrive/Desktop/Projects/Test HTPPCLOACK/pokealert-web/supabase/migrations/20260811165458_target_hotset_delivery.sql`

**Interfaces:**
- Consumes: existing `products`, `subscriptions`, `target_catalog`, `drops`, `target_inventory_observations`, `worker_health`, and `realtime.messages` policies.
- Produces: `products.auto_watch boolean`, `target_auto_watch_rules`, `refresh_target_auto_watch_products()`, `drops.source_event_id uuid`, private `inventory` Broadcast events, and worker delivery/schedule columns.

- [x] **Step 1: Create the migration scaffold**

The required pinned CLI command was run twice:

```powershell
npx --yes supabase@2.113.0 migration new target_hotset_delivery
npx --yes supabase@2.113.0 --workdir . migration new target_hotset_delivery --debug
```

Both attempts failed because the CLI tried to recreate the existing migrations directory. The exact fallback scaffold `supabase/migrations/20260811165458_target_hotset_delivery.sql` was created with `apply_patch`; no DDL has been written or applied yet.

- [ ] **Step 2: Write transaction-safe SQL assertions before DDL**

Use a scratch query through `supabase_execute_sql` to prove the current schema is missing the new columns:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name in ('products', 'drops')
  and column_name in ('auto_watch', 'source_event_id');
```

Expected before implementation: zero rows.

- [ ] **Step 3: Implement the migration**

The migration starts with:

```sql
alter table public.products
  add column if not exists auto_watch boolean not null default false;

alter table public.drops
  add column if not exists source_event_id uuid;

create unique index if not exists drops_source_event_id_unique
  on public.drops (source_event_id)
  where source_event_id is not null;

alter table public.worker_health
  add column if not exists watchlist_product_count integer,
  add column if not exists watchlist_last_success_at timestamptz,
  add column if not exists alert_outbox_pending integer,
  add column if not exists last_drop_delivery_at timestamptz,
  add column if not exists last_discord_delivery_at timestamptz,
  add column if not exists last_discord_status text,
  add column if not exists last_discord_message_id text,
  add column if not exists active_schedule_profile text,
  add column if not exists schedule_next_transition_at timestamptz;
```

Add service-role-owned `target_auto_watch_rules(id, name, match_term, priority, enabled, created_at, updated_at)`, enable RLS, revoke `anon`/`authenticated`, and seed the two required rules with `on conflict (name) do update`.

Implement `refresh_target_auto_watch_products()` as `security definer set search_path = ''`; select `target_catalog.is_marketplace = false`, literal `position(lower(match_term) in lower(name)) > 0`, deterministic `priority desc, last_seen_at desc, product_key`, and `limit 50`. Build canonical Target URLs with `'https://www.target.com/p/-/A-' || product_key`, set selected rows `auto_watch=true`, clear stale automatic rows, and recompute `active = pinned or auto_watch or exists(subscription)`.

Replace `sync_product_active_from_subscriptions()` so its update uses that same three-way invariant. Revoke public execution from the security-definer refresh function after calling it once in the migration.

Add an `after insert` trigger on `target_inventory_observations`. Its `security definer set search_path=''` function resolves `products(retailer='target', product_key=new.tcin)` and calls:

```sql
perform realtime.send(
  to_jsonb(new) || jsonb_build_object('product_id', target_product_id),
  'inventory',
  'drops:product:' || target_product_id,
  true
);
```

Replace the broad `authenticated reads target inventory` policy with a `select to authenticated` policy requiring a matching `subscriptions.user_id = (select auth.uid())` through the Target product key. Keep RLS enabled and grant only `select` to `authenticated`.

- [ ] **Step 4: Verify SQL on an isolated branch or with rollback-capable fixtures**

Verify:

```sql
select count(*) from public.products where auto_watch;
select count(*) from public.products where retailer = 'target' and active;
select name, match_term, priority, enabled
from public.target_auto_watch_rules
order by priority desc;
```

Insert two actionable `drops` rows for one product with different `source_event_id` values inside a transaction and assert their `drop_cycle_id` values match. Attempt a third row reusing the first `source_event_id` and expect SQLSTATE `23505`. Roll back all test rows.

- [ ] **Step 5: Run advisors and commit**

Run Supabase security and performance advisors, fix any new finding caused by this migration, mirror the final migration into the web app, then commit:

```powershell
git add supabase/migrations docs/superpowers/specs/2026-08-11-target-hot-set-durable-notifications-design.md
git commit -m "feat: add bounded Target hot set delivery schema"
```

### Task 2: PokeAlert source-event validation and idempotent ingest

**Files:**
- Modify: `C:/Users/kaib1/OneDrive/Desktop/Projects/Test HTPPCLOACK/pokealert-web/lib/ingest-payload.js`
- Modify: `C:/Users/kaib1/OneDrive/Desktop/Projects/Test HTPPCLOACK/pokealert-web/app/api/ingest/route.js`
- Modify: `C:/Users/kaib1/OneDrive/Desktop/Projects/Test HTPPCLOACK/pokealert-web/app/WorkerHealth.jsx`
- Modify: `C:/Users/kaib1/OneDrive/Desktop/Projects/Test HTPPCLOACK/pokealert-web/test/dashboard.test.js`

**Interfaces:**
- Consumes: Pi drop payload `{ source_event_id, retailer, product_key, product_url, name, drop_type, ... }`.
- Produces: `normalizeDropPayload(payload)` returning normalized rows or throwing `Invalid source_event_id`; duplicate source-event inserts return HTTP 200 `{ ok: true, duplicate: true }`.

- [ ] **Step 1: Write failing normalization tests**

Add:

```js
test('drop ingest preserves a valid source event UUID', () => {
  const [row] = normalizeDropPayload({
    source_event_id: '11111111-1111-4111-8111-111111111111',
    product_key: '95163306'
  })
  assert.equal(row.source_event_id, '11111111-1111-4111-8111-111111111111')
})

test('drop ingest rejects a malformed source event ID', () => {
  assert.throws(
    () => normalizeDropPayload({ source_event_id: 'same-drop', product_key: '95163306' }),
    /Invalid source_event_id/
  )
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from the web app:

```powershell
node --test test/dashboard.test.js
```

Expected: FAIL because `normalizeDropPayload` is not exported.

- [ ] **Step 3: Implement normalization and route handling**

Add `normalizeDropPayload` with RFC 4122 UUID validation, numeric quantity validation, a maximum batch of 100, canonical defaults, and no generated fallback ID. In the route, insert `source_event_id` into `drops`. Treat `error.code === '23505'` as success only when the normalized row supplied a source event ID; propagate every other uniqueness failure.

Extend `WorkerHealth.jsx` to display watchlist count/last success, outbox depth, last cloud and Discord delivery, Discord status/message ID, and active schedule/next transition when present. Render `—` for null legacy rows and never render raw error bodies or destination URLs.

- [ ] **Step 4: Verify GREEN and build**

```powershell
npm test
npm run build
```

Expected: all Node tests pass and Next.js build exits 0.

- [ ] **Step 5: Back up the unversioned web app changes**

Create a timestamped recoverable backup directory next to the four changed files before deployment. Record file hashes before and after in the rollout log; never copy `.env*` files.

### Task 3: Versioned Pi reliability module and regression tests

**Files:**
- Create: `scripts/pi/target_reliability.py`
- Create: `tests/pi/test_target_reliability.py`

**Interfaces:**
- Produces: `AtomicAlertState`, `PendingAlert`, `parse_schedule_config(raw, now, zone)`, `schedule_decision(config, now, zone)`, and `batch_signatures(products, size)`.
- Persists: JSON version 2 with `in_stock`, `outbox`, and destination attempt/result metadata using atomic replace under one lock.

- [ ] **Step 1: Read test rules and write failing state tests**

Read `C:/Users/kaib1/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/test-driven-development/writing-good-tests.md`, then add:

```python
def test_transition_is_persisted_before_delivery_and_reused_after_restart(self):
    first = AtomicAlertState(self.path)
    event = first.ensure_transition('95163306', {'name': 'Prismatic'})
    second = AtomicAlertState(self.path)
    self.assertEqual(second.pending()[0].source_event_id, event.source_event_id)

def test_confirmed_cloud_delivery_moves_tcin_to_in_stock(self):
    state = AtomicAlertState(self.path)
    event = state.ensure_transition('95163306', {})
    state.mark_destination(event.source_event_id, 'cloud', status=200)
    self.assertIn('95163306', state.in_stock)
```

Also test legacy `{"in_stock": [...]}` loading, Discord retry metadata, removal only after every configured destination confirms, and corrupt-file fail-safe behavior.

- [ ] **Step 2: Run and verify RED**

```powershell
python -m unittest tests.pi.test_target_reliability -v
```

Expected: import failure for the missing module.

- [ ] **Step 3: Implement the minimal durable state module**

Use `threading.RLock`, `uuid.uuid4`, `tempfile` in the state file's directory, `flush()` plus `os.fsync()`, then `os.replace()`. Never remove a pending entry until all configured destinations have `confirmed_at`. Cap serialized error text at 500 characters and do not store webhook URLs or tokens.

- [ ] **Step 4: Add schedule and batch tests, then implementation**

Test an ordinary date, a listed release date, an expired override, an invalid interval under 15 seconds, and a midnight-spanning window. The normalized contract is:

```json
{
  "default_interval": 300,
  "windows": [{"start":"22:00","end":"04:00","interval":15}],
  "release_overrides": [{"date":"2026-08-14","start":"22:00","end":"06:00","interval":15}]
}
```

Test that adding an item changes only its containing ordered batch signature and that unchanged signatures remain equal.

- [ ] **Step 5: Run tests and commit**

```powershell
python -m unittest tests.pi.test_target_reliability -v
git add scripts/pi/target_reliability.py tests/pi/test_target_reliability.py
git commit -m "feat: add durable Target alert state"
```

### Task 4: Patch the production Pi monitor for durable fan-out and incremental watchers

**Files:**
- Create: `scripts/maintenance/patch_target_monitor_reliability.py`
- Create: `tests/pi/test_patch_target_monitor_reliability.py`
- Deploy: `/home/hammikb/api-monitor-python/target_reliability.py`
- Patch after backup: `/home/hammikb/api-monitor-python/ApiMonitor.py`

**Interfaces:**
- Consumes: `AtomicAlertState` and normalized schedule/batch helpers from Task 3.
- Produces: retrying cloud/Discord dispatchers, 15-second watchlist refresh, worker delivery metrics, and signature-keyed watcher reconciliation.

- [ ] **Step 1: Write a failing idempotent-patcher test**

Use a sanitized fixture containing the current `_post_ingest`, `_apply`, `watchlist_refresh_forever`, and `sync_watchers` blocks. Assert one patch adds imports/hooks and applying it twice yields byte-identical output.

- [ ] **Step 2: Run and verify RED**

```powershell
python -m unittest tests.pi.test_patch_target_monitor_reliability -v
```

Expected: FAIL because the patcher does not exist.

- [ ] **Step 3: Implement the patcher and monitor contract**

The patch makes `_post_ingest` raise after its third failure; includes `source_event_id` in `_publish_drop`; persists/reuses an outbox event before cloud I/O; adds `in_stock` only after cloud 2xx; clears it only on a valid non-buyable observation; and runs one background dispatcher for pending Discord work.

Discord execution appends `wait=true` without discarding existing query parameters, calls `raise_for_status()`, requires returned JSON `id`, records status/message ID, and retries with full-jitter exponential delays capped at five minutes. Missing webhook configuration marks Discord disabled and emits health evidence without accumulating that destination.

Replace watcher-list mutation with signature-keyed tasks: start new/changed batches first, await task creation, then cancel and await only obsolete tasks. Set the default authenticated watchlist refresh to 15 seconds; do not alter Target request cadence.

Extend worker health with the exact nullable columns from Task 1 and schedule decisions from Task 3.

- [ ] **Step 4: Verify local patch and remote tests before service mutation**

Run the patcher against a temporary fixture twice, run both Python test files, then upload only the module and patcher to a temporary Pi directory. Patch a temporary copy of `ApiMonitor.py` and run:

```bash
python -m py_compile /tmp/pokealert-canary/ApiMonitor.py /tmp/pokealert-canary/target_reliability.py
python -m unittest -v /home/hammikb/api-monitor-python/test_api_monitor.py
```

Expected: compile exit 0 and all existing Pi tests pass.

- [ ] **Step 5: Commit without deploying live yet**

```powershell
git add scripts/maintenance/patch_target_monitor_reliability.py tests/pi/test_patch_target_monitor_reliability.py
git commit -m "feat: make Target monitor delivery durable"
```

### Task 5: Extend the Pi control agent with validated dated overrides

**Files:**
- Create: `scripts/maintenance/patch_pokealert_agent_schedule.py`
- Create: `tests/pi/test_patch_pokealert_agent_schedule.py`
- Patch after backup: `/opt/pokealert-agent/pi_agent.py`

**Interfaces:**
- Consumes: `target_schedule` command payload with optional `release_overrides`.
- Produces: atomically stored validated schedule JSON; ordinary schedule remains unchanged outside listed dates.

- [ ] **Step 1: Write failing patch tests**

Assert that patched `set_target_schedule` accepts the normalized example from Task 3, rejects duplicate dates, intervals below 15 or above the existing maximum, invalid dates, more than 32 overrides, and leaves the existing file unchanged on validation failure.

- [ ] **Step 2: Run and verify RED**

```powershell
python -m unittest tests.pi.test_patch_pokealert_agent_schedule -v
```

- [ ] **Step 3: Implement minimal validation and atomic output**

Preserve the current `default_interval` and `windows` contract. Normalize dates as ISO `YYYY-MM-DD`, clocks as `HH:MM`, sort overrides by date, drop already-expired entries when writing, and report the active override count in the command result.

- [ ] **Step 4: Patch a temporary remote copy and compile**

```bash
python /tmp/pokealert-canary/patch_pokealert_agent_schedule.py /opt/pokealert-agent/pi_agent.py /tmp/pokealert-canary/pi_agent.py
python -m py_compile /tmp/pokealert-canary/pi_agent.py
```

- [ ] **Step 5: Commit**

```powershell
git add scripts/maintenance/patch_pokealert_agent_schedule.py tests/pi/test_patch_pokealert_agent_schedule.py
git commit -m "feat: add dated Target release schedules"
```

## Plan verification

- Every database mutation has a rollback-capable assertion and advisor check.
- Every Pi production change is generated by an idempotent, tested patcher and applied first to a temporary copy.
- No task adds Discord mentions or changes browser checkout behavior.
- `source_event_id` uniqueness and `drop_cycle_id` grouping are tested independently.
- Default Target traffic is unchanged except for the authenticated 15-second watchlist refresh, which does not contact Target.
