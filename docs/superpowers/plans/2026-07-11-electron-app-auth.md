# Electron App Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared "bot account" Supabase login with real per-user email/password auth, gating the whole app behind a login/signup screen.

**Architecture:** Main process owns one `AuthSessionManager` (an `EventEmitter`, same pattern as `TaskManager`) wrapping the existing `SupabaseClient`. It persists the session's refresh token encrypted in the `settings` table (reusing the existing local vault key) and restores it silently at startup. The renderer pulls current status via IPC on mount and listens for push updates on subsequent sign-in/out; while unauthenticated it renders a `Login` screen instead of the app's nav/router.

**Tech Stack:** Electron (main/renderer IPC), `@supabase/supabase-js` v2 (`signInWithPassword`, `signUp`, `refreshSession`, `signOut`), Zustand (renderer store), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-electron-app-auth-design.md`

## Global Constraints

- Auth method is Supabase email + password only for this sub-project (no OAuth, no magic link).
- The whole app UI is gated — no task/account/catalog data renders until `authStatus === 'authenticated'`.
- No paid/subscription gate in this sub-project (that's sub-project B, deferred).
- No password-reset flow in this sub-project (not requested — YAGNI).
- Refresh tokens are encrypted at rest with the existing local vault key (`src/main/crypto.js`, derived via `deriveKeyLegacy(TEMP_DEV_VAULT_PASSWORD)` in `src/main/index.js`) — the same mechanism already used for account/payment secrets. No new crypto.
- **Manual prerequisite, not code:** Supabase project PokeAlert (`jbnnouwhesexfllninwb`) → Authentication → Providers → Email → **"Confirm email" must be OFF**, or `signUp` won't return a usable session. Flagged again in Task 10.
- This work **replaces**, not supplements, the shared "bot account" mechanism — `supabaseEmail` / `supabasePasswordEnc` settings and the `SUPABASE_SET_PASSWORD` / `SUPABASE_CLEAR_CREDENTIALS` IPC channels are deleted, not left in parallel.

---

### Task 1: Extend SupabaseClient with signUp / restoreSession / signOut

**Files:**
- Modify: `src/main/supabase/SupabaseClient.js`
- Test: `tests/main/supabase/SupabaseClient.test.js`

**Interfaces:**
- Consumes: `@supabase/supabase-js` `createClient()` (already wired).
- Produces: `SupabaseClient.signUp(email, password) → Promise<Session>`, `SupabaseClient.restoreSession(refreshToken) → Promise<Session>`, `SupabaseClient.signOut() → Promise<void>`. All three throw `Error` with a `Supabase <verb> failed: <message>` string on failure, matching the existing `signIn` convention.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/supabase/SupabaseClient.test.js` (append inside the existing `describe('SupabaseClient', ...)` block, after the two existing `it`s):

```js
  it('signs up and sets the realtime auth token when a session is returned', async () => {
    const signUp = vi.fn(async () => ({
      data: { session: { access_token: 'jwt-signup', refresh_token: 'rt-signup' } },
      error: null
    }))
    createClient.mockReturnValueOnce({ auth: { signInWithPassword, signUp }, realtime: { setAuth } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    const session = await sc.signUp('new@example.com', 'pw123')

    expect(signUp).toHaveBeenCalledWith({ email: 'new@example.com', password: 'pw123' })
    expect(setAuth).toHaveBeenCalledWith('jwt-signup')
    expect(session).toEqual({ access_token: 'jwt-signup', refresh_token: 'rt-signup' })
  })

  it('signUp throws when Supabase returns no session (e.g. email confirmation still required)', async () => {
    const signUp = vi.fn(async () => ({ data: { session: null }, error: null }))
    createClient.mockReturnValueOnce({ auth: { signInWithPassword, signUp }, realtime: { setAuth } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    await expect(sc.signUp('new@example.com', 'pw123')).rejects.toThrow(
      'Supabase sign-up succeeded but returned no session'
    )
  })

  it('restores a session from a stored refresh token', async () => {
    const refreshSession = vi.fn(async () => ({
      data: { session: { access_token: 'jwt-restored', refresh_token: 'rt-restored' } },
      error: null
    }))
    createClient.mockReturnValueOnce({
      auth: { signInWithPassword, refreshSession },
      realtime: { setAuth }
    })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    const session = await sc.restoreSession('rt-old')

    expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'rt-old' })
    expect(setAuth).toHaveBeenCalledWith('jwt-restored')
    expect(session).toEqual({ access_token: 'jwt-restored', refresh_token: 'rt-restored' })
  })

  it('restoreSession throws a clear error when the token is rejected', async () => {
    const refreshSession = vi.fn(async () => ({ data: {}, error: { message: 'invalid token' } }))
    createClient.mockReturnValueOnce({
      auth: { signInWithPassword, refreshSession },
      realtime: { setAuth }
    })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    await expect(sc.restoreSession('rt-old')).rejects.toThrow(
      'Supabase session restore failed: invalid token'
    )
  })

  it('signs out', async () => {
    const signOut = vi.fn(async () => ({ error: null }))
    createClient.mockReturnValueOnce({ auth: { signInWithPassword, signOut }, realtime: { setAuth } })
    const sc = new SupabaseClient({ url: 'https://x.supabase.co', key: 'k' })

    await sc.signOut()

    expect(signOut).toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- SupabaseClient`
Expected: FAIL — `sc.signUp is not a function` (and similarly for `restoreSession`/`signOut`).

- [ ] **Step 3: Implement signUp / restoreSession / signOut**

Replace the full contents of `src/main/supabase/SupabaseClient.js` with:

