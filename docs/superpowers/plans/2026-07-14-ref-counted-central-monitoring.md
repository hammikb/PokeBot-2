# Ref-counted Central Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A product stays centrally monitored (`products.active = true`) for as long as any user
has a task watching it, and stops the moment the last one leaves — with no Pi code changes.

**Architecture:** Two Supabase migrations (an RLS policy that lets a signed-in user register a
product, and a trigger on `subscriptions` that recomputes `products.active` from the true global
subscriber count) plus one Electron fix (`SupabaseMonitorSource.removeProduct` currently never
deletes the caller's `subscriptions` row, so nothing ever ref-counts down today).

**Tech Stack:** Supabase Postgres (migrations via the Supabase MCP `apply_migration` tool),
`@supabase/supabase-js` v2, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-ref-counted-central-monitoring-design.md`

## Global Constraints

- This builds only on the live schema (`products` / `subscriptions` / `drops`) — the `tasks` /
  `devices` / `retailer_listings` schema is a confirmed-stale, unrelated prototype and must not be
  touched.
- `products.active` may only ever be written by the trigger (`SECURITY DEFINER`), never by a
  client-facing RLS policy — do not add an `UPDATE` policy on `products` for `authenticated`.
- The `EXISTS(...)` recompute in the trigger must be a single atomic `UPDATE ... SET active = EXISTS(...)`
  statement, not a separate `SELECT` followed by an `UPDATE` — this is what makes concurrent
  subscribe/unsubscribe races safe.
- No Pi (`ApiMonitor.py`) changes — it already re-pulls its watchlist on an interval.
- Supabase project id for all migration/SQL steps: `jbnnouwhesexfllninwb`.

---

### Task 1: RLS policy — authenticated users can register a product

**Files:** none (Supabase migration only, via MCP tool — no repo files change)

**Interfaces:**
- Consumes: existing `products` table (columns `id uuid`, `retailer text`, `product_url text`,
  `product_key text`, `name text`, `active bool default true`), RLS already enabled on it.
- Produces: an `INSERT` policy that Task 3's client code (already written in a prior session, in
  `SupabaseMonitorSource.addProduct()`) depends on to actually succeed instead of failing RLS.

- [ ] **Step 1: Apply the migration**

Use the Supabase MCP `apply_migration` tool with:
- `project_id`: `jbnnouwhesexfllninwb`
- `name`: `allow_authenticated_insert_products`
- `query`:
```sql
create policy "authenticated can register products"
on public.products
for insert
to authenticated
with check (retailer in ('target', 'walmart'));
```

- [ ] **Step 2: Verify the policy exists**

Run this SQL via the Supabase MCP `execute_sql` tool (`project_id`: `jbnnouwhesexfllninwb`):
```sql
select policyname, cmd, roles, with_check
from pg_policies
where tablename = 'products' and cmd = 'INSERT';
```
Expected: one row, `policyname = 'authenticated can register products'`,
`with_check` containing `retailer in ('target'::text, 'walmart'::text)` (Postgres normalizes the
literal cast when it echoes the policy back — this is expected, not an error).

- [ ] **Step 3: Commit**

No repo files changed by this task — nothing to commit. Note the applied migration name in your
report so Task 2 and the final verification can reference it.

---

### Task 2: Trigger — keep `products.active` in sync with subscriber count

**Files:** none (Supabase migration only, via MCP tool — no repo files change)

**Interfaces:**
- Consumes: `subscriptions` table (`id uuid`, `user_id uuid`, `product_id uuid`, `max_price
  numeric`, `created_at`), `products.active`.
- Produces: a trigger that fires automatically on every `INSERT`/`DELETE` on `subscriptions` —
  no application code ever calls it directly. Task 3's `removeProduct` fix depends on this trigger
  existing to have any effect (deleting a `subscriptions` row does nothing to `products.active`
  without it).

- [ ] **Step 1: Apply the migration**

Use the Supabase MCP `apply_migration` tool with:
- `project_id`: `jbnnouwhesexfllninwb`
- `name`: `subscriptions_ref_count_trigger`
- `query`:
```sql
create or replace function public.sync_product_active_from_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_id uuid;
begin
  affected_id := coalesce(new.product_id, old.product_id);

  update public.products
  set active = exists (
    select 1 from public.subscriptions where product_id = affected_id
  )
  where id = affected_id;

  return coalesce(new, old);
end;
$$;

drop trigger if exists subscriptions_sync_product_active on public.subscriptions;

create trigger subscriptions_sync_product_active
after insert or delete on public.subscriptions
for each row
execute function public.sync_product_active_from_subscriptions();
```

(`security definer` is required, not optional — without it, the function runs as the invoking
`authenticated` role, whose RLS on `subscriptions` only shows that user's own rows, so the
`EXISTS(...)` count would never see other users' subscriptions. `set search_path = public` is
standard hardening for `SECURITY DEFINER` functions, preventing search-path hijacking.)

- [ ] **Step 2: Verify end-to-end with a real row**

Run via the Supabase MCP `execute_sql` tool (`project_id`: `jbnnouwhesexfllninwb`) — this uses the
`products` row seeding a throwaway test product, not a real monitored one:
```sql
-- Seed a throwaway test product, forced inactive.
insert into public.products (id, retailer, product_url, product_key, name, active)
values ('00000000-0000-0000-0000-000000000001', 'target', 'https://example.com/test', 'test-key-1', 'Trigger test product', false)
on conflict (id) do update set active = false;

-- Insert a subscription for the test@gmail.com user created in a prior session.
insert into public.subscriptions (user_id, product_id)
select id, '00000000-0000-0000-0000-000000000001'
from auth.users where email = 'test@gmail.com'
on conflict do nothing;

select active from public.products where id = '00000000-0000-0000-0000-000000000001';
```
Expected: `active = true` (the trigger flipped it on insert).

```sql
delete from public.subscriptions
where product_id = '00000000-0000-0000-0000-000000000001';

select active from public.products where id = '00000000-0000-0000-0000-000000000001';
```
Expected: `active = false` (the trigger flipped it back off — no subscribers remain).

```sql
-- Clean up the throwaway test product.
delete from public.products where id = '00000000-0000-0000-0000-000000000001';
```

- [ ] **Step 3: Commit**

No repo files changed by this task — nothing to commit.

---

### Task 3: `SupabaseMonitorSource.removeProduct` actually removes the subscription

**Files:**
- Modify: `src/main/monitor/SupabaseMonitorSource.js`
- Test: `tests/main/monitor/SupabaseMonitorSource.test.js`

**Interfaces:**
- Consumes: `this._client` (the authenticated Supabase client already stored on the instance),
  `this._channels` (`Map<productUrl, { channel, productId }>`, already populated by `addProduct`).
- Produces: no new public method — `removeProduct(productUrl)`'s existing signature and return
  type (`Promise<void>`) are unchanged; only its internal behavior gains one more effect (deletes
  the caller's `subscriptions` row) before the existing channel teardown.

- [ ] **Step 1: Write the failing test**

Find this test in `tests/main/monitor/SupabaseMonitorSource.test.js`:
```js
  it('removeProduct unsubscribes the channel', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    await source.removeProduct('https://www.target.com/p/A-94336414')
    expect(calls.removed).toBe(1)
  })
