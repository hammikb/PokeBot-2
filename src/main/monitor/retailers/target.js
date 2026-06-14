import axios from 'axios'
import { createDropEvent } from '../DropEvent.js'
import { DROP_TYPES } from '../../../shared/constants.js'
import { createModuleLogger } from '../../utils/logger.js'

const log = createModuleLogger('TargetPoller')

// ---------------------------------------------------------------------------
// Redsky endpoints (used for axios fallback only)
// ---------------------------------------------------------------------------
const REDSKY_FULFILLMENT_URL =
  'https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_and_variation_hierarchy_v1'
const REDSKY_PDP_URL = 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1'
const REDSKY_API_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96'

// Endpoints that carry live availability, in priority order. Current Target
// (anonymous sessions) fires cdui_orchestrations deferred_enrichment; older /
// logged-in sessions still use redsky fulfillment. Both nest `shipping_options`.
const STOCK_ROUTE_PATTERNS = ['**/cdui_orchestrations/**', '**/redsky_aggregations/**']

// ---------------------------------------------------------------------------
// In-stock logic (matches Guppy's deobfuscated bundle)
// ---------------------------------------------------------------------------
const OOS_RE = /OUT_OF_STOCK|UNSELLABLE|UNAVAILABLE|NOT_SOLD|DISCONTINUED/i
const SELLABLE_RE = /SELLABLE/i
const UNSELLABLE_RE = /UNSELLABLE/i
const EXPLICIT_IN_STOCK = new Set(['IN_STOCK', 'LIMITED_STOCK', 'PRE_ORDER_SELLABLE'])

function isGuppyInStock(shipping, minQuantity = 1) {
  if (!shipping) return false
  const { availabilityStatus: status, availableToPromiseQuantity: atp, reasonCode } = shipping
  if (!status) return false
  if (OOS_RE.test(status)) return false
  if (EXPLICIT_IN_STOCK.has(status) && reasonCode == null) return true
  const isSellable = SELLABLE_RE.test(status) && !UNSELLABLE_RE.test(status) && reasonCode == null
  const hasAtp = atp != null && atp >= minQuantity
  return isSellable || hasAtp
}

// ---------------------------------------------------------------------------
// Akamai backoff
// ---------------------------------------------------------------------------
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// TargetPoller
// ---------------------------------------------------------------------------
export class TargetPoller {
  /**
   * @param {object} opts
   * @param {string}  opts.productUrl
   * @param {number}  [opts.maxPrice]
   * @param {string}  [opts.storeId]
   * @param {string}  [opts.zip]
   * @param {number}  [opts.minQuantity]
   * @param {object}  [opts.browserPool]  BrowserPool — enables Guppy-style browser
   *                                       interception (navigates to product page,
   *                                       intercepts the redsky API calls Target fires).
   *                                       Falls back to axios when omitted.
   */
  constructor({
    productUrl,
    maxPrice = Infinity,
    storeId = '1296',
    zip = '90001',
    minQuantity = 1,
    browserPool = null,
    monitorContext = null,
    // Hard cap for the browser-intercept wait. The stock XHR fires AFTER
    // domcontentloaded, so we cannot resolve on navigation completion — we wait
    // for the intercepted enrichment response, falling back to this timeout.
    browserInterceptTimeoutMs = 25_000
  }) {
    this.productUrl = productUrl
    this.maxPrice = maxPrice
    this.storeId = storeId
    this.zip = zip
    this.minQuantity = minQuantity
    this.browserInterceptTimeoutMs = browserInterceptTimeoutMs
    // monitorContext (MonitorBrowserContext) is preferred — one shared Chrome window,
    // one tab per product. Falls back to browserPool (one context per product) if
    // monitorContext is not provided.
    this.monitorContext = monitorContext
    this.browserPool = browserPool
    this.tcin = productUrl.match(/A-(\d+)/)?.[1]
    if (!this.tcin) throw new Error(`Cannot extract TCIN from URL: ${productUrl}`)

    this._wasInStock = false
    this._isFirstPoll = true
    this._cooldownUntil = 0
    this._consecutiveBlocks = 0

    // Fallback: own context+page when monitorContext is not used.
    this._browserContext = null
    this._browserPage = null
    this._pollInProgress = false
  }

  async poll() {
    // Guard: skip if a poll is already running (prevents window explosion).
    if (this._pollInProgress) return null
    if (Date.now() < this._cooldownUntil) return null

    this._pollInProgress = true
    try {
      return await this._doPoll()
    } finally {
      this._pollInProgress = false
    }
  }

