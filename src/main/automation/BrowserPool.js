import { launchPersistentContext } from 'cloakbrowser'
import { mkdirSync } from 'fs'
import { createModuleLogger } from '../utils/logger.js'
import { buildCloakBrowserOptions, redactProxyUrl } from './cloakBrowserConfig.js'
import { isCaptchaPresent } from './captcha.js'

const log = createModuleLogger('BrowserPool')
const DEFAULT_TIMEOUT = 60 * 60 * 1000 // 60 minutes
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000

const SHAPE_COOKIE_NAMES = ['_shapes', 'shape', '_sfid', '_sctr', '_sdid']
// ~25 min with jitter: comfortably inside Akamai's ~1-2h sensor cookie lifetime, and
// jittered so repeated touches never land on a fixed machine-looking cadence.
const KEEPALIVE_BASE_MS = 22 * 60 * 1000
const KEEPALIVE_JITTER_MS = 7 * 60 * 1000

const RETAILER_HOME = {
  target: 'https://www.target.com/',
  walmart: 'https://www.walmart.com/',
  samsclub: 'https://www.samsclub.com/',
  'pokemon-center': 'https://www.pokemoncenter.com/'
}

export class BrowserPool {
  constructor({
    maxConcurrent = 3,
    contextTimeout = DEFAULT_TIMEOUT,
    setupWarmupMs = 1500,
    capacityWaitMs = 20_000,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    // Called with { accountId, retailer, reason } the first time a keepalive sees a
    // block. Lets the caller trip its circuit breaker without this pool importing one.
    onBlocked = null
  } = {}) {
    this._maxConcurrent = maxConcurrent
    this._contextTimeout = contextTimeout
    this._setupWarmupMs = setupWarmupMs
    this._capacityWaitMs = capacityWaitMs
    this._closeTimeoutMs = Math.max(100, Number(closeTimeoutMs) || DEFAULT_CLOSE_TIMEOUT_MS)
    this._onBlocked = onBlocked
    this._keepalive = new Map()
    this._warmPages = new Map()
    this._active = new Map()
    this._pending = new Map()
    this._pendingProxy = new Map()
    this._pinned = new Set()
    this._lastActivity = new Map()
    this._proxyByAccount = new Map()
    this._retailerByAccount = new Map()
    this._downloadsByAccount = new Map()
    this._healthCheckTimer = null
    this._capacityWaiters = []
    this._capacityReservations = new Set()
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

  async launch(
    accountId,
    { profilePath, proxy, retailer = null, priority = 0, waitTimeoutMs = this._capacityWaitMs }
  ) {
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
        return context
      }
      this._active.delete(accountId)
      this._lastActivity.delete(accountId)
      this._proxyByAccount.delete(accountId)
      this._retailerByAccount.delete(accountId)
    }

    if (this._pending.has(accountId)) {
      if (this._pendingProxy.get(accountId) !== requestedProxy) {
        throw new Error('Refusing concurrent launches for one account with different proxies')
      }
      return this._pending.get(accountId)
    }

