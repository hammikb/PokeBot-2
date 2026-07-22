# PokeBot Supabase Monitor Mode (B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Local↔Supabase monitoring toggle to PokeBot so it can either poll retailers itself (today) or receive in-stock drops from the central Supabase fan-out, plus publish catalog items to the Supabase `products` table.

**Architecture:** A new `SupabaseMonitorSource` joins one private Realtime channel per subscribed product (`drops:product:{id}`, event `drop`) and emits the same `drop` event shape the local `MonitorEngine` already emits, so `TaskManager._onDrop` → local checkout is untouched. `TaskManager` chooses the signal source from a `monitorMode` setting and restarts active tasks live when it changes. Catalog items publish to `products` via an authenticated upsert.

**Tech Stack:** Electron (ESM, `type: module`), Vitest (`vi.mock`), `@supabase/supabase-js` (new), zustand renderer store, better-sqlite3 settings table, existing `crypto.js` (AES-256-GCM) for the bot password at rest.

**Contract reference:** `docs/superpowers/specs/2026-06-15-supabase-monitor-mode-b2-design.md`. Realtime is **Broadcast** (trigger `realtime.send` to private topic), gated by a `realtime.messages` RLS policy requiring a `subscriptions` row. The worker publishes **every** in-stock transition with price; **per-task `max_price` is filtered client-side here**.

---

## File Structure

- Create `src/main/products/productKey.js` — pure `extractProductKey(retailer, productUrl)` (TCIN / Walmart itemId).
- Create `src/main/supabase/SupabaseClient.js` — thin `@supabase/supabase-js` wrapper: create client, sign in, set realtime auth.
- Create `src/main/supabase/catalogPublish.js` — pure `mapCatalogItemToProductRow(item)` + `pushCatalogItemToSupabase({ client, item })`.
- Create `src/main/monitor/SupabaseMonitorSource.js` — EventEmitter: resolve product, subscribe channel, emit `drop`/`notice`, max_price gate.
- Modify `src/main/tasks/TaskManager.js` — mode-aware `startTask`/`stopTask`, `setMonitorMode`, lazy supabase source.
- Modify `src/main/index.js` — pass `getSettings` + `encryptionKey` into `TaskManager` and `registerIpcHandlers`.
- Modify `src/main/ipc.js` — `MONITOR_SET_MODE`, `CATALOG_PUSH_SUPABASE`, `SUPABASE_SET_PASSWORD` handlers.
- Modify `src/shared/constants.js` — new IPC channels.
- Modify `src/renderer/src/store/appStore.js` — `setMonitorMode`, `pushCatalogToSupabase`, `setSupabasePassword`.
- Modify `src/renderer/src/pages/Settings.jsx` — toggle + Supabase fields.
- Modify `src/renderer/src/pages/Catalog.jsx` — "publish to PokeAlert" button.
- Modify `package.json` — add `@supabase/supabase-js`.
- Tests under `tests/main/...` mirroring source paths.

Run all tests with: `npm test`. Run one file with: `npx vitest run tests/main/<path> -v`.

---

## Task 1: `extractProductKey` pure helper

**Files:**

- Create: `src/main/products/productKey.js`
- Test: `tests/main/products/productKey.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest'
import { extractProductKey } from '../../../src/main/products/productKey.js'

describe('extractProductKey', () => {
  it('pulls the TCIN from a Target URL', () => {
    expect(extractProductKey('target', 'https://www.target.com/p/guppy/A-94336414')).toBe(
      '94336414'
    )
  })
  it('pulls the TCIN when there is no slug', () => {
    expect(extractProductKey('target', 'https://www.target.com/p/A-94336414')).toBe('94336414')
  })
  it('pulls the trailing itemId from a Walmart URL and strips query', () => {
    expect(extractProductKey('walmart', 'https://www.walmart.com/ip/seed/15718673510?x=1')).toBe(
      '15718673510'
    )
  })
  it('returns null for unsupported retailer or unparseable URL', () => {
    expect(extractProductKey('bestbuy', 'https://x')).toBeNull()
    expect(extractProductKey('target', 'not a url')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/products/productKey.test.js -v`
Expected: FAIL — "Failed to resolve import" / `extractProductKey is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/main/products/productKey.js
export function extractProductKey(retailer, productUrl) {
  if (retailer === 'target') {
    return String(productUrl || '').match(/A-(\d+)/)?.[1] || null
  }
  if (retailer === 'walmart') {
    try {
      return new URL(productUrl).pathname.split('/').filter(Boolean).pop() || null
    } catch {
      return (
        String(productUrl || '')
          .split('/')
          .pop()
          ?.split('?')[0] || null
      )
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/products/productKey.test.js -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/products/productKey.js tests/main/products/productKey.test.js
git commit -m "feat: add extractProductKey helper for Supabase product matching"
```

---

## Task 2: `SupabaseMonitorSource`

Emits `drop` (checkout signal) and `notice` (feed message). Dependency-injected supabase `client` so it is fully testable with a fake.

**Files:**

- Create: `src/main/monitor/SupabaseMonitorSource.js`
- Test: `tests/main/monitor/SupabaseMonitorSource.test.js`

- [ ] **Step 1: Write the failing test (resolve + subscribe + emit + gate + notice)**

