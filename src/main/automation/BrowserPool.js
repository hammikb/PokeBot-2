import { launchPersistentContext } from 'cloakbrowser'
import { mkdirSync } from 'fs'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('BrowserPool')
const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

// [TARGET] Shape cookies on Target are very short-lived. We need to refresh them often.
const SHAPE_REFRESH_INTERVAL = 45 * 1000 // 45 seconds - keep Shape tokens alive
const SHAPE_COOKIE_NAMES = ['_shapes', 'shape', '_sfid', '_sctr', '_sdid'] // Common Shape cookie names

export class BrowserPool {
  constructor({ maxConcurrent = 3, contextTimeout = DEFAULT_TIMEOUT } = {}) {
    this._maxConcurrent = maxConcurrent
    this._contextTimeout = contextTimeout
    this._active = new Map()
    this._pending = new Map()
    this._pendingProxy = new Map()
    this._pinned = new Set()
    this._lastActivity = new Map()
    this._proxyByAccount = new Map()
    this._healthCheckTimer = null
    // [TARGET] Track refresh timers per account so we can clean them up
    this._refreshTimers = new Map()
    this._startHealthCheck()
  }

  _startHealthCheck() {
    this._healthCheckTimer = setInterval(() => {
      this._checkStaleContexts()
    }, HEALTH_CHECK_INTERVAL)
  }

  _checkStaleContexts() {
    const now = Date.now()
    for (const [accountId, lastActivity] of this._lastActivity.entries()) {
      if (this._pinned.has(accountId)) continue
      if (now - lastActivity > this._contextTimeout) {
        log.warn('Closing stale browser context', { accountId, idleTime: now - lastActivity })
        this.close(accountId).catch((err) => {
          log.error('Failed to close stale context', { accountId, error: err.message })
        })
      }
    }
  }

  _updateActivity(accountId) {
    this._lastActivity.set(accountId, Date.now())
  }

  // [TARGET] New method: refresh Shape cookies by simulating human-like activity
  async _refreshShapeSession(accountId, context) {
    try {
      // Get or create a page for this context
      const pages = context.pages()
      let page = pages.length > 0 ? pages[0] : await context.newPage()

      // [TARGET] If we're not on Target, navigate there quietly to refresh the session
      const currentUrl = page.url()
      if (!currentUrl.includes('target.com')) {
        await page.goto('https://www.target.com', { waitUntil: 'networkidle', timeout: 10000 })
      }

      // [TARGET] Simulate human-like activity to keep Shape happy
      await page.mouse.move(
        Math.floor(Math.random() * 800) + 100,
        Math.floor(Math.random() * 600) + 100
      )

      // [TARGET] Perform a small scroll to mimic browsing
      await page.evaluate(() => {
        window.scrollBy(0, Math.floor(Math.random() * 50) + 10)
      })

      // [TARGET] Check if Shape cookies exist and log their status
      const cookies = await context.cookies()
      const shapeCookies = cookies.filter((c) =>
        SHAPE_COOKIE_NAMES.some((name) => c.name.toLowerCase().includes(name))
      )

      if (shapeCookies.length > 0) {
        log.debug('Shape session refreshed', {
          accountId,
          cookies: shapeCookies.map((c) => c.name)
        })
      } else {
        log.warn('No Shape cookies found after refresh attempt', { accountId })
      }

      this._updateActivity(accountId)
    } catch (err) {
      log.error('Failed to refresh Shape session', { accountId, error: err.message })
      // [TARGET] Don't throw - just log. We'll retry on next interval.
    }
  }

  // [TARGET] Start the Shape refresh loop for an account
  _startShapeRefreshLoop(accountId, context) {
    // Clear any existing timer for this account
    if (this._refreshTimers.has(accountId)) {
      clearInterval(this._refreshTimers.get(accountId))
      this._refreshTimers.delete(accountId)
    }

    log.info('Starting Shape refresh loop', { accountId, interval: SHAPE_REFRESH_INTERVAL })

    // [TARGET] Do an immediate refresh to ensure we have Shape cookies from the start
    this._refreshShapeSession(accountId, context).catch((err) => {
      log.error('Initial Shape refresh failed', { accountId, error: err.message })
    })

    // [TARGET] Set up the recurring refresh
    const timer = setInterval(() => {
      // Only refresh if the context is still active
      if (this._active.has(accountId)) {
        const ctx = this._active.get(accountId)
        if (isContextOpen(ctx)) {
          this._refreshShapeSession(accountId, ctx).catch((err) => {
            log.error('Periodic Shape refresh failed', { accountId, error: err.message })
          })
        } else {
          // [TARGET] If context is closed, clean up the timer
          log.warn('Context closed during Shape refresh loop', { accountId })
          this._stopShapeRefreshLoop(accountId)
        }
      } else {
        this._stopShapeRefreshLoop(accountId)
      }
    }, SHAPE_REFRESH_INTERVAL)

    this._refreshTimers.set(accountId, timer)
  }

