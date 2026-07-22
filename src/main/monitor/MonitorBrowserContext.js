/**
 * MonitorBrowserContext
 *
 * Guppy's actual monitoring architecture: ONE shared browser context (one Chrome
 * window, off-screen) with ONE tab (page) per monitored product.
 *
 * Benefits vs one-context-per-product:
 *   - All tabs share the same Akamai cookies/session → once one tab passes the
 *     challenge, all tabs benefit immediately
 *   - One Chrome process instead of N → ~300MB RAM vs N × 80MB
 *   - Consistent fingerprint across all tabs → stronger Akamai identity
 *   - One stable profile directory → cookies persist across restarts
 */

import { createModuleLogger } from '../utils/logger.js'

const log = createModuleLogger('MonitorBrowserContext')

// ---------------------------------------------------------------------------
// Ghostery adblocker — singleton, loaded once for the entire app lifetime.
//
// Blocks ads, trackers, and analytics on retailer pages. Benefits:
//   - Fewer network requests → pages load faster → domcontentloaded fires sooner
//   - Less JS execution → lower CPU usage per tab
//   - Blocks fingerprinting scripts that could flag the bot
//
// IMPORTANT: Retailer API domains are allowlisted so the adblocker never
// blocks the redsky/walmart API calls we intercept for stock data.
// ---------------------------------------------------------------------------

// Retailer API domains that must NEVER be blocked — these are the endpoints
// we intercept to get stock/price data. Ghostery filter lists incorrectly
// classify some of these as trackers.
const ADBLOCKER_ALLOWLIST = [
  'redsky.target.com', // Target stock/price API (intercepted for monitoring)
  'api.target.com', // Target cart/checkout API
  'walmart.com', // Walmart APIs (cart, checkout, stock)
  'api.walmart.com', // Walmart REST API
  'grocery.walmart.com', // Walmart grocery API
  'samsclub.com', // Sam's Club product/cart APIs
  'api.samsclub.com' // Sam's Club REST APIs
]

let _blockerPromise = null

async function getBlocker() {
  if (_blockerPromise) return _blockerPromise
  _blockerPromise = (async () => {
    try {
      const { PlaywrightBlocker } = await import('@ghostery/adblocker-playwright')
      const blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch)

      // Add allowlist rules so retailer APIs are never blocked.
      // Adblock Plus syntax: @@||domain^ means "allow all requests from domain".
      const allowRules = ADBLOCKER_ALLOWLIST.map((d) => `@@||${d}^`).join('\n')
      blocker.updateFromDiff({ added: [allowRules] })

      log.info('Ghostery adblocker loaded — ads/trackers blocked, retailer APIs allowed', {
        allowlist: ADBLOCKER_ALLOWLIST
      })
      return blocker
    } catch (err) {
      log.warn('Ghostery adblocker failed to load — pages will load without ad blocking', {
        reason: err.message
      })
      return null
    }
  })()
  return _blockerPromise
}

export class MonitorBrowserContext {
  /**
   * @param {object} opts
   * @param {object} opts.browserPool   BrowserPool instance (provides launchContext)
   * @param {string} [opts.retailer]    e.g. 'target', 'walmart' — used for profile naming
   * @param {object} [opts.proxy]       Optional proxy config
   */
  constructor({ browserPool, retailer = 'monitor', proxy = null }) {
    this._browserPool = browserPool
    this._retailer = retailer
    this._proxy = proxy
    this._context = null
    this._pages = new Map() // productId → Page
    this._launching = null // Promise while context is being launched (prevents races)
  }

  /**
   * Get or create a persistent page (tab) for a specific product.
   * The first call launches the shared browser context; subsequent calls
   * just open a new tab in the existing window.
   *
   * @param {string} productId  Unique identifier for the product (e.g. TCIN, item ID)
   * @returns {Promise<Page>}
   */
  async getPage(productId) {
    // Ensure the shared context is running.
    await this._ensureContext()

    // Return existing tab if still open.
    const existing = this._pages.get(productId)
    if (existing && !existing.isClosed?.()) {
      return existing
    }

    log.info('Opening new monitor tab', { retailer: this._retailer, productId })
    const page = await this._context.newPage()
    this._pages.set(productId, page)

    // Apply adblocker to this tab — blocks ads/trackers so pages load faster.
    // Retailer API domains are allowlisted so stock data interception still works.
    // Loaded lazily and cached as a singleton; no-ops if unavailable.
    getBlocker().then((blocker) => {
      if (blocker && !page.isClosed?.()) {
        blocker.enableBlockingInPage(page).catch(() => {})
      }
    })

    page.on?.('close', () => {
      if (this._pages.get(productId) === page) {
        this._pages.delete(productId)
        log.info('Monitor tab closed', { retailer: this._retailer, productId })
      }
    })

    return page
  }

  /**
   * Close the tab for a specific product (called when a monitor task is stopped).
   */
  async closePage(productId) {
    const page = this._pages.get(productId)
    if (page) {
      this._pages.delete(productId)
      try {
        await page.close()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Close the entire shared context (all tabs). Called on app shutdown.
   */
  async closeAll() {
    this._pages.clear()
    if (this._context) {
      try {
        await this._context.close()
      } catch {
        /* ignore */
      }
      this._context = null
    }
    this._launching = null
  }

  get pageCount() {
    return this._pages.size
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------
  async _ensureContext() {
    if (this._context) return

    // Prevent multiple concurrent launches (race condition guard).
    if (this._launching) {
      await this._launching
      return
    }

    this._launching = this._launchContext()
    try {
      await this._launching
    } finally {
      this._launching = null
    }
  }

  async _launchContext() {
    log.info('Launching shared monitor browser context', { retailer: this._retailer })
    // The first Sam's monitor profile was repeatedly navigated through its live
    // waiting room and can remain challenge-marked. Use a fresh versioned monitor
    // identity for the gate-holding implementation without touching account profiles.
    const accountId =
      this._retailer === 'samsclub' ? 'monitor-samsclub-gate-v2' : `monitor-${this._retailer}`
    this._context = await this._browserPool.launchContext({
      accountId,
      proxy: this._proxy
    })
    this._context.on?.('close', () => {
      log.warn('Shared monitor context closed unexpectedly', { retailer: this._retailer })
      this._context = null
      this._pages.clear()
    })
    log.info('Shared monitor browser context ready', { retailer: this._retailer })
  }
}