```javascript
import { describe, expect, it, vi } from 'vitest'
import { SupabaseMonitorSource } from '../../../src/main/monitor/SupabaseMonitorSource.js'

// Fake supabase client. Captures upserts, channel creation, and lets the test
// fire a broadcast into the registered handler.
function makeFakeClient({ product, userId = 'user-1' }) {
  const calls = { upserts: [], channels: [], removed: 0 }
  let dropHandler = null
  const client = {
    from: (table) => ({
      select: () => ({
        match: () => ({ maybeSingle: async () => ({ data: product, error: null }) })
      }),
      upsert: async (row, opts) => {
        calls.upserts.push({ table, row, opts })
        return { error: null }
      }
    }),
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    channel: (name, opts) => {
      const ch = {
        name,
        opts,
        on: (type, filter, cb) => {
          if (type === 'broadcast') dropHandler = cb
          return ch
        },
        subscribe: async () => ch
      }
      calls.channels.push(ch)
      return ch
    },
    removeChannel: async () => {
      calls.removed += 1
    }
  }
  return { client, calls, fireDrop: (payload) => dropHandler({ payload }) }
}

const SEED = { id: 'prod-1' }

describe('SupabaseMonitorSource', () => {
  it('resolves the product, subscribes the private topic, and ensures a subscription', async () => {
    const { client, calls } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })

    const result = await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })

    expect(result).toEqual({ subscribed: true, productId: 'prod-1' })
    expect(calls.upserts[0]).toMatchObject({
      table: 'subscriptions',
      row: { user_id: 'user-1', product_id: 'prod-1' }
    })
    expect(calls.channels[0].name).toBe('drops:product:prod-1')
    expect(calls.channels[0].opts).toEqual({ config: { private: true } })
  })

  it('emits a drop event (mapped to the local productUrl) when a broadcast arrives', async () => {
    const { client, fireDrop } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    const drops = []
    source.on('drop', (e) => drops.push(e))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: null
    })
    fireDrop({
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock'
    })

    expect(drops).toEqual([
      {
        retailer: 'target',
        productName: 'Pokemon ETB',
        productUrl: 'https://www.target.com/p/A-94336414',
        price: 49.99,
        dropType: 'in_stock'
      }
    ])
  })

  it('drops the event when price exceeds the task max_price', async () => {
    const { client, fireDrop } = makeFakeClient({ product: SEED })
    const source = new SupabaseMonitorSource({ client })
    const drops = []
    source.on('drop', (e) => drops.push(e))

    await source.addProduct({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: 40
    })
    fireDrop({
      product_id: 'prod-1',
      retailer: 'target',
      name: 'Pokemon ETB',
      price: 49.99,
      drop_type: 'in_stock'
    })

    expect(drops).toEqual([])
  })

  it('emits a notice and does not subscribe when the product is not in Supabase', async () => {
    const { client, calls } = makeFakeClient({ product: null })
    const source = new SupabaseMonitorSource({ client })
    const notices = []
    source.on('notice', (n) => notices.push(n))

    const result = await source.addProduct({
      productUrl: 'https://www.target.com/p/A-99999999',
      retailer: 'target',
      productKey: '99999999',
      maxPrice: null
    })

    expect(result).toEqual({ subscribed: false })
    expect(calls.channels).toHaveLength(0)
    expect(notices[0]).toMatchObject({ productUrl: 'https://www.target.com/p/A-99999999' })
  })

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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/monitor/SupabaseMonitorSource.test.js -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/main/monitor/SupabaseMonitorSource.js
import { EventEmitter } from 'events'

// Receives in-stock drops from the central Supabase fan-out instead of polling
// retailers locally. One private Realtime channel per subscribed product
// (topic `drops:product:{id}`, event `drop`). Emits the same shape MonitorEngine
// emits so TaskManager._onDrop is unchanged. The serverside worker no longer
// filters by price, so each task's max_price is applied here.
export class SupabaseMonitorSource extends EventEmitter {
  constructor({ client }) {
    super()
    this._client = client
    this._channels = new Map() // productUrl → { channel, productId }
    this._byProduct = new Map() // productId → { productUrl, maxPrice }
  }

  async addProduct({ productUrl, retailer, productKey, maxPrice }) {
    const { data: product, error } = await this._client
      .from('products')
      .select('id')
      .match({ retailer, product_key: productKey })
      .maybeSingle()
    if (error) throw new Error(`Supabase product lookup failed: ${error.message}`)
    if (!product) {
      this.emit('notice', {
        productUrl,
        message: 'Not tracked centrally — publish it from Catalog first.'
      })
      return { subscribed: false }
    }

    const productId = product.id
    const { data: userData } = await this._client.auth.getUser()
    await this._client
      .from('subscriptions')
      .upsert(
        { user_id: userData.user.id, product_id: productId },
        { onConflict: 'user_id,product_id', ignoreDuplicates: true }
      )

    this._byProduct.set(productId, { productUrl, maxPrice: maxPrice ?? null })

    const channel = this._client
      .channel(`drops:product:${productId}`, { config: { private: true } })
      .on('broadcast', { event: 'drop' }, ({ payload }) => this._handleDrop(productId, payload))
    await channel.subscribe()
    this._channels.set(productUrl, { channel, productId })

    return { subscribed: true, productId }
  }

  _handleDrop(productId, payload) {
    const meta = this._byProduct.get(productId)
    if (!meta) return
    const price = payload?.price ?? null
    if (meta.maxPrice != null && price != null && Number(price) > Number(meta.maxPrice)) return
    this.emit('drop', {
      retailer: payload.retailer,
      productName: payload.name,
      productUrl: meta.productUrl,
      price,
      dropType: payload.drop_type || 'in_stock'
    })
  }

  async removeProduct(productUrl) {
    const entry = this._channels.get(productUrl)
    if (!entry) return
    await this._client.removeChannel(entry.channel)
    this._channels.delete(productUrl)
    this._byProduct.delete(entry.productId)
  }

  async stop() {
    for (const productUrl of [...this._channels.keys()]) {
      await this.removeProduct(productUrl)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/monitor/SupabaseMonitorSource.test.js -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/monitor/SupabaseMonitorSource.js tests/main/monitor/SupabaseMonitorSource.test.js
git commit -m "feat: add SupabaseMonitorSource (realtime drop fan-out consumer)"
```

