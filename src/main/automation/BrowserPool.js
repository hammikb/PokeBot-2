import { chromium } from 'playwright'
import { mkdirSync } from 'fs'
import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('BrowserPool')
const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

export class BrowserPool {
  constructor({ maxConcurrent = 3, contextTimeout = DEFAULT_TIMEOUT } = {}) {
    this._maxConcurrent = maxConcurrent
    this._contextTimeout = contextTimeout
    this._active = new Map()
    this._lastActivity = new Map()
    this._healthCheckTimer = null
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

  async launch(accountId, { profilePath, proxy }) {
    if (this._active.has(accountId)) {
      const context = this._active.get(accountId)
      if (isContextOpen(context)) {
        this._updateActivity(accountId)
        return context
      }
      this._active.delete(accountId)
      this._lastActivity.delete(accountId)
    }
    if (this._active.size >= this._maxConcurrent) {
      log.error('Browser pool at capacity', { maxConcurrent: this._maxConcurrent })
      throw new Error(`Browser pool at max capacity (${this._maxConcurrent})`)
    }

    try {
      mkdirSync(profilePath, { recursive: true })
    } catch (err) {
      log.error('Failed to create profile directory', { profilePath, error: err.message })
      throw err
    }

    const contextOptions = {
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation']
    }

    if (proxy) {
      const parts = proxy.split(':')
      if (parts.length >= 2) {
        const [host, port, username, password] = parts
        contextOptions.proxy = {
          server: `http://${host}:${port}`,
          ...(username && password ? { username, password } : {})
        }
      }
    }

    try {
      log.info('Launching browser context', { accountId })
      const context = await chromium.launchPersistentContext(profilePath, contextOptions)
      this._active.set(accountId, context)
      this._updateActivity(accountId)
      context.on?.('close', () => {
        if (this._active.get(accountId) === context) {
          this._active.delete(accountId)
          this._lastActivity.delete(accountId)
          log.info('Browser context closed', { accountId })
        }
      })
      return context
    } catch (err) {
      log.error('Failed to launch browser context', { accountId, error: err.message })
      throw err
    }
  }

  async close(accountId) {
    const ctx = this._active.get(accountId)
    if (ctx) {
      try {
        await ctx.close()
      } catch {
        // Best effort cleanup; the browser may already be closed.
      }
      this._active.delete(accountId)
    }
  }

  async closeAll() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer)
      this._healthCheckTimer = null
    }
    for (const id of [...this._active.keys()]) await this.close(id)
  }

  getActiveCount() {
    return this._active.size
  }

  isAtCapacity() {
    return this._active.size >= this._maxConcurrent
  }
}

function isContextOpen(context) {
  try {
    return Boolean(context?.browser?.())
  } catch {
    return false
  }
}