```

Replace it with:
```js
  it('removeProduct deletes the subscription row and unsubscribes the channel', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    await source.removeProduct('https://www.target.com/p/A-94336414')
    expect(calls.deletes).toEqual([
      { table: 'subscriptions', column: 'product_id', value: 'prod-1' }
    ])
    expect(calls.removed).toBe(1)
  })
```

Also find `makeFakeClient` at the top of the same file:
```js
function makeFakeClient({
  product,
  userId = 'user-1',
  registerResult = { data: { id: 'prod-new' }, error: null }
}) {
  const calls = { upserts: [], registerCalls: [], channels: [], removed: 0 }
  let dropHandler = null
  const client = {
    from: (table) => {
      if (table === 'products') {
        return {
          select: () => ({
            match: () => ({ maybeSingle: async () => ({ data: product, error: null }) })
          }),
          upsert: (row, opts) => {
            calls.registerCalls.push({ row, opts })
            return { select: () => ({ single: async () => registerResult }) }
          }
        }
      }
      return {
        upsert: async (row, opts) => {
          calls.upserts.push({ table, row, opts })
          return { error: null }
        }
      }
    },
```

Replace the `calls` initializer and the `else` branch (the `subscriptions`-table case) with:
```js
function makeFakeClient({
  product,
  userId = 'user-1',
  registerResult = { data: { id: 'prod-new' }, error: null }
}) {
  const calls = { upserts: [], registerCalls: [], deletes: [], channels: [], removed: 0 }
  let dropHandler = null
  const client = {
    from: (table) => {
      if (table === 'products') {
        return {
          select: () => ({
            match: () => ({ maybeSingle: async () => ({ data: product, error: null }) })
          }),
          upsert: (row, opts) => {
            calls.registerCalls.push({ row, opts })
            return { select: () => ({ single: async () => registerResult }) }
          }
        }
      }
      return {
        upsert: async (row, opts) => {
          calls.upserts.push({ table, row, opts })
          return { error: null }
        },
        delete: () => ({
          eq: async (column, value) => {
            calls.deletes.push({ table, column, value })
            return { error: null }
          }
        })
      }
    },
```

(Only the `calls` initializer line and the final `return { ... }` object inside the `else` branch
change — everything else in `makeFakeClient`, `client`, and the rest of the file stays exactly as
it is.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- SupabaseMonitorSource`
Expected: FAIL — `expect(calls.deletes).toEqual(...)` fails because `calls.deletes` is `undefined`
(the fake client doesn't define it yet at this point, and even once the fixture is updated,
`removeProduct` itself doesn't call `.delete()` yet).

- [ ] **Step 3: Implement the fix**

In `src/main/monitor/SupabaseMonitorSource.js`, find:
```js
  async removeProduct(productUrl) {
    const entry = this._channels.get(productUrl)
    if (!entry) return
    await this._client.removeChannel(entry.channel)
    this._channels.delete(productUrl)
    this._byProduct.delete(entry.productId)
  }
```

Replace with:
```js
  async removeProduct(productUrl) {
    const entry = this._channels.get(productUrl)
    if (!entry) return
    // RLS on `subscriptions` scopes every row to the caller's own user_id, so this can
    // only ever delete our own subscription — no explicit user filter needed. This is
    // what actually decrements the central ref count; the `subscriptions_sync_product_active`
    // trigger then deactivates the product once the last subscriber's row is gone.
    await this._client.from('subscriptions').delete().eq('product_id', entry.productId)
    await this._client.removeChannel(entry.channel)
    this._channels.delete(productUrl)
    this._byProduct.delete(entry.productId)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- SupabaseMonitorSource`
Expected: PASS (7 tests total — 6 existing + the replaced one, same count since it's a
replacement, not an addition).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 38/38 test files, 202/202 tests (same total as before this task — Step 1 replaced
an existing test rather than adding a new one).

- [ ] **Step 6: Commit**

```bash
git add src/main/monitor/SupabaseMonitorSource.js tests/main/monitor/SupabaseMonitorSource.test.js
git commit -m "fix: removeProduct deletes the caller's subscription row

Without this, stopping or deleting a Supabase-mode task never actually
removed the user's subscription, so the ref-counting trigger on
subscriptions (see the two migrations preceding this commit) had
nothing to decrement — a product could never become centrally
inactive once subscribed."
```

---

### Task 4: Full regression and manual end-to-end pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`
Expected: all test files passing, 0 failures.

- [ ] **Step 2: Manual verification against the real app**

Run: `npm run dev`

1. In Settings, switch Monitoring Source to **Supabase**.
2. Create (or start) a Target task for a product not already in the central `products` table.
3. Confirm no "Not tracked centrally" notice appears in the Live Feed, and no console error about
   RLS/permission-denied on `products` — this confirms Task 1's policy is live.
4. Run this SQL via the Supabase MCP `execute_sql` tool (`project_id`: `jbnnouwhesexfllninwb`) to
   confirm the app's own subscription registered for real (replace the product_key with the one
   from the task you just created):
   ```sql
   select p.retailer, p.product_key, p.active, count(s.id) as subscriber_count
   from public.products p
   left join public.subscriptions s on s.product_id = p.id
   where p.product_key = '<the product_key you used>'
   group by p.id, p.retailer, p.product_key, p.active;
   ```
   Expected: `active = true`, `subscriber_count >= 1`.
5. Stop or delete that task in the Electron app.
6. Re-run the same query. Expected: `active = false`, `subscriber_count = 0` (assuming no other
   real user is also subscribed to that same product — if `subscriber_count` is still `> 0`,
   that's correct behavior, not a bug, per this feature's whole point).

- [ ] **Step 3: Report results**

No commit for this task — it's a verification pass. If everything in Step 2 checks out, the
feature is complete and this plan is done.