---

## Task 3: `@supabase/supabase-js` dependency + `SupabaseClient` wrapper

**Files:**

- Modify: `package.json` (dependencies)
- Create: `src/main/supabase/SupabaseClient.js`
- Test: `tests/main/supabase/SupabaseClient.test.js`

- [ ] **Step 1: Install the dependency**

Run: `npm install @supabase/supabase-js@^2`
Expected: `package.json` gains `"@supabase/supabase-js"` under dependencies; lockfile updates.

- [ ] **Step 2: Write the failing test**

```javascript
import { describe, expect, it, vi, beforeEach } from 'vitest'

const signInWithPassword = vi.fn()
const setAuth = vi.fn()
const createClient = vi.fn(() => ({
  auth: { signInWithPassword },
  realtime: { setAuth }
}))

vi.mock('@supabase/supabase-js', () => ({ createClient }))

import { SupabaseClient } from '../../../src/main/supabase/SupabaseClient.js'

describe('SupabaseClient', () => {
  beforeEach(() => {
    createClient.mockClear()
    signInWithPassword.mockReset()
    setAuth.mockReset()
  })

  it('signs in and sets the realtime auth token for private channels', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'jwt-123' } },
      error: null
    })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'sb_publishable_abc' })

    await sc.signIn('bot@example.com', '1234')

    expect(createClient).toHaveBeenCalledWith(
      'https://x.supabase.co',
      'sb_publishable_abc',
      expect.objectContaining({ auth: expect.objectContaining({ persistSession: false }) })
    )
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'bot@example.com', password: '1234' })
    expect(setAuth).toHaveBeenCalledWith('jwt-123')
  })

  it('throws a clear error when sign-in fails', async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'invalid login' } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })
    await expect(sc.signIn('a', 'b')).rejects.toThrow('Supabase sign-in failed: invalid login')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/main/supabase/SupabaseClient.test.js -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```javascript
// src/main/supabase/SupabaseClient.js
import { createClient } from '@supabase/supabase-js'

