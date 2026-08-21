/**
 * walmartSession — per-account Walmart session cookies for the HTTP queue API.
 *
 * The queue endpoints (issueTicket / validateTickets) are session-bound: they
 * need `auth`, `CID` and a live `_px3` PerimeterX token, which only exist in a
 * signed-in browser profile. Those are read out of the account's Playwright
 * context and cached — encrypted — in `walmart_sessions`.
 *
 * Persisting matters: if Electron closes or crashes while tickets are held, the
 * spots in line are still valid (they live in Walmart's `wr` cookie, signed and
 * with an expiry). Re-reading every browser profile on restart is slow and can
 * fail, so cookies are restored from disk first and refreshed in the background.
 *
 * WalmartQueueHost asks for a header synchronously on a timer, so `header()` is
 * a plain getter over the cache and refreshing happens out of band.
 */
import { encrypt, decrypt } from '../crypto.js'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('walmartSession')

const WALMART_URL = 'https://www.walmart.com'
// _px3 rotates often; a stale header reads as a bot to PerimeterX.
const DEFAULT_TTL_MS = 120_000
const DEFAULT_REFRESH_MS = 90_000
const SETTINGS_PREFIX = 'walmartSession:'

/** Cookie objects -> a `name=value; name=value` request header. */
export function toCookieHeader(cookies = []) {
  return cookies
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

/** True if this jar looks like a usable signed-in Walmart session. */
export function isUsableSession(cookies = []) {
  const names = new Set(cookies.map((c) => c?.name))
  // `auth` proves sign-in; `_px3` is the PerimeterX token the API checks.
  return names.has('auth') && names.has('_px3')
}

export class WalmartCookieSource {
  constructor({
    browserPool,
    accountManager,
    getDb,
    encryptionKey,
    ttlMs = DEFAULT_TTL_MS,
    refreshMs = DEFAULT_REFRESH_MS
  } = {}) {
    this._browserPool = browserPool
    this._accountManager = accountManager
    this._getDb = getDb
    this._key = encryptionKey
    this._ttlMs = ttlMs
    this._refreshMs = refreshMs
    this._sessions = new Map() // accountId -> { header, fetchedAt, error }
    this._activeId = null
    this._refreshing = new Map()
    this._timer = null
  }

  /* ----------------------------- persistence ----------------------------- */

  _db() {
    try {
      return this._getDb?.() || null
    } catch {
      return null
    }
  }

  /** Restore cached cookies from disk. Call once at startup. */
  load() {
    const db = this._db()
    if (!db) return 0
    let restored = 0
    try {
      const rows = db.prepare('SELECT key, value FROM settings').all()
      for (const row of rows) {
        if (!String(row.key || '').startsWith(SETTINGS_PREFIX)) continue
        const accountId = String(row.key).slice(SETTINGS_PREFIX.length)
        try {
          const stored = JSON.parse(row.value)
          const header = decrypt(stored.cookie_enc, this._key)
          if (!header) continue
          this._sessions.set(accountId, {
            header,
            fetchedAt: Number(stored.updated_at) || 0,
            error: null
          })
          this._activeId = this._activeId || accountId
          restored += 1
        } catch {
          log.warn('Could not decrypt stored Walmart session', { accountId })
        }
      }
    } catch (error) {
      log.warn('Could not load stored Walmart sessions', { error: error.message })
    }
    if (restored) log.info('Restored Walmart sessions from disk', { count: restored })
    return restored
  }

  _persist(accountId, header) {
    const db = this._db()
    if (!db) return
    try {
      // settings(key,value) rather than a dedicated table: JsonDb.exec() is a
      // no-op, so CREATE TABLE never runs and a new table would not exist.
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        `${SETTINGS_PREFIX}${accountId}`,
        JSON.stringify({ cookie_enc: encrypt(header, this._key), updated_at: Date.now() })
      )
    } catch (error) {
      log.warn('Could not persist Walmart session', { accountId, error: error.message })
    }
  }

  forget(accountId) {
    this._sessions.delete(accountId)
    if (this._activeId === accountId) this._activeId = null
    try {
      this._db()
        ?.prepare('DELETE FROM settings WHERE key = ?')
        .run(`${SETTINGS_PREFIX}${accountId}`)
    } catch {
      /* best effort */
    }
  }

  /* ------------------------------- reading ------------------------------- */

  /** Synchronous accessor for WalmartQueueHost. */
  header(accountId = null) {
    const id = accountId || this._activeId || this._sessions.keys().next().value
    return (id && this._sessions.get(id)?.header) || ''
  }

  status(accountId = null) {
    const id = accountId || this._activeId
    const entry = id ? this._sessions.get(id) : null
    return {
      accountId: id || null,
      hasSession: Boolean(entry?.header),
      ageMs: entry?.fetchedAt ? Date.now() - entry.fetchedAt : null,
      stale: entry?.fetchedAt ? Date.now() - entry.fetchedAt > this._ttlMs : false,
      error: entry?.error || this._lastError || null,
      accounts: [...this._sessions.entries()].map(([accId, e]) => ({
        accountId: accId,
        hasSession: Boolean(e.header),
        ageMs: e.fetchedAt ? Date.now() - e.fetchedAt : null
      }))
    }
  }

  _walmartAccounts() {
    return (this._accountManager?.getAll?.() || []).filter((a) => a.retailer === 'walmart')
  }

  _pickAccount(accountId = null) {
    const walmart = this._walmartAccounts()
    if (accountId) return walmart.find((a) => a.id === accountId) || null
    return walmart.find((a) => a.status === 'active') || walmart[0] || null
  }

  /**
   * Push a cookie back INTO the signed-in browser context.
   *
   * Tickets are taken over HTTP, so the `wr` cookie lands in the HTTP client
   * and the browser never learns about it: walmart.com shows no queue, and
   * when a queue admits you the browser cannot check out. Writing it back
   * keeps the two views of the session in sync.
   */
  async writeCookie(accountId, name, value) {
    const account = this._pickAccount(accountId)
    if (!account || !name || !value) return false
    const decrypted = this._accountManager.getDecrypted(account.id) || account
    try {
      const context = await this._browserPool.launch(decrypted.id, {
        profilePath: decrypted.profile_path,
        proxy: decrypted.proxy,
        retailer: 'walmart',
        priority: 30
      })
      await context.addCookies([
        { name, value, domain: '.walmart.com', path: '/', secure: true, sameSite: 'Lax' }
      ])
      log.info('Wrote queue cookie into browser session', { accountId: decrypted.id, name })
      return true
    } catch (error) {
      log.warn('Could not write queue cookie into browser session', { error: error.message })
      return false
    }
  }

  /**
   * Fetch a Walmart page through the signed-in browser context.
   *
   * PerimeterX blocks axios on /search regardless of cookies -- it keys on the
   * TLS fingerprint, and the Pi needed a safari17_0 impersonation for the same
   * URL. The stealth browser already passes, so use it for the pages axios
   * cannot reach. Uses a transient page and closes it straight away.
   */
  async fetchPage(url, { timeoutMs = 45_000 } = {}) {
    const account = this._pickAccount()
    if (!account) throw new Error('No Walmart account configured')
    const decrypted = this._accountManager.getDecrypted(account.id) || account
    let page = null
    try {
      const context = await this._browserPool.launch(decrypted.id, {
        profilePath: decrypted.profile_path,
        proxy: decrypted.proxy,
        retailer: 'walmart',
        priority: 30
      })
      page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      return await page.content()
    } finally {
      await page?.close().catch(() => {})
    }
  }

  /* ------------------------------ refreshing ----------------------------- */

  async refresh(accountId = null) {
    const account = this._pickAccount(accountId)
    if (!account) {
      this._lastError = 'No Walmart account configured'
      return this.status()
    }
    const id = account.id
    if (this._refreshing.has(id)) return this._refreshing.get(id)
    const job = this._doRefresh(account).finally(() => this._refreshing.delete(id))
    this._refreshing.set(id, job)
    return job
  }

  /** Refresh every Walmart account, so any of them can hold tickets. */
  async refreshAll() {
    for (const account of this._walmartAccounts()) {
      await this.refresh(account.id).catch(() => {})
    }
    return this.status()
  }

  async _doRefresh(account) {
    const decrypted = this._accountManager.getDecrypted(account.id) || account
    try {
      const context = await this._browserPool.launch(decrypted.id, {
        profilePath: decrypted.profile_path,
        proxy: decrypted.proxy,
        retailer: 'walmart',
        // Higher number is served first (BrowserPool sorts descending). Reading
        // cookies is fast and blocks queue joining, so it outranks the routine
        // account-session launches at priority 20.
        priority: 30
      })
      const cookies = await context.cookies(WALMART_URL)
      if (!isUsableSession(cookies)) {
        const message = 'Walmart profile is not signed in (missing auth/_px3 cookies)'
        this._sessions.set(decrypted.id, {
          ...(this._sessions.get(decrypted.id) || {}),
          error: message
        })
        this._lastError = message
        log.warn('Walmart session unusable', { accountId: decrypted.id })
        return this.status(decrypted.id)
      }
      const header = toCookieHeader(cookies)
      this._sessions.set(decrypted.id, { header, fetchedAt: Date.now(), error: null })
      this._activeId = this._activeId || decrypted.id
      this._persist(decrypted.id, header)
      this._lastError = null
      log.info('Walmart session cookies refreshed', {
        accountId: decrypted.id,
        cookieCount: cookies.length
      })
    } catch (error) {
      this._lastError = error.message
      this._sessions.set(account.id, {
        ...(this._sessions.get(account.id) || {}),
        error: error.message
      })
      log.warn('Walmart session refresh failed', { error: error.message })
    }
    return this.status(account.id)
  }

  /**
   * Wait briefly for cookies to become available. Auto-join can fire seconds
   * before the first refresh completes; failing outright there loses the drop,
   * so callers wait instead.
   */
  async waitForSession(timeoutMs = 45_000) {
    if (this.header()) return true
    const deadline = Date.now() + timeoutMs
    this.refresh().catch(() => {})
    while (Date.now() < deadline) {
      if (this.header()) return true
      await new Promise((r) => setTimeout(r, 1000))
    }
    return Boolean(this.header())
  }

  /** Keep cookies warm so a drop never waits on a browser launch. */
  startAutoRefresh() {
    if (this._timer) return
    const tick = async () => {
      await this.refreshAll().catch(() => {})
      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = setTimeout(tick, this._refreshMs)
      }
    }
    this._timer = setTimeout(tick, 0)
  }

  stopAutoRefresh() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
  }
}
