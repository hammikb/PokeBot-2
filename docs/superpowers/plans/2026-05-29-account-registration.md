# Account Registration Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate Target and Walmart account creation — bot fills signup form, saves account as `unverified`, notifies user to check email.

**Architecture:** New registration flows mirror existing checkout flows. DB gets a `status` column on `accounts`. A new `accounts:register` IPC handler orchestrates BrowserPool + registration flow + AccountManager. UI adds a "Register on Site" toggle to the single-account form and a separate bulk-creation panel, plus status badges in the account list.

**Tech Stack:** Playwright (chromium), better-sqlite3 / JsonDb fallback, Electron IPC, React + Zustand, Vitest

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/main/db.js` | Modify | Add `status` column to accounts schema + migration |
| `src/main/accounts/AccountManager.js` | Modify | Accept `status` in `create()`, expose in `getAll()`, add `setStatus()` |
| `src/shared/constants.js` | Modify | Add `ACCOUNTS_REGISTER`, `ACCOUNTS_SET_STATUS` IPC channels |
| `src/main/automation/flows/register-target.js` | Create | Target signup automation |
| `src/main/automation/flows/register-walmart.js` | Create | Walmart signup automation |
| `src/main/ipc.js` | Modify | Accept `browserPool` + `notificationEngine`, add registration handlers |
| `src/main/index.js` | Modify | Pass `browserPool` + `notificationEngine` to `registerIpcHandlers` |
| `src/renderer/src/store/appStore.js` | Modify | Add `registerAccount`, `setAccountStatus`, `accountRegistrationStatuses` |
| `src/renderer/src/App.jsx` | Modify | Listen for `account:status` IPC push events |
| `src/renderer/src/pages/Accounts.jsx` | Modify | Register toggle, status badges, bulk-create panel |
| `tests/main/accounts/AccountManager.test.js` | Modify | Tests for `status` field + `setStatus()` |
| `tests/main/automation/flows/register-target.test.js` | Create | Target registration flow tests |
| `tests/main/automation/flows/register-walmart.test.js` | Create | Walmart registration flow tests |

---

### Task 1: Add `status` column to accounts DB schema

**Files:**
- Modify: `src/main/db.js`

- [ ] **Step 1: Add `status` to `TABLE_COLUMNS.accounts`**

In `db.js`, find `TABLE_COLUMNS.accounts` array and add `'status'` after `'shipping_json'`:

```js
const TABLE_COLUMNS = {
  accounts: [
    'id',
    'name',
    'retailer',
    'username',
    'password_enc',
    'cvv_enc',
    'proxy',
    'profile_path',
    'shipping_json',
    'status',        // ← add this
    'created_at'
  ],
  // ...rest unchanged
}
```

- [ ] **Step 2: Add `status` to `CREATE TABLE accounts` SQL**

In `initDb()`, find the `CREATE TABLE IF NOT EXISTS accounts` block and add the `status` column before `created_at`:

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retailer TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  cvv_enc TEXT,
  proxy TEXT,
  profile_path TEXT,
  shipping_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
```

- [ ] **Step 3: Add migration for existing DBs**

After the existing migration checks (after the `buy_limit` check block), add:

```js
const accountColumns = db
  .prepare('PRAGMA table_info(accounts)')
  .all()
  .map((column) => column.name)
if (!accountColumns.includes('status')) {
  db.prepare("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'").run()
}
```

- [ ] **Step 4: Add default in `applyDefaults`**

In `applyDefaults()`, add a default for account status:

```js
function applyDefaults(table, row) {
  const now = Math.floor(Date.now() / 1000)
  if (table === 'accounts') {
    row.created_at ??= now
    row.status ??= 'active'     // ← add this line
  }
  if (table === 'tasks') {
    row.status ??= 'idle'
    row.created_at ??= now
  }
  if (table === 'drop_history') row.timestamp ??= now
}
```

- [ ] **Step 5: Commit**

```bash
git add src/main/db.js
git commit -m "feat: add status column to accounts table"
```

---

### Task 2: AccountManager — status support

**Files:**
- Modify: `src/main/accounts/AccountManager.js`

- [ ] **Step 1: Update `create()` to accept and store `status`**

Change the `create()` signature and INSERT statement:

```js
async create({ name, retailer, username, password, cvv = '', proxy = '', shipping = {}, status = 'active' }) {
  const base = await this._getProfileBase()
  const id = randomUUID()
  const profilePath = join(base, id)
  this._getDb()
    .prepare(
      `
    INSERT INTO accounts (id, name, retailer, username, password_enc, cvv_enc, proxy, profile_path, shipping_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      id,
      name,
      retailer,
      username,
      encrypt(password, this._key),
      cvv ? encrypt(cvv, this._key) : '',
      proxy,
      profilePath,
      JSON.stringify(shipping),
      status
    )
  return id
}
```

- [ ] **Step 2: Update `getAll()` to include `status`**

```js
getAll() {
  return this._getDb()
    .prepare(
      'SELECT id, name, retailer, username, proxy, profile_path, shipping_json, status FROM accounts'
    )
    .all()
}
```

- [ ] **Step 3: Add `setStatus()` method**

Add this method after `update()`:

```js
setStatus(id, status) {
  this._getDb().prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id)
}
```

- [ ] **Step 4: Commit**

```bash
git add src/main/accounts/AccountManager.js
git commit -m "feat: account status field — create with status, getAll returns it, setStatus()"
```

---

### Task 3: AccountManager tests — status

**Files:**
- Modify: `tests/main/accounts/AccountManager.test.js`

- [ ] **Step 1: Add tests for status field**

Append these tests inside `describe('AccountManager', () => { ... })`:

```js
it('defaults status to active on create', async () => {
  const id = await manager.create({
    name: 'A',
    retailer: 'target',
    username: 'u',
    password: 'p'
  })
  const accounts = manager.getAll()
  expect(accounts[0].status).toBe('active')
})

it('saves custom status on create', async () => {
  const id = await manager.create({
    name: 'B',
    retailer: 'walmart',
    username: 'u2',
    password: 'p',
    status: 'unverified'
  })
  const accounts = manager.getAll()
  expect(accounts[0].status).toBe('unverified')
})