// Thin wrapper around supabase-js for the Electron main process. Disables session
// persistence (no browser localStorage in main) and pushes the access token into
// the Realtime socket so private channels (drops:product:{id}) authorize.
export class SupabaseClient {
  constructor({ url, key }) {
    this._client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: true }
    })
  }

  get client() {
    return this._client
  }

  async signIn(email, password) {
    const { data, error } = await this._client.auth.signInWithPassword({ email, password })
    if (error) throw new Error(`Supabase sign-in failed: ${error.message}`)
    await this._client.realtime.setAuth(data.session.access_token)
    return data.session
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/main/supabase/SupabaseClient.test.js -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/supabase/SupabaseClient.js tests/main/supabase/SupabaseClient.test.js
git commit -m "feat: add SupabaseClient wrapper and @supabase/supabase-js dependency"
```

---

## Task 4: Catalog → Supabase publish logic

**Files:**

- Create: `src/main/supabase/catalogPublish.js`
- Test: `tests/main/supabase/catalogPublish.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest'
import {
  mapCatalogItemToProductRow,
  pushCatalogItemToSupabase
} from '../../../src/main/supabase/catalogPublish.js'

const ITEM = {
  retailer: 'target',
  retailer_item_id: '94336414',
  product_url: 'https://www.target.com/p/A-94336414',
  title: 'Pokemon ETB'
}

describe('mapCatalogItemToProductRow', () => {
  it('maps a catalog row to the products upsert payload', () => {
    expect(mapCatalogItemToProductRow(ITEM)).toEqual({
      retailer: 'target',
      product_url: 'https://www.target.com/p/A-94336414',
      product_key: '94336414',
      name: 'Pokemon ETB',
      active: true
    })
  })
})

describe('pushCatalogItemToSupabase', () => {
  it('upserts on (retailer, product_key) and returns the product id', async () => {
    const upsert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: { id: 'prod-1' }, error: null }) })
    }))
    const client = { from: vi.fn(() => ({ upsert })) }

    const result = await pushCatalogItemToSupabase({ client, item: ITEM })

    expect(client.from).toHaveBeenCalledWith('products')
    expect(upsert).toHaveBeenCalledWith(
      {
        retailer: 'target',
        product_url: 'https://www.target.com/p/A-94336414',
        product_key: '94336414',
        name: 'Pokemon ETB',
        active: true
      },
      { onConflict: 'retailer,product_key' }
    )
    expect(result).toEqual({ productId: 'prod-1' })
  })

  it('throws a clear error when the upsert fails', async () => {
    const upsert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: null, error: { message: 'denied' } }) })
    }))
    const client = { from: vi.fn(() => ({ upsert })) }
    await expect(pushCatalogItemToSupabase({ client, item: ITEM })).rejects.toThrow(
      'Supabase product publish failed: denied'
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/supabase/catalogPublish.test.js -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/main/supabase/catalogPublish.js
export function mapCatalogItemToProductRow(item) {
  return {
    retailer: item.retailer,
    product_url: item.product_url,
    product_key: item.retailer_item_id,
    name: item.title,
    active: true
  }
}

// Upsert on the (retailer, product_key) unique constraint so two users adding the
// same item share one monitored product. Returns the row id (new or existing).
export async function pushCatalogItemToSupabase({ client, item }) {
  const row = mapCatalogItemToProductRow(item)
  const { data, error } = await client
    .from('products')
    .upsert(row, { onConflict: 'retailer,product_key' })
    .select()
    .single()
  if (error) throw new Error(`Supabase product publish failed: ${error.message}`)
  return { productId: data.id }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/supabase/catalogPublish.test.js -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/supabase/catalogPublish.js tests/main/supabase/catalogPublish.test.js
git commit -m "feat: add catalog-to-Supabase products publish logic"
```

---

## Task 5: TaskManager mode switch

Wire `monitorMode` into `startTask`/`stopTask`, add `setMonitorMode` (restart-live), and a lazy supabase source built from settings. The supabase source factory is injectable for testing.

**Files:**

- Modify: `src/main/tasks/TaskManager.js`
- Test: `tests/main/tasks/TaskManager.supabase.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../../src/main/automation/flows/walmart.js', () => ({ runWalmartFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/target.js', () => ({ runTargetFlow: vi.fn() }))
vi.mock('../../../src/main/automation/flows/pokemon-center.js', () => ({
  runPokemonCenterFlow: vi.fn()
}))
vi.mock('../../../src/main/automation/flows/costco.js', () => ({ runCostcoFlow: vi.fn() }))

import { TaskManager } from '../../../src/main/tasks/TaskManager.js'

function makeFakeSource() {
  const source = new EventEmitter()
  source.addProduct = vi.fn(async () => ({ subscribed: true, productId: 'prod-1' }))
  source.removeProduct = vi.fn(async () => {})
  source.stop = vi.fn(async () => {})
  return source
}

const TARGET_TASK = {
  id: 'task-1',
  retailer: 'target',
  product_url: 'https://www.target.com/p/A-94336414',
  product_name: 'Pokemon ETB',
  max_price: 40,
  account_ids: '["account-1"]',
  interval_ms: 4000
}

function makeManager(monitorMode) {
  const source = makeFakeSource()
  const db = {
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(() => TARGET_TASK),
      all: vi.fn(() => [TARGET_TASK])
    }))
  }
  const manager = new TaskManager({
    accountManager: { getDecrypted: vi.fn() },
    notificationEngine: { fire: vi.fn() },
    browserPool: { launch: vi.fn(), close: vi.fn() },
    getDb: () => db,
    getSettings: () => ({ monitorMode }),
    encryptionKey: Buffer.alloc(32),
    createSupabaseSource: async () => source
  })
  return { manager, source }
}