  async _doPoll() {
    let product
    try {
      product =
        this.monitorContext || this.browserPool
          ? await this._fetchProductViaBrowser()
          : await this._fetchProductViaAxios()
    } catch (err) {
      const status = err.response?.status
      if (status === 403 || status === 429) {
        this._consecutiveBlocks += 1
        const cooldown = Math.min(
          BACKOFF_BASE_MS * 2 ** (this._consecutiveBlocks - 1),
          BACKOFF_MAX_MS
        )
        this._cooldownUntil = Date.now() + cooldown
        log.warn('Target rate-limited (Akamai) — backing off', {
          tcin: this.tcin,
          status,
          consecutiveBlocks: this._consecutiveBlocks,
          cooldownMs: cooldown
        })
        // Don't destroy the context — keep it alive so cookies persist.
        // The cooldown will prevent polls until Akamai resets.
        return null
      }
      log.error('Target lookup failed', { tcin: this.tcin, error: err.message })
      return null
    }

    this._consecutiveBlocks = 0
    this._cooldownUntil = 0

    if (!product) {
      log.warn('Target returned no product data', { tcin: this.tcin })
      return null
    }

    const { name, price, inStock } = product
    log.info('Polled Target product', {
      tcin: this.tcin,
      inStock,
      price,
      name,
      isFirstPoll: this._isFirstPoll,
      method: this.browserPool ? 'browser-intercept' : 'axios'
    })

    const overPrice = price != null && Number.isFinite(this.maxPrice) && price > this.maxPrice
    if (!inStock || overPrice) {
      this._wasInStock = false
      this._isFirstPoll = false
      return null
    }

    if (this._wasInStock && !this._isFirstPoll) return null

    const isFirstCheck = this._isFirstPoll
    this._wasInStock = true
    this._isFirstPoll = false

    return createDropEvent({
      retailer: 'target',
      productName: name,
      productUrl: this.productUrl,
      dropType: DROP_TYPES.IN_STOCK,
      price,
      isFirstCheck
    })
  }