    const pending = (async () => {
      const reservation = await this._waitForCapacity(accountId, priority, waitTimeoutMs)
      try {
        return await this._launchNew(accountId, { profilePath, proxy, retailer })
      } finally {
        this._capacityReservations.delete(reservation)
        this._drainCapacityWaiters()
      }
    })()
    this._pending.set(accountId, pending)
    this._pendingProxy.set(accountId, requestedProxy)
    try {
      return await pending
    } finally {
      if (this._pending.get(accountId) === pending) {
        this._pending.delete(accountId)
        this._pendingProxy.delete(accountId)
      }
      this._drainCapacityWaiters()
    }
  }

  async pin(accountId, options) {
    this._pinned.add(accountId)
    try {
      const context = await this.launch(accountId, options)
      this._startKeepalive(accountId, options?.retailer)
      return context
    } catch (err) {
      this._pinned.delete(accountId)
      throw err
    }
  }

  async unpin(accountId, { close = false } = {}) {
    this._pinned.delete(accountId)
    this._stopKeepalive(accountId)
    const warmPage = this._warmPages.get(accountId)
    this._warmPages.delete(accountId)
    await Promise.resolve(warmPage?.close?.()).catch(() => {})
    if (close) {
      await this.close(accountId)
    }
  }

  // A pinned context makes no requests while idle, so it is invisible to the retailer —
  // but its Akamai sensor cookies age out in ~1-2h, and re-validating them mid-drop is
  // exactly when the latency is unaffordable. A slow jittered touch keeps them fresh.
  _startKeepalive(accountId, retailer) {
    if (!retailer || !RETAILER_HOME[retailer]) return
    this._stopKeepalive(accountId)
    const delay = KEEPALIVE_BASE_MS + Math.floor(Math.random() * KEEPALIVE_JITTER_MS)
    const timer = setTimeout(() => {
      this._keepaliveTick(accountId, retailer).catch((err) => {
        log.warn('Keepalive tick failed', { accountId, retailer, error: err.message })
        // A transient nav failure is not a block; keep the rhythm rather than
        // tearing down a healthy warm context.
        if (this._pinned.has(accountId)) this._startKeepalive(accountId, retailer)
      })
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this._keepalive.set(accountId, timer)
  }

  _stopKeepalive(accountId) {
    const timer = this._keepalive.get(accountId)
    if (timer) clearTimeout(timer)
    this._keepalive.delete(accountId)
  }

  async _keepaliveTick(accountId, retailer) {
    const context = this._active.get(accountId)
    if (!context || !this._pinned.has(accountId)) return this._stopKeepalive(accountId)

    // Never open a maintenance page while a checkout (or a user-controlled page)
    // is active. A challenge response on the maintenance request must not tear
    // down an in-flight cart or replace the page the user is working in.
    const warmPage = this._warmPages.get(accountId)
    const openPages = (context.pages?.() || []).filter(
      (page) => page !== warmPage && (typeof page.isClosed !== 'function' || !page.isClosed())
    )
    if (openPages.length > 0) {
      this._startKeepalive(accountId, retailer)
      return
    }

    const page = warmPage || (await context.newPage())
    const ownsPage = page !== warmPage
    try {
      const response = await page.goto(RETAILER_HOME[retailer], {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      const status = response?.status() ?? 0
      const reason =
        status === 403 || status === 429
          ? `HTTP ${status}`
          : (await isCaptchaPresent(page).catch(() => false))
            ? 'security challenge'
            : null

      if (reason) {
        // Hard stop. Every further request after a block deepens the penalty, so we
        // do not retry, do not reschedule, and drop the pin so nothing reuses this
        // session until a human looks at it.
        log.error('Keepalive detected a block; stopping keepalive and releasing the pin', {
          accountId,
          retailer,
          reason
        })
        this._stopKeepalive(accountId)
        this._pinned.delete(accountId)
        if (ownsPage) await page.close().catch(() => {})
        await this.close(accountId).catch(() => {})
        this._onBlocked?.({ accountId, retailer, reason })
        return
      }

      this._updateActivity(accountId)
      this._startKeepalive(accountId, retailer)
    } finally {
      if (ownsPage) await page.close().catch(() => {})
    }
  }

  isPinned(accountId) {
    return this._pinned.has(accountId)
  }

  async _launchNew(accountId, { profilePath, proxy, retailer }) {
    try {
      mkdirSync(profilePath, { recursive: true })
    } catch (err) {
      log.error('Failed to create profile directory', { profilePath, error: err.message })
      throw err
    }

    const proxyUrl = buildProxyUrl(proxy)
    const contextOptions = {
      ...buildCloakBrowserOptions({
        identity: `account:${accountId}:${profilePath}`,
        proxyUrl,
        headless: false
      }),
      userDataDir: profilePath
      // Persistent profiles preserve the retailer session and the fixed
      // fingerprint seed preserves device identity across app restarts.
    }

    if (proxyUrl) {
      log.info('Using proxy for browser', {
        accountId,
        proxy: redactProxyUrl(proxyUrl)
      })
    } else {
      log.warn('No proxy configured for browser session', { accountId, retailer })
    }

    try {
      log.info('Launching CloakBrowser context with binary-level stealth', {
        accountId,
        proxy: Boolean(proxyUrl)
      })
      const context = await launchPersistentContext(contextOptions)
      this._trackContextDownloads(accountId, context)

      const warmupUrl = RETAILER_HOME[retailer]
      if (warmupUrl) {
        const setupPage = await context.newPage()
        const keepWarmPage = this._pinned.has(accountId)
        try {
          log.info('Preparing retailer origin', { accountId, retailer })
          await setupPage.goto(warmupUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000
          })
          if (this._setupWarmupMs) {
            await new Promise((resolve) => setTimeout(resolve, this._setupWarmupMs))
          }
        } catch (navErr) {
          log.warn('Retailer origin preparation failed; checkout will retry normally', {
            accountId,
            retailer,
            error: navErr.message
          })
        } finally {
          if (keepWarmPage) this._warmPages.set(accountId, setupPage)
          else await setupPage.close().catch(() => {})
        }
      }

      this._active.set(accountId, context)
      this._proxyByAccount.set(accountId, proxyUrl)
      this._retailerByAccount.set(accountId, retailer)
      this._updateActivity(accountId)

      context.on?.('close', () => {
        if (this._active.get(accountId) === context) {
          this._active.delete(accountId)
          this._lastActivity.delete(accountId)
          this._proxyByAccount.delete(accountId)
          this._retailerByAccount.delete(accountId)
          this._downloadsByAccount.delete(accountId)
          this._warmPages.delete(accountId)
          this._drainCapacityWaiters()
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

    const proxyUrl = buildProxyUrl(proxy)
    const contextOptions = {
      ...buildCloakBrowserOptions({
        identity: `monitor:${accountId}:${profilePath}`,
        proxyUrl,
        headless: false
      }),
      userDataDir: profilePath
    }

    log.info('Launching ephemeral monitor context', { accountId, proxy: Boolean(proxyUrl) })
    const context = await launchPersistentContext(contextOptions)

    return context
  }

  async close(accountId) {
    const ctx = this._active.get(accountId)
    if (ctx) {
      this._warmPages.delete(accountId)
      const downloads = [...(this._downloadsByAccount.get(accountId) || [])]
      try {
        await Promise.allSettled(downloads.map((download) => download.cancel?.()))
        await withTimeout(
          Promise.resolve(ctx.close({ reason: 'PokeBot browser pool cleanup' })),
          this._closeTimeoutMs,
          `Browser context ${accountId} did not close within ${this._closeTimeoutMs}ms`
        )
      } catch (error) {
        log.warn('Browser context required forced cleanup', {
          accountId,
          error: error.message
        })
        const browser = ctx.browser?.()
        if (browser?.close) {
          await withTimeout(
            Promise.resolve(browser.close({ reason: 'PokeBot forced browser cleanup' })),
            Math.min(3000, this._closeTimeoutMs),
            `Browser ${accountId} did not close after its context timed out`
          ).catch((browserError) => {
            log.error('Browser process could not be closed cleanly', {
              accountId,
              error: browserError.message
            })
          })
        }
      }
      this._active.delete(accountId)
      this._proxyByAccount.delete(accountId)
      this._retailerByAccount.delete(accountId)
      this._lastActivity.delete(accountId)
      this._downloadsByAccount.delete(accountId)
      this._drainCapacityWaiters()
    }
  }

  async closeAll() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer)
      this._healthCheckTimer = null
    }
    for (const accountId of [...this._keepalive.keys()]) this._stopKeepalive(accountId)
    this._warmPages.clear()
    this._pinned.clear()

    for (const waiter of this._capacityWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Browser pool is shutting down'))
    }

    await Promise.allSettled([...this._active.keys()].map((id) => this.close(id)))
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

  _trackContextDownloads(accountId, context) {
    const downloads = new Set()
    this._downloadsByAccount.set(accountId, downloads)
    const trackPage = (page) => {
      page.on?.('download', (download) => {
        downloads.add(download)
        Promise.resolve(download.failure?.())
          .catch(() => {})
          .finally(() => downloads.delete(download))
      })
    }
    context.pages?.().forEach(trackPage)
    context.on?.('page', trackPage)
  }

  async _waitForCapacity(accountId, priority, timeoutMs) {
    if (this._active.size + this._capacityReservations.size < this._maxConcurrent) {
      const token = Symbol(accountId)
      this._capacityReservations.add(token)
      return token
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        accountId,
        priority: Number(priority) || 0,
        sequence: Date.now() + Math.random(),
        resolve,
        reject,
        timer: null
      }
      waiter.timer = setTimeout(
        () => {
          this._capacityWaiters = this._capacityWaiters.filter((entry) => entry !== waiter)
          reject(new Error(`Browser capacity wait timed out after ${timeoutMs}ms`))
        },
        Math.max(1000, Number(timeoutMs) || this._capacityWaitMs)
      )
      this._capacityWaiters.push(waiter)
      this._capacityWaiters.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)
      log.info('Browser launch waiting for capacity', {
        accountId,
        priority: waiter.priority,
        waiting: this._capacityWaiters.length
      })
    })
  }

  _drainCapacityWaiters() {
    while (
      this._capacityWaiters.length > 0 &&
      this._active.size + this._capacityReservations.size < this._maxConcurrent
    ) {
      const waiter = this._capacityWaiters.shift()
      clearTimeout(waiter.timer)
      const token = Symbol(waiter.accountId)
      this._capacityReservations.add(token)
      waiter.resolve(token)
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

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
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