describe('TaskManager monitor mode', () => {
  it('in supabase mode subscribes the product instead of polling', async () => {
    const { manager, source } = makeManager('supabase')
    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    expect(source.addProduct).toHaveBeenCalledWith({
      productUrl: 'https://www.target.com/p/A-94336414',
      retailer: 'target',
      productKey: '94336414',
      maxPrice: 40
    })
  })

  it('routes a supabase drop into the checkout path (emits drop)', async () => {
    const { manager, source } = makeManager('supabase')
    const drops = []
    manager.on('drop', (e) => drops.push(e))
    manager.startTask(TARGET_TASK)
    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())

    source.emit('drop', {
      retailer: 'target',
      productName: 'Pokemon ETB',
      productUrl: 'https://www.target.com/p/A-94336414',
      price: 25,
      dropType: 'in_stock'
    })
    await vi.waitFor(() => expect(drops).toHaveLength(1))
  })

  it('setMonitorMode stops active tasks and restarts them under the new source', async () => {
    const { manager, source } = makeManager('local')
    manager.startTask(TARGET_TASK)
    expect(manager.getActiveTasks()).toContain('task-1')

    // getSettings is read fresh inside startTask; flip mode then restart.
    manager._getSettings = () => ({ monitorMode: 'supabase' })
    await manager.setMonitorMode('supabase')

    await vi.waitFor(() => expect(source.addProduct).toHaveBeenCalled())
    expect(manager.getActiveTasks()).toContain('task-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/tasks/TaskManager.supabase.test.js -v`
Expected: FAIL — `getSettings` undefined / supabase branch missing.

- [ ] **Step 3: Edit `src/main/tasks/TaskManager.js` — constructor**

Add imports at the top (after existing imports):

```javascript
import { extractProductKey } from '../products/productKey.js'
import { SupabaseClient } from '../supabase/SupabaseClient.js'
import { SupabaseMonitorSource } from '../monitor/SupabaseMonitorSource.js'
import { decrypt } from '../crypto.js'
```

Replace the constructor signature/body:

```javascript
  constructor({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings = () => ({}),
    encryptionKey = null,
    createSupabaseSource = null
  }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._getDb = getDb
    this._getSettings = getSettings
    this._encryptionKey = encryptionKey
    this._monitor = new MonitorEngine()
    this._monitor.on('drop', (event) => this._onDrop(event))
    this._tasks = new Map()
    this._monitorContexts = new Map()
    this._supabaseSource = null
    this._supabaseSourcePromise = null
    this._createSupabaseSource = createSupabaseSource || (() => this._buildSupabaseSource())
  }
```

- [ ] **Step 4: Edit `TaskManager.js` — supabase source builder + lazy getter**

Add these methods (e.g. after `_getMonitorContext`):

```javascript
  async _buildSupabaseSource() {
    const s = this._getSettings()
    const password = s.supabasePasswordEnc
      ? decrypt(s.supabasePasswordEnc, this._encryptionKey)
      : ''
    const sc = new SupabaseClient({ url: s.supabaseUrl, key: s.supabaseKey })
    await sc.signIn(s.supabaseEmail, password)
    return new SupabaseMonitorSource({ client: sc.client })
  }

  async _getSupabaseSource() {
    if (this._supabaseSource) return this._supabaseSource
    if (!this._supabaseSourcePromise) {
      this._supabaseSourcePromise = Promise.resolve(this._createSupabaseSource()).then((source) => {
        source.on('drop', (event) => this._onDrop(event))
        source.on('notice', (notice) =>
          this.emit('drop', {
            retailer: 'catalog',
            productName: `ℹ️ ${notice.message}`,
            productUrl: notice.productUrl,
            dropType: 'supabase_notice'
          })
        )
        this._supabaseSource = source
        return source
      })
    }
    return this._supabaseSourcePromise
  }
```

- [ ] **Step 5: Edit `TaskManager.js` — `startTask` mode branch**

Replace the body of `startTask(taskRow)` with:

```javascript
  startTask(taskRow) {
    if (this._tasks.has(taskRow.id)) return
    const mode = this._getSettings().monitorMode || 'local'

    if (mode === 'supabase') {
      this._tasks.set(taskRow.id, { ...taskRow, source: 'supabase' })
      this._emitStatus(taskRow.id, 'monitoring')
      this._startSupabaseTask(taskRow).catch((err) => {
        this._emitStatus(taskRow.id, 'error')
        this.emit('drop', {
          retailer: taskRow.retailer,
          productName: `Supabase monitor error: ${err.message}`,
          productUrl: taskRow.product_url,
          dropType: 'supabase_notice'
        })
      })
      return
    }

    const PollerClass = POLLERS[taskRow.retailer]
    if (!PollerClass) {
      this._emitStatus(taskRow.id, 'error')
      return
    }
    const monitorContext =
      taskRow.retailer === 'target' ? this._getMonitorContext('target') : null
    const poller = new PollerClass({
      productUrl: taskRow.product_url,
      maxPrice: taskRow.max_price,
      monitorContext,
      browserPool: this._pool
    })
    this._tasks.set(taskRow.id, { ...taskRow, poller, source: 'local' })
    this._monitor.addTask({ id: taskRow.id, poller, intervalMs: taskRow.interval_ms || 4000 })
    this._emitStatus(taskRow.id, 'monitoring')
  }

  async _startSupabaseTask(taskRow) {
    const source = await this._getSupabaseSource()
    await source.addProduct({
      productUrl: taskRow.product_url,
      retailer: taskRow.retailer,
      productKey: extractProductKey(taskRow.retailer, taskRow.product_url),
      maxPrice: taskRow.max_price ?? null
    })
  }
```

Note: `_tasks` is only set in the local branch _after_ `PollerClass` is confirmed (and in the supabase branch inside `startTask`), so the no-poller early return leaves no stale entry — no delete needed.

- [ ] **Step 6: Edit `TaskManager.js` — `stopTask` dual path + `setMonitorMode`**

Replace `stopTask(id)` with:

```javascript
  stopTask(id) {
    const entry = this._tasks.get(id)
    if (entry?.source === 'supabase') {
      this._supabaseSource?.removeProduct(entry.product_url).catch(() => {})
    } else {
      this._monitor.removeTask(id)
    }
    this._tasks.delete(id)
    this._emitStatus(id, 'idle')
  }
```

Add `setMonitorMode` after `stopAll()`:

```javascript
  async setMonitorMode() {
    // Restart every active task under whatever monitorMode getSettings() now
    // returns. Caller persists the setting before invoking this.
    const activeIds = [...this._tasks.keys()]
    this.stopAll()
    if (this._supabaseSource) {
      await this._supabaseSource.stop().catch(() => {})
      this._supabaseSource = null
      this._supabaseSourcePromise = null
    }
    for (const id of activeIds) {
      const task = this._getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      if (task) this.startTask(task)
    }
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/main/tasks/TaskManager.supabase.test.js -v`
Expected: PASS (3 tests).

- [ ] **Step 8: Run the existing TaskManager tests (no regressions)**

Run: `npx vitest run tests/main/tasks/TaskManager.test.js -v`
Expected: PASS (existing 3 tests still green — local path unchanged).

- [ ] **Step 9: Commit**

```bash
git add src/main/tasks/TaskManager.js tests/main/tasks/TaskManager.supabase.test.js
git commit -m "feat: TaskManager local/supabase monitor mode switch"
```

---

## Task 6: IPC channels + main wiring

**Files:**

- Modify: `src/shared/constants.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/index.js`
- Test: `tests/main/ipc.supabase.test.js`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/constants.js`, inside the `IPC` object after `SETTINGS_SET: 'settings:set',` add:

```javascript
  MONITOR_SET_MODE: 'monitor:set-mode',
  SUPABASE_SET_PASSWORD: 'supabase:set-password',
  CATALOG_PUSH_SUPABASE: 'catalog:push-supabase',
```

- [ ] **Step 2: Write the failing test (handlers registered + behavior)**

```javascript
import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }
}))

