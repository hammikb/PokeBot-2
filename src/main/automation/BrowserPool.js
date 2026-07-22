import { launchPersistentContext } from 'cloakbrowser'
import { mkdirSync } from 'fs'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('BrowserPool')
const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

// Shape cookie configuration
const SHAPE_REFRESH_INTERVAL = 30 * 1000 // 30 seconds - MORE FREQUENT
const SHAPE_COOKIE_NAMES = ['_shapes', 'shape', '_sfid', '_sctr', '_sdid']
const SHAPE_MAX_RETRIES = 10 // More retries before warning

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
    this._refreshTimers = new Map()
    this._shapeRetryCount = new Map()
    this._shapeEstablished = new Map()
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

  async _refreshShapeSession(accountId, context) {
    try {
      const pages = context.pages()
      let page = pages.length > 0 ? pages[0] : await context.newPage()

      // CRITICAL: Always ensure we're on Target.com
      const currentUrl = page.url()
      if (!currentUrl.includes('target.com')) {
        log.debug('Navigating to Target for Shape refresh', { accountId })
        await page.goto('https://www.target.com', {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        })
        // Wait for page to settle
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      // CRITICAL: Simulate human-like behavior to trigger Shape
      // Shape activates on mouse movement and scrolling
      for (let i = 0; i < 3; i++) {
        await page.mouse.move(
          Math.floor(Math.random() * 1200) + 100,
          Math.floor(Math.random() * 800) + 100
        )
        await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 500))
      }

      // Scroll a bit
      await page.evaluate(() => {
        window.scrollBy(0, Math.floor(Math.random() * 200) + 50)
      })

      // Wait for Shape scripts to execute
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Check for Shape cookies
      const cookies = await context.cookies('https://www.target.com')
      const shapeCookies = cookies.filter((c) =>
        SHAPE_COOKIE_NAMES.some((name) => c.name.toLowerCase().includes(name))
      )

      const hasShape = shapeCookies.length > 0
      this._shapeEstablished.set(accountId, hasShape)

      if (hasShape) {
        this._shapeRetryCount.set(accountId, 0)
        log.info('✅ Shape session established!', {
          accountId,
          cookies: shapeCookies.map((c) => c.name),
          domains: shapeCookies.map((c) => c.domain)
        })
      } else {
        const retries = (this._shapeRetryCount.get(accountId) || 0) + 1
        this._shapeRetryCount.set(accountId, retries)

        if (retries <= SHAPE_MAX_RETRIES) {
          log.debug('Waiting for Shape cookies to be set', {
            accountId,
            attempt: retries,
            maxRetries: SHAPE_MAX_RETRIES
          })
        } else if (retries === SHAPE_MAX_RETRIES + 1) {
          log.warn('⚠️ Shape cookies not established - check proxy/network', {
            accountId,
            attempts: retries,
            url: currentUrl,
            hasProxy: this._proxyByAccount.has(accountId)
          })
        }
      }

      this._updateActivity(accountId)
    } catch (err) {
      log.error('Failed to refresh Shape session', {
        accountId,
        error: err.message
      })
    }
  }

  _startShapeRefreshLoop(accountId, context) {
    if (this._refreshTimers.has(accountId)) {
      clearInterval(this._refreshTimers.get(accountId))
      this._refreshTimers.delete(accountId)
    }

    this._shapeRetryCount.set(accountId, 0)
    this._shapeEstablished.set(accountId, false)

    log.info('Starting Shape refresh loop', {
      accountId,
      interval: SHAPE_REFRESH_INTERVAL
    })

    // Do an immediate refresh with more aggressive behavior
    setTimeout(() => {
      this._refreshShapeSession(accountId, context).catch((err) => {
        log.error('Initial Shape refresh failed', { accountId, error: err.message })
      })
    }, 3000)

    const timer = setInterval(() => {
      if (this._active.has(accountId)) {
        const ctx = this._active.get(accountId)
        if (isContextOpen(ctx)) {
          this._refreshShapeSession(accountId, ctx).catch((err) => {
            log.error('Periodic Shape refresh failed', { accountId, error: err.message })
          })
        } else {
          this._stopShapeRefreshLoop(accountId)
        }
      } else {
        this._stopShapeRefreshLoop(accountId)
      }
    }, SHAPE_REFRESH_INTERVAL)

    this._refreshTimers.set(accountId, timer)
  }

  _stopShapeRefreshLoop(accountId) {
    if (this._refreshTimers.has(accountId)) {
      clearInterval(this._refreshTimers.get(accountId))
      this._refreshTimers.delete(accountId)
      this._shapeRetryCount.delete(accountId)
      this._shapeEstablished.delete(accountId)
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
        this._startShapeRefreshLoop(accountId, context)
        return context
      }
      this._active.delete(accountId)
      this._lastActivity.delete(accountId)
      this._proxyByAccount.delete(accountId)
      this._stopShapeRefreshLoop(accountId)
    }

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

    // CRITICAL: More realistic browser arguments
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
        '--disable-features=TranslateUI,ChromeWhatsNewUI,MediaRouter',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--mute-audio',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--disable-blink-features=AutomationControlled',
        // CRITICAL: Use a realistic user agent
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    }

    const proxyUrl = buildProxyUrl(proxy)
    if (proxyUrl) {
      contextOptions.proxy = proxyUrl
      log.info('Using proxy for browser', { accountId, proxy: proxyUrl })
    } else {
      log.warn('No proxy configured - Target may block this connection', { accountId })
    }

    try {
      log.info('Launching CloakBrowser context with binary-level stealth', {
        accountId,
        proxy: Boolean(proxyUrl)
      })
      const context = await launchPersistentContext(contextOptions)

      // CRITICAL: Navigate to Target with realistic expectations
      try {
        const page = await context.newPage()
        log.info('Navigating to Target.com', { accountId })
        await page.goto('https://www.target.com', {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        })
        log.info('Initial Target navigation completed', { accountId })

        // CRITICAL: Wait for page to fully initialize
        await new Promise((resolve) => setTimeout(resolve, 5000))

        // CRITICAL: Do some initial mouse movement to trigger Shape
        await page.mouse.move(500, 400)
        await new Promise((resolve) => setTimeout(resolve, 500))
        await page.mouse.move(700, 300)
      } catch (navErr) {
        log.warn('Initial Target navigation failed, will retry via refresh loop', {
          accountId,
          error: navErr.message
        })
      }

      this._active.set(accountId, context)
      this._proxyByAccount.set(accountId, proxyUrl)
      this._updateActivity(accountId)

      context.on?.('close', () => {
        if (this._active.get(accountId) === context) {
          this._active.delete(accountId)
          this._lastActivity.delete(accountId)
          this._proxyByAccount.delete(accountId)
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

  async launchContext({ accountId = 'monitor', proxy = null } = {}) {
    const { tmpdir } = await import('os')
    const { join } = await import('path')
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
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    }

    const proxyUrl = buildProxyUrl(proxy)
    if (proxyUrl) contextOptions.proxy = proxyUrl

    log.info('Launching ephemeral monitor context', { accountId, proxy: Boolean(proxyUrl) })
    const context = await launchPersistentContext(contextOptions)

    try {
      const page = await context.newPage()
      await page.goto('https://www.target.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } catch {
      // Monitors can fail silently
    }

    return context
  }

  async close(accountId) {
    this._stopShapeRefreshLoop(accountId)

    const ctx = this._active.get(accountId)
    if (ctx) {
      try {
        await ctx.close()
      } catch {
        // Best effort cleanup
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

  async hasValidShapeSession(accountId) {
    const context = this._active.get(accountId)
    if (!context || !isContextOpen(context)) return false

    try {
      const cookies = await context.cookies('https://www.target.com')
      const hasShape = cookies.some((c) =>
        SHAPE_COOKIE_NAMES.some((name) => c.name.toLowerCase().includes(name))
      )
      return hasShape
    } catch {
      return false
    }
  }

  isShapeEstablished(accountId) {
    return this._shapeEstablished.get(accountId) || false
  }

  getShapeRetryCount(accountId) {
    return this._shapeRetryCount.get(accountId) || 0
  }
}

function isContextOpen(context) {
  try {
    return Boolean(context?.browser?.())
  } catch {
    return false
  }
}

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