  // ---------------------------------------------------------------------------
  // Guppy-style browser interception
  //
  // KEY DESIGN: Navigate to the actual product page each poll. Target's own JS
  // fires the redsky API calls — we intercept those responses. This means:
  //   1. Akamai sees a real page visit with full JS execution (no raw API calls)
  //   2. We reuse the same persistent context so cookies accumulate over time
  //   3. No new browser windows are opened after the first poll
  // ---------------------------------------------------------------------------
  async _fetchProductViaBrowser() {
    const page = await this._getOrCreatePage()

    return new Promise((resolve) => {
      let resolved = false

      const done = (data) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        // unroute with the SAME patterns + handler we registered, otherwise the
        // handler leaks and stacks up on the shared (persistent) tab.
        for (const pat of STOCK_ROUTE_PATTERNS) {
          page.unroute(pat, routeHandler).catch(() => {})
        }
        resolve(data)
      }

      // Hard fallback. The stock XHR (cdui deferred_enrichment) fires *after*
      // domcontentloaded, so resolution is driven by the route handler below —
      // NOT by navigation completion. This timer only fires when the stock
      // response never arrives (block / page-shape change).
      const timer = setTimeout(() => {
        log.warn('Target stock fetch timed out', { tcin: this.tcin })
        done(null)
      }, this.browserInterceptTimeoutMs)

      // Intercept the response that actually carries live availability. Current
      // Target fires cdui_orchestrations deferred_enrichment; older/logged-in
      // sessions still use redsky fulfillment. Both nest the same
      // `shipping_options` object, so one deep-search parser handles either.
      const routeHandler = async (route) => {
        let response
        try {
          response = await route.fetch()
        } catch (e) {
          log.warn('Target stock route error', { tcin: this.tcin, error: e.message })
          await route.abort().catch(() => {})
          return
        }
        const json = await response.json().catch(() => null)
        await route.fulfill({ response }).catch(() => {})
        if (resolved || !json) return

        const shipping = this._findShippingOptions(json)
        if (!shipping) return // not the stock-bearing response — keep waiting

        // Name + displayed price come from the rendered page; the stock JSON
        // does not always carry price. Fall back to the JSON if the DOM read fails.
        let name = null
        let price = null
        try {
          const info = await this._readProductInfo(page)
          name = info.name
          price = info.price
        } catch {
          /* ignore */
        }
        if (price == null) price = this._findPrice(json)
        const inStock = isGuppyInStock(shipping, this.minQuantity)
        log.info('Target stock parsed', {
          tcin: this.tcin,
          status: shipping.availabilityStatus,
          atp: shipping.availableToPromiseQuantity,
          inStock,
          price
        })
        done({ name: name || 'Target Product', price, inStock })
      }
      for (const pat of STOCK_ROUTE_PATTERNS) {
        page.route(pat, routeHandler).catch(() => {})
      }

      // Navigate so Target's JS fires the enrichment/stock call. Use
      // 'domcontentloaded' — Target pages never reach 'networkidle' (continuous
      // background XHR). Do NOT resolve on navigation completion: the stock call
      // lands *after* DCL. Resolution happens in the route handler / hard timeout.
      page
        .goto(this.productUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.browserInterceptTimeoutMs
        })
        .catch((err) => {
          if (err.message?.includes('403') || err.message?.includes('429')) {
            this._lastNavigationBlocked = true
            done(null)
          } else {
            log.warn('Target page navigation ended early', { tcin: this.tcin, error: err.message })
            // Let the route handler / hard timeout resolve; data may still land.
          }
        })
    }).then((data) => {
      if (this._lastNavigationBlocked) {
        this._lastNavigationBlocked = false
        const err = new Error('HTTP 403')
        err.response = { status: 403 }
        throw err
      }
      return data
    })
  }

  // ---------------------------------------------------------------------------
  // Response parsing (browser path)
  //
  // The stock payload shape varies by endpoint (cdui_orchestrations vs redsky),
  // but both nest a `shipping_options` object with the same fields. Rather than
  // hard-code a path that Target keeps changing, deep-search for it.
  // ---------------------------------------------------------------------------
  _findShippingOptions(root) {
    let found = null
    const seen = new Set()
    const walk = (o) => {
      if (found || !o || typeof o !== 'object' || seen.has(o)) return
      seen.add(o)
      const so = o.shipping_options
      if (so && typeof so === 'object' && so.availability_status) {
        found = {
          availabilityStatus: so.availability_status ?? null,
          availableToPromiseQuantity: so.available_to_promise_quantity ?? null,
          reasonCode: so.reason_code ?? null
        }
        return
      }
      for (const k of Object.keys(o)) {
        const v = o[k]
        if (v && typeof v === 'object') walk(v)
      }
    }
    walk(root)
    return found
  }

  _findPrice(root) {
    let price = null
    const seen = new Set()
    const walk = (o) => {
      if (price != null || !o || typeof o !== 'object' || seen.has(o)) return
      seen.add(o)
      for (const k of Object.keys(o)) {
        const v = o[k]
        if (k === 'current_retail' && typeof v === 'number') {
          price = v
          return
        }
        if (v && typeof v === 'object') walk(v)
      }
    }
    walk(root)
    return price
  }

  async _readProductInfo(page) {
    // The stock XHR can resolve before the buy-box price repaints (esp. on tab
    // reloads). Wait briefly for the price element so we don't read it as null.
    try {
      await page.waitForSelector?.('[data-test="product-price"]', { timeout: 3000 })
    } catch {
      /* price element never appeared — fall through, price stays null */
    }
    const info = await page.evaluate?.(() => {
      const out = { name: null, price: null }
      // Name: __NEXT_DATA__ holds the title; fall back to the document title.
      try {
        const s = JSON.stringify(window.__NEXT_DATA__)
        const m =
          s.match(/"product_description":\{"title":"([^"]+)"/) || s.match(/"title":"([^"]{4,})"/)
        if (m) out.name = m[1]
      } catch {
        /* ignore */
      }
      if (!out.name && document.title) {
        out.name = document.title.replace(/\s*:\s*Target\s*$/i, '').trim()
      }
      // Price: Target renders the buy-box price with a stable data-test hook.
      try {
        const el = document.querySelector('[data-test="product-price"]')
        const pm = (el?.textContent || '').match(/\$([0-9]+(?:\.[0-9]{2})?)/)
        if (pm) out.price = parseFloat(pm[1])
      } catch {
        /* ignore */
      }
      return out
    })
    return info || { name: null, price: null }
  }

  // ---------------------------------------------------------------------------
  // Persistent page management
  //
  // Preferred: monitorContext (MonitorBrowserContext) — one shared Chrome window,
  //            one tab per product. This is Guppy's exact approach.
  // Fallback:  browserPool — one separate Chrome context per product.
  // ---------------------------------------------------------------------------
  async _getOrCreatePage() {
    // Preferred path: shared context, dedicated tab.
    if (this.monitorContext) {
      return this.monitorContext.getPage(this.tcin)
    }

    // Fallback: own context per product (legacy).
    if (this._browserPage && this._browserContext) {
      return this._browserPage
    }
    log.info('Creating persistent monitor browser context', { tcin: this.tcin })
    this._browserContext = await this.browserPool.launchContext({
      accountId: `monitor-target-${this.tcin}`
    })
    this._browserPage = await this._browserContext.newPage()
    return this._browserPage
  }

  async _closeBrowserContext() {
    // monitorContext manages its own tab lifecycle — just close our tab.
    if (this.monitorContext) {
      await this.monitorContext.closePage(this.tcin)
      return
    }
    try {
      await this._browserPage?.close()
    } catch {
      /* ignore */
    }
    try {
      await this._browserContext?.close()
    } catch {
      /* ignore */
    }
    this._browserPage = null
    this._browserContext = null
  }

  // Called by MonitorEngine when the task is stopped.
  async destroy() {
    await this._closeBrowserContext()
  }

  // ---------------------------------------------------------------------------
  // Axios fallback (used when no browserPool is provided — tests, etc.)
  // ---------------------------------------------------------------------------
  async _fetchProductViaAxios() {
    const params = {
      key: REDSKY_API_KEY,
      tcin: this.tcin,
      store_id: this.storeId,
      pricing_store_id: this.storeId,
      zip: this.zip,
      state: 'CA',
      has_pricing_store_id: true,
      visitor_id: '0',
      channel: 'WEB',
      page: `/p/A-${this.tcin}`
    }
    const headers = {
      accept: 'application/json',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    }

    // Try fulfillment endpoint first.
    try {
      const response = await axios.get(REDSKY_FULFILLMENT_URL, { timeout: 15000, params, headers })
      const parsed = this._parseCombined(response.data, null)
      if (parsed) return parsed
    } catch (err) {
      if (err.response?.status !== 404) throw err
    }

    const response = await axios.get(REDSKY_PDP_URL, { timeout: 15000, params, headers })
    return this._parseCombined(null, response.data)
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------
  _parseCombined(fulfillmentRaw, pdpRaw) {
    const fProduct = fulfillmentRaw?.data?.product ?? null
    const pProduct = pdpRaw?.data?.product ?? null
    if (!fProduct && !pProduct) return null

    const nameSource = pProduct ?? fProduct
    const name = this._extractName(nameSource)
    const price = this._extractPrice(nameSource)

    const stockSource = fProduct ?? pProduct

    // Target uses several different shapes depending on which endpoint fires:
    //   fulfillment endpoint: product.fulfillment.shipping_options
    //   pdp endpoint:         product.fulfillment (object with availability_status directly)
    //                         OR product.availability (top-level)
    const fulfillment = stockSource?.fulfillment ?? null
    const shippingOptions = fulfillment?.shipping_options ?? fulfillment ?? null

    // Log the raw fulfillment data so we can see what we're actually getting.
    log.debug('Target raw fulfillment data', {
      tcin: this.tcin,
      fulfillmentKeys: fulfillment ? Object.keys(fulfillment) : null,
      shippingOptionsKeys: shippingOptions ? Object.keys(shippingOptions) : null,
      availabilityStatus:
        shippingOptions?.availability_status ||
        shippingOptions?.availabilityStatus ||
        stockSource?.availability?.availability_status ||
        null
    })

    // Build the shipping object from whichever shape we got.
    const shipping = shippingOptions
      ? {
          availabilityStatus:
            shippingOptions.availability_status ||
            shippingOptions.availabilityStatus ||
            stockSource?.availability?.availability_status ||
            null,
          availableToPromiseQuantity:
            shippingOptions.available_to_promise_quantity ??
            shippingOptions.availableToPromiseQuantity ??
            stockSource?.availability?.available_to_promise_quantity ??
            null,
          reasonCode:
            shippingOptions.reason_code ??
            shippingOptions.reasonCode ??
            stockSource?.availability?.reason_code ??
            null
        }
      : null

    const inStock = isGuppyInStock(shipping, this.minQuantity)

    log.debug('Target stock decision', {
      tcin: this.tcin,
      shipping,
      inStock
    })

    return { name, price, inStock }
  }

  _extractName(product) {
    return (
      product?.item?.product_description?.title ||
      product?.item?.product_description?.downstream_description ||
      'Target Product'
    )
  }

  _extractPrice(product) {
    const price = product?.price?.current_retail ?? product?.price?.formatted_current_price_type
    return typeof price === 'number' ? price : null
  }
}