const pushCatalogItemToSupabase = vi.fn(async () => ({ productId: 'prod-1' }))
vi.mock('../../src/main/supabase/catalogPublish.js', () => ({ pushCatalogItemToSupabase }))

const signIn = vi.fn(async () => ({}))
vi.mock('../../src/main/supabase/SupabaseClient.js', () => ({
  SupabaseClient: vi.fn(() => ({ signIn, client: { id: 'client' } }))
}))

import { registerIpcHandlers } from '../../src/main/ipc.js'
import { IPC } from '../../src/shared/constants.js'
import { encrypt, decrypt } from '../../src/main/crypto.js'

function setup() {
  handlers.clear()
  const settingsStore = {}
  const db = {
    prepare: vi.fn((sql) => ({
      run: (key, value) => {
        if (sql.includes('INSERT OR REPLACE INTO settings')) settingsStore[key] = value
      },
      get: () => ({
        id: 'cat-1',
        retailer: 'target',
        retailer_item_id: '94336414',
        product_url: 'https://www.target.com/p/A-94336414',
        title: 'Pokemon ETB'
      }),
      all: () => []
    }))
  }
  const taskManager = { on: vi.fn(), setMonitorMode: vi.fn(async () => {}) }
  const key = Buffer.alloc(32, 7)
  registerIpcHandlers({
    getDb: () => db,
    accountManager: {},
    paymentManager: {},
    shippingManager: {},
    thumbnailCache: {},
    taskManager,
    pokemonFinder: { on: vi.fn() },
    profileWarmup: {},
    configManager: null,
    getSettings: () => ({
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'k',
      supabaseEmail: 'bot@example.com',
      supabasePasswordEnc: encrypt('1234', key)
    }),
    mainWindow: { webContents: { send: vi.fn() } },
    browserPool: {},
    notificationEngine: { fire: vi.fn() },
    encryptionKey: key
  })
  return { handlers, settingsStore, taskManager, key }
}

