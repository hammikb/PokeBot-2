import { launchPersistentContext } from 'cloakbrowser'
import { mkdirSync } from 'fs'
import { createModuleLogger } from '../utils/logger.js'
import { buildCloakBrowserOptions, redactProxyUrl } from './cloakBrowserConfig.js'

const log = createModuleLogger('BrowserPool')
const DEFAULT_TIMEOUT = 60 * 60 * 1000 // 60 minutes
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

const SHAPE_COOKIE_NAMES = ['_shapes', 'shape', '_sfid', '_sctr', '_sdid']
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
    capacityWaitMs = 20_000
  } = {}) {
    this._maxConcurrent = maxConcurrent
    this._contextTimeout = contextTimeout
    this._setupWarmupMs = setupWarmupMs
    this._capacityWaitMs = capacityWaitMs
    this._active = new Map()
    this._pending = new Map()
    this._pendingProxy = new Map()
    this._pinned = new Set()
    this._lastActivity = new Map()
    this._proxyByAccount = new Map()
    this._retailerByAccount = new Map()
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
      return await this.launch(accountId, options)
    } catch (err) {
      this._pinned.delete(accountId)
      throw err
    }
  }

  async unpin(accountId, { close = false } = {}) {
    this._pinned.delete(accountId)
    if (close) {
      await this.close(accountId)
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

      const warmupUrl = RETAILER_HOME[retailer]
      if (warmupUrl) {
        const setupPage = await context.newPage()
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
          await setupPage.close().catch(() => {})
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
      try {
        await ctx.close()
      } catch {
        // Best effort cleanup
      }
      this._active.delete(accountId)
      this._proxyByAccount.delete(accountId)
      this._retailerByAccount.delete(accountId)
      this._lastActivity.delete(accountId)
      this._drainCapacityWaiters()
    }
  }

  async closeAll() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer)
      this._healthCheckTimer = null
    }
    this._pinned.clear()

    for (const waiter of this._capacityWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Browser pool is shutting down'))
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