it('setStatus updates account status', async () => {
  const id = await manager.create({
    name: 'C',
    retailer: 'target',
    username: 'u3',
    password: 'p',
    status: 'unverified'
  })
  manager.setStatus(id, 'verified')
  const accounts = manager.getAll()
  expect(accounts[0].status).toBe('verified')
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/main/accounts/AccountManager.test.js
```

Expected: all tests PASS (including existing ones)

- [ ] **Step 3: Commit**

```bash
git add tests/main/accounts/AccountManager.test.js
git commit -m "test: account status field and setStatus()"
```

---

### Task 4: Add IPC constants

**Files:**
- Modify: `src/shared/constants.js`

- [ ] **Step 1: Add new IPC channels**

In the `IPC` object, add after `ACCOUNT_STATUS`:

```js
export const IPC = {
  // ...existing entries...
  ACCOUNT_STATUS: 'account:status',
  ACCOUNTS_REGISTER: 'accounts:register',
  ACCOUNTS_SET_STATUS: 'accounts:set-status'
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/constants.js
git commit -m "feat: add ACCOUNTS_REGISTER and ACCOUNTS_SET_STATUS IPC constants"
```

---

### Task 5: Target registration flow

**Files:**
- Create: `src/main/automation/flows/register-target.js`

- [ ] **Step 1: Write the failing test first** (do this in Task 7 — come back after creating the file)

- [ ] **Step 2: Create the flow file**

```js
import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runTargetRegistration(
  context,
  { email, password, firstName, lastName, notificationEngine }
) {
  const page = await context.newPage()
  const captchaCtx = {
    notificationEngine,
    dropEvent: { productName: `Register: ${email}`, dropType: 'registration' }
  }
  try {
    await page.goto('https://www.target.com/account/create-account', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    // Fill registration form
    const firstNameField = page.locator('input[id="firstName"], input[name="firstName"]')
    await firstNameField.first().fill(firstName)

    const lastNameField = page.locator('input[id="lastName"], input[name="lastName"]')
    await lastNameField.first().fill(lastName)

    const emailField = page.locator('input[id="username"], input[type="email"]')
    await emailField.first().fill(email)

    const passwordField = page.locator('input[id="password"], input[type="password"]')
    await passwordField.first().fill(password)

    // Some Target forms have a confirm password field
    const confirmField = page.locator('input[id="confirmPassword"], input[name="confirmPassword"]')
    if ((await confirmField.count()) > 0) {
      await confirmField.first().fill(password)
    }

    const submitBtn = page.locator('button[type="submit"]')
    await submitBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    // Check for "already exists" error
    const errorEl = page.locator(
      '[data-test="errorMessage"], [class*="error"], [class*="Error"]'
    )
    if ((await errorEl.count()) > 0) {
      const errorText = await errorEl.first().textContent().catch(() => '')
      if (/already|registered|exists/i.test(errorText)) {
        return { success: false, alreadyExists: true, error: errorText.trim() }
      }
      return { success: false, alreadyExists: false, error: errorText.trim() }
    }

    // Wait for success redirect or welcome indicator
    await page.waitForURL(/target\.com\/account/, { timeout: 15000 })

    return { success: true, needsVerification: true }
  } catch (err) {
    return { success: false, alreadyExists: false, error: err.message }
  } finally {
    try {
      await page.close()
    } catch {}
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/main/automation/flows/register-target.js
git commit -m "feat: Target account registration flow"
```

---

### Task 6: Walmart registration flow

**Files:**
- Create: `src/main/automation/flows/register-walmart.js`

- [ ] **Step 1: Create the flow file**

```js
import { waitForCaptchaIfNeeded } from '../captcha.js'

export async function runWalmartRegistration(
  context,
  { email, password, firstName, lastName, phone = '', notificationEngine }
) {
  const page = await context.newPage()
  const captchaCtx = {
    notificationEngine,
    dropEvent: { productName: `Register: ${email}`, dropType: 'registration' }
  }
  try {
    await page.goto('https://www.walmart.com/account/signup', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    // Fill registration form
    const firstNameField = page.locator('input[name="firstName"], input[id="first-name"]')
    await firstNameField.first().fill(firstName)

    const lastNameField = page.locator('input[name="lastName"], input[id="last-name"]')
    await lastNameField.first().fill(lastName)

    const emailField = page.locator('input[type="email"], input[name="email"]')
    await emailField.first().fill(email)

    const passwordField = page.locator('input[type="password"], input[name="password"]')
    await passwordField.first().fill(password)

    if (phone) {
      const phoneField = page.locator('input[name="phone"], input[id="phone"]')
      if ((await phoneField.count()) > 0) {
        await phoneField.first().fill(phone)
      }
    }

    const submitBtn = page.locator('button[type="submit"]')
    await submitBtn.first().click({ timeout: 10000 })
    await waitForCaptchaIfNeeded(page, captchaCtx.notificationEngine, captchaCtx.dropEvent)

    // Check for "already exists" error
    const errorEl = page.locator(
      '[class*="error-text"], [class*="ErrorText"], [role="alert"]'
    )
    if ((await errorEl.count()) > 0) {
      const errorText = await errorEl.first().textContent().catch(() => '')
      if (/already|registered|exists/i.test(errorText)) {
        return { success: false, alreadyExists: true, error: errorText.trim() }
      }
      return { success: false, alreadyExists: false, error: errorText.trim() }
    }

    // Wait for success redirect
    await page.waitForURL(/walmart\.com\/(account|home)?/, { timeout: 15000 })

    return { success: true, needsVerification: true }
  } catch (err) {
    return { success: false, alreadyExists: false, error: err.message }
  } finally {
    try {
      await page.close()
    } catch {}
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/automation/flows/register-walmart.js
git commit -m "feat: Walmart account registration flow"
```

---

### Task 7: Registration flow tests

**Files:**
- Create: `tests/main/automation/flows/register-target.test.js`
- Create: `tests/main/automation/flows/register-walmart.test.js`

- [ ] **Step 1: Create Target registration test**

```js
// tests/main/automation/flows/register-target.test.js
import { describe, expect, it, vi } from 'vitest'
import { runTargetRegistration } from '../../../../src/main/automation/flows/register-target.js'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

function makePage({ errorText = null, waitForUrlResolves = true } = {}) {
  const page = {
    fills: [],
    clicks: [],
    closed: false,
    lastUrl: null,
    async goto(url) {
      this.lastUrl = url
    },
    locator(selector) {
      return makeLocator(page, selector, errorText)
    },
    async waitForURL() {
      if (!waitForUrlResolves) throw new Error('URL did not change')
    },
    async close() {
      this.closed = true
    }
  }
  return page
}

function makeLocator(page, selector, errorText) {
  const isErrorEl = /error|Error/.test(selector)
  const isConfirm = /confirmPassword/.test(selector)
  return {
    first() { return this },
    async count() {
      if (isErrorEl) return errorText ? 1 : 0
      if (isConfirm) return 0
      return 1
    },
    async fill(value) {
      page.fills.push({ selector, value })
    },
    async click() {
      page.clicks.push(selector)
    },
    async textContent() {
      return errorText || ''
    }
  }
}

function makeContext(page) {
  return { async newPage() { return page } }
}

const baseArgs = {
  email: 'test@example.com',
  password: 'SecurePass1!',
  firstName: 'Ash',
  lastName: 'Ketchum',
  notificationEngine: { fire: vi.fn() }
}

describe('runTargetRegistration', () => {
  it('navigates to Target create-account page', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.lastUrl).toContain('target.com/account/create-account')
  })

  it('fills email, password, first and last name', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.fills.some(f => f.value === 'test@example.com')).toBe(true)
    expect(page.fills.some(f => f.value === 'SecurePass1!')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ash')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ketchum')).toBe(true)
  })

  it('returns success with needsVerification on registration', async () => {
    const page = makePage()
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: true, needsVerification: true })
  })

  it('returns alreadyExists when error text matches', async () => {
    const page = makePage({ errorText: 'This email is already registered' })
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: false, alreadyExists: true })
  })

  it('closes page on success', async () => {
    const page = makePage()
    await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
  })

  it('closes page on error', async () => {
    const page = makePage({ waitForUrlResolves: false })
    const result = await runTargetRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Create Walmart registration test**

```js
// tests/main/automation/flows/register-walmart.test.js
import { describe, expect, it, vi } from 'vitest'
import { runWalmartRegistration } from '../../../../src/main/automation/flows/register-walmart.js'

vi.mock('../../../../src/main/automation/captcha.js', () => ({
  waitForCaptchaIfNeeded: vi.fn()
}))

function makePage({ errorText = null, waitForUrlResolves = true } = {}) {
  const page = {
    fills: [],
    clicks: [],
    closed: false,
    lastUrl: null,
    async goto(url) {
      this.lastUrl = url
    },
    locator(selector) {
      return makeLocator(page, selector, errorText)
    },
    async waitForURL() {
      if (!waitForUrlResolves) throw new Error('URL did not change')
    },
    async close() {
      this.closed = true
    }
  }
  return page
}

function makeLocator(page, selector, errorText) {
  const isErrorEl = /error-text|ErrorText|role.*alert/.test(selector)
  return {
    first() { return this },
    async count() {
      if (isErrorEl) return errorText ? 1 : 0
      return 1
    },
    async fill(value) {
      page.fills.push({ selector, value })
    },
    async click() {
      page.clicks.push(selector)
    },
    async textContent() {
      return errorText || ''
    }
  }
}

function makeContext(page) {
  return { async newPage() { return page } }
}

const baseArgs = {
  email: 'test@example.com',
  password: 'SecurePass1!',
  firstName: 'Ash',
  lastName: 'Ketchum',
  phone: '5551234567',
  notificationEngine: { fire: vi.fn() }
}

describe('runWalmartRegistration', () => {
  it('navigates to Walmart signup page', async () => {
    const page = makePage()
    await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.lastUrl).toContain('walmart.com/account/signup')
  })

  it('fills all fields including phone', async () => {
    const page = makePage()
    await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.fills.some(f => f.value === 'test@example.com')).toBe(true)
    expect(page.fills.some(f => f.value === 'SecurePass1!')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ash')).toBe(true)
    expect(page.fills.some(f => f.value === 'Ketchum')).toBe(true)
    expect(page.fills.some(f => f.value === '5551234567')).toBe(true)
  })

  it('returns success with needsVerification on registration', async () => {
    const page = makePage()
    const result = await runWalmartRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: true, needsVerification: true })
  })

  it('returns alreadyExists when error text matches', async () => {
    const page = makePage({ errorText: 'An account already exists with this email' })
    const result = await runWalmartRegistration(makeContext(page), baseArgs)
    expect(result).toMatchObject({ success: false, alreadyExists: true })
  })

  it('closes page on success', async () => {
    const page = makePage()
    await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
  })

  it('closes page on error', async () => {
    const page = makePage({ waitForUrlResolves: false })
    const result = await runWalmartRegistration(makeContext(page), baseArgs)
    expect(page.closed).toBe(true)
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/main/automation/flows/register-target.test.js tests/main/automation/flows/register-walmart.test.js
```

Expected: all 12 tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/main/automation/flows/register-target.test.js tests/main/automation/flows/register-walmart.test.js
git commit -m "test: Target and Walmart registration flow unit tests"
```

---

### Task 8: IPC handlers + index.js wiring

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/main/index.js`

- [ ] **Step 1: Add imports to `ipc.js`**

At the top of `ipc.js`, add the registration flow imports and randomUUID/tmpdir/join:

```js
import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC, RETAILER_BUY_LIMITS } from '../shared/constants.js'
import { lookupProduct } from './products/ProductLookup.js'
import { downloadProxies } from './proxies/ProxyImport.js'
import { testProxy } from './proxies/ProxyTest.js'
import { runTargetRegistration } from './automation/flows/register-target.js'
import { runWalmartRegistration } from './automation/flows/register-walmart.js'
```

- [ ] **Step 2: Update `registerIpcHandlers` signature**

Change the destructured parameter to include `browserPool` and `notificationEngine`:

```js
export function registerIpcHandlers({
  getDb,
  accountManager,
  taskManager,
  getSettings,
  mainWindow,
  browserPool,
  notificationEngine
}) {
```

- [ ] **Step 3: Add `ACCOUNTS_REGISTER` handler**

Add after the `ACCOUNTS_DELETE` handler block (before the Tasks section):

```js
ipcMain.handle(IPC.ACCOUNTS_REGISTER, async (_, data) => {
  const { retailer, email, password, firstName, lastName, phone = '', proxy = '', shipping = {}, cvv = '' } = data || {}
  if (!retailer || !email || !password || !firstName || !lastName) {
    throw new Error('retailer, email, password, firstName, and lastName are required')
  }

  const tempId = `reg-${randomUUID()}`
  const tempProfilePath = join(tmpdir(), tempId)
  const context = await browserPool.launch(tempId, { profilePath: tempProfilePath, proxy })

  let result
  try {
    const flowArgs = { email, password, firstName, lastName, phone, notificationEngine }
    if (retailer === 'target') {
      result = await runTargetRegistration(context, flowArgs)
    } else if (retailer === 'walmart') {
      result = await runWalmartRegistration(context, flowArgs)
    } else {
      throw new Error(`Registration not supported for retailer: ${retailer}`)
    }
  } finally {
    await browserPool.close(tempId)
  }

  if (result.success) {
    const accountId = await accountManager.create({
      name: `${retailer}-${email}`,
      retailer,
      username: email,
      password,
      cvv,
      proxy,
      shipping,
      status: 'unverified'
    })
    mainWindow?.webContents?.send(IPC.ACCOUNT_STATUS, {
      id: accountId,
      status: 'unverified',
      message: `Account created — check ${email} to verify`
    })
    return { success: true, accountId, needsVerification: true }
  }

  return result
})
```

- [ ] **Step 4: Add `ACCOUNTS_SET_STATUS` handler**

Add immediately after the `ACCOUNTS_REGISTER` handler:

```js
ipcMain.handle(IPC.ACCOUNTS_SET_STATUS, (_, id, status) => {
  accountManager.setStatus(id, status)
  return true
})
```

- [ ] **Step 5: Update `index.js` to pass `browserPool` and `notificationEngine`**

Find the `registerIpcHandlers` call in `index.js` and add the two new params:

```js
registerIpcHandlers({ getDb, accountManager, taskManager, getSettings, mainWindow, browserPool, notificationEngine })
```

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.js src/main/index.js
git commit -m "feat: accounts:register and accounts:set-status IPC handlers"
```

---

### Task 9: appStore — new actions and state

**Files:**
- Modify: `src/renderer/src/store/appStore.js`

- [ ] **Step 1: Add `accountRegistrationStatuses` to initial state and new actions**

In `useAppStore`, add `accountRegistrationStatuses: {}` to the initial state object and the following actions:

```js
accountRegistrationStatuses: {},

registerAccount: async (data) => {
  set((s) => ({
    accountRegistrationStatuses: {
      ...s.accountRegistrationStatuses,
      [data.email]: { state: 'registering', message: 'Registering...' }
    }
  }))
  try {
    const result = await invoke(IPC.ACCOUNTS_REGISTER, data)
    set((s) => ({
      accountRegistrationStatuses: {
        ...s.accountRegistrationStatuses,
        [data.email]: result.success
          ? { state: 'success', message: 'Registered — check email to verify' }
          : { state: 'error', message: result.error || result.alreadyExists ? 'Already registered' : 'Registration failed' }
      }
    }))
    if (result.success) get().loadAccounts()
    return result
  } catch (err) {
    set((s) => ({
      accountRegistrationStatuses: {
        ...s.accountRegistrationStatuses,
        [data.email]: { state: 'error', message: err.message }
      }
    }))
    return { success: false, error: err.message }
  }
},

setAccountStatus: async (id, status) => {
  await invoke(IPC.ACCOUNTS_SET_STATUS, id, status)
  get().loadAccounts()
},

setAccountRegistrationStatus: (email, data) =>
  set((s) => ({
    accountRegistrationStatuses: { ...s.accountRegistrationStatuses, [email]: data }
  })),
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/store/appStore.js
git commit -m "feat: registerAccount, setAccountStatus, accountRegistrationStatuses in store"
```

---

### Task 10: App.jsx — listen for account:status push events

**Files:**
- Modify: `src/renderer/src/App.jsx`

- [ ] **Step 1: Destructure new store actions and wire up IPC listener**

Update the `useAppStore` destructure call and `useEffect` in `App.jsx`:

```js
const { loadTasks, loadAccounts, loadSettings, pushFeedEvent, setTaskStatus, setAccountRegistrationStatus } = useAppStore()

useEffect(() => {
  const ipc = window.electron?.ipcRenderer
  loadTasks()
  loadAccounts()
  loadSettings()
  if (ipc) {
    ipc.on(IPC.FEED_EVENT, (_event, data) => pushFeedEvent(data))
    ipc.on(IPC.TASK_STATUS, (_event, { taskId, status }) => setTaskStatus(taskId, status))
    ipc.on(IPC.ACCOUNT_STATUS, (_event, data) => {
      loadAccounts()
      if (data?.email) setAccountRegistrationStatus(data.email, { state: 'success', message: data.message })
    })
  }
  return () => {
    ipc?.removeAllListeners(IPC.FEED_EVENT)
    ipc?.removeAllListeners(IPC.TASK_STATUS)
    ipc?.removeAllListeners(IPC.ACCOUNT_STATUS)
  }
}, [])
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/App.jsx
git commit -m "feat: listen for account:status IPC push events in App.jsx"
```

---

### Task 11: Accounts.jsx — UI changes

**Files:**
- Modify: `src/renderer/src/pages/Accounts.jsx`

- [ ] **Step 1: Import new store actions and add state**

Update the store destructure at the top of `Accounts()`:

```js
const { accounts, createAccount, deleteAccount, settings, registerAccount, setAccountStatus, accountRegistrationStatuses } = useAppStore()
```

Add a state variable for the "register on site" toggle:

```js
const [registerOnSite, setRegisterOnSite] = useState(false)
const [registerStatus, setRegisterStatus] = useState('')
const [bulkCreateRows, setBulkCreateRows] = useState('')
const [bulkCreateStatus, setBulkCreateStatus] = useState('')
```

- [ ] **Step 2: Update `submit` handler to support register mode**

Replace the existing `submit` function:

```js
const submit = async (event) => {
  event.preventDefault()
  const accountData = { ...form, name: form.name || makeAccountName(form) }
  if (registerOnSite) {
    setRegisterStatus('Registering...')
    const result = await registerAccount({
      ...accountData,
      email: form.username,
      firstName: form.shipping.firstName,
      lastName: form.shipping.lastName,
      phone: form.shipping.phone
    })
    if (result.success) {
      setRegisterStatus('Registered — check email to verify')
      setShowForm(false)
      setForm(makeEmptyForm())
      setRegisterOnSite(false)
    } else {
      setRegisterStatus(result.alreadyExists ? 'Already registered on site' : result.error || 'Registration failed')
    }
  } else {
    await createAccount(accountData)
    setShowForm(false)
    setForm(makeEmptyForm())
  }
}
```

- [ ] **Step 3: Add "Register on Site" checkbox to the form**

After the existing `<button type="submit">Save Account</button>` in the form, add the checkbox above it:

```jsx
<div className="flex items-center gap-2">
  <input
    type="checkbox"
    id="registerOnSite"
    checked={registerOnSite}
    onChange={(e) => setRegisterOnSite(e.target.checked)}
    className="accent-red-600"
  />
  <label htmlFor="registerOnSite" className="text-gray-400 uppercase tracking-wider">
    Register on site (bot creates account)
  </label>
</div>

{registerStatus && (
  <div className={`text-xs ${registerStatus.includes('fail') || registerStatus.includes('error') || registerStatus.includes('Already') ? 'text-red-400' : 'text-green-400'}`}>
    {registerStatus}
  </div>
)}

<button
  type="submit"
  className="w-full bg-red-600 hover:bg-red-500 text-white rounded px-4 py-2 uppercase tracking-wider font-bold text-xs"
>
  {registerOnSite ? 'Register on Site' : 'Save Account'}
</button>
```

- [ ] **Step 4: Add bulk "Create on Site" panel**

Add a new section after the existing bulk-import section (before the accounts list):

```jsx
<section className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-xs">
  <div>
    <h3 className="text-gray-400 uppercase tracking-widest mb-1">Bulk Create on Site</h3>
    <p className="text-gray-600">
      Bot registers each account on Target/Walmart. Same CSV format as bulk import.
    </p>
  </div>
  <textarea
    value={bulkCreateRows}
    onChange={(e) => setBulkCreateRows(e.target.value)}
    rows={4}
    placeholder="target,user@email.com,password,Ash,Ketchum,1 Pallet Town,,Pallet,CA,90210,5551234567"
    className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-2 py-1.5 text-gray-200"
  />
  <div className="flex items-center gap-3">
    <button
      type="button"
      onClick={bulkCreateOnSite}
      disabled={!bulkCreateRows.trim()}
      className="text-xs border border-red-700 text-red-400 hover:border-red-500 disabled:border-gray-800 disabled:text-gray-700 px-3 py-1.5 rounded uppercase tracking-wider font-bold"
    >
      Create Accounts on Site
    </button>
    <span className="text-gray-600">{bulkCreateStatus}</span>
  </div>
</section>
```

- [ ] **Step 5: Add `bulkCreateOnSite` handler**

Add this function inside the `Accounts` component (near `importBulkAccounts`):

```js
const bulkCreateOnSite = async () => {
  const rows = parseBulkRows(bulkCreateRows)
  if (rows.length === 0) {
    setBulkCreateStatus('No valid rows found')
    return
  }
  let succeeded = 0
  let failed = 0
  for (let i = 0; i < rows.length; i++) {
    setBulkCreateStatus(`Registering ${i + 1}/${rows.length}...`)
    const row = rows[i]
    const result = await registerAccount({
      ...row,
      email: row.username,
      firstName: row.shipping.firstName,
      lastName: row.shipping.lastName,
      phone: row.shipping.phone
    })
    if (result.success) succeeded++
    else failed++
  }
  setBulkCreateRows('')
  setBulkCreateStatus(`Done: ${succeeded} registered, ${failed} failed`)
}
```

- [ ] **Step 6: Add status badges to account list**

In the account list item `<div>` inside `accounts.map()`, add a status badge after the `{account.name}` line:

```jsx
<div className="flex items-center gap-2">
  <span className="text-gray-200">{account.name}</span>
  {account.status === 'unverified' && (
    <span className="text-yellow-500 border border-yellow-700 rounded px-1 py-0.5 text-xs uppercase tracking-wider">
      unverified
    </span>
  )}
  {account.status === 'verified' && (
    <span className="text-green-500 border border-green-700 rounded px-1 py-0.5 text-xs uppercase tracking-wider">
      verified
    </span>
  )}
</div>
```

And add a "Mark Verified" button next to the delete button for unverified accounts:

```jsx
{account.status === 'unverified' && (
  <button
    onClick={() => setAccountStatus(account.id, 'verified')}
    className="text-green-600 hover:text-green-400 shrink-0 text-xs"
  >
    mark verified
  </button>
)}
<button
  onClick={() => deleteAccount(account.id)}
  className="text-red-600 hover:text-red-400 shrink-0"
>
  delete
</button>
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/pages/Accounts.jsx
git commit -m "feat: accounts UI — register on site toggle, bulk create panel, status badges"
```

---

### Task 12: Run all tests

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: all existing tests still PASS, new registration + status tests PASS

- [ ] **Step 2: Fix any failures**

If `AccountManager` tests fail due to column count mismatch in `JsonDb`, verify `TABLE_COLUMNS.accounts` includes `status` (Task 1 Step 1).

If registration flow tests fail on selector mismatch, check mock `count()` returns correct values for `isConfirm`/`isErrorEl` patterns.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: test adjustments after full suite run"
```