describe('supabase IPC handlers', () => {
  beforeEach(() => {
    pushCatalogItemToSupabase.mockClear()
    signIn.mockClear()
  })

  it('MONITOR_SET_MODE saves the setting then restarts tasks', async () => {
    const { handlers, settingsStore, taskManager } = setup()
    await handlers.get(IPC.MONITOR_SET_MODE)({}, 'supabase')
    expect(JSON.parse(settingsStore.monitorMode)).toBe('supabase')
    expect(taskManager.setMonitorMode).toHaveBeenCalled()
  })

  it('SUPABASE_SET_PASSWORD stores the password encrypted (never plaintext)', async () => {
    const { handlers, settingsStore, key } = setup()
    await handlers.get(IPC.SUPABASE_SET_PASSWORD)({}, 'hunter2')
    const stored = JSON.parse(settingsStore.supabasePasswordEnc)
    expect(stored).not.toContain('hunter2')
    expect(decrypt(stored, key)).toBe('hunter2')
  })

  it('CATALOG_PUSH_SUPABASE signs in and upserts the catalog item', async () => {
    const { handlers } = setup()
    const result = await handlers.get(IPC.CATALOG_PUSH_SUPABASE)({}, 'cat-1')
    expect(signIn).toHaveBeenCalled()
    expect(pushCatalogItemToSupabase).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ retailer_item_id: '94336414' }) })
    )
    expect(result).toEqual({ productId: 'prod-1' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/main/ipc.supabase.test.js -v`
Expected: FAIL — handlers not registered.

- [ ] **Step 4: Implement the handlers in `src/main/ipc.js`**

Add imports near the top:

```javascript
import { encrypt, decrypt } from './crypto.js'
import { SupabaseClient } from './supabase/SupabaseClient.js'
import { pushCatalogItemToSupabase } from './supabase/catalogPublish.js'
```

Add `encryptionKey` to the destructured `registerIpcHandlers({ ... })` parameters.

After the existing Settings handlers (`IPC.SETTINGS_SET`), add:

```javascript
// Monitor mode (local vs supabase)
ipcMain.handle(IPC.MONITOR_SET_MODE, async (_, mode) => {
  const next = mode === 'supabase' ? 'supabase' : 'local'
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('monitorMode', JSON.stringify(next))
  await taskManager.setMonitorMode(next)
  return next
})

// Store the bot's Supabase password encrypted at rest (never plaintext).
ipcMain.handle(IPC.SUPABASE_SET_PASSWORD, (_, password) => {
  const enc = encrypt(String(password ?? ''), encryptionKey)
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('supabasePasswordEnc', JSON.stringify(enc))
  return true
})

// Publish a local catalog item to the Supabase products table.
ipcMain.handle(IPC.CATALOG_PUSH_SUPABASE, async (_, id) => {
  const item = getDb().prepare('SELECT * FROM product_catalog WHERE id = ?').get(id)
  if (!item) throw new Error('Catalog item not found')
  const s = getSettings()
  const password = s.supabasePasswordEnc ? decrypt(s.supabasePasswordEnc, encryptionKey) : ''
  const sc = new SupabaseClient({ url: s.supabaseUrl, key: s.supabaseKey })
  await sc.signIn(s.supabaseEmail, password)
  return pushCatalogItemToSupabase({ client: sc.client, item })
})
```

- [ ] **Step 5: Wire `encryptionKey` + `getSettings` through `src/main/index.js`**

In `createMainWindow`, update the TaskManager construction:

```javascript
taskManager = new TaskManager({
  accountManager,
  notificationEngine,
  browserPool,
  getDb,
  getSettings,
  encryptionKey
})
```

And in the `registerIpcHandlers({ ... })` call, add `encryptionKey,` to the argument object (alongside the existing `getSettings,`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/main/ipc.supabase.test.js -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.js src/main/ipc.js src/main/index.js tests/main/ipc.supabase.test.js
git commit -m "feat: wire monitor-mode, supabase password, and catalog-publish IPC"
```

---

## Task 7: Renderer — store actions

No React test runner is configured, so store actions are covered by the existing IPC tests and manual verification. Add the actions with exact code.

**Files:**

- Modify: `src/renderer/src/store/appStore.js`

- [ ] **Step 1: Add store actions**

After the existing `saveSetting` action, add:

```javascript
  setMonitorMode: async (mode) => {
    await invoke(IPC.MONITOR_SET_MODE, mode)
    await get().loadSettings()
  },
  setSupabasePassword: async (password) => {
    await invoke(IPC.SUPABASE_SET_PASSWORD, password)
  },
  pushCatalogToSupabase: async (id) => invoke(IPC.CATALOG_PUSH_SUPABASE, id),
```

- [ ] **Step 2: Verify the renderer bundle builds**

Run: `npm run build`
Expected: build completes with no errors referencing `appStore.js`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/appStore.js
git commit -m "feat: store actions for monitor mode and catalog publish"
```

---

## Task 8: Renderer — Settings toggle + Supabase fields

**Files:**

- Modify: `src/renderer/src/pages/Settings.jsx`

- [ ] **Step 1: Replace `src/renderer/src/pages/Settings.jsx` with the version below**

```jsx
import { useAppStore } from '../store/appStore'

const FIELDS = [
  {
    key: 'discordWebhook',
    label: 'Discord Webhook URL',
    type: 'text',
    placeholder: 'https://discord.com/api/webhooks/...'
  },
  { key: 'twilioSid', label: 'Twilio Account SID', type: 'text', placeholder: 'ACxxxxxxxx' },
  { key: 'twilioToken', label: 'Twilio Auth Token', type: 'password', placeholder: '••••••••' },
  { key: 'twilioFrom', label: 'Twilio From Number', type: 'text', placeholder: '+1XXXXXXXXXX' },
  { key: 'twilioTo', label: 'SMS Alert Number', type: 'text', placeholder: '+1XXXXXXXXXX' },
  { key: 'maxConcurrent', label: 'Max Concurrent Browsers', type: 'number', placeholder: '3' }
]

const SUPABASE_FIELDS = [
  {
    key: 'supabaseUrl',
    label: 'Supabase URL',
    type: 'text',
    placeholder: 'https://jbnnouwhesexfllninwb.supabase.co'
  },
  {
    key: 'supabaseKey',
    label: 'Supabase Publishable Key',
    type: 'text',
    placeholder: 'sb_publishable_...'
  },
  { key: 'supabaseEmail', label: 'Bot Email', type: 'text', placeholder: 'bot@example.com' }
]

export default function Settings() {
  const { settings, saveSetting, setMonitorMode, setSupabasePassword } = useAppStore()
  const mode = settings.monitorMode || 'local'

  return (
    <div className="p-4 space-y-5 max-w-lg overflow-y-auto h-full">
      <h2 className="text-sm uppercase tracking-widest text-gray-400">Settings</h2>

      <div>
        <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
          Monitoring Source
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMonitorMode('local')}
            className={`flex-1 px-3 py-2 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'local'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Local
          </button>
          <button
            type="button"
            onClick={() => setMonitorMode('supabase')}
            className={`flex-1 px-3 py-2 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'supabase'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Supabase
          </button>
        </div>
        <div className="text-gray-600 text-sm mt-1.5">
          {mode === 'local'
            ? 'This computer polls retailers directly.'
            : 'Receives drops from the central Supabase monitor. Restarts running tasks.'}
        </div>
      </div>

      {mode === 'supabase' &&
        SUPABASE_FIELDS.map((field) => (
          <div key={field.key}>
            <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
              {field.label}
            </label>
            <input
              type={field.type}
              placeholder={field.placeholder}
              defaultValue={settings[field.key] ?? ''}
              onBlur={(e) => {
                if (e.target.value !== (settings[field.key] ?? '').toString()) {
                  saveSetting(field.key, e.target.value)
                }
              }}
              key={`${field.key}-${settings[field.key]}`}
              className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
            />
          </div>
        ))}

      {mode === 'supabase' && (
        <div>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            Bot Password
          </label>
          <input
            type="password"
            placeholder="••••••••"
            onBlur={(e) => {
              if (e.target.value) setSupabasePassword(e.target.value)
            }}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
          <div className="text-gray-600 text-sm mt-1">
            Stored encrypted. Leave blank to keep current.
          </div>
        </div>
      )}

      {FIELDS.map((field) => (
        <div key={field.key}>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            {field.label}
          </label>
          <input
            type={field.type}
            placeholder={field.placeholder}
            defaultValue={settings[field.key] ?? ''}
            onBlur={(e) => {
              if (e.target.value !== (settings[field.key] ?? '').toString()) {
                saveSetting(field.key, e.target.value)
              }
            }}
            key={`${field.key}-${settings[field.key]}`}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>
      ))}
      <div className="text-gray-600 text-sm pt-2">Settings saved automatically on field blur.</div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages/Settings.jsx
git commit -m "feat: Settings monitoring-source toggle and Supabase credential fields"
```

---

## Task 9: Renderer — Catalog "publish to PokeAlert" button

**Files:**

- Modify: `src/renderer/src/pages/Catalog.jsx`

- [ ] **Step 1: Add the store action to the destructure**

Change the `useAppStore()` destructure at the top of `Catalog()`:

```jsx
const {
  catalogItems,
  catalogMessage,
  addCatalogUrl,
  deleteCatalogItem,
  createTask,
  pushCatalogToSupabase
} = useAppStore()
```

- [ ] **Step 2: Add a publish handler (after `createTaskFromItem`)**

```jsx
const publishToSupabase = async (item) => {
  setBusyId(item.id)
  setStatus('Publishing to PokeAlert...')
  try {
    const result = await pushCatalogToSupabase(item.id)
    setStatus(`Published to PokeAlert (product ${result.productId}). The monitor will watch it.`)
  } catch (err) {
    setStatus(err.message || 'Could not publish to PokeAlert')
  } finally {
    setBusyId('')
  }
}
```

- [ ] **Step 3: Add the button in the per-item action column (after the "create task" button)**

```jsx
<button
  type="button"
  onClick={() => publishToSupabase(item)}
  disabled={busyId === item.id}
  className="text-purple-400 hover:text-purple-200 disabled:text-gray-700 uppercase tracking-wider"
>
  publish to pokealert
</button>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/Catalog.jsx
git commit -m "feat: publish catalog items to Supabase from the Catalog page"
```

---

## Task 10: Revert the redundant Realtime publication change

The earlier `alter publication supabase_realtime add table public.drops` (postgres_changes) was added on a wrong assumption — the real fan-out is Broadcast. Remove it so PokeAlert matches repo A's migrations.

**Files:** none (Supabase MCP operation against project `jbnnouwhesexfllninwb`).

- [ ] **Step 1: Drop the table from the publication**

Run (Supabase MCP `execute_sql`, project `jbnnouwhesexfllninwb`):

```sql
alter publication supabase_realtime drop table public.drops;
select coalesce(string_agg(tablename, ','), '(none)') as realtime_tables
from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public';
```

Expected: `realtime_tables` = `(none)`.

- [ ] **Step 2: No commit (no repo change). Note completion in the execution log.**

---

## Task 11: Full suite + live verification

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all suites pass, including the new `productKey`, `SupabaseMonitorSource`, `SupabaseClient`, `catalogPublish`, `TaskManager.supabase`, and `ipc.supabase` tests, plus pre-existing tests.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors in the changed files.

- [ ] **Step 3: Live end-to-end (manual, with the running app + bot user)**

1. In PokeBot Settings, switch Monitoring Source to **Supabase** (fields prefilled: URL + publishable key + `kaib1121@gmail.com`; enter password `1234`).
2. In Catalog, add the Target seed URL `https://www.target.com/p/A-94336414`, then click **publish to PokeAlert**. Expect a success status (it upserts the existing seed `products` row).
3. Create a task for that catalog item and Start it (Supabase mode → subscribes, no local browser opens).
4. Simulate a drop via Supabase MCP `execute_sql` (project `jbnnouwhesexfllninwb`):
   ```sql
   insert into public.drops (product_id, retailer, name, price, drop_type)
   values ('51c9450b-d84e-4364-917f-67bb2725a546', 'target', 'Pokemon ETB', 25.00, 'in_stock');
   ```
5. Expect the PokeBot feed to show the drop (and the checkout flow to fire for the selected account). If `max_price` is set below 25, expect it to be skipped.
6. Switch Monitoring Source back to **Local**; confirm tasks restart and a local poll runs.

- [ ] **Step 4: Final commit (if lint/format touched files)**

```bash
git add -A
git commit -m "chore: lint/format for Supabase monitor mode"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** toggle (Tasks 5–8), Supabase signal source + broadcast contract (Tasks 2–3, 5), client-side max_price gate (Task 2), catalog publish (Tasks 4, 6, 9), encrypted bot password (Task 6), publication-cleanup (Task 10), docker producer is external (covered by the spec runbook — no code task here).
- **Type consistency:** `addProduct({ productUrl, retailer, productKey, maxPrice })`, drop event `{ retailer, productName, productUrl, price, dropType }`, products row `{ retailer, product_url, product_key, name, active }`, and IPC channels `MONITOR_SET_MODE` / `SUPABASE_SET_PASSWORD` / `CATALOG_PUSH_SUPABASE` are used identically across tasks.
- **Settings keys:** `monitorMode`, `supabaseUrl`, `supabaseKey`, `supabaseEmail`, `supabasePasswordEnc` (encrypted) — consistent between TaskManager builder, IPC handlers, and Settings UI.