  // [TARGET] Stop the Shape refresh loop for an account
  _stopShapeRefreshLoop(accountId) {
    if (this._refreshTimers.has(accountId)) {
      clearInterval(this._refreshTimers.get(accountId))
      this._refreshTimers.delete(accountId)
      log.info('Stopped Shape refresh loop', { accountId })
    }
  }

  async launch(accountId, { profilePath, proxy }) {
    const requestedProxy = buildProxyUrl(proxy)
    if (this._active.has(accountId)) {
      const context = this._active.get(accountId)
      if (isContextOpen(context)) {
        if (this._proxyByAccount.get(accountId) !== requestedProxy) {
          throw new Error(
            'Refusing to move an active account session to a different proxy; close it first'
          )
        }
        this._updateActivity(accountId)
        // [TARGET] Ensure the Shape refresh loop is running for this account
        this._startShapeRefreshLoop(accountId, context)
        return context
      }
      this._active.delete(accountId)
      this._lastActivity.delete(accountId)
      this._proxyByAccount.delete(accountId)
      this._stopShapeRefreshLoop(accountId)
    }
    // Two queue jobs can request the same account profile at nearly the same
    // time. Share the first launch promise so Chromium never receives two
    // launchPersistentContext calls for one user-data directory.
    if (this._pending.has(accountId)) {
      if (this._pendingProxy.get(accountId) !== requestedProxy) {
        throw new Error('Refusing concurrent launches for one account with different proxies')
      }
      return this._pending.get(accountId)
    }

    const pending = this._launchNew(accountId, { profilePath, proxy })
    this._pending.set(accountId, pending)
    this._pendingProxy.set(accountId, requestedProxy)
    try {
      const context = await pending
      // [TARGET] Start the Shape refresh loop for the new context
      this._startShapeRefreshLoop(accountId, context)
      return context
    } finally {
      if (this._pending.get(accountId) === pending) {
        this._pending.delete(accountId)
        this._pendingProxy.delete(accountId)
      }
    }
  }

  async pin(accountId, options) {
    this._pinned.add(accountId)
    try {
      return await this.launch(accountId, options)
    } catch (err) {
      this._pinned.delete(accountId)
      throw err
    }
  }

  async unpin(accountId, { close = false } = {}) {
    this._pinned.delete(accountId)
    // [TARGET] Stop the Shape refresh loop before closing
    if (close) {
      this._stopShapeRefreshLoop(accountId)
      await this.close(accountId)
    }
  }

  isPinned(accountId) {
    return this._pinned.has(accountId)
  }

  async _launchNew(accountId, { profilePath, proxy }) {
    if (this._active.size + this._pending.size >= this._maxConcurrent) {
      log.error('Browser pool at capacity', { maxConcurrent: this._maxConcurrent })
      throw new Error(`Browser pool at max capacity (${this._maxConcurrent})`)
    }

    try {
      mkdirSync(profilePath, { recursive: true })
    } catch (err) {
      log.error('Failed to create profile directory', { profilePath, error: err.message })
      throw err
    }

    // CloakBrowser applies stealth at the Chromium binary level (58 source-level
    // C++ patches covering webdriver, canvas, WebGL, audio, fonts, WebRTC, CDP, etc.),
    // so the manual JS init-script spoofing previously required by patchright is no
    // longer needed and would actually risk creating detectable inconsistencies.
    const contextOptions = {
      userDataDir: profilePath,
      headless: false,
      humanize: true,
      geoip: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--mute-audio',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        // [TARGET] Additional args to make fingerprint more consistent for Shape
        '--disable-blink-features=AutomationControlled',
        '--disable-features=ChromeWhatsNewUI',
        '--disable-features=MediaRouter'
      ]
    }

    const proxyUrl = buildProxyUrl(proxy)
    if (proxyUrl) contextOptions.proxy = proxyUrl

