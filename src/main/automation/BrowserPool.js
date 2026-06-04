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
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
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
      ],
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
      log.info('Launching browser context with enhanced stealth', { accountId })
      const context = await chromium.launchPersistentContext(profilePath, contextOptions)
      
      // Inject comprehensive anti-detection scripts on every page
      await context.addInitScript(() => {
        // 1. Remove webdriver property (most important!)
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        })
        
        // 2. Fix chrome object with more realistic properties
        window.chrome = {
          runtime: {},
          loadTimes: function() {},
          csi: function() {},
          app: {}
        }
        
        // 3. Fix permissions API
        const originalQuery = window.navigator.permissions.query
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        )
        
        // 4. Spoof plugins with realistic data
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            return [
              {
                0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" },
                description: "Portable Document Format",
                filename: "internal-pdf-viewer",
                length: 1,
                name: "Chrome PDF Plugin"
              },
              {
                0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
                description: "Portable Document Format", 
                filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
                length: 1,
                name: "Chrome PDF Viewer"
              },
              {
                0: { type: "application/x-nacl", suffixes: "", description: "Native Client Executable" },
                1: { type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable" },
                description: "Native Client",
                filename: "internal-nacl-plugin",
                length: 2,
                name: "Native Client"
              }
            ]
          }
        })
        
        // 5. Fix languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        })
        
        // 6. Override toString to hide modifications
        const originalToString = Function.prototype.toString
        Function.prototype.toString = function() {
          if (this === navigator.permissions.query) {
            return 'function query() { [native code] }'
          }
          return originalToString.call(this)
        }
        
        // 7. Add missing navigator properties
        if (!navigator.connection) {
          Object.defineProperty(navigator, 'connection', {
            get: () => ({
              effectiveType: '4g',
              rtt: 50,
              downlink: 10,
              saveData: false
            })
          })
        }
        
        // 8. Fix hardwareConcurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8
        })
        
        // 9. Fix deviceMemory
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8
        })
        
        // 10. Fix platform
        Object.defineProperty(navigator, 'platform', {
          get: () => 'Win32'
        })
        
        // 11. Add missing window properties
        window.navigator.chrome = window.chrome
        
        // 12. Fix Notification permission
        const originalNotification = window.Notification
        Object.defineProperty(window, 'Notification', {
          get: () => originalNotification,
          set: () => {}
        })
      })
      
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
