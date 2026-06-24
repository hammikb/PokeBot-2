import { launchPersistentContext } from 'cloakbrowser'
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
        '--enable-features=NetworkService,NetworkServiceInProcess'
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
        '--enable-features=NetworkService,NetworkServiceInProcess'
      ]
    }

    const proxyUrl = buildProxyUrl(proxy)
    if (proxyUrl) contextOptions.proxy = proxyUrl

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