    try {
      log.info('Launching CloakBrowser context with binary-level stealth', {
        accountId,
        proxy: Boolean(proxyUrl)
      })
      const context = await launchPersistentContext(contextOptions)

      // [TARGET] Navigate to Target immediately to start building the session
      try {
        const page = await context.newPage()
        await page.goto('https://www.target.com', { waitUntil: 'networkidle', timeout: 30000 })
        log.info('Initial Target navigation completed', { accountId })
      } catch (navErr) {
        log.warn('Initial Target navigation failed, will retry via refresh loop', {
          accountId,
          error: navErr.message
        })
        // [TARGET] The refresh loop will handle recovery
      }

      this._active.set(accountId, context)
      this._proxyByAccount.set(accountId, proxyUrl)
      this._updateActivity(accountId)

      context.on?.('close', () => {
        if (this._active.get(accountId) === context) {
          this._active.delete(accountId)
          this._lastActivity.delete(accountId)
          this._proxyByAccount.delete(accountId)
          // [TARGET] Clean up refresh timer when context closes
          this._stopShapeRefreshLoop(accountId)
          log.info('Browser context closed', { accountId })
        }
      })
      return context
    } catch (err) {
      log.error('Failed to launch browser context', { accountId, error: err.message })
      throw err
    }
  }

  /**
   * Launch a lightweight ephemeral context for monitoring (no persistent profile).
   * Uses a temp directory so it doesn't pollute account profiles.
   * Returns the context directly (not stored in the pool — caller must close it).
   */
  async launchContext({ accountId = 'monitor', proxy = null } = {}) {
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    // Use a STABLE path (no timestamp) so cookies persist across context
    // recreations. This is critical for Akamai — accumulated cookies mean
    // fewer challenges on subsequent visits.
    const profilePath = join(tmpdir(), `pokebot-monitor-${accountId}`)

    try {
      mkdirSync(profilePath, { recursive: true })
    } catch {
      // ignore
    }

    const contextOptions = {
      userDataDir: profilePath,
      headless: false,
      humanize: true,
      geoip: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--mute-audio',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        // [TARGET] Same fingerprint consistency args for monitor contexts
        '--disable-blink-features=AutomationControlled'
      ]
    }

    const proxyUrl = buildProxyUrl(proxy)
    if (proxyUrl) contextOptions.proxy = proxyUrl

    log.info('Launching ephemeral monitor context', { accountId, proxy: Boolean(proxyUrl) })
    const context = await launchPersistentContext(contextOptions)

    // [TARGET] Navigate to Target to build Shape session even for monitors
    try {
      const page = await context.newPage()
      await page.goto('https://www.target.com', { waitUntil: 'networkidle', timeout: 30000 })
    } catch {
      // Monitors can fail silently
    }

    return context
  }

  async close(accountId) {
    // [TARGET] Stop the Shape refresh loop when closing
    this._stopShapeRefreshLoop(accountId)

    const ctx = this._active.get(accountId)
    if (ctx) {
      try {
        await ctx.close()
      } catch {
        // Best effort cleanup; the browser may already be closed.
      }
      this._active.delete(accountId)
      this._proxyByAccount.delete(accountId)
    }
  }

  async closeAll() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer)
      this._healthCheckTimer = null
    }
    this._pinned.clear()

    // [TARGET] Stop all refresh loops
    for (const accountId of this._refreshTimers.keys()) {
      this._stopShapeRefreshLoop(accountId)
    }

    for (const id of [...this._active.keys()]) await this.close(id)
  }

  getActiveCount() {
    return this._active.size
  }

  isAtCapacity() {
    return this._active.size >= this._maxConcurrent
  }

  // [TARGET] New method to manually check if Shape cookies are present
  async hasValidShapeSession(accountId) {
    const context = this._active.get(accountId)
    if (!context || !isContextOpen(context)) return false

    try {
      const cookies = await context.cookies()
      const hasShape = cookies.some((c) =>
        SHAPE_COOKIE_NAMES.some((name) => c.name.toLowerCase().includes(name))
      )
      return hasShape
    } catch {
      return false
    }
  }
}

function isContextOpen(context) {
  try {
    return Boolean(context?.browser?.())
  } catch {
    return false
  }
}

/**
 * Convert a `host:port[:username:password]` proxy string into the URL form
 * that CloakBrowser expects (e.g. `http://user:pass@host:port`).
 * Returns null when no usable proxy is provided.
 */
export function buildProxyUrl(proxy) {
  if (!proxy) return null
  const parts = String(proxy).trim().split(':')
  if (parts.length < 2) return null

  const [host, port, username, ...passwordParts] = parts
  if (!host || !port) return null

  if (username) {
    const password = passwordParts.join(':')
    const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    return `http://${auth}${host}:${port}`
  }

  return `http://${host}:${port}`
}