```js
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

  async signUp(email, password) {
    const { data, error } = await this._client.auth.signUp({ email, password })
    if (error) throw new Error(`Supabase sign-up failed: ${error.message}`)
    if (!data.session) {
      throw new Error(
        'Supabase sign-up succeeded but returned no session — check that email confirmation is disabled for this project'
      )
    }
    await this._client.realtime.setAuth(data.session.access_token)
    return data.session
  }

  async restoreSession(refreshToken) {
    const { data, error } = await this._client.auth.refreshSession({ refresh_token: refreshToken })
    if (error) throw new Error(`Supabase session restore failed: ${error.message}`)
    await this._client.realtime.setAuth(data.session.access_token)
    return data.session
  }

  async signOut() {
    const { error } = await this._client.auth.signOut()
    if (error) throw new Error(`Supabase sign-out failed: ${error.message}`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- SupabaseClient`
Expected: PASS (7 tests total — 2 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/supabase/SupabaseClient.js tests/main/supabase/SupabaseClient.test.js
git commit -m "feat: add signUp/restoreSession/signOut to SupabaseClient"
```

---

### Task 2: AuthSessionManager — per-user session lifecycle

**Files:**
- Create: `src/main/supabase/AuthSessionManager.js`
- Test: `tests/main/supabase/AuthSessionManager.test.js`
- Create: `src/main/supabase/publicClient.js` (replaces `session.js` — keeps only the anon-key public client)
- Delete: `src/main/supabase/session.js`

**Interfaces:**
- Consumes: `SupabaseClient` (Task 1's `signIn`/`signUp`/`signOut`/`restoreSession`, plus its existing `client` getter), `encrypt`/`decrypt` from `src/main/crypto.js`, a `getDb()` function returning a `better-sqlite3`-style db with `.prepare(sql).run(...)` / `.get(...)`.
- Produces: `class AuthSessionManager extends EventEmitter`, constructed as `new AuthSessionManager({ getDb, encryptionKey, client? })` (`client` optional, defaults to a real `SupabaseClient`). Methods: `signIn(email, password)`, `signUp(email, password)`, `signOut()`, `restoreSession() → Promise<boolean>`, `getClient() → rawSupabaseJsClient`, `getStatus() → { authenticated: boolean, user: object|null }`. Emits `'change'` with `{ authenticated, user }` on every state transition.
- Also produces: `getPublicClient()` from the new `publicClient.js` (identical behavior to the old `session.js` export — anon-key client for `target_catalog` reads, no sign-in).

- [ ] **Step 1: Write the failing tests**

Create `tests/main/supabase/AuthSessionManager.test.js`:

```js
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AuthSessionManager } from '../../../src/main/supabase/AuthSessionManager.js'
import { decrypt } from '../../../src/main/crypto.js'

function makeFakeClient() {
  return {
    signIn: vi.fn(async () => ({ refresh_token: 'rt-1', user: { id: 'u1', email: 'a@b.com' } })),
    signUp: vi.fn(async () => ({ refresh_token: 'rt-2', user: { id: 'u2', email: 'c@d.com' } })),
    signOut: vi.fn(async () => {}),
    restoreSession: vi.fn(async () => ({ refresh_token: 'rt-3', user: { id: 'u1', email: 'a@b.com' } })),
    client: { fakeRawClient: true }
  }
}

function makeDb() {
  const store = {}
  return {
    prepare: vi.fn((sql) => ({
      run: (...args) => {
        if (sql.includes('INSERT OR REPLACE INTO settings')) store[args[0]] = args[1]
        if (sql.includes('DELETE FROM settings')) delete store[args[0]]
      },
      get: (key) => (store[key] !== undefined ? { value: store[key] } : undefined)
    })),
    _store: store
  }
}

const KEY = Buffer.alloc(32, 9)

describe('AuthSessionManager', () => {
  let client, db, manager

  beforeEach(() => {
    client = makeFakeClient()
    db = makeDb()
    manager = new AuthSessionManager({ getDb: () => db, encryptionKey: KEY, client })
  })

  it('signIn stores the refresh token encrypted, updates status, and emits change', async () => {
    const changes = []
    manager.on('change', (s) => changes.push(s))

    await manager.signIn('a@b.com', 'pw')

    expect(client.signIn).toHaveBeenCalledWith('a@b.com', 'pw')
    const stored = JSON.parse(db._store.authRefreshTokenEnc)
    expect(decrypt(stored, KEY)).toBe('rt-1')
    expect(changes).toEqual([{ authenticated: true, user: { id: 'u1', email: 'a@b.com' } }])
    expect(manager.getStatus()).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('restoreSession with a stored token restores it and re-saves the new one', async () => {
    await manager.signIn('a@b.com', 'pw') // seeds a stored token
    client.restoreSession.mockClear()

    const ok = await manager.restoreSession()

    expect(ok).toBe(true)
    expect(client.restoreSession).toHaveBeenCalledWith('rt-1')
    expect(manager.getStatus()).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('restoreSession with no stored token reports unauthenticated without calling the client', async () => {
    const ok = await manager.restoreSession()

    expect(ok).toBe(false)
    expect(client.restoreSession).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual({ authenticated: false, user: null })
  })

  it('restoreSession clears a stale token when the client rejects it', async () => {
    await manager.signIn('a@b.com', 'pw')
    client.restoreSession.mockRejectedValueOnce(new Error('expired'))

    const ok = await manager.restoreSession()

    expect(ok).toBe(false)
    expect(db._store.authRefreshTokenEnc).toBeUndefined()
    expect(manager.getStatus()).toEqual({ authenticated: false, user: null })
  })

  it('signOut clears the stored token and reports unauthenticated', async () => {
    await manager.signIn('a@b.com', 'pw')

    await manager.signOut()

    expect(client.signOut).toHaveBeenCalled()
    expect(db._store.authRefreshTokenEnc).toBeUndefined()
    expect(manager.getStatus()).toEqual({ authenticated: false, user: null })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- AuthSessionManager`
Expected: FAIL — cannot find module `src/main/supabase/AuthSessionManager.js`.

- [ ] **Step 3: Implement AuthSessionManager**

Create `src/main/supabase/AuthSessionManager.js`:

```js
import { EventEmitter } from 'events'
import { SupabaseClient } from './SupabaseClient.js'
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'
import { encrypt, decrypt } from '../crypto.js'

const REFRESH_TOKEN_KEY = 'authRefreshTokenEnc'

// Owns the one Supabase session for the app's lifetime. Persists the session's refresh
// token encrypted in `settings` (same local vault key used for account/payment secrets)
// so a signed-in user stays signed in across app restarts. Replaces the old shared
// "bot account" mechanism (session.js's getSupabaseSession) with real per-user identity.
export class AuthSessionManager extends EventEmitter {
  constructor({ getDb, encryptionKey, client = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY }) }) {
    super()
    this._getDb = getDb
    this._key = encryptionKey
    this._client = client
    this._authenticated = false
    this._user = null
  }

  getClient() {
    return this._client.client
  }

  getStatus() {
    return { authenticated: this._authenticated, user: this._user }
  }

  _setState(authenticated, user) {
    this._authenticated = authenticated
    this._user = user
    this.emit('change', { authenticated, user })
  }

  _saveRefreshToken(token) {
    const enc = encrypt(token, this._key)
    this._getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(REFRESH_TOKEN_KEY, JSON.stringify(enc))
  }

  _clearRefreshToken() {
    this._getDb().prepare('DELETE FROM settings WHERE key = ?').run(REFRESH_TOKEN_KEY)
  }

  _readRefreshToken() {
    const row = this._getDb().prepare('SELECT value FROM settings WHERE key = ?').get(REFRESH_TOKEN_KEY)
    if (!row) return null
    try {
      return decrypt(JSON.parse(row.value), this._key)
    } catch {
      return null
    }
  }

  async signIn(email, password) {
    const session = await this._client.signIn(email, password)
    this._saveRefreshToken(session.refresh_token)
    this._setState(true, session.user ?? null)
    return session
  }

  async signUp(email, password) {
    const session = await this._client.signUp(email, password)
    this._saveRefreshToken(session.refresh_token)
    this._setState(true, session.user ?? null)
    return session
  }

  async signOut() {
    await this._client.signOut()
    this._clearRefreshToken()
    this._setState(false, null)
  }

  async restoreSession() {
    const token = this._readRefreshToken()
    if (!token) {
      this._setState(false, null)
      return false
    }
    try {
      const session = await this._client.restoreSession(token)
      this._saveRefreshToken(session.refresh_token)
      this._setState(true, session.user ?? null)
      return true
    } catch {
      this._clearRefreshToken()
      this._setState(false, null)
      return false
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- AuthSessionManager`
Expected: PASS (5 tests).

- [ ] **Step 5: Split session.js — keep the public client, drop the bot-login flow**

Create `src/main/supabase/publicClient.js`:

```js
import { SupabaseClient } from './SupabaseClient.js'
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'

let publicClient = null

// Unauthenticated client for data anon is allowed to read (the shared reference
// catalog). No sign-in, no credentials required.
export function getPublicClient() {
  if (!publicClient) publicClient = new SupabaseClient({ url: SUPABASE_URL, key: SUPABASE_KEY })
  return publicClient
}
```

Delete `src/main/supabase/session.js` (its `getPublicClient` moved above; its `getSupabaseSession`/`resetSupabaseSession` bot-login flow is superseded by `AuthSessionManager` and has no remaining callers after Tasks 3–5).

- [ ] **Step 6: Run the full test suite to confirm nothing else references the deleted file yet**

Run: `npm test`
Expected: FAIL only in `src/main/ipc.js`'s importer (still importing from the deleted `session.js`) — this is expected and fixed in Task 3. Confirm no *other* file fails.

- [ ] **Step 7: Commit**

```bash
git add src/main/supabase/AuthSessionManager.js tests/main/supabase/AuthSessionManager.test.js src/main/supabase/publicClient.js
git rm src/main/supabase/session.js
git commit -m "feat: add AuthSessionManager, split public client out of session.js"
```

---

### Task 3: IPC layer — AUTH_* channels, remove old bot-credential channels

**Files:**
- Modify: `src/shared/constants.js`
- Modify: `src/main/ipc.js`
- Test: `tests/main/ipc.supabase.test.js`

**Interfaces:**
- Consumes: `AuthSessionManager` (Task 2) instance passed into `registerIpcHandlers({ ..., authSessionManager })`.
- Produces: IPC channels `IPC.AUTH_GET_STATUS`, `IPC.AUTH_SIGN_IN`, `IPC.AUTH_SIGN_UP`, `IPC.AUTH_SIGN_OUT` (renderer → main, via `ipcRenderer.invoke`), `IPC.AUTH_STATE_CHANGED` (main → renderer push, wired in Task 5). Removes `IPC.SUPABASE_SET_PASSWORD`, `IPC.SUPABASE_CLEAR_CREDENTIALS`.

- [ ] **Step 1: Update constants.js**

In `src/shared/constants.js`, replace:

```js
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  MONITOR_SET_MODE: 'monitor:set-mode',
  SUPABASE_SET_PASSWORD: 'supabase:set-password',
  SUPABASE_CLEAR_CREDENTIALS: 'supabase:clear-credentials',
  SUPABASE_CATALOG_LIST: 'catalog:supabase-list',
```

with:

```js
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  MONITOR_SET_MODE: 'monitor:set-mode',
  AUTH_SIGN_IN: 'auth:sign-in',
  AUTH_SIGN_UP: 'auth:sign-up',
  AUTH_SIGN_OUT: 'auth:sign-out',
  AUTH_GET_STATUS: 'auth:get-status',
  AUTH_STATE_CHANGED: 'auth:state-changed',
  SUPABASE_CATALOG_LIST: 'catalog:supabase-list',
```

- [ ] **Step 2: Write the failing IPC tests**

Replace the full contents of `tests/main/ipc.supabase.test.js` with:

```js
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handlers, signIn, SupabaseClient, catalogSelect } = vi.hoisted(() => {
  const handlers = new Map()
  const signIn = vi.fn(async () => ({}))
  const catalogSelect = vi.fn(() => ({
    order: async () => ({
      data: [
        {
          id: 'cat-1',
          product_key: '94336414',
          name: 'Pokemon ETB',
          image: null,
          category: 'tcg',
          upc: '196214112568',
          regular_price: 49.99,
          current_price: 44.99,
          price_checked_at: '2026-07-11T12:00:00.000Z'
        }
      ],
      error: null
    })
  }))
  const SupabaseClient = vi.fn(function () {
    return { signIn, client: { from: () => ({ select: catalogSelect }) } }
  })
  return { handlers, signIn, SupabaseClient, catalogSelect }
})

vi.mock('electron', () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }))
vi.mock('../../src/main/supabase/SupabaseClient.js', () => ({ SupabaseClient }))

import { registerIpcHandlers } from '../../src/main/ipc.js'
import { IPC } from '../../src/shared/constants.js'

function makeAuthSessionManager() {
  return {
    getStatus: vi.fn(() => ({ authenticated: false, user: null })),
    signIn: vi.fn(async () => {}),
    signUp: vi.fn(async () => {}),
    signOut: vi.fn(async () => {})
  }
}

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
  const authSessionManager = makeAuthSessionManager()
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
    getSettings: () => ({}),
    mainWindow: { webContents: { send: vi.fn() } },
    browserPool: {},
    notificationEngine: { fire: vi.fn() },
    queueJoiner: { on: vi.fn() },
    authSessionManager
  })
  return { handlers, settingsStore, taskManager, authSessionManager }
}

describe('supabase catalog / monitor-mode IPC handlers', () => {
  beforeEach(() => {
    catalogSelect.mockClear()
    signIn.mockClear()
  })

  it('MONITOR_SET_MODE saves the setting then restarts tasks', async () => {
    const { handlers, settingsStore, taskManager } = setup()
    await handlers.get(IPC.MONITOR_SET_MODE)({}, 'supabase')
    expect(JSON.parse(settingsStore.monitorMode)).toBe('supabase')
    expect(taskManager.setMonitorMode).toHaveBeenCalled()
  })

  it('SUPABASE_CATALOG_LIST reads the target_catalog reference list anonymously — no sign-in required', async () => {
    const { handlers } = setup()
    const result = await handlers.get(IPC.SUPABASE_CATALOG_LIST)({})
    expect(signIn).not.toHaveBeenCalled()
    expect(catalogSelect).toHaveBeenCalledWith(
      'id, product_key, name, image, category, upc, regular_price, current_price, price_checked_at'
    )
    expect(result).toEqual([
      {
        id: 'cat-1',
        retailer: 'target',
        product_key: '94336414',
        product_url: 'https://www.target.com/p/-/A-94336414',
        name: 'Pokemon ETB',
        image: null,
        category: 'tcg',
        upc: '196214112568',
        regular_price: 49.99,
        current_price: 44.99,
        price_checked_at: '2026-07-11T12:00:00.000Z'
      }
    ])
  })
})

describe('auth IPC handlers', () => {
  it('AUTH_GET_STATUS returns the manager\'s current status', async () => {
    const { handlers, authSessionManager } = setup()
    authSessionManager.getStatus.mockReturnValue({
      authenticated: true,
      user: { id: 'u1', email: 'a@b.com' }
    })
    const result = await handlers.get(IPC.AUTH_GET_STATUS)({})
    expect(result).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('AUTH_SIGN_IN signs in with the given credentials and returns the resulting status', async () => {
    const { handlers, authSessionManager } = setup()
    authSessionManager.getStatus.mockReturnValue({
      authenticated: true,
      user: { id: 'u1', email: 'a@b.com' }
    })
    const result = await handlers.get(IPC.AUTH_SIGN_IN)({}, { email: 'a@b.com', password: 'pw' })
    expect(authSessionManager.signIn).toHaveBeenCalledWith('a@b.com', 'pw')
    expect(result).toEqual({ authenticated: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('AUTH_SIGN_UP signs up with the given credentials', async () => {
    const { handlers, authSessionManager } = setup()
    await handlers.get(IPC.AUTH_SIGN_UP)({}, { email: 'new@b.com', password: 'pw' })
    expect(authSessionManager.signUp).toHaveBeenCalledWith('new@b.com', 'pw')
  })

  it('AUTH_SIGN_OUT signs out and returns the resulting (unauthenticated) status', async () => {
    const { handlers, authSessionManager } = setup()
    const result = await handlers.get(IPC.AUTH_SIGN_OUT)({})
    expect(authSessionManager.signOut).toHaveBeenCalled()
    expect(result).toEqual({ authenticated: false, user: null })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- ipc.supabase`
Expected: FAIL — `registerIpcHandlers` doesn't yet register `IPC.AUTH_GET_STATUS` etc. (`handlers.get(...)` is `undefined`), and the old `SUPABASE_SET_PASSWORD` test paths no longer exist to fail on, so the failures are specifically the four new `auth IPC handlers` tests.

- [ ] **Step 4: Update ipc.js**

In `src/main/ipc.js`:

1. Change the import (was `import { encrypt } from './crypto.js'` and `import { getPublicClient, resetSupabaseSession } from './supabase/session.js'`) to:

```js
import { getPublicClient } from './supabase/publicClient.js'
```

(Delete the `encrypt` import entirely — Step 5 below removes its only caller.)

2. Add `authSessionManager` to the `registerIpcHandlers({...})` parameter list, replacing `encryptionKey` (now unused in this file):

```js
export function registerIpcHandlers({
  getDb,
  accountManager,
  paymentManager,
  shippingManager,
  thumbnailCache,
  taskManager,
  pokemonFinder,
  profileWarmup,
  getSettings,
  mainWindow,
  browserPool,
  notificationEngine,
  queueJoiner,
  authSessionManager
}) {
```

3. In the `SETTINGS_SET` handler, remove the now-dead bot-login reset line:

```js
  ipcMain.handle(IPC.SETTINGS_SET, (_, key, value) => {
    if (typeof key !== 'string' || !key) throw new Error('settings key must be a non-empty string')
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value))
    return true
  })
```

4. Replace the `SUPABASE_SET_PASSWORD` handler block with the new auth handlers:

```js
  // Per-user Supabase Auth — replaces the old shared "bot account" (email/password
  // settings) with a real signed-in user. authSessionManager owns the one session for
  // the app's lifetime and persists it (encrypted) across restarts.
  ipcMain.handle(IPC.AUTH_GET_STATUS, () => authSessionManager.getStatus())

  ipcMain.handle(IPC.AUTH_SIGN_IN, async (_, { email, password }) => {
    await authSessionManager.signIn(email, password)
    return authSessionManager.getStatus()
  })

  ipcMain.handle(IPC.AUTH_SIGN_UP, async (_, { email, password }) => {
    await authSessionManager.signUp(email, password)
    return authSessionManager.getStatus()
  })

  ipcMain.handle(IPC.AUTH_SIGN_OUT, async () => {
    await authSessionManager.signOut()
    return authSessionManager.getStatus()
  })
```

5. Delete the `SUPABASE_CLEAR_CREDENTIALS` handler block entirely:

```js
  // DELETE this whole block:
  ipcMain.handle(IPC.SUPABASE_CLEAR_CREDENTIALS, () => {
    getDb()
      .prepare('DELETE FROM settings WHERE key IN (?, ?)')
      .run('supabaseEmail', 'supabasePasswordEnc')
    resetSupabaseSession()
    return true
  })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- ipc.supabase`
Expected: PASS (6 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.js src/main/ipc.js tests/main/ipc.supabase.test.js
git commit -m "feat: replace bot-credential IPC channels with per-user AUTH_* channels"
```

---

### Task 4: TaskManager — use AuthSessionManager instead of the bot session

**Files:**
- Modify: `src/main/tasks/TaskManager.js:19` (import), `:40-58` (constructor), `:82-89` (`_buildSupabaseSource`)

**Interfaces:**
- Consumes: `AuthSessionManager.getClient()` (Task 2).
- Produces: `TaskManager` constructor now takes `authSessionManager` instead of `encryptionKey`; `SupabaseMonitorSource` construction unchanged (`new SupabaseMonitorSource({ client })`).

- [ ] **Step 1: Update the import**

In `src/main/tasks/TaskManager.js`, replace:

```js
import { getSupabaseSession } from '../supabase/session.js'
```

with: (delete this line entirely — no replacement import needed, `authSessionManager` is passed in via the constructor).

- [ ] **Step 2: Update the constructor**

Replace:

```js
  constructor({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings = () => ({}),
    encryptionKey = null,
    createSupabaseSource = null,
    queueJoiner = null
  }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._queueJoiner = queueJoiner
    this._getDb = getDb
    this._getSettings = getSettings
    this._encryptionKey = encryptionKey
```

with:

```js
  constructor({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings = () => ({}),
    authSessionManager = null,
    createSupabaseSource = null,
    queueJoiner = null
  }) {
    super()
    this._accountManager = accountManager
    this._notify = notificationEngine
    this._pool = browserPool
    this._queueJoiner = queueJoiner
    this._getDb = getDb
    this._getSettings = getSettings
    this._authSessionManager = authSessionManager
```

- [ ] **Step 3: Update `_buildSupabaseSource`**

Replace:

```js
  async _buildSupabaseSource() {
    const session = await getSupabaseSession({
      getSettings: this._getSettings,
      encryptionKey: this._encryptionKey
    })
    if (!session) throw new Error('Supabase bot credentials are not configured yet')
    return new SupabaseMonitorSource({ client: session.client })
  }
```

with:

```js
  async _buildSupabaseSource() {
    const client = this._authSessionManager?.getClient()
    if (!client) throw new Error('Not signed in to Supabase yet')
    return new SupabaseMonitorSource({ client })
  }
```

- [ ] **Step 4: Run the existing TaskManager test suites to confirm no regression**

Run: `npm test -- TaskManager`
Expected: PASS — `tests/main/tasks/TaskManager.test.js` and `tests/main/tasks/TaskManager.supabase.test.js` both inject `createSupabaseSource` directly (bypassing `_buildSupabaseSource`), so they're unaffected by this change; the extra unused `encryptionKey` key those tests still pass into the constructor is harmless (ignored).

- [ ] **Step 5: Commit**

```bash
git add src/main/tasks/TaskManager.js
git commit -m "feat: TaskManager uses AuthSessionManager instead of the bot Supabase session"
```

---

### Task 5: Wire AuthSessionManager into index.js startup

**Files:**
- Modify: `src/main/index.js`

**Interfaces:**
- Consumes: `AuthSessionManager` (Task 2), `TaskManager` (Task 4's new `authSessionManager` param), `registerIpcHandlers` (Task 3's new `authSessionManager` param).
- Produces: main process now restores any prior session before the window loads, and relays `AuthSessionManager`'s `'change'` events to the renderer over `IPC.AUTH_STATE_CHANGED`.

- [ ] **Step 1: Swap the import**

Replace:

```js
import { getSupabaseSession } from './supabase/session.js'
```

with:

```js
import { AuthSessionManager } from './supabase/AuthSessionManager.js'
```

- [ ] **Step 2: Replace the startup Supabase connection**

Replace:

```js
  // Connect to Supabase (PokeAlert) at startup regardless of monitor mode —
  // the shared session is reused by catalog browsing and task monitoring.
  // No-op (returns null) until bot email/password are set in Settings.
  getSupabaseSession({ getSettings, encryptionKey }).catch((err) => {
    logger.warn('Supabase session not established at startup', { error: err.message })
  })

  taskManager = new TaskManager({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings,
    encryptionKey,
    queueJoiner
  })
```

with:

```js
  // Per-user Supabase Auth session, reused by catalog browsing and task monitoring.
  // Silently restores a prior sign-in (encrypted refresh token in `settings`) before the
  // window loads, so the renderer's first AUTH_GET_STATUS call already reflects the real
  // state — no login-screen flash for an already-signed-in user. `mainWindow` is assigned
  // further below; the 'change' listener only fires after that, via closure.
  const authSessionManager = new AuthSessionManager({ getDb, encryptionKey })
  await authSessionManager.restoreSession().catch((err) => {
    logger.warn('Supabase session restore failed at startup', { error: err.message })
  })
  authSessionManager.on('change', (state) => {
    mainWindow?.webContents?.send(IPC.AUTH_STATE_CHANGED, state)
  })

  taskManager = new TaskManager({
    accountManager,
    notificationEngine,
    browserPool,
    getDb,
    getSettings,
    authSessionManager,
    queueJoiner
  })
```

- [ ] **Step 3: Pass authSessionManager into registerIpcHandlers**

Replace:

```js
  registerIpcHandlers({
    getDb,
    accountManager,
    paymentManager,
    shippingManager,
    thumbnailCache,
    taskManager,
    pokemonFinder,
    profileWarmup,
    configManager,
    getSettings,
    encryptionKey,
    mainWindow,
    browserPool,
    notificationEngine,
    queueJoiner
  })
```

with:

```js
  registerIpcHandlers({
    getDb,
    accountManager,
    paymentManager,
    shippingManager,
    thumbnailCache,
    taskManager,
    pokemonFinder,
    profileWarmup,
    configManager,
    getSettings,
    authSessionManager,
    mainWindow,
    browserPool,
    notificationEngine,
    queueJoiner
  })
```

- [ ] **Step 4: Manually verify the app still boots**

Run: `npm run dev`
Expected: App window opens with no errors in the terminal about `getSupabaseSession` or missing `session.js`. (The app will still show the old, un-gated UI at this point — gating lands in Task 8. This step just confirms the main-process wiring doesn't crash.)

- [ ] **Step 5: Commit**

```bash
git add src/main/index.js
git commit -m "feat: restore per-user Supabase session at startup, relay auth state to renderer"
```

---

### Task 6: appStore.js — auth state and actions

**Files:**
- Modify: `src/renderer/src/store/appStore.js`

**Interfaces:**
- Consumes: `IPC.AUTH_GET_STATUS`, `IPC.AUTH_SIGN_IN`, `IPC.AUTH_SIGN_UP`, `IPC.AUTH_SIGN_OUT` (Task 3).
- Produces: store fields `authStatus` (`'checking' | 'authenticated' | 'unauthenticated'`), `authUser`, `authError`; actions `checkAuthStatus()`, `signIn(email, password)`, `signUp(email, password)`, `signOut()`, `setAuthState({ authenticated, user })` — all consumed by `Login.jsx` (Task 7) and `App.jsx` (Task 8).

- [ ] **Step 1: Add auth fields to initial state**

In `src/renderer/src/store/appStore.js`, after the line `proxyTestMessage: '',` (part of the initial state object), add:

```js
  authStatus: 'checking', // 'checking' | 'authenticated' | 'unauthenticated'
  authUser: null,
  authError: '',
```

- [ ] **Step 2: Replace the old bot-credential actions with auth actions**

Replace:

```js
  setSupabasePassword: async (password) => {
    await invoke(IPC.SUPABASE_SET_PASSWORD, password)
  },
  clearSupabaseCredentials: async () => {
    await invoke(IPC.SUPABASE_CLEAR_CREDENTIALS)
    await get().loadSettings()
  },
```

with:

```js
  checkAuthStatus: async () => {
    try {
      const status = await invoke(IPC.AUTH_GET_STATUS)
      set({
        authStatus: status.authenticated ? 'authenticated' : 'unauthenticated',
        authUser: status.user ?? null
      })
    } catch (err) {
      set({ authStatus: 'unauthenticated', authError: err.message })
    }
  },
  signIn: async (email, password) => {
    set({ authError: '' })
    try {
      const status = await invoke(IPC.AUTH_SIGN_IN, { email, password })
      set({ authStatus: 'authenticated', authUser: status.user ?? null })
    } catch (err) {
      set({ authError: err.message })
      throw err
    }
  },
  signUp: async (email, password) => {
    set({ authError: '' })
    try {
      const status = await invoke(IPC.AUTH_SIGN_UP, { email, password })
      set({ authStatus: 'authenticated', authUser: status.user ?? null })
    } catch (err) {
      set({ authError: err.message })
      throw err
    }
  },
  signOut: async () => {
    await invoke(IPC.AUTH_SIGN_OUT)
    set({ authStatus: 'unauthenticated', authUser: null })
  },
  setAuthState: (state) => {
    set({
      authStatus: state.authenticated ? 'authenticated' : 'unauthenticated',
      authUser: state.user ?? null
    })
  },
```

- [ ] **Step 3: Manually verify the store still loads**

Run: `npm run dev`
Expected: No console errors about `useAppStore` (the app UI is still un-gated until Task 8, so no visible behavior change yet — this just confirms the store module doesn't throw on load).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/appStore.js
git commit -m "feat: add auth state and actions to appStore"
```

---

### Task 7: Login page

**Files:**
- Create: `src/renderer/src/pages/Login.jsx`

**Interfaces:**
- Consumes: `useAppStore()`'s `signIn`, `signUp`, `authError` (Task 6).
- Produces: default-exported `Login` component, rendered by `App.jsx` (Task 8) in place of the nav/router while unauthenticated.

- [ ] **Step 1: Create the component**

Create `src/renderer/src/pages/Login.jsx`:

```jsx
import { useState } from 'react'
import { useAppStore } from '../store/appStore'

export default function Login() {
  const { signIn, signUp, authError } = useAppStore()
  const [mode, setMode] = useState('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (mode === 'sign-in') await signIn(email, password)
      else await signUp(email, password)
    } catch {
      // authError is already set in the store by signIn/signUp
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-gray-100 font-mono text-base">
      <form
        onSubmit={handleSubmit}
        className="w-80 space-y-4 bg-[#141414] border border-gray-800 rounded p-6"
      >
        <div className="text-red-500 font-bold tracking-widest uppercase text-lg text-center mb-2">
          PB2
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('sign-in')}
            className={`flex-1 px-3 py-1.5 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'sign-in'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => setMode('sign-up')}
            className={`flex-1 px-3 py-1.5 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'sign-up'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Sign Up
          </button>
        </div>

        <div>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>

        <div>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            Password
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>

        {authError && <div className="text-red-500 text-sm">{authError}</div>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-3 py-2 rounded uppercase tracking-wider text-sm font-bold bg-red-600 border border-red-500 text-white disabled:opacity-50"
        >
          {submitting ? 'Please wait...' : mode === 'sign-in' ? 'Sign In' : 'Sign Up'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/pages/Login.jsx
git commit -m "feat: add Login page (email/password sign in and sign up)"
```

(Manual verification of this page happens in Task 8, once `App.jsx` actually renders it.)

---

### Task 8: App.jsx — gate the app behind auth

**Files:**
- Modify: `src/renderer/src/App.jsx`

**Interfaces:**
- Consumes: `authStatus`, `checkAuthStatus`, `setAuthState` (Task 6), `Login` (Task 7), `IPC.AUTH_STATE_CHANGED` (Task 3).
- Produces: the app's top-level gating behavior — no other file depends on `App.jsx`'s internals.

- [ ] **Step 1: Replace the full contents of App.jsx**

Replace the full contents of `src/renderer/src/App.jsx` with:

```jsx
import { useEffect } from 'react'
import { HashRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useAppStore } from './store/appStore'
import Dashboard from './pages/Dashboard'
import Tasks from './pages/Tasks'
import Accounts from './pages/Accounts'
import Proxies from './pages/Proxies'
import Settings from './pages/Settings'
import PaymentMethods from './pages/PaymentMethods'
import ShippingAddresses from './pages/ShippingAddresses'
import Login from './pages/Login'
import { IPC } from '../../shared/constants'

export default function App() {
  const {
    authStatus,
    checkAuthStatus,
    setAuthState,
    loadTasks,
    loadMonitors,
    loadAccounts,
    loadCatalog,
    loadSettings,
    pushFeedEvent,
    setTaskStatus,
    pushQueueProgress,
    setAccountRegistrationStatus
  } = useAppStore()

  // Auth check + live auth-state updates run regardless of current status.
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    checkAuthStatus()
    if (ipc) {
      ipc.on(IPC.AUTH_STATE_CHANGED, (_event, state) => setAuthState(state))
    }
    return () => {
      ipc?.removeAllListeners(IPC.AUTH_STATE_CHANGED)
    }
  }, [checkAuthStatus, setAuthState])

  // App data + live feed only load once actually signed in.
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    const ipc = window.electron?.ipcRenderer
    loadTasks()
    loadMonitors()
    loadAccounts()
    loadCatalog()
    loadSettings()
    if (ipc) {
      ipc.on(IPC.FEED_EVENT, (_event, data) => pushFeedEvent(data))
      ipc.on(IPC.TASK_STATUS, (_event, { taskId, status }) => setTaskStatus(taskId, status))
      ipc.on(IPC.QUEUE_PROGRESS, (_event, data) => pushQueueProgress(data))
      ipc.on(IPC.ACCOUNT_STATUS, (_event, data) => {
        loadAccounts()
        if (data?.email)
          setAccountRegistrationStatus(data.email, { state: 'success', message: data.message })
      })
    }
    return () => {
      ipc?.removeAllListeners(IPC.FEED_EVENT)
      ipc?.removeAllListeners(IPC.TASK_STATUS)
      ipc?.removeAllListeners(IPC.QUEUE_PROGRESS)
      ipc?.removeAllListeners(IPC.ACCOUNT_STATUS)
    }
  }, [
    authStatus,
    loadTasks,
    loadMonitors,
    loadAccounts,
    loadCatalog,
    loadSettings,
    pushFeedEvent,
    setTaskStatus,
    pushQueueProgress,
    setAccountRegistrationStatus
  ])

  if (authStatus === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-gray-500 font-mono text-sm uppercase tracking-widest">
        Loading...
      </div>
    )
  }

  if (authStatus !== 'authenticated') {
    return <Login />
  }

  return (
    <HashRouter>
      <div className="flex flex-col h-screen bg-[#0f0f0f] text-gray-100 font-mono text-base">
        <nav className="flex items-center gap-1 px-4 py-0 bg-[#141414] border-b border-gray-800/60 shrink-0 h-12">
          <span className="text-red-500 font-bold tracking-widest uppercase text-base mr-5 select-none">
            PB2
          </span>
          {[
            ['/', 'Dashboard'],
            ['/tasks', 'Tasks'],
            ['/accounts', 'Accounts'],
            ['/payments', 'Payments'],
            ['/shipping', 'Shipping'],
            ['/proxies', 'Proxies'],
            ['/settings', 'Settings']
          ].map(([path, label]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) =>
                `px-3 h-full flex items-center uppercase tracking-wider text-sm transition-colors border-b-2 ${
                  isActive
                    ? 'text-red-400 border-red-500'
                    : 'text-gray-500 border-transparent hover:text-gray-200 hover:border-gray-600'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
          <div className="ml-auto flex items-center gap-3 text-sm text-gray-600 select-none">
            <span className="w-2 h-2 rounded-full bg-gray-700" title="Monitor status" />
            <span>v1.0.0</span>
          </div>
        </nav>
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/catalog" element={<Navigate to="/tasks" replace />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/payments" element={<PaymentMethods />} />
            <Route path="/shipping" element={<ShippingAddresses />} />
            <Route path="/proxies" element={<Proxies />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
```

- [ ] **Step 2: Manually verify the gate end-to-end**

Run: `npm run dev`

Expected, in order:
1. Briefly shows "Loading..." then the Login screen (since no session is stored yet).
2. Sign Up with a brand-new email/password → lands directly in the Dashboard (nav bar visible, no error). If instead you see the error "Supabase sign-up succeeded but returned no session...", the "Confirm email" prerequisite (Global Constraints) is still ON in the Supabase dashboard — fix it there, not in code.
3. Quit and restart the app (`npm run dev` again) → skips Login entirely, opens straight to the Dashboard (session was restored from the encrypted stored refresh token).
4. Go to Settings → Sign Out (button added in Task 9 — if testing before Task 9 exists, skip this step and re-verify after Task 9 instead) → returns to the Login screen.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.jsx
git commit -m "feat: gate the app behind auth status, show Login when unauthenticated"
```

---

### Task 9: Settings.jsx — remove bot-account UI, add Sign Out

**Files:**
- Modify: `src/renderer/src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `signOut` (Task 6).

- [ ] **Step 1: Replace the full contents of Settings.jsx**

Replace the full contents of `src/renderer/src/pages/Settings.jsx` with:

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

export default function Settings() {
  const { settings, saveSetting, setMonitorMode, signOut } = useAppStore()
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

      <div className="pt-4 border-t border-gray-800">
        <button
          type="button"
          onClick={signOut}
          className="text-red-500 hover:text-red-300 uppercase tracking-wider text-sm"
        >
          Sign Out
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Manually verify**

Run: `npm run dev` (if not already running), navigate to Settings while signed in.
Expected: no "Bot Email"/"Bot Password" fields remain; a "Sign Out" button is visible at the bottom; clicking it returns you to the Login screen (per Task 8 Step 2.4, now fully verifiable).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages/Settings.jsx
git commit -m "feat: remove bot-account settings UI, add Sign Out"
```

---

### Task 10: Full-suite regression check and final manual pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: PASS, all suites green — this catches any remaining reference to the deleted `session.js` bot-login exports or `SUPABASE_SET_PASSWORD`/`SUPABASE_CLEAR_CREDENTIALS` channels.

- [ ] **Step 2: Confirm the Supabase dashboard prerequisite**

In the Supabase dashboard for project PokeAlert (`jbnnouwhesexfllninwb`): Authentication → Providers → Email → confirm **"Confirm email" is OFF**. (Global Constraints — required for Task 8 Step 2.2 to work as scoped.)

- [ ] **Step 3: Full manual walkthrough**

Run: `npm run dev`

1. Sign up with a brand-new real email against the PokeAlert project → lands in the Dashboard immediately, no email-confirmation interstitial.
2. Sign out (Settings page) → back at Login.
3. Sign in with the same credentials → back in the Dashboard.
4. Quit the app fully and run `npm run dev` again → session restored automatically, no Login screen shown.
5. Try signing up with an email that's already registered → inline error shown on the Login form, app stays on Login (does not crash).
6. Try signing in with a wrong password → inline error shown, app stays on Login.

- [ ] **Step 4: Confirm existing Supabase-dependent features still work while signed in**

With Settings → Monitoring Source set to "Supabase", start a task and confirm no console errors about "Not signed in to Supabase yet" (this would indicate `TaskManager`/`AuthSessionManager` wiring from Task 4/5 is broken).
